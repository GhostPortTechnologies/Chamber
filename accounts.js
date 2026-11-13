// accounts.js — user accounts, workspaces (tenants) and the Stripe paywall for Chamber.
// Zero dependencies (Node built-ins only).
//
// Enabled with CHAMBER_ACCOUNTS=1. Then:
//   - /            landing page (signed-in + paid visitors go straight to /app)
//   - /signup, /login, /billing, /join/<code>   views of the same landing page (public/landing.html)
//   - /app         the Chamber app — only for entitled accounts (paid workspace, or admin)
//   - /account/*   sign-up, login, logout, "who am I", workspace + members + invite link
//   - /billing/*   Stripe Checkout (subscribe), Billing Portal (manage/cancel), status refresh
//   - /webhooks/stripe   Stripe tells us when a subscription is paid, changed or cancelled
//
// WORKSPACES (T-0001): every account belongs to exactly one workspace. A plain sign-up creates a new
// workspace and makes the account its owner; a sign-up through an invite link joins an existing
// workspace as a member. The subscription belongs to the owner; members ride on it. server.js keeps
// each workspace's chat / tickets / reviews in its own files (see F() there) and resolves the
// workspace from the session on every request (T-0002), so nothing is shared between workspaces.
//
// Accounts live in accounts.json next to chamber.json. Passwords are scrypt-hashed; never stored in clear.
// Admin accounts (role "admin", GhostPort staff) never need a subscription. Create one with: sudo chamber-admin add <email> <username>
//
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 GhostPort Technologies

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https'); const http = require('http');
const fleet = require('./fleet');                                             // T-0153: GhostPort fleet link (router status, read-only)
const { execFile, execFileSync } = require('child_process');      // T-0010: /source archive via git; T-0036: changelog
const cron = require('./cron');                                   // T-0058: schedules
let changelogCache = { at: 0, html: '' };                           // T-0036
const mail = require('./mail');                                   // T-0008: password-reset email (optional)
const push = require('./push');                                   // T-0013: push notifications
const notify = require('./notify');                               // T-0078: per-room level + quiet hours routing

const ENABLED = process.env.CHAMBER_ACCOUNTS === '1';
const STRIPE_KEY = process.env.CHAMBER_STRIPE_SECRET || '';
const WEBHOOK_SECRET = process.env.CHAMBER_STRIPE_WEBHOOK_SECRET || '';
const PRICE = process.env.CHAMBER_STRIPE_PRICE || '';
const PUBLIC_URL = (process.env.CHAMBER_PUBLIC_URL || '').replace(/\/$/, '');
const SELF_HOSTED = process.env.CHAMBER_SELF_HOSTED === '1';                // T-0061: workspaces without Stripe; everyone entitled
// Storage add-on (2026-11-13). One "pack" is CHAMBER_STORAGE_PACK_GB (10) more file space for the whole workspace, billed yearly as a
// second line on the owner's subscription (quantity = packs). Nothing is offered and nothing can be charged until BOTH
// CHAMBER_STRIPE_STORAGE_PRICE (a Stripe yearly price id) and CHAMBER_STORAGE_PRICE_LABEL (the words the buyer sees, e.g.
// "$49 / year") are set. CHAMBER_STORAGE_SELLABLE_GB caps the total sold across all workspaces to what the disk really has.
const STORAGE_PRICE = process.env.CHAMBER_STRIPE_STORAGE_PRICE || '', STORAGE_LABEL = (process.env.CHAMBER_STORAGE_PRICE_LABEL || '').slice(0, 40);
const STORAGE_PACK_GB = Math.max(1, parseInt(process.env.CHAMBER_STORAGE_PACK_GB, 10) || 10), STORAGE_MAX_PACKS = Math.max(1, parseInt(process.env.CHAMBER_STORAGE_MAX_PACKS, 10) || 10);
const STORAGE_SELLABLE_GB = Math.max(0, parseInt(process.env.CHAMBER_STORAGE_SELLABLE_GB, 10) || 20), STORAGE_BASE_MB = parseInt(process.env.CHAMBER_FILES_QUOTA_MB, 10) || 500;
const STORAGE_ON = () => !SELF_HOSTED && !!STORAGE_PRICE && !!STORAGE_LABEL;
const STRIPE_TEST_PORT = process.env.CHAMBER_TEST_HOOKS === '1' ? parseInt(process.env.CHAMBER_STRIPE_TEST_PORT, 10) || 0 : 0;   // tests only: a stand-in Stripe on loopback
const CONTACT_TO = process.env.CHAMBER_CONTACT_TO || 'support@ghostporttechnologies.com';   // T-0162: where the website contact form is mailed
const CONTACT_PER_HOUR = parseInt(process.env.CHAMBER_CONTACT_PER_HOUR, 10) || 3; const contactHits = new Map(), contactDay = [];
// T-0159: free trial. CHAMBER_TRIAL_DAYS=14 lets anyone start a workspace without an invite code or a card. Full access for
// that many days once the email address is confirmed, then read-only until the owner subscribes; nothing is deleted. Guards:
// a confirmed email (so the trial is off when the server cannot send mail), a few new workspaces per network address per
// day, 2 agents and a small file allowance while on trial. Unset or 0 = no trial, exactly the old behaviour.
const TRIAL_DAYS = SELF_HOSTED ? 0 : Math.max(0, parseInt(process.env.CHAMBER_TRIAL_DAYS, 10) || 0), TRIAL_MS = TRIAL_DAYS * 86400e3, TRIAL_TOKENS = 2;
const TRIAL_SIGNUPS_PER_IP_DAY = parseInt(process.env.CHAMBER_TRIAL_SIGNUPS_PER_IP_DAY, 10) || 3; const trialSignups = new Map();
const TRIAL_ON = () => TRIAL_DAYS > 0 && VERIFY_REQUIRED();
const onTrialClock = acct => !!acct && !acct.subStatus && !!acct.trialEndsAt;      // started on a trial and has never subscribed
// T-0175: one email 3 days before a trial ends and one when it ends. T-0176: a trial sign-up whose email was never confirmed is
// removed after CHAMBER_UNCONFIRMED_DAYS (7). Both run from trialHousekeeping(), called hourly by server.js maintenance.
const TRIAL_SOON_MS = 3 * 86400e3, UNCONFIRMED_MS = (parseInt(process.env.CHAMBER_UNCONFIRMED_DAYS, 10) || 7) * 86400e3;
const INVITE_CODE = process.env.CHAMBER_INVITE_CODE || '';           // when set, creating a NEW workspace needs this code (invite links bypass it)
const DATA_DIR = path.dirname(process.env.CHAMBER_DATA || path.join(__dirname, 'chamber.json'));
const FILE = process.env.CHAMBER_ACCOUNTS_FILE || path.join(DATA_DIR, 'accounts.json');
const LANDING = path.join(__dirname, 'public', 'landing.html');

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const USER_RE = /^[a-zA-Z0-9_-]{2,24}$/;
const WS_RE = /^[a-f0-9]{16}$/;
const RESERVED_NAMES = new Set(['chamber-reminder', 'github-issues', 'chamber']);   // review 2026-11-13: names Chamber itself posts or records under; nobody else may take them
const MIN_PASSWORD = 10;
const MAX_MEMBERS = parseInt(process.env.CHAMBER_MAX_MEMBERS, 10) || 25;
// T-0199: guest seats for the business side. A viewer reads everything (and approves when the owner names them, T-0190); a requester
// only sends requests and follows their own. Guests do not use one of the MAX_MEMBERS seats; they have their own limit.
const MAX_GUESTS = parseInt(process.env.CHAMBER_MAX_GUESTS, 10) || 25, GUEST_ROLES = ['viewer', 'requester'];   // T-0033: seats per workspace (owner included)
const TEST_HOOKS = process.env.CHAMBER_TEST_HOOKS === '1';
// T-0032: email verification. Enforced when we can actually send mail (or in the test harness, which reads the link from the log).
// Unverified accounts can log in and use a workspace they were invited to, but cannot start checkout, rotate the invite link
// or create agent tokens: the address must be real before it anchors billing or invites. Accounts from before this change
// (no emailVerified field) count as verified.
const VERIFY_REQUIRED = () => mail.enabled || TEST_HOOKS;
// ── TOTP two-factor (T-0040), RFC 6238 with HMAC-SHA1, 6 digits, 30 s, ±1 step ─────────────────────────────
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) { let bits = 0, val = 0, out = ''; for (const b of buf) { val = (val << 8) | b; bits += 8; while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; } } if (bits) out += B32[(val << (5 - bits)) & 31]; return out; }
function b32dec(s) { let bits = 0, val = 0; const out = []; for (const c of s.toUpperCase().replace(/[^A-Z2-7]/g, '')) { val = (val << 5) | B32.indexOf(c); bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8; } } return Buffer.from(out); }
function totpAt(secret, counter) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', b32dec(secret)).update(msg).digest(); const o = h[19] & 15;
  return String(((h.readUInt32BE(o) & 0x7fffffff) % 1e6)).padStart(6, '0');
}
function totpOk(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\s+/g, ''); if (!/^\d{6}$/.test(c)) return false;
  const ctr = Math.floor(now / 30000);
  return [ctr - 1, ctr, ctr + 1].some(k => same(totpAt(secret, k), c));
}
function useRecovery(acct, code) {                                   // consumes a recovery code; true if it matched
  const c = String(code || '').replace(/[\s-]/g, '').toLowerCase(); if (c.length < 8) return false;
  const h = sha(c); const i = (acct.totpRecovery || []).indexOf(h); if (i < 0) return false;
  acct.totpRecovery.splice(i, 1); return true;
}
// 2026-11-13: at most 10 wrong codes per account in 15 minutes, then every code is refused until the window ends. Without this,
// someone who had the password could keep guessing 6-digit codes. Callers already save the store after a wrong code.
const MFA_MAX_FAILS = 10, MFA_WINDOW_MS = 15 * 60e3;
function mfaLocked(acct) { const f = acct && acct.mfaFail; return !!f && f.n >= MFA_MAX_FAILS && Date.now() - f.at < MFA_WINDOW_MS; }
function secondFactorOk(acct, code) {
  if (!acct.totp || mfaLocked(acct)) return false;
  const ok = totpOk(acct.totp.secret, code) || useRecovery(acct, code);
  const f = acct.mfaFail && Date.now() - acct.mfaFail.at < MFA_WINDOW_MS ? acct.mfaFail : null;
  if (ok) delete acct.mfaFail; else acct.mfaFail = { n: (f ? f.n : 0) + 1, at: f ? f.at : Date.now() };
  return ok;
}
// T-0048: one place that mints an agent token (used by the account page and by device-code pairing)
function createAgentToken(store, ctx, ws, by, name, username) {
  name = String(name || '').trim().slice(0, 48); username = String(username || '').trim();
  if (name.length < 2) return { error: 'Give the token a name (2 to 48 characters), e.g. "Pi Claude".' };
  if (!USER_RE.test(username)) return { error: 'Agent username: 2 to 24 letters, numbers, - or _.' };
  if (RESERVED_NAMES.has(username.toLowerCase())) return { error: 'That username is taken.', code: 409 };
  if (store.usernames[username.toLowerCase()]) return { error: 'That username is taken.', code: 409 };
  if (billingState(store.accounts[ws.owner]) === 'trial' && Object.keys(ws.tokens || {}).length >= TRIAL_TOKENS) return { error: `The free trial includes ${TRIAL_TOKENS} agents. Subscribe on the Account page to add more.`, code: 403 };   // T-0159
  if (Object.keys(ws.tokens || {}).length >= 20) return { error: 'Limit of 20 agent tokens per workspace.' };
  const id = crypto.randomBytes(4).toString('hex'), secret = crypto.randomBytes(24).toString('base64url');
  (ws.tokens ||= {})[id] = { id, name, username, hash: sha(secret), createdAt: Date.now(), createdBy: by.email };
  store.usernames[username.toLowerCase()] = `agent:${ws.id}`;
  ctx.withWorkspace(ws.id, () => { const data = ctx.loadData(); data.users[username] ||= { username, role: 'ai', lastSeen: 0, joinedAt: Date.now() }; ctx.saveData(data); });
  console.log(`[accounts] ${by.username} created agent token ${id} (${username}) in ${ws.id}`);
  return { id, username, token: `chk_${id}_${secret}` };
}
function sweepPairing(store) { const now = Date.now(); for (const [c, p] of Object.entries(store.pairing || {})) if (p.expires < now) delete store.pairing[c]; }
function cookieOf(req, name) { const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)')); return m ? m[1] : null; }
function rememberedDevice(req, acct) {
  const c = cookieOf(req, 'chamber_mfa'); if (!c || !acct.mfaDevices) return false;
  acct.mfaDevices = acct.mfaDevices.filter(d => d.expires > Date.now());
  return acct.mfaDevices.some(d => same(d.hash, sha(c)));
}
function verified(acct) { return !acct || acct.emailVerified !== false; }
function startVerification(store, acct, reason) {
  const token = crypto.randomBytes(24).toString('base64url');
  store.verifications ||= {};
  for (const [k, v] of Object.entries(store.verifications)) if (v.expires < Date.now() || v.email === acct.email) delete store.verifications[k];
  store.verifications[sha(token)] = { email: acct.email, expires: Date.now() + 24 * 3600e3 };
  acct.emailVerified = false; acct.verifySentAt = Date.now();
  const link = `${PUBLIC_URL}/account/verify/${token}`;
  if (TEST_HOOKS) console.log(`[accounts] verify link for ${acct.username}: ${link}`);
  if (mail.enabled) mail.send({ to: acct.email, subject: 'Chamber: confirm your email address',
      text: `Hi ${acct.username},\n\n${reason}\nOpen this link within 24 hours to confirm ${acct.email}:\n\n${link}\n\nIf you did not create a Chamber account, ignore this message.\n` })
    .then(ok => console.log(`[accounts] verification email ${ok ? 'sent' : 'skipped'} for ${acct.username}`), e => console.error('[accounts] verification email failed:', e.message));
}
function noteLogin(req, acct) {                                   // T-0032: remember where logins come from; email on a new address
  const ip = clientIp(req), ua = String(req.headers['user-agent'] || '').slice(0, 120), at = Date.now();
  const seen = (acct.logins || []).some(l => l.ip === ip);
  acct.logins = [...(acct.logins || []), { ip, ua, at }].slice(-10);
  if (!seen && acct.logins.length > 1 && mail.enabled) {
    mail.send({ to: acct.email, subject: 'Chamber: new sign-in to your account',
      text: `Hi ${acct.username},\n\nYour Chamber account was just signed in from a new address.\n\n  When:   ${new Date(at).toUTCString()}\n  From:   ${ip}\n  Device: ${ua || 'unknown'}\n\nIf this was you, nothing to do. If not: open ${PUBLIC_URL}/billing, change your password and use "Sign out everywhere else".\n` })
      .catch(e => console.error('[accounts] new-login email failed:', e.message));
  }
  return !seen;
}
const PRICE_LABEL = '$49 / year';

