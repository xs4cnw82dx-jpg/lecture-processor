(function (root) {
  'use strict';

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

  function orderCardsByAlgo(cards, options) {
    if (!Array.isArray(cards) || !cards.length) return [];
    var settings = options && typeof options === 'object' ? options : {};
    var state = settings.cardState && typeof settings.cardState === 'object' ? settings.cardState : {};
    var algo = Array.isArray(settings.sessionAlgo) ? settings.sessionAlgo : [];
    var isDueDate = typeof settings.isDueDate === 'function'
      ? settings.isDueDate
      : function (value) { return !!value; };
    var randomFn = typeof settings.randomFn === 'function' ? settings.randomFn : defaultRandom;
    var buckets = { new: [], familiar: [], retry: [], remaster: [], hard: [], random: [] };
    var deferred = [];

    cards.forEach(function (card, index) {
      var id = 'fc_' + index;
      var cardState = state[id];
      var entry = { card: card, idx: index };
      var due = !cardState || !cardState.seen || isDueDate(cardState.next_review_date);
      if (due) {
        if (!cardState || cardState.level === 'new') {
          buckets.new.push(entry);
        } else if (cardState.level === 'familiar') {
          buckets.familiar.push(entry);
        } else if (cardState.level === 'mastered') {
          buckets.remaster.push(entry);
        }
        var wrongCount = Number(cardState && cardState.wrong || 0);
        var correctCount = Number(cardState && cardState.correct || 0);
        if (cardState && (cardState.level === 'retry' || cardState.last_action === 'retry' || wrongCount > correctCount)) {
          buckets.retry.push(entry);
        }
        if (cardState && (cardState.difficulty === 'hard' || cardState.last_action === 'hard')) {
          buckets.hard.push(entry);
        }
      } else {
        deferred.push(entry);
      }
      buckets.random.push({ card: card, idx: index });
    });

    Object.keys(buckets).forEach(function (key) {
      buckets[key] = shuffleWithRandom(buckets[key], randomFn);
    });

    var result = [];
    var used = {};
    algo.forEach(function (bucketName) {
      var pool = buckets[bucketName] || buckets.random;
      for (var poolIndex = 0; poolIndex < pool.length; poolIndex += 1) {
        if (!used[pool[poolIndex].idx]) {
          result.push(pool[poolIndex]);
          used[pool[poolIndex].idx] = true;
          break;
        }
      }
    });

    cards.forEach(function (card, index) {
      var isDeferred = deferred.some(function (entry) { return entry.idx === index; });
      if (!used[index] && !isDeferred) {
        result.push({ card: card, idx: index });
      }
    });
    deferred.forEach(function (entry) {
      if (!used[entry.idx]) {
        result.push(entry);
      }
    });

    return result;
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
    getAnswerDisplay: getAnswerDisplay,
    getEnabledModes: getEnabledModes,
    getFlashcardQueue: getFlashcardQueue,
    gradeAnswer: gradeAnswer,
    normalizeAnswer: normalizeAnswer,
    orderCardsByAlgo: orderCardsByAlgo,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  root.LectureProcessorStudySessionUtils = Object.assign({}, root.LectureProcessorStudySessionUtils || {}, exported);
})(typeof window !== 'undefined' ? window : globalThis);
