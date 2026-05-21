const VOICE_CACHE = 'lecture-processor-voice-v1';
const APP_SHELL = [
  '/voice-notes',
  '/static/manifest.webmanifest',
  '/static/css/shared-ui.css',
  '/static/css/app-shell.css',
  '/static/css/motion.css',
  '/static/css/voice-notes.css',
  '/static/js/firebase-bootstrap.js',
  '/static/js/auth-utils.js',
  '/static/js/study-api-utils.js',
  '/static/js/voice-notes-utils.js',
  '/static/js/voice-notes.js',
  '/static/icons/icon-192.svg',
  '/static/icons/icon-512.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VOICE_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== VOICE_CACHE).map((key) => caches.delete(key))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/status/')) {
    return;
  }

  if (url.pathname === '/voice-notes') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(VOICE_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match('/voice-notes'))
    );
    return;
  }

  if (url.pathname.startsWith('/static/') || url.pathname === '/service-worker.js') {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        const copy = response.clone();
        caches.open(VOICE_CACHE).then((cache) => cache.put(request, copy));
        return response;
      }))
    );
  }
});
