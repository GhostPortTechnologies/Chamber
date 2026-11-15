#!/usr/bin/env node
'use strict';                                                                  // [new] strict mode catches silent JS mistakes
// Chamber tickets CLI: zero-dependency backing store for Chamber's Tickets tab.
// Chamber invokes this (CHAMBER_TICKETS_CLI) with a verb + flags and reads the
// resulting JSON store (CHAMBER_TICKETS_FILE, shape { next_id, tickets:[] }).
// Verbs/args match server.js exactly:
//   propose --by <n> --title <t> [--body][--type][--priority]
//   approve <id> --by <n>
//   reject  <id> --by <n> --reason <r>
//   claim   <id> --by <n>
//   update  <id> --by <n> --note <note>
//   close   <id> --by <n> --note <note>   (note: min 20 chars, each item + result)
//   edit    <id> --by <n> [--title][--body][--type][--priority]   (proposed-only)
//   meta    <id> --by <n> --set <applied|apply_by|reverts|reverted_by> --json <value>   (T-0072: server-managed fields)
//   approve <id> --by <n> --standing <json>   (T-0200: approved in advance by a standing approval the server checked)
//   unstand <id> --by <n> --note <note>   (T-0200: back to proposed, waiting for a person)
//
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 GhostPort Technologies
// Free software under the GNU Affero General Public License v3; NO WARRANTY. See LICENSE.
const fs = require('fs');                                                     // [new] file reads/writes for the JSON store
const path = require('path');                                                 // [new] dirname() for the store folder

const STORE = process.env.CHAMBER_TICKETS_FILE || '';
// T-0222: with the owner lock on, the server hands this one call the workspace key: the store is opened with it, and written sealed
// when CHAMBER_WS_SEAL=1. Without a key a sealed store is refused (nothing is changed).
const WSKEY = /^[a-f0-9]{64}$/i.test(process.env.CHAMBER_WS_KEY || '') ? Buffer.from(process.env.CHAMBER_WS_KEY, 'hex') : null, WSAAD = process.env.CHAMBER_WS_AAD || '', WSSEAL = process.env.CHAMBER_WS_SEAL === '1' && !!WSKEY;
let wsc = null; const crypt = () => wsc || (wsc = require('./wscrypt'));                         // [new] store path comes from the same env var Chamber reads
if (!STORE) { console.error('CHAMBER_TICKETS_FILE not set'); process.exit(1); } // [new] refuse to guess a path

// One writer at a time. Every verb is load -> change -> save, so two overlapping runs  [new] store lock
// (two people clicking at once) would each save their own copy and one change would be lost.
// mkdir is atomic on every filesystem and needs no dependency, so a lock directory is the lock.
const LOCK = STORE + '.lock';                                                  // [new] lock directory next to the store
const LOCK_WAIT_MS = 4000;                                                     // [new] give up after 4 s: under server.js's 5 s CLI timeout, so the user sees this error, not a kill
const LOCK_STALE_MS = 30000;                                                   // [new] a lock older than 30 s was left by a crashed run
function acquireLock() {                                                       // [new] take the lock or exit with a clear error
  fs.mkdirSync(path.dirname(STORE), { recursive: true });                      // [new] the store's folder may not exist yet on first run
  const deadline = Date.now() + LOCK_WAIT_MS;                                  // [new] when to stop waiting
  for (;;) {                                                                   // [new] retry until taken or timed out
    try { fs.mkdirSync(LOCK); break; }                                         // [new] created it: the lock is ours
    catch (e) {                                                               // [new] mkdir failed: find out why
      if (e.code !== 'EEXIST') throw e;                                        // [new] a real error (permissions, disk), not contention
      try {                                                                    // [new] someone holds it: is it stale?
        if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) { fs.rmdirSync(LOCK); continue; }  // [new] clear a crashed run's lock and retry
      } catch { continue; }                                                    // [new] it vanished between checks: retry at once
      if (Date.now() > deadline) { console.error('ticket store is busy (locked by another write); try again'); process.exit(1); }  // [new] fail loudly, never write unlocked
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);        // [new] synchronous 25 ms sleep between attempts
    }
  }
  process.on('exit', () => { try { fs.rmdirSync(LOCK); } catch { /* already gone */ } });  // [new] released on every exit path, including fail()
  for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(1));  // [new] a kill (e.g. a timeout) must also release it; signals skip 'exit' otherwise
}

