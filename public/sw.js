// MiniPlatform service worker — caches the static app shell only, so the
// PWA installs and launches instantly. It deliberately never touches
// /api/* or /socket.io/* — those must always hit the network live, since
// this is a real-time chat app, not a static site.
const CACHE_NAME = 'miniplatform-shell-v1';
const SHELL_FILES = [
  '/',
  '/styles.css',
  '/app.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls, socket.io's own transport, or anything
  // cross-origin — those must always be live.
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;
  if (event.request.method !== 'GET') return;

  // App shell files: cache-first (instant load), falling back to network
  // and re-caching. Everything else (uploaded images/voice notes): network
  // first, falling back to cache if offline.
  const isShellFile = SHELL_FILES.includes(url.pathname);

  if (isShellFile) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const network = fetch(event.request).then((res) => {
          if (res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    );
  } else {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, res.clone()));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
  }
});
