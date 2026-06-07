const CACHE_NAME = 'kamera-v2';
const ASSETS = [
  './',
  './index.html',
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
  const url = new URL(e.request.url);
  
  // Kendi dosyalarımız için Network-First stratejisi (Güncellemeleri anında alabilmek için)
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request).then(response => {
        if (response.status === 200) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(e.request, responseClone);
          });
        }
        return response;
      }).catch(() => {
        return caches.match(e.request);
      })
    );
  } else {
    // Dış kütüphaneler için Cache-First stratejisi
    e.respondWith(
      caches.match(e.request).then(response => {
        return response || fetch(e.request);
      })
    );
  }
});
