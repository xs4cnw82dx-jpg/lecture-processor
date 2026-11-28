(function () {
  'use strict';

  var Model = window.XpedElearningModel;
  var Icons = window.XpedElearningIcons;
  var Blocks = window.XpedElearningBlocks;
  var RouteMap = window.XpedElearningRouteMap;

  var shareToken = document.body.dataset.shareToken || '';
  var params = new URLSearchParams(window.location.search);
  var cohort = (params.get('cohort') || '').trim() || 'default';
  if (!/^[a-zA-Z0-9_.-]{1,48}$/.test(cohort)) cohort = 'default';
  var queryLang = params.get('lang') || '';

  var mainEl = document.getElementById('el-player-main');
  var langHost = document.getElementById('el-player-lang-host');
  var mapBtn = document.getElementById('el-player-map-btn');
  var homeBtn = document.getElementById('el-player-home-btn');
  var courseLabelEl = document.getElementById('el-player-course-label');
  var progressFillEl = document.getElementById('el-player-progress-fill');
  var routeDialog = document.getElementById('el-player-route-dialog');
  var routeBody = document.getElementById('el-player-route-body');
  var comfortDd = document.getElementById('el-comfort-dd');
  var comfortTrigger = document.getElementById('el-comfort-trigger');

  var storageKey = 'xped_el_progress_' + shareToken;
  var groupKeyPrefix = storageKey + ':group:';
  var groupProgressKey = groupKeyPrefix + cohort;
  var consentKey = groupProgressKey + ':consent';
  var state = {
    exp: null,
    lang: 'nl',
    hasSavedLanguage: false,
    canSaveLocally: true,
    responseQueue: Promise.resolve(),
    resumeResponse: null,
    consent: null,
    consentStored: false,
    sharedAnswers: Object.create(null),
    sharedVisits: [],
    view: 'start',
    navDir: 'next',
    navHistory: [],
    modIdx: 0,
    stepIdx: 0,
    lastModIdx: 0,
    lastStepIdx: 0,
    themePref: 'default',
    sessionId: 'lrn_' + crypto.randomUUID(),
    answers: Object.create(null),
    peerDisclosureTypes: Object.create(null),
    visitedStepIds: [],
    completedModuleIds: [],
    stepComments: [],
    pilotSent: false,
    syncTimer: null,
  };

  var langDD = Icons.createDropdown({
    leadingIcon: 'globe',
    align: 'right',
    ariaLabel: 'Language',
    items: [],
    onChange: function (val) {
      state.lang = val;
      if (window.Xped && window.Xped.i18n) {
        document.cookie = 'xped-course-language=' + val + '; Path=' + location.pathname + '; Max-Age=31536000; SameSite=Lax' +
          (location.protocol === 'https:' ? '; Secure' : '');
      }
      saveLocalProgress();
      updateLangDropdown();
      render();
    },
  });
  langDD.el.hidden = true;
  langHost.appendChild(langDD.el);

  function updateLangDropdown() {
    var enabled = (state.exp && state.exp.enabledLanguages) || ['nl'];
    langDD.el.hidden = enabled.length <= 1;
    langDD.setItems(enabled.map(function (code) {
      return { value: code, label: Model.LANG_LABELS[code] || code.toUpperCase(), shortLabel: code.toUpperCase() };
    }), state.lang);
  }

  function assetUrl(assetId) {
    return '/api/elearning/public/' + encodeURIComponent(shareToken) + '/assets/' + encodeURIComponent(assetId);
  }

  function loadLocalProgress() {
    try {
      var saved = JSON.parse(localStorage.getItem(groupProgressKey));
      var sameGroup = !!saved;
      if (!saved) {
        // The course index previously contained the entire personal draft. A new
        // group may continue that work, while its shared response starts empty.
        saved = JSON.parse(localStorage.getItem(storageKey));
        if (saved && saved.recentGroup) saved = JSON.parse(localStorage.getItem(groupKeyPrefix + saved.recentGroup));
      }
      if (!saved) return;
      var grant;
      if (sameGroup) {
        try { grant = JSON.parse(localStorage.getItem(consentKey)); } catch (_err) { /* Keep personal progress when consent is unreadable. */ }
      }
      if (grant && grant.cohort === cohort && grant.sessionId === saved.sessionId) {
        state.consent = grant;
        state.sessionId = grant.sessionId;
        state.consentStored = true;
        state.sharedAnswers = Object.assign(Object.create(null), saved.sharedAnswers);
        state.sharedVisits = Array.isArray(saved.sharedVisits) ? saved.sharedVisits : [];
        state.peerDisclosureTypes = Object.assign(Object.create(null), saved.peerDisclosureTypes);
        state.stepComments = Array.isArray(saved.stepComments) ? saved.stepComments : [];
        state.pilotSent = saved.pilotSent === true;
      }
      if (saved.answers && typeof saved.answers === 'object') state.answers = Object.assign(Object.create(null), saved.answers);
      if (Array.isArray(saved.navHistory)) state.navHistory = saved.navHistory.filter(function (id) { return typeof id === 'string'; });
      if (Array.isArray(saved.visitedStepIds)) state.visitedStepIds = saved.visitedStepIds;
      if (Array.isArray(saved.completedModuleIds)) state.completedModuleIds = saved.completedModuleIds;
      if (typeof saved.lastModIdx === 'number') state.lastModIdx = saved.lastModIdx;
      if (typeof saved.lastStepIdx === 'number') state.lastStepIdx = saved.lastStepIdx;
      if (saved.lang) { state.lang = saved.lang; state.hasSavedLanguage = true; }
      if (saved.textScale) setTextScale(saved.textScale);
      if (saved.themePref) state.themePref = saved.themePref;
    } catch (_err) {
      state.canSaveLocally = false;
    }
  }

  function saveLocalProgress() {
    try {
      localStorage.setItem(groupProgressKey, JSON.stringify({
        sessionId: state.sessionId,
        sharedAnswers: state.sharedAnswers,
        sharedVisits: state.sharedVisits,
        answers: state.answers,
        peerDisclosureTypes: state.peerDisclosureTypes,
        pilotSent: state.pilotSent,
        navHistory: state.navHistory,
        visitedStepIds: state.visitedStepIds,
        completedModuleIds: state.completedModuleIds,
        stepComments: state.stepComments,
        lastModIdx: state.lastModIdx,
        lastStepIdx: state.lastStepIdx,
        lang: state.lang,
        textScale: document.body.getAttribute('data-text-scale') || 'md',
        themePref: state.themePref,
      }));
      localStorage.setItem(storageKey, JSON.stringify({ recentGroup: cohort }));
    } catch (_err) {
      state.canSaveLocally = false;
    }
  }

  function isSharing() {
    var options = state.exp && state.exp.shareOptions;
    return !!(options && options.collectResponses && state.consent && state.consent.choice === 'share'
      && state.consent.cohort === cohort && state.consent.version === options.collectionVersion && state.consent.sessionId === state.sessionId);
  }

  function resumeQueuedResponse() {
    if (!state.resumeResponse) return;
    state.resumeResponse();
    state.resumeResponse = null;
  }

  function resetSharing() {
    resumeQueuedResponse();
    clearTimeout(state.syncTimer);
    state.consent = null;
    state.consentStored = false;
    state.sessionId = 'lrn_' + crypto.randomUUID();
    state.sharedAnswers = Object.create(null);
    state.sharedVisits = [];
    state.peerDisclosureTypes = Object.create(null);
    state.stepComments = [];
    state.pilotSent = false;
  }

  function setConsent(choice) {
    resetSharing();
    if (choice) state.consent = { choice: choice, cohort: cohort, version: state.exp.shareOptions.collectionVersion, sessionId: state.sessionId };
    try {
      if (state.consent) localStorage.setItem(consentKey, JSON.stringify(state.consent));
      else localStorage.removeItem(consentKey);
      state.consentStored = !!state.consent;
    } catch (_err) { state.canSaveLocally = false; }
    saveLocalProgress();
  }

  function grantIsCurrent(grant) {
    if (!isSharing() || grant !== state.consent) return false;
    if (!state.consentStored) return true;
    try { return localStorage.getItem(consentKey) === JSON.stringify(grant); }
    catch (_err) { return false; }
  }

  function sendResponse(completed, pilotFeedback) {
    if (!isSharing()) return Promise.resolve({ ok: false });
    var grant = state.consent;
    var body = JSON.stringify({
      sessionId: state.sessionId,
      consent: true,
      collectionVersion: grant.version,
      cohort: cohort,
      language: state.lang,
      answers: state.sharedAnswers,
      peerDisclosureTypes: state.peerDisclosureTypes,
      visitedStepIds: state.sharedVisits,
      completed: completed || state.view === 'summary',
      pilotFeedback: pilotFeedback,
      stepComments: state.stepComments.length ? state.stepComments : undefined,
    });
    var request = state.responseQueue.then(async function () {
      // Keep submitted answers or feedback queued until the learner leaves the
      // sharing form, then recheck the grant in case either tab withdrew it.
      while (state.view === 'consent' && grantIsCurrent(grant)) {
        await new Promise(function (resolve) { state.resumeResponse = resolve; });
      }
      if (!grantIsCurrent(grant)) return { ok: false };
      var response = await fetch('/api/elearning/public/' + encodeURIComponent(shareToken) + '/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body,
      });
      if ((response.status === 403 || response.status === 409) && grantIsCurrent(grant)) {
        // A course owner changed the pilot settings while this learner had the course open.
        setConsent(null);
        state.exp.shareOptions = { collectResponses: false };
        try {
          var current = await fetch('/api/elearning/public/' + encodeURIComponent(shareToken));
          if (current.ok) state.exp.shareOptions = (await current.json()).expedition.shareOptions;
        } finally { render(); }
      }
      return response;
    });
    state.responseQueue = request.catch(function () {});
    return request;
  }

  function scheduleSync(completed) {
    saveLocalProgress();
    clearTimeout(state.syncTimer);
    if (isSharing()) state.syncTimer = setTimeout(function () { sendResponse(completed); }, 350);
  }

  async function fetchAggregate(blockId) {
    try {
      var r = await fetch('/api/elearning/public/' + encodeURIComponent(shareToken) + '/aggregates/' + encodeURIComponent(blockId));
      if (!r.ok) return null;
      var d = await r.json();
      return d.aggregate || null;
    } catch (_err) { return null; }
  }

  function setTextScale(scale) {
    document.documentElement.dataset.readingSize = scale;
    document.body.setAttribute('data-text-scale', scale);
    document.querySelectorAll('.el-text-scale-group button').forEach(function (btn) {
      var selected = btn.getAttribute('data-scale') === scale;
      btn.classList.toggle('is-active', selected);
      btn.setAttribute('aria-pressed', String(selected));
    });
  }

  function totalStepsCount() {
    if (!state.exp) return 0;
    return (state.exp.modules || []).reduce(function (acc, m) { return acc + (m.steps || []).length; }, 0);
  }

  function updateProgressBar() {
    var total = Math.max(1, totalStepsCount());
    var pct = state.view === 'summary' ? 100 : (state.view === 'start' ? 0 : Math.min(100, Math.round((state.visitedStepIds.length / total) * 100)));
    progressFillEl.value = pct;
    progressFillEl.setAttribute('aria-label', Model.ui(state.lang, 'progress'));
  }

  function evaluateBranching(mod, step) {
    var rules = step.branching || [];
    for (var i = 0; i < rules.length; i += 1) {
      var rule = rules[i];
      var val = state.answers[rule.blockId];
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

  function showCurrentView() {
    render();
    mainEl.focus({ preventScroll: true });
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function goBack() {
    var mods = (state.exp && state.exp.modules) || [];
    state.navDir = 'prev';
    while (state.navHistory.length) {
      var previousId = state.navHistory.pop();
      for (var i = 0; i < mods.length; i++) {
        var index = (mods[i].steps || []).findIndex(function (step) { return step.id === previousId; });
        if (index < 0) continue;
        state.modIdx = i;
        state.stepIdx = index;
        state.view = 'step';
        showCurrentView();
        return;
      }
    }
    if (state.stepIdx > 0) state.stepIdx -= 1;
    else if (state.modIdx > 0) {
      state.modIdx -= 1;
      state.stepIdx = Math.max(0, (mods[state.modIdx].steps || []).length - 1);
    } else state.view = 'start';
    showCurrentView();
  }

  function goNext() {
    var mods = (state.exp && state.exp.modules) || [];
    var mod = mods[state.modIdx];
    if (!mod) return;
    var step = mod.steps[state.stepIdx];
    var isLastMod = state.modIdx === mods.length - 1;
    var isLastStep = state.stepIdx === mod.steps.length - 1;
    state.navDir = 'next';
    var jumpIdx = evaluateBranching(mod, step);
    if (jumpIdx >= 0 && jumpIdx !== state.stepIdx) {
      state.navHistory.push(step.id);
      state.stepIdx = jumpIdx;
    } else if (!isLastStep) {
      state.navHistory.push(step.id);
      state.stepIdx += 1;
    } else {
      if (state.completedModuleIds.indexOf(mod.id) < 0) state.completedModuleIds.push(mod.id);
      if (!isLastMod) state.view = 'milestone';
      else { state.view = 'summary'; scheduleSync(true); }
    }
    showCurrentView();
  }

  function canShareBlock(id) {
    // Editing an older private answer may retain text or selections from before consent.
    return isSharing() && (!Object.hasOwn(state.answers, id) || Object.hasOwn(state.sharedAnswers, id));
  }

  function sharesAnswer(block) {
    return canShareBlock(block.id) && state.exp.shareOptions.showPeerResults && block.settings && block.settings.showPeerResults
      && (!Object.hasOwn(state.answers, block.id) || state.peerDisclosureTypes[block.id] === block.type);
  }

  function responseDisclosure(blocks, expanded) {
    var notice = document.createElement(expanded ? 'aside' : 'details');
    notice.className = 'el-response-disclosure';
    var heading = document.createElement(expanded ? 'strong' : 'summary');
    heading.textContent = Model.ui(state.lang, 'answerPrivacy');
    var body = document.createElement('p');
    var messages = [state.canSaveLocally ? 'deviceResume' : 'storageUnavailable'];
    if (isSharing()) messages.unshift('authorAccess');
    var shared = blocks.filter(sharesAnswer);
    if (shared.some(function (block) { return block.type !== 'wordcloud'; })) messages.push('sharedResults');
    if (shared.some(function (block) { return block.type === 'wordcloud'; })) messages.push('sharedWords');
    body.textContent = messages.map(function (key) { return Model.ui(state.lang, key); }).join(' ');
    notice.append(heading, body);
    if (expanded && state.exp.shareOptions && state.exp.shareOptions.collectResponses && state.consent) {
      var edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'xped-btn xped-btn-secondary';
      edit.textContent = Model.ui(state.lang, 'changeConsent');
      edit.addEventListener('click', function () {
        state.view = 'consent';
        state.modIdx = state.lastModIdx;
        state.stepIdx = state.lastStepIdx;
        showCurrentView();
      });
      notice.appendChild(edit);
    }
    return notice;
  }

  function renderConsent() {
    mainEl.classList.add('is-step-view');
    document.body.removeAttribute('data-active-domain');
    RouteMap.renderConsent(mainEl, state.lang, state.exp.modules, { ...state.exp.shareOptions, cohort: cohort, changing: isSharing() }, function (choice) {
      if (!state.consent || state.consent.choice !== choice) setConsent(choice);
      state.view = 'step';
      showCurrentView();
    });
  }

  function renderStartPage() {
    mainEl.classList.remove('is-step-view');
    document.body.removeAttribute('data-active-domain');
    RouteMap.renderStartPage(mainEl, {
      exp: state.exp,
      disclosure: responseDisclosure(state.exp.modules.flatMap(function (module) {
        return module.steps.flatMap(function (step) { return step.blocks; });
      }), true),
      lang: state.lang,
      editable: false,
      hasProgress: state.visitedStepIds.length > 0,
      completedModuleIds: state.completedModuleIds,
      assetUrl: assetUrl,
      onStart: function () {
        var mods = state.exp.modules || [];
        if (!mods.length) return;
        state.navDir = 'next';
        if (state.visitedStepIds.length > 0 && mods[state.lastModIdx]) {
          state.modIdx = state.lastModIdx;
          var stLen = (mods[state.modIdx].steps || []).length;
          state.stepIdx = Math.min(state.lastStepIdx, Math.max(0, stLen - 1));
        } else {
          state.modIdx = 0;
          state.stepIdx = 0;
        }
        state.view = 'step';
        showCurrentView();
      },
      onSelectModule: function (_m, idx) {
        state.navDir = 'next';
        state.modIdx = idx;
        state.stepIdx = 0;
        state.view = 'step';
        showCurrentView();
      },
    });
  }

  function renderStep() {
    mainEl.classList.add('is-step-view');
    var exp = state.exp;
    var lang = state.lang;
    var defLang = exp.defaultLanguage || 'nl';
    var mods = exp.modules || [];
    var mod = mods[state.modIdx];
    if (!mod || !(mod.steps || []).length) {
      state.view = 'summary';
      render();
      return;
    }
    document.body.setAttribute('data-active-domain', mod.domain || 'general');
    var step = mod.steps[state.stepIdx] || mod.steps[0];
    state.lastModIdx = state.modIdx;
    state.lastStepIdx = state.stepIdx;
    if (state.visitedStepIds.indexOf(step.id) < 0) {
      state.visitedStepIds.push(step.id);
    }
    if (isSharing() && !state.sharedVisits.includes(step.id)) {
      state.sharedVisits.push(step.id);
      scheduleSync(false);
    } else saveLocalProgress();

    mainEl.textContent = '';
    var card = document.createElement('article');
    card.className = 'xped-card domain-accent-' + (mod.domain || 'general') + (state.navDir === 'prev' ? ' anim-prev' : ' anim-next');

    // Clean quiet breadcrumb + segmented progress bar (hide awkward "Stap 1 van 1"!)
    var kicker = document.createElement('div');
    kicker.className = 'xped-step-kicker-row';
    var crumb = document.createElement('span');
    crumb.className = 'xped-step-crumb';
    var dot = document.createElement('span');
    dot.className = 'xped-domain-dot domain-' + (mod.domain || 'general');
    crumb.appendChild(dot);
    crumb.appendChild(document.createTextNode(Model.getLocalized(mod.title, lang, defLang) || ('Station ' + (state.modIdx + 1))));
    kicker.appendChild(crumb);

    if (mod.steps.length > 1) {
      var segs = document.createElement('div');
      segs.className = 'el-step-segments';
      segs.setAttribute('aria-label', Model.ui(lang, 'stepOf', { cur: state.stepIdx + 1, total: mod.steps.length }));
      mod.steps.forEach(function (_s, si) {
        var sg = document.createElement('span');
        sg.className = 'el-step-seg' + (si < state.stepIdx ? ' is-done' : (si === state.stepIdx ? ' is-current' : ''));
        segs.appendChild(sg);
      });
      kicker.appendChild(segs);
    }
    card.appendChild(kicker);

    var h1 = document.createElement('h1');
    h1.className = 'xped-step-title';
    var stTitle = Model.getLocalized(step.title, lang, defLang);
    h1.textContent = stTitle;
    card.appendChild(h1);

    var interactiveTypes = { mcq: 1, myth_fact: 1, scale: 1, reflection: 1, wordcloud: 1, ranking: 1, hotspot: 1, balance_scale: 1, mini_plan: 1 };
    function hasAnyStepAnswer() {
      return (step.blocks || []).some(function (b) {
        return interactiveTypes[b.type] && Model.hasMeaningfulAnswer(state.answers[b.id]);
      });
    }
    var stepHasAnswered = hasAnyStepAnswer();

    var stack = document.createElement('div');
    stack.className = 'xped-blocks-stack';
    (step.blocks || []).forEach(function (blk) {
      stack.appendChild(Blocks.renderBlock(blk, {
        lang: lang,
        defaultLang: defLang,
        stepTitle: stTitle,
        interactive: true,
        stepHasAnswered: stepHasAnswered,
        answers: state.answers,
        collectResponses: canShareBlock(blk.id),
        sharedAnswer: sharesAnswer(blk),
        onAnswer: function (bid, val) {
          if (sharesAnswer(blk)) state.peerDisclosureTypes[bid] = blk.type;
          else delete state.peerDisclosureTypes[bid];
          if (canShareBlock(bid)) state.sharedAnswers[bid] = val;
          state.answers[bid] = val;
          // Progressive Disclosure: unlock only when a meaningful answer exists (UX-077)
          var nowAnswered = hasAnyStepAnswer();
          stack.querySelectorAll('[data-reveal-after="1"]').forEach(function (node) {
            node.classList.toggle('xped-reveal-locked', !nowAnswered);
            node.classList.toggle('xped-reveal-unlocked', nowAnswered);
          });
          scheduleSync(false);
        },
        fetchAggregate: isSharing() && exp.shareOptions.showPeerResults ? fetchAggregate : null,
        assetUrl: assetUrl,
      }));
    });
    card.appendChild(stack);
    if ((step.blocks || []).some(function (block) { return interactiveTypes[block.type]; })) {
      card.appendChild(responseDisclosure(step.blocks, false));
    }

    var nav = document.createElement('div');
    nav.className = 'el-player-nav';
    var backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'xped-btn xped-btn-secondary';
    backBtn.appendChild(Icons.icon('arrowLeft', 16));
    backBtn.appendChild(document.createTextNode(Model.ui(lang, 'back')));
    backBtn.addEventListener('click', goBack);

    var isLastMod = state.modIdx === mods.length - 1;
    var isLastStep = state.stepIdx === mod.steps.length - 1;
    var nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'xped-btn xped-btn-primary';
    nextBtn.appendChild(document.createTextNode((isLastMod && isLastStep) ? Model.ui(lang, 'finish') : Model.ui(lang, 'next')));
    nextBtn.appendChild(Icons.icon('arrowRight', 16));
    nextBtn.addEventListener('click', goNext);

    nav.appendChild(backBtn);
    nav.appendChild(nextBtn);
    card.appendChild(nav);
    mainEl.appendChild(card);

    if (isSharing() && exp.shareOptions.allowStepComments) {
      var revWrap = document.createElement('div');
      revWrap.className = 'el-review-wrap el-no-print';
      var revBtn = document.createElement('button');
      revBtn.type = 'button';
      revBtn.className = 'xped-btn xped-btn-ghost';
      revBtn.appendChild(Icons.icon('messageCircle', 16));
      revBtn.appendChild(document.createTextNode(Model.ui(lang, 'stepCommentBtn')));
      revBtn.setAttribute('aria-expanded', 'false');
      var revPanel = document.createElement('div');
      revPanel.className = 'el-review-panel';
      revPanel.hidden = true;
      var revTitle = document.createElement('strong');
      revTitle.textContent = Model.ui(lang, 'stepCommentTitle');
      var revTa = document.createElement('textarea');
      revTa.className = 'xped-textarea';
      revTa.rows = 3;
      revTa.maxLength = 1200;
      revTa.placeholder = Model.ui(lang, 'stepCommentPlaceholder');
      revTa.setAttribute('aria-label', revTitle.textContent);
      var revRow = document.createElement('div');
      revRow.className = 'el-btn-row';
      var revSend = document.createElement('button');
      revSend.type = 'button';
      revSend.className = 'xped-btn xped-btn-primary';
      revSend.textContent = Model.ui(lang, 'stepCommentSend');
      var revStat = document.createElement('span');
      revStat.className = 'xped-caption';
      revStat.setAttribute('role', 'status');
      revRow.appendChild(revSend);
      revRow.appendChild(revStat);
      revPanel.appendChild(revTitle);
      revPanel.appendChild(revTa);
      revPanel.appendChild(revRow);

      revBtn.addEventListener('click', function () {
        revPanel.hidden = !revPanel.hidden;
        revBtn.setAttribute('aria-expanded', String(!revPanel.hidden));
        if (!revPanel.hidden) revTa.focus();
      });
      revSend.addEventListener('click', async function () {
        var txt = revTa.value.trim();
        if (!txt) return;
        var comment = {
          moduleId: mod.id,
          stepId: step.id,
          moduleTitle: Model.getLocalized(mod.title, lang, defLang),
          stepTitle: stTitle,
          reviewer: cohort,
          comment: txt,
          createdAt: Math.floor(Date.now() / 1000),
        };
        var commentGrant = state.consent;
        state.stepComments.push(comment);
        revSend.disabled = true;
        revTa.readOnly = true;
        try {
          var result = await sendResponse(false);
          if (!grantIsCurrent(commentGrant)) return;
          if (!result.ok) throw new Error('Comment unavailable');
          saveLocalProgress();
          revTa.value = '';
          revStat.textContent = Model.ui(lang, 'stepCommentSent');
        } catch (_err) {
          if (!grantIsCurrent(commentGrant)) return;
          state.stepComments = state.stepComments.filter(function (item) { return item !== comment; });
          revStat.textContent = Model.ui(lang, 'feedbackFailed');
        } finally {
          revSend.disabled = false;
          revTa.readOnly = false;
        }
      });
      revWrap.appendChild(revBtn);
      revWrap.appendChild(revPanel);
      mainEl.appendChild(revWrap);
    }

    var saveNote = document.createElement('p');
    saveNote.className = 'el-player-save-note';
    saveNote.textContent = Model.ui(lang, state.canSaveLocally ? 'savedAutomatically' : 'storageUnavailable');
    mainEl.appendChild(saveNote);
  }

  function buildMilestoneCheckSvg() {
    var ns = 'http://www.w3.org/2000/svg';
    function sEl(tag, attrs) {
      var n = document.createElementNS(ns, tag);
      Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
      return n;
    }
    var svg = sEl('svg', { viewBox: '0 0 84 84', class: 'el-milestone-svg', 'aria-hidden': 'true' });
    svg.appendChild(sEl('circle', { cx: 42, cy: 42, r: 30, fill: 'none', stroke: '#1fe4a9', 'stroke-width': 2.5, class: 'el-ms-ripple' }));
    svg.appendChild(sEl('circle', { cx: 42, cy: 42, r: 28, fill: '#1fe4a9', class: 'el-ms-circle' }));
    svg.appendChild(sEl('path', {
      d: 'M30 43.5 L38.5 51.5 L54.5 34.5',
      fill: 'none',
      stroke: '#062940',
      'stroke-width': 4.2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      class: 'el-ms-check',
    }));
    var sparks = sEl('g', { class: 'el-ms-sparks' });
    [
      { x1: 42, y1: 4, x2: 42, y2: 9, c: '#ffd617' },
      { x1: 72, y1: 16, x2: 68, y2: 20, c: '#1fe4a9' },
      { x1: 78, y1: 42, x2: 73, y2: 42, c: '#ffd617' },
      { x1: 12, y1: 16, x2: 16, y2: 20, c: '#007acc' },
      { x1: 6, y1: 42, x2: 11, y2: 42, c: '#1fe4a9' },
      { x1: 68, y1: 66, x2: 72, y2: 70, c: '#007acc' },
    ].forEach(function (sp) {
      sparks.appendChild(sEl('line', {
        x1: sp.x1,
        y1: sp.y1,
        x2: sp.x2,
        y2: sp.y2,
        stroke: sp.c,
        'stroke-width': 2.5,
        'stroke-linecap': 'round',
      }));
    });
    svg.appendChild(sparks);
    return svg;
  }

  function renderMilestone() {
    mainEl.classList.add('is-step-view');
    var exp = state.exp;
    var lang = state.lang;
    var defLang = exp.defaultLanguage || 'nl';
    var mods = exp.modules || [];
    var mod = mods[state.modIdx];
    var nextMod = mods[state.modIdx + 1];
    mainEl.textContent = '';

    var card = document.createElement('article');
    card.className = 'el-milestone-card';

    var anim = document.createElement('div');
    anim.className = 'el-milestone-anim';
    anim.appendChild(buildMilestoneCheckSvg());
    card.appendChild(anim);

    var h1 = document.createElement('h1');
    h1.textContent = Model.ui(lang, 'milestoneTitle');
    card.appendChild(h1);

    var p = document.createElement('p');
    p.textContent = Model.getLocalized(mod.milestoneMessage, lang, defLang) || (Model.getLocalized(mod.title, lang, defLang) || '');
    card.appendChild(p);

    // Compact Journey Progress Trail (✓ 1 — ● 2 — ○ 3)
    if (mods.length > 1) {
      var trail = document.createElement('div');
      trail.className = 'el-milestone-trail';
      mods.forEach(function (m, idx) {
        var done = state.completedModuleIds.indexOf(m.id) >= 0;
        var isNext = idx === state.modIdx + 1;
        var d = document.createElement('span');
        d.className = 'el-ms-dot' + (done ? ' is-done' : (isNext ? ' is-next' : ''));
        if (done && Icons) {
          d.appendChild(Icons.icon('check', 13));
        } else {
          d.textContent = String(idx + 1);
        }
        trail.appendChild(d);
        if (idx < mods.length - 1) {
          var dash = document.createElement('span');
          dash.className = 'el-ms-dash' + (done ? ' is-done' : '');
          trail.appendChild(dash);
        }
      });
      card.appendChild(trail);
    }

    if (nextMod) {
      var nextPrev = document.createElement('div');
      nextPrev.className = 'el-milestone-next';
      nextPrev.textContent = Model.ui(lang, 'milestoneNextPreview', {
        title: Model.getLocalized(nextMod.title, lang, defLang) || ('Station ' + (state.modIdx + 2)),
        min: nextMod.estimatedMinutes || 5,
      });
      card.appendChild(nextPrev);
    }

    var acts = document.createElement('div');
    acts.className = 'el-milestone-actions';
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'xped-btn xped-btn-sun';
    btn.appendChild(document.createTextNode(Model.ui(lang, 'milestoneNext')));
    btn.appendChild(Icons.icon('arrowRight', 18));
    btn.addEventListener('click', function () {
      state.navDir = 'next';
      if (mod.steps[state.stepIdx]) state.navHistory.push(mod.steps[state.stepIdx].id);
      state.modIdx += 1;
      state.stepIdx = 0;
      state.view = 'step';
      showCurrentView();
    });
    acts.appendChild(btn);

    var pauseBtn = document.createElement('button');
    pauseBtn.type = 'button';
    pauseBtn.className = 'el-milestone-pause';
    pauseBtn.textContent = Model.ui(lang, 'milestonePause');
    pauseBtn.addEventListener('click', function () {
      state.lastModIdx = Math.min(state.modIdx + 1, mods.length - 1);
      state.lastStepIdx = 0;
      saveLocalProgress();
      state.view = 'start';
      showCurrentView();
    });
    acts.appendChild(pauseBtn);

    card.appendChild(acts);
    mainEl.appendChild(card);
  }

  function renderSummary() {
    mainEl.classList.add('is-step-view');
    document.body.removeAttribute('data-active-domain');
    var exp = state.exp;
    var lang = state.lang;
    mainEl.textContent = '';

    var card = RouteMap.renderSummaryCard(exp, state.answers, lang);

    var actions = document.createElement('div');
    actions.className = 'el-player-nav el-no-print';
    var homeB = document.createElement('button');
    homeB.type = 'button';
    homeB.className = 'xped-btn xped-btn-sun';
    homeB.textContent = Model.ui(lang, 'restart');
    homeB.addEventListener('click', function () { state.view = 'start'; showCurrentView(); });
    actions.classList.add('el-summary-finish');
    actions.appendChild(homeB);
    card.appendChild(actions);
    mainEl.appendChild(card);

    if (isSharing() && exp.shareOptions.collectPilotFeedback) {
      var pilot = document.createElement('section');
      pilot.className = 'el-pilot-card';
      var ph2 = document.createElement('h2');
      ph2.textContent = Model.ui(lang, 'pilotTitle');
      pilot.appendChild(ph2);

      if (state.pilotSent) {
        var thx = document.createElement('p');
        thx.setAttribute('role', 'status');
        thx.textContent = Model.ui(lang, 'pilotThanks');
        pilot.appendChild(thx);
      } else {
        var scores = { clarity: 0, engagement: 0 };
        function ratingGroup(labelText, key) {
          var p = document.createElement('p');
          p.className = 'el-rating-label';
          p.textContent = labelText;
          pilot.appendChild(p);
          var row = document.createElement('div');
          row.className = 'el-rating-row';
          row.setAttribute('role', 'group');
          row.setAttribute('aria-label', labelText);
          [1, 2, 3, 4, 5].forEach(function (n) {
            var rb = document.createElement('button');
            rb.type = 'button';
            rb.className = 'el-rating-btn';
            rb.setAttribute('aria-pressed', 'false');
            rb.textContent = String(n);
            rb.addEventListener('click', function () {
              scores[key] = n;
              Array.prototype.forEach.call(row.children, function (button, index) {
                button.classList.toggle('is-selected', index + 1 === n);
                button.setAttribute('aria-pressed', String(index + 1 === n));
              });
            });
            row.appendChild(rb);
          });
          pilot.appendChild(row);
        }
        ratingGroup(Model.ui(lang, 'pilotClarity'), 'clarity');
        ratingGroup(Model.ui(lang, 'pilotEngagement'), 'engagement');

        var ta = document.createElement('textarea');
        ta.className = 'xped-textarea';
        ta.rows = 3;
        ta.placeholder = Model.ui(lang, 'pilotComment');
        ta.setAttribute('aria-label', ta.placeholder);
        pilot.appendChild(ta);

        var subBtn = document.createElement('button');
        subBtn.type = 'button';
        subBtn.className = 'xped-btn xped-btn-primary';
        subBtn.classList.add('el-pilot-submit');
        subBtn.textContent = Model.ui(lang, 'pilotSubmit');
        var submitError = document.createElement('p');
        submitError.setAttribute('role', 'alert');
        submitError.hidden = true;
        subBtn.addEventListener('click', async function () {
          var feedbackGrant = state.consent;
          subBtn.disabled = true;
          submitError.hidden = true;
          clearTimeout(state.syncTimer);
          try {
            var result = await sendResponse(true, { clarity: scores.clarity || null, engagement: scores.engagement || null, comment: ta.value });
            if (!grantIsCurrent(feedbackGrant)) return;
            if (!result.ok) throw new Error('Feedback unavailable');
            state.pilotSent = true;
            saveLocalProgress();
            if (state.view === 'summary') renderSummary();
          } catch (_err) {
            if (!grantIsCurrent(feedbackGrant)) return;
            subBtn.disabled = false;
            submitError.textContent = Model.ui(lang, 'feedbackFailed');
            submitError.hidden = false;
          }
        });
        pilot.append(subBtn, submitError);
      }
      mainEl.appendChild(pilot);
    }
  }

  function applyThemePref() {
    var baseTheme = (state.exp && state.exp.theme && state.exp.theme.preset) || 'xped-warm-sand';
    var effective = state.themePref === 'high-contrast' ? 'high-contrast' : baseTheme;
    document.body.setAttribute('data-xped-theme', effective);
    document.querySelectorAll('.el-theme-toggle-group button').forEach(function (b) {
      var selected = b.getAttribute('data-theme-pref') === state.themePref;
      b.classList.toggle('is-active', selected);
      b.setAttribute('aria-pressed', String(selected));
    });
  }

  function updateComfortLabels() {
    var szLbl = document.getElementById('el-comfort-size-lbl');
    var thLbl = document.getElementById('el-comfort-theme-lbl');
    var wBtn = document.getElementById('el-theme-warm-btn');
    var cBtn = document.getElementById('el-theme-contrast-btn');
    homeBtn.setAttribute('aria-label', Model.ui(state.lang, 'returnHome'));
    comfortTrigger.setAttribute('aria-label', Model.ui(state.lang, 'readingComfort'));
    langDD.trigger.setAttribute('aria-label', Model.ui(state.lang, 'language'));
    routeDialog.querySelector('form button').setAttribute('aria-label', Model.ui(state.lang, 'close'));
    var sizes = { sm: 'smallText', md: 'defaultText', lg: 'largeText' };
    document.querySelectorAll('[data-scale]').forEach(function (button) {
      button.setAttribute('aria-label', Model.ui(state.lang, sizes[button.dataset.scale]));
    });
    if (szLbl) szLbl.textContent = Model.ui(state.lang, 'textSize');
    if (thLbl) thLbl.textContent = Model.ui(state.lang, 'themeMode');
    if (wBtn) wBtn.textContent = Model.ui(state.lang, 'themeWarm');
    if (cBtn) cBtn.textContent = Model.ui(state.lang, 'themeContrast');
  }

  function render() {
    if (!state.exp) return;
    if (state.view !== 'start' && state.exp.shareOptions && state.exp.shareOptions.collectResponses && !state.consent) state.view = 'consent';
    if (state.view !== 'consent') resumeQueuedResponse();
    document.documentElement.lang = state.lang;
    courseLabelEl.textContent = Model.getLocalized(state.exp.startPage && state.exp.startPage.title, state.lang, state.exp.defaultLanguage) || state.exp.title;
    mapBtn.textContent = '';
    mapBtn.appendChild(Icons.icon('map', 16));
    mapBtn.appendChild(document.createTextNode(Model.ui(state.lang, 'routeButton')));
    mapBtn.hidden = state.view === 'consent' || !state.exp.modules.length || (state.view === 'start' && !state.visitedStepIds.length);
    updateComfortLabels();
    applyThemePref();
    courseLabelEl.hidden = state.view === 'start';
    if (state.view === 'start') renderStartPage();
    else if (state.view === 'consent') renderConsent();
    else if (state.view === 'step') renderStep();
    else if (state.view === 'milestone') renderMilestone();
    else renderSummary();
    updateProgressBar();
  }

  homeBtn.addEventListener('click', function () { state.view = 'start'; showCurrentView(); });
  mapBtn.addEventListener('click', function () {
    if (!state.exp) return;
    document.getElementById('el-player-route-title').textContent = Model.ui(state.lang, 'routeTitle');
    RouteMap.renderRouteMap(routeBody, {
      modules: state.exp.modules || [],
      lang: state.lang,
      defaultLang: state.exp.defaultLanguage,
      completedModuleIds: state.completedModuleIds,
      activeModuleId: (state.exp.modules[state.modIdx] && state.exp.modules[state.modIdx].id) || '',
      compact: true,
      onSelect: function (_m, idx) {
        if (state.view === 'step' && (idx !== state.modIdx || state.stepIdx !== 0)) {
          var previous = state.exp.modules[state.modIdx].steps[state.stepIdx];
          if (previous) state.navHistory.push(previous.id);
        }
        state.navDir = 'next';
        state.modIdx = idx;
        state.stepIdx = 0;
        state.view = 'step';
        Icons.closeDialogAnimated(routeDialog).then(showCurrentView);
      },
    });
    if (state.visitedStepIds.length > 0) {
      var foot = document.createElement('div');
      foot.className = 'el-route-dialog-foot';
      var resetB = document.createElement('button');
      resetB.type = 'button';
      resetB.className = 'xped-btn xped-btn-ghost';
      resetB.appendChild(Icons.icon('refresh', 15));
      resetB.appendChild(document.createTextNode(Model.ui(state.lang, 'replayFresh')));
      resetB.addEventListener('click', function () {
        setConsent(null);
        state.answers = Object.create(null);
        state.peerDisclosureTypes = Object.create(null);
        state.stepComments = [];
        state.pilotSent = false;
        state.navHistory = [];
        state.visitedStepIds = [];
        state.completedModuleIds = [];
        state.modIdx = 0;
        state.stepIdx = 0;
        state.lastModIdx = 0;
        state.lastStepIdx = 0;
        state.view = 'start';
        saveLocalProgress();
        Icons.closeDialogAnimated(routeDialog).then(showCurrentView);
      });
      foot.appendChild(resetB);
      routeBody.appendChild(foot);
    }
    routeDialog.showModal();
  });
  routeDialog.addEventListener('close', function () { routeDialog.returnValue = ''; });

  if (comfortTrigger && comfortDd) {
    comfortTrigger.addEventListener('click', function (e) {
      e.stopPropagation();
      var opening = !comfortDd.classList.contains('is-open');
      langDD.setOpen(false);
      comfortDd.classList.toggle('is-open', opening);
      comfortTrigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
    });
    document.addEventListener('click', function (e) {
      if (comfortDd.classList.contains('is-open') && !comfortDd.contains(e.target)) {
        comfortDd.classList.remove('is-open');
        comfortTrigger.setAttribute('aria-expanded', 'false');
      }
    });
  }

  document.querySelectorAll('.el-text-scale-group button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      setTextScale(btn.getAttribute('data-scale'));
      saveLocalProgress();
    });
  });

  document.querySelectorAll('.el-theme-toggle-group button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.themePref = btn.getAttribute('data-theme-pref') || 'default';
      applyThemePref();
      saveLocalProgress();
    });
  });

  // Keyboard arrow navigation between steps when not typing in an input
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && comfortDd.classList.contains('is-open')) {
      comfortDd.classList.remove('is-open');
      comfortTrigger.setAttribute('aria-expanded', 'false');
      comfortTrigger.focus();
      return;
    }
    if (state.view !== 'step' || routeDialog.open || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (document.activeElement.closest('input, textarea, select, button, [contenteditable="true"], .el-dd')) return;
    if (e.key === 'ArrowRight') goNext();
    else if (e.key === 'ArrowLeft') goBack();
  });

  Icons.wireAnimatedDialogs();
  Model.enableDialogLightDismissFallback();

  var academyLocale = window.Xped && window.Xped.i18n;
  async function init() {
    setTextScale('md');
    loadLocalProgress();
    var savedContentLanguage = state.hasSavedLanguage ? state.lang : '';
    state.lang = academyLocale ? academyLocale.language : Model.detectBrowserLanguage(Model.SUPPORTED_LANGS, 'nl', queryLang || (state.hasSavedLanguage ? state.lang : ''), navigator.languages);
    document.documentElement.lang = state.lang;
    updateComfortLabels();
    try {
      var prepared = document.getElementById('academy-initial-course');
      var data;
      var resp;
      if (prepared) {
        data = { expedition: JSON.parse(prepared.textContent) };
        prepared.remove();
      } else {
        resp = await fetch('/api/elearning/public/' + encodeURIComponent(shareToken));
        data = await resp.json().catch(function () { return {}; });
      }
      if (resp && !resp.ok) {
        if (resp.status !== 404 && resp.status !== 410 && resp.status !== 403) throw new Error('Course unavailable');
        mainEl.textContent = '';
        var errCard = document.createElement('div');
        errCard.className = 'xped-card el-player-state';
        var h1 = document.createElement('h1');
        h1.textContent = Model.ui(state.lang, 'unavailable');
        var p = document.createElement('p');
        var message = Model.ui(state.lang, 'notFound');
        if (resp.status === 410 && data.error_code !== 'link_expired') {
          message = data.error_code === 'link_paused' ? Model.ui(state.lang, 'pausedFallback') : (data.error || Model.ui(state.lang, 'pausedFallback'));
        }
        p.textContent = message;
        errCard.append(h1, p);
        mainEl.appendChild(errCard);
        return;
      }
      state.exp = data.expedition;
      var options = state.exp.shareOptions || {};
      if (!state.consent || !options.collectResponses || state.consent.version !== options.collectionVersion ||
          !['private', 'share'].includes(state.consent.choice)) resetSharing();
      document.body.setAttribute('data-xped-theme', (state.exp.theme && state.exp.theme.preset) || 'xped-warm-sand');
      var enabled = state.exp.enabledLanguages || ['nl'];
      var navLangs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'nl'];
      if (academyLocale) {
        const preferred = [queryLang, savedContentLanguage, academyLocale.language, 'nl', 'de'];
        state.lang = preferred.find(code => enabled.includes(code) && (code === 'nl' || code === 'de')) || 'nl';
      } else if (queryLang) {
        state.lang = Model.detectBrowserLanguage(enabled, state.exp.defaultLanguage, queryLang, navLangs);
      } else if (!state.hasSavedLanguage || enabled.indexOf(state.lang) < 0) {
        state.lang = Model.detectBrowserLanguage(enabled, state.exp.defaultLanguage, '', navLangs);
      }
      updateLangDropdown();
      document.title = (state.exp.title || 'xPEDitie Pijn') + ' · ' + (document.body.dataset.siteTitle || 'Lecture Processor');
      render();
    } catch (_err) {
      mainEl.textContent = '';
      var fail = document.createElement('div');
      fail.className = 'xped-card el-player-state';
      var errorTitle = document.createElement('h1');
      errorTitle.textContent = Model.ui(state.lang, 'unavailable');
      var retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'xped-btn xped-btn-secondary';
      retry.textContent = Model.ui(state.lang, 'retry');
      retry.addEventListener('click', function () { retry.disabled = true; init(); });
      fail.append(errorTitle, retry);
      mainEl.appendChild(fail);
    }
  }

  window.addEventListener('storage', function (event) {
    if (!state.exp || (event.key !== null && event.key !== consentKey)) return;
    var updated;
    try { updated = JSON.parse(localStorage.getItem(consentKey)); } catch (_err) { updated = null; }
    if (JSON.stringify(updated) === JSON.stringify(state.consent)) return;
    resetSharing();
    if (updated && updated.cohort === cohort && updated.choice === 'private' && updated.version === (state.exp.shareOptions || {}).collectionVersion) {
      state.consent = updated;
      state.sessionId = updated.sessionId;
      state.consentStored = true;
    }
    if (state.view !== 'start') showCurrentView();
  });

  init();
})();
