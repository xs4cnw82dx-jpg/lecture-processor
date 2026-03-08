const bootstrap = window.LectureProcessorBootstrap || {};
const auth = bootstrap.getAuth ? bootstrap.getAuth() : firebase.auth();
const authUtils = window.LectureProcessorAuth || {};
const authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;
const markdownUtils = window.LectureProcessorMarkdown || {};
const uxUtils = window.LectureProcessorUx || {};
const downloadUtils = window.LectureProcessorDownload || {};
const topbarUtils = window.LectureProcessorTopbar || {};
const uiCache = window.LectureProcessorUiCache || null;
const progressUtils = window.LectureProcessorStudyProgressUtils || {};

/* ── State ── */
let token = null, folders = [], packs = [], selectedFolderId = '', selectedPackId = '', selectedPack = null;
let activeEditorPane = 'notes', exportType = 'flashcards', draggedPackId = '';
let folderModalMode = 'create', editingFolderId = '', pendingOpenPackId = '', confirmModalResolver = null;
let builderDraft = null, builderMode = 'edit', builderPane = 'info', builderDirty = false, builderPackId = '', builderExitResolver = null, builderImportParsed = null;
let builderAutoSaveTimer = null, builderAutoSaving = false, builderAutoSaveQueued = false;
let inlineAutoSaveTimer = null, inlineAutoSaving = false, inlineAutoSaveQueued = false;
let learnFlashcardIndex = 0, learnFlashcardFlipped = false, learnQuestionIndex = 0, learnScore = 0, learnAnswered = false;
let activeLearnMode = ''; // 'flashcards','test','write','match','notes'
let orderedFlashcards = [];
let learnSessionRecorded = false;
let audioSections = [], audioMap = [], audioReady = false, audioSpeedIndex = 1, audioHiddenForLearn = false;
let remoteProgressCardStates = {};
let progressTimezone = (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
let progressSyncTimer = null, progressSyncInFlight = false;
let creatingDemoPack = false;
let progressHydrationDone = false;
let progressSummaryCache = null;
let masterDailyGoal = progressUtils.DEFAULT_DAILY_GOAL || 20;
let packAdvancedMetadataOpen = false, builderAdvancedMetadataOpen = false;
let folderExamDatePicker = null;
let flashcardListMode = false, flashcardPeekMode = false;
let flashcardPeekRevealed = {};
const audioSpeeds = [0.75, 1, 1.25, 1.5, 2];
let difficultyFadeTimer = null, keyboardHintFadeTimer = null, notesFullscreenFadeTimer = null;
let highlightSyncTimer = null, highlightSyncInFlight = false, pendingHighlightPayload = undefined, pendingHighlightPackId = '';
let overallGoalSaveInFlight = false, packGoalSaveInFlight = false;
let overallGoalAutosaveTimer = null, packGoalAutosaveTimer = null;
const HINT_FADE_DELAY_MS = 10000;
const NOTES_ICON_IDLE_MS = 5000;
const HIGHLIGHT_SYNC_DELAY_MS = 450;
const GOAL_AUTOSAVE_DELAY_MS = 420;
const NOTES_HIGHLIGHT_CACHE_PREFIX = 'hl_ranges_';
const LEGACY_NOTES_HIGHLIGHT_CACHE_PREFIX = 'hl_html_';
const urlParams = new URLSearchParams(window.location.search);
const learnPackFromUrl = urlParams.get('pack_id') || '';
const openLearnFromUrl = urlParams.get('mode') === 'learn';
const fullscreenFromUrl = urlParams.get('fullscreen') === '1';
const focusFromUrl = urlParams.get('focus') || '';
const actionFromUrl = String(urlParams.get('action') || '').trim().toLowerCase();
let autoLearnConsumed = false;
let autoCreateConsumed = false;
const progressSyncSourceId = 'study-' + Math.random().toString(36).slice(2, 10);

/* Write mode state */
let writeIndex = 0, writeRevealed = false, writeChecked = false, writePromptSwapped = false;

/* Match mode state */
let matchCards = [], matchSelected = null, matchMatched = 0, matchTotal = 0;
let matchTimerInterval = null, matchStartTime = 0, matchElapsed = 0, matchRunning = false;
const MATCH_MIN_CARDS = 6;
const BUILDER_AUTOSAVE_DELAY_MS = 1500;
const BUILTIN_ALL_FOLDER_ID = '';
const BUILTIN_INTERVIEWS_FOLDER_ID = '__interviews__';
const MAX_PINNED_FOLDERS = 5;
let pinnedFolderIds = [];

/* ── Session state ── */
const ALGO_PRESETS = { balanced: ['new', 'new', 'familiar', 'retry', 'remaster'], random: ['random', 'random', 'random', 'random', 'random'], lastminute: ['new', 'new', 'new', 'new', 'retry'], fixmistakes: ['new', 'retry', 'new', 'retry', 'retry'], hardfirst: ['hard', 'hard', 'retry', 'new', 'familiar'] };
const ALGO_TYPES = ['new', 'familiar', 'retry', 'remaster', 'hard', 'random'];
const ALGO_ICONS = {
  new: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2"></rect><line x1="12" y1="18" x2="12.01" y2="18"></line></svg>',
  familiar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>',
  retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>',
  remaster: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5C5.7 4 7 4.8 8 6c1-1.2 2.3-2 3.5-2a2.5 2.5 0 0 1 0 5H10"></path><path d="M6 9l6 6 6-6"></path></svg>',
  hard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l2.7 5.5L21 8.4l-4.5 4.4 1 6.2L12 16.8 6.5 19l1-6.2L3 8.4l6.3-.9L12 2z"></path></svg>',
  random: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 3 21 3 21 8"></polyline><line x1="4" y1="20" x2="21" y2="3"></line><polyline points="21 16 21 21 16 21"></polyline><line x1="15" y1="15" x2="21" y2="21"></line><line x1="4" y1="4" x2="9" y2="9"></line></svg>'
};
const MODE_ICONS = {
  flashcards: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"></rect><line x1="2" y1="12" x2="22" y2="12"></line></svg>',
  test: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"></path><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path></svg>',
  write: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>',
  match: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect></svg>'
};
const MODE_NAMES = { flashcards: 'Zen Cards', test: 'Multiple Choice', write: 'Write', match: 'Match' };
const MODE_DESCS = { flashcards: 'Flip through cards at your pace', test: 'Answer multiple choice questions', write: 'Type answers from memory', match: 'Pair terms with definitions' };

let sessionSettings = { swapAnswerQuestion: false, randomSwap: false, caseSensitive: false, forceExactMatch: false, addMissedToReview: true, ignoreArticles: false, ignoreDeterminers: false, ignoreBrackets: false };
let sessionAlgo = ['new', 'new', 'familiar', 'retry', 'remaster'], sessionAlgoPreset = 'balanced';
let sessionLessons = { flashcards: true, test: true, write: false, match: false };
let activeSetupPane = 'mastery';

/* ── Card mastery + spaced repetition (localStorage) ── */
const SR_MIN_INTERVAL_DAYS = 1;
const SR_MAX_INTERVAL_DAYS = 120;
const REVIEW_ACTIONS = ['retry', 'hard', 'good', 'easy'];
function getBrowserTimezone() {
  var tz = 'UTC';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { }
  return String(tz || 'UTC');
}
function normalizeTimezoneName(value) {
  var tz = String(value || '').trim();
  if (!tz) { return ''; }
  try {
    Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    return tz;
  } catch (e) {
    return '';
  }
}
function formatDisplayDate(isoDate) {
  var value = String(isoDate || '').trim();
  var match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return '';
  return match[3] + '-' + match[2] + '-' + match[1];
}
function parseDateInput(value) {
  var raw = String(value || '').trim();
  if (!raw) return '';
  var match = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    var date1 = new Date(parseInt(match[1], 10), parseInt(match[2], 10) - 1, parseInt(match[3], 10));
    if (date1.getFullYear() !== parseInt(match[1], 10) || (date1.getMonth() + 1) !== parseInt(match[2], 10) || date1.getDate() !== parseInt(match[3], 10)) {
      return null;
    }
    return raw;
  }
  match = raw.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (match) {
    var day = parseInt(match[1], 10);
    var month = parseInt(match[2], 10);
    var year = parseInt(match[3], 10);
    var date2 = new Date(year, month - 1, day);
    if (date2.getFullYear() !== year || (date2.getMonth() + 1) !== month || date2.getDate() !== day) {
      return null;
    }
    return year + '-' + String(month).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }
  return null;
}
function setFolderExamDateValue(rawValue) {
  if (!folderExamDateInput) return;
  var normalized = parseDateInput(rawValue);
  var isoDate = normalized === null ? '' : normalized;
  if (folderExamDatePicker && typeof folderExamDatePicker.setDate === 'function') {
    folderExamDatePicker.setDate(isoDate || null, true, 'Y-m-d');
  } else {
    folderExamDateInput.value = formatDisplayDate(isoDate);
  }
}
function initFolderExamDatePicker() {
  if (typeof flatpickr === 'undefined' || !folderExamDateInput) return;
  if (folderExamDatePicker && typeof folderExamDatePicker.destroy === 'function') {
    try { folderExamDatePicker.destroy(); } catch (e) { }
  }
  folderExamDatePicker = flatpickr(folderExamDateInput, {
    dateFormat: 'd-m-Y',
    allowInput: true,
    disableMobile: true,
    locale: { firstDayOfWeek: 1 },
  });
}
function getDateStringInTimezone(ts, timezoneName) {
  var resolved = normalizeTimezoneName(timezoneName) || getBrowserTimezone();
  var d = ts ? new Date(ts) : new Date();
  try {
    var parts = Intl.DateTimeFormat('en-CA', { timeZone: resolved, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    var year = '', month = '', day = '';
    for (var i = 0; i < parts.length; i++) {
      if (parts[i].type === 'year') { year = parts[i].value; }
      if (parts[i].type === 'month') { month = parts[i].value; }
      if (parts[i].type === 'day') { day = parts[i].value; }
    }
    if (year && month && day) { return year + '-' + month + '-' + day; }
  } catch (e) { }
  return localDateStringFromTimestamp(ts);
}
function localDateStringFromTimestamp(ts) {
  var d = ts ? new Date(ts) : new Date();
  var y = d.getFullYear();
  var m = String(d.getMonth() + 1).padStart(2, '0');
  var day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}
function todayLocalDateString() { return getDateStringInTimezone(Date.now(), progressTimezone); }
function addDaysToLocalDate(dateString, days) {
  var parts = String(dateString || todayLocalDateString()).split('-');
  if (parts.length !== 3) return todayLocalDateString();
  var year = parseInt(parts[0], 10), month = parseInt(parts[1], 10), day = parseInt(parts[2], 10);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) { return todayLocalDateString(); }
  var base = new Date(Date.UTC(year, month - 1, day));
  base.setUTCDate(base.getUTCDate() + Math.max(0, parseInt(days, 10) || 0));
  return base.toISOString().slice(0, 10);
}
function isDueDate(dateString) {
  var target = String(dateString || '').trim();
  if (!target) return true;
  return target <= todayLocalDateString();
}
function getCardStateIndexKey() { return 'card_state_index_' + (auth.currentUser ? auth.currentUser.uid : 'anon'); }
function readCardStateIndex() {
  try {
    var raw = JSON.parse(localStorage.getItem(getCardStateIndexKey()) || '[]');
    if (!Array.isArray(raw)) { return []; }
    var seen = {}, cleaned = [];
    raw.forEach(function (value) {
      var packId = String(value || '').trim();
      if (!packId || seen[packId]) { return; }
      seen[packId] = true;
      cleaned.push(packId);
    });
    return cleaned;
  } catch (e) { return []; }
}
function writeCardStateIndex(packIds) {
  var seen = {}, cleaned = [];
  (packIds || []).forEach(function (value) {
    var packId = String(value || '').trim();
    if (!packId || seen[packId]) { return; }
    seen[packId] = true;
    cleaned.push(packId);
  });
  try { localStorage.setItem(getCardStateIndexKey(), JSON.stringify(cleaned)); } catch (e) { }
  return cleaned;
}
function addPackToCardStateIndex(packId) {
  var id = String(packId || '').trim();
  if (!id) { return; }
  var next = readCardStateIndex();
  if (next.indexOf(id) < 0) {
    next.push(id);
    writeCardStateIndex(next);
  }
}
function removePackFromCardStateIndex(packId) {
  var id = String(packId || '').trim();
  if (!id) { return; }
  var next = readCardStateIndex().filter(function (item) { return item !== id; });
  writeCardStateIndex(next);
}
function removePackLocalCaches(packId) {
  if (!auth.currentUser) { return; }
  var id = String(packId || '').trim();
  if (!id) { return; }
  var uid = auth.currentUser.uid;
  try { localStorage.removeItem(getCardStateKeyForPack(id)); } catch (e) { }
  try { localStorage.removeItem('match_scores_' + uid + '_' + id); } catch (e) { }
  try { localStorage.removeItem('study_session_' + uid + '_' + id); } catch (e) { }
  removePackFromCardStateIndex(id);
}
function cleanupCardStateCacheForKnownPacks() {
  if (!auth.currentUser) { return; }
  var uid = auth.currentUser.uid;
  var knownPackMap = {};
  (packs || []).forEach(function (pack) {
    var id = String((pack && pack.study_pack_id) || '').trim();
    if (id) { knownPackMap[id] = true; }
  });
  var indexIds = readCardStateIndex();
  var prefix = 'card_state_' + uid + '_';
  for (var i = 0; i < localStorage.length; i++) {
    var key = localStorage.key(i);
    if (!key || key.indexOf(prefix) !== 0) { continue; }
    var packId = key.slice(prefix.length);
    if (packId && indexIds.indexOf(packId) < 0) { indexIds.push(packId); }
  }
  var nextIndex = [];
  indexIds.forEach(function (packId) {
    if (!knownPackMap[packId]) {
      removePackLocalCaches(packId);
      return;
    }
    var state = {};
    try { state = JSON.parse(localStorage.getItem(getCardStateKeyForPack(packId)) || '{}') || {}; } catch (e) { state = {}; }
    if (state && typeof state === 'object' && Object.keys(state).length) {
      nextIndex.push(packId);
    } else {
      try { localStorage.removeItem(getCardStateKeyForPack(packId)); } catch (e) { }
    }
  });
  writeCardStateIndex(nextIndex);
}
function getCardStateKey() { return 'card_state_' + (auth.currentUser ? auth.currentUser.uid : 'anon') + '_' + selectedPackId; }
function loadCardState() { try { return JSON.parse(localStorage.getItem(getCardStateKey())) || {}; } catch (e) { return {}; } }
function saveCardState(s) {
  try { localStorage.setItem(getCardStateKey(), JSON.stringify(s)); } catch (e) { }
  if (selectedPackId) { addPackToCardStateIndex(selectedPackId); }
  queueProgressSync(true);
}
function getStreakKey() { return 'study_streak_' + (auth.currentUser ? auth.currentUser.uid : 'anon'); }
function loadStreakData() {
  try {
    var raw = localStorage.getItem(getStreakKey());
    if (!raw) return { last_study_date: '', current_streak: 0, daily_progress_date: '', daily_progress_count: 0 };
    var parsed = JSON.parse(raw) || {};
    return {
      last_study_date: parsed.last_study_date || '',
      current_streak: parseInt(parsed.current_streak, 10) || 0,
      daily_progress_date: parsed.daily_progress_date || '',
      daily_progress_count: parseInt(parsed.daily_progress_count, 10) || 0
    };
  } catch (e) {
    return { last_study_date: '', current_streak: 0, daily_progress_date: '', daily_progress_count: 0 };
  }
}
function saveStreakData(data) {
  try { localStorage.setItem(getStreakKey(), JSON.stringify(data || {})); } catch (e) { }
  broadcastProgressState({ type: 'summary' });
  queueProgressSync(false);
}
function getDailyGoalKey() { return 'daily_goal_' + (auth.currentUser ? auth.currentUser.uid : 'anon'); }
function loadDailyGoal() {
  if (progressHydrationDone) {
    return Math.max(progressUtils.MIN_DAILY_GOAL || 1, parseInt(masterDailyGoal, 10) || (progressUtils.DEFAULT_DAILY_GOAL || 20));
  }
  if (progressUtils && typeof progressUtils.readDailyGoalCache === 'function') {
    return progressUtils.readDailyGoalCache(auth.currentUser ? auth.currentUser.uid : 'anon', masterDailyGoal);
  }
  try {
    var value = parseInt(localStorage.getItem(getDailyGoalKey()) || String(masterDailyGoal || 20), 10);
    return Number.isFinite(value) && value > 0 ? Math.min(value, 500) : (masterDailyGoal || 20);
  } catch (e) { return masterDailyGoal || 20; }
}
function saveDailyGoal(value) {
  var parsed = progressUtils && typeof progressUtils.clampGoalValue === 'function'
    ? progressUtils.clampGoalValue(value, masterDailyGoal || (progressUtils.DEFAULT_DAILY_GOAL || 20))
    : Math.max(1, Math.min(500, parseInt(value, 10) || (masterDailyGoal || 20)));
  masterDailyGoal = parsed;
  if (progressUtils && typeof progressUtils.writeDailyGoalCache === 'function') {
    progressUtils.writeDailyGoalCache(auth.currentUser ? auth.currentUser.uid : 'anon', parsed);
    return;
  }
  try { localStorage.setItem(getDailyGoalKey(), String(parsed)); } catch (e) { }
}
function readLocalProgressSnapshot() {
  if (!auth.currentUser) return { daily_goal: 20, streak_data: {}, card_states: {} };
  var uid = auth.currentUser.uid;
  var dailyGoal = masterDailyGoal || loadDailyGoal();
  var streakData = loadStreakData();
  var cardStates = {};
  var trackedPackIds = readCardStateIndex();
  if (!trackedPackIds.length) {
    var prefix = 'card_state_' + uid + '_';
    for (var i = 0; i < localStorage.length; i++) {
      var key = localStorage.key(i);
      if (!key || key.indexOf(prefix) !== 0) continue;
      var packId = key.slice(prefix.length);
      if (packId && trackedPackIds.indexOf(packId) < 0) { trackedPackIds.push(packId); }
    }
  }
  var knownPackMap = {};
  (packs || []).forEach(function (pack) {
    var id = String((pack && pack.study_pack_id) || '').trim();
    if (id) { knownPackMap[id] = true; }
  });
  var nextIndex = [];
  trackedPackIds.forEach(function (packId) {
    if (!packId) { return; }
    if (Object.keys(knownPackMap).length && (!knownPackMap[packId])) {
      removePackLocalCaches(packId);
      return;
    }
    var key = getCardStateKeyForPack(packId);
    try {
      var state = JSON.parse(localStorage.getItem(key) || '{}') || {};
      if (state && typeof state === 'object' && Object.keys(state).length) {
        cardStates[packId] = state;
        nextIndex.push(packId);
      } else {
        localStorage.removeItem(key);
      }
    } catch (e) {
      try { localStorage.removeItem(key); } catch (_) { }
    }
  });
  writeCardStateIndex(nextIndex);
  return { daily_goal: dailyGoal, streak_data: streakData, card_states: cardStates };
}
function mergeProgressFromServer(remote) {
  if (!auth.currentUser || !remote) return;
  var uid = auth.currentUser.uid;
  var remoteTimezone = normalizeTimezoneName(remote.timezone || '');
  if (remoteTimezone) { progressTimezone = remoteTimezone; }
  progressSummaryCache = remote.summary && typeof remote.summary === 'object'
    ? remote.summary
    : progressSummaryCache;
  if (typeof remote.daily_goal === 'number' && remote.daily_goal > 0) {
    saveDailyGoal(remote.daily_goal);
  }
  if (progressSummaryCache && typeof progressSummaryCache === 'object') {
    progressSummaryCache.daily_goal = loadDailyGoal();
  }
  if (remote.streak_data && typeof remote.streak_data === 'object') {
    var local = loadStreakData();
    var remoteSeen = parseInt(remote.streak_data.daily_progress_count, 10) || 0;
    var localSeen = parseInt(local.daily_progress_count, 10) || 0;
    var localDate = String(local.daily_progress_date || '');
    var remoteDate = String(remote.streak_data.daily_progress_date || '');
    if (!local.last_study_date || (remoteDate && remoteDate >= localDate && remoteSeen >= localSeen)) {
      saveStreakData(remote.streak_data);
    }
  }
  remoteProgressCardStates = (remote.card_states && typeof remote.card_states === 'object') ? remote.card_states : {};
  Object.keys(remoteProgressCardStates).forEach(function (packId) {
    if (!packId) return;
    var remoteState = remoteProgressCardStates[packId] || {};
    var localKey = 'card_state_' + uid + '_' + packId;
    var localState = {};
    try { localState = JSON.parse(localStorage.getItem(localKey) || '{}') || {}; } catch (e) { }
    if (!Object.keys(localState).length && Object.keys(remoteState).length) {
      try { localStorage.setItem(localKey, JSON.stringify(remoteState)); } catch (e) { }
    }
    if (Object.keys(remoteState).length || Object.keys(localState).length) {
      addPackToCardStateIndex(packId);
    }
  });
  renderGoalPanel();
  if (auth.currentUser) {
    persistSharedSummaryCaches(auth.currentUser, progressSummaryCache || buildLiveProgressSummary());
  }
}
function loadRemoteProgress() {
  if (!auth.currentUser || !token) { return Promise.resolve(); }
  return apiCall('/api/study-progress').then(function (data) {
    progressHydrationDone = true;
    mergeProgressFromServer(data || {});
  }).catch(function (e) {
    console.warn('Could not load remote study progress:', e && e.message ? e.message : e);
  });
}
function flushProgressSync(forceAllPacks) {
  if (progressSyncInFlight || !auth.currentUser || !token) return;
  progressSyncInFlight = true;
  var snapshot = readLocalProgressSnapshot();
  var payload = { streak_data: snapshot.streak_data, timezone: progressTimezone || getBrowserTimezone() };
  if (forceAllPacks) {
    payload.card_states = snapshot.card_states;
  } else if (selectedPackId) {
    payload.card_states = {};
    payload.card_states[selectedPackId] = loadCardState();
  }
  apiCall('/api/study-progress', { method: 'PUT', body: JSON.stringify(payload) }).catch(function (e) {
    console.warn('Could not sync study progress:', e && e.message ? e.message : e);
  }).finally(function () {
    progressSyncInFlight = false;
  });
}
function queueProgressSync(currentPackOnly) {
  if (!auth.currentUser || !token) return;
  if (progressSyncTimer) { clearTimeout(progressSyncTimer); }
  progressSyncTimer = setTimeout(function () {
    progressSyncTimer = null;
    flushProgressSync(!currentPackOnly);
  }, 700);
}
function clampIntervalDays(value) {
  var parsed = Math.round(parseFloat(value) || 0);
  if (parsed < SR_MIN_INTERVAL_DAYS) { return SR_MIN_INTERVAL_DAYS; }
  if (parsed > SR_MAX_INTERVAL_DAYS) { return SR_MAX_INTERVAL_DAYS; }
  return parsed;
}
function normalizeReviewAction(action) {
  var value = String(action || '').toLowerCase();
  return REVIEW_ACTIONS.indexOf(value) >= 0 ? value : 'good';
}
function mapLegacyDifficultyToAction(difficulty) {
  var value = String(difficulty || '').toLowerCase();
  if (value === 'easy') return 'easy';
  if (value === 'hard') return 'hard';
  return 'good';
}
function getNextIntervalDaysForReviewAction(currentDays, action) {
  var current = Math.max(0, parseInt(currentDays, 10) || 0);
  var normalized = normalizeReviewAction(action);
  if (normalized === 'retry') {
    return SR_MIN_INTERVAL_DAYS;
  }
  if (normalized === 'hard') {
    if (current <= 0) return 1;
    return clampIntervalDays(Math.max(current + 1, current * 1.25));
  }
  if (normalized === 'easy') {
    if (current <= 0) return 4;
    return clampIntervalDays(Math.max(current + 3, current * 2.4));
  }
  if (current <= 0) return 2;
  return clampIntervalDays(Math.max(current + 2, current * 1.8));
}
function ensureStudyActivityRecorded() {
  var today = todayLocalDateString();
  var yesterday = addDaysToLocalDate(today, -1);
  var data = loadStreakData();
  if (data.last_study_date !== today) {
    if (data.last_study_date === yesterday) { data.current_streak = Math.max(1, (data.current_streak || 0) + 1); }
    else { data.current_streak = 1; }
    data.last_study_date = today;
  }
  if (data.daily_progress_date !== today) {
    data.daily_progress_date = today;
    data.daily_progress_count = 0;
  }
  return data;
}
function recordStudyActivity() {
  var data = ensureStudyActivityRecorded();
  data.daily_progress_count = Math.max(0, parseInt(data.daily_progress_count, 10) || 0) + 1;
  saveStreakData(data);
  updateDailyGoalDisplays();
  return data;
}
function setCardDifficulty(cardId, difficulty) {
  var action = mapLegacyDifficultyToAction(difficulty);
  setCardReviewAction(cardId, action);
}
function setCardReviewAction(cardId, action) {
  if (!cardId) return;
  var value = normalizeReviewAction(action);
  var state = loadCardState();
  if (!state[cardId]) { state[cardId] = { seen: 0, correct: 0, wrong: 0, level: 'new', interval_days: 0, next_review_date: '', difficulty: 'medium', last_action: '' }; }
  state[cardId].last_action = value;
  if (value === 'hard') state[cardId].difficulty = 'hard';
  else if (value === 'easy') state[cardId].difficulty = 'easy';
  else state[cardId].difficulty = 'medium';
  saveCardState(state);
  updateDifficultyToolbar();
  renderMasteryGauge();
}
function applyReviewAction(cardId, action) {
  if (!cardId) return;
  var state = loadCardState();
  if (!state[cardId]) {
    state[cardId] = { seen: 0, correct: 0, wrong: 0, level: 'new', interval_days: 0, next_review_date: '', difficulty: 'medium', last_review_date: '', last_action: '' };
  }
  var entry = state[cardId];
  var reviewAction = normalizeReviewAction(action);
  entry.seen = (entry.seen || 0) + 1;
  if (reviewAction === 'retry') { entry.wrong = (entry.wrong || 0) + 1; }
  else { entry.correct = (entry.correct || 0) + 1; }
  entry.interval_days = getNextIntervalDaysForReviewAction(entry.interval_days, reviewAction);
  entry.last_review_date = todayLocalDateString();
  entry.next_review_date = reviewAction === 'retry'
    ? entry.last_review_date
    : addDaysToLocalDate(entry.last_review_date, entry.interval_days);
  if (reviewAction === 'retry') { entry.level = 'retry'; }
  else if (entry.interval_days >= 14) { entry.level = 'mastered'; }
  else { entry.level = 'familiar'; }
  if (reviewAction === 'hard') entry.difficulty = 'hard';
  else if (reviewAction === 'easy') entry.difficulty = 'easy';
  else entry.difficulty = 'medium';
  entry.last_action = reviewAction;
  state[cardId] = entry;
  saveCardState(state);
  recordStudyActivity();
  renderMasteryGauge();
  updateTopbarDueCount();
  updateDifficultyToolbar();
  queueProgressSync(true);
}
function markCardReview(cardId, correct) {
  if (!cardId) return;
  var state = loadCardState();
  var entry = state[cardId] || {};
  if (!correct) {
    applyReviewAction(cardId, 'retry');
    return;
  }
  applyReviewAction(cardId, mapLegacyDifficultyToAction(entry.difficulty || 'medium'));
}
function markCardSeen(cardId, correct) { markCardReview(cardId, correct); }
function getCardStateKeyForPack(packId) {
  return 'card_state_' + (auth.currentUser ? auth.currentUser.uid : 'anon') + '_' + String(packId || '');
}
function loadCardStateForPack(packId) {
  try {
    return JSON.parse(localStorage.getItem(getCardStateKeyForPack(packId)) || '{}') || {};
  } catch (e) { return {}; }
}
function updateDailyGoalDisplays() {
  // Daily-goal UI is rendered on dashboard; keep this hook for shared state updates.
}
function recordLearnSessionCompletion() {
  if (learnSessionRecorded) return;
  var today = todayLocalDateString();
  var yesterday = addDaysToLocalDate(today, -1);
  var data = loadStreakData();
  if (data.last_study_date !== today) {
    if (data.last_study_date === yesterday) { data.current_streak = Math.max(1, (data.current_streak || 0) + 1); }
    else { data.current_streak = 1; }
    data.last_study_date = today;
  }
  if (data.daily_progress_date !== today) {
    data.daily_progress_date = today;
    data.daily_progress_count = Math.max(0, parseInt(data.daily_progress_count, 10) || 0);
  }
  saveStreakData(data);
  learnSessionRecorded = true;
}
function countDueCardsInState(state) {
  if (progressUtils && typeof progressUtils.countDueCardsInState === 'function') {
    return progressUtils.countDueCardsInState(state || {}, todayLocalDateString());
  }
  var due = 0;
  Object.keys(state || {}).forEach(function (cardId) {
    if (cardId.indexOf('fc_') !== 0) return;
    var entry = state[cardId] || {};
    if (!(parseInt(entry.seen, 10) > 0)) return;
    if (isDueDate(entry.next_review_date)) due++;
  });
  return due;
}
function updateTopbarDueCount() {
  var totalDue = 0;
  if (Array.isArray(packs) && packs.length) {
    packs.forEach(function (pack) {
      totalDue += countDueCardsInState(loadCardStateForPack(pack.study_pack_id));
    });
  } else if (selectedPackId) {
    totalDue = countDueCardsInState(loadCardState());
  }
  setTopbarDueTextValue(totalDue);
  persistTopbarDueToCache(auth.currentUser, totalDue);
  broadcastProgressState({ type: 'summary' });
}

function formatCardCount(value) {
  if (progressUtils && typeof progressUtils.formatCount === 'function') {
    return progressUtils.formatCount(value, 'card');
  }
  var count = Math.max(0, parseInt(value, 10) || 0);
  return count + ' card' + (count === 1 ? '' : 's');
}

function getPackStatsSnapshot(pack) {
  if (!pack) { return { total: 0, due: 0, unmastered: 0 }; }
  var state = loadCardStateForPack(pack.study_pack_id);
  if (progressUtils && typeof progressUtils.buildPackStats === 'function') {
    return progressUtils.buildPackStats(pack, state, todayLocalDateString());
  }
  var total = Array.isArray(pack.flashcards) ? pack.flashcards.length : Math.max(0, parseInt(pack.flashcards_count, 10) || 0);
  return {
    total: total,
    due: countDueCardsInState(state),
    unmastered: Math.max(0, total),
  };
}

function findSelectedPackFolder() {
  if (!selectedPack || !selectedPack.folder_id) return null;
  return folders.find(function (folder) { return folder.folder_id === selectedPack.folder_id; }) || null;
}

function buildExamRecommendation(unmasteredCount, examDate) {
  if (progressUtils && typeof progressUtils.buildRecommendation === 'function') {
    return progressUtils.buildRecommendation(unmasteredCount, examDate, todayLocalDateString());
  }
  return null;
}

function renderGoalPanel() {
  var hasPack = !!selectedPack;
  var overallGoal = loadDailyGoal();
  if (overallDailyGoalInput && document.activeElement !== overallDailyGoalInput) {
    overallDailyGoalInput.value = String(overallGoal);
  }
  if (overallDailyGoalInput) {
    overallDailyGoalInput.disabled = !auth.currentUser || overallGoalSaveInFlight;
  }
  if (overallDailyGoalDecrease) {
    overallDailyGoalDecrease.disabled = !auth.currentUser || overallGoalSaveInFlight;
  }
  if (overallDailyGoalIncrease) {
    overallDailyGoalIncrease.disabled = !auth.currentUser || overallGoalSaveInFlight;
  }
  if (!packGoalsPanel) return;

  packGoalsPanel.classList.toggle('is-disabled', !hasPack);
  if (packGoalCard) {
    packGoalCard.classList.toggle('is-disabled', !hasPack);
  }

  var stats = hasPack ? getPackStatsSnapshot(selectedPack) : { due: 0, unmastered: 0 };
  if (packGoalDue) { packGoalDue.textContent = formatCardCount(stats.due); }
  if (packGoalUnmastered) { packGoalUnmastered.textContent = formatCardCount(stats.unmastered); }

  if (packDailyGoalInput) {
    var savedPackGoal = hasPack && selectedPack.daily_card_goal !== null && selectedPack.daily_card_goal !== undefined
      ? String(selectedPack.daily_card_goal)
      : '';
    packDailyGoalInput.disabled = !hasPack || packGoalSaveInFlight;
    packDailyGoalInput.dataset.savedGoal = savedPackGoal;
    if (document.activeElement !== packDailyGoalInput) {
      packDailyGoalInput.value = savedPackGoal;
    }
  }
  if (packDailyGoalClear) {
    packDailyGoalClear.disabled = !hasPack || packGoalSaveInFlight;
  }
  if (packDailyGoalDecrease) {
    packDailyGoalDecrease.disabled = !hasPack || packGoalSaveInFlight;
  }
  if (packDailyGoalIncrease) {
    packDailyGoalIncrease.disabled = !hasPack || packGoalSaveInFlight;
  }
  if (packGoalHelper) {
    packGoalHelper.textContent = hasPack
      ? 'Autosaves automatically. Clear removes the saved pack target.'
      : 'Select a study pack to set an optional pack-specific goal.';
  }
}

function getGoalBounds() {
  return {
    min: progressUtils && progressUtils.MIN_DAILY_GOAL ? progressUtils.MIN_DAILY_GOAL : 1,
    max: progressUtils && progressUtils.MAX_DAILY_GOAL ? progressUtils.MAX_DAILY_GOAL : 500
  };
}

function clampGoalNumber(value) {
  var bounds = getGoalBounds();
  var parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return bounds.min;
  return Math.max(bounds.min, Math.min(bounds.max, parsed));
}

function nudgeGoalInput(input, delta, fallbackValue) {
  if (!input || input.disabled) return;
  var currentValue = String(input.value || '').trim();
  var baseValue = currentValue
    ? clampGoalNumber(currentValue)
    : clampGoalNumber(fallbackValue);
  input.value = String(clampGoalNumber(baseValue + delta));
  input.focus();
  input.select();
}

function scheduleOverallGoalAutosave(immediate, showValidationError) {
  if (!overallDailyGoalInput || overallDailyGoalInput.disabled) return;
  if (overallGoalAutosaveTimer) {
    clearTimeout(overallGoalAutosaveTimer);
    overallGoalAutosaveTimer = null;
  }
  if (immediate) {
    persistOverallDailyGoal(!!showValidationError);
    return;
  }
  overallGoalAutosaveTimer = setTimeout(function () {
    overallGoalAutosaveTimer = null;
    persistOverallDailyGoal(!!showValidationError);
  }, GOAL_AUTOSAVE_DELAY_MS);
}

function schedulePackGoalAutosave(immediate, showValidationError) {
  if (!packDailyGoalInput || packDailyGoalInput.disabled) return;
  if (packGoalAutosaveTimer) {
    clearTimeout(packGoalAutosaveTimer);
    packGoalAutosaveTimer = null;
  }
  if (immediate) {
    persistSelectedPackDailyGoal(!!showValidationError);
    return;
  }
  packGoalAutosaveTimer = setTimeout(function () {
    packGoalAutosaveTimer = null;
    persistSelectedPackDailyGoal(!!showValidationError);
  }, GOAL_AUTOSAVE_DELAY_MS);
}

function persistOverallDailyGoal(showValidationError) {
  if (!auth.currentUser || !overallDailyGoalInput || overallGoalSaveInFlight) return;
  var parsedGoal = progressUtils && typeof progressUtils.parseGoalValue === 'function'
    ? progressUtils.parseGoalValue(overallDailyGoalInput.value)
    : parseInt(overallDailyGoalInput.value || '', 10);
  if (!Number.isFinite(parsedGoal) || parsedGoal < 1 || parsedGoal > 500) {
    if (showValidationError) { showToast('Use a goal between 1 and 500.', 'error'); }
    renderGoalPanel();
    return;
  }
  if (parsedGoal === loadDailyGoal()) {
    renderGoalPanel();
    return;
  }

  overallGoalSaveInFlight = true;
  renderGoalPanel();
  apiCall('/api/study-progress', {
    method: 'PUT',
    body: JSON.stringify({
      daily_goal: parsedGoal,
      timezone: progressTimezone || getBrowserTimezone()
    })
  }).then(function () {
    saveDailyGoal(parsedGoal);
    progressSummaryCache = Object.assign({}, progressSummaryCache || {}, { daily_goal: parsedGoal });
    persistSharedSummaryCaches(auth.currentUser, Object.assign({}, buildLiveProgressSummary(), { daily_goal: parsedGoal }));
    broadcastProgressState({ type: 'summary' });
    renderGoalPanel();
    showToast('Daily goal saved automatically.', 'success');
  }).catch(function (e) {
    renderGoalPanel();
    showToast(e.message || 'Could not save overall goal.', 'error');
  }).finally(function () {
    overallGoalSaveInFlight = false;
    renderGoalPanel();
  });
}

function persistSelectedPackDailyGoal(showValidationError) {
  if (!selectedPack || !packDailyGoalInput || packGoalSaveInFlight) return;
  var rawValue = String(packDailyGoalInput.value || '').trim();
  var parsedGoal = rawValue
    ? ((progressUtils && typeof progressUtils.parseGoalValue === 'function')
      ? progressUtils.parseGoalValue(rawValue)
      : parseInt(rawValue, 10))
    : null;
  if (rawValue && (!Number.isFinite(parsedGoal) || parsedGoal < 1 || parsedGoal > 500)) {
    if (showValidationError) { showToast('Pack goals must be between 1 and 500.', 'error'); }
    renderGoalPanel();
    return;
  }
  var savedGoal = String(packDailyGoalInput.dataset.savedGoal || '').trim();
  var normalizedSavedGoal = savedGoal ? parseInt(savedGoal, 10) : null;
  if ((normalizedSavedGoal || null) === (parsedGoal || null)) {
    renderGoalPanel();
    return;
  }

  packGoalSaveInFlight = true;
  renderGoalPanel();
  apiCall('/api/study-packs/' + encodeURIComponent(selectedPack.study_pack_id), {
    method: 'PATCH',
    body: JSON.stringify({ daily_card_goal: parsedGoal === null ? null : parsedGoal })
  }).then(function () {
    selectedPack.daily_card_goal = parsedGoal === null ? null : parsedGoal;
    packs = packs.map(function (pack) {
      if (pack.study_pack_id !== selectedPack.study_pack_id) return pack;
      return Object.assign({}, pack, { daily_card_goal: parsedGoal === null ? null : parsedGoal });
    });
    broadcastProgressState({
      type: 'pack-goal',
      pack_update: {
        pack_id: selectedPack.study_pack_id,
        daily_card_goal: parsedGoal === null ? null : parsedGoal
      }
    });
    renderGoalPanel();
    showToast(parsedGoal === null ? 'Pack goal cleared automatically.' : 'Pack goal saved automatically.', 'success');
  }).catch(function (e) {
    renderGoalPanel();
    showToast(e.message || 'Could not save pack goal.', 'error');
  }).finally(function () {
    packGoalSaveInFlight = false;
    renderGoalPanel();
  });
}

/* ── Match high scores (localStorage) ── */
function getMatchScoreKey() { return 'match_scores_' + (auth.currentUser ? auth.currentUser.uid : 'anon') + '_' + selectedPackId; }
function loadMatchScores() { try { return JSON.parse(localStorage.getItem(getMatchScoreKey())) || []; } catch (e) { return []; } }
function saveMatchScore(timeMs) {
  var scores = loadMatchScores();
  scores.push(timeMs);
  scores.sort(function (a, b) { return a - b; });
  if (scores.length > 10) { scores = scores.slice(0, 10); }
  try { localStorage.setItem(getMatchScoreKey(), JSON.stringify(scores)); } catch (e) { }
  return scores;
}
function getScoreRank(scores, timeMs) {
  for (var i = 0; i < scores.length; i++) {
    if (scores[i] === timeMs) { return i + 1; }
  }
  return scores.length;
}

function getSessionStorageKey() { return 'study_session_' + (auth.currentUser ? auth.currentUser.uid : 'anon') + '_' + selectedPackId; }
function loadSessionState() {
  try {
    var r = localStorage.getItem(getSessionStorageKey());
    if (!r) return;
    var d = JSON.parse(r);
    if (d.settings) { sessionSettings = Object.assign({}, sessionSettings, d.settings); }
    if (d.algo && Array.isArray(d.algo) && d.algo.length === 5) { sessionAlgo = d.algo; }
    if (d.algoPreset) { sessionAlgoPreset = d.algoPreset; }
    if (d.lessons) { sessionLessons = Object.assign({}, sessionLessons, d.lessons); }
  } catch (e) { }
}
function saveSessionState() {
  try { localStorage.setItem(getSessionStorageKey(), JSON.stringify({ settings: sessionSettings, algo: sessionAlgo, algoPreset: sessionAlgoPreset, lessons: sessionLessons })); } catch (e) { }
}

/* ── Algorithm ordering ── */
function orderCardsByAlgo(cards) {
  if (!cards || !cards.length) return [];
  var state = loadCardState();
  var buckets = { new: [], familiar: [], retry: [], remaster: [], hard: [], random: [] };
  var deferred = [];
  cards.forEach(function (c, i) {
    var id = 'fc_' + i; var cs = state[id];
    var entry = { card: c, idx: i };
    var due = !cs || !cs.seen || isDueDate(cs.next_review_date);
    if (due) {
      if (!cs || cs.level === 'new') { buckets.new.push(entry); }
      else if (cs.level === 'familiar') { buckets.familiar.push(entry); }
      else if (cs.level === 'mastered') { buckets.remaster.push(entry); }
      var wrongCount = Number(cs && cs.wrong || 0);
      var correctCount = Number(cs && cs.correct || 0);
      if (cs && (cs.level === 'retry' || cs.last_action === 'retry' || wrongCount > correctCount)) {
        buckets.retry.push(entry);
      }
      if (cs && (cs.difficulty === 'hard' || cs.last_action === 'hard')) { buckets.hard.push(entry); }
    } else {
      deferred.push(entry);
    }
    buckets.random.push({ card: c, idx: i });
  });
  Object.keys(buckets).forEach(function (k) { buckets[k].sort(function () { return Math.random() - 0.5; }); });
  var result = [], used = {};
  sessionAlgo.forEach(function (type) {
    var pool = buckets[type] || buckets.random;
    for (var j = 0; j < pool.length; j++) {
      if (!used[pool[j].idx]) { result.push(pool[j]); used[pool[j].idx] = true; break; }
    }
  });
  cards.forEach(function (c, i) { if (!used[i] && !deferred.find(function (d) { return d.idx === i; })) result.push({ card: c, idx: i }); });
  deferred.forEach(function (entry) { if (!used[entry.idx]) result.push(entry); });
  return result;
}
function getFlashcardQueue() {
  if (orderedFlashcards.length) return orderedFlashcards;
  var base = selectedPack && Array.isArray(selectedPack.flashcards) ? selectedPack.flashcards : [];
  return base.map(function (card, idx) { return { card: card, idx: idx }; });
}
function getCurrentDifficultyCardId() {
  if (!selectedPack) return '';
  if (activeLearnMode === 'flashcards') {
    var queue = getFlashcardQueue();
    if (queue[learnFlashcardIndex]) return 'fc_' + queue[learnFlashcardIndex].idx;
  }
  if (activeLearnMode === 'write') {
    var writeQueue = getWriteCards();
    if (writeQueue[writeIndex]) return 'fc_' + writeQueue[writeIndex].idx;
  }
  if (activeLearnMode === 'test') { return 'q_' + learnQuestionIndex; }
  return '';
}
function updateDifficultyToolbar() {
  if (!difficultyToolbar) return;
  if (!learnStage.classList.contains('visible')) {
    difficultyToolbar.classList.remove('visible');
    difficultyToolbar.classList.remove('faded');
    return;
  }
  if (activeLearnMode !== 'flashcards') {
    difficultyToolbar.classList.remove('visible');
    difficultyToolbar.classList.remove('faded');
    return;
  }
  var cardId = getCurrentDifficultyCardId();
  if (!cardId) {
    difficultyToolbar.classList.remove('visible');
    difficultyToolbar.classList.remove('faded');
    return;
  }
  var state = loadCardState();
  var entry = state[cardId] || {};
  var current = normalizeReviewAction(entry.last_action || mapLegacyDifficultyToAction(entry.difficulty || 'medium'));
  difficultyButtons.forEach(function (btn) {
    var action = normalizeReviewAction(btn.dataset.reviewAction || 'good');
    btn.classList.toggle('active', action === current);
  });
  difficultyToolbar.classList.add('visible');
  difficultyToolbar.classList.remove('faded');
}

/* ── Answer grading (for write mode) ── */
function normalizeAnswer(str) {
  var s = str.trim();
  if (!sessionSettings.caseSensitive) { s = s.toLowerCase(); }
  if (sessionSettings.ignoreBrackets) { s = s.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, ''); }
  if (sessionSettings.ignoreArticles) { s = s.replace(/\b(a|an|the)\b/gi, ''); }
  if (sessionSettings.ignoreDeterminers) { s = s.replace(/[;,\/]/g, ''); }
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}
function gradeAnswer(userAnswer, correctAnswer) {
  var ua = normalizeAnswer(userAnswer);
  var ca = normalizeAnswer(correctAnswer);
  if (sessionSettings.forceExactMatch) { return ua === ca; }
  return ua === ca;
}

