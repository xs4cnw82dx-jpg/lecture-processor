(function (global) {
  'use strict';

  var REST_MAPPING = { '1-2 min': 90, '2-3 min': 150, '3-4 min': 210 };

  function number(value, fallback) {
    var parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : Number(fallback || 0);
  }

  function integer(value, fallback) {
    return Math.max(0, Math.round(number(value, fallback)));
  }

  function formatDuration(seconds) {
    var safe = integer(seconds, 0);
    var hours = Math.floor(safe / 3600);
    var minutes = Math.floor((safe % 3600) / 60);
    var remaining = safe % 60;
    if (hours > 0) {
      return String(hours).padStart(2, '0') + ':' + String(minutes).padStart(2, '0') + ':' + String(remaining).padStart(2, '0');
    }
    return String(minutes).padStart(2, '0') + ':' + String(remaining).padStart(2, '0');
  }

  function formatWeight(value) {
    var safe = number(value, 0);
    return safe.toLocaleString(undefined, { maximumFractionDigits: safe % 1 ? 1 : 0 });
  }

  function restSeconds(range, fallback) {
    return Object.prototype.hasOwnProperty.call(REST_MAPPING, String(range || ''))
      ? REST_MAPPING[String(range || '')]
      : integer(fallback, 0);
  }

  function setVolume(exercise, setItem, bodyweightKg, includeWarmups) {
    var set = setItem || {};
    if (!set.completed || (!includeWarmups && set.type === 'warmup')) return 0;
    var reps = integer(set.reps, 0);
    var kg = Math.max(0, number(set.kg, 0));
    var bodyweight = Math.max(0, number(bodyweightKg, 0));
    var type = String((exercise || {}).tracking_type || 'weight_reps');
    if (type === 'duration') return 0;
    if (type === 'bodyweight') return bodyweight * reps;
    if (type === 'weighted_bodyweight' && exercise.bodyweight_contributes) return (bodyweight + kg) * reps;
    if (type === 'assisted_bodyweight') return Math.max(0, bodyweight - kg) * reps;
    return kg * Math.max(1, Math.min(2, integer(exercise.pair_multiplier, 1))) * reps;
  }

  function sessionMetrics(session, includeWarmups) {
    var volume = 0;
    var completed = 0;
    (session && session.exercises || []).forEach(function (exercise) {
      (exercise.sets || []).forEach(function (setItem) {
        if (setItem.completed) completed += 1;
        volume += setVolume(exercise, setItem, session.bodyweight_kg, includeWarmups);
      });
    });
    return { volume_kg: Math.round(volume * 100) / 100, completed_sets: completed };
  }

  function epley(kg, reps) {
    var safeKg = Math.max(0, number(kg, 0));
    var safeReps = integer(reps, 0);
    if (!safeReps) return 0;
    if (safeReps === 1) return safeKg;
    return safeKg * (1 + safeReps / 30);
  }

  function nextAvailableLoad(currentKg, loads) {
    var current = number(currentKg, 0);
    var sorted = (loads || []).map(Number).filter(Number.isFinite).sort(function (a, b) { return a - b; });
    for (var index = 0; index < sorted.length; index += 1) {
      if (sorted[index] > current + 0.001) return sorted[index];
    }
    return current;
  }

  function warmupSets(targetKg, loads, steps) {
    var target = Math.max(0, number(targetKg, 0));
    var sorted = (loads || []).map(Number).filter(Number.isFinite).sort(function (a, b) { return a - b; });
    return (steps || []).slice(0, 6).map(function (step) {
      var percent = Math.max(1, Math.min(100, integer(step.percent, 50)));
      var desired = target * percent / 100;
      var kg = 0;
      sorted.forEach(function (load) { if (load <= desired + 0.0001) kg = load; });
      return { type: 'warmup', percent: percent, reps: Math.max(1, integer(step.reps, 5)), kg: kg };
    });
  }

  function progression(exercise, phase) {
    var complete = (exercise.sets || []).filter(function (setItem) { return setItem.completed && setItem.type !== 'warmup'; });
    if (!complete.length) return { next_action: 'Nog invullen', flag: '', suggested_next_kg: null };
    var targetSets = Math.max(1, integer(exercise.target_sets, complete.length));
    var minimum = Math.min.apply(Math, complete.map(function (item) { return integer(item.reps, 0); }));
    var last = complete[Math.min(complete.length, targetSets) - 1];
    var rpe = number(last.rpe, 0);
    var targetRpe = number(exercise.last_rpe, 9);
    var best = Math.max.apply(Math, complete.map(function (item) { return number(item.kg, 0); }));
    var action;
    if (phase === 'Semi-deload') action = 'Deload: techniek + herstel';
    else if (complete.length < targetSets) action = 'Sets missen';
    else if (minimum >= integer(exercise.rep_max, 0) && rpe >= targetRpe - 0.5 && rpe <= 10) action = 'Verhoog load volgende keer';
    else if (minimum >= integer(exercise.rep_max, 0) && rpe < targetRpe - 0.5) action = 'Verhoog effort/tempo of load';
    else if (minimum < integer(exercise.rep_min, 0)) action = 'Te zwaar: verlaag load of mik op min reps';
    else action = 'Zelfde load: voeg reps toe';
    var flag = action === 'Verhoog load volgende keer' ? 'Groen' : (minimum < integer(exercise.rep_min, 0) ? 'Load omlaag' : 'Progressie via reps');
    return { next_action: action, flag: flag, best_load: best };
  }

  var api = {
    REST_MAPPING: REST_MAPPING,
    epley: epley,
    formatDuration: formatDuration,
    formatWeight: formatWeight,
    nextAvailableLoad: nextAvailableLoad,
    number: number,
    progression: progression,
    restSeconds: restSeconds,
    sessionMetrics: sessionMetrics,
    setVolume: setVolume,
    warmupSets: warmupSets,
  };

  global.WorkoutUtils = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
