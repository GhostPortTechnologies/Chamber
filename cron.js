// cron.js — tiny 5-field cron matcher with IANA time zones, zero dependencies (T-0058).
//   due('30 7 * * 1-5', new Date(), 'America/Los_Angeles')  -> true when it is 07:30 on a weekday in LA
//   valid(spec) -> true/false        next(spec, tz, from) -> Date of the next due minute within 8 days, or null
// Fields: minute hour day-of-month month day-of-week (0-6, 7=Sunday). Each field: * | n | a-b | a,b,c | */n | a-b/n.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseField(expr, idx) {
  const [min, max] = RANGES[idx]; const set = new Set();
  const name = (t) => { const k = t.toLowerCase(); if (idx === 4 && k in DOW) return DOW[k]; if (idx === 3 && k in MON) return MON[k]; return Number(t); };
  for (const part of String(expr).split(',')) {
    const m = part.match(/^(\*|[A-Za-z0-9]+(?:-[A-Za-z0-9]+)?)(?:\/(\d+))?$/);
    if (!m) return null;
    const step = m[2] ? Number(m[2]) : 1; if (!(step >= 1)) return null;
    let a = min, b = max;
    if (m[1] !== '*') { const [x, y] = m[1].split('-'); a = name(x); b = y === undefined ? (m[2] ? max : a) : name(y); if (!Number.isInteger(a) || !Number.isInteger(b) || a < min || b > max || a > b) return null; }
    for (let v = a; v <= b; v += step) set.add(idx === 4 && v === 7 ? 0 : v);
  }
  return set;
}
function parse(spec) {
  const f = String(spec || '').trim().split(/\s+/); if (f.length !== 5) return null;
  const sets = f.map(parseField); return sets.every(Boolean) ? sets : null;
}
function valid(spec) { return !!parse(spec); }
function partsIn(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hour12: false, minute: '2-digit', hour: '2-digit', day: '2-digit', month: '2-digit', weekday: 'short' });
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return { minute: Number(p.minute), hour: Number(p.hour) % 24, day: Number(p.day), month: Number(p.month), dow: DOW[p.weekday.toLowerCase().slice(0, 3)] };
}
function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }
function due(spec, date = new Date(), tz = 'UTC') {
  const s = parse(spec); if (!s) return false;
  const t = partsIn(date, tz);
  return s[0].has(t.minute) && s[1].has(t.hour) && s[2].has(t.day) && s[3].has(t.month) && s[4].has(t.dow);
}
function next(spec, tz = 'UTC', from = new Date(), maxMinutes = 8 * 24 * 60) {
  if (!parse(spec)) return null;
  const start = Math.floor(from.getTime() / 60000) * 60000 + 60000;            // the next whole minute after `from`
  for (let i = 0; i < maxMinutes; i++) { const d = new Date(start + i * 60000); if (due(spec, d, tz)) return d; }
  return null;
}
const PRESETS = { hourly: '0 * * * *', every15: '*/15 * * * *', every5: '*/5 * * * *' };
function fromPreset(preset, time) {                                         // 'daily' / 'weekdays' + 'HH:MM'
  if (PRESETS[preset]) return PRESETS[preset];
  const m = String(time || '').match(/^(\d{1,2}):(\d{2})$/); if (!m) return null;
  const H = Number(m[1]), M = Number(m[2]); if (H > 23 || M > 59) return null;
  if (preset === 'daily') return `${M} ${H} * * *`;
  if (preset === 'weekdays') return `${M} ${H} * * 1-5`;
  return null;
}
module.exports = { parse, valid, due, next, validTz, fromPreset, PRESETS };
