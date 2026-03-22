(function (root) {
  'use strict';

  function toInteger(value, fallbackValue) {
    var fallback = Number.isFinite(fallbackValue) ? fallbackValue : 0;
    if (typeof value === 'boolean') return fallback;
    var parsed = parseInt(String(value == null ? '' : value).trim(), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function normalizeLevel(value) {
    var normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'mastered' || normalized === 'familiar' || normalized === 'new') {
      return normalized;
    }
    return '';
  }

  function normalizeDifficulty(value) {
    var normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'easy' || normalized === 'hard' || normalized === 'medium') {
      return normalized;
    }
    return 'medium';
  }

  function normalizeReviewAction(value) {
    var normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'retry' || normalized === 'hard' || normalized === 'good' || normalized === 'easy') {
      return normalized;
    }
    return '';
  }

  function defaultRandom() {
    return Math.random();
  }

  function shuffleWithRandom(items, randomFn) {
    var source = Array.isArray(items) ? items.slice() : [];
    var rand = typeof randomFn === 'function' ? randomFn : defaultRandom;
    for (var index = source.length - 1; index > 0; index -= 1) {
      var swapIndex = Math.floor(rand() * (index + 1));
      var temp = source[index];
      source[index] = source[swapIndex];
      source[swapIndex] = temp;
    }
    return source;
  }

  function hasCardInteraction(cardState) {
    var entry = cardState && typeof cardState === 'object' ? cardState : {};
    return (
      toInteger(entry.seen, 0) > 0 ||
      toInteger(entry.correct, 0) > 0 ||
      toInteger(entry.wrong, 0) > 0 ||
      toInteger(entry.flip_count, 0) > 0 ||
      toInteger(entry.write_count, 0) > 0 ||
      Boolean(String(entry.last_review_date || '').trim()) ||
      Boolean(normalizeReviewAction(entry.last_action))
    );
  }

  function deriveCardLevel(cardState) {
    var entry = cardState && typeof cardState === 'object' ? cardState : {};
    if (toInteger(entry.interval_days, 0) >= 14) return 'mastered';
    return hasCardInteraction(entry) ? 'familiar' : 'new';
  }

  function hasMasteryHistory(cardState) {
    var entry = cardState && typeof cardState === 'object' ? cardState : {};
    return normalizeLevel(entry.level) === 'mastered' ||
      Math.max(toInteger(entry.interval_days, 0), toInteger(entry.max_interval_days, 0)) >= 14;
  }

  function isRetryCard(cardState) {
    var entry = cardState && typeof cardState === 'object' ? cardState : {};
    return normalizeReviewAction(entry.last_action) === 'retry' ||
      toInteger(entry.wrong, 0) > toInteger(entry.correct, 0);
  }

  function isHardCard(cardState) {
    var entry = cardState && typeof cardState === 'object' ? cardState : {};
    return normalizeDifficulty(entry.difficulty) === 'hard' ||
      normalizeReviewAction(entry.last_action) === 'hard';
  }

  function isCardDue(cardState, isDueDate) {
    var entry = cardState && typeof cardState === 'object' ? cardState : {};
    if (!hasCardInteraction(entry)) return true;
    var nextReviewDate = String(entry.next_review_date || '').trim();
    if (!nextReviewDate) return true;
    return isDueDate(nextReviewDate);
  }

  function getCardStatusInfo(cardState, options) {
    var settings = options && typeof options === 'object' ? options : {};
    var isDueDate = typeof settings.isDueDate === 'function'
      ? settings.isDueDate
      : function (value) { return !!value; };
    var entry = cardState && typeof cardState === 'object' ? cardState : {};
    var engaged = hasCardInteraction(entry);
    var due = isCardDue(entry, isDueDate);
    var retry = engaged && isRetryCard(entry);
    var hard = engaged && !retry && isHardCard(entry);
    var remaster = engaged && hasMasteryHistory(entry) && (due || retry || hard);
    var viewedOnly = engaged &&
      toInteger(entry.flip_count, 0) > 0 &&
      toInteger(entry.write_count, 0) <= 0 &&
      toInteger(entry.seen, 0) <= 0 &&
      toInteger(entry.correct, 0) <= 0 &&
      toInteger(entry.wrong, 0) <= 0;
    var mastered = engaged && !remaster && !retry && !hard && deriveCardLevel(entry) === 'mastered' && !due;
    var key = 'new';
    var label = 'New';
    var bucket = 'new';

    if (!engaged) {
      key = 'new';
      label = 'New';
      bucket = 'new';
    } else if (remaster) {
      key = 'remaster';
      label = 'Remaster';
      bucket = 'remaster';
    } else if (retry) {
      key = 'retry';
      label = 'Retry';
      bucket = 'retry';
    } else if (hard) {
      key = 'hard';
      label = 'Hard';
      bucket = 'hard';
    } else if (viewedOnly) {
      key = 'viewed';
      label = 'Viewed';
      bucket = 'familiar';
    } else if (mastered) {
      key = 'mastered';
      label = 'Mastered';
      bucket = 'remaster';
    } else {
      key = 'familiar';
      label = 'Familiar';
      bucket = 'familiar';
    }

    return {
      bucket: bucket,
      due: due,
      engaged: engaged,
      hard: hard,
      key: key,
      label: label,
      remaster: remaster,
      retry: retry,
      viewedOnly: viewedOnly,
    };
  }

  function getCardBucketMemberships(cardState, options) {
    var status = getCardStatusInfo(cardState, options);
    return {
      familiar: status.engaged && status.key !== 'mastered' && !status.remaster && !status.retry && !status.hard,
      hard: status.hard,
      new: !status.engaged,
      random: true,
      remaster: status.remaster,
      retry: status.retry,
    };
  }

  function isActiveCard(cardState, options) {
    var status = getCardStatusInfo(cardState, options);
    return !status.engaged || status.due || status.retry || status.hard || status.remaster;
  }

  function fillQueueFromLane(entries, settings) {
    if (!Array.isArray(entries) || !entries.length) return [];
    var options = settings && typeof settings === 'object' ? settings : {};
    var algo = Array.isArray(options.sessionAlgo) && options.sessionAlgo.length
      ? options.sessionAlgo.slice()
      : ['random'];
    var randomFn = typeof options.randomFn === 'function' ? options.randomFn : defaultRandom;
    var pools = { new: [], familiar: [], retry: [], remaster: [], hard: [], random: [] };

    entries.forEach(function (entry) {
      var memberships = getCardBucketMemberships(entry.cardState, options);
      Object.keys(memberships).forEach(function (bucketName) {
        if (memberships[bucketName]) {
          pools[bucketName].push(entry);
        }
      });
    });

    Object.keys(pools).forEach(function (bucketName) {
      pools[bucketName] = shuffleWithRandom(pools[bucketName], randomFn);
    });

    var result = [];
    var used = {};
    while (result.length < entries.length) {
      var addedThisCycle = 0;
      algo.forEach(function (bucketName) {
        var poolName = Object.prototype.hasOwnProperty.call(pools, bucketName) ? bucketName : 'random';
        var pool = pools[poolName];
        for (var index = 0; index < pool.length; index += 1) {
          var candidate = pool[index];
          if (used[candidate.idx]) continue;
          result.push(candidate);
          used[candidate.idx] = true;
          addedThisCycle += 1;
          break;
        }
      });
      if (addedThisCycle === 0) break;
    }

    pools.random.forEach(function (entry) {
      if (used[entry.idx]) return;
      result.push(entry);
      used[entry.idx] = true;
    });

    return result;
  }

  function orderCardsByAlgo(cards, options) {
    if (!Array.isArray(cards) || !cards.length) return [];
    var settings = options && typeof options === 'object' ? options : {};
    var state = settings.cardState && typeof settings.cardState === 'object' ? settings.cardState : {};
    var algo = Array.isArray(settings.sessionAlgo) && settings.sessionAlgo.length
      ? settings.sessionAlgo.slice()
      : ['random'];
    var randomFn = typeof settings.randomFn === 'function' ? settings.randomFn : defaultRandom;
    var entries = cards.map(function (card, index) {
      return { card: card, cardState: state['fc_' + index] || null, idx: index };
    });

    if (algo.every(function (bucketName) { return bucketName === 'random'; })) {
      return shuffleWithRandom(entries, randomFn).map(function (entry) {
        return { card: entry.card, idx: entry.idx };
      });
    }

    var activeEntries = [];
    var deferredEntries = [];
    entries.forEach(function (entry) {
      if (isActiveCard(entry.cardState, settings)) activeEntries.push(entry);
      else deferredEntries.push(entry);
    });

    return fillQueueFromLane(activeEntries, settings)
      .concat(fillQueueFromLane(deferredEntries, settings))
      .map(function (entry) {
        return { card: entry.card, idx: entry.idx };
      });
  }

  function getFlashcardQueue(orderedFlashcards, selectedPack) {
    if (Array.isArray(orderedFlashcards) && orderedFlashcards.length) {
      return orderedFlashcards;
    }
    var base = selectedPack && Array.isArray(selectedPack.flashcards) ? selectedPack.flashcards : [];
    return base.map(function (card, index) {
      return { card: card, idx: index };
    });
  }

  function normalizeAnswer(value, settings) {
    var preferences = settings && typeof settings === 'object' ? settings : {};
    var normalized = String(value || '').trim();
    if (!preferences.caseSensitive) normalized = normalized.toLowerCase();
    if (preferences.ignoreBrackets) normalized = normalized.replace(/\([^)]*\)/g, '').replace(/\[[^\]]*\]/g, '');
    if (preferences.ignoreArticles) normalized = normalized.replace(/\b(a|an|the)\b/gi, '');
    if (preferences.ignoreDeterminers) normalized = normalized.replace(/[;,\/]/g, '');
    normalized = normalized.replace(/\s+/g, ' ').trim();
    return normalized;
  }

  function gradeAnswer(userAnswer, correctAnswer, settings) {
    var userNormalized = normalizeAnswer(userAnswer, settings);
    var correctNormalized = normalizeAnswer(correctAnswer, settings);
    return userNormalized === correctNormalized;
  }

  function getEnabledModes(sessionLessons) {
    var lessons = sessionLessons && typeof sessionLessons === 'object' ? sessionLessons : {};
    var modes = [];
    if (lessons.flashcards) modes.push('flashcards');
    if (lessons.test) modes.push('test');
    if (lessons.write) modes.push('write');
    if (lessons.match) modes.push('match');
    return modes;
  }

  function getAnswerDisplay(question) {
    var options = Array.isArray(question && question.options) ? question.options : [];
    var foundIndex = options.indexOf(question && question.answer);
    var answerIndex = foundIndex >= 0 ? foundIndex : 0;
    return (['A', 'B', 'C', 'D'][answerIndex] || 'A') + ': ' + (options[answerIndex] || '(empty)');
  }

  var exported = {
    deriveCardLevel: deriveCardLevel,
    getAnswerDisplay: getAnswerDisplay,
    getCardStatusInfo: getCardStatusInfo,
    getEnabledModes: getEnabledModes,
    getFlashcardQueue: getFlashcardQueue,
    gradeAnswer: gradeAnswer,
    hasCardInteraction: hasCardInteraction,
    normalizeAnswer: normalizeAnswer,
    orderCardsByAlgo: orderCardsByAlgo,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  root.LectureProcessorStudySessionUtils = Object.assign({}, root.LectureProcessorStudySessionUtils || {}, exported);
})(typeof window !== 'undefined' ? window : globalThis);
