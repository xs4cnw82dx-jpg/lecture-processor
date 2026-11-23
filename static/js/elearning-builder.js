(function () {
  'use strict';

  var Model = window.XpedElearningModel;
  var Icons = window.XpedElearningIcons;
  var Blocks = window.XpedElearningBlocks;
  var RouteMap = window.XpedElearningRouteMap;
  var QR = window.XpedElearningQR;

  var bodyData = document.body.dataset;
  var expeditionId = bodyData.expeditionId || '';
  var grantToken = bodyData.grantToken || '';
  var initialMode = bodyData.initialMode || 'edit';
  var ux = window.LectureProcessorUx;
  var bootstrap = window.LectureProcessorBootstrap;
  var auth = grantToken ? null : bootstrap.getAuth();
  var authClient = grantToken ? null : window.LectureProcessorAuth.createAuthClient(auth);
  var accountSession = null;
  var activeUser = null;
  var loadedAccount = false;
  var leavingAccount = false;
  var privateMedia = new Map();
  var saveVersion = 0;
  var savedVersion = 0;
  var writing = Promise.resolve();

  var urlParams = new URLSearchParams(window.location.search);
  var deepModuleId = urlParams.get('module') || '';
  var deepStepId = urlParams.get('step') || '';
  var openedFromResponses = urlParams.get('from') === 'responses';
  var savedAltPref = false;
  try { savedAltPref = localStorage.getItem('xped_tr_show_alt') === '1'; } catch (_e) {}

  var state = {
    exp: null,
    role: '',
    mode: initialMode,
    pendingMode: '',
    editLang: 'nl',
    trSource: 'nl',
    trTarget: 'de',
    trFilter: 'all',
    trShowPreview: !window.matchMedia('(max-width: 720px)').matches,
    trShowAltLang: savedAltPref,
    trCollapsedGroups: {},
    trLastActiveKey: '',
    trPreviewTimer: null,
    trActiveContext: { type: 'startPage', moduleId: '', stepId: '', blockId: '' },
    trPendingTexts: {},
    trPendingMedia: {},
    trSaveTimer: null,
    selectedTarget: { type: 'startPage' },
    selectedBlockId: '',
    selectedPinId: '',
    insertBlockAt: -1,
    inspectorTab: 'block',
    openInspectorDetails: {},
    blockUploads: {},
    viewport: 'desktop',
    previewViewport: 'desktop',
    previewFrom: 'step',
    previewSamplePeers: false,
    collapsedModules: {},
    b1CoachOpen: false,
    sessionId: 'ses_' + Math.random().toString(36).slice(2, 12),
    leaseToken: '',
    grantAccessToken: '',
    grantTargetLang: '',
    undoStack: [],
    redoStack: [],
    saveTimer: null,
    leaseTimer: null,
    shareQueue: Promise.resolve(),
    shareTab: 'learners',
    shareData: null,
    previewLang: 'nl',
    previewPos: { view: 'start', modIdx: 0, stepIdx: 0, navDir: 'next', navHistory: [], answers: {}, completedIds: [] },
    dragPayload: null,
    focusStepTitleAfterRender: false,
    focusBlockAfterRender: '',
  };

  var titleInput = document.getElementById('el-exp-title');
  var saveStateEl = document.getElementById('el-save-state');
  var saveRetryBtn = document.getElementById('el-save-retry');
  var outlineLiveEl = document.getElementById('el-outline-live');
  var outlineModulesEl = document.getElementById('el-outline-modules');
  var canvasCardEl = document.getElementById('el-canvas-card');
  var canvasFrameEl = document.getElementById('el-canvas-frame');
  var canvasCrumbEl = document.getElementById('el-canvas-crumb');
  var stageFooterEl = document.getElementById('el-stage-footer');
  var readabilityBarEl = document.getElementById('el-readability-bar');
  var authorNotesEl = document.getElementById('el-author-notes');
  var inspectorBodyEl = document.getElementById('el-inspector-body');
  var translateRowsEl = document.getElementById('el-translate-rows');
  var translateProgressEl = document.getElementById('el-tr-progress');
  var translatePreviewStage = document.getElementById('el-tr-preview-stage');
  var translatePreviewPane = document.getElementById('el-tr-preview-pane');
  var translateSplit = document.getElementById('el-translate-split');
  var translateAutosaveEl = document.getElementById('el-tr-autosave');
  var previewContainerEl = document.getElementById('el-preview-container');
  var leaseBanner = document.getElementById('el-lease-banner');
  var leaseMsg = document.getElementById('el-lease-message');
  var toastEl = document.getElementById('el-toast');

  var blockPickerDialog = document.getElementById('el-block-picker-dialog');
  var moduleRecipeDialog = document.getElementById('el-module-recipe-dialog');
  var shareDialog = document.getElementById('el-share-dialog');

  // Hydrate crisp SVG chrome icons
  document.getElementById('el-back-link').appendChild(Icons.icon('arrowLeft', 18));
  document.getElementById('el-undo-btn').appendChild(Icons.icon('undo', 17));
  document.getElementById('el-redo-btn').appendChild(Icons.icon('redo', 17));
  document.getElementById('el-nav-start-icon').appendChild(Icons.icon('compass', 16));
  document.getElementById('el-notes-icon').appendChild(Icons.icon('note', 15));
  var vpDesk = document.getElementById('el-vp-desktop');
  var vpMob = document.getElementById('el-vp-mobile');
  vpDesk.textContent = '';
  vpDesk.appendChild(Icons.icon('monitor', 14));
  vpDesk.appendChild(document.createTextNode(' Desktop'));
  vpMob.textContent = '';
  vpMob.appendChild(Icons.icon('phone', 14));
  vpMob.appendChild(document.createTextNode(' Mobile'));
  var shareBtn = document.getElementById('el-share-btn');
  shareBtn.textContent = '';
  shareBtn.appendChild(Icons.icon('share', 15));
  shareBtn.appendChild(document.createTextNode(' Share'));
  var trArrowHost = document.getElementById('el-tr-arrow-host');
  if (trArrowHost) trArrowHost.appendChild(Icons.icon('arrowRight', 15));
  var nextMissInit = document.getElementById('el-tr-next-missing');
  if (nextMissInit) {
    nextMissInit.textContent = '';
    nextMissInit.appendChild(document.createTextNode('Next missing '));
    nextMissInit.appendChild(Icons.icon('arrowRight', 14));
  }

  var memberRoleValue = 'edit';
  var memberRoleDD = Icons.createDropdown({
    ariaLabel: 'Collaborator role',
    items: [
      { value: 'edit', label: 'Co-Editor' },
      { value: 'translate', label: 'Translator' },
    ],
    value: memberRoleValue,
    onChange: function (val) {
      memberRoleValue = val;
      memberRoleDD.setItems([
        { value: 'edit', label: 'Co-Editor' },
        { value: 'translate', label: 'Translator' },
      ], val);
    },
  });
  var memberRoleHost = document.getElementById('el-member-role-host');
  if (memberRoleHost) memberRoleHost.appendChild(memberRoleDD.el);

  var grantLangValue = 'de';
  var GRANT_LANG_ITEMS = [
    { value: 'de', label: 'DE · Deutsch' },
    { value: 'en', label: 'EN · English' },
    { value: 'nl', label: 'NL · Nederlands' },
  ];
  var grantLangDD = Icons.createDropdown({
    ariaLabel: 'Target translation language',
    items: GRANT_LANG_ITEMS,
    value: grantLangValue,
    onChange: function (val) {
      grantLangValue = val;
      grantLangDD.setItems(GRANT_LANG_ITEMS, val);
    },
  });
  var grantLangHost = document.getElementById('el-grant-lang-host');
  if (grantLangHost) grantLangHost.appendChild(grantLangDD.el);

  var LANG_OPTIONS = [
    { value: 'nl', label: 'Nederlands (NL)', shortLabel: 'NL' },
    { value: 'en', label: 'English (EN)', shortLabel: 'EN' },
    { value: 'de', label: 'Deutsch (DE)', shortLabel: 'DE' },
  ];

  var editLangDD = Icons.createDropdown({
    leadingIcon: 'globe',
    ariaLabel: 'Active editing language',
    items: LANG_OPTIONS,
    value: state.editLang,
    onChange: async function (val) {
      if (saveVersion !== savedVersion) {
        editLangDD.setItems(LANG_OPTIONS, state.editLang);
        clearTimeout(state.saveTimer);
        await queueStructureSave();
        if (saveVersion !== savedVersion) return;
      }
      state.editLang = val;
      editLangDD.setItems(LANG_OPTIONS, val);
      renderAll();
    },
  });
  document.getElementById('el-edit-lang-host').appendChild(editLangDD.el);

  var moreMenuDD = Icons.createDropdown({
    leadingIcon: 'more',
    fixedLabel: '',
    showChevron: false,
    align: 'right',
    triggerClass: 'el-icon-btn',
    ariaLabel: 'More expedition actions',
    items: [],
  });
  document.getElementById('el-more-menu-host').appendChild(moreMenuDD.el);

  var trSourceDD = Icons.createDropdown({
    ariaLabel: 'Source language',
    items: LANG_OPTIONS,
    value: state.trSource,
    onChange: function (val) {
      state.trSource = val;
      trSourceDD.setItems(LANG_OPTIONS, val);
      renderTranslateMode();
    },
  });
  document.getElementById('el-tr-source-host').appendChild(trSourceDD.el);

  var trTargetDD = Icons.createDropdown({
    ariaLabel: 'Target language',
    items: LANG_OPTIONS,
    value: state.trTarget,
    onChange: async function (val) {
      if (state.grantTargetLang || val === state.trTarget) return;
      trTargetDD.setItems(LANG_OPTIONS, state.trTarget);
      if (hasPendingTranslations() && !(await saveTranslationsNow())) return;
      if (hasPendingTranslations()) return;
      state.trTarget = val;
      trTargetDD.setItems(LANG_OPTIONS, val);
      renderTranslateMode();
    },
  });
  document.getElementById('el-tr-target-host').appendChild(trTargetDD.el);

  var FILTER_OPTIONS = [
    { value: 'all', label: 'All fields' },
    { value: 'untranslated', label: 'Untranslated' },
    { value: 'needs_review', label: 'Needs review' },
    { value: 'translated', label: 'Translated' },
  ];
  var trFilterDD = Icons.createDropdown({
    ariaLabel: 'Filter translation rows',
    items: FILTER_OPTIONS,
    value: state.trFilter,
    onChange: function (val) {
      state.trFilter = val;
      trFilterDD.setItems(FILTER_OPTIONS, val);
      renderTranslateMode();
    },
  });
  document.getElementById('el-tr-filter-host').appendChild(trFilterDD.el);

  var previewLangDD = Icons.createDropdown({
    leadingIcon: 'globe',
    ariaLabel: 'Preview language',
    items: LANG_OPTIONS,
    value: state.previewLang,
    onChange: function (val) {
      state.previewLang = val;
      previewLangDD.setItems(LANG_OPTIONS, val);
      renderPreviewMode();
    },
  });
  document.getElementById('el-preview-lang-host').appendChild(previewLangDD.el);

  function showToast(msg, undoCb) {
    ux.toast(msg, {
      element: toastEl,
      type: undoCb === 'error' ? 'error' : 'info',
      show: function () { toastEl.hidden = false; },
      hide: function () { toastEl.hidden = true; },
    });
    if (typeof undoCb !== 'function') return;
    var ubtn = document.createElement('button');
    ubtn.type = 'button';
    ubtn.className = 'el-btn el-btn-sm';
    ubtn.textContent = 'Undo';
    ubtn.addEventListener('click', function () {
      toastEl.hidden = true;
      undoCb();
    });
    toastEl.appendChild(ubtn);
  }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }
  function canEditStructure() { return state.role === 'owner' || state.role === 'edit'; }

  function request(url, options) {
    var opts = Object.assign({}, options);
    opts.headers = Object.assign({ 'X-Elearning-Session': state.sessionId }, opts.headers);
    if (typeof opts.body === 'string') opts.headers['Content-Type'] = 'application/json';
    if (grantToken) {
      if (state.grantAccessToken) opts.headers['X-Elearning-Access'] = state.grantAccessToken;
      return fetch(url, opts);
    }
    if (!accountSession || leavingAccount) throw new Error('Sign in required');
    accountSession.assertCurrent();
    return authClient.authFetch(url, opts);
  }

  async function api(url, opts) {
    var resp = await request(url, opts);
    var data = await resp.json();
    if (!resp.ok) {
      var err = new Error(data.error || ('Request failed (' + resp.status + ')'));
      err.status = resp.status;
      throw err;
    }
    return data;
  }

  function assetUrl(assetId) {
    return '/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/assets/' + encodeURIComponent(assetId);
  }

  function setMediaSource(element, url) {
    if (!url.startsWith('/api/elearning/')) {
      element.src = url;
      return;
    }
    if (!privateMedia.has(url)) {
      var resource = request(url).then(function (response) {
        if (!response.ok) throw new Error('Could not load media.');
        return response.blob();
      }).then(function (blob) {
        if (leavingAccount) throw new Error('Sign in required');
        return URL.createObjectURL(blob);
      });
      privateMedia.set(url, resource);
    }
    privateMedia.get(url).then(function (objectUrl) {
      if (!leavingAccount) element.src = objectUrl;
    }).catch(function (error) {
      if (privateMedia.delete(url) && !leavingAccount) showToast(error.message, 'error');
    });
  }

  function resetMedia() {
    privateMedia.forEach(function (resource) {
      resource.then(function (url) { URL.revokeObjectURL(url); }).catch(function () {});
    });
    privateMedia.clear();
  }

  function currentModuleAndStep() {
    if (!state.exp || state.selectedTarget.type !== 'step') return { mod: null, step: null };
    var mod = (state.exp.modules || []).find(function (m) { return m.id === state.selectedTarget.moduleId; }) || null;
    if (!mod) return { mod: null, step: null };
    var step = (mod.steps || []).find(function (s) { return s.id === state.selectedTarget.stepId; }) || null;
    return { mod: mod, step: step };
  }

  function currentBlock() {
    var pair = currentModuleAndStep();
    if (!pair.step || !state.selectedBlockId) return null;
    return (pair.step.blocks || []).find(function (b) { return b.id === state.selectedBlockId; }) || null;
  }

  function pushUndo(label) {
    if (!state.exp) return;
    state.undoStack.push({ label: label || 'edit', snapshot: clone(state.exp) });
    if (state.undoStack.length > 40) state.undoStack.shift();
    state.redoStack = [];
    updateUndoButtons();
  }

  function restoreSnapshot(entry) {
    var snapshot = entry && entry.snapshot ? entry.snapshot : entry;
    if (!snapshot) return;
    snapshot.revision = state.exp.revision;
    state.exp = snapshot;
    updateUndoButtons();
    renderAll();
    scheduleSave();
  }

  function rebaseUndoStacksWithTranslations(latestExp, langCode) {
    var latestRows = Model.extractTranslationRows(latestExp, state.trSource, langCode);
    var latestMap = new Map(latestRows.map(function (r) { return [r.key, r.locObj[langCode]]; }));
    function patchStack(stack) {
      stack.forEach(function (entry) {
        var snap = entry && entry.snapshot;
        if (!snap) return;
        Model.extractTranslationRows(snap, state.trSource, langCode).forEach(function (row) {
          if (latestMap.has(row.key)) {
            row.locObj[langCode] = latestMap.get(row.key);
          }
        });
      });
    }
    patchStack(state.undoStack);
    patchStack(state.redoStack);
  }

  function updateUndoButtons() {
    var undoBtn = document.getElementById('el-undo-btn');
    var redoBtn = document.getElementById('el-redo-btn');
    undoBtn.disabled = !state.undoStack.length;
    redoBtn.disabled = !state.redoStack.length;
    var uLast = state.undoStack.length ? state.undoStack[state.undoStack.length - 1] : null;
    var rLast = state.redoStack.length ? state.redoStack[state.redoStack.length - 1] : null;
    undoBtn.title = uLast ? ('Undo: ' + uLast.label) : 'Undo';
    redoBtn.title = rLast ? ('Redo: ' + rLast.label) : 'Redo';
  }

  function setSaveStatus(text, isLive, showRetry) {
    saveStateEl.textContent = '';
    if (isLive) saveStateEl.appendChild(Icons.icon('cloudCheck', 13));
    saveStateEl.appendChild(document.createTextNode(text));
    saveStateEl.className = 'el-save-chip' + (isLive ? ' is-live' : (showRetry ? ' is-warn' : ''));
    if (saveRetryBtn) {
      var pendingCount = Math.max(0, saveVersion - savedVersion);
      saveRetryBtn.hidden = !showRetry;
      saveRetryBtn.title = pendingCount > 0 ? (pendingCount + ' unsaved change(s)') : 'Retry saving';
    }
  }

  function scheduleSave() {
    saveVersion++;
    setSaveStatus('Saving…', false, false);
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(queueStructureSave, 700);
  }

  function queueStructureSave() {
    writing = writing.then(saveNow);
    return writing;
  }

  function syncReviewFlags(expedition) {
    // The server owns review decisions. Update only that metadata, even if the
    // author has typed more text since this particular write was submitted.
    var serverRows = Model.extractTranslationRows(expedition, state.trSource, state.trTarget);
    var flags = new Map(serverRows.map(function (row) { return [row.key, row.locObj._review]; }));
    Model.extractTranslationRows(state.exp, state.trSource, state.trTarget).forEach(function (row) {
      var review = flags.get(row.key);
      if (review) row.locObj._review = Object.assign({}, review);
      else delete row.locObj._review;
    });
  }

  async function saveNow() {
    if (leavingAccount || savedVersion === saveVersion || !canEditStructure() || !state.exp) return;
    if (!state.leaseToken) {
      await acquireLease(false);
      if (!state.leaseToken) { setSaveStatus('Save paused', false, true); return; }
    }
    var version = saveVersion;
    try {
      var body = Object.assign({}, state.exp, {
        lease_token: state.leaseToken,
        base_revision: state.exp.revision || 1,
        editedLanguage: state.editLang,
      });
      var res = await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId), {
        method: 'PUT', body: JSON.stringify(body),
      });
      state.exp.revision = res.expedition.revision;
      syncReviewFlags(res.expedition);
      savedVersion = version;
      if (version === saveVersion) setSaveStatus('Saved', true, false);
    } catch (err) {
      setSaveStatus('Save paused', false, true);
      showToast(err.message, 'error');
    }
  }

  async function acquireLease(takeover) {
    if (!canEditStructure() || !expeditionId) return;
    try {
      var res = await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/lease', {
        method: 'POST',
        body: JSON.stringify({ action: 'acquire', takeover: !!takeover }),
      });
      if (res.granted) {
        state.leaseToken = res.lease_token;
        titleInput.disabled = false;
        workspace.inert = false;
        leaseBanner.hidden = true;
        if (savedVersion === saveVersion) setSaveStatus('Saved', true, false);
        clearInterval(state.leaseTimer);
        state.leaseTimer = setInterval(function () { acquireLease(false); }, 40000);
      } else {
        state.leaseToken = '';
        titleInput.disabled = true;
        workspace.inert = true;
        var edName = (res.editor && res.editor.name) || 'A collaborator';
        var agoSec = (res.editor && res.editor.updated_at) ? Math.max(1, Math.round(Date.now() / 1000 - res.editor.updated_at)) : 0;
        var agoTxt = agoSec ? (' (active ' + (agoSec < 60 ? (agoSec + 's') : (Math.round(agoSec / 60) + 'm')) + ' ago)') : '';
        if (res.same_account) {
          leaseMsg.textContent = 'You already have this expedition open in another browser tab or window' + agoTxt + '. Take over editing here to continue.';
        } else {
          leaseMsg.textContent = edName + ' is currently editing this expedition' + agoTxt + '. You can safely preview or take over.';
        }
        leaseBanner.hidden = false;
        saveStateEl.textContent = res.same_account ? 'Open in another tab' : (edName + ' editing');
        saveStateEl.className = 'el-save-chip is-warn';
      }
    } catch (err) {
      if (!state.leaseToken) {
        leaseMsg.textContent = err.message;
        leaseBanner.hidden = false;
        setSaveStatus('Save paused', false, true);
      }
    }
  }

  function mutate(fn, opts) {
    if (!canEditStructure() || !state.leaseToken || !state.exp || leavingAccount) return;
    if (!opts || opts.recordUndo !== false) pushUndo(opts && opts.label);
    fn();
    if (opts && opts.recordUndo === false && inspectorBodyEl.contains(document.activeElement)) {
      renderCanvas();
      renderOutline();
    } else if (!opts || opts.rerender !== false) renderAll();
    else updateReadabilityCue();
    scheduleSave();
  }

  var uploadsInProgress = 0;
  async function uploadFileForBlock(blk, file) {
    var upKey = blk === 'startPage' ? 'startPage' : (blk && blk.id ? blk.id : 'media');
    uploadsInProgress++;
    state.blockUploads[upKey] = { status: 'uploading', fileName: file.name || 'media file', error: '', file: file };
    renderInspector();
    var fd = new FormData();
    fd.append('file', file);
    try {
      var res = await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/assets', { method: 'POST', body: fd });
      delete state.blockUploads[upKey];
      mutate(function () {
        if (blk === 'startPage') {
          state.exp.startPage.heroMedia = { kind: 'asset', assetId: res.asset.id, staticPath: '' };
        } else {
          blk.data.media = { kind: 'asset', assetId: res.asset.id, staticPath: '' };
        }
      }, { label: 'upload media' });
      showToast('Uploaded ' + (file.name || 'media'));
    } catch (err) {
      state.blockUploads[upKey] = { status: 'error', fileName: file.name || 'media file', error: err.message || 'Upload failed', file: file };
      renderInspector();
      showToast(err.message, 'error');
    } finally {
      uploadsInProgress--;
    }
  }

  function setMode(nextMode) {
    if (!canEditStructure() && nextMode === 'edit') nextMode = 'translate';
    state.mode = nextMode;
    document.querySelectorAll('.el-mode-tab').forEach(function (tab) {
      var active = tab.getAttribute('data-mode') === nextMode;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    var editSec = document.getElementById('el-mode-edit');
    var trSec = document.getElementById('el-mode-translate');
    var pvSec = document.getElementById('el-mode-preview');
    editSec.hidden = nextMode !== 'edit';
    trSec.hidden = nextMode !== 'translate';
    pvSec.hidden = nextMode !== 'preview';
    var activeSec = nextMode === 'edit' ? editSec : (nextMode === 'translate' ? trSec : pvSec);
    activeSec.classList.remove('el-mode-entering');
    void activeSec.offsetWidth;
    activeSec.classList.add('el-mode-entering');

    document.getElementById('el-edit-lang-host').hidden = nextMode !== 'edit';
    var topSep = document.querySelector('.el-topbar-sep');
    if (topSep) topSep.hidden = nextMode !== 'edit';
    // UX-090: Hide topbar save chip in Translate mode so only one live save status is shown
    saveStateEl.hidden = nextMode === 'translate';
    if (saveRetryBtn && nextMode === 'translate') saveRetryBtn.hidden = true;
    // UX-069: Sync preview start position when entering Preview mode
    if (nextMode === 'preview') {
      syncPreviewStartPosition();
    }
    renderAll();
  }

  function syncPreviewStartPosition() {
    if (!state.exp) return;
    var visibleMods = (state.exp.modules || []).filter(function (m) { return m.visibleToLearners !== false; });
    if (state.previewFrom === 'step' && state.selectedTarget.type === 'step') {
      var mIdx = visibleMods.findIndex(function (m) { return m.id === state.selectedTarget.moduleId; });
      if (mIdx >= 0) {
        var sIdx = (visibleMods[mIdx].steps || []).findIndex(function (s) { return s.id === state.selectedTarget.stepId; });
        if (sIdx >= 0) {
          state.previewPos = { view: 'step', modIdx: mIdx, stepIdx: sIdx, navDir: 'next', navHistory: [], answers: {}, completedIds: [] };
          return;
        }
      }
    }
    state.previewPos = { view: 'start', modIdx: 0, stepIdx: 0, navDir: 'next', navHistory: [], answers: {}, completedIds: [] };
  }

  function showConfirmDialog(title, message, okLabel) {
    return new Promise(function (resolve) {
      var dlg = document.getElementById('el-confirm-dialog');
      if (!dlg) { resolve(window.confirm(message)); return; }
      document.getElementById('el-confirm-title').textContent = title;
      document.getElementById('el-confirm-message').textContent = message;
      var okBtn = document.getElementById('el-confirm-ok');
      var cancelBtn = document.getElementById('el-confirm-cancel');
      okBtn.textContent = okLabel || 'Confirm';
      var settled = false;
      function done(result) {
        if (settled) return;
        settled = true;
        okBtn.removeEventListener('click', onOk);
        cancelBtn.removeEventListener('click', onCancel);
        dlg.removeEventListener('close', onClose);
        if (dlg.open) dlg.close();
        resolve(result);
      }
      function onOk() { done(true); }
      function onCancel() { done(false); }
      function onClose() { done(false); }
      okBtn.addEventListener('click', onOk);
      cancelBtn.addEventListener('click', onCancel);
      dlg.addEventListener('close', onClose);
      dlg.showModal();
    });
  }

  function announceOutline(msg) {
    if (!outlineLiveEl) return;
    outlineLiveEl.textContent = '';
    requestAnimationFrame(function () { outlineLiveEl.textContent = msg; });
  }

  function restoreOutlineFocus(selector) {
    if (!selector) return;
    var node = outlineModulesEl.querySelector(selector);
    if (node && !node.disabled) {
      node.focus();
      return;
    }
    var fallback = selector.indexOf('[data-dir="up"]') >= 0
      ? outlineModulesEl.querySelector(selector.replace('[data-dir="up"]', '[data-dir="down"]'))
      : outlineModulesEl.querySelector(selector.replace('[data-dir="down"]', '[data-dir="up"]'));
    if (fallback && !fallback.disabled) fallback.focus();
  }

  function clearDragClasses(rootEl) {
    rootEl.querySelectorAll('.is-dragover, .is-dragover-before, .is-dragover-after').forEach(function (elNode) {
      elNode.classList.remove('is-dragover', 'is-dragover-before', 'is-dragover-after');
    });
  }

  /* ---- Left Rail with Real Drag-and-Drop ---- */
  function renderOutline(focusSelector) {
    var startBtn = document.getElementById('el-nav-start-page');
    startBtn.classList.toggle('is-active', state.selectedTarget.type === 'startPage');
    outlineModulesEl.textContent = '';

    (state.exp.modules || []).forEach(function (mod, mIdx) {
      var isCollapsed = !!state.collapsedModules[mod.id];
      var modTitle = Model.getLocalized(mod.title, state.editLang, state.exp.defaultLanguage) || ('Station ' + (mIdx + 1));
      var stepTotal = (mod.steps || []).length;
      var group = document.createElement('div');
      group.className = 'el-module-group' + (mod.visibleToLearners === false ? ' is-hidden-learner' : '') + (isCollapsed ? ' is-collapsed' : '');
      group.setAttribute('data-mod-id', mod.id);
      if (canEditStructure()) {
        group.draggable = true;
        group.addEventListener('dragstart', function (e) {
          if (e.target.closest('.el-step-row')) return;
          state.dragPayload = { kind: 'module', index: mIdx };
          e.dataTransfer.effectAllowed = 'move';
        });
        group.addEventListener('dragover', function (e) {
          if (!state.dragPayload || state.dragPayload.kind !== 'module') return;
          e.preventDefault();
          var rect = group.getBoundingClientRect();
          var after = (e.clientY - rect.top) > rect.height / 2;
          group.classList.toggle('is-dragover-before', !after);
          group.classList.toggle('is-dragover-after', after);
          state.dragPayload.insertAfter = after;
        });
        group.addEventListener('dragleave', function () {
          group.classList.remove('is-dragover-before', 'is-dragover-after');
        });
        group.addEventListener('drop', function (e) {
          var after = !!(state.dragPayload && state.dragPayload.insertAfter);
          clearDragClasses(outlineModulesEl);
          if (!state.dragPayload || state.dragPayload.kind !== 'module') return;
          e.preventDefault();
          var from = state.dragPayload.index;
          state.dragPayload = null;
          var targetIdx = after ? mIdx + 1 : mIdx;
          if (from < targetIdx) targetIdx -= 1;
          if (from === targetIdx) return;
          mutate(function () {
            var moved = state.exp.modules.splice(from, 1)[0];
            state.exp.modules.splice(targetIdx, 0, moved);
          }, { label: 'reorder station' });
          announceOutline('Moved ' + modTitle + ' to station ' + (targetIdx + 1) + ' of ' + state.exp.modules.length);
        });
      }

      var head = document.createElement('div');
      head.className = 'el-module-head';
      if (canEditStructure()) {
        var grip = document.createElement('span');
        grip.className = 'el-drag-grip';
        grip.setAttribute('aria-hidden', 'true');
        grip.appendChild(Icons.icon('grip', 14));
        head.appendChild(grip);
      }

      var toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'el-module-toggle';
      toggleBtn.setAttribute('data-toggle-mod', mod.id);
      toggleBtn.title = isCollapsed ? 'Expand station' : 'Collapse station';
      toggleBtn.setAttribute('aria-label', (isCollapsed ? 'Expand ' : 'Collapse ') + modTitle + ' (' + stepTotal + (stepTotal === 1 ? ' step' : ' steps') + ')');
      toggleBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      toggleBtn.appendChild(Icons.icon('chevronDown', 14));
      toggleBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        state.collapsedModules[mod.id] = !state.collapsedModules[mod.id];
        renderOutline('[data-toggle-mod="' + CSS.escape(mod.id) + '"]');
      });
      head.appendChild(toggleBtn);

      var headBtn = document.createElement('button');
      headBtn.type = 'button';
      headBtn.className = 'el-module-title-btn';
      var dot = document.createElement('span');
      dot.className = 'xped-domain-dot domain-' + (mod.domain || 'general');
      var label = document.createElement('span');
      label.setAttribute('translate', 'no');
      label.textContent = modTitle;
      headBtn.appendChild(dot);
      headBtn.appendChild(label);
      headBtn.addEventListener('click', function () {
        state.collapsedModules[mod.id] = false;
        if (mod.steps && mod.steps[0]) {
          state.selectedTarget = { type: 'step', moduleId: mod.id, stepId: mod.steps[0].id };
          state.selectedBlockId = '';
          state.inspectorTab = 'step';
          renderAll();
        }
      });
      head.appendChild(headBtn);
      if (isCollapsed && stepTotal) {
        var cntBadge = document.createElement('span');
        cntBadge.className = 'el-module-count';
        cntBadge.setAttribute('aria-hidden', 'true');
        cntBadge.textContent = stepTotal + (stepTotal === 1 ? ' step' : ' steps');
        head.appendChild(cntBadge);
      }
      if (canEditStructure() && (state.exp.modules || []).length > 1) {
        var modMove = document.createElement('div');
        modMove.className = 'el-rail-move';
        var mUp = document.createElement('button');
        mUp.type = 'button';
        mUp.className = 'el-rail-move-btn';
        mUp.setAttribute('data-move-mod', mod.id);
        mUp.setAttribute('data-dir', 'up');
        mUp.title = 'Move "' + modTitle + '" up';
        mUp.setAttribute('aria-label', 'Move station ' + modTitle + ' up');
        mUp.disabled = mIdx === 0;
        mUp.appendChild(Icons.icon('chevronUp', 12));
        mUp.addEventListener('click', function (e) {
          e.stopPropagation();
          mutate(function () {
            var arr = state.exp.modules;
            var t = arr[mIdx - 1];
            arr[mIdx - 1] = arr[mIdx];
            arr[mIdx] = t;
          }, { label: 'move station up' });
          restoreOutlineFocus('[data-move-mod="' + CSS.escape(mod.id) + '"][data-dir="up"]');
          announceOutline('Moved ' + modTitle + ' to station ' + mIdx + ' of ' + state.exp.modules.length);
        });
        var mDn = document.createElement('button');
        mDn.type = 'button';
        mDn.className = 'el-rail-move-btn';
        mDn.setAttribute('data-move-mod', mod.id);
        mDn.setAttribute('data-dir', 'down');
        mDn.title = 'Move "' + modTitle + '" down';
        mDn.setAttribute('aria-label', 'Move station ' + modTitle + ' down');
        mDn.disabled = mIdx === state.exp.modules.length - 1;
        mDn.appendChild(Icons.icon('chevronDown', 12));
        mDn.addEventListener('click', function (e) {
          e.stopPropagation();
          mutate(function () {
            var arr = state.exp.modules;
            var t = arr[mIdx + 1];
            arr[mIdx + 1] = arr[mIdx];
            arr[mIdx] = t;
          }, { label: 'move station down' });
          restoreOutlineFocus('[data-move-mod="' + CSS.escape(mod.id) + '"][data-dir="down"]');
          announceOutline('Moved ' + modTitle + ' to station ' + (mIdx + 2) + ' of ' + state.exp.modules.length);
        });
        modMove.appendChild(mUp);
        modMove.appendChild(mDn);
        head.appendChild(modMove);
      }
      group.appendChild(head);

      var stepList = document.createElement('div');
      stepList.className = 'el-step-list';
      (mod.steps || []).forEach(function (step, sIdx) {
        var active = state.selectedTarget.type === 'step' && state.selectedTarget.stepId === step.id;
        var rawStepTitle = Model.getLocalized(step.title, state.editLang, state.exp.defaultLanguage) || 'Untitled step';
        var cleanStepTitle = rawStepTitle.replace(/^\d+\.\s+/, '');
        var stepLine = document.createElement('div');
        stepLine.className = 'el-step-line' + (active ? ' is-active' : '');
        var sbtn = document.createElement('button');
        stepLine.appendChild(sbtn);
        if (active) sbtn.setAttribute('aria-current', 'step');
        sbtn.type = 'button';
        sbtn.className = 'el-step-row' + (active ? ' is-active' : '');
        if (canEditStructure()) {
          sbtn.draggable = true;
          sbtn.addEventListener('dragstart', function (e) {
            e.stopPropagation();
            state.dragPayload = { kind: 'step', fromModId: mod.id, fromIdx: sIdx };
          });
          sbtn.addEventListener('dragover', function (e) {
            if (!state.dragPayload || state.dragPayload.kind !== 'step') return;
            e.preventDefault();
            var rect = sbtn.getBoundingClientRect();
            var after = (e.clientY - rect.top) > rect.height / 2;
            sbtn.classList.toggle('is-dragover-before', !after);
            sbtn.classList.toggle('is-dragover-after', after);
            state.dragPayload.insertAfter = after;
          });
          sbtn.addEventListener('dragleave', function () {
            sbtn.classList.remove('is-dragover-before', 'is-dragover-after');
          });
          sbtn.addEventListener('drop', function (e) {
            var after = !!(state.dragPayload && state.dragPayload.insertAfter);
            clearDragClasses(outlineModulesEl);
            if (!state.dragPayload || state.dragPayload.kind !== 'step') return;
            e.preventDefault();
            e.stopPropagation();
            var dp = state.dragPayload;
            state.dragPayload = null;
            var srcMod = state.exp.modules.find(function (m) { return m.id === dp.fromModId; });
            if (!srcMod) return;
            if (srcMod.id !== mod.id && srcMod.steps.length <= 1) {
              var srcTitle = Model.getLocalized(srcMod.title, state.editLang, state.exp.defaultLanguage) || 'that station';
              showToast('Each station must keep at least one step. Add another step to "' + srcTitle + '" first.');
              return;
            }
            var targetIdx = after ? sIdx + 1 : sIdx;
            if (srcMod.id === mod.id && dp.fromIdx < targetIdx) targetIdx -= 1;
            if (srcMod.id === mod.id && dp.fromIdx === targetIdx) return;
            mutate(function () {
              var moved = srcMod.steps.splice(dp.fromIdx, 1)[0];
              mod.steps.splice(targetIdx, 0, moved);
              state.selectedTarget = { type: 'step', moduleId: mod.id, stepId: moved.id };
            }, { label: 'move step' });
            announceOutline('Moved step to position ' + (targetIdx + 1) + ' in ' + modTitle);
          });
        }

        if (canEditStructure()) {
          var sGrip = document.createElement('span');
          sGrip.className = 'el-step-grip';
          sGrip.setAttribute('aria-hidden', 'true');
          sGrip.title = 'Drag to reorder step';
          sGrip.appendChild(Icons.icon('grip', 12));
          sbtn.appendChild(sGrip);
        }

        var titleSpan = document.createElement('span');
        titleSpan.className = 'el-outline-item-text';
        titleSpan.setAttribute('translate', 'no');
        titleSpan.textContent = (sIdx + 1) + '. ' + cleanStepTitle;
        sbtn.appendChild(titleSpan);

        if (canEditStructure() && (mod.steps || []).length > 1) {
          var stepMove = document.createElement('span');
          stepMove.className = 'el-rail-move';
          var sUp = document.createElement('button');
          sUp.type = 'button';
          sUp.className = 'el-rail-move-btn';
          sUp.setAttribute('data-move-step', step.id);
          sUp.setAttribute('data-dir', 'up');
          sUp.title = 'Move "' + cleanStepTitle + '" up';
          sUp.setAttribute('aria-label', 'Move step ' + cleanStepTitle + ' up');
          sUp.disabled = sIdx === 0;
          sUp.appendChild(Icons.icon('chevronUp', 12));
          sUp.addEventListener('click', function (e) {
            e.stopPropagation();
            mutate(function () {
              var t = mod.steps[sIdx - 1];
              mod.steps[sIdx - 1] = mod.steps[sIdx];
              mod.steps[sIdx] = t;
            }, { label: 'move step up' });
            restoreOutlineFocus('[data-move-step="' + CSS.escape(step.id) + '"][data-dir="up"]');
            announceOutline('Moved ' + cleanStepTitle + ' to step ' + sIdx + ' of ' + mod.steps.length);
          });
          var sDn = document.createElement('button');
          sDn.type = 'button';
          sDn.className = 'el-rail-move-btn';
          sDn.setAttribute('data-move-step', step.id);
          sDn.setAttribute('data-dir', 'down');
          sDn.title = 'Move "' + cleanStepTitle + '" down';
          sDn.setAttribute('aria-label', 'Move step ' + cleanStepTitle + ' down');
          sDn.disabled = sIdx === mod.steps.length - 1;
          sDn.appendChild(Icons.icon('chevronDown', 12));
          sDn.addEventListener('click', function (e) {
            e.stopPropagation();
            mutate(function () {
              var t = mod.steps[sIdx + 1];
              mod.steps[sIdx + 1] = mod.steps[sIdx];
              mod.steps[sIdx] = t;
            }, { label: 'move step down' });
            restoreOutlineFocus('[data-move-step="' + CSS.escape(step.id) + '"][data-dir="down"]');
            announceOutline('Moved ' + cleanStepTitle + ' to step ' + (sIdx + 2) + ' of ' + mod.steps.length);
          });
          stepMove.appendChild(sUp);
          stepMove.appendChild(sDn);
          stepLine.appendChild(stepMove);
        }

        if (step.authorNotes && step.authorNotes.trim()) {
          var noteIco = Icons.icon('note', 13);
          noteIco.classList.add('el-note-icon');
          sbtn.appendChild(noteIco);
        }
        var derivedStatus = Model.deriveStepContentState(step);
        var stDot = document.createElement('span');
        stDot.className = 'el-status-dot status-' + derivedStatus;
        stDot.title = 'Status: ' + derivedStatus;
        sbtn.appendChild(stDot);

        sbtn.addEventListener('click', function () {
          state.selectedTarget = { type: 'step', moduleId: mod.id, stepId: step.id };
          state.selectedBlockId = (step.blocks && step.blocks[0]) ? step.blocks[0].id : '';
          renderAll();
        });
        stepList.appendChild(stepLine);
      });

      if (canEditStructure()) {
        var addStepBtn = document.createElement('button');
        addStepBtn.type = 'button';
        addStepBtn.className = 'el-quiet-add-step';
        addStepBtn.appendChild(Icons.icon('plus', 13));
        addStepBtn.appendChild(document.createTextNode('Add step'));
        addStepBtn.addEventListener('click', function () {
          state.focusStepTitleAfterRender = true;
          mutate(function () {
            var ns = Model.createStep('Stap ' + ((mod.steps || []).length + 1), 'Step ' + ((mod.steps || []).length + 1));
            mod.steps.push(ns);
            state.selectedTarget = { type: 'step', moduleId: mod.id, stepId: ns.id };
            state.selectedBlockId = '';
          }, { label: 'add step' });
        });
        stepList.appendChild(addStepBtn);
      }

      group.appendChild(stepList);
      outlineModulesEl.appendChild(group);
    });
    if (focusSelector) restoreOutlineFocus(focusSelector);
  }

  /* ---- Live Reading Time & Writing / Accessibility Checks (UX-109..111, S-02) ---- */
  function updateReadabilityCue() {
    var pair = currentModuleAndStep();
    if (!pair.step) return;
    var report = Model.analyzeStepReadability(pair.step, state.editLang, state.exp.defaultLanguage);
    var coachPanel = document.getElementById('el-b1-coach-panel');
    readabilityBarEl.textContent = '';

    var left = document.createElement('span');
    var readEst = report.seconds >= 60 ? (Math.round(report.seconds / 60) + ' min read') : (report.seconds + ' sec read');
    var optTxt = report.optionalWords ? (' (+' + report.optionalWords + ' optional in sources/transcripts)') : '';
    left.textContent = report.words + ' words · ~' + readEst + optTxt;
    readabilityBarEl.appendChild(left);

    var issueCount = (report.writingChecks || []).length + (report.accessibilityChecks || []).length;
    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'el-b1-toggle is-' + report.level;
    toggle.setAttribute('aria-expanded', String(!!state.b1CoachOpen));
    toggle.setAttribute('aria-controls', 'el-b1-coach-panel');
    toggle.appendChild(Icons.icon(report.level === 'good' ? 'checkCircle' : 'alertCircle', 13));
    toggle.appendChild(document.createTextNode(
      issueCount === 0
        ? 'Writing & Accessibility: Good'
        : ('Writing & Accessibility Checks (' + issueCount + ')')
    ));
    toggle.addEventListener('click', function () {
      state.b1CoachOpen = !state.b1CoachOpen;
      toggle.setAttribute('aria-expanded', String(state.b1CoachOpen));
      if (coachPanel) coachPanel.hidden = !state.b1CoachOpen;
    });
    readabilityBarEl.appendChild(toggle);

    if (coachPanel) {
      coachPanel.textContent = '';
      function appendCheckSection(heading, items) {
        if (!items.length) return;
        var gh = document.createElement('div');
        gh.className = 'el-b1-group-head';
        gh.textContent = heading;
        coachPanel.appendChild(gh);
        items.forEach(function (tip) {
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'el-b1-tip-btn el-b1-tip is-' + tip.kind;
          btn.appendChild(Icons.icon(tip.kind === 'ok' ? 'check' : (tip.kind === 'warn' ? 'alertCircle' : 'info'), 14));
          var sp = document.createElement('span');
          sp.textContent = tip.text;
          btn.appendChild(sp);
          btn.addEventListener('click', function () {
            if (tip.blockId) {
              state.selectedBlockId = tip.blockId;
              state.inspectorTab = 'block';
              renderCanvas();
              renderInspector();
              var blkNode = canvasCardEl.querySelector('[data-block-id="' + CSS.escape(tip.blockId) + '"]');
              if (blkNode) blkNode.scrollIntoView({ behavior: ux.prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
              if (tip.fieldKey === 'alt' || tip.fieldKey === 'transcript') {
                if (window.matchMedia('(max-width: 920px)').matches) selectPane('inspector');
                var targetField = inspectorBodyEl.querySelector('[data-field-key="' + CSS.escape(tip.fieldKey) + '"]');
                if (targetField) targetField.focus();
              } else if (blkNode) {
                var ed = blkNode.querySelector('textarea, [contenteditable]');
                if (ed) ed.focus();
              }
            } else {
              var stTitleNode = canvasCardEl.querySelector('.xped-step-title');
              if (stTitleNode) stTitleNode.focus();
            }
          });
          coachPanel.appendChild(btn);
        });
      }
      if (!issueCount) {
        var okRow = document.createElement('div');
        okRow.className = 'el-b1-tip is-ok';
        okRow.appendChild(Icons.icon('check', 14));
        var okSp = document.createElement('span');
        okSp.textContent = report.tips[0].text;
        okRow.appendChild(okSp);
        coachPanel.appendChild(okRow);
      } else {
        appendCheckSection('Writing clarity', report.writingChecks || []);
        appendCheckSection('Accessibility', report.accessibilityChecks || []);
      }
      coachPanel.hidden = !state.b1CoachOpen;
    }
  }

  /* ---- Center Live Stage (Direct-On-Canvas Editing!) ---- */
  function makeInsertSlot(insertIdx, labelText) {
    var slot = document.createElement('div');
    slot.className = 'el-insert-slot';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-label', labelText || 'Add block here');
    btn.appendChild(Icons.icon('plus', 12));
    btn.appendChild(document.createTextNode('Add block'));
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      state.insertBlockAt = insertIdx;
      openBlockPicker();
    });
    slot.appendChild(btn);
    return slot;
  }

  function handleBlockInlineEdit(blk, field, val) {
    var lang = state.editLang;
    if (field === 'addOption') {
      mutate(function () {
        blk.data.options.push({ id: Model.uid('opt'), label: Model.loc('Nieuwe optie', 'New option', ''), isCorrect: false, feedback: Model.loc('', '', '') });
      }, { label: 'add option' });
      return;
    }
    if (field === 'addPin') {
      var palette = Model.HOTSPOT_PIN_COLORS || [{ hex: '#0072CE' }];
      var nextColor = palette[(blk.data.pins || []).length % palette.length].hex;
      var newPinId = Model.uid('opt');
      mutate(function () {
        blk.data.pins.push({
          id: newPinId,
          label: Model.loc('Punt ' + (blk.data.pins.length + 1), 'Point ' + (blk.data.pins.length + 1), ''),
          detail: Model.loc('', '', ''),
          x: val.x,
          y: val.y,
          color: nextColor,
        });
        state.selectedPinId = newPinId;
      }, { label: 'add hotspot pin' });
      showToast('Hotspot pin placed — edit its title, color, and explanation in Settings.');
      return;
    }
    if (field === 'movePin' && val && val.id) {
      var targetPin = (blk.data.pins || []).find(function (p) { return p.id === val.id; });
      if (targetPin) {
        mutate(function () {
          targetPin.x = val.x;
          targetPin.y = val.y;
          state.selectedPinId = targetPin.id;
        }, { label: 'move hotspot pin' });
      }
      return;
    }
    if (field === 'selectPin') {
      state.selectedPinId = val || '';
      if (state.selectedBlockId === blk.id && state.inspectorTab === 'block') {
        renderInspector();
      }
      return;
    }
    if (field.indexOf('option:') === 0) {
      var oid = field.slice(7);
      var opt = (blk.data.options || []).find(function (o) { return o.id === oid; });
      if (opt) mutate(function () { opt.label = Model.setLocalized(opt.label, lang, val); }, { recordUndo: false, rerender: false });
      return;
    }
    if (field === 'speakerName') {
      mutate(function () { blk.data.speakerName = val; }, { recordUndo: false, rerender: false });
      return;
    }
    if (field === 'agentBrief') {
      mutate(function () { blk.data.agentBrief = val; }, { recordUndo: false, rerender: false });
      return;
    }
    if (field === 'videoUrl') {
      var parsedV = Model.parseVideoUrl(val);
      if (!parsedV.embedUrl) {
        showToast(parsedV.error || 'Paste a valid YouTube or Vimeo link.', 'error');
        return;
      }
      mutate(function () {
        blk.data.url = val;
        blk.data.provider = parsedV.provider || '';
        blk.data.videoId = parsedV.videoId || '';
        blk.data.embedUrl = parsedV.embedUrl || '';
        if (parsedV.startSeconds !== null && !blk.data.startSeconds) blk.data.startSeconds = parsedV.startSeconds;
      }, { label: 'embed video' });
      return;
    }
    mutate(function () {
      blk.data[field] = Model.setLocalized(blk.data[field], lang, val);
      var pair = currentModuleAndStep();
      if (pair.step && pair.step.status === 'empty' && String(val || '').trim()) {
        pair.step.status = 'draft';
      }
    }, { recordUndo: false, rerender: false });
  }

  function buildBlockToolbar(pair, blk, bIdx) {
    var bar = document.createElement('div');
    bar.className = 'el-block-toolbar';
    var handle = document.createElement('span');
    handle.className = 'el-block-drag-handle';
    handle.title = 'Drag to reorder block';
    handle.setAttribute('aria-hidden', 'true');
    handle.appendChild(Icons.icon('grip', 13));
    bar.appendChild(handle);
    [
      {
        ic: 'chevronUp',
        title: 'Move block up',
        dis: bIdx === 0,
        fn: function () {
          var liveIdx = (pair.step.blocks || []).findIndex(function (b) { return b.id === state.selectedBlockId; });
          if (liveIdx <= 0) return;
          mutate(function () {
            var a = pair.step.blocks;
            var t = a[liveIdx - 1];
            a[liveIdx - 1] = a[liveIdx];
            a[liveIdx] = t;
          }, { label: 'move block up' });
        },
      },
      {
        ic: 'chevronDown',
        title: 'Move block down',
        dis: bIdx === pair.step.blocks.length - 1,
        fn: function () {
          var liveIdx = (pair.step.blocks || []).findIndex(function (b) { return b.id === state.selectedBlockId; });
          if (liveIdx < 0 || liveIdx >= pair.step.blocks.length - 1) return;
          mutate(function () {
            var a = pair.step.blocks;
            var t = a[liveIdx + 1];
            a[liveIdx + 1] = a[liveIdx];
            a[liveIdx] = t;
          }, { label: 'move block down' });
        },
      },
      {
        ic: 'copy',
        title: 'Duplicate block',
        fn: function () {
          var liveIdx = (pair.step.blocks || []).findIndex(function (b) { return b.id === state.selectedBlockId; });
          if (liveIdx < 0) return;
          mutate(function () {
            var cp = clone(pair.step.blocks[liveIdx]);
            cp.id = Model.uid('blk');
            pair.step.blocks.splice(liveIdx + 1, 0, cp);
            state.selectedBlockId = cp.id;
            state.focusBlockAfterRender = cp.id;
          }, { label: 'duplicate block' });
        },
      },
      {
        ic: 'trash',
        title: 'Delete block',
        fn: function () {
          var liveIdx = (pair.step.blocks || []).findIndex(function (b) { return b.id === state.selectedBlockId; });
          if (liveIdx < 0) return;
          var removed = clone(pair.step.blocks[liveIdx]);
          var targetModId = pair.mod.id;
          var targetStepId = pair.step.id;
          mutate(function () {
            pair.step.blocks.splice(liveIdx, 1);
            state.selectedBlockId = '';
          }, { label: 'delete block' });
          // UX-020: Scoped undo re-inserts only the deleted block without clobbering later edits
          showToast('Block deleted.', function () {
            var m = (state.exp.modules || []).find(function (x) { return x.id === targetModId; });
            var s = m && (m.steps || []).find(function (x) { return x.id === targetStepId; });
            if (!s) return;
            mutate(function () {
              var ins = Math.min(liveIdx, s.blocks.length);
              s.blocks.splice(ins, 0, removed);
              state.selectedTarget = { type: 'step', moduleId: targetModId, stepId: targetStepId };
              state.selectedBlockId = removed.id;
            }, { label: 'restore block' });
          });
        },
      },
    ].forEach(function (a) {
      var b = document.createElement('button');
      b.type = 'button';
      b.title = a.title;
      b.setAttribute('aria-label', a.title);
      b.disabled = !!a.dis;
      b.appendChild(Icons.icon(a.ic, 14));
      b.addEventListener('click', function (ev) { ev.stopPropagation(); a.fn(); });
      bar.appendChild(b);
    });
    return bar;
  }

  function syncBlockSelectionInDom(pair, nextBlockId) {
    if (state.selectedBlockId === nextBlockId) return;
    state.selectedBlockId = nextBlockId;
    state.inspectorTab = 'block';
    canvasCardEl.querySelectorAll('.el-canvas-block-wrap').forEach(function (node) {
      var isSel = node.dataset.wrapBlockId === nextBlockId;
      node.classList.toggle('is-selected', isSel);
      var oldBar = node.querySelector('.el-block-toolbar');
      if (oldBar) oldBar.remove();
      if (isSel && canEditStructure()) {
        var idx = (pair.step.blocks || []).findIndex(function (b) { return b.id === nextBlockId; });
        if (idx >= 0) {
          node.insertBefore(buildBlockToolbar(pair, pair.step.blocks[idx], idx), node.firstChild);
        }
      }
    });
    renderInspector();
  }

  function renderCanvas() {
    var lang = state.editLang;
    var defLang = state.exp.defaultLanguage || 'nl';
    canvasCardEl.lang = lang;
    canvasFrameEl.setAttribute('data-xped-theme', (state.exp.theme && state.exp.theme.preset) || 'xped-warm-sand');
    canvasFrameEl.classList.toggle('is-mobile', state.viewport === 'mobile');

    if (state.selectedTarget.type === 'startPage') {
      canvasCrumbEl.textContent = 'Start Page · ' + lang.toUpperCase();
      stageFooterEl.hidden = true;
      RouteMap.renderStartPage(canvasCardEl, {
        exp: state.exp,
        lang: lang,
        editable: canEditStructure(),
        assetUrl: assetUrl, setMediaSource: setMediaSource,
        onEditField: function (key, val) {
          var sp = state.exp.startPage;
          if (key.indexOf('highlight:') === 0) {
            var hid = key.slice(10);
            var hl = (sp.highlights || []).find(function (h) { return h.id === hid; });
            if (hl) mutate(function () { hl.text = Model.setLocalized(hl.text, lang, val); }, { recordUndo: false, rerender: false });
          } else {
            mutate(function () { sp[key] = Model.setLocalized(sp[key], lang, val); }, { recordUndo: false, rerender: false });
          }
        },
        onDeleteHighlight: function (hid) {
          mutate(function () {
            state.exp.startPage.highlights = (state.exp.startPage.highlights || []).filter(function (h) { return h.id !== hid; });
          }, { label: 'remove highlight' });
        },
        onMoveHighlight: function (idx, dir) {
          mutate(function () {
            var arr = state.exp.startPage.highlights || [];
            var target = idx + dir;
            if (target < 0 || target >= arr.length) return;
            var moved = arr.splice(idx, 1)[0];
            arr.splice(target, 0, moved);
          }, { label: 'reorder highlight' });
        },
        onSelectModule: function (mod) {
          if (mod.steps && mod.steps[0]) {
            state.selectedTarget = { type: 'step', moduleId: mod.id, stepId: mod.steps[0].id };
            state.selectedBlockId = '';
            renderAll();
          }
        },
      });
      return;
    }

    var pair = currentModuleAndStep();
    if (!pair.mod || !pair.step) {
      state.selectedTarget = { type: 'startPage' };
      renderCanvas();
      return;
    }

    var modIndex = (state.exp.modules || []).indexOf(pair.mod);
    var stepIndex = (pair.mod.steps || []).indexOf(pair.step);
    // UX-029: Crisp non-redundant outer breadcrumb ("Station N · Step M of K · LANG")
    canvasCrumbEl.textContent = 'Station ' + (modIndex + 1) + ' · Step ' + (stepIndex + 1) + ' of ' + (pair.mod.steps || []).length + ' · ' + lang.toUpperCase();
    stageFooterEl.hidden = false;
    authorNotesEl.value = pair.step.authorNotes || '';

    canvasCardEl.textContent = '';
    var card = document.createElement('div');
    card.className = 'xped-card domain-accent-' + (pair.mod.domain || 'general');

    var kicker = document.createElement('div');
    kicker.className = 'xped-step-kicker-row';
    var crumb = document.createElement('span');
    crumb.className = 'xped-step-crumb';
    var ddot = document.createElement('span');
    ddot.className = 'xped-domain-dot domain-' + (pair.mod.domain || 'general');
    crumb.appendChild(ddot);
    crumb.appendChild(document.createTextNode(Model.getLocalized(pair.mod.title, lang, defLang) || ('Station ' + (modIndex + 1))));
    kicker.appendChild(crumb);
    card.appendChild(kicker);

    // Direct-editable Step Title
    var stepTitle = document.createElement('h1');
    stepTitle.className = 'xped-step-title';
    var curStepTitle = Model.getLocalized(pair.step.title, lang, defLang);
    stepTitle.textContent = curStepTitle;
    Model.bindEditableText(stepTitle, 'Click to write step title…', canEditStructure(), function (value) {
      mutate(function () { pair.step.title = Model.setLocalized(pair.step.title, lang, value); }, { recordUndo: false, rerender: false });
      renderOutline();
    });
    card.appendChild(stepTitle);

    var stack = document.createElement('div');
    stack.className = 'xped-blocks-stack';

    (pair.step.blocks || []).forEach(function (blk, bIdx) {
      var bMeta = Model.getBlockMeta(blk.type);
      if (canEditStructure()) {
        stack.appendChild(makeInsertSlot(bIdx, 'Add block before ' + bMeta.label + ' #' + (bIdx + 1)));
      }

      var wrap = document.createElement('div');
      wrap.className = 'el-canvas-block-wrap' + (blk.id === state.selectedBlockId ? ' is-selected' : '');
      wrap.dataset.wrapBlockId = blk.id;
      if (canEditStructure()) {
        // UX-030: Only enable dragging when pointer starts on the dedicated drag handle
        wrap.draggable = false;
        wrap.addEventListener('pointerdown', function (e) {
          wrap.draggable = !!e.target.closest('.el-block-drag-handle');
        });
        wrap.addEventListener('dragend', function () {
          wrap.draggable = false;
          clearDragClasses(stack);
        });
        wrap.addEventListener('dragstart', function (e) {
          if (!wrap.draggable) { e.preventDefault(); return; }
          state.dragPayload = { kind: 'block', fromIdx: bIdx };
        });
        wrap.addEventListener('dragover', function (e) {
          if (!state.dragPayload || state.dragPayload.kind !== 'block') return;
          e.preventDefault();
          var rect = wrap.getBoundingClientRect();
          var after = (e.clientY - rect.top) > rect.height / 2;
          wrap.classList.toggle('is-dragover-before', !after);
          wrap.classList.toggle('is-dragover-after', after);
          state.dragPayload.insertAfter = after;
        });
        wrap.addEventListener('dragleave', function () {
          wrap.classList.remove('is-dragover-before', 'is-dragover-after');
        });
        wrap.addEventListener('drop', function (e) {
          var after = !!(state.dragPayload && state.dragPayload.insertAfter);
          clearDragClasses(stack);
          if (!state.dragPayload || state.dragPayload.kind !== 'block') return;
          e.preventDefault();
          var from = state.dragPayload.fromIdx;
          state.dragPayload = null;
          var targetIdx = after ? bIdx + 1 : bIdx;
          if (from < targetIdx) targetIdx -= 1;
          if (from === targetIdx) return;
          mutate(function () {
            var moved = pair.step.blocks.splice(from, 1)[0];
            pair.step.blocks.splice(targetIdx, 0, moved);
          }, { label: 'reorder block' });
        });
      }

      wrap.addEventListener('click', function (e) {
        if (e.target.closest('.el-block-toolbar')) return;
        syncBlockSelectionInDom(pair, blk.id);
      });

      if (blk.id === state.selectedBlockId && canEditStructure()) {
        wrap.appendChild(buildBlockToolbar(pair, blk, bIdx));
      }

      wrap.appendChild(Blocks.renderBlock(blk, {
        lang: lang,
        defaultLang: defLang,
        stepTitle: curStepTitle,
        interactive: false,
        editable: canEditStructure(),
        selectedPinId: state.selectedPinId,
        onFocusBlock: function (bid) { syncBlockSelectionInDom(pair, bid); },
        onEdit: handleBlockInlineEdit,
        onUploadFile: uploadFileForBlock,
        assetUrl: assetUrl, setMediaSource: setMediaSource,
      }));
      stack.appendChild(wrap);
    });

    if (!(pair.step.blocks || []).length) {
      // UX-023: Real keyboard-accessible <button> for empty step insertion
      var empty = document.createElement('button');
      empty.type = 'button';
      empty.className = 'el-dropzone';
      empty.appendChild(Icons.icon('plus', 22));
      var es = document.createElement('strong');
      es.textContent = 'Start building this step';
      var ep = document.createElement('span');
      ep.textContent = 'Add text, a YouTube clip, an illustration, a Myth/Fact card, or an interactive pain-education exercise.';
      empty.appendChild(es);
      empty.appendChild(ep);
      empty.addEventListener('click', function () { state.insertBlockAt = 0; openBlockPicker(); });
      stack.appendChild(empty);
    } else if (canEditStructure()) {
      var addRow = document.createElement('div');
      addRow.className = 'el-add-block-row';
      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'el-btn';
      addBtn.appendChild(Icons.icon('plus', 15));
      addBtn.appendChild(document.createTextNode('Add Block'));
      addBtn.addEventListener('click', function () { state.insertBlockAt = pair.step.blocks.length; openBlockPicker(); });
      addRow.appendChild(addBtn);
      stack.appendChild(addRow);
    }

    card.appendChild(stack);
    canvasCardEl.appendChild(card);
    updateReadabilityCue();

    // UX-013: Focus newly added step title immediately for inline naming
    if (state.focusStepTitleAfterRender) {
      state.focusStepTitleAfterRender = false;
      requestAnimationFrame(function () {
        stepTitle.focus();
        try {
          var range = document.createRange();
          range.selectNodeContents(stepTitle);
          var sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        } catch (_e) {}
      });
    }
    // UX-025: Scroll & focus newly inserted block
    if (state.focusBlockAfterRender) {
      var fbId = state.focusBlockAfterRender;
      state.focusBlockAfterRender = '';
      requestAnimationFrame(function () {
        var bNode = canvasCardEl.querySelector('[data-block-id="' + CSS.escape(fbId) + '"]');
        if (bNode) {
          bNode.scrollIntoView({ behavior: ux.prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
          var ed = bNode.querySelector('textarea, input, [contenteditable]');
          if (ed) ed.focus();
        }
      });
    }
  }

  /* ---- Calm Contextual Right Inspector (Settings & Style Only) ---- */
  function fieldText(label, value, onChange, multiline, fieldKey) {
    var wrap = document.createElement('div');
    wrap.className = 'el-field';
    var lab = document.createElement('label');
    lab.textContent = label;
    var inp = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) inp.type = 'text';
    else inp.rows = Math.max(3, Math.min(8, String(value || '').split('\n').length + 1));
    inp.value = value || '';
    if (fieldKey) inp.setAttribute('data-field-key', fieldKey);
    lab.htmlFor = inp.id = Model.uid('field');
    inp.addEventListener('input', function () {
      if (multiline) inp.rows = Math.max(3, Math.min(8, inp.value.split('\n').length + 1));
      onChange(inp.value);
    });
    wrap.appendChild(lab);
    wrap.appendChild(inp);
    return wrap;
  }

  function fieldSelect(label, value, options, onChange) {
    var wrap = document.createElement('div');
    wrap.className = 'el-field';
    var lab = document.createElement('label');
    lab.textContent = label;
    var items = (options || []).map(function (opt) { return { value: opt[0], label: opt[1] }; });
    var dd = Icons.createDropdown({
      className: 'is-full',
      triggerClass: 'el-dd-trigger is-full',
      ariaLabel: label,
      items: items,
      value: value,
      onChange: function (nextVal) {
        dd.setItems(items, nextVal);
        onChange(nextVal);
      },
    });
    wrap.appendChild(lab);
    wrap.appendChild(dd.el);
    return wrap;
  }

  function fieldCheck(label, checked, onChange, disabled) {
    var lab = document.createElement('label');
    lab.className = 'el-field-check';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    if (disabled) cb.disabled = true;
    cb.addEventListener('change', function () { onChange(cb.checked); });
    var span = document.createElement('span');
    span.textContent = label;
    lab.appendChild(cb);
    lab.appendChild(span);
    return lab;
  }

  function buildVisualPicker(currentRef, targetForUpload, onPick, audioOnly, onPickAssetMeta) {
    var box = document.createElement('div');
    box.className = 'el-field';
    var upKey = targetForUpload === 'startPage' ? 'startPage' : (targetForUpload && targetForUpload.id ? targetForUpload.id : 'media');
    var hasMedia = !!(currentRef && currentRef.kind !== 'none');

    box.appendChild(Blocks.createDropzone(
      audioOnly ? (hasMedia ? 'Replace audio clip' : 'Upload audio clip') : (hasMedia ? 'Replace custom photo' : 'Upload custom photo'),
      audioOnly ? 'MP3, M4A or OGG' : 'Drop or click · PNG, JPG, WebP',
      audioOnly ? 'audio/*' : 'image/png,image/jpeg,image/webp',
      function (file) { uploadFileForBlock(targetForUpload, file); }
    ));

    // UX-034: Local upload progress & retry status right inside this block's picker
    var upState = state.blockUploads[upKey];
    if (upState) {
      var upBar = document.createElement('div');
      upBar.className = 'el-upload-status' + (upState.status === 'error' ? ' is-error' : '');
      var upText = document.createElement('span');
      upText.textContent = upState.status === 'uploading'
        ? ('Uploading ' + upState.fileName + '…')
        : (upState.fileName + ': ' + upState.error);
      upBar.appendChild(upText);
      if (upState.status === 'error' && upState.file) {
        var retryUp = document.createElement('button');
        retryUp.type = 'button';
        retryUp.className = 'el-btn el-btn-sm';
        retryUp.textContent = 'Retry';
        retryUp.addEventListener('click', function () { uploadFileForBlock(targetForUpload, upState.file); });
        upBar.appendChild(retryUp);
      }
      box.appendChild(upBar);
    }

    // UX-035: Direct Remove action beside current image/audio
    if (hasMedia) {
      var rmRow = document.createElement('div');
      rmRow.className = 'el-btn-row';
      var rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'el-btn el-btn-danger el-btn-sm';
      rmBtn.textContent = audioOnly ? 'Remove audio' : 'Remove image';
      rmBtn.addEventListener('click', function () {
        onPick({ kind: 'none', assetId: '', staticPath: '' });
      });
      rmRow.appendChild(rmBtn);
      box.appendChild(rmRow);
    }

    if (!audioOnly) {
      var detKey = 'assets:' + upKey;
      var library = document.createElement('details');
      library.className = 'el-asset-library';
      library.open = !!state.openInspectorDetails[detKey];
      library.addEventListener('toggle', function () {
        state.openInspectorDetails[detKey] = library.open;
      });
      var summary = document.createElement('summary');
      var current = Model.XPED_ASSETS.find(function (asset) { return currentRef?.staticPath === asset.path; });
      if (current) {
        var thumbnail = document.createElement('img');
        thumbnail.src = current.path;
        thumbnail.alt = '';
        summary.appendChild(thumbnail);
      }
      summary.append('Official xPED Illustrations');
      library.appendChild(summary);
      box.appendChild(library);

      var grid = document.createElement('div');
      grid.className = 'el-asset-grid';
      var noneBtn = document.createElement('button');
      noneBtn.type = 'button';
      noneBtn.className = 'el-asset-thumb' + (!currentRef || currentRef.kind === 'none' ? ' is-selected' : '');
      noneBtn.textContent = 'None';
      noneBtn.setAttribute('aria-pressed', String(!currentRef || currentRef.kind === 'none'));
      noneBtn.addEventListener('click', function () { onPick({ kind: 'none', assetId: '', staticPath: '' }); });
      grid.appendChild(noneBtn);

      Model.XPED_ASSETS.forEach(function (asset) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'el-asset-thumb' + (currentRef && currentRef.staticPath === asset.path ? ' is-selected' : '');
        var img = document.createElement('img');
        img.src = asset.path;
        img.alt = '';
        img.loading = 'lazy';
        btn.setAttribute('aria-pressed', String(currentRef?.staticPath === asset.path));
        var sp = document.createElement('span');
        sp.textContent = asset.label;
        btn.appendChild(img);
        btn.appendChild(sp);
        btn.addEventListener('click', function () {
          onPick({ kind: 'xped', assetId: '', staticPath: asset.path });
          if (typeof onPickAssetMeta === 'function') onPickAssetMeta(asset);
        });
        grid.appendChild(btn);
      });
      library.appendChild(grid);
    }
    return box;
  }

  function formatSecondsHuman(secs) {
    if (secs === null || secs === undefined || !Number.isFinite(secs)) return '';
    var m = Math.floor(secs / 60);
    var s = secs % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function renderInspector() {
    document.querySelectorAll('.el-insp-tab').forEach(function (t) {
      var on = t.getAttribute('data-insp') === state.inspectorTab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    inspectorBodyEl.textContent = '';
    if (!state.exp) return;

    var lang = state.editLang;
    var defLang = state.exp.defaultLanguage || 'nl';

    if (state.inspectorTab === 'theme') {
      var h = document.createElement('div');
      h.className = 'el-insp-section-title';
      h.textContent = 'Expedition Visual Style';
      inspectorBodyEl.appendChild(h);

      // UX-113: Visual Palette Cards with Swatches & Live Mini Specimen
      var currentPreset = (state.exp.theme && state.exp.theme.preset) || 'xped-warm-sand';
      var palettes = [
        { id: 'xped-warm-sand', name: 'xPED Warm Sand (Recommended)', dots: ['#f6f1e9', '#062940', '#1fe4a9', '#ffd617'] },
        { id: 'xped-clean', name: 'xPED Cool Light', dots: ['#f5f8fb', '#062940', '#007acc', '#1fe4a9'] },
        { id: 'high-contrast', name: 'High Contrast (Accessibility)', dots: ['#ffffff', '#000000', '#005b99', '#087051'] },
      ];
      var palGrid = document.createElement('div');
      palGrid.className = 'el-palette-cards';
      palettes.forEach(function (pal) {
        var cardBtn = document.createElement('button');
        cardBtn.type = 'button';
        cardBtn.className = 'el-palette-card' + (currentPreset === pal.id ? ' is-selected' : '');
        cardBtn.setAttribute('aria-pressed', String(currentPreset === pal.id));
        var dots = document.createElement('div');
        dots.className = 'el-palette-dots';
        pal.dots.forEach(function (hex) {
          var dEl = document.createElement('span');
          dEl.className = 'el-palette-dot';
          dEl.style.backgroundColor = hex;
          dots.appendChild(dEl);
        });
        var nm = document.createElement('strong');
        nm.textContent = pal.name;
        cardBtn.append(dots, nm);
        cardBtn.addEventListener('click', function () {
          mutate(function () { state.exp.theme.preset = pal.id; }, { label: 'change palette' });
        });
        palGrid.appendChild(cardBtn);
      });
      inspectorBodyEl.appendChild(palGrid);

      var spec = document.createElement('div');
      spec.className = 'el-palette-specimen';
      spec.setAttribute('data-xped-theme', currentPreset);
      var specCard = document.createElement('div');
      specCard.className = 'el-palette-specimen-card';
      var specT = document.createElement('strong');
      specT.textContent = 'Live learner card preview';
      var specP = document.createElement('span');
      specP.textContent = 'Calm sand canvas, high-contrast typography, and subtle domain accents.';
      specCard.append(specT, specP);
      spec.appendChild(specCard);
      inspectorBodyEl.appendChild(spec);

      inspectorBodyEl.appendChild(fieldCheck('Show animated Expedition Route Map on Start Page', !state.exp.theme || state.exp.theme.showRouteMap !== false, function (v) {
        mutate(function () { state.exp.theme.showRouteMap = v; }, { label: 'toggle route map' });
      }));

      // UX-114: Course Languages section linked from Translate Studio
      var lh = document.createElement('div');
      lh.id = 'el-design-languages';
      lh.className = 'el-insp-section-title';
      lh.textContent = 'Course Languages';
      inspectorBodyEl.appendChild(lh);

      inspectorBodyEl.appendChild(fieldSelect('Default Fallback Language', defLang, [
        ['nl', 'Nederlands (NL)'],
        ['en', 'English (EN)'],
        ['de', 'Deutsch (DE)'],
      ], function (v) {
        mutate(function () {
          state.exp.defaultLanguage = v;
          if ((state.exp.enabledLanguages || []).indexOf(v) < 0) state.exp.enabledLanguages.unshift(v);
        }, { label: 'change default language' });
      }));

      var enabledSet = state.exp.enabledLanguages || ['nl', 'en', 'de'];
      ['nl', 'en', 'de'].forEach(function (code) {
        var isDefault = code === defLang;
        inspectorBodyEl.appendChild(fieldCheck(
          'Enable ' + Model.LANG_LABELS[code] + (isDefault ? ' (default)' : ''),
          enabledSet.indexOf(code) >= 0,
          function (on) {
            mutate(function () {
              var next = (state.exp.enabledLanguages || ['nl']).filter(function (c) { return c !== code; });
              if (on) next.push(code);
              if (!next.length) next = [defLang];
              state.exp.enabledLanguages = next;
            }, { label: 'toggle language' });
          },
          isDefault
        ));
      });
      return;
    }

    if (state.selectedTarget.type === 'startPage') {
      var sp = state.exp.startPage;
      var spHead = document.createElement('div');
      spHead.className = 'el-insp-section-title';
      spHead.textContent = 'Start Page Properties';
      inspectorBodyEl.appendChild(spHead);

      var hint = document.createElement('p');
      hint.className = 'xped-caption';
      hint.textContent = 'Edit headlines, intro, highlights, and CTA directly on the Start Page canvas.';
      inspectorBodyEl.appendChild(hint);

      inspectorBodyEl.appendChild(buildVisualPicker(sp.heroMedia, 'startPage', function (ref) {
        mutate(function () { sp.heroMedia = ref; }, { label: 'update start page illustration' });
      }, false));

      inspectorBodyEl.appendChild(fieldText('Optional Intro YouTube/Vimeo URL', sp.heroVideoUrl, function (v) {
        mutate(function () {
          sp.heroVideoUrl = v;
          var parsed = Model.parseVideoUrl(v);
          sp.heroVideoEmbedUrl = parsed.embedUrl || '';
        }, { recordUndo: false });
      }));

      var addHl = document.createElement('button');
      addHl.type = 'button';
      addHl.className = 'el-btn el-btn-sm';
      addHl.appendChild(Icons.icon('plus', 14));
      addHl.appendChild(document.createTextNode('Add Start Page Highlight'));
      addHl.addEventListener('click', function () {
        mutate(function () { sp.highlights.push({ id: Model.uid('hl'), text: Model.loc('Nieuw voordeel', 'New highlight', '') }); }, { label: 'add highlight' });
      });
      inspectorBodyEl.appendChild(addHl);
      return;
    }

    var pair = currentModuleAndStep();
    if (!pair.mod || !pair.step) return;

    if (state.inspectorTab === 'step' || !currentBlock()) {
      var mod = pair.mod;
      var step = pair.step;
      var mh = document.createElement('div');
      mh.className = 'el-insp-section-title';
      mh.textContent = 'Station Settings';
      inspectorBodyEl.appendChild(mh);

      inspectorBodyEl.appendChild(fieldText('Station Name (' + lang.toUpperCase() + ')', mod.title[lang], function (v) {
        mutate(function () { mod.title = Model.setLocalized(mod.title, lang, v); }, { recordUndo: false });
      }));
      inspectorBodyEl.appendChild(fieldSelect('Biopsychosocial Color Theme', mod.domain || 'general', [
        ['general', 'General (Neutral Navy)'],
        ['bio', 'Biologisch (Mint)'],
        ['psycho', 'Psychologisch (Blue)'],
        ['social', 'Sociaal (Yellow)'],
      ], function (v) { mutate(function () { mod.domain = v; }, { label: 'change station theme' }); }));

      // UX-108: Validated numeric duration input labeled as author estimate
      var minWrap = document.createElement('div');
      minWrap.className = 'el-field';
      var minLab = document.createElement('label');
      minLab.textContent = 'Estimated Minutes (author estimate, 1–120)';
      var minInp = document.createElement('input');
      minInp.type = 'number';
      minInp.min = '1';
      minInp.max = '120';
      minInp.step = '1';
      minInp.value = String(mod.estimatedMinutes || 5);
      minLab.htmlFor = minInp.id = Model.uid('mins');
      var minErr = document.createElement('p');
      minErr.className = 'el-insp-error';
      minErr.hidden = true;
      minInp.addEventListener('input', function () {
        var n = Number(minInp.value);
        if (!Number.isInteger(n) || n < 1 || n > 120) {
          minErr.textContent = 'Enter a whole number between 1 and 120 minutes.';
          minErr.hidden = false;
        } else {
          minErr.hidden = true;
          mutate(function () { mod.estimatedMinutes = n; }, { recordUndo: false });
        }
      });
      minWrap.append(minLab, minInp);
      inspectorBodyEl.append(minWrap, minErr);

      inspectorBodyEl.appendChild(fieldCheck('Visible in Public Test Link', mod.visibleToLearners !== false, function (v) {
        mutate(function () { mod.visibleToLearners = v; }, { label: 'toggle station visibility' });
      }));
      inspectorBodyEl.appendChild(fieldText('Milestone Celebration Note', mod.milestoneMessage[lang], function (v) {
        mutate(function () { mod.milestoneMessage = Model.setLocalized(mod.milestoneMessage, lang, v); }, { recordUndo: false });
      }));

      var sh = document.createElement('div');
      sh.className = 'el-insp-section-title';
      sh.textContent = 'Step Readiness & Flow';
      inspectorBodyEl.appendChild(sh);

      inspectorBodyEl.appendChild(fieldSelect('Content Status', Model.deriveStepContentState(step), [
        ['empty', 'Empty (awaiting partner content)'],
        ['draft', 'Draft (in progress)'],
        ['review', 'Needs partner review'],
        ['ready', 'Ready for testing'],
      ], function (v) { mutate(function () { step.status = v; }, { label: 'change step status' }); }));

      // UX-073, UX-074, UX-075: Complete Visual Branching Rule Builder
      var qBlocks = (step.blocks || []).filter(function (b) { return b.type === 'mcq' || b.type === 'myth_fact' || b.type === 'scale'; });
      var curRule = (step.branching && step.branching[0]) || null;
      if (curRule && !(mod.steps || []).some(function (s) { return s.id === curRule.targetStepId; })) {
        var brokenWarn = document.createElement('div');
        brokenWarn.className = 'el-insp-warn';
        brokenWarn.textContent = 'This step has a branching jump pointing to a deleted step. Choose a new target or clear the rule.';
        var clrBtn = document.createElement('button');
        clrBtn.type = 'button';
        clrBtn.className = 'el-btn el-btn-sm';
        clrBtn.textContent = 'Clear broken rule';
        clrBtn.addEventListener('click', function () {
          mutate(function () { step.branching = []; }, { label: 'clear broken jump rule' });
        });
        brokenWarn.appendChild(document.createElement('br'));
        brokenWarn.appendChild(clrBtn);
        inspectorBodyEl.appendChild(brokenWarn);
      }

      if (qBlocks.length && mod.steps.length > 1) {
        var brCard = document.createElement('div');
        brCard.className = 'el-insp-card';
        var brHead = document.createElement('div');
        brHead.className = 'el-insp-card-head';
        brHead.textContent = 'Conditional Jump Rule';
        brCard.appendChild(brHead);

        var targetOpts = [['', 'Continue to next step (no jump)']].concat(
          mod.steps.filter(function (s) { return s.id !== step.id; }).map(function (s, i) {
            return [s.id, 'Jump to: ' + (Model.getLocalized(s.title, lang, defLang) || ('Step ' + (i + 1)))];
          })
        );
        brCard.appendChild(fieldSelect('When answered…', curRule ? curRule.targetStepId : '', targetOpts, function (tid) {
          mutate(function () {
            if (!tid) { step.branching = []; return; }
            var firstQ = qBlocks[0];
            var defVal = firstQ.type === 'myth_fact' ? 'myth' : (firstQ.type === 'mcq' ? ((firstQ.data.options && firstQ.data.options[0] && firstQ.data.options[0].id) || '') : '5');
            step.branching = [{ blockId: (curRule && curRule.blockId) || firstQ.id, operator: (curRule && curRule.operator) || 'equals', value: (curRule && curRule.value) || defVal, targetStepId: tid }];
          }, { label: 'update jump rule' });
        }));

        if (curRule) {
          var srcBlock = qBlocks.find(function (b) { return b.id === curRule.blockId; }) || qBlocks[0];
          if (qBlocks.length > 1) {
            var qOpts = qBlocks.map(function (qb, qi) {
              var qTxt = Model.getLocalized(qb.data.question || qb.data.statement, lang, defLang) || (Model.getBlockMeta(qb.type).label + ' #' + (qi + 1));
              return [qb.id, qTxt.slice(0, 48)];
            });
            brCard.appendChild(fieldSelect('Source question', srcBlock.id, qOpts, function (bid) {
              var pickedB = qBlocks.find(function (b) { return b.id === bid; }) || qBlocks[0];
              mutate(function () {
                curRule.blockId = pickedB.id;
                curRule.operator = pickedB.type === 'scale' ? 'lte' : 'equals';
                curRule.value = pickedB.type === 'myth_fact' ? 'myth' : (pickedB.type === 'mcq' ? ((pickedB.data.options && pickedB.data.options[0] && pickedB.data.options[0].id) || '') : '5');
              }, { label: 'change jump source' });
            }));
          }

          if (srcBlock.type === 'myth_fact') {
            brCard.appendChild(fieldSelect('If learner chooses', curRule.value || 'myth', [
              ['myth', 'Fabel / Myth'],
              ['fact', 'Feit / Fact'],
            ], function (val) {
              mutate(function () { curRule.operator = 'equals'; curRule.value = val; }, { label: 'update jump answer' });
            }));
          } else if (srcBlock.type === 'mcq') {
            var optChoices = (srcBlock.data.options || []).map(function (o, oi) {
              return [o.id, Model.getLocalized(o.label, lang, defLang) || ('Option ' + (oi + 1))];
            });
            brCard.appendChild(fieldSelect('If learner chooses option', curRule.value || (optChoices[0] && optChoices[0][0]) || '', optChoices, function (val) {
              mutate(function () { curRule.operator = 'equals'; curRule.value = val; }, { label: 'update jump option' });
            }));
          } else if (srcBlock.type === 'scale') {
            brCard.appendChild(fieldSelect('Condition', curRule.operator || 'lte', [
              ['lte', 'Score is at most (≤)'],
              ['gte', 'Score is at least (≥)'],
              ['equals', 'Score equals (=)'],
            ], function (op) {
              mutate(function () { curRule.operator = op; }, { label: 'update jump operator' });
            }));
            brCard.appendChild(fieldText('Threshold (' + (srcBlock.data.min ?? 0) + '–' + (srcBlock.data.max ?? 10) + ')', curRule.value || '5', function (v) {
              mutate(function () { curRule.value = v; }, { recordUndo: false });
            }));
          }
        }
        inspectorBodyEl.appendChild(brCard);
      }

      // UX-019: Explain & disable Delete Step when station has only 1 step + offer quick Add step
      var dangerRow = document.createElement('div');
      dangerRow.className = 'el-btn-row el-danger-row';
      var delStep = document.createElement('button');
      delStep.type = 'button';
      delStep.className = 'el-btn el-btn-danger el-btn-sm';
      delStep.textContent = 'Delete Step';
      var soleStep = (mod.steps || []).length <= 1;
      delStep.disabled = soleStep;
      delStep.addEventListener('click', function () {
        if ((mod.steps || []).length <= 1) return;
        var removedIdx = mod.steps.indexOf(step);
        var removedStep = clone(step);
        var targetModId = mod.id;
        mutate(function () {
          mod.steps = mod.steps.filter(function (s) { return s.id !== step.id; });
          // UX-075: Clean up broken branching targets pointing to this deleted step
          mod.steps.forEach(function (other) {
            if (Array.isArray(other.branching)) {
              other.branching = other.branching.filter(function (r) { return r.targetStepId !== step.id; });
            }
          });
          state.selectedTarget = { type: 'step', moduleId: mod.id, stepId: mod.steps[Math.min(removedIdx, mod.steps.length - 1)].id };
        }, { label: 'delete step' });
        showToast('Step deleted.', function () {
          var m = (state.exp.modules || []).find(function (x) { return x.id === targetModId; });
          if (!m) return;
          mutate(function () {
            m.steps.splice(Math.min(removedIdx, m.steps.length), 0, removedStep);
            state.selectedTarget = { type: 'step', moduleId: targetModId, stepId: removedStep.id };
          }, { label: 'restore step' });
        });
      });

      var delMod = document.createElement('button');
      delMod.type = 'button';
      delMod.className = 'el-btn el-btn-danger el-btn-sm';
      delMod.textContent = 'Delete Station';
      delMod.addEventListener('click', function () {
        var removedModIdx = state.exp.modules.indexOf(mod);
        var removedMod = clone(mod);
        mutate(function () {
          state.exp.modules = state.exp.modules.filter(function (m) { return m.id !== mod.id; });
          state.selectedTarget = { type: 'startPage' };
        }, { label: 'delete station' });
        showToast('Station deleted.', function () {
          mutate(function () {
            state.exp.modules.splice(Math.min(removedModIdx, state.exp.modules.length), 0, removedMod);
            state.selectedTarget = { type: 'step', moduleId: removedMod.id, stepId: removedMod.steps[0].id };
          }, { label: 'restore station' });
        });
      });
      dangerRow.appendChild(delStep);
      dangerRow.appendChild(delMod);
      inspectorBodyEl.appendChild(dangerRow);

      if (soleStep) {
        var soleNote = document.createElement('div');
        soleNote.className = 'el-insp-warn';
        soleNote.textContent = 'Every station keeps at least one step. Add another step before deleting this one, or delete the whole station. ';
        var quickAdd = document.createElement('button');
        quickAdd.type = 'button';
        quickAdd.className = 'el-btn el-btn-sm';
        quickAdd.textContent = '+ Add step';
        quickAdd.addEventListener('click', function () {
          state.focusStepTitleAfterRender = true;
          mutate(function () {
            var ns = Model.createStep('Stap ' + (mod.steps.length + 1), 'Step ' + (mod.steps.length + 1));
            mod.steps.push(ns);
            state.selectedTarget = { type: 'step', moduleId: mod.id, stepId: ns.id };
            state.selectedBlockId = '';
          }, { label: 'add step' });
        });
        soleNote.appendChild(quickAdd);
        inspectorBodyEl.appendChild(soleNote);
      }
      return;
    }

    /* ---- Calm Contextual Block Settings (S-01, S-06, S-13) ---- */
    var blk = currentBlock();
    var d = blk.data;
    var metaInfo = Model.getBlockMeta(blk.type);

    // UX-093: Selected-block mini preview strip inside mobile inspector
    var mobPrev = document.createElement('div');
    mobPrev.className = 'el-insp-mobile-preview';
    var mobStrong = document.createElement('strong');
    mobStrong.textContent = metaInfo.label;
    var mobBack = document.createElement('button');
    mobBack.type = 'button';
    mobBack.className = 'el-btn el-btn-sm';
    mobBack.textContent = 'View on canvas';
    mobBack.addEventListener('click', function () { selectPane('canvas'); });
    mobPrev.append(mobStrong, mobBack);
    inspectorBodyEl.appendChild(mobPrev);

    var bh = document.createElement('div');
    bh.className = 'el-insp-section-title';
    bh.textContent = metaInfo.label + ' Properties';
    inspectorBodyEl.appendChild(bh);

    // S-01: Tailored per-block help (never misleading generic copy on fields only editable in Inspector)
    var helpByType = {
      sources: 'Manage citations and DOIs below. Learners see a clean collapsible Bron box.',
      video: 'Paste a YouTube or Vimeo link below, optionally set start/end times, and add a summary transcript.',
      hotspot: 'Click the image on the canvas to place pins, drag pins to reposition, and edit titles, colors & explanations below.',
      balance_scale: 'Edit heading on the canvas; configure Load vs. Resources factors and guidance tips below.',
      bps_triad: 'Edit the Bio, Psycho, and Social tab explanations below.',
      custom_visual: 'Pick a built-in pain animation or keep a Coding Agent Blueprint slot with a brief.',
    };
    var editTip = document.createElement('p');
    editTip.className = 'xped-caption el-edit-tip';
    editTip.textContent = helpByType[blk.type] || 'Edit visible headings and wording directly on the slide canvas; adjust behavior and extras here.';
    inspectorBodyEl.appendChild(editTip);

    // UX-076: Warn / guard revealAfterAnswer if step has no interactive question block
    if (blk.type === 'callout' || blk.type === 'richtext' || blk.type === 'image' || blk.type === 'story' || blk.type === 'sources') {
      var interactiveSet = { mcq: 1, myth_fact: 1, scale: 1, reflection: 1, wordcloud: 1, ranking: 1, hotspot: 1, balance_scale: 1, mini_plan: 1 };
      var stepHasInteractive = (pair.step.blocks || []).some(function (b) { return b.id !== blk.id && !!interactiveSet[b.type]; });
      var revOn = !!(blk.settings && blk.settings.revealAfterAnswer);
      inspectorBodyEl.appendChild(fieldCheck(
        'Reveal only after learner answers a question on this step',
        revOn,
        function (v) {
          mutate(function () {
            blk.settings = blk.settings || {};
            blk.settings.revealAfterAnswer = v;
          }, { label: 'toggle progressive reveal' });
        },
        !stepHasInteractive && !revOn
      ));
      if (!stepHasInteractive) {
        var revWarn = document.createElement('div');
        revWarn.className = 'el-insp-warn';
        revWarn.textContent = revOn
          ? 'Warning: this step has no question block, so learners would never be able to unlock this block! Turn off reveal-after-answer or add a question block.'
          : 'Add a question block (e.g. Myth vs. Fact or Poll) on this step to enable progressive reveal.';
        inspectorBodyEl.appendChild(revWarn);
      }
    }

    function locField(lbl, key, multi) {
      inspectorBodyEl.appendChild(fieldText(lbl, (d[key] && d[key][lang]) || '', function (v) {
        mutate(function () { d[key] = Model.setLocalized(d[key], lang, v); }, { recordUndo: false });
      }, multi, key));
    }

    if (blk.type === 'video') {
      // UX-038 & UX-039: Explicit trim preservation/reset on URL replacement + joint Start/End validation
      var urlWrap = document.createElement('div');
      urlWrap.className = 'el-field';
      var urlLab = document.createElement('label');
      urlLab.textContent = 'YouTube or Vimeo URL';
      var urlInp = document.createElement('input');
      urlInp.type = 'url';
      urlInp.value = d.url || '';
      urlLab.htmlFor = urlInp.id = Model.uid('vidurl');
      var trimPrompt = document.createElement('div');
      trimPrompt.className = 'el-insp-warn';
      trimPrompt.hidden = true;
      urlInp.addEventListener('change', function () {
        var v = urlInp.value.trim();
        var oldId = d.videoId || '';
        var p = Model.parseVideoUrl(v);
        var hadManualTrim = (d.startSeconds !== null && d.startSeconds !== undefined) || (d.endSeconds !== null && d.endSeconds !== undefined);
        mutate(function () {
          d.url = v;
          d.provider = p.provider || '';
          d.videoId = p.videoId || '';
          d.embedUrl = p.embedUrl || '';
          if (p.startSeconds !== null && !hadManualTrim) d.startSeconds = p.startSeconds;
        }, { label: 'update video link' });
        if (oldId && p.videoId && p.videoId !== oldId && hadManualTrim) {
          trimPrompt.textContent = 'You replaced the video while a start/end trim is set. ';
          var rst = document.createElement('button');
          rst.type = 'button';
          rst.className = 'el-btn el-btn-sm';
          rst.textContent = 'Reset trim';
          rst.addEventListener('click', function () {
            mutate(function () { d.startSeconds = p.startSeconds; d.endSeconds = null; }, { label: 'reset video trim' });
          });
          trimPrompt.appendChild(rst);
          trimPrompt.hidden = false;
        }
      });
      urlWrap.append(urlLab, urlInp);
      inspectorBodyEl.append(urlWrap, trimPrompt);

      var timeErr = document.createElement('p');
      timeErr.className = 'el-insp-error';
      timeErr.hidden = true;
      var segPreview = document.createElement('p');
      segPreview.className = 'xped-caption';

      function refreshVideoTimingMeta(rawStart, rawEnd) {
        var sSec = Model.parseTimestampSeconds(rawStart);
        var eSec = Model.parseTimestampSeconds(rawEnd);
        if (rawStart.trim() && sSec === null) {
          timeErr.textContent = 'Start time not recognized (use e.g. 1:15 or 75).';
          timeErr.hidden = false;
          return false;
        }
        if (rawEnd.trim() && eSec === null) {
          timeErr.textContent = 'End time not recognized (use e.g. 2:45 or 165).';
          timeErr.hidden = false;
          return false;
        }
        if (sSec !== null && eSec !== null && eSec <= sSec) {
          timeErr.textContent = 'End time (' + formatSecondsHuman(eSec) + ') must be after Start time (' + formatSecondsHuman(sSec) + ').';
          timeErr.hidden = false;
          return false;
        }
        timeErr.hidden = true;
        if (sSec !== null || eSec !== null) {
          segPreview.textContent = 'Effective clip: ' + (sSec !== null ? formatSecondsHuman(sSec) : '0:00') + ' – ' + (eSec !== null ? formatSecondsHuman(eSec) : 'end');
        } else {
          segPreview.textContent = 'Plays full video from start to finish.';
        }
        return true;
      }

      var startField = fieldText('Start Time (e.g. 1:15)', d.startSeconds !== null && d.startSeconds !== undefined ? formatSecondsHuman(d.startSeconds) : '', function (v) {
        var endVal = endField.querySelector('input').value;
        if (refreshVideoTimingMeta(v, endVal)) {
          mutate(function () { d.startSeconds = Model.parseTimestampSeconds(v); }, { recordUndo: false });
        }
      });
      var endField = fieldText('End Time (e.g. 2:45)', d.endSeconds !== null && d.endSeconds !== undefined ? formatSecondsHuman(d.endSeconds) : '', function (v) {
        var startVal = startField.querySelector('input').value;
        if (refreshVideoTimingMeta(startVal, v)) {
          mutate(function () { d.endSeconds = Model.parseTimestampSeconds(v); }, { recordUndo: false });
        }
      });
      refreshVideoTimingMeta(startField.querySelector('input').value, endField.querySelector('input').value);
      inspectorBodyEl.append(startField, endField, timeErr, segPreview);
      locField('Collapsible Transcript / Summary', 'transcript', true);
    } else if (blk.type === 'image') {
      // UX-037: Warn when switching split -> full/framed if side text exists
      var hasSideText = !!(Model.getLocalized(d.sideHeading, lang, defLang).trim() || Model.getLocalized(d.sideBody, lang, defLang).trim());
      var wasSplit = d.layout === 'split-left' || d.layout === 'split-right';
      inspectorBodyEl.appendChild(fieldSelect('Layout', d.layout || 'full', [
        ['full', 'Full Width'],
        ['framed', 'Framed Visual'],
        ['split-left', 'Split: Image Left'],
        ['split-right', 'Split: Image Right'],
      ], function (v) {
        var isNextSplit = v === 'split-left' || v === 'split-right';
        mutate(function () { d.layout = v; }, { label: 'change image layout' });
        if (wasSplit && !isNextSplit && hasSideText) {
          showToast('Side text is hidden in this layout (preserved if you switch back to Split).');
        }
      }));
      // S-06: Image Alignment & Focal Point Controls
      if (!wasSplit) {
        inspectorBodyEl.appendChild(fieldSelect('Alignment', d.align || 'center', [
          ['left', 'Left aligned'],
          ['center', 'Centered'],
          ['right', 'Right aligned'],
        ], function (v) { mutate(function () { d.align = v; }, { label: 'change image alignment' }); }));
      }
      var focalCard = document.createElement('div');
      focalCard.className = 'el-insp-card';
      var fcHead = document.createElement('div');
      fcHead.className = 'el-insp-card-head';
      fcHead.textContent = 'Focal Point (crop anchor)';
      focalCard.appendChild(fcHead);
      var fRow = document.createElement('div');
      fRow.className = 'el-coord-row';
      ['focalX', 'focalY'].forEach(function (axis) {
        var fw = document.createElement('div');
        fw.className = 'el-field';
        var fl = document.createElement('label');
        fl.textContent = axis === 'focalX' ? 'Horizontal %' : 'Vertical %';
        var fi = document.createElement('input');
        fi.type = 'number';
        fi.min = '0';
        fi.max = '100';
        fi.value = String(d[axis] ?? 50);
        fi.addEventListener('input', function () {
          var nv = Math.max(0, Math.min(100, Number(fi.value) || 50));
          mutate(function () { d[axis] = nv; }, { recordUndo: false });
        });
        fw.append(fl, fi);
        fRow.appendChild(fw);
      });
      focalCard.appendChild(fRow);
      inspectorBodyEl.appendChild(focalCard);

      inspectorBodyEl.appendChild(buildVisualPicker(d.media, blk, function (ref) {
        mutate(function () { d.media = ref; }, { label: 'update image' });
      }, false, function (asset) {
        // UX-036: Auto-populate localized alt text when picking official xPED asset if empty
        if (asset && asset.alt && !Model.getLocalized(d.alt, lang, defLang).trim()) {
          mutate(function () { d.alt = Object.assign({ nl: '', en: '', de: '' }, asset.alt); }, { recordUndo: false });
        }
      }));
      locField('Alt Text (Accessibility)', 'alt', false);
    } else if (blk.type === 'audio') {
      inspectorBodyEl.appendChild(buildVisualPicker(d.media, blk, function (ref) { mutate(function () { d.media = ref; }, { label: 'update audio' }); }, true));
      locField('Collapsible Transcript', 'transcript', true);
    } else if (blk.type === 'callout') {
      inspectorBodyEl.appendChild(fieldSelect('Accent Color', d.tone || 'tip', [
        ['tip', 'Navy'],
        ['bio', 'Biologisch (Mint)'],
        ['psycho', 'Psychologisch (Blue)'],
        ['social', 'Sociaal (Yellow)'],
      ], function (v) { mutate(function () { d.tone = v; }, { label: 'change callout color' }); }));
    } else if (blk.type === 'story') {
      inspectorBodyEl.appendChild(buildVisualPicker(d.media, blk, function (ref) { mutate(function () { d.media = ref; }, { label: 'update portrait' }); }, false));
    } else if (blk.type === 'sources') {
      // UX-041 & UX-042: Multiline auto-growing citation + DOI normalization preview + undoable Remove
      locField('Drawer Heading (e.g. Bron)', 'title', false);
      (d.items || []).forEach(function (item, idx) {
        var sCard = document.createElement('div');
        sCard.className = 'el-insp-card';
        var sHead = document.createElement('div');
        sHead.className = 'el-insp-card-head';
        sHead.appendChild(document.createTextNode('Reference ' + (idx + 1)));
        var rmSrc = document.createElement('button');
        rmSrc.type = 'button';
        rmSrc.className = 'el-btn el-btn-danger el-btn-sm';
        rmSrc.textContent = 'Remove';
        rmSrc.addEventListener('click', function () {
          var removed = clone(item);
          mutate(function () { d.items.splice(idx, 1); }, { label: 'remove reference' });
          showToast('Reference removed.', function () {
            mutate(function () { d.items.splice(Math.min(idx, d.items.length), 0, removed); }, { label: 'restore reference' });
          });
        });
        sHead.appendChild(rmSrc);
        sCard.appendChild(sHead);
        sCard.appendChild(fieldText('Citation (' + lang.toUpperCase() + ')', item.citation[lang], function (v) {
          mutate(function () { item.citation = Model.setLocalized(item.citation, lang, v); }, { recordUndo: false });
        }, true));
        sCard.appendChild(fieldText('DOI or URL (e.g. 10.3174/ajnr.A4173)', item.url || '', function (v) {
          mutate(function () { item.url = v; }, { recordUndo: false });
        }));
        var normLink = Model.normalizeCitationLink(item.url);
        if (normLink.url) {
          var lPrev = document.createElement('span');
          lPrev.className = 'xped-caption';
          lPrev.textContent = 'Resolves to: ' + normLink.url;
          sCard.appendChild(lPrev);
        }
        inspectorBodyEl.appendChild(sCard);
      });
      var addSrc = document.createElement('button');
      addSrc.type = 'button';
      addSrc.className = 'el-btn el-btn-sm';
      addSrc.textContent = '+ Add Reference';
      addSrc.addEventListener('click', function () {
        mutate(function () { d.items.push({ id: Model.uid('src'), citation: Model.loc('', '', ''), url: '' }); }, { label: 'add reference' });
      });
      inspectorBodyEl.appendChild(addSrc);
    } else if (blk.type === 'mcq') {
      // UX-047: Explicit Poll vs Knowledge Check + per-option answer key & feedback
      var isGraded = d.graded !== undefined ? !!d.graded : (d.options || []).some(function (o) { return !!o.isCorrect; });
      inspectorBodyEl.appendChild(fieldSelect('Question Mode', isGraded ? 'graded' : 'poll', [
        ['poll', 'Poll / Opinion (no right or wrong)'],
        ['graded', 'Knowledge Check (graded answer key)'],
      ], function (v) {
        mutate(function () {
          d.graded = v === 'graded';
          if (d.graded && blk.settings.allowMultiple && !d.checkMode) d.checkMode = 'submit';
        }, { label: 'change question mode' });
      }));
      inspectorBodyEl.appendChild(fieldCheck('Allow multiple selections', blk.settings.allowMultiple, function (v) {
        mutate(function () {
          blk.settings.allowMultiple = v;
          if (v && d.graded) d.checkMode = 'submit';
        }, { label: 'toggle multi-select' });
      }));
      if (blk.settings.allowMultiple && isGraded) {
        inspectorBodyEl.appendChild(fieldSelect('Feedback Timing', d.checkMode || 'submit', [
          ['submit', 'Wait for "Check answers" button (recommended)'],
          ['immediate', 'Check immediately on each click'],
        ], function (v) { mutate(function () { d.checkMode = v; }, { label: 'change check timing' }); }));
      }
      inspectorBodyEl.appendChild(fieldCheck('Show anonymous peer stats after answering', blk.settings.showPeerResults, function (v) {
        mutate(function () { blk.settings.showPeerResults = v; }, { label: 'toggle peer results' });
      }));

      (d.options || []).forEach(function (opt, idx) {
        var oCard = document.createElement('div');
        oCard.className = 'el-insp-card';
        var oHead = document.createElement('div');
        oHead.className = 'el-insp-card-head';
        oHead.appendChild(document.createTextNode('Option ' + String.fromCharCode(65 + idx)));
        if ((d.options || []).length > 2) {
          var rmO = document.createElement('button');
          rmO.type = 'button';
          rmO.className = 'el-btn el-btn-danger el-btn-sm';
          rmO.textContent = 'Remove';
          rmO.addEventListener('click', function () {
            mutate(function () { d.options.splice(idx, 1); }, { label: 'remove option' });
          });
          oHead.appendChild(rmO);
        }
        oCard.appendChild(oHead);
        oCard.appendChild(fieldText('Label', (opt.label && opt.label[lang]) || '', function (v) {
          mutate(function () { opt.label = Model.setLocalized(opt.label, lang, v); }, { recordUndo: false });
        }));
        if (isGraded) {
          oCard.appendChild(fieldCheck('Mark as correct answer', !!opt.isCorrect, function (v) {
            mutate(function () { opt.isCorrect = v; }, { label: 'toggle correct option' });
          }));
        }
        oCard.appendChild(fieldText('Option-specific feedback (optional)', (opt.feedback && opt.feedback[lang]) || '', function (v) {
          mutate(function () { opt.feedback = Model.setLocalized(opt.feedback, lang, v); }, { recordUndo: false });
        }));
        inspectorBodyEl.appendChild(oCard);
      });
      locField('General Explanation (after answer)', 'explanation', true);
    } else if (blk.type === 'myth_fact') {
      inspectorBodyEl.appendChild(fieldSelect('Correct Answer', d.correctAnswer || 'myth', [
        ['myth', 'Fabel / Myth'],
        ['fact', 'Feit / Fact'],
      ], function (v) { mutate(function () { d.correctAnswer = v; }, { label: 'change correct answer' }); }));
      locField('Explanation Reveal (shown after click)', 'explanation', true);
      inspectorBodyEl.appendChild(fieldText('Optional Source Link or DOI', d.sourceUrl || '', function (v) {
        mutate(function () { d.sourceUrl = v; }, { recordUndo: false });
      }));
    } else if (blk.type === 'scale') {
      // UX-051: One-click Scale Anchor Presets
      var presetOpts = [['', 'Apply anchor preset…']].concat(
        (Model.SCALE_ANCHOR_PRESETS || []).map(function (pr) { return [pr.id, pr.label]; })
      );
      inspectorBodyEl.appendChild(fieldSelect('Quick Anchor Preset', '', presetOpts, function (pid) {
        var preset = (Model.SCALE_ANCHOR_PRESETS || []).find(function (p) { return p.id === pid; });
        if (!preset) return;
        mutate(function () {
          d.min = preset.min;
          d.max = preset.max;
          d.minLabel = Object.assign({}, preset.minLabel);
          d.maxLabel = Object.assign({}, preset.maxLabel);
        }, { label: 'apply scale preset' });
      }));
      locField('Left Endpoint Label', 'minLabel', false);
      locField('Right Endpoint Label', 'maxLabel', false);
      locField('Helper Note', 'feedback', true);
      inspectorBodyEl.appendChild(fieldCheck('Show anonymous peer average', blk.settings.showPeerResults, function (v) {
        mutate(function () { blk.settings.showPeerResults = v; }, { label: 'toggle peer average' });
      }));
    } else if (blk.type === 'wordcloud') {
      inspectorBodyEl.appendChild(fieldCheck('Show anonymous peer word cloud', blk.settings.showPeerResults, function (v) {
        mutate(function () { blk.settings.showPeerResults = v; }, { label: 'toggle peer word cloud' });
      }));
    } else if (blk.type === 'ranking') {
      (d.items || []).forEach(function (it, idx) {
        inspectorBodyEl.appendChild(fieldText('Item ' + (idx + 1), it.label[lang], function (v) {
          mutate(function () { it.label = Model.setLocalized(it.label, lang, v); }, { recordUndo: false });
        }));
      });
      var addRank = document.createElement('button');
      addRank.type = 'button';
      addRank.className = 'el-btn el-btn-sm';
      addRank.textContent = '+ Add Item';
      addRank.addEventListener('click', function () {
        mutate(function () { d.items.push({ id: Model.uid('opt'), label: Model.loc('', '', '') }); }, { label: 'add ranking item' });
      });
      inspectorBodyEl.appendChild(addRank);
    } else if (blk.type === 'hotspot') {
      // S-13: Full Hotspot Pin Manager (color swatches, X/Y coords, reorder, delete)
      inspectorBodyEl.appendChild(buildVisualPicker(d.media, blk, function (ref) {
        mutate(function () { d.media = ref; }, { label: 'update hotspot image' });
      }, false, function (asset) {
        if (asset && asset.alt && !Model.getLocalized(d.alt, lang, defLang).trim()) {
          mutate(function () { d.alt = Object.assign({ nl: '', en: '', de: '' }, asset.alt); }, { recordUndo: false });
        }
      }));
      locField('Image Alt Description', 'alt', false);

      (d.pins || []).forEach(function (pin, idx) {
        var pCard = document.createElement('div');
        pCard.className = 'el-insp-card';
        if (pin.id === state.selectedPinId) pCard.style.borderColor = 'var(--xped-blue)';
        var pHead = document.createElement('div');
        pHead.className = 'el-insp-card-head';
        pHead.appendChild(document.createTextNode('Pin #' + (idx + 1)));
        var pActs = document.createElement('div');
        pActs.className = 'el-btn-row';
        if ((d.pins || []).length > 1) {
          var pUp = document.createElement('button');
          pUp.type = 'button';
          pUp.className = 'el-btn el-btn-sm';
          pUp.textContent = '↑';
          pUp.title = 'Move pin earlier';
          pUp.disabled = idx === 0;
          pUp.addEventListener('click', function () {
            mutate(function () { var t = d.pins[idx - 1]; d.pins[idx - 1] = d.pins[idx]; d.pins[idx] = t; }, { label: 'reorder pin' });
          });
          var pDn = document.createElement('button');
          pDn.type = 'button';
          pDn.className = 'el-btn el-btn-sm';
          pDn.textContent = '↓';
          pDn.title = 'Move pin later';
          pDn.disabled = idx === d.pins.length - 1;
          pDn.addEventListener('click', function () {
            mutate(function () { var t = d.pins[idx + 1]; d.pins[idx + 1] = d.pins[idx]; d.pins[idx] = t; }, { label: 'reorder pin' });
          });
          pActs.append(pUp, pDn);
        }
        var pDel = document.createElement('button');
        pDel.type = 'button';
        pDel.className = 'el-btn el-btn-danger el-btn-sm';
        pDel.textContent = 'Remove';
        pDel.addEventListener('click', function () {
          var removedPin = clone(pin);
          mutate(function () { d.pins.splice(idx, 1); }, { label: 'delete hotspot pin' });
          showToast('Pin removed.', function () {
            mutate(function () { d.pins.splice(Math.min(idx, d.pins.length), 0, removedPin); }, { label: 'restore pin' });
          });
        });
        pActs.appendChild(pDel);
        pHead.appendChild(pActs);
        pCard.appendChild(pHead);

        pCard.appendChild(fieldText('Pin Title', (pin.label && pin.label[lang]) || '', function (v) {
          mutate(function () { pin.label = Model.setLocalized(pin.label, lang, v); }, { recordUndo: false });
        }));
        pCard.appendChild(fieldText('Pin Explanation', (pin.detail && pin.detail[lang]) || '', function (v) {
          mutate(function () { pin.detail = Model.setLocalized(pin.detail, lang, v); }, { recordUndo: false });
        }, true));

        // Pin color swatches
        var swRow = document.createElement('div');
        swRow.className = 'el-swatch-row';
        (Model.HOTSPOT_PIN_COLORS || []).forEach(function (col) {
          var swBtn = document.createElement('button');
          swBtn.type = 'button';
          swBtn.className = 'el-swatch-btn' + ((pin.color || '#0072CE').toUpperCase() === col.hex ? ' is-active' : '');
          swBtn.style.backgroundColor = col.hex;
          swBtn.title = col.label;
          swBtn.setAttribute('aria-label', 'Pin ' + (idx + 1) + ' color: ' + col.label);
          swBtn.addEventListener('click', function () {
            mutate(function () { pin.color = col.hex; }, { label: 'change pin color' });
          });
          swRow.appendChild(swBtn);
        });
        pCard.appendChild(swRow);

        // X/Y coordinate inputs
        var coordRow = document.createElement('div');
        coordRow.className = 'el-coord-row';
        ['x', 'y'].forEach(function (axis) {
          var cw = document.createElement('div');
          cw.className = 'el-field';
          var cl = document.createElement('label');
          cl.textContent = axis.toUpperCase() + ' %';
          var ci = document.createElement('input');
          ci.type = 'number';
          ci.min = '2';
          ci.max = '98';
          ci.value = String(Math.round(pin[axis] ?? 50));
          ci.addEventListener('input', function () {
            var nv = Math.max(2, Math.min(98, Number(ci.value) || 50));
            mutate(function () { pin[axis] = nv; }, { recordUndo: false });
          });
          cw.append(cl, ci);
          coordRow.appendChild(cw);
        });
        pCard.appendChild(coordRow);
        inspectorBodyEl.appendChild(pCard);
      });
    } else if (blk.type === 'balance_scale') {
      locField('Left Label (Load)', 'loadLabel', false);
      locField('Right Label (Resources)', 'resourceLabel', false);
      (d.factors || []).forEach(function (f, idx) {
        inspectorBodyEl.appendChild(fieldText('Factor ' + (idx + 1), f.label[lang], function (v) {
          mutate(function () { f.label = Model.setLocalized(f.label, lang, v); }, { recordUndo: false });
        }));
        inspectorBodyEl.appendChild(fieldSelect('Side', f.category || 'load', [['load', 'Load (Draaglast)'], ['resource', 'Resource (Draagkracht)']], function (v) {
          mutate(function () { f.category = v; }, { label: 'change factor side' });
        }));
      });
      var addFac = document.createElement('button');
      addFac.type = 'button';
      addFac.className = 'el-btn el-btn-sm';
      addFac.textContent = '+ Add Factor';
      addFac.addEventListener('click', function () {
        mutate(function () { d.factors.push({ id: Model.uid('opt'), label: Model.loc('', '', ''), category: 'resource' }); }, { label: 'add balance factor' });
      });
      inspectorBodyEl.appendChild(addFac);
      locField('Tip: High Load', 'overloadTip', true);
      locField('Tip: Balanced', 'balancedTip', true);
    } else if (blk.type === 'bps_triad') {
      locField('Bio Explanation', 'bioBody', true);
      locField('Psycho Explanation', 'psychoBody', true);
      locField('Social Explanation', 'socialBody', true);
    } else if (blk.type === 'mini_plan') {
      (d.suggestions || []).forEach(function (sug, idx) {
        inspectorBodyEl.appendChild(fieldText('Step Suggestion ' + (idx + 1), sug.label[lang], function (v) {
          mutate(function () { sug.label = Model.setLocalized(sug.label, lang, v); }, { recordUndo: false });
        }));
      });
      var addSug = document.createElement('button');
      addSug.type = 'button';
      addSug.className = 'el-btn el-btn-sm';
      addSug.textContent = '+ Add Suggestion';
      addSug.addEventListener('click', function () {
        mutate(function () { d.suggestions.push({ id: Model.uid('opt'), label: Model.loc('', '', '') }); }, { label: 'add suggestion' });
      });
      inspectorBodyEl.appendChild(addSug);
      inspectorBodyEl.appendChild(fieldCheck('Allow learner custom step', d.allowCustom !== false, function (v) {
        mutate(function () { d.allowCustom = v; }, { label: 'toggle custom goal' });
      }));
    } else if (blk.type === 'custom_visual') {
      inspectorBodyEl.appendChild(fieldSelect('Visual Mode', d.preset || 'placeholder', [
        ['placeholder', 'Coding Agent Blueprint Slot'],
        ['alarm-dial', 'Built-in: Pain Alarm Volume Dial'],
        ['breathing-circle', 'Built-in: Calm Guided Breathing'],
        ['custom-svg', 'Pasted Custom SVG Artwork'],
      ], function (v) { mutate(function () { d.preset = v; }, { label: 'change visual preset' }); }));
      inspectorBodyEl.appendChild(fieldSelect('Stage Height', d.height || 'medium', [
        ['compact', 'Compact (180px)'],
        ['medium', 'Medium (260px)'],
        ['tall', 'Tall (360px)'],
      ], function (v) { mutate(function () { d.height = v; }, { label: 'change visual height' }); }));
      inspectorBodyEl.appendChild(fieldText('Slot ID (reference for coding agent)', d.slotId || '', function (v) {
        mutate(function () { d.slotId = v; }, { recordUndo: false });
      }));
      inspectorBodyEl.appendChild(fieldText('Coding Agent Design Brief', d.agentBrief || '', function (v) {
        mutate(function () { d.agentBrief = v; }, { recordUndo: false });
      }, true));
      if (d.preset === 'custom-svg') {
        inspectorBodyEl.appendChild(fieldText('Sanitized SVG Markup (<svg>…</svg>)', d.svgMarkup || '', function (v) {
          mutate(function () { d.svgMarkup = v; }, { recordUndo: false });
        }, true));
      }
      locField('Accessible Alt Description', 'alt', false);
    }

    // S-06: Move block to another step / station
    var allDestinations = [];
    (state.exp.modules || []).forEach(function (m, mi) {
      (m.steps || []).forEach(function (s, si) {
        if (s.id === pair.step.id) return;
        allDestinations.push([m.id + '::' + s.id, 'Station ' + (mi + 1) + ' · Step ' + (si + 1) + ' — ' + (Model.getLocalized(s.title, lang, defLang) || 'Step')]);
      });
    });
    if (allDestinations.length) {
      var mvHead = document.createElement('div');
      mvHead.className = 'el-insp-section-title';
      mvHead.textContent = 'Organize Block';
      inspectorBodyEl.appendChild(mvHead);
      inspectorBodyEl.appendChild(fieldSelect('Move block to another step…', '', [['', 'Choose destination step…']].concat(allDestinations), function (destKey) {
        if (!destKey) return;
        var parts = destKey.split('::');
        var targetMod = (state.exp.modules || []).find(function (m) { return m.id === parts[0]; });
        var targetStep = targetMod && (targetMod.steps || []).find(function (s) { return s.id === parts[1]; });
        if (!targetStep) return;
        mutate(function () {
          var curIdx = (pair.step.blocks || []).findIndex(function (b) { return b.id === blk.id; });
          if (curIdx < 0) return;
          var movedBlk = pair.step.blocks.splice(curIdx, 1)[0];
          targetStep.blocks.push(movedBlk);
          if (targetStep.status === 'empty') targetStep.status = 'draft';
          state.selectedTarget = { type: 'step', moduleId: targetMod.id, stepId: targetStep.id };
          state.selectedBlockId = movedBlk.id;
        }, { label: 'move block to another step' });
        showToast('Block moved to ' + (Model.getLocalized(targetStep.title, lang, defLang) || 'step'));
      }));
    }
  }

  /* ---- Split-Screen German Translation Studio with Live Slide Preview & Autosave ---- */
  function renderTranslatePreviewInto(stageEl) {
    if (!state.exp || !stageEl) return;
    var scrollPos = translatePreviewPane ? translatePreviewPane.scrollTop : 0;
    var openDetailsIdx = [];
    stageEl.querySelectorAll('details').forEach(function (dEl, i) { if (dEl.open) openDetailsIdx.push(i); });

    var langTag = document.getElementById('el-tr-preview-lang-tag');
    if (langTag) langTag.textContent = state.trTarget.toUpperCase();
    stageEl.lang = state.trTarget;
    stageEl.setAttribute('data-xped-theme', (state.exp.theme && state.exp.theme.preset) || 'xped-warm-sand');

    var ctx = state.trActiveContext;
    var allRows = Model.extractTranslationRows(state.exp, state.trSource, state.trTarget);
    var contextRows = allRows.filter(function (r) {
      if (ctx.type === 'startPage') return r.key.indexOf('startPage') === 0;
      return r.key.indexOf('mod.' + ctx.moduleId + '.stp.' + ctx.stepId) === 0;
    });
    var fallbackRows = contextRows.filter(function (r) {
      var liveVal = state.trPendingTexts[r.key] !== undefined ? state.trPendingTexts[r.key] : r.target;
      return !String(liveVal || '').trim() && String(r.source || '').trim();
    });

    function prependFallbackBar(container) {
      if (!fallbackRows.length) return;
      var fbBar = document.createElement('div');
      fbBar.className = 'el-tr-fallback-bar';
      fallbackRows.slice(0, 5).forEach(function (fr) {
        var pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'el-tr-fallback-pill';
        var shortLoc = fr.location.split(' · ').slice(-1)[0] || fr.location;
        pill.textContent = '[' + (state.exp.defaultLanguage || 'nl').toUpperCase() + ' fallback] ' + shortLoc;
        pill.title = 'Jump to untranslated field: ' + fr.location;
        pill.addEventListener('click', function () {
          var sheet = document.getElementById('el-tr-preview-dialog');
          if (sheet && sheet.open) sheet.close();
          jumpToTranslationField(fr.key);
        });
        fbBar.appendChild(pill);
      });
      container.insertBefore(fbBar, container.firstChild);
    }

    if (ctx.type === 'startPage') {
      RouteMap.renderStartPage(stageEl, {
        exp: state.exp,
        lang: state.trTarget,
        editable: false,
        assetUrl: assetUrl, setMediaSource: setMediaSource,
      });
      prependFallbackBar(stageEl);
      if (translatePreviewPane) translatePreviewPane.scrollTop = scrollPos;
      return;
    }
    var mod = (state.exp.modules || []).find(function (m) { return m.id === ctx.moduleId; });
    var step = mod && (mod.steps || []).find(function (s) { return s.id === ctx.stepId; });
    if (!mod || !step) {
      RouteMap.renderStartPage(stageEl, { exp: state.exp, lang: state.trTarget, editable: false, assetUrl: assetUrl, setMediaSource: setMediaSource });
      return;
    }
    stageEl.textContent = '';
    prependFallbackBar(stageEl);
    var card = document.createElement('div');
    card.className = 'xped-card domain-accent-' + (mod.domain || 'general');
    var h1 = document.createElement('h1');
    h1.className = 'xped-step-title';
    var stTitle = Model.getLocalized(step.title, state.trTarget, state.exp.defaultLanguage);
    h1.textContent = stTitle;
    card.appendChild(h1);
    var stack = document.createElement('div');
    stack.className = 'xped-blocks-stack';
    (step.blocks || []).forEach(function (blk) {
      stack.appendChild(Blocks.renderBlock(blk, {
        lang: state.trTarget,
        defaultLang: state.exp.defaultLanguage,
        stepTitle: stTitle,
        interactive: false,
        highlightBlockId: ctx.blockId || '',
        assetUrl: assetUrl, setMediaSource: setMediaSource,
      }));
    });
    card.appendChild(stack);
    stageEl.appendChild(card);
    stageEl.querySelectorAll('details').forEach(function (dEl, i) {
      if (openDetailsIdx.indexOf(i) >= 0) dEl.open = true;
    });
    if (translatePreviewPane && stageEl === translatePreviewStage) {
      translatePreviewPane.scrollTop = scrollPos;
    }
  }

  function renderTranslatePreview() {
    if (!state.exp || !state.trShowPreview) return;
    renderTranslatePreviewInto(translatePreviewStage);
  }

  function scheduleTranslatePreview() {
    clearTimeout(state.trPreviewTimer);
    state.trPreviewTimer = setTimeout(function () {
      renderTranslatePreview();
    }, 180);
  }

  function jumpToTranslationField(fieldKey) {
    var rowEl = translateRowsEl.querySelector('.el-tr-row[data-field-key="' + CSS.escape(fieldKey) + '"]');
    if (!rowEl && state.trFilter !== 'all') {
      state.trFilter = 'all';
      trFilterDD.setItems(FILTER_OPTIONS, 'all');
      renderTranslateMode();
      rowEl = translateRowsEl.querySelector('.el-tr-row[data-field-key="' + CSS.escape(fieldKey) + '"]');
    }
    if (!rowEl) return;
    var parentDet = rowEl.closest('details');
    if (parentDet && !parentDet.open) {
      parentDet.open = true;
      if (parentDet.dataset.groupKey) state.trCollapsedGroups[parentDet.dataset.groupKey] = false;
    }
    var ta = rowEl.querySelector('textarea');
    if (ta) {
      ta.focus();
      ta.scrollIntoView({ behavior: ux.prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
    }
  }

  function scheduleTranslateAutosave() {
    translateAutosaveEl.textContent = 'Saving…';
    translateAutosaveEl.className = 'el-status-inline';
    clearTimeout(state.trSaveTimer);
    state.trSaveTimer = setTimeout(saveTranslationsNow, 900);
  }

  function hasPendingTranslations() {
    return Object.keys(state.trPendingTexts).length || Object.keys(state.trPendingMedia).length;
  }

  function saveTranslationsNow() {
    writing = writing.then(persistTranslations);
    return writing;
  }

  async function persistTranslations() {
    if (leavingAccount || !hasPendingTranslations()) return true;
    var target = state.trTarget;
    var previousRevision = state.exp.revision;
    var texts = Object.assign({}, state.trPendingTexts);
    var media = Object.assign({}, state.trPendingMedia);
    try {
      var res = await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/translations', {
        method: 'POST',
        body: JSON.stringify({ targetLanguage: target, textUpdates: texts, mediaUpdates: media }),
      });
      if (res.expedition.revision !== previousRevision + 1) {
        var localRows = Model.extractTranslationRows(res.expedition, state.trSource, target);
        localRows.forEach(function (row) {
          if (Object.hasOwn(state.trPendingTexts, row.key)) row.locObj[target] = state.trPendingTexts[row.key];
        });
        state.exp = res.expedition;
      } else {
        state.exp.revision = res.expedition.revision;
      }
      syncReviewFlags(res.expedition);
      refreshTranslationStatuses();
      // UX-066: Preserve structural undo history by rebasing localized strings instead of wiping undoStack
      rebaseUndoStacksWithTranslations(state.exp, target);
      updateUndoButtons();
      Object.keys(texts).forEach(function (key) {
        if (state.trPendingTexts[key] === texts[key]) delete state.trPendingTexts[key];
      });
      Object.keys(media).forEach(function (key) {
        if (state.trPendingMedia[key] === media[key]) delete state.trPendingMedia[key];
      });
      if (!hasPendingTranslations()) {
        translateAutosaveEl.textContent = 'Saved';
        translateAutosaveEl.className = 'el-status-inline is-live';
        if (saveVersion === savedVersion) setSaveStatus('Saved', true, false);
      }
      return true;
    } catch (err) {
      translateAutosaveEl.textContent = 'Save failed';
      showToast(err.message, 'error');
      return false;
    }
  }

  function renderTranslateGlossary() {
    var body = document.getElementById('el-tr-glossary-body');
    var sum = document.getElementById('el-tr-glossary-summary');
    if (!body) return;
    var items = (state.exp && state.exp.glossary && state.exp.glossary.length)
      ? state.exp.glossary
      : (Model.DEFAULT_GLOSSARY || []);
    if (sum) sum.textContent = items.length + ' shared pain-science terms';
    body.textContent = '';
    items.forEach(function (term) {
      var chip = document.createElement('span');
      chip.className = 'el-glossary-chip';
      var srcT = term[state.trSource] || term.nl || '';
      var tgtT = term[state.trTarget] || term.de || term.en || '';
      chip.appendChild(document.createTextNode(srcT + ' → '));
      var st = document.createElement('strong');
      st.textContent = tgtT;
      chip.appendChild(st);
      body.appendChild(chip);
    });
  }

  function renderTranslateMediaOverrides() {
    var host = document.getElementById('el-tr-media-section');
    if (!host || !state.exp) return;
    host.textContent = '';
    var mediaRows = Model.extractMediaTranslationRows(state.exp, state.trTarget);
    if (!mediaRows.length) return;
    var card = document.createElement('div');
    card.className = 'el-tr-media-card';
    var h = document.createElement('strong');
    h.textContent = 'Localized Videos & Media (' + state.trTarget.toUpperCase() + ')';
    card.appendChild(h);
    var hint = document.createElement('p');
    hint.className = 'xped-caption';
    hint.textContent = 'Optional: keep the original video or paste a ' + state.trTarget.toUpperCase() + '-subtitled YouTube/Vimeo link.';
    card.appendChild(hint);

    mediaRows.forEach(function (mr) {
      var row = document.createElement('div');
      row.className = 'el-field';
      var lbl = document.createElement('label');
      lbl.textContent = mr.location + ' (Default: ' + mr.sourceUrl + ')';
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.placeholder = 'Paste ' + state.trTarget.toUpperCase() + ' YouTube/Vimeo URL (leave blank to reuse default)';
      inp.value = mr.targetUrl || '';
      inp.addEventListener('input', function () {
        var val = inp.value.trim();
        state.trPendingMedia[mr.blockId] = val;
        var overrides = mr.block.data.mediaOverrides || (mr.block.data.mediaOverrides = {});
        if (val) overrides[state.trTarget] = Object.assign({ url: val }, Model.parseVideoUrl(val));
        else delete overrides[state.trTarget];
        scheduleTranslateAutosave();
      });
      row.appendChild(lbl);
      row.appendChild(inp);
      card.appendChild(row);
    });
    host.appendChild(card);
  }

  function focusNextMissingTranslation() {
    var tas = Array.prototype.slice.call(translateRowsEl.querySelectorAll('textarea.xped-textarea'));
    if (!tas.length) {
      showToast('All fields in this view are translated!');
      return;
    }
    // UX-061: Track last active key independently of focus so toolbar button clicks still advance from current row
    var activeIdx = tas.indexOf(document.activeElement);
    if (activeIdx < 0 && state.trLastActiveKey) {
      activeIdx = tas.findIndex(function (t) {
        var r = t.closest('.el-tr-row');
        return r && r.dataset.fieldKey === state.trLastActiveKey;
      });
    }
    for (var i = 1; i <= tas.length; i += 1) {
      var candidate = tas[(activeIdx + i) % tas.length];
      var rowNode = candidate.closest('.el-tr-row');
      if (!candidate.value.trim() || (rowNode && rowNode.dataset.status === 'needs_review')) {
        // UX-062: Open any collapsed ancestor group before focusing
        var parentDet = candidate.closest('details');
        if (parentDet && !parentDet.open) {
          parentDet.open = true;
          if (parentDet.dataset.groupKey) state.trCollapsedGroups[parentDet.dataset.groupKey] = false;
        }
        candidate.focus();
        candidate.scrollIntoView({ behavior: ux.prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
        return;
      }
    }
    showToast('All visible fields are translated!');
  }

  function updateTranslationProgress(rows) {
    var stats = Model.getTranslationStats(rows);
    translateProgressEl.textContent = state.trTarget.toUpperCase() + ': ' + stats.translated + ' / ' + stats.total + ' translated' + (stats.review ? (' · ' + stats.review + ' to review') : '');
  }

  function updateTranslationBadge(rowElement, badge, status) {
    rowElement.dataset.status = status;
    badge.className = 'el-status-inline ' + (status === 'translated' ? 'is-live' : (status === 'needs_review' ? 'is-warn' : ''));
    badge.textContent = status === 'needs_review' ? 'Review' : (status === 'translated' ? 'Done' : 'Missing');
  }

  function refreshTranslationStatuses() {
    var rows = Model.extractTranslationRows(state.exp, state.trSource, state.trTarget);
    var byKey = new Map(rows.map(function (row) { return [row.key, row.status]; }));
    translateRowsEl.querySelectorAll('.el-tr-row').forEach(function (node) {
      updateTranslationBadge(node, node.querySelector('.el-status-inline'), byKey.get(node.dataset.fieldKey) || 'untranslated');
    });
    updateTranslationProgress(rows);
  }

  function renderTranslateMode() {
    if (!state.exp) return;
    document.querySelector('#el-tr-welcome p').hidden = (state.role !== 'translate' && !grantToken);
    var manageLangsBtn = document.getElementById('el-tr-manage-langs');
    if (manageLangsBtn) manageLangsBtn.hidden = !canEditStructure();
    var altBtn = document.getElementById('el-tr-alt-toggle');
    if (altBtn) altBtn.setAttribute('aria-pressed', String(!!state.trShowAltLang));
    document.getElementById('el-tr-toggle-preview').setAttribute('aria-pressed', String(state.trShowPreview));
    translatePreviewPane.hidden = !state.trShowPreview;
    translateSplit.classList.toggle('no-preview', !state.trShowPreview);
    renderTranslateGlossary();

    var rows = Model.extractTranslationRows(state.exp, state.trSource, state.trTarget);
    updateTranslationProgress(rows);

    translateRowsEl.textContent = '';
    var filtered = rows.filter(function (r) { return state.trFilter === 'all' || r.status === state.trFilter; });
    if (!filtered.length) {
      // UX-063: Celebratory completion state for Missing/Review filters
      var box = document.createElement('div');
      box.className = 'el-tr-complete';
      var stg = document.createElement('strong');
      stg.textContent = state.trFilter === 'untranslated'
        ? ('All ' + state.trTarget.toUpperCase() + ' fields are translated!')
        : (state.trFilter === 'needs_review' ? 'No fields waiting for review.' : 'No fields match this filter.');
      var desc = document.createElement('p');
      desc.className = 'xped-caption';
      desc.textContent = state.trFilter === 'untranslated'
        ? 'Great work — switch back to All fields anytime to review or refine wording.'
        : 'Everything in this filter is clear.';
      var showAllBtn = document.createElement('button');
      showAllBtn.type = 'button';
      showAllBtn.className = 'el-btn el-btn-sm';
      showAllBtn.textContent = 'Show all fields';
      showAllBtn.addEventListener('click', function () {
        state.trFilter = 'all';
        trFilterDD.setItems(FILTER_OPTIONS, 'all');
        renderTranslateMode();
      });
      box.append(stg, desc);
      if (state.trFilter !== 'all') box.appendChild(showAllBtn);
      translateRowsEl.appendChild(box);
      renderTranslatePreview();
      return;
    }

    var groups = [];
    var groupMap = {};
    filtered.forEach(function (row) {
      var gKey = row.key.indexOf('startPage') === 0 ? 'startPage' : row.key.split('.').slice(0, 2).join('.');
      if (!groupMap[gKey]) {
        var title = 'Start Page';
        var modId = '';
        if (gKey !== 'startPage') {
          modId = gKey.split('.')[1];
          var mod = (state.exp.modules || []).find(function (m) { return m.id === modId; });
          title = mod ? (Model.getLocalized(mod.title, state.trSource, state.exp.defaultLanguage) || 'Station') : 'Station';
        }
        groupMap[gKey] = { key: gKey, title: title, modId: modId, rows: [] };
        groups.push(groupMap[gKey]);
      }
      groupMap[gKey].rows.push(row);
    });

    groups.forEach(function (grp) {
      var det = document.createElement('details');
      det.className = 'el-tr-group';
      det.dataset.groupKey = grp.key;
      // UX-060: Persist collapsed group state across re-renders
      det.open = !state.trCollapsedGroups[grp.key];
      det.addEventListener('toggle', function () {
        state.trCollapsedGroups[grp.key] = !det.open;
      });
      var sum = document.createElement('summary');
      var left = document.createElement('span');
      if (grp.title !== 'Start Page') left.setAttribute('translate', 'no');
      left.textContent = grp.title;
      var cnt = document.createElement('span');
      cnt.className = 'xped-caption';
      cnt.textContent = grp.rows.length + (grp.rows.length === 1 ? ' field' : ' fields');
      sum.appendChild(left);
      sum.appendChild(cnt);
      det.appendChild(sum);

      grp.rows.forEach(function (row) {
        var rEl = document.createElement('div');
        rEl.className = 'el-tr-row';
        rEl.dataset.fieldKey = row.key;

        var rHead = document.createElement('div');
        rHead.className = 'el-tr-row-head';
        var locSpan = document.createElement('strong');
        locSpan.textContent = row.location;
        var rightMeta = document.createElement('div');
        rightMeta.className = 'el-btn-row';
        var st = document.createElement('span');
        updateTranslationBadge(rEl, st, row.status);
        // UX-057: Explicit "Use <SRC> text" button with undo when overwriting non-empty target
        var copySrc = document.createElement('button');
        copySrc.type = 'button';
        copySrc.className = 'el-btn el-btn-sm';
        copySrc.title = 'Insert ' + state.trSource.toUpperCase() + ' source text into target box';
        copySrc.appendChild(Icons.icon('copy', 13));
        copySrc.appendChild(document.createTextNode('Use ' + state.trSource.toUpperCase() + ' text'));
        rightMeta.appendChild(st);
        rightMeta.appendChild(copySrc);
        rHead.appendChild(locSpan);
        rHead.appendChild(rightMeta);

        var pair = document.createElement('div');
        pair.className = 'el-tr-pair';
        var srcBox = document.createElement('div');
        srcBox.setAttribute('translate', 'no');
        srcBox.lang = state.trSource;
        srcBox.className = 'el-tr-source';
        var srcPrimary = document.createElement('div');
        srcPrimary.textContent = row.source || '(empty)';
        srcBox.appendChild(srcPrimary);
        // UX-064: Show 3rd-language reference only when enabled
        if (state.trShowAltLang && row.altSource) {
          var altRef = document.createElement('div');
          altRef.className = 'el-tr-alt-ref';
          var altTag = document.createElement('strong');
          altTag.textContent = row.altLang.toUpperCase() + ':';
          altRef.appendChild(altTag);
          altRef.appendChild(document.createTextNode(row.altSource));
          srcBox.appendChild(altRef);
        }

        var ta = document.createElement('textarea');
        ta.className = 'xped-textarea';
        ta.lang = state.trTarget;
        ta.setAttribute('aria-label', row.location + ' (' + state.trTarget.toUpperCase() + ')');
        ta.rows = row.source.length > 90 ? 3 : 2;
        // UX-065: Clean placeholder without repeating shortcut
        ta.placeholder = 'Write ' + state.trTarget.toUpperCase() + ' translation…';
        ta.value = state.trPendingTexts[row.key] !== undefined ? state.trPendingTexts[row.key] : row.target;

        var rowExp = state.exp;
        function updateLocalizedText(value) {
          var activeRow = rowExp === state.exp ? row : Model.extractTranslationRows(state.exp, state.trSource, state.trTarget).find(function (item) { return item.key === row.key; });
          if (activeRow) activeRow.locObj[state.trTarget] = value;
          state.trPendingTexts[row.key] = value;
        }
        function focusContext() {
          state.trLastActiveKey = row.key;
          document.querySelectorAll('.el-tr-row.is-active').forEach(function (n) { n.classList.remove('is-active'); });
          rEl.classList.add('is-active');
          if (row.key.indexOf('startPage') === 0) {
            state.trActiveContext = { type: 'startPage', moduleId: '', stepId: '', blockId: '' };
          } else {
            var parts = row.key.split('.');
            state.trActiveContext = { type: 'step', moduleId: parts[1] || '', stepId: parts[3] || '', blockId: row.blockId || '' };
          }
          renderTranslatePreview();
        }
        ta.addEventListener('focus', focusContext);
        ta.addEventListener('keydown', function (ev) {
          if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
            ev.preventDefault();
            focusNextMissingTranslation();
          }
        });
        ta.addEventListener('input', function () {
          state.trLastActiveKey = row.key;
          updateLocalizedText(ta.value);
          updateTranslationBadge(rEl, st, ta.value.trim() ? 'translated' : 'untranslated');
          scheduleTranslatePreview();
          scheduleTranslateAutosave();
        });
        // UX-068: Reconcile filter membership gently on blur if row no longer matches active filter
        ta.addEventListener('blur', function () {
          if (state.trFilter === 'untranslated' && ta.value.trim()) {
            refreshTranslationStatuses();
          }
        });
        copySrc.addEventListener('click', function () {
          var prevVal = ta.value;
          ta.value = row.source;
          updateLocalizedText(ta.value);
          focusContext();
          scheduleTranslateAutosave();
          if (prevVal.trim() && prevVal !== row.source) {
            showToast('Replaced with ' + state.trSource.toUpperCase() + ' text.', function () {
              ta.value = prevVal;
              updateLocalizedText(prevVal);
              scheduleTranslatePreview();
              scheduleTranslateAutosave();
            });
          }
        });

        pair.appendChild(srcBox);
        pair.appendChild(ta);
        rEl.appendChild(rHead);
        rEl.appendChild(pair);
        det.appendChild(rEl);
      });
      translateRowsEl.appendChild(det);
    });

    renderTranslateMediaOverrides();
    renderTranslatePreview();
  }

  /* ---- Full Interactive Preview Sandbox (UX-069..072, UX-077..079) ---- */
  function evalPreviewBranching(mod, step) {
    var rules = step.branching || [];
    for (var i = 0; i < rules.length; i += 1) {
      var rule = rules[i];
      var val = state.previewPos.answers[rule.blockId];
      if (!Model.hasMeaningfulAnswer(val)) continue;
      var matched = false;
      if (rule.operator === 'equals') matched = Array.isArray(val) ? val.indexOf(rule.value) >= 0 : String(val) === String(rule.value);
      else if (rule.operator === 'lte') matched = Number(val) <= Number(rule.value);
      else if (rule.operator === 'gte') matched = Number(val) >= Number(rule.value);
      if (matched) {
        var idx = (mod.steps || []).findIndex(function (s) { return s.id === rule.targetStepId; });
        if (idx >= 0) return idx;
      }
    }
    return -1;
  }

  function mockPreviewAggregate(blk) {
    if (!state.previewSamplePeers) return Promise.resolve(null);
    if (blk.type === 'mcq') {
      var counts = {};
      var total = 24;
      (blk.data.options || []).forEach(function (o, i) {
        counts[o.id] = Math.max(2, Math.round(total / Math.max(1, (blk.data.options || []).length)) + (i === 0 ? 4 : -1));
      });
      return Promise.resolve({ type: 'mcq', count: total, counts: counts });
    }
    if (blk.type === 'scale') {
      var mid = Math.round(((blk.data.min ?? 0) + (blk.data.max ?? 10)) / 2 * 10) / 10;
      return Promise.resolve({ type: 'scale', count: 18, average: mid + 0.6 });
    }
    if (blk.type === 'wordcloud') {
      return Promise.resolve({
        type: 'wordcloud',
        count: 16,
        words: [
          { word: 'begrip', count: 9 },
          { word: 'rust', count: 7 },
          { word: 'bewegen', count: 6 },
          { word: 'vertrouwen', count: 4 },
        ],
      });
    }
    return Promise.resolve(null);
  }

  function renderPreviewMode() {
    if (!state.exp) return;
    var pLang = state.previewLang || state.editLang;
    var defLang = state.exp.defaultLanguage || 'nl';
    previewContainerEl.lang = pLang;
    previewContainerEl.setAttribute('data-xped-theme', (state.exp.theme && state.exp.theme.preset) || 'xped-warm-sand');
    previewContainerEl.classList.toggle('is-mobile', state.previewViewport === 'mobile');
    previewContainerEl.textContent = '';
    var visibleMods = (state.exp.modules || []).filter(function (m) { return m.visibleToLearners !== false; });

    if (state.previewPos.view === 'start' || !visibleMods.length) {
      RouteMap.renderStartPage(previewContainerEl, {
        exp: state.exp,
        lang: pLang,
        editable: false,
        completedModuleIds: state.previewPos.completedIds || [],
        assetUrl: assetUrl, setMediaSource: setMediaSource,
        onStart: function () {
          state.previewPos.view = 'step';
          state.previewPos.modIdx = 0;
          state.previewPos.stepIdx = 0;
          state.previewPos.navDir = 'next';
          state.previewPos.navHistory = [];
          renderPreviewMode();
        },
        onSelectModule: function (_m, idx) {
          state.previewPos.view = 'step';
          state.previewPos.modIdx = idx;
          state.previewPos.stepIdx = 0;
          state.previewPos.navDir = 'next';
          state.previewPos.navHistory = [];
          renderPreviewMode();
        },
      });
      return;
    }

    // UX-070: Real completion summary view at the end of Preview
    if (state.previewPos.view === 'summary') {
      var sumCard = document.createElement('div');
      sumCard.className = 'xped-card anim-next';
      var sh1 = document.createElement('h1');
      sh1.className = 'xped-step-title';
      sh1.textContent = Model.ui(pLang, 'summaryTitle');
      var sSub = document.createElement('p');
      sSub.className = 'xped-caption';
      sSub.textContent = Model.ui(pLang, 'summarySubtitle');
      sumCard.append(sh1, sSub);

      var ansCount = Object.keys(state.previewPos.answers || {}).filter(function (k) {
        return Model.hasMeaningfulAnswer(state.previewPos.answers[k]);
      }).length;
      var noteP = document.createElement('p');
      noteP.textContent = 'Preview completed · ' + visibleMods.length + ' station(s) · ' + ansCount + ' answered activity block(s).';
      sumCard.appendChild(noteP);

      var sNav = document.createElement('div');
      sNav.className = 'el-player-nav';
      var sStart = document.createElement('button');
      sStart.type = 'button';
      sStart.className = 'xped-btn xped-btn-secondary';
      sStart.textContent = Model.ui(pLang, 'restart');
      sStart.addEventListener('click', function () {
        state.previewPos.view = 'start';
        renderPreviewMode();
      });
      var sReplay = document.createElement('button');
      sReplay.type = 'button';
      sReplay.className = 'xped-btn xped-btn-sun';
      sReplay.textContent = Model.ui(pLang, 'replayFresh');
      sReplay.addEventListener('click', function () {
        state.previewPos = { view: 'start', modIdx: 0, stepIdx: 0, navDir: 'next', navHistory: [], answers: {}, completedIds: [] };
        renderPreviewMode();
      });
      sNav.append(sStart, sReplay);
      sumCard.appendChild(sNav);
      previewContainerEl.appendChild(sumCard);
      return;
    }

    var mod = visibleMods[state.previewPos.modIdx] || visibleMods[0];
    if (state.previewPos.view === 'milestone') {
      var mCard = document.createElement('div');
      mCard.className = 'xped-card domain-accent-' + (mod.domain || 'general') + ' anim-next el-milestone-preview';
      var mh = document.createElement('h1');
      mh.className = 'xped-step-title';
      mh.textContent = Model.ui(pLang, 'milestoneTitle');
      var mp = document.createElement('p');
      mp.textContent = Model.getLocalized(mod.milestoneMessage, pLang, defLang) || Model.getLocalized(mod.title, pLang, defLang);
      var mBtn = document.createElement('button');
      mBtn.type = 'button';
      mBtn.className = 'xped-btn xped-btn-sun';
      mBtn.textContent = Model.ui(pLang, 'milestoneNext');
      mBtn.addEventListener('click', function () {
        state.previewPos.modIdx += 1;
        state.previewPos.stepIdx = 0;
        state.previewPos.navDir = 'next';
        state.previewPos.view = 'step';
        renderPreviewMode();
      });
      mCard.append(mh, mp, mBtn);
      previewContainerEl.appendChild(mCard);
      return;
    }

    var step = (mod.steps || [])[state.previewPos.stepIdx] || (mod.steps || [])[0];
    if (!step) { state.previewPos.view = 'start'; renderPreviewMode(); return; }

    // UX-072: Directional animation anim-next vs anim-prev
    var card = document.createElement('div');
    card.className = 'xped-card domain-accent-' + (mod.domain || 'general') + (state.previewPos.navDir === 'prev' ? ' anim-prev' : ' anim-next');

    // UX-078: Station & step breadcrumb inside Preview matching live Player
    var pvKicker = document.createElement('div');
    pvKicker.className = 'xped-step-kicker-row';
    var pvCrumb = document.createElement('span');
    pvCrumb.className = 'xped-step-crumb';
    var pvDot = document.createElement('span');
    pvDot.className = 'xped-domain-dot domain-' + (mod.domain || 'general');
    pvCrumb.append(pvDot, document.createTextNode(Model.getLocalized(mod.title, pLang, defLang) || ('Station ' + (state.previewPos.modIdx + 1))));
    pvKicker.appendChild(pvCrumb);
    if ((mod.steps || []).length > 1) {
      var pvSegs = document.createElement('span');
      pvSegs.textContent = Model.ui(pLang, 'stepOf', { cur: state.previewPos.stepIdx + 1, total: mod.steps.length });
      pvKicker.appendChild(pvSegs);
    }
    card.appendChild(pvKicker);

    var h1 = document.createElement('h1');
    h1.className = 'xped-step-title';
    var stTitle = Model.getLocalized(step.title, pLang, defLang);
    h1.textContent = stTitle;
    card.appendChild(h1);

    var interactiveTypes = { mcq: 1, myth_fact: 1, scale: 1, reflection: 1, wordcloud: 1, ranking: 1, hotspot: 1, balance_scale: 1, mini_plan: 1 };
    function hasAnyPreviewAnswer() {
      return (step.blocks || []).some(function (b) {
        return interactiveTypes[b.type] && Model.hasMeaningfulAnswer(state.previewPos.answers[b.id]);
      });
    }
    var stepHasAnswered = hasAnyPreviewAnswer();

    var stack = document.createElement('div');
    stack.className = 'xped-blocks-stack';
    (step.blocks || []).forEach(function (blk) {
      stack.appendChild(Blocks.renderBlock(blk, {
        lang: pLang,
        defaultLang: defLang,
        stepTitle: stTitle,
        interactive: true,
        stepHasAnswered: stepHasAnswered,
        answers: state.previewPos.answers,
        fetchAggregate: state.previewSamplePeers ? function () { return mockPreviewAggregate(blk); } : null,
        onAnswer: function (bid, val) {
          state.previewPos.answers[bid] = val;
          var nowAns = hasAnyPreviewAnswer();
          stack.querySelectorAll('[data-reveal-after="1"]').forEach(function (node) {
            node.classList.toggle('xped-reveal-locked', !nowAns);
            node.classList.toggle('xped-reveal-unlocked', nowAns);
          });
        },
        assetUrl: assetUrl, setMediaSource: setMediaSource,
      }));
    });
    card.appendChild(stack);

    var nav = document.createElement('div');
    nav.className = 'el-player-nav';
    var prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'xped-btn xped-btn-secondary';
    prevBtn.appendChild(Icons.icon('arrowLeft', 16));
    prevBtn.appendChild(document.createTextNode(Model.ui(pLang, 'back')));
    prevBtn.addEventListener('click', function () {
      state.previewPos.navDir = 'prev';
      // UX-071: Branching-aware back history stack
      if (state.previewPos.navHistory && state.previewPos.navHistory.length) {
        var backTo = state.previewPos.navHistory.pop();
        state.previewPos.modIdx = backTo.modIdx;
        state.previewPos.stepIdx = backTo.stepIdx;
        state.previewPos.view = 'step';
      } else if (state.previewPos.stepIdx > 0) {
        state.previewPos.stepIdx -= 1;
      } else if (state.previewPos.modIdx > 0) {
        state.previewPos.modIdx -= 1;
        state.previewPos.stepIdx = Math.max(0, (visibleMods[state.previewPos.modIdx].steps || []).length - 1);
      } else {
        state.previewPos.view = 'start';
      }
      renderPreviewMode();
    });

    var isLastStep = state.previewPos.stepIdx >= (mod.steps || []).length - 1;
    var isLastMod = state.previewPos.modIdx >= visibleMods.length - 1;
    var nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'xped-btn xped-btn-primary';
    nextBtn.appendChild(document.createTextNode((isLastMod && isLastStep) ? Model.ui(pLang, 'finish') : Model.ui(pLang, 'next')));
    nextBtn.appendChild(Icons.icon('arrowRight', 16));
    nextBtn.addEventListener('click', function () {
      state.previewPos.navDir = 'next';
      state.previewPos.navHistory = state.previewPos.navHistory || [];
      var jump = evalPreviewBranching(mod, step);
      if (jump >= 0 && jump !== state.previewPos.stepIdx) {
        state.previewPos.navHistory.push({ modIdx: state.previewPos.modIdx, stepIdx: state.previewPos.stepIdx });
        state.previewPos.stepIdx = jump;
      } else if (!isLastStep) {
        state.previewPos.navHistory.push({ modIdx: state.previewPos.modIdx, stepIdx: state.previewPos.stepIdx });
        state.previewPos.stepIdx += 1;
      } else {
        if ((state.previewPos.completedIds || []).indexOf(mod.id) < 0) {
          state.previewPos.completedIds.push(mod.id);
        }
        if (!isLastMod) {
          state.previewPos.view = 'milestone';
        } else {
          state.previewPos.view = 'summary';
        }
      }
      renderPreviewMode();
    });
    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);
    card.appendChild(nav);
    previewContainerEl.appendChild(card);
  }

  /* ---- Visual Block Picker Dialog with Live Preview & Localized Search Aliases (UX-101..104) ---- */
  var BLOCK_ICONS = {
    richtext: 'type',
    video: 'video',
    image: 'image',
    audio: 'sliders',
    callout: 'spark',
    story: 'messageCircle',
    sources: 'book',
    mcq: 'checkCircle',
    myth_fact: 'xCircle',
    scale: 'sliders',
    reflection: 'note',
    wordcloud: 'spark',
    ranking: 'list',
    hotspot: 'map',
    balance_scale: 'scale',
    bps_triad: 'compass',
    mini_plan: 'check',
    custom_visual: 'wand',
  };

  function renderPickerPreview(blockType) {
    var previewEl = document.getElementById('el-picker-preview');
    if (!previewEl) return;
    previewEl.textContent = '';
    var sample = Model.createBlock(blockType);
    if (blockType === 'richtext') {
      sample.data.heading = Model.loc('Wat gebeurt er in het zenuwstelsel?', 'What happens in the nervous system?', '');
      sample.data.body = Model.loc('Pijn is een **beschermingssignaal** dat je lichaam waarschuwt.', 'Pain is a **protective signal** from your nervous system.', '');
    } else if (blockType === 'video') {
      var vBox = document.createElement('div');
      vBox.className = 'xped-picker-media-mock';
      vBox.appendChild(Icons.icon('video', 22));
      var vTitle = document.createElement('strong');
      vTitle.textContent = state.editLang === 'nl' ? 'Korte uitlegvideo (YouTube / Vimeo)' : 'Short explainer clip (YouTube / Vimeo)';
      var vCap = document.createElement('span');
      vCap.className = 'xped-caption';
      vCap.textContent = '0:15 – 2:30 · Privacy-enhanced embed';
      vBox.append(vTitle, vCap);
      previewEl.appendChild(vBox);
      return;
    } else if (blockType === 'image') {
      sample.data.media = { kind: 'xped', assetId: '', staticPath: '/static/images/xped/xped-wandelaar-met-kaart.png' };
      sample.data.caption = Model.loc('Stap voor stap op ontdekkingstocht', 'Step by step on your journey', '');
    } else if (blockType === 'audio') {
      sample.data.title = Model.loc('Rustige ademhalingsoefening (2 min)', 'Calm breathing exercise (2 min)', '');
      sample.data.description = Model.loc('Luister op je eigen tempo.', 'Listen at your own pace.', '');
    } else if (blockType === 'callout') {
      sample.data.title = Model.loc('Goed om te onthouden', 'Key takeaway', '');
      sample.data.body = Model.loc('Pijn is altijd echt — ook als weefsel al hersteld is.', 'Pain is always real — even after tissue has healed.', '');
    } else if (blockType === 'story') {
      sample.data.speakerName = 'Inge';
      sample.data.quote = Model.loc('Toen ik begreep hoe het alarmsysteem werkt, durfde ik weer rustig te wandelen.', 'Once I understood the alarm system, I felt safe walking gently again.', '');
    } else if (blockType === 'myth_fact') {
      sample.data.statement = Model.loc('Aanhoudende pijn betekent altijd nieuwe weefselschade.', 'Persistent pain always means new tissue damage.', '');
    } else if (blockType === 'mcq') {
      sample.data.question = Model.loc('Wat helpt jou op een moeilijke dag?', 'What helps you most on a tough day?', '');
    } else if (blockType === 'scale') {
      sample.data.question = Model.loc('Hoeveel vertrouwen heb je om rustig te bewegen?', 'How confident do you feel moving gently?', '');
    } else if (blockType === 'reflection') {
      sample.data.prompt = Model.loc('Welke gedachte neem je mee uit dit station?', 'What thought will you take away from this station?', '');
    } else if (blockType === 'wordcloud') {
      sample.data.question = Model.loc('Welke woorden passen bij pijn voor jou?', 'Which words come to mind about pain?', '');
    } else if (blockType === 'ranking') {
      sample.data.question = Model.loc('Zet op volgorde wat jou het meest helpt', 'Order what helps you most', '');
    } else if (blockType === 'hotspot') {
      sample.data.question = Model.loc('Tik op een punt op de afbeelding', 'Tap a point on the diagram', '');
      sample.data.media = { kind: 'xped', assetId: '', staticPath: '/static/images/xped/xped-brein-mascotte-met-gloeilamp.png' };
    } else if (blockType === 'sources') {
      sample.data.items = [{ id: 'src_prev', citation: Model.loc('Moseley GL & Butler DS. Explain Pain Supercharged (2017).', 'Moseley GL & Butler DS. Explain Pain Supercharged (2017).', ''), url: '10.1016/j.jpain.2015.05.005' }];
    }
    var rendered = Blocks.renderBlock(sample, {
      lang: state.editLang,
      defaultLang: (state.exp && state.exp.defaultLanguage) || 'nl',
      interactive: false,
      editable: false,
      assetUrl: assetUrl,
      setMediaSource: setMediaSource,
    });
    if (rendered) previewEl.appendChild(rendered);
  }

  function renderBlockPickerList(query) {
    var body = document.getElementById('el-picker-body');
    var q = String(query || '').trim().toLowerCase();
    body.textContent = '';
    var anyRendered = false;
    var firstType = '';
    (Model.BLOCK_CATEGORIES || []).forEach(function (cat) {
      var items = Model.BLOCK_CATALOG.filter(function (b) {
        if (b.category !== cat.key) return false;
        if (!q) return true;
        var hay = (b.label + ' ' + b.desc + ' ' + b.type + ' ' + ((b.aliases || []).join(' '))).toLowerCase();
        return hay.indexOf(q) >= 0;
      });
      if (!items.length) return;
      anyRendered = true;
      var sec = document.createElement('div');
      sec.className = 'el-picker-cat';
      var h3 = document.createElement('h3');
      h3.textContent = cat.label;
      sec.appendChild(h3);
      var grid = document.createElement('div');
      grid.className = 'el-picker-grid';
      items.forEach(function (item) {
        if (!firstType) firstType = item.type;
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'el-picker-card';
        var icoBox = document.createElement('span');
        icoBox.className = 'el-picker-ico';
        icoBox.appendChild(Icons.icon(BLOCK_ICONS[item.type] || 'spark', 17));
        var bodyCol = document.createElement('div');
        bodyCol.className = 'el-picker-card-body';
        var st = document.createElement('strong');
        st.textContent = item.label;
        var sp = document.createElement('span');
        sp.textContent = item.desc;
        bodyCol.appendChild(st);
        bodyCol.appendChild(sp);
        btn.appendChild(icoBox);
        btn.appendChild(bodyCol);
        btn.addEventListener('mouseenter', function () { renderPickerPreview(item.type); });
        btn.addEventListener('focus', function () { renderPickerPreview(item.type); });
        btn.addEventListener('click', function () {
          var pair = currentModuleAndStep();
          if (pair.step) {
            var nb = Model.createBlock(item.type);
            state.focusBlockAfterRender = nb.id;
            mutate(function () {
              var idx = state.insertBlockAt >= 0 ? state.insertBlockAt : pair.step.blocks.length;
              pair.step.blocks.splice(idx, 0, nb);
              if (pair.step.status === 'empty') pair.step.status = 'draft';
              state.selectedBlockId = nb.id;
              state.inspectorTab = 'block';
            }, { label: 'add ' + item.label });
          }
          Icons.closeDialogAnimated(blockPickerDialog);
        });
        grid.appendChild(btn);
      });
      sec.appendChild(grid);
      body.appendChild(sec);
    });
    if (firstType) renderPickerPreview(firstType);
    if (!anyRendered) {
      var empty = document.createElement('p');
      empty.className = 'xped-caption';
      empty.textContent = 'No blocks match "' + q + '". Try keywords like YouTube, stelling, bronnen, waage, or slider.';
      body.appendChild(empty);
    }
  }

  function openBlockPicker() {
    var searchInp = document.getElementById('el-picker-search');
    if (searchInp) searchInp.value = '';
    renderBlockPickerList('');
    blockPickerDialog.showModal();
  }

  /* ---- Share, QR & Collaborators Dialog (UX-081..087) ---- */
  function setShareTab(nextTab) {
    state.shareTab = nextTab || 'learners';
    shareDialog.querySelectorAll('.el-share-tab').forEach(function (t) {
      var on = t.getAttribute('data-share-tab') === state.shareTab;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    shareDialog.querySelectorAll('.el-share-panel').forEach(function (p) {
      p.hidden = p.getAttribute('data-share-panel') !== state.shareTab;
    });
  }

  function syncShareActiveVisibility(enabled) {
    var activeBox = document.getElementById('el-share-active-box');
    var inactiveCard = document.getElementById('el-share-inactive-card');
    if (activeBox) activeBox.hidden = !enabled;
    if (inactiveCard) inactiveCard.hidden = !!enabled;
  }

  function updateShareUrlAndQr() {
    var share = (state.shareData && state.shareData.share) || {};
    var cohort = document.getElementById('el-share-cohort').value.trim();
    var url = window.location.origin + '/elearning/p/' + encodeURIComponent(share.token || '');
    if (cohort) url += '?cohort=' + encodeURIComponent(cohort);
    document.getElementById('el-share-url').value = url;
    document.getElementById('el-share-open-link').href = url;
    var qrHost = document.getElementById('el-share-qr');
    qrHost.textContent = '';
    if (share.token) qrHost.appendChild(QR.createSvgElement(url));
    var cohortNote = document.getElementById('el-share-qr-cohort');
    if (cohortNote) {
      cohortNote.hidden = !cohort;
      cohortNote.textContent = cohort ? ('QR includes cohort tag: ' + cohort) : '';
    }
  }

  async function loadShareDialogData() {
    var loadingBox = document.getElementById('el-share-loading');
    var loadingMsg = document.getElementById('el-share-loading-msg');
    var retryBtn = document.getElementById('el-share-retry-btn');
    var contentBox = document.getElementById('el-share-content');
    if (loadingBox) loadingBox.hidden = false;
    if (loadingMsg) loadingMsg.textContent = 'Loading sharing settings…';
    if (retryBtn) retryBtn.hidden = true;
    if (contentBox) contentBox.hidden = true;

    try {
      var data = await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/sharing');
      state.shareData = data;
      var share = data.share || {};
      document.getElementById('el-share-enabled').checked = !!share.enabled;
      document.getElementById('el-share-peer-results').checked = share.showPeerResults !== false;
      document.getElementById('el-share-pilot-feedback').checked = share.collectPilotFeedback !== false;
      var scChk = document.getElementById('el-share-step-comments');
      if (scChk) scChk.checked = !!share.allowStepComments;
      syncShareActiveVisibility(!!share.enabled);
      updateShareUrlAndQr();
      document.getElementById('el-share-cohort').oninput = updateShareUrlAndQr;
      renderMembersList(data.members || []);
      renderGrantsList(data.grants || []);
      setShareTab(state.shareTab);
      if (loadingBox) loadingBox.hidden = true;
      if (contentBox) contentBox.hidden = false;
    } catch (err) {
      if (loadingMsg) loadingMsg.textContent = err.message || 'Could not load sharing settings.';
      if (retryBtn) retryBtn.hidden = false;
    }
  }

  function openShareDialog() {
    if (!expeditionId) return;
    // UX-084: Show dialog shell immediately so clicks never feel unresponsive
    if (!shareDialog.open) shareDialog.showModal();
    loadShareDialogData();
  }

  function renderMembersList(members) {
    var host = document.getElementById('el-members-list');
    host.textContent = '';
    if (!members.length) {
      var none = document.createElement('p');
      none.className = 'xped-caption';
      none.textContent = 'No collaborators invited yet.';
      host.appendChild(none);
      return;
    }
    members.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'el-member-row';
      var lbl = document.createElement('span');
      lbl.textContent = m.email + ' · ' + (m.role === 'translate' ? 'Translator' : 'Co-Editor');
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'el-btn el-btn-danger el-btn-sm';
      rm.textContent = 'Remove';
      rm.setAttribute('aria-label', 'Remove collaborator ' + m.email);
      rm.addEventListener('click', async function () {
        var ok = await showConfirmDialog('Remove collaborator?', 'Remove ' + m.email + ' from this expedition?', 'Remove');
        if (!ok) return;
        var res = await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/sharing', {
          method: 'POST',
          body: JSON.stringify({ action: 'remove_member', email: m.email }),
        });
        renderMembersList(res.members || []);
        showToast('Collaborator removed.');
      });
      row.appendChild(lbl);
      row.appendChild(rm);
      host.appendChild(row);
    });
  }

  function renderGrantsList(grants) {
    var host = document.getElementById('el-grants-list');
    host.textContent = '';
    if (!grants.length) {
      var none = document.createElement('p');
      none.className = 'xped-caption';
      none.textContent = 'No active translator links yet.';
      host.appendChild(none);
      return;
    }
    grants.forEach(function (g) {
      var row = document.createElement('div');
      row.className = 'el-member-row';
      var url = window.location.origin + (g.urlPath || ('/elearning/translate/' + encodeURIComponent(g.token || '')));
      var grantName = (g.label || 'Translator') + ' (' + String(g.targetLanguage || 'de').toUpperCase() + ')';
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.readOnly = true;
      inp.id = 'grant-url-' + g.id;
      inp.value = url;
      inp.setAttribute('aria-label', 'Link for ' + grantName);
      inp.classList.add('el-grant-url');
      var lbl = document.createElement('span');
      lbl.textContent = grantName;

      // UX-085: Named Copy Link button per translator grant
      var cpWrap = document.createElement('span');
      cpWrap.className = 'el-copy-wrap';
      var cpBtn = document.createElement('button');
      cpBtn.type = 'button';
      cpBtn.className = 'el-btn el-btn-sm el-copy-btn';
      cpBtn.setAttribute('command', '--copy');
      cpBtn.setAttribute('commandfor', inp.id);
      cpBtn.setAttribute('aria-label', 'Copy translator link for ' + grantName);
      cpBtn.textContent = 'Copy link';
      var cpTip = document.createElement('span');
      cpTip.className = 'el-copy-tip';
      cpTip.setAttribute('role', 'status');
      cpWrap.append(cpBtn, cpTip);

      // UX-086: Scoped confirmation before revoking grant
      var rev = document.createElement('button');
      rev.type = 'button';
      rev.className = 'el-btn el-btn-danger el-btn-sm';
      rev.textContent = 'Revoke';
      rev.setAttribute('aria-label', 'Revoke translator link for ' + grantName);
      rev.addEventListener('click', async function () {
        var ok = await showConfirmDialog(
          'Revoke translator link?',
          'Revoke "' + grantName + '"? Anyone using that link will immediately lose access.',
          'Revoke link'
        );
        if (!ok) return;
        await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/sharing', {
          method: 'POST',
          body: JSON.stringify({ action: 'revoke_grant', grantId: g.id }),
        });
        showToast('Translator link revoked.');
        loadShareDialogData();
      });
      row.append(lbl, inp, cpWrap, rev);
      host.appendChild(row);
    });
  }

  var unusedDialog = document.getElementById('el-unused-media');
  var unusedFiles = document.getElementById('el-unused-files');
  var unusedStatus = document.getElementById('el-unused-status');
  var unusedRemove = document.getElementById('el-unused-remove');
  var unusedRevision = 0;
  var unusedLoad = 0;
  var removingMedia = false;

  function usesMedia(value, assetId) {
    if (!value || typeof value !== 'object') return false;
    if (value.kind === 'asset' && value.assetId === assetId) return true;
    return Object.values(value).some(function (child) { return usesMedia(child, assetId); });
  }

  function forgetRemovedMedia(assetId) {
    [state.undoStack, state.redoStack].forEach(function (stack) {
      for (var i = stack.length - 1; i >= 0; i--) {
        if (usesMedia(stack[i], assetId)) stack.splice(i, 1);
      }
    });
    updateUndoButtons();
    // Deletion toasts can retain a separate one-click undo snapshot.
    toastEl.querySelector('button')?.remove();
    var url = assetUrl(assetId);
    var cached = privateMedia.get(url);
    if (cached) {
      privateMedia.delete(url);
      cached.then(function (objectUrl) { URL.revokeObjectURL(objectUrl); }).catch(function () {});
    }
  }

  function syncUnusedButton() {
    unusedRemove.disabled = removingMedia || !unusedFiles.querySelector('input:checked');
  }

  function mediaSize(bytes) {
    var small = bytes < 1024 * 1024;
    return new Intl.NumberFormat(document.documentElement.lang || 'en', {
      style: 'unit', unit: small ? 'kilobyte' : 'megabyte', maximumFractionDigits: 1,
    }).format(bytes / (small ? 1024 : 1024 * 1024));
  }

  async function openUnusedMedia() {
    var attempt = ++unusedLoad;
    unusedFiles.replaceChildren();
    unusedRemove.disabled = true;
    unusedStatus.textContent = 'Checking saved media…';
    unusedDialog.showModal();
    try {
      if (uploadsInProgress) throw new Error('Wait for the upload to finish before removing media.');
      await queueStructureSave();
      if (saveVersion !== savedVersion || !state.leaseToken) throw new Error('Save your changes before removing media.');
      var result = await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/assets');
      if (attempt !== unusedLoad || !unusedDialog.open) return;
      if (result.revision !== state.exp.revision) throw new Error('The expedition changed. Reload before removing media.');
      unusedRevision = result.revision;
      result.unused.forEach(function (asset) {
        if (usesMedia(state.exp, asset.id)) return;
        var row = document.createElement('label');
        row.className = 'el-field-check';
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.value = asset.id;
        input.checked = true;
        var label = document.createElement('span');
        label.textContent = asset.filename || (asset.kind === 'audio' ? 'Audio' : 'Image');
        if (asset.filename) label.setAttribute('translate', 'no');
        var size = document.createElement('small');
        size.textContent = mediaSize(asset.size);
        row.append(input, label, size);
        unusedFiles.append(row);
      });
      unusedStatus.textContent = unusedFiles.children.length ? '' : 'There are no unused files to remove.';
      syncUnusedButton();
    } catch (error) {
      if (attempt === unusedLoad) unusedStatus.textContent = error.message;
    }
  }

  unusedFiles.addEventListener('change', syncUnusedButton);
  document.getElementById('el-unused-cancel').addEventListener('click', function () { unusedDialog.close(); });
  unusedDialog.addEventListener('close', function () { unusedLoad++; });
  unusedDialog.addEventListener('cancel', function (event) { if (removingMedia) { event.preventDefault(); event.stopImmediatePropagation(); } });
  unusedRemove.addEventListener('click', async function () {
    var selected = Array.from(unusedFiles.querySelectorAll('input:checked'));
    if (removingMedia || !selected.length || uploadsInProgress) return;
    removingMedia = true;
    unusedRemove.disabled = true;
    unusedDialog.querySelector('form button').disabled = true;
    document.getElementById('el-unused-cancel').disabled = true;
    unusedFiles.inert = true;
    unusedStatus.textContent = 'Removing files…';
    try {
      for (var input of selected) {
        if (usesMedia(state.exp, input.value) || saveVersion !== savedVersion || state.exp.revision !== unusedRevision) {
          throw new Error('The expedition changed. Reload before removing media.');
        }
        var response = await request(assetUrl(input.value), {
          method: 'DELETE', body: JSON.stringify({ lease_token: state.leaseToken, base_revision: unusedRevision }),
        });
        var result = await response.json();
        if (response.ok || result.removalPending || response.status === 404) forgetRemovedMedia(input.value);
        if (!response.ok && response.status !== 404) throw new Error(result.error || 'Could not remove this file.');
        input.closest('label').remove();
      }
      unusedDialog.close();
      showToast('Unused media removed.');
    } catch (error) {
      unusedStatus.textContent = error.message;
    } finally {
      removingMedia = false;
      unusedDialog.querySelector('form button').disabled = false;
      document.getElementById('el-unused-cancel').disabled = false;
      unusedFiles.inert = false;
      syncUnusedButton();
    }
  });

  function refreshMoreMenu() {
    var mediaActions = state.mode === 'edit' && state.leaseToken ? [
      { label: 'Free unused media', icon: 'trash', onClick: openUnusedMedia },
    ] : [];
    moreMenuDD.setItems([
      ...mediaActions,
      {
        label: 'Responses & Analytics',
        icon: 'chart',
        onClick: function () { window.location.href = '/physio/elearning/' + encodeURIComponent(expeditionId) + '/responses'; },
      },
      {
        label: 'Export JSON Backup',
        icon: 'upload',
        onClick: function () {
          if (!state.exp) return;
          var blob = new Blob([JSON.stringify(state.exp, null, 2)], { type: 'application/json' });
          var a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = (state.exp.title || 'xped-expedition').toLowerCase().replace(/[^a-z0-9]+/g, '-') + '.json';
          a.click();
          setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
        },
      },
    ]);
  }

  function renderAll() {
    if (!state.exp) return;
    titleInput.value = state.exp.title || '';
    titleInput.disabled = !canEditStructure() || !state.leaseToken;
    workspace.inert = !state.leaseToken;
    document.getElementById('el-share-btn').hidden = !canEditStructure();
    moreMenuDD.el.hidden = !canEditStructure();
    var editTab = document.querySelector('.el-mode-tab[data-mode="edit"]');
    if (editTab) editTab.hidden = !canEditStructure();
    utilitiesButton.hidden = !canEditStructure();
    document.getElementById('el-undo-btn').hidden = !canEditStructure();
    document.getElementById('el-redo-btn').hidden = !canEditStructure();
    refreshMoreMenu();

    if (state.mode === 'edit') {
      renderOutline();
      renderCanvas();
      renderInspector();
    } else if (state.mode === 'translate') {
      renderTranslateMode();
    } else if (state.mode === 'preview') {
      renderPreviewMode();
    }
  }

  /* On smaller screens the same outline, canvas and inspector share the stage. */
  var workspace = document.getElementById('el-mode-edit');
  function selectPane(pane) {
    workspace.dataset.pane = pane;
    workspace.querySelectorAll('.el-pane-btn').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.dataset.pane === pane));
    });
  }
  workspace.querySelector('.el-pane-nav').addEventListener('click', function (event) {
    var button = event.target.closest('.el-pane-btn');
    if (button) selectPane(button.dataset.pane);
  });
  workspace.querySelector('.el-outline-rail').addEventListener('click', function (event) {
    if (event.target.closest('.el-step-row, .el-module-title-btn, #el-nav-start-page, .el-quiet-add-step')) selectPane('canvas');
  });
  var utilitiesButton = document.getElementById('el-utilities-toggle');
  utilitiesButton.appendChild(Icons.icon('sliders', 17));
  var utilities = document.getElementById('el-editor-utilities');
  utilitiesButton.addEventListener('click', function () {
    utilitiesButton.setAttribute('aria-expanded', String(utilitiesButton.getAttribute('aria-expanded') !== 'true'));
  });
  document.addEventListener('click', function (event) {
    if (!utilities.contains(event.target) && !utilitiesButton.contains(event.target)) utilitiesButton.setAttribute('aria-expanded', 'false');
  });
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && utilitiesButton.getAttribute('aria-expanded') === 'true') {
      utilitiesButton.setAttribute('aria-expanded', 'false');
      utilitiesButton.focus();
    }
  });

  /* ---- Wire Controls ---- */
  titleInput.addEventListener('input', function () {
    mutate(function () { state.exp.title = titleInput.value; }, { recordUndo: false, rerender: false });
  });
  authorNotesEl.addEventListener('input', function () {
    var pair = currentModuleAndStep();
    if (pair.step) mutate(function () { pair.step.authorNotes = authorNotesEl.value; }, { recordUndo: false, rerender: false });
  });
  document.getElementById('el-nav-start-page').addEventListener('click', function () {
    state.selectedTarget = { type: 'startPage' };
    state.selectedBlockId = '';
    state.inspectorTab = 'block';
    renderAll();
  });
  document.getElementById('el-add-module-btn').addEventListener('click', function () {
    // UX-014: Prefill editable Station Name input inside Add Station dialog
    var stNameInp = document.getElementById('el-new-station-name');
    if (stNameInp) {
      stNameInp.value = 'Station ' + (((state.exp && state.exp.modules) || []).length + 1);
    }
    moduleRecipeDialog.showModal();
    if (stNameInp) { stNameInp.focus(); stNameInp.select(); }
  });
  moduleRecipeDialog.querySelectorAll('[data-recipe]').forEach(function (btn) {
    var icoSlot = btn.querySelector('.el-picker-ico');
    var icoName = btn.getAttribute('data-recipe-icon') || 'plus';
    if (icoSlot) icoSlot.appendChild(Icons.icon(icoName, 17));
    btn.addEventListener('click', function () {
      var recipe = btn.getAttribute('data-recipe');
      var stNameInp = document.getElementById('el-new-station-name');
      var customName = stNameInp ? stNameInp.value.trim() : '';
      mutate(function () {
        var mod = Model.createModule(recipe, (state.exp.modules || []).length);
        if (customName) {
          mod.title = Model.setLocalized(mod.title, state.editLang, customName);
        }
        state.exp.modules.push(mod);
        state.selectedTarget = { type: 'step', moduleId: mod.id, stepId: mod.steps[0].id };
        state.selectedBlockId = (mod.steps[0].blocks && mod.steps[0].blocks[0]) ? mod.steps[0].blocks[0].id : '';
      }, { label: 'add station' });
      Icons.closeDialogAnimated(moduleRecipeDialog);
    });
  });

  // UX-106: Coalesce rapid mode transitions cleanly while waiting for saves
  document.querySelectorAll('.el-mode-tab').forEach(function (tab) {
    tab.addEventListener('click', async function () {
      if (!state.exp) return;
      var requested = tab.getAttribute('data-mode');
      state.pendingMode = requested;
      if (state.mode === 'edit' && savedVersion !== saveVersion) {
        clearTimeout(state.saveTimer);
        await queueStructureSave();
        if (savedVersion !== saveVersion) { state.pendingMode = ''; return; }
      }
      if (state.mode === 'translate' && hasPendingTranslations()) {
        clearTimeout(state.trSaveTimer);
        if (!(await saveTranslationsNow()) || hasPendingTranslations()) { state.pendingMode = ''; return; }
      }
      if (state.pendingMode !== requested) return;
      state.pendingMode = '';
      setMode(requested);
    });
  });
  document.querySelectorAll('.el-insp-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      state.inspectorTab = tab.getAttribute('data-insp');
      renderInspector();
    });
  });

  vpDesk.addEventListener('click', function () {
    state.viewport = 'desktop';
    vpDesk.classList.add('is-active');
    vpMob.classList.remove('is-active');
    vpDesk.setAttribute('aria-pressed', 'true');
    vpMob.setAttribute('aria-pressed', 'false');
    renderCanvas();
  });
  vpMob.addEventListener('click', function () {
    state.viewport = 'mobile';
    vpMob.classList.add('is-active');
    vpDesk.classList.remove('is-active');
    vpMob.setAttribute('aria-pressed', 'true');
    vpDesk.setAttribute('aria-pressed', 'false');
    renderCanvas();
  });

  function performUndo() {
    if (!state.undoStack.length) return;
    var entry = state.undoStack.pop();
    state.redoStack.push({ label: entry.label || 'edit', snapshot: clone(state.exp) });
    restoreSnapshot(entry);
    showToast('Undid ' + (entry.label || 'change'));
  }
  function performRedo() {
    if (!state.redoStack.length) return;
    var entry = state.redoStack.pop();
    state.undoStack.push({ label: entry.label || 'edit', snapshot: clone(state.exp) });
    restoreSnapshot(entry);
    showToast('Redid ' + (entry.label || 'change'));
  }
  document.getElementById('el-undo-btn').addEventListener('click', performUndo);
  document.getElementById('el-redo-btn').addEventListener('click', performRedo);
  // S-09: Global Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z respecting native text input undo
  document.addEventListener('keydown', function (event) {
    if (state.mode !== 'edit' || !canEditStructure() || !state.leaseToken) return;
    if (!(event.metaKey || event.ctrlKey) || event.altKey) return;
    var active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
    var key = String(event.key || '').toLowerCase();
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault();
      performUndo();
    } else if ((key === 'z' && event.shiftKey) || key === 'y') {
      event.preventDefault();
      performRedo();
    }
  });

  if (saveRetryBtn) {
    saveRetryBtn.addEventListener('click', function () {
      clearTimeout(state.saveTimer);
      setSaveStatus('Saving…', false, false);
      queueStructureSave();
    });
  }

  document.getElementById('el-takeover-btn').addEventListener('click', function () { acquireLease(true); });
  shareBtn.addEventListener('click', openShareDialog);

  shareDialog.querySelectorAll('.el-share-tab').forEach(function (t) {
    t.addEventListener('click', function () { setShareTab(t.getAttribute('data-share-tab')); });
  });
  var shareRetryBtn = document.getElementById('el-share-retry-btn');
  if (shareRetryBtn) shareRetryBtn.addEventListener('click', loadShareDialogData);

  // UX-082: Serialize share toggle writes and roll back checkbox state on error
  function savePublicShareSettings(extra, changedEl) {
    var enabledEl = document.getElementById('el-share-enabled');
    var peerEl = document.getElementById('el-share-peer-results');
    var pilotEl = document.getElementById('el-share-pilot-feedback');
    var scEl = document.getElementById('el-share-step-comments');
    var prevState = {
      enabled: state.shareData && state.shareData.share ? !!state.shareData.share.enabled : !enabledEl.checked,
      showPeerResults: state.shareData && state.shareData.share ? state.shareData.share.showPeerResults !== false : peerEl.checked,
      collectPilotFeedback: state.shareData && state.shareData.share ? state.shareData.share.collectPilotFeedback !== false : pilotEl.checked,
      allowStepComments: state.shareData && state.shareData.share ? !!state.shareData.share.allowStepComments : !!(scEl && scEl.checked),
    };
    var body = Object.assign({
      action: 'update_public',
      enabled: enabledEl.checked,
      showPeerResults: peerEl.checked,
      collectPilotFeedback: pilotEl.checked,
      allowStepComments: !!(scEl && scEl.checked),
    }, extra || {});
    syncShareActiveVisibility(body.enabled);
    state.shareQueue = state.shareQueue.then(async function () {
      try {
        var res = await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/sharing', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (state.shareData) state.shareData.share = res.share;
        syncShareActiveVisibility(!!(res.share && res.share.enabled));
        updateShareUrlAndQr();
        showToast('Share settings updated.');
      } catch (err) {
        if (changedEl) {
          enabledEl.checked = prevState.enabled;
          peerEl.checked = prevState.showPeerResults;
          pilotEl.checked = prevState.collectPilotFeedback;
          if (scEl) scEl.checked = prevState.allowStepComments;
          syncShareActiveVisibility(prevState.enabled);
        }
        showToast(err.message, 'error');
      }
    });
    return state.shareQueue;
  }
  document.getElementById('el-share-enabled').addEventListener('change', function (e) { savePublicShareSettings(null, e.target); });
  var activateShareBtn = document.getElementById('el-share-activate-btn');
  if (activateShareBtn) {
    activateShareBtn.addEventListener('click', function () {
      var cb = document.getElementById('el-share-enabled');
      cb.checked = true;
      savePublicShareSettings(null, cb);
    });
  }
  document.getElementById('el-share-peer-results').addEventListener('change', function (e) { savePublicShareSettings(null, e.target); });
  document.getElementById('el-share-pilot-feedback').addEventListener('change', function (e) { savePublicShareSettings(null, e.target); });
  var shareStepCommentsEl = document.getElementById('el-share-step-comments');
  if (shareStepCommentsEl) shareStepCommentsEl.addEventListener('change', function (e) { savePublicShareSettings(null, e.target); });

  var pickerSearchEl = document.getElementById('el-picker-search');
  if (pickerSearchEl) pickerSearchEl.addEventListener('input', function () { renderBlockPickerList(pickerSearchEl.value); });

  var nextMissBtn = document.getElementById('el-tr-next-missing');
  if (nextMissBtn) nextMissBtn.addEventListener('click', focusNextMissingTranslation);

  // UX-064: Remembered 3rd-language reference toggle
  var altToggleBtn = document.getElementById('el-tr-alt-toggle');
  if (altToggleBtn) {
    altToggleBtn.addEventListener('click', function () {
      state.trShowAltLang = !state.trShowAltLang;
      try { localStorage.setItem('xped_tr_show_alt', state.trShowAltLang ? '1' : '0'); } catch (_e) {}
      renderTranslateMode();
    });
  }
  // UX-114: Jump from Translate mode straight to Design -> Course Languages
  var manageLangsBtn = document.getElementById('el-tr-manage-langs');
  if (manageLangsBtn) {
    manageLangsBtn.addEventListener('click', async function () {
      if (hasPendingTranslations()) {
        clearTimeout(state.trSaveTimer);
        if (!(await saveTranslationsNow())) return;
      }
      state.inspectorTab = 'theme';
      setMode('edit');
      if (window.matchMedia('(max-width: 920px)').matches) selectPane('inspector');
      var sec = document.getElementById('el-design-languages');
      if (sec) sec.scrollIntoView({ behavior: ux.prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    });
  }

  // UX-069 & UX-079: Preview starting point & sample peer votes toggle
  var pvFromStep = document.getElementById('el-pv-from-step');
  var pvFromStart = document.getElementById('el-pv-from-start');
  if (pvFromStep && pvFromStart) {
    pvFromStep.addEventListener('click', function () {
      state.previewFrom = 'step';
      pvFromStep.classList.add('is-active');
      pvFromStart.classList.remove('is-active');
      pvFromStep.setAttribute('aria-pressed', 'true');
      pvFromStart.setAttribute('aria-pressed', 'false');
      syncPreviewStartPosition();
      renderPreviewMode();
    });
    pvFromStart.addEventListener('click', function () {
      state.previewFrom = 'start';
      pvFromStart.classList.add('is-active');
      pvFromStep.classList.remove('is-active');
      pvFromStart.setAttribute('aria-pressed', 'true');
      pvFromStep.setAttribute('aria-pressed', 'false');
      syncPreviewStartPosition();
      renderPreviewMode();
    });
  }
  var pvSamplePeers = document.getElementById('el-pv-sample-peers');
  if (pvSamplePeers) {
    pvSamplePeers.addEventListener('change', function () {
      state.previewSamplePeers = pvSamplePeers.checked;
      renderPreviewMode();
    });
  }

  var pvDesk = document.getElementById('el-pv-desktop');
  var pvMob = document.getElementById('el-pv-mobile');
  if (pvDesk && pvMob) {
    pvDesk.addEventListener('click', function () {
      state.previewViewport = 'desktop';
      pvDesk.classList.add('is-active');
      pvMob.classList.remove('is-active');
      pvDesk.setAttribute('aria-pressed', 'true');
      pvMob.setAttribute('aria-pressed', 'false');
      renderPreviewMode();
    });
    pvMob.addEventListener('click', function () {
      state.previewViewport = 'mobile';
      pvMob.classList.add('is-active');
      pvDesk.classList.remove('is-active');
      pvMob.setAttribute('aria-pressed', 'true');
      pvDesk.setAttribute('aria-pressed', 'false');
      renderPreviewMode();
    });
  }
  document.getElementById('el-share-rotate-btn').addEventListener('click', async function () {
    var ok = await showConfirmDialog(
      'Reset public share URL?',
      'Generate a brand-new share URL? The previous link and printed QR codes will stop working.',
      'Reset link'
    );
    if (ok) savePublicShareSettings({ rotateToken: true });
  });
  document.getElementById('el-share-qr-download').addEventListener('click', function () {
    var svg = document.querySelector('#el-share-qr svg');
    if (!svg) return;
    var cohortTag = document.getElementById('el-share-cohort').value.trim().replace(/[^a-zA-Z0-9_.-]+/g, '-');
    var blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'xpeditie-pijn-qr' + (cohortTag ? ('-' + cohortTag) : '') + '.svg';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });
  document.getElementById('el-add-member-btn').addEventListener('click', async function () {
    var email = document.getElementById('el-member-email').value.trim();
    var role = memberRoleValue || 'edit';
    if (!email) return;
    try {
      var res = await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/sharing', {
        method: 'POST',
        body: JSON.stringify({ action: 'add_member', email: email, role: role }),
      });
      document.getElementById('el-member-email').value = '';
      renderMembersList(res.members || []);
      showToast('Collaborator added!');
    } catch (err) { showToast(err.message, 'error'); }
  });
  document.getElementById('el-create-grant-btn').addEventListener('click', async function () {
    var label = document.getElementById('el-grant-label').value.trim() || 'German Editor';
    var lang = grantLangValue || 'de';
    try {
      await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/sharing', {
        method: 'POST',
        body: JSON.stringify({ action: 'create_grant', role: 'translate', targetLanguage: lang, label: label }),
      });
      document.getElementById('el-grant-label').value = '';
      showToast('Translator link created!');
      loadShareDialogData();
    } catch (err) { showToast(err.message, 'error'); }
  });

  // UX-098: On narrow screens, Live Preview opens a field-scoped dialog sheet and returns focus to the active field
  var trSheetDialog = document.getElementById('el-tr-preview-dialog');
  var trSheetStage = document.getElementById('el-tr-sheet-stage');
  document.getElementById('el-tr-toggle-preview').addEventListener('click', function () {
    if (window.matchMedia('(max-width: 720px)').matches && trSheetDialog && trSheetStage) {
      renderTranslatePreviewInto(trSheetStage);
      trSheetDialog.showModal();
      return;
    }
    state.trShowPreview = !state.trShowPreview;
    this.setAttribute('aria-pressed', state.trShowPreview ? 'true' : 'false');
    renderTranslateMode();
  });
  if (trSheetDialog) {
    trSheetDialog.addEventListener('close', function () {
      trSheetDialog.returnValue = '';
      if (state.trLastActiveKey) {
        var activeRow = translateRowsEl.querySelector('.el-tr-row[data-field-key="' + CSS.escape(state.trLastActiveKey) + '"] textarea');
        if (activeRow) activeRow.focus();
      }
    });
  }

  document.getElementById('el-tr-save-btn').addEventListener('click', saveTranslationsNow);
  document.getElementById('el-tr-export-csv').addEventListener('click', async function () {
    try {
      var url = '/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/translations/export.csv?source=' + encodeURIComponent(state.trSource) + '&target=' + encodeURIComponent(state.trTarget);
      var resp = await request(url);
      if (!resp.ok) throw new Error('Could not export CSV.');
      var blob = await resp.blob();
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'xped-translations-' + state.trTarget + '.csv';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    } catch (err) { showToast(err.message, 'error'); }
  });
  var csvInp = document.getElementById('el-tr-import-csv-input');
  document.getElementById('el-tr-import-csv-btn').addEventListener('click', function () { csvInp.click(); });
  csvInp.addEventListener('change', async function () {
    var file = csvInp.files && csvInp.files[0];
    if (!file) return;
    var toolbar = document.querySelector('.el-topbar');
    var form = document.getElementById('el-mode-translate');
    toolbar.inert = true;
    form.inert = true;
    var fd = new FormData();
    fd.append('file', file);
    fd.append('targetLanguage', state.trTarget);
    try {
      clearTimeout(state.trSaveTimer);
      if (!(await saveTranslationsNow())) return;
      var res = await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/translations/import?target=' + encodeURIComponent(state.trTarget), {
        method: 'POST',
        body: fd,
      });
      state.exp = res.expedition;
      rebaseUndoStacksWithTranslations(state.exp, state.trTarget);
      updateUndoButtons();
      showToast('Imported ' + (res.appliedCount || 0) + ' translated fields!');
      renderTranslateMode();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      csvInp.value = '';
      toolbar.inert = false;
      form.inert = false;
    }
  });

  document.getElementById('el-preview-reset').addEventListener('click', function () {
    syncPreviewStartPosition();
    renderPreviewMode();
  });

  [blockPickerDialog, moduleRecipeDialog, shareDialog].forEach(function (dlg) {
    dlg.addEventListener('close', function () { dlg.returnValue = ''; });
  });
  Icons.wireAnimatedDialogs();
  Model.enableDialogLightDismissFallback();
  Model.setupCopyButtons();

  function showUnavailable(message) {
    setSaveStatus(message, false, false);
    ['el-mode-edit', 'el-mode-translate', 'el-mode-preview'].forEach(function (id) { document.getElementById(id).hidden = true; });
    document.querySelector('.el-topbar-center').hidden = true;
    document.querySelector('.el-topbar-right').hidden = true;
    titleInput.hidden = true;
    var panel = document.createElement('p');
    panel.className = 'el-editor-unavailable';
    panel.textContent = message;
    if (!grantToken && !activeUser) {
      var link = document.createElement('a');
      link.href = window.LectureProcessorAuth.buildSignInUrl(window.location.pathname);
      link.textContent = 'Sign in';
      panel.append(' ', link);
    }
    document.querySelector('.el-topbar').after(panel);
  }

  async function loadExpedition() {
    try {
      if (grantToken && !state.grantAccessToken) {
        var ex = await api('/api/elearning/grant-session', {
          method: 'POST',
          body: JSON.stringify({ token: grantToken }),
        });
        state.grantAccessToken = ex.accessToken;
        expeditionId = ex.expeditionId;
        state.grantTargetLang = ex.targetLanguage || 'de';
        state.trTarget = state.grantTargetLang;
        trTargetDD.setItems(LANG_OPTIONS.filter(function (item) { return item.value === state.trTarget; }), state.trTarget);
      }
      var res = await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId));
      state.exp = res.expedition;
      state.role = res.expedition.role || '';
      state.editLang = state.exp.defaultLanguage || 'nl';
      state.previewLang = state.editLang;
      editLangDD.setItems(LANG_OPTIONS, state.editLang);
      previewLangDD.setItems(LANG_OPTIONS, state.previewLang);
      if (state.role === 'translate') state.mode = 'translate';

      // UX-118: Support deep linking from Responses reviewer comments with archived-step fallback
      if (openedFromResponses) {
        var retBar = document.getElementById('el-return-responses');
        var retLink = document.getElementById('el-return-responses-link');
        if (retBar && retLink) {
          retLink.href = '/physio/elearning/' + encodeURIComponent(expeditionId) + '/responses';
          retBar.hidden = false;
        }
      }
      if (deepStepId) {
        var matchedMod = (state.exp.modules || []).find(function (m) {
          return (!deepModuleId || m.id === deepModuleId) && (m.steps || []).some(function (s) { return s.id === deepStepId; });
        }) || (state.exp.modules || []).find(function (m) {
          return (m.steps || []).some(function (s) { return s.id === deepStepId; });
        });
        if (matchedMod) {
          var matchedStep = matchedMod.steps.find(function (s) { return s.id === deepStepId; });
          state.selectedTarget = { type: 'step', moduleId: matchedMod.id, stepId: matchedStep.id };
          state.selectedBlockId = (matchedStep.blocks && matchedStep.blocks[0]) ? matchedStep.blocks[0].id : '';
        } else {
          showToast('That commented step was removed or archived — showing Start Page instead.');
        }
      }

      setSaveStatus('Saved', true, false);
      if (canEditStructure()) await acquireLease(false);
      setMode(state.mode);
    } catch (err) {
      showUnavailable(err.message);
    }
  }

  window.addEventListener('beforeunload', function (event) {
    if (!leavingAccount && (savedVersion !== saveVersion || Object.keys(state.trPendingTexts).length || Object.keys(state.trPendingMedia).length)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
  if (grantToken) {
    loadExpedition();
  } else {
    bootstrap.onAuthStateReady(auth, function (user) {
      if (loadedAccount && (activeUser?.uid || '') !== (user?.uid || '')) {
        leavingAccount = true;
        clearTimeout(state.saveTimer);
        clearTimeout(state.trSaveTimer);
        clearInterval(state.leaseTimer);
        resetMedia();
        document.body.hidden = true;
        window.location.reload();
        return;
      }
      activeUser = user;
      accountSession = authClient.captureSession();
      loadedAccount = true;
      if (user) loadExpedition();
      else showUnavailable('Sign in required');
    });
  }
})();
