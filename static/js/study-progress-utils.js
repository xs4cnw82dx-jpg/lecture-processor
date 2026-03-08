(function () {
  'use strict';

  var DEFAULT_DAILY_GOAL = 20;
  var MIN_DAILY_GOAL = 1;
  var MAX_DAILY_GOAL = 500;
  var PROGRESS_SYNC_EVENT = 'lp-study-progress-sync';
  var PROGRESS_SYNC_STORAGE_KEY = 'lp_study_progress_sync';

  function safeInteger(value) {
    if (typeof value === 'boolean') return null;
    var parsed = parseInt(String(value == null ? '' : value).trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function parseGoalValue(value) {
    if (value == null) return null;
    if (typeof value === 'string' && !String(value).trim()) return null;
    var parsed = safeInteger(value);
    if (!Number.isFinite(parsed) || parsed < MIN_DAILY_GOAL || parsed > MAX_DAILY_GOAL) return null;
    return parsed;
  }

  function clampGoalValue(value, fallbackValue) {
    var parsed = parseGoalValue(value);
    if (parsed !== null) return parsed;
    var fallback = parseGoalValue(fallbackValue);
    return fallback !== null ? fallback : DEFAULT_DAILY_GOAL;
  }

  function getDailyGoalStorageKey(uid) {
    return 'daily_goal_' + String(uid || 'anon');
  }

  function readDailyGoalCache(uid, fallbackValue) {
    try {
      return clampGoalValue(window.localStorage.getItem(getDailyGoalStorageKey(uid)), fallbackValue);
    } catch (_error) {
      return clampGoalValue(fallbackValue, DEFAULT_DAILY_GOAL);
    }
  }

  function writeDailyGoalCache(uid, value) {
    var goal = clampGoalValue(value, DEFAULT_DAILY_GOAL);
    try {
      window.localStorage.setItem(getDailyGoalStorageKey(uid), String(goal));
    } catch (_error) {
      // Ignore cache failures.
    }
    return goal;
  }

  function normalizeTimezoneName(value) {
    var timezoneName = String(value || '').trim();
    if (!timezoneName) return '';
    try {
      Intl.DateTimeFormat('en-CA', { timeZone: timezoneName }).format(new Date());
      return timezoneName;
    } catch (_error) {
      return '';
    }
  }

  function localDateString(timestampValue, timezoneName) {
    var resolvedTimezone = normalizeTimezoneName(timezoneName);
    var date = timestampValue ? new Date(timestampValue) : new Date();
    if (!resolvedTimezone) {
      var year = date.getFullYear();
      var month = String(date.getMonth() + 1).padStart(2, '0');
      var day = String(date.getDate()).padStart(2, '0');
      return year + '-' + month + '-' + day;
    }
    try {
      var parts = Intl.DateTimeFormat('en-CA', {
        timeZone: resolvedTimezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date);
      var yearPart = '';
      var monthPart = '';
      var dayPart = '';
      parts.forEach(function (part) {
        if (part.type === 'year') yearPart = part.value;
        if (part.type === 'month') monthPart = part.value;
        if (part.type === 'day') dayPart = part.value;
      });
      if (yearPart && monthPart && dayPart) {
        return yearPart + '-' + monthPart + '-' + dayPart;
      }
    } catch (_error) {
      // Fall through to local date formatting.
    }
    return localDateString(timestampValue, '');
  }

  function isDueDate(dateString, todayString) {
    var target = String(dateString || '').trim();
    if (!target) return true;
    return target <= String(todayString || localDateString()).trim();
  }

  function countDueCardsInState(state, todayString) {
    var due = 0;
    Object.keys(state || {}).forEach(function (cardId) {
      if (String(cardId).indexOf('fc_') !== 0) return;
      var entry = state[cardId] || {};
      if (!(safeInteger(entry.seen) > 0)) return;
      if (isDueDate(entry.next_review_date, todayString)) due += 1;
    });
    return due;
  }

  function countUnmasteredCardsInState(state, totalFlashcards) {
    var total = Math.max(0, safeInteger(totalFlashcards) || 0);
    var unmastered = 0;
    for (var index = 0; index < total; index += 1) {
      var entry = (state || {})['fc_' + index] || null;
      if (!entry || !(safeInteger(entry.seen) > 0)) {
        unmastered += 1;
        continue;
      }
      if (String(entry.level || '').trim().toLowerCase() !== 'mastered') {
        unmastered += 1;
      }
    }
    return unmastered;
  }

  function buildSummary(summary, fallbackGoal) {
    var source = summary && typeof summary === 'object' ? summary : {};
    return {
      current_streak: Math.max(0, Number(source.current_streak || 0)),
      due_today: Math.max(0, Number(source.due_today || 0)),
      today_progress: Math.max(0, Number(source.today_progress || 0)),
      daily_goal: clampGoalValue(source.daily_goal, fallbackGoal),
    };
  }

  function summarySnapshot(summary, fallbackGoal) {
    var normalized = buildSummary(summary, fallbackGoal);
    return {
      streak: normalized.current_streak,
      due: normalized.due_today,
      done: normalized.today_progress,
      goal: normalized.daily_goal,
    };
  }

  function goalCompletionPercent(summary, fallbackGoal) {
    var normalized = buildSummary(summary, fallbackGoal);
    var goal = Math.max(normalized.daily_goal, 1);
    return Math.max(0, Math.min(100, Math.round((Math.min(normalized.today_progress, goal) / goal) * 100)));
  }

  function goalProgressText(summary, fallbackGoal) {
    var normalized = buildSummary(summary, fallbackGoal);
    return Math.min(normalized.today_progress, normalized.daily_goal) + ' / ' + normalized.daily_goal;
  }

  function formatCount(value, singular, plural) {
    var count = Math.max(0, safeInteger(value) || 0);
    return count + ' ' + (count === 1 ? singular : (plural || singular + 's'));
  }

  function parseIsoDate(value) {
    var match = String(value || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    var year = parseInt(match[1], 10);
    var month = parseInt(match[2], 10);
    var day = parseInt(match[3], 10);
    var parsed = new Date(year, month - 1, day);
    if (
      parsed.getFullYear() !== year ||
      parsed.getMonth() + 1 !== month ||
      parsed.getDate() !== day
    ) {
      return null;
    }
    return parsed;
  }

  function daysUntil(dateString, todayString) {
    var targetDate = parseIsoDate(dateString);
    var todayDate = parseIsoDate(todayString || localDateString());
    if (!targetDate || !todayDate) return null;
    return Math.ceil((targetDate.getTime() - todayDate.getTime()) / 86400000);
  }

  function buildRecommendation(unmasteredCount, examDate, todayString) {
    var unmastered = Math.max(0, safeInteger(unmasteredCount) || 0);
    if (!String(examDate || '').trim()) {
      return {
        tone: 'neutral',
        text: 'Set an exam date to get a daily recommendation.',
        days_remaining: null,
        daily_target: null,
      };
    }
    var remaining = daysUntil(examDate, todayString);
    if (remaining === null) {
      return {
        tone: 'danger',
        text: 'Update the exam date to restore recommendations.',
        days_remaining: null,
        daily_target: null,
      };
    }
    if (remaining < 0) {
      return {
        tone: 'danger',
        text: 'Update the exam date to restore recommendations.',
        days_remaining: remaining,
        daily_target: null,
      };
    }
    if (remaining === 0) {
      return {
        tone: 'today',
        text: unmastered + ' cards should be reviewed today.',
        days_remaining: 0,
        daily_target: unmastered,
      };
    }
    var dailyTarget = Math.max(0, Math.ceil(unmastered / Math.max(remaining, 1)));
    var tone = remaining > 15 ? 'success' : (remaining >= 6 ? 'warn' : 'urgent');
    return {
      tone: tone,
      text: 'Recommended: ' + dailyTarget + ' unmastered cards/day.',
      days_remaining: remaining,
      daily_target: dailyTarget,
    };
  }

  function getPackFlashcardTotal(pack) {
    if (pack && Number.isFinite(Number(pack.flashcards_count))) {
      return Math.max(0, Number(pack.flashcards_count || 0));
    }
    return Array.isArray(pack && pack.flashcards) ? pack.flashcards.length : 0;
  }

  function buildPackStats(pack, state, todayString) {
    var total = getPackFlashcardTotal(pack);
    return {
      total: total,
      due: countDueCardsInState(state, todayString),
      unmastered: countUnmasteredCardsInState(state, total),
    };
  }

  function broadcastProgressEvent(payload) {
    var detail = Object.assign({ timestamp: Date.now() }, payload || {});
    try {
      window.localStorage.setItem(PROGRESS_SYNC_STORAGE_KEY, JSON.stringify(detail));
    } catch (_error) {
      // Ignore storage failures.
    }
    try {
      window.dispatchEvent(new CustomEvent(PROGRESS_SYNC_EVENT, { detail: detail }));
    } catch (_error) {
      // Ignore custom event failures.
    }
    return detail;
  }

  function subscribeProgressEvent(handler) {
    if (typeof handler !== 'function') return function () { };
    var handleCustomEvent = function (event) {
      handler((event && event.detail) || {});
    };
    var handleStorageEvent = function (event) {
      if (!event || event.key !== PROGRESS_SYNC_STORAGE_KEY || !event.newValue) return;
      try {
        handler(JSON.parse(event.newValue) || {});
      } catch (_error) {
        // Ignore malformed payloads.
      }
    };
    window.addEventListener(PROGRESS_SYNC_EVENT, handleCustomEvent);
    window.addEventListener('storage', handleStorageEvent);
    return function unsubscribe() {
      window.removeEventListener(PROGRESS_SYNC_EVENT, handleCustomEvent);
      window.removeEventListener('storage', handleStorageEvent);
    };
  }

  window.LectureProcessorStudyProgressUtils = Object.assign({}, window.LectureProcessorStudyProgressUtils || {}, {
    DEFAULT_DAILY_GOAL: DEFAULT_DAILY_GOAL,
    MIN_DAILY_GOAL: MIN_DAILY_GOAL,
    MAX_DAILY_GOAL: MAX_DAILY_GOAL,
    PROGRESS_SYNC_EVENT: PROGRESS_SYNC_EVENT,
    PROGRESS_SYNC_STORAGE_KEY: PROGRESS_SYNC_STORAGE_KEY,
    parseGoalValue: parseGoalValue,
    clampGoalValue: clampGoalValue,
    getDailyGoalStorageKey: getDailyGoalStorageKey,
    readDailyGoalCache: readDailyGoalCache,
    writeDailyGoalCache: writeDailyGoalCache,
    normalizeTimezoneName: normalizeTimezoneName,
    localDateString: localDateString,
    isDueDate: isDueDate,
    countDueCardsInState: countDueCardsInState,
    countUnmasteredCardsInState: countUnmasteredCardsInState,
    buildSummary: buildSummary,
    summarySnapshot: summarySnapshot,
    goalCompletionPercent: goalCompletionPercent,
    goalProgressText: goalProgressText,
    formatCount: formatCount,
    daysUntil: daysUntil,
    buildRecommendation: buildRecommendation,
    buildPackStats: buildPackStats,
    broadcastProgressEvent: broadcastProgressEvent,
    subscribeProgressEvent: subscribeProgressEvent,
  });
})();
