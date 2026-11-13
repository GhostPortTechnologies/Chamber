// auditchain.js (T-0194): the check values that make a workspace's activity record tamper-evident.
// Every entry carries n (its number), prev (the check value of the entry before it) and h (its own check value: SHA-256 of
// prev and the entry itself). Change or remove an old entry and the check values after it stop matching; remove the newest
// entries and the stored head (audit-head.json) stops matching. Used by server.js and by tools/verify-audit.js, so both
// compute exactly the same thing.
// T-0219: an owner may limit how long the record is kept. The oldest entries are then removed as one front part, and the stored head
// remembers up to which entry number that was done (head.trimmed.upto). Entries missing beyond that point make the check fail,
// so removing old entries by hand shows, which it did not before.
// What this does NOT protect against: someone with full access to the server who rewrites the whole chain. Keep a copy of the
// check value the account page shows (or of an export) somewhere else, and you can tell even then.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const crypto = require('crypto');
function hash(r) { const { h, _where, ...rest } = r; return crypto.createHash('sha256').update(String(rest.prev || '') + '\n' + JSON.stringify(rest)).digest('hex'); }
// entries: in the order they were written (each may carry _where: {file, line} for messages). head: {n, h} or null.
function verify(entries, head) {
  let prev = null, last = null, checked = 0, before = 0, firstKept = null;
  const at = r => ({ n: r.n, ts: r.ts, actor: r.actor || r.agent, action: r.action, ...(r._where || {}) });
  for (const r of entries) {
    if (!r || typeof r !== 'object') return { ok: false, checked, before, reason: 'an entry is not readable any more' };
    if (!r.h) { if (last) return { ok: false, checked, before, at: at(r), reason: 'an entry without a check value sits among checked entries' }; before++; continue; }
    if (!last) { firstKept = r.n; prev = r.prev || null; }            // the oldest kept entry: what came before it may have been removed by retention
    if ((r.prev || null) !== prev) return { ok: false, checked, before, at: at(r), reason: 'an entry just before this one was removed or changed' };
    if (hash(r) !== r.h) return { ok: false, checked, before, at: at(r), reason: 'this entry was changed after it was written' };
    if (last && r.n !== last.n + 1) return { ok: false, checked, before, at: at(r), reason: 'entries are missing just before this one' };
    prev = r.h; last = r; checked++;
  }
  if (head && last && (head.h !== last.h || head.n !== last.n)) return { ok: false, checked, before, at: at(last), reason: 'the newest entries were removed' };
  if (head && head.n && !last) return { ok: false, checked, before, reason: 'the checked entries are gone' };
  const trimmedUpto = (head && head.trimmed && head.trimmed.upto) || 0;
  if (head && firstKept !== null && firstKept > trimmedUpto + 1) return { ok: false, checked, before, reason: 'older entries were removed, and not by the setting for how long the record is kept' };
  return { ok: true, checked, before, firstKept, n: last ? last.n : 0, head: last ? last.h : null, trimmedUpto };
}
module.exports = { hash, verify };
