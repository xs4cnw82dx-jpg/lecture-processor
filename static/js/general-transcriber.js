(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;
  var downloadUtils = window.LectureProcessorDownload || {};

  if (!auth) return;

  var OUTPUT_LANGUAGE_LABELS = {
    english: '\ud83c\uddec\ud83c\udde7 English',
    dutch: '\ud83c\uddf3\ud83c\uddf1 Dutch',
    spanish: '\ud83c\uddea\ud83c\uddf8 Spanish',
    french: '\ud83c\uddeb\ud83c\uddf7 French',
    german: '\ud83c\udde9\ud83c\uddea German',
    chinese: '\ud83c\udde8\ud83c\uddf3 Chinese',
    other: '\ud83c\udf10 Other'
  };

  var fileInput = document.getElementById('transcriber-file-input');
  var dropzone = document.getElementById('transcriber-dropzone');
  var fileInfo = document.getElementById('transcriber-file-info');
  var fileNameEl = document.getElementById('transcriber-file-name');
  var fileSizeEl = document.getElementById('transcriber-file-size');
  var fileRemoveBtn = document.getElementById('transcriber-file-remove');
  var outputLanguageInput = document.getElementById('transcriber-output-language');
  var outputLanguagePicker = document.getElementById('transcriber-output-language-picker');
  var outputLanguageButton = document.getElementById('transcriber-output-language-button');
  var outputLanguageLabel = document.getElementById('transcriber-output-language-label');
  var outputLanguageMenu = document.getElementById('transcriber-output-language-menu');
  var outputLanguageItems = outputLanguageMenu ? Array.prototype.slice.call(outputLanguageMenu.querySelectorAll('.app-select-item[data-value]')) : [];
  var outputLanguageCustom = document.getElementById('transcriber-output-language-custom');
  var languageNote = document.getElementById('transcriber-language-note');
  var runBtn = document.getElementById('transcriber-run-btn');
  var creditNote = document.getElementById('transcriber-credit-note');
  var authPanel = document.getElementById('transcriber-auth-panel');
  var authLink = document.getElementById('transcriber-auth-link');
  var statusEl = document.getElementById('transcriber-status');
  var outputPre = document.getElementById('transcriber-output-pre');
  var copyBtn = document.getElementById('transcriber-copy-btn');
  var downloadBtn = document.getElementById('transcriber-download-docx-btn');
  var toastEl = document.getElementById('transcriber-toast');

  var currentUser = auth.currentUser || null;
  var authStateResolved = !!currentUser;
  var selectedFile = null;
  var running = false;
  var lastOutput = '';
  var currentJobId = '';
  var pollTimer = null;
  var interviewCredits = null;
  var toastTimer = null;
  var languageUserTouched = false;

  function getSignedInUser() {
    return currentUser || auth.currentUser || null;
  }

  function hasSignedInSession() {
    if (getSignedInUser()) return true;
    return !!(authClient && typeof authClient.getToken === 'function' && authClient.getToken());
  }

  function authStateIsPending() {
    return !authStateResolved && !hasSignedInSession();
  }

  function showToast(message, type) {
    if (!toastEl || !message) return;
    toastEl.textContent = String(message);
    toastEl.className = 'reader-toast visible' + (type ? ' ' + type : '');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toastEl.className = 'reader-toast';
    }, 2200);
  }

  function setStatus(message, type) {
    if (!statusEl) return;
    statusEl.textContent = String(message || '');
    statusEl.className = type ? ('status ' + type) : 'status';
  }

  function updateCreditNote() {
    if (!creditNote) return;
    if (interviewCredits === null || interviewCredits === undefined) {
      creditNote.textContent = 'Interview credits: \u2014';
      return;
    }
    creditNote.textContent = 'Interview credits: ' + String(interviewCredits);
  }

  function updateLanguageNote(label) {
    if (!languageNote) return;
    var safeLabel = String(label || 'English').trim() || 'English';
    languageNote.textContent = 'Transcript language: ' + safeLabel + '.';
  }

  function getVisibleMenuItems(menu, selector) {
    if (!menu) return [];
    return Array.prototype.slice.call(menu.querySelectorAll(selector || 'button:not([disabled])')).filter(function (item) {
      return (item.offsetParent !== null || item === document.activeElement) && !item.disabled;
    });
  }

  function focusMenuItem(menu, selector, mode) {
    var items = getVisibleMenuItems(menu, selector);
    var activeIndex = -1;
    if (!items.length) return;
    activeIndex = items.indexOf(document.activeElement);
    if (mode === 'last') {
      items[items.length - 1].focus();
      return;
    }
    if (mode === 'next') {
      items[(activeIndex + 1 + items.length) % items.length].focus();
      return;
    }
    if (mode === 'prev') {
      items[(activeIndex - 1 + items.length) % items.length].focus();
      return;
    }
    if (mode === 'active') {
      var selected = items.find(function (item) {
        return item.classList.contains('active') || item.getAttribute('aria-selected') === 'true';
      });
      (selected || items[0]).focus();
      return;
    }
    items[0].focus();
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
      return custom ? '\ud83c\udf10 ' + custom : OUTPUT_LANGUAGE_LABELS.other;
    }
    return OUTPUT_LANGUAGE_LABELS[key] || OUTPUT_LANGUAGE_LABELS.english;
  }

  function setOutputLanguage(value, customValue) {
    var key = Object.prototype.hasOwnProperty.call(OUTPUT_LANGUAGE_LABELS, value) ? value : 'english';
    var nextCustom = String(customValue || '').trim();
    if (outputLanguageInput) outputLanguageInput.value = key;
    if (outputLanguageCustom) {
      outputLanguageCustom.hidden = key !== 'other';
      outputLanguageCustom.value = key === 'other' ? nextCustom : '';
    }
    if (outputLanguageLabel) {
      outputLanguageLabel.textContent = getLanguageLabel(key, outputLanguageCustom ? outputLanguageCustom.value : nextCustom);
    }
    outputLanguageItems.forEach(function (item) {
      var active = item.dataset.value === key;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    updateLanguageNote(getLanguageLabel(key, outputLanguageCustom ? outputLanguageCustom.value : nextCustom));
  }

  function getSelectedOutputLanguage() {
    var value = outputLanguageInput ? String(outputLanguageInput.value || 'english').trim().toLowerCase() : 'english';
    var custom = value === 'other' && outputLanguageCustom ? String(outputLanguageCustom.value || '').trim() : '';
    return {
      value: Object.prototype.hasOwnProperty.call(OUTPUT_LANGUAGE_LABELS, value) ? value : 'english',
      custom: custom
    };
  }

  function updateAuthStateUI() {
    var signedIn = hasSignedInSession();
    var pending = authStateIsPending();
    if (authPanel) authPanel.hidden = signedIn || pending;
    if (authLink) authLink.href = '/lecture-notes?auth=signin';
    if (pending) {
      if (statusEl && String(statusEl.textContent || '').trim() === 'Sign in to continue.') {
        setStatus('', '');
      }
      return;
    }
    if (!signedIn && !running) {
      setStatus('Sign in to continue.', 'error');
      return;
    }
    if (signedIn && statusEl && String(statusEl.textContent || '').trim() === 'Sign in to continue.') {
      setStatus('', '');
    }
  }

  function formatBytes(bytes) {
    var value = Math.max(0, Number(bytes || 0));
    if (value < 1024) return value + ' B';
    if (value < (1024 * 1024)) return (value / 1024).toFixed(1) + ' KB';
    return (value / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function validateAudioFile(file) {
    if (!file) return 'No file selected.';
    var lower = String(file.name || '').toLowerCase();
    if (!/\.(mp3|m4a|wav|aac|ogg|flac|webm)$/i.test(lower)) return 'Invalid audio type.';
    if (Number(file.size || 0) > (500 * 1024 * 1024)) return 'Audio must be 500 MB or smaller.';
    return '';
  }

  function renderSelectedFile() {
    if (!selectedFile) {
      if (dropzone) dropzone.classList.remove('has-file');
      if (fileInfo) fileInfo.hidden = true;
      if (fileNameEl) fileNameEl.textContent = '';
      if (fileSizeEl) fileSizeEl.textContent = '';
      return;
    }
    if (dropzone) dropzone.classList.add('has-file');
    if (fileInfo) fileInfo.hidden = false;
    if (fileNameEl) fileNameEl.textContent = String(selectedFile.name || '');
    if (fileSizeEl) fileSizeEl.textContent = formatBytes(selectedFile.size);
  }

  function updateOutputActionState() {
    var hasOutput = Boolean(String(lastOutput || '').trim());
    if (copyBtn) copyBtn.disabled = !hasOutput;
    if (downloadBtn) downloadBtn.disabled = !hasOutput || !hasSignedInSession();
  }

  function updateRunState() {
    var signedIn = hasSignedInSession();
    var pending = authStateIsPending();
    runBtn.disabled = pending || !signedIn || !selectedFile || running;
    runBtn.textContent = running ? 'Transcribing...' : 'Transcribe';
    updateAuthStateUI();
  }

  async function authFetch(path, options) {
    if (authClient && typeof authClient.authFetch === 'function') {
      return authClient.authFetch(path, options, { retryOn401: true });
    }
    var signedInUser = getSignedInUser();
    if (!signedInUser) throw new Error('Please sign in');
    var token = await signedInUser.getIdToken();
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
    return fetch(path, Object.assign({}, opts, { headers: headers }));
  }

  async function refreshUserState() {
    var signedInUser = getSignedInUser();
    if (!signedInUser) {
      interviewCredits = null;
      updateCreditNote();
      if (!languageUserTouched) {
        setOutputLanguage('english', '');
      } else {
        updateLanguageNote(getLanguageLabel(outputLanguageInput ? outputLanguageInput.value : 'english', outputLanguageCustom ? outputLanguageCustom.value : ''));
      }
      return;
    }
    try {
      var response = await authFetch('/api/auth/user');
      if (!response.ok) return;
      var payload = await response.json();
      var preferences = payload && payload.preferences ? payload.preferences : {};
      var credits = payload && payload.credits ? payload.credits : {};
      interviewCredits = Number(credits.interview_short || 0) + Number(credits.interview_medium || 0) + Number(credits.interview_long || 0);
      updateCreditNote();
      if (!languageUserTouched) {
        setOutputLanguage(preferences.output_language || 'english', preferences.output_language_custom || '');
      } else {
        updateLanguageNote(getLanguageLabel(outputLanguageInput ? outputLanguageInput.value : 'english', outputLanguageCustom ? outputLanguageCustom.value : ''));
      }
    } catch (_) {
      interviewCredits = null;
      updateCreditNote();
    }
  }

  function clearPolling() {
    currentJobId = '';
    if (pollTimer) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function finishRun() {
    running = false;
    clearPolling();
    updateRunState();
  }

  function startRun() {
    clearPolling();
    running = true;
    lastOutput = '';
    if (outputPre) outputPre.textContent = '';
    updateOutputActionState();
    updateRunState();
  }

  function applyCompleted(payload) {
    lastOutput = String((payload && (payload.output_text || payload.content_markdown || payload.result)) || '').trim();
    if (outputPre) outputPre.textContent = lastOutput;
    updateOutputActionState();
    setStatus(String((payload && payload.step_description) || 'Transcription complete.'), 'success');
    showToast('Transcription complete.', 'success');
  }

  function clearSelectedFile() {
    selectedFile = null;
    if (fileInput) fileInput.value = '';
    renderSelectedFile();
    updateRunState();
  }

  function applySelectedFile(nextFile) {
    var error = validateAudioFile(nextFile);
    if (error) {
      clearSelectedFile();
      setStatus(error, 'error');
      return false;
    }
    selectedFile = nextFile;
    renderSelectedFile();
    updateRunState();
    setStatus('', '');
    return true;
  }

  function shouldIgnoreDropzoneActivation(target) {
    if (!target || typeof target.closest !== 'function') return false;
    return Boolean(target.closest('.tool-file-remove') || target.closest('.tool-file-info') || target.closest('button'));
  }

  function schedulePoll(jobId, delayMs) {
    if (!jobId) return;
    if (pollTimer) window.clearTimeout(pollTimer);
    pollTimer = window.setTimeout(function () {
      pollJob(jobId);
    }, Math.max(600, Number(delayMs || 1200)));
  }

  async function pollJob(jobId) {
    if (!jobId || !running) return;
    try {
      var response = await authFetch('/status/' + encodeURIComponent(jobId));
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        if (response.status === 404 && payload && payload.retryable) {
          setStatus('Reconnecting to transcription job\u2026', '');
          schedulePoll(jobId, 1500);
          return;
        }
        setStatus(String(payload.error || 'Transcription failed.'), 'error');
        finishRun();
        await refreshUserState();
        return;
      }

      var status = String(payload.status || '').trim().toLowerCase();
      if (status === 'complete') {
        applyCompleted(payload);
        finishRun();
        await refreshUserState();
        return;
      }
      if (status === 'error') {
        setStatus(String(payload.error || payload.step_description || 'Transcription failed.'), 'error');
        finishRun();
        await refreshUserState();
        return;
      }

      setStatus(String(payload.step_description || 'Transcription in progress\u2026'), '');
      schedulePoll(jobId, 1200);
    } catch (error) {
      setStatus(error && error.message ? error.message : 'Could not refresh transcription status.', 'error');
      finishRun();
    }
  }

  async function runTranscription() {
    if (!hasSignedInSession()) {
      setStatus('Sign in to continue.', 'error');
      if (authLink) authLink.focus();
      return;
    }
    if (!selectedFile) {
      setStatus('Select an audio file first.', 'error');
      return;
    }

    var selectedLanguage = getSelectedOutputLanguage();
    if (selectedLanguage.value === 'other' && !selectedLanguage.custom) {
      setStatus('Enter a custom transcript language first.', 'error');
      if (outputLanguageCustom) {
        outputLanguageCustom.hidden = false;
        outputLanguageCustom.focus();
      }
      return;
    }

    startRun();
    setStatus('', '');

    var formData = new FormData();
    formData.append('audio', selectedFile);
    formData.append('output_language', selectedLanguage.value);
    formData.append('output_language_custom', selectedLanguage.custom);

    try {
      var response = await authFetch('/api/tools/transcribe', { method: 'POST', body: formData });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        setStatus(String(payload.error || 'Transcription failed.'), 'error');
        finishRun();
        await refreshUserState();
        return;
      }
      currentJobId = String(payload.job_id || '').trim();
      setStatus('Queued\u2026', '');
      schedulePoll(currentJobId, 500);
    } catch (error) {
      setStatus(error && error.message ? error.message : 'Transcription failed.', 'error');
      finishRun();
    }
  }

  if (fileInput) {
    fileInput.addEventListener('change', function (event) {
      var nextFile = event.target.files && event.target.files[0];
      applySelectedFile(nextFile);
      fileInput.value = '';
    });
  }

  if (dropzone) {
    dropzone.addEventListener('click', function (event) {
      if (shouldIgnoreDropzoneActivation(event.target)) return;
      if (fileInput) fileInput.click();
    });
    dropzone.addEventListener('keydown', function (event) {
      if (event.target !== dropzone) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      if (fileInput) fileInput.click();
    });
    dropzone.addEventListener('dragover', function (event) {
      event.preventDefault();
      dropzone.classList.add('drag');
    });
    dropzone.addEventListener('dragleave', function () {
      dropzone.classList.remove('drag');
    });
    dropzone.addEventListener('drop', function (event) {
      event.preventDefault();
      dropzone.classList.remove('drag');
      var nextFile = event.dataTransfer && event.dataTransfer.files ? event.dataTransfer.files[0] : null;
      applySelectedFile(nextFile);
    });
  }

  if (fileRemoveBtn) {
    fileRemoveBtn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      clearSelectedFile();
      setStatus('', '');
    });
  }

  if (outputLanguageButton && outputLanguageMenu) {
    outputLanguageButton.addEventListener('click', function (event) {
      event.stopPropagation();
      var visible = !outputLanguageMenu.classList.contains('visible');
      setOutputLanguageMenuVisible(visible);
      if (visible) focusMenuItem(outputLanguageMenu, '.app-select-item', 'active');
    });
    outputLanguageButton.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setOutputLanguageMenuVisible(true);
        focusMenuItem(outputLanguageMenu, '.app-select-item', 'active');
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setOutputLanguageMenuVisible(true);
        focusMenuItem(outputLanguageMenu, '.app-select-item', 'last');
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        var visible = !outputLanguageMenu.classList.contains('visible');
        setOutputLanguageMenuVisible(visible);
        if (visible) focusMenuItem(outputLanguageMenu, '.app-select-item', 'active');
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setOutputLanguageMenuVisible(false);
      }
    });
    outputLanguageMenu.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusMenuItem(outputLanguageMenu, '.app-select-item', 'next');
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusMenuItem(outputLanguageMenu, '.app-select-item', 'prev');
      }
      if (event.key === 'Home') {
        event.preventDefault();
        focusMenuItem(outputLanguageMenu, '.app-select-item', 'first');
      }
      if (event.key === 'End') {
        event.preventDefault();
        focusMenuItem(outputLanguageMenu, '.app-select-item', 'last');
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setOutputLanguageMenuVisible(false);
        outputLanguageButton.focus();
      }
      if (event.key === 'Tab') {
        setOutputLanguageMenuVisible(false);
      }
    });
    outputLanguageItems.forEach(function (item) {
      item.addEventListener('click', function () {
        var value = item.dataset.value || 'english';
        languageUserTouched = true;
        setOutputLanguage(value, value === 'other' && outputLanguageCustom ? outputLanguageCustom.value : '');
        setOutputLanguageMenuVisible(false);
        if (value === 'other' && outputLanguageCustom) {
          outputLanguageCustom.focus();
          outputLanguageCustom.select();
          return;
        }
        outputLanguageButton.focus();
      });
    });
  }

  if (outputLanguageCustom) {
    outputLanguageCustom.addEventListener('input', function () {
      if (!outputLanguageInput || outputLanguageInput.value !== 'other') return;
      languageUserTouched = true;
      if (outputLanguageLabel) {
        outputLanguageLabel.textContent = getLanguageLabel('other', outputLanguageCustom.value);
      }
      updateLanguageNote(getLanguageLabel('other', outputLanguageCustom.value));
    });
    outputLanguageCustom.addEventListener('blur', function () {
      if (!outputLanguageInput || outputLanguageInput.value !== 'other') return;
      outputLanguageCustom.value = String(outputLanguageCustom.value || '').trim();
      if (outputLanguageLabel) {
        outputLanguageLabel.textContent = getLanguageLabel('other', outputLanguageCustom.value);
      }
      updateLanguageNote(getLanguageLabel('other', outputLanguageCustom.value));
    });
  }

  document.addEventListener('click', function (event) {
    if (!outputLanguagePicker || !outputLanguagePicker.contains(event.target)) {
      setOutputLanguageMenuVisible(false);
    }
  });

  if (runBtn) {
    runBtn.addEventListener('click', runTranscription);
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', async function () {
      if (!lastOutput) return;
      try {
        await navigator.clipboard.writeText(lastOutput);
        showToast('Transcript copied.', 'success');
        setStatus('Copied transcript.', 'success');
      } catch (_) {
        setStatus('Could not copy transcript.', 'error');
      }
    });
  }

  if (downloadBtn) {
    downloadBtn.addEventListener('click', async function () {
      if (!lastOutput) return;
      try {
        var response = await authFetch('/api/tools/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            format: 'docx',
            content_markdown: lastOutput,
            title: 'General Transcript'
          })
        });
        if (!response.ok) throw new Error('Could not export .docx');
        if (downloadUtils && typeof downloadUtils.downloadResponseBlob === 'function') {
          await downloadUtils.downloadResponseBlob(response, 'general-transcript.docx');
        } else {
          var blob = await response.blob();
          var link = document.createElement('a');
          link.href = URL.createObjectURL(blob);
          link.download = 'general-transcript.docx';
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
          URL.revokeObjectURL(link.href);
        }
        setStatus('Word download started.', 'success');
      } catch (error) {
        setStatus(error && error.message ? error.message : 'Could not export .docx.', 'error');
      }
    });
  }

  renderSelectedFile();
  updateCreditNote();
  setOutputLanguage('english', '');
  updateRunState();
  updateOutputActionState();
  auth.onAuthStateChanged(function (user) {
    authStateResolved = true;
    currentUser = user || null;
    if (authClient && typeof authClient.clearToken === 'function' && !currentUser) authClient.clearToken();
    if (!currentUser) finishRun();
    refreshUserState();
    updateRunState();
    updateOutputActionState();
  });
})();