/* ── DOM refs ── */
var userMeta = document.getElementById('user-meta'), backAppBtn = document.getElementById('back-app-btn'), fullscreenBtn = document.getElementById('fullscreen-btn'), topbarDueText = document.getElementById('topbar-due-text');
var studyAuthGate = document.getElementById('study-auth-gate'), studyLibraryShell = document.getElementById('study-library-shell'), studyAuthSignInBtn = document.getElementById('study-auth-signin-btn');
var searchInput = document.getElementById('search-input'), folderList = document.getElementById('folder-list'), packList = document.getElementById('pack-list'), newFolderBtn = document.getElementById('new-folder-btn'), deleteFolderBtn = document.getElementById('delete-folder-btn');
var packEmpty = document.getElementById('pack-empty'), packEmptyDefault = document.getElementById('pack-empty-default'), packEmptyOnboarding = document.getElementById('pack-empty-onboarding'), packEmptyCreateBtn = document.getElementById('pack-empty-create-btn'), packEmptyDemoBtn = document.getElementById('pack-empty-demo-btn'), packEditorWrap = document.getElementById('pack-editor-wrap'), packTitle = document.getElementById('pack-title'), packFolderSelect = document.getElementById('pack-folder-select'), packFolderPicker = document.getElementById('pack-folder-picker'), packFolderButton = document.getElementById('pack-folder-button'), packFolderLabel = document.getElementById('pack-folder-label'), packFolderMenu = document.getElementById('pack-folder-menu');
var packCourse = document.getElementById('pack-course'), packSubject = document.getElementById('pack-subject'), packSemester = document.getElementById('pack-semester'), packBlock = document.getElementById('pack-block'), notesView = document.getElementById('notes-view');
var packAdvancedMetaBtn = document.getElementById('pack-advanced-meta-btn'), packAdvancedMetaShell = document.getElementById('pack-advanced-meta-shell'), packAdvancedMetaPanel = document.getElementById('pack-advanced-meta-panel');
var packSummary = document.getElementById('pack-summary'), packSummaryTitle = document.getElementById('pack-summary-title'), packSummaryMeta = document.getElementById('pack-summary-meta'), packStatNotes = document.getElementById('pack-stat-notes'), packStatCards = document.getElementById('pack-stat-cards'), packStatTest = document.getElementById('pack-stat-test');
var packGoalsPanel = document.getElementById('pack-goals-panel'), packGoalCard = document.getElementById('pack-goal-card'), overallDailyGoalInput = document.getElementById('overall-daily-goal-input'), overallDailyGoalDecrease = document.getElementById('overall-daily-goal-decrease'), overallDailyGoalIncrease = document.getElementById('overall-daily-goal-increase'), packDailyGoalInput = document.getElementById('pack-daily-goal-input'), packDailyGoalClear = document.getElementById('pack-daily-goal-clear'), packDailyGoalDecrease = document.getElementById('pack-daily-goal-decrease'), packDailyGoalIncrease = document.getElementById('pack-daily-goal-increase'), packGoalDue = document.getElementById('pack-goal-due'), packGoalUnmastered = document.getElementById('pack-goal-unmastered'), packGoalHelper = document.getElementById('pack-goal-helper');
var createPackBtn = document.getElementById('create-pack-btn'), openBuilderBtn = document.getElementById('open-builder-btn'), savePackBtn = document.getElementById('save-pack-btn'), deletePackBtn = document.getElementById('delete-pack-btn'), exportPackNotesBtn = document.getElementById('export-pack-notes-btn'), openLearnBtn = document.getElementById('open-learn-btn');
var exportMenu = document.getElementById('export-menu'), exportMenuBtn = document.getElementById('export-menu-btn'), exportMenuList = document.getElementById('export-menu-list'), exportPdfSubmenu = document.getElementById('export-pdf-submenu');
var editorTabs = document.querySelectorAll('.editor-tab'), flashcardCount = document.getElementById('flashcard-count'), questionCount = document.getElementById('question-count'), addFlashcardBtn = document.getElementById('add-flashcard-btn'), addQuestionBtn = document.getElementById('add-question-btn'), flashcardEditorList = document.getElementById('flashcard-editor-list'), questionEditorList = document.getElementById('question-editor-list');
var learnStage = document.getElementById('learn-stage'), learnTitle = document.getElementById('learn-title'), learnSub = document.getElementById('learn-sub'), learnBackAppBtn = document.getElementById('learn-back-app-btn'), learnBackLibraryBtn = document.getElementById('learn-back-library-btn'), learnFullscreenBtn = document.getElementById('learn-fullscreen-btn');
var notesPaneShell = document.getElementById('notes-pane-shell'), notesFullscreenBtn = document.getElementById('notes-fullscreen-btn');
var notesHighlightStatus = document.getElementById('notes-highlight-status');
var hlDownloadWrap = document.getElementById('hl-download-wrap');
var learnModeLabel = document.getElementById('learn-mode-label');
var learnFlashcard3d = document.getElementById('learn-flashcard-3d'), learnFlashcardInner = document.getElementById('learn-flashcard-inner'), learnFlashcardFront = document.getElementById('learn-flashcard-front'), learnFlashcardBack = document.getElementById('learn-flashcard-back');
var learnFPrev = document.getElementById('learn-f-prev'), learnFFlip = document.getElementById('learn-f-flip'), learnFNext = document.getElementById('learn-f-next'), learnFProgress = document.getElementById('learn-f-progress');
var learnFListBtn = document.getElementById('learn-f-list-btn'), learnFPeekWrap = document.getElementById('learn-f-peek-wrap'), learnFPeekToggle = document.getElementById('learn-f-peek-toggle'), learnFListView = document.getElementById('learn-f-list-view');
var learnProgressFill = document.getElementById('learn-progress-fill'), learnProgressText = document.getElementById('learn-progress-text');
var learnQProgress = document.getElementById('learn-q-progress'), learnQScore = document.getElementById('learn-q-score'), learnQText = document.getElementById('learn-q-text'), learnQOptions = document.getElementById('learn-q-options'), learnQExpl = document.getElementById('learn-q-expl'), learnQNext = document.getElementById('learn-q-next');
var writePromptEl = document.getElementById('write-prompt'), writeInputEl = document.getElementById('write-input'), writeCheckBtn = document.getElementById('write-check-btn'), writeRevealBtn = document.getElementById('write-reveal-btn'), writeFeedbackEl = document.getElementById('write-feedback'), writeNextBtn = document.getElementById('write-next-btn'), writeProgressEl = document.getElementById('write-progress');
var matchGridEl = document.getElementById('match-grid'), matchTimerEl = document.getElementById('match-timer'), matchResultsEl = document.getElementById('match-results'), matchResultsTime = document.getElementById('match-results-time'), matchResultsBadge = document.getElementById('match-results-badge'), matchResultsHistory = document.getElementById('match-results-history'), matchPlayAgainBtn = document.getElementById('match-play-again');
var setupOverlay = document.getElementById('setup-overlay'), setupPackName = document.getElementById('setup-pack-name'), setupCloseBtn = document.getElementById('setup-close-btn'), setupStartBtn = document.getElementById('setup-start-btn'), setupMainContent = document.getElementById('setup-main-content'), setupTabs = document.querySelectorAll('.setup-tab'), algoLane = document.getElementById('algo-lane'), algoPresets = document.querySelectorAll('.algo-preset');
var masterySeenEl = document.getElementById('mastery-seen'), masteryTotalEl = document.getElementById('mastery-total'), masteryNewPctEl = document.getElementById('mastery-new-pct'), masteryFamiliarPctEl = document.getElementById('mastery-familiar-pct'), masteryMasteredPctEl = document.getElementById('mastery-mastered-pct'), masteryDueTodayEl = document.getElementById('mastery-due-today'), masteryUnmasteredEl = document.getElementById('mastery-unmastered'), diffRetryCountEl = document.getElementById('diff-retry-count'), diffHardCountEl = document.getElementById('diff-hard-count'), diffGoodCountEl = document.getElementById('diff-good-count'), diffEasyCountEl = document.getElementById('diff-easy-count'), examRecommendationEl = document.getElementById('exam-recommendation');
var modePicker = document.getElementById('mode-picker'), modePickerGrid = document.getElementById('mode-picker-grid'), modePickerBack = document.getElementById('mode-picker-back');
var builderOverlay = document.getElementById('builder-overlay'), builderBrandSub = document.getElementById('builder-brand-sub'), builderSaveBtn = document.getElementById('builder-save-btn'), builderExitBtn = document.getElementById('builder-exit-btn'), builderShareBtn = document.getElementById('builder-share-btn'), builderTitleEl = document.getElementById('builder-title'), builderSubEl = document.getElementById('builder-sub'), builderSummary = document.getElementById('builder-summary'), builderOpenLearnShortcut = document.getElementById('builder-open-learn-shortcut');
var builderPaneButtons = document.querySelectorAll('.builder-nav-btn[data-builder-pane]'), builderStatCards = document.getElementById('builder-stat-cards'), builderStatQuestions = document.getElementById('builder-stat-questions'), builderStatDirty = document.getElementById('builder-stat-dirty');
var builderTitleInput = document.getElementById('builder-title-input'), builderFolderSelect = document.getElementById('builder-folder-select'), builderCourseInput = document.getElementById('builder-course-input'), builderSubjectInput = document.getElementById('builder-subject-input'), builderSemesterInput = document.getElementById('builder-semester-input'), builderBlockInput = document.getElementById('builder-block-input'), builderNotesInput = document.getElementById('builder-notes-input');
var builderAdvancedMetaBtn = document.getElementById('builder-advanced-meta-btn'), builderAdvancedMetaPanel = document.getElementById('builder-advanced-meta-panel');
var builderFlashcardList = document.getElementById('builder-flashcard-list'), builderQuestionList = document.getElementById('builder-question-list'), builderAddCardBtn = document.getElementById('builder-add-card-btn'), builderAddCardBatchBtn = document.getElementById('builder-add-card-batch-btn'), builderAddQuestionBtn = document.getElementById('builder-add-question-btn'), builderAddQuestionBatchBtn = document.getElementById('builder-add-question-batch-btn');
var builderImportType = document.getElementById('builder-import-type'), builderImportMode = document.getElementById('builder-import-mode'), builderCsvDrop = document.getElementById('builder-csv-drop'), builderCsvInput = document.getElementById('builder-csv-input'), builderTemplateBtn = document.getElementById('builder-template-btn'), builderApplyImportBtn = document.getElementById('builder-apply-import-btn'), builderImportSummary = document.getElementById('builder-import-summary'), builderPreview = document.getElementById('builder-preview'), builderPreviewTable = document.getElementById('builder-preview-table'), builderImportErrors = document.getElementById('builder-import-errors');
var builderExitOverlay = document.getElementById('builder-exit-overlay'), builderExitSave = document.getElementById('builder-exit-save'), builderExitDiscard = document.getElementById('builder-exit-discard'), builderExitCancel = document.getElementById('builder-exit-cancel');
var learnNotesContent = document.getElementById('learn-notes-content');
var folderModalOverlay = document.getElementById('folder-modal-overlay'), folderModalTitle = document.getElementById('folder-modal-title'), folderModalClose = document.getElementById('folder-modal-close'), folderModalCancel = document.getElementById('folder-modal-cancel'), folderModalSave = document.getElementById('folder-modal-save'), folderNameInput = document.getElementById('folder-name-input'), folderCourseInput = document.getElementById('folder-course-input'), folderSubjectInput = document.getElementById('folder-subject-input'), folderSemesterInput = document.getElementById('folder-semester-input'), folderBlockInput = document.getElementById('folder-block-input'), folderExamDateInput = document.getElementById('folder-exam-date-input');
var confirmModalOverlay = document.getElementById('confirm-modal-overlay'), confirmModalTitle = document.getElementById('confirm-modal-title'), confirmModalMessage = document.getElementById('confirm-modal-message'), confirmModalClose = document.getElementById('confirm-modal-close'), confirmModalCancel = document.getElementById('confirm-modal-cancel'), confirmModalConfirm = document.getElementById('confirm-modal-confirm');
var toastEl = document.getElementById('toast');
var audioPlayerBar = document.getElementById('audio-player-bar'), audioPlayerEl = document.getElementById('audio-player-el'), audioPlayBtn = document.getElementById('audio-play-btn'), audioPlayIcon = document.getElementById('audio-play-icon'), audioPauseIcon = document.getElementById('audio-pause-icon'), audioTime = document.getElementById('audio-time'), audioProgressWrap = document.getElementById('audio-progress-wrap'), audioProgressFill = document.getElementById('audio-progress-fill'), audioSpeedBtn = document.getElementById('audio-speed-btn'), audioPackTitle = document.getElementById('audio-pack-title'), audioCloseBtn = document.getElementById('audio-close-btn');
var audioBlobUrl = '';
var difficultyToolbar = document.getElementById('difficulty-toolbar'), difficultyButtons = document.querySelectorAll('.difficulty-btn[data-review-action]');
var keyboardHints = document.querySelector('.keyboard-hints');
var STUDY_DUE_CACHE_GLOBAL_KEY = 'study_due_today:last';
var STUDY_DUE_CACHE_USER_PREFIX = 'study_due_today:user:';
var toastTimer = null;

