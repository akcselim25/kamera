const CACHE_NAME = 'kamera-v1';
const ASSETS = [
  './',
  './index.html',
  './app.js?v=36',
  './worker.js?v=31',
  'https://unpkg.com/peerjs@1.5.1/dist/peerjs.min.js',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;500;700;900&display=swap'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(response => {
      return response || fetch(e.request);
    }).catch(() => {
      // Offline fallback
      if (e.request.mode === 'navigate') {
        return caches.match('./index.html');
      }
    })
  );
});
