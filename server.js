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
  const dir = path.dirname(F().data), file = path.join(dir, 'audit.json');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, `audit-${new Date(rec.ts).toISOString().slice(0, 7)}.jsonl`), JSON.stringify(rec) + '\n', { mode: 0o600 });
    let log = []; try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first entry */ }
    log.push(rec);
    if (log.length > AUDIT_RECENT) log = log.slice(-AUDIT_RECENT);
    const tmp = file + '.tmp.' + process.pid; fs.writeFileSync(tmp, JSON.stringify(log)); fs.renameSync(tmp, file);
  } catch (e) { console.error('[audit] write failed:', e.message); }
}
function auditAll(dir) {                                                       // T-0057: everything we have, oldest first (archives + recent, de-duplicated)
  const seen = new Set(), out = [];
  const files = fs.readdirSync(dir).filter(f => /^audit-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  for (const f of files) for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) { if (!line) continue; try { const r = JSON.parse(line); const k = `${r.ts}|${r.actor || r.agent}|${r.action}`; if (!seen.has(k)) { seen.add(k); out.push(r); } } catch {} }
  try { for (const r of JSON.parse(fs.readFileSync(path.join(dir, 'audit.json'), 'utf8'))) { const k = `${r.ts}|${r.actor || r.agent}|${r.action}`; if (!seen.has(k)) { seen.add(k); out.push(r); } } } catch {}
  return out.sort((a, b) => a.ts - b.ts);
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
const ACCOUNTS_CTX = { sessions, createSession, getSession, json, parseBody, loadData, loadDataFull, importWorkspace, saveData, loginThrottled, serveStatic, withWorkspace,
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
function diffDir() { return path.join(path.dirname(F().data), 'diffs'); }                                  // T-0063
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
setInterval(() => { try { runSchedules(); accounts.flushQuietHeld(); } catch (e) { console.error('[schedule]', e.message); } }, 30e3).unref();   // [changed] T-0078: deliver quiet-hours summaries
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
    if (url.pathname === '/api/_test/tick') { const at = new Date(parseInt(url.searchParams.get('at')) || Date.now()); return json(res, 200, { fired: runSchedules(at), flushed: accounts.flushQuietHeld(at) }); }   // T-0058/T-0078
    if (url.pathname === '/api/_test/reject') { Promise.reject(new Error('test: unhandled rejection')); return json(res, 200, { ok: true }); }
    if (url.pathname === '/api/_test/throw-async') { json(res, 200, { ok: true }); setImmediate(() => { throw new Error('test: uncaught exception'); }); return; }
  }
  if (url.pathname.startsWith('/api/') && AUTH_REQUIRED && (!sess || (accounts.enabled && !accounts.sessionEntitled(sess)))) {  // [changed] paid/admin only in accounts mode
    return json(res, 401, { error: 'authentication required' });
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
                            latestAgentVersion: sess.agent ? LATEST_AGENT_VERSION : undefined,   // [new] T-0046: connectors compare and warn when stale
                            peers: sess.agent ? Object.values(loadData().users).filter(u => u.role === 'ai' && u.username !== sess.username).map(u => u.username) : undefined,   // [new] T-0060
                            serverConsole: !accounts.enabled || accounts.serverConsoleAllowed(sess) ? true : undefined,   // T-0181: only then does the app offer the "Chamber server" target
                            fleetLink: accounts.enabled && fleet.enabled ? true : undefined,   // T-0153: show the GhostPort routers menu entry
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
  if (url.pathname === '/api/files' && method === 'POST') {                  // raw body upload; name in X-File-Name (URL-encoded), type in Content-Type
    if (!sess?.username) return json(res, 401, { error: 'login first' });
    const limit = MAX_FILE_MB * 1048576;
    const declared = parseInt(req.headers['content-length'], 10) || 0;
    if (declared > limit) { req.resume(); return json(res, 413, { error: `That file is ${(declared / 1048576).toFixed(1)} MB; the limit is ${MAX_FILE_MB} MB.` }); }
    const data = loadData();
    const room = url.searchParams.get('room') || req.headers['x-chamber-room'] || 'general';
    if (!Object.hasOwn(data.rooms, String(room))) return json(res, 404, { error: `No room '${String(room).slice(0, 40)}' in this workspace.` });
    if (!canSeeRoom(data, room, sess.username)) return json(res, 403, { error: 'not a member of that room' });
    const folder = cleanFolder(url.searchParams.get('folder') ?? req.headers['x-chamber-folder']);   // T-0149: upload straight into a folder
    if (folder === false) { req.resume(); return json(res, 400, { error: FOLDER_RULE }); }
    const used = store.filesBytes(F().data);
    const quotaMb = quotaMbFor(sess);                                                   // T-0159: smaller while on the free trial
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
  if (url.pathname.startsWith('/api/files/') && method === 'GET') {          // the bytes; only members of the file's room, only inside this workspace
    const id = url.pathname.slice('/api/files/'.length).replace(/\/+$/, '');
    if (!/^[a-f0-9]{24}$/.test(id)) return json(res, 404, { error: 'no such file' });
    const rec = store.fileGet(F().data, id);
    if (!rec) return json(res, 404, { error: 'no such file' });
    const data = loadData();
    if (!canSeeRoom(data, rec.room || 'general', sess?.username)) return json(res, 403, { error: 'not a member of that room' });
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
    tickets = tickets.map(x => ({ ...x, tags: ticketTags(x), for: ticketFor(x) }));                                 // T-0145: parsed tags; T-0155: who does it
    let withDiff = new Set(); try { withDiff = new Set(fs.readdirSync(diffDir()).filter(f => f.endsWith('.patch')).map(f => f.slice(0, -6))); } catch {}   // [new] T-0063
    return json(res, 200, { tickets: tickets.map(x => withDiff.has(x.id) ? { ...x, hasDiff: true } : x) });
  }
  const diffMatch = url.pathname.match(/^\/api\/tickets\/(T-\d{4})\/diff$/);           // [new] T-0063: a proposal carries a patch
  if (diffMatch && method === 'GET') {
    const id = diffMatch[1];
    try { const diff = fs.readFileSync(path.join(diffDir(), id + '.patch'), 'utf8'); let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(diffDir(), id + '.json'), 'utf8')); } catch {}
      return json(res, 200, { id, diff, meta }); } catch { return json(res, 404, { error: 'this ticket has no diff' }); }
  }
  if (diffMatch && method === 'POST') {
    const id = diffMatch[1]; const t = (loadTickets().tickets || []).find(x => x.id === id);
    if (!t) return json(res, 404, { error: 'no such ticket' });
    if (!['proposed', 'approved'].includes(t.status)) return json(res, 409, { error: `a diff can only be attached while the ticket is proposed or approved (it is ${t.status})` });
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
    fs.writeFileSync(path.join(diffDir(), id + '.patch'), diff, { mode: 0o600 }); fs.writeFileSync(path.join(diffDir(), id + '.json'), JSON.stringify(meta), { mode: 0o600 });
    audit(sess, { action: 'ticket-diff', ticket: id, files: files.length, added, removed }, true);
    notify('tickets', { diff: id });
    return json(res, 201, { ok: true, id, meta });
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
    return json(res, 201, { ok: true, message: r.stdout });
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
    const r = await runTicketsCLI(['propose', '--by', sess.username, '--title', title.replace(/^(\[agent\]\s*)+/i, ''), '--for', does, '--body', full, '--type', ['task', 'bug', 'security', 'idea'].includes(body?.type) ? body.type : 'task', '--priority', ['low', 'medium', 'high'].includes(body?.priority) ? body.priority : 'medium']);
    if (!r.ok) return json(res, 400, { error: r.stderr || 'propose failed' });
    const id = (String(r.stdout).match(/T-\d{4}/) || [])[0] || null;
    audit(sess, { action: 'proposal', id, title: title.slice(0, 120) }, true);
    notify('tickets');
    return json(res, 201, { ok: true, id, message: r.stdout.trim() });
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
    }
    if (action === 'claim' && (sess?.agent || sess?.role === 'ai')) {                                           // T-0145: agents never claim [human] work
      const found = (loadTickets().tickets || []).find(x => x.id === ticketId);
      if (found && ticketFor(found) === 'human') return json(res, 409, { error: `${ticketId} is for a person: only a person may claim it` });   // T-0155
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
    if (action === 'log') {                                                                                  // T-0143: run-log line and/or model
      if (!body.line && !body.model) return json(res, 400, { error: 'line or model required for log' });
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
        agent: meta && now - meta.at < 180e3 ? { version: meta.version || null, rooms: meta.rooms || [], state: meta.state || 'idle', room: meta.room, task: meta.task, since: meta.since, error: meta.error, ask: meta.ask, shell: meta.shell, stale: !!(LATEST_AGENT_VERSION && meta.version && !/^worker-/.test(meta.version) && meta.version !== LATEST_AGENT_VERSION), loopGuard: (lg && now - lg < 300e3) || undefined } : (u.role === 'ai' ? { version: null, rooms: null, stale: false } : undefined),   // [new] T-0045/T-0089: rooms null = this connector is too old to say; loopGuard = throttled as a possible loop
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
        error: body.error ? { text: String(body.error).slice(0, 200), at: Date.now() } : undefined });    // the connector resends its last error for an hour, then it clears
    }
    return json(res, 200, { ok: true, latestAgentVersion: sess?.agent ? LATEST_AGENT_VERSION : undefined,
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
