// notify.js — per-person push routing for Chamber (T-0078): per-room level + quiet hours.
// Pure functions, no side effects, no dependencies beyond Intl — tested directly in test_isolation.js, like cron.js.
// The push sender (accounts.pushTo) and the quiet-hours flush (accounts.flushQuietHeld) are the only callers.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';

const LEVELS = ['all', 'mentions', 'muted'];                       // per-room notification level

// The level this account has chosen for a room. Default 'mentions' = @-mentions + DMs, the behaviour before T-0078,
// so an account that never touches the setting notices no change. Stored only when it differs from the default.
function levelFor(acct, room) {
  const l = acct && acct.notify && acct.notify[room];
  return LEVELS.includes(l) ? l : 'mentions';
}

// Should this account be pushed for this message, ignoring quiet hours?
//   isDmRecipient — the message is a DM and this account is the counterpart (always reaches them, even if the DM room is muted)
//   mentioned     — this account is @-mentioned in the message
function wantsPush(level, { isDmRecipient, mentioned } = {}) {
  if (isDmRecipient) return true;        // a DM always reaches its recipient
  if (level === 'muted') return false;   // a muted room: nothing for a plain message or even an @-mention
  if (level === 'all') return true;      // every message in the room
  return !!mentioned;                    // 'mentions': only @-mentions (DMs handled above)
}

function parseHM(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? '' : v));
  if (!m) return null;
  const H = Number(m[1]), M = Number(m[2]);
  return (H < 24 && M < 60) ? H * 60 + M : null;   // minutes past local midnight
}

function minutesOfDay(date, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hour12: false, hour: '2-digit', minute: '2-digit' }).formatToParts(date);
  const o = Object.fromEntries(p.map(x => [x.type, x.value]));
  return (Number(o.hour) % 24) * 60 + Number(o.minute);
}

// quiet: { enabled, start:'HH:MM', end:'HH:MM', tz }. The window may wrap past midnight (e.g. 22:00 -> 07:00).
// Half-open [start, end): the end minute is already outside, so a flush tick at the end minute delivers.
function inQuietHours(quiet, now = new Date()) {
  if (!quiet || !quiet.enabled) return false;
  const s = parseHM(quiet.start), e = parseHM(quiet.end);
  if (s == null || e == null || s === e) return false;
  const t = minutesOfDay(now, quiet.tz);
  return s < e ? (t >= s && t < e) : (t >= s || t < e);
}

// The whole decision for one message and one account: 'send' | 'hold' | 'skip'.
function decide(acct, { room, isDmRecipient, mentioned } = {}, now = new Date()) {
  if (!wantsPush(levelFor(acct, room), { isDmRecipient, mentioned })) return 'skip';
  return inQuietHours(acct && acct.quiet, now) ? 'hold' : 'send';
}

module.exports = { LEVELS, levelFor, wantsPush, inQuietHours, decide, parseHM, minutesOfDay };
