// tasks.js (T-0224): recurring tasks, a checklist for people that resets itself. A task comes back every day, every week (on one
// weekday) or every month (on one day of the month). Ticking it off counts for the current day, week or month only, so when the
// next one starts the box is empty again; nothing has to run at midnight for that. Weeks run Monday to Sunday (ISO weeks), and a
// task's days start at midnight in the time zone of whoever added it. Storage and the routes are in server.js; this file is the
// pure logic, so the tests can try any date.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const EVERY = ['day', 'week', 'month'];
const MAX_TASKS = 100, MAX_TITLE = 140, KEEP_DONE = 60;
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const pad = n => String(n).padStart(2, '0');

function validTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }
function localParts(ts, tz) {                                                    // the calendar date at ts in tz: { y, m, d, wd: 1 = Monday .. 7 = Sunday }
  const o = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric', weekday: 'short' }).formatToParts(new Date(ts))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, wd: { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }[o.weekday] };
}
function isoWeek(y, m, d) {                                                      // e.g. 2026-W47; the week belongs to the year its Thursday is in
  const t = new Date(Date.UTC(y, m - 1, d)), wd = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - wd);
  const yr = t.getUTCFullYear(), wk = Math.ceil(((t - Date.UTC(yr, 0, 1)) / 864e5 + 1) / 7);
  return `${yr}-W${pad(wk)}`;
}
function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function periodOf(every, ts, tz) {                                               // the day, week or month a tick at ts counts for
  const p = localParts(ts, tz);
  if (every === 'day') return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  if (every === 'week') return isoWeek(p.y, p.m, p.d);
  return `${p.y}-${pad(p.m)}`;
}
// Where a task stands at `now`: done in this period (by whom, when), or due today, due later in the period, or late.
// A monthly task set for the 31st is due on the last day of a shorter month.
function status(task, now) {
  const p = localParts(now, task.tz), period = periodOf(task.every, now, task.tz);
  const done = (task.done || []).find(x => x.p === period) || null;
  const last = (task.done || []).filter(x => x.p !== period).slice(-1)[0] || null;
  let due = 'today', dueOn = null;
  if (task.every === 'week') { dueOn = WEEKDAYS[task.day - 1]; due = p.wd < task.day ? 'later' : p.wd === task.day ? 'today' : 'late'; }
  if (task.every === 'month') { const d = Math.min(task.day, daysInMonth(p.y, p.m)); dueOn = d; due = p.d < d ? 'later' : p.d === d ? 'today' : 'late'; }
  return { period, done, last, due: done ? 'done' : due, dueOn };
}
function view(task, now) {                                                       // what the app is sent for one task
  const s = status(task, now);
  return { id: task.id, title: task.title, every: task.every, day: task.day, tz: task.tz, by: task.by, at: task.at, editedBy: task.editedBy, ...s,
           streak: streak(task, now) };
}
function streak(task, now) {                                                     // how many periods in a row, up to the last one, were done
  const have = new Set((task.done || []).map(x => x.p));
  let n = 0, k = periodOf(task.every, now, task.tz);
  if (!have.has(k)) k = prevPeriod(task.every, k);                               // this period not done yet: count from the one before
  for (let i = 0; i < KEEP_DONE && have.has(k); i++) { n++; k = prevPeriod(task.every, k); }
  return n;
}
function prevPeriod(every, key) {                                                // the period before, worked out on the calendar (no clock or time zone involved)
  if (every === 'day') { const [y, m, d] = key.split('-').map(Number), t = new Date(Date.UTC(y, m - 1, d - 1)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; }
  if (every === 'week') {
    const [y, w] = key.split('-W').map(Number), jan4 = new Date(Date.UTC(y, 0, 4)), mon = new Date(jan4.getTime() - ((jan4.getUTCDay() || 7) - 1) * 864e5 + (w - 1) * 7 * 864e5 - 7 * 864e5);
    return isoWeek(mon.getUTCFullYear(), mon.getUTCMonth() + 1, mon.getUTCDate());
  }
  const [y, m] = key.split('-').map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}
function countDue(items, now) { return items.filter(t => ['today', 'late'].includes(status(t, now).due)).length; }
// The fields a person may set, checked. Returns { error } or { title, every, day, tz }.
function clean(b, prev) {
  const title = String(b && b.title != null ? b.title : prev ? prev.title : '').replace(/\s+/g, ' ').trim();
  if (title.length < 2 || title.length > MAX_TITLE) return { error: `Say what needs doing in 2 to ${MAX_TITLE} characters.` };
  const every = String((b && b.every) || (prev && prev.every) || '');
  if (!EVERY.includes(every)) return { error: 'every must be day, week or month' };
  let day = b && b.day != null ? parseInt(b.day, 10) : prev && prev.every === every ? prev.day : 1;
  if (every === 'day') day = null;
  else if (every === 'week' && !(day >= 1 && day <= 7)) return { error: 'For a weekly task pick a weekday (1 = Monday to 7 = Sunday).' };
  else if (every === 'month' && !(day >= 1 && day <= 31)) return { error: 'For a monthly task pick a day of the month (1 to 31).' };
  const tz = String((b && b.tz) || (prev && prev.tz) || 'UTC');
  if (!validTz(tz)) return { error: 'Unknown time zone. Use a name like America/Los_Angeles or UTC.' };
  return { title, every, day, tz };
}
function tick(task, by, now) {                                                   // ticked off for this period; false if it already was
  const p = periodOf(task.every, now, task.tz);
  if ((task.done || []).some(x => x.p === p)) return false;
  (task.done ||= []).push({ p, by, at: now });
  if (task.done.length > KEEP_DONE) task.done = task.done.slice(-KEEP_DONE);
  return true;
}
function untick(task, now) {                                                     // the tick for this period taken back; false if there was none
  const p = periodOf(task.every, now, task.tz), before = (task.done || []).length;
  task.done = (task.done || []).filter(x => x.p !== p);
  return task.done.length !== before;
}
// An export read back in (T-0079 import): only well-formed tasks, only the fields Chamber writes.
function sanitize(d) {
  const items = d && Array.isArray(d.items) ? d.items : [], out = [];
  for (const t of items.slice(0, MAX_TASKS)) {
    if (!t || !/^[a-f0-9]{8}$/.test(String(t.id))) continue;
    const c = clean(t); if (c.error) continue;
    const done = (Array.isArray(t.done) ? t.done : []).filter(x => x && typeof x.p === 'string' && /^\d{4}-(W\d{2}|\d{2}(-\d{2})?)$/.test(x.p) && Number.isFinite(x.at)).slice(-KEEP_DONE)
      .map(x => ({ p: x.p, by: String(x.by || '').slice(0, 40), at: x.at }));
    out.push({ id: t.id, ...c, by: String(t.by || '').slice(0, 40), at: Number.isFinite(t.at) ? t.at : Date.now(), done });
  }
  return { items: out };
}
module.exports = { EVERY, MAX_TASKS, MAX_TITLE, KEEP_DONE, WEEKDAYS, localParts, isoWeek, periodOf, prevPeriod, status, view, streak, countDue, clean, tick, untick, sanitize, validTz };
