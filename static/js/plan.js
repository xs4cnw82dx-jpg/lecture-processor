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

    const userEmailEl = document.getElementById('user-email');
    const authRequiredEl = document.getElementById('auth-required');
    const plannerContentEl = document.getElementById('planner-content');
    const streakValueEl = document.getElementById('streak-value');
    const dueValueEl = document.getElementById('due-value');
    const goalValueEl = document.getElementById('goal-value');
    const goalFillEl = document.getElementById('goal-fill');
    const goalInputEl = document.getElementById('goal-input');
    const saveGoalBtn = document.getElementById('save-goal-btn');
    const foldersBodyEl = document.getElementById('folders-body');
    const foldersCardsEl = document.getElementById('folders-cards');
    const foldersEmptyEl = document.getElementById('folders-empty');
    const signoutBtn = document.getElementById('signout-btn');
    const toastEl = document.getElementById('toast');

    let currentUser = null;
    let idToken = null;
    let folderStatsById = {};
    let examDatePickers = [];
    let progressSummaryCache = null;
    let remoteCardStates = {};

    function showToast(message, type) {
      toastEl.textContent = message;
      toastEl.className = 'toast visible' + (type ? ' ' + type : '');
      setTimeout(function(){ toastEl.className = 'toast'; }, 2200);
    }

    function localDateString(ts) {
      const d = ts ? new Date(ts) : new Date();
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      const day = String(d.getDate()).padStart(2, '0');
      return y + '-' + m + '-' + day;
    }
    function safeReadJson(raw, fallback) {
      try { return JSON.parse(raw); } catch (_) { return fallback; }
    }
    function getDailyGoal(uid) {
      const parsed = parseInt(localStorage.getItem('daily_goal_' + uid) || '20', 10);
      return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 500) : 20;
    }
    function setDailyGoal(uid, value) {
      localStorage.setItem('daily_goal_' + uid, String(value));
    }
    function isDueDate(dateString) {
      const value = String(dateString || '').trim();
      if (!value) return true;
      return value <= localDateString();
    }

    function getProgressSummary(uid) {
      const summary = (progressSummaryCache && typeof progressSummaryCache === 'object') ? progressSummaryCache : {};
      const dailyGoal = Number(summary.daily_goal || getDailyGoal(uid) || 20);
      return {
        current_streak: Number(summary.current_streak || 0),
        due_today: Number(summary.due_today || 0),
        today_progress: Number(summary.today_progress || 0),
        daily_goal: Number.isFinite(dailyGoal) && dailyGoal > 0 ? dailyGoal : 20,
      };
    }

    function getPackState(uid, packId, remoteMap) {
      const key = String(packId || '');
      if (remoteMap && remoteMap[key] && typeof remoteMap[key] === 'object') {
        return remoteMap[key];
      }
      return safeReadJson(localStorage.getItem('card_state_' + uid + '_' + key) || '{}', {});
    }

    function computeFolderStats(uid, packs, remoteMap) {
      const byFolder = {};
      (packs || []).forEach(function(pack){
        const folderId = String(pack.folder_id || '');
        if (!folderId) return;
        if (!byFolder[folderId]) byFolder[folderId] = { total: 0, due: 0, unmastered: 0 };
        const total = Math.max(0, parseInt(pack.flashcards_count, 10) || 0);
        byFolder[folderId].total += total;
        const state = getPackState(uid, pack.study_pack_id, remoteMap);
        for (let i = 0; i < total; i++) {
          const card = state['fc_' + i] || null;
          if (!card || !(parseInt(card.seen, 10) > 0)) {
            byFolder[folderId].unmastered += 1;
            continue;
          }
          if (String(card.level || '').toLowerCase() !== 'mastered') byFolder[folderId].unmastered += 1;
          if (isDueDate(card.next_review_date)) byFolder[folderId].due += 1;
        }
      });
      return byFolder;
    }

    function daysUntil(dateString) {
      if (!dateString) return null;
      const parts = String(dateString).split('-');
      if (parts.length !== 3) return null;
      const exam = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      return Math.ceil((exam.getTime() - today.getTime()) / 86400000);
    }

    function formatDisplayDate(isoDate) {
      const val = String(isoDate || '').trim();
      const m = val.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (!m) return '';
      return m[3] + '-' + m[2] + '-' + m[1];
    }

    function parseDateInput(value) {
      const raw = String(value || '').trim();
      if (!raw) return '';
      let m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (m) {
        const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
        if (d.getFullYear() !== parseInt(m[1], 10) || (d.getMonth() + 1) !== parseInt(m[2], 10) || d.getDate() !== parseInt(m[3], 10)) {
          return null;
        }
        return raw;
      }
      m = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
      if (m) {
        const y = parseInt(m[3], 10);
        const mo = parseInt(m[2], 10);
        const d = parseInt(m[1], 10);
        const date = new Date(y, mo - 1, d);
        if (date.getFullYear() !== y || (date.getMonth() + 1) !== mo || date.getDate() !== d) {
          return null;
        }
        return y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
      }
      return null;
    }

    function renderOverview(uid) {
      const summary = getProgressSummary(uid);
      const streak = summary.current_streak;
      const due = summary.due_today;
      const goal = summary.daily_goal;
      const progress = summary.today_progress;
      const pct = Math.max(0, Math.min(100, Math.round((Math.min(progress, goal) / Math.max(goal, 1)) * 100)));
      streakValueEl.textContent = streak + ' day' + (streak === 1 ? '' : 's');
      dueValueEl.textContent = String(due);
      goalValueEl.textContent = Math.min(progress, goal) + ' / ' + goal;
      goalFillEl.style.width = pct + '%';
      goalInputEl.value = String(goal);
    }

    function renderFolders(folders) {
      while (foldersBodyEl.firstChild) foldersBodyEl.removeChild(foldersBodyEl.firstChild);
      while (foldersCardsEl.firstChild) foldersCardsEl.removeChild(foldersCardsEl.firstChild);
      if (!folders || !folders.length) {
        foldersEmptyEl.style.display = 'block';
        return;
      }
      foldersEmptyEl.style.display = 'none';

      folders.forEach(function(folder){
        const stats = folderStatsById[folder.folder_id] || { total: 0, due: 0, unmastered: 0 };
        const days = daysUntil(folder.exam_date || '');
        const folderName = folder.name || 'Untitled folder';
        const metadata = [folder.course, folder.subject, folder.semester, folder.block].filter(Boolean).join(' · ') || 'No metadata';
        const countdownBadge = document.createElement('span');
        countdownBadge.className = 'chip';
        countdownBadge.textContent = 'No exam date';
        const recommendation = document.createElement('span');
        recommendation.className = 'recommendation';
        recommendation.textContent = 'Set an exam date to get a daily recommendation.';
        if (days !== null) {
          if (days > 0) {
            countdownBadge.className = 'chip warn';
            countdownBadge.textContent = days + ' day' + (days === 1 ? '' : 's') + ' left';
            const rec = Math.ceil((stats.unmastered || 0) / Math.max(days, 1));
            recommendation.textContent = 'Recommended: ';
            const strong = document.createElement('strong');
            strong.textContent = String(rec);
            recommendation.appendChild(strong);
            recommendation.appendChild(document.createTextNode(' unmastered cards/day.'));
          } else if (days === 0) {
            countdownBadge.className = 'chip danger';
            countdownBadge.textContent = 'Exam today';
            recommendation.textContent = '';
            const strong = document.createElement('strong');
            strong.textContent = String(stats.unmastered || 0);
            recommendation.appendChild(strong);
            recommendation.appendChild(document.createTextNode(' cards should be reviewed today.'));
          } else {
            countdownBadge.className = 'chip danger';
            countdownBadge.textContent = 'Exam passed';
            recommendation.textContent = 'Update the exam date to restore recommendations.';
          }
        }

        const createDateInputWrap = function() {
          const wrap = document.createElement('div');
          wrap.className = 'date-input-wrap';
          const input = document.createElement('input');
          input.className = 'input js-folder-date';
          input.type = 'text';
          input.value = formatDisplayDate(folder.exam_date || '');
          input.placeholder = 'dd-mm-yyyy';
          input.setAttribute('inputmode', 'numeric');
          input.setAttribute('aria-label', `Exam date for ${folderName}`);
          wrap.appendChild(input);
          const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          icon.setAttribute('class', 'date-input-icon');
          icon.setAttribute('viewBox', '0 0 24 24');
          icon.setAttribute('fill', 'none');
          icon.setAttribute('stroke', 'currentColor');
          icon.setAttribute('stroke-width', '2');
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('x', '3');
          rect.setAttribute('y', '4');
          rect.setAttribute('width', '18');
          rect.setAttribute('height', '18');
          rect.setAttribute('rx', '2');
          icon.appendChild(rect);
          const l1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          l1.setAttribute('x1', '16');
          l1.setAttribute('y1', '2');
          l1.setAttribute('x2', '16');
          l1.setAttribute('y2', '6');
          icon.appendChild(l1);
          const l2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          l2.setAttribute('x1', '8');
          l2.setAttribute('y1', '2');
          l2.setAttribute('x2', '8');
          l2.setAttribute('y2', '6');
          icon.appendChild(l2);
          const l3 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
          l3.setAttribute('x1', '3');
          l3.setAttribute('y1', '10');
          l3.setAttribute('x2', '21');
          l3.setAttribute('y2', '10');
          icon.appendChild(l3);
          wrap.appendChild(icon);
          return wrap;
        };

        const createSaveButton = function() {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'btn primary';
          btn.dataset.saveFolder = String(folder.folder_id || '');
          btn.textContent = 'Save';
          return btn;
        };

        const buildWorkload = function() {
          const wrap = document.createElement('div');
          wrap.className = 'recommendation';
          const totalStrong = document.createElement('strong');
          totalStrong.textContent = String(stats.total);
          wrap.appendChild(totalStrong);
          wrap.appendChild(document.createTextNode(' total · '));
          const unmasteredStrong = document.createElement('strong');
          unmasteredStrong.textContent = String(stats.unmastered);
          wrap.appendChild(unmasteredStrong);
          wrap.appendChild(document.createTextNode(' unmastered · '));
          const dueStrong = document.createElement('strong');
          dueStrong.textContent = String(stats.due);
          wrap.appendChild(dueStrong);
          wrap.appendChild(document.createTextNode(' due'));
          return wrap;
        };

        const tr = document.createElement('tr');
        tr.setAttribute('data-folder-editor', String(folder.folder_id || ''));
        const tdName = document.createElement('td');
        const nameWrap = document.createElement('div');
        const nameStrong = document.createElement('strong');
        nameStrong.textContent = folderName;
        nameWrap.appendChild(nameStrong);
        const metaDiv = document.createElement('div');
        metaDiv.className = 'folder-meta';
        metaDiv.textContent = metadata;
        tdName.appendChild(nameWrap);
        tdName.appendChild(metaDiv);

        const tdDate = document.createElement('td');
        tdDate.appendChild(createDateInputWrap());

        const tdWorkload = document.createElement('td');
        tdWorkload.appendChild(buildWorkload());
        const countdownRow = document.createElement('div');
        countdownRow.style.marginTop = '6px';
        countdownRow.appendChild(countdownBadge.cloneNode(true));
        tdWorkload.appendChild(countdownRow);

        const tdRecommendation = document.createElement('td');
        tdRecommendation.appendChild(recommendation.cloneNode(true));

        const tdAction = document.createElement('td');
        tdAction.appendChild(createSaveButton());

        tr.appendChild(tdName);
        tr.appendChild(tdDate);
        tr.appendChild(tdWorkload);
        tr.appendChild(tdRecommendation);
        tr.appendChild(tdAction);
        foldersBodyEl.appendChild(tr);

        const card = document.createElement('article');
        card.className = 'folder-card';
        card.setAttribute('data-folder-editor', String(folder.folder_id || ''));
        const cardHeader = document.createElement('div');
        cardHeader.className = 'folder-card-header';
        const cardHeaderText = document.createElement('div');
        const cardTitle = document.createElement('div');
        cardTitle.className = 'folder-card-title';
        cardTitle.textContent = folderName;
        const cardMeta = document.createElement('div');
        cardMeta.className = 'folder-card-meta';
        cardMeta.textContent = metadata;
        cardHeaderText.appendChild(cardTitle);
        cardHeaderText.appendChild(cardMeta);
        cardHeader.appendChild(cardHeaderText);
        cardHeader.appendChild(countdownBadge.cloneNode(true));
        card.appendChild(cardHeader);

        const cardExam = document.createElement('div');
        cardExam.className = 'folder-card-section';
        const cardExamLabel = document.createElement('span');
        cardExamLabel.className = 'folder-card-label';
        cardExamLabel.textContent = 'Exam date';
        cardExam.appendChild(cardExamLabel);
        cardExam.appendChild(createDateInputWrap());
        card.appendChild(cardExam);

        const cardWorkload = document.createElement('div');
        cardWorkload.className = 'folder-card-section';
        const cardWorkloadLabel = document.createElement('span');
        cardWorkloadLabel.className = 'folder-card-label';
        cardWorkloadLabel.textContent = 'Workload';
        cardWorkload.appendChild(cardWorkloadLabel);
        cardWorkload.appendChild(buildWorkload());
        card.appendChild(cardWorkload);

        const cardRecommendation = document.createElement('div');
        cardRecommendation.className = 'folder-card-section';
        const cardRecommendationLabel = document.createElement('span');
        cardRecommendationLabel.className = 'folder-card-label';
        cardRecommendationLabel.textContent = 'Recommendation';
        cardRecommendation.appendChild(cardRecommendationLabel);
        cardRecommendation.appendChild(recommendation.cloneNode(true));
        card.appendChild(cardRecommendation);

        const cardActions = document.createElement('div');
        cardActions.className = 'folder-card-actions';
        cardActions.appendChild(createSaveButton());
        card.appendChild(cardActions);
        foldersCardsEl.appendChild(card);
      });
      initFolderDatePickers();
    }

    function initFolderDatePickers() {
      if (typeof flatpickr === 'undefined') return;
      examDatePickers.forEach(function(instance){
        try { instance.destroy(); } catch (_) {}
      });
      examDatePickers = [];
      const inputs = document.querySelectorAll('#folders-body .js-folder-date, #folders-cards .js-folder-date');
      inputs.forEach(function(input){
        const instance = flatpickr(input, {
          dateFormat: 'd-m-Y',
          allowInput: true,
          disableMobile: true,
          locale: { firstDayOfWeek: 1 },
          defaultDate: input.value || null
        });
        examDatePickers.push(instance);
      });
    }

    const planHtmlUtils = window.LectureProcessorHtml || {};
    const escapeHtml = planHtmlUtils.escapeHtml || function(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };

    async function authFetch(url, options) {
      if (authClient && typeof authClient.authFetch === 'function') {
        return authClient.authFetch(url, options, { retryOn401: true });
      }
      const opts = options || {};
      const headers = Object.assign({}, opts.headers || {}, { 'Authorization': 'Bearer ' + idToken });
      return fetch(url, Object.assign({}, opts, { headers }));
    }

    function applyProgressData(progressData) {
      if (!currentUser) return;
      const uid = currentUser.uid;
      if (progressData && typeof progressData === 'object') {
        remoteCardStates = (progressData.card_states && typeof progressData.card_states === 'object') ? progressData.card_states : {};
        if (typeof progressData.daily_goal === 'number' && progressData.daily_goal > 0) {
          try { localStorage.setItem('daily_goal_' + uid, String(progressData.daily_goal)); } catch (_) {}
        }
        if (progressData.streak_data && typeof progressData.streak_data === 'object') {
          try { localStorage.setItem('study_streak_' + uid, JSON.stringify(progressData.streak_data)); } catch (_) {}
        }
        if (progressData.summary && typeof progressData.summary === 'object') {
          progressSummaryCache = progressData.summary;
        } else {
          progressSummaryCache = null;
        }
      } else {
        remoteCardStates = {};
        progressSummaryCache = null;
      }
    }

    async function loadPlannerData() {
      if (!currentUser || !idToken) return;
      renderOverview(currentUser.uid);
      try {
        const [foldersRes, packsRes, progressRes] = await Promise.all([
          authFetch('/api/study-folders'),
          authFetch('/api/study-packs'),
          authFetch('/api/study-progress'),
        ]);
        if (foldersRes.status === 401 || packsRes.status === 401 || progressRes.status === 401) {
          authRequiredEl.style.display = 'block';
          plannerContentEl.style.display = 'none';
          return;
        }
        const [foldersData, packsData, progressData] = await Promise.all([
          foldersRes.json(),
          packsRes.json(),
          progressRes.ok ? progressRes.json() : Promise.resolve({}),
        ]);
        applyProgressData(progressData);
        folderStatsById = computeFolderStats(currentUser.uid, packsData.study_packs || [], remoteCardStates);
        renderOverview(currentUser.uid);
        renderFolders(foldersData.folders || []);
      } catch (_) {
        while (foldersBodyEl.firstChild) foldersBodyEl.removeChild(foldersBodyEl.firstChild);
        while (foldersCardsEl.firstChild) foldersCardsEl.removeChild(foldersCardsEl.firstChild);
        foldersEmptyEl.style.display = 'block';
        foldersEmptyEl.textContent = 'Could not load folders right now. Please try again.';
      }
    }

    saveGoalBtn.addEventListener('click', async function(){
      if (!currentUser) return;
      const val = parseInt(goalInputEl.value || '0', 10);
      if (!Number.isFinite(val) || val < 1 || val > 500) {
        showToast('Use a goal between 1 and 500.', 'error');
        return;
      }
      setDailyGoal(currentUser.uid, val);
      progressSummaryCache = Object.assign({}, progressSummaryCache || {}, { daily_goal: val });
      renderOverview(currentUser.uid);
      try {
        const response = await authFetch('/api/study-progress', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ daily_goal: val, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '' })
        });
        if (!response.ok) {
          const data = await response.json().catch(function(){ return {}; });
          throw new Error(data.error || 'Could not save daily goal');
        }
        await loadPlannerData();
        showToast('Daily goal saved.', 'success');
      } catch (err) {
        showToast(err.message || 'Could not sync daily goal.', 'error');
      }
    });

    async function handleFolderSave(event){
      const btn = event.target.closest('[data-save-folder]');
      if (!btn || !currentUser || !idToken) return;
      const editor = btn.closest('[data-folder-editor]');
      const folderId = editor ? String(editor.getAttribute('data-folder-editor') || '') : String(btn.getAttribute('data-save-folder') || '');
      const dateInput = editor ? editor.querySelector('.js-folder-date') : null;
      if (!dateInput) return;
      const normalizedDate = parseDateInput(dateInput.value);
      if (normalizedDate === null) {
        showToast('Use a valid date: dd-mm-yyyy or yyyy-mm-dd.', 'error');
        dateInput.focus();
        return;
      }
      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        const resp = await authFetch('/api/study-folders/' + encodeURIComponent(folderId), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ exam_date: normalizedDate || '' })
        });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || 'Could not save exam date');
        showToast('Exam date saved.', 'success');
        await loadPlannerData();
      } catch (err) {
        showToast(err.message || 'Could not save exam date.', 'error');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save';
      }
    }

    foldersBodyEl.addEventListener('click', handleFolderSave);
    foldersCardsEl.addEventListener('click', handleFolderSave);

    if (topbarUtils.bindSignOutButton) {
      topbarUtils.bindSignOutButton(signoutBtn, auth, '/dashboard');
    } else {
      signoutBtn.addEventListener('click', async function(){
        try { await auth.signOut(); } catch (_) {}
        window.location.href = '/dashboard';
      });
    }

    window.addEventListener('focus', function(){
      if (currentUser) loadPlannerData();
    });
    document.addEventListener('visibilitychange', function(){
      if (!document.hidden && currentUser) loadPlannerData();
    });

    auth.onAuthStateChanged(async function(user){
      currentUser = user;
      if (!user) {
        idToken = null;
        if (authClient && typeof authClient.clearToken === 'function') authClient.clearToken();
        progressSummaryCache = null;
        remoteCardStates = {};
        if (topbarUtils.applyProtectedPageAuthState) {
          topbarUtils.applyProtectedPageAuthState({
            user: null,
            userTextEl: userEmailEl,
            signOutBtn: signoutBtn,
            authRequiredEl: authRequiredEl,
            mainContentEl: plannerContentEl,
            signOutSignedInDisplay: 'inline-flex',
            authRequiredSignedOutDisplay: 'block',
            mainContentSignedInDisplay: 'block',
          });
        } else {
          userEmailEl.textContent = 'Not signed in';
          signoutBtn.style.display = 'none';
          authRequiredEl.style.display = 'block';
          plannerContentEl.style.display = 'none';
        }
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
          mainContentEl: plannerContentEl,
          signOutSignedInDisplay: 'inline-flex',
          authRequiredSignedOutDisplay: 'block',
          mainContentSignedInDisplay: 'block',
        });
      } else {
        userEmailEl.textContent = user.email || 'Signed in';
        signoutBtn.style.display = 'inline-flex';
        authRequiredEl.style.display = 'none';
        plannerContentEl.style.display = 'block';
      }
      await loadPlannerData();
    });
