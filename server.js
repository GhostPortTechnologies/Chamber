#!/usr/bin/env node
// Chamber — standalone AI coordination chat + code-review board.
// A self-contained coordination app: chat, presence, and a code-review pad.
// Pure Node built-ins only (no npm packages) — runs on any Node >= 18.

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

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
const DEFAULT_ACCENT = process.env.CHAMBER_ACCENT || '#00ff88';             // [new] fallback accent; matches the CSS :root default so there's no color shift on load

const MAX_MESSAGES = 500;
const MAX_REVIEWS = 200;
const ACTIVE_TIMEOUT = 60000; // 60s — user considered active if seen within this window
const ONLINE_TIMEOUT = 30000; // 30s — sidebar online indicator

// Feature flags resolved once at startup so host-integration endpoints can    [new] single source of truth for "is this
// short-circuit cleanly instead of throwing on missing files/CLIs.           integration wired up?"
const TICKETS_READ_ENABLED  = !!TICKETS_FILE;                               // [new]
const TICKETS_WRITE_ENABLED = !!TICKETS_CLI;                                // [new]
const REPO_ENABLED = !!REPO_ROOT && fs.existsSync(REPO_ROOT);              // [new] reviews-from-git needs a real repo dir

function loadTickets() {
  if (!TICKETS_READ_ENABLED) return { next_id: 1, tickets: [] };            // [new] no host ticket file → empty (don't read '')
  try {
    return JSON.parse(fs.readFileSync(TICKETS_FILE, 'utf8'));
  } catch {
    return { next_id: 1, tickets: [] };
  }
}

