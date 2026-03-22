(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;
  var downloadUtils = window.LectureProcessorDownload || {};

  if (!auth) return;

  var fileInput = document.getElementById('transcriber-file-input');
  var dropzone = document.getElementById('transcriber-dropzone');
  var dropzoneTitle = document.getElementById('transcriber-dropzone-title');
  var selectedFilesEl = document.getElementById('transcriber-selected-files');
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
    while (selectedFilesEl && selectedFilesEl.firstChild) selectedFilesEl.removeChild(selectedFilesEl.firstChild);
    if (!selectedFile) {
      if (dropzoneTitle) dropzoneTitle.textContent = 'Drop an audio file here or click to browse';
      return;
    }
    if (dropzoneTitle) dropzoneTitle.textContent = String(selectedFile.name || '');
    var row = document.createElement('div');
    row.className = 'selected-file';
    var left = document.createElement('div');
    var name = document.createElement('strong');
    name.textContent = String(selectedFile.name || '');
    var meta = document.createElement('div');
    meta.className = 'selected-file-meta';
    meta.textContent = formatBytes(selectedFile.size);
    left.appendChild(name);
    left.appendChild(meta);
    var removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'file-remove';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', function () {
      selectedFile = null;
      renderSelectedFile();
      updateRunState();
    });
    row.appendChild(left);
    row.appendChild(removeBtn);
    if (selectedFilesEl) selectedFilesEl.appendChild(row);
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
      updateLanguageNote('English');
      return;
    }
    try {
      var response = await authFetch('/api/auth/user');
      if (!response.ok) return;
      var payload = await response.json();
      var credits = payload && payload.credits ? payload.credits : {};
      interviewCredits = Number(credits.interview_short || 0) + Number(credits.interview_medium || 0) + Number(credits.interview_long || 0);
      updateCreditNote();
      updateLanguageNote(payload && payload.preferences ? payload.preferences.output_language_label : 'English');
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

    startRun();
    setStatus('', '');

    var formData = new FormData();
    formData.append('audio', selectedFile);

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
      var error = validateAudioFile(nextFile);
      if (error) {
        selectedFile = null;
        renderSelectedFile();
        updateRunState();
        setStatus(error, 'error');
      } else {
        selectedFile = nextFile;
        renderSelectedFile();
        updateRunState();
        setStatus('', '');
      }
      fileInput.value = '';
    });
  }

  if (dropzone) {
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
      var error = validateAudioFile(nextFile);
      if (error) {
        setStatus(error, 'error');
        return;
      }
      selectedFile = nextFile;
      renderSelectedFile();
      updateRunState();
      setStatus('', '');
    });
  }

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
  updateLanguageNote('English');
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