/* ── Helpers ── */
function showToast(msg, type) {
  if (!toastEl || !msg) return;
  toastEl.textContent = msg;
  toastEl.className = 'toast visible ' + (type || 'success');
  if (toastTimer) { clearTimeout(toastTimer); }
  toastTimer = setTimeout(function () { toastEl.classList.remove('visible'); }, 2800);
}
function setStudyLibraryVisibility(signedIn) {
  if (studyAuthGate) { studyAuthGate.hidden = !!signedIn; }
  if (studyLibraryShell) { studyLibraryShell.hidden = !signedIn; }
}
function openStudySignIn() {
  var shellSignInBtn = document.getElementById('shell-sign-in-btn');
  if (shellSignInBtn && typeof shellSignInBtn.click === 'function') {
    shellSignInBtn.click();
    return;
  }
  window.location.href = '/lecture-notes?auth=signin';
}
function applyStudySignedOutState() {
  setStudyLibraryVisibility(false);
  folders = [];
  packs = [];
  selectedFolderId = '';
  selectedPackId = '';
  selectedPack = null;
  pendingOpenPackId = '';
  draggedPackId = '';
  orderedFlashcards = [];
  remoteProgressCardStates = {};
  flashcardPeekRevealed = {};
  if (setupOverlay && setupOverlay.classList.contains('visible')) { closeSessionSetup(); }
  if (learnStage && learnStage.classList.contains('visible')) { closeLearnStage(); }
  if (folderModalOverlay && folderModalOverlay.classList.contains('visible')) { closeFolderModal(); }
  if (confirmModalOverlay && confirmModalOverlay.classList.contains('visible')) { closeConfirmModal(false); }
  renderFolderSelect();
  renderFolders();
  renderPacks();
  showPackEditor(false);
  updatePackSummary();
  renderGoalPanel();
  closeAudioPlayer();
  setTopbarDueTextValue(null);
}
function readUiCacheJson(key, fallbackValue) {
  if (uiCache && typeof uiCache.getJson === 'function') {
    return uiCache.getJson(key, fallbackValue);
  }
  try {
    var raw = localStorage.getItem('lp_ui_v2:' + key);
    return raw ? JSON.parse(raw) : fallbackValue;
  } catch (e) {
    return fallbackValue;
  }
}
function writeUiCacheJson(key, value) {
  if (uiCache && typeof uiCache.setJson === 'function') {
    return uiCache.setJson(key, value);
  }
  try {
    localStorage.setItem('lp_ui_v2:' + key, JSON.stringify(value));
    return true;
  } catch (e) {
    return false;
  }
}
function getStudyDueCacheKey(user) {
  return STUDY_DUE_CACHE_USER_PREFIX + String((user && user.uid) || 'anon');
}
function setTopbarDueTextValue(countValue) {
  if (!topbarDueText) return;
  if (countValue === null || countValue === undefined || countValue === '') {
    topbarDueText.textContent = 'Loading due count';
    return;
  }
  var total = Math.max(0, Number(countValue || 0));
  topbarDueText.textContent = total + ' due today';
}
function hydrateTopbarDueFromCache(user) {
  var cached = readUiCacheJson(getStudyDueCacheKey(user), null);
  if (!cached || typeof cached !== 'object') {
    cached = readUiCacheJson(STUDY_DUE_CACHE_GLOBAL_KEY, null);
  }
  if (!cached || typeof cached !== 'object' || !Object.prototype.hasOwnProperty.call(cached, 'count')) {
    setTopbarDueTextValue(null);
    return;
  }
  setTopbarDueTextValue(cached.count);
}
function persistTopbarDueToCache(user, countValue) {
  var payload = { count: Math.max(0, Number(countValue || 0)), updated_at: Date.now() };
  writeUiCacheJson(STUDY_DUE_CACHE_GLOBAL_KEY, payload);
  writeUiCacheJson(getStudyDueCacheKey(user), payload);
}
function persistSharedSummaryCaches(user, summary) {
  if (!user || !summary) return;
  var snapshot = progressUtils && typeof progressUtils.summarySnapshot === 'function'
    ? progressUtils.summarySnapshot(summary, progressUtils.DEFAULT_DAILY_GOAL || 20)
    : {
      streak: Math.max(0, Number(summary.current_streak || 0)),
      due: Math.max(0, Number(summary.due_today || 0)),
      done: Math.max(0, Number(summary.today_progress || 0)),
      goal: Math.max(1, Number(summary.daily_goal || 20))
    };
  writeUiCacheJson('plan_summary:last', summary);
  writeUiCacheJson('plan_summary:user:' + String(user.uid || 'anon'), summary);
  writeUiCacheJson('dashboard_summary:last', snapshot);
  writeUiCacheJson('dashboard_summary:user:' + String(user.uid || 'anon'), snapshot);
}
function buildLiveProgressSummary() {
  var snapshot = readLocalProgressSnapshot();
  var streakData = snapshot.streak_data || {};
  var today = todayLocalDateString();
  var dueTotal = 0;
  Object.keys(snapshot.card_states || {}).forEach(function (packId) {
    dueTotal += countDueCardsInState(snapshot.card_states[packId] || {});
  });
  return {
    current_streak: Math.max(0, parseInt(streakData.current_streak, 10) || 0),
    due_today: dueTotal,
    today_progress: String(streakData.daily_progress_date || '') === today
      ? Math.max(0, parseInt(streakData.daily_progress_count, 10) || 0)
      : 0,
    daily_goal: loadDailyGoal()
  };
}
function broadcastProgressState(extraPayload) {
  if (!auth.currentUser) return;
  var summary = buildLiveProgressSummary();
  progressSummaryCache = Object.assign({}, progressSummaryCache || {}, summary);
  persistSharedSummaryCaches(auth.currentUser, progressSummaryCache);
  if (progressUtils && typeof progressUtils.broadcastProgressEvent === 'function') {
    progressUtils.broadcastProgressEvent(Object.assign({
      source_id: progressSyncSourceId,
      user_id: auth.currentUser.uid,
      summary: progressSummaryCache,
      topbar_due: summary.due_today
    }, extraPayload || {}));
  }
}
function applyExternalPackGoalUpdate(payload) {
  var safePayload = payload && typeof payload === 'object' ? payload : {};
  var packId = String(safePayload.pack_id || '').trim();
  if (!packId) return;
  var nextGoal = safePayload.daily_card_goal === null || safePayload.daily_card_goal === undefined
    ? null
    : clampGoalNumber(safePayload.daily_card_goal);
  packs = (packs || []).map(function (pack) {
    if (String(pack.study_pack_id || '') !== packId) return pack;
    return Object.assign({}, pack, { daily_card_goal: nextGoal });
  });
  if (selectedPack && String(selectedPack.study_pack_id || '') === packId) {
    selectedPack.daily_card_goal = nextGoal;
    renderGoalPanel();
  }
}
function handleExternalProgressEvent(payload) {
  if (!auth.currentUser || !payload || payload.source_id === progressSyncSourceId) return;
  if (payload.user_id && payload.user_id !== auth.currentUser.uid) return;
  if (payload.summary && typeof payload.summary === 'object') {
    progressHydrationDone = true;
    progressSummaryCache = Object.assign({}, progressSummaryCache || {}, payload.summary);
    if (typeof payload.summary.daily_goal === 'number') {
      saveDailyGoal(payload.summary.daily_goal);
    }
    persistSharedSummaryCaches(auth.currentUser, progressSummaryCache);
    renderGoalPanel();
    if (Object.prototype.hasOwnProperty.call(payload, 'topbar_due')) {
      setTopbarDueTextValue(payload.topbar_due);
      persistTopbarDueToCache(auth.currentUser, payload.topbar_due);
    } else if (Object.prototype.hasOwnProperty.call(payload.summary, 'due_today')) {
      setTopbarDueTextValue(payload.summary.due_today);
      persistTopbarDueToCache(auth.currentUser, payload.summary.due_today);
    }
  }
  if (payload.pack_update) {
    applyExternalPackGoalUpdate(payload.pack_update);
  }
}
if (progressUtils && typeof progressUtils.subscribeProgressEvent === 'function') {
  progressUtils.subscribeProgressEvent(handleExternalProgressEvent);
}
function getVisibleMenuItems(menu, selector) {
  if (uxUtils.getVisibleMenuItems) { return uxUtils.getVisibleMenuItems(menu, selector || 'button:not([disabled])'); }
  if (!menu) return [];
  return Array.from(menu.querySelectorAll(selector || 'button:not([disabled])')).filter(function (item) { return item.offsetParent !== null && !item.disabled; });
}
function focusMenuItem(menu, selector, mode) {
  if (uxUtils.focusMenuItem) { uxUtils.focusMenuItem(menu, selector, mode); return; }
  var items = getVisibleMenuItems(menu, selector);
  if (!items.length) return;
  if (mode === 'last') { items[items.length - 1].focus(); return; }
  var active = document.activeElement;
  var idx = items.indexOf(active);
  if (mode === 'next') {
    items[(idx + 1 + items.length) % items.length].focus();
    return;
  }
  if (mode === 'prev') {
    items[(idx - 1 + items.length) % items.length].focus();
    return;
  }
  if (mode === 'active') {
    var selected = items.find(function (item) { return item.classList.contains('active') || item.getAttribute('aria-selected') === 'true'; });
    (selected || items[0]).focus();
    return;
  }
  items[0].focus();
}
function updatePackEmptyState() {
  var hasPacks = (packs || []).length > 0;
  if (packEmptyDefault) { packEmptyDefault.classList.toggle('visible', hasPacks); }
  if (packEmptyOnboarding) { packEmptyOnboarding.classList.toggle('visible', !hasPacks); }
}
function setAdvancedMetadataPanelState(button, panel, open, shell) {
  if (!button || !panel) { return; }
  var isOpen = !!open;
  if (shell) {
    shell.classList.toggle('visible', isOpen);
    shell.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  } else {
    panel.classList.toggle('visible', isOpen);
    panel.setAttribute('aria-hidden', isOpen ? 'false' : 'true');
  }
  button.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  button.textContent = isOpen ? 'Hide advanced metadata' : 'Show advanced metadata';
}
function applyPackAdvancedMetadataState(open) {
  packAdvancedMetadataOpen = !!open;
  setAdvancedMetadataPanelState(packAdvancedMetaBtn, packAdvancedMetaPanel, packAdvancedMetadataOpen, packAdvancedMetaShell);
}
function applyBuilderAdvancedMetadataState(open) {
  builderAdvancedMetadataOpen = !!open;
  setAdvancedMetadataPanelState(builderAdvancedMetaBtn, builderAdvancedMetaPanel, builderAdvancedMetadataOpen);
}
function syncPackAdvancedMetadataState() {
  applyPackAdvancedMetadataState(packAdvancedMetadataOpen);
}
function syncBuilderAdvancedMetadataState() {
  if (!builderSemesterInput || !builderBlockInput) { return; }
  var hasValue = !!String(builderSemesterInput.value || '').trim() || !!String(builderBlockInput.value || '').trim();
  applyBuilderAdvancedMetadataState(builderAdvancedMetadataOpen || hasValue);
}
applyPackAdvancedMetadataState(false);
applyBuilderAdvancedMetadataState(false);
renderGoalPanel();
function setPackFolderMenuOpen(open, focusMode) {
  if (!packFolderMenu || !packFolderButton) return;
  var shouldOpen = !!open;
  packFolderMenu.classList.toggle('visible', shouldOpen);
  packFolderButton.classList.toggle('open', shouldOpen);
  packFolderButton.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  if (shouldOpen && focusMode) { focusMenuItem(packFolderMenu, '.app-select-item', focusMode); }
}
function closeQuestionAnswerMenus() {
  questionEditorList.querySelectorAll('[data-answer-menu]').forEach(function (menu) { menu.classList.remove('visible'); });
  questionEditorList.querySelectorAll('[data-answer-button]').forEach(function (button) { button.classList.remove('open'); button.setAttribute('aria-expanded', 'false'); });
}
function setQuestionAnswerMenuOpen(button, menu, open, focusMode) {
  if (!button || !menu) return;
  closeQuestionAnswerMenus();
  if (!open) return;
  menu.classList.add('visible');
  button.classList.add('open');
  button.setAttribute('aria-expanded', 'true');
  if (focusMode) { focusMenuItem(menu, '[data-answer-item]', focusMode); }
}
function setExportPdfSubmenuOpen(open) {
  if (!exportPdfSubmenu) return;
  var shouldOpen = !!open;
  exportPdfSubmenu.classList.toggle('visible', shouldOpen);
  var trigger = exportMenuList ? exportMenuList.querySelector('[data-export-kind="pdf-menu"]') : null;
  if (trigger) { trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false'); }
}
function setExportMenuOpen(open, focusMode) {
  if (!exportMenuList || !exportMenuBtn) return;
  var shouldOpen = !!open;
  exportMenuList.classList.toggle('visible', shouldOpen);
  exportMenuBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  if (!shouldOpen) { setExportPdfSubmenuOpen(false); return; }
  if (focusMode) { focusMenuItem(exportMenuList, '.export-menu-item', focusMode); }
}
function mdToHtml(md) {
  if (markdownUtils.parseMarkdownToSafeHtml) {
    return markdownUtils.parseMarkdownToSafeHtml(md, {
      preprocess: function (raw) {
        return String(raw || '')
          .replace(/\r\n/g, '\n')
          .replace(/^\s*<!--\s*audio:\d+\s*-\s*\d+\s*-->\s*$/gim, '')
          .replace(/^\s*[→>-]?\s*audio:\d+\s*-\s*\d+\s*[→-]?\s*$/gim, '')
          .replace(/^\s*\[\s*audio:\d+\s*-\s*\d+\s*\]\s*$/gim, '')
          .replace(/[→>\-]?\s*audio:\d+\s*-\s*\d+\s*[→>\-]?/gim, '');
      }
    });
  }
  return escapeHtml(String(md || '')).replace(/\n/g, '<br>');
}
function fmtAudioTime(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  var m = Math.floor(seconds / 60), s = Math.floor(seconds % 60);
  return m + ':' + String(s).padStart(2, '0');
}
function updateAudioBarVisibility() {
  if (!audioPlayerBar) return;
  var shouldShow = audioReady && !audioHiddenForLearn;
  audioPlayerBar.classList.toggle('visible', shouldShow);
}
function setAudioHiddenForLearn(hidden) {
  audioHiddenForLearn = !!hidden;
  if (audioHiddenForLearn && audioPlayerEl) {
    try { audioPlayerEl.pause(); } catch (_) { }
  }
  updateAudioBarVisibility();
}
function updateAudioControls() {
  var paused = !audioPlayerEl || audioPlayerEl.paused;
  if (audioPlayIcon) audioPlayIcon.style.display = paused ? '' : 'none';
  if (audioPauseIcon) audioPauseIcon.style.display = paused ? 'none' : '';
  var dur = audioPlayerEl && isFinite(audioPlayerEl.duration) ? audioPlayerEl.duration : 0;
  var cur = audioPlayerEl ? audioPlayerEl.currentTime : 0;
  if (audioTime) audioTime.textContent = fmtAudioTime(cur) + ' / ' + fmtAudioTime(dur);
  var pct = dur > 0 ? (cur / dur) * 100 : 0;
  if (audioProgressFill) audioProgressFill.style.width = pct + '%';
}
function clearAudioActiveSections() {
  audioSections.forEach(function (entry) { entry.el.classList.remove('audio-active'); });
}
function updateAudioActiveSection() {
  if (!audioMap.length) { clearAudioActiveSections(); return; }
  var currentMs = (audioPlayerEl.currentTime || 0) * 1000;
  var activeSectionIndex = -1;
  for (var i = 0; i < audioMap.length; i++) {
    var seg = audioMap[i];
    if (currentMs >= seg.start_ms && currentMs <= seg.end_ms) { activeSectionIndex = seg.section_index; break; }
  }
  audioSections.forEach(function (entry) { entry.el.classList.toggle('audio-active', entry.sectionIndex === activeSectionIndex); });
}
function seekAudioTo(startMs) {
  if (!audioReady || !audioPlayerEl) return;
  audioPlayerEl.currentTime = Math.max(0, startMs / 1000);
  audioPlayerEl.play().catch(function () { });
  updateAudioControls();
  updateAudioActiveSection();
}
function closeAudioPlayer() {
  if (audioPlayerEl) { audioPlayerEl.pause(); audioPlayerEl.removeAttribute('src'); audioPlayerEl.load(); }
  if (audioBlobUrl) { URL.revokeObjectURL(audioBlobUrl); audioBlobUrl = ''; }
  if (audioPlayerBar) audioPlayerBar.classList.remove('visible');
  document.querySelectorAll('.notes-audio-section.audio-active').forEach(function (el) { el.classList.remove('audio-active'); });
  audioReady = false; audioMap = []; audioSections = [];
}
function decorateNotesWithAudio(container) {
  if (!container || !audioMap.length) return;
  var mapByIdx = {};
  audioMap.forEach(function (item) { mapByIdx[item.section_index] = item; });
  var headings = container.querySelectorAll('h1,h2,h3');
  for (var i = 0; i < headings.length; i++) {
    var heading = headings[i], entry = mapByIdx[i];
    var wrapper = document.createElement('div');
    wrapper.className = 'notes-audio-section' + (entry ? ' has-audio' : '');
    wrapper.dataset.sectionIndex = String(i);
    heading.parentNode.insertBefore(wrapper, heading);
    var node = heading;
    while (node) {
      var next = node.nextElementSibling;
      wrapper.appendChild(node);
      if (!next || /^(H1|H2|H3)$/.test(next.tagName)) break;
      node = next;
    }
    if (entry) {
      (function (seg, sectionIndex, wrap) {
        audioSections.push({ el: wrap, sectionIndex: sectionIndex });
        var playBtn = document.createElement('button');
        playBtn.type = 'button';
        playBtn.className = 'notes-audio-btn';
        var icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'currentColor');
        var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M8 5v14l11-7z');
        icon.appendChild(path);
        playBtn.appendChild(icon);
        playBtn.addEventListener('click', function (e) { e.stopPropagation(); seekAudioTo(seg.start_ms); });
        wrap.appendChild(playBtn);
        wrap.addEventListener('click', function (e) { if (e.target.tagName === 'A') return; seekAudioTo(seg.start_ms); });
      })(entry, i, wrapper);
    }
  }
}
function initAudioForSelectedPack() {
  closeAudioPlayer();
  if (!selectedPack || !selectedPack.has_audio_playback) return;
  audioMap = (selectedPack.has_audio_sync && Array.isArray(selectedPack.notes_audio_map)) ? selectedPack.notes_audio_map.slice() : [];
  if (audioPackTitle) audioPackTitle.textContent = selectedPack.title || 'Lecture audio';
  authenticatedFetch('/api/study-packs/' + encodeURIComponent(selectedPack.study_pack_id) + '/audio').then(function (response) {
    if (!response.ok) {
      return response.json().catch(function () { return {}; }).then(function (body) {
        throw new Error((body && body.error) || 'Could not load audio');
      });
    }
    return response.blob();
  }).then(function (blob) {
    if (!blob || !blob.size) return;
    audioBlobUrl = URL.createObjectURL(blob);
    audioPlayerEl.src = audioBlobUrl;
    audioPlayerEl.playbackRate = audioSpeeds[audioSpeedIndex];
    audioSpeedBtn.textContent = audioSpeeds[audioSpeedIndex] + 'x';
    audioReady = true;
    updateAudioBarVisibility();
    updateAudioControls();
  }).catch(function (e) {
    console.warn('Audio sync unavailable:', e && e.message ? e.message : e);
  });
}

function clearHintFadeTimers() {
  if (difficultyFadeTimer) { clearTimeout(difficultyFadeTimer); difficultyFadeTimer = null; }
  if (keyboardHintFadeTimer) { clearTimeout(keyboardHintFadeTimer); keyboardHintFadeTimer = null; }
}
function scheduleHintFade() {
  clearHintFadeTimers();
  if (!learnStage.classList.contains('visible')) return;
  difficultyFadeTimer = setTimeout(function () {
    if (!learnStage.classList.contains('visible')) return;
    if (difficultyToolbar && difficultyToolbar.classList.contains('visible')) difficultyToolbar.classList.add('faded');
  }, HINT_FADE_DELAY_MS);
  if (activeLearnMode === 'flashcards') {
    keyboardHintFadeTimer = setTimeout(function () {
      if (learnStage.classList.contains('visible') && keyboardHints) keyboardHints.classList.add('faded');
    }, HINT_FADE_DELAY_MS);
  }
}
function resetLearnHintVisibility() {
  if (difficultyToolbar) difficultyToolbar.classList.remove('faded');
  if (keyboardHints) keyboardHints.classList.remove('faded');
  scheduleHintFade();
}
function scheduleNotesFullscreenIdle() {
  if (!notesFullscreenBtn) return;
  if (notesFullscreenFadeTimer) { clearTimeout(notesFullscreenFadeTimer); notesFullscreenFadeTimer = null; }
  notesFullscreenBtn.classList.remove('idle');
  if (activeEditorPane !== 'notes') return;
  notesFullscreenFadeTimer = setTimeout(function () {
    if (activeEditorPane === 'notes' && notesFullscreenBtn) { notesFullscreenBtn.classList.add('idle'); }
  }, NOTES_ICON_IDLE_MS);
}
function openNotesFullscreen() {
  var target = notesPaneShell || notesView;
  if (!target) return;
  try {
    if (document.fullscreenElement === target) { document.exitFullscreen(); }
    else { target.requestFullscreen(); }
  } catch (e) { showToast('Fullscreen not available.', 'error'); }
}

function ensureAuthToken(forceRefresh) {
  if (authClient && typeof authClient.ensureToken === 'function') {
    return authClient.ensureToken(!!forceRefresh).then(function (t) { token = t; return t; });
  }
  if (!auth.currentUser) { return Promise.reject(new Error('Please sign in')); }
  if (token && !forceRefresh) { return Promise.resolve(token); }
  return auth.currentUser.getIdToken(!!forceRefresh).then(function (t) { token = t; return t; });
}
function withAuthHeaders(opts, activeToken) {
  var requestOptions = opts || {};
  var headers = Object.assign({}, requestOptions.headers || {}, { Authorization: 'Bearer ' + (activeToken || token || '') });
  var isFormData = typeof FormData !== 'undefined' && requestOptions.body instanceof FormData;
  if (requestOptions.body && !isFormData && !headers['Content-Type']) { headers['Content-Type'] = 'application/json'; }
  return Object.assign({}, requestOptions, { headers: headers });
}
function performAuthenticatedFetch(path, options, allowRefresh) {
  if (authClient && typeof authClient.authFetch === 'function') {
    return authClient.authFetch(path, options, { retryOn401: allowRefresh !== false, ensureJsonContentType: true }).then(function (response) {
      if (typeof authClient.getToken === 'function') {
        var latestToken = authClient.getToken();
        if (latestToken) { token = latestToken; }
      }
      return response;
    });
  }
  return ensureAuthToken(false).then(function () {
    return fetch(path, withAuthHeaders(options, token));
  }).then(function (response) {
    if (response.status === 401 && allowRefresh !== false) {
      return ensureAuthToken(true).then(function () {
        return fetch(path, withAuthHeaders(options, token));
      });
    }
    return response;
  });
}
function apiCall(path, options) {
  return performAuthenticatedFetch(path, options, true).then(function (res) {
    var isJson = (res.headers.get('content-type') || '').indexOf('application/json') >= 0;
    return (isJson ? res.json() : Promise.resolve(null)).then(function (data) {
      if (!res.ok) {
        if (res.status === 401) { throw new Error('Session expired. Please sign in again.'); }
        throw new Error((data && data.error) || 'Request failed');
      }
      return data;
    });
  });
}
function authenticatedFetch(path, options, allowRefresh) {
  return performAuthenticatedFetch(path, options, allowRefresh !== false);
}
function downloadStudyPackCsv(packId, type) {
  var fallback = type === 'test' ? 'study-pack-' + packId + '-practice-test.csv' : 'study-pack-' + packId + '-flashcards.csv';
  return authenticatedFetch('/api/study-packs/' + encodeURIComponent(packId) + '/export-flashcards-csv?type=' + encodeURIComponent(type)).then(function (r) {
    if (!r.ok) { return r.json().catch(function () { return {}; }).then(function (d) { throw new Error(d.error || 'Could not export CSV'); }); }
    if (downloadUtils.downloadResponseBlob) {
      return downloadUtils.downloadResponseBlob(r, fallback);
    }
    return r.blob().then(function (blob) {
      var url = URL.createObjectURL(blob); var anchor = document.createElement('a'); anchor.href = url; anchor.download = fallback; document.body.appendChild(anchor); anchor.click(); document.body.removeChild(anchor); URL.revokeObjectURL(url);
    });
  });
}
function downloadStudyPackNotes(packId, format) {
  var fmt = (format || 'docx').toLowerCase();
  var fallback = 'study-pack-' + packId + '-notes.' + (fmt === 'md' ? 'md' : 'docx');
  return authenticatedFetch('/api/study-packs/' + encodeURIComponent(packId) + '/export-notes?format=' + encodeURIComponent(fmt)).then(function (r) {
    if (!r.ok) { return r.json().catch(function () { return {}; }).then(function (d) { throw new Error(d.error || 'Could not export notes'); }); }
    if (downloadUtils.downloadResponseBlob) {
      return downloadUtils.downloadResponseBlob(r, fallback);
    }
    return r.blob().then(function (blob) {
      var url = URL.createObjectURL(blob); var anchor = document.createElement('a'); anchor.href = url; anchor.download = fallback; document.body.appendChild(anchor); anchor.click(); document.body.removeChild(anchor); URL.revokeObjectURL(url);
    });
  });
}
function downloadStudyPackPdf(packId, includeAnswers) {
  var withAnswers = (includeAnswers !== false);
  var fallback = 'study-pack-' + packId + (withAnswers ? '' : '-no-answers') + '.pdf';
  var query = 'include_answers=' + (withAnswers ? '1' : '0');
  return authenticatedFetch('/api/study-packs/' + encodeURIComponent(packId) + '/export-pdf?' + query).then(function (r) {
    if (!r.ok) { return r.json().catch(function () { return {}; }).then(function (d) { throw new Error(d.error || 'Could not export PDF'); }); }
    if (downloadUtils.downloadResponseBlob) {
      return downloadUtils.downloadResponseBlob(r, fallback);
    }
    return r.blob().then(function (blob) {
      var url = URL.createObjectURL(blob);
      var anchor = document.createElement('a');
      anchor.href = url; anchor.download = fallback;
      document.body.appendChild(anchor); anchor.click(); document.body.removeChild(anchor);
      URL.revokeObjectURL(url);
    });
  });
}
let activeModalOverlay = null, modalStateStack = [];
function getModalContainer(overlay) {
  if (uxUtils.getModalContainer) {
    return uxUtils.getModalContainer(overlay, { containerSelector: '.modal,.setup-modal,.builder-shell' });
  }
  if (!overlay) return null;
  return overlay.querySelector('[role="dialog"]') || overlay.querySelector('.modal,.setup-modal,.builder-shell') || overlay.firstElementChild || overlay;
}
function getModalFocusableElements(overlay) {
  if (uxUtils.getFocusableElements) {
    return uxUtils.getFocusableElements(overlay, { containerSelector: '.modal,.setup-modal,.builder-shell' });
  }
  var container = getModalContainer(overlay);
  if (!container) return [];
  var selector = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
  return Array.from(container.querySelectorAll(selector)).filter(function (el) {
    return el.offsetParent !== null || el === document.activeElement;
  });
}
function closeActiveModalFromEscape() {
  if (!activeModalOverlay) return;
  if (activeModalOverlay === builderOverlay) { handleBuilderExitRequest(); return; }
  if (activeModalOverlay === setupOverlay) { closeSessionSetup(); return; }
  if (activeModalOverlay === folderModalOverlay) { closeFolderModal(); return; }
  if (activeModalOverlay === confirmModalOverlay) { closeConfirmModal(false); return; }
  if (activeModalOverlay === builderExitOverlay) { closeBuilderExitModal('cancel'); return; }
  closeModal(activeModalOverlay);
}
function openModal(ov) {
  if (!ov) return;
  modalStateStack.push({ overlay: ov, restore: document.activeElement });
  ov.classList.add('entering');
  ov.setAttribute('aria-hidden', 'false');
  activeModalOverlay = ov;
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      ov.classList.replace('entering', 'visible');
      var focusables = getModalFocusableElements(ov);
      if (focusables.length) { focusables[0].focus(); }
    });
  });
}
function closeModal(ov) {
  if (!ov) return;
  ov.classList.remove('visible');
  ov.classList.remove('entering');
  ov.setAttribute('aria-hidden', 'true');
  var restoreTarget = null;
  for (var i = modalStateStack.length - 1; i >= 0; i--) {
    if (modalStateStack[i].overlay === ov) {
      restoreTarget = modalStateStack[i].restore || null;
      modalStateStack.splice(i, 1);
      break;
    }
  }
  activeModalOverlay = modalStateStack.length ? modalStateStack[modalStateStack.length - 1].overlay : null;
  if (restoreTarget && typeof restoreTarget.focus === 'function') {
    try { restoreTarget.focus(); } catch (e) { }
  }
}
function openConfirmModal(title, message, confirmLabel) { confirmModalTitle.textContent = title; confirmModalMessage.textContent = message; confirmModalConfirm.textContent = confirmLabel || 'Delete'; openModal(confirmModalOverlay); return new Promise(function (r) { confirmModalResolver = r; }); }
function closeConfirmModal(c) { closeModal(confirmModalOverlay); if (confirmModalResolver) { confirmModalResolver(Boolean(c)); confirmModalResolver = null; } }

