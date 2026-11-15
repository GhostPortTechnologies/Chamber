// records.js (T-0219): how long a workspace's activity record is kept, and sealed copies of it that only the owner can open.
//
// Two jobs, both on the plain files of one workspace folder (audit-YYYY-MM.jsonl, audit.json, audit-head.json):
//   trim(dir, cutoff, opts)   removes the oldest entries, always as one clean front part of the record, and leaves the record
//                             checkable: the head remembers up to which entry the owner's setting removed, and a "record-trimmed"
//                             entry is written. Entries missing beyond that point still make the check fail (auditchain.js).
//   saveCopy(dir, ...)        writes a copy of entries as a sealed file in records-saved/. Sealed means: the content is encrypted
//                             with a fresh AES-256-GCM key, and that key is wrapped with the owner's PUBLIC key (RSA-OAEP, SHA-256).
//                             The server holds only the public key, so it can write a copy and can never read one back. The private
//                             key lives in the owner's browser, wrapped with a passphrase the server never sees (see landing.html).
// Everything here is synchronous on purpose: the server appends to the record synchronously too, so a trim can never interleave
// with an append.
// What this does NOT do: it does not touch tickets, chat or files, and it is not end-to-end encryption of the workspace.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const FILE_RE = /^audit-\d{4}-\d{2}\.jsonl$/, SAVED_DIR = 'records-saved', NAME_RE = /^record-\d{8}-\d{8}-[a-f0-9]{8}\.sealed\.json$/;
const MIN_DAYS = 7, MAX_DAYS = 3650, MAX_SAVED = 500;

const writeAtomic = (file, text, mode = 0o600) => { const tmp = file + '.tmp.' + process.pid; fs.writeFileSync(tmp, text, { mode }); fs.renameSync(tmp, file); };
const keyOf = r => r.h ? 'h:' + r.h : `${r.ts}|${r.actor || r.agent}|${r.action}`;
const day = ts => new Date(ts).toISOString().slice(0, 10).replace(/-/g, '');

// The owner's public key as the browser exported it (SPKI, base64). Only RSA of 2048 bits or more is accepted.
function checkPublicKey(b64) {
  try {
    const k = crypto.createPublicKey({ key: Buffer.from(String(b64 || ''), 'base64'), format: 'der', type: 'spki' });
    const bits = k.asymmetricKeyDetails && k.asymmetricKeyDetails.modulusLength;
    return k.asymmetricKeyType === 'rsa' && bits >= 2048 ? { ok: true, bits } : { ok: false, why: 'the key must be RSA with 2048 bits or more' };
  } catch (e) { return { ok: false, why: 'that is not a public key' }; }
}

