const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const ORIGIN = 'https://app.example';

// Runs a service worker script against in-memory caches and a scripted network.
function loadWorker(file, { network, existingCaches = [] } = {}) {
  const handlers = {};
  const stores = new Map(existingCaches.map(name => [name, new Map()]));
  const keyOf = (request, ignoreSearch) => {
    const url = new URL(typeof request === 'string' ? request : request.url, ORIGIN);
    return ignoreSearch ? url.origin + url.pathname : url.href;
  };
  function cacheFor(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      put: async (request, response) => { store.set(keyOf(request), response); },
      add: async (request) => { store.set(keyOf(request), await network(new Request(new URL(request, ORIGIN)))); },
      addAll: async (requests) => { for (const request of requests) store.set(keyOf(request), new Response('precached ' + request)); },
      match: async (request, options = {}) => {
        if (!options.ignoreSearch) return store.get(keyOf(request));
        const wanted = keyOf(request, true);
        for (const [key, value] of store) if (keyOf(key, true) === wanted) return value;
        return undefined;
      },
    };
  }
  const caches = {
    open: async name => cacheFor(name),
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name),
    match: async (request, options) => { for (const name of stores.keys()) { const hit = await cacheFor(name).match(request, options); if (hit) return hit; } return undefined; },
  };
  const self = {
    location: new URL(ORIGIN + '/'),
    addEventListener: (type, handler) => { handlers[type] = handler; },
    skipWaiting: async () => {}, clients: { claim: async () => {} },
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { self, caches, fetch: network, Request, Response, URL, Promise, console });
  const run = async (type, event) => { let pending = null; handlers[type]({ ...event, waitUntil: p => { pending = p; }, respondWith: p => { pending = p; } }); return pending; };
  return { stores, run, fetchUrl: async (path) => run('fetch', { request: new Request(ORIGIN + path) }) };
}

const online = async (request) => new Response('network ' + new URL(request.url).pathname);
const offline = async () => { throw new TypeError('offline'); };

test('voice notes worker deletes only its own older caches on activate', async () => {
  const worker = loadWorker('static/service-worker.js', { network: online, existingCaches: ['lecture-processor-voice-v1', 'lecture-processor-workout-static-v1', 'unrelated'] });
  await worker.run('install', {});
  await worker.run('activate', {});
  const names = [...worker.stores.keys()];
  assert.ok(!names.includes('lecture-processor-voice-v1'));
  assert.ok(names.includes('lecture-processor-workout-static-v1'));
  assert.ok(names.includes('unrelated'));
  assert.equal(names.filter(name => name.startsWith('lecture-processor-voice-')).length, 1);
});

test('voice notes worker serves fresh static files online and the precached copy offline', async () => {
  let network = online;
  const worker = loadWorker('static/service-worker.js', { network: (r) => network(r) });
  await worker.run('install', {});
  const fresh = await worker.fetchUrl('/static/js/voice-notes.min.js?v=new');
  assert.equal(await fresh.text(), 'network /static/js/voice-notes.min.js');
  network = offline;
  const cachedSameVersion = await worker.fetchUrl('/static/js/voice-notes.min.js?v=new');
  assert.equal(await cachedSameVersion.text(), 'network /static/js/voice-notes.min.js');
  const otherVersion = await worker.fetchUrl('/static/css/voice-notes.css?v=unknown');
  assert.match(await otherVersion.text(), /^precached \/static\/css\/voice-notes\.css/);
});

test('voice notes worker leaves API requests to the network', async () => {
  const worker = loadWorker('static/service-worker.js', { network: online });
  assert.equal(await worker.fetchUrl('/api/voice-notes'), null);
});

test('workout worker deletes only its own older caches and falls back to precached files offline', async () => {
  let network = online;
  const worker = loadWorker('static/workout-service-worker.js', { network: (r) => network(r), existingCaches: ['lecture-processor-workout-static-v1', 'lecture-processor-voice-v1'] });
  await worker.run('install', {});
  await worker.run('activate', {});
  const names = [...worker.stores.keys()];
  assert.ok(!names.includes('lecture-processor-workout-static-v1'));
  assert.ok(names.includes('lecture-processor-voice-v1'));
  network = offline;
  const cached = await worker.fetchUrl('/static/css/workout.css?v=unknown');
  assert.match(await cached.text(), /^precached \/static\/css\/workout\.css/);
});

function shellResponse({ ok = true, redirected = false, path = '/admin/workout', type = 'text/html; charset=utf-8', body = 'workout shell' } = {}) {
  return { ok, redirected, url: ORIGIN + path, headers: new Headers({ 'Content-Type': type }), body,
    clone() { return shellResponse({ ok, redirected, path, type, body }); }, text: async () => body };
}

test('workout worker caches only a successful, same-origin workout page as its offline shell', async () => {
  const cases = [
    { name: 'signed-in page', response: shellResponse(), cached: true },
    { name: 'redirected response', response: shellResponse({ redirected: true }), cached: false },
    { name: 'server error', response: shellResponse({ ok: false }), cached: false },
    { name: 'other page', response: shellResponse({ path: '/dashboard' }), cached: false },
    { name: 'not HTML', response: shellResponse({ type: 'application/json' }), cached: false },
  ];
  for (const { name, response, cached } of cases) {
    const calls = [];
    const worker = loadWorker('static/workout-service-worker.js', { network: async (request, options) => { calls.push({ request, options }); return response; } });
    await worker.run('message', { data: { type: 'CACHE_WORKOUT_SHELL' } });
    assert.equal(JSON.stringify(calls.map(call => [call.request, call.options])), JSON.stringify([['/admin/workout', { cache: 'no-store', credentials: 'same-origin' }]]), name);
    const stored = [...worker.stores.values()].some(store => store.has(ORIGIN + '/admin/workout'));
    assert.equal(stored, cached, name);
  }
});

test('workout worker opens the cached shell offline and the offline page when none is cached', async () => {
  let network = async () => shellResponse({ body: 'fresh shell' });
  const worker = loadWorker('static/workout-service-worker.js', { network: (...args) => network(...args) });
  const navigate = path => worker.run('fetch', { request: { method: 'GET', url: ORIGIN + path, mode: 'navigate' } });
  await worker.run('install', {});
  assert.equal(await (await navigate('/admin/workout')).text(), 'fresh shell');
  network = offline;
  assert.equal(await (await navigate('/admin/workout')).text(), 'fresh shell');
  const empty = loadWorker('static/workout-service-worker.js', { network: offline });
  await empty.run('install', {});
  const fallback = await empty.run('fetch', { request: { method: 'GET', url: ORIGIN + '/admin/workout', mode: 'navigate' } });
  assert.match(await fallback.text(), /^precached \/static\/workout-offline\.html/);
});