/* ── Fullscreen Pack Builder ── */
var htmlUtils = window.LectureProcessorHtml || {};
var escapeHtml = htmlUtils.escapeHtml || function (v) {
  return String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
};
var sanitizeHtmlFragment = htmlUtils.sanitizeHtmlFragment || function (rawHtml) {
  var htmlText = String(rawHtml || '');
  if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
    return window.DOMPurify.sanitize(htmlText);
  }
  return escapeHtml(htmlText);
};
var setSafeInnerHtml = htmlUtils.setSafeInnerHtml || function (element, rawHtml) {
  if (!element) return;
  element.innerHTML = sanitizeHtmlFragment(rawHtml);
};
function createDefaultQuestion() {
  return normalizeQuestion({
    question: 'New question',
    options: ['Option A', 'Option B', 'Option C', 'Option D'],
    answer: 'Option A',
    explanation: ''
  });
}
function buildDraftFromPack(pack) {
  var source = pack || {};
  return {
    title: source.title || '',
    folder_id: source.folder_id || '',
    course: source.course || '',
    subject: source.subject || '',
    semester: source.semester || '',
    block: source.block || '',
    notes_markdown: source.notes_markdown || '',
    flashcards: (source.flashcards || []).map(function (card) {
      return { front: card.front || '', back: card.back || '' };
    }),
    test_questions: (source.test_questions || []).map(function (q) {
      return normalizeQuestion(q);
    })
  };
}
function clearBuilderAutoSaveTimer() {
  if (builderAutoSaveTimer) {
    window.clearTimeout(builderAutoSaveTimer);
    builderAutoSaveTimer = null;
  }
}
function updateBuilderDirtyIndicator() {
  if (!builderStatDirty) return;
  if (builderAutoSaving) {
    builderStatDirty.textContent = 'Saving...';
    builderStatDirty.className = 'builder-status saving';
    return;
  }
  if (builderDirty) {
    builderStatDirty.textContent = 'Auto-save pending';
    builderStatDirty.className = 'builder-status pending';
    return;
  }
  builderStatDirty.textContent = 'Saved';
  builderStatDirty.className = 'builder-status saved';
}
function scheduleBuilderAutoSave() {
  if (builderMode !== 'edit' || !builderDraft) { return; }
  if (!builderOverlay.classList.contains('visible')) { return; }
  if (builderAutoSaving) {
    builderAutoSaveQueued = true;
    return;
  }
  clearBuilderAutoSaveTimer();
  builderAutoSaveTimer = window.setTimeout(function () {
    builderAutoSaveTimer = null;
    if (!builderDirty || builderMode !== 'edit' || !builderDraft) { return; }
    if (!builderOverlay.classList.contains('visible')) { return; }
    builderAutoSaving = true;
    updateBuilderDirtyIndicator();
    saveBuilderPack(false, { silent: true, refreshAfterSave: false, skipAutoSave: true, autoSavedToast: true })
      .finally(function () {
        builderAutoSaving = false;
        updateBuilderDirtyIndicator();
        if (builderAutoSaveQueued) {
          builderAutoSaveQueued = false;
          scheduleBuilderAutoSave();
        }
      });
  }, BUILDER_AUTOSAVE_DELAY_MS);
}
function markBuilderDirty(value, options) {
  var opts = options || {};
  builderDirty = (value !== false);
  if (!builderDirty) {
    builderAutoSaveQueued = false;
    clearBuilderAutoSaveTimer();
  }
  updateBuilderDirtyIndicator();
  if (builderDirty && !opts.skipAutoSave) {
    scheduleBuilderAutoSave();
  }
}
function updateBuilderStats() {
  if (!builderDraft) { return; }
  builderStatCards.textContent = String((builderDraft.flashcards || []).length);
  builderStatQuestions.textContent = String((builderDraft.test_questions || []).length);
  builderSummary.textContent = (builderDraft.flashcards || []).length + ' cards · ' + (builderDraft.test_questions || []).length + ' questions';
}
function renderBuilderFolderSelect() {
  var options = [{ folder_id: '', name: 'No folder' }].concat(folders.map(function (folder) {
    return { folder_id: folder.folder_id, name: folder.name };
  }));
  setSafeInnerHtml(builderFolderSelect, options.map(function (item) {
    return '<option value="' + escapeHtml(item.folder_id) + '">' + escapeHtml(item.name) + '</option>';
  }).join(''));
  builderFolderSelect.value = builderDraft && builderDraft.folder_id ? builderDraft.folder_id : '';
}
function renderBuilderInfoPane() {
  if (!builderDraft) { return; }
  builderTitleInput.value = builderDraft.title || '';
  builderCourseInput.value = builderDraft.course || '';
  builderSubjectInput.value = builderDraft.subject || '';
  builderSemesterInput.value = builderDraft.semester || '';
  builderBlockInput.value = builderDraft.block || '';
  builderNotesInput.value = builderDraft.notes_markdown || '';
  renderBuilderFolderSelect();
  syncBuilderAdvancedMetadataState();
}
function renderBuilderFlashcards() {
  if (!builderDraft) { return; }
  var cards = builderDraft.flashcards || [];
  if (!cards.length) {
    setSafeInnerHtml(builderFlashcardList, '<div class="builder-list-empty">No flashcards yet. Add one to start building your deck.<div class="builder-list-empty-actions"><button type="button" class="btn" id="builder-empty-add-card-btn">Add flashcard</button><button type="button" class="btn" id="builder-empty-import-card-btn">Import CSV</button></div></div>');
    var addCardBtn = document.getElementById('builder-empty-add-card-btn');
    var importCardBtn = document.getElementById('builder-empty-import-card-btn');
    if (addCardBtn) { addCardBtn.addEventListener('click', function () { builderAddCardBtn.click(); }); }
    if (importCardBtn) { importCardBtn.addEventListener('click', function () { setBuilderPane('import'); builderImportType.value = 'flashcards'; }); }
    updateBuilderStats();
    return;
  }
  setSafeInnerHtml(builderFlashcardList, cards.map(function (card, index) {
    return '<div class="builder-row" data-fc-row="' + index + '">'
      + '<div class="builder-row-head"><span class="builder-row-title">Flashcard ' + (index + 1) + '</span><button class="btn danger" data-delete-fc="' + index + '" style="padding:5px 8px;font-size:.75rem">Delete</button></div>'
      + '<div class="builder-split"><div class="field"><label>Front</label><textarea data-fc-field="front" data-fc-index="' + index + '" style="min-height:92px">' + escapeHtml(card.front || '') + '</textarea></div>'
      + '<div class="field"><label>Back</label><textarea data-fc-field="back" data-fc-index="' + index + '" style="min-height:92px">' + escapeHtml(card.back || '') + '</textarea></div></div></div>';
  }).join(''));
  updateBuilderStats();
}
function renderBuilderQuestions() {
  if (!builderDraft) { return; }
  var questions = (builderDraft.test_questions || []).map(normalizeQuestion);
  builderDraft.test_questions = questions;
  if (!questions.length) {
    setSafeInnerHtml(builderQuestionList, '<div class="builder-list-empty">No practice questions yet. Add one to begin.<div class="builder-list-empty-actions"><button type="button" class="btn" id="builder-empty-add-question-btn">Add question</button><button type="button" class="btn" id="builder-empty-import-question-btn">Import CSV</button></div></div>');
    var addQuestionBtn = document.getElementById('builder-empty-add-question-btn');
    var importQuestionBtn = document.getElementById('builder-empty-import-question-btn');
    if (addQuestionBtn) { addQuestionBtn.addEventListener('click', function () { builderAddQuestionBtn.click(); }); }
    if (importQuestionBtn) { importQuestionBtn.addEventListener('click', function () { setBuilderPane('import'); builderImportType.value = 'questions'; }); }
    updateBuilderStats();
    return;
  }
  setSafeInnerHtml(builderQuestionList, questions.map(function (question, index) {
    var answerOptions = (question.options || []).map(function (option, optionIndex) {
      var letter = ['A', 'B', 'C', 'D'][optionIndex] || '';
      return '<option value="' + escapeHtml(option) + '" ' + (question.answer === option ? 'selected' : '') + '>' + letter + ': ' + escapeHtml(option || '(empty)') + '</option>';
    }).join('');
    return '<div class="builder-row" data-q-row="' + index + '">'
      + '<div class="builder-row-head"><span class="builder-row-title">Question ' + (index + 1) + '</span><button class="btn danger" data-delete-q="' + index + '" style="padding:5px 8px;font-size:.75rem">Delete</button></div>'
      + '<div class="field"><label>Question</label><textarea data-q-field="question" data-q-index="' + index + '" style="min-height:86px">' + escapeHtml(question.question || '') + '</textarea></div>'
      + '<div class="builder-grid-3" style="margin-top:8px">'
      + '<div class="field"><label>Option A</label><input data-q-option="0" data-q-index="' + index + '" value="' + escapeHtml(question.options[0] || '') + '"></div>'
      + '<div class="field"><label>Option B</label><input data-q-option="1" data-q-index="' + index + '" value="' + escapeHtml(question.options[1] || '') + '"></div>'
      + '<div class="field"><label>Option C</label><input data-q-option="2" data-q-index="' + index + '" value="' + escapeHtml(question.options[2] || '') + '"></div>'
      + '</div><div class="builder-grid" style="margin-top:8px">'
      + '<div class="field"><label>Option D</label><input data-q-option="3" data-q-index="' + index + '" value="' + escapeHtml(question.options[3] || '') + '"></div>'
      + '<div class="field"><label>Correct Answer</label><select class="builder-select" data-q-answer="' + index + '">' + answerOptions + '</select></div>'
      + '</div><div class="field" style="margin-top:8px"><label>Explanation (optional)</label><textarea data-q-field="explanation" data-q-index="' + index + '" style="min-height:72px">' + escapeHtml(question.explanation || '') + '</textarea></div></div>';
  }).join(''));
  updateBuilderStats();
}
function setBuilderPane(nextPane) {
  builderPane = nextPane;
  document.querySelectorAll('.builder-pane').forEach(function (pane) {
    pane.classList.toggle('active', pane.id === ('builder-pane-' + nextPane));
  });
  builderPaneButtons.forEach(function (button) {
    button.classList.toggle('active', button.dataset.builderPane === nextPane);
  });
}
function clearBuilderImportState() {
  builderImportParsed = null;
  builderApplyImportBtn.disabled = true;
  builderPreview.style.display = 'none';
  builderImportErrors.style.display = 'none';
  builderImportErrors.textContent = '';
  builderImportSummary.textContent = 'No file loaded.';
}
function openBuilderOverlay(mode, pack) {
  var openingCreate = (mode === 'create');
  builderMode = openingCreate ? 'create' : 'edit';
  builderAutoSaving = false;
  builderAutoSaveQueued = false;
  clearBuilderAutoSaveTimer();
  builderPackId = openingCreate ? '' : (pack && pack.study_pack_id ? pack.study_pack_id : selectedPackId);
  builderDraft = openingCreate ? buildDraftFromPack({
    title: '',
    notes_markdown: '',
    flashcards: [],
    test_questions: []
  }) : buildDraftFromPack(pack || selectedPack || {});
  builderAdvancedMetadataOpen = !openingCreate && (
    !!String(builderDraft.semester || '').trim() ||
    !!String(builderDraft.block || '').trim()
  );
  builderTitleEl.textContent = openingCreate ? 'Create Study Pack' : 'Edit Study Pack';
  builderSubEl.textContent = openingCreate ? 'Start from scratch in a focused fullscreen workspace' : 'Refine cards, metadata, and imports in one place';
  builderBrandSub.textContent = openingCreate ? 'Manual creation flow' : 'Editing ' + (builderDraft.title || 'Untitled pack');
  renderBuilderInfoPane();
  renderBuilderFlashcards();
  renderBuilderQuestions();
  clearBuilderImportState();
  setBuilderPane('info');
  markBuilderDirty(false);
  updateBuilderStats();
  openModal(builderOverlay);
  document.body.style.overflow = 'hidden';
}
function closeBuilderOverlay() {
  builderAutoSaving = false;
  builderAutoSaveQueued = false;
  clearBuilderAutoSaveTimer();
  closeModal(builderOverlay);
  document.body.style.overflow = '';
  builderDraft = null;
  builderPackId = '';
  builderImportParsed = null;
}
function openBuilderExitModal() {
  openModal(builderExitOverlay);
  return new Promise(function (resolve) { builderExitResolver = resolve; });
}
function closeBuilderExitModal(choice) {
  closeModal(builderExitOverlay);
  if (builderExitResolver) {
    builderExitResolver(choice);
    builderExitResolver = null;
  }
}
function handleBuilderExitRequest() {
  if (!builderDirty) {
    closeBuilderOverlay();
    return;
  }
  openBuilderExitModal().then(function (choice) {
    if (choice === 'save') {
      saveBuilderPack(true);
      return;
    }
    if (choice === 'discard') {
      markBuilderDirty(false);
      closeBuilderOverlay();
    }
  });
}
function getBuilderPayload() {
  return {
    title: (builderDraft.title || '').trim(),
    folder_id: builderDraft.folder_id || '',
    course: (builderDraft.course || '').trim(),
    subject: (builderDraft.subject || '').trim(),
    semester: (builderDraft.semester || '').trim(),
    block: (builderDraft.block || '').trim(),
    notes_markdown: builderDraft.notes_markdown || '',
    flashcards: builderDraft.flashcards || [],
    test_questions: (builderDraft.test_questions || []).map(normalizeQuestion)
  };
}
function getDemoPackPayload() {
  return {
    title: 'Demo Pack: Active Recall Basics',
    course: 'Study Skills',
    subject: 'Active Recall',
    semester: 'Demo',
    block: 'Starter',
    notes_markdown: '# Active Recall Starter Notes\n\n## What active recall means\n\nActive recall is studying by forcing yourself to retrieve information from memory instead of rereading notes.\n\n## Quick method\n\n1. Read a short section.\n2. Hide the notes.\n3. Write or say what you remember.\n4. Check gaps and repeat.\n\n## Spaced repetition link\n\nUse increasing review intervals to revisit material before you forget it. Keep difficult cards in shorter intervals.',
    flashcards: [
      { front: 'What is active recall?', back: 'A study method where you retrieve information from memory instead of passively rereading.' },
      { front: 'What should you do immediately after reading a short section?', back: 'Hide the notes and try to recall the key points from memory.' },
      { front: 'Why combine active recall with spaced repetition?', back: 'It improves long-term retention by reviewing just before forgetting.' },
      { front: 'What should you do after checking recall mistakes?', back: 'Correct the gaps and test yourself again.' }
    ],
    test_questions: [
      { question: 'Which action best matches active recall?', options: ['Highlighting without testing', 'Rereading the same paragraph', 'Explaining the topic from memory', 'Copying slides word-for-word'], answer: 'Explaining the topic from memory', explanation: 'Active recall focuses on retrieval practice.' },
      { question: 'What is the main goal of spaced repetition?', options: ['Study once for a long time', 'Review right before forgetting', 'Memorize only definitions', 'Avoid testing'], answer: 'Review right before forgetting', explanation: 'Spacing review sessions strengthens memory efficiently.' },
      { question: 'After a failed recall attempt, what should you do next?', options: ['Skip the topic', 'Check notes and retry', 'Only read summaries', 'Delete the card'], answer: 'Check notes and retry', explanation: 'Feedback plus another recall attempt closes the memory gap.' }
    ]
  };
}
function createDemoPack() {
  if (!auth.currentUser) { showToast('Please sign in first.', 'error'); return; }
  if (creatingDemoPack) { return; }
  creatingDemoPack = true;
  var originalText = packEmptyDemoBtn ? packEmptyDemoBtn.textContent : 'Create demo pack';
  if (packEmptyDemoBtn) {
    packEmptyDemoBtn.disabled = true;
    packEmptyDemoBtn.textContent = 'Creating demo pack...';
  }
  apiCall('/api/study-packs', { method: 'POST', body: JSON.stringify(getDemoPackPayload()) })
    .then(function (response) {
      var createdId = response && response.study_pack_id ? response.study_pack_id : '';
      if (!createdId) { throw new Error('Could not create demo pack'); }
      selectedPackId = createdId;
      showToast('Demo pack created.');
      return loadData(createdId);
    })
    .catch(function (e) {
      showToast(e.message || 'Could not create demo pack.', 'error');
    })
    .finally(function () {
      creatingDemoPack = false;
      if (packEmptyDemoBtn) {
        packEmptyDemoBtn.disabled = false;
        packEmptyDemoBtn.textContent = originalText;
      }
    });
}
function saveBuilderPack(closeAfter, options) {
  if (!builderDraft) { return Promise.resolve(); }
  var opts = options || {};
  var payload = getBuilderPayload();
  if (!payload.title) {
    payload.title = 'Untitled pack';
  }
  clearBuilderAutoSaveTimer();
  builderAutoSaveQueued = false;
  var request;
  if (builderMode === 'create') {
    request = apiCall('/api/study-packs', { method: 'POST', body: JSON.stringify(payload) });
  } else {
    request = apiCall('/api/study-packs/' + encodeURIComponent(builderPackId || selectedPackId), { method: 'PATCH', body: JSON.stringify(payload) });
  }
  return request.then(function (response) {
    if (builderMode === 'create' && response && response.study_pack_id) {
      builderPackId = response.study_pack_id;
      selectedPackId = response.study_pack_id;
      builderMode = 'edit';
    }
    if (opts.refreshAfterSave === false) {
      if (selectedPack && selectedPackId && (builderPackId || selectedPackId) === selectedPackId) {
        selectedPack = Object.assign({}, selectedPack, payload, { study_pack_id: selectedPackId });
      }
      return null;
    }
    return loadData(builderPackId || selectedPackId);
  }).then(function () {
    markBuilderDirty(false, { skipAutoSave: true });
    if (!opts.silent) {
      showToast('Study pack saved.');
    } else if (opts.autoSavedToast) {
      showToast('Saved.', 'success');
    }
    if (closeAfter) {
      closeBuilderOverlay();
    } else {
      builderBrandSub.textContent = 'Editing ' + ((builderDraft && builderDraft.title) || 'Untitled pack');
    }
    return true;
  }).catch(function (e) {
    if (!opts.silent) {
      showToast(e.message || 'Could not save builder changes.', 'error');
    }
    return false;
  });
}
function parseCsvRows(text) {
  if (!(window.Papa && typeof window.Papa.parse === 'function')) {
    return { rows: [], errors: ['CSV parser is unavailable. Reload this page and try again.'] };
  }
  var parsed = window.Papa.parse(String(text || ''), {
    delimiter: '',
    newline: '',
    quoteChar: '"',
    escapeChar: '"',
    skipEmptyLines: 'greedy',
    dynamicTyping: false
  });
  var rows = (parsed && Array.isArray(parsed.data)) ? parsed.data : [];
  var errors = (parsed && Array.isArray(parsed.errors) ? parsed.errors : []).map(function (err) {
    var rowNumber = (typeof err.row === 'number' && err.row >= 0) ? (' row ' + (err.row + 1)) : '';
    var message = String(err.message || 'Invalid CSV format');
    return 'CSV parse error' + rowNumber + ': ' + message;
  });
  return { rows: rows, errors: errors };
}
function normalizeHeader(name) {
  return String(name || '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
}
function parseBuilderCsvContent(rawText, type) {
  var parsedCsv = parseCsvRows(rawText || '');
  var rows = parsedCsv.rows || [];
  var parserErrors = (parsedCsv.errors || []).slice();
  if (parserErrors.length) {
    return { type: type, items: [], errors: parserErrors, preview: [] };
  }
  if (!rows.length || rows.every(function (r) { return !r.join('').trim(); })) {
    return { type: type, items: [], errors: ['The file appears to be empty.'], preview: [] };
  }
  if (rows.length > 5001) {
    return { type: type, items: [], errors: ['CSV has too many rows. Please keep imports to 5,000 data rows or fewer.'], preview: [] };
  }
  var headers = (rows[0] || []).map(function (header) { return normalizeHeader(header.replace(/^\uFEFF/, '')); });
  var errors = [];
  var items = [];
  function idx(name) { return headers.indexOf(name); }
  if (type === 'flashcards') {
    var frontIndex = idx('front');
    var backIndex = idx('back');
    if (frontIndex < 0 || backIndex < 0) {
      // Backward compatibility
      frontIndex = idx('question');
      backIndex = idx('answer');
    }
    if (frontIndex < 0 || backIndex < 0) {
      return { type: type, items: [], errors: ['Missing required headers. Use: front, back'], preview: [] };
    }
    for (var rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      var row = rows[rowIndex] || [];
      if (!row.join('').trim()) { continue; }
      if (row.length < headers.length) {
        errors.push('Row ' + (rowIndex + 1) + ': has fewer columns than the header row.');
        continue;
      }
      var front = String(row[frontIndex] || '').trim();
      var back = String(row[backIndex] || '').trim();
      if (!front || !back) {
        errors.push('Row ' + (rowIndex + 1) + ': front and back are required.');
        continue;
      }
      items.push({ front: front, back: back });
    }
  } else {
    var qIndex = idx('question'), aIndex = idx('option_a'), bIndex = idx('option_b'), cIndex = idx('option_c'), dIndex = idx('option_d'), answerIndex = idx('answer'), expIndex = idx('explanation');
    if (qIndex < 0 || aIndex < 0 || bIndex < 0 || cIndex < 0 || dIndex < 0 || answerIndex < 0) {
      return { type: type, items: [], errors: ['Missing required headers. Use: question, option_a, option_b, option_c, option_d, answer (optional explanation)'], preview: [] };
    }
    for (var qRowIndex = 1; qRowIndex < rows.length; qRowIndex++) {
      var qRow = rows[qRowIndex] || [];
      if (!qRow.join('').trim()) { continue; }
      if (qRow.length < headers.length) {
        errors.push('Row ' + (qRowIndex + 1) + ': has fewer columns than the header row.');
        continue;
      }
      var question = String(qRow[qIndex] || '').trim();
      var options = [String(qRow[aIndex] || '').trim(), String(qRow[bIndex] || '').trim(), String(qRow[cIndex] || '').trim(), String(qRow[dIndex] || '').trim()];
      var answerRaw = String(qRow[answerIndex] || '').trim();
      var explanation = expIndex >= 0 ? String(qRow[expIndex] || '').trim() : '';
      if (!question || options.some(function (opt) { return !opt; })) {
        errors.push('Row ' + (qRowIndex + 1) + ': question and all options are required.');
        continue;
      }
      if (new Set(options).size !== 4) {
        errors.push('Row ' + (qRowIndex + 1) + ': options must be unique.');
        continue;
      }
      var answer = answerRaw;
      if (/^[ABCD]$/i.test(answerRaw)) {
        answer = options['ABCD'.indexOf(answerRaw.toUpperCase())];
      }
      if (options.indexOf(answer) < 0) {
        errors.push('Row ' + (qRowIndex + 1) + ': answer must match one option or use A-D.');
        continue;
      }
      items.push({ question: question, options: options, answer: answer, explanation: explanation });
    }
  }
  return { type: type, items: items, errors: errors, preview: items.slice(0, 10) };
}
function renderBuilderImportPreview() {
  if (!builderImportParsed || !builderImportParsed.items.length) {
    builderPreview.style.display = 'none';
    return;
  }
  var parsed = builderImportParsed;
  var headers = parsed.type === 'flashcards' ? ['Front', 'Back'] : ['Question', 'Answer', 'Explanation'];
  var rowsHtml = parsed.preview.map(function (item) {
    if (parsed.type === 'flashcards') {
      return '<tr><td>' + escapeHtml(item.front) + '</td><td>' + escapeHtml(item.back) + '</td></tr>';
    }
    return '<tr><td>' + escapeHtml(item.question) + '</td><td>' + escapeHtml(item.answer) + '</td><td>' + escapeHtml(item.explanation || '') + '</td></tr>';
  }).join('');
  setSafeInnerHtml(builderPreviewTable, '<thead><tr>' + headers.map(function (header) { return '<th>' + escapeHtml(header) + '</th>'; }).join('') + '</tr></thead><tbody>' + rowsHtml + '</tbody>');
  builderPreview.style.display = '';
}
function handleBuilderCsvFile(file) {
  if (!file) { return; }
  var reader = new FileReader();
  reader.onload = function () {
    var parsed = parseBuilderCsvContent(String(reader.result || ''), builderImportType.value);
    builderImportParsed = parsed;
    builderApplyImportBtn.disabled = !parsed.items.length;
    builderImportSummary.textContent = 'Loaded ' + parsed.items.length + ' valid row(s).';
    if (parsed.errors.length) {
      builderImportErrors.style.display = '';
      setSafeInnerHtml(builderImportErrors, parsed.errors.map(function (err) { return '<div>' + escapeHtml(err) + '</div>'; }).join(''));
    } else {
      builderImportErrors.style.display = 'none';
      builderImportErrors.textContent = '';
    }
    renderBuilderImportPreview();
  };
  reader.onerror = function () {
    showToast('Could not read CSV file.', 'error');
  };
  reader.readAsText(file, 'utf-8');
}
function applyBuilderImport() {
  if (!builderDraft || !builderImportParsed || !builderImportParsed.items.length) {
    return;
  }
  var replaceMode = builderImportMode.value === 'replace';
  if (builderImportParsed.type === 'flashcards') {
    builderDraft.flashcards = replaceMode ? builderImportParsed.items.slice() : (builderDraft.flashcards || []).concat(builderImportParsed.items);
    renderBuilderFlashcards();
  } else {
    var incoming = builderImportParsed.items.map(normalizeQuestion);
    builderDraft.test_questions = replaceMode ? incoming : (builderDraft.test_questions || []).concat(incoming);
    renderBuilderQuestions();
  }
  markBuilderDirty(true);
  updateBuilderStats();
  showToast('Imported ' + builderImportParsed.items.length + ' row(s).');
}
function downloadBuilderTemplate() {
  var csvText = '';
  var filename = '';
  if (builderImportType.value === 'flashcards') {
    csvText = 'front,back\nCell membrane,Selective barrier surrounding the cell\nMitochondria,Organelle that produces ATP';
    filename = 'flashcards-template.csv';
  } else {
    csvText = 'question,option_a,option_b,option_c,option_d,answer,explanation\nWhich organelle produces ATP?,Nucleus,Mitochondria,Golgi apparatus,Ribosome,B,Mitochondria are the powerhouse of the cell.';
    filename = 'practice-test-template.csv';
  }
  var blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  if (downloadUtils.saveBlobAsFile) {
    downloadUtils.saveBlobAsFile(blob, filename);
  } else {
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }
}

/* ── Session Setup ── */
function renderAlgoLane() {
  algoLane.innerHTML = '';
  sessionAlgo.forEach(function (type, i) {
    if (i > 0) { var ch = document.createElement('div'); ch.className = 'algo-chevron'; setSafeInnerHtml(ch, '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"></polyline></svg>'); algoLane.appendChild(ch); }
    var s = document.createElement('div'); s.className = 'algo-slot'; s.dataset.type = type; s.dataset.index = String(i);
    setSafeInnerHtml(s, (ALGO_ICONS[type] || '') + '<span>' + type.charAt(0).toUpperCase() + type.slice(1) + '</span>');
    s.addEventListener('click', function () { var ni = (ALGO_TYPES.indexOf(type) + 1) % ALGO_TYPES.length; sessionAlgo[i] = ALGO_TYPES[ni]; sessionAlgoPreset = ''; renderAlgoLane(); renderAlgoPresets(); saveSessionState(); });
    algoLane.appendChild(s);
  });
}
function renderAlgoPresets() { algoPresets.forEach(function (b) { b.classList.toggle('active', b.dataset.preset === sessionAlgoPreset); }); }
function applyAlgoPreset(p) { if (ALGO_PRESETS[p]) { sessionAlgo = ALGO_PRESETS[p].slice(); sessionAlgoPreset = p; renderAlgoLane(); renderAlgoPresets(); saveSessionState(); } }
function renderSettingsRows() { document.querySelectorAll('.setting-row[data-setting]').forEach(function (r) { r.classList.toggle('active', !!sessionSettings[r.dataset.setting]); }); }

function renderLessonCards() {
  var hf = selectedPack && selectedPack.flashcards && selectedPack.flashcards.length > 0;
  var ht = selectedPack && selectedPack.test_questions && selectedPack.test_questions.length > 0;
  var fcCount = selectedPack ? (selectedPack.flashcards || []).length : 0;
  var hasEnoughForMatch = fcCount >= MATCH_MIN_CARDS;
  var fc = document.getElementById('lesson-card-flashcards');
  var tc = document.getElementById('lesson-card-test');
  var wc = document.getElementById('lesson-card-write');
  var mc = document.getElementById('lesson-card-match');
  var mb = document.getElementById('match-min-badge');
  // Show/hide based on data availability
  fc.style.display = hf ? '' : 'none';
  tc.style.display = ht ? '' : 'none';
  wc.style.display = hf ? '' : 'none'; // write uses flashcards
  mc.style.display = hf ? '' : 'none'; // match uses flashcards
  // Match needs minimum cards
  if (hf && !hasEnoughForMatch) {
    mc.classList.add('unavailable'); mc.classList.remove('selected');
    sessionLessons.match = false;
    mb.style.display = ''; mb.textContent = 'Needs ' + MATCH_MIN_CARDS + '+ cards';
  } else {
    mc.classList.remove('unavailable'); mb.style.display = 'none';
  }
  if (!hf) { sessionLessons.flashcards = false; sessionLessons.write = false; sessionLessons.match = false; }
  if (!ht) { sessionLessons.test = false; }
  fc.classList.toggle('selected', sessionLessons.flashcards);
  tc.classList.toggle('selected', sessionLessons.test);
  wc.classList.toggle('selected', sessionLessons.write);
  mc.classList.toggle('selected', sessionLessons.match);
}

function renderMasteryGauge() {
  var cards = selectedPack ? (selectedPack.flashcards || []) : [];
  var total = cards.length; var state = loadCardState();
  var seen = 0, famCount = 0, mastCount = 0, dueToday = 0, diffRetry = 0, diffHard = 0, diffGood = 0, diffEasy = 0;
  cards.forEach(function (c, i) {
    var cs = state['fc_' + i];
    if (cs && parseInt(cs.seen, 10) > 0) {
      seen++;
      if (cs.level === 'mastered') { mastCount++; } else if (cs.level === 'familiar') { famCount++; }
      if (isDueDate(cs.next_review_date)) { dueToday++; }
    }
    var action = normalizeReviewAction((cs && cs.last_action) || mapLegacyDifficultyToAction((cs && cs.difficulty) || 'medium'));
    if (action === 'retry') diffRetry++;
    else if (action === 'hard') diffHard++;
    else if (action === 'easy') diffEasy++;
    else diffGood++;
  });
  var newCount = total - seen;
  var packStats = getPackStatsSnapshot(selectedPack);
  var unmastered = Math.max(0, parseInt(packStats.unmastered, 10) || Math.max(0, total - mastCount));
  masteryTotalEl.textContent = String(total);
  masterySeenEl.textContent = String(seen);
  masteryNewPctEl.textContent = total ? Math.round((newCount / total) * 100) + '%' : '0%';
  masteryFamiliarPctEl.textContent = total ? Math.round((famCount / total) * 100) + '%' : '0%';
  masteryMasteredPctEl.textContent = total ? Math.round((mastCount / total) * 100) + '%' : '0%';
  if (masteryDueTodayEl) masteryDueTodayEl.textContent = String(Math.max(0, parseInt(packStats.due, 10) || dueToday));
  if (masteryUnmasteredEl) masteryUnmasteredEl.textContent = String(unmastered);
  if (diffRetryCountEl) diffRetryCountEl.textContent = String(diffRetry);
  if (diffHardCountEl) diffHardCountEl.textContent = String(diffHard);
  if (diffGoodCountEl) diffGoodCountEl.textContent = String(diffGood);
  if (diffEasyCountEl) diffEasyCountEl.textContent = String(diffEasy);

  if (examRecommendationEl) {
    var folder = findSelectedPackFolder();
    var examDate = folder && folder.exam_date ? String(folder.exam_date) : '';
    if (!examDate) {
      examRecommendationEl.textContent = 'Set an exam date in Planning mode to get a daily target recommendation.';
    } else {
      var recommendation = buildExamRecommendation(unmastered, examDate);
      if (!recommendation || recommendation.days_remaining === null) {
        examRecommendationEl.textContent = 'Set an exam date in Planning mode to get a daily target recommendation.';
      } else if (recommendation.days_remaining < 0) {
        examRecommendationEl.textContent = 'Exam date has passed. Update the folder exam date to get a recommendation.';
      } else if (recommendation.days_remaining === 0) {
        setSafeInnerHtml(examRecommendationEl, '<strong>' + unmastered + '</strong> cards should be reviewed today.');
      } else {
        setSafeInnerHtml(examRecommendationEl, 'Exam in <strong>' + recommendation.days_remaining + '</strong> day' + (recommendation.days_remaining === 1 ? '' : 's') + '. Recommended: <strong>' + Math.max(0, parseInt(recommendation.daily_target, 10) || 0) + '</strong> unmastered cards/day.');
      }
    }
  }
}

function setSetupPane(p) {
  activeSetupPane = p;
  setupTabs.forEach(function (t) { t.classList.toggle('active', t.dataset.setupPane === p); });
  ['mastery', 'lessons', 'settings', 'algorithm'].forEach(function (x) {
    var el = document.getElementById('setup-pane-' + x);
    if (el) { el.classList.toggle('active', x === p); }
  });
}

function getEnabledModes() {
  var modes = [];
  if (sessionLessons.flashcards) { modes.push('flashcards'); }
  if (sessionLessons.test) { modes.push('test'); }
  if (sessionLessons.write) { modes.push('write'); }
  if (sessionLessons.match) { modes.push('match'); }
  return modes;
}

function showModePicker(modes) {
  setupMainContent.style.display = 'none';
  modePicker.classList.add('active');
  modePickerGrid.innerHTML = '';
  modes.forEach(function (m) {
    var card = document.createElement('div');
    card.className = 'mode-picker-card';
    card.innerHTML = (MODE_ICONS[m] || '') + '<div class="mode-picker-card-title">' + (MODE_NAMES[m] || m) + '</div><div class="mode-picker-card-desc">' + (MODE_DESCS[m] || '') + '</div>';
    card.addEventListener('click', function () {
      closeSessionSetup();
      openLearnStageWithMode(m, false);
    });
    modePickerGrid.appendChild(card);
  });
}

function hideModePicker() {
  modePicker.classList.remove('active');
  setupMainContent.style.display = '';
}

function openSessionSetup() {
  if (!selectedPack) { showToast('Select a study pack first.', 'error'); return; }
  setAudioHiddenForLearn(true);
  loadSessionState();
  setupPackName.textContent = selectedPack.title || 'Untitled pack';
  hideModePicker();
  renderMasteryGauge(); renderLessonCards(); renderSettingsRows(); renderAlgoLane(); renderAlgoPresets();
  setSetupPane('mastery');
  openModal(setupOverlay);
}
function closeSessionSetup() { closeModal(setupOverlay); hideModePicker(); if (!learnStage.classList.contains('visible')) { setAudioHiddenForLearn(false); } }

setupTabs.forEach(function (t) { t.addEventListener('click', function () { setSetupPane(t.dataset.setupPane); }); });
setupCloseBtn.addEventListener('click', closeSessionSetup);
setupOverlay.addEventListener('click', function (e) { if (e.target === setupOverlay) { closeSessionSetup(); } });
algoPresets.forEach(function (b) { b.addEventListener('click', function () { applyAlgoPreset(b.dataset.preset); }); });
document.querySelectorAll('.setting-row[data-setting]').forEach(function (row) {
  row.addEventListener('click', function () {
    sessionSettings[row.dataset.setting] = !sessionSettings[row.dataset.setting];
    renderSettingsRows(); saveSessionState();
  });
});
document.querySelectorAll('.lesson-card:not(.unavailable)').forEach(function (card) {
  card.addEventListener('click', function () {
    var l = card.dataset.lesson;
    if (card.classList.contains('unavailable')) return;
    if (l === 'flashcards') { sessionLessons.flashcards = !sessionLessons.flashcards; }
    if (l === 'test') { sessionLessons.test = !sessionLessons.test; }
    if (l === 'write') { sessionLessons.write = !sessionLessons.write; }
    if (l === 'match') { sessionLessons.match = !sessionLessons.match; }
    renderLessonCards(); saveSessionState();
  });
});
modePickerBack.addEventListener('click', hideModePicker);

setupStartBtn.addEventListener('click', function () {
  saveSessionState();
  var modes = getEnabledModes();
  if (modes.length === 0) {
    showToast('Select at least one lesson type.', 'error');
    setSetupPane('lessons');
    return;
  }
  if (modes.length === 1) {
    // Single mode: enter directly
    closeSessionSetup();
    openLearnStageWithMode(modes[0], false);
  } else {
    // Multiple modes: show picker
    showModePicker(modes);
  }
});

/* ── Write mode ── */
function initWriteMode() {
  writeIndex = 0; writeRevealed = false; writeChecked = false; writePromptSwapped = false;
  renderWriteCard();
}
function getWriteCards() {
  return getFlashcardQueue();
}
function renderWriteCard() {
  var cards = getWriteCards();
  if (!cards.length) { writePromptEl.textContent = 'No flashcards available.'; writeInputEl.style.display = 'none'; writeCheckBtn.style.display = 'none'; writeRevealBtn.style.display = 'none'; writeNextBtn.style.display = 'none'; return; }
  var entry = cards[writeIndex];
  var c = entry.card || {};
  writePromptSwapped = sessionSettings.swapAnswerQuestion || (sessionSettings.randomSwap && Math.random() > 0.5);
  writePromptEl.textContent = writePromptSwapped ? (c.back || '') : (c.front || '');
  writeInputEl.value = ''; writeInputEl.disabled = false; writeInputEl.className = 'write-input';
  writeInputEl.style.display = ''; writeCheckBtn.style.display = ''; writeRevealBtn.style.display = '';
  writeFeedbackEl.className = 'write-feedback'; writeFeedbackEl.style.display = ''; writeFeedbackEl.classList.remove('visible');
  writeChecked = false; writeRevealed = false;
  writeProgressEl.textContent = (writeIndex + 1) + ' / ' + cards.length;
  writeNextBtn.style.display = '';
  writeInputEl.focus();
  updateLearnProgressBar();
  updateDifficultyToolbar();
}
function checkWriteAnswer() {
  if (writeChecked || writeRevealed) return;
  writeChecked = true;
  var cards = getWriteCards();
  var entry = cards[writeIndex] || { card: {}, idx: writeIndex };
  var c = entry.card || {};
  var correctAnswer = writePromptSwapped ? (c.front || '') : (c.back || '');
  var isCorrect = gradeAnswer(writeInputEl.value, correctAnswer);
  writeInputEl.disabled = true;
  markCardSeen('fc_' + entry.idx, isCorrect);
  if (isCorrect) {
    writeInputEl.className = 'write-input correct-input';
    writeFeedbackEl.className = 'write-feedback visible correct-fb';
    writeFeedbackEl.textContent = 'Correct!';
  } else {
    writeInputEl.className = 'write-input wrong-input';
    writeFeedbackEl.className = 'write-feedback visible wrong-fb';
    writeFeedbackEl.textContent = 'Incorrect. Expected: ' + correctAnswer;
  }
}
function revealWriteAnswer() {
  if (writeRevealed) return;
  writeRevealed = true; writeChecked = true;
  var cards = getWriteCards();
  var entry = cards[writeIndex] || { card: {}, idx: writeIndex };
  var c = entry.card || {};
  var correctAnswer = writePromptSwapped ? (c.front || '') : (c.back || '');
  writeInputEl.disabled = true; writeInputEl.className = 'write-input wrong-input';
  writeFeedbackEl.className = 'write-feedback visible wrong-fb';
  writeFeedbackEl.textContent = 'Answer: ' + correctAnswer;
  markCardSeen('fc_' + entry.idx, false);
}
writeCheckBtn.addEventListener('click', function () { checkWriteAnswer(); resetLearnHintVisibility(); });
writeRevealBtn.addEventListener('click', function () { revealWriteAnswer(); resetLearnHintVisibility(); });
writeNextBtn.addEventListener('click', function () {
  var cards = getWriteCards();
  if (writeIndex < cards.length - 1) { writeIndex++; renderWriteCard(); resetLearnHintVisibility(); }
  else { showToast('All cards completed!'); }
});
writeInputEl.addEventListener('keydown', function (e) {
  if (e.key === 'Enter') { e.preventDefault(); if (!writeChecked) { checkWriteAnswer(); } else { writeNextBtn.click(); } }
});

/* ── Match mode ── */
function initMatchMode() {
  stopMatchTimer();
  matchResultsEl.style.display = 'none';
  matchGridEl.style.display = '';
  matchSelected = null; matchMatched = 0;
  var cards = selectedPack && selectedPack.flashcards ? selectedPack.flashcards : [];
  // Pick 6 random cards for 4x3 grid (6 pairs = 12 cells)
  var poolSize = Math.min(6, Math.floor(cards.length));
  var shuffled = cards.map(function (card, idx) { return { card: card, idx: idx }; }).sort(function () { return Math.random() - 0.5; });
  var picked = shuffled.slice(0, poolSize);
  matchTotal = poolSize;
  // Build cells: each card produces a front cell and a back cell
  var cells = [];
  picked.forEach(function (entry, i) {
    var c = entry.card || {};
    cells.push({ id: 'm_' + i, side: 'front', text: c.front || '', pairId: i, cardIdx: entry.idx });
    cells.push({ id: 'm_' + i, side: 'back', text: c.back || '', pairId: i, cardIdx: entry.idx });
  });
  // Shuffle cells
  cells.sort(function () { return Math.random() - 0.5; });
  matchCards = cells;
  renderMatchGrid();
  startMatchTimer();
}
function renderMatchGrid() {
  matchGridEl.innerHTML = '';
  matchCards.forEach(function (cell, idx) {
    var div = document.createElement('div');
    div.className = 'match-cell';
    div.textContent = cell.text;
    div.dataset.idx = String(idx);
    div.dataset.pairId = String(cell.pairId);
    div.dataset.side = cell.side;
    if (cell.matched) { div.classList.add('matched'); }
    div.addEventListener('click', function () { handleMatchClick(idx); });
    matchGridEl.appendChild(div);
  });
}
function handleMatchClick(idx) {
  var cell = matchCards[idx];
  if (cell.matched) return;
  var cellEl = matchGridEl.children[idx];
  if (matchSelected === null) {
    // First selection
    matchSelected = idx;
    cellEl.classList.add('selected');
  } else if (matchSelected === idx) {
    // Deselect
    cellEl.classList.remove('selected');
    matchSelected = null;
  } else {
    // Second selection — check match
    var firstCell = matchCards[matchSelected];
    var firstEl = matchGridEl.children[matchSelected];
    if (firstCell.pairId === cell.pairId && firstCell.side !== cell.side) {
      // Correct match
      firstCell.matched = true; cell.matched = true;
      firstEl.classList.remove('selected'); firstEl.classList.add('matched');
      cellEl.classList.add('matched');
      matchMatched++;
      markCardSeen('fc_' + cell.cardIdx, true);
      if (matchMatched >= matchTotal) {
        // All matched — stop timer and show results
        stopMatchTimer();
        showMatchResults();
      }
    } else {
      // Wrong match — flash red briefly
      cellEl.classList.add('wrong-flash'); firstEl.classList.add('wrong-flash');
      var fi = matchSelected;
      setTimeout(function () {
        cellEl.classList.remove('wrong-flash');
        if (matchGridEl.children[fi]) { matchGridEl.children[fi].classList.remove('wrong-flash', 'selected'); }
      }, 500);
    }
    matchSelected = null;
  }
  updateLearnProgressBar();
}
function startMatchTimer() {
  matchStartTime = Date.now(); matchRunning = true; matchElapsed = 0;
  matchTimerEl.textContent = '0.0s';
  matchTimerInterval = setInterval(function () {
    if (!matchRunning) return;
    matchElapsed = Date.now() - matchStartTime;
    matchTimerEl.textContent = (matchElapsed / 1000).toFixed(1) + 's';
  }, 100);
}
function stopMatchTimer() {
  matchRunning = false;
  if (matchTimerInterval) { clearInterval(matchTimerInterval); matchTimerInterval = null; }
}
function showMatchResults() {
  matchGridEl.style.display = 'none';
  matchResultsEl.style.display = '';
  var timeMs = matchElapsed;
  var timeSec = (timeMs / 1000).toFixed(2);
  matchResultsTime.textContent = timeSec + 's';
  // Save and get rank
  var scores = saveMatchScore(timeMs);
  var rank = getScoreRank(scores, timeMs);
  if (rank === 1) {
    matchResultsBadge.textContent = 'New High Score!';
    matchResultsBadge.className = 'match-results-badge gold';
  } else if (rank === 2) {
    matchResultsBadge.textContent = '2nd Best Time!';
    matchResultsBadge.className = 'match-results-badge silver';
  } else if (rank === 3) {
    matchResultsBadge.textContent = '3rd Best Time!';
    matchResultsBadge.className = 'match-results-badge bronze';
  } else {
    matchResultsBadge.textContent = '';
    matchResultsBadge.className = 'match-results-badge';
  }
  // Show top 3 history
  var historyParts = [];
  var labels = ['1st', '2nd', '3rd'];
  for (var i = 0; i < Math.min(3, scores.length); i++) {
    historyParts.push(labels[i] + ': ' + (scores[i] / 1000).toFixed(2) + 's');
  }
  matchResultsHistory.textContent = historyParts.join(' · ');
}
matchPlayAgainBtn.addEventListener('click', function () { initMatchMode(); });
/* ── Editor pane ── */
function setEditorPane(pane) {
  activeEditorPane = pane;
  editorTabs.forEach(function (b) { b.classList.toggle('active', b.dataset.editorPane === pane); });
  document.getElementById('editor-pane-notes').classList.toggle('active', pane === 'notes');
  document.getElementById('editor-pane-flashcards').classList.toggle('active', pane === 'flashcards');
  document.getElementById('editor-pane-test').classList.toggle('active', pane === 'test');
  exportType = (pane === 'test') ? 'test' : 'flashcards';
  if (pane === 'notes') { scheduleNotesFullscreenIdle(); }
}

function getFolderPinsStorageKey() {
  if (!auth.currentUser) return '';
  return 'pinned_folder_ids_' + auth.currentUser.uid;
}
function isBuiltInFolderId(folderId) {
  return folderId === BUILTIN_ALL_FOLDER_ID || folderId === BUILTIN_INTERVIEWS_FOLDER_ID;
}
function sanitizePinnedFolderIds(rawIds) {
  if (!Array.isArray(rawIds)) return [];
  var validIds = new Set(folders.map(function (folder) { return String(folder.folder_id || ''); }));
  var cleaned = [];
  rawIds.forEach(function (rawId) {
    var safeId = String(rawId || '').trim();
    if (!safeId || !validIds.has(safeId)) return;
    if (cleaned.indexOf(safeId) >= 0) return;
    cleaned.push(safeId);
  });
  return cleaned.slice(0, MAX_PINNED_FOLDERS);
}
function persistPinnedFolderIds() {
  var key = getFolderPinsStorageKey();
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(pinnedFolderIds)); } catch (e) { }
}
function loadPinnedFolderIds() {
  var key = getFolderPinsStorageKey();
  if (!key) { pinnedFolderIds = []; return; }
  try {
    pinnedFolderIds = sanitizePinnedFolderIds(JSON.parse(localStorage.getItem(key) || '[]'));
  } catch (e) {
    pinnedFolderIds = [];
  }
}
function syncPinnedFolderIds() {
  pinnedFolderIds = sanitizePinnedFolderIds(pinnedFolderIds);
  persistPinnedFolderIds();
}
function isPinnedFolder(folderId) {
  return pinnedFolderIds.indexOf(String(folderId || '')) >= 0;
}
function togglePinnedFolder(folderId) {
  var safeId = String(folderId || '').trim();
  if (!safeId) return;
  var index = pinnedFolderIds.indexOf(safeId);
  if (index >= 0) {
    pinnedFolderIds.splice(index, 1);
    persistPinnedFolderIds();
    showToast('Folder unpinned.');
    renderFolders();
    return;
  }
  if (pinnedFolderIds.length >= MAX_PINNED_FOLDERS) {
    showToast('You can pin up to 5 folders. Unpin one first.', 'error');
    return;
  }
  pinnedFolderIds.push(safeId);
  syncPinnedFolderIds();
  showToast('Folder pinned.');
  renderFolders();
}
function buildFolderItemsForSidebar() {
  var pinnedSet = new Set(pinnedFolderIds);
  var pinnedFolders = pinnedFolderIds.map(function (folderId) {
    return folders.find(function (folder) { return folder.folder_id === folderId; }) || null;
  }).filter(Boolean).map(function (folder) {
    return Object.assign({}, folder, { is_pinned: true, is_builtin: false, is_fixed: false });
  });
  var remaining = folders.filter(function (folder) {
    return !pinnedSet.has(folder.folder_id);
  }).map(function (folder) {
    return Object.assign({}, folder, { is_pinned: false, is_builtin: false, is_fixed: false });
  });
  return [
    { folder_id: BUILTIN_ALL_FOLDER_ID, name: 'All Study Packs', course: '', subject: '', semester: '', block: '', exam_date: '', is_pinned: true, is_builtin: true, is_fixed: true, meta_default: 'All packs' },
    { folder_id: BUILTIN_INTERVIEWS_FOLDER_ID, name: 'Interviews', course: '', subject: '', semester: '', block: '', exam_date: '', is_pinned: true, is_builtin: true, is_fixed: true, meta_default: 'Interview transcript packs' },
  ].concat(pinnedFolders, remaining);
}
function filteredPacks() {
  var q = searchInput.value.trim().toLowerCase();
  return packs.filter(function (p) {
    if (selectedFolderId === BUILTIN_INTERVIEWS_FOLDER_ID) {
      if ((p.mode || '') !== 'interview') return false;
    } else if (selectedFolderId && selectedFolderId !== BUILTIN_ALL_FOLDER_ID && p.folder_id !== selectedFolderId) {
      return false;
    }
    if (!q) return true;
    var hay = ((p.title || '') + ' ' + (p.course || '') + ' ' + (p.subject || '') + ' ' + (p.semester || '') + ' ' + (p.block || '')).toLowerCase();
    return hay.indexOf(q) >= 0;
  });
}

