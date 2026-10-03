const test = require('node:test');
const assert = require('node:assert/strict');
const batch = require('../static/js/batch-status.js');

test('credit outcome distinguishes completed and pending refunds', () => {
  assert.deepEqual(batch.credits({ credits_charged: 2, credits_refunded: 2 }), { heading: 'All 2 credits refunded', breakdown: '2 charged · 2 refunded' });
  assert.deepEqual(batch.credits({ credits_charged: 2, credits_refunded: 1, credits_refund_pending: 1 }), { heading: '1 credit refund pending', breakdown: '2 charged · 1 refunded · 1 pending' });
  assert.equal(batch.credits({ credits_charged: 1 }).heading, '1 credit charged');
});

test('poll only unfinished work or unsettled notifications/refunds', () => {
  for (const status of ['queued', 'processing']) assert.equal(batch.needsPolling({ status }), true);
  for (const status of ['complete', 'partial', 'error']) {
    assert.equal(batch.needsPolling({ status, completion_email_status: 'sent' }), false);
    assert.equal(batch.needsPolling({ status, credits_refund_pending: 1 }), true);
    assert.equal(batch.needsPolling({ status, completion_email_status: 'pending' }), true);
    assert.equal(batch.needsPolling({ status, completion_email_status: 'failed' }), false);
  }
});

test('all modes keep the correct creation paths and authenticated download family', () => {
  const suffixes = { 'lecture-notes': '', 'slides-only': '_slides_extraction', interview: '_interview_transcription', 'audio-transcription': '_audio_transcription', 'text-combine': '_text_combine' };
  for (const processing_strategy of ['batch', 'instant']) for (const [mode, suffix] of Object.entries(suffixes)) {
    const b = { mode, processing_strategy, batch_id: 'id with spaces' };
    assert.equal(batch.newBatchUrl(b), (processing_strategy === 'instant' ? '/instant_batch_mode' : '/batch_mode') + suffix);
    assert.equal(batch.api(b), (processing_strategy === 'instant' ? '/api/instant-batch/jobs/' : '/api/batch/jobs/') + 'id%20with%20spaces');
  }
});

test('provider diagnostics and titles are escaped; unknown states remain visible', () => {
  assert.equal(batch.escape('<img src=x onerror="bad()">'), '&lt;img src=x onerror=&quot;bad()&quot;&gt;');
  assert.match(batch.pill('<script>'), /Status unavailable/);
  assert.equal(batch.progress({ total_rows: 2, failed_rows: 2 }), '0 of 2 completed · 2 failed');
});

test('raw provider errors stay out of the main explanation', () => {
  assert.match(batch.friendlyError('503 UNAVAILABLE {"error":"upstream"}'), /temporarily unavailable/);
  assert.match(batch.friendlyError('Traceback: ValueError at parser'), /Technical details/);
});

test('outcomes distinguish partial results, waiting, and unknown status without inventing completion', () => {
  assert.equal(batch.outcome({ status: 'partial' }).title, 'Some results are ready');
  assert.match(batch.outcome({ status: 'queued' }).title, /queue/);
  assert.match(batch.outcome({ status: 'processing' }).title, /progress/);
  assert.match(batch.outcome({ status: 'unrecognized' }).title, /Checking/);
  assert.doesNotMatch(batch.outcome({ status: 'unrecognized' }).copy, /finish|ready/);
});

test('progress segments cannot overflow when counts are stale or total is zero', () => {
  const overcounted = batch.progressBar({ total_rows: 2, completed_rows: 5, failed_rows: 8 });
  assert.match(overcounted, /width="100"/);
  assert.match(overcounted, /bs-progress-failed" x="100" width="0"/);
  assert.doesNotMatch(batch.progressBar({ total_rows: 0, completed_rows: 1 }), /NaN|Infinity/);
});
