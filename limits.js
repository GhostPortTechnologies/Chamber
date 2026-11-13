// limits.js — tiny fixed-window rate limiter, zero dependencies (T-0033).
//   const lim = makeLimiter(60);            // 60 hits per key per minute
//   const r = lim.hit('ws:alice');          // { ok, remaining, retryAfter (s) }
// Keys are swept once a minute so the map never grows with dead keys. `now` is injectable for tests.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
function makeLimiter(perMinute, now = Date.now) {
  const hits = new Map(); let lastSweep = 0;
  return {
    hit(key) {
      const t = now();
      if (t - lastSweep > 60000) { for (const [k, r] of hits) if (r.resetAt < t) hits.delete(k); lastSweep = t; }
      let r = hits.get(key);
      if (!r || r.resetAt < t) { r = { n: 0, resetAt: t + 60000 }; hits.set(key, r); }
      r.n++;
      return { ok: r.n <= perMinute, remaining: Math.max(0, perMinute - r.n), retryAfter: Math.ceil((r.resetAt - t) / 1000) };
    },
    size() { return hits.size; },
  };
}
module.exports = { makeLimiter };
