(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;
  var utils = window.LectureProcessorVoiceNotes || {};
  var downloadUtils = window.LectureProcessorDownload || {};

  if (!auth) return;

  var DB_NAME = 'lecture-processor-voice-notes';
  var DB_VERSION = 1;
  var STORE_NOTES = 'notes';
  var STORE_AUDIO = 'audio';
  var STORE_SETTINGS = 'settings';

  var state = {
    user: auth.currentUser || null,
    notes: [],
    folders: [],
    selectedId: '',
    selectedAudioBlob: null,
    selectedAudioName: '',
    selectedAudioSeconds: 0,
    recorder: null,
    recordingStream: null,
    recordingChunks: [],
    recordingStartedAt: 0,
    recordingTimer: 0,
    syncing: {},
    search: '',
    filter: 'all',
    activeDetailTab: 'transcript',
    highlightColor: 'yellow',
    highlightUndo: [],
    highlightRedo: [],
    settings: {
      output_language: 'english',
      flashcard_amount: '20',
      question_amount: '10'
    }
  };

  var els = {};

  function $(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    [
      'voice-auth', 'voice-app', 'voice-sync-pill', 'voice-record-btn', 'voice-stop-btn', 'voice-time',
      'voice-meter', 'voice-record-status', 'voice-file-input', 'voice-import-btn', 'voice-title-input',
      'voice-tags-input', 'voice-folder-select', 'voice-append-select', 'voice-custom-input',
      'voice-pinned-input', 'voice-generate-tools-input', 'voice-save-local-btn', 'voice-sync-current-btn',
      'voice-search-input', 'voice-note-list', 'voice-detail-empty', 'voice-detail', 'voice-detail-title',
      'voice-detail-meta', 'voice-pin-btn', 'voice-share-btn', 'voice-audio', 'voice-transcript',
      'voice-notes-surface', 'voice-highlight-toolbar', 'voice-hl-undo', 'voice-hl-redo', 'voice-hl-clear',
      'voice-download-notes', 'voice-flashcard-count', 'voice-question-count', 'voice-flashcards',
      'voice-questions', 'voice-refresh-tools-btn', 'voice-language-select', 'voice-flashcard-amount',
      'voice-question-amount', 'voice-storage-count', 'voice-storage-size', 'voice-sync-all-btn',
      'voice-toast'
    ].forEach(function (id) {
      var key = id.replace(/^voice-/, '').replace(/-([a-z])/g, function (_m, chr) { return chr.toUpperCase(); });
      els[key] = $(id);
    });
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains(STORE_NOTES)) {
          db.createObjectStore(STORE_NOTES, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_AUDIO)) {
          db.createObjectStore(STORE_AUDIO, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
        }
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

  function getAllNotes() {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE_NOTES, 'readonly');
        var request = tx.objectStore(STORE_NOTES).getAll();
        request.onsuccess = function () { resolve(request.result || []); };
        request.onerror = function () { reject(request.error || new Error('Could not load notes')); };
        tx.oncomplete = function () { db.close(); };
      });
    });
  }

  function putNote(note) {
    return withStore(STORE_NOTES, 'readwrite', function (store) {
      store.put(note);
      return note;
    });
  }

  function getAudioBlob(id) {
    return withStore(STORE_AUDIO, 'readonly', function (store) {
      return requestToPromise(store.get(id));
    }).then(function (row) {
      return row && row.blob ? row.blob : null;
    });
  }

  function putAudioBlob(id, blob, name) {
    return withStore(STORE_AUDIO, 'readwrite', function (store) {
      store.put({ id: id, blob: blob, name: name || 'voice-note.webm', size: Number(blob && blob.size) || 0, updated_at: Date.now() });
    });
  }

  function loadSettings() {
    return withStore(STORE_SETTINGS, 'readonly', function (store) {
      return requestToPromise(store.get('voice-settings'));
    }).then(function (row) {
      if (row && row.value) state.settings = Object.assign({}, state.settings, row.value);
    }).catch(function () {});
  }

  function saveSettings() {
    return withStore(STORE_SETTINGS, 'readwrite', function (store) {
      store.put({ key: 'voice-settings', value: state.settings });
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

  function selectedNote() {
    return state.notes.find(function (note) { return note.id === state.selectedId; }) || null;
  }

  function setView(view) {
    var safe = view || 'record';
    Array.prototype.slice.call(document.querySelectorAll('[data-voice-panel]')).forEach(function (panel) {
      panel.classList.toggle('active', panel.getAttribute('data-voice-panel') === safe);
    });
    Array.prototype.slice.call(document.querySelectorAll('[data-voice-view]')).forEach(function (btn) {
      var active = btn.getAttribute('data-voice-view') === safe;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    if (safe === 'study') renderDetail();
  }

  function updateRecordButtons() {
    var hasAudio = !!state.selectedAudioBlob;
    if (els.saveLocalBtn) els.saveLocalBtn.disabled = !hasAudio;
    if (els.syncCurrentBtn) els.syncCurrentBtn.disabled = !hasAudio && !selectedNote();
  }

  function setRecordStatus(text) {
    if (els.recordStatus) els.recordStatus.textContent = text || 'Ready';
  }

  function preferredMimeType() {
    if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== 'function') return '';
    var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/aac'];
    for (var i = 0; i < candidates.length; i += 1) {
      if (MediaRecorder.isTypeSupported(candidates[i])) return candidates[i];
    }
    return '';
  }

  function startTimer() {
    state.recordingStartedAt = Date.now();
    window.clearInterval(state.recordingTimer);
    state.recordingTimer = window.setInterval(function () {
      var seconds = Math.floor((Date.now() - state.recordingStartedAt) / 1000);
      state.selectedAudioSeconds = seconds;
      if (els.time) els.time.textContent = utils.formatDuration ? utils.formatDuration(seconds) : String(seconds);
    }, 250);
  }

  function stopTimer() {
    window.clearInterval(state.recordingTimer);
    state.recordingTimer = 0;
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
        var blobType = state.recorder && state.recorder.mimeType ? state.recorder.mimeType : (mimeType || 'audio/webm');
        var blob = new Blob(state.recordingChunks, { type: blobType });
        state.selectedAudioBlob = blob;
        state.selectedAudioName = 'voice-note-' + Date.now() + (blobType.indexOf('mp4') >= 0 ? '.m4a' : '.webm');
        if (state.recordingStream) {
          state.recordingStream.getTracks().forEach(function (track) { track.stop(); });
        }
        state.recordingStream = null;
        state.recorder = null;
        if (els.meter) els.meter.classList.remove('recording');
        if (els.recordBtn) els.recordBtn.classList.remove('recording');
        if (els.stopBtn) els.stopBtn.disabled = true;
        if (els.recordBtn) els.recordBtn.disabled = false;
        setRecordStatus('Recording saved locally in this browser.');
        stopTimer();
        updateRecordButtons();
      };
      state.recorder.start(1000);
      if (els.meter) els.meter.classList.add('recording');
      if (els.recordBtn) els.recordBtn.classList.add('recording');
      if (els.recordBtn) els.recordBtn.disabled = true;
      if (els.stopBtn) els.stopBtn.disabled = false;
      setRecordStatus('Recording...');
      startTimer();
    }).catch(function (error) {
      showToast(error && error.message ? error.message : 'Microphone permission was not granted.', 'error');
    });
  }

  function stopRecording() {
    if (state.recorder && state.recorder.state !== 'inactive') {
      state.recorder.stop();
    }
  }

  function readFormMetadata() {
    return {
      title: String(els.titleInput && els.titleInput.value || '').trim() || 'Untitled voice note',
      tags: utils.parseTags ? utils.parseTags(els.tagsInput && els.tagsInput.value) : [],
      folder_id: String(els.folderSelect && els.folderSelect.value || '').trim(),
      append_to_pack_id: String(els.appendSelect && els.appendSelect.value || '').trim(),
      custom_instruction: String(els.customInput && els.customInput.value || '').trim(),
      pinned: !!(els.pinnedInput && els.pinnedInput.checked),
      archived: false,
      generate_tools: !!(els.generateToolsInput && els.generateToolsInput.checked)
    };
  }

  function saveCurrentAudioOffline() {
    if (!state.selectedAudioBlob) return Promise.resolve(null);
    var meta = readFormMetadata();
    var id = createLocalId();
    var note = {
      id: id,
      study_pack_id: '',
      local_audio_id: id,
      title: meta.title,
      tags: meta.tags,
      folder_id: meta.folder_id,
      append_to_pack_id: meta.append_to_pack_id,
      custom_instruction: meta.custom_instruction,
      pinned: meta.pinned,
      archived: false,
      status: 'pending',
      transcript: '',
      notes_markdown: '',
      notes_highlights: null,
      flashcards: [],
      test_questions: [],
      audio_size: Number(state.selectedAudioBlob.size || 0),
      audio_name: state.selectedAudioName || 'voice-note.webm',
      audio_type: state.selectedAudioBlob.type || 'audio/webm',
      audio_seconds: state.selectedAudioSeconds,
      created_at: nowSeconds(),
      updated_at: nowSeconds(),
      generate_tools: meta.generate_tools
    };
    return putAudioBlob(id, state.selectedAudioBlob, note.audio_name)
      .then(function () { return putNote(note); })
      .then(function () {
        state.notes.unshift(note);
        state.selectedId = id;
        state.selectedAudioBlob = null;
        updateRecordButtons();
        renderAll();
        showToast('Saved offline.');
        return note;
      });
  }

  function syncNote(note) {
    if (!note || state.syncing[note.id]) return Promise.resolve();
    if (!hasSignedInSession()) {
      showToast('Sign in to sync.', 'error');
      return Promise.resolve();
    }
    state.syncing[note.id] = true;
    note.status = 'syncing';
    note.error = '';
    renderAll();
    return getAudioBlob(note.local_audio_id || note.id).then(function (blob) {
      if (!blob) throw new Error('Offline audio was not found on this device.');
      var form = new FormData();
      form.append('audio', blob, note.audio_name || 'voice-note.webm');
      form.append('title', note.title || 'Untitled voice note');
      form.append('tags', (note.tags || []).join(','));
      form.append('folder_id', note.folder_id || '');
      form.append('append_to_pack_id', note.append_to_pack_id || '');
      form.append('custom_instruction', note.custom_instruction || '');
      form.append('pinned', note.pinned ? '1' : '0');
      form.append('study_features', note.generate_tools === false ? 'none' : 'both');
      form.append('flashcard_amount', state.settings.flashcard_amount || '20');
      form.append('question_amount', state.settings.question_amount || '10');
      form.append('output_language', state.settings.output_language || 'english');
      return authFetch('/api/voice-notes', { method: 'POST', body: form });
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (payload) {
        if (!response.ok) throw new Error(payload.error || 'Could not sync voice note');
        note.job_id = payload.job_id;
        note.status = 'syncing';
        note.updated_at = nowSeconds();
        return putNote(note).then(function () { return pollJob(note, payload.job_id); });
      });
    }).catch(function (error) {
      note.status = 'error';
      note.error = error && error.message ? error.message : 'Sync failed';
      note.updated_at = nowSeconds();
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
        note.transcript = payload.transcript || note.transcript || '';
        if (payload.status === 'complete') {
          note.status = 'synced';
          note.study_pack_id = payload.study_pack_id || note.study_pack_id || '';
          note.notes_markdown = payload.result || note.notes_markdown || '';
          note.flashcards = Array.isArray(payload.flashcards) ? payload.flashcards : note.flashcards;
          note.test_questions = Array.isArray(payload.test_questions) ? payload.test_questions : note.test_questions;
          return fetchAndCachePack(note).then(function () {
            showToast('Voice note synced.');
          });
        }
        if (payload.status === 'error') {
          note.status = 'error';
          note.error = payload.error || 'Processing failed';
          return putNote(note);
        }
        return putNote(note).then(function () {
          if (attempts > 240) throw new Error('Processing is taking longer than expected.');
          return new Promise(function (resolve) {
            window.setTimeout(function () { resolve(tick()); }, 2500);
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
      merged.audio_size = note.audio_size || 0;
      merged.audio_name = note.audio_name || '';
      merged.audio_type = note.audio_type || '';
      Object.assign(note, merged);
      return putNote(note).then(function () {
        var index = state.notes.findIndex(function (item) { return item.id === note.id; });
        if (index >= 0) state.notes[index] = note;
      });
    });
  }

  function syncAllPending() {
    var pending = state.notes.filter(function (note) {
      var status = utils.normalizeStatus ? utils.normalizeStatus(note.status) : note.status;
      return status === 'pending' || status === 'error';
    });
    return pending.reduce(function (chain, note) {
      return chain.then(function () { return syncNote(note); });
    }, Promise.resolve());
  }

  function renderFolders() {
    if (!els.folderSelect || !els.appendSelect) return;
    var folderValue = els.folderSelect.value || '';
    els.folderSelect.innerHTML = '<option value="">No folder</option>';
    state.folders.forEach(function (folder) {
      var option = document.createElement('option');
      option.value = folder.folder_id;
      option.textContent = folder.name || 'Untitled folder';
      els.folderSelect.appendChild(option);
    });
    els.folderSelect.value = folderValue;

    var appendValue = els.appendSelect.value || '';
    els.appendSelect.innerHTML = '<option value="">Create new note</option>';
    state.notes.filter(function (note) {
      return note.study_pack_id && !note.archived;
    }).forEach(function (note) {
      var option = document.createElement('option');
      option.value = note.study_pack_id;
      option.textContent = note.title || 'Untitled note';
      els.appendSelect.appendChild(option);
    });
    els.appendSelect.value = appendValue;
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
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'voice-note-item' + (note.id === state.selectedId ? ' active' : '');
      button.innerHTML = [
        '<div class="voice-note-row">',
        '<div class="voice-note-title"></div>',
        '<span class="voice-note-status ' + (status === 'synced' ? 'synced' : status === 'error' ? 'error' : '') + '"></span>',
        '</div>',
        '<div class="voice-note-meta"></div>',
        '<div class="voice-tag-row"></div>'
      ].join('');
      button.querySelector('.voice-note-title').textContent = (note.pinned ? 'Pinned - ' : '') + (note.title || 'Untitled voice note');
      button.querySelector('.voice-note-status').textContent = status;
      button.querySelector('.voice-note-meta').textContent = formatDate(note.created_at) + ' - ' + (note.flashcards || []).length + ' cards - ' + (note.test_questions || []).length + ' questions';
      var tagRow = button.querySelector('.voice-tag-row');
      (note.tags || []).forEach(function (tag) {
        var span = document.createElement('span');
        span.className = 'voice-tag';
        span.textContent = tag;
        tagRow.appendChild(span);
      });
      button.addEventListener('click', function () {
        state.selectedId = note.id;
        setView('study');
        renderAll();
      });
      els.noteList.appendChild(button);
    });
  }

  function escapeHtml(text) {
    return String(text || '').replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
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
      return;
    }
    els.detail.hidden = false;
    els.detailEmpty.hidden = true;
    if (els.detailTitle && els.detailTitle.value !== note.title) els.detailTitle.value = note.title || '';
    if (els.detailMeta) {
      els.detailMeta.textContent = formatDate(note.created_at) + ' - ' + (note.status || 'pending');
    }
    if (els.pinBtn) els.pinBtn.classList.toggle('active', !!note.pinned);
    renderDetailTabs();
    renderAudio(note);
    renderTranscript(note);
    renderNotes(note);
    renderFlashcards(note);
    renderQuestions(note);
  }

  function renderDetailTabs() {
    Array.prototype.slice.call(document.querySelectorAll('[data-detail-tab]')).forEach(function (button) {
      var tab = button.getAttribute('data-detail-tab');
      var active = tab === state.activeDetailTab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    ['transcript', 'notes', 'flashcards', 'test'].forEach(function (tab) {
      var pane = $('voice-pane-' + tab);
      if (pane) pane.classList.toggle('active', tab === state.activeDetailTab);
    });
  }

  function renderAudio(note) {
    if (!els.audio) return;
    var current = els.audio.getAttribute('data-note-id') || '';
    if (current === note.id) return;
    els.audio.removeAttribute('src');
    els.audio.setAttribute('data-note-id', note.id);
    getAudioBlob(note.local_audio_id || note.id).then(function (blob) {
      if (blob && selectedNote() && selectedNote().id === note.id) {
        els.audio.src = URL.createObjectURL(blob);
      } else if (note.study_pack_id && note.has_audio_playback) {
        authFetch('/api/study-packs/' + encodeURIComponent(note.study_pack_id) + '/audio').then(function (response) {
          if (!response.ok) throw new Error('Audio unavailable');
          return response.blob();
        }).then(function (remoteBlob) {
          putAudioBlob(note.local_audio_id || note.id, remoteBlob, note.audio_name || 'voice-note.mp3');
          if (selectedNote() && selectedNote().id === note.id) {
            els.audio.src = URL.createObjectURL(remoteBlob);
          }
        }).catch(function () {});
      }
    });
  }

  function renderTranscript(note) {
    if (!els.transcript) return;
    els.transcript.textContent = note.transcript || 'Transcript will appear after sync.';
  }

  function renderNotes(note) {
    if (!els.notesSurface) return;
    var text = note.notes_markdown || 'Notes will appear after sync.';
    els.notesSurface.innerHTML = '<div class="voice-note-plain">' + highlightedText(text, normalizedRanges(note)) + '</div>';
  }

  function renderFlashcards(note) {
    if (!els.flashcards) return;
    var cards = Array.isArray(note.flashcards) ? note.flashcards : [];
    if (els.flashcardCount) els.flashcardCount.textContent = cards.length + (cards.length === 1 ? ' flashcard' : ' flashcards');
    els.flashcards.innerHTML = '';
    if (!cards.length) {
      els.flashcards.innerHTML = '<div class="voice-detail-empty">No flashcards yet.</div>';
      return;
    }
    cards.forEach(function (card) {
      var node = document.createElement('button');
      node.type = 'button';
      node.className = 'voice-flashcard';
      node.innerHTML = '<div class="voice-flashcard-front"></div><div class="voice-flashcard-back"></div>';
      node.querySelector('.voice-flashcard-front').textContent = card.front || 'Question';
      node.querySelector('.voice-flashcard-back').textContent = card.back || '';
      node.addEventListener('click', function () {
        node.classList.toggle('flipped');
      });
      els.flashcards.appendChild(node);
    });
  }

  function renderQuestions(note) {
    if (!els.questions) return;
    var questions = Array.isArray(note.test_questions) ? note.test_questions : [];
    if (els.questionCount) els.questionCount.textContent = questions.length + (questions.length === 1 ? ' question' : ' questions');
    els.questions.innerHTML = '';
    if (!questions.length) {
      els.questions.innerHTML = '<div class="voice-detail-empty">No practice questions yet.</div>';
      return;
    }
    questions.forEach(function (question) {
      var wrapper = document.createElement('div');
      wrapper.className = 'voice-question';
      var title = document.createElement('strong');
      title.textContent = question.question || 'Question';
      wrapper.appendChild(title);
      (Array.isArray(question.options) ? question.options : []).forEach(function (option) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'voice-option';
        btn.textContent = option;
        btn.addEventListener('click', function () {
          Array.prototype.slice.call(wrapper.querySelectorAll('.voice-option')).forEach(function (node) {
            node.classList.toggle('correct', node.textContent === question.answer);
            if (node === btn && node.textContent !== question.answer) node.classList.add('incorrect');
          });
          explanation.hidden = false;
        });
        wrapper.appendChild(btn);
      });
      var explanation = document.createElement('div');
      explanation.className = 'voice-question-explanation';
      explanation.hidden = true;
      explanation.textContent = question.explanation || '';
      wrapper.appendChild(explanation);
      els.questions.appendChild(wrapper);
    });
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
    if (els.flashcardAmount) els.flashcardAmount.value = state.settings.flashcard_amount || '20';
    if (els.questionAmount) els.questionAmount.value = state.settings.question_amount || '10';
  }

  function renderAll() {
    renderFolders();
    renderList();
    renderDetail();
    renderStorage();
    renderSettings();
    var pending = state.notes.filter(function (note) {
      var status = utils.normalizeStatus ? utils.normalizeStatus(note.status) : note.status;
      return status === 'pending' || status === 'syncing' || status === 'error';
    }).length;
    if (!navigator.onLine) syncPill('Offline', 'error');
    else if (pending) syncPill(pending + ' to sync', 'online');
    else syncPill('Synced', 'online');
  }

  function setAuthUi() {
    var signedIn = hasSignedInSession();
    if (els.auth) els.auth.hidden = signedIn;
    if (els.app) els.app.hidden = false;
  }

  function saveSelectedTitle() {
    var note = selectedNote();
    if (!note || !els.detailTitle) return;
    var title = String(els.detailTitle.value || '').trim() || 'Untitled voice note';
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

  function savePinState() {
    var note = selectedNote();
    if (!note) return;
    note.pinned = !note.pinned;
    note.updated_at = nowSeconds();
    putNote(note).then(function () {
      if (note.study_pack_id) {
        return apiJson('/api/voice-notes/' + encodeURIComponent(note.study_pack_id) + '/metadata', {
          method: 'PATCH',
          body: JSON.stringify({ pinned: note.pinned }),
          headers: { 'Content-Type': 'application/json' }
        }).catch(function () {});
      }
    }).then(renderAll);
  }

  function shareSelectedNote() {
    var note = selectedNote();
    if (!note) return;
    var text = [note.title || 'Voice note', '', note.notes_markdown || note.transcript || ''].join('\n');
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
      base_key: (note.study_pack_id || note.id) + ':' + String(note.notes_markdown || '').length,
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

  function applyHighlightFromSelection() {
    var note = selectedNote();
    if (!note || !els.notesSurface || !(note.notes_markdown || '').trim()) return;
    var offsets = getSelectionOffsets(els.notesSurface);
    if (!offsets) return;
    pushHighlightHistory(note);
    var ranges = normalizedRanges(note);
    ranges = ranges.filter(function (range) {
      return range.end <= offsets.start || range.start >= offsets.end;
    });
    if (state.highlightColor !== 'eraser') {
      ranges.push({ start: offsets.start, end: offsets.end, color: state.highlightColor });
    }
    window.getSelection().removeAllRanges();
    setHighlightPayload(note, ranges);
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
    var blob = new Blob([note.notes_markdown || note.transcript || ''], { type: 'text/markdown;charset=utf-8' });
    if (downloadUtils.saveBlobAsFile) {
      downloadUtils.saveBlobAsFile(blob, (note.title || 'voice-note') + '.md');
      return;
    }
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (note.title || 'voice-note') + '.md';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function refreshStudyTools() {
    var note = selectedNote();
    if (!note || !note.study_pack_id) {
      showToast('Sync this note first.', 'error');
      return;
    }
    apiJson('/api/voice-notes/' + encodeURIComponent(note.study_pack_id) + '/study-tools', {
      method: 'POST',
      body: JSON.stringify({
        study_features: 'both',
        flashcard_amount: state.settings.flashcard_amount,
        question_amount: state.settings.question_amount
      }),
      headers: { 'Content-Type': 'application/json' }
    }).then(function (payload) {
      note.status = 'syncing';
      note.job_id = payload.job_id;
      return putNote(note).then(function () { return pollJob(note, payload.job_id); });
    }).catch(function (error) {
      showToast(error.message || 'Could not refresh study tools.', 'error');
    });
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
            note.local_audio_id = existing ? existing.local_audio_id : note.id;
            note.transcript = detail.source_transcript || note.transcript || '';
            note.created_at = Number(detail.created_at || note.created_at || nowSeconds());
            if (existing) {
              Object.assign(existing, note);
            } else {
              state.notes.push(note);
            }
            return putNote(existing || note);
          });
        });
      });
      return chain;
    }).catch(function () {});
  }

  function loadFolders() {
    if (!hasSignedInSession()) return Promise.resolve();
    return apiJson('/api/study-folders').then(function (payload) {
      state.folders = Array.isArray(payload.folders) ? payload.folders : [];
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
          btn.classList.toggle('active', btn === button);
        });
        renderList();
      });
    });
    Array.prototype.slice.call(document.querySelectorAll('[data-detail-tab]')).forEach(function (button) {
      button.addEventListener('click', function () {
        state.activeDetailTab = button.getAttribute('data-detail-tab') || 'transcript';
        renderDetailTabs();
      });
    });
    if (els.recordBtn) els.recordBtn.addEventListener('click', startRecording);
    if (els.stopBtn) els.stopBtn.addEventListener('click', stopRecording);
    if (els.importBtn) els.importBtn.addEventListener('click', function () { if (els.fileInput) els.fileInput.click(); });
    if (els.fileInput) {
      els.fileInput.addEventListener('change', function () {
        var file = els.fileInput.files && els.fileInput.files[0];
        if (!file) return;
        state.selectedAudioBlob = file;
        state.selectedAudioName = file.name || 'voice-note.m4a';
        state.selectedAudioSeconds = 0;
        setRecordStatus('Audio ready.');
        updateRecordButtons();
      });
    }
    if (els.saveLocalBtn) els.saveLocalBtn.addEventListener('click', function () { saveCurrentAudioOffline(); });
    if (els.syncCurrentBtn) els.syncCurrentBtn.addEventListener('click', function () {
      var note = selectedNote();
      if (state.selectedAudioBlob) {
        saveCurrentAudioOffline().then(syncNote);
      } else if (note) {
        syncNote(note);
      }
    });
    if (els.syncAllBtn) els.syncAllBtn.addEventListener('click', syncAllPending);
    if (els.searchInput) els.searchInput.addEventListener('input', function () {
      state.search = els.searchInput.value || '';
      renderList();
    });
    if (els.detailTitle) els.detailTitle.addEventListener('change', saveSelectedTitle);
    if (els.pinBtn) els.pinBtn.addEventListener('click', savePinState);
    if (els.shareBtn) els.shareBtn.addEventListener('click', shareSelectedNote);
    if (els.notesSurface) {
      els.notesSurface.addEventListener('mouseup', applyHighlightFromSelection);
      els.notesSurface.addEventListener('touchend', function () {
        window.setTimeout(applyHighlightFromSelection, 80);
      });
    }
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
    if (els.refreshToolsBtn) els.refreshToolsBtn.addEventListener('click', refreshStudyTools);
    [
      ['languageSelect', 'output_language'],
      ['flashcardAmount', 'flashcard_amount'],
      ['questionAmount', 'question_amount']
    ].forEach(function (pair) {
      var element = els[pair[0]];
      if (!element) return;
      element.addEventListener('change', function () {
        state.settings[pair[1]] = element.value;
        saveSettings();
      });
    });
    window.addEventListener('online', function () {
      renderAll();
      syncAllPending();
    });
    window.addEventListener('offline', renderAll);
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/service-worker.js').catch(function () {});
  }

  function init() {
    cacheElements();
    attachEvents();
    registerServiceWorker();
    loadSettings()
      .then(getAllNotes)
      .then(function (notes) {
        state.notes = notes;
        return Promise.all([loadFolders(), loadServerStudyPacks()]);
      })
      .then(function () {
        renderAll();
        if (navigator.onLine) syncAllPending();
      })
      .catch(function (error) {
        showToast(error && error.message ? error.message : 'Could not load voice notes.', 'error');
      });

    auth.onAuthStateChanged(function (user) {
      state.user = user || null;
      setAuthUi();
      if (user) {
        Promise.all([loadFolders(), loadServerStudyPacks()]).then(renderAll);
      }
    });
    setAuthUi();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
