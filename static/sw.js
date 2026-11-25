/* 盯盘通知用的极简 Service Worker：只处理通知点击 */
self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  const code = event.notification.data && event.notification.data.code;
  event.notification.close();
  event.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of list) {
      if ("focus" in client) {
        client.postMessage({ type: "alert-click", code });
        return client.focus();
      }
    }
    return self.clients.openWindow("/");
  })());
});
