    const firebaseConfig = {
      apiKey: "AIzaSyBAAeEUCPNvP5qnqpP3M6HnFZ6vaaijUvM",
      authDomain: "lecture-processor-cdff6.firebaseapp.com",
      projectId: "lecture-processor-cdff6",
      storageBucket: "lecture-processor-cdff6.firebasestorage.app",
      messagingSenderId: "374793454161",
      appId: "1:374793454161:web:c68b21590e9a1fafa32e70"
    };
    firebase.initializeApp(firebaseConfig);
    const auth = firebase.auth();
    const authUtils = window.LectureProcessorAuth || {};
    const authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Not signed in' }) : null;
    const topbarUtils = window.LectureProcessorTopbar || {};

    const weekGrid = document.getElementById('week-grid');
    const weekTitle = document.getElementById('week-title');
    const prevWeekBtn = document.getElementById('prev-week-btn');
    const nextWeekBtn = document.getElementById('next-week-btn');
    const todayWeekBtn = document.getElementById('today-week-btn');
    const addSessionBtn = document.getElementById('add-session-btn');
    const signoutBtn = document.getElementById('signout-btn');
    const userEmailEl = document.getElementById('user-email');
    const authRequiredEl = document.getElementById('auth-required');
    const calendarLayoutEl = document.getElementById('calendar-layout');
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
    const saveReminderBtn = document.getElementById('save-reminder-btn');

    let currentUser = null;
    let idToken = '';
    let weekStart = startOfWeek(new Date());
    let sessions = [];
    let studyPacks = [];
    let editingSessionId = '';
    let reminderTimer = null;
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

    function formatDayName(date) {
      return new Intl.DateTimeFormat('en-GB', { weekday: 'short' }).format(date);
    }

    function formatLongDate(date) {
      return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
    }

    function formatTimeDisplay(value) {
      if (!/^\d{2}:\d{2}$/.test(String(value || ''))) return '00:00';
      return String(value);
    }

    function getSessionStorageKey() {
      return `study_sessions_${currentUser ? currentUser.uid : 'anon'}`;
    }

    function getReminderStorageKey() {
      return `study_reminders_${currentUser ? currentUser.uid : 'anon'}`;
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

    function initAppSelect(selectRoot, onChange) {
      if (!selectRoot) return;
      const button = selectRoot.querySelector('.app-select-button');
      const menu = selectRoot.querySelector('.app-select-menu');
      const label = selectRoot.querySelector('.app-select-label');
      const hidden = selectRoot.querySelector('input[type="hidden"]');

      function setValue(value, silent) {
        if (hidden) hidden.value = value;
        let activeText = '';
        menu.querySelectorAll('.app-select-item').forEach((item) => {
          const isActive = item.getAttribute('data-value') === value;
          item.classList.toggle('active', isActive);
          if (isActive) activeText = item.textContent;
        });
        if (label) label.textContent = activeText || (menu.querySelector('.app-select-item') ? menu.querySelector('.app-select-item').textContent : '');
        if (!silent && typeof onChange === 'function') onChange(value);
      }

      button.addEventListener('click', (e) => {
        e.preventDefault();
        const open = !menu.classList.contains('visible');
        document.querySelectorAll('.app-select-menu.visible').forEach((m) => {
          if (m !== menu) m.classList.remove('visible');
        });
        document.querySelectorAll('.app-select-button.open').forEach((b) => {
          if (b !== button) b.classList.remove('open');
        });
        menu.classList.toggle('visible', open);
        button.classList.toggle('open', open);
      });

      menu.addEventListener('click', (e) => {
        const item = e.target.closest('.app-select-item[data-value]');
        if (!item) return;
        setValue(item.getAttribute('data-value'));
        menu.classList.remove('visible');
        button.classList.remove('open');
      });

      const initial = hidden ? hidden.value : ((menu.querySelector('.app-select-item.active') || menu.querySelector('.app-select-item')) && (menu.querySelector('.app-select-item.active') || menu.querySelector('.app-select-item')).getAttribute('data-value'));
      if (initial) setValue(initial, true);

      selectRoot._setValue = (value, silent) => setValue(String(value || ''), !!silent);
      selectRoot._getValue = () => (hidden ? String(hidden.value || '') : '');
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
      document.querySelectorAll('.app-select-menu.visible').forEach((m) => m.classList.remove('visible'));
      document.querySelectorAll('.app-select-button.open').forEach((b) => b.classList.remove('open'));
    }

    function loadSessions() {
      try {
        const parsed = JSON.parse(localStorage.getItem(getSessionStorageKey()) || '[]');
        sessions = Array.isArray(parsed) ? parsed : [];
      } catch (_) {
        sessions = [];
      }
    }

    function saveSessions() {
      localStorage.setItem(getSessionStorageKey(), JSON.stringify(sessions));
    }

    function loadReminderSettings() {
      const fallback = { enabled: 'off', offset: '30', daily_enabled: 'on', daily_time: '19:00', notified: {} };
      try {
        const parsed = JSON.parse(localStorage.getItem(getReminderStorageKey()) || '{}');
        const settings = Object.assign({}, fallback, parsed || {});
        settings.notified = settings.notified && typeof settings.notified === 'object' ? settings.notified : {};
        settings.offset = String(settings.offset || '30');
        settings.enabled = settings.enabled === 'on' ? 'on' : 'off';
        settings.daily_enabled = settings.daily_enabled === 'off' ? 'off' : 'on';
        settings.daily_time = /^\d{2}:\d{2}$/.test(String(settings.daily_time || '')) ? settings.daily_time : '19:00';
        return settings;
      } catch (_) {
        return fallback;
      }
    }

    function saveReminderSettings(settings) {
      localStorage.setItem(getReminderStorageKey(), JSON.stringify(settings));
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

      modalOverlay.classList.add('visible');
      setTimeout(() => sessionTitleEl.focus(), 30);
    }

    function closeModal() {
      modalOverlay.classList.remove('visible');
      editingSessionId = '';
      closeAllSelectMenus();
    }

    function sessionToTimestamp(session) {
      return new Date(`${session.date}T${session.time}:00`).getTime();
    }

    function renderWeek() {
      const end = addDays(weekStart, 6);
      weekTitle.textContent = `${formatLongDate(weekStart)} - ${formatLongDate(end)}`;
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
    }

    function saveSessionFromModal() {
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

      if (editingSessionId) sessions = sessions.map((s) => (s.id === editingSessionId ? payload : s));
      else sessions.push(payload);

      saveSessions();
      closeModal();
      renderWeek();
      showToast(editingSessionId ? 'Session updated.' : 'Session added.', 'success');
    }

    function deleteSession(sessionId) {
      sessions = sessions.filter((s) => s.id !== sessionId);
      saveSessions();
      renderWeek();
      showToast('Session removed.', 'success');
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

    async function saveReminderSettingsFromUI() {
      const settings = loadReminderSettings();
      settings.enabled = notifyEnabledEl.value === 'on' ? 'on' : 'off';
      settings.offset = String(parseInt(notifyOffsetEl.value || '30', 10) || 30);
      settings.daily_enabled = dailyReminderEnabledEl.value === 'off' ? 'off' : 'on';
      settings.daily_time = settings.daily_enabled === 'on' ? String(dailyReminderTimeEl.value || '19:00') : '';

      if (settings.enabled === 'on' && Notification && Notification.permission !== 'granted') {
        try {
          const permission = await Notification.requestPermission();
          if (permission !== 'granted') {
            settings.enabled = 'off';
            if (notifyEnabledSelect && notifyEnabledSelect._setValue) notifyEnabledSelect._setValue('off', true);
            showToast('Notifications were not allowed. Reminders remain off.', 'error');
            saveReminderSettings(settings);
            return;
          }
        } catch (_) {
          settings.enabled = 'off';
          if (notifyEnabledSelect && notifyEnabledSelect._setValue) notifyEnabledSelect._setValue('off', true);
          showToast('Could not request notification permission.', 'error');
          saveReminderSettings(settings);
          return;
        }
      }

      saveReminderSettings(settings);
      showToast('Reminder settings saved.', 'success');
      startReminderLoop();
    }

    function maybeNotify(title, body, session) {
      if (Notification && Notification.permission === 'granted') {
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
    modalSaveBtn.addEventListener('click', saveSessionFromModal);
    modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeModal(); });
    saveReminderBtn.addEventListener('click', saveReminderSettingsFromUI);

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

    if (topbarUtils.bindSignOutButton) {
      topbarUtils.bindSignOutButton(signoutBtn, auth, '/dashboard');
    } else {
      signoutBtn.addEventListener('click', async () => {
        try { await auth.signOut(); } catch (_) {}
        window.location.href = '/dashboard';
      });
    }

    const notifyEnabledSelect = document.getElementById('notify-enabled-select');
    const notifyOffsetSelect = document.getElementById('notify-offset-select');
    const dailyReminderEnabledSelect = document.getElementById('daily-reminder-enabled-select');
    const dailyReminderTimeSelect = document.getElementById('daily-reminder-time-select');
    const sessionPackSelect = document.getElementById('session-pack-select');

    buildDailyTimeOptions();
    initAppSelect(notifyEnabledSelect, () => {});
    initAppSelect(notifyOffsetSelect, () => {});
    initAppSelect(dailyReminderEnabledSelect, () => { toggleDailyReminderTimeInput(); });
    initAppSelect(dailyReminderTimeSelect, () => {});
    initAppSelect(sessionPackSelect, () => {});
    initPickers();
    wireWeekActions();

    auth.onAuthStateChanged(async (user) => {
      currentUser = user;
      if (!user) {
        idToken = '';
        if (authClient && typeof authClient.clearToken === 'function') authClient.clearToken();
        if (topbarUtils.applyProtectedPageAuthState) {
          topbarUtils.applyProtectedPageAuthState({
            user: null,
            userTextEl: userEmailEl,
            signOutBtn: signoutBtn,
            authRequiredEl: authRequiredEl,
            mainContentEl: calendarLayoutEl,
            signOutSignedInDisplay: '',
            authRequiredSignedOutDisplay: '',
            mainContentSignedInDisplay: '',
          });
        } else {
          userEmailEl.textContent = 'Not signed in';
          signoutBtn.style.display = 'none';
          authRequiredEl.style.display = '';
          calendarLayoutEl.style.display = 'none';
        }
        if (reminderTimer) clearInterval(reminderTimer);
        studyPacks = [];
        renderPackSelectOptions('');
        return;
      }

      idToken = await user.getIdToken();
      if (authClient && typeof authClient.setToken === 'function') authClient.setToken(idToken);
      if (topbarUtils.applyProtectedPageAuthState) {
        topbarUtils.applyProtectedPageAuthState({
          user: user,
          userTextEl: userEmailEl,
          signOutBtn: signoutBtn,
          authRequiredEl: authRequiredEl,
          mainContentEl: calendarLayoutEl,
          signOutSignedInDisplay: '',
          authRequiredSignedOutDisplay: '',
          mainContentSignedInDisplay: '',
        });
      } else {
        userEmailEl.textContent = user.email || 'Signed in';
        signoutBtn.style.display = '';
        authRequiredEl.style.display = 'none';
        calendarLayoutEl.style.display = '';
      }

      loadSessions();
      await loadStudyPacks();
      applyReminderSettingsToUI();
      renderWeek();
      startReminderLoop();
    });
