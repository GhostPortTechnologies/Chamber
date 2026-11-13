#!/usr/bin/env node
// tools/verify-pack.js (T-0204): check an evidence pack without the server.
//   node tools/verify-pack.js chamber-evidence-<...>.json [full-record-export.json]
// 1) The pack's seal: any change to anything in the pack after it was made shows. 2) Each entry from the activity record in the
// pack still matches its own check value. 3) With a full export of the record (Account page, Activity & audit, JSON), that every
// one of those entries is really in the workspace's record and the record itself is intact. Exit 0 = all good.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const chain = require(path.join(__dirname, '..', 'auditchain.js'));
const [file, full] = process.argv.slice(2);
if (!file) { console.error('usage: node tools/verify-pack.js <evidence pack .json> [full record export .json]'); process.exit(2); }
const read = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { console.error(`cannot read ${f} as JSON: ${e.message}`); process.exit(2); } };
const pack = read(file);
if (pack.kind !== 'chamber-evidence' || !pack.seal) { console.log('NOT A PACK: this file is not a Chamber evidence pack.'); process.exit(1); }
const { seal, ...rest } = pack;
if (crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex') !== seal.sha256) { console.log('NOT INTACT: the pack was changed after it was made (its seal does not match).'); process.exit(1); }
const entries = (pack.tickets || []).flatMap(t => (t.record || []).map(e => ({ ticket: t.id, e })));
const bad = entries.find(x => x.e.h && chain.hash(x.e) !== x.e.h);
if (bad) { console.log(`NOT INTACT: an activity entry for ${bad.ticket} does not match its own check value.`); process.exit(1); }
let extra = '';
if (full) {
  const doc = read(full), all = Array.isArray(doc) ? doc : doc.entries || [];
  const v = chain.verify(all, doc.chain && doc.chain.head ? { n: doc.chain.n, h: doc.chain.head } : null);
  if (!v.ok) { console.log(`The pack is intact, but the full record export is NOT: ${v.reason}.`); process.exit(1); }
  const have = new Set(all.map(e => e.h).filter(Boolean)), missing = entries.filter(x => x.e.h && !have.has(x.e.h));
  if (missing.length) { console.log(`NOT CONFIRMED: ${missing.length} activity entr${missing.length === 1 ? 'y' : 'ies'} in the pack are not in that record export (another workspace, or the record was rewritten).`); process.exit(1); }
  extra = ` All ${entries.filter(x => x.e.h).length} activity entries are in the full record, which is intact.`;
}
console.log(`INTACT: the pack is as it was made (${(pack.tickets || []).length} ticket${(pack.tickets || []).length === 1 ? '' : 's'}, made ${pack.generated_at}), and its activity entries match their check values.${extra}`);
