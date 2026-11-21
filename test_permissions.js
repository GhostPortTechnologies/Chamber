#!/usr/bin/env node
// test_permissions.js (T-0246): every role and an agent against every action in permissions.js.
//
// 1. The table itself: every cell is a known value, every route belongs to one row, ids are unique.
// 2. Every route in server.js and accounts.js belongs to a row (or to the short list of public routes below).
//    A route added without a row fails here, so nothing ships without someone deciding who may use it.
// 3. One workspace with an owner, an admin, two members, a viewer, a requester and two agents. For every row, each role
//    tries the action for real and the answer (allowed or refused) must be what the table says. "Only their own" rows
//    are tried twice: on the role's own thing (allowed) and on someone else's (refused).
// 4. Every route, for every role whose cell says "no", is refused before the feature runs (the gate).
// 5. The "Who can do what" table in Help is the one tools/permissions-help.js makes from the table.
// Zero dependencies. Run: node test_permissions.js   (exit 0 = all green). test_isolation.js runs it too.
//
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 GhostPort Technologies
'use strict';
const { spawn } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path');
const perm = require('./permissions.js');

const APP = __dirname;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'chamber-perm-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const INVITE = 'PERM-CODE-1234';
const GATE_ONLY = process.env.PERM_TEST_GATE !== '0';          // PERM_TEST_GATE=0: skip part 4 (to check the table against a server without the gate)
const env = { ...process.env, CHAMBER_ACCOUNTS: '1', CHAMBER_STRIPE_SECRET: 'sk_test_dummy', CHAMBER_STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
  CHAMBER_STRIPE_PRICE: 'price_dummy', CHAMBER_STRIPE_STORAGE_YEAR: 'price_storage',
  CHAMBER_PUBLIC_URL: BASE, CHAMBER_INVITE_CODE: INVITE, CHAMBER_PORT: String(PORT), CHAMBER_HOST: '127.0.0.1', CHAMBER_TEST_HOOKS: '1',
  CHAMBER_WRITES_PER_MINUTE: '100000', CHAMBER_DATA: path.join(TMP, 'chamber.json'), CHAMBER_REVIEWS: path.join(TMP, 'reviews.json'),
  CHAMBER_TICKETS_FILE: path.join(TMP, 'tickets.json'), CHAMBER_TICKETS_CLI: path.join(APP, 'tickets-cli.js'), CHAMBER_FLEET_URL: 'http://127.0.0.1:9/none' };
for (const k of ['CHAMBER_SELF_HOSTED', 'CHAMBER_LOCK_MINUTE_MS']) delete env[k];

let pass = 0, fail = 0;
function check(name, ok, detail = '') { if (ok) { pass++; } else { fail++; console.log(`  FAIL ${name} ${detail}`); } }
async function call(method, p, { token, body, headers } = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(headers || {}) },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)), redirect: 'manual' });
  const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const refusedDefault = r => r.status === 401 || r.status === 403;

// ── 1. the table ───────────────────────────────────────────────────────────────────────────────────────────────────
function tableChecks() {
  console.log('the table (permissions.js)');
  const ids = new Set(), routes = new Map();
  let bad = [];
  for (const r of perm.RULES) {
    if (ids.has(r.id)) bad.push('duplicate id ' + r.id); ids.add(r.id);
    for (const role of perm.ROLES) if (!Object.hasOwn(perm.VALUES, r[role])) bad.push(`${r.id}.${role} = ${r[role]}`);
    for (const rt of r.routes) { if (!/^(GET|POST|PATCH|DELETE|PUT) \/\S+$/.test(rt)) bad.push('bad route ' + rt); if (routes.has(rt)) bad.push(`${rt} in ${routes.get(rt)} and ${r.id}`); routes.set(rt, r.id); }
    for (const a of r.also || []) if (!perm.RULES.some(x => x.id === a)) bad.push(`${r.id}: also ${a} is not a row`);
    if (!r.what || !r.area) bad.push(r.id + ' needs what and area');
  }
  check('every row has a unique id, a known value in every cell, and each route in one row only', !bad.length, bad.join('; '));
  check('a conditional cell without its fact refuses (fail closed)', perm.allows('member', 'files.manage') === false && perm.allows('member', 'files.manage', { own: true }) === true && perm.allows('viewer', 'files.manage', { own: true }) === false);
  check('a literal route part outranks a :name part', perm.ruleFor('GET', '/api/shell/pending').id === 'terminal.connector' && perm.ruleFor('GET', '/api/shell/x1').id === 'terminal.use');
  check('the classic single board (no accounts): people act as the owner, agents as agents', perm.roleOf({ username: 'a' }, { enabled: false }) === 'owner' && perm.roleOf({ username: 'b', agent: true }, { enabled: false }) === 'agent');
}

