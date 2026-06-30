(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;
  var utils = window.LectureProcessorVoiceNotes || {};
  var downloadUtils = window.LectureProcessorDownload || {};
  var uxUtils = window.LectureProcessorUx || {};

  if (!auth) return;

  var DB_NAME = 'lecture-processor-voice-notes';
  var DB_VERSION = 2;
  var STORE_NOTES = 'notes';
  var STORE_AUDIO = 'audio';
  var STORE_SETTINGS = 'settings';
  var DEFAULT_SETTINGS = {
    output_language: 'english',
    custom_instruction: ''
  };

  var state = {
    user: auth.currentUser || null,
    notes: [],
    selectedId: '',
    view: 'record',
    authReady: !!auth.currentUser,
    recorder: null,
    recordingStream: null,
    recordingChunks: [],
    recordingElapsedMs: 0,
    recordingTickStartedAt: 0,
    recordingTimer: 0,
    audioContext: null,
    analyser: null,
    micSource: null,
    amplitudeData: null,
    amplitudeFrame: 0,
    amplitudeLevel: 0,
    syncing: {},
    search: '',
    filter: 'all',
    highlightColor: 'yellow',
    highlightUndo: [],
    highlightRedo: [],
    settings: Object.assign({}, DEFAULT_SETTINGS)
  };

  var els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    [
      'voice-auth', 'voice-app', 'voice-sync-pill', 'voice-record-btn', 'voice-pause-btn', 'voice-stop-btn', 'voice-time',
      'voice-meter', 'voice-record-status', 'voice-file-input', 'voice-import-btn', 'voice-search-input',
      'voice-note-list', 'voice-detail-empty', 'voice-detail', 'voice-detail-title', 'voice-detail-meta',
      'voice-back-btn', 'voice-share-btn', 'voice-archive-btn', 'voice-download-audio-btn', 'voice-delete-btn', 'voice-audio', 'voice-audio-retention-note', 'voice-audio-status', 'voice-transcript', 'voice-notes-surface', 'voice-highlight-toolbar',
      'voice-hl-undo', 'voice-hl-redo', 'voice-hl-clear', 'voice-download-notes', 'voice-language-select',
      'voice-custom-input', 'voice-storage-count', 'voice-storage-size', 'voice-sync-all-btn', 'voice-toast',
      'voice-confirm-modal', 'voice-confirm-title', 'voice-confirm-message', 'voice-confirm-close',
      'voice-confirm-cancel', 'voice-confirm-confirm'
    ].forEach(function (id) {
      var key = id.replace(/^voice-/, '').replace(/-([a-z])/g, function (_m, chr) { return chr.toUpperCase(); });
      els[key] = $(id);
    });
  }

  var confirmResolver = null;
  var confirmReturnFocus = null;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_NOTES)) db.createObjectStore(STORE_NOTES, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_AUDIO)) db.createObjectStore(STORE_AUDIO, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        try {
          var notesStore = request.transaction.objectStore(STORE_NOTES);
          if (notesStore && !notesStore.indexNames.contains('owner_key')) notesStore.createIndex('owner_key', 'owner_key', { unique: false });
        } catch (e) {}
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('IndexedDB unavailable')); };
    });
  }

  function withStore(storeName, mode, callback) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(storeName, mode);
        var store = tx.objectStore(storeName);
        var result;
        tx.oncomplete = function () {
          db.close();
          resolve(result);
        };
        tx.onerror = function () {
          db.close();
          reject(tx.error || new Error('Storage failed'));
        };
        result = callback(store);
      });
    });
  }

  function requestToPromise(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error || new Error('Storage request failed')); };
    });
  }

  function currentOwnerKey() {
    return state.user && state.user.uid ? ('user:' + String(state.user.uid)) : 'anon';
  }

  function noteBelongsToCurrentOwner(note) {
    return !!note && String(note.owner_key || '') === currentOwnerKey();
  }

  function getAllNotes() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NOTES, 'readonly');
        var request = tx.objectStore(STORE_NOTES).getAll();
        request.onsuccess = function () {
          resolve((request.result || []).filter(noteBelongsToCurrentOwner));
        };
        request.onerror = function () { reject(request.error || new Error('Could not load notes')); };
        tx.oncomplete = function () { db.close(); };
      });
    });
  }

  function putNote(note) {
    return withStore(STORE_NOTES, 'readwrite', function (store) {
      note.owner_key = currentOwnerKey();
      store.put(note);
      return note;
    });
  }

  function removeNoteRow(id) {
    return withStore(STORE_NOTES, 'readwrite', function (store) {
      store.delete(id);
    });
  }

  function getAudioBlob(id) {
    return withStore(STORE_AUDIO, 'readonly', function (store) {
      return requestToPromise(store.get(id));
    }).then(function (row) {
      return row && row.blob && String(row.owner_key || '') === currentOwnerKey() ? row.blob : null;
    });
  }

  function putAudioBlob(id, blob, name) {
    return withStore(STORE_AUDIO, 'readwrite', function (store) {
      store.put({ id: id, owner_key: currentOwnerKey(), blob: blob, name: name || 'voice-note.webm', size: Number(blob && blob.size) || 0, updated_at: Date.now() });
    });
  }

  function removeAudioBlob(id) {
    return withStore(STORE_AUDIO, 'readwrite', function (store) {
      store.delete(id);
    });
  }

  function loadSettings() {
    return withStore(STORE_SETTINGS, 'readonly', function (store) {
      return requestToPromise(store.get('voice-settings:' + currentOwnerKey()));
    }).then(function (row) {
      if (row && row.value) state.settings = Object.assign({}, state.settings, row.value);
    }).catch(function () {});
  }

  function saveSettings() {
    return withStore(STORE_SETTINGS, 'readwrite', function (store) {
      store.put({ key: 'voice-settings:' + currentOwnerKey(), value: state.settings });
    }).catch(function () {});
  }

  function nowSeconds() {
    return Date.now() / 1000;
  }

  function createLocalId() {
    if (window.crypto && crypto.randomUUID) return 'local-' + crypto.randomUUID();
    return 'local-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  function showToast(message, type) {
    if (!els.toast || !message) return;
    els.toast.textContent = String(message);
    els.toast.classList.toggle('error', type === 'error');
    els.toast.classList.add('visible');
    window.clearTimeout(showToast.timer);
    showToast.timer = window.setTimeout(function () {
      els.toast.classList.remove('visible');
    }, 2600);
  }

  function setAudioStatus(message, type) {
    if (!els.audioStatus) return;
    var text = String(message || '').trim();
    els.audioStatus.textContent = text;
    els.audioStatus.hidden = !text;
    els.audioStatus.classList.toggle('error', type === 'error');
    els.audioStatus.setAttribute('role', type === 'error' ? 'alert' : 'status');
    els.audioStatus.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  }

  function setAudioDownloadReady(isReady) {
    if (!els.downloadAudioBtn) return;
    els.downloadAudioBtn.disabled = !isReady;
    els.downloadAudioBtn.setAttribute('aria-disabled', isReady ? 'false' : 'true');
  }

  function openConfirmModal(title, message, confirmLabel) {
    if (!els.confirmModal) return Promise.resolve(false);
    confirmReturnFocus = document.activeElement;
    if (els.confirmTitle) els.confirmTitle.textContent = title || 'Confirm Action';
    if (els.confirmMessage) els.confirmMessage.textContent = message || '';
    if (els.confirmConfirm) els.confirmConfirm.textContent = confirmLabel || 'Confirm';
    if (typeof uxUtils.openModalOverlay === 'function') {
      uxUtils.openModalOverlay(els.confirmModal, {
        initialFocus: els.confirmCancel,
        onRequestClose: function () { closeConfirmModal(false); }
      });
    } else {
      els.confirmModal.hidden = false;
      els.confirmModal.setAttribute('aria-hidden', 'false');
      if (els.confirmCancel) els.confirmCancel.focus();
    }
    return new Promise(function (resolve) {
      confirmResolver = resolve;
    });
  }

  function closeConfirmModal(confirmed) {
    if (!els.confirmModal) return;
    if (typeof uxUtils.closeModalOverlay === 'function') {
      uxUtils.closeModalOverlay(els.confirmModal, {
        returnFocus: confirmReturnFocus
      });
    } else {
      els.confirmModal.hidden = true;
      els.confirmModal.setAttribute('aria-hidden', 'true');
      if (confirmReturnFocus && typeof confirmReturnFocus.focus === 'function') {
        try { confirmReturnFocus.focus(); } catch (_) {}
      }
    }
    confirmReturnFocus = null;
    if (confirmResolver) {
      confirmResolver(Boolean(confirmed));
      confirmResolver = null;
    }
  }

  function hasSignedInSession() {
    if (state.user || (auth && auth.currentUser)) return true;
    return !!(authClient && typeof authClient.getToken === 'function' && authClient.getToken());
  }

  function authFetch(path, options) {
    if (authClient && typeof authClient.authFetch === 'function') {
      return authClient.authFetch(path, options || {}, { retryOn401: true });
    }
    var user = state.user || auth.currentUser;
    if (!user) return Promise.reject(new Error('Please sign in'));
    return user.getIdToken().then(function (token) {
      var opts = options || {};
      var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
      return fetch(path, Object.assign({}, opts, { headers: headers }));
    });
  }

  function apiJson(path, options) {
    return authFetch(path, options).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) throw new Error(payload.error || 'Request failed');
        return payload;
      });
    });
  }

  function formatDate(ts) {
    var date = new Date(Number(ts || nowSeconds()) * 1000);
    return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function syncPill(message, type) {
    if (!els.syncPill) return;
    els.syncPill.textContent = message;
    els.syncPill.classList.toggle('is-online', type === 'online');
    els.syncPill.classList.toggle('is-error', type === 'error');
  }

  function renderSyncPill() {
    if (!navigator.onLine) {
      syncPill('Offline', 'error');
      return;
    }
    var syncing = state.notes.filter(function (note) {
      return (utils.normalizeStatus ? utils.normalizeStatus(note.status) : note.status) === 'syncing';
    }).length;
    var pending = state.notes.filter(function (note) {
      return (utils.normalizeStatus ? utils.normalizeStatus(note.status) : note.status) === 'pending';
    }).length;
    var errors = state.notes.filter(function (note) {
      return (utils.normalizeStatus ? utils.normalizeStatus(note.status) : note.status) === 'error';
    }).length;
    if (syncing) syncPill(syncing === 1 ? 'Transcribing' : syncing + ' transcribing', 'online');
    else if (pending) syncPill(pending + ' pending', 'online');
    else if (errors) syncPill(errors + ' retry', 'error');
    else syncPill('Synced', 'online');
  }

  function selectedNote() {
    return state.notes.find(function (note) { return note.id === state.selectedId; }) || null;
  }

  function setView(view, options) {
    var safe = view || 'record';
    var previous = state.view;
    state.view = safe;
    Array.prototype.slice.call(document.querySelectorAll('[data-voice-panel]')).forEach(function (panel) {
      panel.classList.toggle('active', panel.getAttribute('data-voice-panel') === safe);
    });
    Array.prototype.slice.call(document.querySelectorAll('[data-voice-view]')).forEach(function (btn) {
      var active = btn.getAttribute('data-voice-view') === safe;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (safe === 'detail') renderDetail();
    if (!options || options.history !== false) {
      if (safe !== previous && window.history && window.history.pushState) {
        window.history.pushState({ voiceView: safe, selectedId: state.selectedId || '' }, '', window.location.pathname + window.location.search);
      }
    }
  }

  function setRecordStatus(text) {
    if (els.recordStatus) els.recordStatus.textContent = text || 'Ready';
  }

  function preferredMimeType() {
    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
    var candidates = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/aac'];
    for (var i = 0; i < candidates.length; i += 1) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function extensionForMime(mimeType) {
    var mime = String(mimeType || '').split(';', 1)[0].toLowerCase();
    if (mime.indexOf('mpeg') >= 0 || mime.indexOf('mp3') >= 0) return '.mp3';
    if (mime.indexOf('mp4') >= 0 || mime.indexOf('m4a') >= 0 || mime.indexOf('aac') >= 0) return '.m4a';
    if (mime.indexOf('wav') >= 0) return '.wav';
    if (mime.indexOf('ogg') >= 0) return '.ogg';
    if (mime.indexOf('flac') >= 0) return '.flac';
    return '.webm';
  }

  function audioFileName(name, blob) {
    var safe = String(name || '').trim();
    if (/\.(mp3|m4a|mp4|wav|aac|ogg|flac|webm)$/i.test(safe)) return safe;
    return 'voice-note-' + Date.now() + extensionForMime(blob && blob.type);
  }

  function saveBlobAsFile(blob, filename) {
    if (!blob) return;
    var safeName = String(filename || 'voice-note-audio').trim() || 'voice-note-audio';
    if (downloadUtils.saveBlobAsFile) {
      downloadUtils.saveBlobAsFile(blob, safeName);
      return;
    }
    var url = URL.createObjectURL(blob);
    var anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = safeName;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }

  function updateRecordingClock() {
    var ms = state.recordingElapsedMs;
    if (state.recordingTickStartedAt) ms += Date.now() - state.recordingTickStartedAt;
    var seconds = Math.floor(ms / 1000);
    if (els.time) els.time.textContent = utils.formatDuration ? utils.formatDuration(seconds) : String(seconds);
  }

  function startTimer(reset) {
    if (reset) state.recordingElapsedMs = 0;
    if (!state.recordingTickStartedAt) state.recordingTickStartedAt = Date.now();
    window.clearInterval(state.recordingTimer);
    state.recordingTimer = window.setInterval(updateRecordingClock, 250);
    updateRecordingClock();
  }

  function pauseTimer() {
    if (state.recordingTickStartedAt) {
      state.recordingElapsedMs += Date.now() - state.recordingTickStartedAt;
      state.recordingTickStartedAt = 0;
    }
    window.clearInterval(state.recordingTimer);
    state.recordingTimer = 0;
    updateRecordingClock();
  }

  function resumeTimer() {
    startTimer(false);
  }

  function stopTimer() {
    pauseTimer();
    window.clearInterval(state.recordingTimer);
    state.recordingTimer = 0;
  }

  function recordingSeconds() {
    var ms = state.recordingElapsedMs;
    if (state.recordingTickStartedAt) ms += Date.now() - state.recordingTickStartedAt;
    return Math.max(0, Math.floor(ms / 1000));
  }

  function stopAmplitudeMeter() {
    if (state.amplitudeFrame) {
      window.cancelAnimationFrame(state.amplitudeFrame);
      state.amplitudeFrame = 0;
    }
    if (state.micSource && typeof state.micSource.disconnect === 'function') {
      try { state.micSource.disconnect(); } catch (e) {}
    }
    state.micSource = null;
    state.analyser = null;
    state.amplitudeData = null;
    state.amplitudeLevel = 0;
    if (els.meter) {
      setMeterLevel(0);
      els.meter.classList.remove('paused');
    }
    if (state.audioContext && typeof state.audioContext.close === 'function') {
      state.audioContext.close().catch(function () {});
    }
    state.audioContext = null;
  }

  function setMeterLevel(level) {
    if (!els.meter) return;
    var next = Math.max(0, Math.min(8, Math.round(Number(level || 0) * 8)));
    for (var i = 0; i <= 8; i += 1) {
      els.meter.classList.toggle('level-' + i, i === next);
    }
  }

  function startAmplitudeMeter(stream) {
    var AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor || !stream || !els.meter) return;
    stopAmplitudeMeter();
    try {
      state.audioContext = new AudioContextCtor();
      state.analyser = state.audioContext.createAnalyser();
      state.analyser.fftSize = 512;
      state.amplitudeData = new Uint8Array(state.analyser.fftSize);
      state.micSource = state.audioContext.createMediaStreamSource(stream);
      state.micSource.connect(state.analyser);
      if (state.audioContext.state === 'suspended' && typeof state.audioContext.resume === 'function') {
        state.audioContext.resume().catch(function () {});
      }
      var tick = function () {
        if (!state.analyser || !state.amplitudeData) return;
        var targetLevel = 0;
        if (state.recorder && state.recorder.state === 'recording') {
          state.analyser.getByteTimeDomainData(state.amplitudeData);
          var sum = 0;
          for (var i = 0; i < state.amplitudeData.length; i += 1) {
            var normalized = (state.amplitudeData[i] - 128) / 128;
            sum += normalized * normalized;
          }
          targetLevel = Math.min(1, Math.sqrt(sum / state.amplitudeData.length) * 4.6);
        }
        state.amplitudeLevel = (state.amplitudeLevel * 0.65) + (targetLevel * 0.35);
        setMeterLevel(state.amplitudeLevel);
        state.amplitudeFrame = window.requestAnimationFrame(tick);
      };
      tick();
    } catch (e) {
      stopAmplitudeMeter();
    }
  }

  function resetRecorderControls() {
    if (els.meter) els.meter.classList.remove('recording', 'paused');
    if (els.recordBtn) els.recordBtn.classList.remove('recording');
    if (els.stopBtn) els.stopBtn.disabled = true;
    if (els.pauseBtn) {
      els.pauseBtn.disabled = true;
      els.pauseBtn.textContent = 'Pause';
    }
    if (els.recordBtn) {
      els.recordBtn.disabled = false;
      els.recordBtn.setAttribute('aria-label', 'Start recording');
      var label = els.recordBtn.querySelector('span');
      if (label) label.textContent = 'Start recording';
    }
  }

  function setRecordingControls(recording) {
    if (els.meter) els.meter.classList.toggle('recording', !!recording);
    if (els.recordBtn) {
      els.recordBtn.classList.toggle('recording', !!recording);
      els.recordBtn.disabled = !!recording;
      els.recordBtn.setAttribute('aria-label', recording ? 'Recording' : 'Start recording');
      var label = els.recordBtn.querySelector('span');
      if (label) label.textContent = recording ? 'Recording' : 'Start recording';
    }
    if (els.stopBtn) els.stopBtn.disabled = !recording;
    if (els.pauseBtn) {
      var canPause = !!(state.recorder && typeof state.recorder.pause === 'function' && typeof state.recorder.resume === 'function');
      els.pauseBtn.disabled = !recording || !canPause;
      els.pauseBtn.textContent = 'Pause';
    }
  }

  function startRecording() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function' || !window.MediaRecorder) {
      showToast('Recording is not supported in this browser.', 'error');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var mimeType = preferredMimeType();
      var options = mimeType ? { mimeType: mimeType } : undefined;
      state.recordingChunks = [];
      state.recordingStream = stream;
      state.recorder = new MediaRecorder(stream, options);
      state.recorder.ondataavailable = function (event) {
        if (event.data && event.data.size > 0) state.recordingChunks.push(event.data);
      };
      state.recorder.onstop = function () {
        var seconds = recordingSeconds();
        var blobType = state.recorder && state.recorder.mimeType ? state.recorder.mimeType : (mimeType || 'audio/webm');
        var blob = new Blob(state.recordingChunks, { type: blobType });
        var name = audioFileName('', blob);
        stopTimer();
        stopAmplitudeMeter();
        if (state.recordingStream) {
          state.recordingStream.getTracks().forEach(function (track) { track.stop(); });
        }
        state.recordingStream = null;
        state.recorder = null;
        resetRecorderControls();
        setRecordStatus('Saved locally. Transcribing...');
        saveAudioAndSync(blob, name, seconds);
      };
      state.recorder.start(1000);
      startAmplitudeMeter(stream);
      setRecordingControls(true);
      setRecordStatus('Recording. Keep this app open and unlocked.');
      showToast('Keep Voice Notes open while recording on iPhone.');
      startTimer(true);
    }).catch(function (error) {
      stopAmplitudeMeter();
      resetRecorderControls();
      showToast(error && error.message ? error.message : 'Microphone permission was not granted.', 'error');
    });
  }

  function stopRecording() {
    if (state.recorder && state.recorder.state !== 'inactive') state.recorder.stop();
  }

  function toggleRecordingPause() {
    if (!state.recorder || state.recorder.state === 'inactive') return;
    if (typeof state.recorder.pause !== 'function' || typeof state.recorder.resume !== 'function') return;
    if (state.recorder.state === 'recording') {
      try {
        if (typeof state.recorder.requestData === 'function') state.recorder.requestData();
        state.recorder.pause();
        pauseTimer();
        if (els.meter) els.meter.classList.add('paused');
        if (els.pauseBtn) els.pauseBtn.textContent = 'Resume';
        setRecordStatus('Paused. Resume or stop to transcribe.');
      } catch (e) {
        showToast('Pause is not available in this browser.', 'error');
      }
      return;
    }
    if (state.recorder.state === 'paused') {
      try {
        state.recorder.resume();
        resumeTimer();
        if (els.meter) els.meter.classList.remove('paused');
        if (els.pauseBtn) els.pauseBtn.textContent = 'Pause';
        setRecordStatus('Recording. Keep this app open and unlocked.');
      } catch (e) {
        showToast('Could not resume recording.', 'error');
      }
    }
  }

  function saveAudioAndSync(blob, name, seconds) {
    if (!blob || !blob.size) {
      showToast('The recording was empty. Please try again.', 'error');
      return Promise.resolve(null);
    }
    var id = createLocalId();
    var note = {
      id: id,
      study_pack_id: '',
      local_audio_id: id,
      title: 'Transcribing voice note...',
      tags: [],
      archived: false,
      status: 'pending',
      transcript: '',
      notes_markdown: '',
      notes_highlights: null,
      flashcards: [],
      test_questions: [],
      audio_size: Number(blob.size || 0),
      audio_name: audioFileName(name, blob),
      audio_type: blob.type || 'audio/webm',
      audio_seconds: Number(seconds || 0),
      created_at: nowSeconds(),
      updated_at: nowSeconds()
    };
    return putAudioBlob(id, blob, note.audio_name)
      .then(function () { return putNote(note); })
      .then(function () {
        state.notes.unshift(note);
        state.selectedId = id;
        setView('detail');
        renderAll();
        if (!navigator.onLine) {
          setRecordStatus('Saved offline. It will transcribe when you are online.');
          return note;
        }
        if (!hasSignedInSession()) {
          setRecordStatus('Saved offline. Sign in to transcribe.');
          showToast('Saved offline. Sign in to transcribe.');
          return note;
        }
        syncNote(note);
        return note;
      });
  }

  function syncNote(note) {
    if (!note || state.syncing[note.id]) return Promise.resolve();
    if (!hasSignedInSession()) {
      showToast('Sign in to transcribe.', 'error');
      renderSyncPill();
      return Promise.resolve();
    }
    state.syncing[note.id] = true;
    note.status = 'syncing';
    note.error = '';
    note.step_description = 'Uploading audio...';
    note.updated_at = nowSeconds();
    renderAll();
    return putNote(note).then(function () {
      return getAudioBlob(note.local_audio_id || note.id);
    }).then(function (blob) {
      if (!blob) throw new Error('Offline audio was not found on this device.');
      var form = new FormData();
      form.append('audio', blob, audioFileName(note.audio_name, blob));
      form.append('custom_instruction', state.settings.custom_instruction || note.custom_instruction || '');
      form.append('output_language', state.settings.output_language || 'english');
      return authFetch('/api/voice-notes', { method: 'POST', body: form });
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) throw new Error(payload.error || 'Could not transcribe voice note');
        note.job_id = payload.job_id;
        note.status = 'syncing';
        note.step_description = 'Transcribing...';
        note.updated_at = nowSeconds();
        return putNote(note).then(function () { return pollJob(note, payload.job_id); });
      });
    }).catch(function (error) {
      note.status = 'error';
      note.error = error && error.message ? error.message : 'Sync failed';
      note.updated_at = nowSeconds();
      setRecordStatus('Saved offline. Sync needs retry.');
      showToast(note.error, 'error');
      return putNote(note);
    }).finally(function () {
      delete state.syncing[note.id];
      renderAll();
    });
  }

  function pollJob(note, jobId) {
    var attempts = 0;
    function tick() {
      attempts += 1;
      return apiJson('/api/voice-notes/jobs/' + encodeURIComponent(jobId)).then(function (payload) {
        note.status = payload.status || 'syncing';
        note.step_description = payload.step_description || '';
        if (payload.transcript) {
          note.transcript = payload.transcript;
          note.notes_markdown = payload.transcript;
        }
        if (payload.status === 'complete') {
          note.status = 'synced';
          note.study_pack_id = payload.study_pack_id || note.study_pack_id || '';
          note.title = payload.title || note.title || 'Voice note';
          note.tags = utils.parseTags ? utils.parseTags(payload.tags || note.tags || []) : (payload.tags || note.tags || []);
          note.transcript = payload.transcript || payload.result || note.transcript || '';
          note.notes_markdown = note.transcript;
          note.flashcards = [];
          note.test_questions = [];
          note.updated_at = nowSeconds();
          return fetchAndCachePack(note).then(function () {
            setRecordStatus('Transcript ready.');
            showToast('Transcript ready.');
          });
        }
        if (payload.status === 'error') {
          note.status = 'error';
          note.error = payload.error || 'Processing failed';
          return putNote(note);
        }
        note.updated_at = nowSeconds();
        return putNote(note).then(function () {
          renderAll();
          if (attempts > 240) throw new Error('Processing is taking longer than expected.');
          return new Promise(function (resolve) {
            window.setTimeout(function () { resolve(tick()); }, 1500);
          });
        });
      });
    }
    return tick();
  }

  function fetchAndCachePack(note) {
    if (!note.study_pack_id) return putNote(note);
    return apiJson('/api/study-packs/' + encodeURIComponent(note.study_pack_id)).then(function (pack) {
      var merged = utils.normalizePackPayload ? utils.normalizePackPayload(pack, note) : Object.assign({}, note, pack);
      merged.id = note.id;
      merged.local_audio_id = note.local_audio_id || note.id;
      merged.transcript = pack.source_transcript || note.transcript || '';
      merged.notes_markdown = merged.transcript;
      merged.audio_size = note.audio_size || 0;
      merged.audio_name = note.audio_name || '';
      merged.audio_type = note.audio_type || '';
      merged.flashcards = [];
      merged.test_questions = [];
      Object.assign(note, merged);
      return putNote(note).then(function () {
        var index = state.notes.findIndex(function (item) { return item.id === note.id; });
        if (index >= 0) state.notes[index] = note;
      });
    }).catch(function () {
      return putNote(note);
    });
  }

  function syncAllPending() {
    var pending = state.notes.filter(function (note) {
      var status = utils.normalizeStatus ? utils.normalizeStatus(note.status) : note.status;
      return status === 'pending' || status === 'error';
    });
    renderSyncPill();
    return pending.reduce(function (chain, note) {
      return chain.then(function () { return syncNote(note); });
    }, Promise.resolve());
  }

  function renderList() {
    if (!els.noteList) return;
    var notes = utils.filterVoiceNotes ? utils.filterVoiceNotes(state.notes, { query: state.search, filter: state.filter }) : state.notes;
    els.noteList.innerHTML = '';
    if (!notes.length) {
      var empty = document.createElement('div');
      empty.className = 'voice-detail-empty';
      empty.textContent = 'No voice notes found.';
      els.noteList.appendChild(empty);
      return;
    }
    notes.forEach(function (note) {
      var status = utils.normalizeStatus ? utils.normalizeStatus(note.status) : note.status;
      var item = document.createElement('article');
      item.className = 'voice-note-item' + (note.id === state.selectedId ? ' active' : '');
      item.innerHTML = [
        '<button type="button" class="voice-note-open" data-note-open>',
        '<div class="voice-note-row">',
        '<div class="voice-note-title"></div>',
        '<span class="voice-note-status ' + (status === 'synced' ? 'synced' : status === 'error' ? 'error' : '') + '"></span>',
        '</div>',
        '<div class="voice-note-meta"></div>',
        '<div class="voice-tag-row"></div>',
        '</button>',
        '<div class="voice-note-actions">',
        '<button type="button" class="voice-note-action" data-note-archive></button>',
        '<button type="button" class="voice-note-action danger" data-note-delete>Delete</button>',
        '</div>'
      ].join('');
      var noteTitle = note.title || 'Voice note';
      item.querySelector('.voice-note-title').textContent = noteTitle;
      item.querySelector('.voice-note-status').textContent = status === 'syncing' ? 'transcribing' : status;
      item.querySelector('[data-note-archive]').textContent = note.archived ? 'Restore' : 'Archive';
      var pieces = [formatDate(note.created_at)];
      if (note.audio_seconds) pieces.push(utils.formatDuration ? utils.formatDuration(note.audio_seconds) : String(note.audio_seconds) + 's');
      if (note.step_description && status === 'syncing') pieces.push(note.step_description);
      item.querySelector('.voice-note-meta').textContent = pieces.join(' - ');
      var tagRow = item.querySelector('.voice-tag-row');
      (note.tags || []).forEach(function (tag) {
        var span = document.createElement('span');
        span.className = 'voice-tag';
        span.textContent = tag;
        tagRow.appendChild(span);
      });
      var openButton = item.querySelector('[data-note-open]');
      openButton.setAttribute('aria-label', 'Open voice note "' + noteTitle + '"');
      openButton.addEventListener('click', function () {
        state.selectedId = note.id;
        setView('detail');
        renderAll();
      });
      var archiveButton = item.querySelector('[data-note-archive]');
      if (archiveButton) {
        archiveButton.setAttribute('aria-label', (note.archived ? 'Restore voice note "' : 'Archive voice note "') + noteTitle + '"');
        archiveButton.addEventListener('click', function (event) {
          event.stopPropagation();
          toggleArchiveNote(note);
        });
      }
      var deleteButton = item.querySelector('[data-note-delete]');
      if (deleteButton) {
        deleteButton.setAttribute('aria-label', 'Delete voice note "' + noteTitle + '"');
        deleteButton.addEventListener('click', function (event) {
          event.stopPropagation();
          deleteVoiceNote(note);
        });
      }
      els.noteList.appendChild(item);
    });
  }

  function escapeHtml(text) {
    return String(text || '').replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function transcriptText(note) {
    return String((note && (note.transcript || note.notes_markdown)) || '');
  }

  function normalizedRanges(note) {
    var payload = note && note.notes_highlights;
    var ranges = payload && Array.isArray(payload.ranges) ? payload.ranges : [];
    return ranges.map(function (range) {
      return {
        start: Math.max(0, Number(range.start || 0)),
        end: Math.max(0, Number(range.end || 0)),
        color: ['yellow', 'green', 'blue', 'pink'].indexOf(range.color) >= 0 ? range.color : 'yellow'
      };
    }).filter(function (range) {
      return range.end > range.start;
    }).sort(function (a, b) {
      return a.start - b.start || a.end - b.end;
    });
  }

  function highlightedText(text, ranges) {
    var source = String(text || '');
    var cursor = 0;
    var html = '';
    ranges.forEach(function (range) {
      var start = Math.max(cursor, Math.min(source.length, range.start));
      var end = Math.max(start, Math.min(source.length, range.end));
      if (start > cursor) html += escapeHtml(source.slice(cursor, start));
      if (end > start) {
        html += '<mark class="voice-mark-' + range.color + '">' + escapeHtml(source.slice(start, end)) + '</mark>';
      }
      cursor = end;
    });
    if (cursor < source.length) html += escapeHtml(source.slice(cursor));
    return html.replace(/\n/g, '<br>');
  }

  function renderDetail() {
    var note = selectedNote();
    if (!els.detail || !els.detailEmpty) return;
    if (!note) {
      els.detail.hidden = true;
      els.detailEmpty.hidden = false;
      setAudioStatus('');
      setAudioDownloadReady(false);
      return;
    }
    els.detail.hidden = false;
    els.detailEmpty.hidden = true;
    if (els.detailTitle && els.detailTitle.value !== note.title) els.detailTitle.value = note.title || '';
    if (els.detailMeta) {
      var meta = [formatDate(note.created_at), note.status || 'pending'];
      if (note.archived) meta.push('archived');
      if (note.error) meta.push(note.error);
      els.detailMeta.textContent = meta.join(' - ');
    }
    if (els.archiveBtn) els.archiveBtn.textContent = note.archived ? 'Restore' : 'Archive';
    setAudioDownloadReady(false);
    setAudioStatus('');
    renderAudio(note);
    updateAudioDownloadAvailability(note);
    renderTranscript(note);
  }

  function updateAudioDownloadAvailability(note) {
    if (!note) {
      setAudioDownloadReady(false);
      return;
    }
    var noteId = note.id;
    var localId = note.local_audio_id || note.id;
    return getAudioBlob(localId).then(function (blob) {
      if (!selectedNote() || selectedNote().id !== noteId) return;
      var hasServerAudio = !!(note.study_pack_id && note.has_audio_playback);
      var isReady = !!blob || hasServerAudio;
      setAudioDownloadReady(isReady);
      if (!isReady) {
        setAudioStatus('No downloadable audio copy is available for this note.', 'error');
      }
    }).catch(function () {
      if (!selectedNote() || selectedNote().id !== noteId) return;
      setAudioDownloadReady(!!(note.study_pack_id && note.has_audio_playback));
    });
  }

  function renderAudio(note) {
    if (!els.audio) return;
    var current = els.audio.getAttribute('data-note-id') || '';
    if (current === note.id) return;
    els.audio.removeAttribute('src');
    els.audio.hidden = true;
    els.audio.setAttribute('data-note-id', note.id);
    getAudioBlob(note.local_audio_id || note.id).then(function (blob) {
      if (blob && selectedNote() && selectedNote().id === note.id) {
        els.audio.src = URL.createObjectURL(blob);
        els.audio.hidden = false;
        setAudioStatus('');
      } else if (note.study_pack_id && note.has_audio_playback) {
        authFetch('/api/study-packs/' + encodeURIComponent(note.study_pack_id) + '/audio').then(function (response) {
          if (!response.ok) throw new Error('Audio unavailable');
          return response.blob();
        }).then(function (remoteBlob) {
          putAudioBlob(note.local_audio_id || note.id, remoteBlob, note.audio_name || 'voice-note.mp3');
          if (selectedNote() && selectedNote().id === note.id) {
            els.audio.src = URL.createObjectURL(remoteBlob);
            els.audio.hidden = false;
            setAudioStatus('');
            setAudioDownloadReady(true);
          }
        }).catch(function () {
          if (selectedNote() && selectedNote().id === note.id) {
            note.has_audio_playback = false;
            setAudioDownloadReady(false);
            setAudioStatus('Audio playback is unavailable because this temporary audio file has been deleted.', 'error');
          }
        });
      } else {
        setAudioDownloadReady(false);
        setAudioStatus('No downloadable audio copy is available for this note.', 'error');
      }
    }).catch(function () {
      if (selectedNote() && selectedNote().id === note.id) {
        setAudioDownloadReady(false);
        setAudioStatus('Could not check audio on this device.', 'error');
      }
    });
  }

  function renderTranscript(note) {
    var text = transcriptText(note);
    if (els.transcript) els.transcript.textContent = text || 'Transcript will appear automatically after recording.';
    if (!els.notesSurface) return;
    var visible = text || (note.status === 'error' ? (note.error || 'Sync failed. Use Sync All to retry.') : 'Transcript will appear automatically after recording.');
    els.notesSurface.innerHTML = '<div class="voice-note-plain">' + highlightedText(visible, normalizedRanges(note)) + '</div>';
  }

  function renderStorage() {
    if (els.storageCount) els.storageCount.textContent = state.notes.length + (state.notes.length === 1 ? ' note cached' : ' notes cached');
    if (els.storageSize) {
      var bytes = utils.estimateOfflineBytes ? utils.estimateOfflineBytes(state.notes) : 0;
      els.storageSize.textContent = (bytes / (1024 * 1024)).toFixed(1) + ' MB offline';
    }
  }

  function renderSettings() {
    if (els.languageSelect) els.languageSelect.value = state.settings.output_language || 'english';
    if (els.customInput && els.customInput.value !== (state.settings.custom_instruction || '')) {
      els.customInput.value = state.settings.custom_instruction || '';
    }
  }

  function renderAll() {
    renderList();
    renderDetail();
    renderStorage();
    renderSettings();
    renderSyncPill();
  }

  function setAuthUi() {
    var signedIn = hasSignedInSession();
    var ready = !!state.authReady || signedIn;
    if (els.auth) els.auth.hidden = !ready || signedIn;
    if (els.app) els.app.hidden = false;
  }

  function saveSelectedTitle() {
    var note = selectedNote();
    if (!note || !els.detailTitle) return;
    var title = String(els.detailTitle.value || '').trim() || 'Voice note';
    if (title === note.title) return;
    note.title = title;
    note.updated_at = nowSeconds();
    putNote(note).then(function () {
      if (note.study_pack_id) {
        return apiJson('/api/voice-notes/' + encodeURIComponent(note.study_pack_id) + '/metadata', {
          method: 'PATCH',
          body: JSON.stringify({ title: title }),
          headers: { 'Content-Type': 'application/json' }
        }).catch(function () {});
      }
    }).then(renderAll);
  }

  function shareSelectedNote() {
    var note = selectedNote();
    if (!note) return;
    var text = [note.title || 'Voice note', '', transcriptText(note)].join('\n');
    if (navigator.share) {
      navigator.share({ title: note.title || 'Voice note', text: text }).catch(function () {});
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      showToast('Copied to clipboard.');
    }).catch(function () {
      showToast('Share is unavailable.', 'error');
    });
  }

  function downloadSelectedAudio() {
    var note = selectedNote();
    if (!note) return;
    var localId = note.local_audio_id || note.id;
    var fallbackName = audioFileName(note.audio_name || note.title || 'voice-note-audio', { type: note.audio_type || 'audio/webm' });
    if (els.downloadAudioBtn) els.downloadAudioBtn.disabled = true;
    getAudioBlob(localId).then(function (blob) {
      if (blob) {
        saveBlobAsFile(blob, audioFileName(note.audio_name || fallbackName, blob));
        setAudioStatus('');
        showToast('Audio download started.');
        return null;
      }
      if (!note.study_pack_id || !note.has_audio_playback) {
        throw new Error('No downloadable audio copy is available for this note.');
      }
      return authFetch('/api/study-packs/' + encodeURIComponent(note.study_pack_id) + '/audio?download=1').then(function (response) {
        if (!response.ok) throw new Error('Audio is no longer available on the server.');
        if (downloadUtils.downloadResponseBlob) {
          return downloadUtils.downloadResponseBlob(response, fallbackName);
        }
        return response.blob().then(function (remoteBlob) {
          saveBlobAsFile(remoteBlob, fallbackName);
        });
      }).then(function () {
        setAudioStatus('');
        showToast('Audio download started.');
      });
    }).catch(function (error) {
      var message = error && error.message ? error.message : 'Could not download audio.';
      setAudioStatus(message, 'error');
      showToast(message, 'error');
    }).finally(function () {
      updateAudioDownloadAvailability(note);
    });
  }

  function persistArchiveState(note, archived) {
    if (!note) return Promise.resolve();
    note.archived = !!archived;
    note.updated_at = nowSeconds();
    return putNote(note).then(function () {
      if (!note.study_pack_id || !navigator.onLine) return null;
      return apiJson('/api/voice-notes/' + encodeURIComponent(note.study_pack_id) + '/metadata', {
        method: 'PATCH',
        body: JSON.stringify({ archived: note.archived }),
        headers: { 'Content-Type': 'application/json' }
      });
    });
  }

  function toggleArchiveNote(note) {
    var target = note || selectedNote();
    if (!target) return;
    var nextArchived = !target.archived;
    persistArchiveState(target, nextArchived).then(function () {
      showToast(nextArchived ? 'Voice note archived.' : 'Voice note restored.');
      if (nextArchived && state.filter !== 'archived') {
        state.selectedId = '';
        setView('library');
      }
      renderAll();
    }).catch(function (error) {
      target.archived = !nextArchived;
      putNote(target).catch(function () {});
      showToast(error && error.message ? error.message : 'Could not update archive state.', 'error');
      renderAll();
    });
  }

  function deleteVoiceNote(note) {
    var target = note || selectedNote();
    if (!target) return;
    openConfirmModal(
      'Delete Voice Note',
      'Delete this voice note permanently? This also removes the synced study-pack copy.',
      'Delete Voice Note'
    ).then(function (confirmed) {
      if (!confirmed) return;
      var removeLocal = function () {
        state.notes = state.notes.filter(function (item) { return item.id !== target.id; });
        if (state.selectedId === target.id) state.selectedId = '';
        return Promise.all([
          removeNoteRow(target.id).catch(function () {}),
          removeAudioBlob(target.local_audio_id || target.id).catch(function () {})
        ]);
      };
      var remoteDelete = target.study_pack_id && navigator.onLine
        ? apiJson('/api/study-packs/' + encodeURIComponent(target.study_pack_id), { method: 'DELETE' })
        : Promise.resolve();
      remoteDelete.then(removeLocal).then(function () {
        showToast('Voice note deleted.');
        setView('library');
        renderAll();
      }).catch(function (error) {
        showToast(error && error.message ? error.message : 'Could not delete voice note.', 'error');
      });
    });
  }

  function getSelectionOffsets(container) {
    var selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
    var range = selection.getRangeAt(0);
    if (!container.contains(range.commonAncestorContainer)) return null;
    var pre = range.cloneRange();
    pre.selectNodeContents(container);
    pre.setEnd(range.startContainer, range.startOffset);
    var start = pre.toString().length;
    var selected = range.toString().length;
    return selected > 0 ? { start: start, end: start + selected } : null;
  }

  function pushHighlightHistory(note) {
    state.highlightUndo.push(JSON.stringify(note.notes_highlights || null));
    state.highlightRedo = [];
    if (state.highlightUndo.length > 50) state.highlightUndo.shift();
  }

  function setHighlightPayload(note, ranges) {
    note.notes_highlights = {
      base_key: (note.study_pack_id || note.id) + ':' + transcriptText(note).length,
      ranges: ranges,
      updated_at: nowSeconds()
    };
    note.updated_at = nowSeconds();
    return putNote(note).then(function () {
      if (!note.study_pack_id || !navigator.onLine) return null;
      return apiJson('/api/study-packs/' + encodeURIComponent(note.study_pack_id), {
        method: 'PATCH',
        body: JSON.stringify({ notes_highlights: note.notes_highlights }),
        headers: { 'Content-Type': 'application/json' }
      }).catch(function () { return null; });
    }).then(renderDetail);
  }

  var highlightSelectionTimer = null;

  function applyHighlightFromSelection() {
    if (highlightSelectionTimer) {
      window.clearTimeout(highlightSelectionTimer);
      highlightSelectionTimer = null;
    }
    var note = selectedNote();
    if (!note || !els.notesSurface || !transcriptText(note).trim()) return;
    var offsets = getSelectionOffsets(els.notesSurface);
    if (!offsets) return;
    pushHighlightHistory(note);
    var ranges = normalizedRanges(note);
    ranges = ranges.filter(function (range) {
      return range.end <= offsets.start || range.start >= offsets.end;
    });
    if (state.highlightColor !== 'eraser') ranges.push({ start: offsets.start, end: offsets.end, color: state.highlightColor });
    window.getSelection().removeAllRanges();
    setHighlightPayload(note, ranges);
  }

  function selectionInsideVoiceNotes() {
    var selection = window.getSelection ? window.getSelection() : null;
    if (!selection || selection.isCollapsed || !selection.rangeCount || !els.notesSurface) return false;
    try {
      return els.notesSurface.contains(selection.getRangeAt(0).commonAncestorContainer);
    } catch (e) {
      return false;
    }
  }

  function scheduleVoiceHighlight(delayMs) {
    if (!selectionInsideVoiceNotes()) return;
    if (highlightSelectionTimer) window.clearTimeout(highlightSelectionTimer);
    highlightSelectionTimer = window.setTimeout(function () {
      highlightSelectionTimer = null;
      applyHighlightFromSelection();
    }, Math.max(80, Number(delayMs || 120)));
  }

  function restoreHighlightHistory(direction) {
    var note = selectedNote();
    if (!note) return;
    if (direction === 'undo') {
      if (!state.highlightUndo.length) return;
      state.highlightRedo.push(JSON.stringify(note.notes_highlights || null));
      note.notes_highlights = JSON.parse(state.highlightUndo.pop());
    } else {
      if (!state.highlightRedo.length) return;
      state.highlightUndo.push(JSON.stringify(note.notes_highlights || null));
      note.notes_highlights = JSON.parse(state.highlightRedo.pop());
    }
    setHighlightPayload(note, normalizedRanges(note));
  }

  function clearHighlights() {
    var note = selectedNote();
    if (!note) return;
    pushHighlightHistory(note);
    setHighlightPayload(note, []);
  }

  function downloadNotes() {
    var note = selectedNote();
    if (!note) return;
    var blob = new Blob([transcriptText(note)], { type: 'text/plain;charset=utf-8' });
    if (downloadUtils.saveBlobAsFile) {
      downloadUtils.saveBlobAsFile(blob, (note.title || 'voice-note') + '.txt');
      return;
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (note.title || 'voice-note') + '.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function loadServerStudyPacks() {
    if (!hasSignedInSession()) return Promise.resolve();
    return apiJson('/api/study-packs?limit=100').then(function (payload) {
      var packs = Array.isArray(payload.study_packs) ? payload.study_packs : [];
      var chain = Promise.resolve();
      packs.filter(function (pack) {
        return pack.mode === 'voice-note';
      }).forEach(function (pack) {
        chain = chain.then(function () {
          return apiJson('/api/study-packs/' + encodeURIComponent(pack.study_pack_id)).then(function (detail) {
            var existing = state.notes.find(function (note) { return note.study_pack_id === detail.study_pack_id; });
            var note = utils.normalizePackPayload ? utils.normalizePackPayload(detail, existing || {}) : Object.assign({}, existing || {}, detail);
            note.id = existing ? existing.id : ('server-' + detail.study_pack_id);
            note.owner_key = currentOwnerKey();
            note.local_audio_id = existing ? existing.local_audio_id : note.id;
            note.transcript = detail.source_transcript || note.transcript || '';
            note.notes_markdown = note.transcript;
            note.created_at = Number(detail.created_at || note.created_at || nowSeconds());
            note.flashcards = [];
            note.test_questions = [];
            if (existing) Object.assign(existing, note);
            else state.notes.push(note);
            return putNote(existing || note);
          });
        });
      });
      return chain;
    }).catch(function () {});
  }

  function attachEvents() {
    Array.prototype.slice.call(document.querySelectorAll('[data-voice-view]')).forEach(function (button) {
      button.addEventListener('click', function () { setView(button.getAttribute('data-voice-view')); });
    });
    Array.prototype.slice.call(document.querySelectorAll('[data-filter]')).forEach(function (button) {
      button.addEventListener('click', function () {
        state.filter = button.getAttribute('data-filter') || 'all';
        Array.prototype.slice.call(document.querySelectorAll('[data-filter]')).forEach(function (btn) {
          var isActive = btn === button;
          btn.classList.toggle('active', isActive);
          btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        });
        renderList();
      });
    });
    if (els.recordBtn) els.recordBtn.addEventListener('click', startRecording);
    if (els.pauseBtn) els.pauseBtn.addEventListener('click', toggleRecordingPause);
    if (els.stopBtn) els.stopBtn.addEventListener('click', stopRecording);
    if (els.importBtn) els.importBtn.addEventListener('click', function () { if (els.fileInput) els.fileInput.click(); });
    if (els.fileInput) {
      els.fileInput.addEventListener('change', function () {
        var file = els.fileInput.files && els.fileInput.files[0];
        if (!file) return;
        setRecordStatus('Audio imported. Transcribing...');
        saveAudioAndSync(file, file.name || 'voice-note.m4a', 0);
        els.fileInput.value = '';
      });
    }
    if (els.syncAllBtn) els.syncAllBtn.addEventListener('click', syncAllPending);
    if (els.searchInput) els.searchInput.addEventListener('input', function () {
      state.search = els.searchInput.value || '';
      renderList();
    });
    if (els.detailTitle) els.detailTitle.addEventListener('change', saveSelectedTitle);
    if (els.backBtn) els.backBtn.addEventListener('click', function () { setView('library'); });
    if (els.shareBtn) els.shareBtn.addEventListener('click', shareSelectedNote);
    if (els.downloadAudioBtn) els.downloadAudioBtn.addEventListener('click', downloadSelectedAudio);
    if (els.archiveBtn) els.archiveBtn.addEventListener('click', function () { toggleArchiveNote(); });
    if (els.deleteBtn) els.deleteBtn.addEventListener('click', function () { deleteVoiceNote(); });
    if (els.confirmClose) els.confirmClose.addEventListener('click', function () { closeConfirmModal(false); });
    if (els.confirmCancel) els.confirmCancel.addEventListener('click', function () { closeConfirmModal(false); });
    if (els.confirmConfirm) els.confirmConfirm.addEventListener('click', function () { closeConfirmModal(true); });
    if (els.confirmModal) {
      els.confirmModal.addEventListener('click', function (event) {
        if (event.target === els.confirmModal) closeConfirmModal(false);
      });
    }
    if (els.notesSurface) {
      els.notesSurface.addEventListener('mouseup', function () { scheduleVoiceHighlight(120); });
      els.notesSurface.addEventListener('touchend', function () {
        scheduleVoiceHighlight(1000);
      });
    }
    document.addEventListener('selectionchange', function () {
      if (!selectionInsideVoiceNotes()) return;
      scheduleVoiceHighlight(1000);
    });
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && els.confirmModal && !els.confirmModal.hidden) closeConfirmModal(false);
    });
    if (els.highlightToolbar) {
      els.highlightToolbar.addEventListener('click', function (event) {
        var target = event.target.closest('[data-hl-color]');
        if (!target) return;
        state.highlightColor = target.getAttribute('data-hl-color') || 'yellow';
        Array.prototype.slice.call(els.highlightToolbar.querySelectorAll('[data-hl-color]')).forEach(function (btn) {
          btn.classList.toggle('active', btn === target);
        });
      });
    }
    if (els.hlUndo) els.hlUndo.addEventListener('click', function () { restoreHighlightHistory('undo'); });
    if (els.hlRedo) els.hlRedo.addEventListener('click', function () { restoreHighlightHistory('redo'); });
    if (els.hlClear) els.hlClear.addEventListener('click', clearHighlights);
    if (els.downloadNotes) els.downloadNotes.addEventListener('click', downloadNotes);
    if (els.languageSelect) {
      els.languageSelect.addEventListener('change', function () {
        state.settings.output_language = els.languageSelect.value;
        saveSettings();
      });
    }
    if (els.customInput) {
      els.customInput.addEventListener('input', function () {
        state.settings.custom_instruction = els.customInput.value || '';
        saveSettings();
      });
    }
    window.addEventListener('online', function () {
      renderAll();
      syncAllPending();
    });
    window.addEventListener('offline', renderAll);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden || !state.recorder || state.recorder.state === 'inactive') return;
      if (typeof state.recorder.requestData === 'function') {
        try { state.recorder.requestData(); } catch (e) {}
      }
      setRecordStatus('Keep this app open and unlocked while recording.');
    });
    window.addEventListener('popstate', function (event) {
      var historyState = event.state && typeof event.state === 'object' ? event.state : {};
      var nextView = String(historyState.voiceView || 'record');
      if (historyState.selectedId !== undefined) state.selectedId = String(historyState.selectedId || '');
      setView(nextView, { history: false });
      renderAll();
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/service-worker.js', { scope: '/voice-notes' }).catch(function () {});
  }

  function loadLocalVoiceNotesForCurrentUser() {
    state.notes = [];
    state.selectedId = '';
    state.settings = Object.assign({}, DEFAULT_SETTINGS);
    return loadSettings()
      .then(getAllNotes)
      .then(function (notes) {
        state.notes = notes;
        return loadServerStudyPacks();
      })
      .then(function () {
        renderAll();
        if (navigator.onLine && hasSignedInSession()) syncAllPending();
      })
      .catch(function (error) {
        showToast(error && error.message ? error.message : 'Could not load voice notes.', 'error');
      });
  }

  function init() {
    cacheElements();
    if (window.history && window.history.replaceState) {
      window.history.replaceState({ voiceView: state.view, selectedId: state.selectedId || '' }, '', window.location.pathname + window.location.search);
    }
    attachEvents();
    registerServiceWorker();

    bootstrap.onAuthStateReady(auth, function (user) {
      state.authReady = true;
      state.user = user || null;
      if (!state.user && authClient && typeof authClient.clearToken === 'function') authClient.clearToken();
      setAuthUi();
      loadLocalVoiceNotesForCurrentUser();
    });
    setAuthUi();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
