// wslock.js (T-0222): which workspaces use the owner lock, and the data keys of the ones that are open right now.
//
// A workspace with the owner lock has a state (accounts.json, ws.lock.state):
//   'sealing'    the lock was just switched on; its stored data is being sealed with its key, one file at a time
//   'on'         everything that is sealed is sealed
//   'unsealing'  the owner switched the lock off; its data is being turned back into plain files
// It is OPEN while the server holds its data key in memory, and LOCKED otherwise. A locked workspace's data is not read or
// written by anyone: requests are answered 423, background work skips it, and storage code refuses (server.js F()).
// The keys live here, in memory, and (when CHAMBER_KEYS_SOCKET names one) in the key keeper beside the app, so that releasing a
// new version of the app does not lock everyone out. They are never written to disk. When the machine restarts, both are gone.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const net = require('net'), crypto = require('crypto'), wscrypt = require('./wscrypt');
const SOCK = process.env.CHAMBER_KEYS_SOCKET || '';
const keys = new Map(), states = new Map();

class LockedError extends Error { constructor(ws) { super('this workspace is locked by its owner'); this.locked = true; this.ws = ws; } }
function setState(ws, st) { if (!ws) return; if (st) states.set(ws, st); else states.delete(ws); }
function state(ws) { return ws ? states.get(ws) || null : null; }
function locked(ws) { return !!ws && states.has(ws) && !keys.has(ws); }
function key(ws) { return (ws && keys.get(ws)) || null; }
const keeper = () => !!SOCK;

function ask(req) {                                                   // one line to the key keeper, one line back; null when it is not there
  if (!SOCK) return Promise.resolve(null);
  return new Promise(resolve => {
    let buf = '', done = false; const end = v => { if (!done) { done = true; try { c.destroy(); } catch {} resolve(v); } };
    const c = net.connect(SOCK); c.setEncoding('utf8'); c.setTimeout(2000, () => end(null));
    c.on('connect', () => c.write(JSON.stringify(req) + '\n'));
    c.on('data', d => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { try { end(JSON.parse(buf.slice(0, i))); } catch { end(null); } } });
    c.on('error', () => end(null)); c.on('close', () => end(null));
  });
}
async function open(ws, dk) {                                         // hold the key; tell the keeper (best effort: without it a restart locks the workspace)
  if (!wscrypt.okKey(dk)) throw new Error('not a workspace key');
  keys.set(ws, Buffer.from(dk));
  const r = await ask({ op: 'put', ws, key: Buffer.from(dk).toString('hex') });
  return !!(r && r.ok);
}
async function forget(ws) {
  const k = keys.get(ws); if (k) k.fill(0); keys.delete(ws);
  await ask({ op: 'del', ws });
}
// At start: ask the keeper for the keys of the workspaces that use the lock, and keep only keys that prove right (list: [{ ws, check }]).
async function restore(list) {
  let restored = 0, answered = false;
  for (const { ws, check } of list) {
    const r = await ask({ op: 'get', ws }); if (r) answered = true;
    if (!r || !r.ok || !/^[a-f0-9]{64}$/i.test(String(r.key || ''))) continue;
    const dk = Buffer.from(r.key, 'hex'), want = Buffer.from(String(check || ''), 'hex'), got = Buffer.from(wscrypt.keyCheck(dk), 'hex');
    if (want.length === got.length && crypto.timingSafeEqual(want, got)) { keys.set(ws, dk); restored++; } else { dk.fill(0); await ask({ op: 'del', ws }); }
  }
  return { restored, keeper: answered || (!list.length && !!(await ask({ op: 'ping' }))) };
}
module.exports = { LockedError, setState, state, locked, key, open, forget, restore, keeper, ask };