function movePackToFolder(pid, fid) {
  return apiCall('/api/study-packs/' + encodeURIComponent(pid), { method: 'PATCH', body: JSON.stringify({ folder_id: fid }) }).then(function () {
    showToast('Study pack moved.'); return loadData(pid);
  }).catch(function (e) { showToast(e.message || 'Could not move pack.', 'error'); });
}

function renderFolders() {
  var all = buildFolderItemsForSidebar();
  folderList.innerHTML = '';
  all.forEach(function (f) {
    var div = document.createElement('div');
    div.className = 'item' + (selectedFolderId === f.folder_id ? ' active' : '');
    div.dataset.folderId = f.folder_id;
    var metaParts = [f.course, f.subject, f.semester, f.block].filter(Boolean).map(escapeHtml);
    var metaLine = (metaParts.join(' &middot; ') || (f.meta_default || 'No metadata'));
    var pendingCount = Math.max(0, parseInt(f.pending_batch_count, 10) || 0);
    var pendingBadge = pendingCount > 0
      ? '<span class="folder-pending-badge">Batch pending' + (pendingCount > 1 ? ' (' + pendingCount + ')' : '') + '</span>'
      : '';
    var pendingHint = pendingCount > 0 && String(f.pending_batch_hint || '').trim()
      ? '<div class="item-sub pending-hint">' + escapeHtml(String(f.pending_batch_hint || '').trim()) + '</div>'
      : '';
    var pinLine = f.is_pinned ? '<div class="item-sub pinned-note">Pinned</div>' : '';
    var examLine = '';
    if (f.folder_id && !f.is_builtin && f.exam_date) {
      var parts = String(f.exam_date).split('-');
      if (parts.length === 3) {
        var examDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
        var todayParts = todayLocalDateString().split('-');
        var todayDate = new Date(parseInt(todayParts[0], 10), parseInt(todayParts[1], 10) - 1, parseInt(todayParts[2], 10));
        var diffDays = Math.ceil((examDate.getTime() - todayDate.getTime()) / 86400000);
        var cls = 'later', label = '';
        if (diffDays > 0) { label = diffDays + ' day' + (diffDays === 1 ? '' : 's') + ' until exam'; }
        else if (diffDays === 0) { label = 'Exam today'; cls = 'overdue'; }
        else { label = 'Exam passed ' + Math.abs(diffDays) + ' day' + (Math.abs(diffDays) === 1 ? '' : 's') + ' ago'; cls = 'overdue'; }
        examLine = '<div class="item-sub exam-countdown ' + cls + '">' + label + '</div>';
      }
    }
    var actions = '';
    if (!f.is_builtin) {
      var pinLabel = f.is_pinned ? 'Unpin' : 'Pin';
      actions = '<span class="folder-head-actions"><button class="btn folder-mini-btn" data-toggle-pin="1">' + pinLabel + '</button><button class="btn folder-mini-btn" data-edit-folder="1">Edit</button></span>';
    }
    setSafeInnerHtml(
      div,
      '<div class="item-head"><span class="item-title-wrap"><span class="item-title">' + escapeHtml(f.name) + '</span>' + pendingBadge + '</span>' + actions + '</div><div class="item-sub">' + metaLine + '</div>' + pendingHint + pinLine + examLine
    );
    div.addEventListener('click', function (e) { if (e.target.closest('[data-edit-folder]') || e.target.closest('[data-toggle-pin]')) return; selectedFolderId = f.folder_id; renderFolders(); renderPacks(); });
    if (!f.is_builtin) {
      var eb = div.querySelector('[data-edit-folder]');
      if (eb) { eb.addEventListener('click', function (e) { e.stopPropagation(); openFolderModal('edit', f); }); }
      var pb = div.querySelector('[data-toggle-pin]');
      if (pb) { pb.addEventListener('click', function (e) { e.stopPropagation(); togglePinnedFolder(f.folder_id); }); }
    }
    var canReceiveDrop = Boolean(f.folder_id && !f.is_builtin);
    div.addEventListener('dragover', function (e) { e.preventDefault(); if (draggedPackId && canReceiveDrop) div.classList.add('drop-target'); });
    div.addEventListener('dragleave', function () { div.classList.remove('drop-target'); });
    div.addEventListener('drop', function (e) { e.preventDefault(); div.classList.remove('drop-target'); if (!draggedPackId || !canReceiveDrop) return; movePackToFolder(draggedPackId, f.folder_id); draggedPackId = ''; });
    folderList.appendChild(div);
  });
}

function getFolderNameById(id) {
  if (!id) return 'No folder';
  if (id === BUILTIN_INTERVIEWS_FOLDER_ID) return 'Interviews';
  var f = folders.find(function (x) { return x.folder_id === id; });
  return f ? f.name : 'No folder';
}
function setPackFolderSelection(id) {
  packFolderSelect.value = id || '';
  packFolderLabel.textContent = getFolderNameById(id || '');
  packFolderMenu.querySelectorAll('.app-select-item').forEach(function (i) {
    var isActive = i.dataset.value === (id || '');
    i.classList.toggle('active', isActive);
    i.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
}
function renderFolderSelect() {
  var items = [{ folder_id: '', name: 'No folder' }].concat(folders.map(function (f) { return { folder_id: f.folder_id, name: f.name }; }));
  packFolderMenu.innerHTML = '';
  items.forEach(function (item) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'app-select-item';
    b.dataset.value = item.folder_id;
    b.textContent = item.name;
    b.setAttribute('role', 'option');
    b.setAttribute('aria-selected', 'false');
    b.addEventListener('click', function () {
      setPackFolderSelection(item.folder_id);
      setPackFolderMenuOpen(false);
      packFolderButton.focus();
      if (selectedPack) {
        selectedPack.folder_id = item.folder_id || '';
        selectedPack.folder_name = getFolderNameById(item.folder_id || '');
        queueInlineAutosave();
      }
    });
    packFolderMenu.appendChild(b);
  });
  setPackFolderSelection(packFolderSelect.value || '');
}

function renderPacks() {
  var items = filteredPacks(); packList.innerHTML = '';
  updatePackEmptyState();
  if (!items.length) {
    setSafeInnerHtml(packList, '<div class="empty">No study packs match this filter.<div class="builder-list-empty-actions"><button type="button" class="btn" id="clear-pack-filters-btn">Clear filters</button></div></div>');
    var clearFiltersBtn = document.getElementById('clear-pack-filters-btn');
    if (clearFiltersBtn) {
      clearFiltersBtn.addEventListener('click', function () {
        searchInput.value = '';
        selectedFolderId = '';
        renderFolders();
        renderPacks();
      });
    }
    return;
  }
  items.forEach(function (p) {
    var div = document.createElement('div');
    div.className = 'item' + (selectedPackId === p.study_pack_id ? ' active' : '');
    div.draggable = true; div.dataset.packId = p.study_pack_id;
    var titleText = escapeHtml(p.title || 'Untitled pack');
    var modeText = escapeHtml(p.mode || '');
    var metaParts = [p.course, p.subject, p.semester, p.block].filter(Boolean).map(escapeHtml);
    var defaultFolderText = (p.mode === 'interview') ? 'Folder: Interviews' : 'No metadata';
    var metaText = metaParts.join(' &middot; ') || (p.folder_name ? 'Folder: ' + escapeHtml(p.folder_name) : defaultFolderText);
    setSafeInnerHtml(div, '<div class="item-head"><span class="item-title">' + titleText + '</span></div><div class="item-sub">' + modeText + ' &middot; ' + p.flashcards_count + ' cards &middot; ' + p.test_questions_count + ' questions</div><div class="item-sub">' + metaText + '</div>');
    div.addEventListener('click', function () { selectedPackId = p.study_pack_id; renderPacks(); openPack(p.study_pack_id); });
    div.addEventListener('dragstart', function (e) { draggedPackId = p.study_pack_id; div.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', p.study_pack_id); });
    div.addEventListener('dragend', function () { div.classList.remove('dragging'); draggedPackId = ''; });
    packList.appendChild(div);
  });
}

function showPackEditor(v) {
  packEmpty.style.display = v ? 'none' : 'block';
  packEditorWrap.classList.toggle('visible', v);
  if (!v) { updatePackEmptyState(); }
}
function updatePackSummary() {
  if (!selectedPack) { packSummary.classList.remove('visible'); return; }
  packSummary.classList.add('visible');
  packSummaryTitle.textContent = selectedPack.title || 'Untitled pack';
  packSummaryMeta.textContent = [selectedPack.course, selectedPack.subject, selectedPack.semester, selectedPack.block].filter(Boolean).join(' · ') || (selectedPack.mode || '');
  packStatNotes.textContent = selectedPack.notes_markdown ? 'Has notes' : 'No notes';
  packStatCards.textContent = (selectedPack.flashcards || []).length + ' flashcards';
  packStatTest.textContent = (selectedPack.test_questions || []).length + ' questions';
  /* Informative images tip */
  var imagesTipEl = document.getElementById('pack-images-tip');
  if (imagesTipEl) {
    imagesTipEl.textContent = selectedPack.notes_markdown
      ? 'Tip: Informative slide images do not appear in the generated notes. You can manually add any relevant slide images to your final document if desired.'
      : '';
  }
}

/* ── Flashcard editor ── */
function renderFlashcardEditor(hi) {
  var idx = typeof hi === 'number' ? hi : -1;
  var cards = selectedPack && Array.isArray(selectedPack.flashcards) ? selectedPack.flashcards : [];
  flashcardCount.textContent = cards.length + ' flashcards'; flashcardEditorList.innerHTML = '';
  if (!cards.length) { setSafeInnerHtml(flashcardEditorList, '<div class="empty">No flashcards yet. Add one to start editing.</div>'); return; }
  cards.forEach(function (card, ci) {
    var row = document.createElement('div'); row.className = 'editor-card' + (ci === idx ? ' newly-added' : ''); row.dataset.rowIndex = String(ci);
    var safeFront = escapeHtml(card.front || '');
    var safeBack = escapeHtml(card.back || '');
    setSafeInnerHtml(row, '<div class="editor-card-head"><span class="editor-card-title">Flashcard ' + (ci + 1) + '</span><button class="btn danger" data-delete-card="' + ci + '" style="padding:5px 8px;font-size:0.75rem;">Delete</button></div><div class="field"><label>Front</label><input data-card-field="front" data-card-index="' + ci + '" value="' + safeFront + '"></div><div class="field" style="margin-top:8px;"><label>Back</label><textarea data-card-field="back" data-card-index="' + ci + '">' + safeBack + '</textarea></div>');
    flashcardEditorList.appendChild(row);
  });
  flashcardEditorList.querySelectorAll('[data-card-field]').forEach(function (el) {
    el.addEventListener('input', function () {
      selectedPack.flashcards[parseInt(el.dataset.cardIndex, 10)][el.dataset.cardField] = el.value;
      queueInlineAutosave();
    });
  });
  flashcardEditorList.querySelectorAll('[data-delete-card]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      selectedPack.flashcards.splice(parseInt(btn.dataset.deleteCard, 10), 1);
      if (learnFlashcardIndex >= selectedPack.flashcards.length) { learnFlashcardIndex = Math.max(0, selectedPack.flashcards.length - 1); }
      renderFlashcardEditor();
      queueInlineAutosave();
      showToast('Flashcard deleted.');
    });
  });
  if (idx >= 0) { var row = flashcardEditorList.querySelector('[data-row-index="' + idx + '"]'); if (row) { row.scrollIntoView({ behavior: 'smooth', block: 'center' }); var inp = row.querySelector('input[data-card-field="front"]'); if (inp) { inp.focus(); } } }
}

