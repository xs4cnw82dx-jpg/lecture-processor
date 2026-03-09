(function (root) {
  'use strict';

  function normalizeAudioImportUrl(value) {
    return String(value || '').trim();
  }

  function describeAudioImportRequest(options) {
    var settings = options && typeof options === 'object' ? options : {};
    var mode = String(settings.mode || '').trim();
    var url = normalizeAudioImportUrl(settings.url);
    var hasLocalAudioFile = Boolean(settings.hasLocalAudioFile);
    var importedAudioToken = String(settings.importedAudioToken || '').trim();
    var importedAudioSourceUrl = normalizeAudioImportUrl(settings.importedAudioSourceUrl);

    if (mode !== 'lecture-notes') {
      return { shouldImport: false, reason: 'unsupported-mode' };
    }
    if (!url) {
      return { shouldImport: false, reason: 'empty-url' };
    }
    if (hasLocalAudioFile) {
      return { shouldImport: false, reason: 'local-audio-selected' };
    }
    if (importedAudioToken && importedAudioSourceUrl === url) {
      return { shouldImport: false, reason: 'already-imported' };
    }
    if (importedAudioToken && importedAudioSourceUrl && importedAudioSourceUrl !== url) {
      return { shouldImport: true, reason: 'replace-imported-audio' };
    }
    return { shouldImport: true, reason: 'import' };
  }

  function hasReadyImportedAudioToken(options) {
    var settings = options && typeof options === 'object' ? options : {};
    var importedAudioToken = String(settings.importedAudioToken || '').trim();
    var currentUrl = normalizeAudioImportUrl(settings.url);
    var importedAudioSourceUrl = normalizeAudioImportUrl(settings.importedAudioSourceUrl);
    if (!importedAudioToken) return false;
    if (!currentUrl) return true;
    return importedAudioSourceUrl === currentUrl;
  }

  var exported = {
    normalizeAudioImportUrl: normalizeAudioImportUrl,
    describeAudioImportRequest: describeAudioImportRequest,
    hasReadyImportedAudioToken: hasReadyImportedAudioToken,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  root.LectureProcessorLectureAudioImportUtils = Object.assign(
    {},
    root.LectureProcessorLectureAudioImportUtils || {},
    exported
  );
})(typeof window !== 'undefined' ? window : globalThis);
