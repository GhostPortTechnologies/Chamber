// push.js — Web Push for Chamber with VAPID, zero dependencies (T-0013).
// Sends content-free pushes ("something new for you"), so no message text is ever handed to Apple/Google/Mozilla push servers.
// Keys live in <data dir>/vapid.json and are created on first use.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
const crypto = require('crypto'); const fs = require('fs'); const path = require('path'); const https = require('https');
const DATA_DIR = path.dirname(process.env.CHAMBER_DATA || path.join(__dirname, 'chamber.json'));
const KEYFILE = path.join(DATA_DIR, 'vapid.json');
const SUBJECT = process.env.CHAMBER_PUSH_SUBJECT || 'mailto:support@ghostporttechnologies.com';
let keys = null;
function b64u(b) { return Buffer.from(b).toString('base64url'); }
function loadKeys() {
  if (keys) return keys;
  try { keys = JSON.parse(fs.readFileSync(KEYFILE, 'utf8')); return keys; } catch { /* make new */ }
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pubRaw = publicKey.export({ format: 'jwk' }), privJwk = privateKey.export({ format: 'jwk' });
  keys = { publicKey: b64u(Buffer.concat([Buffer.from([4]), Buffer.from(pubRaw.x, 'base64url'), Buffer.from(pubRaw.y, 'base64url')])), jwk: privJwk };
  fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(KEYFILE, JSON.stringify(keys), { mode: 0o600 });
  return keys;
}
function vapidHeader(endpoint) {
  const k = loadKeys(); const aud = new URL(endpoint).origin;
  const enc = o => b64u(JSON.stringify(o));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SUBJECT })}`;
  const key = crypto.createPrivateKey({ key: k.jwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${k.publicKey}`;
}
// Send one content-free push. Resolves 'ok', 'gone' (subscription expired: caller should drop it) or 'error'.
function send(sub) {
  return new Promise(resolve => {
    try {
      const u = new URL(sub.endpoint);
      const req = https.request({ hostname: u.hostname, path: u.pathname + u.search, method: 'POST', timeout: 10000,
        headers: { Authorization: vapidHeader(sub.endpoint), TTL: '86400', 'Content-Length': '0', Urgency: 'high' } }, res => {
        res.resume(); res.on('end', () => resolve(res.statusCode === 404 || res.statusCode === 410 ? 'gone' : res.statusCode < 300 ? 'ok' : 'error'));
      });
      req.on('timeout', () => req.destroy()); req.on('error', () => resolve('error')); req.end();
    } catch { resolve('error'); }
  });
}
module.exports = { send, publicKey: () => loadKeys().publicKey };
