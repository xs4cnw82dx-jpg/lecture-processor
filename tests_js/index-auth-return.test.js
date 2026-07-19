const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'index-app.js'), 'utf8');
const helperStart = source.indexOf('function sanitizeAuthReturnUrl');
const helperEnd = source.indexOf('function showAuthView', helperStart);
const helperSource = source.slice(helperStart, helperEnd);

function createHarness(options = {}) {
    const storage = new Map();
    const assignments = [];
    const fetchCalls = [];
    const toasts = [];
    const errors = [];
    const context = {
        URL,
        Promise,
        JSON,
        AUTH_RETURN_STORAGE_KEY: 'lectureProcessorAuthReturnUrl',
        authReturnResumePromise: null,
        authReturnRedirectStarted: false,
        currentUser: options.currentUser || null,
        userProfileLoaded: Boolean(options.userProfileLoaded),
        currentUserIsAdmin: Boolean(options.currentUserIsAdmin),
        window: {
            location: {
                origin: 'https://lectureprocessor.test',
                pathname: '/lecture-notes',
                search: '',
                hash: '',
                assign(url) { assignments.push(url); },
            },
        },
        sessionStorage: {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) { storage.set(key, String(value)); },
            removeItem(key) { storage.delete(key); },
        },
        async authenticatedFetch(url, requestOptions) {
            fetchCalls.push({ url, options: requestOptions });
            if (options.authenticatedFetch) return options.authenticatedFetch(url, requestOptions);
            return { ok: true };
        },
        showToast(message, tone, duration) { toasts.push({ message, tone, duration }); },
        captureClientError(error, tag) { errors.push({ error, tag }); },
    };
    vm.createContext(context);
    vm.runInContext(helperSource, context);
    return { context, storage, assignments, fetchCalls, toasts, errors };
}

test('ordinary pending destinations keep the existing immediate redirect behavior', () => {
    const harness = createHarness();
    harness.storage.set('lectureProcessorAuthReturnUrl', '/study?pack_id=one');

    assert.equal(harness.context.resumePendingNonAdminAuthReturnIfNeeded(), true);
    assert.deepEqual(harness.assignments, ['/study?pack_id=one']);
    assert.equal(harness.fetchCalls.length, 0);
    assert.equal(harness.storage.has('lectureProcessorAuthReturnUrl'), false);
});

test('admin return creates one server session before one redirect', async () => {
    let resolveSession;
    const sessionResult = new Promise((resolve) => { resolveSession = resolve; });
    const harness = createHarness({
        currentUser: { uid: 'admin-1' },
        userProfileLoaded: true,
        currentUserIsAdmin: true,
        authenticatedFetch: () => sessionResult,
    });
    harness.storage.set('lectureProcessorAuthReturnUrl', '/admin/workout');

    const first = harness.context.resumePendingAuthReturnIfNeeded();
    const second = harness.context.resumePendingAuthReturnIfNeeded();
    await Promise.resolve();
    assert.equal(harness.fetchCalls.length, 1);
    assert.deepEqual(harness.assignments, []);
    assert.equal(harness.storage.get('lectureProcessorAuthReturnUrl'), '/admin/workout');

    resolveSession({ ok: true });
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.deepEqual(harness.assignments, ['/admin/workout']);
    assert.equal(harness.storage.has('lectureProcessorAuthReturnUrl'), false);
});

test('failed admin session preserves the destination and can be retried', async () => {
    let attempt = 0;
    const harness = createHarness({
        currentUser: { uid: 'admin-1' },
        userProfileLoaded: true,
        currentUserIsAdmin: true,
        authenticatedFetch: async () => ({ ok: ++attempt > 1 }),
    });
    harness.storage.set('lectureProcessorAuthReturnUrl', '/admin');

    assert.equal(await harness.context.resumePendingAuthReturnIfNeeded(), false);
    assert.deepEqual(harness.assignments, []);
    assert.equal(harness.storage.get('lectureProcessorAuthReturnUrl'), '/admin');
    assert.match(harness.toasts.at(-1).message, /saved.*retry/i);

    assert.equal(await harness.context.resumePendingAuthReturnIfNeeded(), true);
    assert.deepEqual(harness.assignments, ['/admin']);
    assert.equal(harness.fetchCalls.length, 2);
});

test('non-admin account is not given an admin session and pending return remains', async () => {
    const harness = createHarness({
        currentUser: { uid: 'user-1' },
        userProfileLoaded: true,
        currentUserIsAdmin: false,
    });
    harness.storage.set('lectureProcessorAuthReturnUrl', '/admin/workout');

    assert.equal(await harness.context.resumePendingAuthReturnIfNeeded(), false);
    assert.equal(harness.fetchCalls.length, 0);
    assert.deepEqual(harness.assignments, []);
    assert.equal(harness.storage.get('lectureProcessorAuthReturnUrl'), '/admin/workout');
    assert.match(harness.toasts.at(-1).message, /does not have admin access/i);
});

test('email, Google, and auth-state flows all use the deduplicated activation handoff', () => {
    assert.match(source, /await activateVerifiedUser\(credential\.user\)/);
    assert.match(source, /await activateVerifiedUser\(result\.user\)/);
    assert.match(source, /await activateVerifiedUser\(user\)/);
    assert.match(source, /verifiedUserActivationPromise && verifiedUserActivationUid === uid/);
});
