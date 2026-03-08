(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Not signed in' }) : null;
  var uiCache = window.LectureProcessorUiCache || null;
  var progressUtils = window.LectureProcessorStudyProgressUtils || {};
  if (!auth) return;

  var authRequiredEl = document.getElementById('auth-required');
  var plannerContentEl = document.getElementById('planner-content');
  var streakValueEl = document.getElementById('streak-value');
  var dueValueEl = document.getElementById('due-value');
  var goalValueEl = document.getElementById('goal-value');
  var goalFillEl = document.getElementById('goal-fill');
  var goalInputEl = document.getElementById('goal-input');
  var saveGoalBtn = document.getElementById('save-goal-btn');
  var foldersBodyEl = document.getElementById('folders-body');
  var foldersCardsEl = document.getElementById('folders-cards');
  var foldersEmptyEl = document.getElementById('folders-empty');
  var packGoalsBodyEl = document.getElementById('pack-goals-body');
  var packGoalsCardsEl = document.getElementById('pack-goals-cards');
  var packGoalsEmptyEl = document.getElementById('pack-goals-empty');
  var toastEl = document.getElementById('toast');

  var DEFAULT_DAILY_GOAL = progressUtils.DEFAULT_DAILY_GOAL || 20;
  var flatpickrInstances = [];
  var currentUser = null;
  var currentToken = null;
  var currentFolders = [];
  var currentPacks = [];
  var remoteCardStates = {};
  var progressSummaryCache = null;
  var timezoneName = '';
  var goalSaveInFlight = false;
  var goalAutosaveTimer = null;
  var folderSaveTimers = new Map();
  var folderSaveInFlight = new Set();
  var packGoalTimers = new Map();
  var packGoalSaveInFlight = new Set();
  var packGoalDraftValues = new Map();
  var PLAN_CACHE_GLOBAL_KEY = 'plan_summary:last';
  var PLAN_CACHE_USER_PREFIX = 'plan_summary:user:';
  var PLAN_SYNC_SOURCE_ID = 'plan-' + Math.random().toString(36).slice(2, 10);
  var toastTimer = null;

  function showToast(message, type) {
    if (!toastEl || !message) return;
    toastEl.textContent = String(message);
    toastEl.className = 'toast visible' + (type ? ' ' + type : '');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      toastEl.className = 'toast';
    }, 2200);
  }

  function readCacheJson(key, fallbackValue) {
    if (uiCache && typeof uiCache.getJson === 'function') {
      return uiCache.getJson(key, fallbackValue);
    }
    try {
      var raw = window.localStorage.getItem('lp_ui_v2:' + key);
      return raw ? JSON.parse(raw) : fallbackValue;
    } catch (_error) {
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
    } catch (_error) {
      return false;
    }
  }

  function getSummaryCacheKey(uid) {
    return PLAN_CACHE_USER_PREFIX + String(uid || 'anon');
  }

  function hydrateSummaryCache(uid) {
    progressSummaryCache = readCacheJson(getSummaryCacheKey(uid), null) || readCacheJson(PLAN_CACHE_GLOBAL_KEY, null);
  }

  function persistSummaryCache(uid, summary) {
    if (!summary || typeof summary !== 'object') return;
    writeCacheJson(PLAN_CACHE_GLOBAL_KEY, summary);
    writeCacheJson(getSummaryCacheKey(uid), summary);
  }

  function persistDashboardSnapshot(uid, summary) {
    if (!summary) return;
    var snapshot = summarySnapshot(summary);
    writeCacheJson('dashboard_summary:last', snapshot);
    writeCacheJson('dashboard_summary:user:' + String(uid || 'anon'), snapshot);
  }

  function broadcastPlannerProgress(summary, extraPayload) {
    if (!currentUser || !summary || !progressUtils || typeof progressUtils.broadcastProgressEvent !== 'function') return;
    progressUtils.broadcastProgressEvent(Object.assign({
      source_id: PLAN_SYNC_SOURCE_ID,
      user_id: currentUser.uid,
      summary: Object.assign({}, summary)
    }, extraPayload || {}));
  }

  function setAuthView(user) {
    if (authRequiredEl) authRequiredEl.style.display = user ? 'none' : 'block';
    if (plannerContentEl) plannerContentEl.style.display = user ? 'block' : 'none';
  }

  function ensureToken(forceRefresh) {
    if (!currentUser) return Promise.reject(new Error('Not signed in'));
    if (authClient && typeof authClient.ensureToken === 'function') {
      return authClient.ensureToken(!!forceRefresh).then(function (tokenValue) {
        currentToken = tokenValue;
        return tokenValue;
      });
    }
    if (currentToken && !forceRefresh) return Promise.resolve(currentToken);
    return currentUser.getIdToken(!!forceRefresh).then(function (tokenValue) {
      currentToken = tokenValue;
      return tokenValue;
    });
  }

  function authFetch(path, options) {
    if (authClient && typeof authClient.authFetch === 'function') {
      return authClient.authFetch(path, options, { retryOn401: true }).then(function (response) {
        var authHeader = response && response.config && response.config.headers ? response.config.headers.Authorization : '';
        if (authHeader && String(authHeader).indexOf('Bearer ') === 0) {
          currentToken = String(authHeader).slice(7);
        }
        return response;
      });
    }
    return ensureToken(false).then(function (tokenValue) {
      var requestOptions = options || {};
      var headers = Object.assign({}, requestOptions.headers || {}, {
        Authorization: 'Bearer ' + tokenValue,
      });
      return fetch(path, Object.assign({}, requestOptions, { headers: headers }));
    });
  }

  function parseGoalValue(value) {
    if (progressUtils && typeof progressUtils.parseGoalValue === 'function') {
      return progressUtils.parseGoalValue(value);
    }
    var parsed = parseInt(String(value == null ? '' : value).trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > 500) return null;
    return parsed;
  }

  function clampGoalValue(value, fallbackValue) {
    if (progressUtils && typeof progressUtils.clampGoalValue === 'function') {
      return progressUtils.clampGoalValue(value, fallbackValue);
    }
    var parsed = parseGoalValue(value);
    return parsed === null ? (fallbackValue || DEFAULT_DAILY_GOAL) : parsed;
  }

  function formatCount(value, singular, plural) {
    if (progressUtils && typeof progressUtils.formatCount === 'function') {
      return progressUtils.formatCount(value, singular, plural);
    }
    var count = Math.max(0, parseInt(value, 10) || 0);
    return count + ' ' + (count === 1 ? singular : (plural || singular + 's'));
  }

  function goalProgressText(summary, fallbackGoal) {
    if (progressUtils && typeof progressUtils.goalProgressText === 'function') {
      return progressUtils.goalProgressText(summary, fallbackGoal);
    }
    var goal = clampGoalValue(summary && summary.daily_goal, fallbackGoal);
    var done = Math.max(0, Number(summary && summary.today_progress || 0));
    return Math.min(done, goal) + ' / ' + goal;
  }

  function goalCompletionPercent(summary, fallbackGoal) {
    if (progressUtils && typeof progressUtils.goalCompletionPercent === 'function') {
      return progressUtils.goalCompletionPercent(summary, fallbackGoal);
    }
    var goal = clampGoalValue(summary && summary.daily_goal, fallbackGoal);
    var done = Math.max(0, Number(summary && summary.today_progress || 0));
    return Math.max(0, Math.min(100, Math.round((Math.min(done, goal) / Math.max(goal, 1)) * 100)));
  }

  function normalizeTimezoneName(value) {
    if (progressUtils && typeof progressUtils.normalizeTimezoneName === 'function') {
      return progressUtils.normalizeTimezoneName(value);
    }
    var timezone = String(value || '').trim();
    if (!timezone) return '';
    try {
      Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date());
      return timezone;
    } catch (_error) {
      return '';
    }
  }

  function getTodayString() {
    if (progressUtils && typeof progressUtils.localDateString === 'function') {
      return progressUtils.localDateString(Date.now(), timezoneName || '');
    }
    var date = new Date();
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }

  function summarySnapshot(summary) {
    if (progressUtils && typeof progressUtils.summarySnapshot === 'function') {
      return progressUtils.summarySnapshot(summary, DEFAULT_DAILY_GOAL);
    }
    var safe = summary && typeof summary === 'object' ? summary : {};
    return {
      streak: Math.max(0, Number(safe.current_streak || 0)),
      due: Math.max(0, Number(safe.due_today || 0)),
      done: Math.max(0, Number(safe.today_progress || 0)),
      goal: clampGoalValue(safe.daily_goal, DEFAULT_DAILY_GOAL),
    };
  }

  function applyOverview(summary) {
    var snapshot = summarySnapshot(summary || progressSummaryCache || null);
    if (streakValueEl) streakValueEl.textContent = formatCount(snapshot.streak, 'day');
    if (dueValueEl) dueValueEl.textContent = formatCount(snapshot.due, 'card');
    if (goalValueEl) {
      goalValueEl.textContent = goalProgressText({
        today_progress: snapshot.done,
        daily_goal: snapshot.goal,
      }, snapshot.goal);
    }
    if (goalFillEl) {
      goalFillEl.style.width = String(goalCompletionPercent({
        today_progress: snapshot.done,
        daily_goal: snapshot.goal,
      }, snapshot.goal)) + '%';
    }
    if (goalInputEl && document.activeElement !== goalInputEl) {
      goalInputEl.value = String(snapshot.goal);
    }
  }

  function parseDateInput(value) {
    var raw = String(value || '').trim();
    if (!raw) return '';
    var match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (match) {
      var isoDate = new Date(parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10));
      if (isoDate.getFullYear() !== parseInt(match[1], 10) || isoDate.getMonth() + 1 !== parseInt(match[2], 10) || isoDate.getDate() !== parseInt(match[3], 10)) {
        return null;
      }
      return raw;
    }
    match = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
    if (match) {
      var year = parseInt(match[3], 10);
      var month = parseInt(match[2], 10);
      var day = parseInt(match[1], 10);
      var localDate = new Date(year, month - 1, day);
      if (localDate.getFullYear() !== year || localDate.getMonth() + 1 !== month || localDate.getDate() !== day) {
        return null;
      }
      return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
    }
    return null;
  }

  function formatDisplayDate(value) {
    var match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return '';
    return match[3] + '-' + match[2] + '-' + match[1];
  }

  function readPackState(packId) {
    var safePackId = String(packId || '').trim();
    if (!safePackId) return {};
    if (currentUser) {
      try {
        var localState = JSON.parse(window.localStorage.getItem('card_state_' + currentUser.uid + '_' + safePackId) || '{}') || {};
        if (localState && typeof localState === 'object' && Object.keys(localState).length) {
          return localState;
        }
      } catch (_error) {
        // Fall back to remote state below.
      }
    }
    if (remoteCardStates && remoteCardStates[safePackId] && typeof remoteCardStates[safePackId] === 'object') {
      return remoteCardStates[safePackId];
    }
    return {};
  }

  function getPackStats(pack) {
    if (progressUtils && typeof progressUtils.buildPackStats === 'function') {
      return progressUtils.buildPackStats(pack, readPackState(pack && pack.study_pack_id), getTodayString());
    }
    return {
      total: Math.max(0, Number(pack && pack.flashcards_count || 0)),
      due: 0,
      unmastered: Math.max(0, Number(pack && pack.flashcards_count || 0)),
    };
  }

  function buildFolderStatsMap() {
    var statsByFolder = {};
    (currentPacks || []).forEach(function (pack) {
      var folderId = String(pack && pack.folder_id || '').trim();
      if (!folderId) return;
      var stats = getPackStats(pack);
      if (!statsByFolder[folderId]) {
        statsByFolder[folderId] = { total: 0, due: 0, unmastered: 0 };
      }
      statsByFolder[folderId].total += Math.max(0, Number(stats.total || 0));
      statsByFolder[folderId].due += Math.max(0, Number(stats.due || 0));
      statsByFolder[folderId].unmastered += Math.max(0, Number(stats.unmastered || 0));
    });
    return statsByFolder;
  }

  function buildRecommendation(unmasteredCount, examDate) {
    if (progressUtils && typeof progressUtils.buildRecommendation === 'function') {
      return progressUtils.buildRecommendation(unmasteredCount, examDate, getTodayString());
    }
    return {
      tone: 'neutral',
      text: 'Set an exam date to get a daily recommendation.',
      days_remaining: null,
      daily_target: null,
    };
  }

  function createCountdownChip(recommendation) {
    var chip = document.createElement('span');
    var tone = String(recommendation && recommendation.tone || 'neutral');
    chip.className = 'chip' + (tone === 'success' || tone === 'warn' || tone === 'urgent' || tone === 'today' || tone === 'danger' ? ' ' + tone : '');
    if (!recommendation || recommendation.days_remaining === null || recommendation.days_remaining === undefined) {
      chip.textContent = 'No exam date';
      return chip;
    }
    if (recommendation.days_remaining < 0) {
      chip.textContent = 'Exam passed';
      return chip;
    }
    if (recommendation.days_remaining === 0) {
      chip.textContent = 'Today';
      return chip;
    }
    chip.textContent = recommendation.days_remaining + ' day' + (recommendation.days_remaining === 1 ? '' : 's') + ' left';
    return chip;
  }

  function createWorkloadNode(stats) {
    var wrap = document.createElement('div');
    wrap.className = 'recommendation';

    var totalStrong = document.createElement('strong');
    totalStrong.textContent = String(Math.max(0, Number(stats.total || 0)));
    wrap.appendChild(totalStrong);
    wrap.appendChild(document.createTextNode(' total · '));

    var unmasteredStrong = document.createElement('strong');
    unmasteredStrong.textContent = String(Math.max(0, Number(stats.unmastered || 0)));
    wrap.appendChild(unmasteredStrong);
    wrap.appendChild(document.createTextNode(' unmastered · '));

    var dueStrong = document.createElement('strong');
    dueStrong.textContent = String(Math.max(0, Number(stats.due || 0)));
    wrap.appendChild(dueStrong);
    wrap.appendChild(document.createTextNode(' due'));
    return wrap;
  }

  function createDateInput(folder, folderName) {
    var wrap = document.createElement('div');
    wrap.className = 'date-input-wrap';

    var input = document.createElement('input');
    input.className = 'input js-folder-date';
    input.type = 'text';
    input.placeholder = 'dd-mm-yyyy';
    input.setAttribute('inputmode', 'numeric');
    input.setAttribute('aria-label', 'Exam date for ' + folderName);
    input.dataset.folderId = String(folder.folder_id || '');
    input.dataset.savedExamDate = String(folder.exam_date || '');
    input.value = formatDisplayDate(folder.exam_date || '');
    wrap.appendChild(input);

    var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('class', 'date-input-icon');
    icon.setAttribute('viewBox', '0 0 24 24');
    icon.setAttribute('fill', 'none');
    icon.setAttribute('stroke', 'currentColor');
    icon.setAttribute('stroke-width', '2');
    var rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '3');
    rect.setAttribute('y', '4');
    rect.setAttribute('width', '18');
    rect.setAttribute('height', '18');
    rect.setAttribute('rx', '2');
    icon.appendChild(rect);
    var line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line1.setAttribute('x1', '16');
    line1.setAttribute('y1', '2');
    line1.setAttribute('x2', '16');
    line1.setAttribute('y2', '6');
    icon.appendChild(line1);
    var line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line2.setAttribute('x1', '8');
    line2.setAttribute('y1', '2');
    line2.setAttribute('x2', '8');
    line2.setAttribute('y2', '6');
    icon.appendChild(line2);
    var line3 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line3.setAttribute('x1', '3');
    line3.setAttribute('y1', '10');
    line3.setAttribute('x2', '21');
    line3.setAttribute('y2', '10');
    icon.appendChild(line3);
    wrap.appendChild(icon);

    return wrap;
  }

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function initFolderDatePickers() {
    if (typeof flatpickr === 'undefined') return;
    flatpickrInstances.forEach(function (instance) {
      try { instance.destroy(); } catch (_error) { }
    });
    flatpickrInstances = [];

    Array.prototype.slice.call(document.querySelectorAll('.js-folder-date')).forEach(function (input) {
      var folderId = String(input.dataset.folderId || '');
      var picker = flatpickr(input, {
        dateFormat: 'd-m-Y',
        allowInput: true,
        disableMobile: true,
        locale: { firstDayOfWeek: 1 },
        defaultDate: input.value || null,
        onClose: function () {
          if (folderId) scheduleFolderExamDateSave(folderId, input, true);
        },
      });
      flatpickrInstances.push(picker);
    });
  }

  function bindFolderDateAutosave() {
    Array.prototype.slice.call(document.querySelectorAll('.js-folder-date')).forEach(function (input) {
      var folderId = String(input.dataset.folderId || '');
      if (!folderId) return;
      input.addEventListener('input', function () {
        scheduleFolderExamDateSave(folderId, input, false);
      });
      input.addEventListener('blur', function () {
        scheduleFolderExamDateSave(folderId, input, true);
      });
      input.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        scheduleFolderExamDateSave(folderId, input, true);
      });
    });
  }

  function renderFolders() {
    clearNode(foldersBodyEl);
    clearNode(foldersCardsEl);

    if (!currentFolders.length) {
      if (foldersEmptyEl) foldersEmptyEl.style.display = 'block';
      return;
    }

    if (foldersEmptyEl) foldersEmptyEl.style.display = 'none';
    var folderStatsById = buildFolderStatsMap();

    currentFolders.forEach(function (folder) {
      var folderName = String(folder.name || 'Untitled folder');
      var metadata = [folder.course, folder.subject, folder.semester, folder.block].filter(Boolean).join(' · ') || 'No metadata';
      var stats = folderStatsById[String(folder.folder_id || '')] || { total: 0, due: 0, unmastered: 0 };
      var recommendation = buildRecommendation(stats.unmastered, folder.exam_date || '');
      var countdownChip = createCountdownChip(recommendation);

      var tr = document.createElement('tr');
      tr.setAttribute('data-folder-editor', String(folder.folder_id || ''));

      var tdName = document.createElement('td');
      var titleWrap = document.createElement('div');
      var titleStrong = document.createElement('strong');
      titleStrong.textContent = folderName;
      titleWrap.appendChild(titleStrong);
      var metaDiv = document.createElement('div');
      metaDiv.className = 'folder-meta';
      metaDiv.textContent = metadata;
      tdName.appendChild(titleWrap);
      tdName.appendChild(metaDiv);

      var tdDate = document.createElement('td');
      tdDate.appendChild(createDateInput(folder, folderName));

      var tdWorkload = document.createElement('td');
      tdWorkload.appendChild(createWorkloadNode(stats));
      var countdownRow = document.createElement('div');
      countdownRow.style.marginTop = '6px';
      countdownRow.appendChild(countdownChip.cloneNode(true));
      tdWorkload.appendChild(countdownRow);

      var tdRecommendation = document.createElement('td');
      var recommendationNode = document.createElement('div');
      recommendationNode.className = 'recommendation';
      recommendationNode.textContent = recommendation.text;
      tdRecommendation.appendChild(recommendationNode);

      tr.appendChild(tdName);
      tr.appendChild(tdDate);
      tr.appendChild(tdWorkload);
      tr.appendChild(tdRecommendation);
      foldersBodyEl.appendChild(tr);

      var card = document.createElement('article');
      card.className = 'folder-card';
      card.setAttribute('data-folder-editor', String(folder.folder_id || ''));
      var cardHeader = document.createElement('div');
      cardHeader.className = 'folder-card-header';
      var headerText = document.createElement('div');
      var cardTitle = document.createElement('div');
      cardTitle.className = 'folder-card-title';
      cardTitle.textContent = folderName;
      var cardMeta = document.createElement('div');
      cardMeta.className = 'folder-card-meta';
      cardMeta.textContent = metadata;
      headerText.appendChild(cardTitle);
      headerText.appendChild(cardMeta);
      cardHeader.appendChild(headerText);
      cardHeader.appendChild(countdownChip);
      card.appendChild(cardHeader);

      var examSection = document.createElement('div');
      examSection.className = 'folder-card-section';
      var examLabel = document.createElement('span');
      examLabel.className = 'folder-card-label';
      examLabel.textContent = 'Exam date';
      examSection.appendChild(examLabel);
      examSection.appendChild(createDateInput(folder, folderName));
      card.appendChild(examSection);

      var workloadSection = document.createElement('div');
      workloadSection.className = 'folder-card-section';
      var workloadLabel = document.createElement('span');
      workloadLabel.className = 'folder-card-label';
      workloadLabel.textContent = 'Workload';
      workloadSection.appendChild(workloadLabel);
      workloadSection.appendChild(createWorkloadNode(stats));
      card.appendChild(workloadSection);

      var recommendationSection = document.createElement('div');
      recommendationSection.className = 'folder-card-section';
      var recommendationLabel = document.createElement('span');
      recommendationLabel.className = 'folder-card-label';
      recommendationLabel.textContent = 'Recommendation';
      recommendationSection.appendChild(recommendationLabel);
      var cardRecommendation = document.createElement('div');
      cardRecommendation.className = 'recommendation';
      cardRecommendation.textContent = recommendation.text;
      recommendationSection.appendChild(cardRecommendation);
      card.appendChild(recommendationSection);

      foldersCardsEl.appendChild(card);
    });

    initFolderDatePickers();
    bindFolderDateAutosave();
  }

  function parseOptionalGoalValue(value) {
    if (progressUtils && typeof progressUtils.parseOptionalGoalValue === 'function') {
      return progressUtils.parseOptionalGoalValue(value);
    }
    var raw = String(value == null ? '' : value).trim();
    return raw ? parseGoalValue(raw) : null;
  }

  function sameGoalValue(leftValue, rightValue) {
    if (progressUtils && typeof progressUtils.sameGoalValue === 'function') {
      return progressUtils.sameGoalValue(leftValue, rightValue);
    }
    return parseOptionalGoalValue(leftValue) === parseOptionalGoalValue(rightValue);
  }

  function formatGoalTarget(value, emptyLabel) {
    if (progressUtils && typeof progressUtils.formatGoalTarget === 'function') {
      return progressUtils.formatGoalTarget(value, { emptyLabel: emptyLabel || 'Not set' });
    }
    var parsed = parseOptionalGoalValue(value);
    return parsed === null ? String(emptyLabel || 'Not set') : parsed + ' cards/day';
  }

  function updatePackCollectionGoal(packList, packId, goalValue) {
    if (progressUtils && typeof progressUtils.updatePackCollectionGoal === 'function') {
      return progressUtils.updatePackCollectionGoal(packList, packId, goalValue);
    }
    var safePackId = String(packId || '').trim();
    var normalizedGoal = parseOptionalGoalValue(goalValue);
    return (Array.isArray(packList) ? packList : []).map(function (pack) {
      if (String(pack && pack.study_pack_id || '').trim() !== safePackId) return pack;
      return Object.assign({}, pack, { daily_card_goal: normalizedGoal });
    });
  }

  function buildPackGoalNoteText(goalValue) {
    var parsed = parseOptionalGoalValue(goalValue);
    if (parsed === null) {
      return 'No Pack Goal saved. Leave empty to use only the Daily Goal.';
    }
    return 'Saved Pack Goal: ' + formatGoalTarget(parsed, 'Not set') + '. Syncs with Study Library.';
  }

  function getPackGoalInputs(packId) {
    var safePackId = String(packId || '').trim();
    if (!safePackId) return [];
    return Array.prototype.slice.call(document.querySelectorAll('[data-pack-goal-input="' + safePackId + '"]'));
  }

  function getPackGoalNotes(packId) {
    var safePackId = String(packId || '').trim();
    if (!safePackId) return [];
    return Array.prototype.slice.call(document.querySelectorAll('[data-pack-goal-note="' + safePackId + '"]'));
  }

  function setPackGoalInputsDisabled(packId, disabled) {
    getPackGoalInputs(packId).forEach(function (input) {
      input.disabled = !!disabled;
    });
  }

  function mirrorPackGoalDraftValue(packId, rawValue, sourceInput) {
    var safePackId = String(packId || '').trim();
    if (!safePackId) return;
    var normalizedRawValue = String(rawValue == null ? '' : rawValue);
    packGoalDraftValues.set(safePackId, normalizedRawValue);
    getPackGoalInputs(safePackId).forEach(function (input) {
      if (sourceInput && input === sourceInput) return;
      input.value = normalizedRawValue;
    });
  }

  function readPackGoalDraftValue(packId) {
    var safePackId = String(packId || '').trim();
    if (!safePackId) return '';
    if (packGoalDraftValues.has(safePackId)) {
      return String(packGoalDraftValues.get(safePackId) || '');
    }
    var inputs = getPackGoalInputs(safePackId);
    return inputs.length ? String(inputs[0].value || '') : '';
  }

  function syncPackGoalInputState(input, value) {
    if (!input) return;
    var normalized = parseOptionalGoalValue(value);
    input.value = normalized === null ? '' : String(normalized);
    input.dataset.savedGoal = normalized === null ? '' : String(normalized);
  }

  function syncPackGoalControls(packId, goalValue, options) {
    var settings = options && typeof options === 'object' ? options : {};
    var safePackId = String(packId || '').trim();
    if (!safePackId) return;
    getPackGoalInputs(safePackId).forEach(function (input) {
      syncPackGoalInputState(input, goalValue);
    });
    getPackGoalNotes(safePackId).forEach(function (node) {
      node.textContent = buildPackGoalNoteText(goalValue);
    });
    if (settings.clearDraft !== false) {
      packGoalDraftValues.delete(safePackId);
    }
  }

  function scheduleOverallGoalAutosave(immediate, showValidationError) {
    if (!goalInputEl || goalInputEl.disabled) return;
    if (goalAutosaveTimer) {
      window.clearTimeout(goalAutosaveTimer);
      goalAutosaveTimer = null;
    }
    if (immediate) {
      persistOverallGoal(!!showValidationError);
      return;
    }
    goalAutosaveTimer = window.setTimeout(function () {
      goalAutosaveTimer = null;
      persistOverallGoal(!!showValidationError);
    }, 420);
  }

  function schedulePackGoalAutosave(packId, immediate, showValidationError) {
    var safePackId = String(packId || '').trim();
    if (!safePackId) return;
    var existing = packGoalTimers.get(safePackId);
    if (existing) {
      window.clearTimeout(existing);
      packGoalTimers.delete(safePackId);
    }
    if (immediate) {
      persistPackGoal(safePackId, !!showValidationError);
      return;
    }
    var timer = window.setTimeout(function () {
      packGoalTimers.delete(safePackId);
      persistPackGoal(safePackId, !!showValidationError);
    }, 420);
    packGoalTimers.set(safePackId, timer);
  }

  function createPackGoalControls(pack) {
    var wrap = document.createElement('div');
    wrap.className = 'pack-goal-row';

    var input = document.createElement('input');
    input.type = 'number';
    input.className = 'input pack-goal-input';
    input.min = '1';
    input.max = '500';
    input.placeholder = 'Optional';
    input.dataset.packGoalInput = String(pack.study_pack_id || '');
    input.setAttribute('aria-label', 'Pack Goal for ' + String(pack.title || 'Untitled pack'));
    syncPackGoalInputState(input, pack.daily_card_goal);
    wrap.appendChild(input);

    return wrap;
  }

  function bindPackGoalEvents() {
    Array.prototype.slice.call(document.querySelectorAll('[data-pack-goal-input]')).forEach(function (input) {
      var packId = String(input.getAttribute('data-pack-goal-input') || '');
      input.addEventListener('input', function () {
        mirrorPackGoalDraftValue(packId, input.value, input);
        schedulePackGoalAutosave(packId, false, false);
      });
      input.addEventListener('change', function () {
        mirrorPackGoalDraftValue(packId, input.value, input);
        schedulePackGoalAutosave(packId, true, true);
      });
      input.addEventListener('blur', function () {
        mirrorPackGoalDraftValue(packId, input.value, input);
        schedulePackGoalAutosave(packId, true, true);
      });
      input.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        mirrorPackGoalDraftValue(packId, input.value, input);
        schedulePackGoalAutosave(packId, true, true);
      });
    });
  }

  function renderPackGoals() {
    clearNode(packGoalsBodyEl);
    clearNode(packGoalsCardsEl);

    if (!currentPacks.length) {
      packGoalDraftValues.clear();
      if (packGoalsEmptyEl) packGoalsEmptyEl.style.display = 'block';
      return;
    }
    if (packGoalsEmptyEl) packGoalsEmptyEl.style.display = 'none';

    currentPacks.forEach(function (pack) {
      var folder = currentFolders.find(function (item) {
        return String(item.folder_id || '') === String(pack.folder_id || '');
      }) || null;
      var folderName = folder ? String(folder.name || 'No folder') : (pack.folder_name ? String(pack.folder_name) : 'No folder');
      var stats = getPackStats(pack);
      var recommendation = buildRecommendation(stats.unmastered, folder && folder.exam_date ? folder.exam_date : '');

      var tr = document.createElement('tr');
      var nameTd = document.createElement('td');
      var nameStrong = document.createElement('strong');
      nameStrong.textContent = String(pack.title || 'Untitled pack');
      nameTd.appendChild(nameStrong);
      var nameMeta = document.createElement('div');
      nameMeta.className = 'folder-meta';
      nameMeta.textContent = String(pack.mode || '');
      nameTd.appendChild(nameMeta);

      var folderTd = document.createElement('td');
      folderTd.textContent = folderName;

      var dueTd = document.createElement('td');
      dueTd.textContent = formatCount(stats.due, 'card');

      var unmasteredTd = document.createElement('td');
      unmasteredTd.textContent = formatCount(stats.unmastered, 'card');

      var goalTd = document.createElement('td');
      goalTd.appendChild(createPackGoalControls(pack));
      var goalNote = document.createElement('div');
      goalNote.className = 'pack-goal-note';
      goalNote.setAttribute('data-pack-goal-note', String(pack.study_pack_id || ''));
      goalNote.textContent = buildPackGoalNoteText(pack.daily_card_goal);
      goalTd.appendChild(goalNote);

      var recommendationTd = document.createElement('td');
      var recommendationNode = document.createElement('div');
      recommendationNode.className = 'pack-recommendation';
      recommendationNode.textContent = recommendation.text;
      recommendationTd.appendChild(recommendationNode);

      tr.appendChild(nameTd);
      tr.appendChild(folderTd);
      tr.appendChild(dueTd);
      tr.appendChild(unmasteredTd);
      tr.appendChild(goalTd);
      tr.appendChild(recommendationTd);
      packGoalsBodyEl.appendChild(tr);

      var card = document.createElement('article');
      card.className = 'pack-goal-card';
      var cardHead = document.createElement('div');
      cardHead.className = 'pack-goal-card-head';
      var headText = document.createElement('div');
      var cardTitle = document.createElement('div');
      cardTitle.className = 'pack-goal-card-title';
      cardTitle.textContent = String(pack.title || 'Untitled pack');
      var cardFolder = document.createElement('div');
      cardFolder.className = 'pack-goal-card-folder';
      cardFolder.textContent = folderName;
      headText.appendChild(cardTitle);
      headText.appendChild(cardFolder);
      cardHead.appendChild(headText);
      cardHead.appendChild(createCountdownChip(recommendation));
      card.appendChild(cardHead);

      var statsGrid = document.createElement('div');
      statsGrid.className = 'pack-goal-card-stats';
      [['Due today', stats.due], ['Unmastered', stats.unmastered]].forEach(function (entry) {
        var stat = document.createElement('div');
        stat.className = 'pack-goal-stat';
        var label = document.createElement('span');
        label.className = 'pack-goal-stat-label';
        label.textContent = entry[0];
        var value = document.createElement('div');
        value.className = 'pack-goal-stat-value';
        value.textContent = formatCount(entry[1], 'card');
        stat.appendChild(label);
        stat.appendChild(value);
        statsGrid.appendChild(stat);
      });
      card.appendChild(statsGrid);

      var packGoalControls = createPackGoalControls(pack);
      card.appendChild(packGoalControls);
      var packGoalNote = document.createElement('div');
      packGoalNote.className = 'pack-goal-note';
      packGoalNote.setAttribute('data-pack-goal-note', String(pack.study_pack_id || ''));
      packGoalNote.textContent = buildPackGoalNoteText(pack.daily_card_goal);
      card.appendChild(packGoalNote);
      var cardRecommendation = document.createElement('div');
      cardRecommendation.className = 'pack-recommendation';
      cardRecommendation.textContent = recommendation.text;
      card.appendChild(cardRecommendation);
      packGoalsCardsEl.appendChild(card);
    });

    bindPackGoalEvents();
  }

  function applyProgressPayload(progressData) {
    var safeProgress = progressData && typeof progressData === 'object' ? progressData : {};
    timezoneName = normalizeTimezoneName(safeProgress.timezone || '') || timezoneName || normalizeTimezoneName(Intl.DateTimeFormat().resolvedOptions().timeZone || '') || '';
    remoteCardStates = safeProgress.card_states && typeof safeProgress.card_states === 'object' ? safeProgress.card_states : {};
    progressSummaryCache = safeProgress.summary && typeof safeProgress.summary === 'object'
      ? safeProgress.summary
      : (progressSummaryCache || {
        current_streak: 0,
        due_today: 0,
        today_progress: 0,
        daily_goal: DEFAULT_DAILY_GOAL,
      });
    progressSummaryCache.daily_goal = clampGoalValue(safeProgress.daily_goal, progressSummaryCache.daily_goal || DEFAULT_DAILY_GOAL);
    if (currentUser) {
      if (progressUtils && typeof progressUtils.writeDailyGoalCache === 'function') {
        progressUtils.writeDailyGoalCache(currentUser.uid, progressSummaryCache.daily_goal);
      }
      persistSummaryCache(currentUser.uid, progressSummaryCache);
      persistDashboardSnapshot(currentUser.uid, progressSummaryCache);
    }
    applyOverview(progressSummaryCache);
  }

  function handleLoadFailure(message) {
    currentFolders = [];
    currentPacks = [];
    remoteCardStates = {};
    packGoalDraftValues.clear();
    clearNode(foldersBodyEl);
    clearNode(foldersCardsEl);
    clearNode(packGoalsBodyEl);
    clearNode(packGoalsCardsEl);
    if (foldersEmptyEl) {
      foldersEmptyEl.style.display = 'block';
      foldersEmptyEl.innerHTML = '<strong>Could not load folders</strong><span>' + message + '</span>';
    }
    if (packGoalsEmptyEl) {
      packGoalsEmptyEl.style.display = 'block';
      packGoalsEmptyEl.innerHTML = '<strong>Could not load study packs</strong><span>' + message + '</span>';
    }
  }

  function loadPlannerData() {
    if (!currentUser) return Promise.resolve();
    if (!progressSummaryCache) hydrateSummaryCache(currentUser.uid);
    applyOverview(progressSummaryCache);
    return Promise.all([
      authFetch('/api/study-folders'),
      authFetch('/api/study-packs'),
      authFetch('/api/study-progress'),
    ]).then(function (responses) {
      return Promise.all([
        responses[0].json().catch(function () { return {}; }),
        responses[1].json().catch(function () { return {}; }),
        responses[2].ok ? responses[2].json().catch(function () { return {}; }) : Promise.resolve({}),
      ]);
    }).then(function (payloads) {
      currentFolders = Array.isArray(payloads[0].folders) ? payloads[0].folders : [];
      currentPacks = Array.isArray(payloads[1].study_packs) ? payloads[1].study_packs : [];
      applyProgressPayload(payloads[2]);
      renderFolders();
      renderPackGoals();
    }).catch(function (error) {
      handleLoadFailure((error && error.message) ? error.message : 'Please try again.');
    });
  }

  function handleExternalProgressEvent(payload) {
    if (!currentUser || !payload || payload.source_id === PLAN_SYNC_SOURCE_ID) return;
    if (payload.user_id && payload.user_id !== currentUser.uid) return;
    if (payload.summary && typeof payload.summary === 'object') {
      progressSummaryCache = Object.assign({}, progressSummaryCache || {}, payload.summary);
      persistSummaryCache(currentUser.uid, progressSummaryCache);
      persistDashboardSnapshot(currentUser.uid, progressSummaryCache);
      applyOverview(progressSummaryCache);
      renderFolders();
      renderPackGoals();
    }
    if (payload.pack_update && payload.pack_update.pack_id) {
      currentPacks = updatePackCollectionGoal(currentPacks, payload.pack_update.pack_id, payload.pack_update.daily_card_goal);
      syncPackGoalControls(payload.pack_update.pack_id, payload.pack_update.daily_card_goal);
    }
  }

  if (progressUtils && typeof progressUtils.subscribeProgressEvent === 'function') {
    progressUtils.subscribeProgressEvent(handleExternalProgressEvent);
  }

  function persistOverallGoal(showValidationError) {
    if (!currentUser || goalSaveInFlight) return;
    var parsedGoal = parseGoalValue(goalInputEl ? goalInputEl.value : '');
    if (parsedGoal === null) {
      if (showValidationError) showToast('Use a goal between 1 and 500.', 'error');
      applyOverview(progressSummaryCache);
      return;
    }
    var currentGoal = clampGoalValue(progressSummaryCache && progressSummaryCache.daily_goal, DEFAULT_DAILY_GOAL);
    if (parsedGoal === currentGoal) {
      applyOverview(progressSummaryCache);
      return;
    }

    goalSaveInFlight = true;
    if (saveGoalBtn) saveGoalBtn.disabled = true;
    if (goalInputEl) goalInputEl.disabled = true;
    authFetch('/api/study-progress', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        daily_goal: parsedGoal,
        timezone: timezoneName || (Intl.DateTimeFormat().resolvedOptions().timeZone || ''),
      }),
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) throw new Error(body.error || 'Could not save goal');
        progressSummaryCache = Object.assign({}, progressSummaryCache || {}, { daily_goal: parsedGoal });
        if (progressUtils && typeof progressUtils.writeDailyGoalCache === 'function') {
          progressUtils.writeDailyGoalCache(currentUser.uid, parsedGoal);
        }
        persistSummaryCache(currentUser.uid, progressSummaryCache);
        persistDashboardSnapshot(currentUser.uid, progressSummaryCache);
        broadcastPlannerProgress(progressSummaryCache, { type: 'summary' });
        applyOverview(progressSummaryCache);
        showToast('Daily goal saved automatically.', 'success');
      });
    }).catch(function (error) {
      applyOverview(progressSummaryCache);
      showToast((error && error.message) ? error.message : 'Could not save goal.', 'error');
    }).finally(function () {
      goalSaveInFlight = false;
      if (saveGoalBtn) saveGoalBtn.disabled = false;
      if (goalInputEl) goalInputEl.disabled = false;
    });
  }

  function scheduleFolderExamDateSave(folderId, input, immediate) {
    if (!folderId || !input) return;
    var existing = folderSaveTimers.get(folderId);
    if (existing) {
      window.clearTimeout(existing);
      folderSaveTimers.delete(folderId);
    }
    if (immediate) {
      persistFolderExamDate(folderId, input, false);
      return;
    }
    var timer = window.setTimeout(function () {
      folderSaveTimers.delete(folderId);
      persistFolderExamDate(folderId, input, false);
    }, 650);
    folderSaveTimers.set(folderId, timer);
  }

  function persistFolderExamDate(folderId, input, showValidationError) {
    if (!currentUser || !folderId || !input || folderSaveInFlight.has(folderId)) return;
    var parsedDate = parseDateInput(input.value);
    if (parsedDate === null) {
      if (showValidationError) {
        showToast('Use a valid date: dd-mm-yyyy or yyyy-mm-dd.', 'error');
        input.focus();
      }
      return;
    }
    var savedValue = parseDateInput(input.dataset.savedExamDate || '');
    if ((savedValue || '') === (parsedDate || '')) {
      input.value = formatDisplayDate(parsedDate || '');
      return;
    }

    folderSaveInFlight.add(folderId);
    authFetch('/api/study-folders/' + encodeURIComponent(folderId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ exam_date: parsedDate || '' }),
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) throw new Error(body.error || 'Could not save exam date');
        Array.prototype.slice.call(document.querySelectorAll('.js-folder-date[data-folder-id="' + folderId + '"]')).forEach(function (node) {
          node.dataset.savedExamDate = parsedDate || '';
          node.value = formatDisplayDate(parsedDate || '');
        });
        currentFolders = currentFolders.map(function (folder) {
          if (String(folder.folder_id || '') !== folderId) return folder;
          return Object.assign({}, folder, { exam_date: parsedDate || '' });
        });
        renderFolders();
        renderPackGoals();
        showToast('Exam date saved.', 'success');
      });
    }).catch(function (error) {
      Array.prototype.slice.call(document.querySelectorAll('.js-folder-date[data-folder-id="' + folderId + '"]')).forEach(function (node) {
        node.value = formatDisplayDate(node.dataset.savedExamDate || '');
      });
      showToast((error && error.message) ? error.message : 'Could not save exam date.', 'error');
    }).finally(function () {
      folderSaveInFlight.delete(folderId);
    });
  }

  function findPackById(packId) {
    var safePackId = String(packId || '').trim();
    if (!safePackId) return null;
    return currentPacks.find(function (pack) {
      return String(pack.study_pack_id || '') === safePackId;
    }) || null;
  }

  function persistPackGoal(packId, showValidationError) {
    var safePackId = String(packId || '').trim();
    if (!safePackId || !currentUser || packGoalSaveInFlight.has(safePackId)) return;
    var inputs = getPackGoalInputs(safePackId);
    if (!inputs.length) return;

    var rawValue = String(readPackGoalDraftValue(safePackId) || '').trim();
    var parsedGoal = rawValue ? parseGoalValue(rawValue) : null;
    if (rawValue && parsedGoal === null) {
      if (showValidationError) showToast('Pack goals must be between 1 and 500.', 'error');
      syncPackGoalControls(safePackId, inputs[0].dataset.savedGoal || '');
      return;
    }
    var savedGoal = parseOptionalGoalValue(inputs[0].dataset.savedGoal || '');
    if (sameGoalValue(savedGoal, parsedGoal)) {
      syncPackGoalControls(safePackId, parsedGoal);
      return;
    }

    packGoalSaveInFlight.add(safePackId);
    setPackGoalInputsDisabled(safePackId, true);
    authFetch('/api/study-packs/' + encodeURIComponent(safePackId), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ daily_card_goal: parsedGoal === null ? null : parsedGoal }),
    }).then(function (response) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        if (!response.ok) throw new Error(body.error || 'Could not save pack goal');
        currentPacks = updatePackCollectionGoal(currentPacks, safePackId, parsedGoal);
        syncPackGoalControls(safePackId, parsedGoal);
        broadcastPlannerProgress(progressSummaryCache || {}, {
          type: 'pack-goal',
          pack_update: {
            pack_id: safePackId,
            daily_card_goal: parsedGoal === null ? null : parsedGoal
          }
        });
        showToast(parsedGoal === null ? 'Pack goal cleared automatically.' : 'Pack goal saved automatically.', 'success');
      });
    }).catch(function (error) {
      syncPackGoalControls(safePackId, savedGoal);
      showToast((error && error.message) ? error.message : 'Could not save pack goal.', 'error');
    }).finally(function () {
      packGoalSaveInFlight.delete(safePackId);
      setPackGoalInputsDisabled(safePackId, false);
    });
  }

  if (saveGoalBtn) {
    saveGoalBtn.addEventListener('click', function () {
      persistOverallGoal(true);
    });
  }
  if (goalInputEl) {
    goalInputEl.addEventListener('input', function () {
      scheduleOverallGoalAutosave(false, false);
    });
    goalInputEl.addEventListener('change', function () {
      scheduleOverallGoalAutosave(true, true);
    });
    goalInputEl.addEventListener('blur', function () {
      scheduleOverallGoalAutosave(true, true);
    });
    goalInputEl.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      scheduleOverallGoalAutosave(true, true);
    });
  }

  window.addEventListener('focus', function () {
    if (currentUser) loadPlannerData();
  });
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden && currentUser) loadPlannerData();
  });

  auth.onAuthStateChanged(function (user) {
    currentUser = user || null;
    currentToken = null;
    if (authClient && !user && typeof authClient.clearToken === 'function') {
      authClient.clearToken();
    }

    if (!user) {
      progressSummaryCache = null;
      timezoneName = normalizeTimezoneName(Intl.DateTimeFormat().resolvedOptions().timeZone || '') || '';
      currentFolders = [];
      currentPacks = [];
      remoteCardStates = {};
      packGoalDraftValues.clear();
      setAuthView(null);
      clearNode(foldersBodyEl);
      clearNode(foldersCardsEl);
      clearNode(packGoalsBodyEl);
      clearNode(packGoalsCardsEl);
      return;
    }

    setAuthView(user);
    hydrateSummaryCache(user.uid);
    applyOverview(progressSummaryCache);
    ensureToken(false).then(function (tokenValue) {
      currentToken = tokenValue;
      if (authClient && typeof authClient.setToken === 'function') {
        authClient.setToken(tokenValue);
      }
      return loadPlannerData();
    }).catch(function (error) {
      handleLoadFailure((error && error.message) ? error.message : 'Please try again.');
    });
  });
})();
