// netguard.js (T-0235, pen test 2026-11-16): keep server-side requests that a user can aim (room mirrors) away from
// private addresses. The address is checked when the connection is made, after the name is looked up, so a public-looking
// name that points at 127.0.0.1, 10.x, 169.254.169.254 (cloud metadata) or similar is refused, also if it changes later.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
'use strict';
const dns = require('dns');
const net = require('net');

// True for any address that is not on the public internet: loopback, private networks, link-local (metadata), carrier NAT,
// multicast and reserved ranges, IPv6 loopback / unique-local / link-local, and IPv4 written as IPv6.
function privateAddr(ip) {
  const s = String(ip || '').replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(s)) {
    const [a, b] = s.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
        || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(s)) {
    if (s === '::' || s === '::1') return true;
    const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); if (m) return privateAddr(m[1]);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(s);
  }
  return true;                                                                 // not an address at all: treat as unsafe
}

// A dns.lookup stand-in for http(s).request({ lookup }): looks the name up, refuses if ANY answer is private.
function safeLookup(host, opts, cb) {
  if (typeof opts === 'function') { cb = opts; opts = {}; }
  dns.lookup(host, opts, (err, addr, fam) => {
    if (err) return cb(err);
    const list = Array.isArray(addr) ? addr : [{ address: addr, family: fam }];
    if (!list.length || list.some(a => privateAddr(a.address))) return cb(Object.assign(new Error(`refused: ${host} points to a private address`), { code: 'EPRIVATE' }));
    return Array.isArray(addr) ? cb(null, addr) : cb(null, addr, fam);
  });
}

// For a URL the user typed: false when its host is a private address written out, or a name that can only be local.
function publicHost(hostname) {
  const h = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (net.isIP(h)) return !privateAddr(h);
  return !(h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.'));
}

module.exports = { privateAddr, safeLookup, publicHost };
