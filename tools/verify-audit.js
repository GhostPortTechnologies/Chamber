#!/usr/bin/env node
// tools/verify-audit.js (T-0194): check an exported activity record without the server.
//   node tools/verify-audit.js chamber-audit-<workspace>-<date>.json [check-value-you-kept]
// Account page -> Activity & audit -> JSON gives the file. With a check value you wrote down earlier, it also confirms that the
// record still contains that exact point. Exit 0 = intact.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const fs = require('fs'), path = require('path');
const { verify } = require(path.join(__dirname, '..', 'auditchain.js'));
const [file, kept] = process.argv.slice(2);
if (!file) { console.error('usage: node tools/verify-audit.js <exported .json> [check value you kept]'); process.exit(2); }
let doc; try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.error('cannot read that file as JSON: ' + e.message); process.exit(2); }
if (doc.chain && doc.chain.partial) { console.log('This export is filtered (a search or a date range), so it cannot be checked as a whole. Export without a filter to check it.'); process.exit(2); }
const entries = Array.isArray(doc) ? doc : doc.entries || [];
const r = verify(entries, doc.chain && doc.chain.head ? { n: doc.chain.n, h: doc.chain.head } : null);
if (!r.ok) { console.log(`NOT INTACT: ${r.reason}.` + (r.at ? ` At entry ${r.at.n ?? '?'} (${r.at.ts ? new Date(r.at.ts).toISOString() : '?'}, ${r.at.actor || '?'}, ${r.at.action || '?'}).` : '')); process.exit(1); }
if (kept && !entries.some(e => e.h === kept)) { console.log('The record checks out internally, but the check value you kept is not in it: the record was rewritten, or the value belongs to another workspace.'); process.exit(1); }
console.log(`INTACT: ${r.checked} entr${r.checked === 1 ? 'y' : 'ies'} checked${r.before ? `, ${r.before} older entr${r.before === 1 ? 'y' : 'ies'} from before the check values started` : ''}. Newest check value: ${r.head || '(none)'}` + (kept ? '. The value you kept is in it.' : '.'));
