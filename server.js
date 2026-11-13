#!/usr/bin/env node
// Chamber — standalone AI coordination chat + code-review board.
// A self-contained coordination app: chat, presence, and a code-review pad.
// Pure Node built-ins only (no npm packages) — runs on any Node >= 18.
//
// SPDX-License-Identifier: AGPL-3.0-only                                     [new] license identifier
// Copyright (C) 2026 GhostPort Technologies                                  [new] copyright holder (change if a different entity owns it)
// Free software under the GNU Affero General Public License v3; NO WARRANTY. [new]
// See the LICENSE file or <https://www.gnu.org/licenses/>.                   [new]

const http = require('http');
const { exportTickets } = require('./ticket-export');                         // [new] printable HTML / Markdown / CSV ticket export (ticket-export.js)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');                                                // [new] T-0112: archives are gzip-compressed before sealing                                            // [new] auth: scrypt hashing, timing-safe compare, session tokens
const { execFile } = require('child_process');
const { AsyncLocalStorage } = require('async_hooks');                        // [new] per-request workspace scope (T-0002)
const fleet = require('./fleet');                                            // T-0153: GhostPort fleet link (router status, read-only)
const accounts = require('./accounts');                                      // [new] user accounts + Stripe paywall (CHAMBER_ACCOUNTS=1)
const store = require('./store');                                            // [new] T-0017: SQLite chat store (node:sqlite, zero deps)
const { makeLimiter } = require('./limits');                                 // [new] T-0033: per-user write limiter
const cron = require('./cron');                                              // [new] T-0058: schedules

// Minimal zero-dep .env loader — reads KEY=VALUE lines from ./.env if present,   [new] lets `node server.js` be configured
// without overriding anything already set in the real environment.             without systemd or a dotenv package.
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);           // [new] KEY=VALUE, ignores blanks/# comments
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');  // [new] strip optional quotes
  }
} catch { /* no .env file — perfectly fine */ }                              // [new]

// ── Configuration ─────────────────────────────────────────────────────
// Everything is env-tunable so the app is portable across hosts/OSes.        [new] these were previously hardcoded host paths.
// Core data files default to the app's own directory, so a bare checkout      [new] __dirname default = self-contained,
// runs self-contained with no external paths required.                       nothing to create before first run.
const PORT = parseInt(process.env.CHAMBER_PORT, 10) || 4242;                 // [new] listen port (was: const PORT = 4242)
const HOST = process.env.CHAMBER_HOST || '127.0.0.1';                        // [new] bind addr; keep loopback unless you add auth
const DATA_FILE = process.env.CHAMBER_DATA || path.join(__dirname, 'chamber.json');       // [new] chat store, local by default
const REVIEWS_FILE = process.env.CHAMBER_REVIEWS || path.join(__dirname, 'reviews.json');  // [new] reviews store, local by default

// ── Optional host integrations (auto-disabled when unset / missing) ────
// Leave these unset for a plain chat + code-pad install; the related tabs     [new] host-specific paths are now
// simply return empty instead of erroring.                                   optional, not baked in.
const TICKETS_FILE = process.env.CHAMBER_TICKETS_FILE || '';                 // [new] host ticket JSON to READ (optional)
const TICKETS_CLI  = process.env.CHAMBER_TICKETS_CLI  || '';                 // [new] CLI that WRITES tickets (optional)
const REPO_ROOT    = process.env.CHAMBER_REPO_ROOT    || '';                 // [new] git repo for the Reviews diff feature (optional)
const THEME_FILE   = process.env.CHAMBER_THEME_FILE   || '';                 // [new] JSON {color} for live accent theming (optional)
const REPO_URL     = (process.env.CHAMBER_REPO_URL || 'https://github.com/GhostPortTechnologies/Chamber').replace(/\/$/, '');   // [new] T-0047: commit SHAs in chat link here
const DEFAULT_ACCENT = process.env.CHAMBER_ACCENT || '#00ff88';
const TEST_HOOKS = process.env.CHAMBER_TEST_HOOKS === '1';
const VERSION = (() => { try { return require('child_process').execFileSync('git', ['-C', __dirname, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8', timeout: 3000 }).trim(); } catch { return 'unknown'; } })();  // [new] T-0027
const STARTED_AT = Date.now();                                               // [new] T-0027: for uptime in /api/health
const LATEST_AGENT_VERSION = (() => { try { return (fs.readFileSync(path.join(__dirname, 'agent', 'chamber-agent.py'), 'utf8').match(/^AGENT_VERSION = "([^"]+)"/m) || [])[1] || null; } catch { return null; } })();   // [new] T-0046
const agentMeta = new Map();                                                 // [new] T-0046/T-0045: `${ws}:${username}` -> { version, rooms, at } from /api/ping
function statusFile(name) {                                                  // [new] T-0027: backup-status.json / restore-drill-status.json written by the ops scripts
  try { const s = JSON.parse(fs.readFileSync(path.join(path.dirname(DATA_FILE), name), 'utf8'));
        return { ok: !!s.ok, at: s.at || null, age_hours: s.at ? Math.round((Date.now() - Date.parse(s.at)) / 36e5 * 10) / 10 : null, message: s.ok ? undefined : String(s.message || '').slice(0, 200) }; }
  catch { return { ok: null, at: null, age_hours: null }; }                 // never ran yet
}                    // [new] T-0025: fault-injection routes for test_isolation.js only             // [new] fallback accent; matches the CSS :root default so there's no color shift on load

// ── Workspaces (T-0001/T-0002) ───────────────────────────────────────────
// With accounts on, every request runs inside reqScope with its workspace id, and F() points every
// store (chat, reviews, tickets) at that workspace's own files. Without accounts (self-hosted loopback
// install) F() returns the classic single-board paths, so nothing changes for that mode.
const reqScope = new AsyncLocalStorage();                                    // [new]
const WS_ROOT = path.join(path.dirname(DATA_FILE), 'ws');                   // [new] /var/lib/chamber/ws/<id>/
function F() {                                                               // [new] files for the current request's workspace
  const ws = reqScope.getStore()?.ws;
  if (!ws) return { data: DATA_FILE, reviews: REVIEWS_FILE, tickets: TICKETS_FILE };
  const d = path.join(WS_ROOT, ws);
  return { data: path.join(d, 'chamber.json'), reviews: path.join(d, 'reviews.json'), tickets: path.join(d, 'tickets.json') };
}
function withWorkspace(ws, fn, extra) { return reqScope.run({ ws, ...(extra || {}) }, fn); }   // [changed] T-0057: extra = { rid, ip } for the audit log

// ── Live updates (T-0016): one event stream per client, grouped by workspace, so a change in one workspace
// never reaches another. notify() is called by the handlers that change something; clients then re-fetch.
const subscribers = new Map();                                               // ws id (or '_' without accounts) -> Set(res)
function notify(kind, extra = {}) {
  const ws = reqScope.getStore()?.ws || '_';
  const payload = `event: change\ndata: ${JSON.stringify({ kind, ...extra })}\n\n`;
  for (const r of subscribers.get(ws) || []) { try { r.write(payload); } catch { /* gone */ } }
}

// ── Agent audit log (T-0015): every write an agent token makes is recorded per workspace (last 500).
// ── Audit log (T-0015, T-0057) ──────────────────────────────────────────────────────────────────────────
// One log per workspace. audit.json keeps the last AUDIT_RECENT entries for the account page; every entry is also
// appended to audit-YYYY-MM.jsonl (append-only, picked up by the backup) so nothing is lost when the recent file rolls.
// Agent writes are always logged; human actions are logged where the handler says so (admin actions, tickets, edits).
// Entries carry the request id (X-Request-Id) and, for humans, the client ip, so a log line can be matched to the server log.
const AUDIT_RECENT = 2000;
function audit(sess, entry, always = false) {
  if (!sess?.username) return;
  if (!sess.agent && !always) return;
  const scope = reqScope.getStore() || {};
  const rec = { ts: Date.now(), actor: sess.username, kind: sess.agent ? 'agent' : 'human', ...entry, rid: scope.rid || undefined };
  if (!sess.agent && scope.ip) rec.ip = scope.ip;
  if (sess.agent) rec.agent = sess.username;                                   // kept for older readers of audit.json
  const dir = path.dirname(F().data);
  try { auditRepair(dir); auditAppend(dir, rec); }
  catch (e) { console.error('[audit] write failed:', e.message); }
}
// T-0217: if the server stops in the instant between writing an entry and writing its check value (audit-head.json), the record would
// afterwards read as "the newest entries were removed" although nobody touched it. Once per workspace after a start: when the newest
// entry on disk is exactly the one valid next entry after the stored head, the head is brought up to it and the record says so.
// Anything else (a changed entry, a gap, more than one entry past the head) is left alone and still reads as not intact.
const auditChecked = new Set();
function auditRepair(dir) {
  if (auditChecked.has(dir)) return null; auditChecked.add(dir);
  try {
    const headFile = path.join(dir, 'audit-head.json'); let head; try { head = JSON.parse(fs.readFileSync(headFile, 'utf8')); } catch { return null; }
    const files = fs.readdirSync(dir).filter(f => /^audit-\d{4}-\d{2}\.jsonl$/.test(f)).sort(); if (!files.length) return null;
    const lines = fs.readFileSync(path.join(dir, files[files.length - 1]), 'utf8').split('\n').filter(Boolean); if (!lines.length) return null;
    let r; try { r = JSON.parse(lines[lines.length - 1]); } catch { return null; }
    if (!r || !Number.isInteger(head.n) || r.n !== head.n + 1 || (r.prev || null) !== (head.h || null) || auditChain.hash(r) !== r.h) return null;
    const tmp = headFile + '.tmp.' + process.pid; fs.writeFileSync(tmp, JSON.stringify({ n: r.n, h: r.h, since: head.since || r.ts }), { mode: 0o600 }); fs.renameSync(tmp, headFile);
    auditAppend(dir, { ts: Date.now(), actor: 'chamber', kind: 'system', action: 'record-repaired', entry: r.n, note: 'the server stopped between writing this entry and its check value; the check value was restored when the server started again' });
    console.log(`[audit] ${path.basename(dir)}: restored the check value for entry ${r.n} (the server had stopped before writing it)`);
    return r.n;
  } catch (e) { console.error('[audit] repair check failed:', e.message); return null; }
}
function auditAppend(dir, rec) {                                              // one entry onto the chained record, its check value, and the short recent list
  const file = path.join(dir, 'audit.json');
  fs.mkdirSync(dir, { recursive: true });
  const headFile = path.join(dir, 'audit-head.json'); let head = {}; try { head = JSON.parse(fs.readFileSync(headFile, 'utf8')); } catch { /* first chained entry */ }   // T-0194
  rec.n = (head.n || 0) + 1; rec.prev = head.h || null; rec.h = auditChain.hash(rec);
  fs.appendFileSync(path.join(dir, `audit-${new Date(rec.ts).toISOString().slice(0, 7)}.jsonl`), JSON.stringify(rec) + '\n', { mode: 0o600 });
  { const tmpH = headFile + '.tmp.' + process.pid; fs.writeFileSync(tmpH, JSON.stringify({ n: rec.n, h: rec.h, since: head.since || rec.ts }), { mode: 0o600 }); fs.renameSync(tmpH, headFile); }
  let log = []; try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first entry */ }
  log.push(rec);
  if (log.length > AUDIT_RECENT) log = log.slice(-AUDIT_RECENT);
  const tmp = file + '.tmp.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(log)); fs.renameSync(tmp, file);
}
const auditChain = require('./auditchain');                                   // T-0194: tamper-evident activity record
function verifyAudit(dir) {                                                   // T-0194: walk the record as written and recompute every check value
  auditRepair(dir);                                                           // T-0217
  let files = []; try { files = fs.readdirSync(dir).filter(f => /^audit-\d{4}-\d{2}\.jsonl$/.test(f)).sort(); } catch { /* no record yet */ }
  const entries = [];
  for (const f of files) fs.readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => { if (!line) return; let r; try { r = JSON.parse(line); } catch { r = null; } entries.push(r && typeof r === 'object' ? { ...r, _where: { file: f, line: i + 1 } } : null); });
  let head = null; try { head = JSON.parse(fs.readFileSync(path.join(dir, 'audit-head.json'), 'utf8')); } catch { /* none yet */ }
  return { ...auditChain.verify(entries, head), since: head && head.since || null };
}
function auditAll(dir) {                                                       // T-0057: everything we have, oldest first (archives + recent, de-duplicated)
  const seen = new Set(), out = [];
  const files = fs.readdirSync(dir).filter(f => /^audit-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  for (const f of files) for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { if (!line) continue; try { const r = JSON.parse(line); const k = r.h ? 'h:' + r.h : `${r.ts}|${r.actor || r.agent}|${r.action}`; if (!seen.has(k)) { seen.add(k); out.push(r); } } catch {} }
  try { for (const r of JSON.parse(fs.readFileSync(path.join(dir, 'audit.json'), 'utf8'))) { const k = r.h ? 'h:' + r.h : `${r.ts}|${r.actor || r.agent}|${r.action}`; if (!seen.has(k)) { seen.add(k); out.push(r); } } } catch {}
  return out.sort((a, b) => a.ts - b.ts);
}

// T-0218: what a connector says its file tools can reach on its own machine. Folder NAMES only (the connector never sends where
// they are), kept in memory with the rest of what it pings and shown under People and agents. Chamber cannot change it.
function reachOf(r) {
  if (!r || typeof r !== 'object' || !['all', 'attached', 'none'].includes(r.mode)) return undefined;
  const out = { mode: r.mode, private: Math.max(0, Math.min(999, parseInt(r.private, 10) || 0)) };
  if (r.mode === 'attached') out.names = (Array.isArray(r.names) ? r.names : []).slice(0, 12).map(n => String(n).slice(0, 60));
  if (r.cmd === true) out.cmd = true;
  return out;
}

const MAX_MESSAGES = 500;
const MAX_REVIEWS = 200;
const ACTIVE_TIMEOUT = 60000; // 60s — user considered active if seen within this window
const ONLINE_TIMEOUT = 30000; // 30s — sidebar online indicator

// Feature flags resolved once at startup so host-integration endpoints can    [new] single source of truth for "is this
// short-circuit cleanly instead of throwing on missing files/CLIs.           integration wired up?"
const TICKETS_READ_ENABLED  = !!TICKETS_FILE;                               // [new]
const TICKETS_WRITE_ENABLED = !!TICKETS_CLI;                                // [new]
const REPO_ENABLED = !!REPO_ROOT && fs.existsSync(REPO_ROOT);              // [new] reviews-from-git needs a real repo dir

// ── Authentication ─────────────────────────────────────────────────────
// Zero-dep auth via Node's crypto. Set CHAMBER_PASSWORD (a shared access secret)
// to require login; it is scrypt-hashed at boot and never stored in the clear.
// Or supply a pre-hashed CHAMBER_PASSWORD_HASH ("salt:hash") to keep even the
// plaintext out of the environment. If neither is set, auth is OFF — which is
// only allowed on loopback (enforced by the startup guard below).
const SESSION_TTL = 1000 * 60 * 60 * 24 * 7;                                // [new] 7-day sessions
const COOKIE_SECURE = process.env.CHAMBER_SECURE_COOKIE === '1';           // [new] add "Secure" to the cookie when served over HTTPS
const IS_LOOPBACK = HOST === '127.0.0.1' || HOST === '::1' || HOST === 'localhost';  // [new]
let PW_SALT = '', PW_HASH = '';                                             // [new]
if (process.env.CHAMBER_PASSWORD_HASH) {                                    // [new] pre-hashed "salt:hash"
  [PW_SALT, PW_HASH] = process.env.CHAMBER_PASSWORD_HASH.split(':');
} else if (process.env.CHAMBER_PASSWORD) {                                  // [new] plaintext secret -> hash once at boot
  PW_SALT = crypto.randomBytes(16).toString('hex');
  PW_HASH = crypto.scryptSync(process.env.CHAMBER_PASSWORD, PW_SALT, 32).toString('hex');
}
const AUTH_REQUIRED = accounts.enabled || !!(PW_SALT && PW_HASH);           // [changed] on with per-user accounts OR a shared password

function checkPassword(pw) {                                                // [new] constant-time access-secret verify
  if (!AUTH_REQUIRED) return true;                                         // [new] no secret configured -> open (loopback only)
  if (typeof pw !== 'string' || !pw) return false;
  const got = Buffer.from(crypto.scryptSync(pw, PW_SALT, 32).toString('hex'));
  const want = Buffer.from(PW_HASH);
  return got.length === want.length && crypto.timingSafeEqual(got, want);  // [new] timing-safe to avoid leaking via response time
}

const sessions = new Map();                                                 // token -> {username, role, expires, email?}
// With accounts on, sessions survive restarts (a deploy must not log every customer out).   [new]
const SESSIONS_FILE = path.join(path.dirname(DATA_FILE), 'sessions.json');
function persistSessions() {
  if (!accounts.enabled) return;
  try {
    fs.mkdirSync(path.dirname(SESSIONS_FILE), { recursive: true });
    const live = [...sessions].filter(([, s]) => s.expires > Date.now());
    const tmp = SESSIONS_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(live), { mode: 0o600 }); fs.renameSync(tmp, SESSIONS_FILE);
  } catch (e) { console.error('sessions: could not save:', e.message); }
}
if (accounts.enabled) {
  try { for (const [t, s] of JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))) if (s.expires > Date.now()) sessions.set(t, s); } catch { /* first start */ }
  setInterval(persistSessions, 30000).unref();                             // [changed] T-0025: SIGTERM handled by shutdown() below
}
function createSession(username, role, extra = {}) {                        // [changed] extra: {email} when accounts are on
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { username, role, expires: Date.now() + SESSION_TTL, ...extra });
  persistSessions();                                                        // [new]
  return token;
}
function getSession(req) {                                                  // [new] resolve session from cookie OR bearer/header (browser + API clients)
  let token = '';
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) token = auth.slice(7).trim();            // [new] API clients: Authorization: Bearer <token>
  if (accounts.enabled && token.startsWith('chk_')) return accounts.tokenSession(token);   // [new] T-0007: workspace agent token
  if (!token) token = (req.headers['x-chamber-token'] || '').trim();       // [new] or X-Chamber-Token header
  if (!token && req.headers.cookie) {                                      // [new] browsers: HttpOnly cookie
    const m = req.headers.cookie.match(/(?:^|;\s*)chamber_session=([a-f0-9]+)/);
    if (m) token = m[1];
  }
  if (!token) return null;
  const s = sessions.get(token);
  if (!s || s.expires < Date.now()) { sessions.delete(token); return null; }  // [new] expire + sweep on read
  return { token, ...s };
}
const LOGIN_PER_MINUTE = parseInt(process.env.CHAMBER_LOGIN_PER_MINUTE, 10) || 10;   // [new] per IP; tests raise it
const loginHits = new Map();                                                // [new] ip -> {n, resetAt} — brute-force throttle
function loginThrottled(ip) {                                               // [new]
  const now = Date.now(), rec = loginHits.get(ip);
  if (!rec || rec.resetAt < now) { loginHits.set(ip, { n: 1, resetAt: now + 60000 }); return false; }
  rec.n++;
  return rec.n > LOGIN_PER_MINUTE;                                          // [changed] >N login attempts/min/IP -> 429
}

function loadTickets() {
  const file = F().tickets;                                                 // [changed] the current workspace's store
  if (!file) return { next_id: 1, tickets: [] };                            // [new] no ticket file → empty (don't read '')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { next_id: 1, tickets: [] };
  }
}

function runTicketsCLI(args) {
  return new Promise((resolve) => {
    if (!TICKETS_WRITE_ENABLED) {                                           // [new] no CLI configured → clean disabled reply
      return resolve({ ok: false, stdout: '', stderr: 'tickets integration not configured' });  // [new]
    }
    const env = { ...process.env, CHAMBER_TICKETS_FILE: F().tickets };     // [new] the CLI writes the current workspace's store
    execFile(TICKETS_CLI, args, { timeout: 5000, env }, (err, stdout, stderr) => {
      if (!err) notify('tickets');                                              // [new] T-0016
      resolve({ ok: !err, stdout: (stdout || '').trim(), stderr: (stderr || '').trim() });
    });
  });
}

// ── Reviews layer ─────────────────────────────────────────────────────
// A "review" is a snapshot of one or more file diffs against git HEAD,
// captured at the moment an AI shipped an inline fix. Operator approves or
// rejects. The captured diff is the immutable artifact.

function loadReviews() {
  try {
    return JSON.parse(fs.readFileSync(F().reviews, 'utf8'));                   // [changed] per workspace
  } catch {
    return { next_id: 1, reviews: [] };
  }
}

function saveReviews(data) {
  if (data.reviews.length > MAX_REVIEWS) {
    data.reviews = data.reviews.slice(-MAX_REVIEWS);
  }
  const file = F().reviews;                                                 // [changed] per workspace
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic write — temp file, fsync, rename.
  const tmp = file + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  notify('reviews');                                                        // [new] T-0016
}

function gitDiffFile(filePath) {
  return new Promise((resolve) => {
    if (!REPO_ENABLED) {                                                    // [new] guard: no repo configured → feature off.
      return resolve({ ok: false, diff: '', error: 'repo integration not configured' });  // [new] also stops the startsWith('/')
    }                                                                        // [new] path-escape that an empty REPO_ROOT would allow.
    // Stay inside the repo to avoid path-escape attacks.
    if (!filePath.startsWith(REPO_ROOT + '/')) {
      return resolve({ ok: false, diff: '', error: 'path outside repo' });
    }
    const rel = path.relative(REPO_ROOT, filePath);
    execFile('git', ['-C', REPO_ROOT, 'diff', 'HEAD', '--', rel],
      { timeout: 5000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.code !== 1) {
          // exit 0 = clean, 1 = differences, anything else = real error
          return resolve({ ok: false, diff: '', error: stderr || err.message });
        }
        resolve({ ok: true, diff: stdout || '', error: '' });
      });
  });
}

function reviewListView(reviews) {
  // List view strips the diff body (can be large) — clients fetch detail on click.
  return reviews.map(r => ({
    id: r.id,
    by: r.by,
    ticket_id: r.ticket_id || null,
    note: r.note || '',
    proposed_at: r.proposed_at,
    status: r.status,
    reviewed_by: r.reviewed_by || null,
    reviewed_at: r.reviewed_at || null,
    reject_reason: r.reject_reason || null,
    files: (r.files || []).map(f => ({
      path: f.path,
      added: f.added || 0,
      removed: f.removed || 0,
    })),
  }));
}

function countDiffLines(diff) {
  // Count + and - lines, excluding the +++/--- header lines.
  let added = 0, removed = 0;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added++;
    else if (line.startsWith('-')) removed++;
  }
  return { added, removed };
}

// T-0094: Review assembly line -----------------------------------------------
// Split a stored git-format patch into one {path, diff, added, removed} per file, so an auto-created
// review shows the same per-file blocks a pasted review does.
function splitPatch(patch) {
  if (!patch || !patch.trim()) return [];
  const parts = patch.split(/(?=^diff --git )/m).filter(s => s.trim());
  const src = parts.length ? parts : [patch];
  const out = [];
  for (const d of src) {
    let m = d.match(/^\+\+\+ (?:b\/)?(.+)$/m);
    let p = m ? m[1].trim() : null;
    if (!p || p === '/dev/null') { const dm = d.match(/^--- (?:a\/)?(.+)$/m) || d.match(/^diff --git a\/.+ b\/(.+)$/m); if (dm) p = dm[1].trim(); }
    const counts = countDiffLines(d);
    out.push({ path: String(p || 'change').slice(0, 200), diff: d.length > 200000 ? d.slice(0, 200000) : d, added: counts.added, removed: counts.removed });
    if (out.length >= 20) break;
  }
  return out;
}
// Auto-create one pending review from a ticket's stored diff the moment the connector reports it applied.
// The 'why' is the ticket itself (title + body). Returns the new review id, or null when there is no stored
// patch or an unreviewed auto-review for this ticket already exists (a re-post of /applied must not dup it).
function autoReviewForTicket(t, applied) {
  try {
    let patch; try { patch = fs.readFileSync(path.join(diffDir(), t.id + '.patch'), 'utf8'); } catch { return null; }
    const files = splitPatch(patch);
    if (!files.length) return null;
    const data = loadReviews();
    if (data.reviews.some(r => r.ticket_id === t.id && r.source === 'applied' && r.status === 'pending')) return null;
    const id = `R-${String(data.next_id).padStart(4, '0')}`;
    const why = [String(t.title || '').replace(/^(\[agent\]\s*)+/i, ''), String(t.body || '')].filter(Boolean).join('\n\n').slice(0, 2000);
    data.reviews.push({ id, by: applied.by || t.proposed_by || t.id, ticket_id: t.id, ticket_title: String(t.title || '').slice(0, 200),
      note: why, files, proposed_at: new Date().toISOString(), status: 'pending', reviewed_by: null, reviewed_at: null,
      reject_reason: null, source: 'applied', apply: { branch: applied.branch || '', sha: applied.sha || '' }, ticket_closed: false });
    data.next_id++;
    saveReviews(data);
    return id;
  } catch { return null; }
}