// Only a missing (or empty) file starts a new board. Any other read or parse problem   [fix] store-wipe bug
// stops the CLI before it writes: the old catch-all returned an empty store, so one
// hand-edit typo made the next write save a blank board and reissue T-0001.
function load() {                                                             // [new] read the store
  let raw;                                                                    // [fix] file text; read and parse are separate steps so each failure gets its own message
  try { raw = fs.readFileSync(STORE); }                                       // [fix] read the file (T-0222: as bytes, it may be sealed)
  catch (e) {                                                                 // [fix] the read failed: find out why
    if (e.code === 'ENOENT') return { next_id: 1, tickets: [] };              // [fix] no file yet (first run): the one case that starts empty
    fail(`cannot read ticket store ${STORE}: ${e.message}\nNothing was changed.`);  // [fix] permissions or disk error: refuse rather than overwrite the board
  }
  if (raw.length && crypt().isEncBytes(raw)) {                                // T-0222: sealed by the owner lock
    if (!WSKEY) fail(`ticket store ${STORE} is sealed (owner lock) and no key was given.\nNothing was changed.`);
    try { raw = crypt().decBytes(WSKEY, raw, WSAAD); } catch { fail(`ticket store ${STORE} does not open with the key given.\nNothing was changed.`); }
  }
  raw = raw.toString('utf8');
  if (!raw.trim()) return { next_id: 1, tickets: [] };                        // [fix] an empty file (e.g. made with touch) holds no tickets, so starting fresh loses nothing
  let data;                                                                   // [fix] parsed store
  try { data = JSON.parse(raw); }                                             // [fix] parse the JSON
  catch (e) { fail(`ticket store ${STORE} is not valid JSON (${e.message}).\nNothing was changed. Fix the file or restore a backup, then retry.`); }  // [fix] a typo stops here; the file is left exactly as it was
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.tickets)) {  // [fix] valid JSON but not { next_id, tickets: [] }
    fail(`ticket store ${STORE} is not a ticket store (expected { "next_id": N, "tickets": [...] }).\nNothing was changed.`);  // [fix] was: silently replaced the list with []
  }
  return data;                                                                // [fix] a store that is safe to change
}
function save(data) {                                                         // [new] write the store without ever leaving a half-written file
  const tmp = STORE + '.tmp.' + process.pid;                 // atomic: temp + fsync + rename
  const fd = fs.openSync(tmp, 'w');                                           // [new] open the temp file
  fs.writeSync(fd, WSSEAL ? crypt().encBytes(WSKEY, Buffer.from(JSON.stringify(data, null, 2)), WSAAD) : JSON.stringify(data, null, 2));   // T-0222: sealed while the owner lock is on                            // [new] pretty-printed so diffs and hand edits stay readable
  fs.fsyncSync(fd);                                                           // [new] flush to disk before the rename
  fs.closeSync(fd);                                                           // [new] done with the temp file
  fs.renameSync(tmp, STORE);                                                  // [new] atomic swap: readers see the old or the new file, never a mix
}
function fail(msg) { console.error(msg); process.exit(1); }                   // [new] error to stderr + exit 1; Chamber relays stderr to the UI
function nowISO() { return new Date().toISOString(); }                        // [new] UTC ISO timestamps everywhere
function fmtId(n) { return 'T-' + String(n).padStart(4, '0'); }               // [new] 7 -> T-0007

