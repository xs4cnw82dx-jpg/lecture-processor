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

  var state = {
    exp: null,
    role: '',
    mode: initialMode,
    editLang: 'nl',
    trSource: 'nl',
    trTarget: 'de',
    trFilter: 'all',
    trShowPreview: !window.matchMedia('(max-width: 720px)').matches,
    trActiveContext: { type: 'startPage', moduleId: '', stepId: '', blockId: '' },
    trPendingTexts: {},
    trPendingMedia: {},
    trSaveTimer: null,
    selectedTarget: { type: 'startPage' },
    selectedBlockId: '',
    insertBlockAt: -1,
    inspectorTab: 'block',
    viewport: 'desktop',
    previewViewport: 'desktop',
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
    previewLang: 'nl',
    previewPos: { view: 'start', modIdx: 0, stepIdx: 0, answers: {}, completedIds: [] },
    dragPayload: null,
  };

  var titleInput = document.getElementById('el-exp-title');
  var saveStateEl = document.getElementById('el-save-state');
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
    onChange: function (val) {
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

  function pushUndo() {
    if (!state.exp) return;
    state.undoStack.push(clone(state.exp));
    if (state.undoStack.length > 40) state.undoStack.shift();
    state.redoStack = [];
    updateUndoButtons();
  }

  function restoreSnapshot(snapshot) {
    snapshot.revision = state.exp.revision;
    state.exp = snapshot;
    updateUndoButtons();
    renderAll();
    scheduleSave();
  }

  function updateUndoButtons() {
    document.getElementById('el-undo-btn').disabled = !state.undoStack.length;
    document.getElementById('el-redo-btn').disabled = !state.redoStack.length;
  }

  function setSaveStatus(text, isLive) {
    saveStateEl.textContent = '';
    if (isLive) saveStateEl.appendChild(Icons.icon('cloudCheck', 13));
    saveStateEl.appendChild(document.createTextNode(text));
    saveStateEl.className = 'el-save-chip' + (isLive ? ' is-live' : '');
  }

  function scheduleSave() {
    saveVersion++;
    setSaveStatus('Saving…', false);
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(queueStructureSave, 700);
  }

  function queueStructureSave() {
    writing = writing.then(saveNow);
    return writing;
  }

  async function saveNow() {
    if (leavingAccount || savedVersion === saveVersion || !canEditStructure() || !state.exp) return;
    if (!state.leaseToken) {
      await acquireLease(false);
      if (!state.leaseToken) { setSaveStatus('Save paused', false); return; }
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
      savedVersion = version;
      if (version === saveVersion) setSaveStatus('Saved', true);
    } catch (err) {
      setSaveStatus('Save paused', false);
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
        if (savedVersion === saveVersion) setSaveStatus('Saved', true);
        clearInterval(state.leaseTimer);
        state.leaseTimer = setInterval(function () { acquireLease(false); }, 40000);
      } else {
        state.leaseToken = '';
        titleInput.disabled = true;
        workspace.inert = true;
        var edName = (res.editor && res.editor.name) || 'A collaborator';
        var agoSec = (res.editor && res.editor.updated_at) ? Math.max(1, Math.round(Date.now() / 1000 - res.editor.updated_at)) : 0;
        var agoTxt = agoSec ? (' (active ' + (agoSec < 60 ? (agoSec + 's') : (Math.round(agoSec / 60) + 'm')) + ' ago)') : '';
        leaseMsg.textContent = edName + ' is currently editing this expedition' + agoTxt + '. You can safely preview or take over.';
        leaseBanner.hidden = false;
        saveStateEl.textContent = edName + ' editing';
        saveStateEl.className = 'el-save-chip is-warn';
      }
    } catch (err) {
      if (!state.leaseToken) {
        leaseMsg.textContent = err.message;
        leaseBanner.hidden = false;
        setSaveStatus('Save paused', false);
      }
    }
  }

  function mutate(fn, opts) {
    if (!canEditStructure() || !state.leaseToken || !state.exp || leavingAccount) return;
    if (!opts || opts.recordUndo !== false) pushUndo();
    fn();
    if (opts && opts.recordUndo === false && inspectorBodyEl.contains(document.activeElement)) {
      renderCanvas();
      renderOutline();
    } else if (!opts || opts.rerender !== false) renderAll();
    else updateReadabilityCue();
    scheduleSave();
  }

  async function uploadFileForBlock(blk, file) {
    var fd = new FormData();
    fd.append('file', file);
    try {
      showToast('Uploading media…');
      var res = await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/assets', { method: 'POST', body: fd });
      mutate(function () {
        if (blk === 'startPage') {
          state.exp.startPage.heroMedia = { kind: 'asset', assetId: res.asset.id, staticPath: '' };
        } else {
          blk.data.media = { kind: 'asset', assetId: res.asset.id, staticPath: '' };
        }
      });
      showToast('Media uploaded!');
    } catch (err) {
      showToast(err.message, 'error');
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
    document.getElementById('el-mode-edit').hidden = nextMode !== 'edit';
    document.getElementById('el-mode-translate').hidden = nextMode !== 'translate';
    document.getElementById('el-mode-preview').hidden = nextMode !== 'preview';
    // Hide topbar language switcher + divider in Translate & Preview modes (they have dedicated language controls!)
    document.getElementById('el-edit-lang-host').hidden = nextMode !== 'edit';
    var topSep = document.querySelector('.el-topbar-sep');
    if (topSep) topSep.hidden = nextMode !== 'edit';
    renderAll();
  }

  /* ---- Left Rail with Real Drag-and-Drop ---- */
  function renderOutline() {
    var startBtn = document.getElementById('el-nav-start-page');
    startBtn.classList.toggle('is-active', state.selectedTarget.type === 'startPage');
    outlineModulesEl.textContent = '';

    (state.exp.modules || []).forEach(function (mod, mIdx) {
      var isCollapsed = !!state.collapsedModules[mod.id];
      var group = document.createElement('div');
      group.className = 'el-module-group' + (mod.visibleToLearners === false ? ' is-hidden-learner' : '') + (isCollapsed ? ' is-collapsed' : '');
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
          group.classList.add('is-dragover');
        });
        group.addEventListener('dragleave', function () { group.classList.remove('is-dragover'); });
        group.addEventListener('drop', function (e) {
          group.classList.remove('is-dragover');
          if (!state.dragPayload || state.dragPayload.kind !== 'module') return;
          e.preventDefault();
          var from = state.dragPayload.index;
          state.dragPayload = null;
          if (from === mIdx) return;
          mutate(function () {
            var moved = state.exp.modules.splice(from, 1)[0];
            state.exp.modules.splice(mIdx, 0, moved);
          });
        });
      }

      var head = document.createElement('div');
      head.className = 'el-module-head';
      if (canEditStructure()) {
        var grip = document.createElement('span');
        grip.className = 'el-drag-grip';
        grip.appendChild(Icons.icon('grip', 14));
        head.appendChild(grip);
      }

      var toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'el-module-toggle';
      toggleBtn.title = isCollapsed ? 'Expand station' : 'Collapse station';
      toggleBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      toggleBtn.appendChild(Icons.icon('chevronDown', 14));
      toggleBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        state.collapsedModules[mod.id] = !state.collapsedModules[mod.id];
        renderOutline();
      });
      head.appendChild(toggleBtn);

      var headBtn = document.createElement('button');
      headBtn.type = 'button';
      headBtn.className = 'el-module-title-btn';
      var dot = document.createElement('span');
      dot.className = 'xped-domain-dot domain-' + (mod.domain || 'general');
      var label = document.createElement('span');
      label.setAttribute('translate', 'no');
      label.textContent = Model.getLocalized(mod.title, state.editLang, state.exp.defaultLanguage) || ('Station ' + (mIdx + 1));
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
      if (isCollapsed && (mod.steps || []).length) {
        var cntBadge = document.createElement('span');
        cntBadge.className = 'el-module-count';
        cntBadge.textContent = (mod.steps || []).length + ((mod.steps || []).length === 1 ? ' step' : ' steps');
        head.appendChild(cntBadge);
      }
      if (canEditStructure() && (state.exp.modules || []).length > 1) {
        var modMove = document.createElement('div');
        modMove.className = 'el-rail-move';
        var mUp = document.createElement('button');
        mUp.type = 'button';
        mUp.className = 'el-rail-move-btn';
        mUp.title = 'Move station up';
        mUp.disabled = mIdx === 0;
        mUp.appendChild(Icons.icon('chevronUp', 12));
        mUp.addEventListener('click', function (e) {
          e.stopPropagation();
          mutate(function () {
            var arr = state.exp.modules;
            var t = arr[mIdx - 1];
            arr[mIdx - 1] = arr[mIdx];
            arr[mIdx] = t;
          });
        });
        var mDn = document.createElement('button');
        mDn.type = 'button';
        mDn.className = 'el-rail-move-btn';
        mDn.title = 'Move station down';
        mDn.disabled = mIdx === state.exp.modules.length - 1;
        mDn.appendChild(Icons.icon('chevronDown', 12));
        mDn.addEventListener('click', function (e) {
          e.stopPropagation();
          mutate(function () {
            var arr = state.exp.modules;
            var t = arr[mIdx + 1];
            arr[mIdx + 1] = arr[mIdx];
            arr[mIdx] = t;
          });
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
            sbtn.classList.add('is-dragover');
          });
          sbtn.addEventListener('dragleave', function () { sbtn.classList.remove('is-dragover'); });
          sbtn.addEventListener('drop', function (e) {
            sbtn.classList.remove('is-dragover');
            if (!state.dragPayload || state.dragPayload.kind !== 'step') return;
            e.preventDefault();
            e.stopPropagation();
            var dp = state.dragPayload;
            state.dragPayload = null;
            mutate(function () {
              var srcMod = state.exp.modules.find(function (m) { return m.id === dp.fromModId; });
              if (!srcMod) return;
              if (srcMod.id === mod.id && dp.fromIdx === sIdx) return;
              if (srcMod.id !== mod.id && srcMod.steps.length <= 1) return;
              var moved = srcMod.steps.splice(dp.fromIdx, 1)[0];
              mod.steps.splice(sIdx, 0, moved);
              state.selectedTarget = { type: 'step', moduleId: mod.id, stepId: moved.id };
            });
          });
        }

        if (canEditStructure()) {
          var sGrip = document.createElement('span');
          sGrip.className = 'el-step-grip';
          sGrip.title = 'Drag to reorder step';
          sGrip.appendChild(Icons.icon('grip', 12));
          sbtn.appendChild(sGrip);
        }

        var titleSpan = document.createElement('span');
        titleSpan.className = 'el-outline-item-text';
        titleSpan.setAttribute('translate', 'no');
        titleSpan.textContent = (sIdx + 1) + '. ' + (Model.getLocalized(step.title, state.editLang, state.exp.defaultLanguage) || 'Untitled step');
        sbtn.appendChild(titleSpan);

        if (canEditStructure() && (mod.steps || []).length > 1) {
          var stepMove = document.createElement('span');
          stepMove.className = 'el-rail-move';
          var sUp = document.createElement('button');
          sUp.type = 'button';
          sUp.className = 'el-rail-move-btn';
          sUp.title = 'Move step up';
          sUp.disabled = sIdx === 0;
          sUp.appendChild(Icons.icon('chevronUp', 12));
          sUp.addEventListener('click', function (e) {
            e.stopPropagation();
            mutate(function () {
              var t = mod.steps[sIdx - 1];
              mod.steps[sIdx - 1] = mod.steps[sIdx];
              mod.steps[sIdx] = t;
            });
          });
          var sDn = document.createElement('button');
          sDn.type = 'button';
          sDn.className = 'el-rail-move-btn';
          sDn.title = 'Move step down';
          sDn.disabled = sIdx === mod.steps.length - 1;
          sDn.appendChild(Icons.icon('chevronDown', 12));
          sDn.addEventListener('click', function (e) {
            e.stopPropagation();
            mutate(function () {
              var t = mod.steps[sIdx + 1];
              mod.steps[sIdx + 1] = mod.steps[sIdx];
              mod.steps[sIdx] = t;
            });
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
        var stDot = document.createElement('span');
        stDot.className = 'el-status-dot status-' + (step.status || 'empty');
        stDot.title = 'Status: ' + (step.status || 'empty');
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
          mutate(function () {
            var ns = Model.createStep('Stap ' + ((mod.steps || []).length + 1), 'Step ' + ((mod.steps || []).length + 1));
            mod.steps.push(ns);
            state.selectedTarget = { type: 'step', moduleId: mod.id, stepId: ns.id };
            state.selectedBlockId = '';
          });
        });
        stepList.appendChild(addStepBtn);
      }

      group.appendChild(stepList);
      outlineModulesEl.appendChild(group);
    });
  }

  /* ---- Live Reading Time & B1 Plain-Language / Accessibility Coach ---- */
  function updateReadabilityCue() {
    var pair = currentModuleAndStep();
    if (!pair.step) return;
    var report = Model.analyzeStepReadability(pair.step, state.editLang, state.exp.defaultLanguage);
    var coachPanel = document.getElementById('el-b1-coach-panel');
    readabilityBarEl.textContent = '';

    var left = document.createElement('span');
    left.textContent = report.words + ' words · ~' + (report.seconds >= 60 ? (Math.round(report.seconds / 60) + ' min read') : (report.seconds + ' sec read'));
    readabilityBarEl.appendChild(left);

    var toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'el-b1-toggle is-' + report.level;
    toggle.appendChild(Icons.icon(report.level === 'good' ? 'checkCircle' : 'alertCircle', 13));
    toggle.appendChild(document.createTextNode(report.level === 'good' ? 'B1 Readability: Good' : ('B1 & A11y Coach (' + report.tips.length + ')')));
    toggle.addEventListener('click', function () {
      state.b1CoachOpen = !state.b1CoachOpen;
      if (coachPanel) coachPanel.hidden = !state.b1CoachOpen;
    });
    readabilityBarEl.appendChild(toggle);

    if (coachPanel) {
      coachPanel.textContent = '';
      report.tips.forEach(function (tip) {
        var row = document.createElement('div');
        row.className = 'el-b1-tip is-' + tip.kind;
        row.appendChild(Icons.icon(tip.kind === 'ok' ? 'check' : (tip.kind === 'warn' ? 'alertCircle' : 'info'), 14));
        var sp = document.createElement('span');
        sp.textContent = tip.text;
        row.appendChild(sp);
        coachPanel.appendChild(row);
      });
      coachPanel.hidden = !state.b1CoachOpen;
    }
  }

  /* ---- Center Live Stage (Direct-On-Canvas Editing!) ---- */
  function makeInsertSlot(insertIdx) {
    var slot = document.createElement('div');
    slot.className = 'el-insert-slot';
    var btn = document.createElement('button');
    btn.type = 'button';
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
      });
      return;
    }
    if (field === 'addPin') {
      mutate(function () {
        blk.data.pins.push({
          id: Model.uid('opt'),
          label: Model.loc('Punt ' + (blk.data.pins.length + 1), 'Point ' + (blk.data.pins.length + 1), ''),
          detail: Model.loc('', '', ''),
          x: val.x,
          y: val.y,
        });
      });
      showToast('Hotspot pin placed — edit its explanation in Settings.');
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
        showToast(parsedV.error || 'Paste a valid YouTube or Vimeo link.');
        return;
      }
      mutate(function () {
        blk.data.url = val;
        blk.data.provider = parsedV.provider || '';
        blk.data.videoId = parsedV.videoId || '';
        blk.data.embedUrl = parsedV.embedUrl || '';
        if (parsedV.startSeconds !== null && !blk.data.startSeconds) blk.data.startSeconds = parsedV.startSeconds;
      });
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
          });
        },
        onMoveHighlight: function (idx, dir) {
          mutate(function () {
            var arr = state.exp.startPage.highlights || [];
            var target = idx + dir;
            if (target < 0 || target >= arr.length) return;
            var moved = arr.splice(idx, 1)[0];
            arr.splice(target, 0, moved);
          });
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

    canvasCrumbEl.textContent = (Model.getLocalized(pair.mod.title, lang, defLang) || 'Station') + ' · ' + lang.toUpperCase();
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
    crumb.appendChild(document.createTextNode(Model.getLocalized(pair.mod.title, lang, defLang) || 'Station'));
    kicker.appendChild(crumb);
    card.appendChild(kicker);

    // Direct-editable Step Title
    var stepTitle = document.createElement('h1');
    stepTitle.className = 'xped-step-title';
    var curStepTitle = Model.getLocalized(pair.step.title, lang, defLang);
    stepTitle.textContent = curStepTitle;
    if (canEditStructure()) {
      stepTitle.contentEditable = 'true';
      stepTitle.classList.add('el-inline-edit');
      stepTitle.setAttribute('data-placeholder', 'Click to write step title…');
      stepTitle.addEventListener('blur', function () {
        mutate(function () { pair.step.title = Model.setLocalized(pair.step.title, lang, stepTitle.textContent || ''); }, { recordUndo: false, rerender: false });
        renderOutline();
      });
    }
    card.appendChild(stepTitle);

    var stack = document.createElement('div');
    stack.className = 'xped-blocks-stack';

    (pair.step.blocks || []).forEach(function (blk, bIdx) {
      if (canEditStructure()) stack.appendChild(makeInsertSlot(bIdx));

      var wrap = document.createElement('div');
      wrap.className = 'el-canvas-block-wrap' + (blk.id === state.selectedBlockId ? ' is-selected' : '');
      if (canEditStructure()) {
        wrap.draggable = true;
        wrap.addEventListener('dragstart', function (e) {
          if (document.activeElement && document.activeElement.isContentEditable) { e.preventDefault(); return; }
          state.dragPayload = { kind: 'block', fromIdx: bIdx };
        });
        wrap.addEventListener('dragover', function (e) {
          if (!state.dragPayload || state.dragPayload.kind !== 'block') return;
          e.preventDefault();
          wrap.classList.add('is-dragover');
        });
        wrap.addEventListener('dragleave', function () { wrap.classList.remove('is-dragover'); });
        wrap.addEventListener('drop', function (e) {
          wrap.classList.remove('is-dragover');
          if (!state.dragPayload || state.dragPayload.kind !== 'block') return;
          e.preventDefault();
          var from = state.dragPayload.fromIdx;
          state.dragPayload = null;
          if (from === bIdx) return;
          mutate(function () {
            var moved = pair.step.blocks.splice(from, 1)[0];
            pair.step.blocks.splice(bIdx, 0, moved);
          });
        });
      }

      wrap.addEventListener('click', function (e) {
        if (e.target.closest('.el-block-toolbar')) return;
        if (state.selectedBlockId !== blk.id) {
          state.selectedBlockId = blk.id;
          state.inspectorTab = 'block';
          document.querySelectorAll('.el-canvas-block-wrap').forEach(function (n) { n.classList.remove('is-selected'); });
          wrap.classList.add('is-selected');
          renderInspector();
        }
      });

      if (blk.id === state.selectedBlockId && canEditStructure()) {
        var bar = document.createElement('div');
        bar.className = 'el-block-toolbar';
        [
          { ic: 'chevronUp', title: 'Move up', dis: bIdx === 0, fn: function () { mutate(function () { var a = pair.step.blocks; var t = a[bIdx - 1]; a[bIdx - 1] = a[bIdx]; a[bIdx] = t; }); } },
          { ic: 'chevronDown', title: 'Move down', dis: bIdx === pair.step.blocks.length - 1, fn: function () { mutate(function () { var a = pair.step.blocks; var t = a[bIdx + 1]; a[bIdx + 1] = a[bIdx]; a[bIdx] = t; }); } },
          { ic: 'copy', title: 'Duplicate block', fn: function () { mutate(function () { var cp = clone(blk); cp.id = Model.uid('blk'); pair.step.blocks.splice(bIdx + 1, 0, cp); state.selectedBlockId = cp.id; }); } },
          { ic: 'trash', title: 'Delete block', fn: function () {
            var snap = clone(state.exp);
            mutate(function () { pair.step.blocks.splice(bIdx, 1); state.selectedBlockId = ''; });
            showToast('Block deleted.', function () { restoreSnapshot(snap); });
          } },
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
        wrap.appendChild(bar);
      }

      wrap.appendChild(Blocks.renderBlock(blk, {
        lang: lang,
        defaultLang: defLang,
        stepTitle: curStepTitle,
        interactive: false,
        editable: canEditStructure(),
        onEdit: handleBlockInlineEdit,
        onUploadFile: uploadFileForBlock,
        assetUrl: assetUrl, setMediaSource: setMediaSource,
      }));
      stack.appendChild(wrap);
    });

    if (!(pair.step.blocks || []).length) {
      var empty = document.createElement('div');
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
  }

  /* ---- Calm Contextual Right Inspector (Settings & Style Only) ---- */
  function fieldText(label, value, onChange, multiline) {
    var wrap = document.createElement('div');
    wrap.className = 'el-field';
    var lab = document.createElement('label');
    lab.textContent = label;
    var inp = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) inp.type = 'text';
    else inp.rows = 3;
    inp.value = value || '';
    lab.htmlFor = inp.id = Model.uid('field');
    inp.addEventListener('input', function () {
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

  function fieldCheck(label, checked, onChange) {
    var lab = document.createElement('label');
    lab.className = 'el-field-check';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!checked;
    cb.addEventListener('change', function () { onChange(cb.checked); });
    var span = document.createElement('span');
    span.textContent = label;
    lab.appendChild(cb);
    lab.appendChild(span);
    return lab;
  }

  function buildVisualPicker(currentRef, targetForUpload, onPick, audioOnly) {
    var box = document.createElement('div');
    box.className = 'el-field';
    box.appendChild(Blocks.createDropzone(
      audioOnly ? 'Upload audio clip' : 'Upload custom photo',
      audioOnly ? 'MP3, M4A or OGG' : 'Drop or click · PNG, JPG, WebP',
      audioOnly ? 'audio/*' : 'image/png,image/jpeg,image/webp',
      function (file) { uploadFileForBlock(targetForUpload, file); }
    ));

    if (!audioOnly) {
      var library = document.createElement('details');
      library.className = 'el-asset-library';
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
        btn.addEventListener('click', function () { onPick({ kind: 'xped', assetId: '', staticPath: asset.path }); });
        grid.appendChild(btn);
      });
      library.appendChild(grid);
    }
    return box;
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

    if (state.inspectorTab === 'theme') {
      var h = document.createElement('div');
      h.className = 'el-insp-section-title';
      h.textContent = 'Expedition Visual Style';
      inspectorBodyEl.appendChild(h);

      inspectorBodyEl.appendChild(fieldSelect('Canvas Palette', (state.exp.theme && state.exp.theme.preset) || 'xped-warm-sand', [
        ['xped-warm-sand', 'xPED Warm Sand (Recommended)'],
        ['xped-clean', 'xPED Cool Light'],
        ['high-contrast', 'High Contrast'],
      ], function (v) { mutate(function () { state.exp.theme.preset = v; }); }));

      inspectorBodyEl.appendChild(fieldCheck('Show animated Expedition Route Map on Start Page', !state.exp.theme || state.exp.theme.showRouteMap !== false, function (v) {
        mutate(function () { state.exp.theme.showRouteMap = v; });
      }));

      var lh = document.createElement('div');
      lh.className = 'el-insp-section-title';
      lh.textContent = 'Languages';
      inspectorBodyEl.appendChild(lh);

      inspectorBodyEl.appendChild(fieldSelect('Default Fallback Language', state.exp.defaultLanguage || 'nl', [
        ['nl', 'Nederlands (NL)'],
        ['en', 'English (EN)'],
        ['de', 'Deutsch (DE)'],
      ], function (v) { mutate(function () { state.exp.defaultLanguage = v; }); }));

      var enabledSet = state.exp.enabledLanguages || ['nl', 'en', 'de'];
      ['nl', 'en', 'de'].forEach(function (code) {
        inspectorBodyEl.appendChild(fieldCheck('Enable ' + Model.LANG_LABELS[code], enabledSet.indexOf(code) >= 0, function (on) {
          mutate(function () {
            var next = (state.exp.enabledLanguages || ['nl']).filter(function (c) { return c !== code; });
            if (on) next.push(code);
            if (!next.length) next = [state.exp.defaultLanguage || 'nl'];
            state.exp.enabledLanguages = next;
          });
        }));
      });
      return;
    }

    if (state.selectedTarget.type === 'startPage') {
      var sp = state.exp.startPage;
      var hint = document.createElement('p');
      hint.className = 'xped-caption';
      hint.textContent = 'Click any headline, subtitle, bullet, or button directly on the canvas to edit text.';
      inspectorBodyEl.appendChild(hint);

      inspectorBodyEl.appendChild(buildVisualPicker(sp.heroMedia, 'startPage', function (ref) {
        mutate(function () { sp.heroMedia = ref; });
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
        mutate(function () { sp.highlights.push({ id: Model.uid('hl'), text: Model.loc('Nieuw voordeel', 'New highlight', '') }); });
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
        ['bio', 'Biologisch (Mint)'],
        ['psycho', 'Psychologisch (Blue)'],
        ['social', 'Sociaal (Yellow)'],
        ['general', 'General (Navy)'],
      ], function (v) { mutate(function () { mod.domain = v; }); }));
      inspectorBodyEl.appendChild(fieldText('Estimated Minutes', String(mod.estimatedMinutes || 5), function (v) {
        var n = parseInt(v, 10);
        if (n > 0 && n <= 120) mutate(function () { mod.estimatedMinutes = n; }, { recordUndo: false });
      }));
      inspectorBodyEl.appendChild(fieldCheck('Visible in Public Test Link', mod.visibleToLearners !== false, function (v) {
        mutate(function () { mod.visibleToLearners = v; });
      }));
      inspectorBodyEl.appendChild(fieldText('Milestone Celebration Note', mod.milestoneMessage[lang], function (v) {
        mutate(function () { mod.milestoneMessage = Model.setLocalized(mod.milestoneMessage, lang, v); }, { recordUndo: false });
      }));

      var sh = document.createElement('div');
      sh.className = 'el-insp-section-title';
      sh.textContent = 'Step Readiness & Flow';
      inspectorBodyEl.appendChild(sh);

      inspectorBodyEl.appendChild(fieldSelect('Content Status', step.status || 'empty', [
        ['empty', 'Empty (awaiting partner content)'],
        ['draft', 'Draft (in progress)'],
        ['review', 'Needs partner review'],
        ['ready', 'Ready for testing'],
      ], function (v) { mutate(function () { step.status = v; }); }));

      var qBlocks = (step.blocks || []).filter(function (b) { return b.type === 'mcq' || b.type === 'myth_fact' || b.type === 'scale'; });
      if (qBlocks.length && mod.steps.length > 1) {
        var curRule = (step.branching && step.branching[0]) || null;
        var targetOpts = [['', 'Continue normally']].concat(
          mod.steps.filter(function (s) { return s.id !== step.id; }).map(function (s, i) {
            return [s.id, 'Jump to: ' + (Model.getLocalized(s.title, lang, state.exp.defaultLanguage) || ('Step ' + (i + 1)))];
          })
        );
        inspectorBodyEl.appendChild(fieldSelect('Conditional Jump Rule', curRule ? curRule.targetStepId : '', targetOpts, function (tid) {
          mutate(function () {
            if (!tid) { step.branching = []; return; }
            step.branching = [{ blockId: qBlocks[0].id, operator: 'equals', value: (curRule && curRule.value) || 'myth', targetStepId: tid }];
          });
        }));
        if (curRule) {
          inspectorBodyEl.appendChild(fieldText('Trigger value ("myth"/"fact" or option ID)', curRule.value, function (v) {
            mutate(function () { curRule.value = v; }, { recordUndo: false });
          }));
        }
      }

      var dangerRow = document.createElement('div');
      dangerRow.className = 'el-btn-row';
      dangerRow.classList.add('el-danger-row');
      var delStep = document.createElement('button');
      delStep.type = 'button';
      delStep.className = 'el-btn el-btn-danger el-btn-sm';
      delStep.textContent = 'Delete Step';
      delStep.addEventListener('click', function () {
        if (mod.steps.length <= 1) { showToast('A station needs at least one step.'); return; }
        var snap = clone(state.exp);
        mutate(function () {
          mod.steps = mod.steps.filter(function (s) { return s.id !== step.id; });
          state.selectedTarget = { type: 'step', moduleId: mod.id, stepId: mod.steps[0].id };
        });
        showToast('Step deleted.', function () { restoreSnapshot(snap); });
      });
      var delMod = document.createElement('button');
      delMod.type = 'button';
      delMod.className = 'el-btn el-btn-danger el-btn-sm';
      delMod.textContent = 'Delete Station';
      delMod.addEventListener('click', function () {
        var snap = clone(state.exp);
        mutate(function () {
          state.exp.modules = state.exp.modules.filter(function (m) { return m.id !== mod.id; });
          state.selectedTarget = { type: 'startPage' };
        });
        showToast('Station deleted.', function () { restoreSnapshot(snap); });
      });
      dangerRow.appendChild(delStep);
      dangerRow.appendChild(delMod);
      inspectorBodyEl.appendChild(dangerRow);
      return;
    }

    /* ---- Calm Contextual Block Settings ---- */
    var blk = currentBlock();
    var d = blk.data;
    var metaInfo = Model.BLOCK_CATALOG.find(function (c) { return c.type === blk.type; });
    var bh = document.createElement('div');
    bh.className = 'el-insp-section-title';
    bh.textContent = (metaInfo ? metaInfo.label : blk.type) + ' Settings';
    inspectorBodyEl.appendChild(bh);

    // Progressive Disclosure toggle for explanation/takeaway blocks (no spoilers before answering!)
    if (blk.type === 'callout' || blk.type === 'richtext' || blk.type === 'image' || blk.type === 'story' || blk.type === 'sources') {
      inspectorBodyEl.appendChild(fieldCheck('Reveal only after learner answers a question on this step', !!(blk.settings && blk.settings.revealAfterAnswer), function (v) {
        mutate(function () {
          blk.settings = blk.settings || {};
          blk.settings.revealAfterAnswer = v;
        });
      }));
    }

    var editTip = document.createElement('p');
    editTip.className = 'xped-caption';
    editTip.classList.add('el-edit-tip');
    editTip.textContent = 'Click directly on the slide to edit visible text.';
    inspectorBodyEl.appendChild(editTip);

    function locField(lbl, key, multi) {
      inspectorBodyEl.appendChild(fieldText(lbl, (d[key] && d[key][lang]) || '', function (v) {
        mutate(function () { d[key] = Model.setLocalized(d[key], lang, v); }, { recordUndo: false });
      }, multi));
    }

    if (blk.type === 'video') {
      inspectorBodyEl.appendChild(fieldText('YouTube or Vimeo URL', d.url || '', function (v) {
        mutate(function () {
          d.url = v;
          var p = Model.parseVideoUrl(v);
          d.provider = p.provider || '';
          d.videoId = p.videoId || '';
          d.embedUrl = p.embedUrl || '';
          if (p.startSeconds !== null && !d.startSeconds) d.startSeconds = p.startSeconds;
        }, { recordUndo: false });
      }));
      inspectorBodyEl.appendChild(fieldText('Start Time (e.g. 1:15)', d.startSeconds !== null && d.startSeconds !== undefined ? String(d.startSeconds) : '', function (v) {
        mutate(function () { d.startSeconds = Model.parseTimestampSeconds(v); }, { recordUndo: false });
      }));
      inspectorBodyEl.appendChild(fieldText('End Time (e.g. 2:45)', d.endSeconds !== null && d.endSeconds !== undefined ? String(d.endSeconds) : '', function (v) {
        mutate(function () { d.endSeconds = Model.parseTimestampSeconds(v); }, { recordUndo: false });
      }));
      locField('Collapsible Transcript / Summary', 'transcript', true);
    } else if (blk.type === 'image') {
      inspectorBodyEl.appendChild(fieldSelect('Layout', d.layout || 'full', [
        ['full', 'Full Width'],
        ['framed', 'Framed Visual'],
        ['split-left', 'Split: Image Left'],
        ['split-right', 'Split: Image Right'],
      ], function (v) { mutate(function () { d.layout = v; }); }));
      inspectorBodyEl.appendChild(buildVisualPicker(d.media, blk, function (ref) { mutate(function () { d.media = ref; }); }, false));
      locField('Alt Text (Accessibility)', 'alt', false);
    } else if (blk.type === 'audio') {
      inspectorBodyEl.appendChild(buildVisualPicker(d.media, blk, function (ref) { mutate(function () { d.media = ref; }); }, true));
      locField('Collapsible Transcript', 'transcript', true);
    } else if (blk.type === 'callout') {
      inspectorBodyEl.appendChild(fieldSelect('Accent Color', d.tone || 'tip', [
        ['tip', 'Navy'],
        ['bio', 'Biologisch (Mint)'],
        ['psycho', 'Psychologisch (Blue)'],
        ['social', 'Sociaal (Yellow)'],
      ], function (v) { mutate(function () { d.tone = v; }); }));
    } else if (blk.type === 'story') {
      inspectorBodyEl.appendChild(buildVisualPicker(d.media, blk, function (ref) { mutate(function () { d.media = ref; }); }, false));
    } else if (blk.type === 'sources') {
      (d.items || []).forEach(function (item, idx) {
        inspectorBodyEl.appendChild(fieldText('Reference ' + (idx + 1), item.citation[lang], function (v) {
          mutate(function () { item.citation = Model.setLocalized(item.citation, lang, v); }, { recordUndo: false });
        }));
        inspectorBodyEl.appendChild(fieldText('DOI / URL ' + (idx + 1), item.url || '', function (v) {
          mutate(function () { item.url = v; }, { recordUndo: false });
        }));
      });
      var addSrc = document.createElement('button');
      addSrc.type = 'button';
      addSrc.className = 'el-btn el-btn-sm';
      addSrc.textContent = '+ Add Reference';
      addSrc.addEventListener('click', function () {
        mutate(function () { d.items.push({ id: Model.uid('src'), citation: Model.loc('', '', ''), url: '' }); });
      });
      inspectorBodyEl.appendChild(addSrc);
    } else if (blk.type === 'mcq') {
      inspectorBodyEl.appendChild(fieldCheck('Allow multiple selections', blk.settings.allowMultiple, function (v) {
        mutate(function () { blk.settings.allowMultiple = v; });
      }));
      inspectorBodyEl.appendChild(fieldCheck('Show anonymous peer stats after answering', blk.settings.showPeerResults, function (v) {
        mutate(function () { blk.settings.showPeerResults = v; });
      }));
      locField('Empathetic Explanation (after answer)', 'explanation', true);
    } else if (blk.type === 'myth_fact') {
      inspectorBodyEl.appendChild(fieldSelect('Correct Answer', d.correctAnswer || 'myth', [
        ['myth', 'Fabel / Myth'],
        ['fact', 'Feit / Fact'],
      ], function (v) { mutate(function () { d.correctAnswer = v; }); }));
      locField('Explanation Reveal (shown after click)', 'explanation', true);
      inspectorBodyEl.appendChild(fieldText('Optional Source Link', d.sourceUrl || '', function (v) {
        mutate(function () { d.sourceUrl = v; }, { recordUndo: false });
      }));
    } else if (blk.type === 'scale') {
      locField('Left Endpoint Label', 'minLabel', false);
      locField('Right Endpoint Label', 'maxLabel', false);
      locField('Helper Note', 'feedback', true);
      inspectorBodyEl.appendChild(fieldCheck('Show anonymous peer average', blk.settings.showPeerResults, function (v) {
        mutate(function () { blk.settings.showPeerResults = v; });
      }));
    } else if (blk.type === 'reflection') {
      locField('Privacy Reassurance Note', 'helperNote', false);
    } else if (blk.type === 'wordcloud') {
      inspectorBodyEl.appendChild(fieldCheck('Show anonymous peer word cloud', blk.settings.showPeerResults, function (v) {
        mutate(function () { blk.settings.showPeerResults = v; });
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
        mutate(function () { d.items.push({ id: Model.uid('opt'), label: Model.loc('', '', '') }); });
      });
      inspectorBodyEl.appendChild(addRank);
    } else if (blk.type === 'hotspot') {
      inspectorBodyEl.appendChild(buildVisualPicker(d.media, blk, function (ref) { mutate(function () { d.media = ref; }); }, false));
      (d.pins || []).forEach(function (pin, idx) {
        inspectorBodyEl.appendChild(fieldText('Pin ' + (idx + 1) + ' Title', pin.label[lang], function (v) {
          mutate(function () { pin.label = Model.setLocalized(pin.label, lang, v); }, { recordUndo: false });
        }));
        inspectorBodyEl.appendChild(fieldText('Pin ' + (idx + 1) + ' Explanation', pin.detail[lang], function (v) {
          mutate(function () { pin.detail = Model.setLocalized(pin.detail, lang, v); }, { recordUndo: false });
        }, true));
      });
    } else if (blk.type === 'balance_scale') {
      locField('Left Label (Load)', 'loadLabel', false);
      locField('Right Label (Resources)', 'resourceLabel', false);
      (d.factors || []).forEach(function (f, idx) {
        inspectorBodyEl.appendChild(fieldText('Factor ' + (idx + 1), f.label[lang], function (v) {
          mutate(function () { f.label = Model.setLocalized(f.label, lang, v); }, { recordUndo: false });
        }));
        inspectorBodyEl.appendChild(fieldSelect('Side', f.category || 'load', [['load', 'Load (Draaglast)'], ['resource', 'Resource (Draagkracht)']], function (v) {
          mutate(function () { f.category = v; });
        }));
      });
      var addFac = document.createElement('button');
      addFac.type = 'button';
      addFac.className = 'el-btn el-btn-sm';
      addFac.textContent = '+ Add Factor';
      addFac.addEventListener('click', function () {
        mutate(function () { d.factors.push({ id: Model.uid('opt'), label: Model.loc('', '', ''), category: 'resource' }); });
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
        mutate(function () { d.suggestions.push({ id: Model.uid('opt'), label: Model.loc('', '', '') }); });
      });
      inspectorBodyEl.appendChild(addSug);
      inspectorBodyEl.appendChild(fieldCheck('Allow learner custom step', d.allowCustom !== false, function (v) {
        mutate(function () { d.allowCustom = v; });
      }));
    } else if (blk.type === 'custom_visual') {
      inspectorBodyEl.appendChild(fieldSelect('Visual Mode', d.preset || 'placeholder', [
        ['placeholder', 'Coding Agent Blueprint Slot'],
        ['alarm-dial', 'Built-in: Pain Alarm Volume Dial'],
        ['breathing-circle', 'Built-in: Calm Guided Breathing'],
        ['custom-svg', 'Pasted Custom SVG Artwork'],
      ], function (v) { mutate(function () { d.preset = v; }); }));
      inspectorBodyEl.appendChild(fieldSelect('Stage Height', d.height || 'medium', [
        ['compact', 'Compact (180px)'],
        ['medium', 'Medium (260px)'],
        ['tall', 'Tall (360px)'],
      ], function (v) { mutate(function () { d.height = v; }); }));
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
  }

  /* ---- Split-Screen German Translation Studio with Live Slide Preview & Autosave ---- */
  function renderTranslatePreview() {
    if (!state.exp || !state.trShowPreview) return;
    document.getElementById('el-tr-preview-lang-tag').textContent = state.trTarget.toUpperCase();
    translatePreviewStage.lang = state.trTarget;
    translatePreviewStage.setAttribute('data-xped-theme', (state.exp.theme && state.exp.theme.preset) || 'xped-warm-sand');

    var ctx = state.trActiveContext;
    if (ctx.type === 'startPage') {
      RouteMap.renderStartPage(translatePreviewStage, {
        exp: state.exp,
        lang: state.trTarget,
        editable: false,
        assetUrl: assetUrl, setMediaSource: setMediaSource,
      });
      return;
    }
    var mod = (state.exp.modules || []).find(function (m) { return m.id === ctx.moduleId; });
    var step = mod && (mod.steps || []).find(function (s) { return s.id === ctx.stepId; });
    if (!mod || !step) {
      RouteMap.renderStartPage(translatePreviewStage, { exp: state.exp, lang: state.trTarget, editable: false, assetUrl: assetUrl, setMediaSource: setMediaSource });
      return;
    }
    translatePreviewStage.textContent = '';
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
    translatePreviewStage.appendChild(card);
    if (ctx.blockId) {
      var targetEl = translatePreviewStage.querySelector('[data-block-id="' + ctx.blockId + '"]');
      if (targetEl && typeof targetEl.scrollIntoView === 'function') {
        targetEl.scrollIntoView({ behavior: ux.prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
      }
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
        // Another contributor saved since this document was loaded. Keep the
        // current textareas intact while adopting the server's latest structure.
        var localRows = Model.extractTranslationRows(res.expedition, state.trSource, target);
        localRows.forEach(function (row) {
          if (Object.hasOwn(state.trPendingTexts, row.key)) row.locObj[target] = state.trPendingTexts[row.key];
        });
        state.exp = res.expedition;
      } else {
        state.exp.revision = res.expedition.revision;
      }
      // A structural undo snapshot predates this translation and could erase it.
      state.undoStack = [];
      state.redoStack = [];
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
        if (saveVersion === savedVersion) setSaveStatus('Saved', true);
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
      inp.addEventListener('change', function () {
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
    var activeIdx = tas.indexOf(document.activeElement);
    for (var i = 1; i <= tas.length; i += 1) {
      var candidate = tas[(activeIdx + i) % tas.length];
      if (!candidate.value.trim() || candidate.closest('.el-tr-row').dataset.status === 'needs_review') {
        candidate.focus();
        candidate.scrollIntoView({ behavior: ux.prefersReducedMotion() ? 'auto' : 'smooth', block: 'center' });
        return;
      }
    }
    showToast('All visible fields are translated!');
  }

  function renderTranslateMode() {
    if (!state.exp) return;
    document.querySelector('#el-tr-welcome p').hidden = (state.role !== 'translate' && !grantToken);
    document.getElementById('el-tr-toggle-preview').setAttribute('aria-pressed', String(state.trShowPreview));
    translatePreviewPane.hidden = !state.trShowPreview;
    translateSplit.classList.toggle('no-preview', !state.trShowPreview);
    renderTranslateGlossary();

    var rows = Model.extractTranslationRows(state.exp, state.trSource, state.trTarget);
    var stats = Model.getTranslationStats(rows);
    translateProgressEl.textContent = state.trTarget.toUpperCase() + ': ' + stats.translated + ' / ' + stats.total + ' translated' + (stats.review ? (' · ' + stats.review + ' to review') : '');

    translateRowsEl.textContent = '';
    var filtered = rows.filter(function (r) { return state.trFilter === 'all' || r.status === state.trFilter; });
    if (!filtered.length) {
      var empty = document.createElement('p');
      empty.className = 'xped-caption';
      empty.textContent = 'No fields match this filter.';
      translateRowsEl.appendChild(empty);
      renderTranslatePreview();
      return;
    }

    // Group rows cleanly by Start Page & Station (human-readable sections!)
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
      det.open = true;
      var sum = document.createElement('summary');
      var left = document.createElement('span');
      if (grp.title !== 'Start Page') left.setAttribute('translate', 'no');
      left.textContent = grp.title;
      var cnt = document.createElement('span');
      cnt.className = 'xped-caption';
      cnt.textContent = grp.rows.length + ' fields';
      sum.appendChild(left);
      sum.appendChild(cnt);
      det.appendChild(sum);

      grp.rows.forEach(function (row) {
        var rEl = document.createElement('div');
        rEl.className = 'el-tr-row';
        rEl.dataset.status = row.status;

        var rHead = document.createElement('div');
        rHead.className = 'el-tr-row-head';
        var locSpan = document.createElement('strong');
        locSpan.textContent = row.location;
        var rightMeta = document.createElement('div');
        rightMeta.className = 'el-btn-row';
        var st = document.createElement('span');
        st.className = 'el-status-inline ' + (row.status === 'translated' ? 'is-live' : (row.status === 'needs_review' ? 'is-warn' : ''));
        st.textContent = row.status === 'needs_review' ? 'Review' : (row.status === 'translated' ? 'Done' : 'Missing');
        var copySrc = document.createElement('button');
        copySrc.type = 'button';
        copySrc.className = 'el-btn el-btn-sm';
        copySrc.title = 'Copy source text';
        copySrc.appendChild(Icons.icon('copy', 13));
        copySrc.appendChild(document.createTextNode('Copy'));
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
        if (row.altSource) {
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
        ta.placeholder = 'Write ' + state.trTarget.toUpperCase() + ' translation… (Ctrl/Cmd+Enter for next)';
        ta.value = state.trPendingTexts[row.key] !== undefined ? state.trPendingTexts[row.key] : row.target;

        var rowExp = state.exp;
        function updateLocalizedText(value) {
          var activeRow = rowExp === state.exp ? row : Model.extractTranslationRows(state.exp, state.trSource, state.trTarget).find(function (item) { return item.key === row.key; });
          if (activeRow) activeRow.locObj[state.trTarget] = value;
          state.trPendingTexts[row.key] = value;
        }
        function focusContext() {
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
          updateLocalizedText(ta.value);
          rEl.dataset.status = ta.value.trim() ? 'translated' : 'untranslated';
          renderTranslatePreview();
          scheduleTranslateAutosave();
        });
        copySrc.addEventListener('click', function () {
          ta.value = row.source;
          updateLocalizedText(ta.value);
          focusContext();
          scheduleTranslateAutosave();
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

  /* ---- Full Interactive Preview Sandbox (Desktop/Mobile, Milestones, Branching, Progressive Disclosure) ---- */
  function evalPreviewBranching(mod, step) {
    var rules = step.branching || [];
    for (var i = 0; i < rules.length; i += 1) {
      var rule = rules[i];
      var val = state.previewPos.answers[rule.blockId];
      if (val === undefined || val === null) continue;
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

  function renderPreviewMode() {
    if (!state.exp) return;
    var pLang = state.previewLang || state.editLang;
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
          renderPreviewMode();
        },
        onSelectModule: function (_m, idx) {
          state.previewPos.view = 'step';
          state.previewPos.modIdx = idx;
          state.previewPos.stepIdx = 0;
          renderPreviewMode();
        },
      });
      return;
    }

    var mod = visibleMods[state.previewPos.modIdx] || visibleMods[0];
    if (state.previewPos.view === 'milestone') {
      var mCard = document.createElement('div');
      mCard.className = 'xped-card domain-accent-' + (mod.domain || 'general') + ' anim-next';
      mCard.classList.add('el-milestone-preview');
      var mh = document.createElement('h1');
      mh.className = 'xped-step-title';
      mh.textContent = Model.ui(pLang, 'milestoneTitle');
      var mp = document.createElement('p');
      mp.textContent = Model.getLocalized(mod.milestoneMessage, pLang, state.exp.defaultLanguage) || Model.getLocalized(mod.title, pLang, state.exp.defaultLanguage);
      var mBtn = document.createElement('button');
      mBtn.type = 'button';
      mBtn.className = 'xped-btn xped-btn-sun';
      mBtn.textContent = Model.ui(pLang, 'milestoneNext');
      mBtn.addEventListener('click', function () {
        state.previewPos.modIdx += 1;
        state.previewPos.stepIdx = 0;
        state.previewPos.view = 'step';
        renderPreviewMode();
      });
      mCard.appendChild(mh);
      mCard.appendChild(mp);
      mCard.appendChild(mBtn);
      previewContainerEl.appendChild(mCard);
      return;
    }

    var step = (mod.steps || [])[state.previewPos.stepIdx] || (mod.steps || [])[0];
    if (!step) { state.previewPos.view = 'start'; renderPreviewMode(); return; }

    var card = document.createElement('div');
    card.className = 'xped-card domain-accent-' + (mod.domain || 'general') + ' anim-next';
    var h1 = document.createElement('h1');
    h1.className = 'xped-step-title';
    var stTitle = Model.getLocalized(step.title, pLang, state.exp.defaultLanguage);
    h1.textContent = stTitle;
    card.appendChild(h1);

    var interactiveTypes = { mcq: 1, myth_fact: 1, scale: 1, reflection: 1, wordcloud: 1, ranking: 1, hotspot: 1, balance_scale: 1, mini_plan: 1 };
    var stepHasAnswered = (step.blocks || []).some(function (b) {
      return interactiveTypes[b.type] && state.previewPos.answers[b.id] !== undefined && state.previewPos.answers[b.id] !== '';
    });

    var stack = document.createElement('div');
    stack.className = 'xped-blocks-stack';
    (step.blocks || []).forEach(function (blk) {
      stack.appendChild(Blocks.renderBlock(blk, {
        lang: pLang,
        defaultLang: state.exp.defaultLanguage,
        stepTitle: stTitle,
        interactive: true,
        stepHasAnswered: stepHasAnswered,
        answers: state.previewPos.answers,
        onAnswer: function (bid, val) {
          state.previewPos.answers[bid] = val;
          stack.querySelectorAll('.xped-reveal-locked').forEach(function (locked) {
            locked.classList.remove('xped-reveal-locked');
            locked.classList.add('xped-reveal-unlocked');
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
      if (state.previewPos.stepIdx > 0) state.previewPos.stepIdx -= 1;
      else if (state.previewPos.modIdx > 0) {
        state.previewPos.modIdx -= 1;
        state.previewPos.stepIdx = Math.max(0, (visibleMods[state.previewPos.modIdx].steps || []).length - 1);
      } else state.previewPos.view = 'start';
      renderPreviewMode();
    });
    var nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'xped-btn xped-btn-primary';
    nextBtn.appendChild(document.createTextNode(Model.ui(pLang, 'next')));
    nextBtn.appendChild(Icons.icon('arrowRight', 16));
    nextBtn.addEventListener('click', function () {
      var jump = evalPreviewBranching(mod, step);
      if (jump >= 0 && jump !== state.previewPos.stepIdx) {
        state.previewPos.stepIdx = jump;
      } else if (state.previewPos.stepIdx < (mod.steps || []).length - 1) {
        state.previewPos.stepIdx += 1;
      } else {
        if ((state.previewPos.completedIds || []).indexOf(mod.id) < 0) {
          state.previewPos.completedIds.push(mod.id);
        }
        if (state.previewPos.modIdx < visibleMods.length - 1) {
          state.previewPos.view = 'milestone';
        } else {
          state.previewPos.view = 'start';
        }
      }
      renderPreviewMode();
    });
    nav.appendChild(prevBtn);
    nav.appendChild(nextBtn);
    card.appendChild(nav);
    previewContainerEl.appendChild(card);
  }

  /* ---- Visual Block Picker Dialog with Search & Icon Badges ---- */
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

  function renderBlockPickerList(query) {
    var body = document.getElementById('el-picker-body');
    var q = String(query || '').trim().toLowerCase();
    body.textContent = '';
    var anyRendered = false;
    [
      { key: 'content', title: 'Explain & Media' },
      { key: 'interactive', title: 'Ask & Reflect (Mentimeter-Style)' },
      { key: 'xped', title: 'xPED Pain-Education Tools' },
    ].forEach(function (cat) {
      var items = Model.BLOCK_CATALOG.filter(function (b) {
        if (b.category !== cat.key) return false;
        if (!q) return true;
        return (b.label + ' ' + b.desc + ' ' + b.type).toLowerCase().indexOf(q) >= 0;
      });
      if (!items.length) return;
      anyRendered = true;
      var sec = document.createElement('div');
      sec.className = 'el-picker-cat';
      var h3 = document.createElement('h3');
      h3.textContent = cat.title;
      sec.appendChild(h3);
      var grid = document.createElement('div');
      grid.className = 'el-picker-grid';
      items.forEach(function (item) {
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
        btn.addEventListener('click', function () {
          var pair = currentModuleAndStep();
          if (pair.step) {
            mutate(function () {
              var nb = Model.createBlock(item.type);
              var idx = state.insertBlockAt >= 0 ? state.insertBlockAt : pair.step.blocks.length;
              pair.step.blocks.splice(idx, 0, nb);
              if (pair.step.status === 'empty') pair.step.status = 'draft';
              state.selectedBlockId = nb.id;
              state.inspectorTab = 'block';
            });
          }
          Icons.closeDialogAnimated(blockPickerDialog);
        });
        grid.appendChild(btn);
      });
      sec.appendChild(grid);
      body.appendChild(sec);
    });
    if (!anyRendered) {
      var empty = document.createElement('p');
      empty.className = 'xped-caption';
      empty.textContent = 'No blocks match "' + q + '".';
      body.appendChild(empty);
    }
  }

  function openBlockPicker() {
    var searchInp = document.getElementById('el-picker-search');
    if (searchInp) searchInp.value = '';
    renderBlockPickerList('');
    blockPickerDialog.showModal();
    if (searchInp) setTimeout(function () { searchInp.focus(); }, 60);
  }

  /* ---- Share, QR & Collaborators Dialog ---- */
  async function openShareDialog() {
    if (!expeditionId) return;
    try {
      var data = await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/sharing');
      var share = data.share || {};
      document.getElementById('el-share-enabled').checked = !!share.enabled;
      document.getElementById('el-share-peer-results').checked = share.showPeerResults !== false;
      document.getElementById('el-share-pilot-feedback').checked = share.collectPilotFeedback !== false;
      var scChk = document.getElementById('el-share-step-comments');
      if (scChk) scChk.checked = !!share.allowStepComments;

      function updateShareUrlAndQr() {
        var cohort = document.getElementById('el-share-cohort').value.trim();
        var url = window.location.origin + '/elearning/p/' + encodeURIComponent(share.token || '');
        if (cohort) url += '?cohort=' + encodeURIComponent(cohort);
        document.getElementById('el-share-url').value = url;
        document.getElementById('el-share-open-link').href = url;
        var qrHost = document.getElementById('el-share-qr');
        qrHost.textContent = '';
        if (share.token) qrHost.appendChild(QR.createSvgElement(url));
      }
      updateShareUrlAndQr();
      document.getElementById('el-share-cohort').oninput = updateShareUrlAndQr;
      renderMembersList(data.members || []);
      renderGrantsList(data.grants || []);
      shareDialog.showModal();
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  function renderMembersList(members) {
    var host = document.getElementById('el-members-list');
    host.textContent = '';
    members.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'el-member-row';
      var lbl = document.createElement('span');
      lbl.textContent = m.email + ' · ' + (m.role === 'translate' ? 'Translator' : 'Co-Editor');
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'el-btn el-btn-danger el-btn-sm';
      rm.textContent = 'Remove';
      rm.addEventListener('click', async function () {
        var res = await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/sharing', {
          method: 'POST',
          body: JSON.stringify({ action: 'remove_member', email: m.email }),
        });
        renderMembersList(res.members || []);
      });
      row.appendChild(lbl);
      row.appendChild(rm);
      host.appendChild(row);
    });
  }

  function renderGrantsList(grants) {
    var host = document.getElementById('el-grants-list');
    host.textContent = '';
    grants.forEach(function (g) {
      var row = document.createElement('div');
      row.className = 'el-member-row';
      var url = window.location.origin + g.urlPath;
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.readOnly = true;
      inp.value = url;
      inp.classList.add('el-grant-url');
      var lbl = document.createElement('span');
      lbl.textContent = (g.label || 'Translator') + ' (' + String(g.targetLanguage || 'de').toUpperCase() + ')';
      var rev = document.createElement('button');
      rev.type = 'button';
      rev.className = 'el-btn el-btn-danger el-btn-sm';
      rev.textContent = 'Revoke';
      rev.addEventListener('click', async function () {
        await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/sharing', {
          method: 'POST',
          body: JSON.stringify({ action: 'revoke_grant', grantId: g.id }),
        });
        openShareDialog();
      });
      row.appendChild(lbl);
      row.appendChild(inp);
      row.appendChild(rev);
      host.appendChild(row);
    });
  }

  function refreshMoreMenu() {
    moreMenuDD.setItems([
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
  document.getElementById('el-add-module-btn').addEventListener('click', function () { moduleRecipeDialog.showModal(); });
  moduleRecipeDialog.querySelectorAll('[data-recipe]').forEach(function (btn) {
    var icoSlot = btn.querySelector('.el-picker-ico');
    var icoName = btn.getAttribute('data-recipe-icon') || 'plus';
    if (icoSlot) icoSlot.appendChild(Icons.icon(icoName, 17));
    btn.addEventListener('click', function () {
      var recipe = btn.getAttribute('data-recipe');
      mutate(function () {
        var mod = Model.createModule(recipe, (state.exp.modules || []).length);
        state.exp.modules.push(mod);
        state.selectedTarget = { type: 'step', moduleId: mod.id, stepId: mod.steps[0].id };
        state.selectedBlockId = (mod.steps[0].blocks && mod.steps[0].blocks[0]) ? mod.steps[0].blocks[0].id : '';
      });
      Icons.closeDialogAnimated(moduleRecipeDialog);
    });
  });

  document.querySelectorAll('.el-mode-tab').forEach(function (tab) {
    tab.addEventListener('click', async function () {
      if (!state.exp) return;
      if (state.mode === 'edit' && savedVersion !== saveVersion) {
        clearTimeout(state.saveTimer);
        await queueStructureSave();
        if (savedVersion !== saveVersion) return;
      }
      if (state.mode === 'translate' && hasPendingTranslations()) {
        clearTimeout(state.trSaveTimer);
        if (!(await saveTranslationsNow()) || hasPendingTranslations()) return;
      }
      setMode(tab.getAttribute('data-mode'));
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

  document.getElementById('el-undo-btn').addEventListener('click', function () {
    if (!state.undoStack.length) return;
    state.redoStack.push(clone(state.exp));
    restoreSnapshot(state.undoStack.pop());
  });
  document.getElementById('el-redo-btn').addEventListener('click', function () {
    if (!state.redoStack.length) return;
    state.undoStack.push(clone(state.exp));
    restoreSnapshot(state.redoStack.pop());
  });

  document.getElementById('el-takeover-btn').addEventListener('click', function () { acquireLease(true); });
  shareBtn.addEventListener('click', openShareDialog);

  async function savePublicShareSettings(extra) {
    var body = Object.assign({
      action: 'update_public',
      enabled: document.getElementById('el-share-enabled').checked,
      showPeerResults: document.getElementById('el-share-peer-results').checked,
      collectPilotFeedback: document.getElementById('el-share-pilot-feedback').checked,
      allowStepComments: !!(document.getElementById('el-share-step-comments') && document.getElementById('el-share-step-comments').checked),
    }, extra || {});
    try {
      await api('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/sharing', { method: 'POST', body: JSON.stringify(body) });
      showToast('Share settings updated.');
      if (extra && extra.rotateToken) openShareDialog();
    } catch (err) { showToast(err.message, 'error'); }
  }
  document.getElementById('el-share-enabled').addEventListener('change', function () { savePublicShareSettings(); });
  document.getElementById('el-share-peer-results').addEventListener('change', function () { savePublicShareSettings(); });
  document.getElementById('el-share-pilot-feedback').addEventListener('change', function () { savePublicShareSettings(); });
  var shareStepCommentsEl = document.getElementById('el-share-step-comments');
  if (shareStepCommentsEl) shareStepCommentsEl.addEventListener('change', function () { savePublicShareSettings(); });

  var pickerSearchEl = document.getElementById('el-picker-search');
  if (pickerSearchEl) pickerSearchEl.addEventListener('input', function () { renderBlockPickerList(pickerSearchEl.value); });

  var nextMissBtn = document.getElementById('el-tr-next-missing');
  if (nextMissBtn) nextMissBtn.addEventListener('click', focusNextMissingTranslation);

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
  document.getElementById('el-share-rotate-btn').addEventListener('click', function () {
    if (window.confirm('Generate a brand-new share URL? The previous link will stop working.')) savePublicShareSettings({ rotateToken: true });
  });
  document.getElementById('el-share-qr-download').addEventListener('click', function () {
    var svg = document.querySelector('#el-share-qr svg');
    if (!svg) return;
    var blob = new Blob([svg.outerHTML], { type: 'image/svg+xml' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'xpeditie-pijn-qr.svg';
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
      showToast('Translator link created!');
      openShareDialog();
    } catch (err) { showToast(err.message, 'error'); }
  });

  document.getElementById('el-tr-toggle-preview').addEventListener('click', function () {
    state.trShowPreview = !state.trShowPreview;
    this.setAttribute('aria-pressed', state.trShowPreview ? 'true' : 'false');
    renderTranslateMode();
  });
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
      state.undoStack = [];
      state.redoStack = [];
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
    state.previewPos = { view: 'start', modIdx: 0, stepIdx: 0, answers: {}, completedIds: [] };
    renderPreviewMode();
  });

  [blockPickerDialog, moduleRecipeDialog, shareDialog].forEach(function (dlg) {
    dlg.addEventListener('close', function () { dlg.returnValue = ''; });
  });
  Icons.wireAnimatedDialogs();
  Model.enableDialogLightDismissFallback();
  Model.setupCopyButtons();

  function showUnavailable(message) {
    setSaveStatus(message, false);
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
      setSaveStatus('Saved', true);
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
