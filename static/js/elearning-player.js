(function () {
  'use strict';

  var Model = window.XpedElearningModel;
  var Icons = window.XpedElearningIcons;
  var Blocks = window.XpedElearningBlocks;
  var RouteMap = window.XpedElearningRouteMap;

  var shareToken = document.body.dataset.shareToken || '';
  var params = new URLSearchParams(window.location.search);
  var cohort = params.get('cohort') || 'default';
  var queryLang = params.get('lang') || '';
  var reviewModeQuery = params.get('review') === '1' || params.get('mode') === 'review';

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
  var state = {
    exp: null,
    lang: 'nl',
    view: 'start',
    navDir: 'next',
    modIdx: 0,
    stepIdx: 0,
    lastModIdx: 0,
    lastStepIdx: 0,
    themePref: 'default',
    sessionId: 'lrn_' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36),
    answers: {},
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
      saveLocalProgress();
      updateLangDropdown();
      render();
    },
  });
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
      var raw = localStorage.getItem(storageKey);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (saved.sessionId) state.sessionId = saved.sessionId;
      if (saved.answers && typeof saved.answers === 'object') state.answers = saved.answers;
      if (Array.isArray(saved.visitedStepIds)) state.visitedStepIds = saved.visitedStepIds;
      if (Array.isArray(saved.completedModuleIds)) state.completedModuleIds = saved.completedModuleIds;
      if (Array.isArray(saved.stepComments)) state.stepComments = saved.stepComments;
      if (typeof saved.lastModIdx === 'number') state.lastModIdx = saved.lastModIdx;
      if (typeof saved.lastStepIdx === 'number') state.lastStepIdx = saved.lastStepIdx;
      if (saved.lang) state.lang = saved.lang;
      if (saved.textScale) setTextScale(saved.textScale);
      if (saved.themePref) state.themePref = saved.themePref;
    } catch (_err) {
      // Ignore private mode storage errors
    }
  }

  function saveLocalProgress() {
    try {
      localStorage.setItem(storageKey, JSON.stringify({
        sessionId: state.sessionId,
        answers: state.answers,
        visitedStepIds: state.visitedStepIds,
        completedModuleIds: state.completedModuleIds,
        stepComments: state.stepComments,
        lastModIdx: state.lastModIdx,
        lastStepIdx: state.lastStepIdx,
        lang: state.lang,
        textScale: document.body.getAttribute('data-text-scale') || 'md',
        themePref: state.themePref,
      }));
    } catch (_err) {
      // Ignore quota errors
    }
  }

  function scheduleSync(completed, pilotFeedback) {
    saveLocalProgress();
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(function () {
      fetch('/api/elearning/public/' + encodeURIComponent(shareToken) + '/responses', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: state.sessionId,
          cohort: cohort,
          language: state.lang,
          answers: state.answers,
          visitedStepIds: state.visitedStepIds,
          completed: !!completed || state.view === 'summary',
          pilotFeedback: pilotFeedback || undefined,
          stepComments: state.stepComments.length ? state.stepComments : undefined,
        }),
      }).catch(function () {});
    }, 350);
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
    document.body.setAttribute('data-text-scale', scale);
    document.querySelectorAll('.el-text-scale-group button').forEach(function (btn) {
      btn.classList.toggle('is-active', btn.getAttribute('data-scale') === scale);
    });
  }

  function totalStepsCount() {
    if (!state.exp) return 0;
    return (state.exp.modules || []).reduce(function (acc, m) { return acc + (m.steps || []).length; }, 0);
  }

  function updateProgressBar() {
    var total = Math.max(1, totalStepsCount());
    var pct = state.view === 'summary' ? 100 : (state.view === 'start' ? 0 : Math.min(100, Math.round((state.visitedStepIds.length / total) * 100)));
    progressFillEl.style.width = pct + '%';
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

  function goBack() {
    var mods = (state.exp && state.exp.modules) || [];
    state.navDir = 'prev';
    if (state.stepIdx > 0) state.stepIdx -= 1;
    else if (state.modIdx > 0) {
      state.modIdx -= 1;
      state.stepIdx = Math.max(0, (mods[state.modIdx].steps || []).length - 1);
    } else state.view = 'start';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
      state.stepIdx = jumpIdx;
    } else if (!isLastStep) {
      state.stepIdx += 1;
    } else {
      if (state.completedModuleIds.indexOf(mod.id) < 0) state.completedModuleIds.push(mod.id);
      if (!isLastMod) state.view = 'milestone';
      else { state.view = 'summary'; scheduleSync(true); }
    }
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderStartPage() {
    mainEl.classList.remove('is-step-view');
    document.body.removeAttribute('data-active-domain');
    RouteMap.renderStartPage(mainEl, {
      exp: state.exp,
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
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
      onSelectModule: function (_m, idx) {
        state.navDir = 'next';
        state.modIdx = idx;
        state.stepIdx = 0;
        state.view = 'step';
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
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
      scheduleSync(false);
    } else {
      saveLocalProgress();
    }

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
    var stepHasAnswered = (step.blocks || []).some(function (b) {
      return interactiveTypes[b.type] && state.answers[b.id] !== undefined && state.answers[b.id] !== '';
    });

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
        onAnswer: function (bid, val) {
          state.answers[bid] = val;
          // Progressive Disclosure: gently unfold any waiting revealAfterAnswer blocks!
          stack.querySelectorAll('.xped-reveal-locked').forEach(function (locked) {
            locked.classList.remove('xped-reveal-locked');
            locked.classList.add('xped-reveal-unlocked');
          });
          scheduleSync(false);
        },
        fetchAggregate: (exp.shareOptions && exp.shareOptions.showPeerResults) ? fetchAggregate : null,
        assetUrl: assetUrl,
      }));
    });
    card.appendChild(stack);

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

    // Optional Per-Slide Reviewer Comment Mode (?review=1 or shareOptions.allowStepComments)
    if (reviewModeQuery || (exp.shareOptions && exp.shareOptions.allowStepComments)) {
      var revWrap = document.createElement('div');
      revWrap.className = 'el-review-wrap el-no-print';
      var revBtn = document.createElement('button');
      revBtn.type = 'button';
      revBtn.className = 'xped-btn xped-btn-ghost';
      revBtn.appendChild(Icons.icon('messageCircle', 16));
      revBtn.appendChild(document.createTextNode(Model.ui(lang, 'stepCommentBtn')));
      var revPanel = document.createElement('div');
      revPanel.className = 'el-review-panel';
      revPanel.hidden = true;
      var revTitle = document.createElement('strong');
      revTitle.textContent = Model.ui(lang, 'stepCommentTitle');
      var revTa = document.createElement('textarea');
      revTa.className = 'xped-textarea';
      revTa.rows = 3;
      revTa.placeholder = Model.ui(lang, 'stepCommentPlaceholder');
      var revRow = document.createElement('div');
      revRow.className = 'el-btn-row';
      var revSend = document.createElement('button');
      revSend.type = 'button';
      revSend.className = 'xped-btn xped-btn-primary';
      revSend.style.minHeight = '38px';
      revSend.style.padding = '6px 16px';
      revSend.textContent = Model.ui(lang, 'stepCommentSend');
      var revStat = document.createElement('span');
      revStat.className = 'xped-caption';
      revRow.appendChild(revSend);
      revRow.appendChild(revStat);
      revPanel.appendChild(revTitle);
      revPanel.appendChild(revTa);
      revPanel.appendChild(revRow);

      revBtn.addEventListener('click', function () {
        revPanel.hidden = !revPanel.hidden;
        if (!revPanel.hidden) revTa.focus();
      });
      revSend.addEventListener('click', function () {
        var txt = revTa.value.trim();
        if (!txt) return;
        state.stepComments.push({
          moduleId: mod.id,
          stepId: step.id,
          moduleTitle: Model.getLocalized(mod.title, lang, defLang),
          stepTitle: stTitle,
          reviewer: cohort,
          comment: txt,
          createdAt: Math.floor(Date.now() / 1000),
        });
        revTa.value = '';
        revStat.textContent = Model.ui(lang, 'stepCommentSent');
        scheduleSync(false);
      });
      revWrap.appendChild(revBtn);
      revWrap.appendChild(revPanel);
      mainEl.appendChild(revWrap);
    }

    var saveNote = document.createElement('p');
    saveNote.className = 'el-player-save-note';
    saveNote.textContent = Model.ui(lang, 'savedAutomatically');
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
      state.modIdx += 1;
      state.stepIdx = 0;
      state.view = 'step';
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
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
      render();
      window.scrollTo({ top: 0, behavior: 'smooth' });
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
    var defLang = exp.defaultLanguage || 'nl';
    mainEl.textContent = '';

    var card = document.createElement('article');
    card.className = 'xped-card';
    var h1 = document.createElement('h1');
    h1.className = 'xped-step-title';
    h1.textContent = Model.ui(lang, 'summaryTitle');
    var sub = document.createElement('p');
    sub.className = 'xped-caption';
    sub.textContent = Model.ui(lang, 'summarySubtitle');
    card.appendChild(h1);
    card.appendChild(sub);

    var reflections = [];
    var plans = [];
    var balances = [];
    var insights = [];
    (exp.modules || []).forEach(function (m) {
      (m.steps || []).forEach(function (s) {
        (s.blocks || []).forEach(function (b) {
          var ans = state.answers[b.id];
          if (b.type === 'reflection' && typeof ans === 'string' && ans.trim()) {
            reflections.push({ q: Model.getLocalized(b.data.prompt, lang, defLang), a: ans });
          } else if (b.type === 'mini_plan' && Array.isArray(ans) && ans.length) {
            plans = plans.concat(ans);
          } else if (b.type === 'balance_scale' && ans && typeof ans === 'object') {
            var loadT = 0;
            var resT = 0;
            var loadNames = [];
            var resNames = [];
            (b.data.factors || []).forEach(function (f) {
              var v = Number(ans[f.id] || 0);
              var lbl = Model.getLocalized(f.label, lang, defLang);
              if (f.category === 'resource') {
                resT += v;
                if (v >= 2 && lbl) resNames.push(lbl + ' (' + v + '/3)');
              } else {
                loadT += v;
                if (v >= 2 && lbl) loadNames.push(lbl + ' (' + v + '/3)');
              }
            });
            balances.push({ loadT: loadT, resT: resT, loadNames: loadNames, resNames: resNames });
          } else if (b.type === 'myth_fact' && ans) {
            var expTxt = Model.getLocalized(b.data.explanation, lang, defLang);
            if (expTxt) insights.push(expTxt);
          }
        });
      });
    });

    if (balances.length) {
      var bSec = document.createElement('div');
      bSec.className = 'el-summary-section';
      var bh = document.createElement('h3');
      bh.textContent = Model.ui(lang, 'myBalance');
      bSec.appendChild(bh);
      balances.forEach(function (bal) {
        var bGrid = document.createElement('div');
        bGrid.className = 'el-summary-balance-grid';
        var lc = document.createElement('div');
        lc.className = 'el-summary-balance-col';
        var lTitle = document.createElement('strong');
        lTitle.textContent = Model.ui(lang, 'load') + ': ' + bal.loadT;
        lc.appendChild(lTitle);
        lc.appendChild(document.createTextNode(bal.loadNames.join(', ') || '—'));
        var rc = document.createElement('div');
        rc.className = 'el-summary-balance-col';
        var rTitle = document.createElement('strong');
        rTitle.textContent = Model.ui(lang, 'resource') + ': ' + bal.resT;
        rc.appendChild(rTitle);
        rc.appendChild(document.createTextNode(bal.resNames.join(', ') || '—'));
        bGrid.appendChild(lc);
        bGrid.appendChild(rc);
        bSec.appendChild(bGrid);
      });
      card.appendChild(bSec);
    }

    if (plans.length) {
      var pSec = document.createElement('div');
      pSec.className = 'el-summary-section';
      var ph = document.createElement('h3');
      ph.textContent = Model.ui(lang, 'myMiniPlan');
      pSec.appendChild(ph);
      var ul = document.createElement('ul');
      ul.className = 'xped-sources-list';
      plans.forEach(function (item) {
        var li = document.createElement('li');
        li.textContent = item;
        ul.appendChild(li);
      });
      pSec.appendChild(ul);
      card.appendChild(pSec);
    }

    if (insights.length) {
      var iSec = document.createElement('div');
      iSec.className = 'el-summary-section';
      var ih = document.createElement('h3');
      ih.textContent = Model.ui(lang, 'myInsights');
      iSec.appendChild(ih);
      var iul = document.createElement('ul');
      iul.className = 'xped-sources-list';
      insights.forEach(function (txt) {
        var li = document.createElement('li');
        li.textContent = txt;
        iul.appendChild(li);
      });
      iSec.appendChild(iul);
      card.appendChild(iSec);
    }

    if (reflections.length) {
      var rSec = document.createElement('div');
      rSec.className = 'el-summary-section';
      var rh = document.createElement('h3');
      rh.textContent = Model.ui(lang, 'myReflections');
      rSec.appendChild(rh);
      reflections.forEach(function (ref) {
        var q = document.createElement('strong');
        q.textContent = ref.q;
        var a = document.createElement('p');
        a.textContent = ref.a;
        a.style.whiteSpace = 'pre-wrap';
        rSec.appendChild(q);
        rSec.appendChild(a);
      });
      card.appendChild(rSec);
    }

    var actions = document.createElement('div');
    actions.className = 'el-player-nav el-no-print';
    var homeB = document.createElement('button');
    homeB.type = 'button';
    homeB.className = 'xped-btn xped-btn-secondary';
    homeB.textContent = Model.ui(lang, 'restart');
    homeB.addEventListener('click', function () { state.view = 'start'; render(); });
    var printB = document.createElement('button');
    printB.type = 'button';
    printB.className = 'xped-btn xped-btn-sun';
    printB.appendChild(Icons.icon('print', 17));
    printB.appendChild(document.createTextNode(Model.ui(lang, 'printSummary')));
    printB.addEventListener('click', function () { window.print(); });
    actions.appendChild(homeB);
    actions.appendChild(printB);
    card.appendChild(actions);
    mainEl.appendChild(card);

    if (exp.shareOptions && exp.shareOptions.collectPilotFeedback !== false) {
      var pilot = document.createElement('section');
      pilot.className = 'el-pilot-card';
      var ph2 = document.createElement('h2');
      ph2.textContent = Model.ui(lang, 'pilotTitle');
      pilot.appendChild(ph2);

      if (state.pilotSent) {
        var thx = document.createElement('p');
        thx.textContent = Model.ui(lang, 'pilotThanks');
        pilot.appendChild(thx);
      } else {
        var scores = { clarity: 0, engagement: 0 };
        function ratingGroup(labelText, key) {
          var p = document.createElement('p');
          p.style.margin = '14px 0 4px';
          p.style.fontWeight = '700';
          p.textContent = labelText;
          pilot.appendChild(p);
          var row = document.createElement('div');
          row.className = 'el-rating-row';
          [1, 2, 3, 4, 5].forEach(function (n) {
            var rb = document.createElement('button');
            rb.type = 'button';
            rb.className = 'el-rating-btn';
            rb.textContent = String(n);
            rb.addEventListener('click', function () {
              scores[key] = n;
              Array.prototype.forEach.call(row.children, function (c, idx) { c.classList.toggle('is-selected', idx + 1 === n); });
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
        pilot.appendChild(ta);

        var subBtn = document.createElement('button');
        subBtn.type = 'button';
        subBtn.className = 'xped-btn xped-btn-primary';
        subBtn.style.marginTop = '12px';
        subBtn.textContent = Model.ui(lang, 'pilotSubmit');
        subBtn.addEventListener('click', function () {
          state.pilotSent = true;
          scheduleSync(true, { clarity: scores.clarity || null, engagement: scores.engagement || null, comment: ta.value });
          renderSummary();
        });
        pilot.appendChild(subBtn);
      }
      mainEl.appendChild(pilot);
    }
  }

  function applyThemePref() {
    var baseTheme = (state.exp && state.exp.theme && state.exp.theme.preset) || 'xped-warm-sand';
    var effective = state.themePref === 'high-contrast' ? 'high-contrast' : baseTheme;
    document.body.setAttribute('data-xped-theme', effective);
    document.querySelectorAll('.el-theme-toggle-group button').forEach(function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-theme-pref') === state.themePref);
    });
  }

  function updateComfortLabels() {
    var szLbl = document.getElementById('el-comfort-size-lbl');
    var thLbl = document.getElementById('el-comfort-theme-lbl');
    var wBtn = document.getElementById('el-theme-warm-btn');
    var cBtn = document.getElementById('el-theme-contrast-btn');
    if (szLbl) szLbl.textContent = Model.ui(state.lang, 'textSize');
    if (thLbl) thLbl.textContent = Model.ui(state.lang, 'themeMode');
    if (wBtn) wBtn.textContent = Model.ui(state.lang, 'themeWarm');
    if (cBtn) cBtn.textContent = Model.ui(state.lang, 'themeContrast');
  }

  function render() {
    if (!state.exp) return;
    document.documentElement.lang = state.lang;
    courseLabelEl.textContent = Model.getLocalized(state.exp.startPage && state.exp.startPage.title, state.lang, state.exp.defaultLanguage) || state.exp.title;
    mapBtn.textContent = '';
    mapBtn.appendChild(Icons.icon('map', 16));
    mapBtn.appendChild(document.createTextNode(Model.ui(state.lang, 'routeButton')));
    mapBtn.hidden = !(state.exp.modules && state.exp.modules.length);
    updateComfortLabels();
    applyThemePref();
    updateProgressBar();
    if (state.view === 'start') renderStartPage();
    else if (state.view === 'step') renderStep();
    else if (state.view === 'milestone') renderMilestone();
    else renderSummary();
  }

  homeBtn.addEventListener('click', function () { state.view = 'start'; render(); });
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
        state.navDir = 'next';
        state.modIdx = idx;
        state.stepIdx = 0;
        state.view = 'step';
        Icons.closeDialogAnimated(routeDialog);
        render();
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
        state.answers = {};
        state.visitedStepIds = [];
        state.completedModuleIds = [];
        state.modIdx = 0;
        state.stepIdx = 0;
        state.lastModIdx = 0;
        state.lastStepIdx = 0;
        state.view = 'start';
        try { localStorage.removeItem(storageKey); } catch (_e) {}
        Icons.closeDialogAnimated(routeDialog);
        render();
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
      document.querySelectorAll('.el-dd.is-open').forEach(function (other) {
        if (other !== comfortDd) other.classList.remove('is-open');
      });
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
    if (state.view !== 'step') return;
    if (document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
    if (e.key === 'ArrowRight') goNext();
    else if (e.key === 'ArrowLeft') goBack();
  });

  Icons.wireAnimatedDialogs();
  Model.enableDialogLightDismissFallback();

  async function init() {
    loadLocalProgress();
    try {
      var resp = await fetch('/api/elearning/public/' + encodeURIComponent(shareToken));
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) {
        mainEl.textContent = '';
        var errCard = document.createElement('div');
        errCard.className = 'xped-card el-player-state';
        var h1 = document.createElement('h1');
        h1.textContent = resp.status === 410 ? 'Module gepauzeerd' : 'Link niet gevonden';
        var p = document.createElement('p');
        p.textContent = data.error || Model.ui(state.lang, 'notFound');
        errCard.appendChild(h1);
        errCard.appendChild(p);
        mainEl.appendChild(errCard);
        return;
      }
      state.exp = data.expedition;
      document.body.setAttribute('data-xped-theme', (state.exp.theme && state.exp.theme.preset) || 'xped-warm-sand');
      var enabled = state.exp.enabledLanguages || ['nl'];
      var navLangs = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'nl'];
      if (queryLang) {
        state.lang = Model.detectBrowserLanguage(enabled, state.exp.defaultLanguage, queryLang, navLangs);
      } else if (!localStorage.getItem(storageKey) || enabled.indexOf(state.lang) < 0) {
        state.lang = Model.detectBrowserLanguage(enabled, state.exp.defaultLanguage, '', navLangs);
      }
      updateLangDropdown();
      document.title = state.exp.title || 'xPEDitie Pijn';
      render();
    } catch (_err) {
      mainEl.textContent = '';
      var fail = document.createElement('div');
      fail.className = 'xped-card el-player-state';
      fail.textContent = 'Could not load this expedition. Please refresh and try again.';
      mainEl.appendChild(fail);
    }
  }

  init();
})();
