const WORKOUT_CACHE = 'lecture-processor-workout-static-v1';
const WORKOUT_CACHE_PREFIX = 'lecture-processor-workout-';
const OFFLINE_PAGE = '/static/workout-offline.html';
const STATIC_ASSETS = [
  OFFLINE_PAGE,
  '/static/css/workout-offline.css',
  '/static/css/shared-ui.css',
  '/static/css/app-shell.css',
  '/static/css/motion.css',
  '/static/css/workout.css',
  '/static/js/firebase-bootstrap.js',
  '/static/js/html-utils.js',
  '/static/js/ux-utils.js',
  '/static/js/auth-utils.js',
  '/static/js/workout-utils.min.js',
  '/static/js/workout.min.js',
  '/static/workout-manifest.webmanifest',
  '/static/icons/workout-icon-192.svg',
  '/static/icons/workout-icon-512.svg',
  '/static/icons/workout-touch-180.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(WORKOUT_CACHE).then((cache) => cache.addAll(STATIC_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys
    .filter((key) => key.startsWith(WORKOUT_CACHE_PREFIX) && key !== WORKOUT_CACHE)
    .map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/shares/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request, { cache: 'no-store' }).catch(() => caches.match(OFFLINE_PAGE)));
    return;
  }

  if (!url.pathname.startsWith('/static/')) return;
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (!response.ok || response.type !== 'basic') return response;
    const copy = response.clone();
    caches.open(WORKOUT_CACHE).then((cache) => cache.put(request, copy));
    return response;
  })));
});
