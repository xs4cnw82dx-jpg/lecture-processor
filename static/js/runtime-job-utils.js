(function (root) {
  'use strict';

  var ACTIVE_STATUSES = { queued: true, starting: true, processing: true };
  var TERMINAL_STATUSES = { complete: true, error: true };

  function normalizeRuntimeJob(job) {
    var value = job && typeof job === 'object' ? job : {};
    return {
      job_id: String(value.job_id || '').trim(),
      mode: String(value.mode || '').trim(),
      status: String(value.status || '').trim().toLowerCase(),
      step: Math.max(0, parseInt(value.step, 10) || 0),
      step_description: String(value.step_description || '').trim(),
      study_pack_title: String(value.study_pack_title || '').trim(),
      started_at: Math.max(0, Number(value.started_at || 0)),
      study_pack_id: String(value.study_pack_id || '').trim(),
      error: String(value.error || '').trim(),
    };
  }

  function isActiveStatus(status) {
    return !!ACTIVE_STATUSES[String(status || '').trim().toLowerCase()];
  }

  function isTerminalStatus(status) {
    return !!TERMINAL_STATUSES[String(status || '').trim().toLowerCase()];
  }

  function sortRuntimeJobs(jobs) {
    return (Array.isArray(jobs) ? jobs : []).slice().sort(function (left, right) {
      var leftStarted = Math.max(0, Number(left && left.started_at || 0));
      var rightStarted = Math.max(0, Number(right && right.started_at || 0));
      if (leftStarted !== rightStarted) {
        return rightStarted - leftStarted;
      }
      return String(left && left.job_id || '').localeCompare(String(right && right.job_id || ''));
    });
  }

  function mergeActiveRuntimeJobs(currentJobs, incomingJobs) {
    var merged = {};
    (Array.isArray(currentJobs) ? currentJobs : []).forEach(function (job) {
      var normalized = normalizeRuntimeJob(job);
      if (!normalized.job_id || !isActiveStatus(normalized.status)) return;
      merged[normalized.job_id] = normalized;
    });
    (Array.isArray(incomingJobs) ? incomingJobs : []).forEach(function (job) {
      var normalized = normalizeRuntimeJob(job);
      if (!normalized.job_id || !isActiveStatus(normalized.status)) return;
      var existing = merged[normalized.job_id];
      if (!existing || normalized.started_at >= existing.started_at) {
        merged[normalized.job_id] = normalized;
      }
    });
    return sortRuntimeJobs(Object.keys(merged).map(function (jobId) { return merged[jobId]; }));
  }

  function removeRuntimeJob(currentJobs, jobId) {
    var safeJobId = String(jobId || '').trim();
    if (!safeJobId) return mergeActiveRuntimeJobs(currentJobs, []);
    return mergeActiveRuntimeJobs(
      (Array.isArray(currentJobs) ? currentJobs : []).filter(function (job) {
        return String(job && job.job_id || '').trim() !== safeJobId;
      }),
      []
    );
  }

  function findLatestRuntimeJob(jobs) {
    var sorted = sortRuntimeJobs(
      (Array.isArray(jobs) ? jobs : []).map(normalizeRuntimeJob).filter(function (job) {
        return job.job_id && isActiveStatus(job.status);
      })
    );
    return sorted.length ? sorted[0] : null;
  }

  function shouldPromptForNotifications(options) {
    var settings = options && typeof options === 'object' ? options : {};
    return !!(
      settings.jobStarted
      && settings.notificationSupported
      && String(settings.permission || '').trim().toLowerCase() === 'default'
    );
  }

  function shouldSendCompletionNotification(options) {
    var settings = options && typeof options === 'object' ? options : {};
    return !!(
      settings.notificationSupported
      && String(settings.permission || '').trim().toLowerCase() === 'granted'
      && isTerminalStatus(settings.status)
    );
  }

  function buildCompletionNotification(job, statusPayload) {
    var runtimeJob = normalizeRuntimeJob(job);
    var payload = statusPayload && typeof statusPayload === 'object' ? statusPayload : {};
    var status = String(payload.status || runtimeJob.status || '').trim().toLowerCase();
    if (!shouldSendCompletionNotification({
      notificationSupported: true,
      permission: 'granted',
      status: status,
    })) {
      return null;
    }
    var title = runtimeJob.study_pack_title || 'Study pack';
    if (status === 'complete') {
      return {
        title: 'Processing complete',
        body: '"' + title + '" is ready in Study Library.',
      };
    }
    return {
      title: 'Processing failed',
      body: (payload.error || runtimeJob.error || ('"' + title + '" did not finish successfully.')).trim(),
    };
  }

  var exported = {
    normalizeRuntimeJob: normalizeRuntimeJob,
    isActiveStatus: isActiveStatus,
    isTerminalStatus: isTerminalStatus,
    sortRuntimeJobs: sortRuntimeJobs,
    mergeActiveRuntimeJobs: mergeActiveRuntimeJobs,
    removeRuntimeJob: removeRuntimeJob,
    findLatestRuntimeJob: findLatestRuntimeJob,
    shouldPromptForNotifications: shouldPromptForNotifications,
    shouldSendCompletionNotification: shouldSendCompletionNotification,
    buildCompletionNotification: buildCompletionNotification,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  root.LectureProcessorRuntimeJobUtils = Object.assign({}, root.LectureProcessorRuntimeJobUtils || {}, exported);
})(typeof window !== 'undefined' ? window : globalThis);