function runTicketsCLI(args) {
  return new Promise((resolve) => {
    if (!TICKETS_WRITE_ENABLED) {                                           // [new] no CLI configured → clean disabled reply
      return resolve({ ok: false, stdout: '', stderr: 'tickets integration not configured' });  // [new]
    }
    execFile(TICKETS_CLI, args, { timeout: 5000 }, (err, stdout, stderr) => {
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
    return JSON.parse(fs.readFileSync(REVIEWS_FILE, 'utf8'));
  } catch {
    return { next_id: 1, reviews: [] };
  }
}

function saveReviews(data) {
  if (data.reviews.length > MAX_REVIEWS) {
    data.reviews = data.reviews.slice(-MAX_REVIEWS);
  }
  fs.mkdirSync(path.dirname(REVIEWS_FILE), { recursive: true });
  // Atomic write — temp file, fsync, rename.
  const tmp = REVIEWS_FILE + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, REVIEWS_FILE);
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

// Initialize data file
function loadData() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    return { users: {}, messages: [], rooms: { general: { name: 'General', topic: 'Main chamber for AI coordination' } } };
  }
}

function saveData(data) {
  if (data.messages.length > MAX_MESSAGES) {
    data.messages = data.messages.slice(-MAX_MESSAGES);
  }
  // Atomic write — temp file, fsync, rename — so a crash or power loss mid-    [changed] was a plain fs.writeFileSync that
  // write can't truncate/corrupt the chat store. Mirrors saveReviews().      could leave chamber.json half-written.
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });               // [new] ensure dir exists if DATA_FILE relocated
  const tmp = DATA_FILE + '.tmp.' + process.pid;                            // [new] unique temp beside the target
  const fd = fs.openSync(tmp, 'w');                                         // [new]
  try {                                                                      // [new]
    fs.writeSync(fd, JSON.stringify(data, null, 2));                        // [new] write full payload to temp
    fs.fsyncSync(fd);                                                       // [new] flush to disk before rename
  } finally {                                                                // [new]
    fs.closeSync(fd);                                                       // [new]
  }                                                                          // [new]
  fs.renameSync(tmp, DATA_FILE);                                            // [new] atomic swap into place
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(obj));
}

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const method = req.method;

  // CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // API routes
  if (url.pathname === '/api/login' && method === 'POST') {
    const body = await parseBody(req).catch(() => null);
    if (!body?.username) return json(res, 400, { error: 'username required' });
    const data = loadData();
    const username = body.username.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24);
    if (!username) return json(res, 400, { error: 'invalid username' });

    // Reject if username is actively in use by another session
    const existing = data.users[username];
    if (existing && (Date.now() - existing.lastSeen) < ACTIVE_TIMEOUT) {
      // Allow re-login (same user refreshing) by checking if session token matches
      // But since we don't have tokens, suggest a different name
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
    return json(res, 200, { ok: true, user: data.users[username] });
  }

  if (url.pathname === '/api/messages' && method === 'GET') {
    const data = loadData();
    const room = url.searchParams.get('room') || 'general';
    const since = parseInt(url.searchParams.get('since')) || 0;
    const messages = data.messages.filter(m => m.room === room && m.ts > since);
    return json(res, 200, { messages, users: data.users });
  }

  if (url.pathname === '/api/messages' && method === 'POST') {
    const body = await parseBody(req).catch(() => null);
    if (!body?.username || !body?.text) return json(res, 400, { error: 'username and text required' });
    const data = loadData();
    if (!data.users[body.username]) return json(res, 401, { error: 'login first' });
    const msg = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      username: body.username,
      text: body.text.slice(0, 2000),
      room: body.room || 'general',
      ts: Date.now(),
      type: body.type || 'message'
    };
    data.messages.push(msg);
    data.users[body.username].lastSeen = Date.now();
    saveData(data);
    return json(res, 201, { ok: true, message: msg });
  }

  if (url.pathname === '/api/rooms' && method === 'GET') {
    const data = loadData();
    return json(res, 200, { rooms: data.rooms });
  }

  if (url.pathname === '/api/rooms' && method === 'POST') {
    const body = await parseBody(req).catch(() => null);
    if (!body?.name) return json(res, 400, { error: 'name required' });
    const data = loadData();
    const key = body.name.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 32);
    data.rooms[key] = { name: body.name, topic: body.topic || '' };
    saveData(data);
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
  if (url.pathname === '/api/tickets' && method === 'GET') {
    const t = loadTickets();
    let tickets = t.tickets;
    const status = url.searchParams.get('status');
    if (status) tickets = tickets.filter(x => x.status === status);
    return json(res, 200, { tickets });
  }

  if (url.pathname === '/api/tickets' && method === 'POST') {
    if (!TICKETS_WRITE_ENABLED) return json(res, 501, { error: 'tickets integration not configured' });  // [new] clean "off" reply
    const body = await parseBody(req).catch(() => null);
    if (!body?.by || !body?.title) return json(res, 400, { error: 'by and title required' });
    const args = ['propose', '--by', body.by, '--title', body.title];
    if (body.body) args.push('--body', body.body);
    if (body.type) args.push('--type', body.type);
    if (body.priority) args.push('--priority', body.priority);
    const r = await runTicketsCLI(args);
    if (!r.ok) return json(res, 400, { error: r.stderr || 'propose failed' });
    return json(res, 201, { ok: true, message: r.stdout });
  }

  const ticketActionMatch = url.pathname.match(/^\/api\/tickets\/([A-Za-z0-9-]+)\/(approve|reject|claim|update|close|edit)$/);
  if (ticketActionMatch && method === 'POST') {
    if (!TICKETS_WRITE_ENABLED) return json(res, 501, { error: 'tickets integration not configured' });  // [new] clean "off" reply
    const [, ticketId, action] = ticketActionMatch;
    const body = await parseBody(req).catch(() => null);
    if (!body?.by) return json(res, 400, { error: 'by required' });
    const args = [action, ticketId, '--by', body.by];
    if (action === 'reject') {
      if (!body.reason) return json(res, 400, { error: 'reason required for reject' });
      args.push('--reason', body.reason);
    }
    if (action === 'update') {
      if (!body.note) return json(res, 400, { error: 'note required for update' });
      args.push('--note', body.note);
    }
    if (action === 'edit') {
      // Pass through only the fields present; CLI enforces proposed-only + validation.
      let anyField = false;
      for (const f of ['title', 'body', 'type', 'priority']) {
        if (typeof body[f] === 'string' && body[f].length) { args.push(`--${f}`, body[f]); anyField = true; }
      }
      if (!anyField) return json(res, 400, { error: 'edit requires at least one of title/body/type/priority' });
    }
    const r = await runTicketsCLI(args);
    if (!r.ok) return json(res, 400, { error: r.stderr || `${action} failed` });
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
    if (!REPO_ENABLED) return json(res, 501, { error: 'reviews integration not configured (set CHAMBER_REPO_ROOT)' });  // [new] guard
    const body = await parseBody(req).catch(() => null);
    if (!body?.by) return json(res, 400, { error: 'by required' });
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
    const body = await parseBody(req).catch(() => null);
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
    saveReviews(data);
    return json(res, 200, { ok: true });
  }

  // ── Presence ─────────────────────────────────────────────────────
  // Cross-references chamber users with ticket assignees so the sidebar
  // can show 'opus-1m -> working on T-0029' at a glance.
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
      return {
        username: u.username,
        role: u.role,
        last_seen: u.lastSeen,
        state,
        claimed,
      };
    });
    presence.sort((a, b) => b.last_seen - a.last_seen);
    return json(res, 200, { presence });
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
    const chamber = loadData();
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

  if (url.pathname === '/api/ping' && method === 'POST') {
    const body = await parseBody(req).catch(() => null);
    if (!body?.username) return json(res, 400, { error: 'username required' });
    const data = loadData();
    if (data.users[body.username]) {
      data.users[body.username].lastSeen = Date.now();
      saveData(data);
    }
    return json(res, 200, { ok: true });
  }

  // Static files
  if (url.pathname === '/' || url.pathname === '/index.html') {
    return serveStatic(res, path.join(__dirname, 'public', 'index.html'));
  }
  if (url.pathname.startsWith('/')) {
    const safePath = path.join(__dirname, 'public', path.basename(url.pathname));
    return serveStatic(res, safePath);
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, HOST, () => {                                            // [changed] HOST is now configurable (was '127.0.0.1')
  console.log(`Chamber running on http://${HOST}:${PORT}`);
  // Startup summary so the operator sees which integrations are live.         [new] operability / at-a-glance config check
  console.log(`  data:    ${DATA_FILE}`);                                    // [new]
  console.log(`  reviews: ${REVIEWS_FILE}`);                                 // [new]
  console.log(`  tickets: ${TICKETS_READ_ENABLED ? TICKETS_FILE : 'disabled'} (write: ${TICKETS_WRITE_ENABLED ? 'on' : 'off'})`);  // [new]
  console.log(`  repo:    ${REPO_ENABLED ? REPO_ROOT : 'disabled'}`);        // [new]
  console.log(`  theme:   ${THEME_FILE || 'default accent'}`);              // [new]
  if (HOST !== '127.0.0.1') {                                                // [new] loud safety warning: no auth layer exists
    console.log('  WARNING: bound to a non-loopback address, but Chamber has NO authentication.');  // [new]
    console.log('           Put it behind a reverse proxy with auth, or add auth, before exposing it.');  // [new]
  }
});
