    const bootstrap = window.LectureProcessorBootstrap || {};
    const auth = bootstrap.getAuth ? bootstrap.getAuth() : firebase.auth();
    const authUtils = window.LectureProcessorAuth || {};
    const authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Not signed in' }) : null;
    const uxUtils = window.LectureProcessorUx || {};

    const weekGrid = document.getElementById('week-grid');
    const weekTitle = document.getElementById('week-title');
    const weekSubtitle = document.getElementById('week-subtitle');
    const prevWeekBtn = document.getElementById('prev-week-btn');
    const nextWeekBtn = document.getElementById('next-week-btn');
    const todayWeekBtn = document.getElementById('today-week-btn');
    const addSessionBtn = document.getElementById('add-session-btn');
    const authRequiredEl = document.getElementById('auth-required');
    const calendarLayoutEl = document.getElementById('calendar-layout');
    const emptyWeekEl = document.getElementById('calendar-empty-week');
    const toastEl = document.getElementById('toast');

    const modalOverlay = document.getElementById('session-modal-overlay');
    const modalCard = document.getElementById('session-modal-card');
    const modalTitleEl = document.getElementById('session-modal-title');
    const modalCloseBtn = document.getElementById('session-modal-close');
    const modalCancelBtn = document.getElementById('session-cancel-btn');
    const modalSaveBtn = document.getElementById('session-save-btn');
    const sessionTitleEl = document.getElementById('session-title');
    const sessionDateEl = document.getElementById('session-date');
    const sessionTimeEl = document.getElementById('session-time');
    const sessionDurationEl = document.getElementById('session-duration');
    const sessionNotesEl = document.getElementById('session-notes');
    const sessionPackIdEl = document.getElementById('session-pack-id');
    const sessionPackMenu = document.getElementById('session-pack-menu');

    const notifyEnabledEl = document.getElementById('notify-enabled');
    const notifyOffsetEl = document.getElementById('notify-offset');
    const dailyReminderEnabledEl = document.getElementById('daily-reminder-enabled');
    const dailyReminderTimeEl = document.getElementById('daily-reminder-time');
    const dailyReminderTimeRow = document.getElementById('daily-reminder-time-row');

    let currentUser = null;
    let idToken = '';
    let weekStart = startOfWeek(new Date());
    let sessions = [];
    let studyPacks = [];
    let plannerSettings = defaultPlannerSettings();
    let localReminderState = { notified: {} };
    let editingSessionId = '';
    let reminderTimer = null;
    let reminderSaveDebounceTimer = null;
    let sessionDatePicker = null;
    let sessionTimePicker = null;

    function showToast(msg, type) {
      toastEl.textContent = msg;
      toastEl.className = 'toast visible' + (type ? ' ' + type : '');
      setTimeout(() => toastEl.className = 'toast', 2400);
    }

    function localDateString(d) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    }

    function startOfWeek(date) {
      const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
      const day = d.getDay();
      const diff = day === 0 ? -6 : 1 - day;
      d.setDate(d.getDate() + diff);
      return d;
    }

    function addDays(date, n) {
      const d = new Date(date.getTime());
      d.setDate(d.getDate() + n);
      return d;
    }

    function formatLocaleDate(date, options) {
      if (typeof uxUtils.formatDate === 'function') {
        return uxUtils.formatDate(date, { intlOptions: options });
      }
      try {
        const locales = (Array.isArray(navigator.languages) && navigator.languages.length)
          ? navigator.languages.filter(Boolean)
          : (navigator.language || 'en-US');
        return new Intl.DateTimeFormat(locales, options).format(date);
      } catch (_) {
        return new Intl.DateTimeFormat('en-US', options).format(date);
      }
    }

    function formatDayName(date) {
      return formatLocaleDate(date, { weekday: 'short' });
    }

    function formatLongDate(date) {
      return formatLocaleDate(date, { day: '2-digit', month: 'short', year: 'numeric' });
    }

    function formatTimeDisplay(value) {
      if (!/^\d{2}:\d{2}$/.test(String(value || ''))) return '00:00';
      return String(value);
    }

    function getIsoWeekNumber(date) {
      const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
      const day = target.getUTCDay() || 7;
      target.setUTCDate(target.getUTCDate() + 4 - day);
      const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
      return Math.ceil((((target - yearStart) / 86400000) + 1) / 7);
    }

    function defaultPlannerSettings() {
      return { enabled: 'off', offset: '30', daily_enabled: 'on', daily_time: '19:00', updated_at: 0 };
    }

    function normalizePlannerSettings(raw) {
      const payload = raw && typeof raw === 'object' ? raw : {};
      return {
        enabled: payload.enabled === 'on' ? 'on' : 'off',
        offset: ['5', '10', '15', '30', '60'].includes(String(payload.offset || '30')) ? String(payload.offset || '30') : '30',
        daily_enabled: payload.daily_enabled === 'off' ? 'off' : 'on',
        daily_time: /^\d{2}:\d{2}$/.test(String(payload.daily_time || '')) ? String(payload.daily_time) : '19:00',
        updated_at: Number(payload.updated_at || 0) || 0
      };
    }

    function getLegacySessionStorageKey() {
      return `study_sessions_${currentUser ? currentUser.uid : 'anon'}`;
    }

    function getLegacyReminderStorageKey() {
      return `study_reminders_${currentUser ? currentUser.uid : 'anon'}`;
    }

    function getLocalReminderStateKey() {
      return `study_reminder_local_${currentUser ? currentUser.uid : 'anon'}`;
    }

    function getPlannerMigrationKey() {
      return `planner_remote_migrated_${currentUser ? currentUser.uid : 'anon'}`;
    }

    function authFetch(path, options) {
      if (authClient && typeof authClient.authFetch === 'function') {
        return authClient.authFetch(path, options, { retryOn401: true });
      }
      if (!idToken) return Promise.reject(new Error('Not signed in'));
      const opts = options || {};
      const headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + idToken });
      return fetch(path, Object.assign({}, opts, { headers }));
    }

    function loadLegacySessions() {
      try {
        const parsed = JSON.parse(localStorage.getItem(getLegacySessionStorageKey()) || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        return [];
      }
    }

    function loadLegacyReminderSettings() {
      const fallback = Object.assign({}, defaultPlannerSettings(), { notified: {} });
      try {
        const parsed = JSON.parse(localStorage.getItem(getLegacyReminderStorageKey()) || '{}');
        const settings = Object.assign({}, fallback, parsed || {});
        settings.notified = settings.notified && typeof settings.notified === 'object' ? settings.notified : {};
        return Object.assign({}, normalizePlannerSettings(settings), { notified: settings.notified });
      } catch (_) {
        return fallback;
      }
    }

    function loadLocalReminderState() {
      const fallback = { notified: {} };
      try {
        const parsed = JSON.parse(localStorage.getItem(getLocalReminderStateKey()) || '{}');
        if (parsed && typeof parsed === 'object' && parsed.notified && typeof parsed.notified === 'object') {
          return { notified: parsed.notified };
        }
      } catch (_) {}
      const legacy = loadLegacyReminderSettings();
      if (legacy.notified && typeof legacy.notified === 'object' && Object.keys(legacy.notified).length) {
        const migrated = { notified: legacy.notified };
        saveLocalReminderState(migrated);
        return migrated;
      }
      return fallback;
    }

    function saveLocalReminderState(state) {
      const safeState = state && typeof state === 'object' ? state : {};
      localStorage.setItem(getLocalReminderStateKey(), JSON.stringify({
        notified: safeState.notified && typeof safeState.notified === 'object' ? safeState.notified : {}
      }));
    }

    function hasPlannerMigrationSentinel() {
      try {
        return localStorage.getItem(getPlannerMigrationKey()) === '1';
      } catch (_) {
        return false;
      }
    }

    function markPlannerMigrated() {
      try {
        localStorage.setItem(getPlannerMigrationKey(), '1');
      } catch (_) {}
    }

    function hasPlannerSettingsData(settings) {
      const safe = normalizePlannerSettings(settings);
      return (
        safe.enabled !== 'off' ||
        safe.offset !== '30' ||
        safe.daily_enabled !== 'on' ||
        safe.daily_time !== '19:00' ||
        Number(safe.updated_at || 0) > 0
      );
    }

    async function fetchPlannerSettings() {
      const response = await authFetch('/api/planner/settings');
      if (!response.ok) throw new Error('Could not load planner settings');
      const payload = await response.json();
      return normalizePlannerSettings(payload);
    }

    async function savePlannerSettingsRemote(settings) {
      const payload = normalizePlannerSettings(settings);
      const response = await authFetch('/api/planner/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(data.error || 'Could not save reminder settings'));
      }
      return normalizePlannerSettings(Object.assign({}, payload, data.settings || {}, { updated_at: data.updated_at || payload.updated_at || Date.now() / 1000 }));
    }

    async function fetchPlannerSessions(limit) {
      const safeLimit = Math.max(1, Math.min(200, parseInt(limit || '200', 10) || 200));
      const response = await authFetch('/api/planner/sessions?limit=' + safeLimit);
      if (!response.ok) throw new Error('Could not load planner sessions');
      const payload = await response.json();
      return Array.isArray(payload.sessions) ? payload.sessions : [];
    }

    async function savePlannerSessionRemote(payload) {
      const safeId = encodeURIComponent(String(payload && payload.id ? payload.id : ''));
      const response = await authFetch('/api/planner/sessions/' + safeId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {})
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(data.error || 'Could not save study session'));
      }
      return data.session || payload;
    }

    async function deletePlannerSessionRemote(sessionId) {
      const response = await authFetch('/api/planner/sessions/' + encodeURIComponent(String(sessionId || '')), {
        method: 'DELETE'
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(data.error || 'Could not delete study session'));
      }
      return true;
    }

    function hasLegacyPlannerData(legacySessions, legacySettings) {
      return (Array.isArray(legacySessions) && legacySessions.length > 0) || hasPlannerSettingsData(legacySettings);
    }

    async function migrateLegacyPlannerIfNeeded(remoteSessions, remoteSettings) {
      const legacySessions = loadLegacySessions();
      const legacySettings = loadLegacyReminderSettings();
      const localState = loadLocalReminderState();
      if (
        hasPlannerMigrationSentinel() ||
        remoteSessions.length > 0 ||
        hasPlannerSettingsData(remoteSettings) ||
        !hasLegacyPlannerData(legacySessions, legacySettings)
      ) {
        localReminderState = localState;
        return { sessions: remoteSessions, settings: remoteSettings };
      }

      for (const session of legacySessions) {
        await savePlannerSessionRemote(session);
      }
      plannerSettings = await savePlannerSettingsRemote(legacySettings);
      localReminderState = { notified: localState.notified || legacySettings.notified || {} };
      saveLocalReminderState(localReminderState);
      markPlannerMigrated();
      try {
        localStorage.removeItem(getLegacySessionStorageKey());
      } catch (_) {}
      return {
        sessions: await fetchPlannerSessions(200),
        settings: plannerSettings
      };
    }

    async function loadPlannerState() {
      if (!currentUser) {
        sessions = [];
        plannerSettings = defaultPlannerSettings();
        localReminderState = { notified: {} };
        return;
      }
      const [settings, remoteSessions] = await Promise.all([
        fetchPlannerSettings(),
        fetchPlannerSessions(200)
      ]);
      localReminderState = loadLocalReminderState();
      const migrated = await migrateLegacyPlannerIfNeeded(remoteSessions, settings);
      plannerSettings = normalizePlannerSettings(migrated.settings);
      sessions = Array.isArray(migrated.sessions) ? migrated.sessions.slice() : [];
    }

    function initAppSelect(selectRoot, onChange) {
      if (!selectRoot) return;
      const button = selectRoot.querySelector('.app-select-button');
      const menu = selectRoot.querySelector('.app-select-menu');
      const label = selectRoot.querySelector('.app-select-label');
      const hidden = selectRoot.querySelector('input[type="hidden"]');
      if (!button || !menu) return;

      if (!selectRoot.id) {
        selectRoot.id = 'app-select-' + Math.random().toString(36).slice(2, 8);
      }
      if (!button.id) button.id = selectRoot.id + '-button';
      if (!menu.id) menu.id = selectRoot.id + '-menu';
      button.setAttribute('aria-haspopup', 'listbox');
      button.setAttribute('aria-controls', menu.id);
      button.setAttribute('aria-expanded', 'false');
      menu.setAttribute('role', 'listbox');
      menu.setAttribute('aria-labelledby', button.id);

      function getItems() {
        return Array.from(menu.querySelectorAll('.app-select-item[data-value]'));
      }

      function focusItem(target) {
        const items = getItems().filter((item) => !item.disabled);
        if (!items.length) return;
        const currentIndex = items.indexOf(document.activeElement);
        const activeIndex = Math.max(0, items.findIndex((item) => item.classList.contains('active')));
        let nextIndex = activeIndex;
        if (target === 'first') nextIndex = 0;
        if (target === 'last') nextIndex = items.length - 1;
        if (target === 'next') nextIndex = currentIndex >= 0 ? (currentIndex + 1) % items.length : activeIndex;
        if (target === 'prev') nextIndex = currentIndex >= 0 ? (currentIndex - 1 + items.length) % items.length : activeIndex;
        items.forEach((item) => { item.tabIndex = -1; });
        items[nextIndex].tabIndex = 0;
        items[nextIndex].focus();
      }

      function setMenuOpen(open, focusTarget) {
        menu.classList.toggle('visible', !!open);
        button.classList.toggle('open', !!open);
        button.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
          focusItem(focusTarget || 'active');
        }
      }

      function setValue(value, silent) {
        if (hidden) hidden.value = value;
        let activeText = '';
        getItems().forEach((item) => {
          item.setAttribute('role', 'option');
          const isActive = item.getAttribute('data-value') === value;
          item.classList.toggle('active', isActive);
          item.setAttribute('aria-selected', isActive ? 'true' : 'false');
          item.tabIndex = -1;
          if (isActive) activeText = item.textContent;
        });
        if (label) label.textContent = activeText || (menu.querySelector('.app-select-item') ? menu.querySelector('.app-select-item').textContent : '');
        if (!silent && typeof onChange === 'function') onChange(value);
      }

      button.addEventListener('click', (e) => {
        e.preventDefault();
        const open = !menu.classList.contains('visible');
        closeAllSelectMenus();
        if (open) setMenuOpen(true);
      });

      button.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          closeAllSelectMenus();
          setMenuOpen(true, 'first');
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          closeAllSelectMenus();
          setMenuOpen(true, 'last');
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const open = !menu.classList.contains('visible');
          closeAllSelectMenus();
          if (open) setMenuOpen(true);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setMenuOpen(false);
        }
      });

      menu.addEventListener('click', (e) => {
        const item = e.target.closest('.app-select-item[data-value]');
        if (!item) return;
        setValue(item.getAttribute('data-value'));
        setMenuOpen(false);
        button.focus();
      });

      menu.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          focusItem('next');
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          focusItem('prev');
        } else if (e.key === 'Home') {
          e.preventDefault();
          focusItem('first');
        } else if (e.key === 'End') {
          e.preventDefault();
          focusItem('last');
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          const item = document.activeElement && document.activeElement.closest('.app-select-item[data-value]');
          if (!item) return;
          setValue(item.getAttribute('data-value'));
          setMenuOpen(false);
          button.focus();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setMenuOpen(false);
          button.focus();
        } else if (e.key === 'Tab') {
          setMenuOpen(false);
        }
      });

      const initial = hidden ? hidden.value : ((menu.querySelector('.app-select-item.active') || menu.querySelector('.app-select-item')) && (menu.querySelector('.app-select-item.active') || menu.querySelector('.app-select-item')).getAttribute('data-value'));
      if (initial) setValue(initial, true);

      selectRoot._setValue = (value, silent) => setValue(String(value || ''), !!silent);
      selectRoot._getValue = () => (hidden ? String(hidden.value || '') : '');
      selectRoot._setMenuOpen = (open, focusTarget) => setMenuOpen(!!open, focusTarget);
    }

    function buildDailyTimeOptions() {
      const menu = document.getElementById('daily-reminder-time-menu');
      if (!menu) return;
      while (menu.firstChild) menu.removeChild(menu.firstChild);
      for (let h = 0; h < 24; h++) {
        for (let m = 0; m < 60; m += 15) {
          const value = String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'app-select-item';
          button.dataset.value = value;
          button.textContent = value;
          menu.appendChild(button);
        }
      }
    }

    function closeAllSelectMenus() {
      document.querySelectorAll('.app-select').forEach((selectRoot) => {
        if (typeof selectRoot._setMenuOpen === 'function') {
          selectRoot._setMenuOpen(false);
        }
      });
    }

    function loadReminderSettings() {
      return Object.assign({}, plannerSettings, {
        notified: localReminderState && localReminderState.notified && typeof localReminderState.notified === 'object'
          ? localReminderState.notified
          : {}
      });
    }

    function saveReminderSettings(settings) {
      plannerSettings = normalizePlannerSettings(settings);
      localReminderState = {
        notified: settings && settings.notified && typeof settings.notified === 'object'
          ? settings.notified
          : {}
      };
      saveLocalReminderState(localReminderState);
    }

    function toggleDailyReminderTimeInput() {
      const enabled = dailyReminderEnabledEl.value === 'on';
      const selectButton = dailyReminderTimeRow ? dailyReminderTimeRow.querySelector('.app-select-button') : null;
      if (selectButton) {
        selectButton.disabled = !enabled;
        selectButton.style.pointerEvents = enabled ? '' : 'none';
      }
      dailyReminderTimeRow.classList.toggle('disabled-row', !enabled);
    }

    function initPickers() {
      if (typeof flatpickr === 'undefined') return;
      if (!sessionDatePicker) {
        sessionDatePicker = flatpickr(sessionDateEl, {
          dateFormat: 'Y-m-d',
          altInput: true,
          altFormat: 'd-m-Y',
          altInputClass: 'input',
          disableMobile: true,
          locale: { firstDayOfWeek: 1 },
          allowInput: true,
          defaultDate: localDateString(new Date())
        });
      }
      if (!sessionTimePicker) {
        sessionTimePicker = flatpickr(sessionTimeEl, {
          enableTime: true,
          noCalendar: true,
          dateFormat: 'H:i',
          time_24hr: true,
          disableMobile: true,
          allowInput: true,
          defaultDate: '19:00'
        });
      }
    }

    function renderPackSelectOptions(selectedPackId) {
      if (!sessionPackMenu) return;
      const safeSelected = String(selectedPackId || '');
      const options = [{ value: '', label: 'No linked study pack' }].concat((studyPacks || []).map((p) => ({ value: String(p.study_pack_id || ''), label: p.title || 'Untitled pack' })));
      while (sessionPackMenu.firstChild) sessionPackMenu.removeChild(sessionPackMenu.firstChild);
      options.forEach((opt) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'app-select-item' + (opt.value === safeSelected ? ' active' : '');
        button.dataset.value = String(opt.value || '');
        button.textContent = String(opt.label || '');
        sessionPackMenu.appendChild(button);
      });
      if (sessionPackSelect && typeof sessionPackSelect._setValue === 'function') {
        sessionPackSelect._setValue(safeSelected, true);
      }
    }

    function getPackById(packId) {
      const id = String(packId || '');
      return (studyPacks || []).find((p) => String(p.study_pack_id || '') === id) || null;
    }

    function getStudyUrlForSession(session) {
      const packId = String(session && session.pack_id ? session.pack_id : '');
      if (!packId) return '/study';
      return '/study?pack_id=' + encodeURIComponent(packId) + '&mode=learn';
    }

    function openStudySession(session, openInNewTab) {
      const url = getStudyUrlForSession(session);
      if (openInNewTab) {
        window.open(url, '_blank', 'noopener');
      } else {
        window.location.href = url;
      }
    }

    async function loadStudyPacks() {
      if (!idToken) {
        studyPacks = [];
        renderPackSelectOptions('');
        return;
      }
      try {
        const response = await authFetch('/api/study-packs');
        if (!response.ok) throw new Error('Could not load study packs');
        const data = await response.json();
        studyPacks = Array.isArray(data.study_packs) ? data.study_packs : [];
      } catch (_) {
        studyPacks = [];
      }
      renderPackSelectOptions(sessionPackIdEl.value || '');
    }

    function openModal(editSession) {
      editingSessionId = editSession ? editSession.id : '';
      modalTitleEl.textContent = editingSessionId ? 'Edit Study Session' : 'Add Study Session';
      sessionTitleEl.value = editSession ? (editSession.title || '') : '';
      sessionDurationEl.value = editSession ? String(editSession.duration || 60) : '60';
      sessionNotesEl.value = editSession ? (editSession.notes || '') : '';
      sessionPackIdEl.value = editSession ? String(editSession.pack_id || '') : '';
      renderPackSelectOptions(sessionPackIdEl.value);

      const dateValue = editSession ? String(editSession.date || localDateString(new Date())) : localDateString(new Date());
      const timeValue = editSession ? String(editSession.time || '19:00') : '19:00';
      if (sessionDatePicker) sessionDatePicker.setDate(dateValue, true, 'Y-m-d');
      else sessionDateEl.value = dateValue;
      if (sessionTimePicker) sessionTimePicker.setDate(timeValue, true, 'H:i');
      else sessionTimeEl.value = timeValue;

      if (typeof uxUtils.openModalOverlay === 'function') {
        uxUtils.openModalOverlay(modalOverlay, {
          openClass: 'visible',
          initialFocus: sessionTitleEl,
          onRequestClose: () => closeModal(),
        });
      } else {
        modalOverlay.hidden = false;
        modalOverlay.setAttribute('aria-hidden', 'false');
        modalOverlay.classList.add('visible');
        setTimeout(() => sessionTitleEl.focus(), 30);
      }
    }

    function closeModal() {
      if (typeof uxUtils.closeModalOverlay === 'function') {
        uxUtils.closeModalOverlay(modalOverlay, {
          openClass: 'visible',
        });
      } else {
        modalOverlay.classList.remove('visible');
        modalOverlay.hidden = true;
        modalOverlay.setAttribute('aria-hidden', 'true');
        if (addSessionBtn) addSessionBtn.focus();
      }
      editingSessionId = '';
      closeAllSelectMenus();
    }

    function sessionToTimestamp(session) {
      return new Date(`${session.date}T${session.time}:00`).getTime();
    }

    function visibleWeekSessionCount() {
      let total = 0;
      for (let i = 0; i < 7; i++) {
        const dayKey = localDateString(addDays(weekStart, i));
        total += sessions.filter((session) => session.date === dayKey).length;
      }
      return total;
    }

    function updateEmptyWeekState() {
      if (!emptyWeekEl) return;
      const shouldShow = !!currentUser && visibleWeekSessionCount() === 0;
      emptyWeekEl.hidden = !shouldShow;
    }

    function renderWeek() {
      const end = addDays(weekStart, 6);
      weekTitle.textContent = `${formatLongDate(weekStart)} - ${formatLongDate(end)}`;
      if (weekSubtitle) {
        weekSubtitle.textContent = 'Week ' + String(getIsoWeekNumber(weekStart)).padStart(2, '0');
      }
      while (weekGrid.firstChild) weekGrid.removeChild(weekGrid.firstChild);
      const today = localDateString(new Date());

      for (let i = 0; i < 7; i++) {
        const dayDate = addDays(weekStart, i);
        const dayKey = localDateString(dayDate);
        const col = document.createElement('div');
        col.className = 'day-col' + (dayKey === today ? ' today' : '');
        const daySessions = sessions
          .filter((s) => s.date === dayKey)
          .sort((a, b) => sessionToTimestamp(a) - sessionToTimestamp(b));
        const dayHead = document.createElement('div');
        dayHead.className = 'day-head';
        const dayName = document.createElement('div');
        dayName.className = 'day-name';
        dayName.textContent = formatDayName(dayDate);
        const dayDateEl = document.createElement('div');
        dayDateEl.className = 'day-date';
        dayDateEl.textContent = String(dayDate.getDate());
        dayHead.appendChild(dayName);
        dayHead.appendChild(dayDateEl);

        const dayEvents = document.createElement('div');
        dayEvents.className = 'day-events';

        if (!daySessions.length) {
          const empty = document.createElement('div');
          empty.className = 'empty-day';
          empty.textContent = 'No sessions planned.';
          dayEvents.appendChild(empty);
        } else {
          daySessions.forEach((session) => {
            const duration = parseInt(session.duration, 10) || 60;
            const sessionId = String(session.id || '');

            const card = document.createElement('div');
            card.className = 'event-card';
            card.dataset.sessionId = sessionId;

            const title = document.createElement('div');
            title.className = 'event-title';
            title.textContent = String(session.title || 'Study session');
            card.appendChild(title);

            const meta = document.createElement('div');
            meta.className = 'event-meta';
            const timeSpan = document.createElement('span');
            timeSpan.textContent = formatTimeDisplay(session.time || '19:00');
            const durationSpan = document.createElement('span');
            durationSpan.textContent = `${duration} min`;
            meta.appendChild(timeSpan);
            meta.appendChild(durationSpan);
            card.appendChild(meta);

            if (session.pack_title) {
              const packMeta = document.createElement('div');
              packMeta.className = 'event-meta';
              const packStrong = document.createElement('strong');
              packStrong.textContent = 'Pack:';
              packMeta.appendChild(packStrong);
              packMeta.appendChild(document.createTextNode(` ${String(session.pack_title)}`));
              card.appendChild(packMeta);
            }

            if (session.notes) {
              const notesMeta = document.createElement('div');
              notesMeta.className = 'event-meta';
              notesMeta.textContent = String(session.notes);
              card.appendChild(notesMeta);
            }

            const actions = document.createElement('div');
            actions.className = 'event-actions';
            const openBtn = document.createElement('button');
            openBtn.type = 'button';
            openBtn.className = 'mini-btn primary';
            openBtn.dataset.openSession = sessionId;
            openBtn.textContent = 'Open';
            const editBtn = document.createElement('button');
            editBtn.type = 'button';
            editBtn.className = 'mini-btn';
            editBtn.dataset.editSession = sessionId;
            editBtn.textContent = 'Edit';
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'mini-btn danger';
            deleteBtn.dataset.deleteSession = sessionId;
            deleteBtn.textContent = 'Delete';
            actions.appendChild(openBtn);
            actions.appendChild(editBtn);
            actions.appendChild(deleteBtn);
            card.appendChild(actions);
            dayEvents.appendChild(card);
          });
        }

        col.appendChild(dayHead);
        col.appendChild(dayEvents);
        weekGrid.appendChild(col);
      }
      updateEmptyWeekState();
    }

    async function saveSessionFromModal() {
      const title = String(sessionTitleEl.value || '').trim();
      const date = String(sessionDateEl.value || '').trim();
      const time = String(sessionTimeEl.value || '').trim();
      const duration = parseInt(sessionDurationEl.value || '0', 10);
      const notes = String(sessionNotesEl.value || '').trim();
      const packId = String(sessionPackIdEl.value || '');
      const pack = getPackById(packId);

      if (!title) {
        showToast('Session title is required.', 'error');
        sessionTitleEl.focus();
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        showToast('Choose a valid session date.', 'error');
        sessionDateEl.focus();
        return;
      }
      if (!/^\d{2}:\d{2}$/.test(time)) {
        showToast('Choose a valid start time.', 'error');
        sessionTimeEl.focus();
        return;
      }
      if (!Number.isFinite(duration) || duration < 5 || duration > 360) {
        showToast('Duration must be between 5 and 360 minutes.', 'error');
        sessionDurationEl.focus();
        return;
      }

      const payload = {
        id: editingSessionId || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
        title,
        date,
        time,
        duration,
        notes,
        pack_id: packId,
        pack_title: pack ? (pack.title || 'Untitled pack') : ''
      };

      modalSaveBtn.disabled = true;
      try {
        const saved = await savePlannerSessionRemote(payload);
        if (editingSessionId) sessions = sessions.map((s) => (s.id === editingSessionId ? saved : s));
        else sessions.push(saved);
        closeModal();
        renderWeek();
        showToast(editingSessionId ? 'Session updated.' : 'Session added.', 'success');
      } catch (error) {
        showToast(error && error.message ? error.message : 'Could not save session.', 'error');
      } finally {
        modalSaveBtn.disabled = false;
      }
    }

    async function deleteSession(sessionId) {
      try {
        await deletePlannerSessionRemote(sessionId);
        sessions = sessions.filter((s) => s.id !== sessionId);
        renderWeek();
        showToast('Session removed.', 'success');
      } catch (error) {
        showToast(error && error.message ? error.message : 'Could not delete session.', 'error');
      }
    }

    function applyReminderSettingsToUI() {
      const settings = loadReminderSettings();
      if (notifyEnabledSelect && notifyEnabledSelect._setValue) notifyEnabledSelect._setValue(settings.enabled, true);
      if (notifyOffsetSelect && notifyOffsetSelect._setValue) notifyOffsetSelect._setValue(settings.offset, true);
      if (dailyReminderEnabledSelect && dailyReminderEnabledSelect._setValue) dailyReminderEnabledSelect._setValue(settings.daily_enabled, true);

      if (dailyReminderTimeSelect && dailyReminderTimeSelect._setValue) {
        dailyReminderTimeSelect._setValue(settings.daily_time || '19:00', true);
      } else {
        dailyReminderTimeEl.value = settings.daily_time || '19:00';
      }
      toggleDailyReminderTimeInput();
    }

    async function saveReminderSettingsFromUI(options = {}) {
      const settings = loadReminderSettings();
      let suppressSuccessToast = !!options.silent;
      settings.enabled = notifyEnabledEl.value === 'on' ? 'on' : 'off';
      settings.offset = String(parseInt(notifyOffsetEl.value || '30', 10) || 30);
      settings.daily_enabled = dailyReminderEnabledEl.value === 'off' ? 'off' : 'on';
      settings.daily_time = settings.daily_enabled === 'on' ? String(dailyReminderTimeEl.value || '19:00') : '';

      if (settings.enabled === 'on' && typeof Notification !== 'undefined' && Notification.permission !== 'granted') {
        try {
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') {
            settings.enabled = 'off';
            if (notifyEnabledSelect && notifyEnabledSelect._setValue) notifyEnabledSelect._setValue('off', true);
            showToast('Notifications were not allowed. Reminders remain off.', 'error');
            suppressSuccessToast = true;
          }
        } catch (_) {
          settings.enabled = 'off';
          if (notifyEnabledSelect && notifyEnabledSelect._setValue) notifyEnabledSelect._setValue('off', true);
          showToast('Could not request notification permission.', 'error');
          suppressSuccessToast = true;
        }
      }

      try {
        plannerSettings = await savePlannerSettingsRemote(settings);
        saveReminderSettings(Object.assign({}, plannerSettings, { notified: localReminderState.notified }));
        if (!suppressSuccessToast) {
          showToast('Saved successfully.', 'success');
        }
        startReminderLoop();
      } catch (error) {
        showToast(error && error.message ? error.message : 'Could not save reminder settings.', 'error');
      }
    }

    function queueReminderSettingsAutoSave() {
      if (!currentUser) return;
      if (reminderSaveDebounceTimer) clearTimeout(reminderSaveDebounceTimer);
      reminderSaveDebounceTimer = setTimeout(() => {
        reminderSaveDebounceTimer = null;
        saveReminderSettingsFromUI();
      }, 450);
    }

    function maybeNotify(title, body, session) {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        const notification = new Notification(title, { body });
        notification.onclick = function () {
          window.focus();
          if (session) openStudySession(session, false);
        };
      }
      showToast(body, 'success');
    }

    function startReminderLoop() {
      if (reminderTimer) clearInterval(reminderTimer);
      reminderTimer = setInterval(checkReminders, 30000);
      checkReminders();
    }

    function checkReminders() {
      if (!currentUser) return;
      const settings = loadReminderSettings();
      if (settings.enabled !== 'on') return;
      const now = new Date();
      const nowTs = now.getTime();
      const offsetMs = (parseInt(settings.offset, 10) || 30) * 60000;
      let changed = false;

      sessions.forEach((session) => {
        const key = `${session.id}_${session.date}_${session.time}`;
        const targetTs = sessionToTimestamp(session);
        const delta = targetTs - nowTs;
        if (delta <= offsetMs && delta > 0 && !settings.notified[key]) {
          settings.notified[key] = true;
          changed = true;
          const packPart = session.pack_title ? ` (${session.pack_title})` : '';
          maybeNotify('Study session reminder', `${session.title}${packPart} starts at ${session.time}. Click to open.`, session);
        }
      });

      const todayKey = localDateString(now);
      const dailyKey = `daily_${todayKey}`;
      if (settings.daily_enabled === 'on' && settings.daily_time && !settings.notified[dailyKey]) {
        const [hh, mm] = settings.daily_time.split(':').map((v) => parseInt(v, 10));
        const dailyDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh || 19, mm || 0, 0, 0);
        if (nowTs >= dailyDate.getTime() && nowTs <= dailyDate.getTime() + 60000) {
          settings.notified[dailyKey] = true;
          changed = true;
          maybeNotify('Daily study reminder', 'Open your planner and schedule your next review.', null);
        }
      }

      if (changed) saveReminderSettings(settings);
    }

    function wireWeekActions() {
      weekGrid.addEventListener('click', (e) => {
        const openBtn = e.target.closest('[data-open-session]');
        if (openBtn) {
          const id = openBtn.getAttribute('data-open-session');
          const session = sessions.find((s) => s.id === id);
          if (session) openStudySession(session, false);
          return;
        }

        const editBtn = e.target.closest('[data-edit-session]');
        if (editBtn) {
          const id = editBtn.getAttribute('data-edit-session');
          const session = sessions.find((s) => s.id === id);
          if (session) openModal(session);
          return;
        }

        const delBtn = e.target.closest('[data-delete-session]');
        if (delBtn) {
          const id = delBtn.getAttribute('data-delete-session');
          deleteSession(id);
        }
      });
    }

    prevWeekBtn.addEventListener('click', () => { weekStart = addDays(weekStart, -7); renderWeek(); });
    nextWeekBtn.addEventListener('click', () => { weekStart = addDays(weekStart, 7); renderWeek(); });
    todayWeekBtn.addEventListener('click', () => { weekStart = startOfWeek(new Date()); renderWeek(); });
    addSessionBtn.addEventListener('click', () => openModal(null));
    modalCloseBtn.addEventListener('click', closeModal);
    modalCancelBtn.addEventListener('click', closeModal);
    modalSaveBtn.addEventListener('click', () => { saveSessionFromModal(); });
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });

    modalCard.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      if (e.target === sessionNotesEl) return;
      if (e.target && e.target.closest('.app-select-menu')) return;
      e.preventDefault();
      saveSessionFromModal();
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.app-select')) closeAllSelectMenus();
    });

    const notifyEnabledSelect = document.getElementById('notify-enabled-select');
    const notifyOffsetSelect = document.getElementById('notify-offset-select');
    const dailyReminderEnabledSelect = document.getElementById('daily-reminder-enabled-select');
    const dailyReminderTimeSelect = document.getElementById('daily-reminder-time-select');
    const sessionPackSelect = document.getElementById('session-pack-select');

    buildDailyTimeOptions();
    initAppSelect(notifyEnabledSelect, () => { queueReminderSettingsAutoSave(); });
    initAppSelect(notifyOffsetSelect, () => { queueReminderSettingsAutoSave(); });
    initAppSelect(dailyReminderEnabledSelect, () => { toggleDailyReminderTimeInput(); queueReminderSettingsAutoSave(); });
    initAppSelect(dailyReminderTimeSelect, () => { queueReminderSettingsAutoSave(); });
    initAppSelect(sessionPackSelect, () => {});
    initPickers();
    modalOverlay.hidden = true;
    modalOverlay.setAttribute('aria-hidden', 'true');
    wireWeekActions();

    auth.onAuthStateChanged(async (user) => {
      currentUser = user;
      if (!user) {
        idToken = '';
        if (authClient && typeof authClient.clearToken === 'function') authClient.clearToken();
        authRequiredEl.style.display = '';
        calendarLayoutEl.style.display = 'none';
        if (emptyWeekEl) emptyWeekEl.hidden = true;
        if (reminderTimer) clearInterval(reminderTimer);
        if (reminderSaveDebounceTimer) {
          clearTimeout(reminderSaveDebounceTimer);
          reminderSaveDebounceTimer = null;
        }
        sessions = [];
        plannerSettings = defaultPlannerSettings();
        localReminderState = { notified: {} };
        studyPacks = [];
        renderPackSelectOptions('');
        return;
      }

      idToken = await user.getIdToken();
      if (authClient && typeof authClient.setToken === 'function') authClient.setToken(idToken);
      authRequiredEl.style.display = 'none';
      calendarLayoutEl.style.display = '';

      try {
        await loadPlannerState();
      } catch (error) {
        sessions = [];
        plannerSettings = defaultPlannerSettings();
        localReminderState = { notified: {} };
        showToast(error && error.message ? error.message : 'Could not load planner data.', 'error');
      }
      await loadStudyPacks();
      applyReminderSettingsToUI();
      renderWeek();
      startReminderLoop();
    });
