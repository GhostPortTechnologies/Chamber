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
const records = require('./records');
const perm = require('./permissions');                            // T-0246: who may do what, in one table
const wslock = require('./wslock'), wscrypt = require('./wscrypt'), wsfiles = require('./wsfiles');           // T-0222: the owner lock
const LOCK_FEATURE = process.env.CHAMBER_OWNER_LOCK !== '0';                 // T-0222: offered to every owner; CHAMBER_OWNER_LOCK=0 takes the option away on a server                             // T-0219: sealed copies of the activity record, and its keep-for limits
const fleet = require('./fleet');                                             // T-0153: GhostPort fleet link (router status, read-only)
const { execFile, execFileSync } = require('child_process');      // T-0010: /source archive via git; T-0036: changelog
const tasksMod = require('./tasks');                              // T-0224: the task list in export and import
const cron = require('./cron');                                   // T-0058: schedules
let changelogCache = { at: 0, html: '' };                           // T-0036
const mail = require('./mail');                                   // T-0008: password-reset email (optional)
const push = require('./push');
const netguard = require('./netguard');                           // T-0235: mirrors never reach private addresses                                   // T-0013: push notifications
const notify = require('./notify');                               // T-0078: per-room level + quiet hours routing

const ENABLED = process.env.CHAMBER_ACCOUNTS === '1';
const STRIPE_KEY = process.env.CHAMBER_STRIPE_SECRET || '';
const WEBHOOK_SECRET = process.env.CHAMBER_STRIPE_WEBHOOK_SECRET || '';
const PRICE = process.env.CHAMBER_STRIPE_PRICE || '';
// T-0295 (approved 19 Nov 2026): two paid sizes with the same features. PRICE is Team; PRICE_COMPANY is Company. A workspace
// pays for its BUILDERS (owner, admins, members). Approvers, viewers and requesters use no seat and have no limit on a paid plan.
const PRICE_COMPANY = process.env.CHAMBER_STRIPE_PRICE_COMPANY || '';
// T-0314 (approved 20 Nov 2026): included file storage matches the prices: Team 10 GB, Company 50 GB (were 500 MB and 5 GB).
// CHAMBER_FILES_QUOTA_MB, when set, still sets Team's (the tests use a tiny one); a self-hosted Chamber keeps it as its quota.
const PLANS = { team: { builders: Math.max(1, parseInt(process.env.CHAMBER_TEAM_BUILDERS, 10) || 5), baseMb: parseInt(process.env.CHAMBER_TEAM_STORAGE_MB, 10) || parseInt(process.env.CHAMBER_FILES_QUOTA_MB, 10) || 10240 },
                company: { builders: Math.max(1, parseInt(process.env.CHAMBER_COMPANY_BUILDERS, 10) || 25), baseMb: parseInt(process.env.CHAMBER_COMPANY_STORAGE_MB, 10) || 51200 } };
const companyMb = () => Math.max(PLANS.company.baseMb, PLANS.team.baseMb);   // Company never has less than Team
// T-0310 (approved 20 Nov 2026): every plan is paid monthly or yearly, and a year costs 10 months (2 months free):
//   Team $50 a month or $500 a year; Company $150 a month or $1,500 a year; extra storage $5 a month or $50 a year per pack.
// Each has its own Stripe price: CHAMBER_STRIPE_TEAM_MONTH, _TEAM_YEAR, _COMPANY_MONTH, _COMPANY_YEAR, _STORAGE_MONTH and
// _STORAGE_YEAR (Stripe keeps every line of one subscription on the same period, so a monthly plan gets monthly storage).
// The older yearly prices are not sold to anyone new, but a subscription on them is still recognised. CHAMBER_STRIPE_PRICE ($49 a
// year) is still sold for Team yearly to a workspace created before PRICING2_AT: the 19 Nov notice email promised the earlier
// workspace "Team ... at $49 a year". CHAMBER_STRIPE_PRICE_COMPANY ($199) and CHAMBER_STRIPE_STORAGE_PRICE ($49.99) are retired.
const PRICES = { team: { month: process.env.CHAMBER_STRIPE_TEAM_MONTH || '', year: process.env.CHAMBER_STRIPE_TEAM_YEAR || '' },
                 company: { month: process.env.CHAMBER_STRIPE_COMPANY_MONTH || '', year: process.env.CHAMBER_STRIPE_COMPANY_YEAR || '' } };