/* ── Question editor ── */
function normalizeQuestion(q) {
  var b = { question: q.question || '', options: Array.isArray(q.options) ? q.options.slice(0, 4) : [], answer: q.answer || '', explanation: q.explanation || '' };
  while (b.options.length < 4) { b.options.push(''); }
  if (b.options.indexOf(b.answer) < 0) { b.answer = b.options[0] || ''; }
  return b;
}
function getAnswerDisplay(q) { var o = Array.isArray(q.options) ? q.options : []; var fi = o.indexOf(q.answer); var i = fi >= 0 ? fi : 0; return (['A', 'B', 'C', 'D'][i] || 'A') + ': ' + (o[i] || '(empty)'); }

function renderQuestionEditor(hi) {
  var idx = typeof hi === 'number' ? hi : -1;
  selectedPack.test_questions = (selectedPack.test_questions || []).map(normalizeQuestion);
  var questions = selectedPack.test_questions;
  questionCount.textContent = questions.length + ' practice questions'; questionEditorList.innerHTML = '';
  if (!questions.length) { setSafeInnerHtml(questionEditorList, '<div class="empty">No practice questions yet. Add one to start editing.</div>'); return; }
  questions.forEach(function (q, qi) {
    var row = document.createElement('div'); row.className = 'editor-card' + (qi === idx ? ' newly-added' : ''); row.dataset.rowIndex = String(qi);
    var adStr = escapeHtml(getAnswerDisplay(q));
    var answerMenuId = 'q-answer-menu-' + qi;
    var safeQuestion = escapeHtml(q.question || '');
    var safeOptA = escapeHtml(q.options[0] || '');
    var safeOptB = escapeHtml(q.options[1] || '');
    var safeOptC = escapeHtml(q.options[2] || '');
    var safeOptD = escapeHtml(q.options[3] || '');
    var safeExplanation = escapeHtml(q.explanation || '');
    setSafeInnerHtml(row, '<div class="editor-card-head"><span class="editor-card-title">Question ' + (qi + 1) + '</span><button class="btn danger" data-delete-question="' + qi + '" style="padding:5px 8px;font-size:0.75rem;">Delete</button></div>'
      + '<div class="field"><label>Question</label><textarea data-question-field="question" data-question-index="' + qi + '">' + safeQuestion + '</textarea></div>'
      + '<div class="q-options-grid" style="margin-top:8px;">'
      + '<div class="field"><label>Option A</label><input data-option-index="0" data-question-index="' + qi + '" value="' + safeOptA + '"></div>'
      + '<div class="field"><label>Option B</label><input data-option-index="1" data-question-index="' + qi + '" value="' + safeOptB + '"></div>'
      + '<div class="field"><label>Option C</label><input data-option-index="2" data-question-index="' + qi + '" value="' + safeOptC + '"></div>'
      + '<div class="field"><label>Option D</label><input data-option-index="3" data-question-index="' + qi + '" value="' + safeOptD + '"></div></div>'
      + '<div class="field" style="margin-top:8px;"><label>Correct Answer</label>'
      + '<div class="app-select q-answer-picker" data-question-index="' + qi + '">'
      + '<button type="button" class="app-select-button" data-answer-button data-question-index="' + qi + '" aria-haspopup="listbox" aria-expanded="false" aria-controls="' + answerMenuId + '"><span class="app-select-label">' + adStr + '</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"></polyline></svg></button>'
      + '<div class="app-select-menu" id="' + answerMenuId + '" role="listbox" data-answer-menu data-question-index="' + qi + '">'
      + q.options.map(function (o, oi) { var isActive = q.answer === o; return '<button type="button" role="option" aria-selected="' + (isActive ? 'true' : 'false') + '" class="app-select-item' + (isActive ? ' active' : '') + '" data-answer-item data-question-index="' + qi + '" data-option-index="' + oi + '">' + (['A', 'B', 'C', 'D'][oi]) + ': ' + escapeHtml(o || '(empty)') + '</button>'; }).join('')
      + '</div></div></div>'
      + '<div class="field" style="margin-top:8px;"><label>Explanation</label><textarea data-question-field="explanation" data-question-index="' + qi + '">' + safeExplanation + '</textarea></div>');
    questionEditorList.appendChild(row);
  });
  questionEditorList.querySelectorAll('[data-question-field="question"],[data-question-field="explanation"]').forEach(function (el) {
    el.addEventListener('input', function () {
      selectedPack.test_questions[parseInt(el.dataset.questionIndex, 10)][el.dataset.questionField] = el.value;
      queueInlineAutosave();
    });
  });
  questionEditorList.querySelectorAll('input[data-option-index]').forEach(function (el) {
    el.addEventListener('input', function () {
      var qi2 = parseInt(el.dataset.questionIndex, 10), oi2 = parseInt(el.dataset.optionIndex, 10);
      var qn = selectedPack.test_questions[qi2]; qn.options[oi2] = el.value;
      if (qn.options.indexOf(qn.answer) < 0) { qn.answer = qn.options[0] || ''; }
      renderQuestionEditor(qi2);
      queueInlineAutosave();
    });
  });
  questionEditorList.querySelectorAll('[data-answer-button]').forEach(function (b) {
    b.addEventListener('click', function (e) {
      e.stopPropagation();
      var m = b.parentElement.querySelector('[data-answer-menu]');
      var shouldOpen = !m.classList.contains('visible');
      setQuestionAnswerMenuOpen(b, m, shouldOpen, shouldOpen ? 'active' : null);
    });
    b.addEventListener('keydown', function (e) {
      var m = b.parentElement.querySelector('[data-answer-menu]');
      if (!m) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setQuestionAnswerMenuOpen(b, m, true, 'first'); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setQuestionAnswerMenuOpen(b, m, true, 'last'); }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        var shouldOpen = !m.classList.contains('visible');
        setQuestionAnswerMenuOpen(b, m, shouldOpen, shouldOpen ? 'active' : null);
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setQuestionAnswerMenuOpen(b, m, false, null);
      }
    });
  });
  questionEditorList.querySelectorAll('[data-answer-menu]').forEach(function (menu) {
    menu.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); focusMenuItem(menu, '[data-answer-item]', 'next'); }
      if (e.key === 'ArrowUp') { e.preventDefault(); focusMenuItem(menu, '[data-answer-item]', 'prev'); }
      if (e.key === 'Home') { e.preventDefault(); focusMenuItem(menu, '[data-answer-item]', 'first'); }
      if (e.key === 'End') { e.preventDefault(); focusMenuItem(menu, '[data-answer-item]', 'last'); }
      if (e.key === 'Escape') {
        e.preventDefault();
        var b = menu.parentElement.querySelector('[data-answer-button]');
        setQuestionAnswerMenuOpen(b, menu, false, null);
        if (b) { b.focus(); }
      }
      if (e.key === 'Tab') { setQuestionAnswerMenuOpen(menu.parentElement.querySelector('[data-answer-button]'), menu, false, null); }
    });
  });
  questionEditorList.querySelectorAll('[data-answer-item]').forEach(function (item) {
    item.addEventListener('click', function () {
      var qi2 = parseInt(item.dataset.questionIndex, 10), oi2 = parseInt(item.dataset.optionIndex, 10);
      selectedPack.test_questions[qi2].answer = selectedPack.test_questions[qi2].options[oi2] || '';
      renderQuestionEditor(qi2);
      queueInlineAutosave();
    });
  });
  questionEditorList.querySelectorAll('[data-delete-question]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      selectedPack.test_questions.splice(parseInt(btn.dataset.deleteQuestion, 10), 1);
      if (learnQuestionIndex >= selectedPack.test_questions.length) { learnQuestionIndex = Math.max(0, selectedPack.test_questions.length - 1); }
      renderQuestionEditor();
      queueInlineAutosave();
      showToast('Practice question deleted.');
    });
  });
  if (idx >= 0) { var row2 = questionEditorList.querySelector('[data-row-index="' + idx + '"]'); if (row2) { row2.scrollIntoView({ behavior: 'smooth', block: 'center' }); var ta = row2.querySelector('textarea[data-question-field="question"]'); if (ta) { ta.focus(); } } }
}

/* ── Learn progress bar ── */
function updateLearnProgressBar() {
  var c = 0, t = 0;
  if (activeLearnMode === 'flashcards') {
    var fcCards = getFlashcardQueue();
    c = learnFlashcardIndex + 1; t = fcCards.length;
  } else if (activeLearnMode === 'test') {
    var qs = selectedPack ? (selectedPack.test_questions || []) : [];
    c = learnQuestionIndex + 1; t = qs.length;
  } else if (activeLearnMode === 'write') {
    var wCards = getWriteCards(); c = writeIndex + 1; t = wCards.length;
  } else if (activeLearnMode === 'match') {
    c = matchMatched; t = matchTotal;
  } else { c = 1; t = 1; }
  learnProgressFill.style.width = t > 0 ? ((c / t) * 100) + '%' : '0%';
  learnProgressText.textContent = t > 0 ? c + '/' + t : '';
}

function setFlashcardListMode(enabled) {
  flashcardListMode = Boolean(enabled);
  if (learnFListBtn) {
    learnFListBtn.classList.toggle('active', flashcardListMode);
    learnFListBtn.setAttribute('aria-pressed', flashcardListMode ? 'true' : 'false');
    learnFListBtn.textContent = flashcardListMode ? 'Card View' : 'Card List';
  }
  var flashcardPane = document.getElementById('learn-pane-flashcards');
  if (flashcardPane) {
    flashcardPane.classList.toggle('list-mode', flashcardListMode);
  }
  if (learnFListView) {
    learnFListView.hidden = !flashcardListMode;
  }
  if (learnFPeekWrap) {
    learnFPeekWrap.style.display = flashcardListMode ? 'inline-flex' : 'none';
  }
  if (!flashcardListMode) {
    flashcardPeekMode = false;
    if (learnFPeekToggle) learnFPeekToggle.checked = false;
  }
  document.body.classList.toggle('flashcard-list-mode', flashcardListMode);
  if (difficultyToolbar) {
    difficultyToolbar.classList.toggle('list-mode', flashcardListMode);
  }
  renderFlashcardListView();
}

function renderFlashcardListView() {
  if (!learnFListView) { return; }
  if (!flashcardListMode || activeLearnMode !== 'flashcards') {
    learnFListView.innerHTML = '';
    return;
  }
  var queue = getFlashcardQueue();
  if (!queue.length) {
    setSafeInnerHtml(learnFListView, '<div class="peek-empty">No flashcards available.</div>');
    return;
  }
  var rowsHtml = queue.map(function (entry, idx) {
    var card = entry && entry.card ? entry.card : {};
    var cardKey = String(entry && Number.isFinite(entry.idx) ? entry.idx : idx);
    var frontText = escapeHtml(String(card.front || '').trim() || 'Untitled flashcard');
    var backText = escapeHtml(String(card.back || '').trim() || 'No definition available.');
    var revealed = flashcardPeekMode || Boolean(flashcardPeekRevealed[cardKey]);
    var rowClass = 'peek-row' + (idx === learnFlashcardIndex ? ' active' : '');
    var rightContent = revealed
      ? (flashcardPeekMode
        ? ('<div class="peek-answer">' + backText + '</div>')
        : ('<button type="button" class="peek-answer-btn" data-peek-hide="' + cardKey + '"><span class="peek-answer">' + backText + '</span></button>'))
      : ('<button type="button" class="peek-reveal-btn" data-peek-reveal="' + cardKey + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>Show definition</button>');
    return '<div class="' + rowClass + '" role="button" tabindex="0" data-peek-index="' + idx + '"><span class="peek-index">' + (idx + 1) + '</span><span class="peek-front">' + frontText + '</span><span class="peek-divider"></span><span class="peek-right">' + rightContent + '</span></div>';
  }).join('');
  setSafeInnerHtml(learnFListView, rowsHtml);
  learnFListView.querySelectorAll('[data-peek-index]').forEach(function (row) {
    var activateRow = function () {
      var index = parseInt(row.dataset.peekIndex, 10);
      if (!Number.isFinite(index)) { return; }
      learnFlashcardIndex = Math.max(0, Math.min(index, queue.length - 1));
      learnFlashcardFlipped = false;
      renderLearnFlashcard();
      resetLearnHintVisibility();
    };
    row.addEventListener('click', activateRow);
    row.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        activateRow();
      }
    });
  });
  learnFListView.querySelectorAll('[data-peek-reveal]').forEach(function (button) {
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      var key = String(button.dataset.peekReveal || '');
      if (!key) { return; }
      flashcardPeekRevealed[key] = true;
      renderFlashcardListView();
    });
  });
  learnFListView.querySelectorAll('[data-peek-hide]').forEach(function (button) {
    button.addEventListener('click', function (event) {
      event.stopPropagation();
      var key = String(button.dataset.peekHide || '');
      if (!key) { return; }
      delete flashcardPeekRevealed[key];
      renderFlashcardListView();
    });
  });
}

/* ── Learn flashcard with slide animation ── */
var fcSliding = false;
function updateFlashcardContent() {
  var cards = getFlashcardQueue();
  if (!cards.length) {
    learnFlashcardFront.textContent = 'No flashcards available.'; learnFlashcardBack.textContent = '';
    learnFProgress.textContent = 'Card 0 of 0'; learnFPrev.disabled = true; learnFNext.disabled = true; learnFFlip.disabled = true;
    updateLearnProgressBar(); return;
  }
  var entry = cards[learnFlashcardIndex] || { card: {}, idx: learnFlashcardIndex };
  var c = entry.card || {};
  var swap = sessionSettings.swapAnswerQuestion || (sessionSettings.randomSwap && Math.random() > 0.5);
  learnFlashcardFront.textContent = swap ? (c.back || '') : (c.front || '');
  learnFlashcardBack.textContent = swap ? (c.front || '') : (c.back || '');
  learnFProgress.textContent = 'Card ' + (learnFlashcardIndex + 1) + ' of ' + cards.length;
  learnFPrev.disabled = (learnFlashcardIndex === 0);
  learnFNext.disabled = (learnFlashcardIndex === cards.length - 1);
  learnFFlip.disabled = false;
  renderFlashcardListView();
  updateDifficultyToolbar();
  updateLearnProgressBar();
}
function renderLearnFlashcard() {
  learnFlashcardInner.classList.toggle('flipped', learnFlashcardFlipped);
  updateFlashcardContent();
}
function doFlashcardSlide(direction) {
  if (fcSliding) return;
  var cards = getFlashcardQueue();
  if (!cards.length) return;
  var newIdx;
  if (direction === 'next') {
    if (learnFlashcardIndex >= cards.length - 1) return;
    newIdx = learnFlashcardIndex + 1;
  } else {
    if (learnFlashcardIndex <= 0) return;
    newIdx = learnFlashcardIndex - 1;
  }
  fcSliding = true;
  // Unflip before sliding
  learnFlashcardFlipped = false;
  learnFlashcardInner.classList.remove('flipped');
  var cls = (direction === 'next') ? 'slide-left' : 'slide-right';
  learnFlashcardInner.classList.add(cls);
  // Update content at animation midpoint (card is invisible)
  setTimeout(function () {
    learnFlashcardIndex = newIdx;
    updateFlashcardContent();
  }, 130);
  // Remove animation class after it finishes
  setTimeout(function () {
    learnFlashcardInner.classList.remove(cls);
    fcSliding = false;
  }, 320);
}

/* ── Learn quiz ── */
function renderLearnQuestion() {
  var questions = selectedPack && Array.isArray(selectedPack.test_questions) ? selectedPack.test_questions : [];
  if (!questions.length) {
    learnQProgress.textContent = 'Question 0 of 0'; learnQScore.textContent = 'Score: 0/0';
    learnQText.textContent = 'No practice questions available.'; learnQOptions.innerHTML = '';
    learnQExpl.classList.remove('visible'); learnQExpl.textContent = ''; updateLearnProgressBar(); return;
  }
  var q = questions[learnQuestionIndex]; learnAnswered = false;
  learnQProgress.textContent = 'Question ' + (learnQuestionIndex + 1) + ' of ' + questions.length;
  learnQScore.textContent = 'Score: ' + learnScore + '/' + questions.length;
  learnQText.textContent = q.question || ''; learnQOptions.innerHTML = '';
  learnQExpl.classList.remove('visible'); learnQExpl.textContent = '';
  (q.options || []).forEach(function (option) {
    var b = document.createElement('button'); b.type = 'button'; b.className = 'quiz-option'; b.textContent = option;
    b.addEventListener('click', function () {
      if (learnAnswered) return; learnAnswered = true;
      var correct = (option === q.answer);
      var allBtns = learnQOptions.querySelectorAll('.quiz-option');
      for (var j = 0; j < allBtns.length; j++) { allBtns[j].disabled = true; if (allBtns[j].textContent === q.answer) { allBtns[j].classList.add('correct'); } }
      if (correct) { b.classList.add('correct'); learnScore += 1; } else { b.classList.add('wrong'); }
      markCardSeen('q_' + learnQuestionIndex, correct);
      learnQScore.textContent = 'Score: ' + learnScore + '/' + questions.length;
      learnQExpl.textContent = q.explanation || ''; learnQExpl.classList.add('visible');
      updateLearnProgressBar();
      resetLearnHintVisibility();
    });
    learnQOptions.appendChild(b);
  });
  updateDifficultyToolbar();
  updateLearnProgressBar();
}

/* ── Open learn stage in a specific focused mode ── */
function openLearnStageWithMode(mode, requestFullscreen) {
  if (!selectedPack) { showToast('Select a study pack first.', 'error'); return; }
  learnSessionRecorded = false;
  activeLearnMode = mode;
  setAudioHiddenForLearn(true);
  learnTitle.textContent = selectedPack.title || 'Learn Mode';
  learnSub.textContent = (MODE_NAMES[mode] || mode) + ' · Focused session';
  learnModeLabel.textContent = MODE_NAMES[mode] || mode;

  // Hide all panes first
  var allPanes = document.querySelectorAll('#learn-stage .learn-pane');
  for (var i = 0; i < allPanes.length; i++) { allPanes[i].classList.remove('active'); }

  // Reset states
  learnFlashcardIndex = 0; learnFlashcardFlipped = false; learnQuestionIndex = 0; learnScore = 0;
  orderedFlashcards = orderCardsByAlgo(selectedPack.flashcards || []);
  fcSliding = false;

  // Activate only the selected mode pane
  if (mode === 'flashcards') {
    flashcardPeekMode = false;
    flashcardPeekRevealed = {};
    if (learnFPeekToggle) { learnFPeekToggle.checked = false; }
    setFlashcardListMode(false);
    document.getElementById('learn-pane-flashcards').classList.add('active');
    renderLearnFlashcard();
  } else if (mode === 'test') {
    document.getElementById('learn-pane-test').classList.add('active');
    renderLearnQuestion();
  } else if (mode === 'write') {
    document.getElementById('learn-pane-write').classList.add('active');
    initWriteMode();
  } else if (mode === 'match') {
    document.getElementById('learn-pane-match').classList.add('active');
    initMatchMode();
  } else {
    // Fallback: notes
    document.getElementById('learn-pane-notes').classList.add('active');
    setSafeInnerHtml(learnNotesContent, mdToHtml(selectedPack.notes_markdown || ''));
    updateDifficultyToolbar();
  }

  updateLearnProgressBar();
  document.body.style.overflow = 'hidden';
  learnStage.classList.add('entering');
  learnStage.scrollTop = 0;
  var learnBody = learnStage.querySelector('.learn-body');
  if (learnBody) { learnBody.scrollTop = 0; }
  var learnCard = learnStage.querySelector('.learn-card');
  if (learnCard) { learnCard.scrollTop = 0; }
  requestAnimationFrame(function () { requestAnimationFrame(function () { learnStage.classList.replace('entering', 'visible'); }); });
  resetLearnHintVisibility();
  if (requestFullscreen) {
    try { document.documentElement.requestFullscreen(); } catch (e) { }
  }
}

function closeLearnStage() {
  recordLearnSessionCompletion();
  learnStage.classList.remove('visible');
  setFlashcardListMode(false);
  orderedFlashcards = [];
  stopMatchTimer();
  activeLearnMode = '';
  clearHintFadeTimers();
  if (keyboardHints) keyboardHints.classList.remove('faded');
  setAudioHiddenForLearn(false);
  updateDifficultyToolbar();
  document.body.style.overflow = '';
  if (document.fullscreenElement) { try { document.exitFullscreen(); } catch (e) { } }
}

/* ── Folder modal (careful with ternaries) ── */
function openFolderModal(mode, folder) {
  folderModalMode = mode;
  editingFolderId = (folder && folder.folder_id) ? (folder.folder_id) : '';
  folderModalTitle.textContent = (mode === 'edit') ? 'Edit Folder' : 'Create Folder';
  folderNameInput.value = folder ? (folder.name || '') : '';
  folderCourseInput.value = folder ? (folder.course || '') : '';
  folderSubjectInput.value = folder ? (folder.subject || '') : '';
  folderSemesterInput.value = folder ? (folder.semester || '') : '';
  folderBlockInput.value = folder ? (folder.block || '') : '';
  setFolderExamDateValue(folder ? (folder.exam_date || '') : '');
  openModal(folderModalOverlay);
  setTimeout(function () { folderNameInput.focus(); }, 100);
}
function closeFolderModal() {
  closeModal(folderModalOverlay);
  folderModalMode = 'create'; editingFolderId = '';
  folderNameInput.value = ''; folderCourseInput.value = '';
  folderSubjectInput.value = ''; folderSemesterInput.value = '';
  folderBlockInput.value = '';
  setFolderExamDateValue('');
}
function saveFolderFromModal() {
  var normalizedExamDate = parseDateInput(folderExamDateInput.value);
  if (normalizedExamDate === null) {
    showToast('Use a valid date: dd-mm-yyyy or yyyy-mm-dd.', 'error');
    folderExamDateInput.focus();
    return;
  }
  var payload = { name: folderNameInput.value.trim(), course: folderCourseInput.value.trim(), subject: folderSubjectInput.value.trim(), semester: folderSemesterInput.value.trim(), block: folderBlockInput.value.trim(), exam_date: normalizedExamDate || '' };
  if (!payload.name) { showToast('Folder name is required.', 'error'); folderNameInput.focus(); return; }
  var promise;
  if (folderModalMode === 'edit' && editingFolderId) {
    promise = apiCall('/api/study-folders/' + encodeURIComponent(editingFolderId), { method: 'PATCH', body: JSON.stringify(payload) }).then(function () { showToast('Folder updated.'); });
  } else {
    promise = apiCall('/api/study-folders', { method: 'POST', body: JSON.stringify(payload) }).then(function () { showToast('Folder created.'); });
  }
  promise.then(function () { closeFolderModal(); return loadData(selectedPackId || pendingOpenPackId); }).catch(function (e) { showToast(e.message || 'Could not save folder.', 'error'); });
}

/* ── Open pack ── */
function openPack(packId) {
  return apiCall('/api/study-packs/' + encodeURIComponent(packId)).then(function (data) {
    selectedPack = data;
    selectedPack.flashcards = Array.isArray(selectedPack.flashcards) ? selectedPack.flashcards : [];
    selectedPack.test_questions = Array.isArray(selectedPack.test_questions) ? selectedPack.test_questions.map(normalizeQuestion) : [];
    selectedPack.has_audio_playback = !!selectedPack.has_audio_playback;
    selectedPack.has_audio_sync = !!selectedPack.has_audio_sync;
    selectedPack.notes_audio_map = Array.isArray(selectedPack.notes_audio_map) ? selectedPack.notes_audio_map : [];
    showPackEditor(true); updatePackSummary();
    packTitle.value = selectedPack.title || '';
    setPackFolderSelection(selectedPack.folder_id || '');
    packCourse.value = selectedPack.course || '';
    packSubject.value = selectedPack.subject || '';
    packSemester.value = selectedPack.semester || '';
    packBlock.value = selectedPack.block || '';
    packAdvancedMetadataOpen = false;
    syncPackAdvancedMetadataState();
    renderGoalPanel();
    renderNotesForSelectedPackBase();
    reapplyHighlightsForPack();
    initAudioForSelectedPack();
    renderFlashcardEditor(); renderQuestionEditor();
    setEditorPane(activeEditorPane);
    // Deep link: auto-open learn mode if URL says so
    if (openLearnFromUrl && !autoLearnConsumed && selectedPack.study_pack_id === learnPackFromUrl) {
      autoLearnConsumed = true;
      var preferMode = focusFromUrl || '';
      if (preferMode && ['flashcards', 'test', 'write', 'match'].indexOf(preferMode) >= 0) {
        openLearnStageWithMode(preferMode, fullscreenFromUrl);
      } else {
        openSessionSetup();
      }
    }
  });
}

