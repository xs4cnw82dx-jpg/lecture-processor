(function (global) {
  'use strict';

  var Utils = global.WorkoutUtils;
  var escapeHtml = global.LectureProcessorHtml.escapeHtml;
  var ux = global.LectureProcessorUx;
  var state = {
    user: null,
    authClient: null,
    data: null,
    activeSession: null,
    currentView: 'today',
    elapsedTimer: null,
    restTimer: null,
    restEndsAt: 0,
    saveTimer: null,
    wakeLock: null,
    db: null,
    dbName: '',
    sheetReturnFocus: null,
    syncInProgress: false,
  };

  var elements = {};

  function byId(id) { return document.getElementById(id); }
  function setHtml(element, content) { if (element) element.innerHTML = content; }
  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function nowIso() { return new Date().toISOString(); }
  function mondayIso() {
    var current = new Date();
    var offset = (current.getDay() + 6) % 7;
    current.setDate(current.getDate() - offset);
    return current.toISOString().slice(0, 10);
  }
  function formatDate(value, options) {
    if (!value) return '';
    var dateValue = new Date(String(value).slice(0, 10) + 'T12:00:00');
    return dateValue.toLocaleDateString(undefined, options || { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function formatNumber(value, digits) {
    return Number(value || 0).toLocaleString(undefined, { maximumFractionDigits: digits == null ? 1 : digits });
  }
  function getExercise(exerciseId) {
    return (state.data && state.data.exercises || []).find(function (item) { return item.id === exerciseId; }) || {};
  }
  function getRoutine(routineId) {
    return (state.data && state.data.routines || []).find(function (item) { return item.id === routineId; }) || null;
  }
  function toast(message) {
    elements.toast.textContent = String(message || '');
    elements.toast.classList.add('is-visible');
    global.clearTimeout(elements.toast._timer);
    elements.toast._timer = global.setTimeout(function () { elements.toast.classList.remove('is-visible'); }, 3000);
  }
  function setSync(message) { elements.syncPill.textContent = message; }

  function parseJson(response) {
    return response.json().catch(function () { return {}; }).then(function (payload) {
      if (!response.ok) {
        var error = new Error(payload.error || 'Request failed');
        error.status = response.status;
        error.payload = payload;
        throw error;
      }
      return payload;
    });
  }

  function api(url, options) {
    var requestOptions = Object.assign({}, options || {});
    if (requestOptions.body && typeof requestOptions.body !== 'string') requestOptions.body = JSON.stringify(requestOptions.body);
    return state.authClient.authFetch(url, requestOptions, { ensureJsonContentType: true }).then(parseJson);
  }

  function openDatabase(uid) {
    state.dbName = 'lecture-processor-workout-' + String(uid || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    return new Promise(function (resolve, reject) {
      var request = indexedDB.open(state.dbName, 1);
      request.onupgradeneeded = function () {
        var db = request.result;
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('mutations')) db.createObjectStore('mutations', { keyPath: 'key' });
      };
      request.onsuccess = function () { state.db = request.result; resolve(state.db); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function idbRequest(storeName, mode, operation) {
    if (!state.db) return Promise.resolve(null);
    return new Promise(function (resolve, reject) {
      var transaction = state.db.transaction(storeName, mode);
      var request = operation(transaction.objectStore(storeName));
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }
  function saveDraft(session) {
    if (!session || !state.user) return Promise.resolve();
    return idbRequest('drafts', 'readwrite', function (store) {
      return store.put({ id: 'active', uid: state.user.uid, updated_at: Date.now(), session: clone(session) });
    }).catch(function () {});
  }
  function loadDraft() { return idbRequest('drafts', 'readonly', function (store) { return store.get('active'); }); }
  function clearDraft() { return idbRequest('drafts', 'readwrite', function (store) { return store.delete('active'); }).catch(function () {}); }
  function queueMutation(key, method, url, body) {
    return idbRequest('mutations', 'readwrite', function (store) {
      return store.put({ key: key, method: method, url: url, body: clone(body || {}), created_at: Date.now() });
    });
  }
  function listMutations() { return idbRequest('mutations', 'readonly', function (store) { return store.getAll(); }).then(function (items) { return (items || []).sort(function (a, b) { return a.created_at - b.created_at; }); }); }
  function removeMutation(key) { return idbRequest('mutations', 'readwrite', function (store) { return store.delete(key); }); }

  function flushMutations() {
    if (!navigator.onLine || state.syncInProgress || !state.authClient) return Promise.resolve();
    state.syncInProgress = true;
    setSync('Syncing');
    return listMutations().then(function (items) {
      return items.reduce(function (promise, item) {
        return promise.then(function () {
          return api(item.url, { method: item.method, body: item.body }).then(function (payload) {
            if (payload.session && state.activeSession && payload.session.id === state.activeSession.id) state.activeSession = payload.session;
            return removeMutation(item.key);
          });
        });
      }, Promise.resolve());
    }).then(function () {
      setSync('Synced');
    }).catch(function (error) {
      setSync(error.status === 409 ? 'Conflict' : 'Queued');
      if (error.status === 409) toast('This workout changed in another tab. Reload before continuing.');
    }).finally(function () { state.syncInProgress = false; });
  }

  function enhanceSelects(root) {
    if (!ux || typeof ux.enhanceNativeSelect !== 'function') return;
    Array.prototype.slice.call((root || document).querySelectorAll('select:not([multiple])')).forEach(function (select) {
      ux.enhanceNativeSelect(select);
    });
  }

  function showView(viewName) {
    state.currentView = viewName;
    document.querySelectorAll('[data-workout-view]').forEach(function (view) {
      var active = view.dataset.workoutView === viewName;
      view.hidden = !active;
      view.classList.toggle('is-active', active);
    });
    document.querySelectorAll('[data-workout-nav]').forEach(function (button) {
      var active = button.dataset.workoutNav === viewName;
      button.classList.toggle('is-active', active);
      if (button.tagName === 'BUTTON') button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    global.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function activeWeek() {
    var cycle = state.data && state.data.active_cycle;
    if (!cycle) return 0;
    var start = new Date(cycle.start_monday + 'T12:00:00');
    var today = new Date();
    var week = Math.floor((today - start) / 604800000) + 1;
    return Math.max(1, Math.min(10, week));
  }

  function renderToday() {
    var week = activeWeek();
    var cycle = state.data.active_cycle;
    elements.weekRing.querySelector('strong').textContent = week || '–';
    elements.cycleLabel.textContent = cycle ? (cycle.name || '10-week program') : '10-week program';
    elements.greeting.textContent = cycle ? ('Week ' + week + ' · ' + (week <= 4 ? 'Build' : (week === 5 ? 'Semi-deload' : 'Novelty'))) : 'Set up your program';
    elements.weekCopy.textContent = cycle ? 'A/B/C build adherence. Day D stays optional and recovery-led.' : 'Choose a start Monday and your exact Excel plan will be scheduled.';
    elements.resumeCard.hidden = !state.activeSession;
    if (state.activeSession) elements.resumeCopy.textContent = state.activeSession.name + ' · ' + Utils.formatDuration(state.activeSession.elapsed_seconds || 0);
    var occurrences = (state.data.occurrences || []).filter(function (item) { return Number(item.week) === week; });
    if (!cycle) {
      setHtml(elements.schedule, '<button class="workout-primary-btn" type="button" data-open-cycle>Set up 10-week calendar</button>');
      return;
    }
    var today = new Date().toISOString().slice(0, 10);
    var next = occurrences.filter(function (item) { return item.status === 'planned' && item.date >= today; })[0] || occurrences.find(function (item) { return item.status === 'planned'; });
    setHtml(elements.schedule, occurrences.map(function (item) {
      var status = item.status === 'completed' ? '<span class="workout-status-chip">Done</span>' : '<button class="workout-start-btn" type="button" data-start-occurrence="' + escapeHtml(item.id) + '">Start</button>';
      return '<article class="workout-schedule-card ' + (next && next.id === item.id ? 'is-next ' : '') + (item.status === 'completed' ? 'is-completed' : '') + '">' +
        '<div class="workout-schedule-main"><div class="workout-day-badge"><strong>' + escapeHtml(item.day) + '</strong><span>' + escapeHtml(formatDate(item.date, { weekday: 'short' })) + '</span></div>' +
        '<div class="workout-schedule-copy"><strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml(formatDate(item.date)) + ' · ' + item.exercises.length + ' exercises · ' + escapeHtml(item.phase) + '</small></div>' + status + '</div>' +
        (item.optional ? '<span class="workout-optional-label">Optional recovery-led day</span>' : '') + '</article>';
    }).join(''));
  }

  function routineExerciseNames(routine) {
    return (routine.exercises || []).map(function (item) { return getExercise(item.exercise_id).name || item.exercise_id; }).join(', ');
  }

  function renderRoutines() {
    var query = String(elements.routineSearch.value || '').trim().toLowerCase();
    var routines = (state.data.routines || []).filter(function (item) { return !item.archived && (!query || (item.name + ' ' + routineExerciseNames(item)).toLowerCase().indexOf(query) >= 0); });
    setHtml(elements.routineList, routines.map(function (routine) {
      return '<article class="workout-routine-card"><div class="workout-routine-head"><div><h3>' + escapeHtml(routine.name) + '</h3><p>' + escapeHtml(routineExerciseNames(routine)) + '</p></div>' +
        '<button class="workout-menu-btn" type="button" data-routine-menu="' + escapeHtml(routine.id) + '" aria-label="Routine options"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg></button></div>' +
        '<div class="workout-routine-actions"><button class="workout-start-btn" type="button" data-start-routine="' + escapeHtml(routine.id) + '">Start routine</button><button class="workout-share-btn" type="button" data-share-routine="' + escapeHtml(routine.id) + '" aria-label="Share routine"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><path d="m8.6 13.5 6.8 4M15.4 6.5l-6.8 4"></path></svg></button></div></article>';
    }).join('') || '<div class="workout-empty-state">No routines match your search.</div>');
    var activeExercises = (state.data.exercises || []).filter(function (item) { return !item.archived; });
    var custom = activeExercises.filter(function (item) { return !item.seeded; }).length;
    elements.librarySummary.textContent = activeExercises.length + ' exercises available · ' + custom + ' custom. The seeded library contains only exercises from your Excel program.';
  }

  function renderProgress() {
    var stats = state.data.statistics || { summary: {}, weekly: {}, records: {}, bodyweight: [] };
    var summary = stats.summary || {};
    var durationHours = Number(summary.total_duration_seconds || 0) / 3600;
    setHtml(elements.kpis, [
      ['Adherence', formatNumber(summary.adherence_percent || 0, 1) + '%', 'Required A/B/C'],
      ['Workouts', summary.completed_workouts || 0, (summary.optional_d_completed || 0) + ' optional D'],
      ['Volume', formatNumber((summary.total_volume_kg || 0) / 1000, 1) + 't', 'Equipment-aware'],
      ['Training time', formatNumber(durationHours, 1) + 'h', 'Completed sessions'],
    ].map(function (item) { return '<article class="workout-kpi"><span>' + escapeHtml(item[0]) + '</span><strong>' + escapeHtml(item[1]) + '</strong><small>' + escapeHtml(item[2]) + '</small></article>'; }).join(''));
    var weeks = Object.keys(stats.weekly || {}).sort(function (a, b) { return Number(a) - Number(b); });
    setHtml(elements.weeklyBars, weeks.map(function (week) {
      var item = stats.weekly[week];
      return '<div class="workout-bar-row"><span>W' + escapeHtml(week) + '</span><progress max="' + Math.max(1, Number(item.target_sets || 0)) + '" value="' + Number(item.completed_sets || 0) + '"></progress><strong>' + Number(item.completed_sets || 0) + '/' + Number(item.target_sets || 0) + '</strong></div>';
    }).join('') || '<div class="workout-empty-state">Complete a workout to see weekly progress.</div>');
    var currentWeek = activeWeek() || 1;
    var currentMuscles = (stats.weekly && stats.weekly[String(currentWeek)] && stats.weekly[String(currentWeek)].muscles) || {};
    setHtml(elements.muscleBars, (stats.muscle_targets || []).map(function (target) {
      var planned = Number((target.weekly_sets || [])[currentWeek - 1] || 0);
      var done = Number(currentMuscles[target.muscle_group] || 0);
      return '<div class="workout-bar-row"><span>' + escapeHtml(String(target.muscle_group || '').replace('/Glutes', '').slice(0, 5)) + '</span><progress max="' + Math.max(1, planned) + '" value="' + done + '"></progress><strong>' + done + '/' + planned + '</strong></div>';
    }).join(''));
    var historyMap = stats.exercise_history || {};
    var historyIds = Object.keys(historyMap).filter(function (key) { return historyMap[key] && historyMap[key].length; });
    var selectedTrend = elements.trendSelect.value || historyIds[0] || '';
    setHtml(elements.trendSelect, historyIds.map(function (key) { var name = historyMap[key][0].name || key; return '<option value="' + escapeHtml(key) + '"' + (key === selectedTrend ? ' selected' : '') + '>' + escapeHtml(name) + '</option>'; }).join(''));
    if (elements.trendSelect._appSelectInstance) elements.trendSelect._appSelectInstance.rebuild({ value: selectedTrend }); else enhanceSelects(elements.trendSelect.parentElement);
    renderExerciseChart(historyMap[elements.trendSelect.value] || []);
    renderWeightChart(stats.bodyweight || []);
    var records = Object.keys(stats.records || {}).map(function (key) { return stats.records[key]; }).sort(function (a, b) { return Number(b.estimated_1rm || 0) - Number(a.estimated_1rm || 0); });
    setHtml(elements.recordList, records.slice(0, 12).map(function (item) {
      return '<div class="workout-record-row"><div><strong>' + escapeHtml(item.name || 'Exercise') + '</strong><small>' + formatNumber(item.heaviest_kg, 1) + ' kg · ' + Number(item.most_reps || 0) + ' reps</small></div><span>' + formatNumber(item.estimated_1rm, 1) + ' kg<br>e1RM</span></div>';
    }).join('') || '<div class="workout-empty-state">Your PRs will appear after completed workouts.</div>');
    var history = state.data.history || [];
    elements.historyCount.textContent = history.length + ' workout' + (history.length === 1 ? '' : 's');
    setHtml(elements.historyList, history.map(function (session) {
      return '<article class="workout-history-card"><div><strong>' + escapeHtml(session.name) + '</strong><small>' + escapeHtml(formatDate(session.date)) + ' · ' + Utils.formatDuration(session.elapsed_seconds) + ' · ' + formatNumber(session.volume_kg, 0) + ' kg</small></div><button type="button" data-share-workout="' + escapeHtml(session.id) + '">Share</button></article>';
    }).join('') || '<div class="workout-empty-state">Completed workouts will stay here across cycle resets.</div>');
  }

  function renderWeightChart(entries) {
    if (!entries.length) { setHtml(elements.weightChart, '<div class="workout-weight-empty">No bodyweight entries yet.</div>'); return; }
    var values = entries.slice(-16).map(function (item) { return Number(item.weight_kg || 0); });
    var min = Math.min.apply(Math, values) - 1;
    var max = Math.max.apply(Math, values) + 1;
    var range = Math.max(1, max - min);
    var points = values.map(function (value, index) {
      var x = values.length === 1 ? 50 : (index / (values.length - 1) * 100);
      var y = 90 - ((value - min) / range * 75);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    setHtml(elements.weightChart, '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Bodyweight trend"><polyline points="' + points + '" fill="none" stroke="#4f46e5" stroke-width="3" vector-effect="non-scaling-stroke"></polyline></svg>');
  }

  function renderExerciseChart(entries) {
    if (!entries.length) { setHtml(elements.exerciseChart, '<div class="workout-weight-empty">Complete repeated exercises to see a trend.</div>'); return; }
    var values = entries.slice(-16).map(function (item) { return Number(item.estimated_1rm || item.best_weight || 0); });
    var min = Math.min.apply(Math, values) - 1;
    var max = Math.max.apply(Math, values) + 1;
    var range = Math.max(1, max - min);
    var points = values.map(function (value, index) { var x = values.length === 1 ? 50 : index / (values.length - 1) * 100; var y = 90 - ((value - min) / range * 75); return x.toFixed(1) + ',' + y.toFixed(1); }).join(' ');
    setHtml(elements.exerciseChart, '<svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Estimated one rep max trend"><polyline points="' + points + '" fill="none" stroke="#4f46e5" stroke-width="3" vector-effect="non-scaling-stroke"></polyline></svg>');
  }

  function renderSettings() {
    var profile = state.data.profile || {};
    var settings = profile.settings || {};
    byId('workout-default-rest').value = String(settings.default_rest_seconds == null ? 150 : settings.default_rest_seconds);
    byId('workout-previous-scope').value = settings.previous_values_scope || 'same_routine';
    byId('workout-rpe-toggle').checked = settings.rpe_enabled !== false;
    byId('workout-warmup-stats-toggle').checked = !!settings.warmup_sets_in_statistics;
    byId('workout-superset-toggle').checked = settings.smart_superset_scrolling !== false;
    byId('workout-wake-toggle').checked = settings.keep_awake !== false;
    byId('workout-pr-toggle').checked = settings.live_pr_notifications !== false;
    byId('workout-sound-toggle').checked = settings.timer_sound !== false;
    byId('workout-volume').value = settings.timer_volume == null ? .75 : settings.timer_volume;
    byId('workout-volume-output').textContent = Math.round(Number(byId('workout-volume').value) * 100) + '%';
    byId('workout-notification-toggle').checked = !!settings.rest_notifications;
    byId('workout-profile-weight').value = profile.bodyweight_kg || '';
    byId('workout-handle-weight').value = profile.handle_weight_kg || 0;
    byId('workout-optional-toggle').checked = profile.optional_day_enabled !== false;
    var warmupSteps = settings.warmup_steps || state.data.seed.warmup_defaults || [];
    for (var stepIndex = 0; stepIndex < 3; stepIndex += 1) {
      var step = warmupSteps[stepIndex] || state.data.seed.warmup_defaults[stepIndex] || { percent: 50, reps: 5 };
      byId('workout-warmup-percent-' + (stepIndex + 1)).value = step.percent;
      byId('workout-warmup-reps-' + (stepIndex + 1)).value = step.reps;
    }
    enhanceSelects(elements.settingsForm);
    ['workout-default-rest', 'workout-previous-scope'].forEach(function (id) { var select = byId(id); if (select._appSelectInstance) select._appSelectInstance.sync(); });
  }

  function renderAll() {
    renderToday();
    renderRoutines();
    renderProgress();
    renderSettings();
    if (state.activeSession) renderLogger();
  }

  function sessionExerciseHtml(exercise, exerciseIndex) {
    var progression = Utils.progression(exercise, state.activeSession.phase);
    var previous = exercise.previous_sets || (state.data.previous_values || {})[exercise.exercise_id] || [];
    var isDuration = exercise.tracking_type === 'duration';
    var showKg = !isDuration && exercise.tracking_type !== 'bodyweight';
    var showRpe = state.data.profile.settings.rpe_enabled !== false && !isDuration;
    var rows = (exercise.sets || []).map(function (setItem, setIndex) {
      var previousSet = previous[setIndex] || {};
      var typeOptions = ['normal', 'warmup', 'drop', 'failure'].map(function (type) { return '<option value="' + type + '"' + (setItem.type === type ? ' selected' : '') + '>' + type.charAt(0).toUpperCase() + type.slice(1) + '</option>'; }).join('');
      var valueCells = isDuration
        ? '<td colspan="3"><input class="workout-set-input" type="number" min="0" max="86400" inputmode="numeric" aria-label="Duration seconds" value="' + Number(setItem.duration_seconds || 0) + '" data-set-field="duration_seconds" data-exercise-index="' + exerciseIndex + '" data-set-index="' + setIndex + '"><span class="workout-set-previous">seconds</span></td>'
        : '<td>' + (showKg ? '<input class="workout-set-input" type="number" min="0" max="500" step="0.5" inputmode="decimal" aria-label="Weight kilograms" value="' + Number(setItem.kg || 0) + '" data-set-field="kg" data-exercise-index="' + exerciseIndex + '" data-set-index="' + setIndex + '" data-load-type="' + escapeHtml(exercise.load_type || '') + '">' : '<strong>BW</strong>') + '<span class="workout-set-previous">' + (previousSet.kg != null ? escapeHtml(Utils.formatWeight(previousSet.kg)) + ' kg' : '–') + '</span></td>' +
          '<td><input class="workout-set-input" type="number" min="0" max="1000" inputmode="numeric" aria-label="Repetitions" value="' + Number(setItem.reps || 0) + '" data-set-field="reps" data-exercise-index="' + exerciseIndex + '" data-set-index="' + setIndex + '"><span class="workout-set-previous">' + (previousSet.reps != null ? previousSet.reps + ' reps' : '–') + '</span></td>' +
          '<td>' + (showRpe ? '<input class="workout-set-input" type="number" min="0" max="10" step="0.5" inputmode="decimal" aria-label="RPE" value="' + Number(setItem.rpe || 0) + '" data-set-field="rpe" data-exercise-index="' + exerciseIndex + '" data-set-index="' + setIndex + '">' : '<span>–</span>') + '<span class="workout-set-previous">target ' + (setIndex === exercise.sets.length - 1 ? Number(exercise.last_rpe || 0) : Number(exercise.early_rpe || 0)) + '</span></td>';
      return '<tr class="' + (setItem.completed ? 'is-complete' : '') + '"><td><select class="workout-set-type" aria-label="Set type" data-set-field="type" data-exercise-index="' + exerciseIndex + '" data-set-index="' + setIndex + '">' + typeOptions + '</select></td>' + valueCells + '<td><button class="workout-complete-set ' + (setItem.completed ? 'is-complete' : '') + '" type="button" data-complete-set="1" data-exercise-index="' + exerciseIndex + '" data-set-index="' + setIndex + '" aria-label="' + (setItem.completed ? 'Uncomplete' : 'Complete') + ' set"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg></button></td></tr>';
    }).join('');
    return '<article class="workout-exercise-card" data-exercise-card="' + exerciseIndex + '"><header class="workout-exercise-head"><div><h2>' + escapeHtml(exercise.exercise_name) + '</h2><p>' + escapeHtml(exercise.muscle_group || 'Custom') + ' · ' + escapeHtml(exercise.target_sets + ' × ' + exercise.rep_min + '–' + exercise.rep_max) + (exercise.superset_id ? ' · Superset' : '') + '</p></div><button class="workout-menu-btn" type="button" data-exercise-menu="' + exerciseIndex + '" aria-label="Exercise options"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1"></circle><circle cx="12" cy="12" r="1"></circle><circle cx="12" cy="19" r="1"></circle></svg></button></header>' +
      (exercise.technique || exercise.cues ? '<div class="workout-exercise-cues"><strong>' + escapeHtml(exercise.technique || 'Technique') + '</strong><br>' + escapeHtml(exercise.cues || '') + '</div>' : '') +
      '<div class="workout-exercise-tools"><button class="workout-chip-btn is-accent" type="button" data-rest-picker="' + exerciseIndex + '">Rest ' + escapeHtml(Utils.formatDuration(exercise.rest_seconds || 0)) + '</button>' + (showKg ? '<button class="workout-chip-btn" type="button" data-warmup="' + exerciseIndex + '">Warm-up</button>' : '') + '<button class="workout-chip-btn" type="button" data-load-guide="' + exerciseIndex + '">Load guide</button></div>' +
      '<textarea class="workout-notes-input" rows="1" maxlength="2000" placeholder="Private notes…" data-exercise-notes="' + exerciseIndex + '">' + escapeHtml(exercise.notes || '') + '</textarea>' +
      '<table class="workout-set-table"><thead><tr><th>Set</th>' + (isDuration ? '<th colspan="3">Duration</th>' : '<th>kg</th><th>Reps</th><th>RPE</th>') + '<th>✓</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<button class="workout-add-set" type="button" data-add-set="' + exerciseIndex + '">+ Add set</button>' +
      '<div class="workout-progress-advice"><span>Next action</span><strong>' + escapeHtml(progression.next_action) + '</strong></div></article>';
  }

  function renderLogger() {
    var session = state.activeSession;
    if (!session) { elements.logger.hidden = true; document.body.classList.remove('workout-logger-open'); return; }
    elements.loggerTitle.textContent = session.name || 'Workout';
    elements.loggerStatus.textContent = session.status === 'paused' ? 'Paused' : ((session.phase || 'Active') + (session.week ? ' · Week ' + session.week : ''));
    setHtml(elements.exerciseStack, (session.exercises || []).map(sessionExerciseHtml).join('') || '<div class="workout-empty-state">Add your first exercise below.</div>');
    enhanceSelects(elements.exerciseStack);
    updateMetrics();
    elements.pauseBtn.querySelector('span').textContent = session.status === 'paused' ? 'Paused' : 'Duration';
    if (!elements.logger.hidden) requestWakeLock();
  }

  function updateMetrics() {
    if (!state.activeSession) return;
    var metrics = Utils.sessionMetrics(state.activeSession, !!state.data.profile.settings.warmup_sets_in_statistics);
    elements.duration.textContent = Utils.formatDuration(state.activeSession.elapsed_seconds || 0);
    elements.volumeTotal.textContent = formatNumber(metrics.volume_kg, 0) + ' kg';
    elements.setCount.textContent = metrics.completed_sets;
  }

  function openLogger() {
    if (!state.activeSession) return;
    elements.logger.hidden = false;
    document.body.classList.add('workout-logger-open');
    renderLogger();
    startElapsedTimer();
    requestWakeLock();
  }
  function closeLogger() {
    elements.logger.hidden = true;
    document.body.classList.remove('workout-logger-open');
    releaseWakeLock();
    renderToday();
  }

  function startElapsedTimer() {
    global.clearInterval(state.elapsedTimer);
    state.elapsedTimer = global.setInterval(function () {
      if (!state.activeSession || state.activeSession.status !== 'active') return;
      state.activeSession.elapsed_seconds = Number(state.activeSession.elapsed_seconds || 0) + 1;
      updateMetrics();
      if (state.activeSession.elapsed_seconds % 5 === 0) scheduleSave();
    }, 1000);
  }

  function scheduleSave() {
    if (!state.activeSession || state.activeSession.status === 'completed') return;
    saveDraft(state.activeSession);
    global.clearTimeout(state.saveTimer);
    setSync(navigator.onLine ? 'Saving' : 'Queued');
    state.saveTimer = global.setTimeout(saveSessionNow, 700);
  }

  function saveSessionNow() {
    if (!state.activeSession || state.activeSession.status === 'completed') return Promise.resolve();
    var session = clone(state.activeSession);
    var body = { base_revision: Number(session.revision || 0), name: session.name, notes: session.notes, elapsed_seconds: session.elapsed_seconds, status: session.status, exercises: session.exercises };
    if (!navigator.onLine) {
      return queueMutation('session:' + session.id, 'PATCH', '/api/admin/workout/sessions/' + encodeURIComponent(session.id), body).then(function () { setSync('Queued'); });
    }
    return api('/api/admin/workout/sessions/' + encodeURIComponent(session.id), { method: 'PATCH', body: body }).then(function (payload) {
      if (state.activeSession && state.activeSession.id === payload.session.id) state.activeSession.revision = payload.session.revision;
      setSync('Synced');
      return removeMutation('session:' + session.id);
    }).catch(function (error) {
      if (!navigator.onLine || !error.status) return queueMutation('session:' + session.id, 'PATCH', '/api/admin/workout/sessions/' + encodeURIComponent(session.id), body).then(function () { setSync('Queued'); });
      if (error.status === 409) { setSync('Conflict'); toast('Workout changed in another tab. Reload to resolve it.'); return; }
      setSync('Save failed'); toast(error.message);
    });
  }

  function requestWakeLock() {
    if (!state.activeSession || elements.logger.hidden || !state.data.profile.settings.keep_awake || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (lock) { state.wakeLock = lock; lock.addEventListener('release', function () { state.wakeLock = null; }); }).catch(function () {});
  }
  function releaseWakeLock() { if (state.wakeLock) state.wakeLock.release().catch(function () {}); state.wakeLock = null; }

  function startRestTimer(seconds) {
    var duration = Math.max(0, Number(seconds || 0));
    if (!duration) return;
    state.restEndsAt = Date.now() + duration * 1000;
    elements.restDrawer.hidden = false;
    global.clearInterval(state.restTimer);
    updateRestTimer();
    state.restTimer = global.setInterval(updateRestTimer, 250);
  }
  function updateRestTimer() {
    var remaining = Math.max(0, Math.ceil((state.restEndsAt - Date.now()) / 1000));
    elements.restTime.textContent = Utils.formatDuration(remaining);
    if (!remaining) finishRestTimer();
  }
  function finishRestTimer() {
    global.clearInterval(state.restTimer);
    elements.restDrawer.hidden = true;
    playTimerSound();
    var settings = state.data.profile.settings || {};
    if (settings.rest_notifications && global.Notification && Notification.permission === 'granted') {
      try { new Notification('Rest complete', { body: 'Your next set is ready.', tag: 'workout-rest' }); } catch (_error) {}
    }
  }
  function playTimerSound() {
    var settings = state.data.profile.settings || {};
    if (!settings.timer_sound) return;
    try {
      var AudioContext = global.AudioContext || global.webkitAudioContext;
      var context = new AudioContext();
      var oscillator = context.createOscillator();
      var gain = context.createGain();
      oscillator.frequency.value = 880;
      gain.gain.value = Number(settings.timer_volume == null ? .75 : settings.timer_volume) * .15;
      oscillator.connect(gain); gain.connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + .22);
    } catch (_error) {}
  }

  function openSheet(title, eyebrow, content, onReady) {
    state.sheetReturnFocus = document.activeElement;
    byId('workout-sheet-title').textContent = title;
    byId('workout-sheet-eyebrow').textContent = eyebrow || 'Workout';
    setHtml(elements.sheetContent, content);
    elements.sheetOverlay.hidden = false;
    elements.sheetOverlay.setAttribute('aria-hidden', 'false');
    enhanceSelects(elements.sheetContent);
    if (typeof onReady === 'function') onReady(elements.sheetContent);
    var focusable = elements.sheetContent.querySelector('input,button,select,textarea');
    if (focusable) focusable.focus();
  }
  function closeSheet() {
    elements.sheetOverlay.hidden = true;
    elements.sheetOverlay.setAttribute('aria-hidden', 'true');
    setHtml(elements.sheetContent, '');
    if (state.sheetReturnFocus && document.contains(state.sheetReturnFocus)) state.sheetReturnFocus.focus();
  }

  function cycleSheet() {
    var profile = state.data.profile || {};
    var trainingDays = profile.training_days || { A: 1, B: 3, C: 5, D: 6 };
    var weekdayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
    function weekdayField(dayCode) {
      var options = weekdayNames.map(function (name, index) { var value = index + 1; return '<option value="' + value + '"' + (Number(trainingDays[dayCode]) === value ? ' selected' : '') + '>' + escapeHtml(name) + '</option>'; }).join('');
      return '<label class="workout-sheet-field">Day ' + dayCode + '<select id="workout-cycle-day-' + dayCode.toLowerCase() + '">' + options + '</select></label>';
    }
    var tests = state.data.seed.start_tests || [];
    var stored = {};
    (profile.start_tests || []).forEach(function (item) { stored[item.exercise_id] = item; });
    var content = '<form class="workout-sheet-form" id="workout-cycle-form"><p class="workout-sheet-help">Starting or resetting archives the current cycle while preserving all completed workout history. The workbook remains the baseline source.</p>' +
      '<label class="workout-sheet-field">Start Monday<input type="date" id="workout-cycle-start" required value="' + escapeHtml(state.data.active_cycle ? state.data.active_cycle.start_monday : mondayIso()) + '"></label>' +
      '<div class="workout-sheet-row">' + weekdayField('A') + weekdayField('B') + '</div><div class="workout-sheet-row">' + weekdayField('C') + weekdayField('D') + '</div>' +
      '<div class="workout-sheet-row"><label class="workout-sheet-field">Bodyweight (kg)<input type="number" id="workout-cycle-weight" min="20" max="400" step="0.1" inputmode="decimal" value="' + Number(profile.bodyweight_kg || 62.5) + '"></label><label class="workout-sheet-field">Handle weight (kg)<input type="number" id="workout-cycle-handle" min="0" max="10" step="0.1" inputmode="decimal" value="' + Number(profile.handle_weight_kg || 0) + '"></label></div>' +
      '<label class="workout-toggle-row"><span><strong>Include optional D</strong><small>Saturday by default; excluded from adherence</small></span><input id="workout-cycle-optional" type="checkbox" role="switch"' + (profile.optional_day_enabled !== false ? ' checked' : '') + '></label>' +
      '<label class="workout-toggle-row"><span><strong>Restore Excel baseline</strong><small>Ignore routine edits for the new cycle</small></span><input id="workout-cycle-baseline" type="checkbox" role="switch"></label>' +
      '<details><summary>Start tests (optional)</summary><div class="workout-start-test-list">' + tests.map(function (test) { var saved = stored[test.exercise_id] || {}; var savedReps = saved.test_reps == null ? '' : saved.test_reps; return '<div class="workout-start-test" data-start-test="' + escapeHtml(test.exercise_id) + '"><strong>' + escapeHtml(test.exercise_name) + '</strong><div class="workout-start-test-grid"><label>Test kg<input type="number" inputmode="decimal" step="0.5" data-test-kg value="' + Number(saved.test_kg == null ? test.test_kg : saved.test_kg) + '"></label><label>Test reps<input type="number" inputmode="numeric" data-test-reps value="' + escapeHtml(savedReps) + '"></label></div></div>'; }).join('') + '</div></details>' +
      '<button class="workout-primary-btn" type="submit">' + (state.data.active_cycle ? 'Archive & start new cycle' : 'Start 10-week program') + '</button></form>';
    openSheet(state.data.active_cycle ? 'Reset calendar' : 'Set up program', '10-week cycle', content, function (root) {
      byId('workout-cycle-form').addEventListener('submit', function (event) {
        event.preventDefault();
        var startMonday = byId('workout-cycle-start').value;
        var profileBody = { base_revision: Number(state.data.profile.revision || 0), bodyweight_kg: Number(byId('workout-cycle-weight').value), handle_weight_kg: Number(byId('workout-cycle-handle').value), optional_day_enabled: byId('workout-cycle-optional').checked, setup_completed: true, training_days: { A: Number(byId('workout-cycle-day-a').value), B: Number(byId('workout-cycle-day-b').value), C: Number(byId('workout-cycle-day-c').value), D: Number(byId('workout-cycle-day-d').value) } };
        setSync('Saving');
        api('/api/admin/workout/profile', { method: 'PUT', body: profileBody }).then(function (profilePayload) {
          state.data.profile = profilePayload.profile;
          var testPayload = Array.prototype.slice.call(root.querySelectorAll('[data-start-test]')).map(function (row) { var repsValue = row.querySelector('[data-test-reps]').value; return { exercise_id: row.dataset.startTest, test_kg: Number(row.querySelector('[data-test-kg]').value), test_reps: repsValue === '' ? null : Number(repsValue) }; });
          return api('/api/admin/workout/start-tests', { method: 'PUT', body: { base_revision: Number(state.data.profile.revision || 0), tests: testPayload } });
        }).then(function (testResult) {
          state.data.profile = testResult.profile;
          return api('/api/admin/workout/cycles', { method: 'POST', body: { start_monday: startMonday, restore_excel_baseline: byId('workout-cycle-baseline').checked } });
        }).then(function (payload) {
          state.data.active_cycle = payload.cycle; state.data.occurrences = payload.occurrences; state.data.profile = payload.profile; closeSheet(); renderAll(); setSync('Synced'); toast('10-week calendar ready.');
        }).catch(function (error) { setSync('Error'); toast(error.message); });
      });
    });
  }

  function startSession(body) {
    setSync('Starting');
    return api('/api/admin/workout/sessions', { method: 'POST', body: body || {} }).then(function (payload) {
      state.activeSession = payload.session; state.data.active_session = payload.session;
      saveDraft(state.activeSession); renderAll(); openLogger(); setSync('Synced');
    }).catch(function (error) { setSync('Error'); toast(error.message); });
  }

  function exercisePicker(onPick, title) {
    var exercises = (state.data.exercises || []).filter(function (item) { return !item.archived; });
    var content = '<label class="workout-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg><input type="search" id="workout-exercise-search" placeholder="Search exercise"></label><div class="workout-exercise-picker" id="workout-exercise-picker">' + exerciseOptions(exercises) + '</div>';
    openSheet(title || 'Add exercise', 'Exercise library', content, function () {
      var input = byId('workout-exercise-search');
      input.addEventListener('input', function () {
        var query = input.value.trim().toLowerCase();
        setHtml(byId('workout-exercise-picker'), exerciseOptions(exercises.filter(function (item) { return (item.name + ' ' + item.muscle_group).toLowerCase().indexOf(query) >= 0; })));
      });
      byId('workout-exercise-picker').addEventListener('click', function (event) {
        var button = event.target.closest('[data-pick-exercise]');
        if (!button) return;
        var exercise = getExercise(button.dataset.pickExercise);
        closeSheet(); onPick(exercise);
      });
    });
  }
  function exerciseOptions(exercises) {
    return exercises.map(function (item) { return '<button class="workout-exercise-option" type="button" data-pick-exercise="' + escapeHtml(item.id) + '"><span><strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml((item.muscle_group || 'Custom') + ' · ' + (item.equipment || item.load_type || item.tracking_type)) + '</small></span><span>Add</span></button>'; }).join('') || '<div class="workout-empty-state">No matching exercises.</div>';
  }
  function newSessionExercise(exercise) {
    var setCount = 3;
    return { exercise_id: exercise.id, exercise_name: exercise.name, tracking_type: exercise.tracking_type, load_type: exercise.load_type, muscle_group: exercise.muscle_group, pair_multiplier: exercise.pair_multiplier || 1, bodyweight_contributes: !!exercise.bodyweight_contributes, target_sets: setCount, rep_min: 8, rep_max: 12, early_rpe: 8, last_rpe: 9, rest_seconds: exercise.default_rest_seconds || state.data.profile.settings.default_rest_seconds || 150, rest_range: '', technique: exercise.technique || '', cues: exercise.cues || '', notes: '', superset_id: '', previous_sets: (state.data.previous_values || {})[exercise.id] || [], sets: Array.from({ length: setCount }, function (_, index) { return { id: 'set-' + (index + 1), type: 'normal', kg: 0, reps: 0, rpe: index === setCount - 1 ? 9 : 8, duration_seconds: 0, completed: false, completed_at: '' }; }) };
  }

  function exerciseMenu(index) {
    var exercise = state.activeSession.exercises[index];
    var content = '<div class="workout-sheet-list"><button class="workout-sheet-action" type="button" data-exercise-action="up">Move earlier<span>↑</span></button><button class="workout-sheet-action" type="button" data-exercise-action="down">Move later<span>↓</span></button><button class="workout-sheet-action" type="button" data-exercise-action="replace">Replace exercise<span>↻</span></button><button class="workout-sheet-action" type="button" data-exercise-action="superset">Pair with next exercise<span>＋</span></button><button class="workout-sheet-action is-danger" type="button" data-exercise-action="remove">Remove exercise<span>×</span></button></div>';
    openSheet(exercise.exercise_name, 'Exercise options', content, function (root) {
      root.addEventListener('click', function (event) {
        var button = event.target.closest('[data-exercise-action]'); if (!button) return;
        var action = button.dataset.exerciseAction;
        if (action === 'replace') { closeSheet(); exercisePicker(function (replacement) { var next = newSessionExercise(replacement); next.sets = exercise.sets; next.target_sets = exercise.target_sets; state.activeSession.exercises[index] = next; renderLogger(); scheduleSave(); }, 'Replace exercise'); return; }
        if (action === 'remove') state.activeSession.exercises.splice(index, 1);
        if (action === 'up' && index > 0) { var prior = state.activeSession.exercises[index - 1]; state.activeSession.exercises[index - 1] = exercise; state.activeSession.exercises[index] = prior; }
        if (action === 'down' && index < state.activeSession.exercises.length - 1) { var nextExercise = state.activeSession.exercises[index + 1]; state.activeSession.exercises[index + 1] = exercise; state.activeSession.exercises[index] = nextExercise; }
        if (action === 'superset' && index < state.activeSession.exercises.length - 1) { var supersetId = 'superset-' + Date.now(); exercise.superset_id = supersetId; state.activeSession.exercises[index + 1].superset_id = supersetId; }
        closeSheet(); renderLogger(); scheduleSave();
      });
    });
  }

  function restPicker(index) {
    var exercise = state.activeSession.exercises[index];
    var values = [0, 60, 90, 120, 150, 180, 210, 300];
    var options = values.map(function (value) { return '<option value="' + value + '"' + (Number(exercise.rest_seconds) === value ? ' selected' : '') + '>' + (value ? Utils.formatDuration(value) : 'Off') + '</option>'; }).join('');
    openSheet('Rest timer', exercise.exercise_name, '<form class="workout-sheet-form" id="workout-rest-form"><p class="workout-sheet-help">Workbook range: ' + escapeHtml(exercise.rest_range || 'Custom') + '. Midpoints map 1–2 → 1:30, 2–3 → 2:30, and 3–4 → 3:30.</p><label class="workout-sheet-field">Timer<select id="workout-rest-select">' + options + '</select></label><button class="workout-primary-btn" type="submit">Save timer</button></form>', function () {
      byId('workout-rest-form').addEventListener('submit', function (event) { event.preventDefault(); exercise.rest_seconds = Number(byId('workout-rest-select').value); closeSheet(); renderLogger(); scheduleSave(); });
    });
  }

  function warmupFor(index) {
    var exercise = state.activeSession.exercises[index];
    var workSet = (exercise.sets || []).find(function (item) { return item.type !== 'warmup'; }) || {};
    var loads = exercise.load_type === 'Backpack/BW' ? state.data.seed.available_loads.backpack_kg : state.data.seed.available_loads.dumbbell_per_hand_kg;
    var warmups = Utils.warmupSets(workSet.kg, loads, state.data.profile.settings.warmup_steps || state.data.seed.warmup_defaults);
    var created = warmups.map(function (item, idx) { return { id: 'warmup-' + Date.now() + '-' + idx, type: 'warmup', kg: item.kg, reps: item.reps, rpe: 0, duration_seconds: 0, completed: false, completed_at: '' }; });
    exercise.sets = created.concat(exercise.sets || []); renderLogger(); scheduleSave(); toast('Warm-up sets added and rounded down to available loads.');
  }

  function loadGuide(index) {
    var exercise = state.activeSession.exercises[index];
    var loads = exercise.load_type === 'Backpack/BW' ? state.data.seed.available_loads.backpack_kg : state.data.seed.available_loads.dumbbell_per_hand_kg;
    openSheet('Load guide', exercise.exercise_name, '<p class="workout-sheet-help">Available ' + escapeHtml(exercise.load_type || 'load') + ' values from the workbook. Dumbbell numbers are per hand. DB-pair volume is doubled; seeded weighted pull-up/chin-up volume also adds bodyweight.</p><div class="workout-library-summary">' + loads.map(function (value) { return escapeHtml(Utils.formatWeight(value)) + ' kg'; }).join(' · ') + '</div>');
  }

  function routineMenu(routineId) {
    var routine = getRoutine(routineId); if (!routine) return;
    var deleteLabel = routine.seeded ? 'Restore Excel baseline instead' : 'Archive routine';
    openSheet(routine.name, 'Routine options', '<div class="workout-sheet-list"><button class="workout-sheet-action" type="button" data-routine-action="share">Share routine<span>↗</span></button><button class="workout-sheet-action" type="button" data-routine-action="duplicate">Duplicate routine<span>⧉</span></button><button class="workout-sheet-action" type="button" data-routine-action="edit">Edit routine<span>✎</span></button><button class="workout-sheet-action ' + (routine.seeded ? '' : 'is-danger') + '" type="button" data-routine-action="delete">' + escapeHtml(deleteLabel) + '<span>×</span></button></div>', function (root) {
      root.addEventListener('click', function (event) {
        var button = event.target.closest('[data-routine-action]'); if (!button) return;
        var action = button.dataset.routineAction; closeSheet();
        if (action === 'share') shareItem('routine', routine.id);
        if (action === 'duplicate') api('/api/admin/workout/routines/' + encodeURIComponent(routine.id) + '/duplicate', { method: 'POST', body: {} }).then(function (payload) { state.data.routines.push(payload.routine); renderRoutines(); toast('Routine duplicated.'); }).catch(function (error) { toast(error.message); });
        if (action === 'edit') routineEditor(routine);
        if (action === 'delete') { if (routine.seeded) restoreBaseline(); else api('/api/admin/workout/routines/' + encodeURIComponent(routine.id), { method: 'DELETE' }).then(function () { routine.archived = true; renderRoutines(); toast('Routine archived.'); }).catch(function (error) { toast(error.message); }); }
      });
    });
  }

  function routineEditor(routine) {
    var draft = clone(routine);
    var rows = (draft.exercises || []).map(function (item, index) { return '<div class="workout-sheet-exercise-row" data-routine-row="' + index + '"><div class="workout-routine-edit-head"><h4>' + escapeHtml(getExercise(item.exercise_id).name || item.exercise_id) + '</h4><div><button type="button" data-routine-move="up" data-index="' + index + '" aria-label="Move earlier">↑</button><button type="button" data-routine-move="down" data-index="' + index + '" aria-label="Move later">↓</button><button type="button" data-routine-remove="' + index + '" aria-label="Remove exercise">×</button></div></div><div class="workout-sheet-exercise-grid"><label>Sets<input data-routine-field="sets" type="number" min="1" max="12" value="' + Number(item.sets || 3) + '"></label><label>Rep min<input data-routine-field="rep_min" type="number" min="0" max="1000" value="' + Number(item.rep_min || 0) + '"></label><label>Rep max<input data-routine-field="rep_max" type="number" min="0" max="1000" value="' + Number(item.rep_max || 0) + '"></label></div></div>'; }).join('');
    var addOptions = (state.data.exercises || []).filter(function (item) { return !item.archived; }).map(function (item) { return '<option value="' + escapeHtml(item.id) + '">' + escapeHtml(item.name) + '</option>'; }).join('');
    openSheet('Edit routine', draft.name, '<form class="workout-sheet-form" id="workout-routine-form"><label class="workout-sheet-field">Name<input id="workout-routine-name" maxlength="100" value="' + escapeHtml(draft.name) + '"></label>' + rows + '<div class="workout-sheet-row"><label class="workout-sheet-field">Add exercise<select id="workout-routine-add-exercise">' + addOptions + '</select></label><button class="workout-secondary-btn" id="workout-routine-add-btn" type="button">Add</button></div><button class="workout-primary-btn" type="submit">Save future workouts</button></form>', function (root) {
      function captureDraft() {
        draft.name = byId('workout-routine-name').value;
        root.querySelectorAll('[data-routine-row]').forEach(function (row) { var index = Number(row.dataset.routineRow); row.querySelectorAll('[data-routine-field]').forEach(function (input) { draft.exercises[index][input.dataset.routineField] = Number(input.value); }); });
      }
      root.addEventListener('click', function (event) {
        var remove = event.target.closest('[data-routine-remove]');
        var move = event.target.closest('[data-routine-move]');
        if (!remove && !move) return;
        captureDraft();
        if (remove && draft.exercises.length > 1) draft.exercises.splice(Number(remove.dataset.routineRemove), 1);
        if (move) { var index = Number(move.dataset.index); var next = move.dataset.routineMove === 'up' ? index - 1 : index + 1; if (next >= 0 && next < draft.exercises.length) { var swap = draft.exercises[next]; draft.exercises[next] = draft.exercises[index]; draft.exercises[index] = swap; } }
        closeSheet(); routineEditor(draft);
      });
      byId('workout-routine-add-btn').addEventListener('click', function () {
        captureDraft(); var exercise = getExercise(byId('workout-routine-add-exercise').value); if (!exercise.id) return;
        draft.exercises.push({ exercise_id: exercise.id, sets: 3, rep_min: 8, rep_max: 12, start_kg: 0, rest_seconds: exercise.default_rest_seconds || 150, rest_range: '', load_type: exercise.load_type || '', early_rpe: 8, last_rpe: 9, technique: exercise.technique || '', cues: exercise.cues || '', superset_id: '' });
        closeSheet(); routineEditor(draft);
      });
      byId('workout-routine-form').addEventListener('submit', function (event) {
        event.preventDefault();
        captureDraft();
        api('/api/admin/workout/routines/' + encodeURIComponent(draft.id), { method: 'PATCH', body: { base_revision: Number(draft.revision || 0), name: draft.name, focus: draft.focus, block: draft.block, day: draft.day, optional: draft.optional, exercises: draft.exercises } }).then(function (payload) {
          var index = state.data.routines.findIndex(function (item) { return item.id === draft.id; }); state.data.routines[index] = payload.routine; closeSheet(); renderRoutines(); toast('Routine saved · ' + payload.propagated_occurrences + ' future workout(s) updated.');
        }).catch(function (error) { toast(error.message); });
      });
    });
  }

  function newRoutineSheet() {
    var exercises = (state.data.exercises || []).filter(function (item) { return !item.archived; }).slice(0, 60);
    openSheet('New routine', 'Program builder', '<form class="workout-sheet-form" id="workout-new-routine-form"><label class="workout-sheet-field">Name<input id="workout-new-routine-name" maxlength="100" required placeholder="My routine"></label><p class="workout-sheet-help">Select exercises. You can edit targets after creation.</p><div class="workout-exercise-picker">' + exercises.map(function (item) { return '<label class="workout-exercise-option"><span><strong>' + escapeHtml(item.name) + '</strong><small>' + escapeHtml(item.muscle_group || 'Custom') + '</small></span><input type="checkbox" value="' + escapeHtml(item.id) + '" data-new-routine-exercise></label>'; }).join('') + '</div><button class="workout-primary-btn" type="submit">Create routine</button></form>', function (root) {
      byId('workout-new-routine-form').addEventListener('submit', function (event) { event.preventDefault(); var chosen = Array.prototype.slice.call(root.querySelectorAll('[data-new-routine-exercise]:checked')).map(function (input) { return { exercise_id: input.value, sets: 3, rep_min: 8, rep_max: 12, start_kg: 0, rest_seconds: getExercise(input.value).default_rest_seconds || 150, load_type: getExercise(input.value).load_type || '', technique: '', cues: '' }; }); if (!chosen.length) { toast('Select at least one exercise.'); return; } api('/api/admin/workout/routines', { method: 'POST', body: { name: byId('workout-new-routine-name').value, exercises: chosen } }).then(function (payload) { state.data.routines.push(payload.routine); closeSheet(); renderRoutines(); toast('Routine created.'); }).catch(function (error) { toast(error.message); }); });
    });
  }

  function newExerciseSheet() {
    openSheet('Create exercise', 'Exercise library', '<form class="workout-sheet-form" id="workout-new-exercise-form"><label class="workout-sheet-field">Name<input id="workout-exercise-name" maxlength="100" required></label><div class="workout-sheet-row"><label class="workout-sheet-field">Tracking<select id="workout-exercise-type"><option value="weight_reps">Weight & reps</option><option value="bodyweight">Bodyweight</option><option value="weighted_bodyweight">Weighted bodyweight</option><option value="assisted_bodyweight">Assisted bodyweight</option><option value="duration">Duration</option></select></label><label class="workout-sheet-field">Default rest<select id="workout-exercise-rest"><option value="0">Off</option><option value="90">1:30</option><option value="150" selected>2:30</option><option value="210">3:30</option></select></label></div><label class="workout-sheet-field">Equipment<input id="workout-exercise-equipment" maxlength="120"></label><label class="workout-sheet-field">Muscle group<input id="workout-exercise-muscle" maxlength="80"></label><label class="workout-toggle-row"><span><strong>Pair load</strong><small>Double per-hand load for volume</small></span><input id="workout-exercise-pair" type="checkbox" role="switch"></label><label class="workout-toggle-row"><span><strong>Bodyweight contributes</strong><small>Add bodyweight to load volume</small></span><input id="workout-exercise-bodyweight" type="checkbox" role="switch"></label><button class="workout-primary-btn" type="submit">Create exercise</button></form>', function () {
      byId('workout-new-exercise-form').addEventListener('submit', function (event) { event.preventDefault(); api('/api/admin/workout/exercises', { method: 'POST', body: { name: byId('workout-exercise-name').value, tracking_type: byId('workout-exercise-type').value, default_rest_seconds: Number(byId('workout-exercise-rest').value), equipment: byId('workout-exercise-equipment').value, muscle_group: byId('workout-exercise-muscle').value, pair_multiplier: byId('workout-exercise-pair').checked ? 2 : 1, bodyweight_contributes: byId('workout-exercise-bodyweight').checked } }).then(function (payload) { state.data.exercises.push(payload.exercise); closeSheet(); renderRoutines(); toast('Custom exercise created.'); }).catch(function (error) { toast(error.message); }); });
    });
  }

  function shareItem(kind, sourceId) {
    api('/api/admin/workout/shares', { method: 'POST', body: { kind: kind, source_id: sourceId } }).then(function (payload) {
      var url = global.location.origin + payload.share.url;
      if (navigator.share) return navigator.share({ title: 'Workout', text: 'Shared workout', url: url }).catch(function () { return copyShare(url); });
      return copyShare(url);
    }).catch(function (error) { toast(error.message); });
  }
  function copyShare(url) { return navigator.clipboard.writeText(url).then(function () { toast('Share link copied.'); }).catch(function () { openSheet('Share link', 'Read-only snapshot', '<label class="workout-sheet-field">Link<input readonly value="' + escapeHtml(url) + '"></label>'); }); }

  function logBodyweight() {
    openSheet('Log bodyweight', 'Progress', '<form class="workout-sheet-form" id="workout-weight-form"><label class="workout-sheet-field">Date<input id="workout-weight-date" type="date" value="' + new Date().toISOString().slice(0, 10) + '"></label><label class="workout-sheet-field">Weight (kg)<input id="workout-weight-value" type="number" min="20" max="400" step="0.1" inputmode="decimal" value="' + Number(state.data.profile.bodyweight_kg || 0) + '"></label><button class="workout-primary-btn" type="submit">Save entry</button></form>', function () { byId('workout-weight-form').addEventListener('submit', function (event) { event.preventDefault(); api('/api/admin/workout/bodyweight', { method: 'PUT', body: { date: byId('workout-weight-date').value, weight_kg: Number(byId('workout-weight-value').value) } }).then(function (payload) { var existing = (state.data.bodyweight || []).findIndex(function (item) { return item.date === payload.entry.date; }); if (existing >= 0) state.data.bodyweight[existing] = payload.entry; else state.data.bodyweight.push(payload.entry); state.data.profile = payload.profile; return refreshStatistics(); }).then(function () { closeSheet(); renderProgress(); toast('Bodyweight saved.'); }).catch(function (error) { toast(error.message); }); }); });
  }
  function refreshStatistics() { return api('/api/admin/workout/statistics').then(function (payload) { state.data.statistics = payload; }); }

  function restoreBaseline() {
    openSheet('Restore Excel baseline?', 'Future workouts only', '<p class="workout-sheet-help">Active and completed workouts stay frozen. Unstarted prescriptions return to the selected Excel workbook.</p><button class="workout-danger-btn" id="workout-confirm-restore" type="button">Restore future program</button>', function () { byId('workout-confirm-restore').addEventListener('click', function () { api('/api/admin/workout/program/restore', { method: 'POST', body: {} }).then(function (payload) { state.data.routines = state.data.routines.filter(function (item) { return !item.seeded; }).concat(payload.routines); closeSheet(); return reloadBootstrap(); }).then(function () { toast('Excel baseline restored for future workouts.'); }).catch(function (error) { toast(error.message); }); }); });
  }

  function finishWorkout() {
    var session = state.activeSession; if (!session) return;
    var completed = Utils.sessionMetrics(session, false).completed_sets;
    openSheet('Finish workout?', session.name, '<p class="workout-sheet-help">' + completed + ' sets are complete. Finishing freezes this workout and updates progression, records, and analytics.</p><button class="workout-primary-btn" id="workout-confirm-finish" type="button">Finish workout</button>', function () {
      byId('workout-confirm-finish').addEventListener('click', function () {
        var body = { base_revision: Number(session.revision || 0), elapsed_seconds: session.elapsed_seconds, status: 'completed', exercises: session.exercises };
        closeSheet();
        if (!navigator.onLine) { session.status = 'completed'; queueMutation('finish:' + session.id, 'POST', '/api/admin/workout/sessions/' + encodeURIComponent(session.id) + '/finish', body).then(function () { clearDraft(); closeLogger(); state.activeSession = null; setSync('Queued'); toast('Workout finished offline and queued for sync.'); }); return; }
        api('/api/admin/workout/sessions/' + encodeURIComponent(session.id) + '/finish', { method: 'POST', body: body }).then(function (payload) { clearDraft(); releaseWakeLock(); state.activeSession = null; state.data.active_session = null; state.data.history.unshift(payload.session); return reloadBootstrap().then(function () { if (payload.personal_records && payload.personal_records.length && state.data.profile.settings.live_pr_notifications) toast(payload.personal_records.length + ' new personal record' + (payload.personal_records.length === 1 ? '!' : 's!')); else toast('Workout complete.'); closeLogger(); }); }).catch(function (error) { toast(error.message); });
      });
    });
  }

  function discardWorkout() {
    var session = state.activeSession; if (!session) return;
    openSheet('Discard workout?', 'This draft will be removed', '<button class="workout-danger-btn" id="workout-confirm-discard" type="button">Discard workout</button>', function () { byId('workout-confirm-discard').addEventListener('click', function () { api('/api/admin/workout/sessions/' + encodeURIComponent(session.id) + '/discard', { method: 'POST', body: { base_revision: Number(session.revision || 0) } }).then(function () { clearDraft(); state.activeSession = null; closeSheet(); closeLogger(); return reloadBootstrap(); }).then(function () { toast('Workout discarded.'); }).catch(function (error) { toast(error.message); }); }); });
  }

  function saveSettings(event) {
    event.preventDefault();
    var settings = clone(state.data.profile.settings || {});
    settings.default_rest_seconds = Number(byId('workout-default-rest').value);
    settings.previous_values_scope = byId('workout-previous-scope').value;
    settings.rpe_enabled = byId('workout-rpe-toggle').checked;
    settings.warmup_sets_in_statistics = byId('workout-warmup-stats-toggle').checked;
    settings.smart_superset_scrolling = byId('workout-superset-toggle').checked;
    settings.keep_awake = byId('workout-wake-toggle').checked;
    settings.live_pr_notifications = byId('workout-pr-toggle').checked;
    settings.timer_sound = byId('workout-sound-toggle').checked;
    settings.timer_volume = Number(byId('workout-volume').value);
    settings.rest_notifications = byId('workout-notification-toggle').checked;
    settings.warmup_steps = [1, 2, 3].map(function (step) { return { percent: Number(byId('workout-warmup-percent-' + step).value), reps: Number(byId('workout-warmup-reps-' + step).value) }; });
    api('/api/admin/workout/profile', { method: 'PUT', body: { base_revision: Number(state.data.profile.revision || 0), bodyweight_kg: Number(byId('workout-profile-weight').value), handle_weight_kg: Number(byId('workout-handle-weight').value), optional_day_enabled: byId('workout-optional-toggle').checked, settings: settings } }).then(function (payload) { state.data.profile = payload.profile; renderSettings(); toast('Workout settings saved.'); }).catch(function (error) { toast(error.message); });
  }

  function handleLoggerInput(event) {
    var target = event.target;
    if (target.matches('[data-set-field]')) {
      var exercise = state.activeSession.exercises[Number(target.dataset.exerciseIndex)];
      var setItem = exercise.sets[Number(target.dataset.setIndex)];
      var field = target.dataset.setField;
      setItem[field] = field === 'type' ? target.value : Number(target.value || 0);
      scheduleSave(); updateMetrics();
    }
    if (target.matches('[data-exercise-notes]')) { state.activeSession.exercises[Number(target.dataset.exerciseNotes)].notes = target.value; scheduleSave(); }
  }

  function handleLoggerClick(event) {
    var target = event.target.closest('button'); if (!target || !state.activeSession) return;
    if (target.dataset.completeSet) {
      var exercise = state.activeSession.exercises[Number(target.dataset.exerciseIndex)]; var setItem = exercise.sets[Number(target.dataset.setIndex)]; setItem.completed = !setItem.completed; setItem.completed_at = setItem.completed ? nowIso() : '';
      if (setItem.completed && setItem.type !== 'drop') { startRestTimer(exercise.rest_seconds); if (exercise.superset_id && state.data.profile.settings.smart_superset_scrolling) { var nextIndex = state.activeSession.exercises.findIndex(function (item, idx) { return idx !== Number(target.dataset.exerciseIndex) && item.superset_id === exercise.superset_id; }); global.setTimeout(function () { var card = document.querySelector('[data-exercise-card="' + nextIndex + '"]'); if (card) card.scrollIntoView({ behavior: 'smooth' }); }, 120); } }
      renderLogger(); scheduleSave(); return;
    }
    if (target.dataset.addSet != null) { var ex = state.activeSession.exercises[Number(target.dataset.addSet)]; ex.sets.push({ id: 'set-' + (ex.sets.length + 1) + '-' + Date.now(), type: 'normal', kg: ex.sets.length ? ex.sets[ex.sets.length - 1].kg : 0, reps: 0, rpe: ex.last_rpe || 9, duration_seconds: 0, completed: false, completed_at: '' }); renderLogger(); scheduleSave(); }
    if (target.dataset.exerciseMenu != null) exerciseMenu(Number(target.dataset.exerciseMenu));
    if (target.dataset.restPicker != null) restPicker(Number(target.dataset.restPicker));
    if (target.dataset.warmup != null) warmupFor(Number(target.dataset.warmup));
    if (target.dataset.loadGuide != null) loadGuide(Number(target.dataset.loadGuide));
  }

  function bindEvents() {
    document.addEventListener('click', function (event) {
      var nav = event.target.closest('[data-workout-nav]'); if (nav) showView(nav.dataset.workoutNav);
      var cycle = event.target.closest('[data-open-cycle]'); if (cycle) cycleSheet();
      var startOccurrence = event.target.closest('[data-start-occurrence]'); if (startOccurrence) startSession({ occurrence_id: startOccurrence.dataset.startOccurrence });
      var startRoutine = event.target.closest('[data-start-routine]'); if (startRoutine) startSession({ routine_id: startRoutine.dataset.startRoutine });
      var routineMenuButton = event.target.closest('[data-routine-menu]'); if (routineMenuButton) routineMenu(routineMenuButton.dataset.routineMenu);
      var shareRoutineButton = event.target.closest('[data-share-routine]'); if (shareRoutineButton) shareItem('routine', shareRoutineButton.dataset.shareRoutine);
      var shareWorkoutButton = event.target.closest('[data-share-workout]'); if (shareWorkoutButton) shareItem('workout', shareWorkoutButton.dataset.shareWorkout);
    });
    elements.routineSearch.addEventListener('input', renderRoutines);
    elements.trendSelect.addEventListener('change', function () { renderExerciseChart(((state.data.statistics || {}).exercise_history || {})[this.value] || []); });
    elements.resumeCard.addEventListener('click', openLogger);
    elements.emptyBtn.addEventListener('click', function () { startSession({}); });
    byId('workout-new-routine').addEventListener('click', newRoutineSheet);
    byId('workout-new-exercise').addEventListener('click', newExerciseSheet);
    byId('workout-add-weight').addEventListener('click', logBodyweight);
    elements.settingsForm.addEventListener('submit', saveSettings);
    byId('workout-volume').addEventListener('input', function () { byId('workout-volume-output').textContent = Math.round(Number(this.value) * 100) + '%'; });
    byId('workout-notification-toggle').addEventListener('change', function () {
      if (!this.checked) return;
      var installed = (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) || global.navigator.standalone === true;
      if (!installed) { this.checked = false; toast('Install Workout on your Home Screen before enabling rest notifications.'); return; }
      if (global.Notification && Notification.permission === 'default') Notification.requestPermission().then(function (permission) { if (permission !== 'granted') { byId('workout-notification-toggle').checked = false; toast('Notifications were not enabled.'); } });
    });
    byId('workout-restore-baseline').addEventListener('click', restoreBaseline);
    byId('workout-close-logger').addEventListener('click', closeLogger);
    byId('workout-finish-btn').addEventListener('click', finishWorkout);
    byId('workout-discard-btn').addEventListener('click', discardWorkout);
    byId('workout-add-exercise').addEventListener('click', function () { exercisePicker(function (exercise) { state.activeSession.exercises.push(newSessionExercise(exercise)); renderLogger(); scheduleSave(); }); });
    byId('workout-logger-settings').addEventListener('click', function () { closeLogger(); showView('settings'); });
    elements.pauseBtn.addEventListener('click', function () { state.activeSession.status = state.activeSession.status === 'paused' ? 'active' : 'paused'; renderLogger(); scheduleSave(); });
    elements.exerciseStack.addEventListener('input', handleLoggerInput);
    elements.exerciseStack.addEventListener('change', handleLoggerInput);
    elements.exerciseStack.addEventListener('click', handleLoggerClick);
    byId('workout-rest-skip').addEventListener('click', function () { global.clearInterval(state.restTimer); elements.restDrawer.hidden = true; });
    elements.restDrawer.addEventListener('click', function (event) { var button = event.target.closest('[data-rest-adjust]'); if (button) { state.restEndsAt += Number(button.dataset.restAdjust) * 1000; updateRestTimer(); } });
    byId('workout-sheet-close').addEventListener('click', closeSheet);
    elements.sheetOverlay.addEventListener('click', function (event) { if (event.target === elements.sheetOverlay) closeSheet(); });
    document.addEventListener('keydown', function (event) { if (event.key === 'Escape' && !elements.sheetOverlay.hidden) closeSheet(); });
    global.addEventListener('online', function () { elements.offlineBanner.hidden = true; flushMutations().then(reloadBootstrap); });
    global.addEventListener('offline', function () { elements.offlineBanner.hidden = false; setSync('Queued'); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') { requestWakeLock(); flushMutations(); } });
  }

  function cacheElements() {
    elements = { app: byId('workout-app'), loading: byId('workout-loading'), syncPill: byId('workout-sync-pill'), offlineBanner: byId('workout-offline-banner'), cycleLabel: byId('workout-cycle-label'), greeting: byId('workout-greeting'), weekCopy: byId('workout-week-copy'), weekRing: byId('workout-week-ring'), resumeCard: byId('workout-resume-card'), resumeCopy: byId('workout-resume-copy'), schedule: byId('workout-schedule'), emptyBtn: byId('workout-empty-btn'), routineSearch: byId('workout-routine-search'), routineList: byId('workout-routine-list'), librarySummary: byId('workout-library-summary'), kpis: byId('workout-kpi-grid'), weeklyBars: byId('workout-weekly-bars'), muscleBars: byId('workout-muscle-bars'), trendSelect: byId('workout-trend-select'), exerciseChart: byId('workout-exercise-chart'), weightChart: byId('workout-weight-chart'), recordList: byId('workout-record-list'), historyList: byId('workout-history-list'), historyCount: byId('workout-history-count'), settingsForm: byId('workout-settings-form'), logger: byId('workout-logger'), loggerTitle: byId('workout-logger-title'), loggerStatus: byId('workout-logger-status'), duration: byId('workout-duration'), volumeTotal: byId('workout-volume-total'), setCount: byId('workout-set-count'), pauseBtn: byId('workout-pause-btn'), exerciseStack: byId('workout-exercise-stack'), restDrawer: byId('workout-rest-drawer'), restTime: byId('workout-rest-time'), sheetOverlay: byId('workout-sheet-overlay'), sheetContent: byId('workout-sheet-content'), toast: byId('workout-toast') };
  }

  function mergeDraft() {
    return loadDraft().then(function (draft) {
      if (!draft || draft.uid !== state.user.uid || !draft.session) return;
      var server = state.activeSession;
      if (!server || (draft.session.id === server.id && Number(draft.session.revision || 0) >= Number(server.revision || 0))) state.activeSession = draft.session;
    });
  }

  function reloadBootstrap() {
    return api('/api/admin/workout/bootstrap').then(function (payload) {
      state.data = payload; state.activeSession = payload.active_session || null;
      return mergeDraft().then(function () { elements.loading.hidden = true; document.querySelectorAll('.workout-view').forEach(function (view) { view.hidden = view.dataset.workoutView !== state.currentView; }); elements.app.setAttribute('aria-busy', 'false'); renderAll(); if (state.activeSession && !elements.logger.hidden) openLogger(); });
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/admin/workout/service-worker.js', { scope: '/admin/workout' }).catch(function () {});
  }

  function init() {
    cacheElements(); bindEvents(); elements.offlineBanner.hidden = navigator.onLine;
    var auth = global.LectureProcessorBootstrap.getAuth();
    state.authClient = global.LectureProcessorAuth.createAuthClient(auth, { notSignedInMessage: 'Sign in to open Workout' });
    global.LectureProcessorBootstrap.onAuthStateReady(auth, function (user) {
      if (!user) { if (state.db) state.db.close(); state.db = null; if (state.dbName) indexedDB.deleteDatabase(state.dbName); global.location.href = global.LectureProcessorAuth.buildSignInUrl('/admin/workout', 'signin'); return; }
      state.user = user;
      openDatabase(user.uid).then(function () { return reloadBootstrap(); }).then(function () { return flushMutations(); }).then(registerServiceWorker).catch(function (error) { elements.loading.innerHTML = '<p>' + escapeHtml(error.message || 'Could not load Workout') + '</p>'; setSync('Error'); });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})(window);
