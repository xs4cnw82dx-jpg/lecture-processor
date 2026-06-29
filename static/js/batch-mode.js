(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var authClient = auth && authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;
  var downloadUtils = window.LectureProcessorDownload || {};

  var body = document.body;
  var forcedMode = String((body && body.dataset && body.dataset.forcedMode) || 'lecture-notes').trim();
  var isInstantBatch = String((body && body.dataset && body.dataset.instantBatch) || '').trim() === '1';
  var batchApiBase = isInstantBatch ? '/api/instant-batch/jobs' : '/api/batch/jobs';
  var batchKindLabel = isInstantBatch ? 'Instant batch' : 'Batch';
  var mode = ['lecture-notes', 'slides-only', 'interview', 'audio-transcription', 'text-combine'].indexOf(forcedMode) >= 0 ? forcedMode : 'lecture-notes';
  var batchPage = document.getElementById('batch-page');
  var modeLinks = Array.prototype.slice.call(document.querySelectorAll('.mode-link[href]'));

  var MODE_META = {
    'lecture-notes': {
      plural: 'Lectures',
      singular: 'Lecture',
      requiresSlides: true,
      requiresAudio: true,
      allowsAudioUrlImport: true,
      supportsStudyTools: true,
      heroDescription: 'Create one batch request with multiple lectures. Each row produces its own outputs, and the batch can be downloaded as one ZIP.',
      instantHeroDescription: 'Start multiple lectures immediately. Up to 2 rows run at once, and each row shows live progress while it produces outputs.',
      minimumNote: 'Minimum 2 lectures required for batch mode.',
    },
    'slides-only': {
      plural: 'Slides',
      singular: 'Slide set',
      requiresSlides: true,
      requiresAudio: false,
      allowsAudioUrlImport: false,
      supportsStudyTools: true,
      heroDescription: 'Create one batch request with multiple slide sets. Each row produces its own outputs, and the batch can be downloaded as one ZIP.',
      instantHeroDescription: 'Start multiple slide extractions immediately. Up to 2 rows run at once, and each row shows live progress.',
      minimumNote: 'Minimum 2 slides sets required for batch mode.',
    },
    interview: {
      plural: 'Interviews',
      singular: 'Interview',
      requiresSlides: false,
      requiresAudio: true,
      allowsAudioUrlImport: false,
      supportsStudyTools: false,
      heroDescription: 'Create one batch request with multiple interviews. Each row produces its own outputs, and the batch can be downloaded as one ZIP.',
      instantHeroDescription: 'Start multiple interview transcriptions immediately. Up to 2 rows run at once, with clear progress for every recording.',
      minimumNote: 'Minimum 2 interviews required for batch mode.',
    },
    'audio-transcription': {
      plural: 'Audio recordings',
      singular: 'Audio recording',
      requiresSlides: false,
      requiresAudio: true,
      requiresTextInputs: false,
      allowsAudioUrlImport: true,
      supportsStudyTools: false,
      heroDescription: 'Create one batch request with multiple lecture recordings. Each row produces a clean transcript, and the batch can be downloaded as one ZIP.',
      instantHeroDescription: 'Start multiple audio transcriptions immediately. Up to 2 rows run at once, and every row shows what audio step is active.',
      minimumNote: 'Minimum 2 audio recordings required for batch mode.',
    },
    'text-combine': {
      plural: 'Text sets',
      singular: 'Text set',
      requiresSlides: false,
      requiresAudio: false,
      requiresTextInputs: true,
      allowsAudioUrlImport: false,
      supportsStudyTools: false,
      heroDescription: 'Create one batch request from existing slide extraction and transcript text files. Each row produces complete lecture notes, and the batch can be downloaded as one ZIP.',
      instantHeroDescription: 'Combine multiple text sets immediately. Up to 2 rows run at once, with live progress while notes are merged.',
      minimumNote: 'Minimum 2 text sets required for batch mode.',
    },
  };

  var OUTPUT_LANGUAGE_LABELS = {
    english: '🇬🇧 English',
    dutch: '🇳🇱 Dutch',
    spanish: '🇪🇸 Spanish',
    french: '🇫🇷 French',
    german: '🇩🇪 German',
    chinese: '🇨🇳 Chinese',
    other: '🌐 Other',
  };

  var form = document.getElementById('batch-form');
  var rowsWrap = document.getElementById('rows-wrap');
  var addRowBtn = document.getElementById('add-row-btn');
  var addRowLabel = document.getElementById('add-row-label');
  var submitBtn = document.getElementById('submit-batch-btn');
  var heroDescription = document.getElementById('batch-hero-description');
  var rowsTitle = document.getElementById('rows-title');
  var rowsMinimumNote = document.getElementById('rows-minimum-note');
  var statusRowHeader = document.getElementById('status-row-header');
  var batchTitleInput = document.getElementById('batch-title');

  var outputLanguageInput = document.getElementById('output-language');
  var outputLanguageButton = document.getElementById('output-language-button');
  var outputLanguageLabel = document.getElementById('output-language-label');
  var outputLanguageMenu = document.getElementById('output-language-menu');
  var outputLanguageItems = outputLanguageMenu ? Array.prototype.slice.call(outputLanguageMenu.querySelectorAll('.app-select-item[data-value]')) : [];
  var outputLanguageCustom = document.getElementById('output-language-custom');

  var studyDefaultsWrap = document.getElementById('study-defaults-wrap');
  var studyFeaturesInput = document.getElementById('study-features');
  var studyToolChips = Array.prototype.slice.call(document.querySelectorAll('#study-tool-chips [data-study-feature]'));

  var flashcardWrap = document.getElementById('flashcard-wrap');
  var flashcardInput = document.getElementById('flashcard-amount');
  var flashcardAmountChips = Array.prototype.slice.call(document.querySelectorAll('#flashcard-amount-chips .amount-chip[data-value]'));

  var questionWrap = document.getElementById('question-wrap');
  var questionInput = document.getElementById('question-amount');
  var questionAmountChips = Array.prototype.slice.call(document.querySelectorAll('#question-amount-chips .amount-chip[data-value]'));
  var combinedDocxCheckbox = document.getElementById('include-combined-docx');

  var statusPanel = document.getElementById('batch-status-panel');
  var refreshStatusBtn = document.getElementById('refresh-status-btn');
  var downloadZipBtn = document.getElementById('download-zip-btn');
  var statusBanner = document.getElementById('batch-status-banner');
  var summaryEl = document.getElementById('batch-summary');
  var rowsBody = document.getElementById('batch-rows-body');
  var submitFeedback = document.getElementById('batch-submit-feedback');

  var rowStates = new Map();
  var currentBatchId = '';
  var pollTimer = null;
  var queryBatchId = '';
  var activeSubmissionId = '';
  var pendingStartRequest = false;
  var startLockedByBatchState = false;
  var BATCH_CACHE_KEY_PREFIX = isInstantBatch ? 'instant_batch_mode_last_batch_' : 'batch_mode_last_batch_';

  function modeMeta() {
    return MODE_META[mode] || MODE_META['lecture-notes'];
  }

  function modeSupportsStudyTools() {
    return !!modeMeta().supportsStudyTools;
  }

  function modeAllowsAudioUrlImport() {
    return !!modeMeta().allowsAudioUrlImport;
  }

  function showShellToast(message, variant) {
    var shell = window.LectureProcessorShell || {};
    if (shell && typeof shell.showToast === 'function') {
      shell.showToast(message, variant || '');
    }
  }

  function authFetch(path, options) {
    if (authClient && typeof authClient.authFetch === 'function') {
      return authClient.authFetch(path, options, { retryOn401: true });
    }
    if (!auth || !auth.currentUser) {
      return Promise.reject(new Error('Please sign in'));
    }
    return auth.currentUser.getIdToken().then(function (token) {
      var opts = options || {};
      var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
      return fetch(path, Object.assign({}, opts, { headers: headers }));
    });
  }

  function saveBlobFallback(response, fallbackName) {
    return response.blob().then(function (blob) {
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = fallbackName || 'download';
      document.body.appendChild(anchor);
      anchor.click();
      document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
      return fallbackName;
    });
  }

  function parseDownloadError(response) {
    return response.json().catch(function () { return {}; }).then(function (payload) {
      throw new Error((payload && payload.error) || 'Could not download this file.');
    });
  }

  function downloadAuthenticatedFile(path, fallbackName, button) {
    var originalText = button ? button.textContent : '';
    if (button) {
      button.disabled = true;
      button.textContent = 'Downloading...';
    }
    return authFetch(path).then(function (response) {
      if (!response.ok) return parseDownloadError(response);
      if (downloadUtils && typeof downloadUtils.downloadResponseBlob === 'function') {
        return downloadUtils.downloadResponseBlob(response, fallbackName);
      }
      return saveBlobFallback(response, fallbackName);
    }).then(function () {
      showShellToast('Download started.');
    }).catch(function (error) {
      showShellToast(error && error.message ? error.message : 'Could not download this file.', 'error');
    }).finally(function () {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    });
  }

  function isProtectedBatchDownload(href) {
    var value = String(href || '').trim();
    return (
      /^\/api\/(?:instant-)?batch\/jobs\/[^?#]+\/download\.zip(?:[?#].*)?$/.test(value) ||
      /^\/api\/(?:instant-)?batch\/jobs\/[^?#]+\/rows\/[^?#]+\/download-docx(?:[?#].*)?$/.test(value) ||
      /^\/api\/(?:instant-)?batch\/jobs\/[^?#]+\/rows\/[^?#]+\/download-flashcards-csv(?:[?#].*)?$/.test(value)
    );
  }

  function openBatchActionHref(href, button) {
    if (!href) return;
    if (isProtectedBatchDownload(href)) {
      downloadAuthenticatedFile(href, 'batch-download', button);
      return;
    }
    window.open(href, '_blank');
  }

  function rowCount() {
    return rowsWrap ? rowsWrap.querySelectorAll('.batch-row').length : 0;
  }

  function hasValidBatchTitle() {
    var value = String((batchTitleInput && batchTitleInput.value) || '').trim();
    return value.length > 0;
  }

  function formatDate(secondsValue) {
    var safe = Number(secondsValue || 0);
    if (!safe) return '-';
    var date = new Date(safe * 1000);
    if (Number.isNaN(date.getTime())) return '-';
    return date.toLocaleString(navigator.language || 'en-US', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatTokens(value) {
    var safe = Number(value || 0);
    if (!Number.isFinite(safe)) return '0';
    return Math.round(safe).toLocaleString();
  }

  function truncateText(value, maxLength) {
    var text = String(value || '').trim();
    var limit = Math.max(20, Number(maxLength || 0) || 140);
    if (text.length <= limit) return text;
    return text.slice(0, limit - 1).trim() + '…';
  }

  function statusTone(status) {
    var safe = String(status || '').trim().toLowerCase();
    if (safe === 'complete') return 'success';
    if (safe === 'partial') return 'warning';
    if (safe === 'error') return 'error';
    return 'info';
  }

  function batchActionHtml(summary) {
    var label = String(summary.next_action_label || '').trim();
    var href = String(summary.next_action_href || '').trim();
    if (!label || !href) return '';
    var apiAction = href.indexOf('/api/batch/jobs/') === 0 || href.indexOf('/api/instant-batch/jobs/') === 0;
    var className = apiAction ? 'btn small' : 'btn small secondary';
    if (apiAction) {
      return '<button type="button" class="' + className + '" data-batch-action-href="' + escapeHtml(href) + '">' + escapeHtml(label) + '</button>';
    }
    return '<a class="' + className + '" href="' + escapeHtml(href) + '">' + escapeHtml(label) + '</a>';
  }

  function renderStatusBanner(summary) {
    if (!statusBanner) return;
    var message = String(summary.status_message || '').trim();
    var errorMessage = String(summary.error_message || '').trim();
    var details = errorMessage && errorMessage !== message ? errorMessage : '';
    var actionHtml = batchActionHtml(summary);
    if (!message && !details && !actionHtml) {
      statusBanner.hidden = true;
      statusBanner.innerHTML = '';
      statusBanner.className = 'batch-status-banner';
      return;
    }
    statusBanner.className = 'batch-status-banner tone-' + statusTone(summary.status);
    statusBanner.innerHTML =
      '<div class="batch-status-banner-head">' +
      '  <strong>' + escapeHtml(message || 'Batch update') + '</strong>' +
      (details ? '<span>' + escapeHtml(details) + '</span>' : '') +
      '</div>' +
      (actionHtml ? '<div class="batch-status-banner-actions">' + actionHtml + '</div>' : '');
    statusBanner.hidden = false;
    Array.prototype.slice.call(statusBanner.querySelectorAll('[data-batch-action-href]')).forEach(function (button) {
      button.addEventListener('click', function () {
        var href = String(button.getAttribute('data-batch-action-href') || '').trim();
        openBatchActionHref(href, button);
      });
    });
  }

  function formatFileSize(bytes) {
    var total = Math.max(0, Number(bytes || 0));
    if (!total) return '0 B';
    var units = ['B', 'KB', 'MB', 'GB'];
    var idx = Math.min(units.length - 1, Math.floor(Math.log(total) / Math.log(1024)));
    return (total / Math.pow(1024, idx)).toFixed(idx === 0 ? 0 : 2) + ' ' + units[idx];
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function storageKeyForMode() {
    return BATCH_CACHE_KEY_PREFIX + mode;
  }

  function cacheCurrentBatchId(batchId) {
    try {
      if (!batchId) {
        window.localStorage.removeItem(storageKeyForMode());
        return;
      }
      window.localStorage.setItem(storageKeyForMode(), String(batchId));
    } catch (_error) {
      // Ignore local storage failures.
    }
  }

  function readCachedBatchId() {
    try {
      return String(window.localStorage.getItem(storageKeyForMode()) || '').trim();
    } catch (_error) {
      return '';
    }
  }

  function setBatchIdInUrl(batchId) {
    try {
      var params = new URLSearchParams(window.location.search || '');
      if (batchId) {
        params.set('batch_id', String(batchId));
      } else {
        params.delete('batch_id');
      }
      var query = params.toString();
      var nextUrl = window.location.pathname + (query ? ('?' + query) : '') + (window.location.hash || '');
      window.history.replaceState({}, '', nextUrl);
    } catch (_error) {
      // Ignore URL rewrite failures.
    }
  }

  function makeSubmissionId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'submit-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
  }

  function setStartButtonState(locked, label) {
    if (!submitBtn) return;
    submitBtn.disabled = !!locked;
    submitBtn.textContent = String(label || (locked ? 'Queued…' : (isInstantBatch ? 'Start instant batch' : 'Start batch')));
  }

  function showSubmitFeedback(summary) {
    if (!submitFeedback) return;
    var payload = summary || {};
    var title = String(payload.batch_title || (batchTitleInput ? batchTitleInput.value : '') || currentBatchId || 'Batch').trim();
    var submittedAt = payload.created_at ? formatDate(payload.created_at) : formatDate(Date.now() / 1000);
    var status = String(payload.status || 'queued').trim();
    submitFeedback.innerHTML =
      batchKindLabel + ' accepted at <strong>' + escapeHtml(submittedAt) + '</strong> (' + escapeHtml(status) + '). ' +
      (isInstantBatch ? 'Processing starts immediately. ' : 'You can continue using the app while it runs. ') +
      'Study Library folder: <strong>' + escapeHtml(title) + '</strong>. ' +
      '<a href="/batch_status">Open batch status</a>.';
    submitFeedback.hidden = false;
  }

  function showSubmitPendingFeedback(message) {
    if (!submitFeedback) return;
    submitFeedback.textContent = String(message || 'Submitting batch...');
    submitFeedback.hidden = false;
  }

  function showSubmitErrorFeedback(message) {
    if (!submitFeedback) return;
    submitFeedback.textContent = String(message || 'Batch could not be started.');
    submitFeedback.hidden = false;
  }

  function makeRowId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    return 'row-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  }

  function setOutputLanguageMenuVisible(visible) {
    if (!outputLanguageMenu || !outputLanguageButton) return;
    outputLanguageMenu.classList.toggle('visible', !!visible);
    outputLanguageButton.classList.toggle('open', !!visible);
    outputLanguageButton.setAttribute('aria-expanded', visible ? 'true' : 'false');
  }

  function getLanguageLabel(value, customValue) {
    var key = String(value || 'english').trim().toLowerCase();
    if (key === 'other') {
      var custom = String(customValue || '').trim();
      return custom || OUTPUT_LANGUAGE_LABELS.other;
    }
    return OUTPUT_LANGUAGE_LABELS[key] || OUTPUT_LANGUAGE_LABELS.english;
  }

  function setOutputLanguage(value) {
    var key = Object.prototype.hasOwnProperty.call(OUTPUT_LANGUAGE_LABELS, value) ? value : 'english';
    if (outputLanguageInput) outputLanguageInput.value = key;
    if (outputLanguageLabel) outputLanguageLabel.textContent = getLanguageLabel(key, outputLanguageCustom ? outputLanguageCustom.value : '');
    outputLanguageItems.forEach(function (item) {
      var active = item.dataset.value === key;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    if (outputLanguageCustom) {
      outputLanguageCustom.hidden = key !== 'other';
      if (key !== 'other') outputLanguageCustom.value = '';
    }
  }

  function setStudyFeature(value) {
    var next = ['none', 'flashcards', 'test', 'both'].indexOf(value) >= 0 ? value : 'none';
    if (studyFeaturesInput) studyFeaturesInput.value = next;
    studyToolChips.forEach(function (chip) {
      var active = chip.dataset.studyFeature === next;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    var disableStudyTools = !modeSupportsStudyTools();
    var hideFlashcards = disableStudyTools || next === 'none' || next === 'test';
    var hideQuestions = disableStudyTools || next === 'none' || next === 'flashcards';
    if (flashcardWrap) flashcardWrap.hidden = hideFlashcards;
    if (questionWrap) questionWrap.hidden = hideQuestions;
  }

  function setAmountSelection(kind, value) {
    if (kind === 'flashcards') {
      if (flashcardInput) flashcardInput.value = value;
      flashcardAmountChips.forEach(function (chip) {
        var active = chip.dataset.value === value;
        chip.classList.toggle('active', active);
        chip.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
      return;
    }
    if (questionInput) questionInput.value = value;
    questionAmountChips.forEach(function (chip) {
      var active = chip.dataset.value === value;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function updateRowLabels() {
    var meta = modeMeta();
    if (rowsTitle) rowsTitle.textContent = meta.plural;
    if (rowsMinimumNote) rowsMinimumNote.textContent = isInstantBatch
      ? ((meta.minimumNote || ('Minimum 2 ' + meta.plural.toLowerCase() + ' required for batch mode.')).replace('batch mode', 'instant batch') + ' Maximum 20 rows.')
      : (meta.minimumNote || ('Minimum 2 ' + meta.plural.toLowerCase() + ' required for batch mode.'));
    if (statusRowHeader) statusRowHeader.textContent = meta.singular;
    if (addRowLabel) addRowLabel.textContent = 'Add ' + meta.singular.toLowerCase();
    if (heroDescription) heroDescription.textContent = (isInstantBatch ? meta.instantHeroDescription : meta.heroDescription) || '';

    Array.prototype.slice.call(rowsWrap.querySelectorAll('.batch-row')).forEach(function (rowNode, index) {
      var titleEl = rowNode.querySelector('.batch-row-head h3');
      if (titleEl) titleEl.textContent = meta.singular + ' ' + String(index + 1);
      var slidesZone = rowNode.querySelector('[data-upload-zone="slides"]');
      if (slidesZone) slidesZone.setAttribute('aria-label', 'Upload slides for ' + meta.singular + ' ' + String(index + 1));
      var audioZone = rowNode.querySelector('[data-upload-zone="audio"]');
      if (audioZone) audioZone.setAttribute('aria-label', 'Upload audio for ' + meta.singular + ' ' + String(index + 1));
      var slideTextZone = rowNode.querySelector('[data-upload-zone="slideText"]');
      if (slideTextZone) slideTextZone.setAttribute('aria-label', 'Upload slide extraction text for ' + meta.singular + ' ' + String(index + 1));
      var transcriptTextZone = rowNode.querySelector('[data-upload-zone="transcriptText"]');
      if (transcriptTextZone) transcriptTextZone.setAttribute('aria-label', 'Upload audio transcript text for ' + meta.singular + ' ' + String(index + 1));
    });
  }

  function updateTopControls() {
    var showStudyDefaults = modeSupportsStudyTools();
    if (studyDefaultsWrap) studyDefaultsWrap.hidden = !showStudyDefaults;
    if (!showStudyDefaults) {
      if (studyFeaturesInput) studyFeaturesInput.value = 'none';
    } else {
      setStudyFeature(studyFeaturesInput ? studyFeaturesInput.value : 'both');
    }
    updateRowLabels();
  }

  function getRowState(rowNode) {
    var rowId = String((rowNode && rowNode.dataset && rowNode.dataset.rowId) || '');
    if (!rowId) {
      return {
        importedAudioToken: '',
        importedAudioName: '',
        importedAudioSizeBytes: 0,
        importedAudioSourceUrl: '',
        importingInFlight: false,
        importPromise: null,
      };
    }
    if (!rowStates.has(rowId)) {
      rowStates.set(rowId, {
        importedAudioToken: '',
        importedAudioName: '',
        importedAudioSizeBytes: 0,
        importedAudioSourceUrl: '',
        importingInFlight: false,
        importPromise: null,
      });
    }
    return rowStates.get(rowId);
  }

  function setRowAudioImportStatus(rowNode, message, statusKind) {
    var statusEl = rowNode.querySelector('[data-field="m3u8-status"]');
    if (!statusEl) return;
    var text = String(message || '').trim();
    statusEl.textContent = text;
    statusEl.classList.remove('pending', 'success', 'error', 'info');
    if (text && ['pending', 'success', 'error', 'info'].indexOf(statusKind) >= 0) {
      statusEl.classList.add(statusKind);
    }
  }

  function setRowAudioImportPending(rowNode, inFlight) {
    var button = rowNode.querySelector('[data-action="import-audio-url"]');
    var state = getRowState(rowNode);
    state.importingInFlight = !!inFlight;
    if (!button) return;
    if (!button.dataset.defaultLabel) button.dataset.defaultLabel = button.textContent || 'Import audio';
    button.disabled = !!inFlight;
    button.textContent = inFlight ? 'Importing...' : (button.dataset.defaultLabel || 'Import audio');
  }

  function syncRowAudioSourceVisual(rowNode) {
    var wrap = rowNode.querySelector('[data-audio-url-wrap]');
    if (!wrap) return;
    var state = getRowState(rowNode);
    var input = rowNode.querySelector('input[data-field="m3u8"]');
    var hasInput = input && String(input.value || '').trim().length > 0;
    wrap.classList.toggle('active', hasInput || !!state.importedAudioToken);
  }

  function syncRowFileUI(rowNode, fieldName) {
    var input = rowNode.querySelector('input[data-field="' + fieldName + '"]');
    var zone = rowNode.querySelector('[data-upload-zone="' + fieldName + '"]');
    var info = rowNode.querySelector('[data-file-info="' + fieldName + '"]');
    var nameEl = rowNode.querySelector('[data-file-name="' + fieldName + '"]');
    var metaEl = rowNode.querySelector('[data-file-meta="' + fieldName + '"]');
    if (!input || !zone || !info || !nameEl || !metaEl) return;

    var file = input.files && input.files[0] ? input.files[0] : null;
    if (fieldName === 'audio') {
      var state = getRowState(rowNode);
      if (file) {
        nameEl.textContent = file.name;
        metaEl.textContent = formatFileSize(file.size);
        info.hidden = false;
        zone.classList.add('has-file');
        syncRowAudioSourceVisual(rowNode);
        return;
      }
      if (state.importedAudioToken) {
        nameEl.textContent = state.importedAudioName || 'Imported audio';
        metaEl.textContent = (state.importedAudioSizeBytes > 0 ? formatFileSize(state.importedAudioSizeBytes) + ' · ' : '') + 'Imported from URL';
        info.hidden = false;
        zone.classList.add('has-file');
        syncRowAudioSourceVisual(rowNode);
        return;
      }
    }

    if (file) {
      nameEl.textContent = file.name;
      metaEl.textContent = formatFileSize(file.size);
      info.hidden = false;
      zone.classList.add('has-file');
    } else {
      info.hidden = true;
      zone.classList.remove('has-file');
    }
    syncRowAudioSourceVisual(rowNode);
    if (fieldName === 'slideText' || fieldName === 'transcriptText') {
      syncTextCombineBadge(rowNode);
    }
  }

  function textFileSelected(rowNode, fieldName) {
    var input = rowNode.querySelector('input[data-field="' + fieldName + '"]');
    return !!(input && input.files && input.files[0]);
  }

  function textCombineModeLabel(rowNode) {
    var hasSlideText = textFileSelected(rowNode, 'slideText');
    var hasTranscriptText = textFileSelected(rowNode, 'transcriptText');
    if (hasSlideText && hasTranscriptText) return 'Slides + transcript';
    if (hasSlideText) return 'Slides only';
    if (hasTranscriptText) return 'Transcript only';
    return 'No text files selected';
  }

  function syncTextCombineBadge(rowNode) {
    var badge = rowNode.querySelector('[data-text-combine-badge]');
    if (!badge) return;
    var label = textCombineModeLabel(rowNode);
    badge.textContent = label;
    badge.classList.toggle('is-empty', label === 'No text files selected');
  }

  function clearRowImportedAudioState(rowNode) {
    var state = getRowState(rowNode);
    state.importedAudioToken = '';
    state.importedAudioName = '';
    state.importedAudioSizeBytes = 0;
    state.importedAudioSourceUrl = '';
    state.importingInFlight = false;
    state.importPromise = null;
  }

  function releaseRowImportedAudio(rowNode, options) {
    var opts = options || {};
    var state = getRowState(rowNode);
    var token = String(state.importedAudioToken || '').trim();
    var clearStatus = opts.clearStatus !== false;
    if (!token) {
      if (clearStatus) setRowAudioImportStatus(rowNode, '', '');
      return Promise.resolve();
    }

    clearRowImportedAudioState(rowNode);
    syncRowFileUI(rowNode, 'audio');
    if (clearStatus) setRowAudioImportStatus(rowNode, '', '');

    if (!auth || !auth.currentUser) return Promise.resolve();
    return authFetch('/api/import-audio-url/release', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio_import_token: token }),
    }).then(function () {
      return true;
    }).catch(function () {
      return false;
    });
  }

  function applyRowImportedAudio(rowNode, payload, previousToken, importedUrl, announceToast) {
    var state = getRowState(rowNode);
    var token = String(payload && payload.audio_import_token ? payload.audio_import_token : '').trim();
    if (!token) return Promise.resolve(false);

    state.importedAudioToken = token;
    state.importedAudioName = String(payload.file_name || 'Imported audio').trim();
    state.importedAudioSizeBytes = Math.max(0, Number(payload.size_bytes || 0));
    state.importedAudioSourceUrl = String(importedUrl || '').trim();

    var audioInput = rowNode.querySelector('input[data-field="audio"]');
    if (audioInput && audioInput.files && audioInput.files.length) {
      audioInput.value = '';
    }
    syncRowFileUI(rowNode, 'audio');

    var ttlSeconds = Math.max(0, Number(payload.expires_in_seconds || 0));
    if (ttlSeconds > 0) {
      var minutes = Math.max(1, Math.round(ttlSeconds / 60));
      setRowAudioImportStatus(
        rowNode,
        'Imported ' + state.importedAudioName + '. Token expires in about ' + minutes + ' minute' + (minutes === 1 ? '' : 's') + '. Batch mode stores the imported audio immediately when you start the batch.',
        'success'
      );
    } else {
      setRowAudioImportStatus(rowNode, 'Imported ' + state.importedAudioName + '.', 'success');
    }
    if (announceToast) {
      showShellToast('Audio imported successfully for this row.', 'success');
    }

    if (previousToken && previousToken !== token && auth && auth.currentUser) {
      return authFetch('/api/import-audio-url/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio_import_token: previousToken }),
      }).then(function () {
        return true;
      }).catch(function () {
        return true;
      });
    }
    return Promise.resolve(true);
  }

  function waitForAudioImport(ms) {
    return new Promise(function (resolve) {
      window.setTimeout(resolve, Math.max(250, Number(ms || 1000)));
    });
  }

  function pollRowAudioImportJob(rowNode, jobId) {
    var safeJobId = String(jobId || '').trim();
    if (!safeJobId) return Promise.reject(new Error('Audio import did not return a job id.'));
    var deadlineMs = Date.now() + 16 * 60 * 1000;
    var attempt = 0;

    function tick() {
      if (Date.now() >= deadlineMs) {
        throw new Error('Audio import is taking longer than expected. Please try again.');
      }
      return authFetch('/api/import-audio-url/' + encodeURIComponent(safeJobId)).then(function (response) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          return { response: response, payload: payload };
        });
      }).then(function (result) {
        if (!result.response.ok) {
          throw new Error(String(result.payload.error || 'Could not read audio import status.'));
        }
        var status = String(result.payload.status || '').trim().toLowerCase();
        if (status === 'complete' && result.payload.audio_import_token) {
          return result.payload;
        }
        if (status === 'error') {
          throw new Error(String(result.payload.error || 'Audio import failed.'));
        }
        setRowAudioImportStatus(rowNode, String(result.payload.step_description || 'Importing audio from URL...'), 'pending');
        attempt += 1;
        return waitForAudioImport(Math.min(5000, 1000 + attempt * 500)).then(tick);
      });
    }

    return tick();
  }

  function getRowM3u8Url(rowNode) {
    var urlInput = rowNode.querySelector('input[data-field="m3u8"]');
    return String((urlInput && urlInput.value) || '').trim();
  }

  function rowHasLocalAudioFile(rowNode) {
    var audioInput = rowNode.querySelector('input[data-field="audio"]');
    return !!(audioInput && audioInput.files && audioInput.files[0]);
  }

  function shouldAutoImportRow(rowNode) {
    var url = getRowM3u8Url(rowNode);
    if (!url) return false;
    if (rowHasLocalAudioFile(rowNode)) return false;
    var state = getRowState(rowNode);
    if (state.importingInFlight) return false;
    if (!state.importedAudioToken) return true;
    return String(state.importedAudioSourceUrl || '').trim() !== url;
  }

  function importRowAudioFromUrl(rowNode, options) {
    var opts = options || {};
    var reason = String(opts.reason || 'manual');
    var silentIfAlreadyImported = opts.silentIfAlreadyImported !== false;

    if (!auth || !auth.currentUser) {
      if (reason === 'manual') showShellToast('Please sign in first.', 'error');
      return Promise.resolve({ ok: false, reason: 'not-signed-in' });
    }
    var url = getRowM3u8Url(rowNode);
    if (!url) {
      setRowAudioImportStatus(rowNode, 'Paste the audio/video page URL or direct playlist URL first.', 'error');
      return Promise.resolve({ ok: false, reason: 'empty-url' });
    }

    var state = getRowState(rowNode);
    if (state.importingInFlight) {
      return Promise.resolve({ ok: false, reason: 'in-flight' });
    }
    if (state.importedAudioToken && String(state.importedAudioSourceUrl || '').trim() === url) {
      if (!silentIfAlreadyImported) {
        setRowAudioImportStatus(rowNode, 'Already imported from this URL.', 'info');
      }
      return Promise.resolve({ ok: true, reason: 'already-imported' });
    }

    setRowAudioImportPending(rowNode, true);
    setRowAudioImportStatus(rowNode, 'Pending import...', 'pending');
    var previousToken = String(state.importedAudioToken || '').trim();

    var importPromise = authFetch('/api/import-audio-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url }),
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        return { response: response, payload: payload };
      });
    }).then(function (result) {
        if (!result.response.ok) {
          setRowAudioImportStatus(rowNode, 'Import failed: ' + String(result.payload.error || 'Could not import audio from URL.'), 'error');
          return { ok: false, reason: 'import-failed' };
        }
      var readyPayload = result.payload.audio_import_token
        ? Promise.resolve(result.payload)
        : pollRowAudioImportJob(rowNode, result.payload.job_id);
      return readyPayload.then(function (payload) {
        return applyRowImportedAudio(
          rowNode,
          payload,
          previousToken,
          url,
          reason !== 'auto-start'
        );
      }).then(function () {
        return { ok: true, reason: 'imported' };
      });
    }).catch(function () {
      setRowAudioImportStatus(rowNode, 'Import failed: Could not import audio from that URL. Please try again.', 'error');
      return { ok: false, reason: 'network-error' };
    }).finally(function () {
      setRowAudioImportPending(rowNode, false);
    });
    state.importPromise = importPromise;
    return importPromise.finally(function () {
      if (state.importPromise === importPromise) {
        state.importPromise = null;
      }
    });
  }

  function setRowOverrideStudyFeature(rowNode, value) {
    var overrideWrap = rowNode.querySelector('[data-override-wrap]');
    var panel = rowNode.querySelector('[data-override-panel]');
    if (!overrideWrap || !panel) return;
    var hidden = rowNode.querySelector('input[data-field="override-study"]');
    var next = ['none', 'flashcards', 'test', 'both'].indexOf(value) >= 0 ? value : 'both';
    if (hidden) hidden.value = next;
    Array.prototype.slice.call(rowNode.querySelectorAll('[data-override-study-chip]')).forEach(function (chip) {
      var active = chip.dataset.overrideStudyChip === next;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    var flashWrap = rowNode.querySelector('[data-override-flashcards-wrap]');
    var questionWrapNode = rowNode.querySelector('[data-override-questions-wrap]');
    var showFlashcards = next !== 'none' && next !== 'test';
    var showQuestions = next !== 'none' && next !== 'flashcards';
    if (flashWrap) flashWrap.hidden = !showFlashcards;
    if (questionWrapNode) questionWrapNode.hidden = !showQuestions;
    overrideWrap.classList.toggle('amounts-visible', !!(showFlashcards || showQuestions));
  }

  function setRowOverrideAmount(rowNode, kind, value) {
    var field = kind === 'flashcards' ? 'override-flashcards' : 'override-questions';
    var hidden = rowNode.querySelector('input[data-field="' + field + '"]');
    if (hidden) hidden.value = value;

    var selector = kind === 'flashcards' ? '[data-override-flashcards-chip]' : '[data-override-questions-chip]';
    var dataKey = kind === 'flashcards' ? 'overrideFlashcardsChip' : 'overrideQuestionsChip';
    Array.prototype.slice.call(rowNode.querySelectorAll(selector)).forEach(function (chip) {
      var active = chip.dataset[dataKey] === value;
      chip.classList.toggle('active', active);
      chip.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function wireUploadField(rowNode, fieldName) {
    var zone = rowNode.querySelector('[data-upload-zone="' + fieldName + '"]');
    var input = rowNode.querySelector('input[data-field="' + fieldName + '"]');
    var removeBtn = rowNode.querySelector('[data-remove-file="' + fieldName + '"]');
    if (!zone || !input) return;

    var applyDroppedFiles = function (files) {
      if (!files || !files.length) return;
      try {
        var transfer = new DataTransfer();
        transfer.items.add(files[0]);
        input.files = transfer.files;
      } catch (_error) {
        return;
      }
      if (fieldName === 'audio') {
        releaseRowImportedAudio(rowNode, { clearStatus: true }).finally(function () {
          syncRowFileUI(rowNode, fieldName);
        });
      } else {
        syncRowFileUI(rowNode, fieldName);
      }
    };

    zone.addEventListener('click', function (event) {
      if (event.target && event.target.closest('[data-remove-file]')) return;
      input.click();
    });
    zone.addEventListener('keydown', function (event) {
      if (event.target !== zone) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        input.click();
      }
    });
    zone.addEventListener('dragover', function (event) {
      event.preventDefault();
      zone.classList.add('dragover');
    });
    zone.addEventListener('dragleave', function (event) {
      if (event.relatedTarget && zone.contains(event.relatedTarget)) return;
      zone.classList.remove('dragover');
    });
    zone.addEventListener('drop', function (event) {
      event.preventDefault();
      zone.classList.remove('dragover');
      applyDroppedFiles(event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files : null);
    });

    input.addEventListener('change', function () {
      if (fieldName === 'audio') {
        releaseRowImportedAudio(rowNode, { clearStatus: true }).finally(function () {
          syncRowFileUI(rowNode, fieldName);
        });
      } else {
        syncRowFileUI(rowNode, fieldName);
      }
    });

    if (removeBtn) {
      removeBtn.addEventListener('click', function (event) {
        event.preventDefault();
        event.stopPropagation();
        if (fieldName === 'audio') {
          releaseRowImportedAudio(rowNode, { clearStatus: true });
        }
        input.value = '';
        syncRowFileUI(rowNode, fieldName);
      });
    }

    syncRowFileUI(rowNode, fieldName);
  }

  function wireAudioImport(rowNode) {
    var urlInput = rowNode.querySelector('input[data-field="m3u8"]');
    var importBtn = rowNode.querySelector('[data-action="import-audio-url"]');
    if (!urlInput || !importBtn) return;

    urlInput.addEventListener('input', function () {
      syncRowAudioSourceVisual(rowNode);
      var url = getRowM3u8Url(rowNode);
      if (!url) {
        setRowAudioImportStatus(rowNode, '', '');
        return;
      }
      var state = getRowState(rowNode);
      if (state.importedAudioToken && String(state.importedAudioSourceUrl || '').trim() === url) {
        setRowAudioImportStatus(rowNode, 'Already imported from this URL.', 'info');
        return;
      }
      setRowAudioImportStatus(rowNode, 'Pending import.', 'pending');
    });
    urlInput.addEventListener('focus', function () {
      syncRowAudioSourceVisual(rowNode);
    });
    urlInput.addEventListener('blur', function () {
      syncRowAudioSourceVisual(rowNode);
      if (shouldAutoImportRow(rowNode)) {
        importRowAudioFromUrl(rowNode, { reason: 'auto-blur', silentIfAlreadyImported: true });
      }
    });
    urlInput.addEventListener('paste', function () {
      window.setTimeout(function () {
        syncRowAudioSourceVisual(rowNode);
        if (shouldAutoImportRow(rowNode)) {
          importRowAudioFromUrl(rowNode, { reason: 'auto-paste', silentIfAlreadyImported: true });
        }
      }, 0);
    });
    urlInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        importRowAudioFromUrl(rowNode, { reason: 'manual', silentIfAlreadyImported: false });
      }
    });

    importBtn.addEventListener('click', function () {
      importRowAudioFromUrl(rowNode, { reason: 'manual', silentIfAlreadyImported: false });
    });

    syncRowAudioSourceVisual(rowNode);
  }

  function wireRowOverride(rowNode) {
    var enabledCheckbox = rowNode.querySelector('input[data-field="override-enabled"]');
    var overrideWrap = rowNode.querySelector('[data-override-wrap]');
    var panel = rowNode.querySelector('[data-override-panel]');
    if (!enabledCheckbox || !panel || !overrideWrap) return;

    var setOverridePanelInteractive = function (enabled) {
      try {
        panel.inert = !enabled;
      } catch (_) {}
      Array.prototype.slice.call(panel.querySelectorAll('button, input, select, textarea, a[href]')).forEach(function (control) {
        var tag = String(control.tagName || '').toLowerCase();
        var type = String(control.getAttribute('type') || '').toLowerCase();
        if (tag === 'input' && type === 'hidden') return;
        if (!enabled) {
          if (!control.hasAttribute('data-prev-tabindex')) {
            control.setAttribute('data-prev-tabindex', control.hasAttribute('tabindex') ? control.getAttribute('tabindex') : '');
          }
          control.setAttribute('tabindex', '-1');
          control.setAttribute('aria-disabled', 'true');
          if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea') {
            control.disabled = true;
          }
          return;
        }
        var previousTabIndex = control.getAttribute('data-prev-tabindex');
        if (previousTabIndex === '') {
          control.removeAttribute('tabindex');
        } else if (previousTabIndex !== null) {
          control.setAttribute('tabindex', previousTabIndex);
        }
        control.removeAttribute('data-prev-tabindex');
        control.removeAttribute('aria-disabled');
        if (tag === 'button' || tag === 'input' || tag === 'select' || tag === 'textarea') {
          control.disabled = false;
        }
      });
    };

    var syncOverrideVisible = function () {
      var enabled = !!enabledCheckbox.checked;
      overrideWrap.classList.toggle('enabled', enabled);
      setOverridePanelInteractive(enabled);
      panel.setAttribute('aria-hidden', enabled ? 'false' : 'true');
      enabledCheckbox.setAttribute('aria-expanded', enabled ? 'true' : 'false');
      if (!enabled) {
        overrideWrap.classList.remove('amounts-visible');
        return;
      }
      setRowOverrideStudyFeature(
        rowNode,
        String((rowNode.querySelector('input[data-field="override-study"]') || {}).value || 'both')
      );
    };

    enabledCheckbox.addEventListener('change', syncOverrideVisible);

    Array.prototype.slice.call(rowNode.querySelectorAll('[data-override-study-chip]')).forEach(function (chip) {
      chip.addEventListener('click', function () {
        setRowOverrideStudyFeature(rowNode, chip.dataset.overrideStudyChip || 'both');
      });
    });

    Array.prototype.slice.call(rowNode.querySelectorAll('[data-override-flashcards-chip]')).forEach(function (chip) {
      chip.addEventListener('click', function () {
        setRowOverrideAmount(rowNode, 'flashcards', chip.dataset.overrideFlashcardsChip || '20');
      });
    });

    Array.prototype.slice.call(rowNode.querySelectorAll('[data-override-questions-chip]')).forEach(function (chip) {
      chip.addEventListener('click', function () {
        setRowOverrideAmount(rowNode, 'questions', chip.dataset.overrideQuestionsChip || '10');
      });
    });

    setRowOverrideStudyFeature(rowNode, 'both');
    setRowOverrideAmount(rowNode, 'flashcards', '20');
    setRowOverrideAmount(rowNode, 'questions', '10');
    syncOverrideVisible();
  }

  function wireInterviewExtras(rowNode) {
    var note = rowNode.querySelector('[data-interview-extra-note]');
    var syncInterviewExtrasNote = function () {
      var count = rowNode.querySelectorAll('[data-interview-feature-chip].active').length;
      if (!note) return;
      if (count <= 0) {
        note.textContent = 'No extras selected. Select one or both options (1 text extraction credit per option).';
        return;
      }
      note.textContent = count + ' extra' + (count === 1 ? '' : 's') + ' selected (' + count + ' text extraction credit' + (count === 1 ? '' : 's') + ').';
    };
    Array.prototype.slice.call(rowNode.querySelectorAll('[data-interview-feature-chip]')).forEach(function (chip) {
      chip.addEventListener('click', function () {
        chip.classList.toggle('active');
        chip.setAttribute('aria-pressed', chip.classList.contains('active') ? 'true' : 'false');
        syncInterviewExtrasNote();
      });
      chip.setAttribute('aria-pressed', chip.classList.contains('active') ? 'true' : 'false');
    });
    syncInterviewExtrasNote();
  }

  function removeRow(rowNode) {
    if (rowCount() <= 2) {
      showShellToast('Batch mode requires at least 2 rows.', 'error');
      return;
    }
    releaseRowImportedAudio(rowNode, { clearStatus: true }).finally(function () {
      var rowId = String((rowNode.dataset && rowNode.dataset.rowId) || '');
      if (rowId) rowStates.delete(rowId);
      rowNode.remove();
      updateRowLabels();
    });
  }

  function createRow() {
    var meta = modeMeta();
    var ordinal = rowCount() + 1;
    var rowId = makeRowId();

    var overrideBlockHtml = modeSupportsStudyTools() ? (
      '<div class="row-override" data-override-wrap>' +
      '  <div class="row-override-head">' +
      '    <label class="custom-check">' +
      '      <input type="checkbox" data-field="override-enabled" aria-expanded="false">' +
      '      <span class="custom-check-box" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' +
      '      <span class="custom-check-label">Study tools override</span>' +
      '    </label>' +
      '    <div class="row-override-help"><span class="info-dot" aria-hidden="true">i</span><span>Change study tools for this row only. If disabled, this row uses the top Study tools settings.</span></div>' +
      '  </div>' +
      '  <div class="row-override-shell">' +
      '    <div class="row-override-panel" data-override-panel aria-hidden="true">' +
      '      <input type="hidden" data-field="override-study" value="both">' +
      '      <input type="hidden" data-field="override-flashcards" value="20">' +
      '      <input type="hidden" data-field="override-questions" value="10">' +
      '      <div>' +
      '        <span class="control-label">Study tools</span>' +
      '        <div class="tool-chip-grid">' +
      '          <button type="button" class="tool-chip" data-override-study-chip="none">No study tools</button>' +
      '          <button type="button" class="tool-chip" data-override-study-chip="flashcards">Flashcards only</button>' +
      '          <button type="button" class="tool-chip" data-override-study-chip="test">Practice test only</button>' +
      '          <button type="button" class="tool-chip active" data-override-study-chip="both">Flashcards + test <span class="chip-badge">Recommended</span></button>' +
      '        </div>' +
      '      </div>' +
      '      <div class="row-override-amounts">' +
      '        <div class="row-override-amounts-inner">' +
      '          <div data-override-flashcards-wrap>' +
      '            <span class="control-label">Flashcard amount</span>' +
      '            <div class="amount-chips">' +
      '              <button type="button" class="amount-chip" data-override-flashcards-chip="10">10</button>' +
      '              <button type="button" class="amount-chip active" data-override-flashcards-chip="20">20</button>' +
      '              <button type="button" class="amount-chip" data-override-flashcards-chip="30">30</button>' +
      '              <button type="button" class="amount-chip" data-override-flashcards-chip="auto">Auto</button>' +
      '            </div>' +
      '          </div>' +
      '          <div data-override-questions-wrap>' +
      '            <span class="control-label">Practice questions</span>' +
      '            <div class="amount-chips">' +
      '              <button type="button" class="amount-chip" data-override-questions-chip="5">5</button>' +
      '              <button type="button" class="amount-chip active" data-override-questions-chip="10">10</button>' +
      '              <button type="button" class="amount-chip" data-override-questions-chip="15">15</button>' +
      '              <button type="button" class="amount-chip" data-override-questions-chip="auto">Auto</button>' +
      '            </div>' +
      '          </div>' +
      '        </div>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '</div>'
    ) : '';

    var slidesFieldHtml = meta.requiresSlides ? (
      '<div class="row-field row-field--slides">' +
      '  <span class="row-label">Slides (PDF/PPTX)</span>' +
      '  <div class="row-upload-zone" data-upload-zone="slides" role="button" tabindex="0" aria-label="Upload slides for ' + meta.singular + ' ' + String(ordinal) + '">' +
      '    <div class="row-upload-title">Upload slides</div>' +
      '    <div class="row-upload-subtitle">Drag & drop or click to browse</div>' +
      '    <input type="file" data-field="slides" accept=".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation">' +
      '    <div class="row-file-info" data-file-info="slides" hidden>' +
      '      <div>' +
      '        <div class="row-file-name" data-file-name="slides"></div>' +
      '        <div class="row-file-meta" data-file-meta="slides"></div>' +
      '      </div>' +
      '      <button type="button" class="file-remove" data-remove-file="slides" aria-label="Remove slides file">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
      '      </button>' +
      '    </div>' +
      '  </div>' +
      (
        mode === 'lecture-notes'
          ? overrideBlockHtml
          : ''
      ) +
      '</div>'
    ) : '';

    var urlTitleId = 'row-' + String(ordinal) + '-url-title';
    var urlHintId = 'row-' + String(ordinal) + '-url-hint';
    var urlHelpId = 'row-' + String(ordinal) + '-url-help';
    var urlStatusId = 'row-' + String(ordinal) + '-url-status';

    var audioFieldHtml = meta.requiresAudio ? (
      '<div class="row-field row-field--audio">' +
      '  <span class="row-label">Audio file</span>' +
      '  <div class="row-upload-zone" data-upload-zone="audio" role="button" tabindex="0" aria-label="Upload audio for ' + meta.singular + ' ' + String(ordinal) + '">' +
      '    <div class="row-upload-title">Upload audio</div>' +
      '    <div class="row-upload-subtitle">Drag & drop or click to browse</div>' +
      '    <input type="file" data-field="audio" accept=".mp3,.m4a,.wav,.aac,.ogg,.flac,audio/*">' +
      '    <div class="row-file-info" data-file-info="audio" hidden>' +
      '      <div>' +
      '        <div class="row-file-name" data-file-name="audio"></div>' +
      '        <div class="row-file-meta" data-file-meta="audio"></div>' +
      '      </div>' +
      '      <button type="button" class="file-remove" data-remove-file="audio" aria-label="Remove audio file">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
      '      </button>' +
      '    </div>' +
      '  </div>' +
      (
        meta.allowsAudioUrlImport
          ? (
            '  <div class="row-url-import" data-audio-url-wrap>' +
            '    <div class="row-url-head">' +
            '      <strong id="' + urlTitleId + '">Import from audio or video URL</strong>' +
            '      <span id="' + urlHintId + '">Paste the normal lecture video page first. Direct playlist links also work and audio can be auto-imported for this row.</span>' +
            '    </div>' +
            '    <div class="row-url-row">' +
            '      <input type="url" class="row-url-input" data-field="m3u8" placeholder="https://.../audio-video-or-index.m3u8" autocomplete="off" aria-labelledby="' + urlTitleId + '" aria-describedby="' + urlHintId + ' ' + urlHelpId + ' ' + urlStatusId + '">' +
            '      <button type="button" class="btn small" data-action="import-audio-url">Import audio</button>' +
            '    </div>' +
            '    <div class="row-url-help" id="' + urlHelpId + '">' +
            '      <span class="info-dot" aria-hidden="true">i</span>' +
            '      <span>These links expire quickly. Importing stores audio immediately so the batch can still run even when processing takes longer. If the page URL fails, retry with the direct playlist URL.</span>' +
            '    </div>' +
            '    <div class="row-url-status" id="' + urlStatusId + '" data-field="m3u8-status" aria-live="polite"></div>' +
            '  </div>'
          )
          : ''
      ) +
      '</div>'
    ) : '';

    var textCombineFieldsHtml = meta.requiresTextInputs ? (
      '<div class="row-field row-field--text-input">' +
      '  <span class="row-label">Slide extraction text (.txt)</span>' +
      '  <div class="row-upload-zone" data-upload-zone="slideText" role="button" tabindex="0" aria-label="Upload slide extraction text for ' + meta.singular + ' ' + String(ordinal) + '">' +
      '    <div class="row-upload-title">Upload slide text</div>' +
      '    <div class="row-upload-subtitle">Drag & drop or click to browse</div>' +
      '    <input type="file" data-field="slideText" accept=".txt,text/plain">' +
      '    <div class="row-file-info" data-file-info="slideText" hidden>' +
      '      <div>' +
      '        <div class="row-file-name" data-file-name="slideText"></div>' +
      '        <div class="row-file-meta" data-file-meta="slideText"></div>' +
      '      </div>' +
      '      <button type="button" class="file-remove" data-remove-file="slideText" aria-label="Remove slide text file">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
      '      </button>' +
      '    </div>' +
      '  </div>' +
      '</div>' +
      '<div class="row-field row-field--text-input">' +
      '  <span class="row-label">Audio transcript text (.txt)</span>' +
      '  <div class="row-upload-zone" data-upload-zone="transcriptText" role="button" tabindex="0" aria-label="Upload audio transcript text for ' + meta.singular + ' ' + String(ordinal) + '">' +
      '    <div class="row-upload-title">Upload transcript text</div>' +
      '    <div class="row-upload-subtitle">Drag & drop or click to browse</div>' +
      '    <input type="file" data-field="transcriptText" accept=".txt,text/plain">' +
      '    <div class="row-file-info" data-file-info="transcriptText" hidden>' +
      '      <div>' +
      '        <div class="row-file-name" data-file-name="transcriptText"></div>' +
      '        <div class="row-file-meta" data-file-meta="transcriptText"></div>' +
      '      </div>' +
      '      <button type="button" class="file-remove" data-remove-file="transcriptText" aria-label="Remove transcript text file">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
      '      </button>' +
      '    </div>' +
      '  </div>' +
      '</div>' +
      '<div class="text-combine-mode-badge is-empty" data-text-combine-badge>No text files selected</div>'
    ) : '';

    var interviewExtrasHtml = mode === 'interview' ? (
      '<div class="row-field">' +
      '  <span class="row-label">Interview extras</span>' +
      '  <div class="interview-extra-grid">' +
      '    <button type="button" class="interview-extra-chip" data-interview-feature-chip="summary">Summary (max 1 page)</button>' +
      '    <button type="button" class="interview-extra-chip" data-interview-feature-chip="sections">Structured transcript with headings</button>' +
      '  </div>' +
      '  <div class="control-note" data-interview-extra-note>No extras selected. Select one or both options (1 text extraction credit per option).</div>' +
      '</div>'
    ) : '';

    var overrideHtml = mode === 'slides-only' ? (
      '<div class="row-field row-field-override">' + overrideBlockHtml + '</div>'
    ) : '';

    var rowModeClass = {
      'lecture-notes': 'mode-lecture',
      'slides-only': 'mode-slides',
      interview: 'mode-interview',
      'audio-transcription': 'mode-audio',
      'text-combine': 'mode-text-combine',
    }[mode] || 'mode-lecture';
    var card = document.createElement('article');
    card.className = 'batch-row ' + rowModeClass;
    card.dataset.rowId = rowId;
    card.innerHTML =
      '<div class="batch-row-head">' +
      '  <h3>' + meta.singular + ' ' + String(ordinal) + '</h3>' +
      '  <button type="button" class="btn danger-soft" data-action="remove-row">Remove</button>' +
      '</div>' +
      '<div class="batch-row-fields">' +
      slidesFieldHtml + audioFieldHtml + textCombineFieldsHtml + interviewExtrasHtml + overrideHtml +
      '</div>';

    rowsWrap.appendChild(card);
    rowStates.set(rowId, {
      importedAudioToken: '',
      importedAudioName: '',
      importedAudioSizeBytes: 0,
      importedAudioSourceUrl: '',
      importingInFlight: false,
      importPromise: null,
    });

    var removeBtn = card.querySelector('[data-action="remove-row"]');
    if (removeBtn) {
      removeBtn.addEventListener('click', function () {
        removeRow(card);
      });
    }

    if (meta.requiresSlides) wireUploadField(card, 'slides');
    if (modeAllowsAudioUrlImport()) {
      wireUploadField(card, 'audio');
      wireAudioImport(card);
    } else if (meta.requiresAudio) {
      wireUploadField(card, 'audio');
    }
    if (mode === 'interview') wireInterviewExtras(card);
    if (meta.requiresTextInputs) {
      wireUploadField(card, 'slideText');
      wireUploadField(card, 'transcriptText');
      syncTextCombineBadge(card);
    }
    if (modeSupportsStudyTools()) wireRowOverride(card);

    updateRowLabels();
  }

  function ensureMinimumRows() {
    if (!rowsWrap) return;
    while (rowCount() < 2) createRow();
  }

  function collectRowsAndFormData(clientSubmissionId) {
    var formData = new FormData(form);
    formData.append('mode', mode);
    formData.append('client_submission_id', String(clientSubmissionId || '').trim());
    formData.set('include_combined_docx', combinedDocxCheckbox && combinedDocxCheckbox.checked ? '1' : '0');

    var meta = modeMeta();
    var rowNodes = Array.prototype.slice.call(rowsWrap.querySelectorAll('.batch-row'));
    var rows = [];

    rowNodes.forEach(function (rowNode, idx) {
      var rowId = String((rowNode.dataset && rowNode.dataset.rowId) || makeRowId());
      var rowOrdinal = idx + 1;
      var row = { row_id: rowId, ordinal: rowOrdinal };

      if (meta.requiresSlides) {
        var slidesInput = rowNode.querySelector('input[data-field="slides"]');
        var slidesFile = slidesInput && slidesInput.files ? slidesInput.files[0] : null;
        if (!slidesFile) throw new Error(meta.singular + ' ' + rowOrdinal + ': slides file is required.');
        var slidesField = 'row_' + rowOrdinal + '_slides';
        row.slides_file_field = slidesField;
        formData.append(slidesField, slidesFile);
      }

      if (meta.requiresAudio) {
        var audioInput = rowNode.querySelector('input[data-field="audio"]');
        var audioFile = audioInput && audioInput.files ? audioInput.files[0] : null;
        var m3u8Input = rowNode.querySelector('input[data-field="m3u8"]');
        var m3u8Url = m3u8Input ? String(m3u8Input.value || '').trim() : '';
        var state = getRowState(rowNode);
        var importedToken = String(state.importedAudioToken || '').trim();

        if (!audioFile && !importedToken && !m3u8Url) {
          if (meta.allowsAudioUrlImport) {
            throw new Error(meta.singular + ' ' + rowOrdinal + ': provide an audio file or import from an audio or video URL.');
          }
          throw new Error(meta.singular + ' ' + rowOrdinal + ': provide an audio file.');
        }

        if (audioFile) {
          var audioField = 'row_' + rowOrdinal + '_audio';
          row.audio_file_field = audioField;
          formData.append(audioField, audioFile);
        }
        if (!audioFile && importedToken) {
          row.audio_import_token = importedToken;
        } else if (!audioFile && m3u8Url) {
          row.audio_m3u8_url = m3u8Url;
        }
      }

      if (meta.requiresTextInputs) {
        var slideTextInput = rowNode.querySelector('input[data-field="slideText"]');
        var transcriptTextInput = rowNode.querySelector('input[data-field="transcriptText"]');
        var slideTextFile = slideTextInput && slideTextInput.files ? slideTextInput.files[0] : null;
        var transcriptTextFile = transcriptTextInput && transcriptTextInput.files ? transcriptTextInput.files[0] : null;
        if (!slideTextFile && !transcriptTextFile) {
          throw new Error(meta.singular + ' ' + rowOrdinal + ': upload slide text, transcript text, or both.');
        }
        if (slideTextFile) {
          if (!String(slideTextFile.name || '').toLowerCase().endsWith('.txt')) {
            throw new Error(meta.singular + ' ' + rowOrdinal + ': slide text must be a .txt file.');
          }
          var slideTextField = 'row_' + rowOrdinal + '_slide_text';
          row.slide_text_file_field = slideTextField;
          formData.append(slideTextField, slideTextFile);
        }
        if (transcriptTextFile) {
          if (!String(transcriptTextFile.name || '').toLowerCase().endsWith('.txt')) {
            throw new Error(meta.singular + ' ' + rowOrdinal + ': transcript text must be a .txt file.');
          }
          var transcriptTextField = 'row_' + rowOrdinal + '_transcript_text';
          row.transcript_text_file_field = transcriptTextField;
          formData.append(transcriptTextField, transcriptTextFile);
        }
      }

      if (mode === 'interview') {
        row.interview_features = Array.prototype.slice.call(rowNode.querySelectorAll('[data-interview-feature-chip].active')).map(function (chip) {
          return String(chip.dataset.interviewFeatureChip || '').trim();
        });
      } else if (meta.supportsStudyTools) {
        var overrideEnabled = rowNode.querySelector('input[data-field="override-enabled"]');
        if (overrideEnabled && overrideEnabled.checked) {
          row.study_override = {
            study_features: String((rowNode.querySelector('input[data-field="override-study"]') || {}).value || 'both'),
            flashcard_amount: String((rowNode.querySelector('input[data-field="override-flashcards"]') || {}).value || '20'),
            question_amount: String((rowNode.querySelector('input[data-field="override-questions"]') || {}).value || '10'),
          };
        }
      }

      rows.push(row);
    });

    if (rows.length < 2) {
      throw new Error((isInstantBatch ? 'Instant batch' : 'Batch mode') + ' requires at least 2 rows.');
    }
    if (isInstantBatch && rows.length > 20) {
      throw new Error('Instant batch supports up to 20 rows at a time.');
    }

    formData.append('rows', JSON.stringify(rows));
    return formData;
  }

  function isTerminalStatus(status) {
    var value = String(status || '').trim().toLowerCase();
    return value === 'complete' || value === 'partial' || value === 'error';
  }

  function renderStatus(statusPayload) {
    if (!summaryEl || !rowsBody) return;

    var meta = modeMeta();
    var summary = statusPayload || {};
    var status = String(summary.status || 'queued');
    var totalRows = Number(summary.total_rows || 0);
    var completedRows = Number(summary.completed_rows || 0);
    var failedRows = Number(summary.failed_rows || 0);
    var currentStage = String(summary.stage_label || summary.current_stage || '-').trim() || '-';
    var providerState = String(summary.provider_label || summary.provider_state || '-').trim() || '-';
    var errorMessage = String(summary.error_message || '').trim();
    var batchAction = batchActionHtml(summary);

    renderStatusBanner(summary);

    summaryEl.innerHTML =
      '<div class="batch-summary-card">' +
      '  <span class="batch-summary-label">Batch</span>' +
      '  <strong>' + escapeHtml(String(summary.batch_title || summary.batch_id || '-')) + '</strong>' +
      '  <span class="batch-summary-sub">' + escapeHtml(String(summary.status_message || '')) + '</span>' +
      '</div>' +
      '<div class="batch-summary-card">' +
      '  <span class="batch-summary-label">Status</span>' +
      '  <strong>' + escapeHtml(status) + '</strong>' +
      '  <span class="batch-summary-sub">' + escapeHtml(String(summary.current_stage_state || '-')) + '</span>' +
      '</div>' +
      '<div class="batch-summary-card">' +
      '  <span class="batch-summary-label">Current stage</span>' +
      '  <strong>' + escapeHtml(currentStage) + '</strong>' +
      '  <span class="batch-summary-sub">' + escapeHtml(providerState) + '</span>' +
      '</div>' +
      '<div class="batch-summary-card">' +
      '  <span class="batch-summary-label">' + escapeHtml(meta.plural) + '</span>' +
      '  <strong>' + completedRows + '/' + totalRows + ' complete</strong>' +
      '  <span class="batch-summary-sub">' + failedRows + ' failed</span>' +
      '</div>' +
      '<div class="batch-summary-card">' +
      '  <span class="batch-summary-label">Submitted</span>' +
      '  <strong>' + formatDate(summary.created_at) + '</strong>' +
      '  <span class="batch-summary-sub">Last update ' + formatDate(summary.updated_at || summary.last_heartbeat_at || 0) + '</span>' +
      '</div>' +
      '<div class="batch-summary-card">' +
      '  <span class="batch-summary-label">Credits</span>' +
      '  <strong>' + formatTokens(summary.credits_charged) + ' charged</strong>' +
      '  <span class="batch-summary-sub">' + formatTokens(summary.credits_refunded) + ' refunded · ' + formatTokens(summary.credits_refund_pending) + ' pending</span>' +
      '</div>' +
      '<div class="batch-summary-card">' +
      '  <span class="batch-summary-label">Tokens</span>' +
      '  <strong>' + formatTokens(summary.token_total) + ' total</strong>' +
      '  <span class="batch-summary-sub">in ' + formatTokens(summary.token_input_total) + ' · out ' + formatTokens(summary.token_output_total) + '</span>' +
      '</div>' +
      '<div class="batch-summary-card">' +
      '  <span class="batch-summary-label">Email</span>' +
      '  <strong>' + escapeHtml(String(summary.email_status_label || summary.completion_email_status || 'pending')) + '</strong>' +
      '  <span class="batch-summary-sub">' + escapeHtml(truncateText(String(summary.completion_email_error || ''), 120) || 'Notification state saved for this batch.') + '</span>' +
      '</div>' +
      '<div class="batch-summary-card">' +
      '  <span class="batch-summary-label">ZIP extras</span>' +
      '  <strong>' + escapeHtml(summary.export_options && summary.export_options.include_combined_docx ? 'Combined DOCX on' : 'Combined DOCX off') + '</strong>' +
      '  <span class="batch-summary-sub">' + escapeHtml(summary.export_options && summary.export_options.include_combined_docx ? 'Includes one combined Word document in addition to row files.' : 'Downloads contain the individual row files only.') + '</span>' +
      '</div>';

    if (downloadZipBtn) {
      downloadZipBtn.hidden = !summary.can_download_zip;
    }

    rowsBody.innerHTML = '';
    var rows = Array.isArray(summary.rows) ? summary.rows : [];
    rows.forEach(function (row) {
      var rowId = String(row.row_id || '');
      var rowStatus = String(row.status || 'queued');
      var rowStage = String(row.current_stage_label || row.current_stage || '').trim();
      var rowError = String(row.error || '').trim();
      var tr = document.createElement('tr');
      var canDownload = rowStatus === 'complete';
      var rowDetail = String(row.current_stage_detail || '').trim();
      var statusText = rowStatus + (rowStage ? ' · ' + rowStage : '') + (row.failed_stage ? ' (' + String(row.failed_stage) + ')' : '');
      var detailText = rowError || rowDetail;
      var detailClass = rowError ? 'batch-row-error-text' : 'batch-row-progress-text';
      var statusDetail = detailText ? '<div class="' + detailClass + '">' + escapeHtml(truncateText(detailText, 180)) + '</div>' : '';
      tr.innerHTML =
        '<td>' + meta.singular + ' ' + Number(row.ordinal || 0) + '</td>' +
        '<td><div class="batch-row-status-line">' + escapeHtml(statusText) + '</div>' + statusDetail + '</td>' +
        '<td>' + formatTokens(row.token_input_total) + '</td>' +
        '<td>' + formatTokens(row.token_output_total) + '</td>' +
        '<td>' + formatTokens(row.token_total) + '</td>' +
        '<td></td>';

      var actionsCell = tr.lastElementChild;
      if (canDownload && currentBatchId) {
        var docxBtn = document.createElement('button');
        docxBtn.type = 'button';
        docxBtn.className = 'btn tiny';
        docxBtn.textContent = 'DOCX';
        docxBtn.addEventListener('click', function () {
          downloadAuthenticatedFile(
            batchApiBase + '/' + encodeURIComponent(currentBatchId) + '/rows/' + encodeURIComponent(rowId) + '/download-docx',
            'batch-' + currentBatchId + '-' + rowId + '.docx',
            docxBtn
          );
        });

        actionsCell.appendChild(docxBtn);
        if (meta.supportsStudyTools) {
          var cardsBtn = document.createElement('button');
          cardsBtn.type = 'button';
          cardsBtn.className = 'btn tiny';
          cardsBtn.textContent = 'Flashcards CSV';
          cardsBtn.addEventListener('click', function () {
            downloadAuthenticatedFile(
              batchApiBase + '/' + encodeURIComponent(currentBatchId) + '/rows/' + encodeURIComponent(rowId) + '/download-flashcards-csv?type=flashcards',
              'batch-' + currentBatchId + '-' + rowId + '-flashcards.csv',
              cardsBtn
            );
          });

          var testBtn = document.createElement('button');
          testBtn.type = 'button';
          testBtn.className = 'btn tiny';
          testBtn.textContent = 'Test CSV';
          testBtn.addEventListener('click', function () {
            downloadAuthenticatedFile(
              batchApiBase + '/' + encodeURIComponent(currentBatchId) + '/rows/' + encodeURIComponent(rowId) + '/download-flashcards-csv?type=test',
              'batch-' + currentBatchId + '-' + rowId + '-test.csv',
              testBtn
            );
          });

          actionsCell.appendChild(cardsBtn);
          actionsCell.appendChild(testBtn);
        }
      } else {
        actionsCell.textContent = '-';
      }
      rowsBody.appendChild(tr);
    });

    var locked = status === 'queued' || status === 'processing' || Boolean(summary.submission_locked);
    startLockedByBatchState = locked;
    setStartButtonState(locked, locked ? 'Queued…' : (isInstantBatch ? 'Start instant batch' : 'Start batch'));

    if (locked) {
      showSubmitFeedback(summary);
    }
    if (isTerminalStatus(status)) {
      pendingStartRequest = false;
      activeSubmissionId = '';
    }
  }

  function pollDelayMs() {
    return document.visibilityState === 'hidden' ? 60000 : 20000;
  }

  function stopPolling() {
    if (pollTimer) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function scheduleNextPoll() {
    stopPolling();
    if (!currentBatchId) return;
    if (!auth || !auth.currentUser) return;
    pollTimer = window.setTimeout(function () {
      refreshBatchStatus({ silent: true }).finally(function () {
        scheduleNextPoll();
      });
    }, pollDelayMs());
  }

  function refreshBatchStatus(options) {
    var opts = options || {};
    if (!currentBatchId) return Promise.resolve();
    return authFetch(batchApiBase + '/' + encodeURIComponent(currentBatchId))
      .then(function (response) {
        return response.json().then(function (payload) {
          return { response: response, payload: payload };
        });
      })
      .then(function (result) {
        if (!result.response.ok) {
          throw new Error(String(result.payload.error || 'Could not read batch status.'));
        }
        renderStatus(result.payload);
        if (!opts.silent) {
          showShellToast('Batch status refreshed.', 'success');
        }
        if (isTerminalStatus(String(result.payload.status || ''))) {
          stopPolling();
        } else {
          scheduleNextPoll();
        }
      })
      .catch(function (error) {
        console.error('Batch status polling failed:', error);
        if (!opts.silent) {
          showShellToast(String((error && error.message) || 'Could not read batch status.'), 'error');
        }
      });
  }

  function runAutoImportSweepBeforeStart() {
    var meta = modeMeta();
    if (!meta.allowsAudioUrlImport) return Promise.resolve();
    var rowNodes = Array.prototype.slice.call(rowsWrap.querySelectorAll('.batch-row'));
    var importedCount = 0;
    var chain = Promise.resolve();
    rowNodes.forEach(function (rowNode, index) {
      chain = chain.then(function () {
        var state = getRowState(rowNode);
        if (state.importPromise) {
          return state.importPromise.then(function () {
            return true;
          });
        }
        if (!shouldAutoImportRow(rowNode)) return true;
        return importRowAudioFromUrl(rowNode, {
          reason: 'auto-start',
          silentIfAlreadyImported: true,
        }).then(function (result) {
          if (!result || !result.ok) {
            throw new Error(meta.singular + ' ' + String(index + 1) + ': could not auto-import the audio or video URL. Please import it manually or upload audio.');
          }
          if (result.reason === 'imported') importedCount += 1;
          return true;
        });
      });
    });
    return chain.then(function () {
      if (importedCount > 0) {
        showShellToast('Imported audio for ' + importedCount + ' row' + (importedCount === 1 ? '' : 's') + '.', 'success');
      }
      return true;
    });
  }

  async function startBatch() {
    if (!auth || !auth.currentUser) {
      showShellToast('Please sign in first.', 'error');
      return;
    }
    if (!submitBtn) return;
    if (pendingStartRequest) return;
    if (!hasValidBatchTitle()) {
      showShellToast('Batch title is required.', 'error');
      if (batchTitleInput) batchTitleInput.focus();
      return;
    }

    pendingStartRequest = true;
    setStartButtonState(true, 'Submitting...');
    showSubmitPendingFeedback('Preparing batch...');

    try {
      showSubmitPendingFeedback('Preparing rows...');
      await runAutoImportSweepBeforeStart();
      if (!activeSubmissionId) {
        activeSubmissionId = makeSubmissionId();
      }
      var formData = collectRowsAndFormData(activeSubmissionId);
      showSubmitPendingFeedback('Submitting batch...');
      var response = await authFetch(batchApiBase, {
        method: 'POST',
        body: formData,
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        throw new Error(String(payload.error || 'Could not create batch.'));
      }
      currentBatchId = String(payload.batch_id || '');
      if (!currentBatchId) throw new Error('No batch id returned.');
      cacheCurrentBatchId(currentBatchId);
      setBatchIdInUrl(currentBatchId);
      setStartButtonState(true, isInstantBatch ? 'Running…' : 'Queued…');
      showSubmitFeedback(Object.assign({}, payload, {
        status: payload.status || 'queued',
        batch_title: payload.batch_title || (batchTitleInput ? batchTitleInput.value : ''),
      }));
      if (payload.deduplicated) {
        showShellToast('This submission was already accepted. Showing the existing batch.', 'success');
      }
      if (statusPanel) statusPanel.hidden = false;
      await refreshBatchStatus({ silent: true });
      scheduleNextPoll();
      activeSubmissionId = '';
    } catch (error) {
      showShellToast(String(error && error.message ? error.message : error), 'error');
      showSubmitErrorFeedback(String(error && error.message ? error.message : 'Could not create batch.'));
      pendingStartRequest = false;
      if (!startLockedByBatchState) {
        setStartButtonState(false, isInstantBatch ? 'Start instant batch' : 'Start batch');
      }
    } finally {
      if (!pendingStartRequest && !startLockedByBatchState && !currentBatchId) {
        activeSubmissionId = '';
      }
    }
  }

  function startPollingForBatch() {
    if (!currentBatchId) return;
    if (statusPanel) statusPanel.hidden = false;
    if (!auth || !auth.currentUser) return;
    refreshBatchStatus({ silent: true });
    scheduleNextPoll();
  }

  function restoreBatchIdFromQuery() {
    try {
      var params = new URLSearchParams(window.location.search || '');
      var value = String(params.get('batch_id') || '').trim();
      queryBatchId = value;
    } catch (_error) {
      queryBatchId = '';
    }
    if (queryBatchId) {
      currentBatchId = queryBatchId;
      cacheCurrentBatchId(queryBatchId);
    }
    if (!currentBatchId) return;
    setBatchIdInUrl(currentBatchId);
    startPollingForBatch();
  }

  function wireEvents() {
    if (addRowBtn) {
      addRowBtn.addEventListener('click', function () {
        createRow();
      });
    }

    if (form) {
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        startBatch();
      });
    }

    if (batchTitleInput) {
      batchTitleInput.addEventListener('input', function () {
        if (!submitBtn) return;
        if (!pendingStartRequest && !startLockedByBatchState) {
          activeSubmissionId = '';
          setStartButtonState(false, isInstantBatch ? 'Start instant batch' : 'Start batch');
        }
      });
    }

    if (form) {
      form.addEventListener('change', function () {
        if (!pendingStartRequest && !startLockedByBatchState) {
          activeSubmissionId = '';
        }
      });
    }

    studyToolChips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        setStudyFeature(chip.dataset.studyFeature || 'none');
      });
    });

    flashcardAmountChips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        setAmountSelection('flashcards', chip.dataset.value || '20');
      });
    });

    questionAmountChips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        setAmountSelection('questions', chip.dataset.value || '10');
      });
    });

    if (outputLanguageButton && outputLanguageMenu) {
      outputLanguageButton.addEventListener('click', function (event) {
        event.stopPropagation();
        var isVisible = outputLanguageMenu.classList.contains('visible');
        setOutputLanguageMenuVisible(!isVisible);
      });
      outputLanguageItems.forEach(function (item) {
        item.addEventListener('click', function () {
          setOutputLanguage(item.dataset.value || 'english');
          setOutputLanguageMenuVisible(false);
        });
      });
    }

    if (outputLanguageCustom) {
      outputLanguageCustom.addEventListener('input', function () {
        if (outputLanguageInput && outputLanguageInput.value === 'other' && outputLanguageLabel) {
          outputLanguageLabel.textContent = getLanguageLabel('other', outputLanguageCustom.value);
        }
      });
    }

    document.addEventListener('click', function (event) {
      var picker = document.getElementById('output-language-picker');
      if (!picker || !picker.contains(event.target)) {
        setOutputLanguageMenuVisible(false);
      }
    });

    if (refreshStatusBtn) {
      refreshStatusBtn.addEventListener('click', function () {
        refreshBatchStatus({ silent: false });
      });
    }

    if (downloadZipBtn) {
      downloadZipBtn.addEventListener('click', function () {
        if (!currentBatchId) return;
        downloadAuthenticatedFile(
          batchApiBase + '/' + encodeURIComponent(currentBatchId) + '/download.zip',
          'batch-' + currentBatchId + '.zip',
          downloadZipBtn
        );
      });
    }

    modeLinks.forEach(function (link) {
      var prefetchedHref = '';
      function prefetchHref() {
        var href = String(link.getAttribute('href') || '').trim();
        if (!href || href === window.location.pathname || href === prefetchedHref) return;
        prefetchedHref = href;
        try {
          var prefetch = document.createElement('link');
          prefetch.rel = 'prefetch';
          prefetch.href = href;
          document.head.appendChild(prefetch);
        } catch (_error) {
          // Ignore prefetch failures.
        }
      }
      link.addEventListener('mouseenter', prefetchHref);
      link.addEventListener('focus', prefetchHref);
      link.addEventListener('click', function (event) {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (event.button !== 0) return;
        var href = String(link.getAttribute('href') || '').trim();
        if (!href || href === window.location.pathname) return;
        event.preventDefault();
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          window.location.href = href;
          return;
        }
        if (batchPage) {
          batchPage.classList.remove('is-ready');
          batchPage.classList.add('is-leaving');
        }
        window.setTimeout(function () {
          window.location.href = href;
        }, 220);
      });
    });

    document.addEventListener('visibilitychange', function () {
      if (!currentBatchId) return;
      scheduleNextPoll();
    });
  }

  function boot() {
    setOutputLanguage((outputLanguageInput && outputLanguageInput.value) || 'english');
    setStudyFeature((studyFeaturesInput && studyFeaturesInput.value) || 'both');
    setAmountSelection('flashcards', (flashcardInput && flashcardInput.value) || '20');
    setAmountSelection('questions', (questionInput && questionInput.value) || '10');

    updateTopControls();
    ensureMinimumRows();
    wireEvents();
    restoreBatchIdFromQuery();
    if (batchPage) {
      window.requestAnimationFrame(function () {
        batchPage.classList.add('is-ready');
      });
    }

    if (auth) {
      bootstrap.onAuthStateReady(auth, function (user) {
        if (user && queryBatchId) {
          currentBatchId = queryBatchId;
          startPollingForBatch();
          return;
        }
        if (!user) {
          currentBatchId = '';
          startLockedByBatchState = false;
          pendingStartRequest = false;
          setStartButtonState(false, isInstantBatch ? 'Start instant batch' : 'Start batch');
          stopPolling();
        }
      });
    }
  }

  boot();
})();
