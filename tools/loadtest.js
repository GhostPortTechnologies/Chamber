#!/usr/bin/env node
// tools/loadtest.js — load test for a Chamber instance (T-0038). Zero dependencies. Never point it at production.
//
//   node tools/loadtest.js --base http://127.0.0.1:PORT --token <session or chk_ token> [--sse 200] [--rate 50] [--agents 20] [--seconds 60]
//                         [--login email:password --sessions 40]   spread the streams over N real sessions (per-session caps apply otherwise)
//
// Opens --sse event streams for the workspace, posts --rate messages/second as the given user, and runs --agents
// pollers that GET /api/messages?since= every 2s (what connectors do). Reports p50/p95/max latency for POSTs and for
// the time from POST until the event reached the streams, HTTP errors, 429s, and the server's rss from /api/health.
'use strict';
const http = require('http'); const https = require('https');
const args = Object.fromEntries(process.argv.slice(2).map((a, i, arr) => a.startsWith('--') ? [a.slice(2), arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1'] : null).filter(Boolean));
const BASE = args.base || 'http://127.0.0.1:4242', TOKEN = args.token || '', SSE = +args.sse || 200, RATE = +args.rate || 50, AGENTS = +args.agents || 20, SECONDS = +args.seconds || 60, USER = args.user || 'alice', ROOM = args.room || 'general';
if (!TOKEN) { console.error('need --token'); process.exit(2); }
const lib = BASE.startsWith('https') ? https : http;
const agent = new lib.Agent({ keepAlive: true, maxSockets: 1000 });
const H = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };
const mx = (arr) => arr.reduce((a, b) => (b > a ? b : a), 0);   // no spread: hundreds of thousands of samples overflow the stack
const pct = (arr, p) => { if (!arr.length) return 0; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))]; };
const stats = { post: [], event: [], errors: {}, rate429: 0, posted: 0, events: 0, sseOpen: 0, sseFailed: 0 };
const sentAt = new Map(); const tokens = [TOKEN];

function req(method, p, body) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const r = lib.request(BASE + p, { method, headers: H, agent }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, ms: Date.now() - t0, body: d })); });
    r.on('error', e => resolve({ status: 0, ms: Date.now() - t0, error: e.code || e.message })); r.end(body ? JSON.stringify(body) : undefined);
  });
}
function openSse(i = 0) {
  const tok = tokens[i % tokens.length];
  return new Promise((resolve) => {
    const r = lib.request(BASE + '/api/events', { headers: { Authorization: `Bearer ${tok}`, Accept: 'text/event-stream' }, agent }, res => {
      if (res.statusCode !== 200) { stats.sseFailed++; stats.errors[`sse${res.statusCode}`] = (stats.errors[`sse${res.statusCode}`] || 0) + 1; res.resume(); return resolve(null); }
      stats.sseOpen++; let buf = '';
      res.on('data', c => { buf += c; let i; while ((i = buf.indexOf('\n\n')) >= 0) { const ev = buf.slice(0, i); buf = buf.slice(i + 2); const m = ev.match(/data: (.*)/); if (!m) continue; try { const d = JSON.parse(m[1]); if (d.kind === 'messages' && d.marker && sentAt.has(d.marker)) { stats.event.push(Date.now() - sentAt.get(d.marker)); stats.events++; } } catch {} } });
      res.on('close', () => { stats.sseOpen--; }); resolve(res);
    });
    r.on('error', () => { stats.sseFailed++; resolve(null); }); r.end();
  });
}
(async () => {
  console.log(`loadtest: ${SSE} streams, ${RATE} msg/s, ${AGENTS} pollers, ${SECONDS}s against ${BASE}`);
  if (args.login && +args.sessions > 1) {                                   // many sessions, like many devices
    const [email, password] = args.login.split(':');
    for (let i = tokens.length; i < +args.sessions; i++) { const r = await req('POST', '/account/login', { email, password }); try { tokens.push(JSON.parse(r.body).token); } catch { stats.errors[`login${r.status}`] = (stats.errors[`login${r.status}`] || 0) + 1; } }
    console.log(`  sessions: ${tokens.length}`);
  }
  const streams = []; for (let i = 0; i < SSE; i++) streams.push(openSse(i)); await Promise.all(streams);
  console.log(`  streams open: ${stats.sseOpen} (failed ${stats.sseFailed})`);
  const stop = Date.now() + SECONDS * 1000; let since = Date.now();
  const pollers = Array.from({ length: AGENTS }, async (_, i) => { await new Promise(r => setTimeout(r, i * 97)); while (Date.now() < stop) { const r = await req('GET', `/api/messages?room=${ROOM}&since=${since}`); if (r.status !== 200) stats.errors[`poll${r.status}`] = (stats.errors[`poll${r.status}`] || 0) + 1; await new Promise(r => setTimeout(r, 2000)); } });
  const poster = (async () => { let n = 0; while (Date.now() < stop) { const marker = `lt-${process.pid}-${n++}`; sentAt.set(marker, Date.now()); const r = await req('POST', '/api/messages', { username: USER, text: `load ${marker}`, room: ROOM }); stats.post.push(r.ms); if (r.status === 201) stats.posted++; else if (r.status === 429) stats.rate429++; else stats.errors[`post${r.status || r.error}`] = (stats.errors[`post${r.status || r.error}`] || 0) + 1; await new Promise(r => setTimeout(r, Math.max(0, 1000 / RATE - r.ms))); } })();
  const ticker = setInterval(() => process.stdout.write(`  t+${Math.round((Date.now() - (stop - SECONDS * 1000)) / 1000)}s posted=${stats.posted} 429=${stats.rate429} streams=${stats.sseOpen} post p95=${pct(stats.post, 95)}ms\n`), 10000);
  await Promise.all([poster, ...pollers]); clearInterval(ticker);
  await new Promise(r => setTimeout(r, 1500));
  let health = {}; try { health = JSON.parse((await req('GET', '/api/health')).body); } catch {}
  const report = { streams: { requested: SSE, open: stats.sseOpen, failed: stats.sseFailed }, posted: stats.posted, rate429: stats.rate429, errors: stats.errors,
    post_ms: { p50: pct(stats.post, 50), p95: pct(stats.post, 95), max: mx(stats.post) },
    event_ms: { samples: stats.event.length, p50: pct(stats.event, 50), p95: pct(stats.event, 95), max: mx(stats.event) }, server: { version: health.version, rss_mb: health.rss_mb, uptime_s: health.uptime_s } };
  console.log(JSON.stringify(report, null, 1));
  for (const s of await Promise.all(streams)) { try { s?.destroy(); } catch {} }
  process.exit(0);
})();
