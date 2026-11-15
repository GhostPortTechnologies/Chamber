#!/usr/bin/env node
// keykeeper.js (T-0222): keeps the data keys of open workspaces in memory while the app itself is restarted.
//
// Chamber is released several times a day, and every release restarts the app. Without this, each restart would lock every
// workspace that uses the owner lock until its owner typed the passphrase again. This small program runs beside the app, holds
// { workspace id: key } in memory and answers the app over a socket only the app's own account can open. It never writes a key
// anywhere. When the machine restarts, or this program does, the keys are gone and those workspaces are locked: that is the point.
//   node keykeeper.js            listens on CHAMBER_KEYS_SOCKET (default /run/chamber/keys.sock)
// One request per line, as JSON: {"op":"put","ws":"<id>","key":"<64 hex>"} | {"op":"get","ws":".."} | {"op":"del","ws":".."} |
// {"op":"list"} | {"op":"ping"}. One answer per line: {"ok":true,...} or {"ok":false,"error":".."}.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const net = require('net'), fs = require('fs'), path = require('path');
const SOCK = process.env.CHAMBER_KEYS_SOCKET || '/run/chamber/keys.sock', WS_RE = /^[a-f0-9]{8,64}$/i, KEY_RE = /^[a-f0-9]{64}$/i, MAX = 100000;
const keys = new Map(), started = Date.now();
function answer(req) {
  if (!req || typeof req !== 'object') return { ok: false, error: 'not a request' };
  if (req.op === 'ping') return { ok: true, since: started, open: keys.size };
  if (req.op === 'list') return { ok: true, ws: [...keys.keys()] };
  if (!WS_RE.test(String(req.ws || ''))) return { ok: false, error: 'bad workspace id' };
  if (req.op === 'put') { if (!KEY_RE.test(String(req.key || ''))) return { ok: false, error: 'bad key' }; if (!keys.has(req.ws) && keys.size >= MAX) return { ok: false, error: 'full' }; keys.set(req.ws, req.key.toLowerCase()); return { ok: true }; }
  if (req.op === 'get') return keys.has(req.ws) ? { ok: true, key: keys.get(req.ws) } : { ok: true, key: null };
  if (req.op === 'del') return { ok: true, had: keys.delete(req.ws) };
  return { ok: false, error: 'unknown op' };
}
const server = net.createServer(conn => {
  let buf = '';
  conn.setEncoding('utf8');
  conn.on('data', d => { buf += d; if (buf.length > 4096 && !buf.includes('\n')) { conn.destroy(); return; }
    let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); let req = null; try { req = JSON.parse(line); } catch { /* answered below */ } conn.write(JSON.stringify(answer(req)) + '\n'); } });
  conn.on('error', () => {});
});
function listen() {
  fs.mkdirSync(path.dirname(SOCK), { recursive: true, mode: 0o700 });
  const old = process.umask(0o177);                                             // the socket is made readable and writable by this account only
  server.listen(SOCK, () => { process.umask(old); try { fs.chmodSync(SOCK, 0o600); } catch {} console.log(`[keykeeper] listening on ${SOCK}; keys are kept in memory only`); });
}
server.on('error', e => {
  if (e.code !== 'EADDRINUSE') { console.error('[keykeeper] ' + e.message); process.exit(1); }
  const probe = net.connect(SOCK);                                              // is somebody answering there, or is it a leftover from a stopped run?
  probe.on('connect', () => { console.error(`[keykeeper] another key keeper is already running on ${SOCK}`); process.exit(1); });
  probe.on('error', () => { try { fs.unlinkSync(SOCK); } catch {} listen(); });
});
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { keys.clear(); try { fs.unlinkSync(SOCK); } catch {} process.exit(0); });
listen();
