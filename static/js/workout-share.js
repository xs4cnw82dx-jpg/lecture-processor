(function () {
  'use strict';

  var escapeHtml = window.LectureProcessorHtml.escapeHtml;
  var body = document.body;
  var token = body.dataset.workoutShareToken || '';
  var loading = document.getElementById('share-workout-loading');
  var card = document.getElementById('share-workout-card');
  var errorState = document.getElementById('share-workout-error');

  function formatDuration(seconds) {
    var safe = Math.max(0, Number(seconds || 0));
    var hours = Math.floor(safe / 3600);
    var minutes = Math.floor((safe % 3600) / 60);
    var remaining = Math.floor(safe % 60);
    return hours ? hours + 'h ' + minutes + 'm' : minutes + ':' + String(remaining).padStart(2, '0');
  }

  function renderRoutine(share) {
    document.getElementById('share-workout-kind').textContent = 'Shared routine';
    document.getElementById('share-workout-title').textContent = share.name || 'Workout routine';
    document.getElementById('share-workout-copy').textContent = share.focus || 'Plan targets and technique cues. Start weights remain private.';
    return (share.exercises || []).map(function (exercise) {
      return '<section class="share-workout-exercise"><h2>' + escapeHtml(exercise.name) + '</h2><p>' + escapeHtml(exercise.muscle_group || '') + '</p><span class="share-workout-target">' + Number(exercise.sets || 0) + ' sets · ' + Number(exercise.rep_min || 0) + '–' + Number(exercise.rep_max || 0) + ' reps · ' + escapeHtml(formatDuration(exercise.rest_seconds)) + ' rest</span>' + ((exercise.technique || exercise.cues) ? '<div class="share-workout-cues"><strong>' + escapeHtml(exercise.technique || 'Technique') + '</strong><br>' + escapeHtml(exercise.cues || '') + '</div>' : '') + '</section>';
    }).join('');
  }

  function renderWorkout(share) {
    document.getElementById('share-workout-kind').textContent = 'Completed workout';
    document.getElementById('share-workout-title').textContent = share.name || 'Workout';
    document.getElementById('share-workout-copy').textContent = share.date ? new Date(share.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }) : '';
    var metrics = document.getElementById('share-workout-metrics');
    metrics.hidden = false;
    metrics.innerHTML = '<div class="share-workout-metric"><span>Duration</span><strong>' + escapeHtml(formatDuration(share.duration_seconds)) + '</strong></div><div class="share-workout-metric"><span>Volume</span><strong>' + Number(share.volume_kg || 0).toLocaleString(undefined, { maximumFractionDigits: 0 }) + ' kg</strong></div><div class="share-workout-metric"><span>Sets</span><strong>' + Number(share.completed_sets || 0) + '</strong></div>';
    return (share.exercises || []).map(function (exercise) {
      var rows = (exercise.sets || []).map(function (setItem, index) { return '<tr><td>' + (index + 1) + '</td><td>' + escapeHtml(setItem.type || 'normal') + '</td><td>' + Number(setItem.kg || 0) + '</td><td>' + Number(setItem.reps || 0) + '</td><td>' + Number(setItem.rpe || 0) + '</td></tr>'; }).join('');
      return '<section class="share-workout-exercise"><h2>' + escapeHtml(exercise.name) + '</h2><p>' + escapeHtml(exercise.muscle_group || '') + '</p><table class="share-workout-sets"><thead><tr><th>Set</th><th>Type</th><th>kg</th><th>Reps</th><th>RPE</th></tr></thead><tbody>' + rows + '</tbody></table></section>';
    }).join('');
  }

  fetch('/api/workout-shares/' + encodeURIComponent(token), { headers: { Accept: 'application/json' } }).then(function (response) {
    if (!response.ok) throw new Error('Unavailable');
    return response.json();
  }).then(function (payload) {
    var share = payload.share || {};
    document.getElementById('share-workout-exercises').innerHTML = share.kind === 'routine' ? renderRoutine(share) : renderWorkout(share);
    loading.hidden = true;
    card.hidden = false;
  }).catch(function () {
    loading.hidden = true;
    errorState.hidden = false;
  });
})();
