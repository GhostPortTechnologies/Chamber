'use strict';                                                                   // strict mode catches silent JS mistakes
// ticket-export.js: renders the ticket board as printable HTML (open it, Ctrl+P, "Save as PDF"),
// Markdown or CSV. Served by GET /api/tickets/export in server.js, behind the same auth as /api/.
// Ticket text is untrusted (any AI or human can write it), so every HTML interpolation goes through esc().
//
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 GhostPort Technologies
// Free software under the GNU Affero General Public License v3; NO WARRANTY. See LICENSE.

const STATUS_ORDER = ['proposed', 'approved', 'in_progress', 'blocked', 'done', 'closed', 'rejected'];  // board order: open work first; tickets-cli.js uses done, the rest are kept for other stores
const PRIORITY_ORDER = ['critical', 'high', 'normal', 'medium', 'low'];  // the UI files tickets as low/normal/high/critical; medium kept for stores made elsewhere
const PRIORITY_RANK = new Map(PRIORITY_ORDER.map((p, i) => [p, i]));          // priority -> sort rank; a Map, so a priority like "constructor" can't hit Object.prototype

const esc = (s) => String(s == null ? '' : s)                                   // HTML-escape: null/undefined become ''
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')           // & first so the later entities are not double-escaped
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');                              // quotes too, because values also land inside attributes

function ageDays(ts) {                                                          // whole days since a timestamp, or null
  if (!ts) return null;                                                         // no timestamp: age unknown
  const t = typeof ts === 'number' ? ts : Date.parse(ts);                       // tickets-cli.js stores ISO strings; accept epoch ms too
  if (!Number.isFinite(t)) return null;                                         // unparseable date: show no age rather than NaN
  return Math.floor((Date.now() - t) / 86400000);                               // 86400000 ms = one day
}

function sortTickets(ts) {                                                      // highest-priority, longest-waiting ticket goes first
  return ts.slice().sort((a, b) => {                                            // copy first so the caller's array is not reordered
    const sa = STATUS_ORDER.indexOf(a.status), sb = STATUS_ORDER.indexOf(b.status);  // status rank (-1 when unknown)
    if (sa !== sb) return (sa < 0 ? 99 : sa) - (sb < 0 ? 99 : sb);             // unknown statuses sink to the bottom
    const pa = PRIORITY_RANK.get(a.priority) ?? 9, pb = PRIORITY_RANK.get(b.priority) ?? 9;  // unknown priority ranks after low
    if (pa !== pb) return pa - pb;                                              // then by priority
    return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });  // then oldest id first (T-0009 before T-0010)
  });
}

function applyFilters(tickets, q) {                                             // narrow the list from ?status= &priority= &assignee= &open=1 &q=
  let out = tickets;                                                            // start with every ticket
  const pick = (k) => (q[k] || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);  // "a, b" -> ['a','b']
  const st = pick('status'), pr = pick('priority'), as = pick('assignee');      // each filter may hold several comma-separated values
  if (st.length) out = out.filter(t => st.includes(String(t.status || '').toLowerCase()));      // status filter
  if (pr.length) out = out.filter(t => pr.includes(String(t.priority || '').toLowerCase()));    // priority filter
  if (as.length) out = out.filter(t => as.includes(String(t.assignee || '').toLowerCase()));    // owner filter
  if (q.open === '1') out = out.filter(t => !['done', 'closed', 'rejected'].includes(String(t.status)));  // open=1 hides finished work
  if (q.q) {                                                                    // free-text search
    const needle = q.q.toLowerCase();                                           // case-insensitive
    out = out.filter(t => (String(t.title || '') + ' ' + String(t.body || '')).toLowerCase().includes(needle));  // matches title or body
  }
  return out;                                                                   // filtered list
}

function counts(tickets, key) {                                                 // tally tickets by one field, biggest group first
  const m = new Map();                                                          // value -> count
  for (const t of tickets) m.set(t[key] || '-', (m.get(t[key] || '-') || 0) + 1);  // a missing value counts as '-'
  return [...m.entries()].sort((a, b) => b[1] - a[1]);                          // [[value, n], ...] in descending order
}

