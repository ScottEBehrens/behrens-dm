// service-worker.js for Circles

self.addEventListener('install', (event) => {
  console.log('[Circles SW] install');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[Circles SW] activate');
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  console.log('[Circles SW] Push received', event);

  let data = {};
  try {
    if (event.data) {
      // Log the raw text to be sure payload is coming through
      const text = event.data.text();
      console.log('[Circles SW] Raw push data text:', text);
      try {
        data = JSON.parse(text);
      } catch (jsonErr) {
        console.warn('[Circles SW] Failed to parse JSON, using text as body:', jsonErr);
        data = { body: text };
      }
    } else {
      console.warn('[Circles SW] Push event had no data payload');
    }
  } catch (err) {
    console.error('[Circles SW] Error reading push data', err);
  }

  const title = data.title || 'New question in Circles';
  const body = data.body || 'Someone posted a new question.';

  const url =
    data.url ||
    (data.circleId ? `/?circleId=${encodeURIComponent(data.circleId)}` : '/');

  console.log('[Circles SW] About to show notification:', {
    title,
    body,
    url,
    permission: (typeof Notification !== 'undefined') ? Notification.permission : 'unknown',
  });

  const options = {
    body,
    data: {
      url,
      circleId: data.circleId || null,
    },
    // icon: '/icons/circles-192.png', // optional if you have one
    // badge: '/icons/circles-72.png', // optional
  };

  event.waitUntil(
    self.registration.showNotification(title, options).catch((err) => {
      console.error('[Circles SW] showNotification failed', err);
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  console.log('[Circles SW] Notification click', event);
  event.notification.close();

  const targetUrl =
    (event.notification &&
      event.notification.data &&
      event.notification.data.url) ||
    '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        try {
          const clientUrl = new URL(client.url);
          if (clientUrl.origin === self.location.origin) {
            console.log('[Circles SW] Focusing existing client and navigating to', targetUrl);
            client.navigate(targetUrl);
            return client.focus();
          }
        } catch (e) {
          // ignore
        }
      }

      console.log('[Circles SW] Opening new window to', targetUrl);
      return clients.openWindow(targetUrl);
    })
  );
});
