const test = require('node:test');
const assert = require('node:assert/strict');

const studyApiUtils = require('../static/js/study-api-utils.js');

test('withAuthHeaders adds authorization and json content type for non-FormData bodies', () => {
  const headers = studyApiUtils.withAuthHeaders(
    { body: JSON.stringify({ ok: true }) },
    'token-123'
  ).headers;

  assert.equal(headers.Authorization, 'Bearer token-123');
  assert.equal(headers['Content-Type'], 'application/json');
});

test('createStudyApiClient refreshes the token and retries once after a 401 response', async () => {
  let cachedToken = '';
  const seenTokens = [];
  const auth = {
    currentUser: {
      getIdToken(forceRefresh) {
        return Promise.resolve(forceRefresh ? 'token-fresh' : 'token-stale');
      },
    },
  };

  const client = studyApiUtils.createStudyApiClient({
    auth,
    getToken: () => cachedToken,
    setToken: (nextToken) => { cachedToken = nextToken; },
    fetchImpl: (_path, options) => {
      seenTokens.push(options.headers.Authorization);
      return Promise.resolve({
        status: seenTokens.length === 1 ? 401 : 200,
        headers: { get: () => 'application/json' },
      });
    },
  });

  const response = await client.performAuthenticatedFetch('/api/example', { method: 'GET' }, true);

  assert.equal(response.status, 200);
  assert.deepEqual(seenTokens, ['Bearer token-stale', 'Bearer token-fresh']);
  assert.equal(cachedToken, 'token-fresh');
});
