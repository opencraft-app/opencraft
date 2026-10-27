// This worker displays notifications only; it never handles fetch or claims pages.
self.addEventListener("install", event => { event.waitUntil(self.skipWaiting()); });
self.addEventListener("message", event => {
  if (event.data?.kind === "opencraft-turn-client") event.ports[0]?.postMessage(event.source?.id ?? null);
});
self.addEventListener("notificationclick", event => {
  event.notification.close();
  const data = event.notification.data;
  if (data?.kind !== "opencraft-turn") return;
  event.waitUntil((async () => {
    const client = typeof data.clientId === "string" ? await self.clients.get(data.clientId) : null;
    if (client?.type === "window") {
      await client.focus();
      client.postMessage({ kind: "opencraft-turn-click", ownerId: data.ownerId, completion: data.completion });
    } else {
      const url = new URL(data.pageUrl, self.location.origin);
      if (url.origin === self.location.origin) await self.clients.openWindow(url.href);
    }
  })());
});
