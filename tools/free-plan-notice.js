#!/usr/bin/env node
// tools/free-plan-notice.js (T-0295, 19 Nov 2026): the 30-day notice our Terms promise before a workspace's free plan changes.
//
//   node tools/free-plan-notice.js            list the earlier workspaces and whether their owner was told (changes nothing)
//   node tools/free-plan-notice.js --send     email each owner who was not told yet, and record the day (starts the 30 days)
//
// Run it as the service does: same user, same settings (CHAMBER_DATA or CHAMBER_ACCOUNTS_FILE, the mail settings, CHAMBER_PRICING2_AT).
// It refuses to mark anyone as told when mail is switched off, so a workspace is never counted as told without an email.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const fs = require('fs'), path = require('path');
const mail = require(path.join(__dirname, '..', 'mail.js'));
const FILE = process.env.CHAMBER_ACCOUNTS_FILE || path.join(path.dirname(process.env.CHAMBER_DATA || path.join(__dirname, '..', 'chamber.json')), 'accounts.json');
const CUT = Date.parse(process.env.CHAMBER_PRICING2_AT || '2026-11-19T00:00:00Z') || 0, DAYS = 30;
const PUBLIC_URL = (process.env.CHAMBER_PUBLIC_URL || 'https://chamber.ghostporttechnologies.com').replace(/\/+$/, '');
const CONTACT = process.env.CHAMBER_CONTACT_TO || 'support@ghostporttechnologies.com';
const send = process.argv.includes('--send');
const mask = e => String(e).replace(/^(.).*(@.*)$/, '$1…$2');
const day = t => new Date(t).toISOString().slice(0, 10);
const load = () => JSON.parse(fs.readFileSync(FILE, 'utf8'));
const letter = (owner, starts) => ({ to: owner.email, subject: 'Chamber: the free plan is getting bigger (nothing you need to do)',
  text: `Hello ${owner.username},\n\nYou own a Chamber workspace. Our Terms promise 30 days' notice before the free plan changes, so here it is.\n\n`
    + `What changes for your workspace on ${day(starts)}: the free plan will cover up to 3 people (you and the two people who joined first), with 2 AI agents each. Today it covers one person. Nothing is taken away, and nothing is deleted.\n\n`
    + `The paid plans changed on ${day(CUT)}. Team is $49 a year for up to 5 builders, and a new Company plan is $199 a year for up to 25. Approvers, viewers and requesters use no seat. `
    + `Because your workspace is older than that change, it keeps its deal: if you subscribe to Team, it has room for up to 25 builders at $49 a year. The first 100 workspaces to subscribe keep the price they subscribed at for as long as they stay subscribed.\n\n`
    + `Your account page: ${PUBLIC_URL}/billing\nThe Terms: ${PUBLIC_URL}/terms\n\nQuestions? Reply to this email or write to ${CONTACT}.\n\nThomas\nGhostPort Technologies\n` });
(async () => {
  let store; try { store = load(); } catch (e) { console.error('cannot read ' + FILE + ': ' + e.message); process.exit(2); }
  const rows = Object.values(store.workspaces || {}).filter(w => (w.createdAt || 0) < CUT).map(w => ({ w, owner: store.accounts[w.owner] })).filter(r => r.owner && r.owner.role !== 'admin');
  const todo = rows.filter(r => !r.w.freeNoticeAt);
  console.log(`${rows.length} earlier workspace(s) (not counting the site's own); ${rows.length - todo.length} already told, ${todo.length} not yet.`);
  for (const r of rows) console.log(`  ${r.w.id.slice(0, 6)}…  owner ${mask(r.owner.email)}  ${r.w.freeNoticeAt ? 'told ' + day(r.w.freeNoticeAt) + ', free plan changes ' + day(r.w.freeNoticeAt + DAYS * 864e5) : 'not told'}`);
  if (!send) { if (todo.length) console.log('Nothing was sent. Run again with --send once the email text is approved.'); return; }
  if (!todo.length) { console.log('Nobody left to tell.'); return; }
  if (!mail.enabled) { console.error('Mail is switched off here, so nothing was sent and nobody was marked as told.'); process.exit(1); }
  let ok = 0;
  for (const r of todo) {
    const now = Date.now();
    try { await mail.send(letter(r.owner, now + DAYS * 864e5)); } catch (e) { console.error(`  could not email ${mask(r.owner.email)}: ${e.message}. Not marked.`); continue; }
    const fresh = load(); if (!fresh.workspaces[r.w.id]) continue;                 // re-read: the service may have written meanwhile
    fresh.workspaces[r.w.id].freeNoticeAt = now;
    const tmp = FILE + '.tmp.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(fresh), { mode: 0o600 }); fs.renameSync(tmp, FILE);
    console.log(`  emailed ${mask(r.owner.email)}; its free plan changes on ${day(now + DAYS * 864e5)}`); ok++;
  }
  console.log(`${ok} of ${todo.length} told.`); if (ok !== todo.length) process.exit(1);
})();
