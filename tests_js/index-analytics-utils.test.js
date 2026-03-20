const test = require('node:test');
const assert = require('node:assert/strict');

const analyticsUtils = require('../static/js/index-analytics-utils.js');

test('resolveProcessingAnalyticsPage prefers the forced mode when provided', () => {
  assert.equal(
    analyticsUtils.resolveProcessingAnalyticsPage({ forcedMode: 'lecture-notes' }),
    'lecture-notes'
  );
  assert.equal(
    analyticsUtils.resolveProcessingAnalyticsPage({ forcedMode: 'slides-only' }),
    'slides-extraction'
  );
  assert.equal(
    analyticsUtils.resolveProcessingAnalyticsPage({ forcedMode: 'interview' }),
    'interview-transcription'
  );
});

test('resolveProcessingAnalyticsPage falls back to the shell page key before pathname', () => {
  assert.equal(
    analyticsUtils.resolveProcessingAnalyticsPage({
      shellPageKey: 'dashboard',
      pathname: '/lecture-notes',
    }),
    'dashboard'
  );
});

test('resolveProcessingAnalyticsPage normalizes known routes and unknown routes', () => {
  assert.equal(
    analyticsUtils.resolveProcessingAnalyticsPage({ pathname: '/slides-extraction' }),
    'slides-extraction'
  );
  assert.equal(
    analyticsUtils.resolveProcessingAnalyticsPage({ pathname: '/interview-transcription' }),
    'interview-transcription'
  );
  assert.equal(
    analyticsUtils.resolveProcessingAnalyticsPage({ pathname: '/something-else' }),
    'processing'
  );
});
