const WORKOUT_CACHE = 'lecture-processor-workout-static-v3';
const WORKOUT_CACHE_PREFIX = 'lecture-processor-workout-';
const WORKOUT_SHELL = '/admin/workout';
const OFFLINE_PAGE = '/static/workout-offline.html';
const FIREBASE_ASSETS = [
  'https://www.gstatic.com/firebasejs/12.10.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/12.10.0/firebase-auth-compat.js'
];
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
  '/static/icons/workout-icon-v2-192.png',
  '/static/icons/workout-icon-v2-512.png',
  '/static/icons/workout-touch-v2-180.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(WORKOUT_CACHE).then(async (cache) => {
    await cache.addAll(STATIC_ASSETS);
    await Promise.allSettled(FIREBASE_ASSETS.map((asset) => cache.add(asset)));
  }));
});

async function cacheVerifiedWorkoutShell(response) {
  if (!response.ok || response.redirected) return response;

  let responseUrl;
  try {
    responseUrl = new URL(response.url);
  } catch (_) {
    return response;
  }
  const contentType = String(response.headers.get('Content-Type') || '').toLowerCase();
  const isPrivateWorkoutShell = (
    responseUrl.origin === self.location.origin
    && responseUrl.pathname === WORKOUT_SHELL
    && contentType.includes('text/html')
  );
  if (!isPrivateWorkoutShell) return response;

  const cache = await caches.open(WORKOUT_CACHE);
  await cache.put(WORKOUT_SHELL, response.clone());
  return response;
}

async function refreshWorkoutShell() {
  const response = await fetch(WORKOUT_SHELL, {
    cache: 'no-store',
    credentials: 'same-origin'
  });
  return cacheVerifiedWorkoutShell(response);
}

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data && event.data.type === 'CACHE_WORKOUT_SHELL') {
    event.waitUntil(refreshWorkoutShell().catch(() => {}));
  }
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
  if (FIREBASE_ASSETS.includes(url.href)) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
      if (!response.ok) return response;
      const copy = response.clone();
      caches.open(WORKOUT_CACHE).then((cache) => cache.put(request, copy));
      return response;
    })));
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/shares/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request, { cache: 'no-store' }).then((response) => {
      if (url.pathname !== WORKOUT_SHELL) return response;
      return cacheVerifiedWorkoutShell(response);
    }).catch(async () => {
      const cachedShell = await caches.match(WORKOUT_SHELL);
      return cachedShell || caches.match(OFFLINE_PAGE);
    }));
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
