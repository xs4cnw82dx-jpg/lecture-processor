(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;
  var downloadUtils = window.LectureProcessorDownload || {};

  if (!auth) return;

  var urlInput = document.getElementById('lecture-downloader-url');
  var formatButtons = Array.prototype.slice.call(document.querySelectorAll('[data-format]'));
  var runBtn = document.getElementById('lecture-downloader-run-btn');
  var authPanel = document.getElementById('lecture-downloader-auth-panel');
  var authLink = document.getElementById('lecture-downloader-auth-link');
  var statusEl = document.getElementById('lecture-downloader-status');
  var summaryEl = document.getElementById('lecture-downloader-summary');
  var toastEl = document.getElementById('lecture-downloader-toast');

  var currentUser = auth.currentUser || null;
  var authStateResolved = !!currentUser;
  var selectedFormat = 'video';
  var running = false;
  var toastTimer = null;
  var pendingJob = null;
  var activeAttempt = null;

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

  function setStatus(message, type) {
    if (!statusEl) return;
    statusEl.textContent = String(message || '');
    statusEl.className = type ? ('status ' + type) : 'status';
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

  function updateSummary(message) {
    if (!summaryEl) return;
    while (summaryEl.firstChild) summaryEl.removeChild(summaryEl.firstChild);
    var label = document.createElement('strong');
    label.textContent = 'Last download:';
    summaryEl.appendChild(label);
    summaryEl.appendChild(document.createTextNode(' ' + String(message || 'none yet.')));
  }

  function updateFormatUI() {
    formatButtons.forEach(function (button) {
      var isActive = String(button.getAttribute('data-format') || '') === selectedFormat;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  }

  function updateAuthStateUI() {
    var signedIn = hasSignedInSession();
    var pending = authStateIsPending();
    if (authPanel) authPanel.hidden = signedIn || pending;
    if (authLink) {
      authLink.href = typeof authUtils.buildSignInUrl === 'function'
        ? authUtils.buildSignInUrl()
        : '/lecture-notes?auth=signin';
    }
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

  function updateRunState() {
    var signedIn = hasSignedInSession();
    var pending = authStateIsPending();
    var hasUrl = Boolean(urlInput && String(urlInput.value || '').trim());
    runBtn.disabled = pending || !signedIn || !hasUrl || running;
    runBtn.textContent = running ? 'Downloading...' : (pendingJob ? 'Check download' : 'Download');
    if (urlInput) urlInput.disabled = running;
    formatButtons.forEach(function (button) { button.disabled = running; });
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

  function attemptIsCurrent(attempt) {
    return activeAttempt === attempt && getSignedInUser() === attempt.user
      && auth.currentUser === attempt.user && (!attempt.session || attempt.session.isCurrent());
  }

  async function responseError(response, attempt) {
    var payload = await response.json().catch(function () { return {}; });
    if (attemptIsCurrent(attempt) && response.status >= 400 && response.status < 500 && response.status !== 429) {
      pendingJob = null;
    }
    return new Error(String(payload.error || 'Could not download lecture media.'));
  }

  async function waitForDownload(attempt, job) {
    var path = '/api/tools/lecture-download/' + encodeURIComponent(job.id);
    while (attemptIsCurrent(attempt)) {
      var response = await authFetch(path, { headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (!attemptIsCurrent(attempt)) return null;
      if (!response.ok) throw await responseError(response, attempt);
      var payload = await response.json();
      if (!attemptIsCurrent(attempt)) return null;
      if (payload.status === 'error') {
        pendingJob = null;
        throw new Error(String(payload.error || 'Could not download lecture media.'));
      }
      if (payload.status === 'complete') {
        if (!payload.download_token) throw new Error('Could not download lecture media.');
        setStatus('Preparing download…', '');
        var fileResponse = await authFetch(path + '/file?token=' + encodeURIComponent(payload.download_token), { cache: 'no-store' });
        if (!attemptIsCurrent(attempt)) return null;
        if (!fileResponse.ok) throw await responseError(fileResponse, attempt);
        return { response: fileResponse, filename: payload.file_name };
      }
      if (['queued', 'starting', 'processing'].indexOf(payload.status) === -1) {
        throw new Error('Could not download lecture media.');
      }
      setStatus(payload.step_description || 'Preparing download…', '');
      await new Promise(function (resolve) { window.setTimeout(resolve, 1500); });
    }
    return null;
  }

  async function runDownload() {
    if (running) return;
    if (!hasSignedInSession()) {
      setStatus('Sign in to continue.', 'error');
      if (authLink) authLink.focus();
      return;
    }
    var urlValue = String(urlInput ? (urlInput.value || '') : '').trim();
    if (!urlValue) {
      setStatus('Paste the index.m3u8 playlist URL copied from DevTools → Network.', 'error');
      return;
    }

    var format = selectedFormat;
    var attempt = {
      user: getSignedInUser(),
      session: authClient && typeof authClient.captureSession === 'function' ? authClient.captureSession() : null,
    };
    activeAttempt = attempt;
    if (pendingJob && (pendingJob.url !== urlValue || pendingJob.format !== format || pendingJob.user !== attempt.user)) pendingJob = null;
    running = true;
    updateRunState();
    setStatus('Preparing download…', '');

    try {
      var response;
      if (!pendingJob) {
        response = await authFetch('/api/tools/lecture-download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ url: urlValue, format: format })
        });
        if (!attemptIsCurrent(attempt)) return;
        if (!response.ok) throw await responseError(response, attempt);
        if (response.status === 202) {
          var payload = await response.json();
          if (!attemptIsCurrent(attempt)) return;
          if (!payload.job_id) throw new Error('Could not download lecture media.');
          pendingJob = { id: payload.job_id, url: urlValue, format: format, user: attempt.user };
          setStatus(payload.step_description || 'Preparing download…', '');
        }
      }

      var fallbackName = format === 'audio'
        ? 'lecture-audio.mp3'
        : (format === 'both' ? 'lecture-media.zip' : 'lecture-video.mp4');
      if (pendingJob) {
        var prepared = await waitForDownload(attempt, pendingJob);
        if (!attemptIsCurrent(attempt) || !prepared) return;
        response = prepared.response;
        fallbackName = prepared.filename || fallbackName;
      }
      // Rolling deployments may still return a legacy binary response to POST.
      // Read it before saving so account changes during a large body are fenced.
      if ((response.headers.get('content-type') || '').indexOf('application/json') !== -1) {
        throw await responseError(response, attempt);
      }
      var blob = await response.blob();
      if (!attemptIsCurrent(attempt)) return;

      var filename = fallbackName;
      if (typeof downloadUtils.parseFilenameFromDisposition === 'function') {
        filename = downloadUtils.parseFilenameFromDisposition(response.headers.get('content-disposition'), fallbackName);
      }
      if (typeof downloadUtils.saveBlobAsFile === 'function') {
        downloadUtils.saveBlobAsFile(blob, filename);
      } else {
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
      }

      pendingJob = null;
      updateSummary(filename + ' downloaded.');
      showToast('Download started.', 'success');
      setStatus('Download started.', 'success');
    } catch (error) {
      if (!attemptIsCurrent(attempt)) return;
      setStatus(pendingJob ? 'Could not finish the download. Choose Check download to try again.'
        : (error && error.message ? error.message : 'Could not download lecture media.'), 'error');
    } finally {
      if (attemptIsCurrent(attempt)) {
        activeAttempt = null;
        running = false;
        updateRunState();
      }
    }
  }

  if (urlInput) {
    urlInput.addEventListener('input', function () {
      if (running) return;
      pendingJob = null;
      setStatus('', '');
      updateRunState();
    });
  }

  formatButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      if (running) return;
      var nextFormat = String(button.getAttribute('data-format') || 'video');
      if (nextFormat !== selectedFormat) {
        pendingJob = null;
        setStatus('', '');
      }
      selectedFormat = nextFormat;
      updateFormatUI();
      updateRunState();
    });
  });

  if (runBtn) {
    runBtn.addEventListener('click', runDownload);
  }

  updateFormatUI();
  updateSummary('none yet.');
  updateRunState();
  bootstrap.onAuthStateReady(auth, function (user) {
    authStateResolved = true;
    if (currentUser !== (user || null)) {
      activeAttempt = null;
      pendingJob = null;
      running = false;
      if (urlInput) urlInput.value = '';
      if (toastTimer) window.clearTimeout(toastTimer);
      if (toastEl) { toastEl.className = 'reader-toast'; toastEl.textContent = ''; }
      updateSummary('none yet.');
      setStatus('', '');
    }
    currentUser = user || null;
    if (authClient && typeof authClient.clearToken === 'function' && !currentUser) authClient.clearToken();
    updateRunState();
  });
})();