function hydratePackStatesForKnownPacks() {
  if (!auth.currentUser) return;
  cleanupCardStateCacheForKnownPacks();
  var uid = auth.currentUser.uid;
  var remoteStates = (remoteProgressCardStates && typeof remoteProgressCardStates === 'object') ? remoteProgressCardStates : {};
  packs.forEach(function (pack) {
    var packId = String((pack && pack.study_pack_id) || '');
    if (!packId) return;
    var key = 'card_state_' + uid + '_' + packId;
    var localState = {};
    try { localState = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { localState = {}; }
    var remoteState = remoteStates[packId] || {};
    if (!Object.keys(localState).length && Object.keys(remoteState).length) {
      try { localStorage.setItem(key, JSON.stringify(remoteState)); } catch (e) { }
    }
    if (Object.keys(remoteState).length || Object.keys(localState).length) {
      addPackToCardStateIndex(packId);
    }
  });
  cleanupCardStateCacheForKnownPacks();
}

/* ── Load data ── */
function loadData(preferredPackId) {
  var prefId = preferredPackId || '';
  return Promise.all([apiCall('/api/study-folders'), apiCall('/api/study-packs')]).then(function (results) {
    folders = results[0].folders || []; packs = results[1].study_packs || [];
    loadPinnedFolderIds();
    syncPinnedFolderIds();
    if (selectedFolderId && selectedFolderId !== BUILTIN_INTERVIEWS_FOLDER_ID && selectedFolderId !== BUILTIN_ALL_FOLDER_ID && !folders.some(function (folder) { return folder.folder_id === selectedFolderId; })) {
      selectedFolderId = '';
    }
    hydratePackStatesForKnownPacks();
    updateTopbarDueCount();
    renderFolderSelect(); renderFolders(); renderPacks();
    var packToOpen = prefId || selectedPackId || '';
    if (packToOpen && packs.find(function (item) { return item.study_pack_id === packToOpen; })) {
      selectedPackId = packToOpen; renderPacks(); return openPack(packToOpen);
    } else if (learnPackFromUrl && packs.find(function (item) { return item.study_pack_id === learnPackFromUrl; })) {
      selectedPackId = learnPackFromUrl; renderPacks(); return openPack(learnPackFromUrl);
    } else {
      selectedPack = null; showPackEditor(false); updatePackSummary();
      renderGoalPanel();
      closeAudioPlayer();
    }
  });
}

function buildInlineAutosavePayload() {
  if (!selectedPackId || !selectedPack) return null;
  return {
    title: String(packTitle && packTitle.value || '').trim(),
    folder_id: String(packFolderSelect && packFolderSelect.value || ''),
    course: String(packCourse && packCourse.value || '').trim(),
    subject: String(packSubject && packSubject.value || '').trim(),
    semester: String(packSemester && packSemester.value || '').trim(),
    block: String(packBlock && packBlock.value || '').trim(),
    notes_markdown: String(selectedPack.notes_markdown || ''),
    flashcards: selectedPack.flashcards || [],
    test_questions: selectedPack.test_questions || [],
  };
}

function runInlineAutosaveNow() {
  if (!selectedPackId || !selectedPack || !token) return Promise.resolve();
  if (inlineAutoSaving) {
    inlineAutoSaveQueued = true;
    return Promise.resolve();
  }
  inlineAutoSaving = true;
  var packId = selectedPackId;
  var payload = buildInlineAutosavePayload();
  if (!payload) {
    inlineAutoSaving = false;
    return Promise.resolve();
  }
  return apiCall('/api/study-packs/' + encodeURIComponent(packId), {
    method: 'PATCH',
    body: JSON.stringify(payload)
  }).then(function () {
    if (selectedPack && selectedPack.study_pack_id === packId) {
      selectedPack.title = payload.title;
      selectedPack.folder_id = payload.folder_id;
      selectedPack.course = payload.course;
      selectedPack.subject = payload.subject;
      selectedPack.semester = payload.semester;
      selectedPack.block = payload.block;
      selectedPack.updated_at = Date.now() / 1000;
      updatePackSummary();
    }
    showToast('Saved successfully.', 'success');
  }).catch(function (e) {
    showToast(e.message || 'Could not save study pack.', 'error');
  }).finally(function () {
    inlineAutoSaving = false;
    if (inlineAutoSaveQueued) {
      inlineAutoSaveQueued = false;
      runInlineAutosaveNow();
    }
  });
}

function queueInlineAutosave() {
  if (!selectedPackId || !selectedPack || !token) return;
  if (inlineAutoSaveTimer) {
    clearTimeout(inlineAutoSaveTimer);
    inlineAutoSaveTimer = null;
  }
  inlineAutoSaveTimer = setTimeout(function () {
    inlineAutoSaveTimer = null;
    runInlineAutosaveNow();
  }, 650);
}

/* ── Auth ── */
hydrateTopbarDueFromCache(auth.currentUser || null);
auth.onAuthStateChanged(function (user) {
  if (!user) {
    token = null;
    if (authClient && typeof authClient.clearToken === 'function') { authClient.clearToken(); }
    activeModalOverlay = null;
    modalStateStack = [];
    pinnedFolderIds = [];
    progressTimezone = getBrowserTimezone();
    progressHydrationDone = false;
    progressSummaryCache = null;
    masterDailyGoal = progressUtils.DEFAULT_DAILY_GOAL || 20;
    remoteProgressCardStates = {};
    if (progressSyncTimer) { clearTimeout(progressSyncTimer); progressSyncTimer = null; }
    progressSyncInFlight = false;
    if (highlightSyncTimer) { clearTimeout(highlightSyncTimer); highlightSyncTimer = null; }
    highlightSyncInFlight = false;
    pendingHighlightPayload = undefined;
    pendingHighlightPackId = '';
    if (builderOverlay.classList.contains('visible')) {
      markBuilderDirty(false);
      closeBuilderOverlay();
    }
    if (topbarUtils.applyAuthState && userMeta) {
      topbarUtils.applyAuthState({
        user: null,
        userTextEl: userMeta,
        signedOutText: 'Not signed in'
      });
    } else if (userMeta) {
      userMeta.textContent = 'Not signed in';
    }
    hydrateTopbarDueFromCache(null);
    applyStudySignedOutState();
    return;
  }
  setStudyLibraryVisibility(true);
  user.getIdToken().then(function (t) {
    token = t;
    if (authClient && typeof authClient.setToken === 'function') { authClient.setToken(t); }
    if (topbarUtils.applyAuthState && userMeta) {
      topbarUtils.applyAuthState({
        user: user,
        userTextEl: userMeta,
        signedInPrefix: 'Signed in as '
      });
    } else if (userMeta) {
      userMeta.textContent = 'Signed in as ' + user.email;
    }
    hydrateTopbarDueFromCache(user);
    return loadRemoteProgress().then(function () {
      return loadData();
    }).then(function () {
      renderGoalPanel();
      if (actionFromUrl === 'create-pack' && !autoCreateConsumed) {
        autoCreateConsumed = true;
        openBuilderOverlay('create', null);
      }
      queueProgressSync(false);
    });
  }).catch(function (e) {
    showToast(e.message || 'Could not load study library.', 'error');
  });
});
setInterval(function () {
  if (!auth.currentUser) { return; }
  auth.currentUser.getIdToken(true).then(function (t) {
    token = t;
    if (authClient && typeof authClient.setToken === 'function') { authClient.setToken(t); }
  }).catch(function () { });
}, 10 * 60 * 1000);

/* ── Event listeners ── */
if (studyAuthSignInBtn) {
  studyAuthSignInBtn.addEventListener('click', openStudySignIn);
}
createPackBtn.addEventListener('click', function () {
  if (!auth.currentUser) {
    showToast('Please sign in first.', 'error');
    return;
  }
  openBuilderOverlay('create', null);
});
openBuilderBtn.addEventListener('click', function () {
  if (!auth.currentUser) {
    showToast('Please sign in first.', 'error');
    return;
  }
  if (!selectedPack) {
    showToast('Select a study pack first.', 'error');
    return;
  }
  openBuilderOverlay('edit', selectedPack);
  if (activeEditorPane === 'flashcards') {
    setBuilderPane('flashcards');
  } else if (activeEditorPane === 'test') {
    setBuilderPane('test');
  } else {
    setBuilderPane('info');
  }
});
builderSaveBtn.addEventListener('click', function () {
  saveBuilderPack(false);
});
builderExitBtn.addEventListener('click', function () {
  handleBuilderExitRequest();
});
builderPaneButtons.forEach(function (button) {
  button.addEventListener('click', function () {
    setBuilderPane(button.dataset.builderPane);
  });
});
builderOpenLearnShortcut.addEventListener('click', function () {
  if (builderDirty) {
    showToast('Save changes before opening Learn mode.', 'error');
    return;
  }
  if (!builderPackId) {
    showToast('Save this new pack first.', 'error');
    return;
  }
  openPack(builderPackId).then(function () {
    closeBuilderOverlay();
    openSessionSetup();
  });
});
builderTitleInput.addEventListener('input', function () {
  if (!builderDraft) { return; }
  builderDraft.title = builderTitleInput.value;
  builderBrandSub.textContent = 'Editing ' + (builderDraft.title || 'Untitled pack');
  markBuilderDirty(true);
});
builderFolderSelect.addEventListener('change', function () {
  if (!builderDraft) { return; }
  builderDraft.folder_id = builderFolderSelect.value || '';
  markBuilderDirty(true);
});
builderCourseInput.addEventListener('input', function () { if (builderDraft) { builderDraft.course = builderCourseInput.value; markBuilderDirty(true); } });
builderSubjectInput.addEventListener('input', function () { if (builderDraft) { builderDraft.subject = builderSubjectInput.value; markBuilderDirty(true); } });
builderSemesterInput.addEventListener('input', function () {
  if (!builderDraft) { return; }
  builderDraft.semester = builderSemesterInput.value;
  builderAdvancedMetadataOpen = true;
  syncBuilderAdvancedMetadataState();
  markBuilderDirty(true);
});
builderBlockInput.addEventListener('input', function () {
  if (!builderDraft) { return; }
  builderDraft.block = builderBlockInput.value;
  builderAdvancedMetadataOpen = true;
  syncBuilderAdvancedMetadataState();
  markBuilderDirty(true);
});
builderNotesInput.addEventListener('input', function () { if (builderDraft) { builderDraft.notes_markdown = builderNotesInput.value; markBuilderDirty(true); } });
builderAddCardBtn.addEventListener('click', function () {
  if (!builderDraft) { return; }
  builderDraft.flashcards.push({ front: '', back: '' });
  renderBuilderFlashcards();
  markBuilderDirty(true);
});
builderAddCardBatchBtn.addEventListener('click', function () {
  if (!builderDraft) { return; }
  for (var i = 0; i < 5; i++) { builderDraft.flashcards.push({ front: '', back: '' }); }
  renderBuilderFlashcards();
  markBuilderDirty(true);
});
builderAddQuestionBtn.addEventListener('click', function () {
  if (!builderDraft) { return; }
  builderDraft.test_questions.push(createDefaultQuestion());
  renderBuilderQuestions();
  markBuilderDirty(true);
});
builderAddQuestionBatchBtn.addEventListener('click', function () {
  if (!builderDraft) { return; }
  for (var i = 0; i < 3; i++) { builderDraft.test_questions.push(createDefaultQuestion()); }
  renderBuilderQuestions();
  markBuilderDirty(true);
});
builderFlashcardList.addEventListener('input', function (event) {
  if (!builderDraft) { return; }
  var target = event.target;
  if (target.matches('[data-fc-field]')) {
    var index = parseInt(target.dataset.fcIndex, 10);
    var field = target.dataset.fcField;
    if (builderDraft.flashcards[index]) {
      builderDraft.flashcards[index][field] = target.value;
      markBuilderDirty(true);
    }
  }
});
builderFlashcardList.addEventListener('click', function (event) {
  if (!builderDraft) { return; }
  var button = event.target.closest('[data-delete-fc]');
  if (!button) { return; }
  var index = parseInt(button.dataset.deleteFc, 10);
  builderDraft.flashcards.splice(index, 1);
  renderBuilderFlashcards();
  markBuilderDirty(true);
});
builderQuestionList.addEventListener('input', function (event) {
  if (!builderDraft) { return; }
  var target = event.target;
  if (target.matches('[data-q-field]')) {
    var index = parseInt(target.dataset.qIndex, 10);
    var field = target.dataset.qField;
    if (builderDraft.test_questions[index]) {
      builderDraft.test_questions[index][field] = target.value;
      markBuilderDirty(true);
    }
  } else if (target.matches('[data-q-option]')) {
    var qIndex = parseInt(target.dataset.qIndex, 10);
    var optIndex = parseInt(target.dataset.qOption, 10);
    var question = builderDraft.test_questions[qIndex];
    if (question) {
      question.options[optIndex] = target.value;
      if (question.options.indexOf(question.answer) < 0) {
        question.answer = question.options[0] || '';
      }
      renderBuilderQuestions();
      markBuilderDirty(true);
    }
  }
});
builderQuestionList.addEventListener('change', function (event) {
  if (!builderDraft) { return; }
  var target = event.target;
  if (target.matches('[data-q-answer]')) {
    var index = parseInt(target.dataset.qAnswer, 10);
    if (builderDraft.test_questions[index]) {
      builderDraft.test_questions[index].answer = target.value;
      markBuilderDirty(true);
    }
  }
});
builderQuestionList.addEventListener('click', function (event) {
  if (!builderDraft) { return; }
  var button = event.target.closest('[data-delete-q]');
  if (!button) { return; }
  var index = parseInt(button.dataset.deleteQ, 10);
  builderDraft.test_questions.splice(index, 1);
  renderBuilderQuestions();
  markBuilderDirty(true);
});
builderImportType.addEventListener('change', clearBuilderImportState);
builderCsvDrop.addEventListener('click', function () { builderCsvInput.click(); });
builderCsvDrop.addEventListener('dragover', function (event) {
  event.preventDefault();
  builderCsvDrop.classList.add('dragover');
});
builderCsvDrop.addEventListener('dragleave', function () {
  builderCsvDrop.classList.remove('dragover');
});
builderCsvDrop.addEventListener('drop', function (event) {
  event.preventDefault();
  builderCsvDrop.classList.remove('dragover');
  var files = event.dataTransfer && event.dataTransfer.files;
  if (files && files[0]) { handleBuilderCsvFile(files[0]); }
});
builderCsvInput.addEventListener('change', function () {
  if (builderCsvInput.files && builderCsvInput.files[0]) {
    handleBuilderCsvFile(builderCsvInput.files[0]);
  }
});
builderApplyImportBtn.addEventListener('click', applyBuilderImport);
builderTemplateBtn.addEventListener('click', downloadBuilderTemplate);
builderExitSave.addEventListener('click', function () { closeBuilderExitModal('save'); });
builderExitDiscard.addEventListener('click', function () { closeBuilderExitModal('discard'); });
builderExitCancel.addEventListener('click', function () { closeBuilderExitModal('cancel'); });
builderExitOverlay.addEventListener('click', function (event) {
  if (event.target === builderExitOverlay) { closeBuilderExitModal('cancel'); }
});
window.addEventListener('beforeunload', function (event) {
  if (builderDirty && builderOverlay.classList.contains('visible')) {
    event.preventDefault();
    event.returnValue = '';
  }
});
if (backAppBtn) {
  if (topbarUtils.bindRedirectButton) {
    topbarUtils.bindRedirectButton(backAppBtn, '/dashboard');
  } else {
    backAppBtn.addEventListener('click', function () { window.location.href = '/dashboard'; });
  }
}
fullscreenBtn.addEventListener('click', function () {
  if (!selectedPack) { showToast('Select a study pack first.', 'error'); return; }
  openSessionSetup();
});
searchInput.addEventListener('input', renderPacks);
if (packEmptyCreateBtn) {
  packEmptyCreateBtn.addEventListener('click', function () { openBuilderOverlay('create', null); });
}
if (packEmptyDemoBtn) {
  packEmptyDemoBtn.addEventListener('click', createDemoPack);
}
if (packAdvancedMetaBtn) {
  packAdvancedMetaBtn.addEventListener('click', function () {
    applyPackAdvancedMetadataState(!packAdvancedMetadataOpen);
  });
}
if (builderAdvancedMetaBtn) {
  builderAdvancedMetaBtn.addEventListener('click', function () {
    applyBuilderAdvancedMetadataState(!builderAdvancedMetadataOpen);
  });
}
packFolderButton.addEventListener('click', function (e) {
  e.stopPropagation();
  var shouldOpen = !packFolderMenu.classList.contains('visible');
  setPackFolderMenuOpen(shouldOpen, shouldOpen ? 'active' : null);
});
packFolderButton.addEventListener('keydown', function (e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); setPackFolderMenuOpen(true, 'first'); }
  if (e.key === 'ArrowUp') { e.preventDefault(); setPackFolderMenuOpen(true, 'last'); }
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    var shouldOpen = !packFolderMenu.classList.contains('visible');
    setPackFolderMenuOpen(shouldOpen, shouldOpen ? 'active' : null);
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    setPackFolderMenuOpen(false);
  }
});
packFolderMenu.addEventListener('keydown', function (e) {
  if (e.key === 'ArrowDown') { e.preventDefault(); focusMenuItem(packFolderMenu, '.app-select-item', 'next'); }
  if (e.key === 'ArrowUp') { e.preventDefault(); focusMenuItem(packFolderMenu, '.app-select-item', 'prev'); }
  if (e.key === 'Home') { e.preventDefault(); focusMenuItem(packFolderMenu, '.app-select-item', 'first'); }
  if (e.key === 'End') { e.preventDefault(); focusMenuItem(packFolderMenu, '.app-select-item', 'last'); }
  if (e.key === 'Escape') {
    e.preventDefault();
    setPackFolderMenuOpen(false);
    packFolderButton.focus();
  }
  if (e.key === 'Tab') { setPackFolderMenuOpen(false); }
});
if (packTitle) {
  packTitle.addEventListener('input', function () {
    if (!selectedPack) return;
    selectedPack.title = packTitle.value;
    updatePackSummary();
    queueInlineAutosave();
  });
}
if (packCourse) {
  packCourse.addEventListener('input', function () {
    if (!selectedPack) return;
    selectedPack.course = packCourse.value;
    queueInlineAutosave();
  });
}
if (packSubject) {
  packSubject.addEventListener('input', function () {
    if (!selectedPack) return;
    selectedPack.subject = packSubject.value;
    queueInlineAutosave();
  });
}
if (packSemester) {
  packSemester.addEventListener('input', function () {
    if (!selectedPack) return;
    selectedPack.semester = packSemester.value;
    queueInlineAutosave();
  });
}
if (packBlock) {
  packBlock.addEventListener('input', function () {
    if (!selectedPack) return;
    selectedPack.block = packBlock.value;
    queueInlineAutosave();
  });
}
newFolderBtn.addEventListener('click', function () { openFolderModal('create', null); });

deleteFolderBtn.addEventListener('click', function () {
  if (!selectedFolderId) { showToast('Select a folder first.', 'error'); return; }
  if (isBuiltInFolderId(selectedFolderId)) { showToast('This folder is pinned by default and cannot be deleted.', 'error'); return; }
  openConfirmModal('Delete Folder', 'Delete this folder? Packs inside will move to no folder.', 'Delete Folder').then(function (confirmed) {
    if (!confirmed) return;
    apiCall('/api/study-folders/' + encodeURIComponent(selectedFolderId), { method: 'DELETE' }).then(function () {
      pinnedFolderIds = pinnedFolderIds.filter(function (folderId) { return folderId !== selectedFolderId; });
      persistPinnedFolderIds();
      selectedFolderId = ''; showToast('Folder deleted.'); return loadData(selectedPackId);
    }).catch(function (e) { showToast(e.message || 'Could not delete folder.', 'error'); });
  });
});

if (savePackBtn) {
  savePackBtn.addEventListener('click', function () {
    if (!selectedPackId || !selectedPack) { showToast('Select a study pack first.', 'error'); return; }
    runInlineAutosaveNow();
  });
}

if (overallDailyGoalDecrease) {
  overallDailyGoalDecrease.addEventListener('click', function () {
    nudgeGoalInput(overallDailyGoalInput, -1, loadDailyGoal());
    scheduleOverallGoalAutosave(false, true);
  });
}
if (overallDailyGoalIncrease) {
  overallDailyGoalIncrease.addEventListener('click', function () {
    nudgeGoalInput(overallDailyGoalInput, 1, loadDailyGoal());
    scheduleOverallGoalAutosave(false, true);
  });
}
if (overallDailyGoalInput) {
  overallDailyGoalInput.addEventListener('input', function () {
    scheduleOverallGoalAutosave(false, false);
  });
  overallDailyGoalInput.addEventListener('change', function () {
    scheduleOverallGoalAutosave(true, true);
  });
  overallDailyGoalInput.addEventListener('blur', function () {
    scheduleOverallGoalAutosave(true, true);
  });
  overallDailyGoalInput.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    scheduleOverallGoalAutosave(true, true);
  });
}
if (packDailyGoalClear) {
  packDailyGoalClear.addEventListener('click', function () {
    if (!packDailyGoalInput || packDailyGoalInput.disabled) return;
    packDailyGoalInput.value = '';
    schedulePackGoalAutosave(true, false);
  });
}
if (packDailyGoalDecrease) {
  packDailyGoalDecrease.addEventListener('click', function () {
    var fallback = selectedPack && selectedPack.daily_card_goal !== null && selectedPack.daily_card_goal !== undefined
      ? selectedPack.daily_card_goal
      : loadDailyGoal();
    nudgeGoalInput(packDailyGoalInput, -1, fallback);
    schedulePackGoalAutosave(false, true);
  });
}
if (packDailyGoalIncrease) {
  packDailyGoalIncrease.addEventListener('click', function () {
    var fallback = selectedPack && selectedPack.daily_card_goal !== null && selectedPack.daily_card_goal !== undefined
      ? selectedPack.daily_card_goal
      : loadDailyGoal();
    nudgeGoalInput(packDailyGoalInput, 1, fallback);
    schedulePackGoalAutosave(false, true);
  });
}
if (packDailyGoalInput) {
  packDailyGoalInput.addEventListener('input', function () {
    schedulePackGoalAutosave(false, false);
  });
  packDailyGoalInput.addEventListener('change', function () {
    schedulePackGoalAutosave(true, true);
  });
  packDailyGoalInput.addEventListener('blur', function () {
    schedulePackGoalAutosave(true, true);
  });
  packDailyGoalInput.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    schedulePackGoalAutosave(true, true);
  });
}

deletePackBtn.addEventListener('click', function () {
  if (!selectedPackId) { showToast('Select a study pack first.', 'error'); return; }
  openConfirmModal('Delete Study Pack', 'Delete this study pack permanently? This cannot be undone.', 'Delete Pack').then(function (confirmed) {
    if (!confirmed) return;
    var removedPackId = selectedPackId;
    apiCall('/api/study-packs/' + encodeURIComponent(selectedPackId), { method: 'DELETE' }).then(function () {
      return apiCall('/api/study-progress', { method: 'PUT', body: JSON.stringify({ remove_pack_ids: [removedPackId] }) }).catch(function () { });
    }).then(function () {
      removePackLocalCaches(removedPackId);
      selectedPackId = ''; selectedPack = null; showPackEditor(false); updatePackSummary();
      return loadData();
    }).then(function () { showToast('Study pack deleted.'); }).catch(function (e) { showToast(e.message || 'Could not delete study pack.', 'error'); });
  });
});

exportPackNotesBtn.addEventListener('click', function () {
  if (!selectedPackId) { showToast('Select a study pack first.', 'error'); return; }
  downloadStudyPackNotes(selectedPackId, 'docx').then(function () { showToast('Lecture notes export started.'); }).catch(function (e) { showToast(e.message || 'Could not export notes.', 'error'); });
});
if (exportMenuBtn && exportMenuList) {
  exportMenuBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var shouldOpen = !exportMenuList.classList.contains('visible');
    setExportMenuOpen(shouldOpen, shouldOpen ? 'first' : null);
  });
  exportMenuBtn.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setExportMenuOpen(true, 'first'); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setExportMenuOpen(true, 'last'); }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      var shouldOpen = !exportMenuList.classList.contains('visible');
      setExportMenuOpen(shouldOpen, shouldOpen ? 'first' : null);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setExportMenuOpen(false);
    }
  });
  exportMenuList.addEventListener('click', function (e) {
    var item = e.target.closest('.export-menu-item[data-export-kind]');
    if (!item) return;
    if (!selectedPackId) { showToast('Select a study pack first.', 'error'); return; }
    var kind = item.dataset.exportKind;
    if (kind === 'pdf-menu') {
      e.stopPropagation();
      if (exportPdfSubmenu) {
        var shouldOpen = !exportPdfSubmenu.classList.contains('visible');
        setExportPdfSubmenuOpen(shouldOpen);
        if (shouldOpen) { focusMenuItem(exportPdfSubmenu, '.export-menu-item', 'first'); }
      }
      return;
    }
    setExportMenuOpen(false);
    if (kind === 'pdf-with-answers') {
      downloadStudyPackPdf(selectedPackId, true).then(function () { showToast('PDF export started.'); }).catch(function (e2) { showToast(e2.message || 'Could not export PDF.', 'error'); });
      return;
    }
    if (kind === 'pdf-no-answers') {
      downloadStudyPackPdf(selectedPackId, false).then(function () { showToast('Practice PDF export started.'); }).catch(function (e3) { showToast(e3.message || 'Could not export PDF.', 'error'); });
      return;
    }
    var csvType = (kind === 'test') ? 'test' : 'flashcards';
    downloadStudyPackCsv(selectedPackId, csvType).then(function () { showToast('CSV export started.'); }).catch(function (e4) { showToast(e4.message || 'Could not export CSV.', 'error'); });
  });
  exportMenuList.addEventListener('keydown', function (e) {
    var focused = document.activeElement;
    var focusedItem = focused && focused.closest('.export-menu-item');
    if (e.key === 'ArrowDown') { e.preventDefault(); focusMenuItem(exportMenuList, '.export-menu-item', 'next'); }
    if (e.key === 'ArrowUp') { e.preventDefault(); focusMenuItem(exportMenuList, '.export-menu-item', 'prev'); }
    if (e.key === 'Home') { e.preventDefault(); focusMenuItem(exportMenuList, '.export-menu-item', 'first'); }
    if (e.key === 'End') { e.preventDefault(); focusMenuItem(exportMenuList, '.export-menu-item', 'last'); }
    if (e.key === 'Escape') {
      e.preventDefault();
      setExportMenuOpen(false);
      exportMenuBtn.focus();
    }
    if (e.key === 'ArrowRight' && focusedItem && focusedItem.dataset.exportKind === 'pdf-menu') {
      e.preventDefault();
      setExportPdfSubmenuOpen(true);
      focusMenuItem(exportPdfSubmenu, '.export-menu-item', 'first');
    }
    if (e.key === 'ArrowLeft' && focusedItem && focusedItem.closest('#export-pdf-submenu')) {
      e.preventDefault();
      setExportPdfSubmenuOpen(false);
      var pdfTrigger = exportMenuList.querySelector('[data-export-kind="pdf-menu"]');
      if (pdfTrigger) { pdfTrigger.focus(); }
    }
    if (e.key === 'Tab') { setExportMenuOpen(false); }
  });
}

openLearnBtn.addEventListener('click', function () { openSessionSetup(); });
editorTabs.forEach(function (btn) { btn.addEventListener('click', function () { setEditorPane(btn.dataset.editorPane); }); });

addFlashcardBtn.addEventListener('click', function () {
  if (!selectedPack) return;
  selectedPack.flashcards = selectedPack.flashcards || [];
  selectedPack.flashcards.push({ front: 'New concept', back: 'New explanation' });
  var ni = selectedPack.flashcards.length - 1;
  learnFlashcardIndex = ni; learnFlashcardFlipped = false;
  renderFlashcardEditor(ni); setEditorPane('flashcards');
  queueInlineAutosave();
  showToast('New flashcard added.');
});

addQuestionBtn.addEventListener('click', function () {
  if (!selectedPack) return;
  selectedPack.test_questions = selectedPack.test_questions || [];
  selectedPack.test_questions.push(normalizeQuestion({ question: 'New question', options: ['Option A', 'Option B', 'Option C', 'Option D'], answer: 'Option A', explanation: 'Add explanation here.' }));
  var ni = selectedPack.test_questions.length - 1;
  learnQuestionIndex = ni;
  renderQuestionEditor(ni); setEditorPane('test');
  queueInlineAutosave();
  showToast('New practice question added.');
});

if (topbarUtils.bindRedirectButton) {
  topbarUtils.bindRedirectButton(learnBackAppBtn, '/dashboard');
} else {
  learnBackAppBtn.addEventListener('click', function () { window.location.href = '/dashboard'; });
}
learnBackLibraryBtn.addEventListener('click', closeLearnStage);
learnFullscreenBtn.addEventListener('click', function () {
  try {
    if (document.fullscreenElement) { document.exitFullscreen(); }
    else { document.documentElement.requestFullscreen(); }
  } catch (e) { showToast('Fullscreen not available.', 'error'); }
});
if (notesFullscreenBtn) {
  notesFullscreenBtn.addEventListener('click', openNotesFullscreen);
  notesFullscreenBtn.addEventListener('mouseenter', function () { notesFullscreenBtn.classList.remove('idle'); });
}
if (notesPaneShell) {
  notesPaneShell.addEventListener('mouseenter', function () {
    if (activeEditorPane === 'notes') { scheduleNotesFullscreenIdle(); }
  });
}
audioPlayBtn.addEventListener('click', function () {
  if (!audioReady) return;
  if (audioPlayerEl.paused) { audioPlayerEl.play().catch(function () { }); }
  else { audioPlayerEl.pause(); }
});
audioCloseBtn.addEventListener('click', closeAudioPlayer);
audioSpeedBtn.addEventListener('click', function () {
  if (!audioReady) return;
  audioSpeedIndex = (audioSpeedIndex + 1) % audioSpeeds.length;
  audioPlayerEl.playbackRate = audioSpeeds[audioSpeedIndex];
  audioSpeedBtn.textContent = audioSpeeds[audioSpeedIndex] + 'x';
});
audioProgressWrap.addEventListener('click', function (e) {
  if (!audioReady || !audioPlayerEl.duration) return;
  var rect = audioProgressWrap.getBoundingClientRect();
  var pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  audioPlayerEl.currentTime = pct * audioPlayerEl.duration;
  updateAudioControls();
  updateAudioActiveSection();
});
audioPlayerEl.addEventListener('loadedmetadata', updateAudioControls);
audioPlayerEl.addEventListener('play', updateAudioControls);
audioPlayerEl.addEventListener('pause', updateAudioControls);
audioPlayerEl.addEventListener('ended', function () { updateAudioControls(); clearAudioActiveSections(); });
audioPlayerEl.addEventListener('timeupdate', function () { updateAudioControls(); updateAudioActiveSection(); });
difficultyButtons.forEach(function (btn) {
  btn.addEventListener('click', function () {
    var cardId = getCurrentDifficultyCardId();
    if (!cardId) { return; }
    applyReviewAction(cardId, btn.dataset.reviewAction || 'good');
    resetLearnHintVisibility();
  });
});

function applyCurrentFlashcardReviewAction(action) {
  if (activeLearnMode !== 'flashcards') return;
  var queue = getFlashcardQueue();
  var entry = queue[learnFlashcardIndex];
  if (!entry) return;
  applyReviewAction('fc_' + entry.idx, action);
  resetLearnHintVisibility();
}

/* Flashcard controls */
learnFlashcard3d.addEventListener('click', function () {
  if (suppressNextFlashcardTap) {
    suppressNextFlashcardTap = false;
    return;
  }
  if (fcSliding) return;
  learnFlashcardFlipped = !learnFlashcardFlipped;
  renderLearnFlashcard();
  resetLearnHintVisibility();
});
learnFPrev.addEventListener('click', function () { doFlashcardSlide('prev'); resetLearnHintVisibility(); });
learnFNext.addEventListener('click', function () { doFlashcardSlide('next'); resetLearnHintVisibility(); });
learnFFlip.addEventListener('click', function () {
  if (fcSliding) return;
  learnFlashcardFlipped = !learnFlashcardFlipped;
  renderLearnFlashcard();
  resetLearnHintVisibility();
});
if (learnFListBtn) {
  learnFListBtn.addEventListener('click', function () {
    setFlashcardListMode(!flashcardListMode);
    resetLearnHintVisibility();
  });
}
if (learnFPeekToggle) {
  learnFPeekToggle.addEventListener('change', function () {
    flashcardPeekMode = Boolean(learnFPeekToggle.checked);
    if (flashcardPeekMode) {
      flashcardPeekRevealed = {};
    }
    renderFlashcardListView();
  });
}

var flashcardTouchStartX = 0;
var flashcardTouchStartY = 0;
var flashcardTouchActive = false;
var suppressNextFlashcardTap = false;
if (learnFlashcard3d) {
  learnFlashcard3d.addEventListener('touchstart', function (e) {
    if (activeLearnMode !== 'flashcards' || fcSliding) return;
    if (!e.touches || !e.touches.length) return;
    var touch = e.touches[0];
    flashcardTouchStartX = touch.clientX;
    flashcardTouchStartY = touch.clientY;
    flashcardTouchActive = true;
  }, { passive: true });
  learnFlashcard3d.addEventListener('touchend', function (e) {
    if (!flashcardTouchActive || activeLearnMode !== 'flashcards' || fcSliding) return;
    flashcardTouchActive = false;
    if (!e.changedTouches || !e.changedTouches.length) return;
    var touch = e.changedTouches[0];
    var deltaX = touch.clientX - flashcardTouchStartX;
    var deltaY = touch.clientY - flashcardTouchStartY;
    if (Math.abs(deltaX) < 70 || Math.abs(deltaX) <= Math.abs(deltaY)) return;
    suppressNextFlashcardTap = true;
    doFlashcardSlide(deltaX > 0 ? 'prev' : 'next');
    resetLearnHintVisibility();
  }, { passive: true });
}

/* Quiz next */
learnQNext.addEventListener('click', function () {
  var questions = selectedPack && selectedPack.test_questions ? selectedPack.test_questions : [];
  if (!questions.length) return;
  if (learnQuestionIndex < questions.length - 1) { learnQuestionIndex++; renderLearnQuestion(); resetLearnHintVisibility(); }
  else { showToast('All questions completed!'); }
});

