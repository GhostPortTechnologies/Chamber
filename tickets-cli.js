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
//
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 GhostPort Technologies
// Free software under the GNU Affero General Public License v3; NO WARRANTY. See LICENSE.
const fs = require('fs');                                                     // [new] file reads/writes for the JSON store
const path = require('path');                                                 // [new] dirname() for the store folder

const STORE = process.env.CHAMBER_TICKETS_FILE || '';                         // [new] store path comes from the same env var Chamber reads
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
  try { raw = fs.readFileSync(STORE, 'utf8'); }                               // [fix] read the file
  catch (e) {                                                                 // [fix] the read failed: find out why
    if (e.code === 'ENOENT') return { next_id: 1, tickets: [] };              // [fix] no file yet (first run): the one case that starts empty
    fail(`cannot read ticket store ${STORE}: ${e.message}\nNothing was changed.`);  // [fix] permissions or disk error: refuse rather than overwrite the board
  }
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
  fs.writeSync(fd, JSON.stringify(data, null, 2));                            // [new] pretty-printed so diffs and hand edits stay readable
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
    const allowed = ['applied', 'apply_by', 'reverts', 'reverted_by'];
    if (!allowed.includes(flags.set)) fail(`meta --set must be one of ${allowed.join(', ')}`);
    let value; try { value = JSON.parse(flags.json); } catch { fail('meta requires --json <value>'); }
    t[flags.set] = value;
    save(data); console.log(`Set ${flags.set} on ${t.id}`); break;
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
    if (!flags.line && !flags.model) fail('log requires --line and/or --model');
    t.log = Array.isArray(t.log) ? t.log : [];
    if (flags.line) { t.log.push({ at: nowISO(), by: flags.by, line: String(flags.line).slice(0, 300) }); if (t.log.length > 200) t.log = t.log.slice(-200); }
    if (flags.model) t.model = String(flags.model).slice(0, 60);
    save(data); console.log(`Logged ${t.id}`); break;
  }
  default:                                                                    // [new] anything else
    fail(`unknown verb: ${verb}`);                                            // [new] clear error for typos
}
