(function (root) {
  'use strict';

  var DEFAULT_DAILY_GOAL = 20;
  var MIN_DAILY_GOAL = 1;
  var MAX_DAILY_GOAL = 500;
  var PROGRESS_SYNC_EVENT = 'lp-study-progress-sync';
  var PROGRESS_SYNC_STORAGE_KEY = 'lp_study_progress_sync';
  var PROGRESS_DEVICE_STORAGE_KEY = 'lp_study_progress_device_id';
  var CARD_COUNTER_FIELDS = ['seen', 'correct', 'wrong', 'flip_count', 'write_count'];

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

  function parseOptionalGoalValue(value) {
    if (value == null) return null;
    if (typeof value === 'string' && !String(value).trim()) return null;
    return parseGoalValue(value);
  }

  function clampGoalValue(value, fallbackValue) {
    var parsed = parseGoalValue(value);
    if (parsed !== null) return parsed;
    var fallback = parseGoalValue(fallbackValue);
    return fallback !== null ? fallback : DEFAULT_DAILY_GOAL;
  }

  function sameGoalValue(leftValue, rightValue) {
    return parseOptionalGoalValue(leftValue) === parseOptionalGoalValue(rightValue);
  }

  function formatGoalTarget(value, options) {
    var settings = options && typeof options === 'object' ? options : {};
    var emptyLabel = String(settings.emptyLabel || 'Not set');
    var unitLabel = String(settings.unitLabel || 'cards/day');
    var parsed = parseOptionalGoalValue(value);
    return parsed === null ? emptyLabel : parsed + ' ' + unitLabel;
  }

  function updatePackCollectionGoal(packs, packId, goalValue) {
    var safePackId = String(packId || '').trim();
    if (!safePackId) return Array.isArray(packs) ? packs.slice() : [];
    var normalizedGoal = parseOptionalGoalValue(goalValue);
    return (Array.isArray(packs) ? packs : []).map(function (pack) {
      if (String(pack && pack.study_pack_id || '').trim() !== safePackId) return pack;
      return Object.assign({}, pack, { daily_card_goal: normalizedGoal });
    });
  }

  function getDailyGoalStorageKey(uid) {
    return 'daily_goal_' + String(uid || 'anon');
  }

  function readDailyGoalCache(uid, fallbackValue) {
    try {
      if (!root.localStorage) return clampGoalValue(fallbackValue, DEFAULT_DAILY_GOAL);
      return clampGoalValue(root.localStorage.getItem(getDailyGoalStorageKey(uid)), fallbackValue);
    } catch (_error) {
      return clampGoalValue(fallbackValue, DEFAULT_DAILY_GOAL);
    }
  }

  function writeDailyGoalCache(uid, value) {
    var goal = clampGoalValue(value, DEFAULT_DAILY_GOAL);
    try {
      if (root.localStorage) {
        root.localStorage.setItem(getDailyGoalStorageKey(uid), String(goal));
      }
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

  function hasCardInteraction(entry) {
    var card = entry && typeof entry === 'object' ? entry : {};
    return (
      safeInteger(card.seen) > 0 ||
      safeInteger(card.correct) > 0 ||
      safeInteger(card.wrong) > 0 ||
      safeInteger(card.flip_count) > 0 ||
      safeInteger(card.write_count) > 0
    );
  }

  function countDueCardsInState(state, todayString) {
    var due = 0;
    Object.keys(state || {}).forEach(function (cardId) {
      if (String(cardId).indexOf('fc_') !== 0) return;
      var entry = state[cardId] || {};
      if (!hasCardInteraction(entry)) return;
      if (isDueDate(entry.next_review_date, todayString)) due += 1;
    });
    return due;
  }

  function countUnmasteredCardsInState(state, totalFlashcards) {
    var total = Math.max(0, safeInteger(totalFlashcards) || 0);
    var unmastered = 0;
    for (var index = 0; index < total; index += 1) {
      var entry = (state || {})['fc_' + index] || null;
      if (!entry || !hasCardInteraction(entry)) {
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

  function toBoundedCounter(value, maximum) {
    var parsed = safeInteger(value);
    return Math.max(0, Math.min(Number(maximum || 100000), parsed === null ? 0 : parsed));
  }

  function getOrCreateProgressDeviceId(storage, randomUUID) {
    var targetStorage = storage || null;
    if (!targetStorage) {
      try { targetStorage = root.localStorage; } catch (_error) { targetStorage = null; }
    }
    try {
      var existing = String(targetStorage && targetStorage.getItem(PROGRESS_DEVICE_STORAGE_KEY) || '').trim();
      if (/^[A-Za-z0-9_-]{6,80}$/.test(existing)) return existing;
    } catch (_error) { }
    var randomPart = '';
    try {
      if (typeof randomUUID === 'function') randomPart = randomUUID();
      else if (root.crypto && typeof root.crypto.randomUUID === 'function') randomPart = root.crypto.randomUUID();
    } catch (_error) { }
    randomPart = String(randomPart || (Date.now() + '-' + Math.random().toString(36).slice(2))).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    var deviceId = 'web_' + randomPart;
    try { if (targetStorage) targetStorage.setItem(PROGRESS_DEVICE_STORAGE_KEY, deviceId); } catch (_error) { }
    return deviceId;
  }

  function normalizeDeviceCounterMap(entry) {
    var source = entry && typeof entry === 'object' ? entry : {};
    var rawMap = source.device_counters && typeof source.device_counters === 'object' ? source.device_counters : {};
    var normalized = {};
    Object.keys(rawMap).forEach(function (deviceId) {
      var safeDeviceId = String(deviceId || '').trim();
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(safeDeviceId)) return;
      var rawCounters = rawMap[deviceId] && typeof rawMap[deviceId] === 'object' ? rawMap[deviceId] : {};
      normalized[safeDeviceId] = {};
      CARD_COUNTER_FIELDS.forEach(function (field) {
        normalized[safeDeviceId][field] = toBoundedCounter(rawCounters[field]);
      });
    });
    var sums = {};
    CARD_COUNTER_FIELDS.forEach(function (field) {
      sums[field] = Object.keys(normalized).reduce(function (total, deviceId) {
        return total + normalized[deviceId][field];
      }, 0);
    });
    var legacy = {};
    var hasLegacyRemainder = false;
    CARD_COUNTER_FIELDS.forEach(function (field) {
      legacy[field] = Math.max(0, toBoundedCounter(source[field]) - sums[field]);
      if (legacy[field]) hasLegacyRemainder = true;
    });
    if (hasLegacyRemainder) {
      var currentLegacy = normalized.legacy || {};
      normalized.legacy = {};
      CARD_COUNTER_FIELDS.forEach(function (field) {
        normalized.legacy[field] = toBoundedCounter(currentLegacy[field]) + legacy[field];
      });
    }
    return normalized;
  }

  function sumDeviceCounters(deviceCounters) {
    var totals = {};
    CARD_COUNTER_FIELDS.forEach(function (field) { totals[field] = 0; });
    Object.keys(deviceCounters || {}).forEach(function (deviceId) {
      CARD_COUNTER_FIELDS.forEach(function (field) {
        totals[field] += toBoundedCounter(deviceCounters[deviceId] && deviceCounters[deviceId][field]);
      });
    });
    return totals;
  }

  function mergeDeviceCounterMaps(leftEntry, rightEntry) {
    var left = normalizeDeviceCounterMap(leftEntry);
    var right = normalizeDeviceCounterMap(rightEntry);
    var merged = {};
    Object.keys(Object.assign({}, left, right)).forEach(function (deviceId) {
      merged[deviceId] = {};
      CARD_COUNTER_FIELDS.forEach(function (field) {
        merged[deviceId][field] = Math.max(
          toBoundedCounter(left[deviceId] && left[deviceId][field]),
          toBoundedCounter(right[deviceId] && right[deviceId][field])
        );
      });
    });
    return merged;
  }

  function incrementCardDeviceCounters(entry, deviceId, increments) {
    var updated = Object.assign({}, entry || {});
    var counters = normalizeDeviceCounterMap(updated);
    var safeDeviceId = String(deviceId || '').trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(safeDeviceId)) safeDeviceId = 'legacy';
    counters[safeDeviceId] = counters[safeDeviceId] || {};
    CARD_COUNTER_FIELDS.forEach(function (field) {
      counters[safeDeviceId][field] = toBoundedCounter(counters[safeDeviceId][field]) + toBoundedCounter(increments && increments[field]);
    });
    var totals = sumDeviceCounters(counters);
    updated.device_counters = counters;
    CARD_COUNTER_FIELDS.forEach(function (field) { updated[field] = totals[field]; });
    return updated;
  }

  function normalizeDailyProgressByDevice(streak) {
    var source = streak && typeof streak === 'object' ? streak : {};
    var raw = source.daily_progress_by_device && typeof source.daily_progress_by_device === 'object'
      ? source.daily_progress_by_device
      : {};
    var normalized = {};
    Object.keys(raw).forEach(function (date) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
      var devices = raw[date] && typeof raw[date] === 'object' ? raw[date] : {};
      normalized[date] = {};
      Object.keys(devices).forEach(function (deviceId) {
        if (!/^[A-Za-z0-9_-]{1,80}$/.test(deviceId)) return;
        normalized[date][deviceId] = toBoundedCounter(devices[deviceId]);
      });
    });
    var legacyDate = String(source.daily_progress_date || '');
    var aggregate = toBoundedCounter(source.daily_progress_count);
    if (legacyDate && aggregate) {
      normalized[legacyDate] = normalized[legacyDate] || {};
      var existingTotal = Object.keys(normalized[legacyDate]).reduce(function (total, deviceId) {
        return total + toBoundedCounter(normalized[legacyDate][deviceId]);
      }, 0);
      if (aggregate > existingTotal) normalized[legacyDate].legacy = toBoundedCounter(normalized[legacyDate].legacy) + aggregate - existingTotal;
    }
    return normalized;
  }

  function incrementDailyProgressForDevice(streak, date, deviceId) {
    var updated = Object.assign({}, streak || {});
    var byDevice = normalizeDailyProgressByDevice(updated);
    var safeDate = String(date || '');
    var safeDeviceId = /^[A-Za-z0-9_-]{1,80}$/.test(String(deviceId || '')) ? String(deviceId) : 'legacy';
    byDevice[safeDate] = byDevice[safeDate] || {};
    byDevice[safeDate][safeDeviceId] = toBoundedCounter(byDevice[safeDate][safeDeviceId]) + 1;
    updated.daily_progress_by_device = byDevice;
    updated.daily_progress_date = safeDate;
    updated.daily_progress_count = Object.keys(byDevice[safeDate]).reduce(function (total, key) {
      return total + toBoundedCounter(byDevice[safeDate][key]);
    }, 0);
    return updated;
  }

  function mergeStreakData(localStreak, remoteStreak) {
    var local = localStreak && typeof localStreak === 'object' ? localStreak : {};
    var remote = remoteStreak && typeof remoteStreak === 'object' ? remoteStreak : {};
    var left = normalizeDailyProgressByDevice(local);
    var right = normalizeDailyProgressByDevice(remote);
    var mergedByDevice = {};
    Object.keys(Object.assign({}, left, right)).forEach(function (date) {
      mergedByDevice[date] = {};
      Object.keys(Object.assign({}, left[date], right[date])).forEach(function (deviceId) {
        mergedByDevice[date][deviceId] = Math.max(
          toBoundedCounter(left[date] && left[date][deviceId]),
          toBoundedCounter(right[date] && right[date][deviceId])
        );
      });
    });
    var dailyDate = String(local.daily_progress_date || '') > String(remote.daily_progress_date || '')
      ? String(local.daily_progress_date || '')
      : String(remote.daily_progress_date || '');
    var count = Object.keys(mergedByDevice[dailyDate] || {}).reduce(function (total, deviceId) {
      return total + toBoundedCounter(mergedByDevice[dailyDate][deviceId]);
    }, 0);
    var localLastStudy = String(local.last_study_date || '');
    var remoteLastStudy = String(remote.last_study_date || '');
    var lastStudyDate = localLastStudy > remoteLastStudy ? localLastStudy : remoteLastStudy;
    var currentStreak = localLastStudy === remoteLastStudy
      ? Math.max(toBoundedCounter(local.current_streak, 36500), toBoundedCounter(remote.current_streak, 36500))
      : toBoundedCounter(lastStudyDate === localLastStudy ? local.current_streak : remote.current_streak, 36500);
    return {
      last_study_date: lastStudyDate,
      current_streak: currentStreak,
      daily_progress_date: dailyDate,
      daily_progress_count: count,
      daily_progress_by_device: mergedByDevice,
    };
  }

  function cardStateEntryRank(entry) {
    var source = entry && typeof entry === 'object' ? entry : {};
    return [
      String(source.last_review_date || ''),
      toBoundedCounter(source.seen),
      toBoundedCounter(source.correct),
      toBoundedCounter(source.wrong),
      toBoundedCounter(source.interval_days, 3650),
      String(source.next_review_date || ''),
    ];
  }

  function compareRanks(left, right) {
    for (var index = 0; index < left.length; index += 1) {
      if (left[index] === right[index]) continue;
      return left[index] > right[index] ? 1 : -1;
    }
    return 0;
  }

  function mergeCardStateEntry(localEntry, remoteEntry) {
    var local = localEntry && typeof localEntry === 'object' ? localEntry : null;
    var remote = remoteEntry && typeof remoteEntry === 'object' ? remoteEntry : null;
    if (!local) return remote ? Object.assign({}, remote) : null;
    if (!remote) return Object.assign({}, local);

    var localUpdatedAt = Math.max(0, Number(local.updated_at || 0));
    var remoteUpdatedAt = Math.max(0, Number(remote.updated_at || 0));
    var localLast = String(local.last_review_date || '');
    var remoteLast = String(remote.last_review_date || '');
    var scheduleSource;
    if (localUpdatedAt !== remoteUpdatedAt) {
      scheduleSource = localUpdatedAt > remoteUpdatedAt ? local : remote;
    } else if (localLast !== remoteLast) {
      scheduleSource = localLast > remoteLast ? local : remote;
    } else {
      scheduleSource = compareRanks(cardStateEntryRank(local), cardStateEntryRank(remote)) >= 0 ? local : remote;
    }

    var deviceCounters = mergeDeviceCounterMaps(local, remote);
    var deviceTotals = sumDeviceCounters(deviceCounters);
    var correct = deviceTotals.correct;
    var wrong = deviceTotals.wrong;
    var seen = Math.max(deviceTotals.seen, correct + wrong);
    var intervalDays = toBoundedCounter(scheduleSource.interval_days, 3650);
    var flipCount = deviceTotals.flip_count;
    var writeCount = deviceTotals.write_count;
    var difficulty = String(scheduleSource.difficulty || 'medium').trim().toLowerCase();
    if (['easy', 'medium', 'hard'].indexOf(difficulty) < 0) difficulty = 'medium';
    var lastAction = String(scheduleSource.last_action || '').trim().toLowerCase();
    if (['retry', 'hard', 'good', 'easy'].indexOf(lastAction) < 0) lastAction = '';

    return {
      seen: seen,
      correct: correct,
      wrong: wrong,
      level: intervalDays >= 14 ? 'mastered' : ((seen || flipCount || writeCount) ? 'familiar' : 'new'),
      interval_days: intervalDays,
      max_interval_days: Math.max(
        toBoundedCounter(local.max_interval_days, 3650),
        toBoundedCounter(remote.max_interval_days, 3650),
        intervalDays
      ),
      next_review_date: String(scheduleSource.next_review_date || local.next_review_date || remote.next_review_date || ''),
      difficulty: difficulty,
      last_review_date: localLast > remoteLast ? localLast : remoteLast,
      last_action: lastAction,
      flip_count: flipCount,
      write_count: writeCount,
      device_counters: deviceCounters,
      updated_at: Math.max(localUpdatedAt, remoteUpdatedAt),
    };
  }

  function mergeCardStateMaps(localState, remoteState) {
    var local = localState && typeof localState === 'object' ? localState : {};
    var remote = remoteState && typeof remoteState === 'object' ? remoteState : {};
    var merged = {};
    Object.keys(Object.assign({}, local, remote)).sort().forEach(function (cardId) {
      var entry = mergeCardStateEntry(local[cardId], remote[cardId]);
      if (entry) merged[cardId] = entry;
    });
    return merged;
  }

  function createRevisionedSyncController(options) {
    var settings = options && typeof options === 'object' ? options : {};
    var createSnapshot = typeof settings.createSnapshot === 'function'
      ? settings.createSnapshot
      : function () { return { payload: {}, markers: [] }; };
    var transport = typeof settings.transport === 'function'
      ? settings.transport
      : function () { return Promise.resolve(); };
    var onAcknowledge = typeof settings.onAcknowledge === 'function'
      ? settings.onAcknowledge
      : function () { };
    var onError = typeof settings.onError === 'function' ? settings.onError : function () { };
    var revisions = {};
    var nextRevision = 0;
    var inFlight = false;
    var queued = false;
    var queuedForceAll = false;
    var idleWaiters = [];

    function resolveIdleWaiters() {
      if (inFlight || queued) return;
      var waiters = idleWaiters.slice();
      idleWaiters = [];
      waiters.forEach(function (resolve) { resolve(); });
    }

    function ensureMarker(marker) {
      var key = String(marker || '').trim();
      if (!key) return '';
      if (!Object.prototype.hasOwnProperty.call(revisions, key)) revisions[key] = 0;
      return key;
    }

    function mark(marker) {
      var key = ensureMarker(marker);
      if (!key) return 0;
      nextRevision += 1;
      revisions[key] = nextRevision;
      if (inFlight) {
        queued = true;
        // A full snapshot is the safest retry when the selected pack changes mid-request.
        queuedForceAll = true;
      }
      return nextRevision;
    }

    function acknowledgeUnchanged(markerRevisions) {
      var acknowledged = [];
      Object.keys(markerRevisions).forEach(function (marker) {
        if (revisions[marker] !== markerRevisions[marker]) return;
        delete revisions[marker];
        acknowledged.push(marker);
      });
      if (acknowledged.length) onAcknowledge(acknowledged);
      return acknowledged;
    }

    function flush(forceAll) {
      if (inFlight) {
        queued = true;
        queuedForceAll = queuedForceAll || !!forceAll;
        return Promise.resolve(false);
      }

      var snapshot = createSnapshot(!!forceAll, Object.keys(revisions)) || {};
      var markers = Array.isArray(snapshot.markers) ? snapshot.markers.map(ensureMarker).filter(Boolean) : [];
      var markerRevisions = {};
      markers.forEach(function (marker) { markerRevisions[marker] = revisions[marker]; });
      inFlight = true;

      return Promise.resolve().then(function () {
        return transport(snapshot.payload || {});
      }).then(function () {
        acknowledgeUnchanged(markerRevisions);
        return true;
      }).finally(function () {
        inFlight = false;
        if (queued) {
          var retryForceAll = queuedForceAll;
          queued = false;
          queuedForceAll = false;
          flush(retryForceAll).catch(onError);
        } else {
          resolveIdleWaiters();
        }
      });
    }

    function whenIdle() {
      if (!inFlight && !queued) return Promise.resolve();
      return new Promise(function (resolve) { idleWaiters.push(resolve); });
    }

    function reset() {
      revisions = {};
      queued = false;
      queuedForceAll = false;
      resolveIdleWaiters();
    }

    return {
      ensureMarker: ensureMarker,
      flush: flush,
      isInFlight: function () { return inFlight; },
      mark: mark,
      reset: reset,
      whenIdle: whenIdle,
    };
  }

  function broadcastProgressEvent(payload) {
    var detail = Object.assign({ timestamp: Date.now() }, payload || {});
    try {
      if (root.localStorage) {
        root.localStorage.setItem(PROGRESS_SYNC_STORAGE_KEY, JSON.stringify(detail));
      }
    } catch (_error) {
      // Ignore storage failures.
    }
    try {
      if (typeof root.dispatchEvent === 'function' && typeof root.CustomEvent === 'function') {
        root.dispatchEvent(new root.CustomEvent(PROGRESS_SYNC_EVENT, { detail: detail }));
      }
    } catch (_error) {
      // Ignore custom event failures.
    }
    return detail;
  }

  function subscribeProgressEvent(handler) {
    if (typeof handler !== 'function' || typeof root.addEventListener !== 'function') {
      return function () { };
    }
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
    root.addEventListener(PROGRESS_SYNC_EVENT, handleCustomEvent);
    root.addEventListener('storage', handleStorageEvent);
    return function unsubscribe() {
      if (typeof root.removeEventListener !== 'function') return;
      root.removeEventListener(PROGRESS_SYNC_EVENT, handleCustomEvent);
      root.removeEventListener('storage', handleStorageEvent);
    };
  }

  var exported = {
    DEFAULT_DAILY_GOAL: DEFAULT_DAILY_GOAL,
    MIN_DAILY_GOAL: MIN_DAILY_GOAL,
    MAX_DAILY_GOAL: MAX_DAILY_GOAL,
    PROGRESS_SYNC_EVENT: PROGRESS_SYNC_EVENT,
    PROGRESS_SYNC_STORAGE_KEY: PROGRESS_SYNC_STORAGE_KEY,
    PROGRESS_DEVICE_STORAGE_KEY: PROGRESS_DEVICE_STORAGE_KEY,
    parseGoalValue: parseGoalValue,
    parseOptionalGoalValue: parseOptionalGoalValue,
    clampGoalValue: clampGoalValue,
    sameGoalValue: sameGoalValue,
    formatGoalTarget: formatGoalTarget,
    updatePackCollectionGoal: updatePackCollectionGoal,
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
    mergeCardStateEntry: mergeCardStateEntry,
    mergeCardStateMaps: mergeCardStateMaps,
    createRevisionedSyncController: createRevisionedSyncController,
    getOrCreateProgressDeviceId: getOrCreateProgressDeviceId,
    incrementCardDeviceCounters: incrementCardDeviceCounters,
    incrementDailyProgressForDevice: incrementDailyProgressForDevice,
    mergeStreakData: mergeStreakData,
    broadcastProgressEvent: broadcastProgressEvent,
    subscribeProgressEvent: subscribeProgressEvent,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  root.LectureProcessorStudyProgressUtils = Object.assign({}, root.LectureProcessorStudyProgressUtils || {}, exported);
})(typeof window !== 'undefined' ? window : globalThis);
