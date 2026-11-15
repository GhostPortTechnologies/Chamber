// wsfiles.js (T-0222): reading and writing a workspace's own files so that, while the owner lock is on, they are sealed with the
// workspace key: tickets, reviews, attached changes and their comments, agent memory, agents' questions, standing approvals, the
// phone AI's notes, and the who-did-what record (whole files, or one line at a time for the record's monthly files).
// Reading is the same either way: a sealed file is opened with the key the server holds, a plain one is read as it is. Writing
// seals while the lock state is 'sealing' or 'on' and writes plain otherwise, so switching the lock off brings plain files back.
// The file's place in the workspace (its name, or "diffs" for the attached-change folder) is sealed with it, so one sealed file
// cannot stand in for another kind.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const fs = require('fs'), path = require('path'), wscrypt = require('./wscrypt'), wslock = require('./wslock');
const toBuf = v => Buffer.isBuffer(v) ? v : Buffer.from(String(v));
function aadOf(ws, file) { const i = file.lastIndexOf('/' + ws + '/'), rel = i >= 0 ? file.slice(i + ws.length + 2) : path.basename(file); return `ws-file:${ws}:${rel.split('/')[0]}`; }
function sealing(ws) { const st = wslock.state(ws); return !!ws && (st === 'sealing' || st === 'on') && !!wslock.key(ws); }
function decode(ws, file, buf) {
  if (!ws || !wscrypt.isEncBytes(buf)) return buf;
  const dk = wslock.key(ws);
  if (!dk) { if (wslock.state(ws)) throw new wslock.LockedError(ws); return buf; }
  try { return wscrypt.decBytes(dk, buf, aadOf(ws, file)); }
  catch (e) { if (wslock.state(ws) === 'on') throw e; return buf; }    // before sealing is finished, a plain file that merely begins like a sealed one is just a file
}
function encode(ws, file, data) { return sealing(ws) ? wscrypt.encBytes(wslock.key(ws), toBuf(data), aadOf(ws, file)) : toBuf(data); }
function readText(ws, file) { return decode(ws, file, fs.readFileSync(file)).toString('utf8'); }    // throws like fs.readFileSync when the file is missing
function writeText(ws, file, text, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp.' + process.pid; fs.writeFileSync(tmp, encode(ws, file, text), { mode }); fs.renameSync(tmp, file);
}
function encLine(ws, file, line) { return sealing(ws) ? wscrypt.encText(wslock.key(ws), line, aadOf(ws, file)) : line; }
function decLine(ws, file, line) {
  if (!ws || !wscrypt.isEnc(line)) return line;
  const dk = wslock.key(ws); if (!dk) { if (wslock.state(ws)) throw new wslock.LockedError(ws); return line; }
  return wscrypt.decText(dk, line, aadOf(ws, file));
}
// Seal ('seal') or unseal one whole file in place: 'done' | 'skip' (already that way) | 'gone'. Synchronous on purpose: nothing else
// in the server can write the file in between.
function convertFile(ws, file, direction) {
  let buf; try { buf = fs.readFileSync(file); } catch { return 'gone'; }
  const dk = wslock.key(ws); if (!dk) throw new wslock.LockedError(ws);
  const aad = aadOf(ws, file); let plain = null;
  if (wscrypt.isEncBytes(buf)) { try { plain = wscrypt.decBytes(dk, buf, aad); } catch { plain = null; } }
  if (direction === 'seal' ? plain !== null : plain === null) return 'skip';
  const st = fs.statSync(file), tmp = file + '.lock-tmp';
  fs.writeFileSync(tmp, direction === 'seal' ? wscrypt.encBytes(dk, buf, aad) : plain, { mode: st.mode & 0o777 }); fs.renameSync(tmp, file); return 'done';
}
function convertLines(ws, file, direction) {                        // the same for a file of one-entry-per-line (the record)
  let text; try { text = fs.readFileSync(file, 'utf8'); } catch { return 'gone'; }
  const dk = wslock.key(ws); if (!dk) throw new wslock.LockedError(ws);
  const aad = aadOf(ws, file); let changed = 0;
  const out = text.split('\n').map(line => {
    if (!line) return line;
    let plain = null; if (wscrypt.isEnc(line)) { try { plain = wscrypt.decText(dk, line, aad); } catch { plain = null; } }
    if (direction === 'seal') { if (plain !== null) return line; changed++; return wscrypt.encText(dk, line, aad); }
    if (plain === null) return line; changed++; return plain;
  });
  if (!changed) return 'skip';
  const st = fs.statSync(file), tmp = file + '.lock-tmp'; fs.writeFileSync(tmp, out.join('\n'), { mode: st.mode & 0o777 }); fs.renameSync(tmp, file); return 'done';
}
module.exports = { aadOf, sealing, decode, encode, readText, writeText, encLine, decLine, convertFile, convertLines };