// Print stylesheet. One rule per array entry so each line can carry its own comment
// without the comment ending up inside the exported page.
const CSS = [
  ':root { --ink:#111; --dim:#666; --rule:#d8d8d8; --bg:#fff; }',             // black on white: readable on paper, saves toner
  '* { box-sizing: border-box; }',                                              // padding stays inside widths
  'body { margin:0; padding:28px 32px; background:var(--bg); color:var(--ink); font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }',  // page margins and system font
  'h1 { font-size:20px; margin:0 0 2px; letter-spacing:-.01em; }',              // board title
  '.sub { color:var(--dim); font-size:12px; margin-bottom:14px; }',             // filter + timestamp line under the title
  '.summary { display:flex; flex-wrap:wrap; gap:6px 18px; padding:10px 12px; border:1px solid var(--rule); border-radius:6px; margin-bottom:22px; font-size:12px; }',  // count boxes
  '.summary b { font-variant-numeric:tabular-nums; }',                          // digits line up
  'h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:var(--dim); margin:24px 0 8px; padding-bottom:4px; border-bottom:1px solid var(--rule); }',  // status section headings
  '.t { border:1px solid var(--rule); border-left:3px solid var(--rule); border-radius:5px; padding:9px 12px; margin:0 0 8px; page-break-inside:avoid; break-inside:avoid; }',  // one ticket card; never split across pages
  '.t.p-critical { border-left-color:#b3261e; }',                               // left stripe colour = priority
  '.t.p-high { border-left-color:#c2610a; }',                                   // high: orange
  '.t.p-normal, .t.p-medium { border-left-color:#7a6a00; }',                    // normal (and medium, from other stores): olive
  '.t.p-low { border-left-color:#5a5a5a; }',                                    // low: grey
  '.hd { display:flex; align-items:baseline; gap:8px; }',                       // id, priority badge and title on one line
  '.hd h3 { font-size:13.5px; font-weight:600; margin:0; flex:1; }',            // title takes the remaining width
  '.id { font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--dim); white-space:nowrap; }',  // ticket id in monospace
  '.pri { font-size:10px; text-transform:uppercase; letter-spacing:.06em; padding:1px 5px; border-radius:3px; border:1px solid currentColor; white-space:nowrap; }',  // priority badge
  '.pri-critical { color:#b3261e; } .pri-high { color:#c2610a; }',             // badge colours match the stripes
  '.pri-normal, .pri-medium { color:#7a6a00; } .pri-low { color:#5a5a5a; } .pri-none { color:var(--dim); }',  // rest of the badge colours
  '.meta { color:var(--dim); font-size:11.5px; margin-top:3px; display:flex; flex-wrap:wrap; gap:4px 14px; }',  // status/owner/type/age row
  '.meta b { color:var(--ink); font-weight:600; }',                             // values darker than labels
  '.body { white-space:pre-wrap; word-wrap:break-word; font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; background:#fafafa; border:1px solid #eee; border-radius:4px; padding:8px 10px; margin:8px 0 0; }',  // ticket body keeps its line breaks
  'footer { margin-top:28px; padding-top:10px; border-top:1px solid var(--rule); color:var(--dim); font-size:11px; }',  // closing line
  '.warn { border:1px solid #c2610a; color:#8a4408; background:#fff8f1; border-radius:5px; padding:8px 11px; margin:0 0 18px; font-size:11.5px; }',  // full-detail warning box
  '.noprint { margin-bottom:16px; }',                                           // spacing under the print button
  '.noprint button { font:inherit; padding:6px 12px; border:1px solid var(--rule); background:#f6f6f6; border-radius:5px; cursor:pointer; }',  // print button style
  '@media print { body { padding:0; font-size:11px; } .noprint { display:none !important; } .t { border-left-width:2px; } h2 { page-break-after:avoid; break-after:avoid; } @page { margin:14mm 12mm; } }',  // paper: hide the button, keep headings with their cards
].join('\n');                                                                   // one stylesheet string

