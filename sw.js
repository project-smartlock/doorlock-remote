// Service worker: makes the page installable and lets the app shell open on a bad connection.
// Network first, so a new deploy shows up on the next load; the cache is only a fallback.
// It never sees MQTT traffic: WebSockets bypass service workers.

const CACHE = 'smartlock-v2';
const SHELL = [
  './',
  'index.html',
  'config.js',
  'css/style.css',
  'js/app.js',
  'js/lock-client.js',
  'js/voice.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
];
const MQTT_JS = 'https://cdn.jsdelivr.net/npm/mqtt@5.16.0/dist/mqtt.min.js';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const sameOrigin = new URL(req.url).origin === self.location.origin;
  if (req.method !== 'GET' || (!sameOrigin && req.url !== MQTT_JS)) return;

  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit ?? Response.error())),
  );
});
