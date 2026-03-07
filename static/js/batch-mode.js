(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var authClient = auth && authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;

  var body = document.body;
  var forcedMode = String((body && body.dataset && body.dataset.forcedMode) || 'lecture-notes').trim();
  var mode = ['lecture-notes', 'slides-only', 'interview'].indexOf(forcedMode) >= 0 ? forcedMode : 'lecture-notes';

  var MODE_META = {
    'lecture-notes': {
      plural: 'Lectures',
      singular: 'Lecture',
      requiresSlides: true,
      requiresAudio: true,
      heroDescription: 'Create one batch request with multiple lectures. Each row produces its own outputs, and the batch can be downloaded as one ZIP.',
      minimumNote: 'Minimum 2 lectures required for batch mode.',
    },
    'slides-only': {
      plural: 'Slides',
      singular: 'Slide set',
      requiresSlides: true,
      requiresAudio: false,
      heroDescription: 'Create one batch request with multiple slide sets. Each row produces its own outputs, and the batch can be downloaded as one ZIP.',
      minimumNote: 'Minimum 2 slides sets required for batch mode.',
    },
    interview: {
      plural: 'Interviews',
      singular: 'Interview',
      requiresSlides: false,
      requiresAudio: true,
      heroDescription: 'Create one batch request with multiple interviews. Each row produces its own outputs, and the batch can be downloaded as one ZIP.',
      minimumNote: 'Minimum 2 interviews required for batch mode.',
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
  var BATCH_CACHE_KEY_PREFIX = 'batch_mode_last_batch_';

  function modeMeta() {
    return MODE_META[mode] || MODE_META['lecture-notes'];
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
    var className = href.indexOf('/api/batch/jobs/') === 0 ? 'btn small' : 'btn small secondary';
    if (href.indexOf('/api/batch/jobs/') === 0) {
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
      statusBanner.style.display = 'none';
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
    statusBanner.style.display = '';
    Array.prototype.slice.call(statusBanner.querySelectorAll('[data-batch-action-href]')).forEach(function (button) {
      button.addEventListener('click', function () {
        var href = String(button.getAttribute('data-batch-action-href') || '').trim();
        if (!href) return;
        window.open(href, '_blank');
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
    submitBtn.textContent = String(label || (locked ? 'Queued…' : 'Start batch'));
  }

  function showSubmitFeedback(summary) {
    if (!submitFeedback) return;
    var payload = summary || {};
    var title = String(payload.batch_title || (batchTitleInput ? batchTitleInput.value : '') || currentBatchId || 'Batch').trim();
    var submittedAt = payload.created_at ? formatDate(payload.created_at) : formatDate(Date.now() / 1000);
    var status = String(payload.status || 'queued').trim();
    submitFeedback.innerHTML =
      'Batch accepted at <strong>' + escapeHtml(submittedAt) + '</strong> (' + escapeHtml(status) + '). ' +
      'You can continue using the app while it runs. ' +
      'Study Library folder: <strong>' + escapeHtml(title) + '</strong>. ' +
      '<a href="/batch_dashboard">Open Batch Dashboard</a>.';
    submitFeedback.style.display = '';
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
      outputLanguageCustom.style.display = key === 'other' ? '' : 'none';
      if (key !== 'other') outputLanguageCustom.value = '';
    }
  }

  function setStudyFeature(value) {
    var next = ['none', 'flashcards', 'test', 'both'].indexOf(value) >= 0 ? value : 'none';
    if (studyFeaturesInput) studyFeaturesInput.value = next;
    studyToolChips.forEach(function (chip) {
      chip.classList.toggle('active', chip.dataset.studyFeature === next);
    });

    var hideFlashcards = mode === 'interview' || next === 'none' || next === 'test';
    var hideQuestions = mode === 'interview' || next === 'none' || next === 'flashcards';
    if (flashcardWrap) flashcardWrap.style.display = hideFlashcards ? 'none' : '';
    if (questionWrap) questionWrap.style.display = hideQuestions ? 'none' : '';
  }

  function setAmountSelection(kind, value) {
    if (kind === 'flashcards') {
      if (flashcardInput) flashcardInput.value = value;
      flashcardAmountChips.forEach(function (chip) {
        chip.classList.toggle('active', chip.dataset.value === value);
      });
      return;
    }
    if (questionInput) questionInput.value = value;
    questionAmountChips.forEach(function (chip) {
      chip.classList.toggle('active', chip.dataset.value === value);
    });
  }

  function updateRowLabels() {
    var meta = modeMeta();
    if (rowsTitle) rowsTitle.textContent = meta.plural;
    if (rowsMinimumNote) rowsMinimumNote.textContent = meta.minimumNote || ('Minimum 2 ' + meta.plural.toLowerCase() + ' required for batch mode.');
    if (statusRowHeader) statusRowHeader.textContent = meta.singular;
    if (addRowLabel) addRowLabel.textContent = 'Add ' + meta.singular.toLowerCase();
    if (heroDescription) heroDescription.textContent = meta.heroDescription || '';

    Array.prototype.slice.call(rowsWrap.querySelectorAll('.batch-row')).forEach(function (rowNode, index) {
      var titleEl = rowNode.querySelector('.batch-row-head h3');
      if (titleEl) titleEl.textContent = meta.singular + ' ' + String(index + 1);
    });
  }

  function updateTopControls() {
    var showStudyDefaults = mode !== 'interview';
    if (studyDefaultsWrap) studyDefaultsWrap.style.display = showStudyDefaults ? '' : 'none';
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
        info.style.display = 'flex';
        zone.classList.add('has-file');
        syncRowAudioSourceVisual(rowNode);
        return;
      }
      if (state.importedAudioToken) {
        nameEl.textContent = state.importedAudioName || 'Imported audio';
        metaEl.textContent = (state.importedAudioSizeBytes > 0 ? formatFileSize(state.importedAudioSizeBytes) + ' · ' : '') + 'Imported from URL';
        info.style.display = 'flex';
        zone.classList.add('has-file');
        syncRowAudioSourceVisual(rowNode);
        return;
      }
    }

    if (file) {
      nameEl.textContent = file.name;
      metaEl.textContent = formatFileSize(file.size);
      info.style.display = 'flex';
      zone.classList.add('has-file');
    } else {
      info.style.display = 'none';
      zone.classList.remove('has-file');
    }
    syncRowAudioSourceVisual(rowNode);
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
      if (reason === 'manual') alert('Please sign in first.');
      return Promise.resolve({ ok: false, reason: 'not-signed-in' });
    }
    var url = getRowM3u8Url(rowNode);
    if (!url) {
      setRowAudioImportStatus(rowNode, 'Paste the LMS video URL first.', 'error');
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
      return applyRowImportedAudio(
        rowNode,
        result.payload,
        previousToken,
        url,
        reason !== 'auto-start'
      ).then(function () {
        return { ok: true, reason: 'imported' };
      });
    }).catch(function () {
      setRowAudioImportStatus(rowNode, 'Import failed: Could not import audio from the LMS video URL. Please try again.', 'error');
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
    var panel = rowNode.querySelector('[data-override-panel]');
    if (!panel) return;
    var hidden = rowNode.querySelector('input[data-field="override-study"]');
    var next = ['none', 'flashcards', 'test', 'both'].indexOf(value) >= 0 ? value : 'both';
    if (hidden) hidden.value = next;
    Array.prototype.slice.call(rowNode.querySelectorAll('[data-override-study-chip]')).forEach(function (chip) {
      chip.classList.toggle('active', chip.dataset.overrideStudyChip === next);
    });

    var flashWrap = rowNode.querySelector('[data-override-flashcards-wrap]');
    var questionWrapNode = rowNode.querySelector('[data-override-questions-wrap]');
    if (flashWrap) flashWrap.style.display = (next === 'none' || next === 'test') ? 'none' : '';
    if (questionWrapNode) questionWrapNode.style.display = (next === 'none' || next === 'flashcards') ? 'none' : '';
  }

  function setRowOverrideAmount(rowNode, kind, value) {
    var field = kind === 'flashcards' ? 'override-flashcards' : 'override-questions';
    var hidden = rowNode.querySelector('input[data-field="' + field + '"]');
    if (hidden) hidden.value = value;

    var selector = kind === 'flashcards' ? '[data-override-flashcards-chip]' : '[data-override-questions-chip]';
    var dataKey = kind === 'flashcards' ? 'overrideFlashcardsChip' : 'overrideQuestionsChip';
    Array.prototype.slice.call(rowNode.querySelectorAll(selector)).forEach(function (chip) {
      chip.classList.toggle('active', chip.dataset[dataKey] === value);
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
    var panel = rowNode.querySelector('[data-override-panel]');
    if (!enabledCheckbox || !panel) return;

    var syncOverrideVisible = function () {
      panel.classList.toggle('enabled', !!enabledCheckbox.checked);
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
    Array.prototype.slice.call(rowNode.querySelectorAll('[data-interview-feature-chip]')).forEach(function (chip) {
      chip.addEventListener('click', function () {
        chip.classList.toggle('active');
      });
    });
  }

  function removeRow(rowNode) {
    if (rowCount() <= 2) {
      alert('Batch mode requires at least 2 rows.');
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

    var overrideBlockHtml = mode !== 'interview' ? (
      '<div class="row-override">' +
      '  <div class="row-override-head">' +
      '    <label class="custom-check">' +
      '      <input type="checkbox" data-field="override-enabled">' +
      '      <span class="custom-check-box" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"></polyline></svg></span>' +
      '      <span class="custom-check-label">Study tools override</span>' +
      '    </label>' +
      '    <div class="row-override-help"><span class="info-dot" aria-hidden="true">i</span><span>Change study tools for this row only. If disabled, this row uses the top Study tools settings.</span></div>' +
      '  </div>' +
      '  <div class="row-override-panel" data-override-panel>' +
      '    <input type="hidden" data-field="override-study" value="both">' +
      '    <input type="hidden" data-field="override-flashcards" value="20">' +
      '    <input type="hidden" data-field="override-questions" value="10">' +
      '    <div>' +
      '      <span class="control-label">Study tools</span>' +
      '      <div class="tool-chip-grid">' +
      '        <button type="button" class="tool-chip" data-override-study-chip="none">No study tools</button>' +
      '        <button type="button" class="tool-chip" data-override-study-chip="flashcards">Flashcards only</button>' +
      '        <button type="button" class="tool-chip" data-override-study-chip="test">Practice test only</button>' +
      '        <button type="button" class="tool-chip active" data-override-study-chip="both">Flashcards + test</button>' +
      '      </div>' +
      '    </div>' +
      '    <div data-override-flashcards-wrap>' +
      '      <span class="control-label">Flashcard amount</span>' +
      '      <div class="amount-chips">' +
      '        <button type="button" class="amount-chip" data-override-flashcards-chip="10">10</button>' +
      '        <button type="button" class="amount-chip active" data-override-flashcards-chip="20">20</button>' +
      '        <button type="button" class="amount-chip" data-override-flashcards-chip="30">30</button>' +
      '        <button type="button" class="amount-chip" data-override-flashcards-chip="auto">Auto</button>' +
      '      </div>' +
      '    </div>' +
      '    <div data-override-questions-wrap>' +
      '      <span class="control-label">Practice questions</span>' +
      '      <div class="amount-chips">' +
      '        <button type="button" class="amount-chip" data-override-questions-chip="5">5</button>' +
      '        <button type="button" class="amount-chip active" data-override-questions-chip="10">10</button>' +
      '        <button type="button" class="amount-chip" data-override-questions-chip="15">15</button>' +
      '        <button type="button" class="amount-chip" data-override-questions-chip="auto">Auto</button>' +
      '      </div>' +
      '    </div>' +
      '  </div>' +
      '</div>'
    ) : '';

    var slidesFieldHtml = meta.requiresSlides ? (
      '<div class="row-field row-field--slides">' +
      '  <span class="row-label">Slides (PDF/PPTX)</span>' +
      '  <div class="row-upload-zone" data-upload-zone="slides" tabindex="0">' +
      '    <div class="row-upload-title">Upload slides</div>' +
      '    <div class="row-upload-subtitle">Drag & drop or click to browse</div>' +
      '    <input type="file" data-field="slides" accept=".pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation">' +
      '    <div class="row-file-info" data-file-info="slides" style="display:none;">' +
      '      <div>' +
      '        <div class="row-file-name" data-file-name="slides"></div>' +
      '        <div class="row-file-meta" data-file-meta="slides"></div>' +
      '      </div>' +
      '      <button type="button" class="file-remove" data-remove-file="slides" aria-label="Remove slides file">' +
      '        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>' +
      '      </button>' +
      '    </div>' +
      '  </div>' +
      '</div>'
    ) : '';

    var audioFieldHtml = meta.requiresAudio ? (
      '<div class="row-field row-field--audio">' +
      '  <span class="row-label">Audio file</span>' +
      '  <div class="row-upload-zone" data-upload-zone="audio" tabindex="0">' +
      '    <div class="row-upload-title">Upload audio</div>' +
      '    <div class="row-upload-subtitle">Drag & drop or click to browse</div>' +
      '    <input type="file" data-field="audio" accept=".mp3,.m4a,.wav,.aac,.ogg,.flac,audio/*">' +
      '    <div class="row-file-info" data-file-info="audio" style="display:none;">' +
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
        mode === 'lecture-notes'
          ? (
            '  <div class="row-url-import" data-audio-url-wrap>' +
            '    <div class="row-url-head">' +
            '      <strong>Import from LMS video URL</strong>' +
            '      <span>Paste the LMS video playlist URL (usually contains <code>index.m3u8</code>). Audio can be auto-imported for this lecture row.</span>' +
            '    </div>' +
            '    <div class="row-url-row">' +
            '      <input type="url" class="row-url-input" data-field="m3u8" placeholder="https://.../index.m3u8?..." autocomplete="off">' +
            '      <button type="button" class="btn small" data-action="import-audio-url">Import audio</button>' +
            '    </div>' +
            '    <div class="row-url-help">' +
            '      <span class="info-dot" aria-hidden="true">i</span>' +
            '      <span>These links expire quickly. Importing stores audio immediately so the batch can still run even when processing takes longer.</span>' +
            '    </div>' +
            '    <div class="row-url-status" data-field="m3u8-status" aria-live="polite"></div>' +
            '  </div>' +
            overrideBlockHtml
          )
          : ''
      ) +
      '</div>'
    ) : '';

    var interviewExtrasHtml = mode === 'interview' ? (
      '<div class="row-field">' +
      '  <span class="row-label">Interview extras</span>' +
      '  <div class="interview-extra-grid">' +
      '    <button type="button" class="interview-extra-chip active" data-interview-feature-chip="summary">Summary (max 1 page)</button>' +
      '    <button type="button" class="interview-extra-chip active" data-interview-feature-chip="sections">Structured transcript with headings</button>' +
      '  </div>' +
      '  <div class="control-note">Select one or both options (1 text extraction credit per option).</div>' +
      '</div>'
    ) : '';

    var overrideHtml = mode === 'slides-only' ? (
      '<div class="row-field row-field-override">' + overrideBlockHtml + '</div>'
    ) : '';

    var rowModeClass = mode === 'lecture-notes' ? 'mode-lecture' : (mode === 'slides-only' ? 'mode-slides' : 'mode-interview');
    var card = document.createElement('article');
    card.className = 'batch-row ' + rowModeClass;
    card.dataset.rowId = rowId;
    card.innerHTML =
      '<div class="batch-row-head">' +
      '  <h3>' + meta.singular + ' ' + String(ordinal) + '</h3>' +
      '  <button type="button" class="btn danger-soft" data-action="remove-row">Remove</button>' +
      '</div>' +
      '<div class="batch-row-fields">' +
      slidesFieldHtml + audioFieldHtml + interviewExtrasHtml + overrideHtml +
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
    if (mode === 'lecture-notes') {
      wireUploadField(card, 'audio');
      wireAudioImport(card);
    } else if (meta.requiresAudio) {
      wireUploadField(card, 'audio');
    }
    if (mode === 'interview') wireInterviewExtras(card);
    if (mode !== 'interview') wireRowOverride(card);

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
          if (mode === 'lecture-notes') {
            throw new Error(meta.singular + ' ' + rowOrdinal + ': provide an audio file or import from an LMS video URL.');
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

      if (mode === 'interview') {
        row.interview_features = Array.prototype.slice.call(rowNode.querySelectorAll('[data-interview-feature-chip].active')).map(function (chip) {
          return String(chip.dataset.interviewFeatureChip || '').trim();
        });
      } else {
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
      throw new Error('Batch mode requires at least 2 rows.');
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
      '</div>';

    if (downloadZipBtn) {
      downloadZipBtn.style.display = summary.can_download_zip ? '' : 'none';
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
      var statusText = rowStatus + (rowStage ? ' · ' + rowStage : '') + (row.failed_stage ? ' (' + String(row.failed_stage) + ')' : '');
      var statusDetail = rowError ? '<div class="batch-row-error-text">' + escapeHtml(truncateText(rowError, 180)) + '</div>' : '';
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
          window.open('/api/batch/jobs/' + encodeURIComponent(currentBatchId) + '/rows/' + encodeURIComponent(rowId) + '/download-docx', '_blank');
        });

        var cardsBtn = document.createElement('button');
        cardsBtn.type = 'button';
        cardsBtn.className = 'btn tiny';
        cardsBtn.textContent = 'Flashcards CSV';
        cardsBtn.addEventListener('click', function () {
          window.open('/api/batch/jobs/' + encodeURIComponent(currentBatchId) + '/rows/' + encodeURIComponent(rowId) + '/download-flashcards-csv?type=flashcards', '_blank');
        });

        var testBtn = document.createElement('button');
        testBtn.type = 'button';
        testBtn.className = 'btn tiny';
        testBtn.textContent = 'Test CSV';
        testBtn.addEventListener('click', function () {
          window.open('/api/batch/jobs/' + encodeURIComponent(currentBatchId) + '/rows/' + encodeURIComponent(rowId) + '/download-flashcards-csv?type=test', '_blank');
        });

        actionsCell.appendChild(docxBtn);
        actionsCell.appendChild(cardsBtn);
        actionsCell.appendChild(testBtn);
      } else {
        actionsCell.textContent = '-';
      }
      rowsBody.appendChild(tr);
    });

    var locked = status === 'queued' || status === 'processing' || Boolean(summary.submission_locked);
    startLockedByBatchState = locked;
    setStartButtonState(locked, locked ? 'Queued…' : 'Start batch');

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
    return authFetch('/api/batch/jobs/' + encodeURIComponent(currentBatchId))
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
    if (mode !== 'lecture-notes') return Promise.resolve();
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
            throw new Error('Lecture ' + String(index + 1) + ': could not auto-import the LMS video URL. Please import it manually or upload audio.');
          }
          if (result.reason === 'imported') importedCount += 1;
          return true;
        });
      });
    });
    return chain.then(function () {
      if (importedCount > 0) {
        showShellToast('Imported audio for ' + importedCount + ' lecture row' + (importedCount === 1 ? '' : 's') + '.', 'success');
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
    setStartButtonState(true, 'Queued…');
    showSubmitFeedback({
      status: 'queued',
      created_at: Date.now() / 1000,
      batch_title: batchTitleInput ? batchTitleInput.value : '',
    });

    try {
      await runAutoImportSweepBeforeStart();
      if (!activeSubmissionId) {
        activeSubmissionId = makeSubmissionId();
      }
      var formData = collectRowsAndFormData(activeSubmissionId);
      var response = await authFetch('/api/batch/jobs', {
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
      if (payload.deduplicated) {
        showShellToast('This submission was already accepted. Showing the existing batch.', 'success');
      }
      if (statusPanel) statusPanel.style.display = 'block';
      await refreshBatchStatus({ silent: true });
      scheduleNextPoll();
      activeSubmissionId = '';
    } catch (error) {
      showShellToast(String(error && error.message ? error.message : error), 'error');
      pendingStartRequest = false;
      if (!startLockedByBatchState) {
        setStartButtonState(false, 'Start batch');
      }
    } finally {
      if (!pendingStartRequest && !startLockedByBatchState && !currentBatchId) {
        activeSubmissionId = '';
      }
    }
  }

  function startPollingForBatch() {
    if (!currentBatchId) return;
    if (statusPanel) statusPanel.style.display = 'block';
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
    } else {
      currentBatchId = readCachedBatchId();
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
          setStartButtonState(false, 'Start batch');
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
        window.open('/api/batch/jobs/' + encodeURIComponent(currentBatchId) + '/download.zip', '_blank');
      });
    }

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

    if (auth) {
      auth.onAuthStateChanged(function (user) {
        if (user && queryBatchId) {
          currentBatchId = queryBatchId;
          startPollingForBatch();
          return;
        }
        if (user && !queryBatchId) {
          var cachedBatchId = readCachedBatchId();
          if (cachedBatchId) {
            currentBatchId = cachedBatchId;
            startPollingForBatch();
          }
        }
        if (!user) {
          currentBatchId = '';
          startLockedByBatchState = false;
          pendingStartRequest = false;
          setStartButtonState(false, 'Start batch');
          stopPolling();
        }
      });
    }
  }

  boot();
})();