// ── 2. every route in the code belongs to a row ────────────────────────────────────────────────────────────────────
// Public or personal routes that need no workspace role, and test hooks.
const PUBLIC = ['/api/health', '/api/login', '/api/docs', '/account/config', '/account/contact', '/account/signup', '/account/login', '/account/login/totp', '/account/login/passkey/options', '/account/login/passkey', '/account/reset-request', '/account/reset', '/account/pair/start', '/account/pair/status', '/billing/refresh'];
// Routes written as a regular expression, exactly as in the code, with sample requests. A new one must be added here.
const PATTERNS = {
  '/^\\/api\\/requests\\/files\\/([a-f0-9]{24})$/': ['GET /api/requests/files/0123456789abcdef01234567'],
  '/^\\/api\\/tickets\\/(T-\\d{4})\\/diff$/': ['GET /api/tickets/T-0001/diff', 'POST /api/tickets/T-0001/diff'],
  '/^\\/api\\/tickets\\/(T-\\d{4})\\/comments$/': ['GET /api/tickets/T-0001/comments', 'POST /api/tickets/T-0001/comments'],
  '/^\\/api\\/tickets\\/(T-\\d{4})\\/(changes|reviewer)$/': ['POST /api/tickets/T-0001/changes', 'POST /api/tickets/T-0001/reviewer'],
  '/^\\/api\\/tickets\\/(T-\\d{4})\\/pr$/': ['POST /api/tickets/T-0001/pr'],
  '/^\\/api\\/tickets\\/(T-\\d{4})\\/applied$/': ['POST /api/tickets/T-0001/applied'],
  '/^\\/api\\/tickets\\/(T-\\d{4})\\/revert$/': ['POST /api/tickets/T-0001/revert'],
  '/^\\/api\\/tickets\\/(T-\\d{4})\\/draft(\\/use)?$/': ['POST /api/tickets/T-0001/draft', 'POST /api/tickets/T-0001/draft/use'],
  '/^\\/api\\/tickets\\/(T-\\d{4})\\/question$/': ['POST /api/tickets/T-0001/question'],
  '/^\\/api\\/tickets\\/(T-\\d{4})\\/evidence$/': ['GET /api/tickets/T-0001/evidence'],
  '/^\\/api\\/asks\\/(A-\\d{1,6})(?:\\/(answer|result|cancel|use|end))?$/': ['GET /api/asks/A-1', 'POST /api/asks/A-1/answer', 'POST /api/asks/A-1/result', 'POST /api/asks/A-1/cancel', 'POST /api/asks/A-1/use', 'POST /api/asks/A-1/end'],
  '/^\\/api\\/tasks\\/([a-f0-9]{8})(?:\\/(done|undo|remove|confirm))?$/': ['POST /api/tasks/abcd1234', 'POST /api/tasks/abcd1234/done', 'POST /api/tasks/abcd1234/undo', 'POST /api/tasks/abcd1234/remove', 'POST /api/tasks/abcd1234/confirm'],
  '/^\\/api\\/standing(?:\\/(S-\\d{1,5})\\/(withdraw|confirm))?$/i': ['POST /api/standing', 'POST /api/standing/S-1/withdraw', 'POST /api/standing/S-1/confirm'],
  '/^\\/api\\/tickets\\/(T-\\d{4})\\/standing-check$/': ['POST /api/tickets/T-0001/standing-check'],
  '/^\\/api\\/tickets\\/(T-\\d{4,6})\\/check$/': ['POST /api/tickets/T-0001/check'],
  '/^\\/api\\/tickets\\/([A-Za-z0-9-]+)\\/(approve|reject|claim|update|close|edit|release|cancel|log|for)$/': ['approve', 'reject', 'claim', 'update', 'close', 'edit', 'release', 'cancel', 'log', 'for'].map(a => `POST /api/tickets/T-0001/${a}`),
  '/^\\/api\\/reviews\\/(R-\\d+)$/': ['GET /api/reviews/R-0001'],
  '/^\\/api\\/files\\/([a-f0-9]{24})\\/(version|versions)(?:\\/([a-f0-9]{24}))?$/': ['POST /api/files/0123456789abcdef01234567/version', 'GET /api/files/0123456789abcdef01234567/versions', 'GET /api/files/0123456789abcdef01234567/versions/0123456789abcdef01234568'],   // T-0266
  '/^\\/api\\/reviews\\/(R-\\d+)\\/(approve|reject)$/': ['POST /api/reviews/R-0001/approve', 'POST /api/reviews/R-0001/reject'],
  '/^\\/account\\/invite\\/([A-Za-z0-9_-]{8,})$/': [], '/^\\/account\\/verify\\/([A-Za-z0-9_-]{16,})$/': [],   // public links from emails
  '/^\\/account\\/workspace\\/records-saved(?:\\/([A-Za-z0-9.-]{1,80}))?(\\/delete)?$/': ['GET /account/workspace/records-saved', 'POST /account/workspace/records-saved', 'GET /account/workspace/records-saved/copy1', 'POST /account/workspace/records-saved/copy1/delete'],
  '/^\\/account\\/workspace\\/schedules\\/([a-f0-9]{8})$/': ['POST /account/workspace/schedules/abcd1234'],
  '/^\\/account\\/workspace\\/mirrors\\/([a-f0-9]{8})$/': ['POST /account/workspace/mirrors/abcd1234'],
  '/^\\/account\\/workspace\\/hooks\\/([a-f0-9]{8})$/': ['POST /account/workspace/hooks/abcd1234'],
};
// Routes written as a prefix (startsWith), counted per file, with sample requests for the ones that are routes.
// The count is a tripwire: a new startsWith route changes it, and whoever adds it updates this list and the table.
const PREFIXES = {
  'server.js /api/': { count: 7, samples: [] },                             // the checks every API call passes (sign-in, gate, read-only, rate limit)
  'server.js /api/_test/': { count: 1, samples: [] },                       // test hooks, only with CHAMBER_TEST_HOOKS=1
  'server.js /api/files/': { count: 3, samples: ['GET /api/files/0123456789abcdef01234567', 'DELETE /api/files/0123456789abcdef01234567', 'PATCH /api/files/0123456789abcdef01234567'] },
  'server.js /api/shell/': { count: 2, samples: ['POST /api/shell/job1/cancel', 'GET /api/shell/job1'] },
  'server.js /api/archives/': { count: 1, samples: ['GET /api/archives/A1'] },
  'server.js /account/': { count: 1, samples: [] }, 'server.js /billing/': { count: 1, samples: [] },              // the screen lock's list of open pages
  'server.js /account/workspace': { count: 2, samples: [] } /* + twoFactorGated(), T-0241 part 3 */, 'server.js /account/workspace/lock/': { count: 1, samples: [] },
  'accounts.js /account/': { count: 1, samples: [] }, 'accounts.js /billing/': { count: 2, samples: [] },
  'accounts.js /account/workspace': { count: 1, samples: [] }, 'accounts.js /account/workspace/lock/': { count: 1, samples: ['POST /account/workspace/lock/unlock', 'POST /account/workspace/lock/close'] },
};
function routeChecks() {
  console.log('every route in the code belongs to a row');
  const unknown = [], unmapped = [], counts = {};
  const want = (m, p) => { if (PUBLIC.includes(p) || p.startsWith('/api/_test/')) return; const ms = m ? [m] : ['GET', 'POST']; if (!ms.some(x => perm.ruleFor(x, p))) unmapped.push(`${m || 'GET|POST'} ${p}`); };
  for (const file of ['server.js', 'accounts.js']) {
    for (const line of fs.readFileSync(path.join(APP, file), 'utf8').split('\n')) {
      if (/^\s*\/\//.test(line)) continue;
      for (const mm of line.matchAll(/(?:url\.pathname|\bp) === '(\/(?:api|account|billing)\/[^']*)'/g)) want((line.slice(mm.index).match(/(?:method|\bm) === '([A-Z]+)'/) || [])[1], mm[1]);
      for (const mm of line.matchAll(/(?:url\.pathname|\bp)\.match\((\/\^(?:\\\/|[^\/\n])*\/[a-z]*)\)/g)) if (/^\/\^\\\/(api|account|billing)/.test(mm[1]) && !Object.hasOwn(PATTERNS, mm[1])) unknown.push(`${file}: ${mm[1]}`);
      for (const mm of line.matchAll(/(?:url\.pathname|\bp)\.startsWith\('(\/(?:api|account|billing)[^']*)'\)/g)) { const k = `${file} ${mm[1]}`; counts[k] = (counts[k] || 0) + 1; }
    }
  }
  for (const [k, c] of Object.entries(counts)) if (!PREFIXES[k] || PREFIXES[k].count !== c) unknown.push(`${k} startsWith x${c}`);
  for (const k of Object.keys(PREFIXES)) if (!counts[k]) unknown.push(`${k} no longer in the code`);
  for (const samples of [...Object.values(PATTERNS), ...Object.values(PREFIXES).map(x => x.samples)]) for (const s of samples) { const [m, p] = s.split(' '); want(m, p); }
  check('every route written as a pattern or a prefix is known to this test (add new ones to PATTERNS or PREFIXES with a sample request)', !unknown.length, unknown.join(' | '));
  check('every route belongs to a row in permissions.js (or is public)', !unmapped.length, unmapped.join(' | '));
}

// ── 3. the real thing ──────────────────────────────────────────────────────────────────────────────────────────────
(async () => {
  tableChecks();
  routeChecks();
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(APP, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', d => log += d); srv.stderr.on('data', d => log += d);
  for (let i = 0; i < 80; i++) { try { if ((await call('GET', '/api/health')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 100)); }
  try {
    console.log('a workspace with every role');
    const verify = async u => { const l = (log.match(new RegExp(`\\[accounts\\] verify link for ${u}: (\\S+)`)) || [])[1]; if (l) await fetch(l, { redirect: 'manual' }); };
    const signup = async (u, extra) => { const r = (await call('POST', '/account/signup', { body: { email: `${u}@test.invalid`, username: u, password: 'password-for-tests', ...extra } })).json; await verify(u); return r; };
    const O = await signup('olive', { invite: INVITE });
    { const f = path.join(TMP, 'accounts.json'), s = JSON.parse(fs.readFileSync(f, 'utf8')); Object.assign(s.accounts['olive@test.invalid'], { subStatus: 'active', subscription: 'sub_test', periodEnd: Math.floor(Date.now() / 1000) + 86400 * 365 }); fs.writeFileSync(f, JSON.stringify(s)); }
    const ws = (await call('GET', '/account/workspace', { token: O.token })).json, code = ws.inviteUrl.split('/join/')[1];
    const vCode = (await call('POST', '/account/workspace/invite-reset', { token: O.token, body: { role: 'viewer' } })).json.inviteUrl.split('/join/')[1];
    const rCode = (await call('POST', '/account/workspace/invite-reset', { token: O.token, body: { role: 'requester' } })).json.inviteUrl.split('/join/')[1];
    const AD = await signup('adam', { join: code }), MI = await signup('mia', { join: code }), MX = await signup('max', { join: code });
    const VI = await signup('vic', { join: vCode }), RX = await signup('rex', { join: rCode });
    await call('POST', '/account/workspace/role', { token: O.token, body: { username: 'adam', role: 'admin' } });
    const tokA = (await call('POST', '/account/workspace/tokens', { token: O.token, body: { name: 'Bot A', username: 'bot-a' } })).json;
    const tokB = (await call('POST', '/account/workspace/tokens', { token: O.token, body: { name: 'Bot B', username: 'bot-b' } })).json;
    const T = { owner: O.token, admin: AD.token, member: MI.token, viewer: VI.token, requester: RX.token, agent: tokA.token };
    const NAME = { owner: 'olive', admin: 'adam', member: 'mia', viewer: 'vic', requester: 'rex', agent: 'bot-a' };
    const MAX = MX.token, BOTB = tokB.token;
    const roles = (await call('GET', '/account/workspace', { token: O.token })).json.members.reduce((o, m) => (o[m.username] = m.role, o), {});
    check('the workspace has an owner, admin, members, a viewer and a requester', roles.olive === 'owner' && roles.adam === 'admin' && roles.mia === 'member' && roles.vic === 'viewer' && roles.rex === 'requester' && !!tokA.token && !!tokB.token, JSON.stringify(roles));

    // fixtures, each made fresh where an allowed try changes it
    const nameOfTok = tok => Object.entries(T).find(([, v]) => v === tok)?.[0];
    const by = tok => tok === MAX ? 'max' : tok === BOTB ? 'bot-b' : NAME[nameOfTok(tok)] || 'olive';
    let n = 0; const uniq = s => `${s} ${++n} ${Date.now().toString(36)}`;
    const say = async (tok, text, extra = {}) => (await call('POST', '/api/messages', { token: tok, body: { username: by(tok), text, room: 'general', ...extra } })).json?.message;
    const propose = async (tok, title, extra = {}) => { const r = await call('POST', '/api/tickets', { token: tok, body: { by: by(tok), title: uniq(title), ...extra } }); return (String(r.json?.message || '').match(/T-\d{4}/) || [])[0]; };
    const approve = id => call('POST', `/api/tickets/${id}/approve`, { token: O.token, body: { by: 'olive' } });
    const claim = (tok, id) => call('POST', `/api/tickets/${id}/claim`, { token: tok, body: { by: by(tok) } });
    const approved = async (tok = MAX, extra) => { const id = await propose(tok, 'approved one', extra); await approve(id); return id; };
    const DIFF = '--- a/notes.txt\n+++ b/notes.txt\n@@ -1 +1 @@\n-old line\n+new line\n';
    const withDiff = async (tok = MAX) => { const id = await propose(tok, 'with a change'); await call('POST', `/api/tickets/${id}/diff`, { token: tok, body: { diff: DIFF } }); return id; };
    const done = async () => { const id = await approved(MAX); await claim(MAX, id); await call('POST', `/api/tickets/${id}/close`, { token: MAX, body: { by: 'max', note: 'done: the one item in the ticket, checked by hand' } }); return id; };
    const upload = async (tok, name = 'note.txt') => { const r = await fetch(BASE + '/api/files?room=general', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'text/plain', 'X-File-Name': encodeURIComponent(name) }, body: 'hello' }); return (await r.json().catch(() => ({}))).file?.id; };
    const task = async tok => (await call('POST', '/api/tasks', { token: tok, body: { title: uniq('water the plants'), every: 'day' } })).json?.task?.id;
    const review = async () => (await call('POST', '/api/reviews', { token: MAX, body: { by: 'max', note: 'look', files: [{ path: 'notes.txt', diff: '--- a\n+++ b\n-old line\n+new line\n' }] } })).json?.id;
    const tidB = ((await call('GET', '/account/workspace/tokens', { token: O.token })).json?.tokens || []).find(t => t.username === 'bot-b')?.id;
    const tidA = ((await call('GET', '/account/workspace/tokens', { token: O.token })).json?.tokens || []).find(t => t.username === 'bot-a')?.id;
    await call('POST', '/account/workspace/tokens/ask', { token: O.token, body: { id: tidB, on: true } });
    const askB = async () => (await call('POST', '/api/asks', { token: BOTB, body: { room: 'general', tool: 'Bash', summary: 'run this command: npm test', detail: '{"command":"npm test"}', for: 'olive', waitSec: 300 } })).json?.id;
    const firstAsk = await askB();
    check('fixtures: tickets, files, tasks, reviews and an agent question can be made', !!(await propose(MAX, 'fixture check')) && !!(await upload(MAX)) && !!(await task(MAX)) && !!(await review()) && !!firstAsk, String(firstAsk));
    const running = async asker => { const q = await say(asker, '@bot-b check the disk'); return (await say(BOTB, uniq('@x on it'), { type: 'status', reply_to: q.id, run: { state: 'running', for: by(asker), steps: [] } }))?.id; };
    const jobFor = async agent => (await call('POST', '/api/shell', { token: O.token, body: { agent, cmd: 'uptime' } })).json?.id;

    // One entry per row. run(role) tries the action; for rows with "own", own(role) uses the role's own thing and run(role)
    // someone else's. refused(r) says whether a response is a refusal (default: 401 or 403).
    const nf = r => r.status === 401 || r.status === 403 || r.status === 404;
    const P = {
      'app.open': { run: role => call('GET', '/api/me', { token: T[role] }) },
      'app.prefs': { run: role => call('POST', '/api/me/prefs', { token: T[role], body: { prefs: { language: 'plain' } } }) },
      'chat.read': { run: role => call('GET', '/api/messages', { token: T[role] }) },
      'chat.post': { run: role => call('POST', '/api/messages', { token: T[role], body: { username: NAME[role], text: 'hello from ' + role, room: 'general' } }) },
      'chat.edit': { own: async role => call('POST', '/api/messages/edit', { token: T[role], body: { id: (await say(T[role], 'mine')).id, text: 'mine, edited' } }),
                     run: async role => call('POST', '/api/messages/edit', { token: T[role], body: { id: (await say(MAX, 'max wrote this')).id, text: 'changed by ' + role } }) },
      'chat.delete': { own: async role => call('POST', '/api/messages/delete', { token: T[role], body: { id: (await say(T[role], 'mine to delete')).id } }),   // T-0247
                       run: async role => call('POST', '/api/messages/delete', { token: T[role], body: { id: (await say(MAX, 'max wrote this one')).id } }) },
      'chat.rooms': { run: role => call('POST', '/api/rooms', { token: T[role], body: { name: 'room ' + role } }) },
      'chat.stop': { own: async role => call('POST', '/api/messages/stop', { token: T[role], body: { id: await running(T[role]) } }),
                     run: async role => call('POST', '/api/messages/stop', { token: T[role], body: { id: await running(MAX) } }) },
      'chat.archive': { run: role => call('POST', '/api/archives', { token: T[role], body: { room: 'general', before: '2000-01-01' } }) },
      'files.read': { run: role => call('GET', '/api/files', { token: T[role] }) },
      'files.upload': { run: async role => { const r = await fetch(BASE + '/api/files?room=general', { method: 'POST', headers: { Authorization: `Bearer ${T[role]}`, 'Content-Type': 'text/plain', 'X-File-Name': 'up.txt' }, body: 'x' }); return { status: r.status }; } },
      'files.manage': { own: async role => call('PATCH', `/api/files/${await upload(T[role])}`, { token: T[role], body: { folder: 'mine' } }),
                        run: async role => call('PATCH', `/api/files/${await upload(MAX)}`, { token: T[role], body: { folder: 'moved-by-' + role } }) },
      'folders.create': { run: role => call('POST', '/api/folders', { token: T[role], body: { path: 'made by ' + role } }) },
      'folders.change': { own: async role => { await call('POST', '/api/folders', { token: O.token, body: { path: 'mine ' + role } }); const f = await upload(T[role]); if (f) await call('PATCH', `/api/files/${f}`, { token: T[role], body: { folder: 'mine ' + role } }); return call('POST', '/api/folders', { token: T[role], body: { path: 'mine ' + role, to: 'mine renamed ' + role } }); },
                          run: async role => { await call('POST', '/api/folders', { token: O.token, body: { path: 'mixed ' + role } }); await call('PATCH', `/api/files/${await upload(MAX)}`, { token: MAX, body: { folder: 'mixed ' + role + '/inner' } }); return call('POST', '/api/folders', { token: T[role], body: { path: 'mixed ' + role, to: 'renamed ' + role } }); } },   // T-0244: max's file sits one level down
      'requests.follow': { run: role => call('GET', '/api/requests', { token: T[role] }) },
      'requests.send': { run: role => call('POST', '/api/requests', { token: T[role], body: { title: 'x' } }) },   // too short: 400 for anyone allowed
      'tickets.read': { run: role => call('GET', '/api/tickets', { token: T[role] }) },
      'tickets.propose': { run: role => call('POST', '/api/tickets', { token: T[role], body: { by: NAME[role], title: uniq('proposed by ' + role) } }) },
      'tickets.comment': { run: async role => call('POST', `/api/tickets/${await propose(MAX, 'to comment on')}/comments`, { token: T[role], body: { text: 'a comment', line: 1 } }) },
      'tickets.edit': { own: async role => call('POST', `/api/tickets/${await propose(T[role], 'my own to edit')}/edit`, { token: T[role], body: { by: NAME[role], title: uniq('edited by ' + role) } }),   // T-0247
                        run: async role => call('POST', `/api/tickets/${await propose(MAX, 'to edit')}/edit`, { token: T[role], body: { by: NAME[role], title: uniq('edited by ' + role) } }) },
      'tickets.decide': { run: async role => call('POST', `/api/tickets/${await propose(MAX, 'to decide')}/approve`, { token: T[role], body: { by: NAME[role] } }) },
      'tickets.changes': { run: async role => call('POST', `/api/tickets/${await withDiff()}/changes`, { token: T[role], body: { by: NAME[role], note: 'please rename the file' } }) },
      'tickets.unchanges': { own: async role => { const id = await withDiff(); await call('POST', `/api/tickets/${id}/changes`, { token: T[role], body: { by: NAME[role], note: 'please rename it' } }); return call('POST', `/api/tickets/${id}/changes`, { token: T[role], body: { by: NAME[role], withdraw: true } }); },
                             run: async role => { const id = await withDiff(); const asked = await call('POST', `/api/tickets/${id}/changes`, { token: O.token, body: { by: 'olive', note: 'please rename it' } }); if (asked.status !== 200) return { status: 599, text: 'fixture: the owner could not ask for changes ' + asked.text }; return call('POST', `/api/tickets/${id}/changes`, { token: T[role], body: { by: NAME[role], withdraw: true } }); } },
      'tickets.reviewer': { run: async role => call('POST', `/api/tickets/${await withDiff()}/reviewer`, { token: T[role], body: { reviewer: 'olive' } }) },
      'tickets.check': { run: role => call('POST', '/api/tickets/T-9999/check', { token: T[role], body: {} }) },   // T-0309: the bulk route is gone; an empty answer is refused after the role check
      'tickets.standing': { run: role => call('POST', '/api/standing', { token: T[role], body: {} }) },
      'tickets.claim': { run: async role => claim(T[role], await approved(MAX)) },
      'tickets.work': { own: async role => { const id = await approved(MAX); await claim(T[role], id); return call('POST', `/api/tickets/${id}/update`, { token: T[role], body: { by: NAME[role], note: 'progress by ' + role } }); },   // T-0247
                        run: async role => { const id = await approved(MAX); await claim(MAX, id); return call('POST', `/api/tickets/${id}/update`, { token: T[role], body: { by: NAME[role], note: 'progress by ' + role } }); } },
      'tickets.release': { own: async role => { const id = await approved(MAX); await claim(T[role], id); return call('POST', `/api/tickets/${id}/release`, { token: T[role], body: { by: NAME[role] } }); },   // T-0262
                           run: async role => { const id = await approved(MAX); await claim(MAX, id); return call('POST', `/api/tickets/${id}/release`, { token: T[role], body: { by: NAME[role] } }); } },
      'tickets.cancel': { own: async role => call('POST', `/api/tickets/${await approved(T[role])}/cancel`, { token: T[role], body: { by: NAME[role], reason: 'no longer needed' } }),
                          run: async role => call('POST', `/api/tickets/${await approved(MAX)}/cancel`, { token: T[role], body: { by: NAME[role], reason: 'no longer needed' } }) },
      'tickets.for': { run: async role => call('POST', `/api/tickets/${await propose(MAX, 'who does it')}/for`, { token: T[role], body: { by: NAME[role], for: 'human' } }) },
      'tickets.diff': { own: async role => call('POST', `/api/tickets/${await propose(T[role], 'my change')}/diff`, { token: T[role], body: { diff: DIFF } }),
                        run: async role => call('POST', `/api/tickets/${await propose(MAX, 'max change')}/diff`, { token: T[role], body: { diff: DIFF } }) },
      'tickets.applied': { run: async role => call('POST', `/api/tickets/${await approved(MAX)}/applied`, { token: T[role], body: {} }) },
      'tickets.revert': { run: async role => call('POST', `/api/tickets/${await approved(MAX)}/revert`, { token: T[role], body: {} }) },
      'tickets.pr': { own: async role => { const id = await approved(MAX); await claim(T[role], id); return call('POST', `/api/tickets/${id}/pr`, { token: T[role], body: { url: 'nope' } }); },
                      run: async role => { const id = await approved(MAX); await claim(BOTB, id); return call('POST', `/api/tickets/${id}/pr`, { token: T[role], body: { url: 'nope' } }); } },
      'tickets.draft': { run: role => call('GET', '/api/drafts/next', { token: T[role] }) },
      'tickets.usedraft': { run: async role => call('POST', `/api/tickets/${await propose(MAX, 'no draft here')}/draft/use`, { token: T[role], body: {} }) },
      'tickets.question': { run: async role => call('POST', `/api/tickets/${await propose(MAX, 'not a request')}/question`, { token: T[role], body: { text: 'which page?' } }) },
      'tickets.standingcheck': { own: async role => { const id = await approved(MAX); await claim(T[role], id); return call('POST', `/api/tickets/${id}/standing-check`, { token: T[role], body: { files: ['a'] } }); },
                                 run: async role => { const id = await approved(MAX); await claim(MAX, id); return call('POST', `/api/tickets/${id}/standing-check`, { token: T[role], body: { files: ['a'] } }); } },
      'tickets.evidence': { run: async role => call('GET', `/api/tickets/${await propose(MAX, 'evidence')}/evidence`, { token: T[role] }) },
      'reviews.create': { run: role => call('POST', '/api/reviews', { token: T[role], body: { by: NAME[role], note: 'look', files: [{ path: 'a.txt', diff: '--- a\n+++ b\n-x\n+y\n' }] } }) },
      'reviews.decide': { run: async role => call('POST', `/api/reviews/${await review()}/approve`, { token: T[role], body: { by: NAME[role] } }) },
      'tasks.read': { run: role => call('GET', '/api/tasks', { token: T[role] }) },
      'tasks.add': { run: role => call('POST', '/api/tasks', { token: T[role], body: { title: uniq('task by ' + role), every: 'day' } }) },
      'tasks.tick': { run: async role => call('POST', `/api/tasks/${await task(MAX)}/done`, { token: T[role], body: {} }) },
      'tasks.untick': { run: async role => { const id = await task(MAX); await call('POST', `/api/tasks/${id}/done`, { token: MAX, body: {} }); return call('POST', `/api/tasks/${id}/undo`, { token: T[role], body: {} }); } },
      'tasks.propose': { run: role => call('POST', '/api/tasks/propose', { token: T[role], body: { title: 'a duty of mine', every: 'day' } }) },   // T-0264
      'tasks.confirm': { run: async role => call('POST', `/api/tasks/${await task(MAX)}/confirm`, { token: T[role], body: {} }) },   // 400 for those allowed (not a proposal), refused for the rest
      'tasks.manage': { own: async role => call('POST', `/api/tasks/${await task(T[role])}/remove`, { token: T[role], body: {} }),
                        run: async role => call('POST', `/api/tasks/${await task(MAX)}/remove`, { token: T[role], body: {} }) },
      'memory.read': { run: role => call('GET', '/api/memory?agent=bot-a', { token: T[role] }) },
      'memory.edit': { own: role => call('POST', '/api/memory', { token: T[role], body: { agent: 'bot-a', scope: '*', text: 'a note by ' + role } }),
                       run: role => call('POST', '/api/memory', { token: T[role], body: { agent: 'bot-b', scope: '*', text: 'a note by ' + role } }) },
      'asks.read': { own: role => call('GET', '/api/asks', { token: T[role] }),
                     run: role => call('GET', `/api/asks/${firstAsk}`, { token: T[role] }) },
      'asks.ask': { run: role => call('POST', '/api/asks', { token: T[role], body: { room: 'general', tool: 'Bash', summary: 'run this command: ls', detail: '{"command":"ls"}', for: 'olive', waitSec: 300 } }) },
      'asks.follow': { own: async role => { await call('POST', '/account/workspace/tokens/ask', { token: O.token, body: { id: tidA, on: true } }); const id = (await call('POST', '/api/asks', { token: T[role], body: { room: 'general', tool: 'Bash', summary: 'run this command: ls', detail: '{"command":"ls"}', for: 'olive', waitSec: 300 } })).json?.id; await call('POST', '/account/workspace/tokens/ask', { token: O.token, body: { id: tidA, on: false } }); return call('POST', `/api/asks/${id}/cancel`, { token: T[role], body: {} }); },
                       run: role => call('POST', `/api/asks/${firstAsk}/cancel`, { token: T[role], body: {} }) },   // bot-b's question: nobody else may cancel it
      'asks.answer': { run: async role => call('POST', `/api/asks/${await askB()}/answer`, { token: T[role], body: { decision: 'deny' } }) },
      'agents.usage': { run: role => call('GET', '/api/usage', { token: T[role] }) },
      'agents.phoneai': { run: role => call('GET', '/api/ask-config', { token: T[role] }) },
      'agents.phoneaiset': { run: role => call('POST', '/api/ask-config', { token: T[role], body: {} }) },
      'agents.tokens': { run: role => call('GET', '/account/workspace/tokens', { token: T[role] }) },
      'agents.askswitch': { run: role => call('POST', '/account/workspace/tokens/ask', { token: T[role], body: { id: 'nope', on: false } }) },
      'agents.peerswitch': { run: role => call('POST', '/account/workspace/tokens/peers', { token: T[role], body: { id: 'nope', on: false } }) },   // T-0317
      'agents.automation': { run: role => call('GET', '/account/workspace/automation', { token: T[role] }) },
      'terminal.use': { run: role => call('POST', '/api/shell', { token: T[role], body: { agent: 'bot-b', cmd: 'uptime' } }) },
      'terminal.server': { run: role => call('POST', '/api/console', { token: T[role], body: { cmd: 'id' } }) },
      'terminal.connector': { own: role => call('GET', '/api/shell/pending', { token: T[role] }),
                              run: async role => call('POST', '/api/shell/result', { token: T[role], body: { id: await jobFor('bot-b'), code: 0, out: 'x' } }) },
      'fleet.read': { run: role => call('GET', '/api/fleet/routers', { token: T[role] }) },
      'fleet.link': { run: role => call('POST', '/account/workspace/fleet', { token: T[role], body: {} }) },
      'github.link': { run: role => call('GET', '/api/github-link', { token: T[role] }) },
      'activity.read': { run: role => call('GET', `/api/activity?from=0&to=${Date.now()}`, { token: T[role] }) },
      'audit.read': { run: role => call('GET', '/account/workspace/audit', { token: T[role] }) },
      'audit.export': { run: role => call('GET', '/account/workspace/audit?format=json', { token: T[role] }) },
      'ws.view': { run: role => call('GET', '/account/workspace', { token: T[role] }) },
      'ws.rename': { run: role => call('POST', '/account/workspace', { token: T[role], body: { name: ws.name } }) },
      'ws.settings': { run: role => call('POST', '/account/workspace', { token: T[role], body: { retentionDays: 0 } }) },
      'ws.members': { run: role => call('POST', '/account/workspace/remove', { token: T[role], body: { username: 'nobody-here' } }) },
      'ws.invites': { run: role => call('POST', '/account/workspace/invite-reset', { token: T[role], body: { role: 'nonsense' } }) },
      'ws.roles': { run: role => call('POST', '/account/workspace/role', { token: T[role], body: { username: 'nobody-here', role: 'member' } }) },
      'ws.transfer': { run: role => call('POST', '/account/workspace/transfer', { token: T[role], body: { username: 'nobody-here', password: 'password-for-tests' } }) },
      'ws.report': { run: role => call('POST', '/account/workspace/report', { token: T[role], body: {} }) },
      'ws.lock': { run: role => call('POST', '/account/workspace/lock/close', { token: T[role], body: {} }) },
      'ws.records': { run: role => call('GET', '/account/workspace/ownerkey', { token: T[role] }) },
      'ws.export': { run: role => call('GET', '/account/export', { token: T[role] }) },
      'ws.billing': { run: role => call('POST', '/billing/cancel', { token: T[role], body: { undo: true } }),   // T-0311: subscribe, card page, cancel: the owner only ("keep my plan" on a plan that is not ending changes nothing)
                      refused: r => r.status === 401 || r.status === 403 || (r.status === 400 && /Only the workspace owner/.test(r.json?.error || '')) },
      'ws.billing.view': { run: role => call('GET', '/billing/overview', { token: T[role] }),   // T-0311: the Billing tab: owner and admins look; only the owner changes
                      refused: r => r.status === 401 || r.status === 403 || (r.status === 400 && /Only the workspace owner/.test(r.json?.error || '')) },
      'account.own': { run: role => call('GET', '/account/me', { token: T[role] }) },
    };
    const facts = { approver: ['owner', 'admin', 'member'], commander: ['owner'] };   // the defaults: approval rules not set, agent policy "owner only"
    const expectAllowed = (role, v, own) => v === 'yes' || (v === 'own' && own) || (v === 'approver' && facts.approver.includes(role)) || (v === 'commander' && facts.commander.includes(role));

    console.log('every role against every action');
    const missing = perm.RULES.filter(r => !P[r.id]).map(r => r.id);
    check('every row in the table has a probe here', !missing.length, missing.join(', '));
    for (const r of perm.RULES) {
      const pr = P[r.id]; if (!pr) continue;
      const refused = pr.refused || refusedDefault;
      for (const role of perm.ROLES) {
        const v = r[role];
        try {
          const other = await pr.run(role);
          const okOther = expectAllowed(role, v, false) ? !refused(other) && other.status < 500 : refused(other);
          check(`${r.id}: ${role} (${v}${v === 'own' ? ', someone else\'s' : ''}) ${expectAllowed(role, v, false) ? 'allowed' : 'refused'}`, okOther, `got ${other.status} ${String(other.text || '').slice(0, 160)}`);
          if (v === 'own') {
            if (!pr.own) { check(`${r.id}: an own-probe exists`, false); continue; }
            const own = await pr.own(role);
            check(`${r.id}: ${role} (own, their own) allowed`, !refused(own) && own.status < 500, `got ${own.status} ${String(own.text || '').slice(0, 160)}`);
          }
        } catch (e) { check(`${r.id}: ${role} probe ran`, false, e.message); }
      }
    }

    console.log('T-0247: the five rules the owner tightened');
    { const m1 = await say(MI.token, 'a message that should not be here'), m2 = await say(MAX, 'another one');
      const memberTry = await call('POST', '/api/messages/delete', { token: MAX, body: { id: m1.id } }), agentTry = await call('POST', '/api/messages/delete', { token: T.agent, body: { id: m1.id } });
      const ownerEdit = await call('POST', '/api/messages/edit', { token: O.token, body: { id: m1.id, text: 'rewritten by the owner' } });
      const ownerDel = await call('POST', '/api/messages/delete', { token: O.token, body: { id: m1.id } }), adminDel = await call('POST', '/api/messages/delete', { token: AD.token, body: { id: m2.id } });
      const rec = (await call('GET', '/account/workspace/audit', { token: O.token })).json?.audit || [];
      check('T-0247: a member and an agent cannot remove someone else\'s message, and the owner cannot change its words', memberTry.status === 403 && agentTry.status === 403 && ownerEdit.status === 403, [memberTry.status, agentTry.status, ownerEdit.status].join());
      check('T-0247: the owner and an admin remove someone else\'s message, and the activity record says whose it was', ownerDel.status === 200 && !!ownerDel.json?.message?.deleted && adminDel.status === 200
        && rec.some(a => a.action === 'message-remove' && a.actor === 'olive' && a.author === 'mia') && rec.some(a => a.action === 'message-remove' && a.actor === 'adam' && a.author === 'max'), JSON.stringify([ownerDel.status, adminDel.status, rec.filter(a => a.action === 'message-remove')]));
      const dmKey = (await call('POST', '/api/rooms', { token: MAX, body: { dm: 'mia' } })).json?.room, dmMsg = dmKey ? (await call('POST', '/api/messages', { token: MAX, body: { text: 'just between us', room: dmKey } })).json?.message : null;
      const dmDel = dmMsg ? await call('POST', '/api/messages/delete', { token: O.token, body: { id: dmMsg.id } }) : { status: 0 };
      check('T-0247: the owner cannot remove a message in a direct conversation between two other people', !!dmMsg && dmDel.status === 403, JSON.stringify([dmKey, dmDel.status])); }
    { await call('POST', '/api/rooms', { token: O.token, body: { name: 'Plans', topic: 'the real topic' } });
      const again = await call('POST', '/api/rooms', { token: MAX, body: { name: 'plans', topic: 'taken over' } }), agentAgain = await call('POST', '/api/rooms', { token: T.agent, body: { name: 'PLANS', topic: 'taken over' } });
      const room = (await call('GET', '/api/rooms', { token: O.token })).json?.rooms?.plans;
      check('T-0247: a room name that is taken is refused (a member and an agent), and the room keeps its name and topic', again.status === 409 && agentAgain.status === 409 && again.json?.room === 'plans' && room?.name === 'Plans' && room?.topic === 'the real topic', JSON.stringify([again.status, agentAgain.status, room])); }
    { const id = await propose(MI.token, 'mia proposed this');
      const maxEdit = await call('POST', `/api/tickets/${id}/edit`, { token: MAX, body: { by: 'max', title: uniq('rewritten by max') } }), botEdit = await call('POST', `/api/tickets/${id}/edit`, { token: T.agent, body: { by: 'bot-a', title: uniq('rewritten by a bot') } });
      const adminEdit = await call('POST', `/api/tickets/${id}/edit`, { token: AD.token, body: { by: 'adam', title: uniq('tidied by adam') } });
      const botOwn = await call('POST', `/api/tickets/${await propose(T.agent, 'the bot proposed this')}/edit`, { token: T.agent, body: { by: 'bot-a', title: uniq('the bot fixed its own') } });
      check('T-0247: a proposed ticket is changed by its proposer, the owner or an admin; another member or an agent is refused', maxEdit.status === 403 && botEdit.status === 403 && adminEdit.status === 200 && botOwn.status === 200, [maxEdit.status, botEdit.status, adminEdit.status, botOwn.status].join()); }
    { const id = await approved(MAX); await claim(MAX, id);
      const miaUp = await call('POST', `/api/tickets/${id}/update`, { token: MI.token, body: { by: 'mia', note: 'not mine' } }), botClose = await call('POST', `/api/tickets/${id}/close`, { token: T.agent, body: { by: 'bot-a', note: 'closing something I do not hold, which must fail' } });
      const botLog = await call('POST', `/api/tickets/${id}/log`, { token: T.agent, body: { by: 'bot-a', line: 'not my ticket' } }), ownerUp = await call('POST', `/api/tickets/${id}/update`, { token: O.token, body: { by: 'olive', note: 'the owner looked in' } });
      const unheld = await approved(MAX), botUnheld = await call('POST', `/api/tickets/${unheld}/update`, { token: T.agent, body: { by: 'bot-a', note: 'nobody holds it' } });
      const maxClose = await call('POST', `/api/tickets/${id}/close`, { token: MAX, body: { by: 'max', note: 'done: the one item in the ticket, checked by hand' } });
      const miaOwn = await approved(MI.token), miaNote = await call('POST', `/api/tickets/${miaOwn}/update`, { token: MI.token, body: { by: 'mia', note: 'a note on my own proposal' } }), miaClose = await call('POST', `/api/tickets/${miaOwn}/close`, { token: MI.token, body: { by: 'mia', note: 'closing without taking it first, which must fail' } });
      check('T-0247: while nobody holds a ticket its proposer adds notes, but closing needs the holder, the owner or an admin', miaNote.status === 200 && miaClose.status === 403, [miaNote.status, miaClose.status].join());
      check('T-0247: a held ticket is reported on and closed by its holder, the owner or an admin; others and agents are refused', miaUp.status === 403 && botClose.status === 403 && botLog.status === 403 && botUnheld.status === 403 && /Take it first/.test(botUnheld.json?.error || '') && ownerUp.status === 200 && maxClose.status === 200,
        [miaUp.status, botClose.status, botLog.status, botUnheld.status, ownerUp.status, maxClose.status].join()); }
    { const set = await call('POST', '/account/workspace', { token: O.token, body: { approval: { approvers: ['olive', 'mia'], noSelf: true, two: 'none' } } });
      const r1 = await review(), adamTry = await call('POST', `/api/reviews/${r1}/approve`, { token: AD.token, body: { by: 'adam' } });
      const r2 = (await call('POST', '/api/reviews', { token: MI.token, body: { by: 'mia', note: 'mine', files: [{ path: 'a.txt', diff: '--- a\n+++ b\n-x\n+y\n' }] } })).json?.id;
      const miaSelf = await call('POST', `/api/reviews/${r2}/approve`, { token: MI.token, body: { by: 'mia' } }), oliveOk = await call('POST', `/api/reviews/${r2}/approve`, { token: O.token, body: { by: 'olive' } });
      await call('POST', '/account/workspace', { token: O.token, body: { approval: { approvers: [], noSelf: false, two: 'none' } } });
      check('T-0247: code reviews follow the owner\'s approval rules: only the named approvers, and nobody approves a review they started', set.status === 200 && adamTry.status === 403 && miaSelf.status === 403 && /started/.test(miaSelf.json?.error || '') && oliveOk.status === 200,
        JSON.stringify([set.status, adamTry.json, miaSelf.json, oliveOk.status])); }

    { const held = await approved(MAX); await claim(MAX, held);                                                   // T-0262
      const miaRel = await call('POST', `/api/tickets/${held}/release`, { token: MI.token, body: { by: 'mia' } }), miaCan = await call('POST', `/api/tickets/${held}/cancel`, { token: MI.token, body: { by: 'mia', reason: 'not mine to cancel' } });
      const adminRel = await call('POST', `/api/tickets/${held}/release`, { token: AD.token, body: { by: 'adam' } });
      const miaOwn = await approved(MI.token), miaOwnCan = await call('POST', `/api/tickets/${miaOwn}/cancel`, { token: MI.token, body: { by: 'mia', reason: 'I proposed it; no longer needed' } });
      check('T-0262: a member cannot give back or cancel a ticket someone else holds or proposed; an admin gives it back; the proposer cancels their own', miaRel.status === 403 && /held by max/.test(miaRel.json?.error || '') && miaCan.status === 403 && adminRel.status === 200 && miaOwnCan.status === 200,
        [miaRel.status, miaCan.status, adminRel.status, miaOwnCan.status].join()); }

    { const up = async (tok, body) => (await (await fetch(BASE + '/api/files?room=general', { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'text/markdown', 'X-File-Name': 'SOP.md' }, body })).json()).file?.id;   // T-0266
      const fid = await up(MI.token, 'version one'); await say(MI.token, 'the SOP', { attachments: [fid] });
      const ver = (tok, body) => fetch(BASE + `/api/files/${fid}/version`, { method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'text/markdown' }, body }).then(async r => ({ status: r.status, json: await r.json().catch(() => null) }));
      const get = async (p, tok = MI.token) => { const r = await fetch(BASE + p, { headers: { Authorization: `Bearer ${tok}` } }); return { status: r.status, text: await r.text() }; };
      const before = (await call('GET', '/api/files', { token: O.token })).json?.bytes;
      const v2 = await ver(MI.token, 'version two, longer'), now = await get(`/api/files/${fid}`), list = (await call('GET', `/api/files/${fid}/versions`, { token: MI.token })).json;
      const old = list?.versions?.[0] ? await get(`/api/files/${fid}/versions/${list.versions[0].id}`) : { status: 0 };
      const after = (await call('GET', '/api/files', { token: O.token })).json?.bytes;
      check('T-0266: a new version keeps the file id; the link gives the new bytes, the earlier version stays downloadable, and both count toward the file space',
        v2.status === 200 && v2.json?.file?.id === fid && v2.json.file.version === 2 && now.text === 'version two, longer' && list?.versions?.length === 1 && list.versions[0].n === 1 && old.status === 200 && old.text === 'version one' && after - before === 'version two, longer'.length,
        JSON.stringify([v2.status, v2.json?.file, now.text, list, old.status, before, after]));
      const same = await ver(MI.token, 'version two, longer'), maxTry = await ver(MAX, 'max tries'), botTry = await ver(T.agent, 'a bot tries'), vicTry = await ver(VI.token, 'a viewer tries'), adminV = await ver(AD.token, 'version three, by the admin');
      check('T-0266: the same bytes change nothing; another member, an agent and a viewer are refused; an admin may upload a version',
        same.status === 200 && same.json?.unchanged === true && maxTry.status === 403 && botTry.status === 403 && vicTry.status === 403 && adminV.status === 200 && adminV.json?.file?.version === 3,
        JSON.stringify([same.json, maxTry.status, botTry.status, vicTry.status, adminV.status]));
      const etag = (await fetch(BASE + `/api/files/${fid}`, { headers: { Authorization: `Bearer ${MI.token}` } })).headers.get('etag'), cached = await fetch(BASE + `/api/files/${fid}`, { headers: { Authorization: `Bearer ${MI.token}`, 'If-None-Match': etag || 'x' } });
      check('T-0266: browsers re-check the file link (an ETag, no longer cached for a year), so a new version shows at once', !!etag && cached.status === 304, String(etag));
      const vids = ((await call('GET', `/api/files/${fid}/versions`, { token: MI.token })).json?.versions || []).map(v => v.id);
      const del = await call('DELETE', `/api/files/${fid}`, { token: O.token }), gone = vids[0] ? await get(`/api/files/${fid}/versions/${vids[0]}`, O.token) : { status: 0 };
      check('T-0266: deleting the file removes its earlier versions too', del.status === 200 && vids.length === 2 && gone.status === 404, JSON.stringify([del.status, vids.length, gone.status])); }

    console.log('T-0245: agents and the Tasks list');
    { const ag = T.agent, tid = await task(MAX), boxed = (await call('POST', '/api/tasks', { token: O.token, body: { title: uniq('Daily Backups'), every: 'day', agentTick: true } })).json?.task?.id;
      const off = await call('GET', '/api/tasks', { token: ag }), offTick = await call('POST', `/api/tasks/${boxed}/done`, { token: ag, body: { note: 'Chamber backup ok at 03:46 UTC' } });
      check('T-0245: with the switch off an agent sees no tasks and ticks none, and is told the owner decides', off.status === 403 && /owner has not let agents/.test(off.json?.error || '') && offTick.status === 403 && (await call('GET', '/api/me', { token: ag })).json?.tasksDue === undefined, JSON.stringify([off.json, offTick.json]));
      const mOn = await call('POST', '/account/workspace', { token: MI.token, body: { agentTasks: true } }), aOn = await call('POST', '/account/workspace', { token: AD.token, body: { agentTasks: true } });
      const on = await call('POST', '/account/workspace', { token: O.token, body: { agentTasks: true } });
      check('T-0245: only the owner switches it on (members and admins are refused); the Account page reads it back', mOn.status === 403 && aOn.status === 403 && on.status === 200 && (await call('GET', '/account/workspace', { token: O.token })).json?.agentTasks === true, JSON.stringify([mOn.status, aOn.status, on.json]));
      const list = await call('GET', '/api/tasks', { token: ag }), mine = (list.json?.tasks || []).find(t => t.id === boxed);
      check('T-0245: switched on, the agent sees the list, which tasks it may tick, and may add or change none', list.status === 200 && mine && mine.agentTick === true && mine.mayTick === true && mine.canManage === false && list.json.canAdd === false && (list.json.tasks.find(t => t.id === tid) || {}).mayTick === false, JSON.stringify(list.json).slice(0, 300));
      check('T-0245: the agent\'s check-in says how many tasks it may tick are due', (await call('GET', '/api/me', { token: ag })).json?.tasksDue >= 1);
      { const prop = await call('POST', '/api/tasks/propose', { token: ag, body: { title: uniq('Daily Moltbook check'), every: 'day', remindAt: '23:58', tz: 'UTC' } }), pid = prop.json?.task?.id;   // T-0264
        const row = ((await call('GET', '/api/tasks', { token: O.token })).json?.tasks || []).find(t => t.id === pid);
        const tickEarly = await call('POST', `/api/tasks/${pid}/done`, { token: ag, body: { note: 'checked the feed at 09:02 UTC' } }), memConfirm = await call('POST', `/api/tasks/${pid}/confirm`, { token: MI.token, body: {} });
        const tickBefore = (await call('GET', `/api/_test/tick?at=${Date.now()}`)).json?.tasksPinged || [], ownConfirm = await call('POST', `/api/tasks/${pid}/confirm`, { token: O.token, body: {} });
        check('T-0264: an agent proposes a recurring task that reminds itself; it waits (not due, not tickable, no reminder) until the owner confirms it; a member cannot confirm',
          prop.status === 201 && row?.proposed === true && row.due === 'proposed' && row.remindAgent === 'bot-a' && row.remindAt === '23:58' && tickEarly.status === 400 && memConfirm.status === 403 && !tickBefore.some(x => x.task === pid) && ownConfirm.status === 200 && ownConfirm.json?.task?.proposed === false,
          JSON.stringify([prop.json, row, tickEarly.json, memConfirm.status, ownConfirm.json]));
        const day = new Date(), at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 23, 58, 30);
        const early = (await call('GET', `/api/_test/tick?at=${at - 3 * 60e3}`)).json?.tasksPinged || [], first = (await call('GET', `/api/_test/tick?at=${at}`)).json?.tasksPinged || [], again = (await call('GET', `/api/_test/tick?at=${at + 50e3}`)).json?.tasksPinged || [];
        const ping = ((await call('GET', '/api/messages?room=general', { token: O.token })).json?.messages || []).find(m => m.id === (first.find(x => x.task === pid) || {}).message);
        check('T-0264: at its time the agent is reminded once, in the name of the owner who confirmed it (so its connector acts on it); not before, not twice',
          !early.some(x => x.task === pid) && first.filter(x => x.task === pid).length === 1 && !again.some(x => x.task === pid) && ping?.username === 'olive' && /^@bot-a Task due \(Tasks tab\)/.test(ping?.text || ''), JSON.stringify([early, first, again, ping?.username, ping?.text]));
        const badAgent = await call('POST', '/api/tasks', { token: O.token, body: { title: uniq('remind nobody'), every: 'day', remindAt: '08:00', remindAgent: 'nobody-here' } }), noAgent = await call('POST', '/api/tasks', { token: O.token, body: { title: uniq('remind whom'), every: 'day', remindAt: '08:00' } });
        check('T-0264: a reminder must name a real agent of the workspace', badAgent.status === 400 && /no agent called/.test(badAgent.json?.error || '') && noAgent.status === 400, JSON.stringify([badAgent.json, noAgent.json])); }
      const noBox = await call('POST', `/api/tasks/${tid}/done`, { token: ag, body: { note: 'checked the thing carefully' } }), noNote = await call('POST', `/api/tasks/${boxed}/done`, { token: ag, body: { note: 'ok' } });
      check('T-0245: the agent cannot tick a task that is not marked, nor one without saying what it checked', noBox.status === 403 && /not marked/.test(noBox.json?.error || '') && noNote.status === 400, JSON.stringify([noBox.json, noNote.json]));
      const ok = await call('POST', `/api/tasks/${boxed}/done`, { token: ag, body: { note: 'Chamber backup ok at 03:46 UTC, 19 copies kept' } }), seen = ((await call('GET', '/api/tasks', { token: O.token })).json?.tasks || []).find(t => t.id === boxed);
      check('T-0245: a marked task ticked by the agent shows the agent and what it checked', ok.status === 200 && seen?.done?.by === 'bot-a' && seen.done.agent === true && seen.done.note === 'Chamber backup ok at 03:46 UTC, 19 copies kept', JSON.stringify(seen?.done));
      const rec = (await call('GET', '/account/workspace/audit?format=json', { token: O.token })).json?.entries || [];
      check('T-0245: the tick and its note are on the record, and so is the switch', rec.some(e => e.action === 'task-done' && e.actor === 'bot-a' && /19 copies/.test(e.note || '')) && rec.some(e => e.action === 'agent-tasks' && e.on === true));
      const undo = await call('POST', `/api/tasks/${boxed}/undo`, { token: ag, body: {} }), rm = await call('POST', `/api/tasks/${boxed}/remove`, { token: ag, body: {} }), ed = await call('POST', `/api/tasks/${boxed}`, { token: ag, body: { title: 'renamed by an agent' } }), add = await call('POST', '/api/tasks', { token: ag, body: { title: 'added by an agent', every: 'day' } });
      check('T-0245: even switched on, an agent cannot take a tick back, remove, change or add a task', [undo, rm, ed, add].every(r => r.status === 403), JSON.stringify([undo.status, rm.status, ed.status, add.status]));
      const Z = (await call('POST', '/account/signup', { body: { email: 'zed@test.invalid', username: 'zed', password: 'password-for-tests', invite: INVITE } })).json; await verify('zed');
      await call('POST', '/account/workspace', { token: Z.token, body: { agentTasks: true } }); const zt = (await call('POST', '/account/workspace/tokens', { token: Z.token, body: { name: 'Z bot', username: 'zed-bot' } })).json?.token;
      const zl = await call('GET', '/api/tasks', { token: zt });
      check('T-0245: an agent of another workspace sees none of these tasks', zl.status === 200 && !zl.text.includes('Daily Backups') && !zl.text.includes('water the plants'), zl.text.slice(0, 200));
      await call('POST', '/account/workspace', { token: O.token, body: { agentTasks: false } });
      check('T-0245: switched off again, the agent is refused again', (await call('GET', '/api/tasks', { token: ag })).status === 403);
    }

    console.log('T-0244: folders that hold other people\'s files');
    { await call('POST', '/api/folders', { token: MI.token, body: { path: 'shared box' } }); await call('PATCH', `/api/files/${await upload(MI.token)}`, { token: MI.token, body: { folder: 'shared box' } }); await call('PATCH', `/api/files/${await upload(MAX)}`, { token: MAX, body: { folder: 'shared box' } });
      const del = await call('POST', '/api/folders', { token: MI.token, body: { path: 'shared box', delete: true, contents: 'parent' } });
      const flags = (await call('GET', '/api/files?folder=shared%20box', { token: MI.token })).json?.folders || [], mine = flags.find(f => f.path === 'shared box');
      check('T-0244: a member cannot delete a folder with someone else\'s file in it, and is told why', del.status === 403 && /other people shared/.test(del.json?.error || ''), JSON.stringify(del.json));   // the files staying is shown below: the admin's delete moves both
      check('T-0244: the app is told which folders the person may change', mine && mine.canChange === false && (await call('GET', '/api/folders', { token: O.token })).json.folders.find(f => f.path === 'shared box')?.canChange === true && (await call('GET', '/api/folders', { token: VI.token })).json.folders.every(f => f.canChange === false), JSON.stringify(mine));
      await call('POST', '/api/folders', { token: MI.token, body: { path: 'just mine' } }); await call('PATCH', `/api/files/${await upload(MI.token)}`, { token: MI.token, body: { folder: 'just mine' } });
      const d2 = await call('POST', '/api/folders', { token: MI.token, body: { path: 'just mine', delete: true, contents: 'parent' } });
      const d3 = await call('POST', '/api/folders', { token: AD.token, body: { path: 'shared box', delete: true, contents: 'parent' } });
      check('T-0244: a member deletes a folder of their own files; an admin deletes the mixed one and its files move up', d2.status === 200 && d2.json.moved === 1 && d3.status === 200 && d3.json.moved === 2, JSON.stringify([d2.json, d3.json]));
    }

    // ── 4. the gate: every route, every role whose cell says no ──────────────────────────────────────────────────────
    if (GATE_ONLY) {
      console.log('the gate: every route refuses a role whose cell says no, before the feature runs');
      const sample = p => p.replace(/:id/g, 'x0');
      let tried = 0; const wrong = [];
      for (const r of perm.RULES) for (const rt of r.routes) {
        const [m, p] = rt.split(' ');
        if (p.startsWith('/billing/')) continue;                              // billing answers with its own words (not gated)
        for (const role of perm.ROLES) {
          if (r[role] !== 'no') continue;
          if (role === 'agent' && p.startsWith('/account/')) continue;      // an agent token is not an account session: 401 there, tested in part 3
          if (role === 'agent' && r.recorded) continue;                      // the feature refuses and records it (part 3 tries it with a real ticket)
          const res = await call(m, sample(p), { token: T[role], body: m === 'GET' ? undefined : {} }); tried++;
          if (!(res.status === 403 || (res.status === 401 && p.startsWith('/account/')))) wrong.push(`${role} ${m} ${p} -> ${res.status}`);
        }
      }
      check(`the gate refuses all ${tried} tries by a role whose cell says no`, !wrong.length, wrong.slice(0, 12).join(' | '));
      const g = await call('POST', '/api/archives', { token: T.agent, body: {} }), v = await call('POST', '/api/messages', { token: T.viewer, body: { text: 'x' } });
      check('a guest calling a path that is no action is refused, as before', (await call('POST', '/api/requests/mail/x', { token: T.requester, body: {} })).status === 403 && (await call('POST', '/api/no-such-thing', { token: T.viewer, body: {} })).status === 403 && (await call('POST', '/api/no-such-thing', { token: T.member, body: {} })).status === 404);
      const ag = await call('POST', `/api/tickets/${await propose(MAX, 'an agent tries to approve')}/approve`, { token: T.agent, body: { by: 'bot-a' } });
      const rec = (await call('GET', '/account/workspace/audit?format=json', { token: O.token })).json?.entries || [];
      check('an agent trying to approve is refused by the feature and written on the activity record', ag.status === 403 && /only a person/.test(ag.json?.error || '') && rec.some(e => e.action === 'ticket-approve-refused' && e.actor === 'bot-a'), JSON.stringify([ag.status, rec.slice(-3).map(e => e.action)]));
      check('a refusal names what the action is, and guests keep their sentences', /people, not agents/.test(g.json?.error || '') && /viewer in this workspace/.test(v.json?.error || ''), JSON.stringify([g.json, v.json]));
    }

    // ── 5. Help shows the same table ─────────────────────────────────────────────────────────────────────────────────
    console.log('Help shows the table');
    const help = fs.readFileSync(path.join(APP, 'public', 'help.html'), 'utf8'), gen = require('./tools/permissions-help.js').html();
    const a = help.indexOf('<!-- permissions:start'), b = help.indexOf('<!-- permissions:end -->');
    check('the Who can do what table in Help is made from permissions.js (run: node tools/permissions-help.js --write)', a > 0 && b > a && help.slice(a, b + '<!-- permissions:end -->'.length) === gen);
  } catch (e) { fail++; console.log('  FAIL crashed: ' + (e.stack || e.message)); }
  finally {
    srv.kill(); try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