function renderHtml(tickets, opts) {                                            // printable page; Ctrl+P -> Save as PDF
  const full = opts.full;                                                       // full=1 adds ticket bodies
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16);         // "YYYY-MM-DD HH:MM" in UTC
  const groups = [];                                                            // [[status, tickets], ...] in board order
  for (const st of STATUS_ORDER) {                                              // walk the known statuses in order
    const g = tickets.filter(t => t.status === st);                             // tickets in this status
    if (g.length) groups.push([st, g]);                                         // skip empty sections
  }
  const known = new Set(STATUS_ORDER);                                          // fast lookup for the catch-all below
  const other = tickets.filter(t => !known.has(t.status));                      // statuses we do not know still get printed
  if (other.length) groups.push(['other', other]);                              // under an "other" heading

  const row = (t) => {                                                          // one ticket card
    const age = ageDays(t.proposed_at);                                         // days since it was filed
    return [
      `<article class="t p-${esc(t.priority || 'none')}">`,                     // card; class picks the stripe colour
      `<div class="hd"><span class="id">${esc(t.id)}</span>`,                   // header row: id
      `<span class="pri pri-${esc(t.priority || 'none')}">${esc(t.priority || '-')}</span>`,  // priority badge
      `<h3>${esc(t.title)}</h3></div>`,                                         // title (escaped: untrusted text)
      `<div class="meta"><span>status <b>${esc(t.status)}</b></span>`,          // meta row: status
      `<span>owner <b>${esc(t.assignee || 'unassigned')}</b></span>`,           // who claimed it
      t.type ? `<span>type <b>${esc(t.type)}</b></span>` : '',                  // bug/feature/task/incident, if set
      age != null ? `<span>open <b>${age}d</b></span>` : '',                    // age in days (a number, safe to print)
      Array.isArray(t.updates) && t.updates.length ? `<span>updates <b>${t.updates.length}</b></span>` : '',  // number of progress notes
      '</div>',                                                                 // end meta row
      full && t.body ? `<pre class="body">${esc(t.body)}</pre>` : '',           // body only when full=1
      '</article>',                                                             // end card
    ].join('');                                                                 // no separators needed in HTML
  };

  const byStatus = counts(tickets, 'status');                                   // summary counts per status
  const byPriority = counts(tickets, 'priority');                               // summary counts per priority
  return [
    '<!doctype html>',                                                          // standards mode
    '<html lang="en"><head><meta charset="utf-8">',                             // UTF-8 so ticket text renders correctly
    `<title>Chamber tickets - ${when}</title>`,                               // tab title; also the default PDF file name
    `<style>${CSS}</style></head><body>`,                                       // stylesheet above
    '<div class="noprint"><button onclick="window.print()">Print / Save as PDF</button></div>',  // hidden on paper by @media print
    '<h1>Chamber - ticket board</h1>',                                        // page heading
    `<div class="sub">${esc(opts.filterLabel)} · generated ${when} UTC · ${tickets.length} ticket${tickets.length === 1 ? '' : 's'}</div>`,  // filter label is built from the query string, so escaped
    full ? '<div class="warn"><b>Full detail included.</b> Ticket bodies describe internal systems, file paths and unresolved security findings. Review before sending this outside your team. The version without <code>full=1</code> is titles and metadata only.</div>' : '',  // warn before a full export leaves the building
    '<div class="summary">',                                                    // count boxes
    `<span><b>${tickets.length}</b> total</span>`,                              // total shown
    byStatus.map(([k, n]) => `<span>${esc(k)} <b>${n}</b></span>`).join(''),    // per-status counts
    '<span style="width:100%;height:0"></span>',                                // line break inside the flex row
    byPriority.map(([k, n]) => `<span>${esc(k)} <b>${n}</b></span>`).join(''),  // per-priority counts
    '</div>',                                                                   // end summary
    groups.map(([st, g]) => `<section><h2>${esc(st)} - ${g.length}</h2>${sortTickets(g).map(row).join('')}</section>`).join(''),  // one section per status
    `<footer>Chamber ticket board · ${esc(opts.filterLabel)} · ${tickets.length} shown${full ? ' · full detail' : ' · titles and metadata only'}</footer>`,  // repeats the scope on the last page
    '</body></html>',                                                           // end document
  ].join('\n');                                                                 // newlines keep the source readable
}

