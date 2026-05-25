const VOICE_CACHE = 'lecture-processor-voice-v6';
const APP_SHELL = [
  '/voice-notes',
  '/static/manifest.webmanifest',
  '/static/css/shared-ui.css',
  '/static/css/app-shell.css',
  '/static/css/motion.css',
  '/static/css/voice-notes.css',
  '/static/js/firebase-bootstrap.js',
  '/static/js/html-utils.js',
  '/static/js/auth-utils.js',
  '/static/js/download-utils.js',
  '/static/js/topbar-utils.js',
  '/static/js/ui-cache.js',
  '/static/js/user-cache-utils.js',
  '/static/js/app-shell.js',
  '/static/js/study-api-utils.js',
  '/static/js/study-api-utils.min.js',
  '/static/js/voice-notes-utils.js',
  '/static/js/voice-notes-utils.min.js',
  '/static/js/voice-notes.js',
  '/static/js/voice-notes.min.js',
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
      fetch(new Request(request, { cache: 'no-cache' }))
        .then((response) => {
          const copy = response.clone();
          caches.open(VOICE_CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request))
    );
  }
});