const argv = process.argv.slice(2);                                           // [new] drop 'node' and the script path
const pos = [];                                                               // [new] positional args: verb, ticket id
const flags = Object.create(null);                                              // [new] --name value pairs; no prototype, so --constructor or --__proto__ are plain keys
for (let i = 0; i < argv.length; i++) {                                       // [new] walk the arguments once
  const a = argv[i];                                                          // [new] current argument
  if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];                      // [new] --flag takes the next arg as its value, even one starting with --
  else pos.push(a);                                                           // [new] anything else is positional
}
const verb = pos[0];                                                          // [new] first positional is the verb
if (!verb) fail('usage: tickets-cli <verb> [id] [--flags]');                  // [new] no verb: print usage

acquireLock();                                                                 // [new] hold the lock from read to write
const data = load();                                                          // [new] read once; every verb works on this copy
{                                                                             // [fix] keep the id counter ahead of every id in use
  const used = data.tickets.map(t => parseInt(String(t.id).replace(/^T-/, ''), 10)).filter(Number.isFinite);  // [fix] numbers of the ids already taken
  const after = (used.length ? Math.max(...used) : 0) + 1;                   // [fix] first number past the highest id
  if (!Number.isInteger(data.next_id) || data.next_id < after) data.next_id = after;  // [fix] a missing or stale counter (hand edit, other tool) can no longer hand out an id that exists; was: reset to 1
}

function findTicket(id) {                                                     // [new] look up a ticket or exit
  const t = data.tickets.find(x => x.id === id);                              // [new] exact id match
  if (!t) fail(`ticket not found: ${id}`);                                    // [new] unknown id: clear error
  return t;                                                                   // [new] the ticket object (edited in place, then saved)
}

