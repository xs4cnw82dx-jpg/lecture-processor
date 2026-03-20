(function (root) {
  'use strict';

  function getProgressStepsForMode(mode, totalSteps, modeConfig) {
    var safeMode = String(mode || '').trim();
    var requestedTotal = Math.max(0, Number(totalSteps || 0));
    var config = modeConfig && typeof modeConfig === 'object' ? modeConfig : {};
    var interviewSteps = Array.isArray(config.interview && config.interview.steps) ? config.interview.steps.slice() : [];
    var slidesSteps = Array.isArray(config['slides-only'] && config['slides-only'].steps) ? config['slides-only'].steps.slice() : [];
    var lectureSteps = Array.isArray(config['lecture-notes'] && config['lecture-notes'].steps) ? config['lecture-notes'].steps.slice() : [];

    if (safeMode === 'interview') {
      if (requestedTotal > 1) {
        return [{ num: 1, label: 'Transcribe' }, { num: 2, label: 'Create Extras' }];
      }
      return interviewSteps;
    }

    var baseSteps = safeMode === 'slides-only' ? slidesSteps : lectureSteps;
    if (requestedTotal > 0 && requestedTotal < baseSteps.length) {
      return baseSteps.slice(0, requestedTotal);
    }
    return baseSteps;
  }

  function buildRuntimeJobSnapshot(job, fallback, runtimeJobUtils) {
    var payload = Object.assign({}, fallback || {}, job || {});
    if (runtimeJobUtils && typeof runtimeJobUtils.normalizeRuntimeJob === 'function') {
      return runtimeJobUtils.normalizeRuntimeJob(payload);
    }
    return payload;
  }

  var exported = {
    getProgressStepsForMode: getProgressStepsForMode,
    buildRuntimeJobSnapshot: buildRuntimeJobSnapshot,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  root.LectureProcessorIndexProgress = Object.assign({}, root.LectureProcessorIndexProgress || {}, exported);
})(typeof window !== 'undefined' ? window : globalThis);
