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

  function updateRunState() {
    var signedIn = hasSignedInSession();
    var pending = authStateIsPending();
    var hasUrl = Boolean(urlInput && String(urlInput.value || '').trim());
    runBtn.disabled = pending || !signedIn || !hasUrl || running;
    runBtn.textContent = running ? 'Downloading...' : 'Download';
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

  async function runDownload() {
    if (!hasSignedInSession()) {
      setStatus('Sign in to continue.', 'error');
      if (authLink) authLink.focus();
      return;
    }
    var urlValue = String(urlInput ? (urlInput.value || '') : '').trim();
    if (!urlValue) {
      setStatus('Paste a lecture URL first.', 'error');
      return;
    }

    running = true;
    updateRunState();
    setStatus('Preparing download…', '');

    try {
      var response = await authFetch('/api/tools/lecture-download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: urlValue,
          format: selectedFormat
        })
      });

      if (!response.ok) {
        var payload = await response.json().catch(function () { return {}; });
        throw new Error(String(payload.error || 'Could not download lecture media.'));
      }

      var fallbackName = selectedFormat === 'audio'
        ? 'lecture-audio.mp3'
        : (selectedFormat === 'both' ? 'lecture-media.zip' : 'lecture-video.mp4');

      var filename = fallbackName;
      if (downloadUtils && typeof downloadUtils.downloadResponseBlob === 'function') {
        filename = await downloadUtils.downloadResponseBlob(response, fallbackName);
      } else {
        var blob = await response.blob();
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = fallbackName;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(link.href);
      }

      updateSummary(filename + ' downloaded.');
      showToast('Download started.', 'success');
      setStatus('Download started.', 'success');
    } catch (error) {
      setStatus(error && error.message ? error.message : 'Could not download lecture media.', 'error');
    } finally {
      running = false;
      updateRunState();
    }
  }

  if (urlInput) {
    urlInput.addEventListener('input', function () {
      setStatus('', '');
      updateRunState();
    });
  }

  formatButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      selectedFormat = String(button.getAttribute('data-format') || 'video');
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
  auth.onAuthStateChanged(function (user) {
    authStateResolved = true;
    currentUser = user || null;
    if (authClient && typeof authClient.clearToken === 'function' && !currentUser) authClient.clearToken();
    updateRunState();
  });
})();