const LABELS = { team: { month: '$50 / month', year: '$500 / year' }, company: { month: '$150 / month', year: '$1,500 / year' } };
const LEGACY_TEAM = { price: PRICE, label: '$49 / year' };                // the kept deal; PRICE may be empty on a new install
const RETIRED = PRICE_COMPANY ? { [PRICE_COMPANY]: { plan: 'company', interval: 'year', label: '$199 / year' } } : {};
const RENEW_NOTE_MS = 14 * 86400e3;                                      // yearly plans: the renewal email goes this long before
// Workspaces that existed before the new plans keep what they signed up for: Team covers up to 25 builders for them, and their
// free plan changes only 30 days after we emailed the owner (the Terms promise that notice). CHAMBER_PRICING2_AT = the release day.
const PRICING2_AT = Date.parse(process.env.CHAMBER_PRICING2_AT || '2026-11-19T00:00:00Z') || 0, NOTICE_MS = 30 * 86400e3, FOUNDING_MAX = 100;
const PUBLIC_URL = (process.env.CHAMBER_PUBLIC_URL || '').replace(/\/$/, '');
const SELF_HOSTED = process.env.CHAMBER_SELF_HOSTED === '1';                // T-0061: workspaces without Stripe; everyone entitled
// Storage add-on (2026-11-13). One "pack" is CHAMBER_STORAGE_PACK_GB (10) more file space for the whole workspace, billed as a
// second line on the owner's subscription (quantity = packs), on the plan's own period (T-0310: $5 a month or $50 a year).
// Nothing is offered and nothing can be charged until CHAMBER_STRIPE_STORAGE_MONTH or _YEAR is set; a period without its price
// offers no storage. CHAMBER_STORAGE_SELLABLE_GB caps the total sold across all workspaces to what the disk really has.
const STORAGE_PRICES = { month: process.env.CHAMBER_STRIPE_STORAGE_MONTH || '', year: process.env.CHAMBER_STRIPE_STORAGE_YEAR || '' };
const STORAGE_LABELS = { month: '$5 / month', year: '$50 / year' };
const STORAGE_OLD = process.env.CHAMBER_STRIPE_STORAGE_PRICE || '';      // $49.99 a year (13 Nov): not sold any more; packs on it still count
const isStoragePrice = id => !!id && [STORAGE_PRICES.month, STORAGE_PRICES.year, STORAGE_OLD].includes(id);
const STORAGE_PACK_GB = Math.max(1, parseInt(process.env.CHAMBER_STORAGE_PACK_GB, 10) || 10), STORAGE_MAX_PACKS = Math.max(1, parseInt(process.env.CHAMBER_STORAGE_MAX_PACKS, 10) || 10);
const STORAGE_SELLABLE_GB = Math.max(0, parseInt(process.env.CHAMBER_STORAGE_SELLABLE_GB, 10) || 20), STORAGE_BASE_MB = parseInt(process.env.CHAMBER_FILES_QUOTA_MB, 10) || 500;
const STORAGE_ON = () => !SELF_HOSTED && !!(STORAGE_PRICES.month || STORAGE_PRICES.year);
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
// T-0225: the free plan (decided on T-0196, 15 Nov 2026). Free for one person, the owner, with no time limit and up to
// FREE_TOKENS agents, but without inviting anyone and without cloud storage (no files). A workspace is on it when its owner has no
// subscription: after the free trial, after a cancelled subscription has run out, or having never subscribed (a confirmed email is
// needed, as for the trial). People already in such a workspace keep read access and export but cannot post; nothing is deleted.
// A failed payment still goes grace, then read-only, as before. CHAMBER_FREE_PLAN=0 brings back the old behaviour (read-only).
const FREE_ON = () => !SELF_HOSTED && process.env.CHAMBER_FREE_PLAN !== '0';
const FREE_TOKENS = TRIAL_TOKENS;
// T-0288 (approved by the owner 19 Nov 2026): the free plan covers up to FREE_PEOPLE people (3), not the owner alone, with
// FREE_TOKENS agents for each of them. Who has a seat: the owner, then whoever joined first. Anyone beyond that keeps read
// access and export, exactly as the others did before. Still no cloud storage. CHAMBER_FREE_PEOPLE=1 is the old one-person plan.
const FREE_PEOPLE = Math.max(1, Math.min(25, parseInt(process.env.CHAMBER_FREE_PEOPLE, 10) || 3));
const freePeopleText = () => FREE_PEOPLE === 1 ? 'one person' : `up to ${FREE_PEOPLE} people`;
const legacyWs = ws => !!ws && (ws.createdAt || 0) < PRICING2_AT;              // T-0295: existed before the new plans
const freePeopleFor = ws => legacyWs(ws) && !(ws.freeNoticeAt && Date.now() >= ws.freeNoticeAt + NOTICE_MS) ? 1 : FREE_PEOPLE;   // the Terms: 30 days after the email
function freeSeats(store, wsId) {
  const ws = store.workspaces[wsId]; if (!ws) return [];
  return members(store, wsId).sort((a, b) => (b.email === ws.owner) - (a.email === ws.owner) || (a.createdAt || 0) - (b.createdAt || 0) || String(a.email).localeCompare(String(b.email))).slice(0, freePeopleFor(ws));
}
const hasFreeSeat = (acct, store) => freeSeats(store, acct.workspace).some(a => a.email === acct.email);
const freeTokenLimit = (store, ws) => FREE_TOKENS * Math.min(freePeopleFor(ws), Math.max(1, members(store, ws.id).length));
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
const MAX_GUESTS = parseInt(process.env.CHAMBER_MAX_GUESTS, 10) || 25, GUEST_ROLES = ['viewer', 'requester'], INVITE_KINDS = ['viewer', 'requester', 'approver'];   // T-0295: an approver is a viewer who may approve by default   // T-0033: seats per workspace (owner included)
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
  { const st = billingState(store.accounts[ws.owner]), lim = st === 'free' ? freeTokenLimit(store, ws) : TRIAL_TOKENS;        // T-0159; T-0225 the free plan too; T-0288: 2 for each person on it
    if (['trial', 'free'].includes(st) && Object.keys(ws.tokens || {}).length >= lim) return { error: `The free ${st === 'free' ? 'plan' : 'trial'} includes ${lim} agents${st === 'free' && FREE_PEOPLE > 1 ? ` (${FREE_TOKENS} for each person, ${freePeopleText()})` : ''}. Subscribe on the Account page to add more.`, code: 403 }; }
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
const PRICE_LABEL = 'Team $50 / month or $500 / year';   // T-0310: the words in the trial emails

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
const LOCK_IDLE_CHOICES = [0, 5, 15, 30, 60];                           // T-0241: idle lock minutes (0 = never)
const screenLockPrefs = a => ({ lockIdle: LOCK_IDLE_CHOICES.includes(a?.screenLock?.idle) ? a.screenLock.idle : 0, lockReopen: !!a?.screenLock?.reopen });
const SESSION_DAY_CHOICES = [1, 7, 30];                                // T-0241 part 2: how long a sign-in lasts (days)
const sessionPolicyOf = a => ({ days: SESSION_DAY_CHOICES.includes(a?.sessionPolicy?.days) ? a.sessionPolicy.days : 7, remember: a?.sessionPolicy?.remember !== false });
// T-0241 part 3: the owner's rules for everyone in the workspace (myWs.security). What applies to a person is the stricter of their
// own choice and the rule: the shorter idle lock, lock-on-return if either says so, the shorter sign-in.
const RECHECK_CHOICES = [0, 5, 15, 60];                                 // T-0241 part 4: ask for the password again after N minutes (0 = never)
const recheckPrefOf = a => RECHECK_CHOICES.includes(a?.recheck?.min) ? a.recheck.min : 0;
const wsSecurity = ws => { const s = (ws && ws.security) || {}; return { idleMax: LOCK_IDLE_CHOICES.includes(s.idleMax) && s.idleMax > 0 ? s.idleMax : 0, reopen: s.reopen === true, daysMax: SESSION_DAY_CHOICES.includes(s.daysMax) ? s.daysMax : 0, require2fa: s.require2fa === true, recheckMax: RECHECK_CHOICES.includes(s.recheckMax) && s.recheckMax > 0 ? s.recheckMax : 0 }; };
// T-0241 part 5: passkeys (WebAuthn). A passkey can unlock the screen lock and answer "confirm it is you" instead of the
// password. Chamber asks for user verification (fingerprint, face or device PIN) every time and checks the device did it.
// No library: a small CBOR reader, the public key as a JWK, and node's crypto.verify. Attestation is not asked for or checked:
// what matters is that the same key signs later, with the person verified. Challenges live 5 minutes and are used once.
const PK_MAX = 10, PK_TTL = 5 * 60e3, PK_CHALLENGES = new Map();      // challenge -> { email, kind: 'create' | 'get', exp }
const b64u = b => Buffer.from(b).toString('base64url'), unb64u = s => Buffer.from(String(s || ''), 'base64url');
function pkRp() {                                                // this Chamber's own host name; a loopback test copy uses 'localhost' (an IP address cannot be one)
  let u; try { u = new URL(PUBLIC_URL); } catch { return null; }
  const loop = ['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname);
  return { id: loop ? 'localhost' : u.hostname, origins: loop ? [u.origin, `${u.protocol}//localhost${u.port ? ':' + u.port : ''}`] : [u.origin] };
}
function cborRead(buf, pos = 0) {                                // -> [value, next position]; the CBOR WebAuthn uses: ints, byte and text strings, arrays, maps, true/false/null
  const ib = buf[pos++], mt = ib >> 5, ai = ib & 31; let n = ai;
  if (ai === 24) n = buf[pos++]; else if (ai === 25) { n = buf.readUInt16BE(pos); pos += 2; } else if (ai === 26) { n = buf.readUInt32BE(pos); pos += 4; }
  else if (ai === 27) { n = Number(buf.readBigUInt64BE(pos)); pos += 8; } else if (ai > 27 && mt !== 7) throw new Error('cbor: unsupported length');
  if (mt === 0) return [n, pos]; if (mt === 1) return [-1 - n, pos];
  if (mt === 2) { if (pos + n > buf.length) throw new Error('cbor: short'); return [buf.subarray(pos, pos + n), pos + n]; }
  if (mt === 3) { if (pos + n > buf.length) throw new Error('cbor: short'); return [buf.subarray(pos, pos + n).toString('utf8'), pos + n]; }
  if (mt === 4) { if (n > 64) throw new Error('cbor: too long'); const a = []; for (let i = 0; i < n; i++) { const [v, p2] = cborRead(buf, pos); a.push(v); pos = p2; } return [a, pos]; }
  if (mt === 5) { if (n > 64) throw new Error('cbor: too long'); const m = new Map(); for (let i = 0; i < n; i++) { const [k, p2] = cborRead(buf, pos); const [v, p3] = cborRead(buf, p2); m.set(k, v); pos = p3; } return [m, pos]; }
  if (mt === 7 && ai === 20) return [false, pos]; if (mt === 7 && ai === 21) return [true, pos]; if (mt === 7 && ai === 22) return [null, pos];
  throw new Error('cbor: unsupported type');
}
function coseToJwk(m) {                                          // the new passkey's public key (COSE) -> { alg, jwk }; ES256 and RS256, the two Chamber asks for
  if (!(m instanceof Map)) throw new Error('no public key');
  const kty = m.get(1), alg = m.get(3);
  if (kty === 2 && alg === -7 && m.get(-1) === 1 && Buffer.isBuffer(m.get(-2)) && Buffer.isBuffer(m.get(-3))) return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64u(m.get(-2)), y: b64u(m.get(-3)) } };
  if (kty === 3 && alg === -257 && Buffer.isBuffer(m.get(-1)) && Buffer.isBuffer(m.get(-2))) return { alg, jwk: { kty: 'RSA', n: b64u(m.get(-1)), e: b64u(m.get(-2)) } };
  throw new Error('this kind of key is not supported');
}
function pkClientData(b, kind, email) {                          // type, challenge (once, for this person, in time) and origin; -> the clientDataJSON bytes
  const raw = unb64u(b?.clientDataJSON); let cd; try { cd = JSON.parse(raw.toString('utf8')); } catch { throw new Error('the answer is not readable'); }
  const key = String(cd?.challenge || ''), ch = PK_CHALLENGES.get(key); PK_CHALLENGES.delete(key);
  if (cd.type !== (kind === 'create' ? 'webauthn.create' : 'webauthn.get')) throw new Error('wrong kind of answer');
  if (!ch || ch.kind !== kind || ch.email !== email || ch.exp < Date.now()) throw new Error('this request expired or was already used; try again');
  const rp = pkRp(); if (!rp || !rp.origins.includes(cd.origin)) throw new Error('the answer came from another site');
  return raw;
}
function pkAuthData(ad, withCred) {                              // the site, "the person was verified", the counter; when adding, the new credential too
  const rp = pkRp();
  if (!rp || ad.length < 37 || !ad.subarray(0, 32).equals(crypto.createHash('sha256').update(rp.id).digest())) throw new Error('the passkey belongs to another site');
  const flags = ad[32]; if (!(flags & 0x01) || !(flags & 0x04)) throw new Error('the device did not check that it is you (fingerprint, face or PIN)');
  const counter = ad.readUInt32BE(33); if (!withCred) return { counter };
  if (!(flags & 0x40) || ad.length < 55) throw new Error('no new passkey in the answer');
  const len = ad.readUInt16BE(53); if (!len || len > 1023 || ad.length < 55 + len + 1) throw new Error('no new passkey in the answer');
  const credId = ad.subarray(55, 55 + len), [cose] = cborRead(ad, 55 + len);
  return { counter, credId, ...coseToJwk(cose) };
}
function pkChallenge(email, kind) {
  const now = Date.now(); for (const [k, v] of PK_CHALLENGES) if (v.exp < now) PK_CHALLENGES.delete(k);
  if (PK_CHALLENGES.size > 5000) PK_CHALLENGES.clear();
  const c = b64u(crypto.randomBytes(32)); PK_CHALLENGES.set(c, { email, kind, exp: now + PK_TTL }); return c;
}
function pkVerifyGet(acct, b) {                                  // "it is me", signed by one of the person's passkeys -> that passkey (counter updated), or it throws
  const cdj = pkClientData(b, 'get', acct.email), pk = (acct.passkeys || []).find(k => k.id === String(b?.id || ''));
  if (!pk) throw new Error('that passkey is not one of yours here');
  const ad = unb64u(b?.authenticatorData), { counter } = pkAuthData(ad, false);
  const data = Buffer.concat([ad, crypto.createHash('sha256').update(cdj).digest()]), key = crypto.createPublicKey({ key: pk.jwk, format: 'jwk' });
  if (!crypto.verify('sha256', data, pk.alg === -7 ? { key, dsaEncoding: 'der' } : key, unb64u(b?.signature))) throw new Error('the passkey signature does not match');
  if (pk.counter && counter && counter <= pk.counter) throw new Error('this passkey looks copied (its counter went back); remove it and add it again');
  pk.counter = counter; pk.lastUsed = Date.now(); return pk;
}
const pkLoginOn = a => !!(a && a.passkeyLogin && Array.isArray(a.passkeys) && a.passkeys.length && pkRp());   // T-0241 (a): the passkey is asked for at sign-in
const twoStep = a => !!(a && (a.totp || pkLoginOn(a)));                     // the app's code or the passkey: either is a second step
function passkeyCount(email) { if (!ENABLED || !email) return 0; const a = load().accounts[email]; return a && Array.isArray(a.passkeys) ? a.passkeys.length : 0; }
const effectiveRecheck = (a, ws) => { const own = recheckPrefOf(a), r = wsSecurity(ws); return r.recheckMax && (!own || own > r.recheckMax) ? r.recheckMax : own; };
const effectiveLock = (a, ws) => { const own = screenLockPrefs(a), r = wsSecurity(ws); return { lockIdle: r.idleMax && (!own.lockIdle || own.lockIdle > r.idleMax) ? r.idleMax : own.lockIdle, lockReopen: own.lockReopen || r.reopen }; };
const effectiveSession = (a, ws) => { const own = sessionPolicyOf(a), r = wsSecurity(ws); return { days: r.daysMax ? Math.min(own.days, r.daysMax) : own.days, remember: own.remember }; };
const ruleWords = r => [r.idleMax ? `the screen lock after at most ${r.idleMax} minutes of no activity` : '', r.reopen ? 'the lock when coming back to Chamber' : ''].filter(Boolean).join(' and ');
function needs2fa(sess) {                                         // server.js asks on every request: a person in a workspace that requires 2FA, without it
  if (!ENABLED || !sess || sess.agent || !sess.email) return false;
  const store = load(), a = store.accounts[sess.email];
  return !!a && !twoStep(a) && wsSecurity(store.workspaces[a.workspace]).require2fa;   // T-0241 (a): a passkey at sign-in counts
}
const sessionId = t => crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16);   // the list never shows tokens, only this
function deviceOf(ua) {                                                 // "Chrome on Windows" from a User-Agent, for the signed-in devices list
  ua = String(ua || ''); if (!ua) return 'Unknown device';
  if (/^chamber-cli\//i.test(ua)) return 'Chamber command-line tool';
  if (/^(curl|python|node|undici|go-http|okhttp|wget|axios)/i.test(ua)) return 'Script or API client';
  const b = /Edg\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /OPR\//.test(ua) ? 'Opera' : /Firefox\/|FxiOS/.test(ua) ? 'Firefox' : /Chrome\/|CriOS/.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const o = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Windows/.test(ua) ? 'Windows' : /CrOS/.test(ua) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '';
  return o ? `${b} on ${o}` : b;
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
// T-0295: which plan a workspace is on, and how many builders it covers. 'company' | 'team' | 'trial' | 'free' | 'none' | 'self'.
function planOf(store, ws) {
  if (SELF_HOSTED) return 'self';
  const owner = ws && store.accounts[ws.owner]; if (!owner) return 'none';
  if (owner.role === 'admin') return 'company';                       // the site's own workspace
  const st = billingState(owner);
  if (st === 'trial') return 'trial'; if (st === 'free') return 'free'; if (st === 'none') return 'none';
  return owner.plan === 'company' ? 'company' : 'team';               // ok, grace or readonly: a subscription exists
}
function builderLimit(store, ws) {
  const p = planOf(store, ws);
  if (p === 'self') return MAX_MEMBERS;
  if (p === 'team') return planCap(ws, 'team');
  if (p === 'free' || p === 'none') return freePeopleFor(ws);
  return planCap(ws, 'company');                                      // company, and the trial (full size until the owner picks)
}
// How many builders a plan covers for this workspace. An earlier workspace keeps its deal on Team; CHAMBER_MAX_MEMBERS stays the server's own ceiling.
function planCap(ws, plan) { return Math.min(MAX_MEMBERS, plan === 'company' ? PLANS.company.builders : legacyWs(ws) ? Math.max(PLANS.team.builders, PLANS.company.builders) : PLANS.team.builders); }
const guestsUnlimited = (store, ws) => ['team', 'company', 'trial'].includes(planOf(store, ws));
// T-0310: monthly or yearly. A subscription made before T-0310 is yearly (every older price was).
const periodOf = a => a && a.interval === 'month' ? 'month' : 'year';
const keptDeal = (plan, interval, ws) => plan === 'team' && interval === 'year' && !!LEGACY_TEAM.price && legacyWs(ws);
function priceFor(plan, interval, ws) {                              // the Stripe price this workspace buys; '' = not offered
  return keptDeal(plan, interval, ws) ? LEGACY_TEAM.price : (PRICES[plan]?.[interval] || '');
}
function labelFor(plan, interval, ws) {                              // the words for that price; '' = not offered
  return keptDeal(plan, interval, ws) ? LEGACY_TEAM.label : PRICES[plan]?.[interval] ? LABELS[plan][interval] : '';
}
function priceInfo(id) {                                             // which plan and period a Stripe price is; null = not a plan price
  if (!id) return null;
  for (const plan of ['team', 'company']) for (const interval of ['month', 'year']) if (PRICES[plan][interval] === id) return { plan, interval, label: LABELS[plan][interval] };
  if (id === LEGACY_TEAM.price) return { plan: 'team', interval: 'year', label: LEGACY_TEAM.label, kept: true };
  return RETIRED[id] ? { ...RETIRED[id], retired: true } : null;
}
function priceLabelOf(a, ws) {                                       // what this account pays (or would pay first)
  if (a && a.priceLabel) return a.priceLabel;
  const plan = a && a.plan === 'company' ? 'company' : 'team';
  return (a && a.subscription ? labelFor(plan, periodOf(a), ws) : '') || labelFor(plan, 'month', ws) || labelFor(plan, 'year', ws);
}
const planBaseMb = (store, ws) => SELF_HOSTED ? STORAGE_BASE_MB : planOf(store, ws) === 'company' ? companyMb() : PLANS.team.baseMb;   // T-0314: the plan's own size; self-hosted keeps CHAMBER_FILES_QUOTA_MB
function planBaseMbFor(sess) {   // exported below                                        // for server.js: the file space that comes with this session's plan
  const store = load(), a = sess?.email && store.accounts[sess.email], ws = store.workspaces[sess?.agent ? sess.ws : a?.workspace];
  return ws ? planBaseMb(store, ws) : STORAGE_BASE_MB;
}
function fullMembers(store, wsId) { const ws = store.workspaces[wsId]; return members(store, wsId).filter(a => !GUEST_ROLES.includes(wsRoleOf(a, ws))); }
function guestMembers(store, wsId) { const ws = store.workspaces[wsId]; return members(store, wsId).filter(a => GUEST_ROLES.includes(wsRoleOf(a, ws))); }
function inviteRole(ws, code) {                                    // which role an invite code gives in this workspace, or null
  if (ws.invite && same(ws.invite, code)) return 'member';
  for (const r of INVITE_KINDS) if (ws.invites && ws.invites[r] && same(ws.invites[r], code)) return r;
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
    return named.size ? named.has(a.username.toLowerCase()) : (role !== 'viewer' || a.approves === true);   // T-0295: an approver (a viewer with approves) decides by default
  }).map(a => a.username);
}
function approvalCheck(wsId, ticket, actor, action, noun = 'ticket') {   // server.js asks before every approve / reject. -> { ok, code, error, needs, note }; noun 'review' for code reviews (T-0247)
  if (!ENABLED || !wsId) return { ok: true, needs: 1 };
  const store = load(), ws = store.workspaces[wsId];
  if (!ws) return { ok: true, needs: 1 };
  const lc = s => String(s || '').toLowerCase(), rules = approvalRules(ws), eligible = approverNames(store, ws);
  if (!eligible.some(u => lc(u) === lc(actor))) return { ok: false, code: 403, error: rules.approvers.length
    ? `In this workspace only ${eligible.join(', ')} may approve or reject ${noun}s (the owner's approval rules).`
    : `Only builders and approvers may approve or reject ${noun}s here. A viewer can approve when the owner makes them an approver.` };
  if (action !== 'approve') return { ok: true };
  const notes = [], others = eligible.filter(u => lc(u) !== lc(ticket.proposed_by));
  if (rules.noSelf && lc(ticket.proposed_by) === lc(actor)) {
    if (others.length) return { ok: false, code: 403, error: `You ${noun === 'review' ? 'started' : 'proposed'} ${ticket.id}, and in this workspace nobody approves their own ${noun}. ${others.slice(0, 3).join(', ')} can approve it.` };
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
// T-0217: an address gets the weekly report only after it said yes. ws.report.confirm = { email: { token, ok, askedAt } }. A list that
// existed before this was added is kept as it is (those addresses were already getting it); the verified account address of someone
// in the workspace needs no question. Every address has its own link, which also stops the report.
function reportConfirm(ws) {
  const r = ws.report || (ws.report = {});
  if (!r.confirm) { r.confirm = {}; for (const e of r.recipients || []) r.confirm[e] = { token: crypto.randomBytes(18).toString('base64url'), ok: true, kept: true }; }
  return r.confirm;
}
function reportSetRecipients(store, ws, list, by) {                // -> the addresses that were asked just now
  const conf = reportConfirm(ws), asked = [], mine = new Set(members(store, ws.id).filter(a => verified(a)).map(a => a.email.toLowerCase()));
  for (const e of Object.keys(conf)) if (!list.includes(e)) delete conf[e];
  for (const e of list) {
    if (conf[e]) continue;
    conf[e] = { token: crypto.randomBytes(18).toString('base64url'), ok: mine.has(e), askedAt: Date.now() };
    if (conf[e].ok) continue;
    asked.push(e);
    const link = `${PUBLIC_URL}/report-mail/${conf[e].token}`;
    if (TEST_HOOKS) console.log(`[report] confirm link for ${e}: ${link}`);
    if (mail.enabled) mail.send({ to: e, subject: `Do you want the weekly report for ${ws.name}?`,
      text: `Hello,\n\n${by} listed this address for a short weekly report from the workspace "${ws.name}" in Chamber: what was done, how long it took and what is waiting. No chat and no code.\n\nNothing is sent unless you say yes. To say yes (or no), open:\n${link}\n\nIf you do not want it, you can also just ignore this message.\n` }).catch(err => console.error('[report] confirm mail failed:', err.message));
  }
  ws.report.recipients = list;
  return asked;
}
function reportMailFind(token) {                                   // { ws, name, email, ok } for one address's link, or null
  if (!ENABLED || !token) return null;
  for (const ws of Object.values(load().workspaces)) for (const [email, c] of Object.entries((ws.report && ws.report.confirm) || {})) if (c.token && same(c.token, token)) return { ws: ws.id, name: ws.name, email, ok: !!c.ok };
  return null;
}
function reportMailSet(token, what) {                              // 'yes' confirms the address, 'stop' takes it off the list
  if (!ENABLED || !token) return null;
  const store = load();
  for (const ws of Object.values(store.workspaces)) for (const [email, c] of Object.entries((ws.report && ws.report.confirm) || {})) if (c.token && same(c.token, token)) {
    if (what === 'yes') { c.ok = true; c.confirmedAt = Date.now(); }
    else { delete ws.report.confirm[email]; ws.report.recipients = (ws.report.recipients || []).filter(e => e !== email); if (!ws.report.recipients.length) ws.report.enabled = false; }
    save(store); return { ws: ws.id, name: ws.name, email };
  }
  return null;
}
function reportView(ws) { const r = (ws && ws.report) || {}, rec = Array.isArray(r.recipients) ? r.recipients : [], conf = r.confirm || null;
  return { enabled: !!r.enabled, recipients: rec, waiting: conf ? rec.filter(e => !(conf[e] && conf[e].ok)) : [], linkUrl: r.token ? `${PUBLIC_URL}/report/${r.token}` : null }; }   // T-0217: + waiting (asked, no yes yet)
function reportByToken(token) {
  if (!ENABLED || !token) return null;
  for (const ws of Object.values(load().workspaces)) if (ws.report && ws.report.token && same(ws.report.token, token)) return { ws: ws.id, name: ws.name, token: ws.report.token };
  return null;
}
function reportWorkspaces() {
  if (!ENABLED) return [];
  const store = load(); let changed = false, out = [];
  for (const ws of Object.values(store.workspaces)) {
    if (!(ws.report && ws.report.enabled && Array.isArray(ws.report.recipients) && ws.report.recipients.length)) continue;
    if (!ws.report.confirm) { reportConfirm(ws); changed = true; }                                   // T-0217: a list from before keeps going, and gets its stop links
    const conf = ws.report.confirm, ok = ws.report.recipients.filter(e => conf[e] && conf[e].ok).slice(0, 10);
    if (ok.length) out.push({ ws: ws.id, name: ws.name, recipients: ok, stop: Object.fromEntries(ok.map(e => [e, `${PUBLIC_URL}/report-mail/${conf[e].token}`])), linkUrl: ws.report.token ? `${PUBLIC_URL}/report/${ws.report.token}` : null });
  }
  if (changed) save(store);
  return out;
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
function agentTasksOn(wsId) { const ws = ENABLED && wsId ? load().workspaces[wsId] : null; return !!ws && ws.agentTasks === true; }   // T-0245: off unless the owner switched it on
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
    return { token, username: t.username, role: 'ai', agent: true, ws: ws.id, expires: Infinity, mayAsk: !!t.mayAsk, answersAgents: !!t.answersAgents };   // T-0188; T-0317
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
  if (s === 'paused' || s === 'incomplete' || s === 'incomplete_expired') return FREE_ON() && verified(acct) ? 'free' : 'none';   // T-0225
  if (onTrialClock(acct)) return !verified(acct) ? 'none' : Date.now() < acct.trialEndsAt ? 'trial' : FREE_ON() ? 'free' : 'readonly';   // T-0159: trial needs a confirmed email; T-0225: afterwards the free plan (read-only without it), nothing deleted
  return acct.periodEnd && acct.periodEnd * 1000 > Date.now() ? 'ok' : FREE_ON() && verified(acct) ? 'free' : 'none';   // cancelled: good until the paid period ends; T-0225: then free
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
  const payer = payerOf(acct, store), st = billingState(payer);
  if (st === 'free') return hasFreeSeat(acct, store) ? 'full' : 'readonly';   // T-0225, T-0288: the owner and whoever joined first, up to FREE_PEOPLE; the rest may read
  return st === 'none' ? 'none' : st === 'readonly' ? 'readonly' : 'full';
}
function entitled(acct, store) { return accessOf(acct, store) !== 'none'; }
function billingView(acct, store) {                                // what /api/me and the account page show (T-0028)
  if (!acct) return null;
  const payer = payerOf(acct, store);
  return { state: acct.role === 'admin' ? 'ok' : billingState(payer), access: accessOf(acct, store), graceEndsAt: billingState(payer) === 'grace' ? graceEndsAt(payer) : null,
           payer: payer ? payer.username : null, isPayer: !!payer && payer.email === acct.email,
           trial: billingState(payer) === 'trial', trialEndsAt: onTrialClock(payer) ? payer.trialEndsAt : null, trialOver: onTrialClock(payer) && ['readonly', 'free'].includes(billingState(payer)), free: billingState(payer) === 'free', freePeople: freePeopleFor(store.workspaces[(payer || acct).workspace]), plan: payer && ['ok', 'grace', 'readonly'].includes(billingState(payer)) ? (payer.plan === 'company' ? 'company' : 'team') : null, founding: payer && payer.founding ? payer.founding.n : null,   // T-0159; T-0225; T-0288; T-0295
           interval: payer && ['ok', 'grace', 'readonly'].includes(billingState(payer)) ? periodOf(payer) : null, foundingLabel: payer && payer.founding ? payer.founding.label || null : null,   // T-0310
           trialPending: onTrialClock(payer) && !verified(payer) && Date.now() < payer.trialEndsAt };
}
// Storage add-on: packs count only while the payer's subscription is good (ok or grace). Nothing is deleted when they stop
// counting; the workspace just cannot take new files while it is over its limit.
function storagePacksOf(payer) { return STORAGE_ON() && payer && payer.subscription && billingState(payer) === 'ok' ? (payer.storagePacks || 0) : 0; }   // T-0311: a failed payment pauses the packs (not 'grace')
// T-0311: the Billing tab. What a plan and its packs give (MB); a change asked for (plan, period, packs: whatever is not given stays),
// checked once for both the preview and the change; and the subscription lines after it.
const limitMbOf = (plan, packs) => (plan === 'company' ? companyMb() : PLANS.team.baseMb) + packs * STORAGE_PACK_GB * 1024;   // T-0314
function changeTarget(store, ws, P, b) {
  const havePlan = P.plan === 'company' ? 'company' : 'team', haveIv = periodOf(P), havePacks = P.storagePacks || 0;
  const plan = b?.plan === undefined ? havePlan : b.plan, iv = b?.interval === undefined ? haveIv : b.interval, packs = b?.packs === undefined ? havePacks : b.packs;
  if (!['team', 'company'].includes(plan)) return { error: 'plan must be team or company' };
  if (!['month', 'year'].includes(iv)) return { error: 'interval must be month or year' };
  if (!Number.isInteger(packs) || packs < 0 || packs > STORAGE_MAX_PACKS) return { error: `Choose between 0 and ${STORAGE_MAX_PACKS} packs.` };
  if (P.cancelAtPeriodEnd) return { error: 'The plan is set to cancel. Keep it first (Billing tab), then change it. Nothing was changed.' };
  if (!priceFor(plan, iv, ws)) return { error: `The ${plan === 'company' ? 'Company' : 'Team'} plan is not offered ${iv === 'year' ? 'yearly' : 'monthly'} on this Chamber. Nothing was changed.` };
  if (packs > 0 && !STORAGE_PRICES[iv]) return { error: `Extra storage is not offered on ${iv === 'month' ? 'monthly' : 'yearly'} plans on this Chamber. Remove it first. Nothing was changed.` };
  const n = fullMembers(store, ws.id).length, cap = planCap(ws, plan);
  if (plan !== havePlan && n > cap) return { status: 409, error: `This workspace has ${n} builders and the ${plan === 'company' ? 'Company' : 'Team'} plan covers ${cap}. Make some of them approvers or viewers first. Nothing was changed.` };
  const charges = (plan === 'company' && havePlan === 'team') || (iv === 'year' && haveIv === 'month') || packs > havePacks;
  return { plan, iv, packs, havePlan, haveIv, havePacks, charges, same: plan === havePlan && iv === haveIv && packs === havePacks };
}
function changeItems(sub, t, ws) {                                   // Stripe keeps every line of a subscription on one period: they move together
  const items = sub.items?.data || [], planItem = items.find(i => priceInfo(i.price?.id)), stItem = items.find(i => isStoragePrice(i.price?.id)), out = [];
  if (planItem) out.push({ id: planItem.id, price: priceFor(t.plan, t.iv, ws) });
  if (t.packs > 0) out.push(stItem ? { id: stItem.id, price: STORAGE_PRICES[t.iv], quantity: t.packs } : { price: STORAGE_PRICES[t.iv], quantity: t.packs });
  else if (stItem) out.push({ id: stItem.id, deleted: 'true' });
  return Object.fromEntries(out.map((x, i) => [i, x]));
}
async function previewInvoice(P, extra) {                            // what Stripe would bill (now, for a change; or next, with no change); null if it cannot say
  try { return await stripe('GET', 'invoices/upcoming', { customer: P.stripeCustomer, subscription: P.subscription, ...extra }); }
  catch (e) { console.error('[accounts] preview:', e.message); return null; }
}
const usedBytesOf = (ctx, ws) => { try { return (ctx.withWorkspace(ws.id, () => ctx.filesUsed()) || { b: 0 }).b || 0; } catch { return 0; } };
const biggestFiles = (ctx, ws) => { try { return (ctx.withWorkspace(ws.id, () => ctx.listFiles()) || []).sort((a, b) => (b.size || 0) - (a.size || 0)).slice(0, 5).map(f => ({ name: f.name, size: f.size || 0, folder: f.folder || null })); } catch { return []; } };
const mbText = b => b >= 1073741824 ? (b / 1073741824).toFixed(1) + ' GB' : Math.ceil(b / 1048576) + ' MB';
function storageView(acct, store) {                                // what the account page shows; null = not offered here
  if (!STORAGE_ON() || !acct) return null;
  const payer = payerOf(acct, store), isPayer = !!payer && payer.email === acct.email, iv = periodOf(payer), pws = payer && store.workspaces[payer.workspace];
  return { packGb: STORAGE_PACK_GB, label: STORAGE_PRICES[iv] ? STORAGE_LABELS[iv] : '', period: iv, maxPacks: STORAGE_MAX_PACKS, baseMb: pws ? planBaseMb(store, pws) : PLANS.team.baseMb, packs: storagePacksOf(payer), isPayer,   // T-0310: the plan's period; Company's 5 GB
           canChange: isPayer && payer.subStatus === 'active' && !!payer.subscription && !payer.cancelAtPeriodEnd && !!STORAGE_PRICES[iv] };
}
function storageExtraMbFor(sess) {                                 // for server.js: extra MB this session's workspace has bought
  if (!STORAGE_ON()) return 0;
  const store = load();
  const payer = sess?.agent ? store.accounts[store.workspaces[sess.ws]?.owner] : sess?.email && store.accounts[sess.email] ? payerOf(store.accounts[sess.email], store) : null;
  return storagePacksOf(payer) * STORAGE_PACK_GB * 1024;
}
function planList(ws) {                                              // T-0295, T-0310: what the pages show; a plan or period only where its price is configured
  if (SELF_HOSTED) return null;
  const one = (plan, storageMb) => { const month = labelFor(plan, 'month', ws), year = labelFor(plan, 'year', ws);
    return month || year ? { label: month || year, month: month || null, year: year || null, builders: ws ? planCap(ws, plan) : PLANS[plan].builders, storageMb } : null; };
  return { team: one('team', PLANS.team.baseMb), company: one('company', companyMb()), yearNote: '2 months free' };   // T-0314
}
function publicView(acct, store) {
  const ws = store.workspaces[acct.workspace] || {};
  const owner = store.accounts[ws.owner];
  return { email: acct.email, username: acct.username, role: acct.role, entitled: entitled(acct, store),
           subStatus: acct.subStatus || null, periodEnd: acct.periodEnd || null, cancelAtPeriodEnd: !!acct.cancelAtPeriodEnd,
           hasCustomer: !!acct.stripeCustomer, price: SELF_HOSTED ? 'self-hosted (no subscription)' : priceLabelOf(owner || acct, ws), plans: planList(ws), selfHosted: SELF_HOSTED, billing: billingView(acct, store), storage: storageView(acct, store),   // T-0028/T-0061; T-0310
           emailVerified: verified(acct), verifyRequired: VERIFY_REQUIRED(), logins: (acct.logins || []).slice(-5).map(l => ({ ip: l.ip, at: l.at, device: l.ua })),   // T-0032
           totp: !!acct.totp, passkeyLogin: pkLoginOn(acct), needsTotp: !twoStep(acct) && ws.owner === acct.email && Object.keys(ws.tokens || {}).length > 0,   // T-0040: owners who hold agent tokens should have 2FA
           security: wsSecurity(ws),                                                                   // T-0241 part 3: the workspace's rules, shown to everyone
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
  if (Array.isArray(sub.items?.data)) {                             // T-0295, T-0310: Team or Company, monthly or yearly, by the price on the subscription
    const pi = sub.items.data.map(i => priceInfo(i.price?.id)).find(Boolean);
    if (pi) { acct.plan = pi.plan; acct.interval = pi.interval; acct.priceLabel = pi.label; }
  }
  if ((STORAGE_PRICES.month || STORAGE_PRICES.year || STORAGE_OLD) && Array.isArray(sub.items?.data)) {   // storage add-on: the quantity on its subscription line is the number of packs
    const si = sub.items.data.find(i => isStoragePrice(i.price?.id));
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
function setSessionCookie(res, ctx, token, pol) {                  // T-0241 part 2: pol = sessionPolicyOf(acct); remember off = a cookie that ends with the browser
  const age = pol ? (pol.remember ? `; Max-Age=${pol.days * 86400}` : '') : `; Max-Age=${ctx.sessionTtl / 1000}`;
  res.setHeader('Set-Cookie', `chamber_session=${token}; HttpOnly; SameSite=Strict; Path=/${age}` + (ctx.cookieSecure ? '; Secure' : ''));
}
function clientIp(req) {                                          // behind nginx the real address is the LAST X-Forwarded-For hop (nginx appends it; the first hop is whatever the client sent) — T-0030
  const hops = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return hops.length ? hops[hops.length - 1] : (req.socket.remoteAddress || '?');
}
function signIn(res, ctx, acct, req) {                                 // create the Chamber session + make sure the app knows the user (in ITS workspace)
  const chatRole = acct.chatRole || 'human';
  ctx.withWorkspace(acct.workspace, () => {
    const data = ctx.loadData();
    const existing = data.users[acct.username];
    data.users[acct.username] = { username: acct.username, role: chatRole, lastSeen: Date.now(), joinedAt: existing?.joinedAt || Date.now() };
    ctx.saveData(data);
  });
  const wsNow = load().workspaces[acct.workspace], pol = effectiveSession(acct, wsNow);   // T-0241 parts 2+3: the sign-in length (the workspace rule may shorten it); device and address for the devices list
  const token = ctx.createSession(acct.username, chatRole, { email: acct.email, ...effectiveLock(acct, wsNow), recheckMin: effectiveRecheck(acct, wsNow), checkedAt: Date.now(), ttlMs: pol.days * 864e5,   // T-0241 part 4: signing in is a fresh check
    ua: req ? String(req.headers['user-agent'] || '').slice(0, 200) : '', ip: req ? clientIp(req) : '' });   // T-0241: the person's screen-lock choices ride on the session
  setSessionCookie(res, ctx, token, pol);
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
  const myRole = me && myWs ? wsRoleOf(me, myWs) : null;              // T-0246: the role permissions.js reads (owner, admin, member, viewer, requester)

  // Pages
  if (m === 'GET' && (p === '/' || p === '/index.html')) {
    if (me && entitled(me, store)) return redirect(res, '/app'), true;
    return ctx.serveStatic(res, LANDING, req), true;
  }
  if (m === 'GET' && (['/signup', '/login', '/billing', '/account', '/settings', '/forgot'].includes(p) || /^\/(join|reset)\/[A-Za-z0-9_-]{8,}$/.test(p))) {
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
  if (m === 'GET' && p === '/download') return ctx.serveStatic(res, path.join(__dirname, 'public', 'download.html'), req), true;   // T-0226: run it on your own computer
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
          if (!acct.founding && ['active', 'trialing'].includes(sub.status)) {   // T-0295: the first paying workspaces keep the price they signed up at
            const n = Object.values(store.accounts).filter(a => a.founding).length;
            if (n < FOUNDING_MAX) acct.founding = { n: n + 1, at: Date.now(), plan: acct.plan || 'team', interval: periodOf(acct), label: priceLabelOf(acct, store.workspaces[acct.workspace]),   // T-0310: the exact price
                                                    price: (sub.items?.data || []).map(i => i.price?.id).find(id => priceInfo(id)) || null };
          }
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
        if (acct) { clearFailure(acct); console.log(`[accounts] payment ok: ${acct.username}`);
          // T-0310: a receipt by email for every payment, so a monthly plan gets one each month. Only on invoice.paid (Stripe also
          // sends invoice.payment_succeeded for the same payment), once per invoice even if Stripe sends the event again.
          if (ev.type === 'invoice.paid' && (obj.amount_paid || 0) > 0 && obj.id && !(acct.receipts || []).includes(obj.id)) {
            acct.receipts = [...(acct.receipts || []), obj.id].slice(-50);
            const cur = String(obj.currency || 'usd').toUpperCase(), amt = (cur === 'USD' ? '$' : cur + ' ') + (obj.amount_paid / 100).toFixed(2);
            const when = new Date(((obj.status_transitions && obj.status_transitions.paid_at) || obj.created || Date.now() / 1000) * 1000).toUTCString().slice(0, 16);
            const link = typeof obj.hosted_invoice_url === 'string' && /^https:\/\/[a-z0-9.-]*stripe\.com\//.test(obj.hosted_invoice_url) ? obj.hosted_invoice_url : '';
            const number = typeof obj.number === 'string' ? obj.number.replace(/[^\w-]/g, '').slice(0, 40) : '';
            const letter = { to: acct.email, subject: `Chamber: receipt for ${amt}`, text: `Hello ${acct.username},\n\nThank you. We received ${amt} for Chamber on ${when}${number ? ` (invoice ${number})` : ''}.\n\n`
              + (link ? `The invoice, with a PDF to download: ${link}\n\n` : '') + `Your plan and storage: ${PUBLIC_URL}/billing\n\nQuestions, or a refund within 14 days: reply to this email or write to ${CONTACT_TO}.\n` };
            if (TEST_HOOKS) console.log(`[accounts] receipt mail to ${letter.to}: ${amt}${number ? ' ' + number : ''}`);
            if (mail.enabled) mail.send(letter).catch(e => console.error('[accounts] receipt mail failed:', e.message));
          }
        }
      }
      seen(); save(store);
    } catch (e) { console.error('[accounts] webhook:', e.message); return ctx.json(res, 500, { error: 'internal' }), true; }
    return ctx.json(res, 200, { received: true }), true;
  }

  // Public bits the sign-up form needs
  if (p === '/account/config' && m === 'GET') {
    return ctx.json(res, 200, { inviteRequired: !!INVITE_CODE && !TRIAL_ON(), trialDays: TRIAL_ON() ? TRIAL_DAYS : 0, price: PRICE_LABEL, resetByEmail: mail.enabled, freePlan: FREE_ON() ? { tokens: FREE_TOKENS, people: FREE_PEOPLE } : null, plans: SELF_HOSTED ? null : { ...planList(null), foundingLeft: Math.max(0, FOUNDING_MAX - Object.values(load().accounts).filter(a => a.founding).length) }, storage: STORAGE_ON() ? { packGb: STORAGE_PACK_GB, label: STORAGE_PRICES.month ? STORAGE_LABELS.month : STORAGE_LABELS.year, month: STORAGE_PRICES.month ? STORAGE_LABELS.month : null, year: STORAGE_PRICES.year ? STORAGE_LABELS.year : null, baseMb: PLANS.team.baseMb, companyMb: companyMb() } : null }), true;   // T-0310; T-0314: the plans' own sizes
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
    const joined = b?.join ? findInvite(store, String(b.join)) : null, joinWs = joined ? joined.ws : null, joinApprover = !!joined && joined.role === 'approver', joinRole = joined ? (joinApprover ? 'viewer' : joined.role) : 'member';   // T-0295: an approver link = viewer + approves   // T-0199: the link decides the role
    if (b?.join && !joinWs) return ctx.json(res, 400, { error: 'This invite link is not valid any more.' }), true;
    if (joinWs && billingState(store.accounts[joinWs.owner]) === 'free' && members(store, joinWs.id).length >= freePeopleFor(joinWs)) return ctx.json(res, 403, { error: `This workspace is on Chamber's free plan, which covers ${freePeopleFor(joinWs) === 1 ? 'one person' : freePeopleText()}, and it is full. Ask its owner to subscribe, then open the invite link again.`, plan: 'free' }), true;   // T-0225; T-0288: full at FREE_PEOPLE
    if (joinWs && joinRole === 'member' && fullMembers(store, joinWs.id).length >= builderLimit(store, joinWs)) return ctx.json(res, 403, { error: `This workspace has no free builder seat (${builderLimit(store, joinWs)} on its plan). Ask the owner for an approver link, which uses no seat, or to move to a bigger plan.` }), true;   // T-0033; T-0295: by plan
    if (joinWs && joinRole !== 'member' && !guestsUnlimited(store, joinWs) && guestMembers(store, joinWs.id).length >= MAX_GUESTS) return ctx.json(res, 403, { error: `This workspace has no free places for viewers and requesters (${MAX_GUESTS}). Ask the owner.` }), true;   // T-0199; T-0295: no limit on a paid plan
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
    if (joinWs) { acct.workspace = joinWs.id; acct.wsRole = joinRole; if (joinApprover) acct.approves = true; } else createWorkspace(store, acct);
    if (trialSignup) { const used = (store.trials ||= {}), h = sha('trial:' + email);       // T-0159 review: one trial per email address, also after deleting the account and signing up again
      acct.trialEndsAt = used[h] || Date.now() + TRIAL_MS; used[h] = acct.trialEndsAt; const ip = clientIp(req); trialSignups.set(ip, [...(trialSignups.get(ip) || []).filter(t => Date.now() - t < 86400e3), Date.now()]);
      if (trialSignups.size > 5000) for (const [k, v] of trialSignups) if (!v.some(t => Date.now() - t < 86400e3)) trialSignups.delete(k); }
    store.accounts[email] = acct; store.usernames[username.toLowerCase()] = email;
    if (VERIFY_REQUIRED()) startVerification(store, acct, 'Welcome to Chamber.'); else acct.emailVerified = true;   // T-0032
    if (trialSignup && acct.emailVerified === false) acct.unconfirmedSince = Date.now();   // T-0176: only sign-ups carrying this mark are ever cleaned up
    acct.logins = [{ ip: clientIp(req), ua: String(req.headers['user-agent'] || '').slice(0, 120), at: Date.now() }];
    save(store);
    const token = signIn(res, ctx, acct, req);
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
    if (twoStep(acct) && !rememberedDevice(req, acct)) {                                           // T-0040: second step (T-0241 (a): the code or a passkey)
      const mfaToken = crypto.randomBytes(24).toString('base64url');
      store.mfaPending ||= {};
      for (const [k, v] of Object.entries(store.mfaPending)) if (v.expires < Date.now()) delete store.mfaPending[k];
      store.mfaPending[sha(mfaToken)] = { email: acct.email, expires: Date.now() + 5 * 60e3 }; save(store);
      const pk = (acct.passkeys || []).length > 0 && !!pkRp(), totp = !!acct.totp;
      return ctx.json(res, 200, { ok: true, mfa: true, mfaToken, totp, passkey: pk, message: totp && pk ? 'Enter the 6-digit code from your authenticator app or a recovery code, or use a passkey.'
        : totp ? 'Enter the 6-digit code from your authenticator app, or a recovery code.' : 'Use your passkey to finish signing in.' }), true;
    }
    acct.lastLogin = Date.now(); const fresh = noteLogin(req, acct); save(store);                 // T-0032
    if (acct.workspace) ctx.withWorkspace(acct.workspace, () => ctx.audit({ username: acct.username }, { action: 'login', newAddress: fresh && acct.logins.length > 1 ? true : undefined }, true));   // T-0057
    if (fresh && acct.logins.length > 1) console.log(`[accounts] login from a new address: ${acct.username} ${clientIp(req)}`);
    const token = signIn(res, ctx, acct, req);
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
    const pkOnly = !acct.totp && pkLoginOn(acct);                     // T-0241 (a): the reset link proves the email, not the passkey: change the password, then sign in with both
    acct.salt = crypto.randomBytes(16).toString('hex'); acct.hash = hash(pw, acct.salt);
    if (acct.emailVerified === false) {                                // 2026-11-12: the reset link was mailed to this address and opened, which proves the address as well as
      acct.emailVerified = true; delete acct.unconfirmedSince;         // the confirm link would. Before this, someone who set a password by email was still told to confirm their email.
      for (const [k, v] of Object.entries(store.verifications || {})) if (v.email === acct.email) delete store.verifications[k];
      console.log(`[accounts] email confirmed by password reset: ${acct.username}`);
    }
    delete store.resets[sha(String(b.token))]; save(store);
    endSessions(ctx, acct.email);
    if (pkOnly) { console.log(`[accounts] password reset via email (passkey sign-in on, not signed in): ${acct.username}`); return ctx.json(res, 200, { ok: true, signIn: true, message: 'Password changed. Now sign in with it and your passkey.' }), true; }
    const token = signIn(res, ctx, acct, req);
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
    if (!acct || !acct.totp) { if (acct && pkLoginOn(acct)) return ctx.json(res, 400, { error: 'This account signs in with a passkey, not a code. Use your passkey.' }), true; delete store.mfaPending[sha(String(b.mfaToken))]; save(store); return ctx.json(res, 400, { error: 'Start the sign-in again.' }), true; }
    if (!secondFactorOk(acct, b?.code)) { save(store); return ctx.json(res, mfaLocked(acct) ? 429 : 401, { error: mfaLocked(acct) ? 'Too many wrong codes. Wait 15 minutes, then try again.' : 'That code is not right. Codes change every 30 seconds; recovery codes work once.' }), true; }
    delete store.mfaPending[sha(String(b.mfaToken))];
    let dev = null;
    if (b?.remember) {                                                                             // 30-day device cookie, hashed server-side, 5 devices max
      dev = crypto.randomBytes(24).toString('base64url');
      acct.mfaDevices = [...(acct.mfaDevices || []).filter(d => d.expires > Date.now()), { hash: sha(dev), expires: Date.now() + 30 * 86400e3, ua: String(req.headers['user-agent'] || '').slice(0, 80) }].slice(-5);
    }
    acct.lastLogin = Date.now(); noteLogin(req, acct); save(store);
    if (acct.workspace) ctx.withWorkspace(acct.workspace, () => ctx.audit({ username: acct.username }, { action: 'login-2fa', remembered: !!b?.remember }, true));   // T-0057
    const token = signIn(res, ctx, acct, req);                                                           // sets the session cookie
    if (dev) res.setHeader('Set-Cookie', [...[].concat(res.getHeader('Set-Cookie') || []), `chamber_mfa=${dev}; HttpOnly; SameSite=Strict; Path=/account; Max-Age=${30 * 86400}` + (ctx.cookieSecure ? '; Secure' : '')]);   // add, not replace
    console.log(`[accounts] 2fa login: ${acct.username}`);
    return ctx.json(res, 200, { ok: true, account: publicView(acct, store), token }), true;
  }
  if ((p === '/account/login/passkey/options' || p === '/account/login/passkey') && m === 'POST') {   // T-0241 (a): the second step with a passkey
    if (ctx.loginThrottled(clientIp(req))) return ctx.json(res, 429, { error: 'Too many attempts. Wait a minute.' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    const rec = store.mfaPending?.[sha(String(b?.mfaToken || ''))];
    if (!rec || rec.expires < Date.now()) return ctx.json(res, 400, { error: 'This sign-in attempt expired. Start again.' }), true;
    const acct = store.accounts[rec.email], rp = pkRp();
    if (!acct || !rp || !(acct.passkeys || []).length) return ctx.json(res, 400, { error: 'This account has no passkey here. Use the code from your authenticator app.' }), true;
    if (p === '/account/login/passkey/options') return ctx.json(res, 200, { publicKey: { challenge: pkChallenge(acct.email, 'get'), rpId: rp.id, timeout: 120000, userVerification: 'required', allowCredentials: acct.passkeys.map(k => ({ type: 'public-key', id: k.id })) } }), true;
    try { pkVerifyGet(acct, b); }
    catch (e) { save(store); if (acct.workspace) ctx.withWorkspace(acct.workspace, () => ctx.audit({ username: acct.username }, { action: 'login-2fa-failed', via: 'passkey', why: e.message }, true)); return ctx.json(res, 401, { error: 'The passkey did not work: ' + e.message + '.' }), true; }
    delete store.mfaPending[sha(String(b.mfaToken))];
    let dev = null;
    if (b?.remember) {                                                                             // the same 30-day device cookie as the code step
      dev = crypto.randomBytes(24).toString('base64url');
      acct.mfaDevices = [...(acct.mfaDevices || []).filter(d => d.expires > Date.now()), { hash: sha(dev), expires: Date.now() + 30 * 86400e3, ua: String(req.headers['user-agent'] || '').slice(0, 80) }].slice(-5);
    }
    acct.lastLogin = Date.now(); noteLogin(req, acct); save(store);
    if (acct.workspace) ctx.withWorkspace(acct.workspace, () => ctx.audit({ username: acct.username }, { action: 'login-2fa', via: 'passkey', remembered: !!b?.remember }, true));
    const token = signIn(res, ctx, acct, req);
    if (dev) res.setHeader('Set-Cookie', [...[].concat(res.getHeader('Set-Cookie') || []), `chamber_mfa=${dev}; HttpOnly; SameSite=Strict; Path=/account; Max-Age=${30 * 86400}` + (ctx.cookieSecure ? '; Secure' : '')]);
    console.log(`[accounts] 2fa login (passkey): ${acct.username}`);
    return ctx.json(res, 200, { ok: true, account: publicView(acct, store), token }), true;
  }
  if (p === '/account/passkey-login' && m === 'POST') {               // T-0241 (a): ask for the passkey when this person signs in
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({})), on = b?.on === true;
    if (typeof b?.on !== 'boolean') return ctx.json(res, 400, { error: 'on must be true or false' }), true;
    if (on) {
      if (!(me.passkeys || []).length || !pkRp()) return ctx.json(res, 400, { error: 'Add a passkey first (above), then switch this on.' }), true;
      me.passkeyLogin = true; save(store);
      for (const [t, s] of ctx.sessions) if (s.email === me.email && t !== sess.token) ctx.sessions.delete(t);   // as with the app: other sign-ins must prove the new step
    } else {
      if (!me.passkeyLogin) return ctx.json(res, 200, { ok: true, on: false }), true;
      if (!me.totp && wsSecurity(store.workspaces[me.workspace]).require2fa) return ctx.json(res, 400, { error: 'Your workspace requires two-step sign-in, so it cannot be turned off. Turn on the authenticator app first if you want to use that instead.' }), true;
      const g = reauth(me, b?.password); if (g !== 'ok') return reauthFail(ctx, res, g, b?.password ? 'Password is wrong.' : 'Enter your password to stop asking for the passkey at sign-in.'), true;
      delete me.passkeyLogin; save(store);
    }
    if (me.workspace) ctx.withWorkspace(me.workspace, () => ctx.audit(sess, { action: 'passkey-login', on }, true));
    return ctx.json(res, 200, { ok: true, on }), true;
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
    if (wsSecurity(store.workspaces[me.workspace]).require2fa && !pkLoginOn(me)) return ctx.json(res, 400, { error: 'Your workspace requires two-factor authentication, so it cannot be turned off.' + (store.workspaces[me.workspace]?.owner === me.email ? ' Switch that rule off first (Rules for everyone, on this page).' : '') }), true;   // T-0241 part 3
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
    if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !push.endpointOk(sub.endpoint)) return ctx.json(res, 400, { error: 'bad subscription' }), true;   // T-0235: browser push services only
    me.push = (me.push || []).filter(s => s.endpoint !== sub.endpoint).concat([{ endpoint: sub.endpoint, keys: sub.keys || {}, addedAt: Date.now() }]).slice(-10);
    save(store);
    return ctx.json(res, 200, { ok: true, subscriptions: me.push.length }), true;
  }
  if (p === '/account/push/clear' && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    me.push = []; save(store); return ctx.json(res, 200, { ok: true }), true;
  }
  // T-0241 part 1: screen lock. GET/POST the person's choices; POST /account/unlock with the password (the gate in server.js lets
  // only this, sign-out and the public sign-in routes through for a locked session). Making the lock stricter needs nothing;
  // making it weaker (shorter protection, or off) needs the password, so a passer-by at an open session cannot switch it off.
  if (p === '/account/screen-lock' && m === 'GET') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const cur = screenLockPrefs(me), wsl = store.workspaces[me.workspace], eff = effectiveLock(me, wsl), r = wsSecurity(wsl);   // T-0241 part 3: what applies, the person's own choice, the rule
    return ctx.json(res, 200, { idle: eff.lockIdle, reopen: eff.lockReopen, own: { idle: cur.lockIdle, reopen: cur.lockReopen }, rule: { idleMax: r.idleMax, reopen: r.reopen }, choices: LOCK_IDLE_CHOICES, reopenMinutes: ctx.screenLock.reopenMin }), true;
  }
  if (p === '/account/screen-lock' && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    const idle = Number(b?.idle), reopen = b?.reopen === true;
    if (!LOCK_IDLE_CHOICES.includes(idle)) return ctx.json(res, 400, { error: 'idle must be 0 (never), 5, 15, 30 or 60 minutes' }), true;
    if (b?.reopen !== undefined && typeof b.reopen !== 'boolean') return ctx.json(res, 400, { error: 'reopen must be true or false' }), true;
    { const rl = wsSecurity(store.workspaces[me.workspace]);                     // T-0241 part 3: stricter than the workspace rule, never weaker
      if ((rl.idleMax && (idle === 0 || idle > rl.idleMax)) || (rl.reopen && !reopen)) return ctx.json(res, 400, { error: `Your workspace requires ${ruleWords(rl)}. You can choose something stricter, not weaker.`, rule: { idleMax: rl.idleMax, reopen: rl.reopen } }), true; }
    const cur = screenLockPrefs(me);
    const weaker = (cur.lockIdle > 0 && (idle === 0 || idle > cur.lockIdle)) || (cur.lockReopen && !reopen);
    if (weaker) { const g = reauth(me, b?.password); if (g !== 'ok') return reauthFail(ctx, res, g, b?.password ? 'Password is wrong.' : 'Enter your password to make the screen lock less strict.'), true; }
    me.screenLock = { idle, reopen, at: Date.now() }; save(store);
    const now = Date.now();
    for (const [t, s] of ctx.sessions) if (s.email === me.email) { s.lockIdle = idle; s.lockReopen = reopen; if (t === sess?.token) { s.lastActive = now; s.lastAlive = now; } }
    if (me.workspace) ctx.withWorkspace(me.workspace, () => ctx.audit(sess, { action: 'screen-lock-settings', idle, reopen }, true));
    return ctx.json(res, 200, { ok: true, idle, reopen }), true;
  }
  // T-0241 part 5: passkeys. Add one (with the person's own device), list, remove; then use one to unlock or to confirm it is you.
  if (p === '/account/passkeys' && m === 'GET') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    return ctx.json(res, 200, { passkeys: (me.passkeys || []).map(k => ({ id: k.id, name: k.name, at: k.at, lastUsed: k.lastUsed || null })), max: PK_MAX, available: !!pkRp(), login: pkLoginOn(me), totp: !!me.totp }), true;
  }
  if (p === '/account/passkeys/options' && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const rp = pkRp(); if (!rp) return ctx.json(res, 400, { error: 'Passkeys need this Chamber\'s address to be set (CHAMBER_PUBLIC_URL).' }), true;
    const b = await ctx.parseBody(req).catch(() => ({})), kind = b?.kind === 'create' ? 'create' : 'get', mine = me.passkeys || [];
    if (kind === 'create' && mine.length >= PK_MAX) return ctx.json(res, 400, { error: `At most ${PK_MAX} passkeys. Remove one first.` }), true;
    if (kind === 'get' && !mine.length) return ctx.json(res, 400, { error: 'You have no passkey here yet.' }), true;
    const challenge = pkChallenge(me.email, kind);
    if (kind === 'create') return ctx.json(res, 200, { publicKey: { challenge, rp: { id: rp.id, name: 'Chamber' }, user: { id: b64u(crypto.createHash('sha256').update(me.email).digest().subarray(0, 16)), name: me.username, displayName: me.username },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], timeout: 120000, attestation: 'none',
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' }, excludeCredentials: mine.map(k => ({ type: 'public-key', id: k.id })) } }), true;
    return ctx.json(res, 200, { publicKey: { challenge, rpId: rp.id, timeout: 120000, userVerification: 'required', allowCredentials: mine.map(k => ({ type: 'public-key', id: k.id })) } }), true;
  }
  if (p === '/account/passkeys/add' && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    let cred; try { pkClientData(b, 'create', me.email); const [att] = cborRead(unb64u(b?.attestationObject)); if (!(att instanceof Map) || !Buffer.isBuffer(att.get('authData'))) throw new Error('the answer is not readable'); cred = pkAuthData(att.get('authData'), true); }
    catch (e) { return ctx.json(res, 400, { error: 'Could not add the passkey: ' + e.message + '.' }), true; }
    const id = b64u(cred.credId); if ((me.passkeys || []).some(k => k.id === id)) return ctx.json(res, 400, { error: 'That passkey is already added.' }), true;
    if ((me.passkeys || []).length >= PK_MAX) return ctx.json(res, 400, { error: `At most ${PK_MAX} passkeys. Remove one first.` }), true;
    const name = String(b?.name || '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Passkey';
    (me.passkeys ||= []).push({ id, alg: cred.alg, jwk: cred.jwk, counter: cred.counter, name, at: Date.now() }); save(store);
    if (me.workspace) ctx.withWorkspace(me.workspace, () => ctx.audit(sess, { action: 'passkey-add', name }, true));
    return ctx.json(res, 200, { ok: true, id, name }), true;
  }
  if (p === '/account/passkeys/remove' && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({})), k = (me.passkeys || []).find(x => x.id === String(b?.id || ''));
    if (!k) return ctx.json(res, 404, { error: 'No such passkey here.' }), true;
    if (me.passkeyLogin && me.passkeys.length === 1) {                // T-0241 (a): the last passkey also ends the passkey at sign-in
      if (!me.totp && wsSecurity(store.workspaces[me.workspace]).require2fa) return ctx.json(res, 400, { error: 'This is your last passkey and your workspace requires two-step sign-in. Add another passkey or turn on the authenticator app first.' }), true;
      delete me.passkeyLogin;
    }
    me.passkeys = me.passkeys.filter(x => x !== k); if (!me.passkeys.length) delete me.passkeys; save(store);
    if (me.workspace) ctx.withWorkspace(me.workspace, () => ctx.audit(sess, { action: 'passkey-remove', name: k.name }, true));
    return ctx.json(res, 200, { ok: true }), true;
  }
  if (p === '/account/passkeys/use' && m === 'POST') {                // unlock the screen, or confirm it is you
    if (!me || !sess?.token) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({})), purpose = b?.purpose === 'unlock' ? 'unlock' : 'recheck';
    try { pkVerifyGet(me, b); }
    catch (e) { if (me.workspace) ctx.withWorkspace(me.workspace, () => ctx.audit(sess, { action: purpose === 'unlock' ? 'screen-unlock-failed' : 'recheck-failed', why: 'passkey: ' + e.message }, true)); return ctx.json(res, 403, { error: 'The passkey did not work: ' + e.message + '.' }), true; }
    save(store);                                                      // its counter and when it was last used
    if (purpose === 'unlock') { ctx.screenLock.unlock(sess.token); if (me.workspace) ctx.withWorkspace(me.workspace, () => ctx.audit(sess, { action: 'screen-unlock', via: 'passkey' }, true)); }
    else { const s = ctx.sessions.get(sess.token); if (s) { s.checkedAt = Date.now(); ctx.persistSessions(); } if (me.workspace) ctx.withWorkspace(me.workspace, () => ctx.audit(sess, { action: 'recheck', via: 'passkey' }, true)); }
    return ctx.json(res, 200, { ok: true, purpose }), true;
  }
  // T-0241 part 4: ask for the password again before sensitive actions (the list is RECHECK in permissions.js; the gate is in
  // server.js). Asking more often needs nothing; less often needs the password; never weaker than the owner's rule.
  if (p === '/account/recheck-settings' && m === 'GET') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const wsr = store.workspaces[me.workspace];
    return ctx.json(res, 200, { min: effectiveRecheck(me, wsr), own: recheckPrefOf(me), rule: { recheckMax: wsSecurity(wsr).recheckMax }, choices: RECHECK_CHOICES }), true;
  }
  if (p === '/account/recheck-settings' && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({})), min = Number(b?.min), wsr = store.workspaces[me.workspace], rule = wsSecurity(wsr).recheckMax;
    if (!RECHECK_CHOICES.includes(min)) return ctx.json(res, 400, { error: 'min must be 0 (never), 5, 15 or 60 minutes' }), true;
    if (rule && (!min || min > rule)) return ctx.json(res, 400, { error: `Your workspace requires the password again after at most ${rule} minutes. You can choose more often, not less.`, rule: { recheckMax: rule } }), true;
    const cur = recheckPrefOf(me);
    if (cur && (!min || min > cur)) { const g = reauth(me, b?.password); if (g !== 'ok') return reauthFail(ctx, res, g, b?.password ? 'Password is wrong.' : 'Enter your password to be asked less often.'), true; }
    me.recheck = { min, at: Date.now() }; save(store);
    const now = Date.now(), eff = effectiveRecheck(me, wsr);
    for (const [t, s] of ctx.sessions) if (s.email === me.email) { s.recheckMin = eff; if (t === sess?.token) s.checkedAt = now; }
    ctx.persistSessions();
    if (me.workspace) ctx.withWorkspace(me.workspace, () => ctx.audit(sess, { action: 'recheck-settings', min }, true));
    return ctx.json(res, 200, { ok: true, min: eff, own: min }), true;
  }
  if (p === '/account/recheck' && m === 'POST') {
    if (!me || !sess?.token) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    const g = reauth(me, b?.password);
    if (g !== 'ok') { if (me.workspace) ctx.withWorkspace(me.workspace, () => ctx.audit(sess, { action: 'recheck-failed', why: g }, true)); return reauthFail(ctx, res, g), true; }
    const s = ctx.sessions.get(sess.token); if (s) { s.checkedAt = Date.now(); ctx.persistSessions(); }
    if (me.workspace) ctx.withWorkspace(me.workspace, () => ctx.audit(sess, { action: 'recheck' }, true));
    return ctx.json(res, 200, { ok: true }), true;
  }
  if (p === '/account/unlock' && m === 'POST') {
    if (!me || !sess?.token) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    const g = reauth(me, b?.password);
    if (g !== 'ok') {
      if (me.workspace) ctx.withWorkspace(me.workspace, () => ctx.audit(sess, { action: 'screen-unlock-failed', why: g }, true));
      return reauthFail(ctx, res, g), true;
    }
    const was = ctx.screenLock.unlock(sess.token);
    if (was && me.workspace) ctx.withWorkspace(me.workspace, () => ctx.audit(sess, { action: 'screen-unlock' }, true));
    return ctx.json(res, 200, { ok: true, unlocked: was }), true;
  }
  // T-0241 part 2: the signed-in devices list (sign out one device) and how long a sign-in lasts. Shorter is stricter and needs
  // nothing; longer, or keeping the sign-in after the browser closes, needs the password. A shorter length also cuts the sign-ins
  // that already exist down to the new length from now.
  if (p === '/account/sessions' && m === 'GET') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const now = Date.now(), list = [];
    for (const [t, s] of ctx.sessions) if (s.email === me.email && s.expires > now) list.push({ id: sessionId(t), current: t === sess?.token, kind: s.web ? 'browser' : 'other', device: deviceOf(s.ua), ip: s.ip || null, created: s.created || null, seen: s.seen || null, expires: s.expires, locked: !!s.lock });
    list.sort((a, b) => (b.current - a.current) || ((b.seen || 0) - (a.seen || 0)));
    return ctx.json(res, 200, { sessions: list, policy: effectiveSession(me, store.workspaces[me.workspace]), own: sessionPolicyOf(me), rule: { daysMax: wsSecurity(store.workspaces[me.workspace]).daysMax }, dayChoices: SESSION_DAY_CHOICES }), true;   // T-0241 part 3
  }
  if (p === '/account/sessions/revoke' && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    const id = String(b?.id || ''), hit = /^[a-f0-9]{16}$/.test(id) ? [...ctx.sessions].find(([t, s]) => s.email === me.email && sessionId(t) === id) : null;
    if (!hit) return ctx.json(res, 404, { error: 'No such signed-in device. It may have signed out already.' }), true;
    ctx.sessions.delete(hit[0]); ctx.persistSessions();
    const current = hit[0] === sess?.token;
    if (current) res.setHeader('Set-Cookie', 'chamber_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' + (ctx.cookieSecure ? '; Secure' : ''));
    if (me.workspace) ctx.withWorkspace(me.workspace, () => ctx.audit(sess, { action: 'session-revoke', device: deviceOf(hit[1].ua), current: current || undefined }, true));
    return ctx.json(res, 200, { ok: true, current }), true;
  }
  if (p === '/account/session-policy' && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    const b = await ctx.parseBody(req).catch(() => ({}));
    const days = Number(b?.days), remember = b?.remember !== false;
    if (!SESSION_DAY_CHOICES.includes(days)) return ctx.json(res, 400, { error: 'days must be 1, 7 or 30' }), true;
    if (b?.remember !== undefined && typeof b.remember !== 'boolean') return ctx.json(res, 400, { error: 'remember must be true or false' }), true;
    { const rs = wsSecurity(store.workspaces[me.workspace]); if (rs.daysMax && days > rs.daysMax) return ctx.json(res, 400, { error: `Your workspace allows sign-ins of at most ${rs.daysMax} day${rs.daysMax === 1 ? '' : 's'}. You can choose a shorter one, not a longer one.`, rule: { daysMax: rs.daysMax } }), true; }   // T-0241 part 3
    const cur = sessionPolicyOf(me), weaker = days > cur.days || (remember && !cur.remember);
    if (weaker) { const g = reauth(me, b?.password); if (g !== 'ok') return reauthFail(ctx, res, g, b?.password ? 'Password is wrong.' : 'Enter your password to keep sign-ins longer.'), true; }
    me.sessionPolicy = { days, remember, at: Date.now() }; save(store);
    const cap = Date.now() + days * 864e5; let shortened = 0;
    for (const s of ctx.sessions.values()) if (s.email === me.email && s.expires > cap) { s.expires = cap; shortened++; }
    if (shortened) ctx.persistSessions();
    if (me.workspace) ctx.withWorkspace(me.workspace, () => ctx.audit(sess, { action: 'session-policy', days, remember, shortened: shortened || undefined }, true));
    return ctx.json(res, 200, { ok: true, days, remember, shortened }), true;
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
    if (!perm.allows(myRole, 'ws.export')) return ctx.json(res, 403, { error: 'Only the workspace owner can export.' }), true;   // T-0246
    const dir = path.join(DATA_DIR, 'ws', myWs.id); const read = n => { try { return JSON.parse(wsfiles.readText(myWs.id, path.join(dir, n))); } catch { return null; } };   // T-0222: opened if sealed
    const out = { exported_at: new Date().toISOString(), workspace: { id: myWs.id, name: myWs.name, members: members(store, myWs.id).map(a => ({ username: a.username, role: a.email === myWs.owner ? 'owner' : 'member' })) },
                  chat: ctx.withWorkspace(myWs.id, () => { const d = ctx.loadDataFull(); return { users: d.users, rooms: d.rooms, messages: d.messages }; }),   // T-0017: from SQLite
                  tickets: read('tickets.json'), reviews: read('reviews.json'), agent_audit: read('audit.json'), agent_memory: read('memory.json'), tasks: read('tasks.json'),   // T-0059; T-0224 the task list
                  files: ctx.withWorkspace(myWs.id, () => ctx.listFiles()) };   // T-0064: metadata only; the bytes are in the backup's files/ directory
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="chamber-${myWs.name.replace(/[^A-Za-z0-9_-]+/g, '-')}-${new Date().toISOString().slice(0, 10)}.json"` });
    res.end(JSON.stringify(out, null, 2)); return true;
  }
  if (p === '/account/import' && m === 'POST') {                 // T-0079: read an export back into an EMPTY workspace (owner only). Dry-run reports counts + conflicts; ids are preserved.
    if (!me || !myWs) return ctx.json(res, 401, { error: 'not signed in' }), true;
    if (!perm.allows(myRole, 'ws.export')) return ctx.json(res, 403, { error: 'Only the workspace owner can import.' }), true;   // T-0246
    const b = await ctx.parseBody(req).catch(() => null);
    const exp = b && b.export;
    if (!exp || typeof exp !== 'object' || !exp.chat || typeof exp.chat !== 'object') return ctx.json(res, 400, { error: 'Upload a Chamber export file (the JSON from Account \u2192 Export).' }), true;
    { const bad = importUnsafe(exp); if (bad) return ctx.json(res, 400, { error: `This does not look like a file made by Chamber's Export: ${bad}. Nothing was imported.` }), true; }
    const dir = path.join(DATA_DIR, 'ws', myWs.id);
    const readJson = n => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } };
    const cur = ctx.withWorkspace(myWs.id, () => ctx.loadDataFull());
    const curT = readJson('tickets.json'); const curR = readJson('reviews.json'); const curM = readJson('memory.json'); const curK = readJson('tasks.json');
    const memNotes = curM ? Object.values(curM).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0) : 0;   // T-0102 F3: agent memory counts, so import can't clobber it
    const curFiles = (() => { try { return fs.readdirSync(path.join(dir, 'files')).filter(f => !f.endsWith('.part')).length; } catch { return 0; } })();   // T-0102 F3: existing uploads count too
    const nonEmpty = cur.messages.length > 0 || (curT && (curT.tickets || []).length > 0) || (curR && ((curR.reviews || curR || []).length) > 0) || memNotes > 0 || curFiles > 0 || !!(curK && (curK.items || []).length);
    const counts = {
      users: Object.keys(exp.chat.users || {}).length, rooms: Object.keys(exp.chat.rooms || {}).length, messages: (exp.chat.messages || []).length,
      tickets: (exp.tickets && (exp.tickets.tickets || []).length) || 0,
      reviews: exp.reviews ? ((exp.reviews.reviews || exp.reviews || []).length || 0) : 0,
      memory_notes: exp.agent_memory ? Object.values(exp.agent_memory).reduce((s, a) => s + (Array.isArray(a) ? a.length : 0), 0) : 0,
      tasks: exp.tasks && Array.isArray(exp.tasks.items) ? exp.tasks.items.length : 0, files: (exp.files || []).length };
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
      const stage = (name, val, pretty) => { if (val === undefined || val === null) return; const tmp = path.join(dir, name + '.importtmp'); fs.writeFileSync(tmp, wsfiles.encode(myWs.id, path.join(dir, name), JSON.stringify(val, null, pretty ? 2 : 0))); staged.push([tmp, path.join(dir, name)]); };   // T-0222
      stage('tickets.json', exp.tickets, true); stage('reviews.json', exp.reviews, true);
      stage('memory.json', exp.agent_memory, false); stage('audit.json', exp.agent_audit, false);
      if (exp.tasks) stage('tasks.json', tasksMod.sanitize(exp.tasks), false);   // T-0224: only well-formed tasks
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
      delete st.workspaces[ws.id]; wslock.setState(ws.id, null); wslock.forget(ws.id);   // T-0222
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
    if (myRole === 'requester') return ctx.json(res, 403, { error: 'A requester sees only their own requests, not the workspace.' }), true;   // T-0199 (the table says the same: ws.view)
    { const g = perm.gate(myRole, m, p); if (g) return ctx.json(res, g.status, { error: g.error }), true; }   // T-0246: the gate, as for /api/ (permissions.js)
    if (p === '/account/workspace/lock' || p.startsWith('/account/workspace/lock/')) {   // T-0222: the owner lock (the key is the owner's, so the owner switches it)
      if (!LOCK_FEATURE) return ctx.json(res, 404, { error: 'not found' }), true;
      if (m === 'GET' && p === '/account/workspace/lock') return ctx.json(res, 200, lockView(myWs, amOwner)), true;
      if (m !== 'POST') return ctx.json(res, 405, { error: 'GET or POST' }), true;
      if (!perm.allows(myRole, 'ws.lock')) return ctx.json(res, 403, { error: 'Only the workspace owner can lock or unlock it: the key is theirs.' }), true;   // T-0246
      const lb = (await ctx.parseBody(req).catch(() => ({}))) || {}, L = myWs.lock && myWs.lock.on ? myWs.lock : null;
      if (p === '/account/workspace/lock' && lb.on === true) {
        if (L) return ctx.json(res, 409, { error: 'The owner lock is already on.' }), true;
        const k = ownerKeyNow(myWs);
        if (!k || k.by !== me.username) return ctx.json(res, 400, { error: 'Set your passphrase first (Account, Activity & audit, Passphrase for saved copies). The lock opens with the same passphrase.' }), true;
        const dk = wscrypt.newKey();
        myWs.lock = { on: true, state: 'sealing', key: k.id, wrapped: wrapForOwner(k.pub, dk), check: wscrypt.keyCheck(dk), since: Date.now(), by: me.username };
        save(store); wslock.setState(myWs.id, 'sealing'); await wslock.open(myWs.id, dk); dk.fill(0);
        ctx.audit(sess, { action: 'lock-on', key: k.id }, true);
        ctx.lockConvert(myWs.id, 'seal');                                         // carries on in the background
        return ctx.json(res, 200, lockView(myWs, true)), true;
      }
      if (p === '/account/workspace/lock' && lb.on === false) {
        if (!L) return ctx.json(res, 409, { error: 'The owner lock is not on.' }), true;
        if (wslock.locked(myWs.id)) return ctx.json(res, 423, { error: 'Unlock the workspace first: it cannot be turned back into plain files while it is locked.', locked: true }), true;
        { const g = reauth(me, lb.password); if (g !== 'ok') return reauthFail(ctx, res, g), true; }
        L.state = 'unsealing'; save(store); wslock.setState(myWs.id, 'unsealing');
        ctx.audit(sess, { action: 'lock-off' }, true);
        ctx.lockConvert(myWs.id, 'unseal');
        return ctx.json(res, 200, lockView(myWs, true)), true;
      }
      if (p === '/account/workspace/lock/unlock') {                              // the browser opened the workspace key with the passphrase and sends it here, over https
        if (!L) return ctx.json(res, 409, { error: 'The owner lock is not on.' }), true;
        const hex = String(lb.key || '');
        if (!/^[a-f0-9]{64}$/i.test(hex)) return ctx.json(res, 400, { error: 'key must be the workspace key (64 hex characters), as the Account page sends it.' }), true;
        const dk = Buffer.from(hex, 'hex'), want = Buffer.from(String(L.check), 'hex'), got = Buffer.from(wscrypt.keyCheck(dk), 'hex');
        if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) { dk.fill(0); return ctx.json(res, 403, { error: 'That key does not open this workspace.' }), true; }
        const was = wslock.locked(myWs.id); await wslock.open(myWs.id, dk); dk.fill(0);
        if (was) ctx.audit(sess, { action: 'unlocked' }, true);
        if (L.state === 'sealing' || L.state === 'unsealing') ctx.lockConvert(myWs.id, L.state === 'sealing' ? 'seal' : 'unseal');
        return ctx.json(res, 200, lockView(myWs, true)), true;
      }
      if (p === '/account/workspace/lock/close') {                               // lock it now, by hand: the key is forgotten until the owner unlocks again
        if (!L) return ctx.json(res, 409, { error: 'The owner lock is not on.' }), true;
        if (L.state === 'unsealing') return ctx.json(res, 409, { error: 'The lock is being switched off; wait until that is finished.' }), true;
        if (!wslock.locked(myWs.id)) ctx.audit(sess, { action: 'locked-by-hand' }, true);
        await wslock.forget(myWs.id); ctx.lockClosed(myWs.id);
        return ctx.json(res, 200, lockView(myWs, true)), true;
      }
      return ctx.json(res, 400, { error: 'POST /account/workspace/lock {on: true | false (with password)}, /account/workspace/lock/unlock {key}, or /account/workspace/lock/close' }), true;
    }
    if (p === '/account/workspace' && m === 'GET') {
      let seen = {}; try { seen = ctx.withWorkspace(myWs.id, () => ctx.loadData().users) || {}; } catch (e) { if (!e.locked) throw e; }   // T-0222: not known while locked                                   // T-0034: last activity per member
      const roleOf = (a) => wsRoleOf(a, myWs);                                                                   // T-0199
      return ctx.json(res, 200, {
        id: myWs.id, name: myWs.name, role: roleOf(me), canManage: amAdmin, owner: store.accounts[myWs.owner]?.username || null, plan: billingState(store.accounts[myWs.owner]) === 'free' ? 'free' : 'team', freePeople: freePeopleFor(myWs),   // T-0225; T-0288; T-0295: an earlier workspace keeps the old size until its notice has run
        members: members(store, myWs.id).map(a => ({ username: a.username, role: roleOf(a) === 'viewer' && a.approves ? 'approver' : roleOf(a), email: amAdmin ? a.email : undefined, chatRole: a.chatRole || 'human',
                                                      lastSeen: seen[a.username]?.lastSeen || null, joinedAt: a.createdAt || null })),
        inviteUrl: amAdmin ? `${PUBLIC_URL}/join/${myWs.invite}` : null,
        inviteUrls: amAdmin ? Object.fromEntries(INVITE_KINDS.map(r => [r, myWs.invites && myWs.invites[r] ? `${PUBLIC_URL}/join/${myWs.invites[r]}` : null])) : null,   // T-0199
        seats: { full: fullMembers(store, myWs.id).length, maxFull: builderLimit(store, myWs), guests: guestMembers(store, myWs.id).length, maxGuests: guestsUnlimited(store, myWs) ? null : MAX_GUESTS }, sizePlan: planOf(store, myWs), legacy: legacyWs(myWs) || undefined,   // T-0199; T-0295: builders by plan, guests unlimited when paid   // T-0199
        approval: approvalRules(myWs),                                           // T-0190
        requestDrafts: !myWs.requestDraftsOff,                                   // T-0207
        agentTasks: myWs.agentTasks === true,                                    // T-0245
        security: wsSecurity(myWs),                                              // T-0241 part 3
        report: amAdmin ? reportView(myWs) : null,                               // T-0202
        budget: budgetOf(myWs.id),                                               // T-0203
        fleet: myWs.fleet ? { linked: true, tenant: myWs.fleet.tenant || '', by: myWs.fleet.by, at: myWs.fleet.at, state: myWs.fleet.state || 'ok', lastError: myWs.fleet.lastError || null } : { linked: false },   // T-0153: never the key
        agentPolicy: myWs.agentPolicy || 'owner',
        retentionDays: myWs.retentionDays || 0,                                  // T-0037: 0 = keep forever
        recordDays: myWs.recordDays || 0, recordCopy: !!myWs.recordCopy, ownerKey: ownerKeyView(myWs, me, false),   // T-0219: 0 = the record is kept for good
        lock: LOCK_FEATURE || (myWs.lock && myWs.lock.on) ? lockView(myWs, amOwner) : undefined,   // T-0222
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
        if (!perm.allows(myRole, 'audit.export')) return ctx.json(res, 403, { error: 'Only the workspace owner or an admin can export the audit log.' }), true;   // T-0246
        const all = ctx.auditAll(dir).filter(match);
        const filtered = !!(q || actor || action || since || until !== Infinity), ch = filtered ? null : ctx.verifyAudit(dir);   // T-0194: before the export adds its own entry
        ctx.audit(sess, { action: 'audit-export', format, entries: all.length }, true);
        const name = `chamber-audit-${myWs.name.replace(/[^A-Za-z0-9_-]+/g, '_')}-${new Date().toISOString().slice(0, 10)}.${format}`;
        if (format === 'json') { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${name}"` }); res.end(JSON.stringify({ workspace: myWs.name, exported_at: new Date().toISOString(), chain: ch ? { ok: ch.ok, n: ch.n, head: ch.head, trimmed_upto: ch.trimmedUpto || 0, how: 'node tools/verify-audit.js <this file> checks it without the server' } : { partial: true, how: 'This export is filtered, so it cannot be checked as a whole. Export without a filter to check it.' }, entries: all })); return true; }
        const cols = ['ts', 'time_utc', 'actor', 'kind', 'action', 'target', 'details', 'request_id', 'ip'];
        const cell = (v) => { const s = v === undefined || v === null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        const rows = all.map(r => { const { ts, actor: a, agent, kind, action: act, rid, ip, ...rest } = r; const target = rest.ticket || rest.id || rest.room || rest.review || rest.username || rest.target || ''; return [ts, new Date(ts).toISOString(), a || agent || '', kind || (agent ? 'agent' : 'human'), act || '', target, JSON.stringify(rest), rid || '', ip || ''].map(cell).join(','); });
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` }); res.end(cols.join(',') + '\n' + rows.join('\n') + '\n'); return true;
      }
      let log = []; try { log = JSON.parse(wsfiles.readText(myWs.id, path.join(dir, 'audit.json'))); } catch { /* none yet */ }   // T-0222: opened if sealed
      const filtered = log.filter(match);
      return ctx.json(res, 200, { audit: filtered.slice(-300).reverse(), total: filtered.length, actors: [...new Set(log.map(r => r.actor || r.agent).filter(Boolean))].sort() }), true;
    }
    if (!amAdmin) return ctx.json(res, 403, { error: 'Only the workspace owner or an admin can do that.' }), true;   // T-0034. T-0246: a fence; the gate above already refused by the table, and every route below has a row
    const b = await ctx.parseBody(req).catch(() => ({}));
    const ownerOnly = () => ctx.json(res, 403, { error: 'Only the workspace owner can do that.' });
    // ── T-0219: the owner's key for sealed copies of the record, and the copies. Owner only: the wrapped private key and the
    // copies go to nobody else. The server keeps the PUBLIC key (to seal with) and the private key only as the browser wrapped
    // it with the owner's passphrase and with a recovery code; it never sees either secret, so it can never open a copy.
    if (p === '/account/workspace/ownerkey' && m === 'GET') {
      if (!perm.allows(myRole, 'ws.records')) return ownerOnly(), true;   // T-0246
      return ctx.json(res, 200, ownerKeyView(myWs, me, true)), true;
    }
    if (p === '/account/workspace/ownerkey' && m === 'POST') {
      if (!perm.allows(myRole, 'ws.records')) return ownerOnly(), true;   // T-0246
      const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9+/=]+$/.test(v);
      const wrapOk = w => w && str(w.wrapped, 8192) && str(w.salt, 64) && str(w.iv, 64) && Number.isInteger(w.iter) && w.iter >= 100000 && w.iter <= 5000000;
      const wrapOf = w => ({ wrapped: w.wrapped, salt: w.salt, iv: w.iv, iter: w.iter });
      const keys = ownerKeys(myWs);
      if (b?.rewrap !== undefined) {                                   // a new passphrase (or recovery code) for the same key: older copies stay openable
        const k = keys.find(x => x.id === b.rewrap); if (!k) return ctx.json(res, 404, { error: 'No such key.' }), true;
        if (!wrapOk(b) || (b.rec !== undefined && !wrapOk(b.rec))) return ctx.json(res, 400, { error: 'The wrapped key is not in the expected form.' }), true;
        Object.assign(k, wrapOf(b)); if (b.rec) k.rec = wrapOf(b.rec); k.changed = Date.now();
        save(store); ctx.audit(sess, { action: 'owner-key-passphrase', key: k.id }, true);
        return ctx.json(res, 200, ownerKeyView(myWs, me, true)), true;
      }
      const pk = records.checkPublicKey(b?.pub);
      if (!pk.ok) return ctx.json(res, 400, { error: 'That key cannot be used: ' + pk.why + '.' }), true;
      if (!wrapOk(b) || !wrapOk(b.rec)) return ctx.json(res, 400, { error: 'The wrapped key is not in the expected form.' }), true;
      if (keys.length >= 10) return ctx.json(res, 400, { error: 'This workspace already had ten keys. Write to support.' }), true;
      const id = keys.reduce((n, k) => Math.max(n, k.id), 0) + 1;
      if (myWs.lock && myWs.lock.on) {                                  // T-0222: the workspace key is wrapped for the owner's key; a new key takes it over
        const wdk = wslock.key(myWs.id);
        if (!wdk) return ctx.json(res, 423, { error: 'This workspace is locked with your earlier passphrase. Unlock it first with that passphrase or its recovery code; a new passphrase cannot open what the earlier one locked.', locked: true }), true;
        myWs.lock.wrapped = wrapForOwner(b.pub, wdk); myWs.lock.key = id;
      }
      myWs.ownerKeys = [...keys, { id, pub: b.pub, ...wrapOf(b), rec: wrapOf(b.rec), created: Date.now(), by: me.username }];
      save(store); ctx.audit(sess, { action: 'owner-key-set', key: id, bits: pk.bits }, true);
      return ctx.json(res, 200, ownerKeyView(myWs, me, true)), true;
    }
    const savedM = p.match(/^\/account\/workspace\/records-saved(?:\/([A-Za-z0-9.-]{1,80}))?(\/delete)?$/);
    if (savedM) {
      if (!perm.allows(myRole, 'ws.records')) return ownerOnly(), true;   // T-0246
      const dir = path.join(DATA_DIR, 'ws', myWs.id);
      if (!savedM[1] && m === 'GET') return ctx.json(res, 200, { copies: records.listSaved(dir) }), true;
      if (!savedM[1] && m === 'POST') {                                 // "Save a sealed copy now": the whole record as it stands, nothing deleted
        const k = ownerKeyNow(myWs);
        if (!k || k.by !== me.username) return ctx.json(res, 400, { error: 'Set your passphrase for saved copies first.' }), true;
        const v = ctx.verifyAudit(dir), entries = ctx.auditAll(dir);   // before this request adds its own entry
        let made; try { made = records.saveCopy(dir, { entries, ownerKey: { id: k.id, pub: k.pub }, workspace: myWs.name, reason: 'manual',
          chain: v.ok ? { ok: true, n: v.n, head: v.head, trimmed_upto: (v.trimmed && v.trimmed.upto) || 0, how: 'node tools/verify-audit.js <this file> checks it without the server' } : { partial: true } }); }
        catch (e) { return ctx.json(res, 400, { error: e.message.charAt(0).toUpperCase() + e.message.slice(1) + '.' }), true; }
        ctx.audit(sess, { action: 'record-copy-saved', name: made.name, entries: made.entries }, true);
        return ctx.json(res, 200, { ok: true, copy: made, copies: records.listSaved(dir) }), true;
      }
      if (savedM[1] && !savedM[2] && m === 'GET') {
        const text = records.readSaved(dir, savedM[1]); if (!text) return ctx.json(res, 404, { error: 'No such copy.' }), true;
        ctx.audit(sess, { action: 'record-copy-download', name: savedM[1] }, true);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${savedM[1]}"`, 'Cache-Control': 'no-store' }); res.end(text); return true;
      }
      if (savedM[1] && savedM[2] && m === 'POST') {
        if (!records.removeSaved(dir, savedM[1])) return ctx.json(res, 404, { error: 'No such copy.' }), true;
        ctx.audit(sess, { action: 'record-copy-deleted', name: savedM[1] }, true);
        return ctx.json(res, 200, { ok: true, copies: records.listSaved(dir) }), true;
      }
      return ctx.json(res, 405, { error: 'GET or POST' }), true;
    }
    if (p === '/account/workspace/fleet' && m === 'POST') {      // T-0153: link this workspace to a GhostPort fleet tenant (read-only router status), or unlink
      if (!perm.allows(myRole, 'fleet.link')) return ownerOnly(), true;   // T-0246
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
      myWs.report = myWs.report || {}; let asked = [];
      if (b?.recipients !== undefined) {
        const list = [...new Set((Array.isArray(b.recipients) ? b.recipients : String(b.recipients).split(/[,\s]+/)).map(s => String(s).trim().toLowerCase()).filter(Boolean))];
        if (list.length > 10) return ctx.json(res, 400, { error: 'At most 10 people get the report by email.' }), true;
        const bad = list.filter(e => !EMAIL_RE.test(e)); if (bad.length) return ctx.json(res, 400, { error: `Not an email address: ${bad.slice(0, 3).join(', ')}` }), true;
        asked = reportSetRecipients(store, myWs, list, me.username);                              // T-0217: new addresses are asked first
      }
      if (b?.enabled !== undefined) myWs.report.enabled = !!b.enabled;
      if (myWs.report.enabled && !(myWs.report.recipients || []).length) return ctx.json(res, 400, { error: 'Add at least one email address before switching the email on.' }), true;
      if (b?.link === 'make') myWs.report.token = crypto.randomBytes(18).toString('base64url');
      if (b?.link === 'off') delete myWs.report.token;
      save(store); ctx.audit(sess, { action: 'report-settings', enabled: !!myWs.report.enabled, recipients: (myWs.report.recipients || []).length, link: b?.link || undefined }, true);
      return ctx.json(res, 200, { ok: true, report: reportView(myWs), asked }), true;
    }
    if (p === '/account/workspace/role' && m === 'POST') {       // T-0034: owner promotes/demotes a member
      if (!perm.allows(myRole, 'ws.roles')) return ownerOnly(), true;   // T-0246
      const target = Object.values(store.accounts).find(a => a.username.toLowerCase() === String(b?.username || '').toLowerCase() && a.workspace === myWs.id);
      if (!target) return ctx.json(res, 404, { error: 'No such member in your workspace.' }), true;
      if (target.email === myWs.owner) return ctx.json(res, 400, { error: 'The owner already has every permission. Use Transfer to hand the workspace over.' }), true;
      if (!['admin', 'member', 'viewer', 'requester', 'approver'].includes(b?.role)) return ctx.json(res, 400, { error: 'role must be admin, member, approver, viewer or requester' }), true;   // T-0199; T-0295: + approver
      const asApprover = b.role === 'approver'; if (asApprover) b.role = 'viewer';                                   // an approver is a viewer who may approve by default
      const toGuest = GUEST_ROLES.includes(b.role), wasGuest = GUEST_ROLES.includes(wsRoleOf(target, myWs));
      if (toGuest && (target.chatRole || 'human') !== 'human') return ctx.json(res, 400, { error: 'An AI account cannot be a viewer or requester.' }), true;
      if (!toGuest && wasGuest && fullMembers(store, myWs.id).length >= builderLimit(store, myWs)) return ctx.json(res, 409, { error: `No free builder seat: this workspace's plan covers ${builderLimit(store, myWs)} builders. Make someone an approver or a viewer first, or move to a bigger plan.` }), true;   // T-0295: by plan
      if (toGuest && !wasGuest && !guestsUnlimited(store, myWs) && guestMembers(store, myWs.id).length >= MAX_GUESTS) return ctx.json(res, 409, { error: `No free place for viewers and requesters (${MAX_GUESTS}).` }), true;
      target.wsRole = b.role; if (asApprover) target.approves = true; else delete target.approves; save(store);
      if (asApprover) b.role = 'approver';                                                                           // what the record and the answer say
      console.log(`[accounts] ${me.username} made ${target.username} ${b.role} in ${myWs.id}`); ctx.audit(sess, { action: 'member-role', username: target.username, role: b.role }, true);   // T-0057
      return ctx.json(res, 200, { ok: true, username: target.username, role: b.role }), true;
    }
    if (p === '/account/workspace/transfer' && m === 'POST') {   // T-0034: hand the workspace (and its subscription) to another human member
      if (!perm.allows(myRole, 'ws.transfer')) return ownerOnly(), true;   // T-0246
      if (myWs.lock && myWs.lock.on) return ctx.json(res, 400, { error: 'Switch the owner lock off first: the workspace is locked with your key, and the new owner could not open it.' }), true;   // T-0222
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
        if (!perm.allows(myRole, 'ws.settings')) return ownerOnly(), true;   /* T-0246 */
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
        if (!perm.allows(myRole, 'ws.settings')) return ownerOnly(), true;   /* T-0246 */
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
        if (!perm.allows(myRole, 'ws.settings')) return ownerOnly(), true;   /* T-0246 */
        if (typeof b.requestDrafts !== 'boolean') return ctx.json(res, 400, { error: 'requestDrafts must be true or false' }), true;
        if (b.requestDrafts) delete myWs.requestDraftsOff; else myWs.requestDraftsOff = true;
        ctx.audit(sess, { action: 'request-drafts', on: b.requestDrafts }, true);
      }
      if (b?.agentTasks !== undefined) {                                                                             // T-0245: may agents see the Tasks list?
        if (!perm.allows(myRole, 'ws.settings')) return ownerOnly(), true;
        if (typeof b.agentTasks !== 'boolean') return ctx.json(res, 400, { error: 'agentTasks must be true or false' }), true;
        if (b.agentTasks) myWs.agentTasks = true; else delete myWs.agentTasks;
        ctx.audit(sess, { action: 'agent-tasks', on: b.agentTasks }, true);
      }
      if (b?.agentPolicy !== undefined) {
        if (!perm.allows(myRole, 'ws.settings')) return ownerOnly(), true;   /* T-0246 */                                                                        // T-0034: policy is the owner's call
        if (!['owner', 'members'].includes(b.agentPolicy)) return ctx.json(res, 400, { error: 'agentPolicy must be owner or members' }), true;
        myWs.agentPolicy = b.agentPolicy; ctx.audit(sess, { action: 'agent-policy', policy: b.agentPolicy }, true);   // T-0057
      }
      if (b?.retentionDays !== undefined) {                                                                          // T-0037
        if (!perm.allows(myRole, 'ws.settings')) return ownerOnly(), true;   /* T-0246 */
        const d = parseInt(b.retentionDays, 10);
        if (!Number.isInteger(d) || d < 0 || (d > 0 && d < 7) || d > 3650) return ctx.json(res, 400, { error: 'retentionDays must be 0 (keep forever) or between 7 and 3650' }), true;
        myWs.retentionDays = d; console.log(`[accounts] ${me.username} set retention ${d || 'forever'} for ${myWs.id}`); ctx.audit(sess, { action: 'retention', days: d }, true);   // T-0057
      }
      if (b?.recordDays !== undefined || b?.recordCopy !== undefined) {                                              // T-0219: how long the who-did-what record is kept
        if (!perm.allows(myRole, 'ws.settings')) return ownerOnly(), true;   /* T-0246 */
        const d = b.recordDays !== undefined ? parseInt(b.recordDays, 10) : (myWs.recordDays || 0), copy = b.recordCopy !== undefined ? b.recordCopy === true : !!myWs.recordCopy, k = ownerKeyNow(myWs);
        if (!Number.isInteger(d) || d < 0 || (d > 0 && d < records.MIN_DAYS) || d > records.MAX_DAYS) return ctx.json(res, 400, { error: `Keep the record for good (0), or for ${records.MIN_DAYS} to ${records.MAX_DAYS} days.` }), true;
        if (copy && !(k && k.by === me.username)) return ctx.json(res, 400, { error: 'Set your passphrase for saved copies first. Without it nobody could open them.' }), true;
        myWs.recordDays = d; myWs.recordCopy = copy; console.log(`[accounts] ${me.username} set the record to ${d ? d + ' days' : 'for good'}${copy ? ' with sealed copies' : ''} for ${myWs.id}`);
        ctx.audit(sess, { action: 'record-retention', days: d, copy }, true);
      }
      if (b?.security !== undefined) {                                                                               // T-0241 part 3: the owner's rules for everyone
        if (!perm.allows(myRole, 'ws.settings')) return ownerOnly(), true;
        const s = b.security && typeof b.security === 'object' ? b.security : {};
        const next = { idleMax: Number(s.idleMax) || 0, reopen: s.reopen === true, daysMax: Number(s.daysMax) || 0, require2fa: s.require2fa === true, recheckMax: Number(s.recheckMax) || 0 };
        if (next.recheckMax && !RECHECK_CHOICES.includes(next.recheckMax)) return ctx.json(res, 400, { error: 'recheckMax must be 0 (no rule), 5, 15 or 60 minutes' }), true;   // T-0241 part 4
        if (next.idleMax && !LOCK_IDLE_CHOICES.includes(next.idleMax)) return ctx.json(res, 400, { error: 'idleMax must be 0 (no rule), 5, 15, 30 or 60 minutes' }), true;
        if (next.daysMax && !SESSION_DAY_CHOICES.includes(next.daysMax)) return ctx.json(res, 400, { error: 'daysMax must be 0 (no rule), 1, 7 or 30 days' }), true;
        if (next.require2fa && !twoStep(me)) return ctx.json(res, 400, { error: 'Turn on two-step sign-in for yourself first (Security, on this page: the authenticator app, or a passkey at sign-in). You cannot require it of others before you use it.' }), true;
        const cur = wsSecurity(myWs), looser = (cur.idleMax && (!next.idleMax || next.idleMax > cur.idleMax)) || (cur.reopen && !next.reopen) || (cur.daysMax && (!next.daysMax || next.daysMax > cur.daysMax)) || (cur.require2fa && !next.require2fa) || (cur.recheckMax && (!next.recheckMax || next.recheckMax > cur.recheckMax));
        if (looser) { const g = reauth(me, b?.password); if (g !== 'ok') return reauthFail(ctx, res, g, b?.password ? 'Password is wrong.' : 'Enter your password to make the rules less strict.'), true; }
        if (next.idleMax || next.reopen || next.daysMax || next.require2fa || next.recheckMax) myWs.security = { ...next, at: Date.now(), by: me.username }; else delete myWs.security;
        const now = Date.now(); let applied = 0;                                                                    // the rules apply at once to every sign-in of everyone here
        for (const ss of ctx.sessions.values()) { const a = ss.email && store.accounts[ss.email]; if (!a || a.workspace !== myWs.id) continue;
          const eff = effectiveLock(a, myWs); ss.lockIdle = eff.lockIdle; ss.lockReopen = eff.lockReopen; ss.recheckMin = effectiveRecheck(a, myWs);
          if (next.daysMax && ss.expires > now + next.daysMax * 864e5) ss.expires = now + next.daysMax * 864e5; applied++; }
        ctx.persistSessions();
        ctx.audit(sess, { action: 'security-rules', ...next, sessions: applied }, true);
      }
      if (b?.name !== undefined) {
        const name = String(b.name || '').trim().slice(0, 48);
        if (name.length < 2) return ctx.json(res, 400, { error: 'Name must be 2 to 48 characters.' }), true;
        myWs.name = name; ctx.audit(sess, { action: 'workspace-rename', name }, true);   // T-0057
      }
      save(store);
      return ctx.json(res, 200, { ok: true, name: myWs.name, agentPolicy: myWs.agentPolicy || 'owner', retentionDays: myWs.retentionDays || 0, recordDays: myWs.recordDays || 0, recordCopy: !!myWs.recordCopy, requestDrafts: !myWs.requestDraftsOff, agentTasks: myWs.agentTasks === true, security: wsSecurity(myWs), approval: approvalRules(myWs), approvalWarning, budget: budgetOf(myWs.id) }), true;
    }
    if (p === '/account/workspace/invite-reset' && m === 'POST') {
      if (!verified(me)) return ctx.json(res, 403, { error: 'Confirm your email address first (account page).', needsVerification: true }), true;   // T-0032
      const role = b?.role === undefined ? 'member' : b.role;                                    // T-0199: member, viewer or requester link
      if (!['member', ...INVITE_KINDS].includes(role)) return ctx.json(res, 400, { error: 'role must be member, approver, viewer or requester' }), true;   // T-0295: + approver
      if (role === 'member') { myWs.invite = newInvite(); save(store); ctx.audit(sess, { action: 'invite-rotate' }, true); return ctx.json(res, 200, { ok: true, inviteUrl: `${PUBLIC_URL}/join/${myWs.invite}` }), true; }   // T-0057
      myWs.invites = myWs.invites || {};
      if (b?.off) { delete myWs.invites[role]; save(store); ctx.audit(sess, { action: 'invite-off', role }, true); return ctx.json(res, 200, { ok: true, inviteUrl: null }), true; }
      myWs.invites[role] = newInvite(); save(store); ctx.audit(sess, { action: 'invite-rotate', role }, true);
      return ctx.json(res, 200, { ok: true, role, inviteUrl: `${PUBLIC_URL}/join/${myWs.invites[role]}` }), true;
    }
    if (p === '/account/workspace/tokens' && m === 'GET') {
      return ctx.json(res, 200, { tokens: Object.values(myWs.tokens || {}).map(t => ({ id: t.id, name: t.name, username: t.username, createdAt: t.createdAt, lastUsed: t.lastUsed || null, mayAsk: !!t.mayAsk, answersAgents: !!t.answersAgents })) }), true;   // T-0317: + answersAgents
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
        schedules: (myWs.schedules || []).map(s => ({ ...s, text: scheduleText(myWs.id, s) ?? '(locked)', nextRun: s.enabled ? (cron.next(s.spec, s.tz, now)?.getTime() || null) : null })),
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
      const sid = crypto.randomBytes(4).toString('hex'), s = { id: sid, spec, tz, room, text: schedSeal(myWs.id, sid, text), by: me.username, enabled: true, createdAt: Date.now(), lastRun: null, runs: 0, once: !!b?.once };   // T-0069: once = a reminder; it disables itself after firing
      (myWs.schedules ||= []).push(s); save(store);
      ctx.audit(sess, { action: 'schedule-create', id: s.id, spec, tz, room }, true);
      return ctx.json(res, 201, { ok: true, schedule: { ...s, text, nextRun: cron.next(spec, tz)?.getTime() || null } }), true;
    }
    const schedMatch = p.match(/^\/account\/workspace\/schedules\/([a-f0-9]{8})$/);
    if (schedMatch && m === 'POST') {                                // T-0058: toggle / delete
      const s = (myWs.schedules || []).find(x => x.id === schedMatch[1]); if (!s) return ctx.json(res, 404, { error: 'No such schedule.' }), true;
      if (b?.delete) { myWs.schedules = myWs.schedules.filter(x => x.id !== s.id); save(store); ctx.audit(sess, { action: 'schedule-delete', id: s.id }, true); return ctx.json(res, 200, { ok: true }), true; }
      if (b?.enabled !== undefined) { s.enabled = !!b.enabled; save(store); ctx.audit(sess, { action: 'schedule-toggle', id: s.id, enabled: s.enabled }, true); }
      return ctx.json(res, 200, { ok: true, schedule: { ...s, text: scheduleText(myWs.id, s) } }), true;
    }
    if (p === '/account/workspace/mirrors' && m === 'POST') {       // T-0062: forward a room to Slack / Discord / any JSON endpoint
      const room = String(b?.room || 'general'); const rooms = ctx.withWorkspace(myWs.id, () => ctx.loadData().rooms);
      if (!rooms[room] || rooms[room].dm) return ctx.json(res, 400, { error: 'Pick an existing room (not a DM).' }), true;
      const kind = ['slack', 'discord', 'generic'].includes(b?.kind) ? b.kind : null; if (!kind) return ctx.json(res, 400, { error: 'kind must be slack, discord or generic' }), true;
      let u; try { u = new URL(String(b?.url || '')); } catch { u = null; }
      if (!u || u.protocol !== 'https:' || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(u.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname) || !netguard.publicHost(u.hostname)) return ctx.json(res, 400, { error: 'Mirror URL must be https and public (Slack incoming webhook, Discord webhook, or your own endpoint).' }), true;
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
      if (!perm.allows(myRole, 'agents.askswitch')) return ctx.json(res, 403, { error: 'Only the workspace owner can do that.' }), true;   // T-0246
      const t = myWs.tokens?.[String(b?.id || '')];
      if (!t) return ctx.json(res, 404, { error: 'No such token.' }), true;
      t.mayAsk = !!b?.on; save(store); ctx.audit(sess, { action: 'agent-may-ask', username: t.username, on: t.mayAsk }, true);
      return ctx.json(res, 200, { ok: true, mayAsk: t.mayAsk }), true;
    }
    if (p === '/account/workspace/tokens/peers' && m === 'POST') {   // T-0317: may this agent answer other agents' questions (read-only, no orders)? Off by default; the owner decides per agent
      if (!perm.allows(myRole, 'agents.peerswitch')) return ctx.json(res, 403, { error: 'Only the workspace owner can do that.' }), true;
      const t = myWs.tokens?.[String(b?.id || '')];
      if (!t) return ctx.json(res, 404, { error: 'No such token.' }), true;
      t.answersAgents = !!b?.on; save(store); ctx.audit(sess, { action: 'agent-answers-agents', username: t.username, on: t.answersAgents }, true);
      return ctx.json(res, 200, { ok: true, answersAgents: t.answersAgents }), true;
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

  // T-0311: the Billing tab. The owner and admins see the plan, the next charge, founding and the storage bar; everyone else is
  // refused, so approvers, viewers and requesters never see a price. Only the OWNER changes anything (their answer, 20 Nov):
  // for an admin the tab is read-only (canChange false) and preview, plan and storage refuse them (ws.billing).
  if (p === '/billing/overview' && m === 'GET') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    if (!myWs || !perm.allows(myRole, 'ws.billing.view')) return ctx.json(res, 403, { error: 'Only the workspace owner or an admin can see billing.' }), true;
    if (SELF_HOSTED) return ctx.json(res, 200, { selfHosted: true }), true;
    const P = store.accounts[myWs.owner]; if (!P) return ctx.json(res, 404, { error: 'This workspace has no owner.' }), true;
    const st = billingState(P), plan = P.subscription && ['ok', 'grace', 'readonly'].includes(st) ? (P.plan === 'company' ? 'company' : 'team') : null, iv = periodOf(P);
    const packs = storagePacksOf(P), baseMb = plan ? limitMbOf(plan, 0) : null, usedB = usedBytesOf(ctx, myWs);
    const sold = Object.values(store.accounts).reduce((n, a) => n + (a.subscription && a.email !== P.email ? (a.storagePacks || 0) : 0), 0);
    let next = null;
    if (plan && P.subStatus === 'active' && !P.cancelAtPeriodEnd && P.stripeCustomer) { const inv = await previewInvoice(P, {}); if (inv) next = { amount: inv.amount_due, currency: inv.currency || 'usd', at: inv.next_payment_attempt || inv.period_end || P.periodEnd || null }; }
    const may = perm.allows(myRole, 'ws.billing');
    return ctx.json(res, 200, { isOwner: P.email === me.email, owner: P.username, role: myRole, state: st, plan, interval: plan ? iv : null, price: plan ? priceLabelOf(P, myWs) : null,
      status: P.subStatus || null, periodEnd: P.periodEnd || null, cancelAtPeriodEnd: !!P.cancelAtPeriodEnd, paymentFailed: !!P.paymentFailedAt && st !== 'ok', graceEndsAt: st === 'grace' ? graceEndsAt(P) : null, next,
      founding: P.founding ? { n: P.founding.n, label: P.founding.label || null } : null, trial: st === 'trial', trialEndsAt: onTrialClock(P) ? P.trialEndsAt : null, free: st === 'free',
      builders: { n: fullMembers(store, myWs.id).length, team: planCap(myWs, 'team'), company: planCap(myWs, 'company') }, plans: planList(myWs), teamMb: limitMbOf('team', 0), companyMb: limitMbOf('company', 0),
      storage: { offered: STORAGE_ON(), usedBytes: usedB, baseMb, packs, packGb: STORAGE_PACK_GB, maxPacks: STORAGE_MAX_PACKS, limitMb: plan ? limitMbOf(plan, packs) : null, label: STORAGE_PRICES[iv] ? STORAGE_LABELS[iv] : '',
                 labels: STORAGE_LABELS, soldOut: (sold + packs + 1) * STORAGE_PACK_GB > STORAGE_SELLABLE_GB, paused: !!P.subscription && (P.storagePacks || 0) > 0 && packs === 0, biggest: biggestFiles(ctx, myWs) },
      canChange: may && !!plan && P.subStatus === 'active' && !P.cancelAtPeriodEnd, canSubscribe: may && !plan, canCancel: may && !!plan && P.subStatus === 'active', canPortal: may && !!P.stripeCustomer }), true;
  }
  // Billing API (needs a signed-in account)
  if (p.startsWith('/billing/') && m === 'POST') {
    if (!me) return ctx.json(res, 401, { error: 'not signed in' }), true;
    if (SELF_HOSTED) return ctx.json(res, 400, { error: 'This Chamber is self-hosted: there is no subscription to manage.' }), true;   // T-0061
    try {
      if (p === '/billing/checkout') {
        if (entitled(me, store) && !onTrialClock(me)) return ctx.json(res, 200, { url: '/app' }), true;   // T-0159: someone on (or past) the free trial may subscribe
        if (!perm.allows(myRole, 'ws.billing')) return ctx.json(res, 400, { error: `Your workspace is paid for by its owner (${store.accounts[myWs?.owner]?.username || 'the owner'}).` }), true;
        if (!verified(me)) return ctx.json(res, 403, { error: 'Confirm your email address first (check your inbox for the link, or resend it below).', needsVerification: true }), true;   // T-0032
        if (!me.stripeCustomer) {
          const c = await stripe('POST', 'customers', { email: me.email, metadata: { chamber_username: me.username, chamber_workspace: me.workspace } });
          me.stripeCustomer = c.id;
          const fresh = load(); if (fresh.accounts[me.email]) { fresh.accounts[me.email].stripeCustomer = c.id; save(fresh); }   // re-read: the call above waited on Stripe
        }
        const cb = await ctx.parseBody(req).catch(() => ({})), wantPlan = cb?.plan === 'company' ? 'company' : 'team';        // T-0295: Team or Company
        const wantIv = cb?.interval === undefined ? 'month' : cb.interval;                                                   // T-0310: monthly (the default) or yearly
        if (!['month', 'year'].includes(wantIv)) return ctx.json(res, 400, { error: 'interval must be month or year' }), true;
        const wantPrice = priceFor(wantPlan, wantIv, myWs);
        if (!wantPrice) return ctx.json(res, 400, { error: `The ${wantPlan === 'company' ? 'Company' : 'Team'} plan is not offered ${wantIv === 'year' ? 'yearly' : 'monthly'} on this Chamber.` }), true;
        { const n = fullMembers(store, myWs.id).length, cap = planCap(myWs, wantPlan);
          if (n > cap) return ctx.json(res, 409, { error: `This workspace has ${n} builders and the ${wantPlan === 'company' ? 'Company' : 'Team'} plan covers ${cap}. Make some of them approvers or viewers (they use no seat)${wantPlan === 'team' ? ', or choose Company' : ''}.`, builders: n, covers: cap }), true; }
        const cs = await stripe('POST', 'checkout/sessions', {
          mode: 'subscription', customer: me.stripeCustomer, client_reference_id: me.email,
          line_items: { 0: { price: wantPrice, quantity: 1 } }, subscription_data: { metadata: { chamber_workspace: me.workspace, chamber_plan: wantPlan, chamber_period: wantIv } },
          success_url: `${PUBLIC_URL}/billing?done=1`, cancel_url: `${PUBLIC_URL}/billing`,
          allow_promotion_codes: 'true',
        });
        return ctx.json(res, 200, { url: cs.url }), true;
      }
      if (p === '/billing/portal') {
        if (!me.stripeCustomer) return ctx.json(res, 400, { error: 'No subscription yet.' }), true;
        if (!perm.allows(myRole, 'ws.billing')) return ctx.json(res, 400, { error: 'Only the workspace owner can open the card and invoices page: it is their card.' }), true;   // T-0311: said, not only implied by having no customer
        const pb = await ctx.parseBody(req).catch(() => ({}));                     // T-0311: from the Billing tab, Stripe's page comes back to the tab
        const ps = await stripe('POST', 'billing_portal/sessions', { customer: me.stripeCustomer, return_url: `${PUBLIC_URL}${pb?.from === 'app' ? '/app#billing' : '/billing'}` });
        return ctx.json(res, 200, { url: ps.url }), true;
      }
      if (p === '/billing/preview') {                                            // T-0311: what a change would charge today, before anything is changed
        if (!perm.allows(myRole, 'ws.billing')) return ctx.json(res, 403, { error: 'Only the workspace owner can change the plan or the storage: it is their card.' }), true;   // T-0311: the owner only (20 Nov)
        const P = store.accounts[myWs?.owner], b = await ctx.parseBody(req).catch(() => ({}));
        if (!P || P.subStatus !== 'active' || !P.subscription) return ctx.json(res, 400, { error: 'There is no active subscription to change.' }), true;
        const t = changeTarget(store, myWs, P, b); if (t.error) return ctx.json(res, t.status || 400, { error: t.error }), true;
        const sub = await stripe('GET', `subscriptions/${P.subscription}`);
        const inv = t.same ? null : await previewInvoice(P, { subscription_items: changeItems(sub, t, myWs), subscription_proration_behavior: 'always_invoice', subscription_proration_date: Math.floor(Date.now() / 1000), ...(t.iv !== t.haveIv ? { subscription_billing_cycle_anchor: 'now' } : {}) });
        const usedB = usedBytesOf(ctx, myWs), newMb = limitMbOf(t.plan, t.packs);
        return ctx.json(res, 200, { plan: t.plan, interval: t.iv, packs: t.packs, same: t.same, dueNow: inv ? Math.max(0, inv.amount_due || 0) : null, total: inv ? inv.total : null, currency: inv?.currency || 'usd',
          then: `${labelFor(t.plan, t.iv, myWs)}${t.packs ? `, plus ${t.packs} × ${STORAGE_LABELS[t.iv]} for ${t.packs * STORAGE_PACK_GB} GB of storage` : ''}`, newPeriod: t.iv !== t.haveIv,
          overFiles: usedB > newMb * 1048576, usedMb: Math.ceil(usedB / 1048576), limitMb: newMb, needsPassword: t.charges }), true;
      }
      if (p === '/billing/cancel') {                                             // T-0311: one tap and one confirmation (the page asks once); {undo:true} keeps the plan
        if (!perm.allows(myRole, 'ws.billing')) return ctx.json(res, 400, { error: 'Only the workspace owner can cancel the plan: it is their card.' }), true;
        const b = await ctx.parseBody(req).catch(() => ({})), undo = b?.undo === true;
        if (me.subStatus !== 'active' || !me.subscription) return ctx.json(res, 400, { error: 'There is no active plan to cancel.' }), true;
        if (!!me.cancelAtPeriodEnd === !undo) return ctx.json(res, 200, publicView(me, store)), true;
        await stripe('POST', `subscriptions/${me.subscription}`, { cancel_at_period_end: undo ? 'false' : 'true' });
        const after = await stripe('GET', `subscriptions/${me.subscription}`), fresh = load(), cur = fresh.accounts[me.email];
        if (!cur) return ctx.json(res, 401, { error: 'not signed in' }), true;
        applySubscription(cur, after); save(fresh);
        const until = cur.periodEnd ? new Date(cur.periodEnd * 1000).toUTCString().slice(0, 16) : 'the end of the paid period';
        console.log(`[accounts] plan ${undo ? 'kept' : 'cancelled'}: ${cur.username} (until ${until})`); ctx.audit(sess, { action: undo ? 'plan-kept' : 'plan-cancel', until: cur.periodEnd || null }, true);
        { const letter = { to: cur.email, subject: undo ? 'Chamber: your plan continues' : 'Chamber: your plan is cancelled', text: `Hello ${cur.username},\n\n`
            + (undo ? `Your Chamber plan will not end: it renews as before (${priceLabelOf(cur, fresh.workspaces[cur.workspace])}).` : `Your Chamber plan is cancelled. It stays as it is until ${until}. Then the workspace moves to the free plan: nothing is deleted, and everyone in it can still read and export the record. Nothing more is charged.\n\nChanged your mind? Keep the plan in the Billing tab before then.`)
            + `\n\n${PUBLIC_URL}/app\n\nIf you did not do this, change your password now and write to ${CONTACT_TO}.\n` };
          if (TEST_HOOKS) console.log(`[accounts] cancel mail to ${letter.to}: ${undo ? 'kept' : 'cancelled'}`);
          if (mail.enabled) mail.send(letter).catch(e => console.error('[accounts] cancel mail failed:', e.message)); }
        return ctx.json(res, 200, publicView(cur, fresh)), true;
      }
      if (p === '/billing/plan') {                                               // T-0295: Team or Company; T-0311: and monthly or yearly, by the owner only; prorated
        if (!PRICES.company.month && !PRICES.company.year && !(PRICES.team.month && PRICES.team.year)) return ctx.json(res, 404, { error: 'This Chamber has one plan.' }), true;
        if (!perm.allows(myRole, 'ws.billing')) return ctx.json(res, 400, { error: 'Only the workspace owner can change the plan: it is their card.' }), true;   // T-0311: the owner only (20 Nov)
        const b = await ctx.parseBody(req).catch(() => ({})), P = store.accounts[myWs?.owner];
        if (b?.plan !== undefined && !['team', 'company'].includes(b.plan)) return ctx.json(res, 400, { error: 'plan must be team or company' }), true;
        if (!P || P.subStatus !== 'active' || !P.subscription) return ctx.json(res, 400, { error: 'Changing the plan needs an active subscription. Subscribe first.' }), true;
        const t = changeTarget(store, myWs, P, { plan: b?.plan, interval: b?.interval });          // the storage packs stay as they are
        if (t.error) return ctx.json(res, t.status || 400, { error: t.error }), true;
        if (t.same) return ctx.json(res, 200, publicView(me, store)), true;
        { const usedB = usedBytesOf(ctx, myWs), newMb = limitMbOf(t.plan, t.packs);              // warn first when the files would be over the new limit
          if (usedB > newMb * 1048576 && b?.confirmOver !== true) return ctx.json(res, 409, { error: `The files use ${mbText(usedB)} and the ${t.plan === 'company' ? 'Company' : 'Team'} plan with your storage gives ${mbText(newMb * 1048576)}. After the change nobody can add files until some are deleted or storage is added. Nothing was changed: confirm to go ahead.`, overFiles: true, usedMb: Math.ceil(usedB / 1048576), limitMb: newMb }), true; }
        if (t.charges) { const g = reauth(me, b?.password); if (g !== 'ok') return reauthFail(ctx, res, g, 'Password is wrong. Nothing was charged.'), true; }   // a charge to the owner's card needs the password of whoever asks
        try {
          const sub = await stripe('GET', `subscriptions/${P.subscription}`);
          const item = (sub.items?.data || []).find(i => priceInfo(i.price?.id));
          if (!item) return ctx.json(res, 409, { error: 'We could not find the plan on the subscription. Nothing was changed; write to us and we will sort it out.' }), true;
          if (t.iv === t.haveIv) await stripe('POST', `subscription_items/${item.id}`, { price: priceFor(t.plan, t.iv, myWs), ...(t.charges ? { proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' } : { proration_behavior: 'create_prorations' }) });
          else await stripe('POST', `subscriptions/${P.subscription}`, { items: changeItems(sub, t, myWs), billing_cycle_anchor: 'now', proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' });   // the new period starts today; the unused part of the old one comes off
        } catch (e) {
          if (/^Stripe/.test(e.message) || e.code) throw e;
          console.error('[accounts] plan:', e.message);
          return ctx.json(res, 402, { error: `Nothing was changed and the card was not charged. The payment service said: ${String(e.message).slice(0, 200)}` }), true;
        }
        const after = await stripe('GET', `subscriptions/${P.subscription}`);
        const fresh = load(), cur = fresh.accounts[P.email];
        if (!cur) return ctx.json(res, 409, { error: 'The workspace owner is gone. Nothing more was changed.' }), true;
        applySubscription(cur, after); save(fresh);
        const name = (pl, v) => `${pl === 'company' ? 'Company' : 'Team'}, ${v === 'year' ? 'yearly' : 'monthly'}`;
        console.log(`[accounts] plan ${name(t.havePlan, t.haveIv)} -> ${name(cur.plan, periodOf(cur))}: ${cur.username} (by ${me.username})`); ctx.audit(sess, { action: 'plan-change', from: t.havePlan, to: cur.plan, fromPeriod: t.haveIv, toPeriod: periodOf(cur) }, true);
        { const letter = { to: cur.email, subject: 'Chamber: your plan was changed', text: `Hello ${cur.username},\n\nYour Chamber workspace moved from ${name(t.havePlan, t.haveIv)} to ${name(cur.plan, periodOf(cur))} (${priceLabelOf(cur, fresh.workspaces[cur.workspace])}).\n\n`
            + (t.iv !== t.haveIv ? 'The new period starts today; the unused part of the old one was taken off.' : t.charges ? `Your card on file was charged the difference for the rest of your current ${periodOf(cur)}.` : 'The unused part of what you paid is taken off your next bill. Nothing was deleted.')
            + (me.email !== cur.email ? `\n\nThe change was made by ${me.username}, an admin of your workspace.` : '')
            + `\n\nYou can change it again at any time in the Billing tab: ${PUBLIC_URL}/app\n\nIf you did not expect this, change your password now and write to ${CONTACT_TO}.\n` };
          if (TEST_HOOKS) console.log(`[accounts] plan mail to ${letter.to}: ${t.havePlan} -> ${cur.plan} (${t.haveIv} -> ${periodOf(cur)}, by ${me.username})`);
          if (mail.enabled) mail.send(letter).catch(e => console.error('[accounts] plan mail failed:', e.message)); }
        return ctx.json(res, 200, publicView(fresh.accounts[me.email] || me, fresh)), true;
      }
      if (p === '/billing/storage') {                                            // storage add-on: set how many packs the workspace has
        if (!STORAGE_ON()) return ctx.json(res, 404, { error: 'Extra storage is not offered on this Chamber.' }), true;
        if (!perm.allows(myRole, 'ws.billing')) return ctx.json(res, 400, { error: 'Only the workspace owner can change the storage: it is their card.' }), true;   // T-0246; T-0311: the owner only (20 Nov)
        const P = store.accounts[myWs?.owner] || me;                                 // T-0311: always the owner's subscription, whoever asks
        const b = await ctx.parseBody(req).catch(() => ({})), want = b?.packs, have = P.storagePacks || 0;
        if (!Number.isInteger(want) || want < 0 || want > STORAGE_MAX_PACKS) return ctx.json(res, 400, { error: `Choose between 0 and ${STORAGE_MAX_PACKS} packs.` }), true;
        if (P.subStatus !== 'active' || !P.subscription) return ctx.json(res, 400, { error: 'Extra storage needs an active subscription. Subscribe first.' }), true;
        if (P.cancelAtPeriodEnd) return ctx.json(res, 400, { error: 'The subscription is set to cancel. Keep it (Billing tab) before changing storage.' }), true;
        const siv = periodOf(P), sprice = STORAGE_PRICES[siv];                                      // T-0310: storage follows the plan's period
        if (!sprice && want > have) return ctx.json(res, 400, { error: `Extra storage is not offered on ${siv === 'month' ? 'monthly' : 'yearly'} plans on this Chamber.` }), true;
        if (want === have) return ctx.json(res, 200, publicView(me, store)), true;
        if (want < have) {                                                         // T-0311: never leave the files over the limit; say what to delete
          const usedB = usedBytesOf(ctx, myWs), newMb = limitMbOf(P.plan === 'company' ? 'company' : 'team', want);
          if (usedB > newMb * 1048576) { const big = biggestFiles(ctx, myWs); return ctx.json(res, 409, { error: `The files use ${mbText(usedB)}, and with ${want * STORAGE_PACK_GB} GB of extra storage the limit would be ${mbText(newMb * 1048576)}. Delete files first (${big.map(f => `${f.name}, ${mbText(f.size)}`).join('; ') || 'see the Files tab'}). Nothing was changed.`, overFiles: true, usedMb: Math.ceil(usedB / 1048576), limitMb: newMb, biggest: big }), true; }
        }
        if (want > have) { const g = reauth(me, b?.password); if (g !== 'ok') return reauthFail(ctx, res, g, 'Password is wrong. Nothing was charged.'), true; }   // a charge to the card on file needs the password again (of whoever asks), not only a signed-in browser
        if (want > have) {                                                         // never sell space the disk does not have
          const sold = Object.values(store.accounts).reduce((n, a) => n + (a.subscription && a.email !== P.email ? (a.storagePacks || 0) : 0), 0);
          if ((sold + want) * STORAGE_PACK_GB > STORAGE_SELLABLE_GB) return ctx.json(res, 409, { error: 'More storage is coming soon: we cannot add that much right now. Nothing was charged.', soldOut: true }), true;
        }
        try {                                                                      // an increase is charged now; if the card fails Stripe changes nothing
          const sub = await stripe('GET', `subscriptions/${P.subscription}`);
          const item = (sub.items?.data || []).find(i => isStoragePrice(i.price?.id));
          const charge = { proration_behavior: 'always_invoice', payment_behavior: 'error_if_incomplete' };
          if (want === 0) { if (item) await stripe('DELETE', `subscription_items/${item.id}`, { proration_behavior: 'create_prorations' }); }
          else if (item) await stripe('POST', `subscription_items/${item.id}`, { quantity: want, ...(want > (item.quantity || 0) ? charge : { proration_behavior: 'create_prorations' }) });
          else await stripe('POST', 'subscription_items', { subscription: P.subscription, price: sprice, quantity: want, ...charge });
        } catch (e) {
          if (/^Stripe/.test(e.message) || e.code) throw e;                        // network trouble: the generic answer below
          console.error('[accounts] storage:', e.message);
          return ctx.json(res, 402, { error: `Nothing was changed and your card was not charged. The payment service said: ${String(e.message).slice(0, 200)}` }), true;
        }
        const after = await stripe('GET', `subscriptions/${P.subscription}`);
        const fresh = load(), cur = fresh.accounts[P.email];                       // re-read: the calls above waited on Stripe
        if (!cur) return ctx.json(res, 409, { error: 'The workspace owner is gone. Nothing more was changed.' }), true;
        applySubscription(cur, after); save(fresh);
        console.log(`[accounts] storage packs ${have} -> ${cur.storagePacks}: ${cur.username} (by ${me.username})`); ctx.audit(sess, { action: 'storage-packs', from: have, to: cur.storagePacks }, true);
        { const now = cur.storagePacks || 0, up = now > have;                         // tell the owner by email every time: it is their card, and it is how they notice a change they did not make
          const letter = { to: cur.email, subject: 'Chamber: your extra storage was changed', text: `Hello ${cur.username},\n\nThe extra file storage of your Chamber workspace was changed from ${have * STORAGE_PACK_GB} GB to ${now * STORAGE_PACK_GB} GB.\n\n`
            + (up ? `Your card on file was charged for the rest of your current ${siv}. From your next renewal it costs ${STORAGE_LABELS[siv]} for each ${STORAGE_PACK_GB} GB pack, together with your subscription.` : 'The unused part of what you paid is taken off your next bill. No files were deleted.')
            + (me.email !== cur.email ? `\n\nThe change was made by ${me.username}, an admin of your workspace.` : '')   // T-0311
            + `\n\nYou can change it again at any time: ${PUBLIC_URL}/billing\n\nIf you did not do this, change your password now and write to ${CONTACT_TO}.\n` };
          if (TEST_HOOKS) console.log(`[accounts] storage mail to ${letter.to}: ${have * STORAGE_PACK_GB} GB -> ${now * STORAGE_PACK_GB} GB`);
          if (mail.enabled) mail.send(letter).catch(e => console.error('[accounts] storage mail failed:', e.message)); }
        return ctx.json(res, 200, publicView(fresh.accounts[me.email] || me, fresh)), true;
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
                   ['CHAMBER_STRIPE_TEAM_MONTH or CHAMBER_STRIPE_TEAM_YEAR', PRICES.team.month || PRICES.team.year || PRICE], ['CHAMBER_PUBLIC_URL', PUBLIC_URL]]).filter(([, v]) => !v).map(([k]) => k);   // T-0061; T-0310: a price that is not set is simply not offered
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
    if (!a.totp && !a.passkeyLogin) { console.log(`${a.username} does not have two-factor on; nothing changed`); process.exit(0); }
    delete a.totp; delete a.totpRecovery; delete a.mfaDevices; delete a.totpPending; delete a.passkeyLogin; save(store);   // T-0241 (a): the passkey at sign-in too (the passkeys stay for unlocking)
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
    const keep = FREE_ON() ? `Nothing is deleted. Your workspace ${kind === 'over' ? 'is now' : 'then moves'} on Chamber's free plan: it stays yours to use for free, for ${FREE_PEOPLE === 1 ? 'you alone' : `${freePeopleText()} (you and the people who joined first)`} and ${FREE_TOKENS} AI agents${FREE_PEOPLE === 1 ? '' : ' each'}, without storing files. Anyone beyond that can still read it but not post.`   // T-0225; T-0288
      : `Nothing is deleted. Your workspace ${kind === 'over' ? 'is now' : 'then becomes'} read-only: you can still open it and read everything, but you and your AI agents cannot post or change anything until you subscribe.`;
    sends.push({ to: a.email, subject: kind === 'over' ? 'Chamber: your free trial has ended' : `Chamber: your free trial ends on ${day(a.trialEndsAt)}`,
      text: `Hi ${a.username},\n\n${kind === 'over' ? 'Your Chamber free trial has ended.' : `Your Chamber free trial ends on ${day(a.trialEndsAt)}.`}\n\n${keep}\n\n${FREE_ON() ? 'To keep your team and your files' : 'To keep going'}, subscribe (${keptDeal('team', 'year', ws) ? 'Team $50 / month, or $49 / year: the deal your workspace keeps' : PRICE_LABEL}, refundable for 14 days):\n\n${PUBLIC_URL}/billing\n\nIf Chamber was not for you, you do not need to do anything, and nothing will be charged. Questions? Reply to this email.\n` });
  }
  // T-0310: a yearly plan gets an email 14 days before each renewal (the pricing page and the Terms promise it), once per renewal
  // date (renewMailFor). A monthly plan gets a receipt every month instead (the invoice.paid webhook).
  out.renewals = [];
  if (mail.enabled || TEST_HOOKS) for (const a of Object.values(store.accounts)) {
    if (!a.subscription || a.subStatus !== 'active' || a.cancelAtPeriodEnd || periodOf(a) !== 'year' || !a.periodEnd || a.renewMailFor === a.periodEnd) continue;
    const at = a.periodEnd * 1000; if (at <= now || at - now > RENEW_NOTE_MS) continue;
    a.renewMailFor = a.periodEnd; out.renewals.push(a.username);
    const packs = storagePacksOf(a), label = priceLabelOf(a, store.workspaces[a.workspace]);
    sends.push({ to: a.email, subject: `Chamber: your plan renews on ${day(at)}`,
      text: `Hi ${a.username},\n\nYour Chamber ${a.plan === 'company' ? 'Company' : 'Team'} plan renews on ${day(at)} at ${label}${packs ? `, with ${packs * STORAGE_PACK_GB} GB of extra storage at ${STORAGE_LABELS.year} per ${STORAGE_PACK_GB} GB` : ''}. The card on file is charged then.\n\n`
        + `If you want to keep it, there is nothing to do. To change the plan or the storage, or to cancel: ${PUBLIC_URL}/billing\n\nIf you forget to cancel, write to us within 14 days of the charge and we refund it in full.\n` });
  }
  if (out.reminded.length || out.removed.length || out.renewals.length) save(store);
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
// T-0314: what paying workspaces could still upload (their plan's storage plus packs, minus what they use), for the disk check.
// The site's own workspace is left out (its owner runs the server); a workspace that can no longer write is left out too.
function storagePromised(ctx) {
  if (SELF_HOSTED) return { bytes: 0, count: 0 };
  const store = load(); let bytes = 0, count = 0;
  for (const ws of Object.values(store.workspaces)) {
    const owner = store.accounts[ws.owner]; if (!owner || owner.role === 'admin') continue;
    const plan = planOf(store, ws), st = billingState(owner);
    if ((plan !== 'team' && plan !== 'company') || (st !== 'ok' && st !== 'grace')) continue;
    bytes += Math.max(0, limitMbOf(plan, storagePacksOf(owner)) * 1048576 - usedBytesOf(ctx, ws)); count++;
  }
  return { bytes, count };
}
// T-0314: the workspaces the site operators own (accounts with role admin), and their usernames, for operator notices.
function operatorWorkspaces() {
  const store = load(), out = [];
  for (const a of Object.values(store.accounts)) if (a.role === 'admin' && a.workspace && store.workspaces[a.workspace]?.owner === a.email) out.push({ ws: a.workspace, username: a.username });
  return out;
}
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
// ── T-0219: the owner's keys for sealed copies. ws.ownerKeys = [{ id, pub, wrapped, salt, iv, iter, rec: {wrapped, salt, iv, iter},
// created, by }]; the newest is the one copies are sealed for. Older ones are kept so that older copies can still be opened.
function ownerKeys(ws) { return Array.isArray(ws.ownerKeys) ? ws.ownerKeys : []; }
function ownerKeyNow(ws) { const k = ownerKeys(ws); return k.length ? k[k.length - 1] : null; }
function ownerKeyView(ws, me, full) {
  const k = ownerKeyNow(ws), v = { set: !!k, id: k ? k.id : null, created: k ? k.created : null, by: k ? k.by : null, mine: !!(k && me && k.by === me.username) };
  if (full) v.keys = ownerKeys(ws).map(x => ({ id: x.id, created: x.created, by: x.by, wrapped: x.wrapped, salt: x.salt, iv: x.iv, iter: x.iter, rec: x.rec }));
  return v;
}
// ── T-0222: the owner lock. ws.lock = { on, state: 'sealing' | 'on' | 'unsealing', key: owner key id, wrapped: the workspace key
// RSA-OAEP-wrapped for that owner key, check: proves a key is the right one, since, by }. The workspace key itself is never stored.
function wrapForOwner(pubB64, dk) { return crypto.publicEncrypt({ key: crypto.createPublicKey({ key: Buffer.from(pubB64, 'base64'), format: 'der', type: 'spki' }), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, dk).toString('base64'); }
function lockView(ws, owner) {
  const l = ws && ws.lock && ws.lock.on ? ws.lock : null;
  if (!l) return { feature: LOCK_FEATURE, on: false };
  return { feature: LOCK_FEATURE, on: true, state: l.state, open: !wslock.locked(ws.id), since: l.since, by: l.by, key: l.key, keeper: wslock.keeper(), ...(owner ? { wrapped: l.wrapped } : {}) };
}
// Schedule texts live in accounts.json, outside the workspace folder; with the lock on they are sealed with the workspace key too.
function schedSeal(wsId, id, text) { return wsfiles.sealing(wsId) ? wscrypt.encText(wslock.key(wsId), text, `sched:${wsId}:${id}`) : text; }
function scheduleText(wsId, s) {                                   // the text, opened; null while the workspace is locked
  if (!s || !wscrypt.isEnc(s.text)) return s ? s.text : null;
  const dk = wslock.key(wsId); if (!dk) return null;
  try { return wscrypt.decText(dk, s.text, `sched:${wsId}:${s.id}`); } catch { return null; }
}
function lockConvertSchedules(wsId, direction) {
  const dk = wslock.key(wsId); if (!dk) return 0; const st = load(), w = st.workspaces[wsId]; if (!w) return 0; let n = 0;
  for (const s of w.schedules || []) {
    const aad = `sched:${wsId}:${s.id}`, sealed = wscrypt.isEnc(s.text) && (() => { try { wscrypt.decText(dk, s.text, aad); return true; } catch { return false; } })();
    if (direction === 'seal' && !sealed) { s.text = wscrypt.encText(dk, String(s.text || ''), aad); n++; }
    else if (direction === 'unseal' && sealed) { s.text = wscrypt.decText(dk, s.text, aad); n++; }
  }
  if (n) save(st); return n;
}
function lockStates() { if (!ENABLED) return []; return Object.values(load().workspaces).filter(w => w.lock && w.lock.on).map(w => ({ ws: w.id, state: w.lock.state, check: w.lock.check })); }
function lockConverted(wsId, direction) {                         // the server sealed (or unsealed) all of a workspace's data
  const st = load(), w = st.workspaces[wsId]; if (!w || !w.lock || !w.lock.on) return;
  if (direction === 'seal' && w.lock.state === 'sealing') { w.lock.state = 'on'; w.lock.sealedAt = Date.now(); save(st); wslock.setState(wsId, 'on'); }
  else if (direction === 'unseal' && w.lock.state === 'unsealing') { delete w.lock; save(st); wslock.setState(wsId, null); wslock.forget(wsId); }
}
function recordSettings() {                                       // T-0219: [{ id, name, days, copy, key, by }] for workspaces whose owner limited how long the record is kept
  if (!ENABLED) return [];
  const st = load();
  return Object.values(st.workspaces).filter(w => w.recordDays > 0).map(w => { const k = ownerKeyNow(w), owner = st.accounts[w.owner], mine = !!(k && owner && k.by === owner.username);
    return { id: w.id, name: w.name, days: w.recordDays, copy: !!w.recordCopy, key: w.recordCopy && mine ? { id: k.id, pub: k.pub } : null, by: owner ? owner.username : null }; });   // a key set by an earlier owner is not used: the new owner could not open what it seals
}
function retentionSettings() {                                    // T-0037: [{ id, days }] for workspaces that asked for retention
  if (!ENABLED) return [];
  return Object.values(load().workspaces).filter(w => w.retentionDays > 0).map(w => ({ id: w.id, days: w.retentionDays }));
}
function fleetLinkOf(wsId) { return (load().workspaces[wsId] || {}).fleet || null; }                       // T-0153: the stored link record (sealed key + status), or null
function fleetMark(wsId, patch) { const store = load(); const f = (store.workspaces[wsId] || {}).fleet; if (!f) return; Object.assign(f, patch); save(store); }
const fleetDir = () => path.dirname(FILE);                                                                  // where fleet-link.key lives (beside accounts.json)
module.exports = { storagePromised, operatorWorkspaces, enabled: ENABLED, lockStates, lockConverted, scheduleText, lockConvertSchedules, recordSettings, reportMailFind, reportMailSet, standingRules, draftsOn, agentTasksOn, needs2fa, passkeyCount, requestMailFor, setRequestMail, workspaceName, budgetOf, budgetWorkspaces, reportByToken, reportWorkspaces, approvalCheck, canApprove, reminderWorkspaces, remindTargets, storageExtraMbFor, planBaseMbFor, storageOffered: STORAGE_ON, serverConsoleAllowed, trialHousekeeping, fleetLinkOf, fleetMark, fleetDir, handle, check, sessionEntitled, sessionReadOnly, billingFor, workspaceOf, entitled, tokenSession, commandersFor, pushTo, flushQuietHeld, retentionSettings, dueSchedules, hookByToken, hookHit, sessionRole, mirrorsFor, mirrorResult, selfHosted: SELF_HOSTED };
