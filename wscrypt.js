// wscrypt.js (T-0222): the encryption used for what a workspace stores, once its owner has switched the owner lock on.
//
// One data key per workspace (32 random bytes). The server holds it in memory only while the workspace is open; on disk it exists
// only wrapped for the owner (see accounts.js). Everything here is AES-256-GCM from Node's own crypto, in three shapes:
//   encText / decText        a short value: a message's text, one line of a log. "enc:v1:" + base64(iv | ciphertext | tag).
//   encBytes / decBytes      a whole small file (a JSON state file). MAGIC | iv | ciphertext | tag.
//   encryptStream / decryptStream, encryptFileSync / decryptFileSync
//                            a file of any size (an upload), in 64 KB pieces so it never has to sit in memory as a whole. Each piece
//                            is sealed by itself and knows its place and whether it is the last, so a piece that was changed, moved,
//                            or cut off the end is refused instead of being handed out.
// A wrong key and a changed byte both end in an error; nothing is ever returned half-checked.
// What this does NOT hide: how long a value is, and anything the caller keeps outside it (names of rooms and people, times).
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const crypto = require('crypto'), fs = require('fs'), { Transform } = require('stream');
const TEXT_PREFIX = 'enc:v1:', MAGIC = Buffer.from('CHAMBER-ENC-1\n'), MAGIC_S = Buffer.from('CHAMBER-ENCS-1\n'), CHUNK = 64 * 1024, IV = 12, TAG = 16;

const newKey = () => crypto.randomBytes(32);
const okKey = dk => Buffer.isBuffer(dk) && dk.length === 32;
function need(dk) { if (!okKey(dk)) throw new Error('no workspace key'); return dk; }
// A value that proves a key is the right one for a workspace, without being the key. Stored beside the wrapped key.
const keyCheck = dk => crypto.createHmac('sha256', need(dk)).update('chamber workspace key check v1').digest('hex');

function seal(dk, plain, aad) {
  const iv = crypto.randomBytes(IV), c = crypto.createCipheriv('aes-256-gcm', need(dk), iv); if (aad) c.setAAD(Buffer.from(String(aad)));
  return Buffer.concat([iv, c.update(plain), c.final(), c.getAuthTag()]);
}
function open(dk, box, aad) {
  if (box.length < IV + TAG) throw new Error('not a sealed value');
  const d = crypto.createDecipheriv('aes-256-gcm', need(dk), box.subarray(0, IV)); if (aad) d.setAAD(Buffer.from(String(aad)));
  d.setAuthTag(box.subarray(box.length - TAG));
  try { return Buffer.concat([d.update(box.subarray(IV, box.length - TAG)), d.final()]); } catch { throw new Error('this does not open with the workspace key: the key is wrong or the stored value was changed'); }
}
const isEnc = s => typeof s === 'string' && s.startsWith(TEXT_PREFIX);
const encText = (dk, s, aad) => TEXT_PREFIX + seal(dk, Buffer.from(String(s), 'utf8'), aad).toString('base64');
const decText = (dk, s, aad) => { if (!isEnc(s)) throw new Error('not a sealed value'); return open(dk, Buffer.from(s.slice(TEXT_PREFIX.length), 'base64'), aad).toString('utf8'); };
const isEncBytes = b => Buffer.isBuffer(b) && b.length >= MAGIC.length && b.subarray(0, MAGIC.length).equals(MAGIC);
const encBytes = (dk, buf, aad) => Buffer.concat([MAGIC, seal(dk, Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'utf8'), aad)]);
const decBytes = (dk, buf, aad) => { if (!isEncBytes(buf)) throw new Error('not a sealed file'); return open(dk, buf.subarray(MAGIC.length), aad); };