// ── Store ──────────────────────────────────────────────────────────────
function load() {
  let store;
  try { store = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch { store = { accounts: {}, usernames: {}, workspaces: {} }; }   // accounts: email -> record; usernames: lowercase name -> email
  store.workspaces ||= {};
  // Migration: accounts from before workspaces each get their own.
  let changed = false;
  for (const a of Object.values(store.accounts)) {
    if (!a.workspace || !store.workspaces[a.workspace]) { createWorkspace(store, a); changed = true; }
  }
  if (changed) save(store);
  return store;
}
function save(store) {                                           // atomic write, same pattern as chamber.json
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = FILE + '.tmp.' + process.pid;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, JSON.stringify(store, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, FILE);
}
function hash(pw, salt) { return crypto.scryptSync(pw, salt, 32).toString('hex'); }
// 2026-11-13: the password that is asked AGAIN inside a signed-in session (change email or password, turn off two-factor, delete
// the account, hand over the workspace, buy storage) had no limit on wrong tries, so a stolen session could guess it at full
// speed. Now 10 wrong tries per account per 15 minutes (kept in memory; a restart clears it).
const pwFails = new Map();
function reauth(acct, pw) {                                         // 'ok' | 'wrong' | 'locked'
  const f = pwFails.get(acct.email), live = f && Date.now() - f.at < MFA_WINDOW_MS ? f : null;
  if (live && live.n >= MFA_MAX_FAILS) return 'locked';
  if (checkPw(acct, pw)) { pwFails.delete(acct.email); return 'ok'; }
  pwFails.set(acct.email, { n: (live ? live.n : 0) + 1, at: live ? live.at : Date.now() });
  return 'wrong';
}
const reauthFail = (ctx, res, g, msg = 'Password is wrong.') => ctx.json(res, g === 'locked' ? 429 : 403, { error: g === 'locked' ? 'Too many wrong passwords. Wait 15 minutes, then try again.' : msg });
function checkPw(acct, pw) {
  if (typeof pw !== 'string' || !pw || !acct.salt || !acct.hash) return false;
  const got = Buffer.from(hash(pw, acct.salt)), want = Buffer.from(acct.hash);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function same(a, b) {                                            // constant-time string compare
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function newInvite() { return crypto.randomBytes(12).toString('base64url'); }
function createWorkspace(store, owner, name) {
  const id = crypto.randomBytes(8).toString('hex');
  store.workspaces[id] = { id, name: name || `${owner.username}'s workspace`, owner: owner.email, createdAt: Date.now(), invite: newInvite() };
  owner.workspace = id; owner.wsRole = 'owner';
  return store.workspaces[id];
}
function members(store, wsId) { return Object.values(store.accounts).filter(a => a.workspace === wsId); }
// T-0199: one place that says what role someone has in their workspace. owner | admin | member (full seats) | viewer | requester (guests).
function wsRoleOf(a, ws) { if (!a || !ws) return null; if (ws.owner === a.email) return 'owner'; return ['admin', 'viewer', 'requester'].includes(a.wsRole) ? a.wsRole : 'member'; }
function fullMembers(store, wsId) { const ws = store.workspaces[wsId]; return members(store, wsId).filter(a => !GUEST_ROLES.includes(wsRoleOf(a, ws))); }
function guestMembers(store, wsId) { const ws = store.workspaces[wsId]; return members(store, wsId).filter(a => GUEST_ROLES.includes(wsRoleOf(a, ws))); }
function inviteRole(ws, code) {                                    // which role an invite code gives in this workspace, or null
  if (ws.invite && same(ws.invite, code)) return 'member';
  for (const r of GUEST_ROLES) if (ws.invites && ws.invites[r] && same(ws.invites[r], code)) return r;
  return null;
}
function findInvite(store, code) { for (const ws of Object.values(store.workspaces)) { const role = inviteRole(ws, code); if (role) return { ws, role }; } return null; }
// T-0190: approval rules, set by the owner. With none set nothing changes: any person in a full seat may approve and one approval
// is enough. noSelf: the proposer may not approve their own ticket. two: 'high' (high and critical priority) or 'all' tickets need two
// different people. approvers: only these people may approve or reject (the owner always may); a viewer named here may approve.
function approvalRules(ws) {
  const r = (ws && ws.approval) || {};
  return { noSelf: !!r.noSelf, two: ['high', 'all'].includes(r.two) ? r.two : 'none', approvers: Array.isArray(r.approvers) ? r.approvers.filter(x => typeof x === 'string').slice(0, 50) : [],
           remindMin: Number.isInteger(r.remindMin) ? r.remindMin : 0, escalateMin: Number.isInteger(r.escalateMin) ? r.escalateMin : 0, backup: typeof r.backup === 'string' ? r.backup : '' };   // T-0201
}
function approverNames(store, ws) {                                // usernames that may approve or reject in this workspace right now
  const rules = approvalRules(ws), named = new Set(rules.approvers.map(s => s.toLowerCase()));
  return members(store, ws.id).filter(a => (a.chatRole || 'human') === 'human').filter(a => {
    const role = wsRoleOf(a, ws);
    if (role === 'requester') return false;
    if (role === 'owner') return true;
    return named.size ? named.has(a.username.toLowerCase()) : role !== 'viewer';
  }).map(a => a.username);
}
function approvalCheck(wsId, ticket, actor, action) {              // server.js asks before every approve / reject. -> { ok, code, error, needs, note }
  if (!ENABLED || !wsId) return { ok: true, needs: 1 };
  const store = load(), ws = store.workspaces[wsId];
  if (!ws) return { ok: true, needs: 1 };
  const lc = s => String(s || '').toLowerCase(), rules = approvalRules(ws), eligible = approverNames(store, ws);
  if (!eligible.some(u => lc(u) === lc(actor))) return { ok: false, code: 403, error: rules.approvers.length
    ? `In this workspace only ${eligible.join(', ')} may approve or reject tickets (the owner's approval rules).`
    : 'Only people in a full seat may approve or reject tickets here. A viewer can approve when the owner names them in the approval rules.' };
  if (action !== 'approve') return { ok: true };
  const notes = [], others = eligible.filter(u => lc(u) !== lc(ticket.proposed_by));
  if (rules.noSelf && lc(ticket.proposed_by) === lc(actor)) {
    if (others.length) return { ok: false, code: 403, error: `You proposed ${ticket.id}, and in this workspace nobody approves their own ticket. ${others.slice(0, 3).join(', ')} can approve it.` };
    notes.push('the rule that nobody approves their own ticket could not be met: nobody else here may approve');
  }
  let needs = (rules.two === 'all' || (rules.two === 'high' && ['high', 'critical'].includes(lc(ticket.priority)))) ? 2 : 1;
  if (needs === 2 && (rules.noSelf ? others : eligible).length < 2) { needs = 1; notes.push('the rule for two approvers could not be met: fewer than two people here may approve it'); }
  return { ok: true, needs, note: notes.join('; ') };
}
// T-0201: approval reminders. Which workspaces have them switched on, and who a waiting ticket should remind: its named reviewer
// if it has one who may approve, else everyone who may approve, never the person who proposed it or who already approved it.
function reminderWorkspaces() {
  if (!ENABLED) return [];
  const store = load();
  return Object.values(store.workspaces).map(ws => ({ ws: ws.id, cfg: approvalRules(ws) })).filter(x => x.cfg.remindMin > 0 || (x.cfg.escalateMin > 0 && x.cfg.backup));
}
function remindTargets(wsId, ticket) {
  const store = load(), ws = store.workspaces[wsId]; if (!ws) return [];
  const lc = s => String(s || '').toLowerCase(), may = approverNames(store, ws), done = new Set((ticket.approvals || []).map(a => lc(a.by)));
  if (ticket.reviewer && may.some(u => lc(u) === lc(ticket.reviewer))) return [may.find(u => lc(u) === lc(ticket.reviewer))];
  return may.filter(u => lc(u) !== lc(ticket.proposed_by) && !done.has(lc(u)));
}
// T-0202: the weekly report. ws.report = { enabled, recipients: [emails], token }. The token makes a private link (no login).
function reportView(ws) { const r = (ws && ws.report) || {}; return { enabled: !!r.enabled, recipients: Array.isArray(r.recipients) ? r.recipients : [], linkUrl: r.token ? `${PUBLIC_URL}/report/${r.token}` : null }; }
function reportByToken(token) {
  if (!ENABLED || !token) return null;
  for (const ws of Object.values(load().workspaces)) if (ws.report && ws.report.token && same(ws.report.token, token)) return { ws: ws.id, name: ws.name, token: ws.report.token };
  return null;
}
function reportWorkspaces() {
  if (!ENABLED) return [];
  return Object.values(load().workspaces).filter(ws => ws.report && ws.report.enabled && Array.isArray(ws.report.recipients) && ws.report.recipients.length)
    .map(ws => ({ ws: ws.id, name: ws.name, recipients: ws.report.recipients.slice(0, 10), linkUrl: ws.report.token ? `${PUBLIC_URL}/report/${ws.report.token}` : null }));
}
// T-0203: the monthly AI budget, set by the owner. ws.budget = { monthlyCents, perAgent: { agentName: cents } }. server.js adds up
// the spend; these only store and hand out the settings.
function budgetOf(wsId) { const ws = ENABLED && wsId ? load().workspaces[wsId] : null; const b = (ws && ws.budget) || {}; return { monthlyCents: Number.isInteger(b.monthlyCents) ? b.monthlyCents : 0, perAgent: b.perAgent && typeof b.perAgent === 'object' ? b.perAgent : {} }; }
function budgetWorkspaces() {
  if (!ENABLED) return [];
  const store = load();
  return Object.values(store.workspaces).filter(ws => ws.budget && (ws.budget.monthlyCents > 0 || Object.keys(ws.budget.perAgent || {}).length))
    .map(ws => ({ ws: ws.id, admins: members(store, ws.id).filter(a => ['owner', 'admin'].includes(wsRoleOf(a, ws)) && (a.chatRole || 'human') === 'human').map(a => a.username) }));
}
// T-0205: who gets the email when a request moves. { email, username, wanted, confirmed } for a person of this workspace, else null.
function draftsOn(wsId) { const ws = ENABLED && wsId ? load().workspaces[wsId] : null; return !!ws && !ws.requestDraftsOff; }   // T-0207: on unless the owner switched it off
function requestMailFor(wsId, username) {
  if (!ENABLED || !wsId || !username) return null;
  const store = load(), a = store.accounts[store.usernames[String(username).toLowerCase()]];
  if (!a || a.workspace !== wsId) return null;
  return { email: a.email, username: a.username, wanted: a.requestMailOff !== true, confirmed: verified(a) };
}
function setRequestMail(sess, on) {                                // the person's own switch, on the Your requests page
  if (!ENABLED || !sess || sess.agent || !sess.email) return false;
  const store = load(), a = store.accounts[sess.email]; if (!a) return false;
  if (on) delete a.requestMailOff; else a.requestMailOff = true;
  save(store); return true;
}
function workspaceName(wsId) { const ws = ENABLED && wsId ? load().workspaces[wsId] : null; return ws ? ws.name : null; }   // T-0204
function canApprove(sess) {                                        // for /api/me: should the app offer Approve to this person?
  if (!ENABLED) return true;
  if (!sess || sess.agent || !sess.email) return false;
  const store = load(), a = store.accounts[sess.email], ws = a && store.workspaces[a.workspace];
  return !!ws && approverNames(store, ws).some(u => u.toLowerCase() === a.username.toLowerCase());
}
function standingRules(wsId) {                                    // T-0200: what a standing approval must respect: who may approve right now, and the two rules
  const none = { approvers: null, two: 'none', noSelf: false };
  if (!ENABLED || !wsId) return none;
  const store = load(), ws = store.workspaces[wsId]; if (!ws) return none;
  const r = approvalRules(ws); return { approvers: approverNames(store, ws), two: r.two, noSelf: r.noSelf };
}
function commandersFor(wsId) {                                   // T-0015: usernames whose instructions agents in this workspace obey
  const store = load(); const ws = store.workspaces[wsId]; if (!ws) return [];
  const owner = store.accounts[ws.owner];
  if ((ws.agentPolicy || 'owner') === 'owner') return owner ? [owner.username] : [];
  return members(store, wsId).filter(a => (a.chatRole || 'human') === 'human' && !GUEST_ROLES.includes(wsRoleOf(a, ws))).map(a => a.username);   // T-0199: viewers and requesters never instruct agents
}

// ── Agent API tokens (T-0007) ─────────────────────────────────────────────
// A workspace owner creates a token per AI agent. The agent authenticates with `Authorization: Bearer chk_<id>_<secret>`
// and acts in the workspace as a chat user with role "ai". Only a sha256 of the secret is stored; the token is shown once.
// Token sessions carry no account (no email), so agents can never reach /account/* or /billing/*.
const TOKEN_RE = /^chk_([a-f0-9]{8})_([A-Za-z0-9_-]{32,})$/;
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
function tokenSession(token) {
  const m = TOKEN_RE.exec(token || '');
  if (!m) return null;
  const store = load();
  for (const ws of Object.values(store.workspaces)) {
    const t = ws.tokens?.[m[1]];
    if (!t) continue;
    if (!same(t.hash, sha(m[2]))) return null;
    if (Date.now() - (t.lastUsed || 0) > 300000) { t.lastUsed = Date.now(); save(store); }   // at most one write per 5 min
    return { token, username: t.username, role: 'ai', agent: true, ws: ws.id, expires: Infinity, mayAsk: !!t.mayAsk };   // T-0188
  }
  return null;
}

// May this account use the app right now? Admins always; otherwise the WORKSPACE OWNER's subscription decides.
// T-0028: billing is a small state machine instead of a boolean.
//   ok        active / trialing, or cancelled but still inside the paid period
//   grace     Stripe could not charge the card (past_due / unpaid); full access for GRACE_MS from the first failure
//   readonly  grace is over: members can read and export, every write answers 402 until billing is fixed
//   none      no subscription, paused, or expired
const GRACE_MS = 7 * 86400e3;
function billingState(acct) {
  if (!acct) return 'none';
  if (SELF_HOSTED || acct.role === 'admin') return 'ok';          // T-0061
  const s = acct.subStatus;
  if (s === 'active' || s === 'trialing') return 'ok';
  if (s === 'past_due' || s === 'unpaid') {
    const since = acct.paymentFailedAt || (acct.periodEnd ? acct.periodEnd * 1000 : Date.now());
    return Date.now() - since < GRACE_MS ? 'grace' : 'readonly';
  }
  if (s === 'paused' || s === 'incomplete' || s === 'incomplete_expired') return 'none';
  if (onTrialClock(acct)) return !verified(acct) ? 'none' : Date.now() < acct.trialEndsAt ? 'trial' : 'readonly';   // T-0159: trial needs a confirmed email; afterwards read-only, nothing deleted
  return acct.periodEnd && acct.periodEnd * 1000 > Date.now() ? 'ok' : 'none';   // cancelled: good until the paid period ends
}
function graceEndsAt(acct) { const since = acct?.paymentFailedAt || (acct?.periodEnd ? acct.periodEnd * 1000 : null); return since ? since + GRACE_MS : null; }
function subscribed(acct) { return billingState(acct) !== 'none'; }
function payerOf(acct, store) {                                   // whose card this account rides on
  const ws = store.workspaces[acct.workspace];
  return ws && ws.owner !== acct.email ? store.accounts[ws.owner] : acct;
}
function accessOf(acct, store) {                                   // 'full' | 'readonly' | 'none'
  if (!acct) return 'none';
  if (acct.role === 'admin') return 'full';
  const st = billingState(payerOf(acct, store));
  return st === 'none' ? 'none' : st === 'readonly' ? 'readonly' : 'full';
}
function entitled(acct, store) { return accessOf(acct, store) !== 'none'; }
function billingView(acct, store) {                                // what /api/me and the account page show (T-0028)
  if (!acct) return null;
  const payer = payerOf(acct, store);
  return { state: acct.role === 'admin' ? 'ok' : billingState(payer), access: accessOf(acct, store), graceEndsAt: billingState(payer) === 'grace' ? graceEndsAt(payer) : null,
           payer: payer ? payer.username : null, isPayer: !!payer && payer.email === acct.email,
           trial: billingState(payer) === 'trial', trialEndsAt: onTrialClock(payer) ? payer.trialEndsAt : null, trialOver: onTrialClock(payer) && billingState(payer) === 'readonly',   // T-0159
           trialPending: onTrialClock(payer) && !verified(payer) && Date.now() < payer.trialEndsAt };
}
// Storage add-on: packs count only while the payer's subscription is good (ok or grace). Nothing is deleted when they stop
// counting; the workspace just cannot take new files while it is over its limit.
function storagePacksOf(payer) { return STORAGE_ON() && payer && payer.subscription && ['ok', 'grace'].includes(billingState(payer)) ? (payer.storagePacks || 0) : 0; }
function storageView(acct, store) {                                // what the account page shows; null = not offered here
  if (!STORAGE_ON() || !acct) return null;
  const payer = payerOf(acct, store), isPayer = !!payer && payer.email === acct.email;
  return { packGb: STORAGE_PACK_GB, label: STORAGE_LABEL, maxPacks: STORAGE_MAX_PACKS, baseMb: STORAGE_BASE_MB, packs: storagePacksOf(payer), isPayer,
           canChange: isPayer && payer.subStatus === 'active' && !!payer.subscription && !payer.cancelAtPeriodEnd };
}
function storageExtraMbFor(sess) {                                 // for server.js: extra MB this session's workspace has bought
  if (!STORAGE_ON()) return 0;
  const store = load();
  const payer = sess?.agent ? store.accounts[store.workspaces[sess.ws]?.owner] : sess?.email && store.accounts[sess.email] ? payerOf(store.accounts[sess.email], store) : null;
  return storagePacksOf(payer) * STORAGE_PACK_GB * 1024;
}
function publicView(acct, store) {
  const ws = store.workspaces[acct.workspace] || {};
  const owner = store.accounts[ws.owner];
  return { email: acct.email, username: acct.username, role: acct.role, entitled: entitled(acct, store),
           subStatus: acct.subStatus || null, periodEnd: acct.periodEnd || null, cancelAtPeriodEnd: !!acct.cancelAtPeriodEnd,
           hasCustomer: !!acct.stripeCustomer, price: SELF_HOSTED ? 'self-hosted (no subscription)' : PRICE_LABEL, selfHosted: SELF_HOSTED, billing: billingView(acct, store), storage: storageView(acct, store),   // T-0028/T-0061
           emailVerified: verified(acct), verifyRequired: VERIFY_REQUIRED(), logins: (acct.logins || []).slice(-5).map(l => ({ ip: l.ip, at: l.at, device: l.ua })),   // T-0032
           totp: !!acct.totp, needsTotp: !acct.totp && ws.owner === acct.email && Object.keys(ws.tokens || {}).length > 0,   // T-0040: owners who hold agent tokens should have 2FA
           workspace: { id: ws.id, name: ws.name, role: wsRoleOf(acct, ws) || 'member', owner: owner ? owner.username : null,
                        ownerSubscribed: !!owner && (owner.role === 'admin' || subscribed(owner)) } };
}

// ── Stripe (plain HTTPS, form-encoded) ──────────────────────────────────
function encode(params, prefix = '') {
  return Object.entries(params).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) return [];
    if (typeof v === 'object') return [encode(v, key)];
    return [`${encodeURIComponent(key)}=${encodeURIComponent(v)}`];
  }).join('&');
}
function stripe(method, endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    const inUrl = method === 'GET' || method === 'DELETE';                     // Stripe takes the parameters of GET and DELETE from the address (its own libraries send them that way)
    const body = inUrl ? '' : encode(params);
    const query = inUrl && Object.keys(params).length ? '?' + encode(params) : '';
    const req = (STRIPE_TEST_PORT ? http : https).request({
      hostname: STRIPE_TEST_PORT ? '127.0.0.1' : 'api.stripe.com', ...(STRIPE_TEST_PORT ? { port: STRIPE_TEST_PORT } : {}), path: `/v1/${endpoint}${query}`, method,
      auth: `${STRIPE_KEY}:`, timeout: 15000,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let obj; try { obj = JSON.parse(data); } catch { return reject(new Error('Stripe: bad response')); }
        if (res.statusCode >= 400) return reject(new Error(obj.error?.message || `Stripe HTTP ${res.statusCode}`));
        resolve(obj);
      });
    });
    req.on('timeout', () => req.destroy(new Error('Stripe: timeout')));
    req.on('error', reject);
    req.end(body);
  });
}
function verifyStripeSignature(raw, header) {                    // Stripe-Signature: t=...,v1=...
  const parts = Object.fromEntries((header || '').split(',').map(p => p.split('=')));
  const t = parts.t, sig = parts.v1;
  if (!t || !sig || Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const want = crypto.createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${raw}`).digest('hex');
  return same(want, sig);
}
function applySubscription(acct, sub) {                          // copy what matters from a Stripe subscription object
  acct.subscription = sub.id;
  acct.subStatus = sub.status;
  acct.periodEnd = sub.current_period_end || sub.items?.data?.[0]?.current_period_end || acct.periodEnd || null;
  acct.cancelAtPeriodEnd = !!sub.cancel_at_period_end;
  if (STORAGE_PRICE && Array.isArray(sub.items?.data)) {            // storage add-on: the quantity on its subscription line is the number of packs
    const si = sub.items.data.find(i => i.price?.id === STORAGE_PRICE);
    acct.storagePacks = si ? Math.max(0, Math.min(STORAGE_MAX_PACKS, parseInt(si.quantity, 10) || 0)) : 0;
  }
  if (sub.customer) acct.stripeCustomer = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
}
async function bestSubscription(customer) {                       // fallback when a webhook was missed or is late: ask Stripe (no store is touched here)
  if (!customer) return null;
  const subs = await stripe('GET', 'subscriptions', { customer, status: 'all', limit: 5 });
  return subs.data.sort((a, b) => (b.created || 0) - (a.created || 0))
    .find(s => ['active', 'trialing', 'past_due'].includes(s.status)) || subs.data[0] || null;
}
function findByCustomer(store, customerId) {
  return Object.values(store.accounts).find(a => a.stripeCustomer === customerId);
}

// ── HTTP helpers ──────────────────────────────────────────────────────
function rawBody(req, limit = 1e6) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > limit) req.destroy(); });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}
function redirect(res, to) { res.writeHead(302, { Location: to }); res.end(); }
function setSessionCookie(res, ctx, token) {
  res.setHeader('Set-Cookie', `chamber_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${ctx.sessionTtl / 1000}` + (ctx.cookieSecure ? '; Secure' : ''));
}
function clientIp(req) {                                          // behind nginx the real address is the LAST X-Forwarded-For hop (nginx appends it; the first hop is whatever the client sent) — T-0030
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : (req.socket.remoteAddress || '?');
}
function signIn(res, ctx, acct) {                                 // create the Chamber session + make sure the app knows the user (in ITS workspace)
  const chatRole = acct.chatRole || 'human';
  ctx.withWorkspace(acct.workspace, () => {
    const data = ctx.loadData();
    const existing = data.users[acct.username];
    data.users[acct.username] = { username: acct.username, role: chatRole, lastSeen: Date.now(), joinedAt: existing?.joinedAt || Date.now() };
    ctx.saveData(data);
  });
  const token = ctx.createSession(acct.username, chatRole, { email: acct.email });
  setSessionCookie(res, ctx, token);
  return token;
}
function endSessions(ctx, email) {                                // log an account out everywhere (removal, etc.)
  for (const [t, s] of ctx.sessions) if (s.email === email) ctx.sessions.delete(t);
}

// Used by server.js on every request: which workspace does this session act in, and may it use the app?
function workspaceOf(sess) {
  if (sess?.agent) return WS_RE.test(sess.ws) ? sess.ws : null;        // agent token: workspace is on the session
  if (!sess || !sess.email) return null;
  const ws = load().accounts[sess.email]?.workspace;
  return ws && WS_RE.test(ws) ? ws : null;
}
function sessionAccess(sess) {                                    // T-0028: 'full' | 'readonly' | 'none' for the current session
  const store = load();
  if (sess?.agent) { const ws = store.workspaces[sess.ws]; return ws ? accessOf(store.accounts[ws.owner], store) : 'none'; }   // agents ride on the owner
  if (!sess || !sess.email) return 'none';
  return accessOf(store.accounts[sess.email], store);
}
function sessionReadOnly(sess) { return sessionAccess(sess) === 'readonly'; }
function billingFor(sess) {                                       // T-0028: for /api/me
  const store = load();
  if (sess?.agent) { const ws = store.workspaces[sess.ws]; const owner = ws && store.accounts[ws.owner]; return owner ? billingView(owner, store) : null; }
  return sess?.email ? billingView(store.accounts[sess.email], store) : null;
}
function sessionEntitled(sess) {
  const store = load();
  if (sess?.agent) { const ws = store.workspaces[sess.ws]; return !!ws && entitled(store.accounts[ws.owner], store); }  // agents ride on the owner
  if (!sess || !sess.email) return false;
  return entitled(store.accounts[sess.email], store);
}

// 2026-11-13: an import keeps the ids, names and room keys of the file it is given, and the app writes those into the page.
// A file made by Export only ever holds plain ones; a hand-made file could carry text that the page would run. Refuse those.
const SAFE_REF = /^[^\u0000-\u001f'"<>&\\`]{1,200}$/;
function importUnsafe(exp) {
  const ok = v => v === undefined || v === null || ((typeof v === 'string' || typeof v === 'number') && SAFE_REF.test(String(v)));
  const c = exp.chat || {};
  for (const [k, u] of Object.entries(c.users || {})) if (!ok(k) || !u || !ok(u.username)) return 'a user name holds characters a name cannot have';
  for (const [k, r] of Object.entries(c.rooms || {})) if (!ok(k) || (r && Array.isArray(r.dm) && !r.dm.every(ok))) return 'a room holds characters a room cannot have';
  for (const m of Array.isArray(c.messages) ? c.messages : []) {
    if (!m || m.id == null || !ok(m.id) || !ok(m.room) || !ok(m.username) || !ok(m.reply_to)) return 'a message id, room or author holds characters it cannot have';
    if (m.reactions && typeof m.reactions === 'object' && !Object.keys(m.reactions).every(ok)) return 'a reaction is not a plain emoji';
    for (const a of Array.isArray(m.attachments) ? m.attachments : []) if (!a || !ok(a.id)) return 'an attachment id holds characters it cannot have';
  }
  for (const f of Array.isArray(exp.files) ? exp.files : []) if (!f || f.id == null || !ok(f.id) || !ok(f.msg_id) || !ok(f.room) || !ok(f.by)) return 'a file id holds characters it cannot have';
  for (const t of (exp.tickets && Array.isArray(exp.tickets.tickets)) ? exp.tickets.tickets : []) if (!t || !ok(t.id) || !ok(t.reverts) || !ok(t.reverted_by)) return 'a ticket id holds characters it cannot have';
  const revs = exp.reviews ? (Array.isArray(exp.reviews.reviews) ? exp.reviews.reviews : Array.isArray(exp.reviews) ? exp.reviews : []) : [];
  for (const r of revs) if (!r || !ok(r.id) || !ok(r.ticket_id)) return 'a review id holds characters it cannot have';
  for (const [k, notes] of Object.entries(exp.agent_memory || {})) { if (!ok(k)) return 'an agent name holds characters a name cannot have'; for (const n of Array.isArray(notes) ? notes : []) if (!n || !ok(n.id) || !ok(n.scope)) return 'a memory note id holds characters it cannot have'; }
  return null;
}

// ── Request handler. Returns true when it handled the request. ───────
async function handle(req, res, url, ctx0) {
  const p = url.pathname, m = req.method;
  // 2026-11-13: accounts.json is read, changed and written back whole. A handler that read it, then WAITED (for the request
  // body, or for Stripe), then wrote it back would silently undo whatever another request saved meanwhile (a sign-up, a
  // payment). So the body is read BEFORE the file is, and the Stripe routes below re-read the file after their wait.
  let ctx = ctx0;
  if (m === 'POST' && (p.startsWith('/account/') || p.startsWith('/billing/'))) {
    const pre = await ctx0.parseBody(req).then(v => ({ v }), e => ({ e }));
    ctx = Object.create(ctx0); ctx.parseBody = () => pre.e ? Promise.reject(pre.e) : Promise.resolve(pre.v);
  }
  const sess = ctx.getSession(req);
  let store = load();
  const me = sess?.email ? store.accounts[sess.email] : null;
  const myWs = me ? store.workspaces[me.workspace] : null;
  const amOwner = !!(me && myWs && myWs.owner === me.email);
  const amAdmin = amOwner || !!(me && myWs && me.wsRole === 'admin');   // T-0034: admins manage members, invites and agent tokens; billing, roles and transfer stay with the owner

  // Pages
  if (m === 'GET' && (p === '/' || p === '/index.html')) {
    if (me && entitled(me, store)) return redirect(res, '/app'), true;
    return ctx.serveStatic(res, LANDING, req), true;
  }
  if (m === 'GET' && (['/signup', '/login', '/billing', '/account', '/forgot'].includes(p) || /^\/(join|reset)\/[A-Za-z0-9_-]{8,}$/.test(p))) {
    return ctx.serveStatic(res, LANDING, req), true;
  }
  if (m === 'GET' && (p === '/source' || p === '/source/')) {               // T-0010: AGPL §13, the exact source we run, as a tarball
    execFile('git', ['-C', __dirname, 'archive', '--format=tar.gz', '--prefix=chamber/', 'HEAD'], { maxBuffer: 50 * 1024 * 1024, encoding: 'buffer' }, (err, out) => {
      if (err) { ctx.json(res, 500, { error: 'source archive unavailable right now; email support@ghostporttechnologies.com' }); return; }
      execFile('git', ['-C', __dirname, 'rev-parse', '--short', 'HEAD'], (e2, rev) => {
        res.writeHead(200, { 'Content-Type': 'application/gzip', 'Content-Length': out.length,
                             'Content-Disposition': `attachment; filename="chamber-source-${(rev || 'HEAD').toString().trim()}.tar.gz"`, 'Cache-Control': 'no-cache' });
        res.end(out);
      });
    });
    return true;
  }
  if (m === 'GET' && ['/terms', '/privacy', '/refunds'].includes(p)) {       // T-0018: legal pages
    return ctx.serveStatic(res, path.join(__dirname, 'public', 'legal', p.slice(1) + '.html'), req), true;
  }
  if (m === 'GET' && p === '/demo') return ctx.serveStatic(res, path.join(__dirname, 'public', 'demo.html'), req), true;
  if (m === 'GET' && p === '/requests') {                                   // T-0199: send requests and follow your own (requesters; anyone signed in may use it)
    if (!me) return redirect(res, '/login'), true;
    return ctx.serveStatic(res, path.join(__dirname, 'public', 'requests.html'), req), true;
  }
  if (m === 'GET' && p === '/compare') return ctx.serveStatic(res, path.join(__dirname, 'public', 'compare.html'), req), true;   // T-0195: public, honest comparison with other tools   // T-0161: public demo, sample data only, no API behind it
  if (m === 'GET' && p === '/help') return ctx.serveStatic(res, path.join(__dirname, 'public', 'help.html'), req), true;   // T-0036
  if (m === 'GET' && (p === '/help/api' || p === '/api/docs')) return ctx.serveStatic(res, path.join(__dirname, 'public', 'api.html'), req), true;   // T-0051
  if (m === 'GET' && p === '/changelog') {                                   // T-0036: from git, cached 5 minutes, no secrets (commit subjects only)
    if (!changelogCache.html || Date.now() - changelogCache.at > 300e3) {
      let out = ''; try { out = execFileSync('git', ['-C', __dirname, 'log', '-n', '80', '--date=short', '--pretty=format:%ad%x09%h%x09%s'], { encoding: 'utf8', timeout: 5000 }); } catch { out = ''; }
      const esc = (t) => String(t).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const rows = out.split('\n').filter(Boolean).map(l => l.split('\t')).filter(r => r.length === 3 && !/^(Deploy staged tree|Merge )/.test(r[2]))
        .map(([d, h, s]) => `<tr><td class="dim">${esc(d)}</td><td><code>${esc(h)}</code></td><td>${esc(s)}</td></tr>`).join('');
      changelogCache = { at: Date.now(), html: `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Changelog · Chamber</title><link rel="icon" href="/favicon.ico" sizes="any"><link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>body{margin:0;background:#0b0f0c;color:#d8e0da;font:14px/1.6 ui-monospace,Menlo,Consolas,monospace;padding:0 16px}main{max-width:900px;margin:0 auto;padding:28px 0 60px}h1{color:#00ff88;letter-spacing:.1em;font-size:22px}table{border-collapse:collapse;width:100%}td{border-bottom:1px solid #1f2a23;padding:6px 8px;vertical-align:top}.dim{color:#7f8c84;white-space:nowrap}code{color:#7f8c84}a{color:#00ff88}footer{color:#7f8c84;font-size:12px;margin-top:30px}</style></head>
<body><main><h1>CHANGELOG</h1><p class="dim">What changed in the hosted Chamber, newest first. The running version is <code>${esc(ctx.version || 'unknown')}</code>; its full source is at <a href="/source">/source</a>.</p><table>${rows || '<tr><td>No history available.</td></tr>'}</table><footer><a href="/help">Help</a> · <a href="/">Home</a></footer></main></body></html>` };
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' }); res.end(changelogCache.html); return true;
  }
  if (m === 'GET' && (p === '/app' || p === '/app/')) {
    if (!me) return redirect(res, '/login'), true;
    if (!entitled(me, store)) return redirect(res, '/billing'), true;
    if (wsRoleOf(me, myWs) === 'requester') return redirect(res, '/requests'), true;   // T-0199: a requester's place is their requests page
    return ctx.serveStatic(res, ctx.appHtml, req), true;
  }

  // Stripe webhook (signature-verified, no session)
  if (p === '/webhooks/stripe' && m === 'POST') {
    if (SELF_HOSTED) return ctx.json(res, 404, { error: 'no billing on this instance' }), true;   // T-0061
    const raw = await rawBody(req).catch(() => '');
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'])) return ctx.json(res, 400, { error: 'bad signature' }), true;
    let ev; try { ev = JSON.parse(raw); } catch { return ctx.json(res, 400, { error: 'bad json' }), true; }
    const obj = ev.data?.object || {};
    let paidSub = null;                                                          // ask Stripe first, read our file after (see the note at the top of handle)
    if (ev.type === 'checkout.session.completed' && obj.mode === 'subscription' && obj.subscription) {
      try { paidSub = await stripe('GET', `subscriptions/${obj.subscription}`); } catch (e) { console.error('[accounts] webhook:', e.message); return ctx.json(res, 500, { error: 'internal' }), true; }
    }
    store = load();
    store.stripeEvents ||= [];                                                   // T-0028: Stripe retries; every event is applied once
    if (ev.id && store.stripeEvents.some(e => e.id === ev.id)) return ctx.json(res, 200, { received: true, duplicate: true }), true;
    const seen = () => { if (ev.id) { store.stripeEvents.push({ id: ev.id, type: ev.type, ts: Date.now() }); if (store.stripeEvents.length > 500) store.stripeEvents = store.stripeEvents.slice(-500); } };
    const clearFailure = (acct) => { delete acct.paymentFailedAt; delete acct.lastPaymentError; delete acct.paymentFailedMailAt; };
    try {
      if (ev.type === 'checkout.session.completed' && obj.mode === 'subscription') {
        const acct = store.accounts[(obj.client_reference_id || '').toLowerCase()] || findByCustomer(store, obj.customer);
        if (acct) {
          acct.stripeCustomer = obj.customer;
          const sub = paidSub; if (!sub) throw new Error('checkout completed without a subscription');
          applySubscription(acct, sub); clearFailure(acct);
          console.log(`[accounts] paid: ${acct.username} (${sub.status})`);
        }
      } else if (['customer.subscription.updated', 'customer.subscription.deleted', 'customer.subscription.paused', 'customer.subscription.resumed'].includes(ev.type)) {
        const acct = findByCustomer(store, obj.customer);
        if (acct) {
          applySubscription(acct, obj);
          if (obj.status === 'active' || obj.status === 'trialing') clearFailure(acct);
          else if ((obj.status === 'past_due' || obj.status === 'unpaid') && !acct.paymentFailedAt) acct.paymentFailedAt = Date.now();
          console.log(`[accounts] subscription ${obj.status}: ${acct.username} (billing ${billingState(acct)})`);
        }
      } else if (ev.type === 'invoice.payment_failed') {
        const acct = findByCustomer(store, obj.customer);
        if (acct) {
          acct.paymentFailedAt ||= Date.now();
          acct.lastPaymentError = String(obj.last_finalization_error?.message || obj.last_payment_error?.message || `attempt ${obj.attempt_count || '?'} failed`).slice(0, 200);
          console.log(`[accounts] payment failed: ${acct.username} (${acct.lastPaymentError}); grace until ${new Date(graceEndsAt(acct)).toISOString()}`);
          if (mail.enabled && Date.now() - (acct.paymentFailedMailAt || 0) > 86400e3) {   // at most one email a day
            acct.paymentFailedMailAt = Date.now();
            mail.send({ to: acct.email, subject: 'Chamber: your payment did not go through',
              text: `Hi ${acct.username},\n\nStripe could not charge your card for Chamber (${acct.lastPaymentError}).\nYour workspace keeps full access until ${new Date(graceEndsAt(acct)).toUTCString()}; after that it becomes read-only until the payment succeeds.\n\nUpdate your card here: ${PUBLIC_URL}/billing (Manage billing)\n\nQuestions: support@ghostporttechnologies.com\n` })
              .catch(e => console.error('[accounts] payment-failed mail:', e.message));
          }
        } else console.log(`[accounts] payment failed for unknown customer ${obj.customer}`);
      } else if (ev.type === 'invoice.payment_succeeded' || ev.type === 'invoice.paid') {
        const acct = findByCustomer(store, obj.customer);
        if (acct) { clearFailure(acct); console.log(`[accounts] payment ok: ${acct.username}`); }
      }
      seen(); save(store);
    } catch (e) { console.error('[accounts] webhook:', e.message); return ctx.json(res, 500, { error: 'internal' }), true; }
    return ctx.json(res, 200, { received: true }), true;
  }

  // Public bits the sign-up form needs
  if (p === '/account/config' && m === 'GET') {
    return ctx.json(res, 200, { inviteRequired: !!INVITE_CODE && !TRIAL_ON(), trialDays: TRIAL_ON() ? TRIAL_DAYS : 0, price: PRICE_LABEL, resetByEmail: mail.enabled, storage: STORAGE_ON() ? { packGb: STORAGE_PACK_GB, label: STORAGE_LABEL, baseMb: STORAGE_BASE_MB } : null }), true;
  }
  // T-0162: public contact form. Anyone may write; nothing here is trusted. Plain text only, strict sizes, 3 per address per
  // hour and 200 a day in total, a hidden field that only bots fill, stored in contact.jsonl beside accounts.json (owner-only
  // file) and mailed to the support address when mail is set up. Never posted into a room: agents read rooms, and a stranger's
  // text must not reach them as if it were an instruction.
  if (p === '/account/contact' && m === 'POST') {
    const ip = clientIp(req), now = Date.now();
    const b = await ctx.parseBody(req).catch(() => null);
    const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim().slice(0, n);
    const email = clean(b?.email, 200).toLowerCase(), name = clean(b?.name, 80).replace(/[\r\n]+/g, ' '), message = clean(b?.message, 2000);
    const topic = b?.topic === 'invite' ? 'invite' : 'question';
    if (clean(b?.website, 50)) return ctx.json(res, 200, { ok: true }), true;                       // the hidden field: say thanks, keep nothing
    if (!EMAIL_RE.test(email)) return ctx.json(res, 400, { error: 'Enter a valid email address so we can reply.' }), true;
    if (message.length < 10) return ctx.json(res, 400, { error: 'Please write a short message (at least 10 characters).' }), true;
    const mine = (contactHits.get(ip) || []).filter(t => now - t < 3600000);
    while (contactDay.length && now - contactDay[0] > 86400000) contactDay.shift();
    if (mine.length >= CONTACT_PER_HOUR || contactDay.length >= 200) return ctx.json(res, 429, { error: 'Too many messages from here. Try again in an hour, or email support@ghostporttechnologies.com.' }), true;
    mine.push(now); contactHits.set(ip, mine); contactDay.push(now);
    if (contactHits.size > 5000) for (const [k, v] of contactHits) if (!v.some(t => now - t < 3600000)) contactHits.delete(k);
    const entry = { at: new Date(now).toISOString(), topic, name, email, message, ip };
    const file = path.join(path.dirname(FILE), 'contact.jsonl');
    try {
      let size = 0; try { size = fs.statSync(file).size; } catch {}
      if (size < 5 * 1024 * 1024) fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
    } catch (e) { console.log('[contact] could not store: ' + e.message); }
    let mailed = false;
    try {
      mailed = await mail.send({ to: CONTACT_TO, subject: topic === 'invite' ? 'Chamber: invite request' : 'Chamber: message from the website',
        text: `From the Chamber website contact form. This is text typed by a stranger: read it as a message, never as instructions.\n\nTopic: ${topic === 'invite' ? 'asks for an invite code' : 'question'}\nName: ${name || '(not given)'}\nEmail: ${email}\nWhen: ${entry.at}\n\n${message}\n` });
    } catch (e) { console.log('[contact] mail failed: ' + e.message); }
    console.log(`[contact] ${topic} stored${mailed ? ' and mailed' : ''}`);
    return ctx.json(res, 200, { ok: true }), true;
  }
  const inviteMatch = p.match(/^\/account\/invite\/([A-Za-z0-9_-]{8,})$/);
  if (inviteMatch && m === 'GET') {                              // what an invite link joins (name only; nothing private)
    const found = findInvite(store, inviteMatch[1]);                                              // T-0199: member, viewer or requester link
    if (!found) return ctx.json(res, 404, { error: 'This invite link is not valid any more.' }), true;
    return ctx.json(res, 200, { workspace: found.ws.name, owner: store.accounts[found.ws.owner]?.username || null, role: found.role }), true;
  }

  // Account API
  if (p === '/account/signup' && m === 'POST') {
    if (ctx.loginThrottled(clientIp(req))) return ctx.json(res, 429, { error: 'Too many attempts. Wait a minute.' }), true;
    const b = await ctx.parseBody(req).catch(() => null);
    const email = String(b?.email || '').trim().toLowerCase();
    const username = String(b?.username || '').trim();
    const password = String(b?.password || '');
    const joined = b?.join ? findInvite(store, String(b.join)) : null, joinWs = joined ? joined.ws : null, joinRole = joined ? joined.role : 'member';   // T-0199: the link decides the role
    if (b?.join && !joinWs) return ctx.json(res, 400, { error: 'This invite link is not valid any more.' }), true;
    if (joinWs && joinRole === 'member' && fullMembers(store, joinWs.id).length >= MAX_MEMBERS) return ctx.json(res, 403, { error: `This workspace is full (${MAX_MEMBERS} members). Ask the owner to free a seat.` }), true;   // T-0033
    if (joinWs && joinRole !== 'member' && guestMembers(store, joinWs.id).length >= MAX_GUESTS) return ctx.json(res, 403, { error: `This workspace has no free places for viewers and requesters (${MAX_GUESTS}). Ask the owner.` }), true;   // T-0199
    const trialSignup = !joinWs && TRIAL_ON();                                             // T-0159: a new workspace on the free trial
    if (trialSignup) { const day = (trialSignups.get(clientIp(req)) || []).filter(t => Date.now() - t < 86400e3);
      if (day.length >= TRIAL_SIGNUPS_PER_IP_DAY) return ctx.json(res, 429, { error: 'Too many new accounts from this network today. Try again tomorrow, or write to us from the Contact form.' }), true; }
    if (!joinWs && !trialSignup && INVITE_CODE && !same(String(b?.invite || ''), INVITE_CODE)) {
      return ctx.json(res, 403, { error: 'Invite code required. Ask the person who invited you.' }), true;
    }
    if (!EMAIL_RE.test(email)) return ctx.json(res, 400, { error: 'Enter a valid email address.' }), true;
    if (!USER_RE.test(username)) return ctx.json(res, 400, { error: 'Username: 2 to 24 letters, numbers, - or _.' }), true;
    if (RESERVED_NAMES.has(username.toLowerCase())) return ctx.json(res, 409, { error: 'That username is taken.' }), true;
    if (password.length < MIN_PASSWORD) return ctx.json(res, 400, { error: `Password must be at least ${MIN_PASSWORD} characters.` }), true;
    if (store.accounts[email]) return ctx.json(res, 409, { error: 'An account with that email already exists. Log in instead.' }), true;
    if (store.usernames[username.toLowerCase()]) return ctx.json(res, 409, { error: 'That username is taken.' }), true;
    const salt = crypto.randomBytes(16).toString('hex');
    const acct = { email, username, salt, hash: hash(password, salt), role: 'member', chatRole: b?.role === 'ai' ? 'ai' : 'human',
                   createdAt: Date.now(), stripeCustomer: null, subscription: null, subStatus: null, periodEnd: null };
    if (joinWs) { acct.workspace = joinWs.id; acct.wsRole = joinRole; } else createWorkspace(store, acct);
    if (trialSignup) { const used = (store.trials ||= {}), h = sha('trial:' + email);       // T-0159 review: one trial per email address, also after deleting the account and signing up again
      acct.trialEndsAt = used[h] || Date.now() + TRIAL_MS; used[h] = acct.trialEndsAt; const ip = clientIp(req); trialSignups.set(ip, [...(trialSignups.get(ip) || []).filter(t => Date.now() - t < 86400e3), Date.now()]);
      if (trialSignups.size > 5000) for (const [k, v] of trialSignups) if (!v.some(t => Date.now() - t < 86400e3)) trialSignups.delete(k); }
    store.accounts[email] = acct; store.usernames[username.toLowerCase()] = email;
    if (VERIFY_REQUIRED()) startVerification(store, acct, 'Welcome to Chamber.'); else acct.emailVerified = true;   // T-0032
    if (trialSignup && acct.emailVerified === false) acct.unconfirmedSince = Date.now();   // T-0176: only sign-ups carrying this mark are ever cleaned up
    acct.logins = [{ ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 120), at: Date.now() }];
    save(store);
    const token = signIn(res, ctx, acct);
    console.log(`[accounts] signup: ${username}${joinWs ? ' (joined ' + joinWs.id + ')' : ''}`);
    ctx.withWorkspace(acct.workspace, () => ctx.audit({ username }, { action: joinWs ? 'member-join' : 'workspace-create' }, true));   // T-0057
    return ctx.json(res, 200, { ok: true, account: publicView(acct, store), token }), true;   // token: for API clients (Authorization: Bearer)
  }
  if (p === '/account/login' && m === 'POST') {
    if (ctx.loginThrottled(clientIp(req))) return ctx.json(res, 429, { error: 'Too many attempts. Wait a minute.' }), true;
    const b = await ctx.parseBody(req).catch(() => null);
    const id = String(b?.email || '').trim().toLowerCase();
    const acct = store.accounts[id] || store.accounts[store.usernames[id] || ''];     // email or username
    if (!acct || !checkPw(acct, b?.password)) return ctx.json(res, 401, { error: 'Wrong email/username or password.' }), true;
    if (acct.totp && !rememberedDevice(req, acct)) {                                               // T-0040: second step
      const mfaToken = crypto.randomBytes(24).toString('base64url');
      store.mfaPending ||= {};
      for (const [k, v] of Object.entries(store.mfaPending)) if (v.expires < Date.now()) delete store.mfaPending[k];
      store.mfaPending[sha(mfaToken)] = { email: acct.email, expires: Date.now() + 5 * 60e3 }; save(store);
      return ctx.json(res, 200, { ok: true, mfa: true, mfaToken, message: 'Enter the 6-digit code from your authenticator app, or a recovery code.' }), true;
    }
    acct.lastLogin = Date.now(); const fresh = noteLogin(req, acct); save(store);                 // T-0032
    if (acct.workspace) ctx.withWorkspace(acct.workspace, () => ctx.audit({ username: acct.username }, { action: 'login', newAddress: fresh && acct.logins.length > 1 ? true : undefined }, true));   // T-0057
    if (fresh && acct.logins.length > 1) console.log(`[accounts] login from a new address: ${acct.username} ${clientIp(req)}`);
    const token = signIn(res, ctx, acct);
    return ctx.json(res, 200, { ok: true, account: publicView(acct, store), token }), true;
  }
  if (p === '/account/reset-request' && m === 'POST') {           // T-0008: send a time-limited reset link (always answers OK)
    if (ctx.loginThrottled(clientIp(req))) return ctx.json(res, 429, { error: 'Too many attempts. Wait a minute.' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    if (!mail.enabled) return ctx.json(res, 503, { error: 'Email is not set up on this server. Ask the workspace owner or support@ghostporttechnologies.com to reset your password.' }), true;
    const id = String(b?.email || '').trim().toLowerCase();
    const acct = store.accounts[id] || store.accounts[store.usernames[id] || ''];
    if (acct) {
      const token = crypto.randomBytes(24).toString('base64url');
      store.resets ||= {};
      for (const [k, v] of Object.entries(store.resets)) if (v.expires < Date.now() || v.email === acct.email) delete store.resets[k];   // one live token per account
      store.resets[sha(token)] = { email: acct.email, expires: Date.now() + 30 * 60 * 1000 }; save(store);
      const link = `${PUBLIC_URL}/reset/${token}`;
      mail.send({ to: acct.email, subject: 'Chamber: reset your password',
                  text: `Hi ${acct.username},\n\nSomeone (hopefully you) asked to reset the password for your Chamber account.\nOpen this link within 30 minutes to choose a new password:\n\n${link}\n\nIf you did not ask for this, ignore this email; your password stays as it is.\n\nChamber by GhostPort Technologies` })
        .then(ok => console.log(`[accounts] reset email ${ok ? 'sent' : 'skipped'} for ${acct.username}`), e => console.error('[accounts] reset email failed:', e.message));
    }
    return ctx.json(res, 200, { ok: true, message: 'If that account exists, a reset link is on its way. Check your inbox (and spam) within a few minutes.' }), true;
  }
  if (p === '/account/reset' && m === 'POST') {                   // T-0008: use the link
    if (ctx.loginThrottled(clientIp(req))) return ctx.json(res, 429, { error: 'Too many attempts. Wait a minute.' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    const rec = store.resets?.[sha(String(b?.token || ''))];
    if (!rec || rec.expires < Date.now()) return ctx.json(res, 400, { error: 'This reset link is invalid or has expired. Request a new one.' }), true;
    const pw = String(b?.password || '');
    if (pw.length < MIN_PASSWORD) return ctx.json(res, 400, { error: `Password must be at least ${MIN_PASSWORD} characters.` }), true;
    const acct = store.accounts[rec.email];
    if (!acct) return ctx.json(res, 400, { error: 'That account no longer exists.' }), true;
    if (acct.totp && !secondFactorOk(acct, b?.code)) { save(store); return ctx.json(res, 403, { error: 'This account uses two-factor authentication. Enter the code from your authenticator app or a recovery code.', mfa: true }), true; }   // T-0040
    acct.salt = crypto.randomBytes(16).toString('hex'); acct.hash = hash(pw, acct.salt);
    if (acct.emailVerified === false) {                                // 2026-11-12: the reset link was mailed to this address and opened, which proves the address as well as
      acct.emailVerified = true; delete acct.unconfirmedSince;         // the confirm link would. Before this, someone who set a password by email was still told to confirm their email.
      for (const [k, v] of Object.entries(store.verifications || {})) if (v.email === acct.email) delete store.verifications[k];
      console.log(`[accounts] email confirmed by password reset: ${acct.username}`);
    }
    delete store.resets[sha(String(b.token))]; save(store);
    endSessions(ctx, acct.email);
    const token = signIn(res, ctx, acct);
    console.log(`[accounts] password reset via email: ${acct.username}`);
    return ctx.json(res, 200, { ok: true, account: publicView(acct, store), token }), true;
  }
  const verifyMatch = p.match(/^\/account\/verify\/([A-Za-z0-9_-]{16,})$/);   // T-0032: the link from the email
  if (verifyMatch && m === 'GET') {
    const rec = store.verifications?.[sha(verifyMatch[1])];
    const acct = rec && rec.expires > Date.now() ? store.accounts[rec.email] : null;
    if (acct) { acct.emailVerified = true; delete acct.verifySentAt; delete acct.unconfirmedSince; delete store.verifications[sha(verifyMatch[1])]; save(store); console.log(`[accounts] email verified: ${acct.username}`); }
    res.writeHead(302, { Location: acct ? '/billing?verified=1' : '/billing?verified=0', 'Cache-Control': 'no-store' }); res.end(); return true;
  }
  if (p === '/account/verify-resend' && m === 'POST') {           // T-0032: signed-in, unverified, at most once a minute
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    if (verified(me)) return ctx.json(res, 200, { ok: true, message: 'Your email is already confirmed.' }), true;
    if (!VERIFY_REQUIRED()) return ctx.json(res, 503, { error: 'Email is not set up on this server.' }), true;
    if (Date.now() - (me.verifySentAt || 0) < 60e3) return ctx.json(res, 429, { error: 'A link was sent less than a minute ago. Check your inbox and spam folder.' }), true;
    startVerification(store, me, 'You asked for a new confirmation link.'); save(store);
    return ctx.json(res, 200, { ok: true, message: `Sent. Check ${me.email} (and spam) within a few minutes.` }), true;
  }
  if (p === '/account/logout-all' && m === 'POST') {              // T-0032: every other device/session of this account
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    let n = 0; for (const [t, s] of ctx.sessions) if (s.email === me.email && t !== sess.token) { ctx.sessions.delete(t); n++; }
    console.log(`[accounts] ${me.username} signed out ${n} other session(s)`); ctx.audit(sess, { action: 'logout-all', sessions: n }, true);   // T-0057
    return ctx.json(res, 200, { ok: true, signedOut: n, message: n ? `Signed out ${n} other session${n === 1 ? '' : 's'}. This device stays signed in.` : 'No other sessions were open.' }), true;
  }
  if (p === '/account/pair/start' && m === 'POST') {              // T-0048: a device asks for a code (no auth)
    if (ctx.loginThrottled(clientIp(req))) return ctx.json(res, 429, { error: 'Too many attempts. Wait a minute.' }), true;
    store.pairing ||= {}; sweepPairing(store);
    if (Object.keys(store.pairing).length >= 100) return ctx.json(res, 429, { error: 'Too many devices waiting right now. Try again in a few minutes.' }), true;
    let code; do { code = String(crypto.randomInt(0, 1e6)).padStart(6, '0'); } while (store.pairing[code]);
    const pollToken = crypto.randomBytes(24).toString('base64url');
    store.pairing[code] = { pollHash: sha(pollToken), status: 'pending', created: Date.now(), expires: Date.now() + 10 * 60e3, ip: clientIp(req) }; save(store);
    return ctx.json(res, 200, { code, pollToken, expiresIn: 600, approveAt: `${PUBLIC_URL}/billing#agents` }), true;
  }
  if (p === '/account/pair/status' && m === 'GET') {              // T-0048: the device polls; the token is handed over exactly once
    const pt = url.searchParams.get('pollToken') || '';
    sweepPairing(store);
    const entry = Object.entries(store.pairing || {}).find(([, r]) => same(r.pollHash, sha(pt)));
    if (!entry) return ctx.json(res, 200, { status: 'expired' }), true;
    const [code, rec] = entry;
    if (rec.status === 'approved') { const out = { status: 'approved', token: rec.result, username: rec.username, url: PUBLIC_URL }; delete store.pairing[code]; save(store); return ctx.json(res, 200, out), true; }
    return ctx.json(res, 200, { status: 'pending', expiresIn: Math.max(0, Math.round((rec.expires - Date.now()) / 1000)) }), true;
  }
  if (p === '/account/login/totp' && m === 'POST') {              // T-0040: second step of login
    if (ctx.loginThrottled(clientIp(req))) return ctx.json(res, 429, { error: 'Too many attempts. Wait a minute.' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    const rec = store.mfaPending?.[sha(String(b?.mfaToken || ''))];
    if (!rec || rec.expires < Date.now()) return ctx.json(res, 400, { error: 'This sign-in attempt expired. Start again.' }), true;
    const acct = store.accounts[rec.email];
    if (!acct || !acct.totp) { delete store.mfaPending[sha(String(b.mfaToken))]; save(store); return ctx.json(res, 400, { error: 'Start the sign-in again.' }), true; }
    if (!secondFactorOk(acct, b?.code)) { save(store); return ctx.json(res, mfaLocked(acct) ? 429 : 401, { error: mfaLocked(acct) ? 'Too many wrong codes. Wait 15 minutes, then try again.' : 'That code is not right. Codes change every 30 seconds; recovery codes work once.' }), true; }
    delete store.mfaPending[sha(String(b.mfaToken))];
    let dev = null;
    if (b?.remember) {                                                                             // 30-day device cookie, hashed server-side, 5 devices max
      dev = crypto.randomBytes(24).toString('base64url');
      acct.mfaDevices = [...(acct.mfaDevices || []).filter(d => d.expires > Date.now()), { hash: sha(dev), expires: Date.now() + 30 * 86400e3, ua: String(req.headers['user-agent'] || '').slice(0, 80) }].slice(-5);
    }
    acct.lastLogin = Date.now(); noteLogin(req, acct); save(store);
    if (acct.workspace) ctx.withWorkspace(acct.workspace, () => ctx.audit({ username: acct.username }, { action: 'login-2fa', remembered: !!b?.remember }, true));   // T-0057
    const token = signIn(res, ctx, acct);                                                           // sets the session cookie
    if (dev) res.setHeader('Set-Cookie', [...[].concat(res.getHeader('Set-Cookie') || []), `chamber_mfa=${dev}; HttpOnly; SameSite=Strict; Path=/account; Max-Age=${30 * 86400}` + (ctx.cookieSecure ? '; Secure' : '')]);   // add, not replace
    console.log(`[accounts] 2fa login: ${acct.username}`);
    return ctx.json(res, 200, { ok: true, account: publicView(acct, store), token }), true;
  }
  if (p === '/account/totp' && m === 'GET') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    return ctx.json(res, 200, { enabled: !!me.totp, enabledAt: me.totp?.enabledAt || null, recoveryLeft: (me.totpRecovery || []).length, devices: (me.mfaDevices || []).filter(d => d.expires > Date.now()).length }), true;
  }
  if (p === '/account/totp/setup' && m === 'POST') {              // step 1: a fresh secret, nothing enabled yet
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    if (me.totp) return ctx.json(res, 400, { error: 'Two-factor is already on. Turn it off first to set up a new device.' }), true;
    const secret = b32enc(crypto.randomBytes(20));
    me.totpPending = { secret, at: Date.now() }; save(store);
    const label = encodeURIComponent(`Chamber:${me.email}`);
    return ctx.json(res, 200, { secret, otpauth: `otpauth://totp/${label}?secret=${secret}&issuer=Chamber&algorithm=SHA1&digits=6&period=30`, message: 'Add this to your authenticator app, then enter the code it shows.' }), true;
  }
  if (p === '/account/totp/confirm' && m === 'POST') {            // step 2: prove the app has the secret; get recovery codes once
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    if (!me.totpPending || Date.now() - me.totpPending.at > 15 * 60e3) return ctx.json(res, 400, { error: 'Start the setup again (it expires after 15 minutes).' }), true;
    if (!totpOk(me.totpPending.secret, b?.code)) return ctx.json(res, 401, { error: 'That code is not right. Check the clock on your phone and try the next code.' }), true;
    const codes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
    me.totp = { secret: me.totpPending.secret, enabledAt: Date.now() }; delete me.totpPending;
    me.totpRecovery = codes.map(c => sha(c)); me.mfaDevices = []; save(store);
    for (const [t, s] of ctx.sessions) if (s.email === me.email && t !== sess.token) ctx.sessions.delete(t);   // other sessions must prove the new factor
    console.log(`[accounts] 2fa enabled: ${me.username}`); ctx.audit(sess, { action: '2fa-enabled' }, true);   // T-0057
    return ctx.json(res, 200, { ok: true, recoveryCodes: codes.map(c => c.slice(0, 5) + '-' + c.slice(5)), message: 'Two-factor is on. Save these recovery codes somewhere safe; each works once and they are shown only now.' }), true;
  }
  if (p === '/account/totp/disable' && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    if (!me.totp) return ctx.json(res, 400, { error: 'Two-factor is not on.' }), true;
    { const g = reauth(me, b?.password); if (g !== 'ok') return reauthFail(ctx, res, g), true; }
    if (!secondFactorOk(me, b?.code)) { save(store); return ctx.json(res, 401, { error: 'Enter a current code from your app or a recovery code.' }), true; }
    delete me.totp; delete me.totpRecovery; delete me.mfaDevices; delete me.totpPending; save(store);
    console.log(`[accounts] 2fa disabled: ${me.username}`); ctx.audit(sess, { action: '2fa-disabled' }, true);   // T-0057
    return ctx.json(res, 200, { ok: true, message: 'Two-factor is off.' }), true;
  }
  if (p === '/account/notify' && m === 'GET') {                    // T-0078: this account's per-room levels + quiet hours (Account page reads this)
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    return ctx.json(res, 200, { rooms: me.notify || {}, quiet: me.quiet || { enabled: false }, held: me.pushHeld || 0, levels: notify.LEVELS, default: 'mentions' }), true;
  }
  if (p === '/account/notify' && m === 'POST') {                   // T-0078: set one room's level (all | mentions | muted)
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    const room = String((b && b.room) || '').slice(0, 200); const level = String((b && b.level) || '');
    if (!room) return ctx.json(res, 400, { error: 'room required' }), true;
    if (!notify.LEVELS.includes(level)) return ctx.json(res, 400, { error: 'level must be all, mentions or muted' }), true;
    me.notify = me.notify || {};
    if (level === 'mentions') delete me.notify[room]; else me.notify[room] = level;   // the default is stored as absence
    save(store);
    return ctx.json(res, 200, { room, level }), true;
  }
  if (p === '/account/quiet' && m === 'POST') {                    // T-0078: set or clear quiet hours
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    if (b && b.enabled) {
      if (notify.parseHM(b.start) == null || notify.parseHM(b.end) == null) return ctx.json(res, 400, { error: 'start and end must be HH:MM' }), true;
      const tz = String(b.tz || 'UTC'); if (!okTz(tz)) return ctx.json(res, 400, { error: 'invalid time zone' }), true;
      me.quiet = { enabled: true, start: b.start, end: b.end, tz };
    } else { me.quiet = { enabled: false }; }
    save(store);
    return ctx.json(res, 200, { quiet: me.quiet }), true;
  }
  if (p === '/account/push' && m === 'GET') {                      // T-0013: public key + whether this account has subscriptions
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    return ctx.json(res, 200, { publicKey: push.publicKey(), subscriptions: (me.push || []).length }), true;
  }
  if (p === '/account/push' && m === 'POST') {                     // T-0013: register this device for pushes
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    const sub = b?.subscription;
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint)) return ctx.json(res, 400, { error: 'bad subscription' }), true;
    me.push = (me.push || []).filter(s => s.endpoint !== sub.endpoint).concat([{ endpoint: sub.endpoint, keys: sub.keys || {}, addedAt: Date.now() }]).slice(-10);
    save(store);
    return ctx.json(res, 200, { ok: true, subscriptions: me.push.length }), true;
  }
  if (p === '/account/push/clear' && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    me.push = []; save(store); return ctx.json(res, 200, { ok: true }), true;
  }
  if (p === '/account/logout' && m === 'POST') {
    if (sess) ctx.sessions.delete(sess.token);
    res.setHeader('Set-Cookie', 'chamber_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + (ctx.cookieSecure ? '; Secure' : ''));
    return ctx.json(res, 200, { ok: true }), true;
  }
  if (p === '/account/me' && m === 'GET') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    return ctx.json(res, 200, publicView(me, store)), true;
  }

  // Self-service (T-0019): change password / email, export the workspace, delete the account.
  if (p === '/account/password' && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    { const g = reauth(me, b?.current); if (g !== 'ok') return reauthFail(ctx, res, g, 'Current password is wrong.'), true; }
    const pw = String(b?.password || '');
    if (pw.length < MIN_PASSWORD) return ctx.json(res, 400, { error: `Password must be at least ${MIN_PASSWORD} characters.` }), true;
    me.salt = crypto.randomBytes(16).toString('hex'); me.hash = hash(pw, me.salt); save(store);
    for (const [t, s] of ctx.sessions) if (s.email === me.email && t !== sess.token) ctx.sessions.delete(t);   // other devices must log in again
    return ctx.json(res, 200, { ok: true }), true;
  }
  if (p === '/account/email' && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    const email = String(b?.email || '').trim().toLowerCase();
    { const g = reauth(me, b?.password); if (g !== 'ok') return reauthFail(ctx, res, g), true; }
    if (!EMAIL_RE.test(email)) return ctx.json(res, 400, { error: 'Enter a valid email address.' }), true;
    if (store.accounts[email]) return ctx.json(res, 409, { error: 'That email already has an account.' }), true;
    const old = me.email;
    delete store.accounts[old]; me.email = email; store.accounts[email] = me;
    store.usernames[me.username.toLowerCase()] = email;
    for (const w of Object.values(store.workspaces)) if (w.owner === old) w.owner = email;
    if (VERIFY_REQUIRED()) startVerification(store, me, 'You changed the email on your Chamber account.');   // T-0032: a new address must be confirmed again
    save(store);
    for (const s of ctx.sessions.values()) if (s.email === old) s.email = email;
    return ctx.json(res, 200, { ok: true, email, emailVerified: verified(me) }), true;
  }
  if (p === '/account/export' && m === 'GET') {                   // owner only: everything in the workspace, as one JSON file
    if (!me || !myWs) return ctx.json(res, 401, { error: 'not signed in' }), true;
    if (!amOwner) return ctx.json(res, 403, { error: 'Only the workspace owner can export.' }), true;
    const dir = path.join(DATA_DIR, 'ws', myWs.id); const read = n => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } };
    const out = { exported_at: new Date().toISOString(), workspace: { id: myWs.id, name: myWs.name, members: members(store, myWs.id).map(a => ({ username: a.username, role: a.email === myWs.owner ? 'owner' : 'member' })) },
                  chat: ctx.withWorkspace(myWs.id, () => { const d = ctx.loadDataFull(); return { users: d.users, rooms: d.rooms, messages: d.messages }; }),   // T-0017: from SQLite
                  tickets: read('tickets.json'), reviews: read('reviews.json'), agent_audit: read('audit.json'), agent_memory: read('memory.json'),   // T-0059
                  files: ctx.withWorkspace(myWs.id, () => ctx.listFiles()) };   // T-0064: metadata only; the bytes are in the backup's files/ directory
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="chamber-${myWs.name.replace(/[^A-Za-z0-9_-]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json"` });
    res.end(JSON.stringify(out, null, 2)); return true;
  }
  if (p === '/account/import' && m === 'POST') {                 // T-0079: read an export back into an EMPTY workspace (owner only). Dry-run reports counts + conflicts; ids are preserved.
    if (!me || !myWs) return ctx.json(res, 401, { error: 'not signed in' }), true;
    if (!amOwner) return ctx.json(res, 403, { error: 'Only the workspace owner can import.' }), true;
    const b = await ctx.parseBody(req).catch(() => null);
    const exp = b && b.export;
    if (!exp || typeof exp !== 'object' || !exp.chat || typeof exp.chat !== 'object') return ctx.json(res, 400, { error: 'Upload a Chamber export file (the JSON from Account \u2192 Export).' }), true;
    { const bad = importUnsafe(exp); if (bad) return ctx.json(res, 400, { error: `This does not look like a file made by Chamber's Export: ${bad}. Nothing was imported.` }), true; }
    const dir = path.join(DATA_DIR, 'ws', myWs.id);
    const readJson = n => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } };
    const cur = ctx.withWorkspace(myWs.id, () => ctx.loadDataFull());
    const curT = readJson('tickets.json'); const curR = readJson('reviews.json'); const curM = readJson('memory.json');
    const memNotes = curM ? Object.values(curM).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0) : 0;   // T-0102 F3: agent memory counts, so import can't clobber it
    const curFiles = (() => { try { return fs.readdirSync(path.join(dir, 'files')).filter(f => !f.endsWith('.part')).length; } catch { return 0; } })();   // T-0102 F3: existing uploads count too
    const nonEmpty = cur.messages.length > 0 || (curT && (curT.tickets || []).length > 0) || (curR && ((curR.reviews || curR || []).length) > 0) || memNotes > 0 || curFiles > 0;
    const counts = {
      users: Object.keys(exp.chat.users || {}).length, rooms: Object.keys(exp.chat.rooms || {}).length, messages: (exp.chat.messages || []).length,
      tickets: (exp.tickets && (exp.tickets.tickets || []).length) || 0,
      reviews: exp.reviews ? ((exp.reviews.reviews || exp.reviews || []).length || 0) : 0,
      memory_notes: exp.agent_memory ? Object.values(exp.agent_memory).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0) : 0,
      files: (exp.files || []).length };
    if (b.dryRun) return ctx.json(res, 200, { dryRun: true, counts, empty: !nonEmpty, from: exp.workspace || null, exported_at: exp.exported_at || null,
      files_note: counts.files ? 'File references only — attachment bytes are not carried by the JSON export; restore the backup files/ directory to serve them.' : null,
      conflict: nonEmpty ? 'This workspace already has data. Import only into an empty workspace.' : null }), true;
    if (nonEmpty) return ctx.json(res, 409, { error: 'This workspace already has messages or tickets. Import only works on an empty workspace.', counts, empty: false }), true;
    // T-0102 F2: make the import atomic. Stage the side-files to temp first; import chat+file-metadata in ONE db
    // transaction; only then rename the temp files into place. If the db import throws, the transaction rolled the
    // workspace back to empty, so we delete the temp files and the owner can simply retry (nothing is left half-done).
    fs.mkdirSync(dir, { recursive: true });
    const staged = [];   // [tmpPath, finalPath]
    try {
      const stage = (name, val, pretty) => { if (val === undefined || val === null) return; const tmp = path.join(dir, name + '.importtmp'); fs.writeFileSync(tmp, JSON.stringify(val, null, pretty ? 2 : 0)); staged.push([tmp, path.join(dir, name)]); };
      stage('tickets.json', exp.tickets, true); stage('reviews.json', exp.reviews, true);
      stage('memory.json', exp.agent_memory, false); stage('audit.json', exp.agent_audit, false);
    } catch (e) { for (const [tmp] of staged) { try { fs.unlinkSync(tmp); } catch {} } return ctx.json(res, 500, { error: 'Import failed while staging data: ' + (e.message || 'unknown error') }), true; }
    let imported;
    try { imported = ctx.withWorkspace(myWs.id, () => ctx.importWorkspace(exp)); }
    catch (e) { for (const [tmp] of staged) { try { fs.unlinkSync(tmp); } catch {} } return ctx.json(res, 500, { error: 'Import failed: ' + (e.message || 'unknown error') + ' — the workspace was left empty, you can retry.' }), true; }
    for (const [tmp, final] of staged) { try { fs.renameSync(tmp, final); } catch (e) { console.error('[accounts] import side-file commit:', e.message); } }
    if (ctx.audit) ctx.audit(sess, { action: 'workspace-import', counts });
    return ctx.json(res, 200, { ok: true, imported, counts, files_note: counts.files ? 'Imported ' + counts.files + ' file reference(s). Attachment bytes are not carried by the JSON export; restore the backup files/ directory to serve them.' : null }), true;
  }
  if (p === '/account/delete' && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    { const g = reauth(me, b?.password); if (g !== 'ok') return reauthFail(ctx, res, g), true; }
    if (String(b?.confirm || '') !== me.username) return ctx.json(res, 400, { error: 'Type your username to confirm.' }), true;
    if (amOwner && members(store, myWs.id).length > 1) return ctx.json(res, 400, { error: 'You own a workspace with other members. Transfer ownership first (Workspace section), or remove the members.' }), true;   // T-0034
    if (amOwner && me.subscription && ['active', 'trialing', 'past_due'].includes(me.subStatus || '')) {
      try { await stripe('DELETE', `subscriptions/${me.subscription}`); } catch (e) { console.error('[accounts] cancel on delete:', e.message); }
    }
    const st = load(), gone = st.accounts[me.email], ws = gone && st.workspaces[gone.workspace];   // re-read: the cancel above waited on Stripe
    if (gone && ws && ws.owner === gone.email) {
      for (const a of members(st, ws.id)) if (a.email !== gone.email) { createWorkspace(st, a); endSessions(ctx, a.email); }   // members get their own empty workspace
      for (const t of Object.values(ws.tokens || {})) delete st.usernames[t.username.toLowerCase()];
      delete st.workspaces[ws.id];
      if (WS_RE.test(ws.id)) fs.rmSync(path.join(DATA_DIR, 'ws', ws.id), { recursive: true, force: true });
    }
    if (gone) { delete st.usernames[gone.username.toLowerCase()]; delete st.accounts[gone.email]; save(st); }
    endSessions(ctx, me.email);
    res.setHeader('Set-Cookie', 'chamber_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + (ctx.cookieSecure ? '; Secure' : ''));
    console.log(`[accounts] deleted account ${me.username}${amOwner ? ' and workspace ' + myWs.id : ''}`);
    return ctx.json(res, 200, { ok: true }), true;
  }

  // Workspace: members and invite link (T-0003 / T-0006). Everyone in the workspace can see members; only the owner manages.
  if (p.startsWith('/account/workspace')) {
    if (!me || !myWs) return ctx.json(res, 401, { error: 'not signed in' }), true;
    if (wsRoleOf(me, myWs) === 'requester') return ctx.json(res, 403, { error: 'A requester sees only their own requests, not the workspace.' }), true;   // T-0199
    if (p === '/account/workspace' && m === 'GET') {
      const seen = ctx.withWorkspace(myWs.id, () => ctx.loadData().users) || {};                                   // T-0034: last activity per member
      const roleOf = (a) => wsRoleOf(a, myWs);                                                                   // T-0199
      return ctx.json(res, 200, {
        id: myWs.id, name: myWs.name, role: roleOf(me), canManage: amAdmin, owner: store.accounts[myWs.owner]?.username || null,
        members: members(store, myWs.id).map(a => ({ username: a.username, role: roleOf(a), email: amAdmin ? a.email : undefined, chatRole: a.chatRole || 'human',
                                                      lastSeen: seen[a.username]?.lastSeen || null, joinedAt: a.createdAt || null })),
        inviteUrl: amAdmin ? `${PUBLIC_URL}/join/${myWs.invite}` : null,
        inviteUrls: amAdmin ? Object.fromEntries(GUEST_ROLES.map(r => [r, myWs.invites && myWs.invites[r] ? `${PUBLIC_URL}/join/${myWs.invites[r]}` : null])) : null,   // T-0199
        seats: { full: fullMembers(store, myWs.id).length, maxFull: MAX_MEMBERS, guests: guestMembers(store, myWs.id).length, maxGuests: MAX_GUESTS },   // T-0199
        approval: approvalRules(myWs),                                           // T-0190
        requestDrafts: !myWs.requestDraftsOff,                                   // T-0207
        report: amAdmin ? reportView(myWs) : null,                               // T-0202
        budget: budgetOf(myWs.id),                                               // T-0203
        fleet: myWs.fleet ? { linked: true, tenant: myWs.fleet.tenant || '', by: myWs.fleet.by, at: myWs.fleet.at, state: myWs.fleet.state || 'ok', lastError: myWs.fleet.lastError || null } : { linked: false },   // T-0153: never the key
        agentPolicy: myWs.agentPolicy || 'owner',
        retentionDays: myWs.retentionDays || 0,                                  // T-0037: 0 = keep forever
      }), true;
    }
    if (p === '/account/workspace/audit/verify' && m === 'GET') {             // T-0194: is the record intact?
      return ctx.json(res, 200, ctx.verifyAudit(path.join(DATA_DIR, 'ws', myWs.id))), true;
    }
    if (p === '/account/workspace/audit' && m === 'GET') {        // T-0015/T-0057: who did what (members may look; owner/admin may export everything)
      const dir = path.join(DATA_DIR, 'ws', myWs.id);
      const q = (url.searchParams.get('q') || '').toLowerCase(), actor = (url.searchParams.get('actor') || '').toLowerCase(), action = (url.searchParams.get('action') || '').toLowerCase();
      const since = parseInt(url.searchParams.get('since')) || 0, until = parseInt(url.searchParams.get('until')) || Infinity, format = url.searchParams.get('format');
      const match = (r) => r.ts >= since && r.ts <= until && (!actor || String(r.actor || r.agent || '').toLowerCase() === actor) && (!action || String(r.action || '').toLowerCase().includes(action)) && (!q || JSON.stringify(r).toLowerCase().includes(q));
      if (format === 'csv' || format === 'json') {
        if (!amAdmin) return ctx.json(res, 403, { error: 'Only the workspace owner or an admin can export the audit log.' }), true;
        const all = ctx.auditAll(dir).filter(match);
        const filtered = !!(q || actor || action || since || until !== Infinity), ch = filtered ? null : ctx.verifyAudit(dir);   // T-0194: before the export adds its own entry
        ctx.audit(sess, { action: 'audit-export', format, entries: all.length }, true);
        const name = `chamber-audit-${myWs.name.replace(/[^A-Za-z0-9_-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.${format}`;
        if (format === 'json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${name}"` }); res.end(JSON.stringify({ workspace: myWs.name, exported_at: new Date().toISOString(), chain: ch ? { ok: ch.ok, n: ch.n, head: ch.head, how: 'node tools/verify-audit.js <this file> checks it without the server' } : { partial: true, how: 'This export is filtered, so it cannot be checked as a whole. Export without a filter to check it.' }, entries: all })); return true; }
        const cols = ['ts', 'time_utc', 'actor', 'kind', 'action', 'target', 'details', 'request_id', 'ip'];
        const cell = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        const rows = all.map(r => { const { ts, actor: a, agent, kind, action: act, rid, ip, ...rest } = r; const target = rest.ticket || rest.id || rest.room || rest.review || rest.username || rest.target || ''; return [ts, new Date(ts).toISOString(), a || agent || '', kind || (agent ? 'agent' : 'human'), act || '', target, JSON.stringify(rest), rid || '', ip || ''].map(cell).join(','); });
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` }); res.end(cols.join(',') + '\n' + rows.join('\n') + '\n'); return true;
      }
      let log = []; try { log = JSON.parse(fs.readFileSync(path.join(dir, 'audit.json'), 'utf8')); } catch { /* none yet */ }
      const filtered = log.filter(match);
      return ctx.json(res, 200, { audit: filtered.slice(-300).reverse(), total: filtered.length, actors: [...new Set(log.map(r => r.actor || r.agent).filter(Boolean))].sort() }), true;
    }
    if (!amAdmin) return ctx.json(res, 403, { error: 'Only the workspace owner or an admin can do that.' }), true;   // T-0034
    const b = await ctx.parseBody(req).catch(() => ({}));
    const ownerOnly = () => ctx.json(res, 403, { error: 'Only the workspace owner can do that.' });
    if (p === '/account/workspace/fleet' && m === 'POST') {      // T-0153: link this workspace to a GhostPort fleet tenant (read-only router status), or unlink
      if (!amOwner) return ownerOnly(), true;
      if (b?.unlink) {
        if (myWs.fleet) { delete myWs.fleet; save(store); ctx.audit(sess, { action: 'fleet-unlink' }, true); }
        fleet.forget(myWs.id); return ctx.json(res, 200, { ok: true, linked: false }), true;
      }
      if (!verified(me)) return ctx.json(res, 403, { error: 'Confirm your email address first (account page).', needsVerification: true }), true;
      const key = String(b?.key || '').trim();
      const tried = await fleet.tryKey(key);                        // one GET to the fleet with that key; nothing is stored unless it answers
      if (!tried.ok) { ctx.audit(sess, { action: 'fleet-link-failed', code: tried.code }, true); return ctx.json(res, tried.code, { error: tried.error }), true; }
      const fresh = load(); const ws2 = fresh.workspaces[myWs.id];   // re-read: the check above waited on the network
      if (!ws2) return ctx.json(res, 404, { error: 'workspace not found' }), true;
      ws2.fleet = { sealed: fleet.seal(path.dirname(FILE), myWs.id, key), tenant: tried.data.tenant, by: me.username, at: Date.now(), state: 'ok', lastOk: Date.now(), lastError: null };
      save(fresh); fleet.forget(myWs.id);
      ctx.audit(sess, { action: 'fleet-link', tenant: tried.data.tenant, routers: tried.data.count }, true);
      return ctx.json(res, 200, { ok: true, linked: true, tenant: tried.data.tenant, routers: tried.data.count, online: tried.data.online }), true;
    }
    if (p === '/account/workspace/report' && m === 'POST') {    // T-0202: owner or admin: who gets the Monday email, and the private link
      myWs.report = myWs.report || {};
      if (b?.recipients !== undefined) {
        const list = [...new Set((Array.isArray(b.recipients) ? b.recipients : String(b.recipients).split(/[,\s]+/)).map(s => String(s).trim().toLowerCase()).filter(Boolean))];
        if (list.length > 10) return ctx.json(res, 400, { error: 'At most 10 people get the report by email.' }), true;
        const bad = list.filter(e => !EMAIL_RE.test(e)); if (bad.length) return ctx.json(res, 400, { error: `Not an email address: ${bad.slice(0, 3).join(', ')}` }), true;
        myWs.report.recipients = list;
      }
      if (b?.enabled !== undefined) myWs.report.enabled = !!b.enabled;
      if (myWs.report.enabled && !(myWs.report.recipients || []).length) return ctx.json(res, 400, { error: 'Add at least one email address before switching the email on.' }), true;
      if (b?.link === 'make') myWs.report.token = crypto.randomBytes(18).toString('base64url');
      if (b?.link === 'off') delete myWs.report.token;
      save(store); ctx.audit(sess, { action: 'report-settings', enabled: !!myWs.report.enabled, recipients: (myWs.report.recipients || []).length, link: b?.link || undefined }, true);
      return ctx.json(res, 200, { ok: true, report: reportView(myWs) }), true;
    }
    if (p === '/account/workspace/role' && m === 'POST') {       // T-0034: owner promotes/demotes a member
      if (!amOwner) return ownerOnly(), true;
      const target = Object.values(store.accounts).find(a => a.username.toLowerCase() === String(b?.username || '').toLowerCase() && a.workspace === myWs.id);
      if (!target) return ctx.json(res, 404, { error: 'No such member in your workspace.' }), true;
      if (target.email === myWs.owner) return ctx.json(res, 400, { error: 'The owner already has every permission. Use Transfer to hand the workspace over.' }), true;
      if (!['admin', 'member', 'viewer', 'requester'].includes(b?.role)) return ctx.json(res, 400, { error: 'role must be admin, member, viewer or requester' }), true;   // T-0199
      const toGuest = GUEST_ROLES.includes(b.role), wasGuest = GUEST_ROLES.includes(wsRoleOf(target, myWs));
      if (toGuest && (target.chatRole || 'human') !== 'human') return ctx.json(res, 400, { error: 'An AI account cannot be a viewer or requester.' }), true;
      if (!toGuest && wasGuest && fullMembers(store, myWs.id).length >= MAX_MEMBERS) return ctx.json(res, 409, { error: `No free seat: this workspace already has ${MAX_MEMBERS} members. Remove someone, or make someone a viewer, first.` }), true;
      if (toGuest && !wasGuest && guestMembers(store, myWs.id).length >= MAX_GUESTS) return ctx.json(res, 409, { error: `No free place for viewers and requesters (${MAX_GUESTS}).` }), true;
      target.wsRole = b.role; save(store);
      console.log(`[accounts] ${me.username} made ${target.username} ${b.role} in ${myWs.id}`); ctx.audit(sess, { action: 'member-role', username: target.username, role: b.role }, true);   // T-0057
      return ctx.json(res, 200, { ok: true, username: target.username, role: b.role }), true;
    }
    if (p === '/account/workspace/transfer' && m === 'POST') {   // T-0034: hand the workspace (and its subscription) to another human member
      if (!amOwner) return ownerOnly(), true;
      { const g = reauth(me, b?.password); if (g !== 'ok') return reauthFail(ctx, res, g), true; }
      const target = Object.values(store.accounts).find(a => a.username.toLowerCase() === String(b?.username || '').toLowerCase() && a.workspace === myWs.id);
      if (!target) return ctx.json(res, 404, { error: 'No such member in your workspace.' }), true;
      if (target.email === me.email) return ctx.json(res, 400, { error: 'You already own this workspace.' }), true;
      if (GUEST_ROLES.includes(wsRoleOf(target, myWs))) return ctx.json(res, 400, { error: 'Make them a member first: a viewer or requester cannot own the workspace.' }), true;   // T-0199
      if ((target.chatRole || 'human') !== 'human') return ctx.json(res, 400, { error: 'Ownership can only go to a human member.' }), true;
      if (!verified(target)) return ctx.json(res, 400, { error: `${target.username} has not confirmed their email address yet.` }), true;
      // The subscription pays for the workspace, so it moves with it. Stripe is told about the new owner so receipts and the billing portal follow.
      const moved = {};
      for (const k of ['stripeCustomer', 'subscription', 'subStatus', 'periodEnd', 'cancelAtPeriodEnd', 'paymentFailedAt', 'lastPaymentError', 'paymentFailedMailAt', 'storagePacks']) { if (me[k] !== undefined && me[k] !== null) { moved[k] = me[k]; target[k] = me[k]; } delete me[k]; }
      me.subscription = null; me.subStatus = null; me.periodEnd = null; me.stripeCustomer = null;
      myWs.owner = target.email; target.wsRole = 'owner'; me.wsRole = 'admin'; save(store);
      if (moved.stripeCustomer) stripe('POST', `customers/${moved.stripeCustomer}`, { email: target.email, metadata: { chamber_username: target.username, chamber_workspace: myWs.id } })
        .catch(e => console.error('[accounts] transfer: could not update Stripe customer:', e.message));
      console.log(`[accounts] ${me.username} transferred ${myWs.id} to ${target.username}${moved.subscription ? ' with subscription ' + moved.subscription : ''}`); ctx.audit(sess, { action: 'workspace-transfer', username: target.username, subscriptionMoved: !!moved.subStatus }, true);   // T-0057
      return ctx.json(res, 200, { ok: true, owner: target.username, subscriptionMoved: !!(moved.subStatus || moved.subscription || moved.stripeCustomer) }), true;
    }
    if (p === '/account/workspace' && m === 'POST') {           // rename and/or agent policy
      let approvalWarning;
      if (b?.budget !== undefined) {                                                                                 // T-0203: the owner's monthly AI budget
        if (!amOwner) return ownerOnly(), true;
        const bu = b.budget && typeof b.budget === 'object' ? b.budget : {}, cents = v => v === undefined || v === null || v === '' ? 0 : (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= 1e7 ? Number(v) : NaN);
        const monthlyCents = cents(bu.monthlyCents); if (Number.isNaN(monthlyCents)) return ctx.json(res, 400, { error: 'The budget is whole cents from 0 to 100,000 dollars.' }), true;
        let pa = bu.perAgent || {};
        if (typeof pa === 'string') { const o = {}; for (const line of pa.split('\n').map(s => s.trim()).filter(Boolean)) { const m2 = line.match(/^@?([A-Za-z0-9_-]{2,24})\s*[:=]?\s*\$?\s*(\d+(?:\.\d{1,2})?)$/); if (!m2) return ctx.json(res, 400, { error: `Write each limit as: agent-name dollars (this line is not: ${line.slice(0, 40)})` }), true; o[m2[1]] = Math.round(Number(m2[2]) * 100); } pa = o; }
        if (typeof pa !== 'object' || Array.isArray(pa) || Object.keys(pa).length > 20) return ctx.json(res, 400, { error: 'At most 20 limits for single agents.' }), true;
        const clean = {}; for (const [k, v] of Object.entries(pa)) { const c = cents(v); if (!USER_RE.test(k) || Number.isNaN(c)) return ctx.json(res, 400, { error: `Not a valid limit for ${String(k).slice(0, 24)}.` }), true; if (c > 0) clean[k] = c; }
        myWs.budget = { monthlyCents, perAgent: clean };
        ctx.audit(sess, { action: 'ai-budget', monthlyCents, agents: Object.keys(clean).length }, true);
      }
      if (b?.approval !== undefined) {                                                                               // T-0190: the owner's approval rules
        if (!amOwner) return ownerOnly(), true;
        const ap = b.approval && typeof b.approval === 'object' ? b.approval : {}, two = ap.two === undefined ? 'none' : ap.two;
        if (!['none', 'high', 'all'].includes(two)) return ctx.json(res, 400, { error: 'two must be none, high or all' }), true;
        let names = Array.isArray(ap.approvers) ? ap.approvers : typeof ap.approvers === 'string' ? ap.approvers.split(',') : [];
        names = [...new Set(names.map(s => String(s).trim()).filter(Boolean))];
        if (names.length > 50) return ctx.json(res, 400, { error: 'Name at most 50 approvers.' }), true;
        const byName = new Map(members(store, myWs.id).map(a => [a.username.toLowerCase(), a]));
        const bad = names.filter(n => { const a = byName.get(n.toLowerCase()); return !a || (a.chatRole || 'human') !== 'human' || wsRoleOf(a, myWs) === 'requester'; });
        if (bad.length) return ctx.json(res, 400, { error: `Not a person in this workspace who may approve: ${bad.slice(0, 5).join(', ')}. Requesters and AI agents cannot approve.` }), true;
        const mins = (v, max) => v === undefined || v === null || v === '' ? 0 : Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= max ? Number(v) : NaN;   // T-0201
        const remindMin = mins(ap.remindMin, 10080), escalateMin = mins(ap.escalateMin, 20160), backupName = String(ap.backup || '').trim().replace(/^@/, '');
        if (Number.isNaN(remindMin) || Number.isNaN(escalateMin)) return ctx.json(res, 400, { error: 'reminder times are whole minutes: up to a week for the reminder, two weeks for the backup' }), true;
        if (escalateMin && !backupName) return ctx.json(res, 400, { error: 'Name the backup approver who should be told.' }), true;
        if (escalateMin && remindMin && escalateMin <= remindMin) return ctx.json(res, 400, { error: 'The backup is told after the reminder, so give it a longer time.' }), true;
        const backupAcct = backupName ? byName.get(backupName.toLowerCase()) : null;
        if (backupName && (!backupAcct || (backupAcct.chatRole || 'human') !== 'human' || wsRoleOf(backupAcct, myWs) === 'requester')) return ctx.json(res, 400, { error: `${backupName} is not a person in this workspace who may approve.` }), true;
        myWs.approval = { noSelf: !!ap.noSelf, two, approvers: names.map(n => byName.get(n.toLowerCase()).username), remindMin, escalateMin, backup: backupAcct ? backupAcct.username : '' };
        if (backupAcct && !approverNames(store, myWs).includes(backupAcct.username)) { delete myWs.approval; return ctx.json(res, 400, { error: `${backupAcct.username} may not approve under these rules; add them to the approvers or pick someone else as the backup.` }), true; }
        ctx.audit(sess, { action: 'approval-rules', noSelf: !!ap.noSelf, two, approvers: myWs.approval.approvers.join(',') }, true);
        const n = approverNames(store, myWs).length;
        if (n < 2 && (two !== 'none' || ap.noSelf)) approvalWarning = 'Only one person may approve right now, so these rules cannot fully apply yet: tickets are not blocked, and each one notes that a rule could not be met. They apply fully once a second approver exists.';
      }
      if (b?.requestDrafts !== undefined) {                                                                          // T-0207: a connected agent drafts a plan for each new request
        if (!amOwner) return ownerOnly(), true;
        if (typeof b.requestDrafts !== 'boolean') return ctx.json(res, 400, { error: 'requestDrafts must be true or false' }), true;
        if (b.requestDrafts) delete myWs.requestDraftsOff; else myWs.requestDraftsOff = true;
        ctx.audit(sess, { action: 'request-drafts', on: b.requestDrafts }, true);
      }
      if (b?.agentPolicy !== undefined) {
        if (!amOwner) return ownerOnly(), true;                                                                        // T-0034: policy is the owner's call
        if (!['owner', 'members'].includes(b.agentPolicy)) return ctx.json(res, 400, { error: 'agentPolicy must be owner or members' }), true;
        myWs.agentPolicy = b.agentPolicy; ctx.audit(sess, { action: 'agent-policy', policy: b.agentPolicy }, true);   // T-0057
      }
      if (b?.retentionDays !== undefined) {                                                                          // T-0037
        if (!amOwner) return ownerOnly(), true;
        const d = parseInt(b.retentionDays, 10);
        if (!Number.isInteger(d) || d < 0 || (d > 0 && d < 7) || d > 3650) return ctx.json(res, 400, { error: 'retentionDays must be 0 (keep forever) or between 7 and 3650' }), true;
        myWs.retentionDays = d; console.log(`[accounts] ${me.username} set retention ${d || 'forever'} for ${myWs.id}`); ctx.audit(sess, { action: 'retention', days: d }, true);   // T-0057
      }
      if (b?.name !== undefined) {
        const name = String(b.name || '').trim().slice(0, 48);
        if (name.length < 2) return ctx.json(res, 400, { error: 'Name must be 2 to 48 characters.' }), true;
        myWs.name = name; ctx.audit(sess, { action: 'workspace-rename', name }, true);   // T-0057
      }
      save(store);
      return ctx.json(res, 200, { ok: true, name: myWs.name, agentPolicy: myWs.agentPolicy || 'owner', retentionDays: myWs.retentionDays || 0, requestDrafts: !myWs.requestDraftsOff, approval: approvalRules(myWs), approvalWarning, budget: budgetOf(myWs.id) }), true;
    }
    if (p === '/account/workspace/invite-reset' && m === 'POST') {
      if (!verified(me)) return ctx.json(res, 403, { error: 'Confirm your email address first (account page).', needsVerification: true }), true;   // T-0032
      const role = b?.role === undefined ? 'member' : b.role;                                    // T-0199: member, viewer or requester link
      if (!['member', ...GUEST_ROLES].includes(role)) return ctx.json(res, 400, { error: 'role must be member, viewer or requester' }), true;
      if (role === 'member') { myWs.invite = newInvite(); save(store); ctx.audit(sess, { action: 'invite-rotate' }, true); return ctx.json(res, 200, { ok: true, inviteUrl: `${PUBLIC_URL}/join/${myWs.invite}` }), true; }   // T-0057
      myWs.invites = myWs.invites || {};
      if (b?.off) { delete myWs.invites[role]; save(store); ctx.audit(sess, { action: 'invite-off', role }, true); return ctx.json(res, 200, { ok: true, inviteUrl: null }), true; }
      myWs.invites[role] = newInvite(); save(store); ctx.audit(sess, { action: 'invite-rotate', role }, true);
      return ctx.json(res, 200, { ok: true, role, inviteUrl: `${PUBLIC_URL}/join/${myWs.invites[role]}` }), true;
    }
    if (p === '/account/workspace/tokens' && m === 'GET') {
      return ctx.json(res, 200, { tokens: Object.values(myWs.tokens || {}).map(t => ({ id: t.id, name: t.name, username: t.username, createdAt: t.createdAt, lastUsed: t.lastUsed || null, mayAsk: !!t.mayAsk })) }), true;
    }
    if (p === '/account/workspace/tokens' && m === 'POST') {    // create: returns the token ONCE
      if (!verified(me)) return ctx.json(res, 403, { error: 'Confirm your email address first (account page).', needsVerification: true }), true;   // T-0032
      const made = createAgentToken(store, ctx, myWs, me, b?.name, b?.username);                   // T-0048: shared with pairing
      if (made.error) return ctx.json(res, made.code || 400, { error: made.error }), true;
      save(store); ctx.audit(sess, { action: 'token-create', username: made.username, tokenId: made.id, name: String(b?.name || '').slice(0, 48) }, true);   // T-0057
      return ctx.json(res, 200, { ok: true, id: made.id, username: made.username, token: made.token }), true;
    }
    if (p === '/account/workspace/automation' && m === 'GET') {    // T-0058: schedules + webhooks (owner/admin)
      const now = new Date();
      return ctx.json(res, 200, {
        schedules: (myWs.schedules || []).map(s => ({ ...s, nextRun: s.enabled ? (cron.next(s.spec, s.tz, now)?.getTime() || null) : null })),
        hooks: (myWs.hooks || []).map(h => ({ id: h.id, name: h.name, room: h.room, instruction: h.instruction, bot: h.bot || null, by: h.by, createdAt: h.createdAt, lastHit: h.lastHit || null, hits: h.hits || 0 })),
        mirrors: (myWs.mirrors || []).map(x => { let host = '?'; try { host = new URL(x.url).hostname; } catch {} return { id: x.id, room: x.room, kind: x.kind, host, urlTail: x.url.slice(-6), by: x.by, enabled: x.enabled, sent: x.sent || 0, fails: x.fails || 0, lastSent: x.lastSent || null, lastError: x.lastError || null }; }),   // T-0062: URL never returned in full
        presets: cron.PRESETS,
      }), true;
    }
    if (p === '/account/workspace/schedules' && m === 'POST') {     // T-0058: create
      const spec = b?.preset ? cron.fromPreset(String(b.preset), String(b.time || '')) : String(b?.spec || '').trim();
      if (!spec || !cron.valid(spec)) return ctx.json(res, 400, { error: 'Give a valid schedule: a preset with a time (HH:MM), or a 5-field cron line like "30 7 * * 1-5".' }), true;
      const tz = String(b?.tz || 'UTC'); if (!cron.validTz(tz)) return ctx.json(res, 400, { error: 'Unknown time zone. Use an IANA name like America/Los_Angeles or UTC.' }), true;
      const text = String(b?.text || '').trim(); if (text.length < 3 || text.length > 2000) return ctx.json(res, 400, { error: 'Text: 3 to 2000 characters, usually starting with @agent-name.' }), true;
      const room = String(b?.room || 'general');
      const rooms = ctx.withWorkspace(myWs.id, () => ctx.loadData().rooms);
      if (!rooms[room] || rooms[room].dm) return ctx.json(res, 400, { error: 'Pick an existing room (not a DM).' }), true;
      if ((myWs.schedules || []).length >= 30) return ctx.json(res, 400, { error: 'Limit of 30 schedules per workspace.' }), true;
      const s = { id: crypto.randomBytes(4).toString('hex'), spec, tz, room, text, by: me.username, enabled: true, createdAt: Date.now(), lastRun: null, runs: 0, once: !!b?.once };   // T-0069: once = a reminder; it disables itself after firing
      (myWs.schedules ||= []).push(s); save(store);
      ctx.audit(sess, { action: 'schedule-create', id: s.id, spec, tz, room }, true);
      return ctx.json(res, 201, { ok: true, schedule: { ...s, nextRun: cron.next(spec, tz)?.getTime() || null } }), true;
    }
    const schedMatch = p.match(/^\/account\/workspace\/schedules\/([a-f0-9]{8})$/);
    if (schedMatch && m === 'POST') {                                // T-0058: toggle / delete
      const s = (myWs.schedules || []).find(x => x.id === schedMatch[1]); if (!s) return ctx.json(res, 404, { error: 'No such schedule.' }), true;
      if (b?.delete) { myWs.schedules = myWs.schedules.filter(x => x.id !== s.id); save(store); ctx.audit(sess, { action: 'schedule-delete', id: s.id }, true); return ctx.json(res, 200, { ok: true }), true; }
      if (b?.enabled !== undefined) { s.enabled = !!b.enabled; save(store); ctx.audit(sess, { action: 'schedule-toggle', id: s.id, enabled: s.enabled }, true); }
      return ctx.json(res, 200, { ok: true, schedule: s }), true;
    }
    if (p === '/account/workspace/mirrors' && m === 'POST') {       // T-0062: forward a room to Slack / Discord / any JSON endpoint
      const room = String(b?.room || 'general'); const rooms = ctx.withWorkspace(myWs.id, () => ctx.loadData().rooms);
      if (!rooms[room] || rooms[room].dm) return ctx.json(res, 400, { error: 'Pick an existing room (not a DM).' }), true;
      const kind = ['slack', 'discord', 'generic'].includes(b?.kind) ? b.kind : null; if (!kind) return ctx.json(res, 400, { error: 'kind must be slack, discord or generic' }), true;
      let u; try { u = new URL(String(b?.url || '')); } catch { u = null; }
      if (!u || u.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname)) return ctx.json(res, 400, { error: 'Mirror URL must be https and public (Slack incoming webhook, Discord webhook, or your own endpoint).' }), true;
      if ((myWs.mirrors || []).length >= 10) return ctx.json(res, 400, { error: 'Limit of 10 mirrors per workspace.' }), true;
      const mr = { id: crypto.randomBytes(4).toString('hex'), room, kind, url: u.toString(), by: me.username, enabled: true, createdAt: Date.now(), sent: 0, fails: 0, lastSent: null, lastError: null };
      (myWs.mirrors ||= []).push(mr); save(store);
      ctx.audit(sess, { action: 'mirror-create', id: mr.id, room, kind, host: u.hostname }, true);
      return ctx.json(res, 201, { ok: true, id: mr.id }), true;
    }
    const mirrorMatch = p.match(/^\/account\/workspace\/mirrors\/([a-f0-9]{8})$/);
    if (mirrorMatch && m === 'POST') {                               // T-0062: pause / delete
      const mr = (myWs.mirrors || []).find(x => x.id === mirrorMatch[1]); if (!mr) return ctx.json(res, 404, { error: 'No such mirror.' }), true;
      if (b?.delete) { myWs.mirrors = myWs.mirrors.filter(x => x.id !== mr.id); save(store); ctx.audit(sess, { action: 'mirror-delete', id: mr.id }, true); return ctx.json(res, 200, { ok: true }), true; }
      if (b?.enabled !== undefined) { mr.enabled = !!b.enabled; save(store); ctx.audit(sess, { action: 'mirror-toggle', id: mr.id, enabled: mr.enabled }, true); }
      return ctx.json(res, 200, { ok: true }), true;
    }
    if (p === '/account/workspace/hooks' && m === 'POST') {         // T-0058: create a webhook; URL shown once
      const name = String(b?.name || '').trim().slice(0, 48); if (name.length < 2) return ctx.json(res, 400, { error: 'Name the webhook (2 to 48 characters), e.g. "GitHub CI".' }), true;
      const room = String(b?.room || 'general'); const rooms = ctx.withWorkspace(myWs.id, () => ctx.loadData().rooms);
      if (!rooms[room] || rooms[room].dm) return ctx.json(res, 400, { error: 'Pick an existing room (not a DM).' }), true;
      if ((myWs.hooks || []).length >= 20) return ctx.json(res, 400, { error: 'Limit of 20 webhooks per workspace.' }), true;
      const id = crypto.randomBytes(4).toString('hex'), secret = crypto.randomBytes(24).toString('base64url');
      const bot = String(b?.bot || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 24);                  // T-0074: optional bot identity the deliveries post as
      if (bot && (bot.length < 2 || bot in Object.prototype)) return ctx.json(res, 400, { error: 'Bot name: 2 to 24 characters (letters, digits, - or _). Pick another name.' }), true;
      if (bot && Object.values(store.accounts).some(a => a.workspace === myWs.id && a.username.toLowerCase() === bot)) return ctx.json(res, 400, { error: 'That name belongs to a member; pick another for the bot.' }), true;
      const h = { id, name, room, instruction: String(b?.instruction || '').trim().slice(0, 500), bot: bot || null, by: me.username, hash: sha(secret), createdAt: Date.now(), hits: 0 };
      (myWs.hooks ||= []).push(h); save(store);
      ctx.audit(sess, { action: 'hook-create', id, name, room }, true);
      return ctx.json(res, 201, { ok: true, id, name, url: `${PUBLIC_URL}/hooks/chh_${id}_${secret}`, message: 'Copy the URL now; it is not shown again. Anyone who has it can post into that room.' }), true;
    }
    const hookMatch = p.match(/^\/account\/workspace\/hooks\/([a-f0-9]{8})$/);
    if (hookMatch && m === 'POST') {                                 // T-0058: delete / regenerate
      const h = (myWs.hooks || []).find(x => x.id === hookMatch[1]); if (!h) return ctx.json(res, 404, { error: 'No such webhook.' }), true;
      if (b?.delete) { myWs.hooks = myWs.hooks.filter(x => x.id !== h.id); save(store); ctx.audit(sess, { action: 'hook-delete', id: h.id }, true); return ctx.json(res, 200, { ok: true }), true; }
      if (b?.regenerate) { const secret = crypto.randomBytes(24).toString('base64url'); h.hash = sha(secret); save(store); ctx.audit(sess, { action: 'hook-regenerate', id: h.id }, true); return ctx.json(res, 200, { ok: true, url: `${PUBLIC_URL}/hooks/chh_${h.id}_${secret}` }), true; }
      return ctx.json(res, 400, { error: 'send {delete:true} or {regenerate:true}' }), true;
    }
    if (p === '/account/workspace/pair' && m === 'POST') {           // T-0048: approve a device code -> the device gets its token
      if (!verified(me)) return ctx.json(res, 403, { error: 'Confirm your email address first (account page).', needsVerification: true }), true;
      sweepPairing(store);
      const code = String(b?.code || '').replace(/\D/g, '');
      const rec = store.pairing?.[code];
      if (!rec || rec.status !== 'pending') return ctx.json(res, 404, { error: 'No device is waiting with that code (codes last 10 minutes). Run the pairing on the device again.' }), true;
      const made = createAgentToken(store, ctx, myWs, me, b?.name, b?.username);
      if (made.error) return ctx.json(res, made.code || 400, { error: made.error }), true;
      rec.status = 'approved'; rec.result = made.token; rec.username = made.username; rec.ws = myWs.id; rec.approvedBy = me.username; rec.expires = Date.now() + 5 * 60e3;   // 5 minutes to collect
      save(store);
      console.log(`[accounts] ${me.username} paired device ${code} as ${made.username} in ${myWs.id}`); ctx.audit(sess, { action: 'token-pair', username: made.username, tokenId: made.id }, true);   // T-0057
      return ctx.json(res, 200, { ok: true, username: made.username, id: made.id, message: `Paired: ${made.username} is collecting its token now. Nothing to copy.` }), true;
    }
    if (p === '/account/workspace/tokens/ask' && m === 'POST') {   // T-0188: may this agent ask a person to allow a tool use mid-job? Off by default; the owner decides per agent
      if (!amOwner) return ctx.json(res, 403, { error: 'Only the workspace owner can do that.' }), true;
      const t = myWs.tokens?.[String(b?.id || '')];
      if (!t) return ctx.json(res, 404, { error: 'No such token.' }), true;
      t.mayAsk = !!b?.on; save(store); ctx.audit(sess, { action: 'agent-may-ask', username: t.username, on: t.mayAsk }, true);
      return ctx.json(res, 200, { ok: true, mayAsk: t.mayAsk }), true;
    }
    if (p === '/account/workspace/tokens/revoke' && m === 'POST') {
      const t = myWs.tokens?.[String(b?.id || '')];
      if (!t) return ctx.json(res, 404, { error: 'No such token.' }), true;
      delete myWs.tokens[t.id]; delete store.usernames[t.username.toLowerCase()]; save(store);
      console.log(`[accounts] ${me.username} revoked agent token ${t.id} (${t.username})`); ctx.audit(sess, { action: 'token-revoke', username: t.username, tokenId: t.id }, true);   // T-0057
      return ctx.json(res, 200, { ok: true }), true;
    }
    if (p === '/account/workspace/remove' && m === 'POST') {    // the member gets a fresh, empty workspace of their own and is logged out
      const target = Object.values(store.accounts).find(a => a.username.toLowerCase() === String(b?.username || '').toLowerCase() && a.workspace === myWs.id);
      if (!target) return ctx.json(res, 404, { error: 'No such member in your workspace.' }), true;
      if (target.email === me.email) return ctx.json(res, 400, { error: 'You cannot remove yourself.' }), true;
      if (target.email === myWs.owner) return ctx.json(res, 400, { error: 'The owner cannot be removed. Transfer ownership first.' }), true;          // T-0034
      if (!amOwner && target.wsRole === 'admin') return ctx.json(res, 403, { error: 'Only the owner can remove an admin.' }), true;                // T-0034
      target.wsRole = 'member'; createWorkspace(store, target); save(store);
      endSessions(ctx, target.email);
      console.log(`[accounts] ${me.username} removed ${target.username} from ${myWs.id}`); ctx.audit(sess, { action: 'member-remove', username: target.username }, true);   // T-0057
      return ctx.json(res, 200, { ok: true }), true;
    }
  }

  // Billing API (needs a signed-in account)
  if (p.startsWith('/billing/') && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    if (SELF_HOSTED) return ctx.json(res, 400, { error: 'This Chamber is self-hosted: there is no subscription to manage.' }), true;   // T-0061
    try {
      if (p === '/billing/checkout') {
        if (entitled(me, store) && !onTrialClock(me)) return ctx.json(res, 200, { url: '/app' }), true;   // T-0159: someone on (or past) the free trial may subscribe
        if (!amOwner) return ctx.json(res, 400, { error: `Your workspace is paid for by its owner (${store.accounts[myWs?.owner]?.username || 'the owner'}).` }), true;
        if (!verified(me)) return ctx.json(res, 403, { error: 'Confirm your email address first (check your inbox for the link, or resend it below).', needsVerification: true }), true;   // T-0032
        if (!me.stripeCustomer) {
          const c = await stripe('POST', 'customers', { email: me.email, metadata: { chamber_username: me.username, chamber_workspace: me.workspace } });
          me.stripeCustomer = c.id;
          const fresh = load(); if (fresh.accounts[me.email]) { fresh.accounts[me.email].stripeCustomer = c.id; save(fresh); }   // re-read: the call above waited on Stripe
        }
        const cs = await stripe('POST', 'checkout/sessions', {
          mode: 'subscription', customer: me.stripeCustomer, client_reference_id: me.email,
          line_items: { 0: { price: PRICE, quantity: 1 } },
          success_url: `${PUBLIC_URL}/billing?done=1`, cancel_url: `${PUBLIC_URL}/billing`,
          allow_promotion_codes: 'true',
        });
        return ctx.json(res, 200, { url: cs.url }), true;
      }
      if (p === '/billing/portal') {
        if (!me.stripeCustomer) return ctx.json(res, 400, { error: 'No subscription yet.' }), true;
        const ps = await stripe('POST', 'billing_portal/sessions', { customer: me.stripeCustomer, return_url: `${PUBLIC_URL}/billing` });
        return ctx.json(res, 200, { url: ps.url }), true;
      }
      if (p === '/billing/storage') {                                            // storage add-on: set how many packs the workspace has
        if (!STORAGE_ON()) return ctx.json(res, 404, { error: 'Extra storage is not offered on this Chamber.' }), true;
        if (!amOwner) return ctx.json(res, 400, { error: 'Only the workspace owner can change storage: it is paid for with their card.' }), true;
        const b = await ctx.parseBody(req).catch(() => ({})), want = b?.packs, have = me.storagePacks || 0;
        if (!Number.isInteger(want) || want < 0 || want > STORAGE_MAX_PACKS) return ctx.json(res, 400, { error: `Choose between 0 and ${STORAGE_MAX_PACKS} packs.` }), true;
        if (me.subStatus !== 'active' || !me.subscription) return ctx.json(res, 400, { error: 'Extra storage needs an active subscription. Subscribe first.' }), true;
        if (me.cancelAtPeriodEnd) return ctx.json(res, 400, { error: 'Your subscription is set to cancel. Keep it (Manage billing) before changing storage.' }), true;
        if (want === have) return ctx.json(res, 200, publicView(me, store)), true;
        if (want > have) { const g = reauth(me, b?.password); if (g !== 'ok') return reauthFail(ctx, res, g, 'Password is wrong. Nothing was charged.'), true; }   // a charge to the card on file needs the password again, not only a signed-in browser
        if (want > have) {                                                         // never sell space the disk does not have
          const sold = Object.values(store.accounts).reduce((n, a) => n + (a.subscription && a.email !== me.email ? (a.storagePacks || 0) : 0), 0);
          if ((sold + want) * STORAGE_PACK_GB > STORAGE_SELLABLE_GB) return ctx.json(res, 409, { error: 'We cannot add that much storage right now. Write to us through the contact form and we will make room. Nothing was charged.' }), true;
        }
        try {                                                                      // an increase is charged now; if the card fails Stripe changes nothing
          const sub = await stripe('GET', `subscriptions/${me.subscription}`);
          const item = (sub.items?.data || []).find(i => i.price?.id === STORAGE_PRICE);
          const charge = { proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' };
          if (want === 0) { if (item) await stripe('DELETE', `subscription_items/${item.id}`, { proration_behavior: 'create_prorations' }); }
          else if (item) await stripe('POST', `subscription_items/${item.id}`, { quantity: want, ...(want > (item.quantity || 0) ? charge : { proration_behavior: 'create_prorations' }) });
          else await stripe('POST', 'subscription_items', { subscription: me.subscription, price: STORAGE_PRICE, quantity: want, ...charge });
        } catch (e) {
          if (/^Stripe/.test(e.message) || e.code) throw e;                        // network trouble: the generic answer below
          console.error('[accounts] storage:', e.message);
          return ctx.json(res, 402, { error: `Nothing was changed and your card was not charged. The payment service said: ${String(e.message).slice(0, 200)}` }), true;
        }
        const after = await stripe('GET', `subscriptions/${me.subscription}`);
        const fresh = load(), cur = fresh.accounts[me.email];                      // re-read: the calls above waited on Stripe
        if (!cur) return ctx.json(res, 401, { error: 'not signed in' }), true;
        applySubscription(cur, after); save(fresh);
        console.log(`[accounts] storage packs ${have} -> ${cur.storagePacks}: ${cur.username}`); ctx.audit(sess, { action: 'storage-packs', from: have, to: cur.storagePacks }, true);
        { const now = cur.storagePacks || 0, up = now > have;                         // tell the owner by email every time: it is their card, and it is how they notice a change they did not make
          const letter = { to: cur.email, subject: 'Chamber: your extra storage was changed', text: `Hello ${cur.username},\n\nThe extra file storage of your Chamber workspace was changed from ${have * STORAGE_PACK_GB} GB to ${now * STORAGE_PACK_GB} GB.\n\n`
            + (up ? `Your card on file was charged for the rest of your current subscription year. From your next renewal it costs ${STORAGE_LABEL} for each ${STORAGE_PACK_GB} GB pack, together with your subscription.` : 'The unused part of what you paid is taken off your next bill. No files were deleted.')
            + `\n\nYou can change it again at any time: ${PUBLIC_URL}/billing\n\nIf you did not do this, change your password now and write to ${CONTACT_TO}.\n` };
          if (TEST_HOOKS) console.log(`[accounts] storage mail to ${letter.to}: ${have * STORAGE_PACK_GB} GB -> ${now * STORAGE_PACK_GB} GB`);
          if (mail.enabled) mail.send(letter).catch(e => console.error('[accounts] storage mail failed:', e.message)); }
        return ctx.json(res, 200, publicView(cur, fresh)), true;
      }
      if (p === '/billing/refresh') {
        const best = await bestSubscription(me.stripeCustomer);
        const fresh = load(), cur = fresh.accounts[me.email];                      // re-read: the call above waited on Stripe
        if (!cur) return ctx.json(res, 401, { error: 'not signed in' }), true;
        if (best) { applySubscription(cur, best); save(fresh); }
        return ctx.json(res, 200, publicView(cur, fresh)), true;
      }
    } catch (e) {
      console.error('[accounts] billing:', e.message);
      return ctx.json(res, 502, { error: 'Payment service error. Try again in a minute.' }), true;
    }
  }
  return false;
}

// Refuse to run half-configured: a paywall with no Stripe keys would lock everyone out or let everyone in.
function check() {
  if (!ENABLED) return;
  const missing = (SELF_HOSTED ? [['CHAMBER_PUBLIC_URL', PUBLIC_URL]] : [['CHAMBER_STRIPE_SECRET', STRIPE_KEY], ['CHAMBER_STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET],
                   ['CHAMBER_STRIPE_PRICE', PRICE], ['CHAMBER_PUBLIC_URL', PUBLIC_URL]]).filter(([, v]) => !v).map(([k]) => k);   // T-0061
  if (missing.length) { console.error('REFUSING TO START: CHAMBER_ACCOUNTS=1 but missing ' + missing.join(', ')); process.exit(1); }
  if (!fs.existsSync(LANDING)) { console.error('REFUSING TO START: public/landing.html is missing'); process.exit(1); }
}

// ── CLI (used by chamber-admin): node accounts.js add-admin <email> <username> | set-password <email> | promote <email> | list | remove <email>
//    The password comes in env var P so it never appears in `ps` or shell history.
if (require.main === module) {
  const [cmd, email, username] = process.argv.slice(2);
  const store = load(); const id = (email || '').toLowerCase();
  if (cmd === 'add-admin' || cmd === 'set-password') {
    const pw = process.env.P || '';
    if (pw.length < MIN_PASSWORD) { console.error(`password must be at least ${MIN_PASSWORD} characters`); process.exit(1); }
    let acct = store.accounts[id];
    if (cmd === 'add-admin') {
      if (!EMAIL_RE.test(id) || !USER_RE.test(username || '')) { console.error('usage: add-admin <email> <username>'); process.exit(1); }
      if (!acct) {
        if (store.usernames[username.toLowerCase()]) { console.error('that username is taken'); process.exit(1); }
        acct = { email: id, username, role: 'admin', chatRole: 'human', createdAt: Date.now() };
        store.accounts[id] = acct; store.usernames[username.toLowerCase()] = id; createWorkspace(store, acct);
      }
      acct.role = 'admin';
    } else if (!acct) { console.error('no such account'); process.exit(1); }
    acct.salt = crypto.randomBytes(16).toString('hex'); acct.hash = hash(pw, acct.salt); save(store);
    console.log(`${cmd === 'add-admin' ? 'admin account ready' : 'password updated'}: ${acct.username} <${acct.email}>`);
  } else if (cmd === 'promote') {
    const a = store.accounts[id]; if (!a) { console.error('no such account'); process.exit(1); }
    a.role = 'admin'; save(store); console.log(`now admin (no subscription needed): ${a.username}`);
  } else if (cmd === 'list') {
    for (const a of Object.values(store.accounts)) {
      const ws = store.workspaces[a.workspace] || {};
      console.log(`${a.username.padEnd(24)} ${a.email.padEnd(34)} ${a.role.padEnd(7)} ${(entitled(a, store) ? 'ACCESS' : 'no access').padEnd(10)} ${(a.subStatus || '-').padEnd(9)} ws=${ws.name || '?'} (${a.wsRole || 'member'})`);
    }
    console.log(`${Object.keys(store.accounts).length} account(s), ${Object.keys(store.workspaces).length} workspace(s)`);
  } else if (cmd === 'transfer') {                                 // T-0024: transfer <from-email> <to-email>; both must share the workspace
    const from = store.accounts[id], to = store.accounts[(username || '').toLowerCase()];
    if (!from || !to) { console.error('usage: transfer <from-email> <to-email> (both existing accounts)'); process.exit(1); }
    const ws = store.workspaces[from.workspace];
    if (!ws || ws.owner !== from.email) { console.error(`${from.username} does not own a workspace`); process.exit(1); }
    if (to.workspace !== ws.id) { console.error(`${to.username} is not a member of ${ws.name}`); process.exit(1); }
    ws.owner = to.email; to.wsRole = 'owner'; from.wsRole = 'member'; save(store);
    console.log(`${ws.name}: owner is now ${to.username} (${from.username} stays as a member). Agent tokens, invite link and history are unchanged.`);
  } else if (cmd === '2fa-off') {                                   // T-0052: rescue after an out-of-band identity check
    const a = store.accounts[id]; if (!a) { console.error('no such account'); process.exit(1); }
    if (!a.totp) { console.log(`${a.username} does not have two-factor on; nothing changed`); process.exit(0); }
    delete a.totp; delete a.totpRecovery; delete a.mfaDevices; delete a.totpPending; save(store);
    console.log(`two-factor removed for ${a.username} <${a.email}>; they can sign in with the password alone and set it up again on the account page`);
  } else if (cmd === 'remove') {
    const a = store.accounts[id]; if (!a) { console.error('no such account'); process.exit(1); }
    const owned = Object.values(store.workspaces).find(w => w.owner === id && members(store, w.id).length > 1);
    if (owned) { console.error(`${a.username} owns '${owned.name}' which still has members. Run: transfer ${id} <new-owner-email> first.`); process.exit(1); }
    delete store.usernames[a.username.toLowerCase()]; delete store.accounts[id];
    for (const [wid, w] of Object.entries(store.workspaces)) if (w.owner === id && members(store, wid).length === 0) delete store.workspaces[wid];
    save(store); console.log('removed ' + a.username);
  } else { console.error('usage: accounts.js add-admin <email> <username> | set-password <email> | promote <email> | list | transfer <from-email> <to-email> | 2fa-off <email> | remove <email>'); process.exit(1); }
}

function okTz(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }   // T-0078
// T-0013/T-0078: notify a workspace's accounts on their phones about a message. Content-free, as before. Each account
// is routed by its own per-room level and quiet hours (notify.js): a muted room drops a plain message but a DM always
// gets through; a push inside quiet hours is HELD (counted) and delivered as one summary by flushQuietHeld() when the
// window ends. Dead subscriptions are dropped. msg = { room, mentions:[usernames], dm:[usernames] }.
function pushTo(wsId, msg, from) {
  if (!ENABLED || !wsId || !msg || !msg.room) return;
  const store = load();
  const ment = new Set((msg.mentions || []).map(u => String(u).toLowerCase()));
  const dm = new Set((msg.dm || []).map(u => String(u).toLowerCase()));
  const now = new Date(); let changed = false; const toSend = [];
  for (const a of Object.values(store.accounts)) {
    if (a.workspace !== wsId || a.username === from || !(a.push || []).length) continue;
    const uname = a.username.toLowerCase();
    const d = notify.decide(a, { room: msg.room, isDmRecipient: dm.has(uname), mentioned: ment.has(uname) }, now);
    if (d === 'skip') continue;
    if (d === 'hold') { a.pushHeld = (a.pushHeld || 0) + 1; a.pushHeldAt = now.getTime(); changed = true; continue; }
    toSend.push(a);
  }
  if (changed) save(store);
  if (!toSend.length) return;
  let dirty = false;
  Promise.all(toSend.flatMap(a => a.push.map(async s => { const r = await push.send(s); if (r === 'gone') { a.push = a.push.filter(x => x !== s); dirty = true; } })))
    .then(() => { if (!dirty) return; const fresh = load(); for (const a of toSend) if (fresh.accounts[a.email]) fresh.accounts[a.email].push = a.push; save(fresh); }).catch(() => {});
}
// T-0078: the per-minute schedule tick calls this to deliver one summary push to each account whose quiet window has ended.
function flushQuietHeld(now = new Date()) {
  if (!ENABLED) return [];
  const store = load(); const flushed = []; let changed = false; const toSend = [];
  for (const a of Object.values(store.accounts)) {
    if (!(a.pushHeld > 0) || notify.inQuietHours(a.quiet, now)) continue;   // nothing held, or still quiet -> keep holding
    toSend.push(a); flushed.push({ email: a.email, held: a.pushHeld });
    a.pushHeld = 0; a.pushHeldAt = null; changed = true;
  }
  if (changed) save(store);
  for (const a of toSend) if ((a.push || []).length) Promise.all(a.push.map(s => push.send(s).catch(() => {}))).catch(() => {});
  return flushed;
}
// T-0175 / T-0176. Returns what it did so the log line and the tests can see it. `now` is injectable for tests.
//  - reminders go only to confirmed, never-subscribed trial owners, each kind once (marked before sending, so a mail failure
//    never turns into a repeat), and the "ended" mail only within 3 days of the end (no surprise mail about an old trial);
//  - cleanup touches only accounts marked unconfirmedSince at sign-up (so nothing that was ever confirmed, and no account from
//    before this existed), that own their workspace alone, with no agents and no Stripe customer. An unconfirmed account has
//    never had access, so the workspace holds nothing. The one-trial-per-email record is dropped too: they never used a day.
function trialHousekeeping(ctx, now = Date.now()) {
  const out = { reminded: [], removed: [] };
  if (!ENABLED || SELF_HOSTED) return out;
  const store = load(); const sends = [];
  const day = t => new Date(t).toUTCString().slice(0, 16);
  for (const a of Object.values(store.accounts)) {
    if (!onTrialClock(a)) continue;
    const ws = store.workspaces[a.workspace];
    if (a.emailVerified === false) {
      if (a.unconfirmedSince && now - a.unconfirmedSince > UNCONFIRMED_MS && !a.stripeCustomer && a.role !== 'admin' && ws && ws.owner === a.email
          && /^[a-f0-9]{8,64}$/.test(ws.id) && members(store, ws.id).length === 1 && !Object.keys(ws.tokens || {}).length) {
        delete store.workspaces[ws.id]; fs.rmSync(path.join(DATA_DIR, 'ws', ws.id), { recursive: true, force: true });
        delete store.usernames[a.username.toLowerCase()]; delete store.accounts[a.email];
        if (store.trials) delete store.trials[sha('trial:' + a.email)];
        for (const [k, v] of Object.entries(store.verifications || {})) if (v.email === a.email) delete store.verifications[k];
        if (ctx) endSessions(ctx, a.email);
        out.removed.push(a.username); console.log(`[accounts] removed unconfirmed sign-up ${a.username} (email not confirmed in ${Math.round(UNCONFIRMED_MS / 86400e3)} days)`);
      }
      continue;
    }
    if (!mail.enabled && !TEST_HOOKS) continue;
    const left = a.trialEndsAt - now, sent = a.trialMail || {};
    const kind = left <= 0 ? (left > -TRIAL_SOON_MS && !sent.over ? 'over' : null)
               : (left <= TRIAL_SOON_MS && !sent.soon && a.trialEndsAt - (a.createdAt || 0) > TRIAL_SOON_MS ? 'soon' : null);
    if (!kind) continue;
    a.trialMail = { ...sent, [kind]: now }; out.reminded.push({ username: a.username, kind });
    const keep = `Nothing is deleted. Your workspace ${kind === 'over' ? 'is now' : 'then becomes'} read-only: you can still open it and read everything, but you and your AI agents cannot post or change anything until you subscribe.`;
    sends.push({ to: a.email, subject: kind === 'over' ? 'Chamber: your free trial has ended' : `Chamber: your free trial ends on ${day(a.trialEndsAt)}`,
      text: `Hi ${a.username},\n\n${kind === 'over' ? 'Your Chamber free trial has ended.' : `Your Chamber free trial ends on ${day(a.trialEndsAt)}.`}\n\n${keep}\n\nTo keep going, subscribe (${PRICE_LABEL}, refundable for 14 days):\n\n${PUBLIC_URL}/billing\n\nIf Chamber was not for you, you do not need to do anything, and nothing will be charged. Questions? Reply to this email.\n` });
  }
  if (out.reminded.length || out.removed.length) save(store);
  for (const s of sends) { if (TEST_HOOKS) console.log(`[accounts] trial mail to ${s.to}: ${s.subject}`);
    if (mail.enabled) mail.send(s).then(() => console.log(`[accounts] trial mail sent: ${s.subject}`), e => console.error('[accounts] trial mail failed:', e.message)); }
  return out;
}
function dueSchedules(now, isDue) {                                // T-0058: schedules due this minute, marked so they fire once
  if (!ENABLED) return [];
  const store = load(); const out = []; let changed = false;
  const minute = Math.floor(now.getTime() / 60000);
  for (const ws of Object.values(store.workspaces)) for (const s of ws.schedules || []) {
    if (!s.enabled || s.lastMinute === minute) continue;
    if (isDue(s.spec, now, s.tz)) { s.lastMinute = minute; s.lastRun = now.getTime(); s.runs = (s.runs || 0) + 1; if (s.once) s.enabled = false; changed = true; out.push({ ws: ws.id, schedule: s }); }   // T-0069: one-shot
  }
  if (changed) save(store);
  return out;
}
function hookByToken(token) {                                      // T-0058: chh_<id>_<secret> -> { ws, hook } or null
  const m = /^chh_([a-f0-9]{8})_([A-Za-z0-9_-]{32,})$/.exec(token || ''); if (!m) return null;
  const store = load();
  for (const ws of Object.values(store.workspaces)) { const h = (ws.hooks || []).find(x => x.id === m[1]); if (h) return same(h.hash, sha(m[2])) ? { ws: ws.id, hook: h } : null; }
  return null;
}
function hookHit(wsId, id) { const store = load(); const h = ((store.workspaces[wsId] || {}).hooks || []).find(x => x.id === id); if (h) { h.hits = (h.hits || 0) + 1; h.lastHit = Date.now(); if (h.hits % 10 === 1 || Date.now() - (h.savedAt || 0) > 300e3) { h.savedAt = Date.now(); save(store); } } }
// T-0181 (security): may this session run commands on the Chamber server itself? On the hosted service only a site operator:
// an account whose role is 'admin', which only the server-side CLI (accounts.js add-admin / promote) can set, and who owns
// their workspace. Being the owner of a workspace is NOT enough: every sign-up owns one. Self-hosted: the owner, as before.
function serverConsoleAllowed(sess) {
  if (!ENABLED) return true;
  if (!sess || sess.agent || !sess.email) return false;
  const store = load(); const a = store.accounts[sess.email]; const ws = a && store.workspaces[a.workspace];
  if (!a || !ws || ws.owner !== a.email) return false;
  return SELF_HOSTED || a.role === 'admin';
}
function sessionRole(sess) {                                       // T-0059: 'agent' | 'owner' | 'admin' | 'member' | null
  if (!ENABLED || !sess) return null;
  if (sess.agent) return 'agent';
  const store = load(); const a = sess.email ? store.accounts[sess.email] : null; if (!a) return null;
  const ws = store.workspaces[a.workspace]; if (!ws) return null;
  return wsRoleOf(a, ws);                                          // T-0199: + viewer | requester
}
function mirrorsFor(wsId, room) {                                   // T-0062: enabled mirrors of one room
  if (!ENABLED || !wsId) return [];
  return (((load().workspaces[wsId] || {}).mirrors) || []).filter(x => x.enabled && x.room === room);
}
function mirrorResult(wsId, id, ok, err) {
  const store = load(); const x = (((store.workspaces[wsId] || {}).mirrors) || []).find(m => m.id === id); if (!x) return;
  if (ok) { x.sent = (x.sent || 0) + 1; x.lastSent = Date.now(); x.fails = 0; x.lastError = null; } else { x.fails = (x.fails || 0) + 1; x.lastError = String(err || 'error').slice(0, 120); if (x.fails >= 20) { x.enabled = false; x.lastError += ' (paused after 20 failures)'; } }
  save(store);
}
function retentionSettings() {                                    // T-0037: [{ id, days }] for workspaces that asked for retention
  if (!ENABLED) return [];
  return Object.values(load().workspaces).filter(w => w.retentionDays > 0).map(w => ({ id: w.id, days: w.retentionDays }));
}
function fleetLinkOf(wsId) { return (load().workspaces[wsId] || {}).fleet || null; }                       // T-0153: the stored link record (sealed key + status), or null
function fleetMark(wsId, patch) { const store = load(); const f = (store.workspaces[wsId] || {}).fleet; if (!f) return; Object.assign(f, patch); save(store); }
const fleetDir = () => path.dirname(FILE);                                                                  // where fleet-link.key lives (beside accounts.json)
module.exports = { enabled: ENABLED, standingRules, draftsOn, requestMailFor, setRequestMail, workspaceName, budgetOf, budgetWorkspaces, reportByToken, reportWorkspaces, approvalCheck, canApprove, reminderWorkspaces, remindTargets, storageExtraMbFor, storageOffered: STORAGE_ON, serverConsoleAllowed, trialHousekeeping, fleetLinkOf, fleetMark, fleetDir, handle, check, sessionEntitled, sessionReadOnly, billingFor, workspaceOf, entitled, tokenSession, commandersFor, pushTo, flushQuietHeld, retentionSettings, dueSchedules, hookByToken, hookHit, sessionRole, mirrorsFor, mirrorResult, selfHosted: SELF_HOSTED };
