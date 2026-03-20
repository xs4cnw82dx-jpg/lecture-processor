(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;
  var uiCache = window.LectureProcessorUiCache || null;
  var userCache = window.LectureProcessorUserCache || {};
  var config = window.ReaderConfig || {};
  var sourceType = String(config.source || 'document');

  var advancedToggle = document.getElementById('reader-advanced-toggle');
  var advancedBody = document.getElementById('reader-advanced-body');
  var questionInput = document.getElementById('reader-question-input');
  var questionHelp = document.getElementById('reader-question-help');
  var urlWrap = document.getElementById('reader-url-wrap');
  var urlInput = document.getElementById('reader-url-input');
  var dropzoneWrap = document.getElementById('reader-dropzone-wrap');
  var dropzone = document.getElementById('reader-dropzone');
  var dropzoneTitle = document.getElementById('reader-dropzone-title');
  var dropzoneSub = document.getElementById('reader-dropzone-sub');
  var dropzoneSubExtra = document.getElementById('reader-dropzone-sub-extra');
  var fileInput = document.getElementById('reader-file-input');
  var addImageBtn = document.getElementById('reader-add-image-btn');
  var selectedFilesEl = document.getElementById('reader-selected-files');
  var runBtn = document.getElementById('reader-run-btn');
  var statusEl = document.getElementById('reader-status');
  var creditNote = document.getElementById('reader-credit-note');
  var authPanel = document.getElementById('reader-auth-panel');
  var authLink = document.getElementById('reader-auth-link');
  var outputPre = document.getElementById('reader-output-pre');
  var copyBtn = document.getElementById('reader-copy-btn');
  var downloadBtn = document.getElementById('reader-download-docx-btn');
  var readerToast = document.getElementById('reader-toast');

  var currentUser = auth && auth.currentUser ? auth.currentUser : null;
  var authStateResolved = !!currentUser;
  var selectedFiles = [];
  var running = false;
  var lastOutput = '';
  var slidesCredits = null;
  var toastTimer = null;
  var CREDITS_CACHE_KEY = 'credits_breakdown';

  function getSignedInUser() {
    return currentUser || (auth && auth.currentUser) || null;
  }

  function hasSignedInSession() {
    if (getSignedInUser()) return true;
    return !!(authClient && typeof authClient.getToken === 'function' && authClient.getToken());
  }

  function authStateIsPending() {
    return !authStateResolved && !hasSignedInSession();
  }

  function showReaderToast(message, type) {
    if (!readerToast || !message) return;
    readerToast.textContent = String(message);
    readerToast.className = 'reader-toast visible' + (type ? ' ' + type : '');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      readerToast.className = 'reader-toast';
    }, 2200);
  }

  function setStatus(message, type) {
    statusEl.textContent = String(message || '');
    statusEl.className = type ? ('status ' + type) : 'status';
  }

  function getSignInHref() {
    return '/lecture-notes?auth=signin';
  }

  function updateAuthStateUI() {
    var signedIn = hasSignedInSession();
    var pending = authStateIsPending();
    if (authPanel) authPanel.hidden = signedIn || pending;
    if (authLink) authLink.href = getSignInHref();
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

  function updateCreditNote() {
    if (slidesCredits === null || slidesCredits === undefined) {
      creditNote.textContent = 'Text extraction credits: \u2014';
      return;
    }
    creditNote.textContent = 'Text extraction credits: ' + String(slidesCredits);
  }

  function readCacheJson(key, fallbackValue) {
    return typeof userCache.getJson === 'function'
      ? userCache.getJson(key, fallbackValue, uiCache)
      : fallbackValue;
  }

  function writeCacheJson(key, value) {
    return typeof userCache.setJson === 'function'
      ? userCache.setJson(key, value, uiCache)
      : false;
  }

  function readUserCacheJson(userOrUid, key, fallbackValue) {
    return typeof userCache.getUserJson === 'function'
      ? userCache.getUserJson(userOrUid, key, fallbackValue, uiCache)
      : fallbackValue;
  }

  function writeUserCacheJson(userOrUid, key, value) {
    return typeof userCache.setUserJson === 'function'
      ? userCache.setUserJson(userOrUid, key, value, uiCache)
      : false;
  }

  function hydrateCachedCredits(user) {
    if (!user || !user.uid) {
      slidesCredits = null;
      updateCreditNote();
      return;
    }
    var cached = readUserCacheJson(user, CREDITS_CACHE_KEY, null);
    if (!cached || typeof cached !== 'object') {
      slidesCredits = null;
      updateCreditNote();
      return;
    }
    slidesCredits = Number(cached.textExtraction || 0);
    updateCreditNote();
  }

  function getQuestionDefault() {
    if (sourceType === 'document') return 'Answer the following questions about this document:';
    if (sourceType === 'image') return 'Extract text from images...';
    return 'Explain the results section of this study in simple language';
  }

  function setAdvancedOpen(open) {
    if (!advancedBody || !advancedToggle) return;
    advancedBody.classList.toggle('visible', !!open);
    advancedToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function setupModeUI() {
    questionInput.placeholder = getQuestionDefault();
    questionHelp.textContent = sourceType === 'document'
      ? 'Use this to ask specific questions about your uploaded document.'
      : sourceType === 'image'
        ? 'Ask exactly what should be extracted from the images.'
        : 'Provide the URL and ask your question in simple terms.';

    if (sourceType === 'url') {
      if (urlWrap) urlWrap.hidden = false;
      if (dropzoneWrap) dropzoneWrap.hidden = true;
      setAdvancedOpen(true);
      return;
    }

    setAdvancedOpen(sourceType === 'document');
    if (urlWrap) urlWrap.hidden = true;
    if (dropzoneWrap) dropzoneWrap.hidden = false;
    if (sourceType === 'image') {
      fileInput.accept = '.png,.jpg,.jpeg,.webp,.heic,.heif';
      fileInput.multiple = true;
      if (addImageBtn) addImageBtn.hidden = false;
      dropzoneSub.textContent = 'PNG, JPG, WEBP, HEIC, HEIF';
      if (dropzoneSubExtra) dropzoneSubExtra.textContent = 'up to 20 MB each · max 5 images';
    } else {
      fileInput.accept = '.pdf,.pptx,.docx';
      fileInput.multiple = false;
      if (addImageBtn) addImageBtn.hidden = true;
      dropzoneSub.textContent = 'PDF, PPTX, DOCX · up to 50 MB';
      if (dropzoneSubExtra) dropzoneSubExtra.textContent = '';
    }
  }

  function formatBytes(bytes) {
    var value = Math.max(0, Number(bytes || 0));
    if (value < 1024) return value + ' B';
    if (value < (1024 * 1024)) return (value / 1024).toFixed(1) + ' KB';
    return (value / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function selectedFilesSummary() {
    if (!selectedFiles.length) return '';
    if (sourceType !== 'image') return selectedFiles[0].name || '';
    return selectedFiles.length + ' image' + (selectedFiles.length === 1 ? '' : 's') + ' selected';
  }

  function renderSelectedFiles() {
    while (selectedFilesEl.firstChild) selectedFilesEl.removeChild(selectedFilesEl.firstChild);
    if (!selectedFiles.length) {
      dropzoneTitle.textContent = sourceType === 'image' ? 'Drop image files here or click to browse' : 'Drop a file here or click to browse';
      return;
    }
    dropzoneTitle.textContent = selectedFilesSummary();
    selectedFiles.forEach(function (file, index) {
      var row = document.createElement('div');
      row.className = 'selected-file';
      var left = document.createElement('div');
      var name = document.createElement('strong');
      name.textContent = String(file.name || '');
      var meta = document.createElement('div');
      meta.className = 'selected-file-meta';
      meta.textContent = formatBytes(file.size);
      left.appendChild(name);
      left.appendChild(meta);
      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'file-remove';
      remove.textContent = 'Remove';
      remove.addEventListener('click', function () {
        selectedFiles.splice(index, 1);
        renderSelectedFiles();
        updateRunState();
      });
      row.appendChild(left);
      row.appendChild(remove);
      selectedFilesEl.appendChild(row);
    });
  }

  function validateFile(file) {
    if (!file) return 'No file selected.';
    var lower = String(file.name || '').toLowerCase();
    if (sourceType === 'image') {
      if (!/\.(png|jpg|jpeg|webp|heic|heif)$/i.test(lower)) return 'Invalid image type.';
      if (Number(file.size || 0) > (20 * 1024 * 1024)) return 'Each image must be 20 MB or smaller.';
      return '';
    }
    if (!/\.(pdf|pptx|docx)$/i.test(lower)) return 'Invalid document type.';
    if (Number(file.size || 0) > (50 * 1024 * 1024)) return 'Document must be 50 MB or smaller.';
    return '';
  }

  function addFiles(files) {
    if (!files || !files.length) return;
    var incoming = Array.prototype.slice.call(files);
    var errors = [];
    if (sourceType === 'image') {
      var exceededLimit = false;
      incoming.forEach(function (file) {
        var error = validateFile(file);
        if (error) {
          errors.push(error);
          return;
        }
        if (selectedFiles.length >= 5) {
          exceededLimit = true;
          return;
        }
        selectedFiles.push(file);
      });
      if (exceededLimit) showReaderToast('Max 5 images per run.', 'error');
    } else {
      var file = incoming[0];
      var docError = validateFile(file);
      if (docError) errors.push(docError);
      else selectedFiles = [file];
    }
    if (errors.length) setStatus(errors[0], 'error');
    else setStatus('', '');
    renderSelectedFiles();
    updateRunState();
  }

  function updateRunState() {
    var signedIn = hasSignedInSession();
    var pending = authStateIsPending();
    var hasInput = sourceType === 'url'
      ? Boolean(urlInput && String(urlInput.value || '').trim())
      : selectedFiles.length > 0;
    runBtn.disabled = pending || !signedIn || !hasInput || running;
    runBtn.textContent = running ? 'Extracting...' : 'Extract';
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

  async function refreshCredits() {
    var signedInUser = getSignedInUser();
    if (!signedInUser) {
      slidesCredits = null;
      updateCreditNote();
      return;
    }
    try {
      var response = await authFetch('/api/auth/user');
      if (!response.ok) return;
      var payload = await response.json();
      slidesCredits = payload && payload.credits ? Number(payload.credits.slides || 0) : 0;
      if (payload && payload.credits) {
        var lecture = Number(payload.credits.lecture_standard || 0) + Number(payload.credits.lecture_extended || 0);
        var interview = Number(payload.credits.interview_short || 0) + Number(payload.credits.interview_medium || 0) + Number(payload.credits.interview_long || 0);
        writeUserCacheJson(signedInUser, CREDITS_CACHE_KEY, {
          lecture: lecture,
          textExtraction: slidesCredits,
          interview: interview,
          total: lecture + slidesCredits + interview
        });
      }
      updateCreditNote();
    } catch (_) {
      hydrateCachedCredits(signedInUser);
    }
  }

  function outputTitle() {
    if (sourceType === 'url') return 'URL Reader Output';
    if (sourceType === 'image') return 'Image Reader Output';
    return 'Document Reader Output';
  }

  function hasOutput() {
    return Boolean(String(lastOutput || '').trim());
  }

  function updateOutputActionState() {
    var outputReady = hasOutput();
    if (copyBtn) copyBtn.disabled = !outputReady;
    if (downloadBtn) downloadBtn.disabled = !outputReady || !hasSignedInSession();
  }

  async function runExtraction() {
    if (!hasSignedInSession()) {
      setStatus('Sign in to continue.', 'error');
      if (authLink) authLink.focus();
      return;
    }
    var urlValue = String(urlInput ? (urlInput.value || '') : '').trim();
    if (sourceType === 'url' && !urlValue) {
      setStatus('Enter a valid URL first.', 'error');
      return;
    }
    if (sourceType !== 'url' && !selectedFiles.length) {
      setStatus('Select at least one file first.', 'error');
      return;
    }
    running = true;
    updateRunState();
    setStatus('', '');

    var formData = new FormData();
    formData.append('source_type', sourceType);
    if (sourceType === 'url') {
      formData.append('source_url', urlValue);
    } else if (sourceType === 'image') {
      selectedFiles.forEach(function (file) {
        formData.append('files', file);
      });
      if (selectedFiles[0]) formData.append('file', selectedFiles[0]);
    } else if (selectedFiles[0]) {
      formData.append('file', selectedFiles[0]);
    }

    var question = String(questionInput.value || '').trim();
    if (question) formData.append('custom_prompt', question);

    try {
      var response = await authFetch('/api/tools/extract', { method: 'POST', body: formData });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        setStatus(String(payload.error || 'Extraction failed.'), 'error');
        await refreshCredits();
        return;
      }
      lastOutput = String(payload.output_text || payload.content_markdown || '').trim();
      outputPre.textContent = lastOutput;
      updateOutputActionState();
      setStatus('Extraction complete.', 'success');
      await refreshCredits();
    } catch (error) {
      setStatus(error && error.message ? error.message : 'Extraction failed.', 'error');
    } finally {
      running = false;
      updateRunState();
    }
  }

  if (advancedToggle) {
    advancedToggle.addEventListener('click', function () {
      var nextOpen = !advancedBody.classList.contains('visible');
      setAdvancedOpen(nextOpen);
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', function (event) {
      addFiles(event.target.files);
      fileInput.value = '';
    });
  }

  if (addImageBtn) {
    addImageBtn.addEventListener('click', function () { fileInput.click(); });
  }

  if (dropzone) {
    dropzone.addEventListener('dragover', function (event) {
      event.preventDefault();
      dropzone.classList.add('drag');
    });
    dropzone.addEventListener('dragleave', function () { dropzone.classList.remove('drag'); });
    dropzone.addEventListener('drop', function (event) {
      event.preventDefault();
      dropzone.classList.remove('drag');
      addFiles(event.dataTransfer && event.dataTransfer.files);
    });
  }

  if (urlInput) {
    urlInput.addEventListener('input', function () {
      setStatus('', '');
      updateRunState();
    });
  }

  if (runBtn) {
    runBtn.addEventListener('click', runExtraction);
  }

  if (copyBtn) {
    copyBtn.addEventListener('click', async function () {
      if (!lastOutput) return;
      try {
        await navigator.clipboard.writeText(lastOutput);
        setStatus('Copied output.', 'success');
      } catch (_) {
        setStatus('Could not copy output.', 'error');
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
            title: outputTitle()
          })
        });
        if (!response.ok) throw new Error('Could not export .docx');
        var blob = await response.blob();
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'reader-output-' + (new Date().toISOString().slice(0, 10)) + '.docx';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setStatus('Word download started.', 'success');
      } catch (error) {
        setStatus(error && error.message ? error.message : 'Could not export .docx.', 'error');
      }
    });
  }

  setupModeUI();
  hydrateCachedCredits(getSignedInUser());
  updateAuthStateUI();
  updateOutputActionState();
  auth.onAuthStateChanged(function (user) {
    authStateResolved = true;
    currentUser = user || null;
    if (authClient && typeof authClient.clearToken === 'function' && !currentUser) authClient.clearToken();
    hydrateCachedCredits(currentUser);
    refreshCredits();
    updateRunState();
    updateOutputActionState();
  });
})();
