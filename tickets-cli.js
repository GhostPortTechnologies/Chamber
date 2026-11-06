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

function load() {                                                             // [new] read the store
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')); }                  // [new] normal case: parse the JSON file
  catch { return { next_id: 1, tickets: [] }; }                               // [new] first run (no file yet): start empty
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
if (!Array.isArray(data.tickets)) { data.tickets = []; }                      // [new] repair a store missing its list
if (!data.next_id) data.next_id = 1;                                          // [new] repair a store missing its counter

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
    t.updates.push({ at: nowISO(), by: flags.by, note: flags.note });         // [new] append to the history
    save(data); console.log(`Updated ${t.id}`); break;                        // [new] persist and report
  }
  case 'close': {                                                             // [new] -> done, with a note
    const t = findTicket(pos[1] || fail('close requires a ticket id'));       // [new] id is the second positional
    if (!flags.by) fail('close requires --by');                               // [new] record who closed it
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
    if (!changed) fail('edit requires at least one of --title/--body/--type/--priority'); // [new] nothing to do: say so
    save(data); console.log(`Edited ${t.id}`); break;                         // [new] persist and report
  }
  default:                                                                    // [new] anything else
    fail(`unknown verb: ${verb}`);                                            // [new] clear error for typos
}