switch (verb) {                                                               // [new] one case per verb
  case 'propose': {                                                           // [new] new ticket, status proposed
    if (!flags.by || !flags.title) fail('propose requires --by and --title'); // [new] author and title are mandatory
    const id = fmtId(data.next_id);                                           // [new] next sequential id
    data.tickets.push({                                                       // [new] append the new ticket
      id, title: flags.title, body: flags.body || '',                         // [new] id, title, optional body
      type: flags.type || 'task', priority: flags.priority || 'normal',      // [changed] default 'normal' to match the UI's priority list
      for: ['human', 'agent'].includes(flags.for) ? flags.for : null,         // T-0155: who does it, a person or an AI worker
      status: 'proposed', proposed_by: flags.by, proposed_at: nowISO(),       // [new] waits for a human to approve
      approved_by: null, approved_at: null,                                   // [new] filled by approve
      rejected_by: null, rejected_at: null, reject_reason: null,              // [new] filled by reject
      assignee: null, claimed_at: null,                                       // [new] filled by claim
      closed_by: null, closed_at: null,                                       // [new] filled by close
      updates: [],                                                            // [new] progress notes, plus the CLOSED note
    });
    data.next_id++;                                                           // [new] reserve the id
    save(data);                                                               // [new] persist
    console.log(`Proposed ${id}: ${flags.title}`);                            // [new] stdout goes back to the Chamber UI
    break;
  }
  case 'approve': {                                                           // [new] proposed -> approved
    const t = findTicket(pos[1] || fail('approve requires a ticket id'));     // [new] id is the second positional
    if (!flags.by) fail('approve requires --by');                             // [new] record who approved
    if (t.status !== 'proposed') fail(`only proposed tickets can be approved (${t.id} is ${t.status})`); // [new] no approving twice or after reject
    if (t.changes) fail(`changes were asked for on ${t.id} by ${t.changes.by}; it waits for a new version of the change, or that request can be withdrawn`);   // T-0189
    if (flags.standing) {                                                     // T-0200: approved in advance by a standing approval the server checked; the person who set it up is the approver on record
      let s; try { s = JSON.parse(flags.standing); } catch { fail('--standing must be JSON'); }
      if (!s || !/^S-\d+$/.test(String(s.id))) fail('--standing needs the standing approval');
      t.updates = Array.isArray(t.updates) ? t.updates : [];
      t.approvals = [{ by: flags.by, at: nowISO(), standing: s.id }]; t.standing = s; delete t.standing_was;
      t.updates.push({ at: nowISO(), by: flags.by, note: `APPROVED IN ADVANCE by standing approval ${s.id} (set up by ${s.by}${s.confirmedBy ? ', confirmed by ' + s.confirmedBy : ''}): "${s.what}". Limits: done by ${s.agent} only, as a pull request a person merges, at most ${s.maxFiles} file${s.maxFiles === 1 ? '' : 's'}${Array.isArray(s.paths) && s.paths.length ? ', only in ' + s.paths.join(', ') : ''}.` });
      t.status = 'approved'; t.approved_by = flags.by; t.approved_at = nowISO();
      save(data); console.log(`Approved ${t.id} in advance by standing approval ${s.id}`); break;
    }
    const needs = Math.min(3, Math.max(1, parseInt(flags.needs, 10) || 1));       // T-0190: how many different people must approve (the server works it out)
    t.approvals = Array.isArray(t.approvals) ? t.approvals : []; t.updates = Array.isArray(t.updates) ? t.updates : [];
    if (t.approvals.some(a => String(a.by).toLowerCase() === String(flags.by).toLowerCase())) fail(`${flags.by} has already approved ${t.id}; it waits for a different person`);
    t.approvals.push({ by: flags.by, at: nowISO() });
    if (flags.note) t.updates.push({ at: nowISO(), by: flags.by, note: `APPROVAL RULES: ${flags.note}` });
    if (needs > 1) t.approvals_needed = needs;
    if (t.approvals.length < needs) {                                         // T-0190: recorded, but it waits for another person
      t.updates.push({ at: nowISO(), by: flags.by, note: `APPROVED ${t.approvals.length} of ${needs}: waits for another person to approve` });
      save(data); console.log(`Approved ${t.id} (${t.approvals.length} of ${needs}): waits for another person to approve`); break;
    }
    t.status = 'approved'; t.approved_by = flags.by; t.approved_at = nowISO(); // [new] state change + audit fields
    save(data); console.log(`Approved ${t.id}`); break;                       // [new] persist and report
  }
  case 'reject': {                                                            // [new] proposed -> rejected
    const t = findTicket(pos[1] || fail('reject requires a ticket id'));      // [new] id is the second positional
    if (!flags.by) fail('reject requires --by');                              // [new] record who rejected
    if (!flags.reason) fail('reject requires --reason');                      // [new] a rejection must say why
    if (t.status !== 'proposed') fail(`only proposed tickets can be rejected (${t.id} is ${t.status})`); // [new] only open proposals
    t.status = 'rejected'; t.rejected_by = flags.by; t.rejected_at = nowISO(); t.reject_reason = flags.reason; // [new] state change + audit fields
    save(data); console.log(`Rejected ${t.id}`); break;                       // [new] persist and report
  }
  case 'claim': {                                                             // [new] approved -> in_progress
    const t = findTicket(pos[1] || fail('claim requires a ticket id'));       // [new] id is the second positional
    if (!flags.by) fail('claim requires --by');                               // [new] the claimer becomes the assignee
    if (t.status !== 'approved') fail(`only approved tickets can be claimed (${t.id} is ${t.status})`); // [new] no work before approval
    t.status = 'in_progress'; t.assignee = flags.by; t.claimed_at = nowISO(); // [new] state change + owner
    save(data); console.log(`Claimed ${t.id} -> ${flags.by}`); break;         // [new] persist and report
  }
  case 'update': {                                                            // [new] add a progress note
    const t = findTicket(pos[1] || fail('update requires a ticket id'));      // [new] id is the second positional
    if (!flags.by) fail('update requires --by');                              // [new] record who wrote it
    if (!flags.note) fail('update requires --note');                          // [new] empty notes are pointless
    t.updates = t.updates || [];                                              // [fix] stores made elsewhere may lack the list; close already guarded this, update crashed
    t.updates.push({ at: nowISO(), by: flags.by, note: flags.note });         // [new] append to the history
    save(data); console.log(`Updated ${t.id}`); break;                        // [new] persist and report
  }
  case 'close': {                                                             // [new] -> done, with a note
    const t = findTicket(pos[1] || fail('close requires a ticket id'));       // [new] id is the second positional
    if (!flags.by) fail('close requires --by');                               // [new] record who closed it
    if (t.status !== 'approved' && t.status !== 'in_progress') {              // [fix] lifecycle bug: close used to work from any status
      fail(`only approved or in-progress tickets can be closed (${t.id} is ${t.status})`);  // [fix] no closing a ticket nobody approved, and no re-close overwriting closed_by
    }
    // A close must state what it actually covered. The commonest defect in closed
    // tickets is a note that claims more than the work did: a scope item quietly
    // dropped, a check described but never run, a sample generalised into "every".
    // Closing with no note was free, so it happened; now it costs one sentence per item.
    if (!flags.note || flags.note.trim().length < 20) {                       // [new] 20 chars: enough for one 'item: result' line
      fail('close requires --note (min 20 chars). Name each item in the ticket body and its result.\n' + // [new] the error explains what a good note holds
           '  If an item was not done, say so and leave the ticket open instead of closing over it.\n' +
           '  Example: --note "1. login fix: done, verified after a restart. ' +
           '2. docs update: NOT DONE, waiting on review."');
    }
    t.status = 'done'; t.closed_by = flags.by; t.closed_at = nowISO();        // [new] state change + audit fields
    t.updates = t.updates || [];                                              // [new] older stores may lack the list
    t.updates.push({ at: nowISO(), by: flags.by, note: `CLOSED: ${flags.note.trim()}` }); // [new] the close note joins the history, marked CLOSED
    save(data); console.log(`Closed ${t.id}`); break;                         // [new] persist and report
  }
  case 'edit': {                                                              // [new] change a proposal before approval
    const t = findTicket(pos[1] || fail('edit requires a ticket id'));        // [new] id is the second positional
    if (!flags.by) fail('edit requires --by');                                // [new] record who edited
    if (t.status !== 'proposed') fail(`only proposed tickets can be edited (${t.id} is ${t.status})`); // [new] approved scope is frozen
    let changed = false;                                                      // [new] track whether anything was given
    for (const f of ['title', 'body', 'type', 'priority']) {                  // [new] the editable fields
      if (typeof flags[f] === 'string' && flags[f].length) { t[f] = flags[f]; changed = true; } // [new] only non-empty values overwrite
    }
    if (typeof flags.for === 'string') { if (!['human', 'agent'].includes(flags.for)) fail('--for must be human or agent'); t.for = flags.for; changed = true; }   // T-0155
    if (!changed) fail('edit requires at least one of --title/--body/--type/--priority/--for'); // [new] nothing to do: say so
    if (Array.isArray(t.approvals) && t.approvals.length) {                  // T-0190: what was approved is not what is there now
      (t.updates = Array.isArray(t.updates) ? t.updates : []).push({ at: nowISO(), by: flags.by, note: `EDITED after ${t.approvals.map(a => a.by).join(', ')} approved: that approval was cleared, so the new version must be approved again` });
      t.approvals = [];
    }
    save(data); console.log(`Edited ${t.id}`); break;                         // [new] persist and report
  }
  case 'for': {                                                              // T-0155: a person decides who does the ticket; allowed until work starts
    const t = findTicket(pos[1] || fail('for requires a ticket id'));
    if (!flags.by) fail('for requires --by');
    if (!['human', 'agent'].includes(flags.for)) fail('--for must be human or agent');
    if (!['proposed', 'approved'].includes(t.status)) fail(`who does ${t.id} can only change while it is proposed or approved (it is ${t.status})`);
    const was = t.for || null; t.for = flags.for;
    t.updates.push({ at: nowISO(), by: flags.by, note: `FOR: ${flags.for === 'human' ? 'a person' : 'an agent'}${was ? ` (was ${was === 'human' ? 'a person' : 'an agent'})` : ''}` });
    save(data); console.log(`${t.id} is now for ${flags.for === 'human' ? 'a person' : 'an agent'}`); break;
  }
  case 'meta': {                                                              // T-0072: one server-managed field; the server decides who may call this
    const t = findTicket(pos[1] || fail('meta requires a ticket id'));
    if (!flags.by) fail('meta requires --by');
    const allowed = ['applied', 'apply_by', 'reverts', 'reverted_by', 'reviewer', 'pr', 'github', 'request_mail', 'draft', 'draft_job', 'approved_diff', 'client_questions'];   // T-0205: + request_mail   // T-0189: + reviewer; T-0191: + pr; T-0197: + github
    if (!allowed.includes(flags.set)) fail(`meta --set must be one of ${allowed.join(', ')}`);
    let value; try { value = JSON.parse(flags.json); } catch { fail('meta requires --json <value>'); }
    t[flags.set] = value;
    save(data); console.log(`Set ${flags.set} on ${t.id}`); break;
  }
  case 'check': {                                                             // T-0223: a person's check of finished work (the Reviews tab)
    // check <id> --by X --state ok [--note ..]      looks good
    // check <id> --by X --state back --note ..      sent back: the note says what is wrong, and a follow-up ticket is made in the same step
    // check <id> --by X --state undo                takes a "looks good" back
    // check --by X --before <ISO date>              every finished ticket closed before then is marked checked ("start fresh")
    // Nobody checks work they finished themselves. The server decides who may call this at all (people who may approve).
    if (!flags.by) fail('check requires --by');
    if (flags.before) {
      const cut = Date.parse(flags.before); if (!Number.isFinite(cut)) fail('check --before needs a date');
      let n = 0;
      for (const t of data.tickets) if (t.status === 'done' && !t.check && t.closed_by !== flags.by && Date.parse(t.closed_at) < cut) { t.check = { state: 'ok', by: flags.by, at: nowISO(), bulk: true }; n++; }
      save(data); console.log(`Checked ${n}`); break;
    }
    const t = findTicket(pos[1] || fail('check requires a ticket id'));
    t.updates = t.updates || [];
    if (flags.state === 'undo') {
      if (!t.check) fail(`${t.id} has no check to take back`);
      if (t.check.state === 'back') fail(`${t.id} was sent back and its follow-up ${t.check.followup || ''} exists; reject or finish the follow-up instead`);
      delete t.check; t.updates.push({ at: nowISO(), by: flags.by, note: 'CHECK taken back' });
      save(data); console.log(`Unchecked ${t.id}`); break;
    }
    if (t.status !== 'done') fail(`only a finished ticket can be checked (${t.id} is ${t.status})`);
    if (t.check) fail(`${t.id} was already checked by ${t.check.by}`);
    if (t.closed_by === flags.by) fail(`${t.id} was finished by ${flags.by}; someone else checks it`);
    const note = String(flags.note || '').trim();
    if (flags.state === 'ok') {
      t.check = { state: 'ok', by: flags.by, at: nowISO(), ...(note ? { note } : {}) };
      t.updates.push({ at: nowISO(), by: flags.by, note: 'CHECKED: looks good' + (note ? '. ' + note : '') });
      save(data); console.log(`Checked ${t.id}`); break;
    }
    if (flags.state !== 'back') fail('check --state must be ok, back or undo');
    if (note.length < 5) fail('sending a ticket back needs --note saying what is wrong or missing');
    const fid = fmtId(data.next_id), tag = (String(t.title).match(/^\s*(\[[A-Za-z-]{1,12}\])/) || [])[1];   // the follow-up stays in the same lane ([agent], [human], [product] ...)
    const closed = [...t.updates].reverse().find(u => String(u.note || '').startsWith('CLOSED: '));
    data.tickets.push({
      id: fid, title: `${tag ? tag + ' ' : ''}Follow-up to ${t.id}: ${note.replace(/\s+/g, ' ').slice(0, 90)}`,
      body: `Sent back by ${flags.by} after checking ${t.id} ("${t.title}").\n\nWHAT IS WRONG OR MISSING\n${note}\n\nWHAT WAS ASKED (${t.id})\n${String(t.body || '(no text)').slice(0, 3000)}\n\nWHAT WAS REPORTED AS DONE\n${closed ? closed.note.slice(8, 3008) : '(no closing note)'}`,
      type: t.type === 'request' ? 'task' : (t.type || 'task'), priority: t.priority || 'normal', for: t.for || null, followup_of: t.id,
      status: 'proposed', proposed_by: flags.by, proposed_at: nowISO(), approved_by: null, approved_at: null, rejected_by: null, rejected_at: null, reject_reason: null,
      assignee: null, claimed_at: null, closed_by: null, closed_at: null, updates: [],
    });
    data.next_id++;
    t.check = { state: 'back', by: flags.by, at: nowISO(), note, followup: fid };
    t.updates.push({ at: nowISO(), by: flags.by, note: `SENT BACK: ${note} (follow-up ${fid})` });
    save(data); console.log(`Sent back ${t.id}, follow-up ${fid}`); break;
  }
  case 'changes': {                                                           // T-0189: a reviewer asks for changes to the proposed change (or withdraws that)
    const t = findTicket(pos[1] || fail('changes requires a ticket id'));
    if (!flags.by) fail('changes requires --by');
    if (t.status !== 'proposed') fail(`changes can only be asked for while ${t.id} is proposed (it is ${t.status})`);
    t.updates = Array.isArray(t.updates) ? t.updates : [];
    if (flags.withdraw) {
      if (!t.changes) fail(`no request for changes on ${t.id} to withdraw`);
      t.updates.push({ at: nowISO(), by: flags.by, note: `WITHDRAWN: the request for changes made by ${t.changes.by} was withdrawn; the current version can be approved` });
      delete t.changes; save(data); console.log(`Withdrew the request for changes on ${t.id}`); break;
    }
    const v = Math.max(1, parseInt(flags.version, 10) || 1), note = String(flags.note || '').slice(0, 2000), had = Array.isArray(t.approvals) ? t.approvals.length : 0;
    t.changes = { by: flags.by, at: nowISO(), version: v, note };
    t.approvals = [];
    t.updates.push({ at: nowISO(), by: flags.by, note: `CHANGES REQUESTED on version ${v}${note ? ': ' + note : ''}${had ? ' (the earlier approval was cleared)' : ''}` });
    save(data); console.log(`Changes requested on ${t.id} (version ${v})`); break;
  }
  case 'revised': {                                                           // T-0189: a new version of the change was attached
    const t = findTicket(pos[1] || fail('revised requires a ticket id'));
    if (!flags.by) fail('revised requires --by');
    if (t.status !== 'proposed') fail(`a new version can only be attached while ${t.id} waits for approval (it is ${t.status})`);   // review 2026-11-13: it used to say "the approval was cleared" on an approved ticket and leave it approved
    const v = Math.max(2, parseInt(flags.version, 10) || 2), was = t.changes, had = Array.isArray(t.approvals) ? t.approvals.length : 0;
    t.updates = Array.isArray(t.updates) ? t.updates : [];
    t.updates.push({ at: nowISO(), by: flags.by, note: `NEW VERSION ${v} of the change attached${was ? ` after the changes ${was.by} asked for` : ''}${had ? '; the earlier approval was cleared' : ''}` });
    delete t.changes; t.approvals = [];
    save(data); console.log(`Version ${v} recorded on ${t.id}`); break;
  }
  case 'unstand': {                                                           // T-0200: a ticket approved by a standing approval goes back to waiting for a person (a limit was crossed, or it was withdrawn)
    const t = findTicket(pos[1] || fail('unstand requires a ticket id'));
    if (!flags.by) fail('unstand requires --by');
    if (!t.standing) fail(`${t.id} was not approved by a standing approval`);
    if (t.status !== 'approved' && t.status !== 'in_progress') fail(`only approved or in-progress tickets can go back to waiting (${t.id} is ${t.status})`);
    t.standing_was = t.standing; delete t.standing;
    t.status = 'proposed'; t.approvals = []; t.approved_by = null; t.approved_at = null; t.assignee = null; t.claimed_at = null;
    t.updates = Array.isArray(t.updates) ? t.updates : [];
    t.updates.push({ at: nowISO(), by: flags.by, note: String(flags.note || `WAITS FOR A PERSON: back from standing approval ${t.standing_was.id}`).slice(0, 2000) });
    save(data); console.log(`${t.id} waits for a person again`); break;
  }
  case 'release': {                                                           // T-0143: in_progress -> approved. A human un-claims a stuck ticket so the agent retries or someone else takes it.
    const t = findTicket(pos[1] || fail('release requires a ticket id'));
    if (!flags.by) fail('release requires --by');
    if (t.status !== 'in_progress') fail(`only in-progress tickets can be released (${t.id} is ${t.status})`);
    const was = t.assignee; t.status = 'approved'; t.assignee = null; t.claimed_at = null; t.released_by = flags.by; t.released_at = nowISO();
    t.updates = t.updates || [];
    t.updates.push({ at: nowISO(), by: flags.by, note: `RELEASED from ${was || 'nobody'}: ${String(flags.note || 'back to approved so it can be claimed again').trim()}` });
    save(data); console.log(`Released ${t.id}`); break;
  }
  case 'cancel': {                                                            // T-0143: approved | in_progress -> rejected, with a reason. Reject only worked on proposals.
    const t = findTicket(pos[1] || fail('cancel requires a ticket id'));
    if (!flags.by) fail('cancel requires --by');
    if (!flags.reason) fail('cancel requires --reason');
    if (t.status !== 'approved' && t.status !== 'in_progress') fail(`only approved or in-progress tickets can be cancelled (${t.id} is ${t.status})`);
    t.status = 'rejected'; t.rejected_by = flags.by; t.rejected_at = nowISO(); t.reject_reason = flags.reason; t.assignee = null;
    t.updates = t.updates || [];
    t.updates.push({ at: nowISO(), by: flags.by, note: `CANCELLED: ${String(flags.reason).trim()}` });
    save(data); console.log(`Cancelled ${t.id}`); break;
  }
  case 'log': {                                                               // T-0143: one run-log line (and/or the model name) from whoever works the ticket. Capped at 200 lines.
    const t = findTicket(pos[1] || fail('log requires a ticket id'));
    if (!flags.by) fail('log requires --by');
    if (!flags.line && !flags.model && !flags.usage) fail('log requires --line, --model and/or --usage');
    if (flags.usage) {                                                        // T-0194: the worker reports what a run cost; totals are kept on the ticket
      let u; try { u = JSON.parse(flags.usage); } catch { fail('--usage must be JSON'); }
      const tot = t.usage && typeof t.usage === 'object' ? t.usage : { runs: 0, cost_cents: 0, tokens_in: 0, tokens_out: 0, ms: 0 };
      tot.runs = (tot.runs || 0) + 1; for (const k of ['cost_cents', 'tokens_in', 'tokens_out', 'ms']) if (typeof u[k] === 'number') tot[k] = Math.round(((tot[k] || 0) + u[k]) * 100) / 100;
      t.usage = tot;
    }
    t.log = Array.isArray(t.log) ? t.log : [];
    if (flags.line) { t.log.push({ at: nowISO(), by: flags.by, line: String(flags.line).slice(0, 300) }); if (t.log.length > 200) t.log = t.log.slice(-200); }
    if (flags.model) t.model = String(flags.model).slice(0, 60);
    save(data); console.log(`Logged ${t.id}`); break;
  }
  default:                                                                    // [new] anything else
    fail(`unknown verb: ${verb}`);                                            // [new] clear error for typos
}
