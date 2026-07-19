(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Sign in to use Study Plan.' }) : null;
  var htmlUtils = window.LectureProcessorHtml || {};
  var userCache = window.LectureProcessorUserCache || {};
  var uiCache = window.LectureProcessorUiCache || {};
  var escapeHtml = htmlUtils.escapeHtml || function (value) { return String(value == null ? '' : value); };
  var CACHE_KEY = 'study_plan_v2_bootstrap';
  var DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

  var state = {
    user: null,
    data: null,
    view: 'today',
    weekStart: startOfWeek(new Date()),
    wizardStep: 1,
    wizardMode: 'create',
    wizardGoalId: '',
    proposal: null,
    applyIdempotencyKey: '',
    availabilityPreset: '',
    wizardSelectedPackIds: new Set(),
    wizardNotesMinutesByPack: {},
    packFilter: 'all',
    packSearch: '',
    online: navigator.onLine !== false,
    queryPacksConsumed: false,
    lastFocusedElement: null
  };

  var els = {};
  var activeControlPopover = null;

  function byId(id) { return document.getElementById(id); }
  function queryAll(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function pad(value) { return String(value).padStart(2, '0'); }
  function localDate(dateValue) {
    var date = dateValue || new Date();
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }
  function parseDate(value) {
    var parts = String(value || '').split('-').map(Number);
    return new Date(parts[0], (parts[1] || 1) - 1, parts[2] || 1);
  }
  function addDays(dateValue, count) {
    var next = new Date(dateValue.getFullYear(), dateValue.getMonth(), dateValue.getDate());
    next.setDate(next.getDate() + count);
    return next;
  }
  function startOfWeek(value) {
    var date = new Date(value.getFullYear(), value.getMonth(), value.getDate());
    date.setDate(date.getDate() - ((date.getDay() + 6) % 7));
    return date;
  }
  function formatDate(value, options) {
    try { return new Intl.DateTimeFormat(undefined, options || { day: 'numeric', month: 'short' }).format(parseDate(value)); }
    catch (_) { return String(value || ''); }
  }
  function todayInTimezone() {
    var timezone = state.data && state.data.preferences && state.data.preferences.timezone;
    try {
      var parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone || undefined, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
      var values = {};
      parts.forEach(function (part) { values[part.type] = part.value; });
      return values.year + '-' + values.month + '-' + values.day;
    } catch (_) { return localDate(); }
  }
  function currentTimeInTimezone() {
    var timezone = state.data && state.data.preferences && state.data.preferences.timezone;
    try {
      var parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone || undefined, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
      var values = {};
      parts.forEach(function (part) { values[part.type] = part.value; });
      return values.hour + ':' + values.minute;
    } catch (_) { return pad(new Date().getHours()) + ':' + pad(new Date().getMinutes()); }
  }
  function minutesLabel(value) {
    var minutes = Math.max(0, Number(value) || 0);
    if (minutes < 60) return minutes + ' min';
    var hours = Math.floor(minutes / 60);
    var remainder = minutes % 60;
    return hours + 'h' + (remainder ? ' ' + remainder + 'm' : '');
  }
  function randomId(prefix) {
    var random = (window.crypto && window.crypto.getRandomValues) ? window.crypto.getRandomValues(new Uint32Array(2)).join('') : Math.random().toString(36).slice(2);
    return prefix + '_' + String(Date.now()) + '_' + String(random).slice(0, 20);
  }
  function activeGoals() {
    return ((state.data && state.data.goals) || []).filter(function (goal) { return goal.status === 'active'; });
  }
  function plannedSessions() { return (state.data && Array.isArray(state.data.sessions)) ? state.data.sessions : []; }
  function packById(packId) { return ((state.data && state.data.study_packs) || []).find(function (pack) { return pack.study_pack_id === packId; }); }
  function isEditable() { return !!state.user && state.online; }

  function toast(message, type) {
    if (!els.toast) return;
    els.toast.textContent = message;
    els.toast.className = 'toast visible' + (type ? ' ' + type : '');
    els.toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    window.setTimeout(function () { els.toast.className = 'toast'; }, 3200);
  }
  function setSaving(kind, message) {
    if (!els.saveState) return;
    if (!kind) {
      els.saveState.hidden = true;
      els.saveState.className = 'save-state';
      els.saveState.textContent = '';
      return;
    }
    els.saveState.hidden = false;
    els.saveState.className = 'save-state' + (kind ? ' is-' + kind : '');
    els.saveState.textContent = message || (kind === 'saving' ? 'Saving…' : 'Could not save');
  }
  function setOfflineState() {
    state.online = navigator.onLine !== false;
    if (els.offline) els.offline.hidden = state.online;
    queryAll('[data-requires-online], #new-study-goal-btn, #today-add-session-btn, #schedule-add-session-btn').forEach(function (button) {
      button.disabled = !state.online;
    });
  }

  async function api(path, options) {
    if (!authClient || typeof authClient.authFetch !== 'function') throw new Error('Sign in to continue.');
    var response = await authClient.authFetch(path, options || {}, { retryOn401: true, ensureJsonContentType: true });
    var payload = {};
    try { payload = await response.json(); } catch (_) { payload = {}; }
    if (!response.ok) {
      var error = new Error(payload.error || 'The change could not be saved.');
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function cacheData() {
    if (state.user && state.data && typeof userCache.setUserJson === 'function') {
      userCache.setUserJson(state.user, CACHE_KEY, state.data, uiCache);
    }
  }
  function readCache() {
    if (!state.user || typeof userCache.getUserJson !== 'function') return null;
    return userCache.getUserJson(state.user, CACHE_KEY, null, uiCache);
  }

  function bootstrapRange() {
    var from = localDate(addDays(state.weekStart, -7));
    var to = localDate(addDays(state.weekStart, 70));
    return '?from=' + encodeURIComponent(from) + '&to=' + encodeURIComponent(to);
  }
  async function loadData(options) {
    var settings = options || {};
    if (settings.useCache !== false) {
      var cached = readCache();
      if (cached) {
        state.data = cached;
        renderAll();
        els.loading.hidden = true;
        els.workspace.hidden = false;
      }
    }
    try {
      var payload = await api('/api/study-plan' + bootstrapRange());
      state.data = payload;
      cacheData();
      setSaving('');
      els.loading.hidden = true;
      els.workspace.hidden = false;
      renderAll();
      await loadRemainingPacks(payload.next_pack_cursor);
      openRequestedPacks();
    } catch (error) {
      els.loading.hidden = true;
      if (!state.data) {
        els.workspace.hidden = false;
        els.workspace.innerHTML = '<section class="study-plan-auth"><h2>We could not load your plan</h2><p>' + escapeHtml(error.message) + '</p><button type="button" class="btn primary" id="study-plan-retry">Try again</button></section>';
        var retry = byId('study-plan-retry');
        if (retry) retry.addEventListener('click', function () { window.location.reload(); });
      } else {
        toast('Showing your last saved plan. Changes are unavailable until the connection returns.', 'error');
      }
    }
  }

  async function loadRemainingPacks(initialCursor) {
    var cursor = String(initialCursor || '');
    var pageCount = 0;
    while (cursor && pageCount < 10) {
      try {
        var result = await api('/api/study-plan/library?limit=100&cursor=' + encodeURIComponent(cursor));
        var byId = new Map(((state.data && state.data.study_packs) || []).map(function (pack) { return [pack.study_pack_id, pack]; }));
        (result.study_packs || []).forEach(function (pack) { byId.set(pack.study_pack_id, pack); });
        state.data.study_packs = Array.from(byId.values());
        cursor = String(result.next_cursor || '');
        pageCount += 1;
      } catch (error) {
        toast('Some older study packs could not be loaded. ' + error.message, 'error');
        break;
      }
    }
    state.data.next_pack_cursor = cursor;
    cacheData();
    if (els.wizardOverlay && !els.wizardOverlay.hidden) renderWizardPacks();
  }

  function setView(view, updateUrl) {
    var safe = ['today', 'schedule', 'progress'].indexOf(view) >= 0 ? view : 'today';
    state.view = safe;
    queryAll('.study-plan-tab').forEach(function (button) {
      var active = button.dataset.planView === safe;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    queryAll('.study-plan-view').forEach(function (section) { section.hidden = section.dataset.view !== safe; });
    if (updateUrl !== false) {
      var url = new URL(window.location.href);
      if (safe === 'today') url.searchParams.delete('view'); else url.searchParams.set('view', safe);
      window.history.replaceState({}, '', url.pathname + url.search);
    }
    if (safe === 'schedule') renderSchedule();
  }

  function sessionOutcomeText(session) {
    var outcomes = session.planned_outcomes || {};
    var parts = [];
    if (outcomes.flashcards) parts.push(outcomes.flashcards + ' cards');
    if (outcomes.questions) parts.push(outcomes.questions + ' questions');
    if (outcomes.notes_minutes) parts.push(outcomes.notes_minutes + ' min notes');
    return parts.join(' · ') || minutesLabel(session.duration);
  }
  function studyLink(session) {
    if (!session.pack_id) return '/study';
    var outcomes = session.planned_outcomes || {};
    var focus = Number(outcomes.questions || 0) > 0 && Number(outcomes.flashcards || 0) === 0 ? '&focus=test' : (Number(outcomes.notes_minutes || 0) > 0 && Number(outcomes.flashcards || 0) === 0 && Number(outcomes.questions || 0) === 0 ? '&focus=notes' : '');
    return '/study?pack_id=' + encodeURIComponent(session.pack_id) + '&mode=learn' + focus + '&plan_item_id=' + encodeURIComponent(session.id);
  }
  function hasPersonalPace() {
    return !!(state.data && state.data.pace && state.data.pace.personalized);
  }
  function bindSetupButtons(root) {
    queryAll('[data-setup-plan]', root || document).forEach(function (button) {
      button.addEventListener('click', function () { openWizard(); });
    });
  }
  function renderHeaderAction() {
    var label = byId('new-study-goal-label');
    if (label) label.textContent = activeGoals().length ? 'New study goal' : 'Set up my plan';
  }
  function renderNextSession() {
    var today = todayInTimezone();
    var nowTime = currentTimeInTimezone();
    var sessions = plannedSessions().filter(function (item) {
      return item.status === 'planned' && (item.date > today || (item.date === today && item.time >= nowTime));
    }).sort(sortSessions);
    var next = sessions[0];
    if (!next) {
      els.nextTime.textContent = '';
      els.nextContent.innerHTML = '<h2>' + (activeGoals().length ? 'You are clear for now' : 'Let’s build your first study plan') + '</h2><p>' + (activeGoals().length ? 'There is no upcoming session in the current plan. You can add one manually or review your schedule.' : 'Pick what you need to study, choose your deadline and available times, then approve the schedule.') + '</p><div class="next-session-actions"><button type="button" class="btn" data-next-empty-action>' + (activeGoals().length ? 'Add a session' : 'Set up my plan') + '</button></div>';
      var emptyAction = els.nextContent.querySelector('[data-next-empty-action]');
      if (emptyAction) emptyAction.addEventListener('click', function () { activeGoals().length ? openSessionEditor(null) : openWizard(); });
      return;
    }
    els.nextTime.textContent = next.date === today ? next.time : formatDate(next.date, { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + next.time;
    els.nextContent.innerHTML = '<h2>' + escapeHtml(next.title) + '</h2><p>' + escapeHtml(sessionOutcomeText(next)) + (next.pack_title ? ' from ' + escapeHtml(next.pack_title) : '') + '</p><div class="next-session-actions"><a class="btn" href="' + escapeHtml(studyLink(next)) + '">Start studying</a><button type="button" class="btn secondary" data-next-complete>Complete</button><button type="button" class="btn secondary" data-next-edit>Reschedule</button></div>';
    els.nextContent.querySelector('[data-next-complete]').addEventListener('click', function () { updateSessionStatus(next, 'completed'); });
    els.nextContent.querySelector('[data-next-edit]').addEventListener('click', function () { openSessionEditor(next); });
  }
  function sortSessions(a, b) { return (a.date + a.time + a.id).localeCompare(b.date + b.time + b.id); }
  function renderGoalHealth() {
    var goals = activeGoals().slice().sort(function (a, b) { return a.exam_date.localeCompare(b.exam_date); });
    var goal = goals[0];
    if (!goal) {
      els.goalHealth.innerHTML = '<h2>Start with a study goal</h2><p>Choose the packs you want to study and the date you want to be ready. We will guide you through the rest.</p><button type="button" class="btn primary" data-setup-plan>Set up a goal</button>';
      bindSetupButtons(els.goalHealth);
      return;
    }
    var progressGoal = (((state.data || {}).progress || {}).goals || []).find(function (item) { return item.goal_id === goal.goal_id; }) || {};
    var days = Math.max(0, Math.ceil((parseDate(goal.exam_date) - parseDate(todayInTimezone())) / 86400000));
    var paceCopy = hasPersonalPace() ? minutesLabel(progressGoal.remaining_minutes || 0) + ' remaining at your recent pace. ' : '';
    els.goalHealth.innerHTML = '<div class="goal-countdown">' + days + ' <span>days left</span></div><h2>' + escapeHtml(goal.title) + '</h2><p>' + escapeHtml(paceCopy) + 'Deadline: ' + escapeHtml(formatDate(goal.exam_date, { day: 'numeric', month: 'long' })) + '.</p><span class="health-badge ' + (progressGoal.on_track ? 'good' : 'warning') + '">' + (progressGoal.on_track ? 'On track' : 'Needs attention') + '</span>';
  }
  function sessionRow(session) {
    var statusLabel = session.status === 'completed' ? 'Completed' : session.status === 'skipped' ? 'Skipped' : '';
    return '<div class="session-row is-' + escapeHtml(session.status) + '" data-session-id="' + escapeHtml(session.id) + '"><div class="session-row-time">' + escapeHtml(session.time) + '<span>' + escapeHtml(minutesLabel(session.duration)) + '</span></div><div><h3>' + escapeHtml(session.title) + '</h3><p>' + escapeHtml(statusLabel || sessionOutcomeText(session)) + (session.locked ? ' · Locked' : '') + '</p></div><div class="session-row-actions">' + (session.status === 'planned' && session.pack_id ? '<a class="btn" href="' + escapeHtml(studyLink(session)) + '">Start</a>' : '') + (session.status === 'planned' ? '<button type="button" class="btn" data-complete>Complete</button><button type="button" class="btn" data-edit>Edit</button>' : '') + '</div></div>';
  }
  function renderToday() {
    var today = todayInTimezone();
    var sessions = plannedSessions().filter(function (item) { return item.date === today && item.status !== 'cancelled'; }).sort(sortSessions);
    els.todayList.innerHTML = sessions.length ? sessions.map(sessionRow).join('') : '<div class="empty-plan-state"><strong>No sessions today</strong>Your accepted plan is staying quiet today. Add a manual session only if you want one.</div>';
    queryAll('.session-row', els.todayList).forEach(function (row) {
      var session = plannedSessions().find(function (item) { return item.id === row.dataset.sessionId; });
      var complete = row.querySelector('[data-complete]');
      var edit = row.querySelector('[data-edit]');
      if (complete) complete.addEventListener('click', function () { updateSessionStatus(session, 'completed'); });
      if (edit) edit.addEventListener('click', function () { openSessionEditor(session); });
    });
    var missed = plannedSessions().filter(function (item) { return item.status === 'planned' && item.date < today && item.origin === 'automatic'; });
    var progressChanged = ((((state.data || {}).progress || {}).goals || []).some(function (goal) { return !!goal.needs_rebalance; }));
    els.rebalance.hidden = !missed.length && !progressChanged;
    if (missed.length) els.rebalanceMessage.textContent = missed.length + ' planned session' + (missed.length === 1 ? ' was' : 's were') + ' missed. Review a proposal; nothing moves until you accept it.';
    else if (progressChanged) els.rebalanceMessage.textContent = 'Your recent progress meaningfully changed the remaining workload. Review a proposal; nothing moves until you accept it.';
  }

  function renderSchedule() {
    if (!state.data) return;
    var end = addDays(state.weekStart, 6);
    var from = localDate(state.weekStart);
    var to = localDate(end);
    var sessions = plannedSessions().filter(function (item) { return item.date >= from && item.date <= to && item.status !== 'cancelled'; }).sort(sortSessions);
    els.weekTitle.textContent = formatDate(from, { day: 'numeric', month: 'short' }) + ' – ' + formatDate(to, { day: 'numeric', month: 'short', year: 'numeric' });
    els.weekSummary.textContent = minutesLabel(sessions.filter(function (item) { return item.status !== 'skipped'; }).reduce(function (total, item) { return total + Number(item.duration || 0); }, 0)) + ' planned across ' + sessions.length + ' session' + (sessions.length === 1 ? '' : 's');
    var noPlanYet = activeGoals().length === 0 && plannedSessions().length === 0;
    els.scheduleHelp.hidden = noPlanYet;
    els.weekCalendar.classList.toggle('is-empty-workspace', noPlanYet);
    if (noPlanYet) {
      els.weekCalendar.innerHTML = '<div class="empty-workspace-panel"><div class="empty-workspace-icon" aria-hidden="true">◇</div><h3>Your schedule begins with a goal</h3><p>Tell us what you are studying, your deadline, and when you are free. You will review the proposed schedule before anything is added.</p><button type="button" class="btn primary" data-setup-plan>Set up my study plan</button></div>';
      els.mobileAgenda.innerHTML = '';
      bindSetupButtons(els.weekCalendar);
      return;
    }
    var today = todayInTimezone();
    var daysHtml = [];
    var agendaHtml = [];
    for (var index = 0; index < 7; index += 1) {
      var day = localDate(addDays(state.weekStart, index));
      var daySessions = sessions.filter(function (item) { return item.date === day; });
      var buttons = daySessions.map(function (item) {
        return '<button type="button" class="calendar-session is-' + escapeHtml(item.status) + (item.locked ? ' is-locked' : '') + '" data-calendar-session="' + escapeHtml(item.id) + '"><span class="calendar-session-time">' + escapeHtml(item.time) + ' · ' + escapeHtml(minutesLabel(item.duration)) + '</span><span class="calendar-session-title">' + escapeHtml(item.title) + '</span></button>';
      }).join('');
      daysHtml.push('<div class="week-day' + (day === today ? ' is-today' : '') + '"><div class="week-day-head"><div class="week-day-name">' + escapeHtml(DAY_NAMES[index].slice(0, 3)) + '</div><div class="week-day-number">' + parseDate(day).getDate() + '</div></div>' + (buttons || '<div class="empty-plan-state">Free</div>') + '</div>');
      agendaHtml.push('<section class="agenda-day"><h3>' + escapeHtml(DAY_NAMES[index]) + ' · ' + escapeHtml(formatDate(day)) + '</h3>' + (daySessions.length ? daySessions.map(sessionRow).join('') : '<div class="empty-plan-state">No sessions</div>') + '</section>');
    }
    els.weekCalendar.innerHTML = daysHtml.join('');
    els.mobileAgenda.innerHTML = agendaHtml.join('');
    queryAll('[data-calendar-session]', els.weekCalendar).forEach(function (button) {
      button.addEventListener('click', function () { openSessionEditor(plannedSessions().find(function (item) { return item.id === button.dataset.calendarSession; })); });
    });
    queryAll('[data-session-id]', els.mobileAgenda).forEach(function (row) {
      var session = plannedSessions().find(function (item) { return item.id === row.dataset.sessionId; });
      var complete = row.querySelector('[data-complete]');
      var edit = row.querySelector('[data-edit]');
      if (complete) complete.addEventListener('click', function () { updateSessionStatus(session, 'completed'); });
      if (edit) edit.addEventListener('click', function () { openSessionEditor(session); });
    });
  }

  function renderProgress() {
    var progress = (state.data && state.data.progress) || {};
    var metrics = [
      ['Study time', minutesLabel(progress.completed_minutes || progress.minutes || 0), minutesLabel(progress.planned_minutes || 0) + ' planned'],
      ['Cards reviewed', Number(progress.cards_reviewed || 0), Number(progress.due_cards || 0) + ' due now'],
      ['Questions answered', Number(progress.questions_answered || 0), Number(progress.correct || 0) + ' correct'],
      ['Accuracy', Number(progress.accuracy_percent || 0) + '%', Number(progress.correct || 0) + ' correct'],
      ['Mastery', Number(progress.mastery_percent || 0) + '%', Number(progress.due_cards || 0) + ' cards due'],
      ['Study streak', Number(progress.current_streak || 0) + ' days', 'Keep the rhythm going']
    ];
    els.progressSummary.innerHTML = metrics.map(function (item) { return '<article class="metric-card"><div class="metric-card-label">' + escapeHtml(item[0]) + '</div><div class="metric-card-value">' + escapeHtml(item[1]) + '</div><div class="metric-card-note">' + escapeHtml(item[2]) + '</div></article>'; }).join('');
    var completed = Number(progress.completed_minutes || progress.minutes || 0);
    var planned = Math.max(0, Number(progress.planned_minutes || 0));
    var percent = planned ? Math.min(100, Math.round(completed / planned * 100)) : 0;
    els.timeChart.innerHTML = '<progress class="time-progress-bar" max="100" value="' + percent + '">' + percent + '%</progress><div class="time-progress-labels"><span>' + escapeHtml(minutesLabel(completed)) + ' completed</span><span>' + escapeHtml(minutesLabel(planned)) + ' planned</span></div>';
    var goals = Array.isArray(progress.goals) ? progress.goals : [];
    els.goalProgress.innerHTML = goals.length ? goals.map(function (goal) {
      var detail = (hasPersonalPace() ? minutesLabel(goal.remaining_minutes) + ' remaining at your pace · ' : '') + minutesLabel(goal.scheduled_minutes) + ' scheduled · ' + String(goal.mastery_percent || 0) + '% mastered';
      return '<div class="goal-progress-item"><div class="goal-progress-item-head"><h3>' + escapeHtml(goal.title) + '</h3><span class="health-badge ' + (goal.on_track ? 'good' : 'warning') + '">' + escapeHtml(String(goal.readiness_percent || 0)) + '% ready</span></div><p>' + escapeHtml(detail) + '</p></div>';
    }).join('') : '<div class="empty-plan-state"><strong>No goal yet</strong>Set up a goal to connect your packs, deadline, schedule, and readiness.<button type="button" class="btn primary" data-setup-plan>Create my first goal</button></div>';
    bindSetupButtons(els.goalProgress);
  }

  function renderAll() {
    if (!state.data) return;
    renderHeaderAction();
    renderNextSession();
    renderGoalHealth();
    renderToday();
    renderSchedule();
    renderProgress();
    renderFeeds();
    setView(state.view, false);
    setOfflineState();
  }

  function controlLabel(control) {
    var explicit = control.getAttribute('aria-label');
    if (explicit) return explicit;
    var label = control.labels && control.labels[0];
    var heading = label && label.querySelector(':scope > span');
    return (heading ? heading.textContent : (label ? label.textContent : 'Choose an option')).trim();
  }
  function closeControlPopover(restoreFocus) {
    if (!activeControlPopover) return false;
    var current = activeControlPopover;
    activeControlPopover = null;
    if (current.anchor) current.anchor.setAttribute('aria-expanded', 'false');
    if (current.panel && current.panel.parentNode) current.panel.parentNode.removeChild(current.panel);
    if (restoreFocus && current.anchor && typeof current.anchor.focus === 'function') current.anchor.focus();
    return true;
  }
  function positionControlPopover(panel, anchor) {
    var rect = anchor.getBoundingClientRect();
    panel.classList.toggle('is-lower-anchor', rect.top > window.innerHeight * .55);
  }
  function showControlPopover(panel, anchor) {
    closeControlPopover(false);
    panel.classList.add('plan-control-popover');
    document.body.appendChild(panel);
    anchor.setAttribute('aria-expanded', 'true');
    activeControlPopover = { panel: panel, anchor: anchor };
    positionControlPopover(panel, anchor);
  }
  function refreshPrettySelect(select) {
    if (!select || !select._prettyButton) return;
    var option = select.options[select.selectedIndex] || select.options[0];
    var text = option ? option.textContent : 'Choose an option';
    select._prettyButton.querySelector('[data-pretty-select-label]').textContent = text;
    select._prettyButton.setAttribute('aria-label', controlLabel(select) + ': ' + text);
  }
  function openPrettySelect(select) {
    var button = select._prettyButton;
    var panel = document.createElement('div');
    panel.className = 'select-popover';
    panel.setAttribute('role', 'listbox');
    panel.setAttribute('aria-label', controlLabel(select));
    Array.prototype.forEach.call(select.options, function (option) {
      var optionButton = document.createElement('button');
      optionButton.type = 'button';
      optionButton.className = 'pretty-option' + (option.selected ? ' is-selected' : '');
      optionButton.textContent = option.textContent;
      optionButton.setAttribute('role', 'option');
      optionButton.setAttribute('aria-selected', option.selected ? 'true' : 'false');
      optionButton.disabled = option.disabled;
      optionButton.addEventListener('click', function () {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        refreshPrettySelect(select);
        closeControlPopover(false);
        button.focus();
      });
      panel.appendChild(optionButton);
    });
    showControlPopover(panel, button);
    var selectedButton = panel.querySelector('.pretty-option.is-selected');
    if (selectedButton) selectedButton.focus();
  }
  function enhancePrettySelects(root) {
    queryAll('select[data-pretty-select]', root || document).forEach(function (select) {
      if (select.dataset.prettySelectReady === 'true') { refreshPrettySelect(select); return; }
      select.dataset.prettySelectReady = 'true';
      var wrapper = document.createElement('span');
      wrapper.className = 'pretty-select';
      select.parentNode.insertBefore(wrapper, select);
      wrapper.appendChild(select);
      select.classList.add('plan-native-control-hidden');
      select.tabIndex = -1;
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'pretty-select-button';
      button.setAttribute('aria-haspopup', 'listbox');
      button.setAttribute('aria-expanded', 'false');
      button.innerHTML = '<span data-pretty-select-label></span>';
      wrapper.appendChild(button);
      select._prettyButton = button;
      refreshPrettySelect(select);
      select.addEventListener('change', function () { refreshPrettySelect(select); });
      button.addEventListener('click', function (event) { event.stopPropagation(); if (activeControlPopover && activeControlPopover.anchor === button) closeControlPopover(false); else openPrettySelect(select); });
      button.addEventListener('keydown', function (event) { if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openPrettySelect(select); } });
    });
  }
  function pickerIcon(kind) {
    if (kind === 'time') return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle><path d="M12 7v5l3 2"></path></svg>';
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="4" y="6" width="16" height="14" rx="2"></rect><path d="M8 3v6M16 3v6M4 10h16"></path></svg>';
  }
  function setPickerValue(input, value) {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function validPickerDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    var parsed = parseDate(value);
    return isNaN(parsed.getTime()) ? null : parsed;
  }
  function openDatePicker(input, anchor) {
    var chosen = validPickerDate(input.value);
    var cursor = chosen || new Date();
    var monthCursor = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    var panel = document.createElement('div');
    panel.className = 'date-picker-popover';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Choose ' + controlLabel(input).toLowerCase());
    function allowed(value) { return (!input.min || value >= input.min) && (!input.max || value <= input.max); }
    function renderMonth() {
      var year = monthCursor.getFullYear();
      var month = monthCursor.getMonth();
      var offset = (new Date(year, month, 1).getDay() + 6) % 7;
      var days = new Date(year, month + 1, 0).getDate();
      var today = localDate(new Date());
      var selected = input.value;
      var cells = '';
      for (var spacer = 0; spacer < offset; spacer += 1) cells += '<span class="date-picker-spacer" aria-hidden="true"></span>';
      for (var day = 1; day <= days; day += 1) {
        var value = year + '-' + pad(month + 1) + '-' + pad(day);
        cells += '<button type="button" class="date-picker-day' + (value === today ? ' is-today' : '') + (value === selected ? ' is-selected' : '') + '" data-picker-date="' + value + '"' + (allowed(value) ? '' : ' disabled') + ' aria-label="' + escapeHtml(formatDate(value, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })) + '">' + day + '</button>';
      }
      var todayDisabled = allowed(today) ? '' : ' disabled';
      panel.innerHTML = '<div class="date-picker-header"><button type="button" class="date-picker-nav" data-month-step="-1" aria-label="Previous month">‹</button><div class="date-picker-title">' + escapeHtml(new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(monthCursor)) + '</div><button type="button" class="date-picker-nav" data-month-step="1" aria-label="Next month">›</button></div><div class="date-picker-weekdays"><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span><span>Sun</span></div><div class="date-picker-grid">' + cells + '</div><div class="date-picker-footer"><button type="button" class="picker-text-button" data-picker-clear>Clear</button><button type="button" class="picker-text-button" data-picker-today' + todayDisabled + '>Today</button></div>';
      queryAll('[data-month-step]', panel).forEach(function (button) { button.addEventListener('click', function () { monthCursor = new Date(year, month + Number(button.dataset.monthStep), 1); renderMonth(); positionControlPopover(panel, anchor); }); });
      queryAll('[data-picker-date]', panel).forEach(function (button) { button.addEventListener('click', function () { setPickerValue(input, button.dataset.pickerDate); closeControlPopover(false); input.focus(); }); });
      panel.querySelector('[data-picker-clear]').addEventListener('click', function () { setPickerValue(input, ''); closeControlPopover(false); input.focus(); });
      var todayButton = panel.querySelector('[data-picker-today]');
      todayButton.addEventListener('click', function () { if (!todayButton.disabled) { setPickerValue(input, today); closeControlPopover(false); input.focus(); } });
    }
    renderMonth();
    showControlPopover(panel, anchor);
  }
  function openTimePicker(input, anchor) {
    var panel = document.createElement('div');
    panel.className = 'time-picker-popover';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Choose ' + controlLabel(input).toLowerCase());
    panel.innerHTML = '<div class="time-picker-title">Choose a time</div><div class="time-picker-grid"></div>';
    var grid = panel.querySelector('.time-picker-grid');
    var values = [];
    for (var minutes = 0; minutes < 24 * 60; minutes += 30) values.push(pad(Math.floor(minutes / 60)) + ':' + pad(minutes % 60));
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(input.value) && values.indexOf(input.value) < 0) values.push(input.value);
    values.sort();
    values.forEach(function (value) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'time-picker-option' + (value === input.value ? ' is-selected' : '');
      button.textContent = value;
      button.addEventListener('click', function () { setPickerValue(input, value); closeControlPopover(false); input.focus(); });
      grid.appendChild(button);
    });
    showControlPopover(panel, anchor);
    var selected = grid.querySelector('.is-selected');
    if (selected) selected.scrollIntoView({ block: 'center' });
  }
  function enhancePlanPickers(root) {
    queryAll('input[data-plan-picker]', root || document).forEach(function (input) {
      if (input.dataset.planPickerReady === 'true') return;
      input.dataset.planPickerReady = 'true';
      var kind = input.dataset.planPicker;
      var wrapper = document.createElement('span');
      wrapper.className = 'plan-picker-control';
      input.parentNode.insertBefore(wrapper, input);
      wrapper.appendChild(input);
      var trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'plan-picker-trigger';
      trigger.setAttribute('aria-label', 'Open ' + controlLabel(input).toLowerCase());
      trigger.setAttribute('aria-haspopup', 'dialog');
      trigger.setAttribute('aria-expanded', 'false');
      trigger.innerHTML = pickerIcon(kind);
      wrapper.appendChild(trigger);
      function openPicker(event) { event.stopPropagation(); if (activeControlPopover && activeControlPopover.anchor === trigger) closeControlPopover(false); else if (kind === 'time') openTimePicker(input, trigger); else openDatePicker(input, trigger); }
      trigger.addEventListener('click', openPicker);
      input.addEventListener('click', function (event) { if (!activeControlPopover || activeControlPopover.anchor !== trigger) openPicker(event); });
      input.addEventListener('keydown', function (event) { if (event.key === 'ArrowDown') { event.preventDefault(); if (kind === 'time') openTimePicker(input, trigger); else openDatePicker(input, trigger); } });
    });
  }

  function openOverlay(element) {
    if (!element) return;
    state.lastFocusedElement = document.activeElement;
    element.hidden = false;
    element.setAttribute('aria-hidden', 'false');
    document.body.classList.add('plan-modal-open');
    window.requestAnimationFrame(function () {
      var first = element.querySelector('[autofocus], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
      if (first) first.focus();
    });
  }
  function closeOverlay(element) {
    if (!element) return;
    closeControlPopover(false);
    element.hidden = true;
    element.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('plan-modal-open');
    if (state.lastFocusedElement && typeof state.lastFocusedElement.focus === 'function') state.lastFocusedElement.focus();
    state.lastFocusedElement = null;
  }

  function requestedPackIds() {
    var params = new URLSearchParams(window.location.search);
    var raw = params.get('add_packs') || params.get('add_pack') || '';
    return raw.split(',').map(function (item) { return item.trim(); }).filter(Boolean);
  }
  function openRequestedPacks() {
    if (state.queryPacksConsumed || !requestedPackIds().length) return;
    state.queryPacksConsumed = true;
    openWizard({ packIds: requestedPackIds() });
  }
  function eligibleStudyPacks() {
    return ((state.data && state.data.study_packs) || []).filter(function (pack) {
      return String(pack.mode || '').toLowerCase() !== 'voice-note';
    });
  }
  function packMatchesFilter(pack) {
    var cards = Number(pack.flashcards_count || 0);
    var questions = Number(pack.test_questions_count || 0);
    if (state.packFilter === 'flashcards' && cards <= 0) return false;
    if (state.packFilter === 'questions' && questions <= 0) return false;
    if (state.packFilter === 'notes' && (cards > 0 || questions > 0)) return false;
    var search = String(state.packSearch || '').trim().toLowerCase();
    if (!search) return true;
    return [pack.title, pack.folder_name, pack.course, pack.subject].join(' ').toLowerCase().indexOf(search) >= 0;
  }
  function packMaterialBadges(pack) {
    var cards = Number(pack.flashcards_count || 0);
    var questions = Number(pack.test_questions_count || 0);
    var badges = [];
    if (cards > 0) badges.push('<span class="material-badge flashcards">▱ ' + escapeHtml(String(cards)) + ' flashcard' + (cards === 1 ? '' : 's') + '</span>');
    if (questions > 0) badges.push('<span class="material-badge questions">? ' + escapeHtml(String(questions)) + ' question' + (questions === 1 ? '' : 's') + '</span>');
    if (!badges.length) badges.push('<span class="material-badge notes">≡ Notes</span>');
    return badges.join('');
  }
  function updatePackSelectionSummary() {
    var packs = eligibleStudyPacks();
    var cards = packs.filter(function (pack) { return Number(pack.flashcards_count || 0) > 0; }).length;
    var questions = packs.filter(function (pack) { return Number(pack.test_questions_count || 0) > 0; }).length;
    els.wizardPackSelectionSummary.textContent = state.wizardSelectedPackIds.size + ' selected · ' + cards + ' flashcard pack' + (cards === 1 ? '' : 's') + ' · ' + questions + ' question pack' + (questions === 1 ? '' : 's');
  }
  function renderWizardPacks(selectedIds, notesMinutesByPack) {
    if (selectedIds) {
      var eligibleIds = new Set(eligibleStudyPacks().map(function (pack) { return pack.study_pack_id; }));
      state.wizardSelectedPackIds = new Set(selectedIds.filter(function (packId) { return eligibleIds.has(packId); }));
    }
    if (notesMinutesByPack) state.wizardNotesMinutesByPack = Object.assign({}, notesMinutesByPack);
    var packs = eligibleStudyPacks().filter(packMatchesFilter);
    els.wizardPackList.innerHTML = packs.length ? packs.map(function (pack) {
      var folder = pack.folder_name ? pack.folder_name : 'Unfiled';
      return '<div class="wizard-pack-option"><label class="wizard-pack-select"><input type="checkbox" value="' + escapeHtml(pack.study_pack_id) + '"' + (state.wizardSelectedPackIds.has(pack.study_pack_id) ? ' checked' : '') + '><span class="wizard-pack-copy"><strong>' + escapeHtml(pack.title) + '</strong><span class="pack-materials">' + packMaterialBadges(pack) + '</span><span>' + escapeHtml(folder) + '</span></span></label>' + (pack.in_plan ? '<span class="in-plan-tag">In plan</span>' : '') + '</div>';
    }).join('') : '<div class="empty-plan-state"><strong>' + (eligibleStudyPacks().length ? 'No packs match this filter' : 'No study packs yet') + '</strong>' + (eligibleStudyPacks().length ? 'Try another search or material type.' : 'Create flashcards, questions, or notes in Study Library first.') + '</div>';
    queryAll('.wizard-pack-select input[type="checkbox"]', els.wizardPackList).forEach(function (input) {
      input.addEventListener('change', function () {
        if (input.checked) state.wizardSelectedPackIds.add(input.value);
        else state.wizardSelectedPackIds.delete(input.value);
        updatePackSelectionSummary();
      });
    });
    updatePackSelectionSummary();
  }
  function selectedWizardPacks() { return Array.from(state.wizardSelectedPackIds); }
  function wizardNotesMinutes(packIds) {
    var selected = new Set(packIds || []);
    var result = {};
    Object.keys(state.wizardNotesMinutesByPack || {}).forEach(function (packId) {
      if (selected.has(packId)) result[packId] = Math.max(15, Math.min(5000, Number(state.wizardNotesMinutesByPack[packId] || 45)));
    });
    return result;
  }
  function defaultExamDate() { return localDate(addDays(new Date(), 28)); }
  function openWizard(options) {
    if (!isEditable()) { toast(state.online ? 'Sign in to create a plan.' : 'Reconnect before changing your plan.', 'error'); return; }
    var settings = options || {};
    state.wizardMode = settings.goalId ? 'rebalance' : 'create';
    state.wizardGoalId = settings.goalId || '';
    state.proposal = null;
    state.applyIdempotencyKey = '';
    state.wizardStep = 1;
    state.packFilter = 'all';
    state.packSearch = '';
    els.wizardPackSearch.value = '';
    queryAll('[data-pack-filter]').forEach(function (button) { var active = button.dataset.packFilter === 'all'; button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', active ? 'true' : 'false'); });
    var existing = activeGoals().find(function (goal) { return goal.goal_id === state.wizardGoalId; });
    renderWizardPacks(settings.packIds || (existing ? existing.pack_ids : []), existing ? existing.notes_minutes_by_pack : {});
    els.wizardPersonalPaceNote.hidden = !hasPersonalPace();
    els.wizardTitle.value = existing ? existing.title : '';
    els.wizardDate.value = existing ? existing.exam_date : defaultExamDate();
    els.wizardDate.min = localDate(addDays(new Date(), 1));
    els.wizardSessionLength.value = String((state.data.preferences || {}).default_session_minutes || 45);
    refreshPrettySelect(els.wizardSessionLength);
    renderCustomAvailability();
    var configured = !!((state.data.preferences || {}).availability_configured);
    chooseAvailabilityPreset(existing || configured ? 'custom' : '', true);
    renderWizardStep();
    openOverlay(els.wizardOverlay);
  }
  function renderWizardStep() {
    queryAll('[data-wizard-step]').forEach(function (section) { section.hidden = Number(section.dataset.wizardStep) !== state.wizardStep; });
    queryAll('[data-wizard-marker]').forEach(function (marker) { marker.classList.toggle('is-active', Number(marker.dataset.wizardMarker) <= state.wizardStep); });
    els.wizardBack.hidden = state.wizardStep === 1;
    els.wizardNext.textContent = state.wizardStep === 4 ? 'Accept this plan' : (state.wizardStep === 3 ? 'Generate schedule' : 'Continue');
    els.wizardNext.disabled = false;
  }
  function clearWizardErrors() { [els.wizardPackError, els.wizardGoalError, els.wizardAvailabilityError].forEach(function (item) { item.hidden = true; item.textContent = ''; }); }
  function availabilityForPreset() {
    if (state.availabilityPreset === 'balanced') return [
      { weekday: 0, start: '17:00', end: '19:00' },
      { weekday: 2, start: '17:00', end: '19:00' },
      { weekday: 5, start: '10:00', end: '12:00' }
    ];
    if (state.availabilityPreset === 'weekday-evenings') return [0,1,2,3,4].map(function (weekday) { return { weekday: weekday, start: '19:00', end: '21:00' }; });
    if (state.availabilityPreset === 'daily') return [0,1,2,3,4,5,6].map(function (weekday) { return { weekday: weekday, start: '17:00', end: '19:00' }; });
    if (state.availabilityPreset !== 'custom') return [];
    return queryAll('.custom-day', els.customAvailability).filter(function (row) { return row.querySelector('input[type="checkbox"]').checked; }).map(function (row) { return { weekday: Number(row.dataset.weekday), start: row.querySelector('[data-start]').value, end: row.querySelector('[data-end]').value }; }).filter(function (item) { return item.start && item.end && item.end > item.start; });
  }
  function renderCustomAvailability() {
    var preferences = ((state.data || {}).preferences || {});
    var current = preferences.availability_configured ? (preferences.availability || []) : [];
    els.customAvailability.innerHTML = DAY_NAMES.map(function (name, weekday) {
      var existing = current.find(function (item) { return Number(item.weekday) === weekday; });
      return '<div class="custom-day" data-weekday="' + weekday + '"><label><input type="checkbox" aria-label="Study on ' + escapeHtml(name) + '"' + (existing ? ' checked' : '') + '> ' + escapeHtml(name) + '</label><input type="text" inputmode="numeric" autocomplete="off" data-plan-picker="time" data-start aria-label="' + escapeHtml(name) + ' start time" value="' + escapeHtml(existing ? existing.start : '17:00') + '"><span>to</span><input type="text" inputmode="numeric" autocomplete="off" data-plan-picker="time" data-end aria-label="' + escapeHtml(name) + ' end time" value="' + escapeHtml(existing ? existing.end : '19:00') + '"></div>';
    }).join('');
    enhancePlanPickers(els.customAvailability);
  }
  function chooseAvailabilityPreset(preset, skipRender) {
    state.availabilityPreset = preset;
    queryAll('[data-availability-preset]').forEach(function (button) { var active = button.dataset.availabilityPreset === preset; button.classList.toggle('is-active', active); button.setAttribute('aria-pressed', active ? 'true' : 'false'); });
    els.customAvailability.hidden = preset !== 'custom';
    if (preset === 'custom' && !skipRender) renderCustomAvailability();
    if (preset === 'custom' && !els.customAvailability.children.length) renderCustomAvailability();
  }
  async function previewWizard() {
    if (!isEditable()) { toast('Reconnect before generating a schedule.', 'error'); return; }
    var packIds = selectedWizardPacks();
    var existing = activeGoals().find(function (goal) { return goal.goal_id === state.wizardGoalId; });
    var goal = {
      goal_id: existing ? existing.goal_id : undefined,
      revision: existing ? existing.revision : undefined,
      title: els.wizardTitle.value.trim(),
      exam_date: els.wizardDate.value,
      pack_ids: packIds,
      notes_minutes_by_pack: wizardNotesMinutes(packIds)
    };
    var preferences = {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || ((state.data || {}).preferences || {}).timezone || 'UTC',
      availability: availabilityForPreset(),
      default_session_minutes: Number(els.wizardSessionLength.value || 45),
      reminder_offset_minutes: Number(((state.data || {}).preferences || {}).reminder_offset_minutes || 30)
    };
    els.wizardNext.disabled = true;
    els.wizardNext.textContent = 'Generating…';
    try {
      var result = await api('/api/study-plan/preview', { method: 'POST', body: JSON.stringify({ goal: goal, preferences: preferences }) });
      state.proposal = result.proposal;
      state.applyIdempotencyKey = randomId('idem');
      renderPreview();
      state.wizardStep = 4;
      renderWizardStep();
    } catch (error) {
      els.wizardAvailabilityError.textContent = error.message;
      els.wizardAvailabilityError.hidden = false;
      els.wizardNext.disabled = false;
      els.wizardNext.textContent = 'Generate schedule';
    }
  }
  function renderPreview() {
    var proposal = state.proposal || {};
    var summary = proposal.summary || {};
    var sessionDates = new Set((proposal.sessions || []).map(function (session) { return session.date; })).size;
    var personalized = !!(proposal.pace && proposal.pace.personalized);
    var paceStat = personalized ? '<div class="preview-stat"><strong>' + escapeHtml(minutesLabel(summary.required_minutes)) + '</strong><span>at your recent pace</span></div>' : '';
    els.previewSummary.classList.toggle('has-two-stats', !personalized);
    els.previewSummary.innerHTML = paceStat + '<div class="preview-stat"><strong>' + escapeHtml(String((proposal.sessions || []).length)) + '</strong><span>study sessions</span></div><div class="preview-stat"><strong>' + escapeHtml(String(sessionDates)) + '</strong><span>study day' + (sessionDates === 1 ? '' : 's') + '</span></div>';
    var shortage = Number(summary.shortage_minutes || 0);
    els.capacityWarning.hidden = shortage <= 0;
    if (shortage > 0) {
      els.capacityWarning.innerHTML = '<strong>You are short by ' + escapeHtml(minutesLabel(shortage)) + '.</strong>This plan stays within your availability instead of overbooking you.<div class="capacity-fixes"><button type="button" data-capacity-fix="availability">Add availability</button><button type="button" data-capacity-fix="scope">Reduce scope</button><button type="button" data-capacity-fix="deadline">Change deadline</button></div>';
      queryAll('[data-capacity-fix]', els.capacityWarning).forEach(function (button) { button.addEventListener('click', function () { state.wizardStep = button.dataset.capacityFix === 'scope' ? 1 : button.dataset.capacityFix === 'deadline' ? 2 : 3; renderWizardStep(); }); });
    }
    els.previewSessions.innerHTML = (proposal.sessions || []).map(function (session) { return '<div class="preview-session"><time>' + escapeHtml(formatDate(session.date, { weekday: 'short', day: 'numeric', month: 'short' }) + ' · ' + session.time) + '</time><span>' + escapeHtml(session.title + ' · ' + minutesLabel(session.duration)) + '</span></div>'; }).join('') || '<div class="empty-plan-state">No sessions could be scheduled. Add availability or change the deadline.</div>';
  }
  async function applyWizardPlan() {
    if (!state.proposal) return;
    if (!isEditable()) { toast('Reconnect before accepting this plan.', 'error'); return; }
    els.wizardNext.disabled = true;
    els.wizardNext.textContent = 'Saving…';
    setSaving('saving');
    try {
      if (!state.applyIdempotencyKey) state.applyIdempotencyKey = randomId('idem');
      await api('/api/study-plan/apply', { method: 'POST', body: JSON.stringify({ proposal_id: state.proposal.proposal_id, idempotency_key: state.applyIdempotencyKey }) });
      closeOverlay(els.wizardOverlay);
      setSaving('', 'Saved');
      toast(state.wizardMode === 'rebalance' ? 'Catch-up plan accepted.' : 'Your study plan is ready.');
      await loadData({ useCache: false });
    } catch (error) {
      setSaving('failed');
      els.wizardNext.disabled = false;
      els.wizardNext.textContent = 'Try accepting again';
      toast(error.message, 'error');
    }
  }
  function nextWizardStep() {
    clearWizardErrors();
    if (state.wizardStep === 1) {
      if (!selectedWizardPacks().length) { els.wizardPackError.textContent = 'Select at least one study pack.'; els.wizardPackError.hidden = false; return; }
      state.wizardStep = 2;
    } else if (state.wizardStep === 2) {
      if (!els.wizardTitle.value.trim() || !validPickerDate(els.wizardDate.value) || els.wizardDate.value <= todayInTimezone()) { els.wizardGoalError.textContent = 'Enter a goal name and choose a future date.'; els.wizardGoalError.hidden = false; return; }
      state.wizardStep = 3;
    } else if (state.wizardStep === 3) {
      if (!availabilityForPreset().length) { els.wizardAvailabilityError.textContent = 'Add at least one availability window.'; els.wizardAvailabilityError.hidden = false; return; }
      previewWizard(); return;
    } else { applyWizardPlan(); return; }
    renderWizardStep();
  }

  function populateSessionEditorPacks(selected) {
    els.sessionPack.innerHTML = '<option value="">No linked pack</option>' + eligibleStudyPacks().map(function (pack) { return '<option value="' + escapeHtml(pack.study_pack_id) + '"' + (pack.study_pack_id === selected ? ' selected' : '') + '>' + escapeHtml(pack.title) + '</option>'; }).join('');
    refreshPrettySelect(els.sessionPack);
  }
  function openSessionEditor(session) {
    if (!isEditable()) { toast('Reconnect before changing a session.', 'error'); return; }
    var current = session || {};
    els.sessionId.value = current.id || '';
    els.sessionName.value = current.title || 'Study session';
    populateSessionEditorPacks(current.pack_id || '');
    els.sessionDate.value = current.date || todayInTimezone();
    els.sessionTime.value = current.time || '19:00';
    els.sessionDuration.value = current.duration || ((state.data.preferences || {}).default_session_minutes || 45);
    els.sessionLocked.checked = current.id ? !!current.locked : true;
    els.sessionError.hidden = true;
    els.sessionStatusActions.hidden = !current.id || current.status !== 'planned';
    openOverlay(els.sessionOverlay);
  }
  async function saveSession(statusOverride) {
    if (!isEditable()) { toast('Reconnect before changing a session.', 'error'); return; }
    var existingId = els.sessionId.value;
    var existing = plannedSessions().find(function (item) { return item.id === existingId; });
    var id = existingId || randomId('manual');
    var pack = packById(els.sessionPack.value);
    var payload = {
      revision: existing ? existing.revision : undefined,
      title: els.sessionName.value.trim(),
      pack_id: els.sessionPack.value,
      pack_title: pack ? pack.title : '',
      date: els.sessionDate.value,
      time: els.sessionTime.value,
      duration: Number(els.sessionDuration.value),
      locked: els.sessionLocked.checked,
      status: statusOverride || (existing ? existing.status : 'planned'),
      origin: existing ? existing.origin : 'manual',
      goal_id: existing ? existing.goal_id : ''
    };
    if (!payload.title || !validPickerDate(payload.date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(payload.time) || payload.duration < 5 || payload.duration > 360) {
      els.sessionError.textContent = 'Add a title, valid date, time, and duration between 5 and 360 minutes.';
      els.sessionError.hidden = false;
      return;
    }
    var previous = plannedSessions().slice();
    var optimistic = Object.assign({}, existing || {}, payload, { id: id, revision: existing ? existing.revision : 0 });
    state.data.sessions = previous.filter(function (item) { return item.id !== id; }).concat([optimistic]).sort(sortSessions);
    renderAll();
    closeOverlay(els.sessionOverlay);
    setSaving('saving');
    try {
      var result = await api('/api/study-plan/items/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify(payload) });
      state.data.sessions = state.data.sessions.filter(function (item) { return item.id !== id; }).concat([result.session]).sort(sortSessions);
      cacheData();
      renderAll();
      setSaving('', 'Saved');
      toast(statusOverride === 'completed' ? 'Session completed.' : statusOverride === 'skipped' ? 'Session skipped.' : 'Session saved.');
    } catch (error) {
      state.data.sessions = previous;
      renderAll();
      setSaving('failed');
      toast(error.message + ' Your visible change was undone.', 'error');
    }
  }
  function updateSessionStatus(session, status) {
    if (!session) return;
    if (!isEditable()) { toast('Reconnect before changing a session.', 'error'); return; }
    openSessionEditor(session);
    saveSession(status);
  }

  function openFeeds() { renderFeeds(); openOverlay(els.feedsOverlay); }
  function renderFeeds() {
    if (!els.feedList || !state.data) return;
    var feeds = state.data.calendar_feeds || [];
    els.feedList.innerHTML = feeds.length ? feeds.map(function (feed) {
      var revoked = Number(feed.revoked_at || 0) > 0;
      return '<div class="calendar-feed-item' + (revoked ? ' is-revoked' : '') + '" data-feed-id="' + escapeHtml(feed.feed_id) + '"><div><strong>' + escapeHtml(feed.name) + '</strong><span>' + (revoked ? 'Revoked' : 'Active · reminder ' + escapeHtml(minutesLabel(feed.reminder_offset_minutes))) + '</span></div>' + (!revoked ? '<div class="calendar-feed-actions"><button type="button" class="btn" data-feed-rotate>Rotate URL</button><button type="button" class="btn danger" data-feed-revoke>Revoke</button></div>' : '') + '</div>';
    }).join('') : '<div class="empty-plan-state">No device calendars connected.</div>';
    queryAll('[data-feed-id]', els.feedList).forEach(function (row) {
      var rotate = row.querySelector('[data-feed-rotate]');
      var revoke = row.querySelector('[data-feed-revoke]');
      if (rotate) rotate.addEventListener('click', function () { rotateFeed(row.dataset.feedId); });
      if (revoke) revoke.addEventListener('click', function () { revokeFeed(row.dataset.feedId); });
    });
  }
  function showFeedUrl(result) {
    els.feedOnce.hidden = false;
    els.feedUrl.value = result.subscription_url || '';
    els.feedUrl.focus();
    els.feedUrl.select();
  }
  async function createFeed() {
    if (!isEditable()) { toast('Reconnect before creating a calendar URL.', 'error'); return; }
    els.feedCreate.disabled = true;
    try {
      var result = await api('/api/study-plan/calendar-feeds', { method: 'POST', body: JSON.stringify({ name: els.feedName.value.trim() || 'Device calendar', reminder_offset_minutes: Number(els.feedReminder.value) }) });
      state.data.calendar_feeds = [result.feed].concat(state.data.calendar_feeds || []);
      renderFeeds(); showFeedUrl(result); cacheData();
    } catch (error) { toast(error.message, 'error'); }
    finally { els.feedCreate.disabled = false; }
  }
  async function rotateFeed(feedId) {
    if (!window.confirm('Rotate this private URL? The previous URL will stop working immediately.')) return;
    try {
      var result = await api('/api/study-plan/calendar-feeds/' + encodeURIComponent(feedId) + '/rotate', { method: 'POST', body: '{}' });
      showFeedUrl(result); toast('Private calendar URL rotated.');
    } catch (error) { toast(error.message, 'error'); }
  }
  async function revokeFeed(feedId) {
    if (!window.confirm('Revoke this calendar subscription? Its URL will stop working.')) return;
    try {
      var result = await api('/api/study-plan/calendar-feeds/' + encodeURIComponent(feedId), { method: 'DELETE' });
      state.data.calendar_feeds = (state.data.calendar_feeds || []).map(function (feed) { return feed.feed_id === feedId ? result.feed : feed; });
      renderFeeds(); cacheData(); toast('Calendar subscription revoked.');
    } catch (error) { toast(error.message, 'error'); }
  }

  function bindElements() {
    els.loading = byId('study-plan-loading'); els.workspace = byId('study-plan-workspace'); els.authGate = byId('study-plan-auth'); els.offline = byId('study-plan-offline'); els.saveState = byId('study-plan-save-state'); els.toast = byId('study-plan-toast');
    els.nextTime = byId('next-session-time'); els.nextContent = byId('next-session-content'); els.goalHealth = byId('goal-health-content'); els.todayList = byId('today-session-list'); els.rebalance = byId('rebalance-card'); els.rebalanceMessage = byId('rebalance-message');
    els.weekTitle = byId('schedule-week-title'); els.weekSummary = byId('schedule-week-summary'); els.scheduleHelp = byId('schedule-help'); els.weekCalendar = byId('week-calendar'); els.mobileAgenda = byId('mobile-agenda');
    els.progressSummary = byId('progress-summary-grid'); els.timeChart = byId('time-progress-chart'); els.goalProgress = byId('goal-progress-list');
    els.wizardOverlay = byId('plan-wizard-overlay'); els.wizardPackList = byId('wizard-pack-list'); els.wizardPackSearch = byId('wizard-pack-search'); els.wizardPackSelectionSummary = byId('wizard-pack-selection-summary'); els.wizardPersonalPaceNote = byId('wizard-personal-pace-note'); els.wizardPackError = byId('wizard-pack-error'); els.wizardGoalError = byId('wizard-goal-error'); els.wizardAvailabilityError = byId('wizard-availability-error'); els.wizardTitle = byId('wizard-goal-title'); els.wizardDate = byId('wizard-exam-date'); els.wizardSessionLength = byId('wizard-session-length'); els.customAvailability = byId('custom-availability'); els.wizardBack = byId('wizard-back-btn'); els.wizardNext = byId('wizard-next-btn'); els.previewSummary = byId('wizard-preview-summary'); els.capacityWarning = byId('wizard-capacity-warning'); els.previewSessions = byId('wizard-preview-sessions');
    els.sessionOverlay = byId('session-editor-overlay'); els.sessionId = byId('session-editor-id'); els.sessionName = byId('session-editor-name'); els.sessionPack = byId('session-editor-pack'); els.sessionDate = byId('session-editor-date'); els.sessionTime = byId('session-editor-time'); els.sessionDuration = byId('session-editor-duration'); els.sessionLocked = byId('session-editor-locked'); els.sessionError = byId('session-editor-error'); els.sessionStatusActions = byId('session-editor-status-actions');
    els.feedsOverlay = byId('calendar-feeds-overlay'); els.feedName = byId('calendar-feed-name'); els.feedReminder = byId('calendar-feed-reminder'); els.feedCreate = byId('calendar-feed-create-btn'); els.feedOnce = byId('calendar-feed-once'); els.feedUrl = byId('calendar-feed-url'); els.feedList = byId('calendar-feed-list');
  }
  function bindActions() {
    queryAll('.study-plan-tab').forEach(function (button) { button.addEventListener('click', function () { setView(button.dataset.planView); }); });
    byId('new-study-goal-btn').addEventListener('click', function () { openWizard(); });
    byId('today-add-session-btn').addEventListener('click', function () { openSessionEditor(null); });
    byId('schedule-add-session-btn').addEventListener('click', function () { openSessionEditor(null); });
    byId('review-rebalance-btn').addEventListener('click', function () { var goal = activeGoals()[0]; if (goal) openWizard({ goalId: goal.goal_id }); });
    byId('schedule-prev-week').addEventListener('click', function () { state.weekStart = addDays(state.weekStart, -7); loadData({ useCache: false }); });
    byId('schedule-next-week').addEventListener('click', function () { state.weekStart = addDays(state.weekStart, 7); loadData({ useCache: false }); });
    byId('schedule-this-week').addEventListener('click', function () { state.weekStart = startOfWeek(new Date()); loadData({ useCache: false }); });
    [byId('calendar-connections-btn'), byId('progress-calendar-connections-btn')].forEach(function (button) { button.addEventListener('click', openFeeds); });
    byId('plan-wizard-close').addEventListener('click', function () { closeOverlay(els.wizardOverlay); });
    els.wizardBack.addEventListener('click', function () { if (state.wizardStep > 1) { state.wizardStep -= 1; renderWizardStep(); } });
    els.wizardNext.addEventListener('click', nextWizardStep);
    els.wizardPackSearch.addEventListener('input', function () { state.packSearch = els.wizardPackSearch.value; renderWizardPacks(); });
    queryAll('[data-pack-filter]').forEach(function (button) { button.addEventListener('click', function () { state.packFilter = button.dataset.packFilter; queryAll('[data-pack-filter]').forEach(function (candidate) { var active = candidate === button; candidate.classList.toggle('is-active', active); candidate.setAttribute('aria-pressed', active ? 'true' : 'false'); }); renderWizardPacks(); }); });
    queryAll('[data-availability-preset]').forEach(function (button) { button.addEventListener('click', function () { chooseAvailabilityPreset(button.dataset.availabilityPreset); }); });
    [byId('session-editor-close'), byId('session-editor-cancel')].forEach(function (button) { button.addEventListener('click', function () { closeOverlay(els.sessionOverlay); }); });
    byId('session-editor-save').addEventListener('click', function () { saveSession(); });
    queryAll('[data-session-status]', els.sessionStatusActions).forEach(function (button) { button.addEventListener('click', function () { saveSession(button.dataset.sessionStatus); }); });
    byId('calendar-feeds-close').addEventListener('click', function () { closeOverlay(els.feedsOverlay); });
    els.feedCreate.addEventListener('click', createFeed);
    byId('calendar-feed-copy').addEventListener('click', async function () { try { await navigator.clipboard.writeText(els.feedUrl.value); toast('Calendar URL copied.'); } catch (_) { els.feedUrl.select(); toast('Select and copy the URL.'); } });
    [els.wizardOverlay, els.sessionOverlay, els.feedsOverlay].forEach(function (overlay) { overlay.addEventListener('click', function (event) { if (event.target === overlay) closeOverlay(overlay); }); });
    document.addEventListener('click', function (event) { if (activeControlPopover && !activeControlPopover.panel.contains(event.target) && !activeControlPopover.anchor.contains(event.target)) closeControlPopover(false); });
    window.addEventListener('resize', function () { closeControlPopover(false); });
    window.addEventListener('scroll', function (event) { if (activeControlPopover && !activeControlPopover.panel.contains(event.target)) closeControlPopover(false); }, true);
    window.addEventListener('online', function () { setOfflineState(); loadData({ useCache: false }); });
    window.addEventListener('offline', setOfflineState);
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      if (closeControlPopover(true)) { event.preventDefault(); return; }
      var open = [els.feedsOverlay, els.sessionOverlay, els.wizardOverlay].find(function (overlay) { return overlay && !overlay.hidden; });
      if (open) { event.preventDefault(); closeOverlay(open); }
    });
  }

  function init() {
    bindElements(); enhancePrettySelects(document); enhancePlanPickers(document); bindActions(); renderCustomAvailability();
    var requestedView = new URLSearchParams(window.location.search).get('view');
    state.view = ['today', 'schedule', 'progress'].indexOf(requestedView) >= 0 ? requestedView : 'today';
    setOfflineState();
    if (!bootstrap.onAuthStateReady) return;
    bootstrap.onAuthStateReady(auth, async function (user) {
      state.user = user;
      if (!user) {
        if (authClient) authClient.clearToken();
        els.loading.hidden = true; els.workspace.hidden = true; els.authGate.hidden = false;
        return;
      }
      els.authGate.hidden = true;
      try { authClient.setToken(await user.getIdToken()); } catch (_) {}
      await loadData({ useCache: true });
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