// ── Rooms, direct messages and mentions (T-0012) ───────────────────────────
// A DM room is { name, topic, dm: [userA, userB] } under the key dm:<a>:<b> (lower-cased, sorted).
// Only its two members can list it, read it or post in it. Mentions are @names that exist in the workspace.
const MAX_TEXT = 20000;                                                     // [changed] was 2000 (T-0014)
const MAX_FILE_MB = parseInt(process.env.CHAMBER_MAX_FILE_MB, 10) || 10;      // [new] T-0064: one upload
const TRIAL_FILES_MB = parseInt(process.env.CHAMBER_TRIAL_FILES_MB, 10) || 50;      // T-0159: file allowance while a workspace is on the free trial
const quotaMbFor = sess => (accounts.enabled && accounts.billingFor(sess)?.trial) ? Math.min(FILES_QUOTA_MB, TRIAL_FILES_MB) : FILES_QUOTA_MB + (accounts.enabled ? accounts.storageExtraMbFor(sess) : 0);   // + storage add-on packs
const storageHint = () => (accounts.enabled && accounts.storageOffered()) ? ' The workspace owner can also add storage on the Account page.' : '';
const FILES_QUOTA_MB = parseInt(process.env.CHAMBER_FILES_QUOTA_MB, 10) || 500;   // [new] T-0064: per workspace
const MAX_ATTACH = 5;                                                       // [new] T-0064: files per message
const INLINE_IMAGE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp']);   // [new] T-0064: shown in the page; SVG is NOT (scripts)
const SAFE_DOWNLOAD = /^(text\/|application\/(pdf|json|zip|gzip|x-tar|x-7z-compressed|octet-stream)$|image\/|audio\/|video\/)/;   // [new] T-0064: served with its own type; anything else as octet-stream
// ── Agent runs (T-0071) ─────────────────────────────────────────────────────────────────
// An agent keeps a progress record on its own status line: {state, steps[], tools[], model, tokens_in, tokens_out, ms,
// cost_cents, for, started, ended}. Only agent tokens may write it; every field is trimmed here so a chatty connector
// cannot bloat the database, and a person's `stop` request survives the agent's own updates. People press Stop with
// POST /api/messages/stop; the connector sees it on GET /api/messages/one and ends its run.
const MAX_RUN_BYTES = 64 * 1024;
const REACTIONS = ['👍', '✅', '👀', '❓', '❌', '🎉'];                       // T-0070: the fixed reaction set (agents use 👀 while working, ✅ / ❌ when done)
// T-0089: server-side loop guard — the workspace's own protection against a buggy or third-party connector the
// server does not control. An agent that posts the same (digit-masked) message many times, or at a runaway rate,
// is throttled with 429 + Retry-After. Humans are never throttled. This is a CONSERVATIVE backstop: the precise loop
// prevention is client-side (T-0086 seq cursor + T-0087 answer ledger); the thresholds here are set high enough never
// to catch a legitimately busy agent. State is keyed by workspace:username so tenants never share a throttle.
const AGENT_POSTS = new Map();            // ws:username -> [{room, norm, at}] within the dup window
const LOOP_GUARD = new Map();             // ws:username -> last throttle ms (surfaced in presence)
const LG_DUP_WINDOW = 180000, LG_DUP = 6, LG_RATE_WINDOW = 60000, LG_RATE = 40;
function loopGuardCheck(key, room, text) {
  const now = Date.now();
  const norm = String(text || '').replace(/^@\S+\s+/, '').toLowerCase().replace(/\s+/g, ' ').replace(/\d+/g, '#').trim().slice(0, 400);
  const arr = (AGENT_POSTS.get(key) || []).filter(e => now - e.at < LG_DUP_WINDOW);
  AGENT_POSTS.set(key, arr);
  const dup = arr.filter(e => e.room === room && e.norm === norm).length;
  const rate = arr.filter(e => now - e.at < LG_RATE_WINDOW).length;
  if (dup >= LG_DUP || rate >= LG_RATE) {
    LOOP_GUARD.set(key, now);
    return dup >= LG_DUP ? { blocked: true, reason: `the same message ${dup + 1} times in ${LG_DUP_WINDOW / 1000}s`, retry: Math.ceil(LG_DUP_WINDOW / 1000) }
                         : { blocked: true, reason: `${rate + 1} messages in ${LG_RATE_WINDOW / 1000}s`, retry: Math.ceil(LG_RATE_WINDOW / 1000) };
  }
  arr.push({ room, norm, at: now });
  return { blocked: false };
}
const RUN_STATES = new Set(['running', 'done', 'stopped', 'failed']);
function cleanRun(raw, prev) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = (v, n) => v == null ? undefined : String(v).slice(0, n);
  const num = v => (typeof v === 'number' && isFinite(v)) ? v : undefined;
  const run = { state: RUN_STATES.has(raw.state) ? raw.state : 'running', at: Date.now() };
  if (Array.isArray(raw.steps)) run.steps = raw.steps.slice(-40).map(x => ({ t: s(x && typeof x === 'object' ? x.t : x, 160) || '', ok: x?.ok === true ? true : x?.ok === false ? false : null }));
  if (Array.isArray(raw.tools)) run.tools = raw.tools.slice(-60).filter(x => x && typeof x === 'object').map(x => {
    const o = { tool: s(x.tool, 40) || 'tool', input: s(x.input, 400) || '' };
    if (x.out != null) o.out = s(x.out, 2000); if (num(x.exit) !== undefined) o.exit = x.exit; if (x.error) o.error = true; if (num(x.ms) !== undefined) o.ms = Math.round(x.ms);
    return o;
  });
  for (const k of ['model', 'for', 'note']) if (raw[k] != null) run[k] = s(raw[k], 120);
  for (const k of ['tokens_in', 'tokens_out', 'ms', 'cost_cents', 'started', 'ended']) if (num(raw[k]) !== undefined) run[k] = raw[k];
  if (prev && prev.stop) run.stop = prev.stop;
  if (JSON.stringify(run).length > MAX_RUN_BYTES) return { error: `run record over ${MAX_RUN_BYTES / 1024} KB; trim the transcript` };
  return run;
}
// ── Files: folders + delete (T-0149) ────────────────────────────────────────────────────────
const FOLDER_RULE = 'Folder names: letters, numbers, spaces, . _ - ( ) & + #, with / between levels; up to 5 levels and 200 characters.';
function cleanFolder(v) {                                                   // 'installers/pi' -> same; '' or null -> null (top level); anything else -> false
  if (v === undefined || v === null) return null;
  const s = String(v).trim().replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/|\/$/g, '');
  if (!s) return null;
  if (s.length > 200) return false;
  const parts = s.split('/').map(p => p.trim()); if (parts.length > 5) return false;
  for (const p of parts) if (!p || p.length > 60 || p === '.' || p === '..' || !/^[\p{L}\p{N} ._()&+#-]+$/u.test(p)) return false;
  return parts.join('/');
}
function mayManageFile(sess, rec) {                                        // the person who shared it, or an owner/admin (agents: their own uploads only)
  if (!sess?.username) return false;
  if (String(rec.by || '').toLowerCase() === sess.username.toLowerCase()) return true;
  if (sess.agent) return false;
  if (!accounts.enabled) return true;
  const role = accounts.sessionRole(sess); return role === 'owner' || role === 'admin';
}
function mayStop(sess, msg) {                                                 // the person who asked, or an owner/admin (never an agent)
  if (!sess?.username || sess.agent) return false;
  const me = sess.username.toLowerCase();
  if ((msg.run?.for || '').toLowerCase() === me) return true;
  if (msg.reply_to) { const p = store.get(F().data, msg.reply_to); if (p && p.username.toLowerCase() === me) return true; }
  if (!accounts.enabled) return true;
  const role = accounts.sessionRole(sess); return role === 'owner' || role === 'admin';
}
// ── Vibe-coder mode (T-0072) ────────────────────────────────────────────────────────────────
// A revert is "one tap": the server reverses the stored patch, files a proposal for the agent that applied the original
// (apply_by), and the normal approve → apply flow does the rest. Commanders, owners and admins may ask for it.
function mayRevert(sess) {
  if (!sess?.username || sess.agent) return false;
  if (!accounts.enabled) return true;
  const role = accounts.sessionRole(sess); if (role === 'owner' || role === 'admin') return true;
  return (accounts.commandersFor(reqScope.getStore()?.ws) || []).some(u => u.toLowerCase() === sess.username.toLowerCase());
}
function reverseDiff(diff) {                                                  // unified diff -> its inverse; hunk line counts keep '-- x' content lines from being mistaken for headers
  const lines = diff.split('\n'), out = []; let oldLeft = 0, newLeft = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (oldLeft > 0 || newLeft > 0) {
      if (l.startsWith('\\')) { out.push(l); continue; }                         // "\ No newline at end of file" is not counted
      if (l.startsWith('+')) { out.push('-' + l.slice(1)); newLeft--; continue; }
      if (l.startsWith('-')) { out.push('+' + l.slice(1)); oldLeft--; continue; }
      out.push(l); oldLeft--; newLeft--; continue;                             // context
    }
    const h = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (h) { oldLeft = h[2] === undefined ? 1 : +h[2]; newLeft = h[4] === undefined ? 1 : +h[4]; out.push(`@@ -${h[3]}${h[4] !== undefined ? ',' + h[4] : ''} +${h[1]}${h[2] !== undefined ? ',' + h[2] : ''} @@${h[5]}`); continue; }
    if (l.startsWith('--- ') && (lines[i + 1] || '').startsWith('+++ ')) {       // swap the file headers, keeping --- first
      out.push('--- ' + lines[i + 1].slice(4).replace(/^b\//, 'a/')); out.push('+++ ' + l.slice(4).replace(/^a\//, 'b/')); i++; continue;
    }
    const ix = l.match(/^index ([0-9a-f]+)\.\.([0-9a-f]+)(.*)$/); if (ix) { out.push(`index ${ix[2]}..${ix[1]}${ix[3]}`); continue; }
    if (l.startsWith('new file mode')) { out.push('deleted file mode' + l.slice(13)); continue; }
    if (l.startsWith('deleted file mode')) { out.push('new file mode' + l.slice(17)); continue; }
    out.push(l);
  }
  return out.join('\n');
}
function filesDir() { return path.join(path.dirname(F().data), 'files'); }   // [new] T-0064: <ws dir>/files/<id>
function unlinkFile(rec) { try { fs.unlinkSync(path.join(filesDir(), rec.id)); } catch { /* already gone */ } store.fileDelete(F().data, rec.id); }   // [new] T-0064
function cleanName(n) { return String(n || 'file').replace(/[\x00-\x1f\\/:*?"<>|]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file'; }   // [new] T-0064
function fileMeta(r) { return { id: r.id, name: r.name, mime: r.mime, size: r.size, by: r.by, ts: r.ts, room: r.room, msg_id: r.msg_id || undefined, folder: r.folder || null, url: `/api/files/${r.id}` }; }   // [new] T-0064; T-0149: folder
function sweepOrphanFiles() {                                                // [new] T-0064: uploads never attached to a message, older than an hour
  let n = 0; for (const r of store.filesOrphans(F().data, Date.now() - 3600e3)) { unlinkFile(r); n++; } return n;
}
const WRITES_PER_MINUTE = parseInt(process.env.CHAMBER_WRITES_PER_MINUTE, 10) || 60;   // [new] T-0033: per user (or agent) per workspace
const MAX_ROOMS = parseInt(process.env.CHAMBER_MAX_ROOMS, 10) || 50;        // [new] T-0033: named rooms per workspace (DMs not counted)
const writeLimiter = makeLimiter(WRITES_PER_MINUTE);                         // [new] T-0033
const MAX_STREAMS_WS = parseInt(process.env.CHAMBER_MAX_STREAMS_WS, 10) || 300;        // [new] T-0038: live event streams per workspace
const MAX_STREAMS_SESSION = parseInt(process.env.CHAMBER_MAX_STREAMS_SESSION, 10) || 6;   // [new] T-0038: per signed-in session (tabs/devices)
function dmKey(a, b) { return 'dm:' + [a, b].map(x => x.toLowerCase()).sort().join(':'); }
function canSeeRoom(data, key, who) {
  const r = Object.hasOwn(data.rooms, String(key)) ? data.rooms[key] : undefined;   // own entries only: 'constructor' or '__proto__' is not a room
  const members = r && Array.isArray(r.dm) ? r.dm : null;
  if (!r) return !String(key).startsWith('dm:');                             // unknown non-DM key: harmless (empty)
  return !members || (!!who && members.some(m => m.toLowerCase() === who.toLowerCase()));
}
function visibleRooms(data, who) { return Object.fromEntries(Object.entries(data.rooms).filter(([k]) => canSeeRoom(data, k, who))); }
function mentionsIn(text, users) {
  const byLower = new Map(Object.keys(users).map(u => [u.toLowerCase(), u]));
  const out = [];
  for (const m of String(text).matchAll(/(^|[^\w])@([A-Za-z0-9_-]{2,24})/g)) {
    const real = byLower.get(m[2].toLowerCase());
    if (real && !out.includes(real)) out.push(real);
  }
  return out;
}

// Chat store (T-0017): SQLite beside the old chamber.json path, one database per workspace. store.js imports an
// existing chamber.json once. Handlers keep the familiar { users, rooms, messages } shape.
function loadData() {                     // T-0076: light load — users + rooms only, no message history (the hot-route default)
  return store.loadLight(F().data);
}
function loadDataFull() {                 // T-0076: full load incl. the last 1000 messages; only Export and the activity digest need it
  return store.load(F().data);
}
function importWorkspace(exp) {           // T-0079 / T-0102: write an export's chat + file METADATA into the workspace db in ONE transaction (ids preserved, atomic)
  const file = F().data;
  const r = store.importWorkspaceData(file, exp.chat || {}, exp.files || []);
  return { users: r.users, rooms: r.rooms, messages: r.messages, fileRefs: r.fileRefs };   // fileRefs: metadata rows only; blob bytes are not carried by the JSON export
}

function saveData(data) {
  store.save(F().data, data);                                               // [changed] T-0017: upsert users/rooms, insert new messages
}
function saveDataLegacyJson(data) {                                           // kept for reference; no longer called
  if (data.messages.length > MAX_MESSAGES) {
    data.messages = data.messages.slice(-MAX_MESSAGES);
  }
  // Atomic write — temp file, fsync, rename — so a crash or power loss mid-    [changed] was a plain fs.writeFileSync that
  // write can't truncate/corrupt the chat store. Mirrors saveReviews().      could leave chamber.json half-written.
  const file = F().data;                                                    // [changed] per workspace
  fs.mkdirSync(path.dirname(file), { recursive: true });                    // ensure dir exists (new workspace)
  const tmp = file + '.tmp.' + process.pid;                            // [new] unique temp beside the target
  const fd = fs.openSync(tmp, 'w');                                         // [new]
  try {                                                                      // [new]
    fs.writeSync(fd, JSON.stringify(data, null, 2));                        // [new] write full payload to temp
    fs.fsyncSync(fd);                                                       // [new] flush to disk before rename
  } finally {                                                                // [new]
    fs.closeSync(fd);                                                       // [new]
  }                                                                          // [new]
  fs.renameSync(tmp, file);                                                 // atomic swap into place
}

function parseBody(req, sess) {                                             // [changed] sess: pin username/by to the signed-in user
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');                                                  // decode as one stream: a character split across two network chunks used to arrive as two broken ones
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => {
      try {
        const b = JSON.parse(body);
        if (accounts.enabled && sess && b && typeof b === 'object') {     // [new] T-0002: nobody can post or act as someone else
          if ('username' in b) b.username = sess.username;
          if ('by' in b) b.by = sess.username;
        }
        resolve(b);
      } catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  // Same-origin app: no wildcard CORS. Cross-origin API clients use a Bearer   [changed] dropped Access-Control-Allow-Origin:*
  // token, which isn't subject to browser CORS — so removing this closes the    so a third-party page can't script the
  // "any website can script the API" hole without breaking real clients.        authenticated API in a victim's browser.
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function serveStatic(res, filePath, req) {                                      // [changed] T-0076: req lets a conditional GET get a 304
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/manifest+json', '.png': 'image/png', '.ico': 'image/x-icon', '.py': 'text/x-python; charset=utf-8', '.md': 'text/markdown; charset=utf-8' };   // [changed] T-0053
  try {
    const content = fs.readFileSync(filePath, (ext === '.png' || ext === '.ico') ? null : 'utf8');
    const extra = filePath.endsWith('sw.js') ? { 'Service-Worker-Allowed': '/' } : {};                 // [new] T-0013
    // T-0076: a content-hash ETag so a phone that already holds this exact file gets a tiny 304 instead of the whole
    // asset (index.html is ~220 KB). Cache-Control stays no-cache: the browser still revalidates each load, so a deploy
    // that changes the bytes changes the ETag and ships at once. nginx may weaken the tag to W/"..." when it gzips, so
    // the If-None-Match compare strips a leading W/ and tolerates a comma-separated list.
    const etag = '"' + crypto.createHash('sha1').update(content).digest('base64').slice(0, 24) + '"';
    const inm = req && req.headers && req.headers['if-none-match'];
    if (inm && String(inm).split(',').some(t => t.trim().replace(/^W\//, '') === etag)) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache', ...extra });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain', 'Cache-Control': 'no-cache', 'ETag': etag, ...extra });  // [changed] browsers re-check after each deploy
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

// What accounts.js needs from this file (sessions, data store, helpers). [new]
// [new] T-0116: a repeated submit (slow network, impatient Enter, phone retry) must not clone a ticket.
// Same author + same title inside the window returns the FIRST result instead of filing another.
const recentProposes = new Map();                                            // "by|title" -> { at, message }
const PROPOSE_DEDUPE_MS = 30000;
function proposeDedupeHit(by, title) {
  const k = String(by).toLowerCase() + '|' + String(title).trim().toLowerCase();
  const prior = recentProposes.get(k);
  if (prior && Date.now() - prior.at < PROPOSE_DEDUPE_MS) return prior;
  return null;
}
function proposeDedupeRemember(by, title, message) {
  const k = String(by).toLowerCase() + '|' + String(title).trim().toLowerCase();
  recentProposes.set(k, { at: Date.now(), message });
  if (recentProposes.size > 200) for (const [kk, vv] of recentProposes) if (Date.now() - vv.at > PROPOSE_DEDUPE_MS) recentProposes.delete(kk);
}
// [new] T-0121 Phase A: relayed terminal. The owner queues a command for one of THEIR connectors;
// the connector collects it over its existing outbound poll, runs it on ITS OWN machine inside the
// bounds its operator configured, and posts the result back. Chamber never connects inward, never
// holds a shell, and never executes any of this itself.
//
// Keys are workspace-scoped ("<ws>:<id>") so a connector can only ever be handed work from its own
// workspace. Jobs are deliberately in-memory and short-lived: a relayed command is ephemeral, and a
// restart losing a queued command is far safer than one persisting and running later out of context.
const shellJobs = new Map();
const SHELL_TTL_MS = 10 * 60 * 1000;          // a command nobody collected is dead after 10 minutes
const SHELL_MAX_PER_WS = 50;
const SHELL_OUT_CAP = 256 * 1024;
function shellKey(ws, id) { return `${ws}:${id}`; }
function shellSweep() {
  const now = Date.now();
  for (const [k, j] of shellJobs) if (now - (j.doneAt || j.at) > SHELL_TTL_MS) shellJobs.delete(k);
}
const consoleCwd = new Map();                                               // T-0101: per-owner working directory for the Terminal console
const ACCOUNTS_CTX = { verifyAudit, sessions, createSession, getSession, json, parseBody, loadData, loadDataFull, importWorkspace, saveData, loginThrottled, serveStatic, withWorkspace,
  cookieSecure: COOKIE_SECURE, sessionTtl: SESSION_TTL, appHtml: path.join(__dirname, 'public', 'index.html'), get version() { return VERSION; }, audit, auditAll,
  listFiles: () => store.filesList(F().data, null, 10000).map(fileMeta) };   // [changed] T-0036: version; T-0057: audit; T-0064: files in the export
accounts.check();                                                           // [new] refuse to start half-configured

function requestFailed(req, res, e) {                                         // [new] T-0025: one place for 'handler blew up'
  console.error(`[request] ${req.method} ${safePath(req)} failed rid=${req.rid || '-'}:`, e?.stack || e);   // [changed] T-0030: the id ties this to the access line
  try { if (!res.headersSent) json(res, 500, { error: 'internal', request_id: req.rid }); else res.end(); } catch { /* socket gone */ }
}
// ── Request log (T-0030) ───────────────────────────────────────────────────────────────────────────────
// One line per request on stdout (journald): method, path, status, ms, user, workspace, client ip, request id.
// The id is also sent back as X-Request-Id and inside 5xx JSON, so a user's screenshot leads straight to the
// matching log lines. Chatty endpoints (event stream, health, presence pings) are logged only when they fail.
// Secrets never reach the log: query strings are dropped and reset / invite tokens in the path are masked.
const QUIET_PATHS = new Set(['/api/events', '/api/health', '/api/ping', '/api/presence', '/api/messages', '/api/activity']);
function safePath(req) { return (req.url || '').split('?')[0].replace(/^(\/reset|\/join)\/.+$/, '$1/***'); }
function clientIp(req) {                                                      // behind nginx: the LAST X-Forwarded-For hop is the one nginx appended; earlier ones are client-supplied
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : (req.socket.remoteAddress || '?');
}
const server = http.createServer((req, res) => {                            // [changed] resolve session + workspace, then handle inside that scope
  const t0 = Date.now(); req.rid = crypto.randomBytes(6).toString('hex'); res.setHeader('X-Request-Id', req.rid);   // [new] T-0030
  res.on('finish', () => {
    const p = safePath(req);
    if (QUIET_PATHS.has(p) && (req.method === 'GET' || p === '/api/ping') && res.statusCode < 400) return;
    console.log(`req ${req.method} ${p} ${res.statusCode} ${Date.now() - t0}ms user=${req.sess?.username || '-'} ws=${req.ws || '-'} ip=${clientIp(req)} rid=${req.rid}`);
  });
  if (shuttingDown) res.setHeader('Connection', 'close');                    // [new] T-0025: drain keep-alive clients during restart
  try {
    const sess = getSession(req);
    const ws = accounts.enabled ? accounts.workspaceOf(sess) : null;
    req.sess = sess; req.ws = ws;                                             // [new] T-0030: for the access line
    return withWorkspace(ws, () => handleRequest(req, res, sess).catch(e => requestFailed(req, res, e)), { rid: req.rid, ip: clientIp(req) });
  } catch (e) { requestFailed(req, res, e); }                                // [new] T-0025: sync throw in setup
});

// ── Crash resilience + graceful shutdown (T-0025) ──────────────────────────────────────────────────────
// SIGTERM (deploy, systemctl restart) and a fatal error both go through shutdown(): save sessions, tell every live
// event stream to reconnect, stop accepting, let in-flight requests finish (5s cap), then exit. Exit 0 on a
// requested stop, 1 on a crash so systemd (Restart=always) brings a clean process back. An unhandled promise
// rejection is logged and the process keeps serving: it is almost always one request's problem, not the server's.
let shuttingDown = false;
function shutdown(code, why) {
  if (shuttingDown) return; shuttingDown = true;
  const streams = [...subscribers.values()].reduce((n, s) => n + s.size, 0);
  console.log(`[shutdown] ${why}: draining (${streams} live event stream${streams === 1 ? '' : 's'})`);
  try { persistSessions(); } catch (e) { console.error('[shutdown] sessions:', e.message); }
  for (const set of subscribers.values()) for (const r of set) { try { r.write('event: shutdown\ndata: {"reason":"restart"}\n\n'); r.end(); } catch { /* gone */ } }
  subscribers.clear();
  server.close(() => { console.log('[shutdown] done'); process.exit(code); });
  try { server.closeIdleConnections(); } catch { /* older node */ }
  setTimeout(() => { console.log('[shutdown] drain timeout, forcing exit'); try { server.closeAllConnections(); } catch {} process.exit(code); }, 5000).unref();
}
// ── Hourly maintenance (T-0037) ──────────────────────────────────────────────────────────────────────────
// Expired sessions out of memory, SQLite WAL files checkpointed, idle database handles closed, and message
// retention applied for workspaces whose owner set it. Cheap, logged in one line, never touches anything else.
function maintenance() {
  const t0 = Date.now(); let sessionsPruned = 0;
  for (const [t, s] of sessions) if (s.expires < t0) { sessions.delete(t); sessionsPruned++; }
  const retained = [];
  for (const { id, days } of accounts.retentionSettings()) {
    try { const n = withWorkspace(id, () => store.retention(F().data, days, rows => rows.forEach(unlinkFile))); if (n) retained.push(`${id}:${n}`); } catch (e) { console.error('[maintenance] retention', id, e.message); }
  }
  let orphans = 0;                                                            // T-0064: uploads that were never sent
  try {
    const wss = accounts.enabled ? (fs.existsSync(WS_ROOT) ? fs.readdirSync(WS_ROOT).filter(d => fs.existsSync(path.join(WS_ROOT, d, 'chamber.db'))) : []) : [null];
    for (const id of wss) orphans += withWorkspace(id, () => { try { return sweepOrphanFiles(); } catch (e) { console.error('[maintenance] files', id, e.message); return 0; } });
  } catch (e) { console.error('[maintenance] files', e.message); }
  let trial = { reminded: [], removed: [] };                                  // T-0175/T-0176: trial reminder emails, unconfirmed sign-ups cleaned up
  try { if (accounts.enabled) trial = accounts.trialHousekeeping(ACCOUNTS_CTX); } catch (e) { console.error('[maintenance] trial', e.message); }
  if (trial.reminded.length || trial.removed.length) console.log(`[maintenance] trial reminders=${trial.reminded.length} unconfirmed removed=${trial.removed.length}`);
  const st = store.maintenance();
  console.log(`[maintenance] sessions pruned=${sessionsPruned} wal checkpointed=${st.checkpointed} db closed=${st.closed} retention=${retained.join(',') || '-'} orphan files=${orphans} ${Date.now() - t0}ms`);
  return { sessionsPruned, ...st, retained, orphanFiles: orphans };
}
setTimeout(maintenance, 60e3).unref(); setInterval(maintenance, 3600e3).unref();
process.on('SIGTERM', () => shutdown(0, 'SIGTERM'));
process.on('SIGINT', () => shutdown(0, 'SIGINT'));
process.on('uncaughtException', e => { console.error('[fatal] uncaught exception:', e?.stack || e); shutdown(1, 'uncaught exception'); });
process.on('unhandledRejection', e => { console.error('[warn] unhandled rejection (server keeps running):', e?.stack || e); });

// ── Agent memory (T-0059) ──────────────────────────────────────────────────────────────────────────────
// memory.json per workspace: { "<agent>": [ { id, scope: '<room>' | '*', text, by, at } ] }. Members may read; the workspace
// owner/admins, the agent's commanders, and the agent itself (for its own notes) may add or delete. Connectors load the
// notes for their agent + room into every prompt as context. Everything is audited.
const MEMORY_MAX_NOTES = 50, MEMORY_MAX_CHARS = 500;
function memoryFile() { return path.join(path.dirname(F().data), 'memory.json'); }
function diffDir() { return path.join(path.dirname(F().data), 'diffs'); }
const MAX_DIFF_VERSIONS = 10;                                                  // T-0189: versions of one ticket's change that are kept                                  // T-0063
// T-0136: phone-AI settings live in their own small file. They used to ride on loadData()/saveData(), but the SQLite
// store only persists users/rooms/messages, so a Save answered 200 and the settings were silently dropped.
// ── Chat archives (T-0112) ─────────────────────────────────────────────────────────────────────────────
// An owner/admin moves a room's messages older than a date into a sealed archive file, which frees the live chat
// and keeps the history readable (read-only) later. Seal = gzip, then AES-256-GCM with a per-workspace key derived
// (HKDF) from a server master key that lives OUTSIDE the workspace folder. GCM's tag means a changed byte fails to
// open; the SHA-256 of the plaintext is kept in the index AND written to the append-only audit log, so a swapped
// archive (or a doctored index) does not match either. The live rows are deleted only after the file was written,
// read back, opened and checked. Nothing here ever deletes an archive.
const ARCHIVE_MAGIC = Buffer.from('CHARC1');
const ARCHIVE_MAX = 20000;                                                    // messages per archive; run again for more
function archiveMasterKey() {
  const f = path.join(path.dirname(DATA_FILE), 'archive-master.key');
  try { const k = fs.readFileSync(f); if (k.length === 32) return k; } catch { /* first use */ }
  const k = crypto.randomBytes(32); fs.mkdirSync(path.dirname(f), { recursive: true });
  try { fs.writeFileSync(f, k, { mode: 0o600, flag: 'wx' }); return k; } catch { return fs.readFileSync(f); }   // a racing request may have made it first
}
function archiveWsKey() { return Buffer.from(crypto.hkdfSync('sha256', archiveMasterKey(), Buffer.from(path.basename(path.dirname(F().data))), Buffer.from('chamber-archive-v1'), 32)); }
function archivesDir() { return path.join(path.dirname(F().data), 'archives'); }
function archiveIndexFile() { return path.join(archivesDir(), 'index.json'); }
function loadArchiveIndex() { try { const a = JSON.parse(fs.readFileSync(archiveIndexFile(), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } }
function saveArchiveIndex(list) { const f = archiveIndexFile(); fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(list), { mode: 0o600 }); fs.renameSync(tmp, f); }
function archiveAad(meta) { return Buffer.from(`${meta.id}|${meta.room}|${meta.count}|${meta.sha256}`); }
function sealArchive(meta, plain) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', archiveWsKey(), iv); c.setAAD(archiveAad(meta));
  const body = Buffer.concat([c.update(zlib.gzipSync(plain, { level: 9 })), c.final()]);
  return Buffer.concat([ARCHIVE_MAGIC, iv, c.getAuthTag(), body]);
}
function openArchive(meta) {                                                  // -> { rows } or throws 'tampered'
  const buf = fs.readFileSync(path.join(archivesDir(), meta.id + '.arc'));
  if (!buf.subarray(0, 6).equals(ARCHIVE_MAGIC)) throw new Error('tampered');
  const d = crypto.createDecipheriv('aes-256-gcm', archiveWsKey(), buf.subarray(6, 18)); d.setAAD(archiveAad(meta)); d.setAuthTag(buf.subarray(18, 34));
  let plain; try { plain = zlib.gunzipSync(Buffer.concat([d.update(buf.subarray(34)), d.final()])); } catch { throw new Error('tampered'); }
  if (crypto.createHash('sha256').update(plain).digest('hex') !== meta.sha256) throw new Error('tampered');
  const j = JSON.parse(plain.toString('utf8'));
  if (j.room !== meta.room || !Array.isArray(j.rows) || j.rows.length !== meta.count) throw new Error('tampered');
  return j;
}
function archiveMeta(a) { return { id: a.id, room: a.room, from: a.from, to: a.to, count: a.count, bytes: a.bytes, plain_bytes: a.plain_bytes, sha256: a.sha256, by: a.by, ts: a.ts }; }
function mayArchive(sess) {
  if (!sess?.username || sess.agent) return false;
  if (!accounts.enabled) return true;
  const role = accounts.sessionRole(sess); return role === 'owner' || role === 'admin';
}
function parseCutoff(v) {                                                     // 'YYYY-MM-DD' (start of that day, UTC) or epoch ms
  if (typeof v === 'number' && isFinite(v)) return Math.floor(v);
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) { const t = Date.parse(s + 'T00:00:00Z'); return isNaN(t) ? null : t; }
  if (/^\d{10,14}$/.test(s)) return parseInt(s, 10);
  return null;
}
function createArchive(sess, room, cutoff) {
  const rows = store.archivePick(F().data, room, cutoff, ARCHIVE_MAX);
  if (!rows.length) return { error: 'nothing to archive: no messages in that room before that date', status: 404 };
  const id = 'A' + Date.now().toString(36) + crypto.randomBytes(4).toString('hex');
  const plain = Buffer.from(JSON.stringify({ v: 1, room, cutoff, rows }), 'utf8');
  const meta = { id, room, from: rows[0].ts, to: rows[rows.length - 1].ts, count: rows.length, plain_bytes: plain.length,
                 sha256: crypto.createHash('sha256').update(plain).digest('hex'), by: sess.username, ts: Date.now() };
  const sealed = sealArchive(meta, plain); meta.bytes = sealed.length;
  const dir = archivesDir(); fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = path.join(dir, id + '.arc'), tmp = f + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w', 0o600); try { fs.writeSync(fd, sealed); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, f);
  try { openArchive(meta); } catch (e) { try { fs.unlinkSync(f); } catch {} return { error: 'the archive did not verify after writing, so nothing was removed', status: 500 }; }
  const list = loadArchiveIndex(); list.push(meta); saveArchiveIndex(list);
  const removed = store.archiveRemove(F().data, rows.map(r => r.id));
  audit(sess, { action: 'archive-create', archive: id, room, messages: meta.count, removed, sha256: meta.sha256, from: meta.from, to: meta.to }, true);
  notify('messages', { room, from: sess.username, archived: { id, count: removed } });
  return { archive: archiveMeta(meta), removed, more: rows.length >= ARCHIVE_MAX || undefined };
}

function askConfigFile() { return path.join(path.dirname(F().data), 'ask-config.json'); }
function loadAskConfig() { try { const c = JSON.parse(fs.readFileSync(askConfigFile(), 'utf8')); return c && typeof c === 'object' ? c : {}; } catch { return {}; } }
function saveAskConfig(cfg) { const f = askConfigFile(); fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(cfg), { mode: 0o600 }); fs.renameSync(tmp, f); }
function loadMemory() { try { return JSON.parse(fs.readFileSync(memoryFile(), 'utf8')); } catch { return {}; } }
function saveMemory(mem) { const f = memoryFile(); fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(mem), { mode: 0o600 }); fs.renameSync(tmp, f); }
function mayEditMemory(sess, agent) {
  if (!sess?.username) return false;
  if (sess.agent) return sess.username.toLowerCase() === String(agent).toLowerCase();
  if (!accounts.enabled) return true;
  const role = accounts.sessionRole(sess);
  if (role === 'owner' || role === 'admin') return true;
  return (accounts.commandersFor(reqScope.getStore()?.ws) || []).some(u => u.toLowerCase() === sess.username.toLowerCase());
}
// T-0058: one place that creates a message (handler, schedules, webhooks). Caller has checked room visibility for the author.
function postMessage(data, { username, text, room, type, reply_to, source, attachments, run }) {
  const msg = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    username, text: String(text || '').slice(0, MAX_TEXT), room: room || 'general', ts: Date.now(), type: type || 'message',
    mentions: mentionsIn(String(text || ''), data.users),
  };
  if (source) msg.source = source;                                                             // 'schedule:<id>' | 'webhook:<id>'
  if (Array.isArray(attachments) && attachments.length) msg.attachments = attachments.map(a => ({ id: a.id, name: a.name, mime: a.mime, size: a.size }));   // T-0064
  if (run) msg.run = run;                                                                        // T-0071: already cleaned by the handler
  if (reply_to) {
    const parent = store.get(F().data, String(reply_to));
    if (!parent || parent.room !== msg.room) return { error: 'reply_to must be the id of a message in the same room' };
    msg.reply_to = parent.id;
  }
  data.messages.push(msg);
  if (data.users[username]) data.users[username].lastSeen = Date.now();
  saveData(data);
  if (msg.attachments) store.filesAttach(F().data, msg.attachments.map(a => a.id), msg.room, msg.id);   // T-0064: the uploads now belong to this message
  notify('messages', { room: msg.room, from: msg.username, mentions: msg.mentions, reply_to: msg.reply_to, marker: /^load (lt-\S+)/.test(msg.text) ? msg.text.match(/^load (lt-\S+)/)[1] : undefined });
  if (accounts.enabled) {
    const dmOther = Array.isArray(data.rooms[msg.room]?.dm) ? data.rooms[msg.room].dm.filter(u => u !== msg.username) : [];
    if (!(msg.type === 'status' && msg.run)) accounts.pushTo(reqScope.getStore()?.ws, { room: msg.room, mentions: msg.mentions || [], dm: dmOther }, msg.username);   // [changed] T-0078: per-room level + quiet hours. An agent's progress line is not news: the phone is told when it becomes the answer (the edit route)
    mirrorOut(reqScope.getStore()?.ws, msg);                                                   // [new] T-0062
  }
  return { message: msg };
}
// T-0062: forward a room's messages to Slack / Discord / a JSON endpoint. Fire-and-forget, 5 s timeout, never for messages
// that themselves came in through a webhook or another mirror (loop protection), never for status lines.
const https = require('https');
function mirrorOut(wsId, msg) {
  if (!wsId || msg.type !== 'message' || (msg.source && !msg.source.startsWith('schedule:'))) return;
  for (const mr of accounts.mirrorsFor(wsId, msg.room)) {
    const text = (msg.text.length > 2000 ? msg.text.slice(0, 1990) + '…' : msg.text) + (msg.attachments ? ` [${msg.attachments.length} file${msg.attachments.length === 1 ? '' : 's'}: ${msg.attachments.map(a => a.name).join(', ')}]` : '');   // T-0064
    const body = mr.kind === 'slack' ? { text: `*${msg.username}* in #${msg.room}: ${text}` }
               : mr.kind === 'discord' ? { content: `**${msg.username}** in #${msg.room}: ${text}`.slice(0, 2000), allowed_mentions: { parse: [] } }
               : { username: msg.username, room: msg.room, text, ts: msg.ts, id: msg.id, reply_to: msg.reply_to || null, source: 'chamber' };
    const payload = JSON.stringify(body);
    try {
      const u = new URL(mr.url);
      const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), 'User-Agent': 'chamber-mirror/1' }, timeout: 5000 }, res => {
        res.resume(); res.on('end', () => accounts.mirrorResult(wsId, mr.id, res.statusCode < 300, `HTTP ${res.statusCode}`));
      });
      req.on('timeout', () => req.destroy(new Error('timeout'))); req.on('error', e => accounts.mirrorResult(wsId, mr.id, false, e.message)); req.end(payload);
    } catch (e) { accounts.mirrorResult(wsId, mr.id, false, e.message); }
  }
}
// T-0058: schedules fire as their creator (a commander), so the agent sees an ordinary request and answers in-thread.
// T-0201: nobody waits silently for an approval. On the schedule tick, every workspace with reminders switched on gets, per proposed
// ticket, at most ONE reminder (after remindMin) and ONE message to the backup approver (after escalateMin). Tickets due at the same
// time for the same people go out together as one message, so switching this on in a busy workspace is not a flood. Posted in the
// ticket's room by "chamber-reminder", an ai identity (so agents ignore it); the mentions push through each person's own quiet hours.
// What was sent is kept in approval-reminders.json in the workspace, and forgotten once the ticket moves on.
const REMINDER_BOT = 'chamber-reminder';
function ticketRoomOf(t) { return ((String(t.body || '').match(/ in #([\w-]{1,40})\.\s*$/) || [])[1]) || 'general'; }
function waitedText(ms) { return ms < 5400e3 ? `${Math.max(1, Math.round(ms / 6e4))} minutes` : ms < 1.5 * 864e5 ? `${Math.round(ms / 36e5)} hours` : `${Math.round(ms / 864e5)} days`; }
function approvalReminders(now = new Date()) {
  if (!accounts.enabled) return [];
  const sent = [];
  for (const { ws, cfg } of accounts.reminderWorkspaces()) {
    withWorkspace(ws, () => {
      const file = path.join(path.dirname(F().data), 'approval-reminders.json');
      let done = {}; try { done = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* nothing sent yet */ }
      const waiting = (loadTickets().tickets || []).filter(t => t.status === 'proposed' && !t.changes);
      const open = new Set(waiting.map(t => t.id)); let dirty = false;
      for (const id of Object.keys(done)) if (!open.has(id)) { delete done[id]; dirty = true; }
      const data = loadData(), groups = new Map();
      if (Object.hasOwn(data.users, REMINDER_BOT) && data.users[REMINDER_BOT].role !== 'ai') return;   // a person has that name: say nothing rather than speak as them
      for (const t of waiting) {
        const waited = now.getTime() - Date.parse(t.proposed_at || ''), d = done[t.id] || {};
        if (!isFinite(waited)) continue;
        let stage = null, to = [];
        if (cfg.remindMin && !d.reminded && waited >= cfg.remindMin * 6e4) { stage = 'reminded'; to = accounts.remindTargets(ws, t); }
        else if (cfg.escalateMin && cfg.backup && !d.escalated && waited >= cfg.escalateMin * 6e4) { stage = 'escalated'; to = [cfg.backup]; }
        if (!stage) continue;
        if (!to.length) { d[stage] = now.getTime(); done[t.id] = d; dirty = true; continue; }   // nobody to remind: note it so it is not retried every minute
        const room = data.rooms[ticketRoomOf(t)] ? ticketRoomOf(t) : (data.rooms.general ? 'general' : Object.keys(data.rooms)[0]);
        if (!room) continue;
        const key = `${stage}|${room}|${to.slice().sort().join(',')}`;
        if (!groups.has(key)) groups.set(key, { stage, room, to, items: [] });
        groups.get(key).items.push({ t, waited });
      }
      for (const g of groups.values()) {
        const list = g.items.slice(0, 10).map(({ t, waited }) => `${t.id} (${waitedText(waited)}): ${String(t.title).slice(0, 100)}`), more = g.items.length > 10 ? `\n…and ${g.items.length - 10} more on the Tickets tab.` : '';
        const text = g.stage === 'reminded'
          ? `${g.to.map(u => '@' + u).join(' ')} ${g.items.length === 1 ? 'This ticket is' : 'These tickets are'} waiting for approval:\n${list.join('\n')}${more}\n(One reminder from the approval rules.)`
          : `@${g.to[0]} Nobody has decided on ${g.items.length === 1 ? 'this ticket' : 'these tickets'} yet, and you are the backup approver:\n${list.join('\n')}${more}`;
        if (!Object.hasOwn(data.users, REMINDER_BOT)) data.users[REMINDER_BOT] = { username: REMINDER_BOT, role: 'ai', lastSeen: now.getTime() };
        const made = postMessage(data, { username: REMINDER_BOT, text, room: g.room, source: 'reminder' });
        if (!made.message) continue;
        for (const { t } of g.items) { done[t.id] = { ...(done[t.id] || {}), [g.stage]: now.getTime() }; sent.push({ ws, ticket: t.id, stage: g.stage, to: g.to }); }
        dirty = true;
      }
      if (dirty) { const tmp = file + '.tmp.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(done), { mode: 0o600 }); fs.renameSync(tmp, file); }
    }, { rid: 'remind' });
  }
  if (sent.length) console.log(`[remind] ${sent.length} ticket(s): ${sent.map(s => s.ticket + ' ' + s.stage).join(', ')}`);
  return sent;
}
// T-0202: the weekly report. Measured facts only: what was done, how long each took, how long approvals waited, who approved, what the
// AI cost, what waits now. Never chat, code or estimates of "time saved". Weeks run Monday to Sunday in UTC.
const mail = require('./mail');
function weekStartOf(d) { const x = new Date(d); x.setUTCHours(0, 0, 0, 0); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; }
const escH = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function weeklyReport(wsName, from, to, linkBase) {                            // call inside withWorkspace
  const tickets = loadTickets().tickets || [], at = s => Date.parse(s || ''), inWeek = s => { const t = at(s); return t >= from.getTime() && t < to.getTime(); };
  const done = tickets.filter(t => t.status === 'done' && inWeek(t.closed_at)).sort((a, b) => at(a.closed_at) - at(b.closed_at));
  const approved = tickets.filter(t => inWeek(t.approved_at)), waits = approved.map(t => at(t.approved_at) - at(t.proposed_at)).filter(x => x >= 0);
  const avgWait = waits.length ? waits.reduce((a, b) => a + b, 0) / waits.length : null;
  const rejected = tickets.filter(t => t.status === 'rejected' && inWeek(t.rejected_at)), waiting = tickets.filter(t => t.status === 'proposed').sort((a, b) => at(a.proposed_at) - at(b.proposed_at)), working = tickets.filter(t => t.status === 'in_progress');
  const requests = tickets.filter(t => /^\[request\]/i.test(t.title || '') && inWeek(t.proposed_at)).length;
  let cents = 0, answers = 0, noCost = 0;
  for (const m of store.runsSince(F().data, from.getTime())) { if (m.ts >= to.getTime() || !m.run || m.run.state === 'running') continue; answers++; if (typeof m.run.cost_cents === 'number' && isFinite(m.run.cost_cents)) cents += m.run.cost_cents; else noCost++; }
  const result = t => { const c = (t.updates || []).filter(u => /^CLOSED\b/.test(u.note || '')).pop(); return c ? String(c.note).replace(/^CLOSED:?\s*/, '').split('\n')[0].slice(0, 240) : ''; };
  const who = t => [...new Set((Array.isArray(t.approvals) && t.approvals.length ? t.approvals.map(a => a.by) : [t.approved_by]).filter(Boolean))].join(' and ') || 'nobody recorded';
  const day = s => new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }), last = new Date(to.getTime() - 864e5);
  const span = `${day(from)} to ${last.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`;
  const money = c => '$' + (c / 100).toFixed(2);
  const summary = `${done.length} ticket${done.length === 1 ? '' : 's'} done, ${approved.length} approved${avgWait !== null ? ` (approval waited ${waitedText(avgWait)} on average)` : ''}, ${rejected.length} turned down, ${waiting.length} waiting for approval now, ${working.length} being worked on. AI: ${answers} answer${answers === 1 ? '' : 's'}, ${money(cents)}${noCost ? ` (${noCost} without a reported cost)` : ''}.${requests ? ` ${requests} request${requests === 1 ? '' : 's'} came in from clients or managers.` : ''}`;
  const doneLines = done.map(t => `${t.id} ${t.title}: requested ${day(t.proposed_at)}, done ${day(t.closed_at)} (${waitedText(at(t.closed_at) - at(t.proposed_at))}), approved by ${who(t)}.${result(t) ? ' ' + result(t) : ''}`);
  const waitLines = waiting.slice(0, 15).map(t => `${t.id} ${t.title}: waiting ${waitedText(Date.now() - at(t.proposed_at))}`), workLines = working.slice(0, 15).map(t => `${t.id} ${t.title}${t.assignee ? ` (${t.assignee})` : ''}`);
  const text = `Weekly report for ${wsName}, ${span}\n\nIn short: ${summary}\n\nDone:\n${doneLines.length ? doneLines.map(l => '- ' + l).join('\n') : '- nothing closed this week'}\n\nWaiting for approval now:\n${waitLines.length ? waitLines.map(l => '- ' + l).join('\n') : '- nothing'}\n\nBeing worked on:\n${workLines.length ? workLines.map(l => '- ' + l).join('\n') : '- nothing'}\n\n`
    + (linkBase ? `The same report as a page you can print: ${linkBase}\n\n` : '') + 'Only measured facts: no estimates of time saved. AI cost is as the AI tools report it (with a Claude subscription, the API-price equivalent).\nMade with Chamber, https://chamber.ghostporttechnologies.com\n';
  const prev = new Date(from.getTime() - 7 * 864e5).toISOString().slice(0, 10), next = new Date(from.getTime() + 7 * 864e5);
  const row = t => `<tr><td>${escH(t.id)}</td><td>${escH(t.title)}${result(t) ? `<div class="r">${escH(result(t))}</div>` : ''}</td><td>${escH(day(t.proposed_at))}</td><td>${escH(day(t.closed_at))}<div class="r">${escH(waitedText(at(t.closed_at) - at(t.proposed_at)))}</div></td><td>${escH(who(t))}</td></tr>`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Weekly report · ${escH(wsName)} · ${escH(span)}</title>
<style>body{margin:0;background:#fff;color:#1b1f1d;font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:860px;margin:0 auto;padding:28px 18px 48px}h1{font-size:22px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;border-bottom:1px solid #d9dfdb;padding-bottom:4px}.dim,.r{color:#5b665f;font-size:13px}.box{background:#f3f6f4;border:1px solid #d9dfdb;border-radius:8px;padding:12px 14px}table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;vertical-align:top;padding:7px 6px;border-bottom:1px solid #e6ebe8}th{font-size:12px;color:#5b665f;font-weight:600}td:first-child{white-space:nowrap;font-weight:600}ul{padding-left:20px}nav{font-size:13px;margin:6px 0 0}nav a{color:#0b6b43}@media print{nav{display:none}}@media(max-width:600px){table,tbody,tr,td{display:block}thead{display:none}tr{padding:8px 0;border-bottom:1px solid #e6ebe8}td{border:0;padding:2px 0}}</style></head>
<body><main><h1>Weekly report: ${escH(wsName)}</h1><div class="dim">${escH(span)} (weeks run Monday to Sunday, UTC)</div>
<nav><a href="?week=${prev}">Previous week</a>${next.getTime() <= Date.now() ? ` · <a href="?week=${next.toISOString().slice(0, 10)}">Next week</a>` : ''} · <a href="?week=this">This week so far</a> · <span style="color:#5b665f">print it from your browser</span></nav>
<h2>In short</h2><div class="box">${escH(summary)}</div>
<h2>Done this week</h2>${done.length ? `<table><thead><tr><th>Ticket</th><th>What, and the result</th><th>Asked</th><th>Done, and how long it took</th><th>Approved by</th></tr></thead><tbody>${done.map(row).join('')}</tbody></table>` : '<p class="dim">Nothing was closed this week.</p>'}
<h2>Waiting for approval now</h2>${waitLines.length ? `<ul>${waitLines.map(l => `<li>${escH(l)}</li>`).join('')}</ul>` : '<p class="dim">Nothing is waiting.</p>'}
<h2>Being worked on now</h2>${workLines.length ? `<ul>${workLines.map(l => `<li>${escH(l)}</li>`).join('')}</ul>` : '<p class="dim">Nothing right now.</p>'}
<p class="dim" style="margin-top:28px">Only measured facts: no estimates of time saved. AI cost is as the AI tools report it; with a Claude subscription it is the API-price equivalent, not what is billed. This page is private to whoever has its link, and shows no chat and no code.<br>Made with <a href="https://chamber.ghostporttechnologies.com" style="color:#0b6b43">Chamber</a>.</p></main></body></html>`;
  return { text, html, done: done.length, subject: `Weekly report for ${wsName}: ${done.length} done, ${waiting.length} waiting (${span})` };
}
function weeklyReportMail(now = new Date()) {                                   // Mondays from 08:00 UTC: last week's report to whoever the owner listed, once
  if (!accounts.enabled || now.getUTCDay() !== 1 || now.getUTCHours() < 8) return [];
  const to = weekStartOf(now), from = new Date(to.getTime() - 7 * 864e5), week = from.toISOString().slice(0, 10), sent = [];
  for (const w of accounts.reportWorkspaces()) {
    withWorkspace(w.ws, () => {
      const file = path.join(path.dirname(F().data), 'report-sent.json'); let st = {}; try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* never sent */ }
      if (st.week === week) return;
      const r = weeklyReport(w.name, from, to, w.linkUrl ? `${w.linkUrl}?week=${week}` : null);
      for (const addr of w.recipients) {                                       // T-0217: each address gets its own link that stops the report
        const stop = (w.stop || {})[addr], text = r.text + (stop ? `\nTo stop getting this report: ${stop}\n` : '');
        if (TEST_HOOKS) console.log(`[report] mail to ${addr}: ${r.subject}${stop ? ' | stop ' + stop : ''}`);
        if (mail.enabled) mail.send({ to: addr, subject: r.subject, text }).catch(e => console.error('[report] mail failed:', e.message));
      }
      const tmp = file + '.tmp.' + process.pid; fs.writeFileSync(tmp, JSON.stringify({ week, at: now.getTime(), to: w.recipients.length }), { mode: 0o600 }); fs.renameSync(tmp, file);
      sent.push({ ws: w.ws, week, to: w.recipients, done: r.done, subject: r.subject });
    }, { rid: 'report' });
  }
  return sent;
}
// T-0203: the AI budget. Spend this month (UTC) = what agents reported with their answers + what the ticket worker reported on tickets
// (usage-log.jsonl). At 80 percent the owner and admins are told, at 100 percent agents finish what they are doing and take no new
// tickets (claims answer 402; connector 3.21 also stops starting new answers). An agent that has reported no cost in the last 90 days
// (a local model) is never blocked: money other agents spent is not a reason to stop it.
function monthStartOf(d) { const x = new Date(d); return new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), 1)); }
// ── T-0200: standing approvals ─────────────────────────────────────────────────────────────────────────────────────────────
// Someone who may approve says once, in advance: "this kind of job, done by this agent, is fine within these limits, until this
// date". A ticket that names one (the app's propose form, a "standing" field, or [standing:S-1] in its title) is approved by the
// server at once, and its record says which standing approval covered it. The server checks every limit it can count: the
// approval rules, the end date, the jobs per week, the agent that claims it, pull-request mode only, and (before anything is
// pushed) the number of files, the folders and the files no standing approval ever covers. Whether a job really is the kind
// described stays with the person who reviews and merges the pull request. Kept per workspace in standing.json next to the tickets.
const STANDING_MAX_ACTIVE = 20, STANDING_MAX_DAYS = 90, STANDING_KEEP = 200;
const STANDING_NEVER = ['*.key', '*.pub', '*.pem', '*.pfx', '*.p12', 'auth.json', '*tokens*', '*secret*', '*credential*', '*.env', '.env*', '*/.env*', 'backups/*', '*.db', '*.sqlite*',
  '.github/*', '.gitlab-ci.yml', '.circleci/*', 'Jenkinsfile', 'azure-pipelines.yml', '.buildkite/*'];   // the worker's never-touch list, plus build pipelines: a pull request that changes those can run code with the repository's secrets
const STANDING_NEVER_RE = STANDING_NEVER.map(p => new RegExp('^(?:.*/)?' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i'));
function standingPath() { return path.join(path.dirname(F().data), 'standing.json'); }
function loadStanding() {
  try { const d = JSON.parse(fs.readFileSync(standingPath(), 'utf8')); if (d && Array.isArray(d.items)) return { next: Number.isInteger(d.next) ? d.next : d.items.length + 1, items: d.items }; } catch {}
  return { next: 1, items: [] };
}
function saveStanding(d) {                                                   // keeps every live one and the newest ended / withdrawn ones
  const live = d.items.filter(s => ['active', 'waiting'].includes(standingState(s))), old = d.items.filter(s => !live.includes(s));
  d.items = old.slice(-Math.max(0, STANDING_KEEP - live.length)).concat(live).sort((a, b) => parseInt(a.id.slice(2), 10) - parseInt(b.id.slice(2), 10));
  const f = standingPath(), tmp = f + '.tmp'; fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(d, null, 1), { mode: 0o600 }); fs.renameSync(tmp, f);
}
function standingState(s, now = Date.now()) {                                // active | waiting (for a second approver) | withdrawn | ended
  if (s.withdrawn) return 'withdrawn';
  if (now > Date.parse(s.until + 'T23:59:59Z')) return 'ended';
  return s.needsConfirm && !s.confirmedBy ? 'waiting' : 'active';
}
function standingRulesFor(sess) { return accounts.enabled ? accounts.standingRules(accounts.workspaceOf(sess)) : { approvers: null, two: 'none', noSelf: false }; }
function standingLive(s, sess) {                                             // why this standing approval cannot start work right now, or ''
  const lc = x => String(x || '').toLowerCase(), st = standingState(s), rules = standingRulesFor(sess);
  if (st === 'withdrawn') return `standing approval ${s.id} was withdrawn by ${s.withdrawn.by}`;
  if (st === 'ended') return `standing approval ${s.id} ended on ${s.until}`;
  if (st === 'waiting') return `standing approval ${s.id} still waits for a second approver to confirm it`;
  if (rules.two === 'all' && !s.confirmedBy && (rules.approvers || []).length >= 2) return `the approval rules now need two people, so a second approver must confirm ${s.id} first`;
  const may = rules.approvers || Object.entries(loadData().users).filter(([, u]) => u.role === 'human').map(([n]) => n);
  if (!may.some(u => lc(u) === lc(s.by))) return `${s.by}, who set up ${s.id}, may no longer approve here`;
  if (s.confirmedBy && !may.some(u => lc(u) === lc(s.confirmedBy))) return `${s.confirmedBy}, who confirmed ${s.id}, may no longer approve here`;
  return '';
}
function standingUses(s, tickets, now = Date.now()) { return tickets.filter(t => t.standing && t.standing.id === s.id && Date.parse(t.approved_at || t.proposed_at) > now - 7 * 864e5).length; }
function standingTicketFor(t) { return t.for === 'human' || t.for === 'agent' ? t.for : /\[agent\]/i.test(t.title || '') ? 'agent' : /\[human\]/i.test(t.title || '') ? 'human' : null; }
function standingCovers(s, t, sess) {                                        // why this ticket is NOT covered, or ''
  const lc = x => String(x || '').toLowerCase(), live = standingLive(s, sess); if (live) return live;
  const rules = standingRulesFor(sess);
  if (standingTicketFor(t) !== 'agent') return 'it is not a ticket for an agent';
  if (rules.noSelf && [s.by, s.confirmedBy].some(u => u && lc(u) === lc(t.proposed_by))) return `${t.proposed_by} set up or confirmed ${s.id}, and here nobody approves their own ticket`;
  if (rules.two === 'high' && ['high', 'critical'].includes(lc(t.priority))) return 'high and critical tickets need two people each time here';
  const used = standingUses(s, loadTickets().tickets || []);
  if (used >= s.perWeek) return `${s.id} allows ${s.perWeek} job${s.perWeek === 1 ? '' : 's'} a week and ${used} already started in the last 7 days`;
  return '';
}
function standingCited(field, title) {                                       // 'S-1' | null (none named) | false (named, but not a standing approval's id)
  const v = String(field == null ? '' : field).trim() || ((String(title || '').match(/\[standing:\s*(S-\d{1,5})\]/i) || [])[1] || '');
  return !v ? null : /^S-\d{1,5}$/i.test(v) ? v.toUpperCase() : false;
}
async function standingApprove(id, sid, sess) {                               // a new ticket names a standing approval: approve it now, or say on the ticket why not
  const s = loadStanding().items.find(x => x.id === sid), t = (loadTickets().tickets || []).find(x => x.id === id);
  if (!t) return { ok: false, id: sid, why: 'the ticket was not found' };
  const why = !s ? `there is no standing approval ${sid} here` : standingCovers(s, t, sess);
  if (why) {
    await runTicketsCLI(['update', id, '--by', sess.username, '--note', `STANDING APPROVAL ${sid} does not cover this: ${why}. It waits for a person to approve it.`]);
    audit(sess, { action: 'standing-not-covered', ticket: id, standing: sid, reason: why.slice(0, 200) }, true); notify('tickets');
    return { ok: false, id: sid, why };
  }
  const snap = { id: s.id, what: s.what, agent: s.agent, by: s.by, confirmedBy: s.confirmedBy || undefined, paths: s.paths, maxFiles: s.maxFiles, until: s.until };
  const r = await runTicketsCLI(['approve', id, '--by', s.by, '--standing', JSON.stringify(snap)]);
  if (!r.ok) return { ok: false, id: sid, why: r.stderr || 'could not approve it' };
  audit(sess, { action: 'ticket-approve-standing', ticket: id, standing: s.id, set_by: s.by }, true); notify('tickets');
  return { ok: true, id: s.id };
}
function standingBack(id, by, note) { return runTicketsCLI(['unstand', id, '--by', by, '--note', `WAITS FOR A PERSON: ${note}`]); }   // back to proposed: a person approves it by hand, or not
async function standingClaimCheck(t, sess, body) {                           // '' = may claim; else why not. When no agent may do it under the standing approval any more, it goes back to a person.
  const lc = x => String(x || '').toLowerCase(), s = loadStanding().items.find(x => x.id === t.standing.id);
  const dead = !s ? `standing approval ${t.standing.id} no longer exists` : standingLive(s, sess);
  if (dead) {
    await standingBack(t.id, sess.username, `${dead}, before any work started.`);
    audit(sess, { action: 'standing-outside', ticket: t.id, standing: t.standing.id, reason: dead.slice(0, 200) }, true); notify('tickets');
    return `${dead}, so ${t.id} went back to waiting for a person`;
  }
  if (lc(sess.username) !== lc(s.agent)) return `${t.id} was approved in advance by standing approval ${s.id}, which covers jobs done by ${s.agent} only`;
  if (body?.mode !== 'pr') {
    const why = `standing approval ${s.id} allows pull-request mode only (nothing goes live until a person merges it), and ${s.agent} ${body?.mode === 'live' ? 'works in the live folder' : 'did not say it works in pull-request mode (ticket worker 1.8.0 or newer does)'}`;
    await standingBack(t.id, sess.username, why + '.');
    audit(sess, { action: 'standing-outside', ticket: t.id, standing: s.id, reason: why.slice(0, 200) }, true); notify('tickets');
    return `${why}, so ${t.id} went back to waiting for a person`;
  }
  return '';
}

// ── T-0188: the agent asks, a person taps Allow or Deny ──────────────────────────────────────────────────────────────────────
// A chat agent the owner switched this on for (Account, AI agents, "may ask") can ask mid-job to use a tool it was not given
// outright: run one command, change one file. The question appears in the room (Allow once / Deny above the message box) for the
// people who may approve tickets here; no answer in time means no. Each answer covers exactly that one use. Question, answer, who
// gave it and the result all go on the activity record. On the agent's side Claude Code's permission prompt goes to a small
// helper of the connector (--permission-prompt-tool), which holds no key and only talks to the connector.
const ASK_KEEP = 500, ASK_MIN_WAIT = 60, ASK_MAX_WAIT = 1800, ASK_MAX_WAITING = 5, ASK_PER_HOUR = 60;
const ASK_JOB_MS = 30 * 60e3, ASK_JOB_USES = 100;                             // T-0211: "Allow for this job" covers exactly the same thing again, for one job, 30 minutes at most
function asksPath() { return path.join(path.dirname(F().data), 'asks.json'); }
function loadAsks() {
  try { const d = JSON.parse(fs.readFileSync(asksPath(), 'utf8')); if (d && Array.isArray(d.items)) return { next: Number.isInteger(d.next) ? d.next : d.items.length + 1, items: d.items }; } catch {}
  return { next: 1, items: [] };
}
function saveAsks(d) { d.items = d.items.slice(-ASK_KEEP); const f = asksPath(), tmp = f + '.tmp.' + process.pid; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(d), { mode: 0o600 }); fs.renameSync(tmp, f); }
function askIsAgent(sess) { return !!(sess && (sess.agent || sess.role === 'ai')); }
function askMayAsk(sess) {                                                   // the owner's switch for this agent (off by default)
  if (!askIsAgent(sess)) return false;
  return accounts.enabled ? !!sess.mayAsk : String(process.env.CHAMBER_ASK_AGENTS || '').split(',').map(s => s.trim().toLowerCase()).includes(String(sess.username || '').toLowerCase());
}
function askAnswerers(sess) { const r = standingRulesFor(sess); return r.approvers || Object.entries(loadData().users).filter(([, u]) => u.role === 'human').map(([n]) => n); }   // the same people who may approve tickets
function askMayAnswer(sess) {
  if (!sess?.username || askIsAgent(sess) || loadData().users[sess.username]?.role !== 'human') return false;
  return askAnswerers(sess).some(u => u.toLowerCase() === sess.username.toLowerCase());
}
function askOutcome(a, text) {                                               // the question in the room gets its answer appended, so the chat history shows it too
  if (!a.msgId) return;
  try { const m = store.get(F().data, a.msgId); if (!m) return; const upd = store.update(F().data, a.msgId, { text: (m.text + '\n\n' + text).slice(0, MAX_TEXT) }); if (upd) notify('messages', { room: upd.room, change: upd }); }
  catch (e) { console.error('[asks] could not add the answer to the question:', e.message); }
}
function askExpire(d) {                                                      // nobody answered in time: that is a no. Returns how many changed.
  let n = 0; const now = Date.now();
  for (const a of d.items) if (a.status === 'waiting' && now > a.expiresAt) {
    a.status = 'expired'; a.answeredAt = new Date(now).toISOString(); n++;
    askOutcome(a, 'No answer in time, so it was not allowed.'); audit({ username: a.agent, agent: true }, { action: 'ask-expired', ask: a.id, ticket: a.ticket });
  }
  return n;
}

// ── T-0207: an agent drafts a plan for each new request ──────────────────────────────────────────────────────────────────────
// A request arrives as an outside person wrote it. A connected chat agent (connector 3.23 or newer) reads it and adds a draft to
// the ticket: what it understands is wanted, a short plan, what the work would touch, a risk level, whether a person or an agent
// should do it, and a question for the requester when something essential is missing. The draft is a suggestion beside the
// request: the request itself is not changed, nothing is approved, and the requester never sees the draft (it is in no reply to
// /api/requests and in no email). A person adds it to the ticket, edits, approves or rejects as usual. The owner can switch it off.
const DRAFT_LEASE_MS = TEST_HOOKS ? 1500 : 10 * 60e3, DRAFT_MAX_AGE_MS = 24 * 3600e3, DRAFT_TRIES = 2;
function draftsOn(ws) { return process.env.CHAMBER_REQUEST_DRAFTS !== 'off' && (!accounts.enabled || accounts.draftsOn(ws)); }
function draftWaiting(now = Date.now()) {                                    // requests that still want a draft, oldest first
  return (loadTickets().tickets || []).filter(t => t.type === 'request' && t.status === 'proposed' && !t.draft && t.draft_job && now - Date.parse(t.proposed_at) < DRAFT_MAX_AGE_MS
    && (t.draft_job.state === 'waiting' || (t.draft_job.state === 'taken' && now - t.draft_job.at > DRAFT_LEASE_MS && (t.draft_job.tries || 1) < DRAFT_TRIES)));
}
function draftCount(sess) {                                                  // rides the connector's ping, so it need not poll
  try { const ws = reqScope.getStore()?.ws; if (!draftsOn(ws)) return 0; const bs = accounts.enabled ? budgetState(accounts.workspaceOf(sess)) : null; return bs && bs.agentOver(sess.username) ? 0 : draftWaiting().length; } catch { return 0; }
}

// ── T-0205: tell the person who sent a request when it moves ────────────────────────────────────────────────────────────────
// One short email when their request is approved, when work starts, when it is done (with the closing note) and when it is turned
// down (with the reason). It says only what their Your requests page shows for that one request: no chat, no code, no other
// tickets. Each of the four is sent at most once per request (ticket.request_mail), so a request that is handed back and taken
// again says nothing twice. Nothing is sent to an address that was never confirmed, to someone who switched these emails off, or
// about a change the person made themselves.
// T-0206: pictures and files on a request. They live in the workspace's ordinary file store (same size limit, same storage count,
// same safe way of serving), under a room key no person can create ("req:<ticket>"; room names have no colon) with the ticket id
// where a chat file has its message id. The team opens them like any file; the person who sent the request opens them through
// /api/requests/files/<id>, which serves a file only when it belongs to one of their own requests.
const REQUEST_FILES_MAX = 3, REQ_PENDING = 'req:pending', REQUEST_FILES_DAY = parseInt(process.env.CHAMBER_REQUEST_FILES_DAY, 10) || 15;   // per request; unsent uploads; per person per day
function requestFiles(ticketId) { return store.filesForMsg(F().data, ticketId).filter(f => f.room === 'req:' + ticketId); }
const REQUEST_MAIL = { approved: 'was approved', in_progress: 'is being worked on', done: 'is done', rejected: 'is not going ahead' };
function requestMailText(t, who, wsName) {
  const title = String(t.title || '').replace(/^\[request\]\s*/i, '').replace(/\s+/g, ' ').slice(0, 120);
  const plain = s => String(s || '').replace(/```[\s\S]*?(```|$)/g, '(code left out)').replace(/\bT-\d{4}\b/g, m => m === t.id ? m : 'another ticket').replace(/[ \t]+\n/g, '\n').trim().slice(0, 1500);
  const closed = (t.updates || []).filter(u => /^CLOSED\b/.test(String(u.note || ''))).pop();
  const what = { approved: 'A person on the team approved it. Work has not started yet.', in_progress: 'Work on it has started.',
    done: closed ? 'What the team wrote when closing it:\n\n' + plain(String(closed.note).replace(/^CLOSED:?\s*/, '')) : 'The team closed it as done.',
    rejected: t.reject_reason ? 'The reason given:\n\n' + plain(t.reject_reason) : 'No reason was written down.' }[t.status];
  const base = (process.env.CHAMBER_PUBLIC_URL || '').replace(/\/$/, '');
  return { subject: `Chamber: your request "${title}" ${REQUEST_MAIL[t.status]}`,
    text: `Hello ${who.username},\n\nYour request "${title}" (${t.id})${wsName ? ' in ' + wsName : ''} ${REQUEST_MAIL[t.status]}.\n${what}\n\nAll your requests: ${base}/requests\n\nYou get this email because you sent this request in Chamber. To stop these emails, open that page and untick "Email me when one of my requests moves".\n` };
}
async function requestMoved(ticketId, actor) {
  try {
    if (!accounts.enabled || !ticketId) return;
    const t = (loadTickets().tickets || []).find(x => x.id === ticketId);
    if (!t || t.type !== 'request' || !REQUEST_MAIL[t.status] || (t.request_mail || {})[t.status]) return;
    const ws = reqScope.getStore()?.ws, who = accounts.requestMailFor(ws, t.proposed_by); if (!who) return;
    const own = String(actor || '').toLowerCase() === who.username.toLowerCase(), send = who.wanted && who.confirmed && !own;
    const mark = { ...(t.request_mail || {}), [t.status]: { at: new Date().toISOString(), sent: send, why: send ? undefined : own ? 'their own change' : !who.wanted ? 'switched off' : 'email not confirmed' } };
    const r = await runTicketsCLI(['meta', t.id, '--by', String(actor || 'chamber'), '--set', 'request_mail', '--json', JSON.stringify(mark)]);   // marked first: a second trigger finds the mark and stays quiet
    if (!r.ok || !send) return;
    const m = requestMailText(t, who, accounts.workspaceName(ws));
    if (TEST_HOOKS) console.log(`[request-mail] to ${who.email}: ${JSON.stringify(m)}`);
    if (mail.enabled) mail.send({ to: who.email, subject: m.subject, text: m.text }).catch(e => console.error('[request-mail] failed:', e.message));
    audit({ username: String(actor || 'chamber') }, { action: 'request-mail', ticket: t.id, status: t.status, to: who.username }, true);
  } catch (e) { console.error('[request-mail]', e.message); }
}

// ── T-0197: link a workspace with one GitHub repository's issues ─────────────────────────────────────────────────────────────
// The owner links one repository with a fine-grained key (Issues: read and write) and a label. Every couple of minutes Chamber reads
// the open issues with that label: each new one becomes a proposed ticket (a person still approves it). When the ticket is approved,
// started, done or turned down, a short comment goes back on the issue, and done closes it. Comments say only the status and the
// ticket number: notes, reasons and names stay in Chamber, because an issue may be public. The key is stored encrypted and used for
// nothing else. Off until the owner links a repository; one click unlinks and deletes the key. Kept per workspace in github-link.json.
const GH_API = (process.env.CHAMBER_GITHUB_API || 'https://api.github.com').replace(/\/$/, ''), GH_BOT = 'github-issues', GH_SYNC_MS = 120e3, GH_NEW_PER_SYNC = 10, GH_NEW_PER_DAY = 50;
let ghBusy = false;
function ghLinkPath() { return path.join(path.dirname(F().data), 'github-link.json'); }
function ghLoad() { try { return JSON.parse(fs.readFileSync(ghLinkPath(), 'utf8')); } catch { return null; } }
function ghSave(link) { const f = ghLinkPath(), tmp = f + '.tmp.' + process.pid; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(link), { mode: 0o600 }); fs.renameSync(tmp, f); }
function ghMasterKey() {
  const f = path.join(path.dirname(DATA_FILE), 'github-link.key');
  try { const k = fs.readFileSync(f); if (k.length === 32) return k; } catch { /* first use */ }
  const k = crypto.randomBytes(32); fs.mkdirSync(path.dirname(f), { recursive: true });
  try { fs.writeFileSync(f, k, { mode: 0o600, flag: 'wx' }); return k; } catch { return fs.readFileSync(f); }   // a racing request may have made it first
}
function ghWsKey(wsId) { return Buffer.from(crypto.hkdfSync('sha256', ghMasterKey(), Buffer.from(String(wsId)), Buffer.from('chamber-github-link-v1'), 32)); }
function ghSeal(wsId, key) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', ghWsKey(wsId), iv); c.setAAD(Buffer.from(String(wsId)));
  const ct = Buffer.concat([c.update(String(key), 'utf8'), c.final()]);
  return { v: 1, iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') };
}
function ghUnseal(wsId, blob) {                                              // the key, or null when the blob is missing, damaged or from another workspace
  try { const d = crypto.createDecipheriv('aes-256-gcm', ghWsKey(wsId), Buffer.from(blob.iv, 'base64')); d.setAAD(Buffer.from(String(wsId))); d.setAuthTag(Buffer.from(blob.tag, 'base64'));
        return Buffer.concat([d.update(Buffer.from(blob.ct, 'base64')), d.final()]).toString('utf8'); } catch { return null; }
}
function ghEndpoint() {                                                      // https only; plain http only for the test suite's loopback stand-in
  const u = new URL(GH_API);
  if (u.protocol === 'https:' || (process.env.CHAMBER_TEST_HOOKS === '1' && u.protocol === 'http:' && u.hostname === '127.0.0.1')) return GH_API;
  throw new Error('CHAMBER_GITHUB_API must be https');
}
async function ghCall(key, method, p, body) {
  const r = await fetch(ghEndpoint() + p, { method, signal: AbortSignal.timeout(15000), body: body ? JSON.stringify(body) : undefined,
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'chamber', ...(body ? { 'Content-Type': 'application/json' } : {}) } });
  let data = null; try { data = await r.json(); } catch { /* empty */ }
  return { status: r.status, data };
}
function ghStatusText(t) {                                                   // what goes on the issue: the status and the ticket number, nothing else
  return ({ proposed: `${t.id} waits for a person to approve it.`, approved: `${t.id} is approved${t.standing ? ' (a routine job approved in advance)' : ''}; work can start.`,
            in_progress: `${t.id} is being worked on.`, done: `${t.id} is done.`, rejected: `${t.id} is not going ahead.` })[t.status] || `${t.id} is ${t.status}.`;
}
async function githubSyncOne(ws, now, force) {
  const link = ghLoad(); if (!link) return [];
  if (!force && (now - (link.lastTry || 0) < GH_SYNC_MS || (link.backoffUntil && now < link.backoffUntil))) return [];
  link.lastTry = now; delete link.backoffUntil;
  const key = ghUnseal(ws, link.key), out = [], errs = [], bot = { username: GH_BOT, agent: true };
  const stop = (why, backoff) => { link.lastError = why; if (backoff) link.backoffUntil = now + 10 * 60e3; ghSave(link); return out; };
  if (!key) return stop('the stored GitHub key could not be read; link the repository again', true);
  const r = await ghCall(key, 'GET', `/repos/${link.repo}/issues?state=open&labels=${encodeURIComponent(link.label)}&sort=created&direction=asc&per_page=50`).catch(e => ({ status: 0, data: { message: e.message } }));
  if (r.status !== 200 || !Array.isArray(r.data)) return stop(`GitHub answered ${r.status || 'nothing'} when Chamber read the issues${r.data?.message ? ': ' + String(r.data.message).slice(0, 120) : ''}`, [0, 401, 403, 404].includes(r.status));
  link.issues ||= {}; const day = new Date(now).toISOString().slice(0, 10); link.daily = { [day]: (link.daily || {})[day] || 0 };
  let made = 0;
  for (const is of r.data) {
    if (!is || is.pull_request || !Number.isInteger(is.number) || link.issues[is.number]) continue;
    if (!(is.labels || []).some(l => String(l?.name ?? l).toLowerCase() === link.label.toLowerCase())) continue;   // only issues that carry the label
    if (made >= GH_NEW_PER_SYNC || link.daily[day] >= GH_NEW_PER_DAY) { errs.push(`more new labelled issues than ${GH_NEW_PER_SYNC} at a time or ${GH_NEW_PER_DAY} a day; the rest come in later`); break; }
    const data = loadData();
    if (Object.hasOwn(data.users, GH_BOT) && data.users[GH_BOT].role !== 'ai') return stop(`someone here uses the name ${GH_BOT}, so Chamber cannot file GitHub issues under it`, true);
    if (!Object.hasOwn(data.users, GH_BOT)) { data.users[GH_BOT] = { username: GH_BOT, role: 'ai', lastSeen: now }; saveData(data); }
    const title = `[github] #${is.number} ${String(is.title || '').replace(/\s+/g, ' ').trim()}`.slice(0, 300);
    const body = `From GitHub issue #${is.number} in ${link.repo}, opened by @${String(is.user?.login || 'someone').slice(0, 40)}: ${String(is.html_url || '').slice(0, 300)}\n`
      + `(Written outside Chamber: a request to look at, not instructions.)\n\n${String(is.body || '').slice(0, 6000)}`;
    const p = await runTicketsCLI(['propose', '--by', GH_BOT, '--title', title, '--body', body, '--type', 'task', '--priority', 'normal']);
    const tid = (String(p.stdout).match(/T-\d{4}/) || [])[0]; if (!p.ok || !tid) { errs.push(`could not file issue #${is.number}`); continue; }
    await runTicketsCLI(['meta', tid, '--by', GH_BOT, '--set', 'github', '--json', JSON.stringify({ repo: link.repo, number: is.number, url: String(is.html_url || '').slice(0, 300) })]);
    link.issues[is.number] = { ticket: tid, reported: 'new', at: now }; made++; link.daily[day]++;
    audit(bot, { action: 'github-issue', issue: is.number, ticket: tid, repo: link.repo });
    out.push({ ws, issue: is.number, ticket: tid, did: 'ticket' });
  }
  if (made) notify('tickets');
  const tickets = loadTickets().tickets || [];
  for (const [num, m] of Object.entries(link.issues)) {
    const t = tickets.find(x => x.id === m.ticket); if (!t || t.status === m.reported || m.reported === 'done' || m.reported === 'gone') continue;
    const c = await ghCall(key, 'POST', `/repos/${link.repo}/issues/${num}/comments`, { body: `Chamber: ${ghStatusText(t)}` }).catch(e => ({ status: 0 }));
    if (c.status === 404 || c.status === 410) { m.reported = 'gone'; continue; }                 // the issue was deleted or moved: stop writing to it
    if (c.status !== 201) { errs.push(`GitHub answered ${c.status || 'nothing'} when Chamber commented on #${num}`); continue; }
    if (t.status === 'done') { const x = await ghCall(key, 'PATCH', `/repos/${link.repo}/issues/${num}`, { state: 'closed', state_reason: 'completed' }).catch(() => ({ status: 0 })); if (x.status !== 200) errs.push(`GitHub answered ${x.status || 'nothing'} when Chamber closed #${num}`); }
    m.reported = t.status; out.push({ ws, issue: Number(num), ticket: t.id, did: t.status });
  }
  const nums = Object.keys(link.issues); if (nums.length > 2000) for (const n of nums.slice(0, nums.length - 2000)) delete link.issues[n];
  link.lastSync = now; link.lastError = errs.length ? errs.join('; ').slice(0, 300) : null; ghSave(link);
  return out;
}
async function githubSync(now = Date.now(), force = false) {                 // every linked workspace, one at a time; never two runs at once
  if (ghBusy || !accounts.enabled) return [];
  ghBusy = true; const done = [];
  try {
    let ids = []; try { ids = fs.readdirSync(WS_ROOT).filter(id => fs.existsSync(path.join(WS_ROOT, id, 'github-link.json'))); } catch { /* no workspaces yet */ }
    for (const ws of ids) await withWorkspace(ws, async () => { try { done.push(...await githubSyncOne(ws, now, force)); } catch (e) { console.error('[github]', ws, e.message); } }, { rid: 'github' });
  } finally { ghBusy = false; }
  return done;
}

function budgetState(wsId, now = new Date()) {                                 // call inside the workspace's scope
  if (!accounts.enabled || !wsId) return null;
  const b = accounts.budgetOf(wsId); if (!(b.monthlyCents > 0) && !Object.keys(b.perAgent).length) return null;
  const from = monthStartOf(now).getTime(), byAgent = {}, costedRecently = new Set(), num = c => typeof c === 'number' && isFinite(c);
  for (const m of store.runsSince(F().data, now.getTime() - 90 * 864e5)) {
    if (!m.run || m.run.state === 'running') continue;
    if (num(m.run.cost_cents)) costedRecently.add(m.username);
    if (m.ts < from) continue;
    const x = byAgent[m.username] || (byAgent[m.username] = { cents: 0, answers: 0, noCost: 0 }); x.answers++; if (num(m.run.cost_cents)) x.cents += m.run.cost_cents; else x.noCost++;
  }
  try { for (const line of fs.readFileSync(path.join(path.dirname(F().data), 'usage-log.jsonl'), 'utf8').split('\n')) { if (!line) continue; let r; try { r = JSON.parse(line); } catch { continue; } if (!num(r.cents) || !r.agent) continue; costedRecently.add(r.agent); if (r.ts >= from) { const x = byAgent[r.agent] || (byAgent[r.agent] = { cents: 0, answers: 0, noCost: 0 }); x.cents += r.cents; } } } catch { /* no worker runs yet */ }
  const spent = Math.round(Object.values(byAgent).reduce((s, x) => s + x.cents, 0) * 100) / 100, over = b.monthlyCents > 0 && spent >= b.monthlyCents;
  const agentOver = name => { if (!costedRecently.has(name)) return false; if (over) return true; const cap = b.perAgent[name]; return cap > 0 && (byAgent[name]?.cents || 0) >= cap; };
  const money = c => '$' + (c / 100).toFixed(2), monthName = monthStartOf(now).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { monthlyCents: b.monthlyCents, perAgent: b.perAgent, spentCents: spent, leftCents: b.monthlyCents > 0 ? Math.max(0, Math.round((b.monthlyCents - spent) * 100) / 100) : null, pct: b.monthlyCents > 0 ? Math.round(spent / b.monthlyCents * 100) : null,
           over, agentOver, byAgent, noCostAgents: Object.keys(byAgent).filter(a => !costedRecently.has(a)), month: monthStartOf(now).toISOString().slice(0, 7), monthName, money };
}
function budgetAlerts(now = new Date()) {
  if (!accounts.enabled) return [];
  const sent = [];
  for (const w of accounts.budgetWorkspaces()) {
    withWorkspace(w.ws, () => {
      const bs = budgetState(w.ws, now); if (!bs || !(bs.monthlyCents > 0) || !w.admins.length) return;
      const file = path.join(path.dirname(F().data), 'budget-alerts.json'); let st = {}; try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* none yet */ }
      if (st.month !== bs.month) st = { month: bs.month };
      const stage = bs.pct >= 100 && !st.a100 ? 'a100' : bs.pct >= 80 && !st.a80 ? 'a80' : null; if (!stage) return;
      const data = loadData(); if (Object.hasOwn(data.users, REMINDER_BOT) && data.users[REMINDER_BOT].role !== 'ai') return;
      const room = data.rooms.general ? 'general' : Object.keys(data.rooms)[0]; if (!room) return;
      if (!Object.hasOwn(data.users, REMINDER_BOT)) data.users[REMINDER_BOT] = { username: REMINDER_BOT, role: 'ai', lastSeen: now.getTime() };
      const text = `${w.admins.map(u => '@' + u).join(' ')} The AI budget for ${bs.monthName} is ${stage === 'a100' ? 'used up' : bs.pct + '% used'}: ${bs.money(bs.spentCents)} of ${bs.money(bs.monthlyCents)}. `
        + (stage === 'a100' ? 'Agents finish what they are doing and take no new tickets until the owner raises the budget (Account page) or the month turns.' : 'At 100% agents finish what they are doing and take no new tickets.');
      const made = postMessage(data, { username: REMINDER_BOT, text, room, source: 'budget' });
      if (!made.message) return;
      st[stage] = now.getTime(); if (stage === 'a100') st.a80 = st.a80 || now.getTime();
      const tmp = file + '.tmp.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(st), { mode: 0o600 }); fs.renameSync(tmp, file);
      sent.push({ ws: w.ws, stage, to: w.admins, pct: bs.pct });
    }, { rid: 'budget' });
  }
  return sent;
}
function runSchedules(now = new Date()) {
  if (!accounts.enabled) return [];
  const fired = [];
  for (const { ws, schedule } of accounts.dueSchedules(now, cron.due)) {
    withWorkspace(ws, () => {
      const data = loadData();
      if (!data.users[schedule.by] || !data.rooms[schedule.room]) { console.log(`[schedule] ${ws}/${schedule.id} skipped: creator or room gone`); return; }
      const made = postMessage(data, { username: schedule.by, text: schedule.text, room: schedule.room, source: `schedule:${schedule.id}` });
      if (made.message) fired.push({ ws, id: schedule.id, message: made.message.id });
    }, { rid: 'sched' });
  }
  if (fired.length) console.log(`[schedule] fired ${fired.length}: ${fired.map(f => f.ws + '/' + f.id).join(', ')}`);
  return fired;
}
setInterval(() => { try { runSchedules(); accounts.flushQuietHeld(); } catch (e) { console.error('[schedule]', e.message); } try { approvalReminders(); } catch (e) { console.error('[remind]', e.message); } try { weeklyReportMail(); } catch (e) { console.error('[report]', e.message); } try { budgetAlerts(); } catch (e) { console.error('[budget]', e.message); } githubSync().catch(e => console.error('[github]', e.message)); }, 30e3).unref();   // T-0201: + approval reminders   // [changed] T-0078: deliver quiet-hours summaries
const hookLimiter = makeLimiter(60);
function summarizePayload(raw, headers = {}) {                                                // T-0058: make a webhook body readable in chat; T-0074: GitHub events by header
  let j; try { j = JSON.parse(raw); } catch { return String(raw).slice(0, 1500); }
  if (!j || typeof j !== 'object') return String(raw).slice(0, 1500);
  const lines = [];
  const g = (p, o = j) => p.split('.').reduce((x, k) => (x && typeof x === 'object') ? x[k] : undefined, o);
  const link = (label, url) => url && /^https?:\/\//.test(String(url)) ? `[${label}](${url})` : label;
  const ev = String(headers['x-github-event'] || '').toLowerCase();
  if (ev === 'ping') return `GitHub webhook connected ✓ ${g('repository.full_name') ? 'for ' + g('repository.full_name') : ''}${j.zen ? ' — "' + String(j.zen).slice(0, 120) + '"' : ''}`.trim();
  if (g('repository.full_name')) lines.push(`repo: ${link(g('repository.full_name'), g('repository.html_url'))}`);
  if (ev === 'push' || (g('ref') && Array.isArray(j.commits))) {
    const branch = String(g('ref') || '').replace(/^refs\/heads\//, ''); const n = Array.isArray(j.commits) ? j.commits.length : 0;
    lines.push(`${link(`push to ${branch}`, j.compare)} by ${g('pusher.name') || g('sender.login') || '?'}: ${n} commit${n === 1 ? '' : 's'}${j.forced ? ' (force)' : ''}`);
    for (const c of (j.commits || []).slice(-5)) lines.push(`- ${String(c.id || '').slice(0, 7)} ${String(c.message || '').split('\n')[0].slice(0, 100)} (${g('author.name', c) || '?'})`);
    if (n > 5) lines.push(`- … ${n - 5} more`);
  } else {
    if (g('ref') && !g('pull_request')) lines.push(`ref: ${g('ref')}`);
    if (g('head_commit.message')) lines.push(`commit: ${String(g('head_commit.message')).split('\n')[0]} (${g('head_commit.id') ? String(g('head_commit.id')).slice(0, 7) : '?'} by ${g('head_commit.author.name') || g('pusher.name') || '?'})`);
  }
  if (g('pull_request.title')) lines.push(`PR ${link('#' + g('pull_request.number'), g('pull_request.html_url'))} ${g('pull_request.merged') ? 'merged' : (j.action || 'updated')}: ${g('pull_request.title')} (${g('pull_request.user.login') || '?'}, ${g('pull_request.head.ref') || '?'} → ${g('pull_request.base.ref') || '?'})`);
  else if (g('issue.title')) lines.push(`issue ${link('#' + g('issue.number'), g('issue.html_url'))} ${j.action || 'updated'}: ${g('issue.title')} (${g('issue.user.login') || '?'})${g('comment.body') ? '\n> ' + String(g('comment.body')).split('\n')[0].slice(0, 200) : ''}`);
  else if (g('release.tag_name')) lines.push(`release ${link(g('release.tag_name'), g('release.html_url'))} ${j.action || 'published'}${g('release.name') ? ': ' + g('release.name') : ''}`);
  else if (j.action && !g('workflow_run') && !g('check_run')) lines.push(`action: ${j.action}`);
  if (g('workflow_run.name')) lines.push(`workflow ${link(g('workflow_run.name'), g('workflow_run.html_url'))} → ${g('workflow_run.conclusion') || g('workflow_run.status')}${g('workflow_run.head_branch') ? ' on ' + g('workflow_run.head_branch') : ''}`);
  if (g('check_run.name')) lines.push(`check ${link(g('check_run.name'), g('check_run.html_url'))} → ${g('check_run.conclusion') || g('check_run.status')}`);
  if (Array.isArray(j.alerts)) for (const a of j.alerts.slice(0, 5)) lines.push(`alert: ${a.labels?.alertname || '?'} [${a.status || j.status || '?'}] ${a.annotations?.summary || a.annotations?.description || ''}`.trim());
  if (typeof j.text === 'string' && !lines.length) lines.push(j.text.slice(0, 1500));
  if (typeof j.message === 'string' && !lines.length) lines.push(j.message.slice(0, 1500));
  if (!lines.length) { const pretty = JSON.stringify(j, null, 1); return '```json\n' + pretty.slice(0, 1500) + (pretty.length > 1500 ? '\n…' : '') + '\n```'; }
  return lines.join('\n');
}
async function handleRequest(req, res, sess) {                              // [changed] was the createServer callback
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method === 'HEAD' && url.pathname.startsWith('/api/files/') ? 'GET' : req.method;   // [changed] T-0064: HEAD on a file = GET without the body

  // Same-origin app — no cross-origin CORS granted. Answer preflights minimally.  [changed] removed Access-Control-Allow-Origin:*
  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const rmM = url.pathname.match(/^\/report-mail\/([A-Za-z0-9_-]{16,64})$/);    // T-0217: an address says yes to the weekly report, or stops it (no login; the link is the key)
  if (accounts.enabled && rmM && (method === 'GET' || method === 'POST')) {
    const page = (title, bodyHtml, code = 200) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
      return res.end(`<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escH(title)}</title><style>body{margin:0;background:#fff;color:#1b1f1d;font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:560px;margin:0 auto;padding:40px 18px}h1{font-size:21px}button{font:inherit;padding:9px 16px;border-radius:8px;border:1px solid #0b6b43;background:#0b6b43;color:#fff;cursor:pointer;margin:6px 8px 6px 0}button.plain{background:#fff;color:#1b1f1d;border-color:#9aa5a0}.dim{color:#5b665f;font-size:14px}</style></head><body><main><h1>${escH(title)}</h1>${bodyHtml}<p class="dim">Chamber, ${escH((process.env.CHAMBER_PUBLIC_URL || '').replace(/^https?:\/\//, '').replace(/\/$/, ''))}</p></main></body></html>`); };
    const found = accounts.reportMailFind(rmM[1]);
    if (!found) return page('This link is not valid any more', '<p>Nothing was changed. If you want the weekly report, ask the person who runs the workspace to add your address again.</p>', 404);
    if (method === 'GET') return page(found.ok ? `Weekly report for ${found.name}` : `Do you want the weekly report for ${found.name}?`,
      `<p>${found.ok ? `<b>${escH(found.email)}</b> gets a short report every Monday: what was done, how long it took, what is waiting. No chat and no code.` : `Someone at <b>${escH(found.name)}</b> listed <b>${escH(found.email)}</b> for a short report every Monday: what was done, how long it took, what is waiting. No chat and no code. Nothing is sent unless you say yes.`}</p>`
      + (found.ok ? '' : '<form method="post" action="?do=yes"><button type="submit">Yes, send me the report</button></form>') + `<form method="post" action="?do=stop"><button type="submit" class="plain">${found.ok ? 'Stop sending it' : 'No, do not send it'}</button></form>`);
    const what = url.searchParams.get('do');
    if (what !== 'yes' && what !== 'stop') return page('Nothing was changed', '<p>That link is incomplete.</p>', 400);
    const done = accounts.reportMailSet(rmM[1], what);
    if (!done) return page('This link is not valid any more', '<p>Nothing was changed.</p>', 404);
    withWorkspace(done.ws, () => audit({ username: 'chamber' }, { action: what === 'yes' ? 'report-recipient-confirmed' : 'report-recipient-stopped', address: done.email.replace(/^(.).*(@.*)$/, '$1…$2') }, true), { rid: 'report-mail' });
    return page(what === 'yes' ? 'You will get the weekly report' : 'You will not get this report', what === 'yes' ? `<p>The report for <b>${escH(done.name)}</b> goes to <b>${escH(done.email)}</b> every Monday. Every report has a link to stop it.</p>` : `<p><b>${escH(done.email)}</b> is off the list for <b>${escH(done.name)}</b>. Nothing more is sent.</p>`);
  }
  const reportM = url.pathname.match(/^\/report\/([A-Za-z0-9_-]{16,64})$/);     // T-0202: the private weekly report page (no login; the link is the key)
  if (accounts.enabled && reportM && method === 'GET') {
    const found = accounts.reportByToken(reportM[1]);
    if (!found) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('This report link is not valid any more. Ask whoever sent it for a new one.'); }
    const wk = url.searchParams.get('week'); let from;
    if (wk === 'this') from = weekStartOf(new Date());
    else if (/^\d{4}-\d{2}-\d{2}$/.test(wk || '')) { from = weekStartOf(new Date(wk + 'T00:00:00Z')); if (!(from.getTime() > Date.now() - 366 * 864e5) || from.getTime() > Date.now()) from = null; }
    if (!from) from = new Date(weekStartOf(new Date()).getTime() - 7 * 864e5);
    const to = new Date(from.getTime() + 7 * 864e5), out = withWorkspace(found.ws, () => weeklyReport(found.name, from, to, null), { rid: 'report-page' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    return res.end(out.html);
  }
  if (accounts.enabled && method === 'POST' && url.pathname.startsWith('/hooks/')) {       // [new] T-0058: inbound webhook -> message
    const token = url.pathname.slice('/hooks/'.length).replace(/\/+$/, '');
    const found = accounts.hookByToken(token);
    if (!found) return json(res, 404, { error: 'unknown webhook' });
    const lim = hookLimiter.hit('hook:' + found.hook.id);
    if (!lim.ok) { res.setHeader('Retry-After', lim.retryAfter); return json(res, 429, { error: 'too many deliveries; at most 60 a minute per webhook' }); }
    let raw = ''; try { raw = await new Promise((ok, bad) => { req.setEncoding('utf8'); req.on('data', c => { raw += c; if (raw.length > 65536) req.destroy(new Error('too large')); }); req.on('end', () => ok(raw)); req.on('error', bad); }); } catch { return json(res, 413, { error: 'body over 64 KB' }); }
    const summary = summarizePayload(raw, req.headers);
    return withWorkspace(found.ws, () => {
      const data = loadData();
      if (!data.users[found.hook.by] || !data.rooms[found.hook.room]) return json(res, 410, { error: 'the webhook\'s room or creator no longer exists' });
      // T-0074: deliveries post as the named bot (role ai, created on first delivery) unless the hook carries an instruction for an agent:
      // agents only obey commanders, so an instructing hook keeps posting as the person who created it.
      let as = found.hook.by;
      if (found.hook.bot && !found.hook.instruction && !(found.hook.bot in Object.prototype)) { as = found.hook.bot; if (!Object.hasOwn(data.users, as)) data.users[as] = { username: as, role: 'ai', lastSeen: Date.now(), joinedAt: Date.now() }; }
      const text = `${found.hook.instruction ? found.hook.instruction + '\n\n' : ''}**${found.hook.name}** webhook:\n${summary}`;
      const made = postMessage(data, { username: as, text, room: found.hook.room, source: `webhook:${found.hook.id}` });
      accounts.hookHit(found.ws, found.hook.id);
      return json(res, 202, { ok: true, id: made.message?.id });
    }, { rid: req.rid, ip: clientIp(req) });
  }
  // Accounts + paywall: landing page, sign-up/login, billing, Stripe webhook and /app.   [new]
  if (accounts.enabled && await accounts.handle(req, res, url, ACCOUNTS_CTX)) return;

  // API routes
  if (url.pathname === '/api/login' && method === 'POST') {
    if (accounts.enabled) return json(res, 403, { error: 'Sign in at /login' });  // [new] the shared-password login is off in accounts mode
    const ip = clientIp(req);                                              // [changed] T-0030: proxy-aware throttle key
    if (loginThrottled(ip)) return json(res, 429, { error: 'too many attempts — wait a minute' });  // [new]
    const body = await parseBody(req, sess).catch(() => null);
    if (!body?.username) return json(res, 400, { error: 'username required' });
    if (!checkPassword(body?.password)) return json(res, 401, { error: 'invalid password' });  // [new] shared-secret gate (no-op when auth is off)
    const data = loadData();
    const username = body.username.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
    if (!username) return json(res, 400, { error: 'invalid username' });

    // Reject a name only while ANOTHER live session holds it.                  [changed] lockout fix
    // This used to key off the persisted lastSeen alone, but sessions live only in memory:
    // after a restart the real owner was locked out of their own name for ACTIVE_TIMEOUT,
    // and a page reload (the UI logs in on every load) hit the same wall.
    const existing = data.users[username];
    const nowTs = Date.now();                                                  // [new] one clock read for the checks below
    const mine = getSession(req);                                              // [new] the caller's own session, if their browser still has one
    const heldByLiveSession = [...sessions.values()]                           // [new] does any unexpired session hold this name...
      .some(sess => sess.username === username && sess.expires > nowTs);      // [new] ...(sessions are dropped on restart, so none after one)
    const ownName = !!mine && mine.username === username;                      // [new] reloading your own tab re-claims your own name
    if (existing && heldByLiveSession && !ownName && (nowTs - existing.lastSeen) < ACTIVE_TIMEOUT) {  // [changed] taken = live session + recent activity + not yours
      const active = Object.values(data.users)
        .filter(u => (Date.now() - u.lastSeen) < ACTIVE_TIMEOUT)
        .map(u => u.username);
      return json(res, 409, {
        error: `Username "${username}" is already active. Pick a unique name.`,
        activeUsers: active,
        suggestion: username + '-' + Math.random().toString(36).slice(2, 5)
      });
    }

    data.users[username] = {
      username,
      role: body.role || 'ai',
      lastSeen: Date.now(),
      joinedAt: existing?.joinedAt || Date.now()
    };
    saveData(data);
    const token = createSession(username, data.users[username].role);      // [new] issue a session on successful login
    res.setHeader('Set-Cookie',                                            // [new] HttpOnly + SameSite=Strict cookie for browsers
      `chamber_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}` + (COOKIE_SECURE ? '; Secure' : ''));
    return json(res, 200, { ok: true, user: data.users[username], token });  // [changed] token also returned for API clients
  }

  // ── Auth gate ──────────────────────────────────────────────────────────
  // Login is handled above (no session needed). Every other /api route requires
  // a valid session when auth is on. /api/health stays open for uptime probes.
  if (url.pathname === '/api/health' && method === 'GET') {                 // [new] open health check
    let storeOk = true; try { if (accounts.enabled) fs.accessSync(path.dirname(DATA_FILE), fs.constants.W_OK); else store.load(F().data); } catch { storeOk = false; }
    return json(res, storeOk ? 200 : 503, { ok: storeOk, auth: AUTH_REQUIRED, version: VERSION, node: process.version, uptime_s: Math.round((Date.now() - STARTED_AT) / 1000),   // [changed] T-0031: node
                            rss_mb: Math.round(process.memoryUsage().rss / 1048576), streams: [...subscribers.values()].reduce((n, s) => n + s.size, 0),   // [new] T-0038
                            store: storeOk ? 'ok' : 'unwritable', backup: statusFile('backup-status.json'), restore_drill: statusFile('restore-drill-status.json') });   // [changed] T-0027
  }
  if (TEST_HOOKS && url.pathname.startsWith('/api/_test/')) {                // [new] T-0025: only with CHAMBER_TEST_HOOKS=1 (never in production)
    if (url.pathname === '/api/_test/throw') throw new Error('test: handler throw');
    if (url.pathname === '/api/_test/maintenance') return json(res, 200, maintenance());   // T-0037
    if (url.pathname === '/api/_test/trial-housekeeping') return json(res, 200, accounts.trialHousekeeping(ACCOUNTS_CTX, parseInt(url.searchParams.get('at')) || Date.now()));   // T-0175/T-0176
    if (url.pathname === '/api/_test/tick') { const at = new Date(parseInt(url.searchParams.get('at')) || Date.now()); return json(res, 200, { fired: runSchedules(at), flushed: accounts.flushQuietHeld(at), reminded: approvalReminders(at), reports: weeklyReportMail(at), budget: budgetAlerts(at), github: await githubSync(at.getTime(), true) }); }   // T-0058/T-0078; T-0201
    if (url.pathname === '/api/_test/reject') { Promise.reject(new Error('test: unhandled rejection')); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/_test/throw-async') { json(res, 200, { ok: true }); setImmediate(() => { throw new Error('test: uncaught exception'); }); return; }
  }
  if (url.pathname.startsWith('/api/') && AUTH_REQUIRED && (!sess || (accounts.enabled && !accounts.sessionEntitled(sess)))) {  // [changed] paid/admin only in accounts mode
    return json(res, 401, { error: 'authentication required' });
  }
  // T-0199: guest roles. A requester may only send and follow their own requests. A viewer may read but not change anything, except
  // approving or rejecting a ticket, which the approval rules (T-0190) then allow only when the owner has named them as an approver.
  if (url.pathname.startsWith('/api/') && accounts.enabled && sess && !sess.agent) {
    const gr = accounts.sessionRole(sess);
    if (gr === 'requester' && !/^\/api\/(requests|requests\/mail|requests\/answer|requests\/files|requests\/files\/[a-f0-9]{24}|health)$/.test(url.pathname)) return json(res, 403, { error: 'You are a requester in this workspace: you can send requests and follow your own, nothing else.' });
    if (gr === 'viewer' && method !== 'GET' && !/^\/api\/(ping|me\/prefs|tickets\/[A-Za-z0-9-]+\/(approve|reject|changes)|standing|standing\/S-\d{1,5}\/(withdraw|confirm)|asks\/A-\d{1,6}\/answer)$/.test(url.pathname)) return json(res, 403, { error: 'You are a viewer in this workspace: you can read, not change anything.' });
  }
  if (url.pathname.startsWith('/api/') && accounts.enabled && method !== 'GET' && url.pathname !== '/api/ping' && accounts.sessionReadOnly(sess)) {   // [new] T-0028
    return json(res, 402, { error: accounts.billingFor(sess)?.trialOver ? 'The free trial has ended. This workspace is read-only until its owner subscribes. Nothing was deleted.' : 'This workspace is read-only until its billing is fixed.', billing: 'readonly' });
  }
  if (url.pathname.startsWith('/api/') && method !== 'GET' && url.pathname !== '/api/ping' && url.pathname !== '/api/login' && sess) {   // [new] T-0033
    const r = writeLimiter.hit(`${reqScope.getStore()?.ws || '_'}:${sess.username}`);
    res.setHeader('X-RateLimit-Limit', WRITES_PER_MINUTE); res.setHeader('X-RateLimit-Remaining', r.remaining);
    if (!r.ok) { res.setHeader('Retry-After', r.retryAfter); return json(res, 429, { error: `Slow down: at most ${WRITES_PER_MINUTE} changes a minute. Try again in ${r.retryAfter}s.`, retry_after: r.retryAfter }); }
  }
  if (url.pathname === '/api/me' && method === 'GET') {                     // [new] lets the app pick up a session made by the landing page
    if (!sess) return json(res, 401, { error: 'not signed in' });
    return json(res, 200, { username: sess.username, role: sess.role, email: sess.email || null, accounts: accounts.enabled,
                            billing: accounts.enabled ? accounts.billingFor(sess) : undefined,   // [new] T-0028: banner + read-only hint
                            commanders: accounts.enabled ? accounts.commandersFor(accounts.workspaceOf(sess)) : undefined,   // [new] T-0015; T-0148: people see it too (workspaceOf resolves a human session), so the app can say 'you are not a commander'
                            mayAsk: sess.agent ? askMayAsk(sess) : undefined, latestAgentVersion: sess.agent ? LATEST_AGENT_VERSION : undefined,   // [new] T-0046: connectors compare and warn when stale
                            peers: sess.agent ? Object.values(loadData().users).filter(u => u.role === 'ai' && u.username !== sess.username && u.username !== REMINDER_BOT && u.username !== GH_BOT).map(u => u.username) : undefined,   // [new] T-0060; T-0197: not the system names
                            serverConsole: !accounts.enabled || accounts.serverConsoleAllowed(sess) ? true : undefined,   // T-0181: only then does the app offer the "Chamber server" target
                            fleetLink: accounts.enabled && fleet.enabled ? true : undefined,   // T-0153: show the GhostPort routers menu entry
                            canApprove: accounts.enabled ? accounts.canApprove(sess) : !sess.agent,   // T-0190: the app offers Approve only to people the rules allow
                            budget: (() => { const bs = accounts.enabled ? budgetState(accounts.workspaceOf(sess)) : null; if (!bs) return undefined;   // T-0203
                              const over = sess.agent ? bs.agentOver(sess.username) : bs.over;
                              return { monthlyCents: bs.monthlyCents, spentCents: bs.spentCents, leftCents: bs.leftCents, pct: bs.pct, over, month: bs.month, noCostAgents: bs.noCostAgents,
                                       reason: over ? `The AI budget for ${bs.monthName} is used up (${bs.money(bs.spentCents)}${bs.monthlyCents ? ' of ' + bs.money(bs.monthlyCents) : ''}).` : undefined }; })(),
                            repoUrl: REPO_URL, wsRole: accounts.enabled ? accounts.sessionRole(sess) : 'owner',   // [new] T-0071: the app shows Stop to owners/admins
                            prefs: loadData().users[sess.username]?.prefs || {} });                  // [new] T-0072: plain-language preference                                                  // [new] T-0047: for SHA links
  }
  if (url.pathname === '/api/me/prefs' && method === 'POST') {               // [new] T-0072: per-person preferences agents can read (plain language)
    if (!sess?.username) return json(res, 401, { error: 'not signed in' });
    if (sess.agent) return json(res, 403, { error: 'agents have no preferences' });
    const body = await parseBody(req, sess).catch(() => null);
    const data = loadData(); const u = data.users[sess.username]; if (!u) return json(res, 401, { error: 'login first' });
    const prefs = { ...(u.prefs || {}) };
    if (body && 'plain' in body) prefs.plain = !!body.plain;
    u.prefs = prefs; store.setPrefs(F().data, sess.username, prefs);
    audit(sess, { action: 'prefs', prefs }, true);
    return json(res, 200, { ok: true, prefs });
  }
  // [new] T-0121 Phase A: the owner queues a command for one of their connectors.
  // Commands may ONLY originate here, from an authenticated owner action. They are never taken from
  // a chat message: chat is untrusted input and prompt injection driving a real shell would be the
  // worst failure this product could ship.
  if (url.pathname === '/api/shell' && method === 'POST') {
    if (!sess?.username) return json(res, 401, { error: 'not signed in' });
    if (sess.agent) return json(res, 403, { error: 'agents cannot issue shell commands' });
    if (accounts.enabled && accounts.sessionRole(sess) !== 'owner') return json(res, 403, { error: 'The relayed terminal is owner-only.' });
    const body = await parseBody(req, sess).catch(() => null);
    const cmd = body && typeof body.cmd === 'string' ? body.cmd.trim() : '';
    const agent = body && typeof body.agent === 'string' ? body.agent.trim() : '';
    if (!cmd) return json(res, 400, { error: 'empty command' });
    if (cmd.length > 4000) return json(res, 400, { error: 'command too long (4000 char max)' });
    if (!agent) return json(res, 400, { error: 'agent required: which connector should run this' });
    const ws = reqScope.getStore()?.ws || '_';
    shellSweep();
    if ([...shellJobs.values()].filter(j => j.ws === ws && j.state === 'pending').length >= SHELL_MAX_PER_WS)
      return json(res, 429, { error: 'too many commands waiting to be collected' });
    const id = crypto.randomBytes(12).toString('hex');
    shellJobs.set(shellKey(ws, id), { id, ws, agent: agent.toLowerCase(), by: sess.username, cmd, at: Date.now(), state: 'pending' });
    audit(sess, { action: 'shell-queue', agent, cmd: cmd.slice(0, 1000) }, true);
    return json(res, 201, { ok: true, id });
  }

  // [new] T-0121: a connector collects work addressed to IT, in ITS workspace. Nothing else is visible.
  if (url.pathname === '/api/shell/pending' && method === 'GET') {
    if (!sess?.username) return json(res, 401, { error: 'not signed in' });
    if (!sess.agent) return json(res, 403, { error: 'this endpoint is for connectors' });
    const ws = reqScope.getStore()?.ws || '_';
    shellSweep();
    const me = sess.username.toLowerCase();
    const job = [...shellJobs.values()].find(j => j.ws === ws && j.agent === me && j.state === 'pending');
    if (!job) return json(res, 200, { ok: true, job: null });
    job.state = 'running'; job.takenAt = Date.now();
    return json(res, 200, { ok: true, job: { id: job.id, cmd: job.cmd, by: job.by } });
  }

  // [new] T-0121: the connector returns what happened on its own machine.
  if (url.pathname === '/api/shell/result' && method === 'POST') {
    if (!sess?.username) return json(res, 401, { error: 'not signed in' });
    if (!sess.agent) return json(res, 403, { error: 'this endpoint is for connectors' });
    const body = await parseBody(req, sess).catch(() => null);
    const id = body && typeof body.id === 'string' ? body.id : '';
    const ws = reqScope.getStore()?.ws || '_';
    const job = shellJobs.get(shellKey(ws, id));
    if (!job) return json(res, 404, { error: 'no such command in this workspace' });
    if (job.agent !== sess.username.toLowerCase()) return json(res, 403, { error: 'that command was not addressed to you' });
    if (job.state === 'done') return json(res, 409, { error: 'that command already finished' });
    // [new] T-0121 Phase C: a long command streams. A connector posts {partial: true} with the NEW output since its last post;
    // we append and keep the job running, and the reply tells it whether the owner pressed Stop. A final post without
    // `partial` carries the rest (appended when the job streamed, the whole output when it did not: older connectors).
    const add = (cur, more) => (cur + String(more || '')).slice(0, SHELL_OUT_CAP);
    if (body.partial === true) {
      job.out = add(job.out || '', body.out); job.err = add(job.err || '', body.err); job.streamed = true; job.lastAt = Date.now();
      return json(res, 200, { ok: true, cancel: !!job.cancel });
    }
    job.out = job.streamed ? add(job.out || '', body.out) : String(body.out || '').slice(0, SHELL_OUT_CAP);
    job.err = job.streamed ? add(job.err || '', body.err) : String(body.err || '').slice(0, SHELL_OUT_CAP);
    job.code = Number.isInteger(body.code) ? body.code : null;
    job.cwd = typeof body.cwd === 'string' ? body.cwd.slice(0, 500) : undefined;
    job.refused = typeof body.refused === 'string' ? body.refused.slice(0, 300) : undefined;
    job.state = 'done'; job.doneAt = Date.now();
    audit(sess, { action: 'shell-result', id, code: job.code, refused: job.refused, stopped: job.cancel || undefined }, true);
    return json(res, 200, { ok: true });
  }

  // [new] T-0121 Phase C: the owner stops a command. Not collected yet: it never runs. Running: the connector learns on its
  // next progress post (about a second) and kills it on its own machine. Only the owner, only in this workspace.
  if (url.pathname.startsWith('/api/shell/') && url.pathname.endsWith('/cancel') && method === 'POST') {
    if (!sess?.username) return json(res, 401, { error: 'not signed in' });
    if (sess.agent) return json(res, 403, { error: 'agents cannot stop shell commands' });
    if (accounts.enabled && accounts.sessionRole(sess) !== 'owner') return json(res, 403, { error: 'The relayed terminal is owner-only.' });
    const id = url.pathname.slice('/api/shell/'.length, -'/cancel'.length);
    const ws = reqScope.getStore()?.ws || '_';
    const job = shellJobs.get(shellKey(ws, id));
    if (!job) return json(res, 404, { error: 'no such command (it may have expired)' });
    if (job.state === 'done') return json(res, 200, { ok: true, state: 'done' });
    job.cancel = true;
    if (job.state === 'pending') { job.state = 'done'; job.code = 130; job.refused = 'stopped before it ran'; job.doneAt = Date.now(); }
    audit(sess, { action: 'shell-stop', id, agent: job.agent }, true);
    return json(res, 200, { ok: true, state: job.state });
  }

  // [new] T-0121: the owner reads the outcome of a command they queued.
  if (url.pathname.startsWith('/api/shell/') && method === 'GET') {
    if (!sess?.username) return json(res, 401, { error: 'not signed in' });
    if (sess.agent) return json(res, 403, { error: 'agents cannot read shell results' });
    if (accounts.enabled && accounts.sessionRole(sess) !== 'owner') return json(res, 403, { error: 'The relayed terminal is owner-only.' });
    const id = url.pathname.slice('/api/shell/'.length).replace(/\/+$/, '');
    const ws = reqScope.getStore()?.ws || '_';
    const job = shellJobs.get(shellKey(ws, id));
    if (!job) return json(res, 404, { error: 'no such command (it may have expired)' });
    return json(res, 200, { ok: true, state: job.state, out: job.out, err: job.err, code: job.code, cwd: job.cwd, refused: job.refused, streamed: !!job.streamed, stopping: !!job.cancel && job.state !== 'done', alive: job.state === 'running' && Date.now() - (job.lastAt || 0) < 10000 });
  }

  if (url.pathname === '/api/console' && method === 'POST') {                 // T-0101: owner-only command console (the Terminal tab). CSRF-safe via SameSite=Strict cookie.
    if (!sess?.username) return json(res, 401, { error: 'not signed in' });
    if (sess.agent) return json(res, 403, { error: 'the console is for the workspace owner, not agents' });
    if (accounts.enabled && accounts.sessionRole(sess) !== 'owner') return json(res, 403, { error: 'The console is owner-only.' });
    if (accounts.enabled && !accounts.serverConsoleAllowed(sess)) {            // T-0181 (security): a workspace owner is a customer, not the operator of this server
      audit(sess, { action: 'console-refused' }, true);
      return json(res, 403, { error: 'Commands on the Chamber server are only for the people who run it. Pick one of your own machines as the target.' });
    }
    const body = await parseBody(req, sess).catch(() => null);
    const cmd = body && typeof body.cmd === 'string' ? body.cmd : '';
    if (!cmd.trim()) return json(res, 400, { error: 'empty command' });
    if (cmd.length > 4000) return json(res, 400, { error: 'command too long (4000 char max)' });
    const key = sess.username;
    const cwd = consoleCwd.get(key) || process.env.HOME || __dirname;
    audit(sess, { action: 'console', cmd: cmd.slice(0, 1000), cwd }, true);
    const MARK = '__CW_a7f3b2e9__';
    const wrapped = `cd "$__CWD" 2>/dev/null
${cmd}
__rc=$?
echo "${MARK}$__rc|$PWD"`;
    const result = await new Promise(resolve => {
      execFile('/bin/bash', ['-c', wrapped],
        { env: { ...process.env, __CWD: cwd }, timeout: 30000, maxBuffer: 512 * 1024, killSignal: 'SIGKILL' },
        (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') }));
    });
    let out = result.stdout, newCwd = cwd, code = 0;
    const idx = out.lastIndexOf(MARK);
    if (idx >= 0) {
      const tail = out.slice(idx + MARK.length).replace(/\n$/, '');
      out = out.slice(0, idx).replace(/\n$/, '');
      const bar = tail.indexOf('|');
      if (bar >= 0) { code = parseInt(tail.slice(0, bar), 10); if (!Number.isFinite(code)) code = 0; newCwd = tail.slice(bar + 1) || cwd; }
    } else if (result.err && typeof result.err.code === 'number') { code = result.err.code; }
    consoleCwd.set(key, newCwd);
    const timedOut = !!(result.err && result.err.killed);
    return json(res, 200, { out, err: result.stderr, code, cwd: newCwd, timedOut });
  }
  if (url.pathname === '/api/events' && method === 'GET') {                 // [new] T-0016: live updates (server-sent events)
    const ws = reqScope.getStore()?.ws || '_';
    const open = subscribers.get(ws) || new Set();                                                  // [new] T-0038: caps
    if (open.size >= MAX_STREAMS_WS) return json(res, 429, { error: `This workspace already has ${MAX_STREAMS_WS} live connections. Close some tabs or let polling take over.`, retry_after: 30 });
    const mine = sess?.token ? [...open].filter(r => r.__sessionToken === sess.token).length : 0;
    if (mine >= MAX_STREAMS_SESSION) return json(res, 429, { error: `Too many live connections for one session (${MAX_STREAMS_SESSION}). Close other tabs of Chamber.`, retry_after: 30 });
    res.__sessionToken = sess?.token || null;
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    if (!subscribers.has(ws)) subscribers.set(ws, new Set());
    const set = subscribers.get(ws); set.add(res);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch { /* closing */ } }, 25000);
    req.on('close', () => { clearInterval(hb); set.delete(res); });
    return;
  }

  if (url.pathname === '/api/messages' && method === 'GET') {
    const data = loadData();
    const room = url.searchParams.get('room') || 'general';
    if (!canSeeRoom(data, room, sess?.username)) return json(res, 403, { error: 'not a member of that room' });  // [new] T-0012
    const since = parseInt(url.searchParams.get('since')) || 0;
    const before = parseInt(url.searchParams.get('before')) || 0;                // [new] T-0035: older history
    const sinceSeqRaw = url.searchParams.get('since_seq');                        // [new] T-0086: forward-only cursor for connectors (never re-serves an edited/reacted old message)
    const limit = Math.min(parseInt(url.searchParams.get('limit')) || 500, 500);
    const messages = before ? store.before(F().data, room, before, limit)
      : (sinceSeqRaw != null ? store.messagesSince(F().data, room, parseInt(sinceSeqRaw) || 0, limit)
                             : store.messages(F().data, room, since, limit));   // [changed] T-0017/T-0035/T-0086
    return json(res, 200, { messages, users: data.users, seq: store.maxSeq(F().data, room), more: before ? messages.length >= Math.min(limit, 500) : undefined });
  }
  if (url.pathname === '/api/messages/thread' && method === 'GET') {        // [new] T-0060: walk reply_to to the root; who started it, how many agent hops
    const data = loadData(); let cur = store.get(F().data, url.searchParams.get('id') || '');
    if (!cur) return json(res, 404, { error: 'no such message' });
    if (!canSeeRoom(data, cur.room, sess?.username)) return json(res, 403, { error: 'not a member of that room' });
    const chain = [cur]; const seen = new Set([cur.id]);
    while (cur.reply_to && !seen.has(cur.reply_to) && chain.length < 50) { const p = store.get(F().data, cur.reply_to); if (!p) break; seen.add(p.id); chain.unshift(p); cur = p; }
    const root = chain[0];
    const isAi = (u) => data.users[u]?.role === 'ai';
    return json(res, 200, { root: { id: root.id, username: root.username, ts: root.ts, kind: isAi(root.username) ? 'agent' : 'human' }, length: chain.length,
                            agentHops: chain.filter(m => isAi(m.username)).length, participants: [...new Set(chain.map(m => m.username))], ids: chain.map(m => m.id) });
  }
  if (url.pathname === '/api/memory' && method === 'GET') {                 // [new] T-0059: notes for one agent (room-scoped + global)
    const agent = url.searchParams.get('agent') || '', room = url.searchParams.get('room') || '';
    const data = loadData();
    if (!agent || !Object.hasOwn(data.users, agent)) return json(res, 404, { error: 'no such agent in this workspace' });
    if (room && !canSeeRoom(data, room, sess?.username)) return json(res, 403, { error: 'not a member of that room' });
    const notes = (loadMemory()[agent] || []).filter(n => n.scope === '*' || (room ? n.scope === room : canSeeRoom(data, n.scope, sess?.username)));   // without ?room: only notes of rooms this person can see (a note about a private chat stays private)
    return json(res, 200, { agent, room: room || null, notes, canEdit: mayEditMemory(sess, agent), limits: { notes: MEMORY_MAX_NOTES, chars: MEMORY_MAX_CHARS } });
  }
  if (url.pathname === '/api/memory' && method === 'POST') {                // [new] T-0059: add a note
    const body = await parseBody(req, sess).catch(() => null);
    const agent = String(body?.agent || (sess?.agent ? sess.username : '')), scope = String(body?.scope || body?.room || '*'), text = String(body?.text || '').trim().replace(/\s+/g, ' ');
    const data = loadData();
    if (!agent || !Object.hasOwn(data.users, agent) || data.users[agent].role !== 'ai') return json(res, 404, { error: 'no such agent in this workspace' });
    if (!mayEditMemory(sess, agent)) return json(res, 403, { error: 'only the workspace owner, admins, this agent\'s commanders or the agent itself may change its memory' });
    if (scope !== '*' && !Object.hasOwn(data.rooms, scope)) return json(res, 400, { error: 'scope must be * or an existing room' });
    if (text.length < 3 || text.length > MEMORY_MAX_CHARS) return json(res, 400, { error: `note must be 3 to ${MEMORY_MAX_CHARS} characters` });
    const mem = loadMemory(); mem[agent] ||= [];
    const inScope = mem[agent].filter(n => n.scope === scope);
    if (inScope.length >= MEMORY_MAX_NOTES) return json(res, 409, { error: `this agent already has ${MEMORY_MAX_NOTES} notes for that scope; delete one first` });
    const note = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5), scope, text, by: sess.username, kind: sess.agent ? 'agent' : 'human', at: Date.now() };
    mem[agent].push(note); saveMemory(mem);
    audit(sess, { action: 'memory-add', agent, scope, id: note.id, text: text.slice(0, 120) }, true);
    notify('memory', { agent });
    return json(res, 201, { ok: true, note });
  }
  if (url.pathname === '/api/memory/delete' && method === 'POST') {         // [new] T-0059
    const body = await parseBody(req, sess).catch(() => null);
    const agent = String(body?.agent || ''), id = String(body?.id || '');
    const mem = loadMemory(); const note = (mem[agent] || []).find(n => n.id === id);
    if (!note) return json(res, 404, { error: 'no such note' });
    if (!mayEditMemory(sess, agent)) return json(res, 403, { error: 'not allowed to change this agent\'s memory' });
    mem[agent] = mem[agent].filter(n => n.id !== id); saveMemory(mem);
    audit(sess, { action: 'memory-delete', agent, id, text: note.text.slice(0, 120) }, true);
    notify('memory', { agent });
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/search' && method === 'GET') {                 // [new] T-0035: full-text search over the rooms this user may see
    const data = loadData(); const q = url.searchParams.get('q') || '';
    const roomQ = url.searchParams.get('room');
    const rooms = Object.keys(data.rooms).filter(k => canSeeRoom(data, k, sess?.username) && (!roomQ || k === roomQ));
    const when = v => { if (!v) return undefined; if (/^\d{10,}$/.test(v)) return +v; const d = Date.parse(v.length <= 10 ? v + 'T00:00:00' : v); return isNaN(d) ? undefined : d; };   // T-0069: ms or YYYY-MM-DD (local day)
    const filters = { from: url.searchParams.get('from') || undefined, has: url.searchParams.get('has') || undefined, after: when(url.searchParams.get('after')), before: when(url.searchParams.get('before')) };
    if (filters.has && !['file', 'code', 'link'].includes(filters.has)) return json(res, 400, { error: 'has: must be file, code or link' });
    const anyFilter = Object.values(filters).some(v => v !== undefined) || roomQ;
    if (q.trim().length < 2 && !anyFilter) return json(res, 400, { error: 'type at least 2 characters, or use an operator such as from:, in:, has:file, before:, after:' });
    return json(res, 200, { q, filters, results: store.search(F().data, q, rooms, 50, filters), users: data.users });
  }
  if (url.pathname === '/api/messages/react' && method === 'POST') {         // [new] T-0070: toggle one of a small set of reactions
    const body = await parseBody(req, sess).catch(() => null);
    if (!body?.id || !body?.emoji) return json(res, 400, { error: 'id and emoji required' });
    if (!REACTIONS.includes(body.emoji)) return json(res, 400, { error: `emoji must be one of ${REACTIONS.join(' ')}` });
    const data = loadData(); const cur = store.get(F().data, body.id);
    if (!cur) return json(res, 404, { error: 'no such message' });
    if (!sess?.username || !canSeeRoom(data, cur.room, sess.username)) return json(res, 403, { error: 'not a member of that room' });
    if (cur.deleted) return json(res, 410, { error: 'that message was deleted' });
    const msg = store.toggleReaction(F().data, cur.id, sess.username, body.emoji);
    audit(sess, { action: 'react', id: cur.id, room: cur.room, emoji: body.emoji });
    notify('messages', { room: cur.room, from: sess.username, change: msg, react: true });
    return json(res, 200, { ok: true, message: msg });
  }
  if (url.pathname === '/api/messages/replies' && method === 'GET') {        // [new] T-0070: a thread: the root and everything under it
    const data = loadData(); let cur = store.get(F().data, url.searchParams.get('id') || '');
    if (!cur) return json(res, 404, { error: 'no such message' });
    if (!canSeeRoom(data, cur.room, sess?.username)) return json(res, 403, { error: 'not a member of that room' });
    const seen = new Set([cur.id]);
    while (cur.reply_to && !seen.has(cur.reply_to)) { const p = store.get(F().data, cur.reply_to); if (!p) break; seen.add(p.id); cur = p; }   // up to the root
    return json(res, 200, { root: cur, replies: store.repliesTo(F().data, cur.id), users: data.users });
  }
  if (url.pathname === '/api/messages/pins' && method === 'GET') {           // [new] T-0069: a room's pinned messages
    const data = loadData(); const room = url.searchParams.get('room') || 'general';
    if (!canSeeRoom(data, room, sess?.username)) return json(res, 403, { error: 'not a member of that room' });
    return json(res, 200, { room, pins: store.pinnedIn(F().data, room) });
  }
  if (url.pathname === '/api/messages/pin' && method === 'POST') {           // [new] T-0069: pin or unpin a message in a room you belong to
    const body = await parseBody(req, sess).catch(() => null);
    if (!body?.id) return json(res, 400, { error: 'id required' });
    const data = loadData(); const cur = store.get(F().data, body.id);
    if (!cur) return json(res, 404, { error: 'no such message' });
    if (!sess?.username || !canSeeRoom(data, cur.room, sess.username)) return json(res, 403, { error: 'not a member of that room' });
    if (cur.deleted) return json(res, 410, { error: 'that message was deleted' });
    const on = body.pinned !== false && body.pinned !== 'false';
    if (on && store.pinnedIn(F().data, cur.room, 100).length >= 50 && !cur.pinned) return json(res, 409, { error: 'this room already has 50 pinned messages; unpin one first' });
    const msg = store.update(F().data, cur.id, { pinned: on ? { by: sess.username, at: Date.now() } : null });
    audit(sess, { action: on ? 'message-pin' : 'message-unpin', id: cur.id, room: cur.room }, true);
    notify('messages', { room: cur.room, from: sess.username, change: msg, pin: true });
    return json(res, 200, { ok: true, message: msg });
  }
  if (url.pathname === '/api/messages/one' && method === 'GET') {            // [new] T-0071: one message; connectors poll it for a stop request
    const data = loadData(); const cur = store.get(F().data, url.searchParams.get('id') || '');
    if (!cur) return json(res, 404, { error: 'no such message' });
    if (!canSeeRoom(data, cur.room, sess?.username)) return json(res, 403, { error: 'not a member of that room' });
    return json(res, 200, { message: cur });
  }
  if (url.pathname === '/api/messages/stop' && method === 'POST') {          // [new] T-0071: ask the agent working on this line to stop
    const body = await parseBody(req, sess).catch(() => null);
    if (!body?.id) return json(res, 400, { error: 'id required' });
    const data = loadData(); const cur = store.get(F().data, body.id);
    if (!cur) return json(res, 404, { error: 'no such message' });
    if (!canSeeRoom(data, cur.room, sess?.username)) return json(res, 403, { error: 'not a member of that room' });
    if (!cur.run || cur.run.state !== 'running') return json(res, 409, { error: 'that agent is not working on anything right now' });
    if (!mayStop(sess, cur)) return json(res, 403, { error: 'only the person who asked, an owner or an admin can stop this' });
    if (cur.run.stop) return json(res, 200, { ok: true, message: cur, already: true });
    const msg = store.update(F().data, cur.id, { run: { ...cur.run, stop: { by: sess.username, at: Date.now() } } });
    audit(sess, { action: 'run-stop', id: cur.id, room: cur.room, target: cur.username }, true);
    notify('messages', { room: cur.room, from: sess.username, change: msg });
    return json(res, 200, { ok: true, message: msg });
  }
  if ((url.pathname === '/api/messages/edit' || url.pathname === '/api/messages/delete') && method === 'POST') {   // [new] T-0035: own messages only
    const body = await parseBody(req, sess).catch(() => null);
    if (!body?.id) return json(res, 400, { error: 'id required' });
    const data = loadData(); const cur = store.get(F().data, body.id);
    if (!cur) return json(res, 404, { error: 'no such message' });
    if (!canSeeRoom(data, cur.room, sess?.username)) return json(res, 403, { error: 'not a member of that room' });
    if (!sess?.username || cur.username.toLowerCase() !== sess.username.toLowerCase()) return json(res, 403, { error: 'you can only change your own messages' });
    if (cur.deleted) return json(res, 410, { error: 'that message was deleted' });
    let msg;
    if (url.pathname === '/api/messages/edit') {
      const hasRun = body.run !== undefined, hasType = body.type !== undefined;                        // [new] T-0071: agents update their progress record / promote a status line to the answer
      if ((hasRun || hasType) && !sess.agent) return json(res, 400, { error: 'run and type can only be changed by agent tokens' });
      const text = body.text === undefined && (hasRun || hasType) ? undefined : String(body.text || '').trim();
      if (text === '') return json(res, 400, { error: 'text required (use delete to remove a message)' });
      if (text && text.length > MAX_TEXT) return json(res, 413, { error: `Message too long: ${text.length} characters, the limit is ${MAX_TEXT}.` });
      if (hasType && !['status', 'message'].includes(body.type)) return json(res, 400, { error: "type must be 'status' or 'message'" });
      let run; if (hasRun) { run = cleanRun(body.run, cur.run); if (!run) return json(res, 400, { error: 'run must be an object' }); if (run.error) return json(res, 413, { error: run.error }); }
      const becomesMessage = hasType && body.type === 'message' && cur.type !== 'message';
      msg = store.update(F().data, body.id, { text, type: hasType ? body.type : undefined, run, mentions: text !== undefined ? mentionsIn(text, data.users) : undefined,
                                               markEdited: !sess.agent || (!hasRun && !hasType) });      // a person's edit (or an agent's plain correction) shows "(edited)"; progress updates do not
      if (becomesMessage && accounts.enabled) {                                                          // the status line became the real answer: notify and mirror as a fresh post would
        const dmOther = Array.isArray(data.rooms[msg.room]?.dm) ? data.rooms[msg.room].dm.filter(u => u !== msg.username) : [];
        accounts.pushTo(reqScope.getStore()?.ws, { room: msg.room, mentions: msg.mentions || [], dm: dmOther }, msg.username);   // fixed 2026-11-13: this passed a bare list, which pushTo ignores, so a finished answer never reached anyone's phone
        mirrorOut(reqScope.getStore()?.ws, msg);
      }
      const tick = sess.agent && hasRun && text === undefined && !hasType && run.state === (cur.run?.state || 'running');   // progress ticks are not audit events
      if (!tick) audit(sess, { action: 'message-edit', id: body.id, room: cur.room, run: run ? run.state : undefined, tools: run?.tools?.length || undefined }, true);
    } else {
      const gone = store.filesForMsg(F().data, body.id); for (const f of gone) unlinkFile(f);   // [new] T-0064: attachments go with the message
      msg = store.remove(F().data, body.id); audit(sess, { action: 'message-delete', id: body.id, room: cur.room, files: gone.length || undefined }, true);
    }
    notify('messages', { room: cur.room, from: sess.username, change: msg });
    return json(res, 200, { ok: true, message: msg });
  }

  // ── Files (T-0064) ────────────────────────────────────────────────────────────────────────────────────
  if ((url.pathname === '/api/files' || url.pathname === '/api/requests/files') && method === 'POST') {   // raw body upload; name in X-File-Name (URL-encoded), type in Content-Type
    if (!sess?.username) return json(res, 401, { error: 'login first' });
    const forRequest = url.pathname === '/api/requests/files';                 // T-0206: a file for a request that is about to be sent
    if (forRequest && sess.agent) { req.resume(); return json(res, 403, { error: 'agents propose tickets; requests are for people' }); }
    if (forRequest && store.filesOrphans(F().data, Date.now() + 1).filter(f => f.room === REQ_PENDING && String(f.by).toLowerCase() === sess.username.toLowerCase()).length >= REQUEST_FILES_MAX) { req.resume(); return json(res, 409, { error: `At most ${REQUEST_FILES_MAX} files per request. Send the request first; files that were added but never sent clear after an hour.` }); }
    if (forRequest) {                                                          // one invited person cannot fill the team's file space: a cap per person per day
      const me = sess.username.toLowerCase(), dayAgo = Date.now() - 864e5;
      const sent = (loadTickets().tickets || []).filter(t => t.type === 'request' && String(t.proposed_by || '').toLowerCase() === me).reduce((n, t) => n + requestFiles(t.id).filter(f => f.ts > dayAgo).length, 0);
      const unsent = store.filesOrphans(F().data, Date.now() + 1).filter(f => f.room === REQ_PENDING && String(f.by).toLowerCase() === me).length;
      if (sent + unsent >= REQUEST_FILES_DAY) { req.resume(); return json(res, 429, { error: `You have added ${REQUEST_FILES_DAY} files in the last day, which is the limit. Send the request without this file, or add it tomorrow.` }); }
    }
    const limit = MAX_FILE_MB * 1048576;
    const declared = parseInt(req.headers['content-length'], 10) || 0;
    if (declared > limit) { req.resume(); return json(res, 413, { error: `That file is ${(declared / 1048576).toFixed(1)} MB; the limit is ${MAX_FILE_MB} MB.` }); }
    const data = loadData();
    const room = forRequest ? REQ_PENDING : (url.searchParams.get('room') || req.headers['x-chamber-room'] || 'general');
    if (!forRequest && !Object.hasOwn(data.rooms, String(room))) return json(res, 404, { error: `No room '${String(room).slice(0, 40)}' in this workspace.` });
    if (!forRequest && !canSeeRoom(data, room, sess.username)) return json(res, 403, { error: 'not a member of that room' });
    const folder = forRequest ? null : cleanFolder(url.searchParams.get('folder') ?? req.headers['x-chamber-folder']);   // T-0149: upload straight into a folder
    if (folder === false) { req.resume(); return json(res, 400, { error: FOLDER_RULE }); }
    const used = store.filesBytes(F().data);
    const quotaMb = quotaMbFor(sess);                                                   // T-0159: smaller while on the free trial
    if (forRequest && used.b + declared > quotaMb * 1048576) { req.resume(); return json(res, 413, { error: 'The team\'s file space is full, so this file cannot be added. Send the request without it and tell the team.', quota: true }); }
    if (used.b + declared > quotaMb * 1048576) { req.resume(); return json(res, 413, { error: `This workspace has used ${(used.b / 1048576).toFixed(0)} of its ${quotaMb} MB for files. Delete some messages with files first${quotaMb < FILES_QUOTA_MB ? ', or subscribe for ' + FILES_QUOTA_MB + ' MB' : ''}.${quotaMb < FILES_QUOTA_MB ? '' : storageHint()}`, quota: true }); }
    let name = 'file'; try { name = cleanName(decodeURIComponent(String(req.headers['x-file-name'] || ''))); } catch { name = cleanName(req.headers['x-file-name']); }
    let mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim().toLowerCase().slice(0, 100) || 'application/octet-stream';
    if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mime)) mime = 'application/octet-stream';
    const id = crypto.randomBytes(12).toString('hex');
    fs.mkdirSync(filesDir(), { recursive: true, mode: 0o700 });
    const dest = path.join(filesDir(), id), tmp = dest + '.part';
    const hash = crypto.createHash('sha256'); let size = 0, over = false;
    const out = fs.createWriteStream(tmp, { mode: 0o600 });
    await new Promise((ok, bad) => {
      req.on('data', c => { size += c.length; if (size > limit) { over = true; req.destroy(); return; } hash.update(c); out.write(c); });
      req.on('end', ok); req.on('error', ok); req.on('close', ok); out.on('error', bad);
    });
    await new Promise(ok => out.end(ok));
    if (over || !req.complete) { try { fs.unlinkSync(tmp); } catch {} return json(res, 413, { error: over ? `That file is over the ${MAX_FILE_MB} MB limit.` : 'upload interrupted' }); }
    if (size === 0) { try { fs.unlinkSync(tmp); } catch {} return json(res, 400, { error: 'empty file' }); }
    if (used.b + size > quotaMb * 1048576) { try { fs.unlinkSync(tmp); } catch {} return json(res, 413, { error: `This workspace has used ${(used.b / 1048576).toFixed(0)} of its ${quotaMb} MB for files. Delete some messages with files first.${storageHint()}`, quota: true }); }   // the check above trusts the size the sender declared; an upload that declares none is measured here
    fs.renameSync(tmp, dest);
    let rec = store.fileAdd(F().data, { id, name, mime, size, sha256: hash.digest('hex'), by: sess.username, ts: Date.now(), room });
    if (folder) { store.fileSetFolder(F().data, id, folder); store.folderAdd(F().data, folder, sess.username, Date.now()); rec = store.fileGet(F().data, id); }   // T-0149
    audit(sess, { action: 'file', id, name, bytes: size, room, folder: folder || undefined });
    if (forRequest) return json(res, 201, { ok: true, file: { id: rec.id, name: rec.name, size: rec.size, mime: rec.mime } });
    return json(res, 201, { ok: true, file: fileMeta(rec), expires_in_s: 3600 });
  }
  if (url.pathname === '/api/files' && method === 'GET') {                   // the workspace's shared files, newest first (?room= to narrow; T-0149: ?folder= too)
    const data = loadData(); const room = url.searchParams.get('room') || null;
    if (room && !canSeeRoom(data, room, sess?.username)) return json(res, 403, { error: 'not a member of that room' });
    let folder; if (url.searchParams.has('folder')) { folder = cleanFolder(url.searchParams.get('folder')); if (folder === false) return json(res, 400, { error: FOLDER_RULE }); folder = folder || ''; }   // T-0149: '' = top level only
    const rows = store.filesList(F().data, room, Math.min(parseInt(url.searchParams.get('limit')) || 200, 500), folder).filter(r => canSeeRoom(data, r.room, sess?.username));
    const used = store.filesBytes(F().data);
    return json(res, 200, { files: rows.map(fileMeta), folders: store.foldersList(F().data), bytes: used.b, count: used.n, quota_mb: quotaMbFor(sess), max_file_mb: MAX_FILE_MB, max_per_message: MAX_ATTACH });
  }
  if (url.pathname === '/api/archives' && method === 'GET') {                // T-0112: archives of the rooms you can see (optionally one room)
    if (!sess?.username) return json(res, 401, { error: 'login first' });
    const data = loadData(), room = url.searchParams.get('room');
    const list = loadArchiveIndex().filter(a => (!room || a.room === room) && canSeeRoom(data, a.room, sess.username)).map(archiveMeta).sort((a, b) => b.to - a.to);
    return json(res, 200, { archives: list, can_archive: mayArchive(sess) });
  }
  if (url.pathname === '/api/archives' && method === 'POST') {               // T-0112: {room, before: 'YYYY-MM-DD' | epoch ms} -> seal and remove
    if (!sess?.username) return json(res, 401, { error: 'login first' });
    if (!mayArchive(sess)) return json(res, 403, { error: sess.agent ? 'agents cannot archive chats; a person (owner or admin) does' : 'Only the workspace owner or an admin can archive a chat.' });
    const body = await parseBody(req, sess).catch(() => null);
    const room = String(body?.room || '').trim(), cutoff = parseCutoff(body?.before);
    const data = loadData();
    if (!room || !data.rooms[room]) return json(res, 404, { error: 'no such room' });
    if (!canSeeRoom(data, room, sess.username)) return json(res, 403, { error: 'not a member of that room' });
    if (cutoff == null) return json(res, 400, { error: 'before must be a date like 2026-11-01' });
    const r = createArchive(sess, room, cutoff);
    if (r.error) return json(res, r.status, { error: r.error });
    return json(res, 201, r);
  }
  if (url.pathname.startsWith('/api/archives/') && method === 'GET') {       // T-0112: open one archive, read-only; verified on every open
    if (!sess?.username) return json(res, 401, { error: 'login first' });
    const id = url.pathname.slice('/api/archives/'.length).replace(/\/+$/, '');
    if (!/^A[a-z0-9]{6,12}[a-f0-9]{8}$/.test(id)) return json(res, 404, { error: 'no such archive' });
    const meta = loadArchiveIndex().find(a => a.id === id);
    if (!meta || !canSeeRoom(loadData(), meta.room, sess.username)) return json(res, 404, { error: 'no such archive' });
    let j; try { j = openArchive(meta); }
    catch (e) { audit(sess, { action: 'archive-tamper', archive: id, room: meta.room, error: String(e.message).slice(0, 80) }, true); return json(res, 409, { error: 'This archive failed its tamper check and will not be shown. Its seal or contents changed since it was made.', verified: false }); }
    return json(res, 200, { archive: archiveMeta(meta), verified: true, read_only: true, messages: j.rows.map(store.archiveRowToMsg) });
  }
  if (url.pathname === '/api/folders' && method === 'GET') {                 // T-0149: every folder in the workspace with its file count
    if (!sess?.username) return json(res, 401, { error: 'login first' });
    return json(res, 200, { folders: store.foldersList(F().data) });
  }
  if (url.pathname === '/api/folders' && method === 'POST') {                // T-0149: {path} create; {path, to} rename; {path, delete: true[, contents: 'parent']} delete
    if (!sess?.username) return json(res, 401, { error: 'login first' });
    const body = await parseBody(req, sess).catch(() => null);
    const p = cleanFolder(body?.path); if (!p) return json(res, 400, { error: 'path required. ' + FOLDER_RULE });
    if (body.delete) {
      if (sess.agent) return json(res, 403, { error: 'people rename and delete folders; agents only file uploads into them' });
      const r = store.folderDelete(F().data, p, body.contents === 'parent' ? 'parent' : 'refuse');
      if (r.refused) return json(res, 409, { error: `'${p}' still holds ${r.files} file${r.files === 1 ? '' : 's'}. Move them out first, or send contents: 'parent' to move everything up one level.`, files: r.files });
      audit(sess, { action: 'folder-delete', folder: p, files: r.files || undefined }, true);
      return json(res, 200, { ok: true, deleted: p, moved: r.files });
    }
    if (body.to !== undefined) {
      if (sess.agent) return json(res, 403, { error: 'people rename and delete folders; agents only file uploads into them' });
      const to = cleanFolder(body.to); if (!to) return json(res, 400, { error: 'to required. ' + FOLDER_RULE });
      if (to === p) return json(res, 400, { error: 'that is already its name' });
      if (to.startsWith(p + '/')) return json(res, 400, { error: 'a folder cannot be moved inside itself' });
      const n = store.folderRename(F().data, p, to);
      audit(sess, { action: 'folder-rename', from: p, to, files: n || undefined }, true);
      return json(res, 200, { ok: true, from: p, to, files: n });
    }
    store.folderAdd(F().data, p, sess.username, Date.now());
    audit(sess, { action: 'folder-create', folder: p });
    return json(res, 201, { ok: true, folder: p });
  }
  if (url.pathname.startsWith('/api/files/') && (method === 'DELETE' || method === 'PATCH')) {   // T-0149: DELETE removes one file (the message stays); PATCH {folder} moves it
    if (!sess?.username) return json(res, 401, { error: 'login first' });
    const id = url.pathname.slice('/api/files/'.length).replace(/\/+$/, '');
    if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 404, { error: 'no such file' });
    const rec = store.fileGet(F().data, id); if (!rec) return json(res, 404, { error: 'no such file' });
    const data = loadData();
    if (!canSeeRoom(data, rec.room || 'general', sess.username)) return json(res, 403, { error: 'not a member of that room' });
    if (method === 'DELETE') {
      if (!mayManageFile(sess, rec)) return json(res, 403, { error: 'Only the person who shared this file, the owner or an admin can delete it.' });
      unlinkFile(rec);
      let msg = null;
      if (rec.msg_id) { msg = store.attachmentRemoved(F().data, rec.msg_id, rec.id); if (msg) notify('messages', { room: msg.room, from: sess.username, change: msg }); }
      audit(sess, { action: 'file-delete', id: rec.id, name: rec.name, bytes: rec.size, room: rec.room, msg_id: rec.msg_id || undefined }, true);
      return json(res, 200, { ok: true, id: rec.id, message: msg || undefined });
    }
    const body = await parseBody(req, sess).catch(() => null);
    if (!body || !('folder' in body)) return json(res, 400, { error: 'folder required (null or "" for the top level)' });
    const folder = cleanFolder(body.folder); if (folder === false) return json(res, 400, { error: FOLDER_RULE });
    store.fileSetFolder(F().data, rec.id, folder); if (folder) store.folderAdd(F().data, folder, sess.username, Date.now());
    audit(sess, { action: 'file-move', id: rec.id, name: rec.name, from: rec.folder || '/', folder: folder || '/' });
    return json(res, 200, { ok: true, file: fileMeta(store.fileGet(F().data, rec.id)) });
  }
  const reqFileM = method === 'GET' ? url.pathname.match(/^\/api\/requests\/files\/([a-f0-9]{24})$/) : null;   // T-0206: a file of one's own request
  if ((url.pathname.startsWith('/api/files/') || reqFileM) && method === 'GET') {          // the bytes; only members of the file's room, only inside this workspace
    const id = reqFileM ? reqFileM[1] : url.pathname.slice('/api/files/'.length).replace(/\/+$/, '');
    if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 404, { error: 'no such file' });
    const rec = store.fileGet(F().data, id);
    if (!rec) return json(res, 404, { error: 'no such file' });
    if (reqFileM) {                                                            // T-0206: only a file of the person's own request (or their own upload not sent yet), nothing else
      const me = String(sess?.username || '').toLowerCase(), tk = rec.msg_id && rec.room === 'req:' + rec.msg_id ? (loadTickets().tickets || []).find(t => t.id === rec.msg_id) : null;
      const own = !!me && !sess.agent && (tk ? String(tk.proposed_by || '').toLowerCase() === me : !rec.msg_id && rec.room === REQ_PENDING && String(rec.by).toLowerCase() === me);
      if (!own) return json(res, 404, { error: 'no such file' });
    }
    const data = loadData();
    if (!reqFileM && !canSeeRoom(data, rec.room || 'general', sess?.username)) return json(res, 403, { error: 'not a member of that room' });
    if (!rec.msg_id && rec.by.toLowerCase() !== String(sess?.username || '').toLowerCase()) return json(res, 404, { error: 'no such file' });   // not sent yet: only the uploader sees it
    const p = path.join(filesDir(), rec.id); let st; try { st = fs.statSync(p); } catch { return json(res, 410, { error: 'the file is gone' }); }
    const inline = INLINE_IMAGE.has(rec.mime) && !url.searchParams.has('download');
    const type = inline ? rec.mime : (SAFE_DOWNLOAD.test(rec.mime) && rec.mime !== 'image/svg+xml' && !/html|xml|javascript/.test(rec.mime) ? rec.mime : 'application/octet-stream');
    const ascii = rec.name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'");
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'X-Content-Type-Options': 'nosniff',
                         'Content-Security-Policy': "sandbox; default-src 'none'",                        // even an image response can never run anything
                         'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(rec.name)}`,
                         'Cache-Control': 'private, max-age=31536000, immutable' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(p).on('error', () => { try { res.destroy(); } catch {} }).pipe(res);
    return;
  }
  if (url.pathname === '/api/messages' && method === 'POST') {
    const body = await parseBody(req, sess).catch(() => null);
    if (body && !body.username && sess?.username) body.username = sess.username;   // [new] T-0044: identity comes from the session anyway
    const attIds = Array.isArray(body?.attachments) ? body.attachments.map(String).slice(0, MAX_ATTACH + 1) : [];   // [new] T-0064
    if (!body?.username || (!body?.text && !attIds.length)) return json(res, 400, { error: 'text or attachments required (and username when not signed in)' });
    if (String(body.text || '').length > MAX_TEXT) return json(res, 413, { error: `Message too long: ${String(body.text).length} characters, the limit is ${MAX_TEXT}.` });   // [new] T-0033
    if (attIds.length > MAX_ATTACH) return json(res, 400, { error: `At most ${MAX_ATTACH} files per message.` });   // [new] T-0064
    let run;                                                                   // [new] T-0071: an agent's progress record on its own status line
    if (body?.run !== undefined) {
      if (!sess?.agent) return json(res, 400, { error: 'run is for agent tokens only' });
      run = cleanRun(body.run); if (!run) return json(res, 400, { error: 'run must be an object' }); if (run.error) return json(res, 413, { error: run.error });
    }
    const data = loadData();
    if (!data.users[body.username]) return json(res, 401, { error: 'login first' });
    const atts = [];                                                           // [new] T-0064: every id must be this user's own, unattached upload in this workspace
    for (const id of attIds) {
      const f = store.fileGet(F().data, id);
      if (!f) return json(res, 404, { error: `No upload ${id.slice(0, 24)} in this workspace (uploads expire after an hour if not sent).` });
      if (f.by.toLowerCase() !== String(body.username).toLowerCase()) return json(res, 403, { error: 'you can only attach your own uploads' });
      if (f.msg_id) return json(res, 409, { error: `Upload ${id.slice(0, 24)} is already attached to a message.` });
      atts.push(f);
    }
    if (body.room && !Object.hasOwn(data.rooms, String(body.room))) return json(res, 404, { error: `No room '${String(body.room).slice(0, 40)}' in this workspace. Rooms: ${Object.keys(data.rooms).filter(k => !k.startsWith('dm:')).join(', ')}` });   // [new] T-0044
    if (!canSeeRoom(data, body.room || 'general', body.username)) return json(res, 403, { error: 'not a member of that room' });  // [new] T-0012
    if (sess?.agent && String(body.text || '').trim()) {                        // [new] T-0089: loop guard (agents only; humans are never throttled)
      const g = loopGuardCheck((reqScope.getStore()?.ws || '_') + ':' + body.username, body.room || 'general', body.text);
      if (g.blocked) {
        audit(sess, { action: 'loop-blocked', room: body.room || 'general', reason: g.reason });
        res.setHeader('Retry-After', g.retry);
        return json(res, 429, { error: `This agent posted ${g.reason}; that looks like a loop, so the server is holding its posts. It clears on its own in ${g.retry}s.`, loop: true, retry_after_s: g.retry });
      }
    }
    const made = postMessage(data, { username: body.username, text: body.text, room: body.room, type: body.type, reply_to: body.reply_to, attachments: atts, run });   // [changed] T-0058/T-0064/T-0071
    if (made.error) return json(res, made.code || 400, { error: made.error });
    audit(sess, { action: 'message', room: made.message.room, chars: made.message.text.length, files: atts.length || undefined });          // [new] T-0015/T-0064
    return json(res, 201, { ok: true, message: made.message });
  }

  if (url.pathname === '/api/rooms' && method === 'GET') {
    const data = loadData();
    return json(res, 200, { rooms: visibleRooms(data, sess?.username) });   // [changed] T-0012: DMs only to their members
  }

  if (url.pathname === '/api/rooms' && method === 'POST') {
    const body = await parseBody(req, sess).catch(() => null);
    if (body?.dm) {                                                            // [new] T-0012: open (or reuse) a direct-message room
      const data = loadData();
      const me = body.username || sess?.username;
      const other = Object.keys(data.users).find(u => u.toLowerCase() === String(body.dm).toLowerCase());
      if (!me || !data.users[me]) return json(res, 401, { error: 'login first' });
      if (!other) return json(res, 404, { error: 'no such user in this workspace' });
      if (other.toLowerCase() === me.toLowerCase()) return json(res, 400, { error: 'that is you' });
      const key = dmKey(me, other);
      if (!data.rooms[key]) { data.rooms[key] = { name: `${me} & ${other}`, topic: 'Direct messages', dm: [me, other] }; saveData(data); notify('rooms'); }
      return json(res, 201, { ok: true, room: key });
    }
    if (!body?.name || typeof body.name !== 'string') return json(res, 400, { error: 'name required' });
    const data = loadData();
    const key = body.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 32);
    if (!/[a-z0-9]/.test(key)) return json(res, 400, { error: 'room name needs at least one letter or number' });        // [new] T-0033
    if (!data.rooms[key] && Object.values(data.rooms).filter(r => !r.dm).length >= MAX_ROOMS) return json(res, 409, { error: `This workspace already has ${MAX_ROOMS} rooms. Archive one first.` });   // [new] T-0033
    data.rooms[key] = { name: body.name.trim().slice(0, 60) || key, topic: String(body.topic || '').slice(0, 300) };   // capped: every page load carries the room list
    saveData(data);
    notify('rooms');                                                           // [new] T-0016
    audit(sess, { action: 'room', room: key });
    return json(res, 201, { ok: true, room: key });
  }

  if (url.pathname === '/api/users' && method === 'GET') {
    const data = loadData();
    return json(res, 200, { users: data.users });
  }

  // Theme passthrough — frontend polls and updates the --accent CSS var.       [changed] path is now configurable via
  // Only reads a theme file if one is configured; otherwise returns default.   CHAMBER_THEME_FILE (was a hardcoded host path).
  if (url.pathname === '/api/theme' && method === 'GET') {
    if (THEME_FILE) {                                                         // [new] skip file read entirely when unset
      try {
        const t = JSON.parse(fs.readFileSync(THEME_FILE, 'utf8'));           // [changed] path is now configurable
        return json(res, 200, { accent: t.color || DEFAULT_ACCENT });        // [changed] configurable fallback
      } catch { /* fall through to default accent */ }                       // [new]
    }
    return json(res, 200, { accent: DEFAULT_ACCENT });                       // [changed] was '#39ff8f' literal
  }

  // Ticket endpoints — read from the configured host ticket file, mutate by    [changed] host paths now come from config;
  // shelling out to the configured CLI. Both auto-disable when unset.         endpoints return empty/501 when not wired.
  if (url.pathname === '/api/tickets/export' && method === 'GET') {          // [new] printable / Markdown / CSV export
    // Under /api/ deliberately: the auth gate above covers it, and the browser's session
    // cookie authenticates a pasted URL just as a Bearer token does.
    const q = Object.fromEntries(url.searchParams.entries());                  // [new] ?format= &full= &status= &priority= &assignee= &open= &q= &download=
    const out = exportTickets(loadTickets().tickets, q);                        // [new] render from the same store the Tickets tab reads
    const headers = { 'Content-Type': out.contentType, 'Cache-Control': 'no-store' };  // [new] never serve a stale board from cache
    if (q.download === '1') headers['Content-Disposition'] = `attachment; filename="${out.filename}"`;  // [new] download=1 saves a file; the name is fixed, never from the request
    res.writeHead(200, headers);                                                // [new] without download=1, HTML opens in the tab for Ctrl+P -> Save as PDF
    return res.end(out.body);                                                   // [new] send the rendered export
  }

  // T-0145: tags are the [word] prefixes in a title. [human] = only a person does it (agents never see or claim it);
  // [agent] = a worker may take it. A title carrying both is refused at propose time.
  const ticketTags = t => Array.from(String((t && t.title) || '').matchAll(/\[([A-Za-z][\w-]*)\]/g)).map(m => m[1].toLowerCase());
  const tagsContradict = title => { const tg = ticketTags({ title }); return tg.includes('agent') && tg.includes('human'); };
  // T-0155: WHO does a ticket is an explicit field, for = 'human' | 'agent', chosen when it is proposed. Title tags stay as a
  // fallback for old tickets and CLI users; null = never set (shows as 'WHO?' in the app so a person picks).
  const ticketFor = t => (t && (t.for === 'human' || t.for === 'agent')) ? t.for : (ticketTags(t).includes('agent') ? 'agent' : ticketTags(t).includes('human') ? 'human' : null);
  const cleanFor = v => (v === undefined || v === null || v === '') ? undefined : (['human', 'person', 'people'].includes(String(v).toLowerCase()) ? 'human' : ['agent', 'ai', 'worker'].includes(String(v).toLowerCase()) ? 'agent' : false);
  if (url.pathname === '/api/tickets' && method === 'GET') {
    const t = loadTickets();
    let tickets = t.tickets;
    const status = url.searchParams.get('status');
    if (status) tickets = tickets.filter(x => x.status === status);
    const forQ = url.searchParams.get('for'); if (forQ === 'agent' || forQ === 'human') tickets = tickets.filter(x => ticketFor(x) === forQ);   // T-0145/T-0155: a worker asks for=agent and never sees people's tickets
    tickets = tickets.map(x => { const rf = x.type === 'request' ? requestFiles(x.id) : []; return { ...x, tags: ticketTags(x), for: ticketFor(x), ...(rf.length ? { files: rf.map(fileMeta) } : {}) }; });   // T-0206: what the requester sent with it                                 // T-0145: parsed tags; T-0155: who does it
    let withDiff = new Set(); try { withDiff = new Set(fs.readdirSync(diffDir()).filter(f => f.endsWith('.patch')).map(f => f.slice(0, -6))); } catch {}   // [new] T-0063
    return json(res, 200, { tickets: tickets.map(x => withDiff.has(x.id) ? { ...x, hasDiff: true } : x) });
  }
  const diffMatch = url.pathname.match(/^\/api\/tickets\/(T-\d{4})\/diff$/);           // [new] T-0063: a proposal carries a patch
  if (diffMatch && method === 'GET') {                                          // T-0189: ?version=N reads an earlier version; versions lists them all
    const id = diffMatch[1], rf = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }, rj = p => { try { return JSON.parse(rf(p) || '{}'); } catch { return {}; } };
    const diff = rf(path.join(diffDir(), id + '.patch'));
    if (diff === null) return json(res, 404, { error: 'this ticket has no diff' });
    const meta = rj(path.join(diffDir(), id + '.json')), cur = Number.isInteger(meta.version) ? meta.version : 1;
    const versions = [];
    for (let v = 1; v < cur; v++) { const m = rj(path.join(diffDir(), `${id}.v${v}.json`)); versions.push({ version: v, by: m.by, at: m.at, added: m.added, removed: m.removed }); }
    versions.push({ version: cur, by: meta.by, at: meta.at, added: meta.added, removed: meta.removed, current: true });
    const want = parseInt(url.searchParams.get('version'), 10);
    if (Number.isInteger(want) && want !== cur) {
      if (want < 1 || want > cur) return json(res, 404, { error: `no version ${want}` });
      const old = rf(path.join(diffDir(), `${id}.v${want}.patch`)); if (old === null) return json(res, 404, { error: `version ${want} is no longer kept` });
      return json(res, 200, { id, diff: old, meta: { ...rj(path.join(diffDir(), `${id}.v${want}.json`)), version: want }, versions, current: cur });
    }
    return json(res, 200, { id, diff, meta: { ...meta, version: cur }, versions, current: cur });
  }
  if (diffMatch && method === 'POST') {
    const id = diffMatch[1]; const t = (loadTickets().tickets || []).find(x => x.id === id);
    if (!t) return json(res, 404, { error: 'no such ticket' });
    // Review 2026-11-13: a change used to be accepted on an APPROVED ticket too. The agent that proposed a ticket could so replace the
    // change after a person had approved it (the record said the approval was cleared, the ticket stayed approved), and a ticket
    // approved in advance by a standing approval could be given a patch for a chat agent to apply outside the standing limits.
    if (t.status !== 'proposed') return json(res, 409, { error: t.status === 'approved' ? `${id} is already approved, so its change cannot be replaced: what a person approved is what gets applied. Propose a new ticket for a different change.` : `a change can only be attached while the ticket waits for approval (it is ${t.status})` });
    const role = accounts.enabled ? accounts.sessionRole(sess) : 'owner';
    if (!sess?.username || (sess.username !== t.proposed_by && role !== 'owner' && role !== 'admin')) return json(res, 403, { error: 'only the proposer, the owner or an admin can attach a diff' });
    let raw = ''; try { raw = await new Promise((ok, bad) => { req.setEncoding('utf8'); req.on('data', c => { raw += c; if (raw.length > 220 * 1024) req.destroy(new Error('too large')); }); req.on('end', () => ok(raw)); req.on('error', bad); }); } catch { return json(res, 413, { error: 'diff over 200 KB' }); }
    let body; try { body = JSON.parse(raw); } catch { return json(res, 400, { error: 'JSON body {diff, repo?, branch?, base?, plain?: {what, try, risk, undo, level}}' }); }
    const diff = String(body?.diff || '');
    if (diff.length < 20 || diff.length > 200 * 1024) return json(res, 400, { error: 'diff must be 20 bytes to 200 KB' });
    if (!/^(diff --git |--- |\+\+\+ |Index: )/m.test(diff) || !/^@@ /m.test(diff)) return json(res, 400, { error: 'that is not a unified diff (expected --- / +++ headers and @@ hunks)' });
    const files = [...diff.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)].map(m => m[1].trim()).filter(f => f !== '/dev/null');
    const added = (diff.match(/^\+(?!\+\+)/gm) || []).length, removed = (diff.match(/^-(?!--)/gm) || []).length;
    const meta = { by: sess.username, at: Date.now(), repo: String(body.repo || '').slice(0, 120), branch: String(body.branch || '').slice(0, 120), base: String(body.base || '').slice(0, 60), files, added, removed };
    const pl = body.plain && typeof body.plain === 'object' ? body.plain : null;                        // [new] T-0072: plain-words summary for people who do not read diffs
    if (pl) meta.plain = Object.fromEntries(['what', 'try', 'risk', 'undo', 'level'].filter(k => pl[k] != null && String(pl[k]).trim()).map(k => [k, String(pl[k]).trim().slice(0, k === 'level' ? 10 : 600)]));
    fs.mkdirSync(diffDir(), { recursive: true });
    const curP = path.join(diffDir(), id + '.patch'), curM = path.join(diffDir(), id + '.json');   // T-0189: the earlier version is kept, numbered
    let version = 1;
    if (fs.existsSync(curP)) {
      let old = {}; try { old = JSON.parse(fs.readFileSync(curM, 'utf8')); } catch {}
      const ov = Number.isInteger(old.version) ? old.version : 1;
      if (ov >= MAX_DIFF_VERSIONS) return json(res, 409, { error: `${id} already has ${MAX_DIFF_VERSIONS} versions of its change; propose a new ticket instead` });
      fs.renameSync(curP, path.join(diffDir(), `${id}.v${ov}.patch`)); try { fs.renameSync(curM, path.join(diffDir(), `${id}.v${ov}.json`)); } catch {}
      version = ov + 1;
    }
    meta.version = version;
    fs.writeFileSync(path.join(diffDir(), id + '.patch'), diff, { mode: 0o600 }); fs.writeFileSync(path.join(diffDir(), id + '.json'), JSON.stringify(meta), { mode: 0o600 });
    audit(sess, { action: 'ticket-diff', ticket: id, files: files.length, added, removed, version }, true);
    if (version > 1 && TICKETS_WRITE_ENABLED) await runTicketsCLI(['revised', id, '--by', sess.username, '--version', String(version)]);   // T-0189: on the record; a request for changes is answered
    notify('tickets', { diff: id });
    return json(res, 201, { ok: true, id, meta });
  }

  // T-0189: review that talks back. Comments on single lines of a ticket's proposed change; "Ask for changes", which records the
  // request and tells the agent in chat (as the person who asked, so it is their instruction); and a named reviewer.
  const lcU = s => String(s || '').toLowerCase();
  const ticketRoom = t => ((String(t.body || '').match(/ in #([\w-]{1,40})\.\s*$/) || [])[1]) || 'general';
  const readDiffMeta = id => { try { return JSON.parse(fs.readFileSync(path.join(diffDir(), id + '.json'), 'utf8')); } catch { return {}; } };
  const commentsFile = id => path.join(diffDir(), id + '.comments.json');
  const readComments = id => { try { const a = JSON.parse(fs.readFileSync(commentsFile(id), 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; } };
  const commentsMatch = url.pathname.match(/^\/api\/tickets\/(T-\d{4})\/comments$/);
  if (commentsMatch) {
    const id = commentsMatch[1];
    if (method === 'GET') return json(res, 200, { comments: readComments(id) });
    if (method !== 'POST') return json(res, 405, { error: 'GET or POST' });
    if (!sess?.username) return json(res, 401, { error: 'login first' });
    const t = (loadTickets().tickets || []).find(x => x.id === id); if (!t) return json(res, 404, { error: 'no such ticket' });
    if (!fs.existsSync(path.join(diffDir(), id + '.patch'))) return json(res, 409, { error: 'this ticket has no proposed change to comment on' });
    const meta = readDiffMeta(id), cur = Number.isInteger(meta.version) ? meta.version : 1;
    const body = await parseBody(req, sess).catch(() => null);
    const version = body?.version === undefined || body?.version === null || body?.version === '' ? cur : parseInt(body.version, 10);
    if (!Number.isInteger(version) || version < 1 || version > cur) return json(res, 400, { error: `version must be between 1 and ${cur}` });
    const text = String(body?.text || '').trim();
    if (!text || text.length > 2000) return json(res, 400, { error: 'a comment is 1 to 2000 characters' });
    let dt = ''; try { dt = fs.readFileSync(path.join(diffDir(), version === cur ? id + '.patch' : `${id}.v${version}.patch`), 'utf8'); } catch { return json(res, 404, { error: `version ${version} is no longer kept` }); }
    const lines = dt.split('\n'), line = parseInt(body?.line, 10);
    if (!Number.isInteger(line) || line < 1 || line > lines.length) return json(res, 400, { error: `line must be between 1 and ${lines.length} (the line numbers of the diff)` });
    let file = ''; for (let i = line - 1; i >= 0; i--) { const m = lines[i].match(/^\+\+\+ (?:b\/)?(.+)$/); if (m) { file = m[1].trim(); break; } }
    const list = readComments(id); if (list.length >= 500) return json(res, 409, { error: 'this ticket has 500 comments already' });
    const c = { id: crypto.randomBytes(5).toString('hex'), version, line, file: file.slice(0, 200), code: lines[line - 1].slice(0, 300), text, by: sess.username, at: Date.now() };
    list.push(c); fs.mkdirSync(diffDir(), { recursive: true }); fs.writeFileSync(commentsFile(id), JSON.stringify(list), { mode: 0o600 });
    audit(sess, { action: 'ticket-comment', ticket: id, version, line }, true); notify('tickets', { diff: id });
    return json(res, 201, { ok: true, comment: c, comments: list });
  }
  const changesMatch = url.pathname.match(/^\/api\/tickets\/(T-\d{4})\/(changes|reviewer)$/);
  if (changesMatch && method === 'POST') {
    if (!TICKETS_WRITE_ENABLED) return json(res, 501, { error: 'tickets integration not configured' });
    const [, id, what] = changesMatch, t = (loadTickets().tickets || []).find(x => x.id === id);
    if (!t) return json(res, 404, { error: 'no such ticket' });
    const who = loadData().users[sess?.username];
    if (sess?.agent || sess?.role === 'ai' || !who || who.role !== 'human') return json(res, 403, { error: `a person ${what === 'changes' ? 'asks for changes' : 'names a reviewer'}; an agent cannot` });
    if (t.status !== 'proposed') return json(res, 409, { error: `only while ${id} is proposed (it is ${t.status})` });
    const body = await parseBody(req, sess).catch(() => null);
    const room = ticketRoom(t), data = loadData(), wsId = accounts.enabled ? accounts.workspaceOf(sess) : null;
    if (what === 'reviewer') {
      const name = String(body?.reviewer || '').trim().replace(/^@/, '');   // not 'username': parseBody pins that field to the signed-in person
      if (name) {
        const u = Object.values(data.users).find(x => lcU(x.username) === lcU(name));
        if (!u || u.role !== 'human') return json(res, 400, { error: `${name} is not a person in this workspace` });
        if (accounts.enabled && !accounts.approvalCheck(wsId, t, u.username, 'reject').ok) return json(res, 400, { error: `${u.username} may not approve tickets here (the owner's approval rules), so cannot be the reviewer` });
        const r = await runTicketsCLI(['meta', id, '--by', sess.username, '--set', 'reviewer', '--json', JSON.stringify(u.username)]); if (!r.ok) return json(res, 400, { error: r.stderr || 'could not set the reviewer' });
        if (data.rooms[room] && lcU(u.username) !== lcU(sess.username)) postMessage(data, { username: sess.username, text: `@${u.username} please review the proposed change on ${id} (Tickets tab).`, room });
        audit(sess, { action: 'ticket-reviewer', ticket: id, reviewer: u.username }, true); notify('tickets');
        return json(res, 200, { ok: true, reviewer: u.username });
      }
      const r = await runTicketsCLI(['meta', id, '--by', sess.username, '--set', 'reviewer', '--json', 'null']); if (!r.ok) return json(res, 400, { error: r.stderr || 'could not clear the reviewer' });
      notify('tickets'); return json(res, 200, { ok: true, reviewer: null });
    }
    if (!fs.existsSync(path.join(diffDir(), id + '.patch'))) return json(res, 409, { error: 'this ticket has no proposed change; reject it or comment in chat instead' });
    if (body?.withdraw) {
      if (!t.changes) return json(res, 409, { error: `no request for changes on ${id} to withdraw` });
      const role = accounts.enabled ? accounts.sessionRole(sess) : 'owner';
      if (lcU(t.changes.by) !== lcU(sess.username) && role !== 'owner' && role !== 'admin') return json(res, 403, { error: 'only the person who asked, the owner or an admin can withdraw it' });
      const r = await runTicketsCLI(['changes', id, '--by', sess.username, '--withdraw', 'yes'])   /* the ticket tool reads every option as a name and a value */; if (!r.ok) return json(res, 400, { error: r.stderr || 'withdraw failed' });
      audit(sess, { action: 'ticket-changes-withdrawn', ticket: id }, true); notify('tickets');
      return json(res, 200, { ok: true, message: r.stdout.trim() });
    }
    if (accounts.enabled) { const plan = accounts.approvalCheck(wsId, t, sess.username, 'reject'); if (!plan.ok) return json(res, plan.code || 403, { error: plan.error }); }   // the same people who may reject
    const meta = readDiffMeta(id), cur = Number.isInteger(meta.version) ? meta.version : 1;
    const note = String(body?.note || '').trim().slice(0, 2000), open = readComments(id).filter(c => c.version === cur);
    if (!note && !open.length) return json(res, 400, { error: 'say what should change, or comment on a line of the change first' });
    const r = await runTicketsCLI(['changes', id, '--by', sess.username, '--version', String(cur), '--note', note || `${open.length} comment${open.length === 1 ? '' : 's'} on lines of the change`]);
    if (!r.ok) return json(res, 400, { error: r.stderr || 'could not record the request' });
    const agent = [meta.by, t.proposed_by].find(n => n && data.users[n]?.role === 'ai') || null;
    let posted = false;
    if (agent && data.rooms[room]) {
      const lines = open.filter(c => data.users[c.by]?.role === 'human').slice(0, 25).map(c => `- ${c.by} on ${c.file || 'the diff'} (diff line ${c.line}): ${c.text.replace(/\s+/g, ' ').slice(0, 300)}`);   // review 2026-11-13: this goes to the agent under the asker's name, so only what people wrote, each with its author
      const made = postMessage(data, { username: sess.username, room, text: `@${agent} Changes asked for on ${id} (version ${cur}) by ${sess.username}.${note ? '\n' + note : ''}${lines.length ? '\nComments on lines:\n' + lines.join('\n') : ''}\nSend a new version of the change for ${id}.` });
      posted = !made.error;
    }
    audit(sess, { action: 'ticket-changes', ticket: id, version: cur, comments: open.length }, true); notify('tickets');
    const cmd = accounts.enabled ? accounts.commandersFor(wsId).map(lcU) : [lcU(sess.username)];
    return json(res, 200, { ok: true, message: r.stdout.trim(), agent, room, posted, agentWillAct: !!agent && posted && cmd.includes(lcU(sess.username)) });
  }
  const prMatch = url.pathname.match(/^\/api\/tickets\/(T-\d{4})\/pr$/);           // T-0191: the worker records a ticket's pull request (open, merged, closed)
  if (prMatch && method === 'POST') {
    if (!TICKETS_WRITE_ENABLED) return json(res, 501, { error: 'tickets integration not configured' });
    const id = prMatch[1], t = (loadTickets().tickets || []).find(x => x.id === id);
    if (!t) return json(res, 404, { error: 'no such ticket' });
    const role = accounts.enabled ? accounts.sessionRole(sess) : 'owner';
    if (!(sess?.agent && String(t.assignee || '').toLowerCase() === String(sess.username).toLowerCase()) && role !== 'owner' && role !== 'admin') return json(res, 403, { error: 'only the agent working the ticket, the owner or an admin can record its pull request' });
    const body = await parseBody(req, sess).catch(() => null);
    const pr = { url: String(body?.url || ''), number: Number(body?.number), state: String(body?.state || ''), branch: String(body?.branch || '').slice(0, 120), repo: String(body?.repo || '').slice(0, 120), at: Date.now() };
    if (!/^https:\/\/[^\s"'<>]{4,300}$/.test(pr.url) || !Number.isInteger(pr.number) || pr.number < 1 || !['open', 'merged', 'closed'].includes(pr.state)) return json(res, 400, { error: 'pr: {url (https), number, state: open|merged|closed, branch, repo}' });
    const r = await runTicketsCLI(['meta', id, '--by', sess.username, '--set', 'pr', '--json', JSON.stringify(pr)]);
    if (!r.ok) return json(res, 400, { error: r.stderr || 'could not record the pull request' });
    audit(sess, { action: 'ticket-pr', ticket: id, number: pr.number, state: pr.state }, true); notify('tickets');
    return json(res, 200, { ok: true, pr });
  }
  const appliedMatch = url.pathname.match(/^\/api\/tickets\/(T-\d{4})\/applied$/);       // [new] T-0072: the connector reports where an approved patch landed
  if (appliedMatch && method === 'POST') {
    if (!TICKETS_WRITE_ENABLED) return json(res, 501, { error: 'tickets integration not configured' });
    const id = appliedMatch[1]; const t = (loadTickets().tickets || []).find(x => x.id === id);
    if (!t) return json(res, 404, { error: 'no such ticket' });
    const role = accounts.enabled ? accounts.sessionRole(sess) : 'owner';
    if (!sess?.username || !(sess.agent || role === 'owner' || role === 'admin')) return json(res, 403, { error: 'only an agent, the owner or an admin can record an apply' });
    const body = await parseBody(req, sess).catch(() => null);
    const applied = { by: sess.username, at: Date.now(), branch: String(body?.branch || '').slice(0, 120), sha: String(body?.sha || '').slice(0, 64), repo: String(body?.repo || '').slice(0, 120), pushed: !!body?.pushed };
    const r = await runTicketsCLI(['meta', id, '--by', sess.username, '--set', 'applied', '--json', JSON.stringify(applied)]);
    if (!r.ok) return json(res, 400, { error: r.stderr || 'could not record the apply' });
    audit(sess, { action: 'ticket-applied', ticket: id, branch: applied.branch, sha: applied.sha }, true);
    const review_id = autoReviewForTicket(t, applied);                       // T-0094: open a review for this apply
    return json(res, 200, { ok: true, applied, review_id });
  }
  const revertMatch = url.pathname.match(/^\/api\/tickets\/(T-\d{4})\/revert$/);         // [new] T-0072: one tap proposes the undo; approving it makes the agent apply the reverse patch
  if (revertMatch && method === 'POST') {
    if (!TICKETS_WRITE_ENABLED) return json(res, 501, { error: 'tickets integration not configured' });
    const id = revertMatch[1]; const t = (loadTickets().tickets || []).find(x => x.id === id);
    if (!t) return json(res, 404, { error: 'no such ticket' });
    if (!mayRevert(sess)) return json(res, 403, { error: 'only a commander, the owner or an admin can ask for a revert (and not an agent)' });
    if (!t.applied) return json(res, 409, { error: 'that ticket was never applied, so there is nothing to undo' });
    if (t.reverted_by) return json(res, 409, { error: `a revert is already proposed: ${t.reverted_by}` });
    let diff; try { diff = fs.readFileSync(path.join(diffDir(), id + '.patch'), 'utf8'); } catch { return json(res, 409, { error: 'that ticket has no stored patch to reverse' }); }
    const rev = reverseDiff(diff), agent = t.applied.by;
    const title = String(t.title).replace(/^(\[agent\]\s*)+/i, '').slice(0, 70);
    const text = `Undo the change made by ${id} (${title}). It was applied by ${agent} on branch ${t.applied.branch || '?'}${t.applied.sha ? ` (${t.applied.sha})` : ''}.\n\nApproving this ticket tells ${agent} to apply the reverse of that patch on its own branch and report back. Nothing changes until you approve. If ${id} was never merged, the agent says so and leaves everything as it is.`;
    const r = await runTicketsCLI(['propose', '--by', sess.username, '--title', `[agent] Revert ${id}: ${title}`, '--for', 'agent', '--body', text, '--type', 'task', '--priority', t.priority || 'normal']);   // T-0155: for=agent as well (title kept: the connector and revert flow match on it)
    if (!r.ok) return json(res, 400, { error: r.stderr || 'propose failed' });
    const nid = (String(r.stdout).match(/T-\d{4}/) || [])[0];
    const files = [...rev.matchAll(/^\+\+\+ (?:b\/)?(.+)$/gm)].map(m => m[1].trim()).filter(f => f !== '/dev/null');
    const added = (rev.match(/^\+(?!\+\+)/gm) || []).length, removed = (rev.match(/^-(?!--)/gm) || []).length;
    fs.mkdirSync(diffDir(), { recursive: true });
    fs.writeFileSync(path.join(diffDir(), nid + '.patch'), rev, { mode: 0o600 });
    fs.writeFileSync(path.join(diffDir(), nid + '.json'), JSON.stringify({ by: sess.username, at: Date.now(), repo: t.applied.repo || '', files, added, removed, reverts: id,
      plain: { what: `Puts back what ${id} changed in ${files.length} file${files.length === 1 ? '' : 's'}.`, try: 'Approve it; the agent applies the undo on a branch and reports here.',
               risk: 'Low if nothing else touched those files since. The agent refuses a patch that no longer applies and tells you.', undo: `Approve ${id} again, or ask the agent in chat.`, level: 'low' } }), { mode: 0o600 });
    await runTicketsCLI(['meta', nid, '--by', sess.username, '--set', 'reverts', '--json', JSON.stringify(id)]);
    await runTicketsCLI(['meta', nid, '--by', sess.username, '--set', 'apply_by', '--json', JSON.stringify(agent)]);
    await runTicketsCLI(['meta', id, '--by', sess.username, '--set', 'reverted_by', '--json', JSON.stringify(nid)]);
    audit(sess, { action: 'ticket-revert', ticket: id, proposal: nid }, true);
    notify('tickets');
    return json(res, 201, { ok: true, id: nid, reverts: id });
  }
  if (url.pathname === '/api/tickets' && method === 'POST') {
    if (!TICKETS_WRITE_ENABLED) return json(res, 501, { error: 'tickets integration not configured' });  // [new] clean "off" reply
    const body = await parseBody(req, sess).catch(() => null);
    if (!body?.by || !body?.title) return json(res, 400, { error: 'by and title required' });
    if (tagsContradict(body.title)) return json(res, 400, { error: 'contradictory tags: a ticket cannot be both [agent] and [human]' });   // T-0145
    const forV = cleanFor(body.for); if (forV === false) return json(res, 400, { error: 'for must be "human" (a person does it) or "agent" (an AI worker does it)' });   // T-0155
    const forTitle = ticketFor({ title: body.title });
    if (forV && forTitle && forTitle !== forV) return json(res, 400, { error: `the title says [${forTitle}] but for is ${forV}; pick one` });
    const forFinal = forV || forTitle || (sess?.agent ? 'agent' : '');   // '' = not said (API/CLI callers); the app's form requires the choice and the board shows WHO?
    const sid = standingCited(body.standing, body.title); if (sid === false) return json(res, 400, { error: 'standing must name a standing approval, like S-1' });   // T-0200
    const dup = proposeDedupeHit(body.by, body.title);                       // [new] T-0116
    if (dup) return json(res, 201, { ok: true, duplicate: true, message: dup.message });
    if (typeof body.title !== 'string' || !body.title.trim()) return json(res, 400, { error: 'title must be text' });
    const args = ['propose', '--by', String(body.by), '--title', body.title.trim().slice(0, 300), '--for', forFinal];   // T-0155
    if (body.body) args.push('--body', String(body.body).slice(0, 20000));
    if (body.type) args.push('--type', String(body.type).slice(0, 20));
    if (body.priority) args.push('--priority', String(body.priority).slice(0, 20));
    const r = await runTicketsCLI(args);
    if (!r.ok) return json(res, 400, { error: r.stderr || 'propose failed' });
    proposeDedupeRemember(body.by, body.title, r.stdout);                    // [new] T-0116
    audit(sess, { action: 'ticket-propose', title: String(body.title).slice(0, 120) }, true);    // [new] T-0015; T-0057: humans too
    const newId = (String(r.stdout).match(/T-\d{4}/) || [])[0], standing = sid && newId ? await standingApprove(newId, sid, sess) : undefined;   // T-0200
    return json(res, 201, { ok: true, message: r.stdout, standing });
  }

  if (url.pathname === '/api/proposals' && method === 'POST') {             // [new] T-0047: structured proposal, mainly for agents
    if (!TICKETS_WRITE_ENABLED) return json(res, 501, { error: 'tickets integration not configured' });
    const body = await parseBody(req, sess).catch(() => null);
    if (!sess?.username) return json(res, 401, { error: 'login first' });
    const title = String(body?.title || '').trim().slice(0, 100), text = String(body?.body || '').trim().slice(0, 4000), reason = String(body?.reason || '').trim().slice(0, 1000);
    if (title.length < 4) return json(res, 400, { error: 'title required (4 to 100 characters)' });
    if (tagsContradict(title) || (sess.agent && ticketTags({ title }).includes('human'))) return json(res, 400, { error: 'contradictory tags: an agent proposal is [agent]; it cannot also be [human]' });   // T-0145
    if (!text) return json(res, 400, { error: 'body required: what exactly should be done' });
    const full = `${text}${reason ? `\n\nWhy: ${reason}` : ''}\n\nProposed by ${sess.username}${body?.for ? ` for ${String(body.for).slice(0, 24)}` : ''}${body?.room ? ` in #${String(body.room).slice(0, 40)}` : ''}.`;
    const doesV = cleanFor(body?.does); if (doesV === false) return json(res, 400, { error: 'does must be "human" or "agent"' });   // T-0155: who does it (default: an agent, since agents file these)
    const does = doesV || ticketFor({ title }) || (sess.agent ? 'agent' : '');
    const sid = standingCited(body?.standing, title); if (sid === false) return json(res, 400, { error: 'standing must name a standing approval, like S-1' });   // T-0200
    const r = await runTicketsCLI(['propose', '--by', sess.username, '--title', title.replace(/^(\[agent\]\s*)+/i, ''), '--for', does, '--body', full, '--type', ['task', 'bug', 'security', 'idea'].includes(body?.type) ? body.type : 'task', '--priority', ['low', 'medium', 'high'].includes(body?.priority) ? body.priority : 'medium']);
    if (!r.ok) return json(res, 400, { error: r.stderr || 'propose failed' });
    const id = (String(r.stdout).match(/T-\d{4}/) || [])[0] || null;
    audit(sess, { action: 'proposal', id, title: title.slice(0, 120) }, true);
    notify('tickets');
    const standing = sid && id ? await standingApprove(id, sid, sess) : undefined;   // T-0200
    return json(res, 201, { ok: true, id, message: r.stdout.trim(), standing });
  }
  // T-0199: requests from the business side. A request becomes a proposed ticket on the team's board, titled [request] so it stands
  // out, with who-does-it left open for the team to decide. Whoever sent it sees only their own requests: the status in plain words and
  // the closing note or the reason, never the chat, the run log, the code or anyone else's tickets.
  // T-0207: drafts for requests. An agent takes the oldest waiting request, writes its draft; a person adds it to the ticket.
  if (url.pathname === '/api/drafts/next' && method === 'GET') {
    if (!askIsAgent(sess)) return json(res, 403, { error: 'agents write drafts; people decide' });
    const ws = reqScope.getStore()?.ws;
    if (!draftsOn(ws)) return json(res, 200, { job: null, off: true });
    const bs = accounts.enabled ? budgetState(accounts.workspaceOf(sess)) : null;
    if (bs && bs.agentOver(sess.username)) return json(res, 200, { job: null, budget: true });
    const t = draftWaiting()[0]; if (!t) return json(res, 200, { job: null });
    const r = await runTicketsCLI(['meta', t.id, '--by', sess.username, '--set', 'draft_job', '--json', JSON.stringify({ state: 'taken', by: sess.username, at: Date.now(), tries: (t.draft_job.tries || 0) + 1 })]);
    if (!r.ok) return json(res, 200, { job: null });
    audit(sess, { action: 'draft-take', ticket: t.id });
    return json(res, 200, { job: { ticket: t.id, title: String(t.title || '').replace(/^\[request\]\s*/i, ''), body: String(t.body || ''), by: t.proposed_by, files: requestFiles(t.id).map(fileMeta) } });
  }
  const draftM = url.pathname.match(/^\/api\/tickets\/(T-\d{4})\/draft(\/use)?$/);
  if (draftM && method === 'POST' && !draftM[2]) {
    if (!askIsAgent(sess)) return json(res, 403, { error: 'agents write drafts; people decide' });
    const body = await parseBody(req, sess).catch(() => null), lc = s => String(s || '').toLowerCase();
    const t = (loadTickets().tickets || []).find(x => x.id === draftM[1]); if (!t) return json(res, 404, { error: 'no such ticket' });
    const job = t.draft_job || {};
    if (t.type !== 'request' || t.draft || job.state !== 'taken' || lc(job.by) !== lc(sess.username)) return json(res, 409, { error: 'this request is not waiting for a draft from this agent' });
    const meta = (k, v) => runTicketsCLI(['meta', t.id, '--by', sess.username, '--set', k, '--json', JSON.stringify(v)]);
    if (body?.failed) {
      await meta('draft_job', { state: 'failed', by: sess.username, at: Date.now(), tries: job.tries || 1, why: String(body.failed).slice(0, 300) });
      audit(sess, { action: 'draft-failed', ticket: t.id, why: String(body.failed).slice(0, 200) }); notify('tickets');
      return json(res, 200, { ok: true });
    }
    const clean = (v, max) => String(v == null ? '' : v).replace(/\r/g, '').trim().slice(0, max);
    const d = { understood: clean(body?.understood, 600), plan: clean(body?.plan, 2000), touches: clean(body?.touches, 600), risk: ['low', 'medium', 'high'].includes(lc(body?.risk)) ? lc(body.risk) : null, risk_why: clean(body?.risk_why, 300),
                who: ['person', 'agent'].includes(lc(body?.who)) ? lc(body.who) : null, who_why: clean(body?.who_why, 300), question: clean(body?.question, 500) || null, by: sess.username, at: new Date().toISOString(), model: clean(body?.model, 60) || undefined };
    if (d.understood.length < 10 || d.plan.length < 10 || !d.risk || !d.who) return json(res, 400, { error: 'a draft needs understood, plan, risk (low, medium or high) and who (person or agent)' });
    if (/^none\.?$/i.test(d.question || '')) d.question = null;
    const r = await meta('draft', d); if (!r.ok) return json(res, 400, { error: r.stderr || 'could not save the draft' });
    await meta('draft_job', { state: 'done', by: sess.username, at: Date.now(), tries: job.tries || 1 });
    const u = body?.usage && typeof body.usage === 'object' ? body.usage : null, num = v => typeof v === 'number' && isFinite(v) && v >= 0 && v <= 1e10 ? v : undefined;
    if (u) {                                                                     // what the draft cost: on the ticket (AI usage page, like a worker's run) and toward the AI budget
      const cu = Object.fromEntries(Object.entries({ cost_cents: num(u.cost_cents), tokens_in: num(u.tokens_in), tokens_out: num(u.tokens_out) }).filter(([, v]) => v !== undefined));
      if (Object.keys(cu).length) await runTicketsCLI(['log', t.id, '--by', sess.username, '--usage', JSON.stringify(cu)]);
      if (typeof cu.cost_cents === 'number' && cu.cost_cents <= 1e7) { try { fs.appendFileSync(path.join(path.dirname(F().data), 'usage-log.jsonl'), JSON.stringify({ ts: Date.now(), agent: sess.username, ticket: t.id, cents: cu.cost_cents }) + '\n', { mode: 0o600 }); } catch (e) { console.error('[usage] log failed:', e.message); } }
    }
    audit(sess, { action: 'ticket-draft', ticket: t.id, risk: d.risk, who: d.who, question: !!d.question }); notify('tickets');
    return json(res, 201, { ok: true });
  }
  if (draftM && method === 'POST' && draftM[2]) {                               // a person adds the agent's draft to the ticket
    if (!sess?.username || askIsAgent(sess) || loadData().users[sess.username]?.role !== 'human') return json(res, 403, { error: 'a person decides what goes into the ticket; an agent cannot' });
    const t = (loadTickets().tickets || []).find(x => x.id === draftM[1]); if (!t || !t.draft) return json(res, 404, { error: 'there is no draft on that ticket' });
    if (t.status !== 'proposed') return json(res, 409, { error: 'only a ticket that still waits for approval can take the draft' });
    if (t.draft.used) return json(res, 409, { error: `the draft was already added by ${t.draft.used.by}` });
    const d = t.draft, who = ticketFor(t) || (d.who === 'agent' ? 'agent' : 'human');
    const block = `\n\n---\nPlan drafted by ${d.by} (an AI agent), added by ${sess.username}:\n\nWhat is wanted: ${d.understood}\n\nPlan:\n${d.plan}\n\nWould touch: ${d.touches || 'not sure'}\nRisk: ${d.risk}${d.risk_why ? ' - ' + d.risk_why : ''}`;
    const args = ['edit', t.id, '--by', sess.username, '--body', (String(t.body || '') + block).slice(0, 20000)]; if (!ticketFor(t)) args.push('--for', who);
    const r = await runTicketsCLI(args); if (!r.ok) return json(res, 400, { error: r.stderr || 'could not add the draft' });
    await runTicketsCLI(['meta', t.id, '--by', sess.username, '--set', 'draft', '--json', JSON.stringify({ ...d, used: { by: sess.username, at: new Date().toISOString() } })]);
    audit(sess, { action: 'ticket-draft-used', ticket: t.id }, true); notify('tickets');
    return json(res, 200, { ok: true, for: who });
  }
  // ── T-0216: a person asks the client a question on their request; the client answers on their Your requests page ──────────
  // One question at a time, in a person's own words or the agent's drafted question sent by a person's tap. The client sees it under
  // that request (and gets one short email under the T-0205 rules), types an answer there, and the answer lands on the ticket as a
  // note. The person who asked is told in the ticket's room. An agent can neither send a question nor read an answer as an instruction.
  const cqM = url.pathname.match(/^\/api\/tickets\/(T-\d{4})\/question$/);
  if (cqM && method === 'POST') {
    if (!TICKETS_WRITE_ENABLED) return json(res, 501, { error: 'tickets are not switched on in this Chamber' });
    if (!sess?.username || askIsAgent(sess) || loadData().users[sess.username]?.role !== 'human') return json(res, 403, { error: 'a person sends a question to the requester; an agent cannot' });
    const body = await parseBody(req, sess).catch(() => null), id = cqM[1], lc = s => String(s || '').toLowerCase();
    const t = (loadTickets().tickets || []).find(x => x.id === id); if (!t) return json(res, 404, { error: 'no such ticket' });
    if (t.type !== 'request') return json(res, 409, { error: 'Only a request (sent from a Your requests page) can take a question for the person who sent it.' });
    if (!['proposed', 'approved', 'in_progress'].includes(t.status)) return json(res, 409, { error: `${id} is finished (${t.status}), so it takes no more questions.` });
    const list = Array.isArray(t.client_questions) ? t.client_questions : [];
    if (list.some(q => !q.answer)) return json(res, 409, { error: `One question at a time: ${t.proposed_by} has not answered the last one yet.` });
    if (list.length >= 10) return json(res, 409, { error: 'This request already had 10 questions. Talk to them directly, or ask them to send a new request.' });
    const text = String(body?.fromDraft ? (t.draft && t.draft.question) || '' : body?.text || '').replace(/\r/g, '').trim();
    if (body?.fromDraft && !text) return json(res, 400, { error: 'The agent\'s draft has no question to send.' });
    if (text.length < 5 || text.length > 1000) return json(res, 400, { error: 'Write the question in 5 to 1000 characters.' });
    const q = { n: list.length + 1, text, by: sess.username, at: new Date().toISOString(), fromDraft: body?.fromDraft ? true : undefined };
    const r = await runTicketsCLI(['meta', id, '--by', sess.username, '--set', 'client_questions', '--json', JSON.stringify([...list, q])]);
    if (!r.ok) return json(res, 400, { error: r.stderr || 'could not send the question' });
    await runTicketsCLI(['update', id, '--by', sess.username, '--note', `QUESTION for the requester (${t.proposed_by}): ${text}`]);
    const ws = reqScope.getStore()?.ws, who = accounts.enabled ? accounts.requestMailFor(ws, t.proposed_by) : null; let mailed = false;
    if (who && who.wanted && who.confirmed && lc(who.username) !== lc(sess.username)) {                 // one short email, the same rules as T-0205
      const title = String(t.title || '').replace(/^\[request\]\s*/i, '').replace(/\s+/g, ' ').slice(0, 120), base = (process.env.CHAMBER_PUBLIC_URL || '').replace(/\/$/, ''), wsName = accounts.workspaceName(ws);
      const m = { subject: `Chamber: the team has a question about your request "${title}"`,
        text: `Hello ${who.username},\n\nThe team has a question about your request "${title}" (${id})${wsName ? ' in ' + wsName : ''}:\n\n${text}\n\nAnswer it here: ${base}/requests\n\nYou get this email because you sent this request in Chamber. To stop these emails, open that page and untick "Email me when one of my requests moves".\n` };
      if (TEST_HOOKS) console.log(`[request-mail] to ${who.email}: ${JSON.stringify(m)}`);
      if (mail.enabled) mail.send({ to: who.email, subject: m.subject, text: m.text }).catch(e => console.error('[request-mail] failed:', e.message));
      mailed = true;
    }
    audit(sess, { action: 'request-question', ticket: id, n: q.n, from_draft: q.fromDraft, mailed }, true); notify('tickets');
    return json(res, 200, { ok: true, question: q, mailed });
  }
  if (url.pathname === '/api/requests/answer' && method === 'POST') {
    if (!sess?.username || sess.agent) return json(res, 403, { error: 'for people' });
    if (!TICKETS_WRITE_ENABLED) return json(res, 501, { error: 'tickets are not switched on in this Chamber' });
    const body = await parseBody(req, sess).catch(() => null), lc = s => String(s || '').toLowerCase(), id = String(body?.id || '').toUpperCase();
    const t = /^T-\d{4}$/.test(id) ? (loadTickets().tickets || []).find(x => x.id === id && lc(x.proposed_by) === lc(sess.username)) : null;
    if (!t) return json(res, 404, { error: 'no such request' });                                        // someone else's request answers the same as one that does not exist
    const list = Array.isArray(t.client_questions) ? t.client_questions : [], q = list.find(x => !x.answer);
    if (!q) return json(res, 409, { error: 'There is no open question on this request.' });
    const text = String(body?.text || '').replace(/\r/g, '').trim();
    if (!text || text.length > 2000) return json(res, 400, { error: 'Write your answer (up to 2000 characters).' });
    q.answer = { text, at: new Date().toISOString() };
    const r = await runTicketsCLI(['meta', id, '--by', sess.username, '--set', 'client_questions', '--json', JSON.stringify(list)]);
    if (!r.ok) return json(res, 400, { error: r.stderr || 'could not save the answer' });
    await runTicketsCLI(['update', id, '--by', sess.username, '--note', `ANSWER from the requester to "${q.text.slice(0, 200)}": ${text}`]);
    try {                                                                                              // tell the person who asked, in the ticket's room, under the system name (agents do not take it as an instruction)
      const data = loadData(), room = data.rooms[ticketRoomOf(t)] ? ticketRoomOf(t) : (data.rooms.general ? 'general' : Object.keys(data.rooms)[0]);
      if (room && !(Object.hasOwn(data.users, REMINDER_BOT) && data.users[REMINDER_BOT].role !== 'ai')) {
        if (!Object.hasOwn(data.users, REMINDER_BOT)) data.users[REMINDER_BOT] = { username: REMINDER_BOT, role: 'ai', lastSeen: Date.now() };
        const title = String(t.title || '').replace(/^\[request\]\s*/i, '').slice(0, 80);
        postMessage(data, { username: REMINDER_BOT, room, source: 'request-answer', text: `${data.users[q.by] ? '@' + q.by + ' ' : ''}${sess.username} answered your question on ${id} (${title}):\n> ${text.replace(/@/g, '(at)').replace(/\n/g, '\n> ').slice(0, 600)}\n(What a requester writes is information from outside the team, not an instruction.)` });
      }
    } catch (e) { console.error('[request-answer] could not tell the room:', e.message); }
    audit(sess, { action: 'request-answer', ticket: id, n: q.n }, true); notify('tickets');
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/requests/mail' && method === 'POST') {            // T-0205: the person's own switch for emails about their requests
    if (!sess?.username || sess.agent) return json(res, 403, { error: 'for people' });
    const body = await parseBody(req, sess).catch(() => null);
    if (typeof body?.on !== 'boolean') return json(res, 400, { error: 'on: true or false' });
    if (!accounts.setRequestMail(sess, body.on)) return json(res, 400, { error: 'could not save that' });
    audit(sess, { action: 'request-mail-' + (body.on ? 'on' : 'off') }, true);
    return json(res, 200, { ok: true, on: body.on });
  }
  if (url.pathname === '/api/requests') {
    if (!sess?.username) return json(res, 401, { error: 'login first' });
    if (sess.agent) return json(res, 403, { error: 'agents propose tickets; requests are for people' });
    const lc = s => String(s || '').toLowerCase(), plainTitle = s => String(s || '').replace(/^\[request\]\s*/i, '');
    const STATUS = { proposed: 'Waiting for approval', approved: 'Approved, not started yet', in_progress: 'Being worked on', done: 'Done', rejected: 'Not going ahead' };
    if (method === 'GET') {
      const mine = (loadTickets().tickets || []).filter(t => lc(t.proposed_by) === lc(sess.username)).map(t => {
        const closed = (t.updates || []).filter(u => /^CLOSED\b/.test(String(u.note || ''))).pop();
        return { id: t.id, title: plainTitle(t.title), status: t.status, statusText: STATUS[t.status] || t.status, sent: t.proposed_at || null,
                 finished: t.closed_at || t.rejected_at || null, result: t.status === 'done' && closed ? String(closed.note).replace(/^CLOSED:?\s*/, '').slice(0, 2000) : null,
                 reason: t.status === 'rejected' ? String(t.reject_reason || '').slice(0, 1000) : null,
                 files: requestFiles(t.id).map(f => ({ id: f.id, name: f.name, size: f.size, mime: f.mime, url: '/api/requests/files/' + f.id })),   // T-0206
                 questions: (Array.isArray(t.client_questions) ? t.client_questions : []).map(q => ({ n: q.n, text: q.text, at: q.at, answer: q.answer ? { text: q.answer.text, at: q.answer.at } : null })) };   // T-0216: what the team asked on this request, and what they answered
      });
      const rm = accounts.requestMailFor(reqScope.getStore()?.ws, sess.username);   // T-0205: their email switch
      return json(res, 200, { requests: mine.reverse(), max_files: REQUEST_FILES_MAX, max_file_mb: MAX_FILE_MB, mail: { on: rm ? rm.wanted : true, confirmed: rm ? rm.confirmed : true, set_up: mail.enabled } });
    }
    if (method === 'POST') {
      if (!TICKETS_WRITE_ENABLED) return json(res, 501, { error: 'tickets are not switched on in this Chamber' });
      const body = await parseBody(req, sess).catch(() => null);
      const title = String(body?.title || '').replace(/\s+/g, ' ').trim(), text = String(body?.body || '').trim();
      if (title.length < 3 || title.length > 120) return json(res, 400, { error: 'Say what you need in 3 to 120 characters.' });
      if (text.length > 4000) return json(res, 400, { error: 'Details: at most 4000 characters.' });
      const fileIds = Array.isArray(body?.files) ? [...new Set(body.files.map(String))] : [];   // T-0206
      if (fileIds.length > REQUEST_FILES_MAX) return json(res, 400, { error: `At most ${REQUEST_FILES_MAX} files per request.` });
      if (fileIds.some(fid => { const f = /^[a-f0-9]{24}$/.test(fid) ? store.fileGet(F().data, fid) : null; return !f || f.msg_id || f.room !== REQ_PENDING || lc(f.by) !== lc(sess.username); })) return json(res, 400, { error: 'One of the files could not be found. Add it again and send once more.' });
      const r = await runTicketsCLI(['propose', '--by', sess.username, '--title', '[request] ' + plainTitle(title), '--body', text, '--type', 'request', '--priority', 'normal']);
      if (!r.ok) return json(res, 400, { error: r.stderr || 'could not send the request' });
      const id = (String(r.stdout).match(/T-\d+/) || [])[0] || null;
      if (id && fileIds.length) store.filesAttach(F().data, fileIds, 'req:' + id, id);   // T-0206: from now on they belong to this request
      audit(sess, { action: 'request', ticket: id, files: fileIds.length || undefined }, true);
      if (id && draftsOn(reqScope.getStore()?.ws)) { await runTicketsCLI(['meta', id, '--by', sess.username, '--set', 'draft_job', '--json', JSON.stringify({ state: 'waiting', at: Date.now() })]); notify('tickets'); }   // T-0207: a connected agent drafts a plan for it
      return json(res, 200, { ok: true, id });
    }
    return json(res, 405, { error: 'GET or POST' });
  }
  if (url.pathname === '/api/usage' && method === 'GET') {                   // T-0194: what the agents' work cost and how long it took
    if (!sess?.username) return json(res, 401, { error: 'login first' });
    if (sess.agent) return json(res, 403, { error: 'for people' });
    const days = Math.min(366, Math.max(1, parseInt(url.searchParams.get('days'), 10) || 28)), since = Date.now() - days * 864e5, data = loadData();
    const zero = () => ({ answers: 0, cents: 0, ms: 0, tokens_in: 0, tokens_out: 0, no_cost: 0 });
    const add = (map, k, r) => { const x = map[k] || (map[k] = zero()); x.answers++; if (typeof r.cost_cents === 'number' && isFinite(r.cost_cents)) x.cents += r.cost_cents; else x.no_cost++; x.ms += Number(r.ms) || 0; x.tokens_in += Number(r.tokens_in) || 0; x.tokens_out += Number(r.tokens_out) || 0; };
    const weekOf = ts => { const d = new Date(ts); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); };
    const byAgent = {}, byWeek = {}, byTicket = {}, total = {};
    for (const m of store.runsSince(F().data, since)) {                         // only rooms this person can see
      if (!m.run || m.run.state === 'running' || !canSeeRoom(data, m.room, sess.username)) continue;
      add(total, 'all', m.run); add(byAgent, m.username, m.run); add(byWeek, weekOf(m.ts), m.run);
      for (const id of new Set(String(m.text || '').match(/T-\d{4}/g) || [])) add(byTicket, id, m.run);
    }
    const tickets = loadTickets().tickets || [], titles = Object.fromEntries(tickets.map(t => [t.id, t.title]));
    for (const t of tickets) if (t.usage && t.usage.runs) { const x = byTicket[t.id] || (byTicket[t.id] = zero()); x.worker = t.usage; }   // the ticket worker reports its own runs on the ticket (all time)
    const r2 = o => { for (const v of Object.values(o)) v.cents = Math.round(v.cents * 100) / 100; return o; };
    const top = Object.entries(r2(byTicket)).sort((a, b) => ((b[1].cents + (b[1].worker?.cost_cents || 0)) - (a[1].cents + (a[1].worker?.cost_cents || 0)))).slice(0, 30).map(([id, v]) => ({ id, title: titles[id] || null, ...v }));
    return json(res, 200, { days, since, total: r2(total).all || zero(), byAgent: r2(byAgent), byWeek: r2(byWeek), tickets: top,
      note: 'Cost as the AI tool reports it. With a Claude subscription this is what the same work would cost at API prices, not what you are billed. Answers that report no cost (local models) are counted separately.' });
  }
  // T-0204: an evidence pack. For one ticket, or for the tickets closed in a date range: the request, who approved it and when, the
  // plain-words summary, the change (every version for a single ticket), the comments, the run log, every command the agents ran in
  // answers that name the ticket (with output and exit codes), the result, and the entries of the tamper-evident record (T-0194) about
  // it. Sealed with a SHA-256 over the whole pack; tools/verify-pack.js checks the seal and, given a full record export, that every
  // entry is in the workspace's record. A readable page (?format=html) and the data (?format=json). No claim of meeting any standard.
  const evidenceM = url.pathname.match(/^\/api\/tickets\/(T-\d{4})\/evidence$/);
  if ((evidenceM || url.pathname === '/api/evidence') && method === 'GET') {
    if (!sess?.username) return json(res, 401, { error: 'login first' });
    if (sess.agent) return json(res, 403, { error: 'evidence packs are for people' });
    const all = loadTickets().tickets || [], at = s => Date.parse(s || ''); let pick, range = null;
    if (evidenceM) { const t = all.find(x => x.id === evidenceM[1]); if (!t) return json(res, 404, { error: 'no such ticket' }); pick = [t]; }
    else {
      const f = url.searchParams.get('from'), tt = url.searchParams.get('to');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(f || '') || !/^\d{4}-\d{2}-\d{2}$/.test(tt || '')) return json(res, 400, { error: 'from and to are dates like 2026-11-01' });
      const a = Date.parse(f + 'T00:00:00Z'), b = Date.parse(tt + 'T00:00:00Z') + 864e5;
      if (!(b > a) || b - a > 367 * 864e5) return json(res, 400, { error: 'the range is 1 day to 1 year, from before to' });
      range = { from: f, to: tt }; pick = all.filter(t => t.status === 'done' && at(t.closed_at) >= a && at(t.closed_at) < b).slice(0, 200);
    }
    const dir = path.dirname(F().data), data = loadData(), ids = new Set(pick.map(t => t.id)), single = !!evidenceM;
    const record = auditAll(dir).filter(e => e.ticket && ids.has(e.ticket));
    const earliest = Math.min(...pick.map(t => at(t.proposed_at)).filter(isFinite), Date.now());
    const runs = store.runsSince(F().data, earliest - 864e5).filter(m => m.run && canSeeRoom(data, m.room, sess.username));
    const rf = p => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }, rj = p => { try { return JSON.parse(rf(p) || 'null'); } catch { return null; } };
    const closeNote = t => { const c = (t.updates || []).filter(u => /^CLOSED\b/.test(u.note || '')).pop(); return c ? String(c.note).replace(/^CLOSED:?\s*/, '') : null; };
    const asksAll = loadAsks().items;                                          // T-0212: questions an agent asked a person while working a ticket
    const tickets = pick.map(t => {
      const meta = rj(path.join(diffDir(), t.id + '.json')), cur = meta && Number.isInteger(meta.version) ? meta.version : (meta ? 1 : 0), versions = [];
      if (cur) for (let v = 1; v <= cur; v++) { if (!single && v < cur) continue; const m = v === cur ? meta : rj(path.join(diffDir(), `${t.id}.v${v}.json`)) || {}, d = rf(path.join(diffDir(), v === cur ? t.id + '.patch' : `${t.id}.v${v}.patch`)); versions.push({ version: v, by: m.by || null, at: m.at || null, files: m.files || [], added: m.added || 0, removed: m.removed || 0, plain: m.plain || null, diff: d }); }
      const mine = runs.filter(m => String(m.text || '').includes(t.id)).slice(-50).map(m => ({ at: m.ts, agent: m.username, room: m.room, answer: String(m.text || '').slice(0, 2000), model: m.run.model || null, state: m.run.state, tokens_in: m.run.tokens_in ?? null, tokens_out: m.run.tokens_out ?? null, ms: m.run.ms ?? null, cost_cents: m.run.cost_cents ?? null, commands: (m.run.tools || []).map(x => ({ tool: x.tool, input: x.input, output: x.out ?? null, exit: x.exit ?? null, error: !!x.error })) }));
      return { id: t.id, title: t.title, request: t.body || '', type: t.type, priority: t.priority, for: t.for || null, status: t.status,
        proposed: { by: t.proposed_by, at: t.proposed_at }, approvals: Array.isArray(t.approvals) && t.approvals.length ? t.approvals : (t.approved_by ? [{ by: t.approved_by, at: t.approved_at }] : []), approved_at: t.approved_at || null,
        rejected: t.rejected_by ? { by: t.rejected_by, at: t.rejected_at, reason: t.reject_reason } : null, reviewer: t.reviewer || null, standing: t.standing || null, standing_was: t.standing_was || null, worked_by: t.assignee || null, claimed_at: t.claimed_at || null,
        closed: t.closed_by ? { by: t.closed_by, at: t.closed_at } : null, result: closeNote(t), applied: t.applied || null, reverts: t.reverts || null,
        change: cur ? { current_version: cur, versions } : null, comments: (rj(path.join(diffDir(), t.id + '.comments.json')) || []).filter(c => single || c.version === cur),
        history: t.updates || [], run_log: t.log || [], worker_usage: t.usage || null, agent_runs: mine,
        request_files: requestFiles(t.id).map(f => ({ name: f.name, bytes: f.size, sha256: f.sha256 || null, by: f.by, at: new Date(f.ts).toISOString() })),   // T-0206
        questions: asksAll.filter(a => a.ticket === t.id).map(a => ({ id: a.id, agent: a.agent, tool: a.tool, what: a.summary, asked_at: a.at, status: a.status, answered_by: a.answeredBy || null, answered_at: a.answeredAt || null, via: a.via || null, result: a.result || null, scope: a.scope || null, runs: a.scope === 'job' ? 1 + (a.uses || []).length : undefined, more_runs: a.scope === 'job' ? (a.uses || []).map(u => ({ at: u.at, result: u.result || null })) : undefined })), record: record.filter(e => e.ticket === t.id).slice(-500) };
    });
    const chk = verifyAudit(dir), pack = { kind: 'chamber-evidence', version: 1, workspace: accounts.enabled ? accounts.workspaceName(accounts.workspaceOf(sess)) : null, generated_at: new Date().toISOString(), generated_by: sess.username,
      scope: single ? { ticket: evidenceM[1] } : range, record_check: { intact: chk.ok, entries_checked: chk.checked, newest_check_value: chk.head || null, problem: chk.ok ? null : chk.reason },
      note: 'A record of what Chamber saw. It does not by itself show that anything meets a law or a standard.', tickets };
    pack.seal = { sha256: crypto.createHash('sha256').update(JSON.stringify(pack)).digest('hex'), how: 'node tools/verify-pack.js <this file> [full record export] (in the Chamber source) checks it without the server' };
    audit(sess, { action: 'evidence-pack', ticket: single ? evidenceM[1] : undefined, range: range ? `${range.from}..${range.to}` : undefined, tickets: tickets.length }, true);
    const fname = `chamber-evidence-${single ? evidenceM[1] : `${range.from}_${range.to}`}`;
    if (url.searchParams.get('format') === 'json') { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': `attachment; filename="${fname}.json"`, 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(pack, null, 1)); }
    const E = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])), when = s => s ? new Date(typeof s === 'number' ? s : Date.parse(s)).toUTCString().replace(' GMT', ' UTC') : '';
    const sec = t => `<section><h2>${E(t.id)}: ${E(t.title)}</h2><table>
<tr><th>Status</th><td>${E(t.status)}</td></tr><tr><th>Asked for</th><td>by ${E(t.proposed.by)}, ${E(when(t.proposed.at))}</td></tr>
<tr><th>Approved</th><td>${t.approvals.length ? t.approvals.map(a => `${E(a.by)}, ${E(when(a.at))}${a.standing ? `, in advance by standing approval ${E(a.standing)}${t.standing && t.standing.what ? ` (${E(t.standing.what)})` : ''}` : ''}`).join('<br>') : 'not approved'}</td></tr>
${t.rejected ? `<tr><th>Turned down</th><td>by ${E(t.rejected.by)}, ${E(when(t.rejected.at))}: ${E(t.rejected.reason)}</td></tr>` : ''}<tr><th>Done by</th><td>${E(t.worked_by || '')}${t.closed ? `; closed by ${E(t.closed.by)}, ${E(when(t.closed.at))}` : ''}</td></tr>
${t.applied ? `<tr><th>Applied</th><td>branch ${E(t.applied.branch)} ${E(t.applied.sha)} by ${E(t.applied.by)}</td></tr>` : ''}</table>
<h3>The request</h3><pre>${E(t.request)}</pre>${t.request_files.length ? `<h3>Files sent with the request</h3><ul>${t.request_files.map(f => `<li>${E(f.name)} (${f.bytes} bytes, by ${E(f.by)}, SHA-256 ${E(f.sha256 || 'not recorded')})</li>`).join('')}</ul>` : ''}${t.result ? `<h3>The result</h3><pre>${E(t.result)}</pre>` : ''}
${t.change ? `<h3>The change (version ${t.change.current_version})</h3>${t.change.versions.map(v => `<div class="v"><b>Version ${v.version}</b> by ${E(v.by)} ${E(when(v.at))}: ${v.files.map(E).join(', ')} (+${v.added} -${v.removed})${v.plain ? `<div>In plain words: ${E(v.plain.what || '')} ${v.plain.risk ? 'Risk: ' + E(v.plain.risk) : ''}</div>` : ''}<pre>${E(v.diff || '')}</pre></div>`).join('')}` : ''}
${t.comments.length ? `<h3>Review comments</h3><ul>${t.comments.map(c => `<li>${E(c.by)} on version ${c.version}, line ${c.line}${c.file ? ' of ' + E(c.file) : ''}: ${E(c.text)}</li>`).join('')}</ul>` : ''}
${t.agent_runs.length ? `<h3>What the agents ran (${t.agent_runs.length} answer${t.agent_runs.length === 1 ? '' : 's'} naming ${E(t.id)})</h3>${t.agent_runs.map(r => `<div class="v"><b>${E(r.agent)}</b> ${E(when(r.at))}${r.model ? ', ' + E(r.model) : ''}${r.cost_cents != null ? `, $${(r.cost_cents / 100).toFixed(2)}` : ''}${r.commands.length ? r.commands.map(c => `<pre>$ ${E(c.tool)}: ${E(c.input)}${c.exit != null ? `   (exit ${E(c.exit)})` : ''}\n${E(c.output || '')}</pre>`).join('') : '<div class="dim">no commands recorded</div>'}</div>`).join('')}` : ''}
${t.questions.length ? `<h3>Questions the agent asked a person</h3>${t.questions.map(q => `<div class="v"><b>${E(q.id)}</b> ${E(when(q.asked_at))}: ${E(q.agent)} asked to ${E(q.what)}<div>${q.status === 'allowed' ? (q.scope === 'job' ? `Allowed for this job by ${E(q.answered_by)}; it ran ${q.runs} time${q.runs === 1 ? '' : 's'} under this answer` : `Allowed once by ${E(q.answered_by)}`) : q.status === 'denied' ? `${E(q.answered_by)} said no` : q.status === 'expired' ? 'No answer in time: not allowed' : q.status === 'cancelled' ? 'Withdrawn before anyone answered' : 'Waiting for an answer'}${q.via ? ' (from the notification)' : ''}${q.answered_at ? ', ' + E(when(q.answered_at)) : ''}${q.result ? `. It ${q.result.ok ? 'worked' : 'failed'}.` : ''}</div>${q.result && q.result.output ? `<pre>${E(q.result.output)}</pre>` : ''}${(q.more_runs || []).map((u, i) => `<div>Run ${i + 2}, ${E(when(u.at))}${u.result ? `: it ${u.result.ok ? 'worked' : 'failed'}.` : ''}</div>${u.result && u.result.output ? `<pre>${E(u.result.output)}</pre>` : ''}`).join('')}</div>`).join('')}` : ''}
${t.run_log.length ? `<h3>Run log</h3><pre>${t.run_log.map(l => `${when(l.at)}  ${l.by}: ${l.line}`).map(E).join('\n')}</pre>` : ''}
<h3>History</h3><pre>${t.history.map(u => `${when(u.at)}  ${u.by}: ${u.note}`).map(E).join('\n')}</pre>
<h3>Entries in the activity record</h3><pre>${t.record.map(e => `#${e.n ?? '-'} ${when(e.ts)} ${e.actor || e.agent} ${e.action}${e.h ? '  check ' + e.h.slice(0, 16) : ''}`).map(E).join('\n') || 'none'}</pre></section>`;
    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Evidence pack · ${E(single ? evidenceM[1] : range.from + ' to ' + range.to)}</title>
<style>body{margin:0;background:#fff;color:#1b1f1d;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:900px;margin:0 auto;padding:24px 16px 48px}h1{font-size:20px;margin:0}h2{font-size:17px;margin:30px 0 8px;border-top:2px solid #1b1f1d;padding-top:10px}h3{font-size:14px;margin:16px 0 4px}table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:4px 6px;border-bottom:1px solid #e3e8e5}th{width:120px;color:#5b665f;font-weight:600}pre{background:#f4f6f5;border:1px solid #e3e8e5;padding:8px;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}.v{margin:8px 0}.dim{color:#5b665f}</style></head><body><main>
<h1>Evidence pack: ${E(single ? evidenceM[1] : `tickets closed ${range.from} to ${range.to}`)}</h1><div class="dim">${E(pack.workspace || '')} · made ${E(when(pack.generated_at))} by ${E(pack.generated_by)} · ${tickets.length} ticket${tickets.length === 1 ? '' : 's'}</div>
<p class="dim">Activity record: ${chk.ok ? `intact (${chk.checked} entries checked)` : 'NOT intact: ' + E(chk.reason)}. ${E(pack.note)}</p>
${tickets.map(sec).join('') || '<p>No tickets in this range.</p>'}
<h2>Seal</h2><p>SHA-256 of the data version of this pack: <code>${E(pack.seal.sha256)}</code>. Download the data version (?format=json) and run <code>node tools/verify-pack.js</code> on it to check that nothing in it was changed.</p></main></body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); return res.end(html);
  }
  // T-0197: the GitHub issues link (workspace owner only).
  if (url.pathname === '/api/github-link' || url.pathname === '/api/github-link/remove') {
    const owner = accounts.enabled && !askIsAgent(sess) && accounts.sessionRole(sess) === 'owner';
    if (!owner) return json(res, 403, { error: 'Only the workspace owner can link or unlink a GitHub repository.' });
    if (url.pathname === '/api/github-link' && method === 'GET') {
      const l = ghLoad();
      return json(res, 200, l ? { linked: true, repo: l.repo, label: l.label, by: l.by, at: l.at, lastSync: l.lastSync || null, lastError: l.lastError || null, issues: Object.keys(l.issues || {}).length } : { linked: false });
    }
    if (method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const body = await parseBody(req, sess).catch(() => null);
    if (url.pathname === '/api/github-link/remove') {
      const l = ghLoad(); if (!l) return json(res, 404, { error: 'No GitHub repository is linked.' });
      fs.unlinkSync(ghLinkPath()); audit(sess, { action: 'github-unlink', repo: l.repo }, true);
      return json(res, 200, { ok: true, linked: false, message: `Unlinked ${l.repo}. The key is deleted; the tickets stay, and Chamber no longer reads or writes that repository.` });
    }
    const repo = String(body?.repo || '').trim().replace(/^https:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, ''), label = String(body?.label || 'chamber').trim(), key = String(body?.token || '').trim();
    if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/.test(repo) || repo.split('/').some(p => /^\.+$/.test(p))) return json(res, 400, { error: 'Write the repository as owner/name, for example acme/shop.' });   // review 2026-11-13: "../.." passed and pointed the key at other GitHub addresses
    if (!label || label.length > 50 || /[,\n]/.test(label)) return json(res, 400, { error: 'The label is one GitHub label name (no commas), up to 50 characters.' });
    if (key.length < 20 || key.length > 255 || /\s/.test(key)) return json(res, 400, { error: 'Paste the GitHub key (a fine-grained token starts with github_pat_).' });
    const a = await ghCall(key, 'GET', `/repos/${repo}`).catch(e => ({ status: 0, data: { message: e.message } }));
    if (a.status !== 200) return json(res, 400, { error: a.status === 401 ? 'GitHub did not accept that key. Nothing was saved.' : a.status === 404 ? `GitHub says this key cannot see a repository ${repo}. Nothing was saved.` : `GitHub answered ${a.status || 'nothing'}. Nothing was saved.` });
    const b = await ghCall(key, 'GET', `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=1`).catch(() => ({ status: 0 }));
    if (b.status !== 200) return json(res, 400, { error: 'The key can see the repository but not its issues. Give it Issues: Read and write. Nothing was saved.' });
    ghSave({ repo, label, key: ghSeal(accounts.workspaceOf(sess), key), by: sess.username, at: Date.now(), issues: {} });
    audit(sess, { action: 'github-link', repo, label }, true);
    return json(res, 200, { ok: true, linked: true, repo, label, message: `Linked ${repo}. Open issues with the label "${label}" come in as proposed tickets within a couple of minutes.` });
  }
  // T-0188: asks. The agent's permission helper asks (through its connector); people who may approve answer; the agent records the result.
  if (url.pathname === '/api/asks' && method === 'POST') {
    const body = await parseBody(req, sess).catch(() => null);
    if (!askIsAgent(sess)) return json(res, 403, { error: 'agents ask; people answer' });
    if (!askMayAsk(sess)) return json(res, 403, { error: 'Asking is switched off for this agent. The workspace owner can switch it on: Account, AI agents, "may ask".' });
    const data = loadData(), room = String(body?.room || 'general');
    if (!data.rooms[room] || !canSeeRoom(data, room, sess.username)) return json(res, 404, { error: 'no such room' });
    const tool = String(body?.tool || ''), summary = String(body?.summary || '').trim().slice(0, 2000);
    if (!/^[A-Za-z][\w.-]{0,39}$/.test(tool) || summary.length < 3) return json(res, 400, { error: 'tool and summary (what the agent wants to do, in plain words) are required' });
    const wait = Math.max(process.env.CHAMBER_TEST_HOOKS === '1' ? 1 : ASK_MIN_WAIT, Math.min(ASK_MAX_WAIT, parseInt(body?.waitSec, 10) || 300));
    const d = loadAsks(); askExpire(d);
    const mine = d.items.filter(a => a.agent === sess.username);
    if (mine.filter(a => a.status === 'waiting').length >= ASK_MAX_WAITING) { saveAsks(d); return json(res, 429, { error: `${ASK_MAX_WAITING} questions from this agent are already waiting` }); }
    if (mine.filter(a => Date.parse(a.at) > Date.now() - 3600e3).length >= ASK_PER_HOUR) { saveAsks(d); return json(res, 429, { error: `at most ${ASK_PER_HOUR} questions an hour` }); }
    const who = askAnswerers(sess); if (!who.length) { saveAsks(d); return json(res, 409, { error: 'nobody in this workspace may answer' }); }
    const forU = String(body?.for || '').slice(0, 40), asker = who.find(u => u.toLowerCase() === forU.toLowerCase()), to = asker ? [asker] : who.slice(0, 5);
    const tk = String(body?.ticket || '').toUpperCase(); let tkT = null;                          // T-0212: a ticket worker asks for the ticket it is working on
    if (tk) {
      tkT = /^T-\d{4}$/.test(tk) ? (loadTickets().tickets || []).find(x => x.id === tk) : null;
      if (!tkT || tkT.status !== 'in_progress' || String(tkT.assignee || '').toLowerCase() !== String(sess.username).toLowerCase()) { saveAsks(d); return json(res, 409, { error: 'ticket: an agent can only ask for a ticket it is working on right now' }); }
    }
    const a = { id: 'A-' + d.next, agent: sess.username, room, tool, summary, detail: String(body?.detail || '').slice(0, 4000) || undefined, for: forU || undefined, ticket: tkT ? tk : undefined, canJob: body?.job === true ? true : undefined,   // T-0211: this agent can honour "Allow for this job"
                status: 'waiting', at: new Date().toISOString(), expiresAt: Date.now() + wait * 1000, waitSec: wait };
    d.next++;
    const mins = wait >= 120 ? `${Math.round(wait / 60)} minutes` : `${wait} seconds`;
    const what = tool === 'Bash' ? 'run this command?\n```\n' + summary.replace(/^run this command: /, '') + '\n```' : summary + '?';
    const text = `${to.map(u => '@' + u).join(' ')} ${tkT ? `Working on ${tk} (${String(tkT.title || '').slice(0, 80)}): may I` : 'May I'} ${what}\nAllow once or Deny, above the message box (question ${a.id}). No answer within ${mins} means no.`;
    let made = postMessage(data, { username: sess.username, text, room, reply_to: body?.msg ? String(body.msg) : undefined, source: 'ask:' + a.id });
    if (made.error) made = postMessage(data, { username: sess.username, text, room, source: 'ask:' + a.id });
    a.msgId = made.message?.id; d.items.push(a); saveAsks(d);
    audit(sess, { action: 'ask', ask: a.id, ticket: a.ticket, tool, what: summary.slice(0, 300), room, for: a.for, waitSec: wait });
    notify('asks', { room });
    return json(res, 201, { ok: true, id: a.id, expiresAt: a.expiresAt, answerers: to });
  }
  if (url.pathname === '/api/asks' && method === 'GET') {
    const d = loadAsks(); if (askExpire(d)) saveAsks(d);
    const status = url.searchParams.get('status'), can = askMayAnswer(sess);
    let items = d.items.slice().reverse();
    if (status) items = items.filter(a => a.status === status);
    if (askIsAgent(sess)) items = items.filter(a => a.agent === sess.username);             // an agent sees only its own questions
    return json(res, 200, { asks: items.slice(0, 100).map(a => ({ ...a, canAnswer: can && a.status === 'waiting' })), canAnswer: can });
  }
  const askM = url.pathname.match(/^\/api\/asks\/(A-\d{1,6})(?:\/(answer|result|cancel|use|end))?$/);
  if (askM && method === 'GET' && !askM[2]) {
    const d = loadAsks(); if (askExpire(d)) saveAsks(d);
    const a = d.items.find(x => x.id === askM[1]); if (!a) return json(res, 404, { error: 'no such question' });
    if (askIsAgent(sess) && a.agent !== sess.username) return json(res, 403, { error: 'that question belongs to another agent' });
    return json(res, 200, { ...a, canAnswer: askMayAnswer(sess) && a.status === 'waiting' });
  }
  if (askM && method === 'POST' && askM[2]) {
    const body = await parseBody(req, sess).catch(() => null), d = loadAsks(); askExpire(d);
    const a = d.items.find(x => x.id === askM[1]); if (!a) { saveAsks(d); return json(res, 404, { error: 'no such question' }); }
    if (askM[2] === 'answer') {
      if (!askMayAnswer(sess)) { saveAsks(d); audit(sess, { action: 'ask-answer-refused', ask: a.id }, true); return json(res, 403, { error: 'Only people who may approve tickets here can answer (the owner\'s approval rules).' }); }
      if (a.status !== 'waiting') { saveAsks(d); return json(res, 409, { error: a.status === 'expired' ? `${a.id} was not answered in time, so it was not allowed. The agent can ask again.` : `${a.id} is already ${a.status}${a.answeredBy ? ' by ' + a.answeredBy : ''}` }); }
      const dec = body?.decision; if (dec !== 'allow' && dec !== 'deny') { saveAsks(d); return json(res, 400, { error: 'decision: allow or deny' }); }
      a.status = dec === 'allow' ? 'allowed' : 'denied'; a.answeredBy = sess.username; a.answeredAt = new Date().toISOString();
      if (body?.via === 'notification') a.via = 'notification';                // T-0210: answered with the buttons on the notification (public/sw.js)
      if (dec === 'allow' && body?.scope === 'job' && a.canJob) {              // T-0211: exactly this may run again in the same job; Chamber keeps the clock and counts every run
        a.scope = 'job'; a.uses = []; a.jobUntil = Date.now() + (TEST_HOOKS && Number(body.scopeSec) >= 1 ? Math.min(ASK_JOB_MS, Number(body.scopeSec) * 1000) : ASK_JOB_MS);
      }
      saveAsks(d);
      askOutcome(a, (dec === 'allow' ? (a.scope === 'job' ? `Allowed for this job by ${sess.username} (exactly this may run again until the job ends, 30 minutes at most)` : `Allowed once by ${sess.username}`) : `${sess.username} said no`) + (a.via ? ', from the notification.' : '.'));
      audit(sess, { action: dec === 'allow' ? (a.scope === 'job' ? 'ask-allow-job' : 'ask-allow') : 'ask-deny', ask: a.id, ticket: a.ticket, via: a.via, agent: a.agent, tool: a.tool, what: a.summary.slice(0, 300) }, true); notify('asks', { room: a.room });
      return json(res, 200, { ok: true, status: a.status, scope: a.scope });
    }
    if (!askIsAgent(sess) || a.agent !== sess.username) { saveAsks(d); return json(res, 403, { error: 'only the agent that asked' }); }
    if (askM[2] === 'cancel') {
      if (a.status !== 'waiting') { saveAsks(d); return json(res, 409, { error: `${a.id} is ${a.status}` }); }
      a.status = 'cancelled'; a.answeredAt = new Date().toISOString(); saveAsks(d);
      askOutcome(a, 'The agent stopped before anyone answered.'); audit(sess, { action: 'ask-cancel', ask: a.id, ticket: a.ticket }); notify('asks', { room: a.room });
      return json(res, 200, { ok: true });
    }
    if (askM[2] === 'use') {                                                   // T-0211: exactly the same thing again in the same job, under the earlier answer
      const why = a.status !== 'allowed' || a.scope !== 'job' ? 'this question was not allowed for the whole job' : a.jobEnded ? 'that job has ended' : Date.now() > a.jobUntil ? 'the 30 minutes are over' : a.uses.length >= ASK_JOB_USES ? `it already ran ${ASK_JOB_USES} more times under this answer` : null;
      if (why) { saveAsks(d); return json(res, 409, { error: `${a.id}: ${why}. Ask again.` }); }
      a.uses.push({ at: new Date().toISOString() }); saveAsks(d);
      audit(sess, { action: 'ask-covered', ask: a.id, ticket: a.ticket, run: a.uses.length + 1, by: a.answeredBy, what: a.summary.slice(0, 300) });
      return json(res, 200, { ok: true, n: a.uses.length });
    }
    if (askM[2] === 'end') {                                                   // the agent's job is over: the answer covers nothing more
      if (a.scope !== 'job' || a.jobEnded) { saveAsks(d); return json(res, 409, { error: `${a.id} has no job to end` }); }
      a.jobEnded = new Date().toISOString(); saveAsks(d);
      askOutcome(a, `The job ended. It ran ${a.uses.length + 1} time${a.uses.length ? 's' : ''} under this answer.`);
      audit(sess, { action: 'ask-job-end', ask: a.id, ticket: a.ticket, runs: a.uses.length + 1 }); notify('asks', { room: a.room });
      return json(res, 200, { ok: true, runs: a.uses.length + 1 });
    }
    if (askM[2] === 'result' && Number.isInteger(body?.use) && body.use >= 1) { // the result of a covered run
      const u = a.scope === 'job' ? (a.uses || [])[body.use - 1] : null;
      if (!u || u.result) { saveAsks(d); return json(res, 409, { error: 'a result is recorded once for each run' }); }
      u.result = { ok: body?.ok !== false, output: String(body?.output || '').slice(0, 2000), at: new Date().toISOString() }; saveAsks(d);
      audit(sess, { action: 'ask-result', ask: a.id, ticket: a.ticket, run: body.use + 1, ok: u.result.ok, output: u.result.output.slice(0, 500) });
      return json(res, 200, { ok: true });
    }
    if (a.status !== 'allowed' || a.result) { saveAsks(d); return json(res, 409, { error: 'a result is recorded once, and only for a question that was allowed' }); }
    a.result = { ok: body?.ok !== false, output: String(body?.output || '').slice(0, 2000), at: new Date().toISOString() }; saveAsks(d);
    audit(sess, { action: 'ask-result', ask: a.id, ticket: a.ticket, ok: a.result.ok, output: a.result.output.slice(0, 500) });
    return json(res, 200, { ok: true });
  }
  // T-0200: standing approvals. Read: everyone in the workspace (agents too, so they can name one). Set up, confirm, withdraw: people who may approve.
  if (url.pathname === '/api/standing' && method === 'GET') {
    const tickets = loadTickets().tickets || [], now = Date.now(), person = !sess?.agent && sess?.role !== 'ai';
    const items = loadStanding().items.slice().reverse().map(s => ({ ...s, state: standingState(s, now), usedThisWeek: standingUses(s, tickets, now), usedTotal: tickets.filter(t => t.standing && t.standing.id === s.id).length }));
    return json(res, 200, { standing: items, canManage: person && (accounts.enabled ? accounts.canApprove(sess) : true), agents: Object.entries(loadData().users).filter(([n, u]) => u.role === 'ai' && n !== REMINDER_BOT && n !== GH_BOT).map(([n]) => n).sort(), never: STANDING_NEVER, maxDays: STANDING_MAX_DAYS });
  }
  const standingActM = url.pathname.match(/^\/api\/standing(?:\/(S-\d{1,5})\/(withdraw|confirm))?$/i);
  if (standingActM && method === 'POST') {
    const body = await parseBody(req, sess).catch(() => null);
    if (!sess?.username) return json(res, 401, { error: 'login first' });
    if (sess.agent || sess.role === 'ai' || loadData().users[sess.username]?.role !== 'human') return json(res, 403, { error: 'a person decides standing approvals; an agent cannot' });
    if (accounts.enabled && !accounts.canApprove(sess)) return json(res, 403, { error: 'Only people who may approve tickets here can set up, confirm or withdraw a standing approval (the owner\'s approval rules).' });
    const d = loadStanding(), lc = x => String(x || '').toLowerCase();
    if (!standingActM[1]) {                                                    // set one up
      const users = loadData().users, what = String(body?.what || '').trim().replace(/\s+/g, ' ');
      if (what.length < 5 || what.length > 200) return json(res, 400, { error: 'Say in a few words what kind of job this covers (5 to 200 characters), for example: fix failing tests.' });
      const agent = Object.keys(users).find(n => lc(n) === lc(String(body?.agent || '').trim().replace(/^@/, '')));
      if (!agent || users[agent].role !== 'ai' || agent === REMINDER_BOT) return json(res, 400, { error: 'Pick the AI agent that does these jobs (your ticket worker).' });
      let paths = Array.isArray(body?.paths) ? body.paths : String(body?.paths || '').split(/[,\n]/);
      paths = [...new Set(paths.map(p => String(p).trim().replace(/^(\.\/)+/, '').replace(/^\/+/, '')).filter(Boolean))];
      if (paths.length > 10 || paths.some(p => p.length > 120 || p.split('/').includes('..') || /[*?[\]\\]/.test(p))) return json(res, 400, { error: 'Folders are plain paths inside the repository, like tests/ or src/utils/ (no .. and no wildcards), at most 10.' });
      const num = (v, def, min, max) => v === undefined || v === null || v === '' ? def : (Number.isInteger(Number(v)) && Number(v) >= min && Number(v) <= max ? Number(v) : NaN);
      const maxFiles = num(body?.maxFiles, 5, 1, 50), perWeek = num(body?.perWeek, 10, 1, 100);
      if (Number.isNaN(maxFiles) || Number.isNaN(perWeek)) return json(res, 400, { error: 'Files per job: 1 to 50. Jobs a week: 1 to 100.' });
      const until = String(body?.until || '').trim(), today = new Date().toISOString().slice(0, 10), last = new Date(Date.now() + STANDING_MAX_DAYS * 864e5).toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(until) || Number.isNaN(Date.parse(until)) || until < today || until > last) return json(res, 400, { error: `Pick an end date from today to ${last}: at most ${STANDING_MAX_DAYS} days ahead, so every standing approval gets looked at again.` });
      if (d.items.filter(s => ['active', 'waiting'].includes(standingState(s))).length >= STANDING_MAX_ACTIVE) return json(res, 400, { error: `At most ${STANDING_MAX_ACTIVE} standing approvals at once. Withdraw one first.` });
      const rules = standingRulesFor(sess);
      const s = { id: 'S-' + d.next, what, agent, paths, maxFiles, perWeek, until, by: sess.username, at: new Date().toISOString(), needsConfirm: rules.two === 'all' && (rules.approvers || []).length >= 2 };
      d.next++; d.items.push(s); saveStanding(d);
      audit(sess, { action: 'standing-create', standing: s.id, what: what.slice(0, 120), agent, maxFiles, perWeek, until, paths: paths.join(',').slice(0, 200) || undefined }, true); notify('tickets');
      return json(res, 201, { ok: true, standing: { ...s, state: standingState(s) }, message: s.needsConfirm ? `${s.id} is set up. The approval rules here need two people, so it starts once a second approver confirms it.` : `${s.id} is active until ${until}. Tickets that name it start without waiting.` });
    }
    const s = d.items.find(x => x.id === standingActM[1].toUpperCase()); if (!s) return json(res, 404, { error: 'no such standing approval' });
    const st = standingState(s);
    if (standingActM[2].toLowerCase() === 'confirm') {
      if (st !== 'waiting') return json(res, 409, { error: `${s.id} is ${st}; only one that waits for a second approver can be confirmed` });
      if (lc(s.by) === lc(sess.username)) return json(res, 403, { error: `A different approver must confirm ${s.id}: that is what the two-person rule is for.` });
      s.confirmedBy = sess.username; s.confirmedAt = new Date().toISOString(); saveStanding(d);
      audit(sess, { action: 'standing-confirm', standing: s.id }, true); notify('tickets');
      return json(res, 200, { ok: true, message: `${s.id} is active until ${s.until}.` });
    }
    if (s.withdrawn) return json(res, 409, { error: `${s.id} was already withdrawn` });
    s.withdrawn = { by: sess.username, at: new Date().toISOString() }; saveStanding(d);
    let back = 0;
    for (const t of (loadTickets().tickets || []).filter(x => x.status === 'approved' && x.standing && x.standing.id === s.id)) if ((await standingBack(t.id, sess.username, `standing approval ${s.id} was withdrawn by ${sess.username} before any work started.`)).ok) back++;
    audit(sess, { action: 'standing-withdraw', standing: s.id, back }, true); notify('tickets');
    return json(res, 200, { ok: true, back, message: `${s.id} is withdrawn. ${back ? `${back} ticket${back === 1 ? '' : 's'} it had approved went back to waiting for a person.` : 'No ticket was waiting under it.'} Work already started under it stops before anything is pushed.` });
  }
  const standingCheckM = url.pathname.match(/^\/api\/tickets\/(T-\d{4})\/standing-check$/);
  if (standingCheckM && method === 'POST') {                                 // T-0200: the worker asks before it pushes anything: is this change inside the limits?
    const id = standingCheckM[1], body = await parseBody(req, sess).catch(() => null), t = (loadTickets().tickets || []).find(x => x.id === id);
    if (!t) return json(res, 404, { error: 'no such ticket' });
    if (!sess?.username || String(t.assignee || '').toLowerCase() !== String(sess.username).toLowerCase()) return json(res, 403, { error: 'only the agent working on this ticket can ask' });
    if (!t.standing || t.status !== 'in_progress') return json(res, 409, { ok: false, error: `${id} is not being worked under a standing approval` });
    const files = Array.isArray(body?.files) ? [...new Set(body.files.map(f => String(f).trim().replace(/^(\.\/)+/, '')).filter(Boolean))] : null;
    if (!files || !files.length || files.length > 2000) return json(res, 400, { error: 'files: the list of changed paths, relative to the repository' });
    const s = loadStanding().items.find(x => x.id === t.standing.id);
    let why = !s ? `standing approval ${t.standing.id} no longer exists` : standingLive(s, sess);
    if (!why) {
      const bad = files.filter(f => f.startsWith('/') || f.split('/').includes('..') || STANDING_NEVER_RE.some(re => re.test(f)));
      const inside = f => !s.paths.length || s.paths.some(p => { const q = p.replace(/\/+$/, ''); return f === q || f.startsWith(q + '/'); });
      const out = files.filter(f => !inside(f));
      if (files.length > s.maxFiles) why = `the change touches ${files.length} files and ${s.id} allows at most ${s.maxFiles}`;
      else if (bad.length) why = `the change touches files no standing approval covers: ${bad.slice(0, 5).join(', ')}`;
      else if (out.length) why = `the change touches files outside ${s.paths.join(', ')}: ${out.slice(0, 5).join(', ')}`;
    }
    if (why) {
      await standingBack(id, sess.username, `${why} (checked by Chamber before anything was pushed). A person can look at it and approve it by hand.`);
      audit(sess, { action: 'standing-outside', ticket: id, standing: t.standing.id, reason: why.slice(0, 200) }, true); notify('tickets');
      return json(res, 200, { ok: false, why });
    }
    await runTicketsCLI(['log', id, '--by', sess.username, '--line', `standing approval ${s.id}: Chamber checked the ${files.length} changed file${files.length === 1 ? '' : 's'} against its limits; inside them`]);
    audit(sess, { action: 'standing-check', ticket: id, standing: s.id, files: files.length }, true);
    return json(res, 200, { ok: true });
  }
  const ticketActionMatch = url.pathname.match(/^\/api\/tickets\/([A-Za-z0-9-]+)\/(approve|reject|claim|update|close|edit|release|cancel|log|for)$/);   // T-0143: + release, cancel, log; T-0155: + for
  if (ticketActionMatch && method === 'POST') {
    if (!TICKETS_WRITE_ENABLED) return json(res, 501, { error: 'tickets integration not configured' });  // [new] clean "off" reply
    const [, ticketId, action] = ticketActionMatch;
    const body = await parseBody(req, sess).catch(() => null);
    if (!body?.by) return json(res, 400, { error: 'by required' });
    const args = [action, ticketId, '--by', String(body.by)];
    if (action === 'approve' || action === 'reject') {                                                      // 2026-11-13 (security): the decision is a person's. Before this an agent's key could approve its own proposal.
      const who = loadData().users[String(body.by)];
      if (sess?.agent || sess?.role === 'ai' || !who || who.role !== 'human') { audit(sess, { action: 'ticket-' + action + '-refused', ticket: ticketId }, true); return json(res, 403, { error: `only a person can ${action} a ticket; an agent cannot` }); }
      if (accounts.enabled) {                                                                                 // T-0190: the owner's approval rules
        const cur = (loadTickets().tickets || []).find(x => x.id === ticketId);
        if (cur) {
          const plan = accounts.approvalCheck(accounts.workspaceOf(sess), cur, sess.username, action);
          if (!plan.ok) { audit(sess, { action: 'ticket-' + action + '-refused', ticket: ticketId, reason: 'approval rules' }, true); return json(res, plan.code || 403, { error: plan.error }); }
          if (action === 'approve') { args.push('--needs', String(plan.needs || 1)); if (plan.note) args.push('--note', plan.note); }
        }
      }
    }
    let approveDiff = null;                                                                                   // review 2026-11-13: the change that is approved is the version the person was shown
    if (action === 'approve') {
      try { const dm = JSON.parse(fs.readFileSync(path.join(diffDir(), ticketId + '.json'), 'utf8')), patch = fs.readFileSync(path.join(diffDir(), ticketId + '.patch'), 'utf8');
            approveDiff = { version: Number.isInteger(dm.version) ? dm.version : 1, sha256: crypto.createHash('sha256').update(patch).digest('hex') }; } catch { /* this ticket carries no change */ }
      if (approveDiff && body.version !== undefined && body.version !== null && Number(body.version) !== approveDiff.version) return json(res, 409, { error: `The change on ${ticketId} was replaced by version ${approveDiff.version} after you opened it. Look at version ${approveDiff.version} first, then approve.` });
    }
    if (action === 'claim' && accounts.enabled && (sess?.agent || sess?.role === 'ai')) {                   // T-0203: no new tickets once the AI budget is used up
      const bs = budgetState(accounts.workspaceOf(sess));
      if (bs && bs.agentOver(sess.username)) { audit(sess, { action: 'ticket-claim-refused', ticket: ticketId, reason: 'ai budget' }, true); return json(res, 402, { error: `The AI budget for ${bs.monthName} is used up (${bs.money(bs.spentCents)}${bs.monthlyCents ? ' of ' + bs.money(bs.monthlyCents) : ''}${bs.perAgent[sess.username] ? `; this agent's own limit is ${bs.money(bs.perAgent[sess.username])}` : ''}). New tickets wait until the owner raises it or the month turns.` }); }
    }
    if (action === 'claim' && (sess?.agent || sess?.role === 'ai')) {                                           // T-0145: agents never claim [human] work
      const found = (loadTickets().tickets || []).find(x => x.id === ticketId);
      if (found && ticketFor(found) === 'human') return json(res, 409, { error: `${ticketId} is for a person: only a person may claim it` });   // T-0155
    }
    if (action === 'claim') {                                                                                 // T-0200: a ticket approved in advance by a standing approval
      const cur = (loadTickets().tickets || []).find(x => x.id === ticketId);
      if (cur && cur.standing && cur.status === 'approved') { const no = await standingClaimCheck(cur, sess, body); if (no) return json(res, 409, { error: no }); }
    }
    if (action === 'for') {                                                                                 // T-0155: a person decides who does the ticket
      if (sess?.agent || sess?.role === 'ai') return json(res, 403, { error: 'people decide who does a ticket; an agent cannot change it' });
      const v = cleanFor(body.for); if (!v) return json(res, 400, { error: 'for must be "human" or "agent"' });
      args.push('--for', v);
    }
    if ((action === 'release' || action === 'cancel') && (sess?.agent || sess?.role === 'ai')) {           // T-0143: people un-claim or cancel work; T-0151: an agent may release what it holds and withdraw what it proposed
      const cur = (loadTickets().tickets || []).find(x => x.id === ticketId); const me = String(sess.username || '').toLowerCase();
      const own = action === 'release' ? String(cur?.assignee || '').toLowerCase() === me : String(cur?.proposed_by || '').toLowerCase() === me;
      if (!own) return json(res, 403, { error: action === 'release' ? 'an agent may only release a ticket it holds itself' : 'an agent may only cancel (withdraw) a ticket it proposed itself' });
    }
    if (action === 'release' && body.note) args.push('--note', String(body.note).slice(0, 1000));           // T-0143
    if (action === 'cancel') {                                                                               // T-0143
      if (!body.reason) return json(res, 400, { error: 'reason required for cancel' });
      args.push('--reason', String(body.reason).slice(0, 1000));
    }
    if (action === 'log') {                                                                                  // T-0143: run-log line and/or model; T-0194: + usage
      if (body.usage !== undefined) {
        const u = body.usage, num = (v, max) => v === undefined || v === null ? undefined : (typeof v === 'number' && isFinite(v) && v >= 0 && v <= max ? v : NaN);
        const clean = u && typeof u === 'object' ? { cost_cents: num(u.cost_cents, 1e7), tokens_in: num(u.tokens_in, 1e10), tokens_out: num(u.tokens_out, 1e10), ms: num(u.ms, 864e5) } : null;
        if (!clean || Object.values(clean).some(v => Number.isNaN(v))) return json(res, 400, { error: 'usage: {cost_cents, tokens_in, tokens_out, ms}, numbers, none negative' });
        args.push('--usage', JSON.stringify(Object.fromEntries(Object.entries(clean).filter(([, v]) => v !== undefined))));
        if (typeof clean.cost_cents === 'number') { try { fs.appendFileSync(path.join(path.dirname(F().data), 'usage-log.jsonl'), JSON.stringify({ ts: Date.now(), agent: sess.username, ticket: ticketId, cents: clean.cost_cents }) + '\n', { mode: 0o600 }); } catch (e) { console.error('[usage] log failed:', e.message); } }   // T-0203: counts toward this month's budget
      }
      if (!body.line && !body.model && body.usage === undefined) return json(res, 400, { error: 'line, model or usage required for log' });
      if (body.line) args.push('--line', String(body.line).slice(0, 300));
      if (body.model) args.push('--model', String(body.model).slice(0, 60));
    }
    if (action === 'reject') {
      if (!body.reason) return json(res, 400, { error: 'reason required for reject' });
      args.push('--reason', String(body.reason).slice(0, 1000));
    }
    if (action === 'update') {
      if (!body.note) return json(res, 400, { error: 'note required for update' });
      args.push('--note', String(body.note).slice(0, 8000));                  // T-0146: one explicit cap (8000) instead of clients guessing 1000
    }
    // Close carries a note, as update does, and tickets-cli.js refuses a close without one.
    // Both sides change together: harden only the CLI and every close made here would fail.
    if (action === 'close') {                                                   // [new] a close must say what it covered
      if (!body.note || String(body.note).trim().length < 20) {                 // [new] same 20-char minimum as tickets-cli.js, so the UI gets a clear 400
        return json(res, 400, { error: 'note required for close: name each item in the ticket body and its result (min 20 chars)' });  // [new] tells the closer what a good note holds
      }
      args.push('--note', String(body.note).slice(0, 8000));                   // [new] forward it; the CLI saves it as a CLOSED update  // T-0146: same 8000 cap
    }
    if (action === 'edit') {
      // Pass through only the fields present; CLI enforces proposed-only + validation.
      let anyField = false;
      for (const f of ['title', 'body', 'type', 'priority', 'for']) {   // T-0155: + for
        if (typeof body[f] === 'string' && body[f].length) { args.push(`--${f}`, body[f]); anyField = true; }
      }
      if (!anyField) return json(res, 400, { error: 'edit requires at least one of title/body/type/priority' });
    }
    const r = await runTicketsCLI(args);
    if (!r.ok) return json(res, 400, { error: r.stderr || `${action} failed` });
    if (approveDiff && ((loadTickets().tickets || []).find(x => x.id === ticketId) || {}).status === 'approved') await runTicketsCLI(['meta', ticketId, '--by', String(body.by), '--set', 'approved_diff', '--json', JSON.stringify(approveDiff)]);   // on the record: which version was approved, with its fingerprint (the connector checks it before applying)
    if (['approve', 'reject', 'claim', 'close', 'cancel'].includes(action)) await requestMoved(ticketId, sess?.username || body.by);   // T-0205: tell the requester
    if (action !== 'log') audit(sess, { action: 'ticket-' + action, ticket: ticketId, note: body.note ? String(body.note).slice(0, 200) : undefined, reason: body.reason ? String(body.reason).slice(0, 200) : undefined }, true);   // [new] T-0015; T-0057: humans too; T-0143: run-log lines are progress, not audited
    return json(res, 200, { ok: true, message: r.stdout });
  }

  // ── Reviews ──────────────────────────────────────────────────────
  if (url.pathname === '/api/reviews' && method === 'GET') {
    const r = loadReviews();
    let reviews = r.reviews;
    const status = url.searchParams.get('status');
    if (status) reviews = reviews.filter(x => x.status === status);
    return json(res, 200, { reviews: reviewListView(reviews) });
  }

  if (url.pathname === '/api/reviews' && method === 'POST') {
    const body = await parseBody(req, sess).catch(() => null);
    if (!body?.by) return json(res, 400, { error: 'by required' });
    if (Array.isArray(body.files)) {                                          // [new] T-0005: pasted review (no repo needed)
      if (body.files.length === 0 || body.files.length > 20) return json(res, 400, { error: '1 to 20 files per review' });
      const files = [];
      for (const f of body.files) {
        const p = String(f?.path || '').trim().slice(0, 200), diff = String(f?.diff || '');
        if (!p || !diff.trim()) return json(res, 400, { error: 'each file needs a path and some content' });
        if (diff.length > 200000) return json(res, 400, { error: `${p}: too large (200 KB max per file)` });
        const counts = countDiffLines(diff);
        files.push({ path: p, diff, added: counts.added, removed: counts.removed });
      }
      const data = loadReviews();
      const id = `R-${String(data.next_id).padStart(4, '0')}`;
      data.reviews.push({ id, by: body.by, ticket_id: body.ticket_id || null, note: String(body.note || '').slice(0, 2000), files,
                          proposed_at: new Date().toISOString(), status: 'pending', reviewed_by: null, reviewed_at: null, reject_reason: null, source: 'paste' });
      data.next_id++;
      saveReviews(data);
      audit(sess, { action: 'review-propose', review: id }, true);
      return json(res, 201, { ok: true, id });
    }
    if (!REPO_ENABLED) return json(res, 501, { error: 'repo-backed reviews are not configured here; send files: [{path, diff}] instead' });
    if (!Array.isArray(body.file_paths) || body.file_paths.length === 0) {
      return json(res, 400, { error: 'file_paths (non-empty array) required' });
    }
    if (body.file_paths.length > 20) {
      return json(res, 400, { error: 'max 20 files per review' });
    }
    const data = loadReviews();
    const id = `R-${String(data.next_id).padStart(4, '0')}`;
    const files = [];
    for (const p of body.file_paths) {
      if (typeof p !== 'string' || !p.startsWith(REPO_ROOT + '/')) {
        return json(res, 400, { error: `path must be inside ${REPO_ROOT}: ${p}` });
      }
      const result = await gitDiffFile(p);
      if (!result.ok) {
        return json(res, 400, { error: `git diff failed for ${p}: ${result.error}` });
      }
      const counts = countDiffLines(result.diff);
      files.push({ path: p, diff: result.diff, added: counts.added, removed: counts.removed });
    }
    const review = {
      id,
      by: body.by,
      ticket_id: body.ticket_id || null,
      note: body.note || '',
      files,
      proposed_at: new Date().toISOString(),
      status: 'pending',
      reviewed_by: null,
      reviewed_at: null,
      reject_reason: null,
    };
    data.reviews.push(review);
    data.next_id++;
    saveReviews(data);
    return json(res, 201, { ok: true, id });
  }

  const reviewDetailMatch = url.pathname.match(/^\/api\/reviews\/(R-\d+)$/);
  if (reviewDetailMatch && method === 'GET') {
    const data = loadReviews();
    const review = data.reviews.find(r => r.id === reviewDetailMatch[1]);
    if (!review) return json(res, 404, { error: 'review not found' });
    return json(res, 200, { review });
  }

  const reviewActionMatch = url.pathname.match(/^\/api\/reviews\/(R-\d+)\/(approve|reject)$/);
  if (reviewActionMatch && method === 'POST') {
    const [, id, action] = reviewActionMatch;
    const body = await parseBody(req, sess).catch(() => null);
    if (!body?.by) return json(res, 400, { error: 'by required' });
    const data = loadReviews();
    const review = data.reviews.find(r => r.id === id);
    if (!review) return json(res, 404, { error: 'review not found' });
    if (review.status !== 'pending') {
      return json(res, 400, { error: `cannot ${action} — already ${review.status}` });
    }
    // Verify the reviewer is human (mirror the ticket-CLI rule).
    const chamber = loadData();
    const u = chamber.users[body.by];
    if (!u || u.role !== 'human') {
      return json(res, 403, { error: 'only humans can approve/reject reviews' });
    }
    if (action === 'reject' && !body.reason) {
      return json(res, 400, { error: 'reason required for reject' });
    }
    review.status = action === 'approve' ? 'approved' : 'rejected';
    review.reviewed_by = body.by;
    review.reviewed_at = new Date().toISOString();
    review.reject_reason = action === 'reject' ? body.reason : null;
    if (action === 'approve' && body.note) review.approve_note = String(body.note).slice(0, 2000);   // T-0094
    // T-0094: the verdict drives the linked ticket -- thumbs-up closes it, thumbs-down leaves it open and
    // records the knock-back so the agent that applied it picks the work back up.
    let ticket = null;
    if (review.ticket_id && TICKETS_WRITE_ENABLED) {
      try {
        const tk = (loadTickets().tickets || []).find(x => x.id === review.ticket_id);
        if (tk) {
          if (action === 'approve') {
            if (tk.status === 'approved' || tk.status === 'in_progress') {
              const note = `Reviewed in ${review.id} by ${body.by}: change verified and approved.` + (body.note ? ` ${String(body.note).slice(0, 300)}` : '');
              const cr = await runTicketsCLI(['close', tk.id, '--by', body.by, '--note', note]);
              review.ticket_closed = !!cr.ok;
              ticket = { id: tk.id, closed: !!cr.ok };
            } else ticket = { id: tk.id, closed: false, note: `ticket was ${tk.status}` };
          } else {
            const note = `REVIEW REJECTED (${review.id}) by ${body.by}: ${String(body.reason).slice(0, 500)}`;
            await runTicketsCLI(['update', tk.id, '--by', body.by, '--note', note]);
            ticket = { id: tk.id, reopened: true };
          }
        }
      } catch { /* the review verdict stands even if the ticket side hiccups */ }
    }
    saveReviews(data);
    if (ticket) notify('tickets');                                           // T-0094: a verdict changed a ticket
    return json(res, 200, { ok: true, ticket });
  }

  // ── Presence ─────────────────────────────────────────────────────
  // Cross-references chamber users with ticket assignees so the sidebar
  // can show 'opus-1m -> working on T-0029' at a glance.
  if (url.pathname === '/api/fleet/routers' && method === 'GET') {          // T-0153: this workspace's GhostPort routers. Read-only status for members and agents; the key never leaves the server
    if (!sess?.username) return json(res, 401, { error: 'sign in first' });
    const wsId = reqScope.getStore()?.ws; const link = accounts.enabled && fleet.enabled && wsId ? accounts.fleetLinkOf(wsId) : null;
    if (!link) return json(res, 200, { linked: false, routers: [], count: 0, online: 0 });
    return json(res, 200, await fleet.routers(accounts.fleetDir(), wsId, link, patch => accounts.fleetMark(wsId, patch)));
  }
  if (url.pathname === '/api/presence' && method === 'GET') {
    const chamber = loadData();
    const tix = loadTickets();
    const inflight = (tix.tickets || []).filter(t => t.status === 'in_progress');
    const now = Date.now();
    const presence = Object.values(chamber.users || {}).map(u => {
      const claimed = inflight.filter(t => t.assignee === u.username).map(t => ({
        id: t.id, title: t.title, priority: t.priority,
      }));
      const ageMs = now - u.lastSeen;
      let state = 'offline';
      if (ageMs < ONLINE_TIMEOUT) state = 'online';
      else if (ageMs < ACTIVE_TIMEOUT * 5) state = 'idle';
      const meta = u.role === 'ai' ? agentMeta.get(`${reqScope.getStore()?.ws || '_'}:${u.username}`) : null;   // [new] T-0045
      const lg = u.role === 'ai' ? LOOP_GUARD.get(`${reqScope.getStore()?.ws || '_'}:${u.username}`) : null;    // [new] T-0089
      return {
        username: u.username,
        role: u.role,
        last_seen: u.lastSeen,
        state,
        claimed,
        agent: meta && now - meta.at < 180e3 ? { version: meta.version || null, rooms: meta.rooms || [], state: meta.state || 'idle', room: meta.room, task: meta.task, since: meta.since, error: meta.error, ask: meta.ask, shell: meta.shell, reach: meta.reach, stale: !!(LATEST_AGENT_VERSION && meta.version && !/^worker-/.test(meta.version) && meta.version !== LATEST_AGENT_VERSION), loopGuard: (lg && now - lg < 300e3) || undefined } : (u.role === 'ai' ? { version: null, rooms: null, stale: false } : undefined),   // [new] T-0045/T-0089: rooms null = this connector is too old to say; loopGuard = throttled as a possible loop
      };
    });
    presence.sort((a, b) => b.last_seen - a.last_seen);
    return json(res, 200, { presence, latestAgentVersion: LATEST_AGENT_VERSION });
  }

  // ── Activity timeline ────────────────────────────────────────────
  // Deterministic event derivation from chamber + tickets + reviews.
  // Returns chronological events in [since, now], capped at 200 newest.
  if (url.pathname === '/api/activity' && method === 'GET') {
    const since = parseInt(url.searchParams.get('since')) || (Date.now() - 24 * 3600 * 1000);
    const events = [];

    // Tickets — propose / approve / reject / claim / close events from the
    // updates array if present, else fall back to top-level timestamps.
    const tix = loadTickets();
    for (const t of (tix.tickets || [])) {
      const proposedTs = Date.parse(t.proposed_at);
      if (proposedTs > since) {
        events.push({ ts: proposedTs, kind: 'ticket_proposed', actor: t.proposed_by,
          ref: t.id, title: t.title, meta: { priority: t.priority, type: t.type } });
      }
      if (t.approved_at) {
        const ts = Date.parse(t.approved_at);
        if (ts > since) events.push({ ts, kind: 'ticket_approved', actor: t.approved_by, ref: t.id, title: t.title });
      }
      if (t.rejected_at) {
        const ts = Date.parse(t.rejected_at);
        if (ts > since) events.push({ ts, kind: 'ticket_rejected', actor: t.rejected_by, ref: t.id, title: t.title, meta: { reason: t.reject_reason } });
      }
      if (t.claimed_at) {
        const ts = Date.parse(t.claimed_at);
        if (ts > since) events.push({ ts, kind: 'ticket_claimed', actor: t.assignee, ref: t.id, title: t.title });
      }
      if (t.closed_at) {
        const ts = Date.parse(t.closed_at);
        if (ts > since) events.push({ ts, kind: 'ticket_closed', actor: t.assignee || t.proposed_by, ref: t.id, title: t.title });
      }
    }

    // Reviews — submit / approve / reject events.
    const rev = loadReviews();
    for (const r of (rev.reviews || [])) {
      const ts = Date.parse(r.proposed_at);
      if (ts > since) {
        events.push({ ts, kind: 'review_submitted', actor: r.by, ref: r.id,
          title: r.files.map(f => path.basename(f.path)).join(', '),
          meta: { ticket: r.ticket_id, files: r.files.length } });
      }
      if (r.reviewed_at) {
        const ts2 = Date.parse(r.reviewed_at);
        if (ts2 > since) events.push({ ts: ts2,
          kind: r.status === 'approved' ? 'review_approved' : 'review_rejected',
          actor: r.reviewed_by, ref: r.id,
          title: r.files.map(f => path.basename(f.path)).join(', '),
          meta: { reason: r.reject_reason } });
      }
    }

    // Message bursts — >=5 messages from one user within a 2-minute window.
    const chamber = loadDataFull();
    const msgs = (chamber.messages || []).filter(m => m.ts > since && m.type !== 'system');
    const byUser = {};
    for (const m of msgs) {
      (byUser[m.username] ||= []).push(m);
    }
    for (const [user, list] of Object.entries(byUser)) {
      list.sort((a, b) => a.ts - b.ts);
      let i = 0;
      while (i < list.length) {
        let j = i;
        while (j + 1 < list.length && list[j + 1].ts - list[i].ts < 120000) j++;
        if (j - i + 1 >= 5) {
          events.push({ ts: list[j].ts, kind: 'message_burst', actor: user,
            meta: { count: j - i + 1, span_sec: Math.round((list[j].ts - list[i].ts) / 1000) } });
          i = j + 1;
        } else {
          i++;
        }
      }
    }

    // User joins (joinedAt within window).
    for (const u of Object.values(chamber.users || {})) {
      if (u.joinedAt > since && (Date.now() - u.joinedAt) > 1000) {
        events.push({ ts: u.joinedAt, kind: 'user_joined', actor: u.username,
          meta: { role: u.role } });
      }
    }

    events.sort((a, b) => b.ts - a.ts);
    return json(res, 200, { events: events.slice(0, 200) });
  }

  // [new] T-0132: the owner says what the phone AI is called, what it may do and anything it should
  // know, in the app. Stored per workspace; every connector picks it up on its next ping and rewrites
  // its own briefing, so a change lands on the next question - no file to edit, no restart.
  if (url.pathname === '/api/ask-config' && method === 'GET') {
    if (!sess?.username) return json(res, 401, { error: 'not signed in' });
    return json(res, 200, { ok: true, config: loadAskConfig() });                       // [changed] T-0136
  }
  if (url.pathname === '/api/ask-config' && method === 'POST') {
    if (!sess?.username) return json(res, 401, { error: 'not signed in' });
    if (sess.agent) return json(res, 403, { error: 'connectors cannot change this' });
    if (accounts.enabled && accounts.sessionRole(sess) !== 'owner') return json(res, 403, { error: 'Phone AI settings are owner-only.' });
    const body = await parseBody(req, sess).catch(() => null);
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n).trim() : '');
    const cfg = { device: str(body?.device, 60), owner: str(body?.owner, 40),
                  can: ['readonly', 'folder', 'full'].includes(body?.can) ? body.can : '',
                  notes: str(body?.notes, 1000) };
    saveAskConfig(cfg);                                                                   // [changed] T-0136: actually persisted now
    audit(sess, { action: 'ask-config', config: cfg }, true);
    return json(res, 200, { ok: true, config: cfg });
  }

  if (url.pathname === '/api/ping' && method === 'POST') {
    const body = await parseBody(req, sess).catch(() => null);
    if (!body?.username) return json(res, 400, { error: 'username required' });
    const data = loadData();
    if (data.users[body.username]) {
      data.users[body.username].lastSeen = Date.now();
      saveData(data);
    }
    if (sess?.agent && (body.version || body.rooms || body.state)) {                         // [new] T-0046: what this connector runs and watches; T-0071: what it is doing right now
      const key = `${reqScope.getStore()?.ws || '_'}:${sess.username}`, prev = agentMeta.get(key) || {};
      const state = body.state === 'working' ? 'working' : 'idle';
      agentMeta.set(key, { version: String(body.version || '').slice(0, 20), rooms: Array.isArray(body.rooms) ? body.rooms.map(String).slice(0, 50) : [], at: Date.now(),
        ask: ['ready', 'off', 'error'].includes(body.ask) ? body.ask : undefined,          // [new] T-0131: is the phone AI installed and signed in on that machine?
        shell: body.shell === 'on' ? 'on' : undefined,                                     // [new] T-0131: does that connector accept relayed commands at all?
        state, room: state === 'working' ? String(body.room || '').slice(0, 60) : undefined, task: state === 'working' ? String(body.task || '').slice(0, 120) : undefined,
        since: state !== prev.state ? Date.now() : prev.since,
        error: body.error ? { text: String(body.error).slice(0, 200), at: Date.now() } : undefined,       // the connector resends its last error for an hour, then it clears
        reach: reachOf(body.reach) });                                                     // T-0218
    }
    return json(res, 200, { ok: true, latestAgentVersion: sess?.agent ? LATEST_AGENT_VERSION : undefined, drafts: sess?.agent ? draftCount(sess) : undefined,   // T-0207: requests waiting for a draft
      askConfig: sess?.agent ? loadAskConfig() : undefined });                          // [changed] T-0136: read from where it is really stored        // [new] T-0132: settings ride the ping the connector already sends
  }

  if (url.pathname === '/agent/chamber-agent.py' && method === 'GET') {        // Phase 1 (T-0105): serve the reference connector (already AGPL-public via /source) so "Connect your AI" is one curl
    return serveStatic(res, path.join(__dirname, 'agent', 'chamber-agent.py'), req);
  }
  if (url.pathname === '/worker' && method === 'GET') return serveStatic(res, path.join(__dirname, 'agent', 'chamber-worker.py'), req);              // T-0144: the ticket worker, fetched by install.sh
  if (url.pathname === '/worker.service' && method === 'GET') return serveStatic(res, path.join(__dirname, 'agent', 'chamber-worker.service'), req);  // T-0144: unit template (__REPO__, __REPO_GROUP__)
  if (url.pathname === '/agent.service' && method === 'GET') return serveStatic(res, path.join(__dirname, 'agent', 'chamber-agent.service'), req);     // T-0144
  if (url.pathname === '/console' && method === 'GET') {                      // T-0101: the Terminal page; /api/console enforces owner-only
    return serveStatic(res, path.join(__dirname, 'public', 'console.html'), req);
  }
  // Static files
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveStatic(res, path.join(__dirname, 'public', 'index.html'), req);
  }
  if (url.pathname.startsWith('/')) {
    const safePath = path.join(__dirname, 'public', path.basename(url.pathname));
    return serveStatic(res, safePath, req);
  }

  json(res, 404, { error: 'not found' });
}

// Fail closed: never serve to a network without auth. This is the key launch
// guard — it stops an open board from being accidentally exposed to a LAN/internet.
if (!IS_LOOPBACK && !AUTH_REQUIRED) {                                        // [new]
  console.error(`REFUSING TO START: bound to ${HOST} (non-loopback) with no password set.`);  // [new]
  console.error('Set CHAMBER_PASSWORD (or CHAMBER_PASSWORD_HASH), or bind CHAMBER_HOST=127.0.0.1 behind a proxy.');  // [new]
  process.exit(1);                                                          // [new]
}

server.listen(PORT, HOST, () => {                                            // [changed] HOST is now configurable (was '127.0.0.1')
  console.log(`Chamber running on http://${HOST}:${PORT}`);
  console.log('  store:   SQLite (node:sqlite), one database per workspace');
  // Startup summary so the operator sees which integrations are live.         [new] operability / at-a-glance config check
  console.log(`  data:    ${DATA_FILE}`);                                    // [new]
  console.log(`  reviews: ${REVIEWS_FILE}`);                                 // [new]
  console.log(`  tickets: ${TICKETS_READ_ENABLED ? TICKETS_FILE : 'disabled'} (write: ${TICKETS_WRITE_ENABLED ? 'on' : 'off'})`);  // [new]
  console.log(`  repo:    ${REPO_ENABLED ? REPO_ROOT : 'disabled'}`);        // [new]
  console.log(`  theme:   ${THEME_FILE || 'default accent'}`);              // [new]
  console.log(`  auth:    ${AUTH_REQUIRED ? 'ON (password required)' : 'OFF (loopback only)'}`);  // [changed] report auth status at boot
  if (!IS_LOOPBACK && AUTH_REQUIRED && !COOKIE_SECURE) {                     // [new] nudge toward TLS when exposed
    console.log('  NOTE: exposed with auth but CHAMBER_SECURE_COOKIE is off — serve over HTTPS (reverse proxy) and set it to 1.');  // [new]
  }
});