/* Keyboard shortcuts */
window.addEventListener('keydown', function (e) {
  if (activeModalOverlay) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeActiveModalFromEscape();
      return;
    }
    if (e.key === 'Tab') {
      var focusables = getModalFocusableElements(activeModalOverlay);
      if (!focusables.length) { return; }
      var first = focusables[0], last = focusables[focusables.length - 1], active = document.activeElement;
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
        return;
      }
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
        return;
      }
    }
    return;
  }
  if (builderOverlay.classList.contains('visible') && e.key === 'Escape') {
    e.preventDefault();
    handleBuilderExitRequest();
    return;
  }
  if (!learnStage.classList.contains('visible')) return;
  var activeElement = document.activeElement;
  var isTypingTarget = activeElement && (
    activeElement.tagName === 'INPUT' ||
    activeElement.tagName === 'TEXTAREA' ||
    activeElement.tagName === 'SELECT' ||
    activeElement.isContentEditable
  );
  if (!isTypingTarget && activeLearnMode === 'flashcards') {
    if (e.key === '1' || e.key === '2' || e.key === '3' || e.key === '4') {
      e.preventDefault();
      var mapped = e.key === '1' ? 'retry' : (e.key === '2' ? 'hard' : (e.key === '3' ? 'good' : 'easy'));
      applyCurrentFlashcardReviewAction(mapped);
      return;
    }
  }
  if (activeLearnMode === 'flashcards') {
    if (e.key === 'ArrowLeft') { e.preventDefault(); doFlashcardSlide('prev'); resetLearnHintVisibility(); }
    if (e.key === 'ArrowRight') { e.preventDefault(); doFlashcardSlide('next'); resetLearnHintVisibility(); }
    if (e.code === 'Space') { e.preventDefault(); learnFFlip.click(); resetLearnHintVisibility(); }
  }
});

/* Folder modal events */
folderModalClose.addEventListener('click', closeFolderModal);
folderModalCancel.addEventListener('click', closeFolderModal);
folderModalSave.addEventListener('click', saveFolderFromModal);
folderModalOverlay.addEventListener('click', function (e) { if (e.target === folderModalOverlay) { closeFolderModal(); } });

/* Close dropdowns on outside click */
document.addEventListener('click', function (e) {
  if (!packFolderPicker.contains(e.target)) { setPackFolderMenuOpen(false); }
  if (exportMenu && !exportMenu.contains(e.target) && exportMenuList) {
    setExportMenuOpen(false);
  }
  if (!e.target.closest('.q-answer-picker')) {
    closeQuestionAnswerMenus();
  }
});

/* Confirm modal events */
confirmModalClose.addEventListener('click', function () { closeConfirmModal(false); });
confirmModalCancel.addEventListener('click', function () { closeConfirmModal(false); });
confirmModalConfirm.addEventListener('click', function () { closeConfirmModal(true); });
confirmModalOverlay.addEventListener('click', function (e) { if (e.target === confirmModalOverlay) { closeConfirmModal(false); } });

/* ── Note Highlighting ── */
var hlActiveColor = 'yellow';
var hlToolbar = document.getElementById('highlight-toolbar');
var hlClearAllBtn = document.getElementById('hl-clear-all');
var hlUndoBtn = document.getElementById('hl-undo');
var hlRedoBtn = document.getElementById('hl-redo');
var hlDownloadBtn = document.getElementById('hl-download');
var hlDownloadMenu = null;
var HL_HISTORY_LIMIT = 50;
var hlUndoStack = [];
var hlRedoStack = [];

function renderNotesForSelectedPackBase() {
  if (!notesView || !selectedPack) return;
  setSafeInnerHtml(notesView, mdToHtml(selectedPack.notes_markdown || ''));
  audioMap = selectedPack.has_audio_sync ? selectedPack.notes_audio_map.slice() : [];
  audioSections = [];
  if (selectedPack.has_audio_sync && audioMap.length) {
    decorateNotesWithAudio(notesView);
  }
  if (notesHighlightStatus) {
    notesHighlightStatus.textContent = 'Highlights save to this study pack automatically.';
  }
}

function cloneHighlightPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return {
    base_key: String(payload.base_key || ''),
    ranges: Array.isArray(payload.ranges) ? payload.ranges.map(function (range) {
      return {
        start: Math.max(0, parseInt(range.start, 10) || 0),
        end: Math.max(0, parseInt(range.end, 10) || 0),
        color: String(range.color || '').trim().toLowerCase()
      };
    }) : [],
    updated_at: Math.max(0, Number(payload.updated_at || 0))
  };
}

function getHighlightCacheKey() {
  return selectedPackId ? (NOTES_HIGHLIGHT_CACHE_PREFIX + selectedPackId) : null;
}

function getLegacyHighlightStorageKey() {
  return selectedPackId ? (LEGACY_NOTES_HIGHLIGHT_CACHE_PREFIX + selectedPackId) : null;
}

function getHighlightBaseKey() {
  if (!selectedPack || !selectedPackId) return '';
  return selectedPackId + ':' + String(selectedPack.updated_at || 0) + ':' + String((selectedPack.notes_markdown || '').length);
}

function normalizeClientHighlightPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  var baseKey = String(payload.base_key || '').trim();
  if (!baseKey || baseKey !== getHighlightBaseKey()) return null;
  if (!Array.isArray(payload.ranges)) return null;
  var ranges = [];
  payload.ranges.forEach(function (rawRange) {
    if (!rawRange || typeof rawRange !== 'object') return;
    var start = parseInt(rawRange.start, 10);
    var end = parseInt(rawRange.end, 10);
    var color = String(rawRange.color || '').trim().toLowerCase();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    if (['yellow', 'green', 'blue', 'pink'].indexOf(color) < 0) return;
    ranges.push({ start: start, end: end, color: color });
  });
  if (!ranges.length) return null;
  return {
    base_key: baseKey,
    ranges: ranges,
    updated_at: Math.max(0, Number(payload.updated_at || 0))
  };
}

function readStructuredHighlightCache() {
  var key = getHighlightCacheKey();
  if (!key) return null;
  try {
    return normalizeClientHighlightPayload(JSON.parse(localStorage.getItem(key) || 'null'));
  } catch (e) {
    return null;
  }
}

function writeStructuredHighlightCache(payload) {
  var key = getHighlightCacheKey();
  if (!key) return;
  if (!payload || !payload.ranges || !payload.ranges.length) {
    try { localStorage.removeItem(key); } catch (e) { }
    return;
  }
  try {
    localStorage.setItem(key, JSON.stringify(payload));
  } catch (e) { }
}

function clearStructuredHighlightCache() {
  var key = getHighlightCacheKey();
  if (key) {
    try { localStorage.removeItem(key); } catch (e) { }
  }
}

function readLegacyHighlightPayload() {
  var key = getLegacyHighlightStorageKey();
  if (!key) return null;
  try {
    var parsed = JSON.parse(localStorage.getItem(key) || 'null');
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.base_key !== getHighlightBaseKey()) return null;
    if (typeof parsed.annotated_html !== 'string' || !parsed.annotated_html) return null;
    return parsed;
  } catch (e) {
    return null;
  }
}

function clearLegacyHighlightCache() {
  var key = getLegacyHighlightStorageKey();
  if (key) {
    try { localStorage.removeItem(key); } catch (e) { }
  }
}

function setNotesHtml(html) {
  if (!notesView) return;
  notesView.innerHTML = String(html || '');
}
function updateHighlightHistoryButtons() {
  if (hlUndoBtn) hlUndoBtn.disabled = hlUndoStack.length === 0;
  if (hlRedoBtn) hlRedoBtn.disabled = hlRedoStack.length === 0;
}

function payloadFingerprint(payload) {
  return JSON.stringify(payload || null);
}

function pushUndoSnapshot(snapshot) {
  var cloned = cloneHighlightPayload(snapshot);
  if (hlUndoStack.length && payloadFingerprint(hlUndoStack[hlUndoStack.length - 1]) === payloadFingerprint(cloned)) return;
  hlUndoStack.push(cloned);
  if (hlUndoStack.length > HL_HISTORY_LIMIT) {
    hlUndoStack.splice(0, hlUndoStack.length - HL_HISTORY_LIMIT);
  }
  updateHighlightHistoryButtons();
}

function resetHighlightHistory(initialSnapshot) {
  hlUndoStack = [];
  hlRedoStack = [];
  void initialSnapshot;
  updateHighlightHistoryButtons();
}

function setHighlightStatus(message) {
  if (!notesHighlightStatus) return;
  notesHighlightStatus.textContent = String(message || 'Highlights save to this study pack automatically.');
}

function buildTextNodeIndex(root) {
  var entries = [];
  if (!root) return entries;
  var offset = 0;
  var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
  var node;
  while ((node = walker.nextNode())) {
    var length = String(node.nodeValue || '').length;
    entries.push({ node: node, start: offset, end: offset + length });
    offset += length;
  }
  return entries;
}

function findTextPosition(entries, offset, preferEnd) {
  if (!entries.length) return null;
  var target = Math.max(0, parseInt(offset, 10) || 0);
  for (var i = 0; i < entries.length; i++) {
    var entry = entries[i];
    if (target < entry.end) {
      return { node: entry.node, offset: target - entry.start };
    }
    if (target === entry.end) {
      if (preferEnd || i === entries.length - 1) {
        return { node: entry.node, offset: entry.node.nodeValue.length };
      }
      return { node: entries[i + 1].node, offset: 0 };
    }
  }
  var lastEntry = entries[entries.length - 1];
  return { node: lastEntry.node, offset: lastEntry.node.nodeValue.length };
}

function createRangeFromOffsets(startOffset, endOffset) {
  if (!notesView) return null;
  var entries = buildTextNodeIndex(notesView);
  if (!entries.length) return null;
  var start = findTextPosition(entries, startOffset, false);
  var end = findTextPosition(entries, endOffset, true);
  if (!start || !end) return null;
  try {
    var range = document.createRange();
    range.setStart(start.node, Math.max(0, start.offset));
    range.setEnd(end.node, Math.max(0, end.offset));
    if (range.collapsed) return null;
    return range;
  } catch (e) {
    return null;
  }
}

function collectHighlightRangesFromDom() {
  if (!notesView) return [];
  var index = buildTextNodeIndex(notesView);
  var map = new Map();
  index.forEach(function (entry) { map.set(entry.node, entry); });
  var ranges = [];
  notesView.querySelectorAll('mark[data-hl]').forEach(function (mark) {
    var color = String(mark.getAttribute('data-hl') || '').trim().toLowerCase();
    if (['yellow', 'green', 'blue', 'pink'].indexOf(color) < 0) return;
    var walker = document.createTreeWalker(mark, NodeFilter.SHOW_TEXT, null, false);
    var node;
    var start = null;
    var end = null;
    while ((node = walker.nextNode())) {
      var entry = map.get(node);
      if (!entry) continue;
      if (start === null) start = entry.start;
      end = entry.end;
    }
    if (start !== null && end !== null && end > start) {
      ranges.push({ start: start, end: end, color: color });
    }
  });
  return ranges;
}

function collectCurrentHighlightPayload() {
  var baseKey = getHighlightBaseKey();
  if (!baseKey) return null;
  var ranges = collectHighlightRangesFromDom();
  if (!ranges.length) return null;
  return {
    base_key: baseKey,
    ranges: ranges,
    updated_at: Date.now() / 1000
  };
}

function persistHighlightPayloadLocally(payload) {
  if (payload && payload.ranges && payload.ranges.length) {
    writeStructuredHighlightCache(payload);
  } else {
    clearStructuredHighlightCache();
  }
}

function queueHighlightSync(payload) {
  var safePackId = String(selectedPackId || '');
  if (!safePackId) return;
  var cloned = cloneHighlightPayload(payload);
  pendingHighlightPayload = cloned;
  pendingHighlightPackId = safePackId;
  if (selectedPack && selectedPack.study_pack_id === safePackId) {
    selectedPack.notes_highlights = cloned;
  }
  persistHighlightPayloadLocally(cloned);
  if (highlightSyncTimer) { clearTimeout(highlightSyncTimer); }
  highlightSyncTimer = setTimeout(function () {
    highlightSyncTimer = null;
    flushHighlightSync();
  }, HIGHLIGHT_SYNC_DELAY_MS);
}

function flushHighlightSync() {
  if (highlightSyncInFlight || !pendingHighlightPackId || !token) return;
  highlightSyncInFlight = true;
  var packId = pendingHighlightPackId;
  var payload = cloneHighlightPayload(pendingHighlightPayload);
  pendingHighlightPackId = '';
  pendingHighlightPayload = undefined;

  apiCall('/api/study-packs/' + encodeURIComponent(packId), {
    method: 'PATCH',
    body: JSON.stringify({ notes_highlights: payload || null })
  }).then(function () {
    if (selectedPack && selectedPack.study_pack_id === packId) {
      selectedPack.notes_highlights = payload;
    }
    setHighlightStatus(payload && payload.ranges && payload.ranges.length
      ? 'Highlights save to this study pack automatically.'
      : 'Highlights cleared for this study pack.');
  }).catch(function (e) {
    console.warn('Could not sync note highlights:', e && e.message ? e.message : e);
    pendingHighlightPackId = packId;
    pendingHighlightPayload = payload;
    setHighlightStatus('Highlights are saved locally and will retry syncing.');
  }).finally(function () {
    highlightSyncInFlight = false;
    if (pendingHighlightPackId && !highlightSyncTimer) {
      highlightSyncTimer = setTimeout(function () {
        highlightSyncTimer = null;
        flushHighlightSync();
      }, HIGHLIGHT_SYNC_DELAY_MS * 2);
    }
  });
}

function applyHighlightPayloadToNotes(payload) {
  renderNotesForSelectedPackBase();
  var normalized = normalizeClientHighlightPayload(payload);
  if (!normalized) return null;
  normalized.ranges.slice().sort(function (left, right) {
    if (left.start !== right.start) return left.start - right.start;
    return left.end - right.end;
  }).forEach(function (rangeData) {
    var range = createRangeFromOffsets(rangeData.start, rangeData.end);
    if (!range) return;
    removeHighlightsInRange(range);
    applyColorToRange(range, rangeData.color);
  });
  mergeAdjacentHighlightMarks(notesView);
  return collectCurrentHighlightPayload();
}

function applyHighlightSnapshot(payload, shouldPersist) {
  var appliedPayload = applyHighlightPayloadToNotes(payload);
  if (shouldPersist !== false) {
    queueHighlightSync(appliedPayload);
  }
  return appliedPayload;
}

function commitHighlightMutation(mutator, successMessage) {
  if (!notesView || !selectedPackId || typeof mutator !== 'function') return;
  var before = collectCurrentHighlightPayload();
  mutator();
  mergeAdjacentHighlightMarks(notesView);
  var after = collectCurrentHighlightPayload();
  if (payloadFingerprint(before) === payloadFingerprint(after)) return;
  pushUndoSnapshot(before);
  hlRedoStack = [];
  updateHighlightHistoryButtons();
  queueHighlightSync(after);
  if (successMessage) showToast(successMessage);
}

function unwrapHighlightMark(mark) {
  if (!mark || !mark.parentNode) return;
  var parent = mark.parentNode;
  while (mark.firstChild) {
    parent.insertBefore(mark.firstChild, mark);
  }
  parent.removeChild(mark);
  parent.normalize();
}
function removeHighlightsInRange(range) {
  if (!notesView || !range) return;
  var marks = notesView.querySelectorAll('mark[data-hl]');
  marks.forEach(function (mark) {
    try {
      if (range.intersectsNode(mark)) unwrapHighlightMark(mark);
    } catch (e) { }
  });
}
function wrapTextNodeSegment(node, startOffset, endOffset, color) {
  if (!node || startOffset >= endOffset) return;
  var target = node;
  if (startOffset > 0) target = target.splitText(startOffset);
  var selectedLen = endOffset - startOffset;
  if (selectedLen < target.nodeValue.length) {
    target.splitText(selectedLen);
  }
  var parentMark = target.parentElement && target.parentElement.closest('mark[data-hl]');
  if (parentMark) {
    parentMark.setAttribute('data-hl', color);
    return;
  }
  var mark = document.createElement('mark');
  mark.setAttribute('data-hl', color);
  target.parentNode.insertBefore(mark, target);
  mark.appendChild(target);
}
function mergeAdjacentHighlightMarks(root) {
  if (!root) return;
  var marks = root.querySelectorAll('mark[data-hl]');
  marks.forEach(function (mark) {
    if (!mark.parentNode) return;
    if (!mark.textContent) {
      mark.remove();
      return;
    }
    var next = mark.nextSibling;
    while (
      next &&
      next.nodeType === Node.ELEMENT_NODE &&
      next.tagName === 'MARK' &&
      next.getAttribute('data-hl') === mark.getAttribute('data-hl')
    ) {
      while (next.firstChild) {
        mark.appendChild(next.firstChild);
      }
      var toRemove = next;
      next = next.nextSibling;
      toRemove.remove();
    }
  });
}
function getTextNodesIntersectingRange(range) {
  if (!range || !notesView) return [];
  var walker = document.createTreeWalker(notesView, NodeFilter.SHOW_TEXT, {
    acceptNode: function (node) {
      if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      try {
        return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      } catch (e) {
        return NodeFilter.FILTER_REJECT;
      }
    }
  }, false);
  var nodes = [];
  var current;
  while ((current = walker.nextNode())) {
    nodes.push(current);
  }
  return nodes;
}
function applyColorToRange(range, color) {
  var textNodes = getTextNodesIntersectingRange(range);
  textNodes.forEach(function (node) {
    var start = 0;
    var end = node.nodeValue.length;
    if (node === range.startContainer) start = range.startOffset;
    if (node === range.endContainer) end = range.endOffset;
    start = Math.max(0, Math.min(start, node.nodeValue.length));
    end = Math.max(0, Math.min(end, node.nodeValue.length));
    if (start < end) {
      wrapTextNodeSegment(node, start, end, color);
    }
  });
  mergeAdjacentHighlightMarks(notesView);
}

function migrateLegacyHighlightsForPack() {
  var legacyPayload = readLegacyHighlightPayload();
  if (!legacyPayload || !legacyPayload.annotated_html) return null;
  setNotesHtml(legacyPayload.annotated_html);
  var migratedPayload = collectCurrentHighlightPayload();
  clearLegacyHighlightCache();
  renderNotesForSelectedPackBase();
  if (migratedPayload) {
    queueHighlightSync(migratedPayload);
  }
  return migratedPayload;
}

function reapplyHighlightsForPack() {
  if (!notesView || !selectedPackId) return;
  var payload = normalizeClientHighlightPayload(selectedPack && selectedPack.notes_highlights);
  if (!payload) {
    payload = readStructuredHighlightCache();
  }
  if (!payload) {
    payload = migrateLegacyHighlightsForPack();
  }
  var appliedPayload = applyHighlightPayloadToNotes(payload);
  if (!appliedPayload) {
    renderNotesForSelectedPackBase();
    clearStructuredHighlightCache();
    setHighlightStatus('Highlights save to this study pack automatically.');
  } else {
    persistHighlightPayloadLocally(appliedPayload);
    setHighlightStatus('Highlights save to this study pack automatically.');
  }
  resetHighlightHistory(appliedPayload);
}

function applyHighlightToSelection() {
  var sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount || !notesView) return;
  var range = sel.getRangeAt(0);
  if (!notesView.contains(range.commonAncestorContainer)) return;
  if (!range.toString().trim()) return;
  commitHighlightMutation(function () {
    removeHighlightsInRange(range);
    if (hlActiveColor !== 'eraser') {
      applyColorToRange(range, hlActiveColor);
    }
  });
  sel.removeAllRanges();
}

function undoHighlightChange() {
  if (!hlUndoStack.length || !notesView) return;
  var current = collectCurrentHighlightPayload();
  var previous = cloneHighlightPayload(hlUndoStack.pop());
  hlRedoStack.push(cloneHighlightPayload(current));
  if (hlRedoStack.length > HL_HISTORY_LIMIT) {
    hlRedoStack.splice(0, hlRedoStack.length - HL_HISTORY_LIMIT);
  }
  applyHighlightSnapshot(previous, true);
  updateHighlightHistoryButtons();
}
function redoHighlightChange() {
  if (!hlRedoStack.length || !notesView) return;
  var current = collectCurrentHighlightPayload();
  var next = cloneHighlightPayload(hlRedoStack.pop());
  pushUndoSnapshot(current);
  applyHighlightSnapshot(next, true);
  updateHighlightHistoryButtons();
}

// Toolbar color selection
if (hlToolbar) {
  hlToolbar.querySelectorAll('.hl-btn[data-hl-color]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      hlActiveColor = btn.getAttribute('data-hl-color') || 'yellow';
      hlToolbar.querySelectorAll('.hl-btn[data-hl-color]').forEach(function (b) { b.classList.remove('active'); });
      btn.classList.add('active');
    });
  });
}

// Clear all highlights
if (hlClearAllBtn) {
  hlClearAllBtn.addEventListener('click', function () {
    if (!notesView || !selectedPack) return;
    commitHighlightMutation(function () {
      renderNotesForSelectedPackBase();
    }, 'All highlights cleared.');
  });
}

// Click to remove individual highlight
if (notesView) {
  notesView.addEventListener('click', function (e) {
    if (hlActiveColor !== 'eraser') return;
    var mark = e.target.closest('mark[data-hl]');
    if (!mark) return;
    commitHighlightMutation(function () { unwrapHighlightMark(mark); });
  });
}

// Apply highlight on text selection (mouseup)
if (notesView) {
  notesView.addEventListener('mouseup', function () {
    setTimeout(function () { applyHighlightToSelection(); }, 10);
  });
}

function downloadBlob(filename, mime, textContent) {
  var blob = new Blob([textContent], { type: mime });
  var url = URL.createObjectURL(blob);
  var anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
function downloadOriginalNotesDocx() {
  if (!selectedPackId) {
    showToast('No notes to download.', 'error');
    return;
  }
  downloadStudyPackNotes(selectedPackId, 'docx').then(function () {
    showToast('Original notes Word export started.');
  }).catch(function (e) {
    showToast(e.message || 'Could not export Word file.', 'error');
  });
}
function downloadAnnotatedNotesPdf() {
  if (!notesView || !notesView.innerHTML.trim()) {
    showToast('No notes to download.', 'error');
    return;
  }
  var title = (selectedPack && selectedPack.title) ? selectedPack.title : 'Study Notes';
  var filename = title.replace(/[^a-zA-Z0-9 _-]/g, '').substring(0, 60).trim() || 'Study Notes';
  if (window.html2pdf) {
    var exportRoot = document.createElement('div');
    exportRoot.className = 'notes-export-root';
    var exportTitle = document.createElement('div');
    exportTitle.className = 'notes-export-title';
    exportTitle.textContent = title;
    var exportView = document.createElement('div');
    exportView.className = 'notes-view notes-export-view';
    exportView.innerHTML = notesView.innerHTML;
    exportRoot.appendChild(exportTitle);
    exportRoot.appendChild(exportView);
    document.body.appendChild(exportRoot);
    var options = {
      margin: [10, 10, 10, 10],
      filename: filename + ' - Annotated.pdf',
      image: { type: 'jpeg', quality: 0.98 },
      html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff' },
      jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' },
      pagebreak: { mode: ['css', 'legacy'] }
    };
    window.html2pdf().set(options).from(exportRoot).save().then(function () {
      document.body.removeChild(exportRoot);
      showToast('Annotated notes downloaded as PDF.');
    }).catch(function () {
      if (document.body.contains(exportRoot)) { document.body.removeChild(exportRoot); }
      showToast('Could not export annotated PDF.', 'error');
    });
    return;
  }
  showToast('Annotated PDF export is currently unavailable on this device.', 'error');
}
function isNotesFullscreenActive() {
  return document.fullscreenElement === notesPaneShell || document.webkitFullscreenElement === notesPaneShell;
}
function getHighlightDownloadMenuHost() {
  if (isNotesFullscreenActive() && notesPaneShell) {
    return notesPaneShell;
  }
  return document.body || document.documentElement;
}
function syncHighlightDownloadMenuHost() {
  if (!hlDownloadMenu) return null;
  var host = getHighlightDownloadMenuHost();
  if (host && hlDownloadMenu.parentNode !== host) {
    host.appendChild(hlDownloadMenu);
  }
  return host;
}
function resetHighlightDownloadMenuPosition() {
  if (!hlDownloadMenu) return;
  hlDownloadMenu.classList.remove('is-upward', 'is-align-left', 'is-floating');
  hlDownloadMenu.style.left = '';
  hlDownloadMenu.style.top = '';
}
function setHighlightDownloadMenuOpen(open) {
  var menu = ensureHighlightDownloadMenu();
  if (!menu) return;
  var shouldOpen = !!open;
  if (shouldOpen) {
    syncHighlightDownloadMenuHost();
  }
  if (!shouldOpen) {
    resetHighlightDownloadMenuPosition();
  }
  menu.classList.toggle('visible', shouldOpen);
  if (hlDownloadBtn) {
    hlDownloadBtn.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
  }
  if (shouldOpen) {
    window.requestAnimationFrame(positionHighlightDownloadMenu);
  }
}
function positionHighlightDownloadMenu() {
  if (!hlDownloadMenu || !hlDownloadMenu.classList.contains('visible')) return;
  syncHighlightDownloadMenuHost();
  resetHighlightDownloadMenuPosition();
  var viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
  var viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
  if (!hlDownloadBtn) return;
  hlDownloadMenu.classList.add('is-floating');
  var buttonRect = hlDownloadBtn.getBoundingClientRect();
  var menuWidth = hlDownloadMenu.offsetWidth || 280;
  var menuHeight = hlDownloadMenu.offsetHeight || 108;
  var left = buttonRect.right - menuWidth;
  var alignLeft = false;
  var upward = false;
  if (left < 16) {
    left = buttonRect.left;
    alignLeft = true;
  }
  if (left + menuWidth > viewportWidth - 16) {
    left = Math.max(16, viewportWidth - menuWidth - 16);
  }
  var top = buttonRect.bottom + 10;
  if (top + menuHeight > viewportHeight - 16) {
    top = buttonRect.top - menuHeight - 10;
    upward = true;
  }
  if (top < 16) {
    top = Math.max(16, Math.min(buttonRect.bottom + 10, viewportHeight - menuHeight - 16));
    upward = false;
  }
  hlDownloadMenu.classList.toggle('is-upward', upward);
  hlDownloadMenu.classList.toggle('is-align-left', alignLeft);
  hlDownloadMenu.style.left = Math.round(left) + 'px';
  hlDownloadMenu.style.top = Math.round(top) + 'px';
}
function ensureHighlightDownloadMenu() {
  if (hlDownloadMenu || !hlToolbar) return hlDownloadMenu;
  hlDownloadMenu = document.createElement('div');
  hlDownloadMenu.className = 'hl-download-menu';
  hlDownloadMenu.setAttribute('role', 'menu');
  var originalDocxBtn = document.createElement('button');
  originalDocxBtn.type = 'button';
  originalDocxBtn.className = 'hl-download-item';
  originalDocxBtn.setAttribute('role', 'menuitem');
  originalDocxBtn.textContent = 'Download Original Notes (.docx)';
  originalDocxBtn.addEventListener('click', function () {
    setHighlightDownloadMenuOpen(false);
    downloadOriginalNotesDocx();
  });
  var annotatedBtn = document.createElement('button');
  annotatedBtn.type = 'button';
  annotatedBtn.className = 'hl-download-item';
  annotatedBtn.setAttribute('role', 'menuitem');
  annotatedBtn.textContent = 'Download Annotated Notes (.pdf)';
  annotatedBtn.addEventListener('click', function () {
    setHighlightDownloadMenuOpen(false);
    downloadAnnotatedNotesPdf();
  });
  hlDownloadMenu.appendChild(originalDocxBtn);
  hlDownloadMenu.appendChild(annotatedBtn);
  syncHighlightDownloadMenuHost();
  document.addEventListener('click', function (e) {
    if (!hlDownloadBtn || !hlDownloadMenu) return;
    if (!hlDownloadMenu.contains(e.target) && !hlDownloadBtn.contains(e.target)) {
      setHighlightDownloadMenuOpen(false);
    }
  });
  return hlDownloadMenu;
}
if (hlDownloadBtn) {
  ensureHighlightDownloadMenu();
  hlDownloadBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    var menu = ensureHighlightDownloadMenu();
    if (!menu) return;
    setHighlightDownloadMenuOpen(!menu.classList.contains('visible'));
  });
}
window.addEventListener('resize', function () {
  if (hlDownloadMenu && hlDownloadMenu.classList.contains('visible')) {
    positionHighlightDownloadMenu();
  }
});
window.addEventListener('scroll', function () {
  if (hlDownloadMenu && hlDownloadMenu.classList.contains('visible')) {
    positionHighlightDownloadMenu();
  }
}, true);
document.addEventListener('fullscreenchange', function () {
  syncHighlightDownloadMenuHost();
  if (hlDownloadMenu && hlDownloadMenu.classList.contains('visible')) {
    positionHighlightDownloadMenu();
  } else {
    resetHighlightDownloadMenuPosition();
  }
});
document.addEventListener('webkitfullscreenchange', function () {
  syncHighlightDownloadMenuHost();
  if (hlDownloadMenu && hlDownloadMenu.classList.contains('visible')) {
    positionHighlightDownloadMenu();
  } else {
    resetHighlightDownloadMenuPosition();
  }
});
document.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' || !hlDownloadMenu || !hlDownloadMenu.classList.contains('visible')) return;
  setHighlightDownloadMenuOpen(false);
  if (hlDownloadBtn) { hlDownloadBtn.focus(); }
});
if (hlUndoBtn) {
  hlUndoBtn.addEventListener('click', function () { undoHighlightChange(); });
}
if (hlRedoBtn) {
  hlRedoBtn.addEventListener('click', function () { redoHighlightChange(); });
}
document.addEventListener('keydown', function (e) {
  if (!selectedPackId || !notesView) return;
  var active = document.activeElement;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return;
  var cmdOrCtrl = e.metaKey || e.ctrlKey;
  if (!cmdOrCtrl) return;
  var isZ = (e.key || '').toLowerCase() === 'z';
  if (!isZ) return;
  e.preventDefault();
  if (e.shiftKey) {
    redoHighlightChange();
  } else {
    undoHighlightChange();
  }
});
initFolderExamDatePicker();
updateHighlightHistoryButtons();
