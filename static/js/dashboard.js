(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var uiCache = window.LectureProcessorUiCache || null;
  var userCache = window.LectureProcessorUserCache || {};
  var progressUtils = window.LectureProcessorStudyProgressUtils || {};
  var displayFormatUtils = window.LectureProcessorDisplayFormatUtils || {};

  var streakEl = document.getElementById('dash-streak');
  var dueEl = document.getElementById('dash-due');
  var goalEl = document.getElementById('dash-goal');
  var goalFillEl = document.getElementById('dash-goal-fill');
  var sessionsList = document.getElementById('dash-sessions-list');
  var packsList = document.getElementById('dash-packs-list');
  var dashboardPage = document.getElementById('dashboard-page');
  var authBanner = document.getElementById('dashboard-auth-banner');
  var DASHBOARD_CACHE_KEY = 'dashboard_summary_active_plan_v1';
  var currentUser = null;
  var dueRequest = 0;
  var nextPlannedPack = false;
  var activePlanPackIds = new Set();
  var recentPanel = document.getElementById('dash-recent-packs');
  recentPanel.addEventListener('app:disclosurechange', function (event) {
    if (currentUser && recentPanel.dataset.owner === currentUser.uid) writeUserCacheJson(currentUser, 'dashboard_recent_open', event.detail.open);
  });

  function setDashboardLoading(isLoading) {
    if (!dashboardPage) return;
    dashboardPage.setAttribute('data-load-state', isLoading ? 'loading' : 'ready');
    dashboardPage.setAttribute('aria-busy', isLoading ? 'true' : 'false');
  }

  function setSignedOutHero(visible) {
    if (!authBanner) return;
    authBanner.hidden = !visible;
  }

  function localDateString(value) {
    var date = value ? new Date(value) : new Date();
    var y = String(date.getFullYear());
    var m = String(date.getMonth() + 1).padStart(2, '0');
    var d = String(date.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  function sortSessions(sessions) {
    return (sessions || []).slice().sort(function (a, b) {
      var left = new Date(String(a.date || '') + 'T' + String(a.time || '00:00') + ':00').getTime();
      var right = new Date(String(b.date || '') + 'T' + String(b.time || '00:00') + ':00').getTime();
      return left - right;
    });
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

  function toSnapshot(summary) {
    if (progressUtils && typeof progressUtils.summarySnapshot === 'function') {
      return progressUtils.summarySnapshot(summary, progressUtils.DEFAULT_DAILY_GOAL || 20);
    }
    var streak = Math.max(0, Number(summary.current_streak || 0));
    var due = Math.max(0, Number(summary.due_today || 0));
    var goal = Math.max(1, Number(summary.daily_goal || 20));
    var done = Math.max(0, Number(summary.today_progress || 0));
    return { streak: streak, due: due, goal: goal, done: done };
  }

  function applySnapshot(snapshot) {
    if (!snapshot) {
      if (streakEl) streakEl.textContent = '\u2014 days';
      if (dueEl) dueEl.textContent = '\u2014 cards';
      if (goalEl) goalEl.textContent = '\u2014 / \u2014';
      if (goalFillEl) goalFillEl.value = 0;
      return;
    }
    var streak = Math.max(0, Number(snapshot.streak || 0));
    var due = Math.max(0, Number(snapshot.due || 0));
    var goal = Math.max(1, Number(snapshot.goal || 20));
    var done = Math.max(0, Number(snapshot.done || 0));
    if (streakEl) {
      streakEl.textContent = progressUtils && typeof progressUtils.formatCount === 'function'
        ? progressUtils.formatCount(streak, 'day')
        : (streak + ' day' + (streak === 1 ? '' : 's'));
    }
    if (dueEl) {
      dueEl.textContent = progressUtils && typeof progressUtils.formatCount === 'function'
        ? progressUtils.formatCount(due, 'card')
        : (due + ' card' + (due === 1 ? '' : 's'));
    }
    if (goalEl) {
      goalEl.textContent = progressUtils && typeof progressUtils.goalProgressText === 'function'
        ? progressUtils.goalProgressText({ today_progress: done, daily_goal: goal }, goal)
        : (Math.min(done, goal) + ' / ' + goal);
    }
    if (goalFillEl) {
      goalFillEl.hidden = false;
      goalFillEl.setAttribute('aria-hidden', 'false');
      goalFillEl.value = Number(
        progressUtils && typeof progressUtils.goalCompletionPercent === 'function'
          ? progressUtils.goalCompletionPercent({ today_progress: done, daily_goal: goal }, goal)
          : Math.max(0, Math.min(100, Math.round((Math.min(done, goal) / goal) * 100)))
      ) || 0;
    }
  }

  function applySignedOutSnapshot() {
    if (streakEl) streakEl.textContent = 'Sign in to track';
    if (dueEl) dueEl.textContent = 'Sign in to review';
    if (goalEl) goalEl.textContent = 'Sign in to set goals';
    if (goalFillEl) {
      goalFillEl.value = 0;
      goalFillEl.hidden = true;
      goalFillEl.setAttribute('aria-hidden', 'true');
    }
  }

  function hydrateCachedSnapshot(user) {
    if (!user || !user.uid) {
      applySignedOutSnapshot();
      return;
    }
    var fromUser = readUserCacheJson(user, DASHBOARD_CACHE_KEY, null);
    applySnapshot(fromUser || null);
  }

  function persistSnapshot(user, snapshot) {
    if (!snapshot) return;
    if (user && user.uid) {
      writeUserCacheJson(user, DASHBOARD_CACHE_KEY, snapshot);
    }
  }

  async function fetchUpcomingSessions(token) {
    if (!token) return [];
    var response = await fetch('/api/planner/sessions?future_only=1&limit=4&scope=active_plan', {
      headers: { Authorization: 'Bearer ' + token }
    });
    if (!response.ok) throw new Error('Could not load planner sessions');
    var payload = await response.json();
    return sortSessions(Array.isArray(payload.sessions) ? payload.sessions : []).slice(0, 4);
  }

  function fetchProgressSummary(headers) {
    return fetch('/api/study-progress/summary?scope=active_plan', { headers: headers });
  }

  function fetchRecentStudyPacks(headers) {
    return fetch('/api/study-packs?limit=10', { headers: headers });
  }

  function renderUpcomingSessions(user, sessions) {
    if (!sessionsList) return;
    while (sessionsList.firstChild) sessionsList.removeChild(sessionsList.firstChild);
    if (!user) {
      var signInHref = typeof authUtils.buildSignInUrl === 'function'
        ? authUtils.buildSignInUrl()
        : '/lecture-notes?auth=signin';
      sessionsList.innerHTML = '<div class="empty-state-card"><h3>Sign in to see your planner</h3><p>Study sessions now sync with your account. Sign in to view your upcoming plan and open Study Plan.</p><div class="empty-state-actions"><a class="empty-state-link primary" href="' + signInHref + '">Sign in</a><a class="empty-state-link" href="/helpcenter">Help Center</a></div></div>';
      return;
    }
    var future = Array.isArray(sessions) ? sessions : [];
    if (!future.length) {
      sessionsList.innerHTML = '<div class="empty-state-card"><h3>Plan your first study session</h3><p>Give your next study session a time and a place in your week.</p><div class="empty-state-actions"><a class="empty-state-link primary" href="/plan?view=schedule">Open schedule</a><a class="empty-state-link" href="/plan">Study Plan</a></div></div>';
      return;
    }
    var nextSession = future.find(function (session) { return session.status !== 'completed' && session.status !== 'cancelled' && session.status !== 'skipped'; });
    if (nextSession) {
      document.getElementById('dash-continue-title').textContent = nextSession.title || 'Your next study session';
      document.getElementById('dash-continue-copy').textContent = 'Choose your study mode and begin your planned session.';
      nextPlannedPack = !!nextSession.pack_id;
      if (nextPlannedPack) document.getElementById('dash-continue-link').href = studyEntry(nextSession.pack_id, nextSession.session_id || nextSession.id);
      document.getElementById('dash-continue-link').textContent = 'Continue studying →';
    }
    future.forEach(function (session) {
      var row = document.createElement('a');
      row.className = 'list-item plain-link-reset';
      row.href = '/plan?view=schedule';
      var title = document.createElement('h3');
      title.textContent = String(session.title || 'Study session');
      var meta = document.createElement('p');
      var pack = session.pack_title && !String(session.title || '').includes(session.pack_title) ? (' · ' + session.pack_title) : '';
      var date = new Date(String(session.date || '') + 'T12:00:00');
      var dateText = Number.isNaN(date.getTime()) ? String(session.date || '') : new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short' }).format(date);
      meta.textContent = dateText + ' · ' + String(session.time || '00:00') + pack;
      row.appendChild(title);
      row.appendChild(meta);
      sessionsList.appendChild(row);
    });
  }

  function renderUpcomingSessionsError() {
    if (!sessionsList) return;
    sessionsList.innerHTML = '<div class="empty-state-card" role="status" aria-live="polite"><h3>Could not load your planner</h3><p>Your saved sessions may still exist. Check your connection, then try again.</p><div class="empty-state-actions"><button type="button" class="empty-state-link primary" data-dashboard-retry>Retry</button><a class="empty-state-link" href="/plan?view=schedule">Open schedule</a></div></div>';
  }

  function renderRecentPacks(packs) {
    if (!packsList) return;
    while (packsList.firstChild) packsList.removeChild(packsList.firstChild);
    if (!packs || !packs.length) {
      packsList.innerHTML = '<div class="empty-state-card"><h3>Upload your first lecture</h3><p>Create a study pack first, then your latest packs will appear here for quick access.</p><div class="empty-state-actions"><a class="empty-state-link primary" href="/lecture-notes">Upload first lecture</a><a class="empty-state-link" href="/study">Open Study Library</a></div></div>';
      return;
    }
    var recommendedPack = packs.find(function (pack) { return activePlanPackIds.has(pack.study_pack_id); });
    if (!nextPlannedPack && recommendedPack) {
      document.getElementById('dash-continue-title').textContent = recommendedPack.title || 'Your latest study pack';
      document.getElementById('dash-continue-copy').textContent = 'Pick a study mode and continue with your latest pack.';
      document.getElementById('dash-continue-link').textContent = 'Continue studying →';
      document.getElementById('dash-continue-link').href = studyEntry(recommendedPack.study_pack_id);
    }
    packs.slice(0, 5).forEach(function (pack) {
      var row = document.createElement('a');
      row.className = 'list-item plain-link-reset';
      row.href = '/study?pack_id=' + encodeURIComponent(String(pack.study_pack_id || ''));
      var title = document.createElement('h3');
      title.textContent = String(pack.title || 'Untitled pack');
      var meta = document.createElement('p');
      var modeLabel = displayFormatUtils && typeof displayFormatUtils.formatPackMode === 'function'
        ? displayFormatUtils.formatPackMode(pack.mode || '')
        : 'Study Pack';
      var materialCounts = [Number(pack.flashcards_count) ? pack.flashcards_count + (Number(pack.flashcards_count) === 1 ? ' card' : ' cards') : '', Number(pack.test_questions_count) ? pack.test_questions_count + (Number(pack.test_questions_count) === 1 ? ' question' : ' questions') : ''].filter(Boolean);
      meta.textContent = [modeLabel].concat(materialCounts).join(' · ');
      row.appendChild(title);
      row.appendChild(meta);
      packsList.appendChild(row);
    });
  }

  function renderRecentPacksError() {
    if (!packsList) return;
    packsList.innerHTML = '<div class="empty-state-card" role="status" aria-live="polite"><h3>Could not load study packs</h3><p>Your library may still have saved lectures. Check your connection, then try again.</p><div class="empty-state-actions"><button type="button" class="empty-state-link primary" data-dashboard-retry>Retry</button><a class="empty-state-link" href="/study">Open Study Library</a></div></div>';
  }

  function bindDashboardRetry() {
    Array.prototype.slice.call(document.querySelectorAll('[data-dashboard-retry]')).forEach(function (button) {
      button.addEventListener('click', function () {
        loadDashboard(currentUser);
      }, { once: true });
    });
  }

  function dashboardVisiblePacks(packs) {
    return (Array.isArray(packs) ? packs : []).filter(function (pack) {
      return String((pack && pack.mode) || '').trim() !== 'voice-note';
    });
  }

  async function loadDashboard(user) {
    nextPlannedPack = false;
    activePlanPackIds = new Set();
    recentPanel.dataset.owner = user ? user.uid : '';
    recentPanel.open = user ? readUserCacheJson(user, 'dashboard_recent_open', true) !== false : true;
    dueRequest += 1;
    document.getElementById('dash-due-panel').hidden = true;
    document.getElementById('dash-due-list').replaceChildren();
    document.getElementById('dash-due-open').setAttribute('aria-expanded', 'false');
    document.getElementById('dash-continue-link').href = '/plan';
    document.getElementById('dash-continue-title').textContent = 'Ready for your next session?';
    document.getElementById('dash-continue-copy').textContent = 'Review your study plan or choose a pack from your library.';
    document.getElementById('dash-continue-link').textContent = 'Open Study Plan →';
    setDashboardLoading(true);
    if (!user) {
      setSignedOutHero(true);
      applySignedOutSnapshot();
      renderUpcomingSessions(null, []);
      renderRecentPacks([]);
      setDashboardLoading(false);
      return;
    }
    setSignedOutHero(false);
    var sessions = [];
    try {
      var token = await user.getIdToken();
      var headers = { Authorization: 'Bearer ' + token };
      var result = await Promise.all([
        fetchProgressSummary(headers),
        fetchRecentStudyPacks(headers),
        fetchUpcomingSessions(token).catch(function () { return { __dashboardLoadFailed: true }; })
      ]);
      if (currentUser !== user) return;
      var sessionsFailed = !!(result[2] && result[2].__dashboardLoadFailed);
      var packsFailed = !result[1].ok;
      sessions = sessionsFailed ? [] : (Array.isArray(result[2]) ? result[2] : []);
      var snapshot = null;
      if (result[0].ok) {
        var progressPayload = await result[0].json();
        if (currentUser !== user) return;
        var summary = progressPayload && progressPayload.summary ? progressPayload.summary : progressPayload;
        if (!summary || typeof summary !== 'object') summary = {};
        activePlanPackIds = new Set(summary.active_plan_pack_ids || []);
        snapshot = toSnapshot(summary);
        persistSnapshot(user, snapshot);
      }
      if (snapshot) applySnapshot(snapshot);
      else hydrateCachedSnapshot(user);
      if (sessionsFailed) renderUpcomingSessionsError();
      else renderUpcomingSessions(user, sessions.filter(function (session) { return activePlanPackIds.has(session.pack_id); }));
      if (packsFailed) {
        renderRecentPacksError();
      } else {
        var packsPayload = await result[1].json();
        if (currentUser !== user) return;
        renderRecentPacks(dashboardVisiblePacks((packsPayload && packsPayload.study_packs) || []));
      }
    } catch (_) {
      if (currentUser !== user) return;
      hydrateCachedSnapshot(user);
      renderUpcomingSessionsError();
      renderRecentPacksError();
    } finally {
      if (currentUser === user) { bindDashboardRetry(); setDashboardLoading(false); }
    }
  }

  function studyEntry(packId, sessionId) {
    return '/study?pack_id=' + encodeURIComponent(packId || '') + '&mode=learn' + (sessionId ? '&plan_item_id=' + encodeURIComponent(sessionId) : '');
  }

  async function loadDueCards() {
    var user = currentUser, requestId = ++dueRequest;
    var list = document.getElementById('dash-due-list');
    list.replaceChildren();
    var message = document.createElement('p'); message.className = 'dashboard-due-message';
    message.textContent = user ? 'Finding your due cards…' : 'Sign in to see your due cards.';
    list.appendChild(message);
    if (!user) return;
    try {
      var token = await user.getIdToken();
      var response = await fetch('/api/study-progress/due?scope=active_plan', { headers: { Authorization: 'Bearer ' + token } });
      if (!response.ok) throw new Error('Could not load due cards.');
      var data = await response.json();
      if (currentUser !== user || requestId !== dueRequest) return;
      list.replaceChildren();
      dueEl.textContent = data.due_count + ' card' + (data.due_count === 1 ? '' : 's');
      if (!data.packs || !data.packs.length) {
        message.textContent = 'No cards are due in your active Study Plan. Add packs to your plan to include their scheduled reviews here.';
        list.appendChild(message); return;
      }
      data.packs.forEach(function (pack) {
        var section = document.createElement('section'); section.className = 'dashboard-due-pack';
        var head = document.createElement('div'); head.className = 'dashboard-due-pack-head';
        var title = document.createElement('h3'); title.textContent = pack.title;
        var review = document.createElement('a'); review.className = 'hero-btn';
        review.href = studyEntry(pack.study_pack_id) + '&review=due';
        review.textContent = 'Review ' + pack.due_count + ' due card' + (pack.due_count === 1 ? '' : 's');
        head.append(title, review); section.appendChild(head);
        var cards = document.createElement('ol'); cards.className = 'dashboard-due-cards';
        (pack.cards || []).forEach(function (card) { var item = document.createElement('li'); item.textContent = card.front; cards.appendChild(item); });
        section.appendChild(cards); list.appendChild(section);
      });
    } catch (_) {
      if (currentUser !== user || requestId !== dueRequest) return;
      list.replaceChildren(); message.textContent = 'Could not load due cards. Your progress is safe; try again.';
      var retry = document.createElement('button'); retry.type = 'button'; retry.className = 'hero-btn secondary'; retry.textContent = 'Try again'; retry.addEventListener('click', loadDueCards);
      list.append(message, retry);
    }
  }
  document.getElementById('dash-due-open').addEventListener('click', function () {
    var panel = document.getElementById('dash-due-panel');
    panel.hidden = false;
    if (!panel.open) panel.querySelector('summary').click();
    this.setAttribute('aria-expanded', 'true');
    loadDueCards();
    panel.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
  });
  document.getElementById('dash-due-panel').addEventListener('toggle', function () { document.getElementById('dash-due-open').setAttribute('aria-expanded', String(this.open)); });

  function handleExternalProgressEvent(user) {
    if (user) loadDashboard(user);
  }

  if (progressUtils && typeof progressUtils.subscribeProgressEvent === 'function') {
    progressUtils.subscribeProgressEvent(function (payload) {
      handleExternalProgressEvent(currentUser, payload);
    });
  }

  setDashboardLoading(true);
  window.setTimeout(function () {
    if (dashboardPage && dashboardPage.getAttribute('data-load-state') === 'loading') {
      setDashboardLoading(false);
    }
  }, 5000);
  if (!auth || typeof bootstrap.onAuthStateReady !== 'function') {
    loadDashboard(null);
    return;
  }

  bootstrap.onAuthStateReady(auth, function (user) {
    currentUser = user || null;
    loadDashboard(currentUser);
  });
})();
