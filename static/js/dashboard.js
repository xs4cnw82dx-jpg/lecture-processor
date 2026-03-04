(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  if (!auth) return;

  var streakEl = document.getElementById('dash-streak');
  var dueEl = document.getElementById('dash-due');
  var goalEl = document.getElementById('dash-goal');
  var goalFillEl = document.getElementById('dash-goal-fill');
  var sessionsList = document.getElementById('dash-sessions-list');
  var packsList = document.getElementById('dash-packs-list');

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

  function renderUpcomingSessions(user) {
    if (!sessionsList) return;
    while (sessionsList.firstChild) sessionsList.removeChild(sessionsList.firstChild);
    if (!user) {
      sessionsList.innerHTML = '<div class="list-empty">Sign in to view upcoming sessions.</div>';
      return;
    }
    var key = 'study_sessions_' + user.uid;
    var sessions = [];
    try {
      sessions = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(sessions)) sessions = [];
    } catch (_) {
      sessions = [];
    }
    var today = localDateString();
    var future = sortSessions(sessions).filter(function (session) {
      return String(session.date || '') >= today;
    }).slice(0, 4);
    if (!future.length) {
      sessionsList.innerHTML = '<div class="list-empty">No study sessions planned yet.</div>';
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
      packsList.innerHTML = '<div class="list-empty">No study packs yet.</div>';
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
    if (!user) {
      if (streakEl) streakEl.textContent = '0 days';
      if (dueEl) dueEl.textContent = '0 cards';
      if (goalEl) goalEl.textContent = '0 / 20';
      if (goalFillEl) goalFillEl.style.width = '0%';
      renderUpcomingSessions(null);
      renderRecentPacks([]);
      return;
    }
    renderUpcomingSessions(user);
    try {
      var token = await user.getIdToken();
      var headers = { Authorization: 'Bearer ' + token };
      var result = await Promise.all([
        fetch('/api/study-progress', { headers: headers }),
        fetch('/api/study-packs', { headers: headers })
      ]);
      if (result[0].ok) {
        var progressPayload = await result[0].json();
        var summary = progressPayload && progressPayload.summary ? progressPayload.summary : {};
        var streak = Number(summary.current_streak || 0);
        var due = Number(summary.due_today || 0);
        var goal = Math.max(1, Number(summary.daily_goal || 20));
        var done = Math.max(0, Number(summary.today_progress || 0));
        if (streakEl) streakEl.textContent = streak + ' day' + (streak === 1 ? '' : 's');
        if (dueEl) dueEl.textContent = due + ' card' + (due === 1 ? '' : 's');
        if (goalEl) goalEl.textContent = Math.min(done, goal) + ' / ' + goal;
        if (goalFillEl) goalFillEl.style.width = String(Math.max(0, Math.min(100, Math.round((Math.min(done, goal) / goal) * 100)))) + '%';
      }
      if (result[1].ok) {
        var packsPayload = await result[1].json();
        renderRecentPacks((packsPayload && packsPayload.study_packs) || []);
      } else {
        renderRecentPacks([]);
      }
    } catch (_) {
      renderRecentPacks([]);
    }
  }

  auth.onAuthStateChanged(function (user) {
    loadDashboard(user || null);
  });
})();
