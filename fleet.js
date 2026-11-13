// fleet.js — T-0153: link a workspace to a GhostPort fleet tenant and read its routers' status. Read-only.
//
// The owner pastes the tenant's own API key once. It is checked against the fleet, then stored encrypted
// (AES-256-GCM, a per-workspace key derived from fleet-link.key, which lives beside accounts.json with
// mode 0600; the workspace id is bound in as associated data, so a blob copied to another workspace does not
// open). The key is never returned by any route, never logged, never sent anywhere but the fleet URL.
//
// Outbound calls go to ONE fixed URL (CHAMBER_FLEET_URL, https only), GET only. What comes back is device-
// supplied data, so it is treated as untrusted: a fixed list of fields, short, with a plain character set.
// Limits protect the fleet server's own lockouts: answers are cached per workspace, there is a global cap
// on calls per minute, and after 3 wrong keys in 10 minutes no new key is tried for a while (the fleet side
// bans an address after 5).
//
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 GhostPort Technologies
'use strict';
const crypto = require('crypto'); const fs = require('fs'); const path = require('path'); const https = require('https'); const http = require('http');

const TEST_HOOKS = process.env.CHAMBER_TEST_HOOKS === '1';
const FLEET_URL = process.env.CHAMBER_FLEET_URL || 'https://api.ghostporttechnologies.com/fleet/tenant/routers';
// Off unless the operator switches it on (CHAMBER_FLEET_LINK=1): the app hides the menu entry and linking is refused.
const ENABLED = process.env.CHAMBER_FLEET_LINK === '1' || TEST_HOOKS;
const CACHE_MS = (TEST_HOOKS && parseInt(process.env.CHAMBER_FLEET_CACHE_MS)) || 60e3;
const KEY_RE = /^gp_[A-Za-z0-9_-]{20,100}$/;
const BAD_WINDOW_MS = 10 * 60e3, BAD_MAX = 3, CALLS_PER_MIN = 20;

function endpoint() {                                                // https only; plain http is accepted solely for the test suite's loopback stub
  const u = new URL(FLEET_URL);
  if (u.protocol === 'https:' || (TEST_HOOKS && u.protocol === 'http:' && u.hostname === '127.0.0.1')) return u;
  throw new Error('CHAMBER_FLEET_URL must be https');
}