function fenceFor(text) {                                                       // Markdown code fence longer than any backtick run in the text
  const runs = String(text).match(/`+/g) || [];                                 // every run of backticks in the body
  const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);              // the longest run
  return '`'.repeat(Math.max(3, longest + 1));                                  // a body containing ``` can no longer close the fence early
}

function renderMarkdown(tickets, opts) {                                        // for pasting into an email, issue or chat
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16);         // UTC timestamp
  const out = ['# Chamber - ticket board', '', `${opts.filterLabel} · generated ${when} UTC · ${tickets.length} ticket(s)`, ''];  // heading + scope line
  out.push('**' + counts(tickets, 'status').map(([k, n]) => `${k}: ${n}`).join('  ·  ') + '**', '');  // bold status summary
  for (const st of [...STATUS_ORDER, 'other']) {                                // same section order as the HTML
    const g = st === 'other' ? tickets.filter(t => !STATUS_ORDER.includes(t.status)) : tickets.filter(t => t.status === st);  // tickets in this section
    if (!g.length) continue;                                                    // skip empty sections
    out.push(`## ${st} (${g.length})`, '');                                     // section heading
    out.push('| ID | Pri | Title | Owner | Age |', '|---|---|---|---|---|');    // table header
    for (const t of sortTickets(g)) {                                           // one row per ticket
      const age = ageDays(t.proposed_at);                                       // days open
      const title = String(t.title || '').replace(/\|/g, '\\|');                // a | in a title would split the table cell
      out.push(`| ${t.id} | ${t.priority || '-'} | ${title} | ${t.assignee || '-'} | ${age != null ? age + 'd' : '-'} |`);  // the row
    }
    out.push('');                                                               // blank line ends the table
    if (opts.full) {                                                            // full=1: bodies after the table
      for (const t of sortTickets(g)) {                                         // same order as the table
        if (!t.body) continue;                                                  // nothing to print
        const fence = fenceFor(t.body);                                         // fence that the body cannot break
        out.push(`### ${t.id} - ${t.title}`, '', fence, String(t.body), fence, '');  // body verbatim inside the fence
      }
    }
  }
  return out.join('\n');                                                        // one Markdown document
}

function renderCsv(tickets, opts) {                                             // for a spreadsheet
  const cell = (v) => {                                                         // quote one CSV value
    let s = String(v == null ? '' : v);                                         // null/undefined -> empty cell
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                                    // formula guard: a title like =HYPERLINK(...) would run in Excel/Sheets; a leading ' makes it text
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;          // RFC 4180: quote cells holding comma, quote or newline
  };
  const cols = ['id', 'status', 'priority', 'type', 'title', 'assignee', 'proposed_by', 'proposed_at', 'age_days'];  // column order
  if (opts.full) cols.push('body');                                             // bodies only with full=1
  const rows = [cols.join(',')];                                                // header row
  for (const t of sortTickets(tickets)) {                                       // same order as the board
    rows.push(cols.map(c => cell(c === 'age_days' ? (ageDays(t.proposed_at) ?? '') : t[c])).join(','));  // age is computed, the rest come from the ticket
  }
  return rows.join('\n');                                                       // one CSV document
}

function describeFilters(q, n, total) {                                         // human-readable scope line, e.g. "open only (12 of 303)"
  const bits = [];                                                              // one phrase per active filter
  if (q.open === '1') bits.push('open only');                                   // open=1
  if (q.status) bits.push(`status: ${q.status}`);                               // status=
  if (q.priority) bits.push(`priority: ${q.priority}`);                         // priority=
  if (q.assignee) bits.push(`assignee: ${q.assignee}`);                         // assignee=
  if (q.q) bits.push(`matching "${q.q}"`);                                      // q= (escaped later by esc() in HTML)
  if (!bits.length) return 'all tickets';                                       // no filters
  return `${bits.join(', ')} (${n} of ${total})`;                               // filters plus shown/total
}

function exportTickets(allTickets, q) {                                         // entry point used by server.js
  const format = String(q.format || 'html').toLowerCase();                      // html is the default (print to PDF)
  const filtered = applyFilters(allTickets || [], q);                           // tolerate a missing ticket list
  const opts = { full: q.full === '1', filterLabel: describeFilters(q, filtered.length, (allTickets || []).length) };  // render options
  if (format === 'md' || format === 'markdown') {                               // Markdown
    return { contentType: 'text/markdown; charset=utf-8', filename: 'chamber-tickets.md', body: renderMarkdown(filtered, opts) };
  }
  if (format === 'csv') {                                                       // CSV
    return { contentType: 'text/csv; charset=utf-8', filename: 'chamber-tickets.csv', body: renderCsv(filtered, opts) };
  }
  return { contentType: 'text/html; charset=utf-8', filename: 'chamber-tickets.html', body: renderHtml(filtered, opts) };  // anything else: HTML
}

module.exports = { exportTickets };                                             // only the entry point is public
