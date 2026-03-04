(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;
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
  var fileInput = document.getElementById('reader-file-input');
  var addImageBtn = document.getElementById('reader-add-image-btn');
  var selectedFilesEl = document.getElementById('reader-selected-files');
  var runBtn = document.getElementById('reader-run-btn');
  var statusEl = document.getElementById('reader-status');
  var creditNote = document.getElementById('reader-credit-note');
  var outputPre = document.getElementById('reader-output-pre');
  var copyBtn = document.getElementById('reader-copy-btn');
  var downloadBtn = document.getElementById('reader-download-docx-btn');

  var currentUser = null;
  var selectedFiles = [];
  var running = false;
  var lastOutput = '';
  var slidesCredits = null;

  function setStatus(message, type) {
    statusEl.textContent = String(message || '');
    statusEl.className = type ? ('status ' + type) : 'status';
  }

  function updateCreditNote() {
    if (slidesCredits === null || slidesCredits === undefined) {
      creditNote.textContent = 'Text extraction credits: -';
      return;
    }
    creditNote.textContent = 'Text extraction credits: ' + String(slidesCredits);
  }

  function getQuestionDefault() {
    if (sourceType === 'document') return 'Answer the following questions in order:\n1) ...\n2) ...\n3) ...';
    if (sourceType === 'image') return 'Extract text from images...';
    return 'Explain the results section of this study in simple language';
  }

  function setupModeUI() {
    questionInput.placeholder = getQuestionDefault();
    questionHelp.textContent = sourceType === 'document'
      ? 'Use this to ask specific questions about your uploaded document.'
      : sourceType === 'image'
        ? 'Ask exactly what should be extracted from the images.'
        : 'Provide the URL and ask your question in simple terms.';

    if (sourceType === 'url') {
      urlWrap.style.display = '';
      dropzoneWrap.style.display = 'none';
      return;
    }

    urlWrap.style.display = 'none';
    dropzoneWrap.style.display = '';
    if (sourceType === 'image') {
      fileInput.accept = '.png,.jpg,.jpeg,.webp,.heic,.heif';
      fileInput.multiple = true;
      addImageBtn.style.display = '';
      dropzoneSub.textContent = 'PNG, JPG, WEBP, HEIC, HEIF · up to 20 MB each · max 5 images';
    } else {
      fileInput.accept = '.pdf,.pptx,.docx';
      fileInput.multiple = false;
      addImageBtn.style.display = 'none';
      dropzoneSub.textContent = 'PDF, PPTX, DOCX · up to 50 MB';
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
      left.innerHTML = '<strong>' + file.name + '</strong><div class="selected-file-meta">' + formatBytes(file.size) + '</div>';
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
      incoming.forEach(function (file) {
        var error = validateFile(file);
        if (error) {
          errors.push(error);
          return;
        }
        if (selectedFiles.length < 5) {
          selectedFiles.push(file);
        }
      });
      if (selectedFiles.length > 5) {
        selectedFiles = selectedFiles.slice(0, 5);
      }
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
    var hasInput = sourceType === 'url'
      ? Boolean(urlInput && String(urlInput.value || '').trim())
      : selectedFiles.length > 0;
    runBtn.disabled = !currentUser || !hasInput || running;
    runBtn.textContent = running ? 'Extracting...' : 'Extract';
  }

  async function authFetch(path, options) {
    if (authClient && typeof authClient.authFetch === 'function') {
      return authClient.authFetch(path, options, { retryOn401: true });
    }
    if (!currentUser) throw new Error('Please sign in');
    var token = await currentUser.getIdToken();
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
    return fetch(path, Object.assign({}, opts, { headers: headers }));
  }

  async function refreshCredits() {
    if (!currentUser) {
      slidesCredits = null;
      updateCreditNote();
      return;
    }
    try {
      var response = await authFetch('/api/auth/user');
      if (!response.ok) return;
      var payload = await response.json();
      slidesCredits = payload && payload.credits ? Number(payload.credits.slides || 0) : 0;
      updateCreditNote();
    } catch (_) {
      slidesCredits = null;
      updateCreditNote();
    }
  }

  function outputTitle() {
    if (sourceType === 'url') return 'URL Reader Output';
    if (sourceType === 'image') return 'Image Reader Output';
    return 'Document Reader Output';
  }

  async function runExtraction() {
    if (!currentUser) {
      setStatus('Please sign in to continue.', 'error');
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
    setStatus('Extracting...', '');

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
      advancedBody.classList.toggle('visible', nextOpen);
      advancedToggle.setAttribute('aria-expanded', nextOpen ? 'true' : 'false');
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
  auth.onAuthStateChanged(function (user) {
    currentUser = user || null;
    if (authClient && typeof authClient.clearToken === 'function' && !currentUser) authClient.clearToken();
    refreshCredits();
    updateRunState();
  });
})();