function masterKey(dir) {
  const f = path.join(dir, 'fleet-link.key');
  try { const k = fs.readFileSync(f); if (k.length === 32) return k; } catch { /* first use */ }
  const k = crypto.randomBytes(32); fs.mkdirSync(dir, { recursive: true });
  try { fs.writeFileSync(f, k, { mode: 0o600, flag: 'wx' }); return k; } catch { return fs.readFileSync(f); }   // a racing request may have made it first
}
const wsKey = (dir, wsId) => Buffer.from(crypto.hkdfSync('sha256', masterKey(dir), Buffer.from(String(wsId)), Buffer.from('chamber-fleet-link-v1'), 32));
function seal(dir, wsId, key) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', wsKey(dir, wsId), iv); c.setAAD(Buffer.from(String(wsId)));
  const ct = Buffer.concat([c.update(String(key), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
function unseal(dir, wsId, blob) {                                   // the key, or null when the blob is missing, damaged or from another workspace
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', wsKey(dir, wsId), Buffer.from(blob.iv, 'base64')); d.setAAD(Buffer.from(String(wsId))); d.setAuthTag(Buffer.from(blob.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8');
  } catch { return null; }
}

// Device names, serials and firmware strings are typed on (or sent by) a device. People and agents both read
// them here, so keep a plain character set and a short length: nothing that reads as markup or as an instruction block.
const clean = (s, n = 64) => String(s == null ? '' : s).replace(/[^\w .:+()#\/-]/g, '').replace(/\s+/g, ' ').trim().slice(0, n);
const num = (x) => (Number.isFinite(+x) && +x > 0 ? Math.floor(+x) : null);
function tidy(body) {
  const routers = (Array.isArray(body?.routers) ? body.routers : []).slice(0, 200).map(r => ({
    id: clean(r?.id, 40), name: clean(r?.name), serial: clean(r?.serial, 40), firmware: clean(r?.firmware_version, 32), hardware: clean(r?.hardware, 32),
    status: clean(r?.status, 16), registered_at: num(r?.registered_at), last_seen: num(r?.last_seen), online: r?.online === true }));
  return { tenant: clean(body?.tenant?.name), subscription: clean(body?.tenant?.subscription_status, 16) || 'none', routers,
           count: routers.length, online: routers.filter(r => r.online).length, as_of: num(body?.as_of) || Math.floor(Date.now() / 1000) };
}

let calls = [], bad = [];
const recent = (arr, ms) => { const cut = Date.now() - ms; while (arr.length && arr[0] < cut) arr.shift(); return arr.length; };
const tooManyBadKeys = () => recent(bad, BAD_WINDOW_MS) >= BAD_MAX;

// One GET to the fleet. Resolves { ok, status, data?, error? } and never rejects. status 0 = could not reach it.
function ask(key) {
  return new Promise(resolve => {
    let u; try { u = endpoint(); } catch (e) { return resolve({ ok: false, status: 0, error: e.message }); }
    if (recent(calls, 60e3) >= CALLS_PER_MIN) return resolve({ ok: false, status: 429, error: 'busy: too many router checks this minute, try again shortly' });
    calls.push(Date.now());
    const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'GET', timeout: 6000, headers: { Authorization: `Bearer ${key}`, Accept: 'application/json', 'User-Agent': 'chamber-fleet-link/1' } }, res => {
      let buf = '', size = 0; res.setEncoding('utf8');
      res.on('data', d => { size += d.length; if (size > 512e3) req.destroy(new Error('answer too large')); else buf += d; });
      res.on('end', () => {
        if (res.statusCode === 401) { bad.push(Date.now()); return resolve({ ok: false, status: 401, error: 'the fleet did not accept that key' }); }
        if (res.statusCode !== 200) return resolve({ ok: false, status: res.statusCode, error: `the fleet answered ${res.statusCode}` });
        try { resolve({ ok: true, status: 200, data: tidy(JSON.parse(buf)) }); } catch { resolve({ ok: false, status: 502, error: 'the fleet sent an answer that could not be read' }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', e => resolve({ ok: false, status: 0, error: `could not reach the fleet (${e.code || e.message})` }));
    req.end();
  });
}

const cache = new Map();                                             // wsId -> { at, data }
const forget = (wsId) => cache.delete(wsId);

// Try a key the owner just pasted. { ok, data } or { ok: false, code, error }.
async function tryKey(key) {
  if (!ENABLED) return { ok: false, code: 404, error: 'Router status is not switched on for this Chamber server.' };
  if (!KEY_RE.test(String(key || ''))) return { ok: false, code: 400, error: 'That does not look like a GhostPort tenant API key. It starts with gp_ and is about 46 characters long.' };
  if (tooManyBadKeys()) return { ok: false, code: 429, error: 'Several wrong keys were tried in the last few minutes. Wait 10 minutes, then try again.' };
  const r = await ask(key);
  if (r.ok) return r;
  return { ok: false, code: r.status === 401 ? 400 : 502, error: r.status === 401 ? 'The fleet did not accept that key. Check that you copied the whole key and that the tenant is active.' : `Could not check the key: ${r.error}. Nothing was stored.` };
}

// Status for a linked workspace. link = the stored record ({ sealed, tenant, state, ... }); mark(patch) saves changes to it.
async function routers(dir, wsId, link, mark) {
  const hit = cache.get(wsId);
  if (hit && Date.now() - hit.at < CACHE_MS) return { linked: true, ...hit.data, cached: true };
  if (link.state === 'rejected') return { linked: true, tenant: link.tenant || '', routers: [], count: 0, online: 0, error: 'The fleet no longer accepts the stored key. The workspace owner needs to link again.', needsRelink: true };
  const key = unseal(dir, wsId, link.sealed);
  if (!key) return { linked: true, tenant: link.tenant || '', routers: [], count: 0, online: 0, error: 'The stored key could not be opened. The workspace owner needs to link again.', needsRelink: true };
  const r = await ask(key);
  if (r.ok) { cache.set(wsId, { at: Date.now(), data: r.data }); if (r.data.tenant !== link.tenant || link.lastError) mark({ tenant: r.data.tenant, lastOk: Date.now(), lastError: null }); return { linked: true, ...r.data }; }
  if (r.status === 401) { cache.delete(wsId); mark({ state: 'rejected', lastError: r.error }); return { linked: true, tenant: link.tenant || '', routers: [], count: 0, online: 0, error: 'The fleet no longer accepts the stored key. The workspace owner needs to link again.', needsRelink: true }; }
  if (hit) return { linked: true, ...hit.data, stale: true, error: r.error };            // keep showing the last good answer, marked old
  return { linked: true, tenant: link.tenant || '', routers: [], count: 0, online: 0, error: r.error };
}

module.exports = { enabled: ENABLED, tryKey, routers, seal, unseal, forget, tidy, KEY_RE, FLEET_URL };
