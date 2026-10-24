// Legacy Web Push fallback. No fetch handler and no page-claiming behavior.
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('push', event => {
  let payload;
  try { payload = event.data.json(); } catch { return; }
  const notification = payload?.notification;
  if (payload?.web_push !== 8030 || typeof notification?.title !== 'string') return;
  event.waitUntil(self.registration.showNotification(notification.title, {
    body: notification.body, lang: notification.lang, tag: notification.tag,
    data: { navigate: notification.navigate },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const navigate = event.notification.data?.navigate;
  if (typeof navigate !== 'string') return;
  let url;
  try { url = new URL(navigate); } catch { return; }
  if (url.origin !== self.location.origin) return;
  event.waitUntil(self.clients.openWindow(url.href));
});
