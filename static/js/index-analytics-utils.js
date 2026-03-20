(function (global) {
  'use strict';

  function normalizeProcessingMode(value) {
    var safeValue = String(value || '').trim().toLowerCase();
    if (safeValue === 'lecture-notes' || safeValue === 'slides-only' || safeValue === 'interview') {
      return safeValue;
    }
    return '';
  }

  function normalizePageKey(value) {
    return String(value || '').trim().toLowerCase();
  }

  function resolveProcessingAnalyticsPage(options) {
    var state = options && typeof options === 'object' ? options : {};
    var forcedMode = normalizeProcessingMode(state.forcedMode);
    if (forcedMode === 'lecture-notes') return 'lecture-notes';
    if (forcedMode === 'slides-only') return 'slides-extraction';
    if (forcedMode === 'interview') return 'interview-transcription';

    var shellPageKey = normalizePageKey(state.shellPageKey);
    if (shellPageKey) return shellPageKey;

    var pathname = normalizePageKey(state.pathname);
    if (pathname === '/lecture-notes') return 'lecture-notes';
    if (pathname === '/slides-extraction') return 'slides-extraction';
    if (pathname === '/interview-transcription') return 'interview-transcription';
    return 'processing';
  }

  var exported = {
    resolveProcessingAnalyticsPage: resolveProcessingAnalyticsPage,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  global.LectureProcessorIndexAnalytics = Object.assign({}, global.LectureProcessorIndexAnalytics || {}, exported);
})(typeof window !== 'undefined' ? window : globalThis);
