// Onyx service worker: Web Push for the Agents chat (iPhone home-screen app, iOS 16.4+).
// Pushes come from the sms-reminders Worker, encrypted for this device; payload = { title, body, url, tag, badge }.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Onyx";
  const options = {
    body: data.body || "New message",
    tag: data.tag || "onyx-agents",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url || "/agents" },
  };
  const badge = typeof data.badge === "number" && self.navigator.setAppBadge ? self.navigator.setAppBadge(data.badge).catch(() => {}) : Promise.resolve();
  // Tell an open chat to refresh right away instead of waiting for its next poll.
  const ping = self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => list.forEach((c) => c.postMessage({ type: "onyx-push" })));
  event.waitUntil(Promise.all([self.registration.showNotification(title, options), badge, ping]));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/agents", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin && "focus" in client) {
          client.navigate(url).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
