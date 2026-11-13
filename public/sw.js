// Chamber service worker (T-0013): makes the app installable and shows push notifications.
// Pushes carry no content (nothing private leaves the server); the notification just says there is something new.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'Chamber', { body: d.body || 'New message or mention for you', icon: '/icon-192.png', badge: '/icon-192.png', tag: 'chamber', renotify: true, data: { url: d.url || '/app' } }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return clients.openWindow(e.notification.data?.url || '/app');
  }));
});
