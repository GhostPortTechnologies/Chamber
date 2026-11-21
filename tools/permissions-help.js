#!/usr/bin/env node
// tools/permissions-help.js (T-0246): makes the "Who can do what" table in public/help.html from permissions.js, so Help
// can never say something the server does not do. test_permissions.js fails when the two differ.
//   node tools/permissions-help.js           prints the block
//   node tools/permissions-help.js --write   puts it into public/help.html (between the permissions:start/end markers)
//
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 GhostPort Technologies
'use strict';
const fs = require('fs'); const path = require('path');
const perm = require('../permissions.js');

const SHORT = { yes: 'Yes', no: '–', own: 'Own', approver: 'If approver', commander: 'If instructs agents', setting: 'If switched on', operator: 'Server operators' };
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function html() {
  const head = perm.ROLES.map(r => `<th>${perm.ROLE_NAMES[r]}</th>`).join('');
  let rows = '', area = '';
  for (const r of perm.RULES) {
    if (r.area !== area) { area = r.area; rows += `<tr class="perm-area"><th colspan="${perm.ROLES.length + 1}"><span>${esc(area)}</span></th></tr>\n`; }
    const cells = perm.ROLES.map(role => `<td class="perm-${r[role]}">${esc(SHORT[r[role]])}</td>`).join('');
    rows += `<tr><td>${esc(r.what)}${r.note ? `<br><small>${esc(r.note)}</small>` : ''}</td>${cells}</tr>\n`;
  }
  const legend = ['own', 'approver', 'commander', 'setting', 'operator'].map(v => `<b>${esc(SHORT[v])}</b>: ${esc(perm.VALUES[v].charAt(0).toLowerCase() + perm.VALUES[v].slice(1))}`).join('; ');
  return `<!-- permissions:start (made by tools/permissions-help.js from permissions.js; do not edit by hand) -->
<style>.perm-wrap{overflow-x:auto;margin:10px 0}.perm{border-collapse:collapse;font-size:12.5px;min-width:640px}.perm th,.perm td{padding:5px 7px;border-bottom:1px solid var(--line);text-align:center;vertical-align:top}.perm td:first-child,.perm tr:first-child th:first-child{text-align:left;min-width:220px;position:sticky;left:0;background:var(--bg);z-index:1}@media (max-width:600px){.perm td:first-child,.perm tr:first-child th:first-child{min-width:150px;max-width:170px}}.perm td small{color:var(--text-dim)}.perm .perm-yes{color:var(--accent);font-weight:700}.perm .perm-no{color:var(--text-faint)}.perm tr.perm-area th{text-align:left;padding-top:14px;color:var(--text-dim);font-weight:700}.perm tr.perm-area th span{position:sticky;left:7px}</style>
<p id="who-can"><b>Who can do what.</b> The server checks every request against this table, and a test tries every role and an agent against every line of it before each release. ${legend}. <b>–</b>: cannot. On a phone, swipe the table sideways to see every role.</p>
<div class="perm-wrap"><table class="perm"><tr><th>Action</th>${head}</tr>
${rows}</table></div>
<!-- permissions:end -->`;
}

if (require.main === module) {
  const out = html();
  if (process.argv.includes('--write')) {
    const f = path.join(__dirname, '..', 'public', 'help.html'), s = fs.readFileSync(f, 'utf8');
    const a = s.indexOf('<!-- permissions:start'), b = s.indexOf('<!-- permissions:end -->');
    if (a < 0 || b < a) { console.error('help.html has no permissions:start/end markers'); process.exit(1); }
    fs.writeFileSync(f, s.slice(0, a) + out + s.slice(b + '<!-- permissions:end -->'.length));
    console.log('help.html updated');
  } else process.stdout.write(out + '\n');
}
module.exports = { html };
