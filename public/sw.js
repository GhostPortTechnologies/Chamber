// Chamber service worker (T-0013): makes the app installable and shows push notifications.
// Pushes carry no content (nothing private leaves the server); the notification just says there is something new.
// T-0210: when a push arrives, the worker asks Chamber itself, over the session this browser already has, whether a question from
// an agent is waiting for this person. If one is, the notification shows the exact command with Allow once / Deny, and a tap
// answers without opening the app. The command is fetched from Chamber, so it still never passes through a push service.
// Browsers without notification buttons (iPhone, Safari, Firefox) show the question, and a tap opens the app at it.
// SPDX-License-Identifier: AGPL-3.0-only  |  Copyright (C) 2026 GhostPort Technologies
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
const BUTTONS = (self.Notification && self.Notification.maxActions) || 0;     // 0 where notifications cannot carry buttons
const ICON = { icon: '/icon-192.png', badge: '/icon-192.png' };
const askTag = id => 'ask-' + id, isAskTag = t => /^ask-A-\d+$/.test(t || '');
async function waitingAsks() {                                                // the questions this person may answer; null when Chamber cannot be asked (signed out, offline)
  try {
    const quick = self.AbortSignal && AbortSignal.timeout ? { signal: AbortSignal.timeout(5000) } : {};   // a slow line must not hold the notification back
    const r = await fetch('/api/asks?status=waiting', { credentials: 'same-origin', cache: 'no-store', ...quick }); if (!r.ok) return null;
    return ((await r.json()).asks || []).filter(a => a.canAnswer);
  } catch { return null; }
}
async function showAsks(asks) {                                               // one notification per waiting question; returns how many are new
  const open = await self.registration.getNotifications(), live = new Set(asks.map(a => askTag(a.id)));
  for (const n of open) if (isAskTag(n.tag) && !live.has(n.tag)) n.close();    // answered somewhere else, or out of time
  const shown = new Set(open.map(n => n.tag)); let fresh = 0;
  for (const a of asks.slice(0, 5)) {
    if (shown.has(askTag(a.id))) continue;
    const cmd = a.tool === 'Bash', what = String(a.summary || '').replace(/^run this command: /, '').slice(0, 300);
    const until = new Date(a.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    await self.registration.showNotification(`${a.agent}${a.ticket ? ' (' + a.ticket + ')' : ''} asks: ${cmd ? 'may I run this command?' : 'may I do this?'}`, {
      ...ICON, body: `${what}\n${BUTTONS >= 2 ? '' : 'Tap to open Chamber and answer. '}No answer by ${until} means no.`, tag: askTag(a.id), renotify: true, requireInteraction: true,
      actions: BUTTONS >= 2 ? [{ action: 'allow', title: 'Allow once' }, { action: 'deny', title: 'Deny' }] : [],
      data: { ask: a.id, what, url: a.msgId ? '/app#m=' + a.msgId : '/app' } });
    fresh++;
  }
  return fresh;
}
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil((async () => {
    const asks = await waitingAsks(); let fresh = 0;
    try { if (asks) fresh = await showAsks(asks); } catch {}
    if (fresh) return;                                                         // the question is the news
    await self.registration.showNotification(d.title || 'Chamber', { ...ICON, body: d.body || 'New message or mention for you', tag: 'chamber', renotify: true, data: { url: d.url || '/app' } });
  })());
});
async function answerAsk(d, decision) {                                       // a tap on Allow once or Deny: answer with this browser's own session, then say what happened
  let note = null;
  try {
    const r = await fetch(`/api/asks/${encodeURIComponent(d.ask)}/answer`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision, via: 'notification' }) });
    if (!r.ok) { const j = await r.json().catch(() => ({})); note = r.status === 401 ? 'You are signed out on this device, so nothing was answered. Open Chamber to answer.' : (j.error || 'Chamber could not take the answer. Open Chamber to answer.'); }
  } catch { note = 'No connection, so nothing was answered. Open Chamber to answer.'; }
  try { await self.registration.showNotification(note ? 'Not answered' : (decision === 'allow' ? 'Allowed once' : 'You said no'), { ...ICON, body: note || d.what || '', tag: 'ask-note', silent: !note, data: { url: d.url || '/app' } }); } catch {}
  return note;
}
self.addEventListener('message', e => {                                      // the open app says which questions still wait; the others leave this device
  const d = e.data || {}; if (d.kind !== 'chamber-asks' || !Array.isArray(d.live)) return;
  const live = new Set(d.live.map(askTag));
  e.waitUntil(self.registration.getNotifications().then(ns => ns.forEach(n => { if (isAskTag(n.tag) && !live.has(n.tag)) n.close(); })).catch(() => {}));
});
self.addEventListener('notificationclick', e => {
  const d = e.notification.data || {}; e.notification.close();
  if (d.ask && (e.action === 'allow' || e.action === 'deny')) { e.waitUntil(answerAsk(d, e.action)); return; }
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const url = d.url || '/app', app = list.find(c => new URL(c.url).pathname === '/app' && 'focus' in c) || (d.ask ? null : list.find(c => 'focus' in c));
    if (!app) return clients.openWindow(url);
    if (d.ask) app.postMessage({ kind: 'chamber-open', url });                // the open app jumps to the question
    return app.focus();
  }));
});
