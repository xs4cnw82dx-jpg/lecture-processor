const test = require('node:test');
const assert = require('node:assert/strict');

const runtimeJobUtils = require('../static/js/runtime-job-utils.js');

test('mergeActiveRuntimeJobs keeps active jobs sorted newest-first', () => {
  const merged = runtimeJobUtils.mergeActiveRuntimeJobs(
    [
      { job_id: 'job-1', status: 'processing', started_at: 100, study_pack_title: 'Older' },
    ],
    [
      { job_id: 'job-2', status: 'starting', started_at: 200, study_pack_title: 'Newest' },
      { job_id: 'job-1', status: 'processing', started_at: 90, study_pack_title: 'Ignored older duplicate' },
      { job_id: 'job-3', status: 'complete', started_at: 300, study_pack_title: 'Not active' },
    ]
  );

  assert.deepEqual(merged.map((job) => job.job_id), ['job-2', 'job-1']);
  assert.equal(merged[0].study_pack_title, 'Newest');
});

test('removeRuntimeJob removes the requested cached job id', () => {
  const remaining = runtimeJobUtils.removeRuntimeJob(
    [
      { job_id: 'job-1', status: 'processing', started_at: 100 },
      { job_id: 'job-2', status: 'starting', started_at: 200 },
    ],
    'job-1'
  );

  assert.deepEqual(remaining.map((job) => job.job_id), ['job-2']);
});

test('notification helpers only prompt after a job starts and only notify on terminal states', () => {
  assert.equal(runtimeJobUtils.shouldPromptForNotifications({
    jobStarted: false,
    notificationSupported: true,
    permission: 'default',
  }), false);

  assert.equal(runtimeJobUtils.shouldPromptForNotifications({
    jobStarted: true,
    notificationSupported: true,
    permission: 'default',
  }), true);

  assert.equal(runtimeJobUtils.shouldSendCompletionNotification({
    notificationSupported: true,
    permission: 'granted',
    status: 'processing',
  }), false);

  assert.equal(runtimeJobUtils.shouldSendCompletionNotification({
    notificationSupported: true,
    permission: 'granted',
    status: 'complete',
  }), true);
});

test('buildCompletionNotification uses the pack title and failure message', () => {
  const success = runtimeJobUtils.buildCompletionNotification(
    { job_id: 'job-1', study_pack_title: 'Biology Week 1', status: 'complete' },
    { status: 'complete' }
  );
  assert.equal(success.title, 'Processing complete');
  assert.match(success.body, /Biology Week 1/);

  const failure = runtimeJobUtils.buildCompletionNotification(
    { job_id: 'job-2', study_pack_title: 'History Week 2', status: 'error' },
    { status: 'error', error: 'Transcript generation failed' }
  );
  assert.equal(failure.title, 'Processing failed');
  assert.equal(failure.body, 'Transcript generation failed');
});
