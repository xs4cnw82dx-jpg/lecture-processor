(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var uiCache = window.LectureProcessorUiCache || null;
  var progressUtils = window.LectureProcessorStudyProgressUtils || {};
  if (!auth) return;

  var streakEl = document.getElementById('dash-streak');
  var dueEl = document.getElementById('dash-due');
  var goalEl = document.getElementById('dash-goal');
  var goalFillEl = document.getElementById('dash-goal-fill');
  var sessionsList = document.getElementById('dash-sessions-list');
  var packsList = document.getElementById('dash-packs-list');
  var dashboardPage = document.getElementById('dashboard-page');
  var DASHBOARD_CACHE_GLOBAL_KEY = 'dashboard_summary:last';
  var DASHBOARD_CACHE_USER_PREFIX = 'dashboard_summary:user:';
  var currentUser = null;

  function setDashboardLoading(isLoading) {
    if (!dashboardPage) return;
    dashboardPage.setAttribute('data-load-state', isLoading ? 'loading' : 'ready');
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
    if (uiCache && typeof uiCache.getJson === 'function') {
      return uiCache.getJson(key, fallbackValue);
    }
    try {
      var raw = window.localStorage.getItem('lp_ui_v2:' + key);
      return raw ? JSON.parse(raw) : fallbackValue;
    } catch (_) {
      return fallbackValue;
    }
  }

  function writeCacheJson(key, value) {
    if (uiCache && typeof uiCache.setJson === 'function') {
      return uiCache.setJson(key, value);
    }
    try {
      window.localStorage.setItem('lp_ui_v2:' + key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
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
      if (goalFillEl) goalFillEl.style.width = '0%';
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
      goalFillEl.style.width = String(
        progressUtils && typeof progressUtils.goalCompletionPercent === 'function'
          ? progressUtils.goalCompletionPercent({ today_progress: done, daily_goal: goal }, goal)
          : Math.max(0, Math.min(100, Math.round((Math.min(done, goal) / goal) * 100)))
      ) + '%';
    }
  }

  function hydrateCachedSnapshot(user) {
    var fromUser = user && user.uid ? readCacheJson(DASHBOARD_CACHE_USER_PREFIX + user.uid, null) : null;
    var fromGlobal = readCacheJson(DASHBOARD_CACHE_GLOBAL_KEY, null);
    applySnapshot(fromUser || fromGlobal || null);
  }

  function persistSnapshot(user, snapshot) {
    if (!snapshot) return;
    writeCacheJson(DASHBOARD_CACHE_GLOBAL_KEY, snapshot);
    if (user && user.uid) {
      writeCacheJson(DASHBOARD_CACHE_USER_PREFIX + user.uid, snapshot);
    }
  }

  function readUpcomingSessions(user) {
    if (!user) return [];
    var key = 'study_sessions_' + user.uid;
    var sessions = [];
    try {
      sessions = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(sessions)) sessions = [];
    } catch (_) {
      sessions = [];
    }
    var today = localDateString();
    return sortSessions(sessions).filter(function (session) {
      return String(session.date || '') >= today;
    }).slice(0, 4);
  }

  function renderUpcomingSessions(user, sessions) {
    if (!sessionsList) return;
    while (sessionsList.firstChild) sessionsList.removeChild(sessionsList.firstChild);
    if (!user) {
      sessionsList.innerHTML = '<div class="empty-state-card"><h3>Sign in to plan study sessions</h3><p>Use your account to save sessions, track what is due, and keep your calendar connected to your packs.</p><div class="empty-state-actions"><a class="empty-state-link primary" href="/lecture-notes?auth=signin">Sign in</a><a class="empty-state-link" href="/helpcenter">Help Center</a></div></div>';
      return;
    }
    var future = Array.isArray(sessions) ? sessions : [];
    if (!future.length) {
      sessionsList.innerHTML = '<div class="empty-state-card"><h3>Plan your first study session</h3><p>Set up a session once, then use Calendar to see what is coming up and keep your semester visible.</p><div class="empty-state-actions"><a class="empty-state-link primary" href="/calendar">Open Calendar</a><a class="empty-state-link" href="/plan">Planning &amp; Progress</a></div></div>';
      return;
    }
    future.forEach(function (session) {
      var row = document.createElement('div');
      row.className = 'list-item';
      var title = document.createElement('h3');
      title.textContent = String(session.title || 'Study session');
      var meta = document.createElement('p');
      var pack = session.pack_title ? (' · ' + session.pack_title) : '';
      meta.textContent = String(session.date || '-') + ' at ' + String(session.time || '00:00') + pack;
      row.appendChild(title);
      row.appendChild(meta);
      sessionsList.appendChild(row);
    });
  }

  function renderRecentPacks(packs) {
    if (!packsList) return;
    while (packsList.firstChild) packsList.removeChild(packsList.firstChild);
    if (!packs || !packs.length) {
      packsList.innerHTML = '<div class="empty-state-card"><h3>Upload your first lecture</h3><p>Create a study pack first, then your latest packs will appear here for quick access.</p><div class="empty-state-actions"><a class="empty-state-link primary" href="/lecture-notes">Upload first lecture</a><a class="empty-state-link" href="/study">Open Study Library</a></div></div>';
      return;
    }
    packs.slice(0, 5).forEach(function (pack) {
      var row = document.createElement('a');
      row.className = 'list-item';
      row.href = '/study?pack_id=' + encodeURIComponent(String(pack.study_pack_id || ''));
      row.style.textDecoration = 'none';
      row.style.color = 'inherit';
      var title = document.createElement('h3');
      title.textContent = String(pack.title || 'Untitled pack');
      var meta = document.createElement('p');
      meta.textContent = (pack.mode || '-') + ' · ' + (pack.flashcards_count || 0) + ' cards · ' + (pack.test_questions_count || 0) + ' questions';
      row.appendChild(title);
      row.appendChild(meta);
      packsList.appendChild(row);
    });
  }

  async function loadDashboard(user) {
    setDashboardLoading(true);
    if (!user) {
      applySnapshot(null);
      renderUpcomingSessions(null, []);
      renderRecentPacks([]);
      setDashboardLoading(false);
      return;
    }
    var sessions = readUpcomingSessions(user);
    try {
      var token = await user.getIdToken();
      var headers = { Authorization: 'Bearer ' + token };
      var result = await Promise.all([
        fetch('/api/study-progress', { headers: headers }),
        fetch('/api/study-packs', { headers: headers })
      ]);
      var snapshot = null;
      if (result[0].ok) {
        var progressPayload = await result[0].json();
        var summary = progressPayload && progressPayload.summary ? progressPayload.summary : {};
        snapshot = toSnapshot(summary);
        persistSnapshot(user, snapshot);
      }
      if (snapshot) applySnapshot(snapshot);
      else hydrateCachedSnapshot(user);
      renderUpcomingSessions(user, sessions);
      if (result[1].ok) {
        var packsPayload = await result[1].json();
        renderRecentPacks((packsPayload && packsPayload.study_packs) || []);
      } else {
        renderRecentPacks([]);
      }
    } catch (_) {
      hydrateCachedSnapshot(user);
      renderUpcomingSessions(user, sessions);
      renderRecentPacks([]);
    } finally {
      setDashboardLoading(false);
    }
  }

  function handleExternalProgressEvent(user, payload) {
    if (!user || !payload || (payload.user_id && payload.user_id !== user.uid)) return;
    if (!payload.summary || typeof payload.summary !== 'object') return;
    var snapshot = toSnapshot(payload.summary);
    persistSnapshot(user, snapshot);
    applySnapshot(snapshot);
  }

  if (progressUtils && typeof progressUtils.subscribeProgressEvent === 'function') {
    progressUtils.subscribeProgressEvent(function (payload) {
      handleExternalProgressEvent(currentUser, payload);
    });
  }

  auth.onAuthStateChanged(function (user) {
    currentUser = user || null;
    loadDashboard(currentUser);
  });

  setDashboardLoading(true);
})();
