(function (root) {
  'use strict';
  function focusSeconds(slotSeconds, mode, duration) {
    var elapsed = Math.max(0, Math.floor(slotSeconds || 0));
    if (mode !== 'pomodoro') return elapsed;
    var bounded = Math.min(elapsed, duration);
    return Math.floor(bounded / 1800) * 1500 + Math.min(bounded % 1800, 1500) + Math.max(0, elapsed - duration);
  }
  function timerState(run) {
    var elapsed = Math.max(0, Math.floor(run.slot_seconds || 0));
    var duration = run.duration_seconds;
    var remaining = Math.max(0, duration - elapsed);
    var onBreak = run.timer_mode === 'pomodoro' && elapsed < duration && elapsed % 1800 >= 1500;
    return { onBreak: onBreak, remaining: remaining,
      phaseRemaining: run.timer_mode === 'pomodoro' && remaining ? Math.min(remaining, (onBreak ? 1800 : 1500) - elapsed % 1800) : remaining };
  }
  function pendingItems(run) {
    var answers = run.answers || {};
    var first = run.queue.filter(function (item) {
      return item.type === 'notes' ? (run.notes_seconds || 0) < item.seconds : !answers[item.id];
    });
    var retries = run.queue.filter(function (item) {
      return answers[item.id] && !answers[item.id].correct && (run.retry_done || []).indexOf(item.id) < 0;
    }).map(function (item) { return Object.assign({}, item, { retry: true, reason: 'One more try' }); });
    return first.concat(retries);
  }
  function canFinish(run) {
    var notes = run.queue.some(function (item) { return item.type === 'notes'; });
    var meaningful = Object.keys(run.answers || {}).length > 0 || (run.retired_answers || []).length > 0 || (notes && run.notes_seconds >= 60);
    var timeMet = run.slot_seconds >= run.duration_seconds && run.active_seconds >= focusSeconds(run.duration_seconds, run.timer_mode, run.duration_seconds);
    return meaningful && (pendingItems(run).length === 0 || timeMet);
  }
  function mergeCheckpoint(remote, local) {
    if (!local || local.activity_id !== remote.activity_id || local.content_fingerprint !== remote.content_fingerprint || local.generation !== remote.generation || (local.mode_generation || 0) !== (remote.mode_generation || 0) || local.study_mode !== remote.study_mode) return remote;
    if ((local.checkpoint_revision || 0) < (remote.checkpoint_revision || 0) || ((local.checkpoint_revision || 0) === (remote.checkpoint_revision || 0) && !(local.pending_reviews || []).length)) return remote;
    return Object.assign({}, remote, local, { queue: remote.queue, duration_seconds: remote.duration_seconds, run_status: 'paused' });
  }
  var api = { focusSeconds: focusSeconds, timerState: timerState, pendingItems: pendingItems, canFinish: canFinish, mergeCheckpoint: mergeCheckpoint };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.LectureProcessorPlannedStudyUtils = api;
})(typeof window !== 'undefined' ? window : globalThis);
