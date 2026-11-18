// Offline-Cache für die App-Oberfläche. Bei Änderungen an den Dateien VERSION erhöhen.
const VERSION = 'skriptor-v4';
const APP_FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'logic.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
];
const CDN_HOST = 'cdnjs.cloudflare.com';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // jsPDF vom CDN: einmal laden, danach aus dem Cache (Version ist fest).
  if (url.host === CDN_HOST) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
        return res;
      }))
    );
    return;
  }

  // Eigene Dateien: erst Netz (damit Updates sofort ankommen), sonst Cache.
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
          return res;
        })
        .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match('index.html')))
    );
  }
  // Alles andere (z. B. Gemini) geht unverändert ans Netz.
});