function seal(pubB64, plain) {
  const key = crypto.randomBytes(32), iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);          // tag at the end: what WebCrypto's AES-GCM expects
  const pub = crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' });
  const wk = crypto.publicEncrypt({ key: pub, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key);
  return { alg: 'RSA-OAEP-256 + AES-256-GCM', wk: wk.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64') };
}

// entries: record entries, oldest first. ownerKey: { id, pub }. chain: what lets the copy be checked by itself after opening.
function saveCopy(dir, { entries, ownerKey, workspace, reason, chain }) {
  if (!ownerKey || !ownerKey.pub || !checkPublicKey(ownerKey.pub).ok) throw new Error('no owner key is set, so a sealed copy cannot be made');
  if (!entries.length) throw new Error('there is nothing to copy');
  const sdir = path.join(dir, SAVED_DIR); fs.mkdirSync(sdir, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(sdir).filter(f => NAME_RE.test(f)).length >= MAX_SAVED) throw new Error(`there are already ${MAX_SAVED} saved copies; delete some first`);
  const from = entries[0].ts, to = entries[entries.length - 1].ts, numbered = entries.filter(r => Number.isInteger(r.n));
  const doc = { workspace, exported_at: new Date().toISOString(), reason, chain: chain || { partial: true }, entries };
  const env = { kind: 'chamber-sealed-record', v: 1, workspace, created: new Date().toISOString(), reason, from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    entries: entries.length, first: numbered.length ? numbered[0].n : null, last: numbered.length ? numbered[numbered.length - 1].n : null, key: ownerKey.id, ...seal(ownerKey.pub, Buffer.from(JSON.stringify(doc), 'utf8')) };
  const name = `record-${day(from)}-${day(to)}-${crypto.randomBytes(4).toString('hex')}.sealed.json`, file = path.join(sdir, name);
  const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeSync(fd, JSON.stringify(env)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const back = JSON.parse(fs.readFileSync(file, 'utf8'));                          // read it back before anything is deleted on the strength of it
  if (back.ct !== env.ct || back.wk !== env.wk || back.entries !== entries.length) { try { fs.unlinkSync(file); } catch {} throw new Error('the saved copy did not read back as written'); }
  return { name, entries: entries.length, from: env.from, to: env.to, bytes: fs.statSync(file).size };
}

function listSaved(dir) {
  let names = []; try { names = fs.readdirSync(path.join(dir, SAVED_DIR)).filter(f => NAME_RE.test(f)).sort().reverse(); } catch { /* none yet */ }
  return names.map(name => { try { const e = JSON.parse(fs.readFileSync(path.join(dir, SAVED_DIR, name), 'utf8'));
    return { name, created: e.created, reason: e.reason, from: e.from, to: e.to, entries: e.entries, first: e.first, last: e.last, key: e.key, bytes: fs.statSync(path.join(dir, SAVED_DIR, name)).size }; } catch { return null; } }).filter(Boolean);
}
function readSaved(dir, name) { if (!NAME_RE.test(String(name))) return null; try { return fs.readFileSync(path.join(dir, SAVED_DIR, name), 'utf8'); } catch { return null; } }
function removeSaved(dir, name) { if (!NAME_RE.test(String(name))) return false; try { fs.unlinkSync(path.join(dir, SAVED_DIR, name)); return true; } catch { return false; } }

// Remove every entry older than cutoffTs, as ONE clean front part: the cut ends at the first entry that stays (or that cannot be
// read), so the record never gets a hole. opts: { days, by, workspace, copy, ownerKey, append(rec) }. With copy, the removed entries
// are sealed for the owner first, and nothing is deleted when that fails. Returns { removed, first, upto, copy }.
function trim(dir, cutoffTs, opts) {
  let files = []; try { files = fs.readdirSync(dir).filter(f => FILE_RE.test(f)).sort(); } catch { return { removed: 0 }; }
  const headFile = path.join(dir, 'audit-head.json'); let head = {}; try { head = JSON.parse(fs.readFileSync(headFile, 'utf8')); } catch { /* a record from before the check values */ }
  const gone = [], kept = new Map(); let cutting = true;
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean), keep = [];
    for (const line of lines) {
      let r = null; if (cutting) { try { r = JSON.parse(opts.decLine ? opts.decLine(path.join(dir, f), line) : line); } catch { r = null; } }   // T-0222: a sealed line is opened to read its time
      if (cutting && r && typeof r.ts === 'number' && r.ts < cutoffTs) gone.push(r); else { cutting = false; keep.push(line); }
    }
    kept.set(f, { keep, changed: keep.length !== lines.length });
  }
  if (!gone.length) return { removed: 0 };
  const numbered = gone.filter(r => Number.isInteger(r.n)), first = numbered.length ? numbered[0].n : null, upto = numbered.length ? numbered[numbered.length - 1].n : null;
  const was = (head.trimmed && head.trimmed.upto) || 0;
  let copy = null;
  if (opts.copy) copy = saveCopy(dir, { entries: gone, ownerKey: opts.ownerKey, workspace: opts.workspace, reason: 'retention',
    chain: upto !== null ? { ok: true, n: upto, head: numbered[numbered.length - 1].h, trimmed_upto: was, how: 'node tools/verify-audit.js <this file> checks it without the server' } : { partial: true } }).name;
  if (upto !== null) writeAtomic(headFile, JSON.stringify({ ...head, trimmed: { upto, before: cutoffTs, at: Date.now() } }));   // first: from here on these entries are allowed to be missing
  for (const [f, k] of kept) { if (!k.changed) continue; if (k.keep.length) writeAtomic(path.join(dir, f), k.keep.join('\n') + '\n'); else fs.unlinkSync(path.join(dir, f)); }
  try { const removed = new Set(gone.map(keyOf)), recent = path.join(dir, 'audit.json'); const log = JSON.parse(opts.readText ? opts.readText(recent) : fs.readFileSync(recent, 'utf8')).filter(r => !removed.has(keyOf(r))); writeAtomic(recent, opts.encode ? opts.encode(recent, JSON.stringify(log)) : JSON.stringify(log), 0o644); } catch { /* no recent list */ }
  opts.append({ ts: Date.now(), actor: 'chamber', kind: 'system', action: 'record-trimmed', removed: gone.length, first, upto, before: new Date(cutoffTs).toISOString(), days: opts.days, setting_by: opts.by || null, copy });
  return { removed: gone.length, first, upto, copy };
}

module.exports = { trim, saveCopy, listSaved, readSaved, removeSaved, checkPublicKey, seal, MIN_DAYS, MAX_DAYS, SAVED_DIR, NAME_RE };