// ── files of any size ───────────────────────────────────────────────────────────────────────────────────────────────────────
// MAGIC_S | 8 random bytes (this file's id) | pieces. A piece: 4 bytes length of the sealed piece | iv | ciphertext | tag.
// What is sealed with each piece besides its bytes: the file's id, the piece's number, and whether it is the last one.
const isEncStream = b => Buffer.isBuffer(b) && b.length >= MAGIC_S.length && b.subarray(0, MAGIC_S.length).equals(MAGIC_S);
const pieceAad = (id, n, last) => { const a = Buffer.alloc(17); id.copy(a, 0); a.writeBigUInt64BE(BigInt(n), 8); a[16] = last ? 1 : 0; return a; };
function sealPiece(dk, id, n, last, plain) { const box = seal(dk, plain, pieceAad(id, n, last)), len = Buffer.alloc(4); len.writeUInt32BE(box.length); return Buffer.concat([len, box]); }
function encryptStream(dk) {
  need(dk); const id = crypto.randomBytes(8); let held = Buffer.alloc(0), n = 0, started = false;
  return new Transform({
    transform(chunk, _e, cb) {
      try { if (!started) { this.push(Buffer.concat([MAGIC_S, id])); started = true; }
        held = Buffer.concat([held, chunk]);
        while (held.length > CHUNK) { this.push(sealPiece(dk, id, n++, false, held.subarray(0, CHUNK))); held = held.subarray(CHUNK); }   // always keeps something back: the last piece must be marked as last
        cb(); } catch (e) { cb(e); }
    },
    flush(cb) { try { if (!started) this.push(Buffer.concat([MAGIC_S, id])); this.push(sealPiece(dk, id, n, true, held)); cb(); } catch (e) { cb(e); } },
  });
}
function decryptStream(dk) {
  need(dk); let buf = Buffer.alloc(0), id = null, n = 0, done = false;
  const step = (self, ending) => {
    if (!id) { if (buf.length < MAGIC_S.length + 8) { if (ending) throw new Error('not a sealed file'); return; }
      if (!isEncStream(buf)) throw new Error('not a sealed file'); id = Buffer.from(buf.subarray(MAGIC_S.length, MAGIC_S.length + 8)); buf = buf.subarray(MAGIC_S.length + 8); }
    for (;;) {
      if (buf.length < 4) break; const len = buf.readUInt32BE(0);
      if (len < IV + TAG || len > CHUNK + IV + TAG) throw new Error('the stored file was changed');
      if (buf.length < 4 + len) break;
      const box = buf.subarray(4, 4 + len), rest = buf.subarray(4 + len);
      if (done) throw new Error('the stored file has something after its end');
      let plain, last = false;
      // a piece is the last one exactly when it was sealed as the last one; try that reading only when nothing follows it yet
      try { plain = open(dk, box, pieceAad(id, n, false)); } catch { plain = open(dk, box, pieceAad(id, n, true)); last = true; }
      if (last) done = true;
      n++; buf = rest; if (plain.length) self.push(plain);
    }
    if (ending) { if (buf.length) throw new Error('the stored file was cut off or changed'); if (!done) throw new Error('the stored file was cut off before its end'); }
  };
  return new Transform({ transform(chunk, _e, cb) { try { buf = Buffer.concat([buf, chunk]); step(this, false); cb(); } catch (e) { cb(e); } }, flush(cb) { try { step(this, true); cb(); } catch (e) { cb(e); } } });
}
// Whole files on disk, piece by piece (used when a workspace's existing files are locked or unlocked in one go). dst is written new.
function encryptFileSync(dk, src, dst) {
  need(dk); const id = crypto.randomBytes(8), inFd = fs.openSync(src, 'r'), outFd = fs.openSync(dst, 'wx', 0o600);
  try { fs.writeSync(outFd, Buffer.concat([MAGIC_S, id])); const size = fs.fstatSync(inFd).size, b = Buffer.alloc(CHUNK); let off = 0, n = 0;
    for (;;) { const got = fs.readSync(inFd, b, 0, CHUNK, off); off += got; const last = off >= size; fs.writeSync(outFd, sealPiece(dk, id, n++, last, b.subarray(0, got))); if (last) break; }
    fs.fsyncSync(outFd); } finally { fs.closeSync(inFd); fs.closeSync(outFd); }
}
function decryptFileSync(dk, src, dst) {
  need(dk); const inFd = fs.openSync(src, 'r'), outFd = fs.openSync(dst, 'wx', 0o600);
  try { const head = Buffer.alloc(MAGIC_S.length + 8); if (fs.readSync(inFd, head, 0, head.length, 0) !== head.length || !isEncStream(head)) throw new Error('not a sealed file');
    const id = head.subarray(MAGIC_S.length), size = fs.fstatSync(inFd).size, lenB = Buffer.alloc(4); let off = head.length, n = 0, done = false;
    while (off < size) {
      if (done) throw new Error('the stored file has something after its end');
      if (fs.readSync(inFd, lenB, 0, 4, off) !== 4) throw new Error('the stored file was cut off or changed'); const len = lenB.readUInt32BE(0);
      if (len < IV + TAG || len > CHUNK + IV + TAG || off + 4 + len > size) throw new Error('the stored file was cut off or changed');
      const box = Buffer.alloc(len); fs.readSync(inFd, box, 0, len, off + 4); off += 4 + len;
      const last = off >= size; const plain = open(dk, box, pieceAad(id, n++, last)); if (last) done = true; fs.writeSync(outFd, plain);
    }
    if (!done) throw new Error('the stored file was cut off before its end'); fs.fsyncSync(outFd);
  } catch (e) { try { fs.closeSync(outFd); fs.unlinkSync(dst); } catch {} fs.closeSync(inFd); throw e; }
  fs.closeSync(inFd); fs.closeSync(outFd);
}
const isEncFileSync = file => { let fd; try { fd = fs.openSync(file, 'r'); const b = Buffer.alloc(MAGIC_S.length); return fs.readSync(fd, b, 0, b.length, 0) === b.length && b.equals(MAGIC_S); } catch { return false; } finally { if (fd !== undefined) fs.closeSync(fd); } };

module.exports = { newKey, okKey, keyCheck, isEnc, encText, decText, isEncBytes, encBytes, decBytes, isEncStream, encryptStream, decryptStream, encryptFileSync, decryptFileSync, isEncFileSync, TEXT_PREFIX, CHUNK };
