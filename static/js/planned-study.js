(function (root) {
  'use strict';
  var utils = root.LectureProcessorPlannedStudyUtils;
  var controller = null;
  function escape(value) { return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function clock(seconds) { return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }

  async function open(options) {
    if (controller) return;
    var preferredMode = 'countdown';
    try { preferredMode = localStorage.getItem('planned_timer_' + options.uid) || preferredMode; } catch (_error) { /* Preference is optional. */ }
    var result = await options.api('/api/study-plan/items/' + encodeURIComponent(options.sessionId) + '/run', { method: 'POST', body: JSON.stringify({ timer_mode: preferredMode }) });
    if (options.isCurrentUser && !options.isCurrentUser()) return;
    if (result.pack) { options.pack = result.pack; if (options.onPack) options.onPack(result.pack); }
    var session = result.session;
    var storageKey = 'planned_run_' + options.uid + '_' + result.run.activity_id;
    var local;
    try { local = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch (_error) { local = null; }
    var run = utils.mergeCheckpoint(result.run, local);
    run.run_status = 'paused';
    run.retry_done = run.retry_done || [];
    run.pending_reviews = run.pending_reviews || [];
    var disposed = false;
    var revealed = false, summary = false, finished = false, saving = false, answerLocked = false;
    var lastTick = Date.now(), autoStopped = run.slot_seconds >= run.duration_seconds;
    var syncChain = Promise.resolve(), saveMessage = run.content_updated ? 'Pack updated · your completed work is kept' : 'Progress saved', lastSync = Date.now();
    var previousFocus = document.activeElement;
    var overlay = document.createElement('div');
    overlay.className = 'planned-study-overlay';
    overlay.innerHTML = '<section class="planned-study" role="dialog" aria-modal="true" aria-labelledby="planned-study-title"><header class="planned-study-header"><div><p class="planned-study-kicker">YOUR STUDY SESSION</p><h1 id="planned-study-title">' + escape(session.title) + '</h1><p>' + escape(options.pack.title) + ' · ' + Math.round(run.duration_seconds / 60) + ' minute slot</p></div><button type="button" class="btn" data-leave>Save &amp; leave</button></header><div class="planned-study-toolbar"><div class="planned-study-timer"><strong data-clock>0:00</strong><span data-phase>Ready to focus</span></div><label>Timer <select data-timer aria-label="Study timer"><option value="countdown">Countdown</option><option value="pomodoro">Pomodoro · 25 / 5</option></select></label><button type="button" class="btn primary" data-pause>Start session</button><button type="button" class="btn" data-summary>Session progress</button></div><p class="planned-study-timer-note">Your timer pauses when you leave this tab. Pomodoro breaks fit inside your study slot.</p><div class="planned-study-progress"><progress max="100" value="0" data-progress aria-label="Completed study targets"></progress><span data-progress-label></span></div><div class="planned-study-work" data-work></div><footer><span data-save role="status" aria-live="polite">Progress saved</span><a href="/plan">Study Plan</a></footer></section>';
    document.body.appendChild(overlay);
    document.body.classList.add('planned-study-open');
    var $ = function (selector) { return overlay.querySelector(selector); };
    $('[data-timer]').value = run.timer_mode;
    function persist() {
      run.checkpoint_revision += 1;
      try { localStorage.setItem(storageKey, JSON.stringify(run)); } catch (_error) { saveMessage = 'Keep this tab open until your progress is saved.'; }
    }
    function checkpoint() {
      persist();
      var payload = JSON.parse(JSON.stringify(run));
      saveMessage = 'Saving progress…';
      renderTimer();
      var job = syncChain.catch(function () {}).then(function () {
        return options.api('/api/study-plan/runs/' + encodeURIComponent(run.activity_id), { method: 'PUT', body: JSON.stringify(payload) });
      }).then(function (response) {
        if (disposed || (options.isCurrentUser && !options.isCurrentUser())) return response;
        if (response.run.checkpoint_revision > run.checkpoint_revision) {
          run = response.run; run.run_status = 'paused'; run.pending_reviews = []; summary = true; renderWork();
        }
        var acknowledged = payload.pending_reviews || [];
        acknowledged.forEach(function (review) {
          var pending = run.pending_reviews.find(function (item) { return item.key === review.key; });
          if (!pending) return;
          options.review(review.id, review.action);
          run.pending_reviews = run.pending_reviews.filter(function (item) { return item.key !== review.key; });
        });
        if (payload.notes_seconds >= 60 && options.notesStudied) options.notesStudied();
        if (acknowledged.length) persist();
        saveMessage = 'Progress saved';
        // Local work made while this request was in flight remains authoritative.
        if (response.run.checkpoint_revision === run.checkpoint_revision) {
          try { localStorage.setItem(storageKey, JSON.stringify(run)); } catch (_error) { /* Server checkpoint is safe. */ }
        }
        renderTimer();
        return response;
      }).catch(function (error) {
        if (disposed) throw error;
        if (error.status === 409) { run.run_status = 'paused'; summary = true; renderWork(); }
        saveMessage = error.status === 409 ? 'Session changed. Your local progress is safe; reopen Study Plan.' : 'Saved on this device · will retry when connected';
        renderTimer();
        throw error;
      });
      syncChain = job;
      job.catch(function () {});
      lastSync = Date.now();
      return job;
    }
    function current() { return utils.pendingItems(run)[0]; }
    function tick(includeHidden) {
      var now = Date.now();
      var elapsed = Math.floor((now - lastTick) / 1000);
      if (run.run_status !== 'active' || (document.hidden && includeHidden !== true) || finished) { lastTick = now; return; }
      if (elapsed < 1) return;
      lastTick += elapsed * 1000;
      var oldSlot = run.slot_seconds;
      run.slot_seconds += elapsed;
      var focus = utils.focusSeconds(run.slot_seconds, run.timer_mode, run.duration_seconds) - utils.focusSeconds(oldSlot, run.timer_mode, run.duration_seconds);
      run.active_seconds += focus;
      var previousItem = current();
      if (previousItem && previousItem.type === 'notes') run.notes_seconds += focus;
      persist();
      if (!autoStopped && run.slot_seconds >= run.duration_seconds) {
        autoStopped = true;
        run.run_status = 'paused';
        summary = true;
        checkpoint();
        renderWork();
      }
      var wasBreak = utils.timerState(Object.assign({}, run, { slot_seconds: oldSlot })).onBreak;
      if (wasBreak !== utils.timerState(run).onBreak) renderWork();
      if (previousItem && previousItem.type === 'notes' && (!current() || current().id !== previousItem.id)) {
        if (!current()) { run.run_status = 'paused'; summary = true; checkpoint(); }
        renderWork();
      }
      renderTimer();
      if (Date.now() - lastSync >= 15000) checkpoint();
    }
    function renderTimer() {
      var phase = utils.timerState(run);
      $('[data-clock]').textContent = clock(phase.phaseRemaining);
      $('[data-phase]').textContent = finished ? 'Session finished' : run.run_status !== 'active' ? 'Paused · ' + clock(phase.remaining) + ' left' : phase.onBreak ? 'Take a break · ' + clock(phase.remaining) + ' in slot' : 'Focus · ' + clock(phase.remaining) + ' in slot';
      $('[data-pause]').textContent = run.run_status === 'active' ? 'Pause' : run.slot_seconds ? 'Resume' : 'Start session';
      $('[data-pause]').disabled = finished;
      $('[data-timer]').disabled = run.slot_seconds > 0 || finished;
      $('[data-save]').textContent = saveMessage;
      var done = run.queue.length - run.queue.filter(function (item) { return item.type === 'notes' ? run.notes_seconds < item.seconds : !run.answers[item.id]; }).length;
      $('[data-progress]').value = done / run.queue.length * 100;
      $('[data-progress-label]').textContent = done + ' / ' + run.queue.length + ' targets · ' + Math.floor(run.active_seconds / 60) + ' active min';
      var notesButton = $('[data-notes-next]');
      if (notesButton && current()) notesButton.disabled = run.notes_seconds < current().seconds;
    }
    function renderWork() {
      var work = $('[data-work]');
      var item = current();
      if (summary || !item || finished) {
        var answers = Object.values(run.answers).concat(run.retired_answers || []);
        var correct = answers.filter(function (answer) { return answer.correct; }).length;
        work.innerHTML = '<div class="planned-study-summary"><p class="planned-study-kicker">' + (finished ? 'SESSION SAVED' : 'YOUR PROGRESS') + '</p><h2>' + (finished ? 'Good work. You’re done for now.' : utils.canFinish(run) ? 'Ready to finish your session?' : 'A little progress still counts.') + '</h2><div class="planned-study-stats"><div><strong>' + answers.length + '</strong><span>items reviewed</span></div><div><strong>' + Math.floor(run.active_seconds / 60) + '</strong><span>active minutes</span></div><div><strong>' + (answers.length ? Math.round(correct / answers.length * 100) + '%' : '—') + '</strong><span>first-attempt accuracy</span></div></div><p>' + (finished ? 'Your answers and next review dates are saved. Your plan now reflects the work you did.' : utils.pendingItems(run).length ? utils.pendingItems(run).length + ' targets or retries remain. Unfinished work stays available when you resume.' : 'You’ve reached today’s targets. Your next sessions will use your updated review dates.') + '</p><div class="planned-study-actions">' + (finished ? '<a class="btn primary" href="/plan">Back to Study Plan</a><button type="button" class="btn" data-undo>Reopen session</button>' : '<button type="button" class="btn primary" data-finish' + (utils.canFinish(run) && !saving ? '' : ' disabled') + '>Finish session</button>' + (item ? '<button type="button" class="btn" data-continue>Keep studying</button>' : '') + '<button type="button" class="btn" data-save-leave>Save &amp; leave</button>') + '</div></div>';
        if ($('[data-finish]')) $('[data-finish]').addEventListener('click', finish);
        if ($('[data-continue]')) $('[data-continue]').addEventListener('click', function () { summary = false; renderWork(); });
        if ($('[data-save-leave]')) $('[data-save-leave]').addEventListener('click', leave);
        if ($('[data-undo]')) $('[data-undo]').addEventListener('click', undo);
        return;
      }
      if (utils.timerState(run).onBreak && run.run_status === 'active') {
        work.innerHTML = '<div class="planned-study-summary"><p class="planned-study-kicker">POMODORO BREAK</p><h2>Give your mind a moment.</h2><p>Stretch, get some water, or look away from the screen. Your next item is ready when the break ends.</p></div>';
        return;
      }
      var content = item.type === 'fc' ? (options.pack.flashcards || [])[item.index] : item.type === 'q' ? (options.pack.test_questions || [])[item.index] : null;
      var paused = run.run_status !== 'active';
      var html = '<p class="planned-study-kicker">' + escape(item.reason) + ' · ' + (item.type === 'fc' ? 'FLASHCARD' : item.type === 'q' ? 'PRACTICE QUESTION' : 'NOTES') + '</p>';
      if (item.type === 'fc') {
        html += '<h2>' + escape(content.front) + '</h2>' + (revealed ? '<div class="planned-study-answer">' + escape(content.back) + '</div><p>How well did you remember it?</p><div class="planned-study-actions">' + ['retry', 'hard', 'good', 'easy'].map(function (action) { return '<button type="button" class="btn' + (action === 'good' ? ' primary' : '') + '" data-rate="' + action + '"' + (paused ? ' disabled' : '') + '>' + { retry: 'Again', hard: 'Hard', good: 'Got it', easy: 'Easy' }[action] + '</button>'; }).join('') + '</div>' : '<button type="button" class="btn primary" data-reveal' + (paused ? ' disabled' : '') + '>Reveal answer</button>');
      } else if (item.type === 'q') {
        html += '<h2>' + escape(content.question) + '</h2><div class="planned-study-options">' + (content.options || []).map(function (answer, index) { return '<button type="button" class="btn" data-answer="' + index + '"' + (paused ? ' disabled' : '') + '>' + escape(answer) + '</button>'; }).join('') + '</div><div data-feedback role="status"></div>';
      } else {
        html += '<div class="planned-study-notes">' + options.markdown(options.pack.notes_markdown || '') + '</div><button type="button" class="btn" data-notes-next' + (run.notes_seconds < item.seconds ? ' disabled' : '') + '>Continue</button><p>Read actively, then explain the main ideas from memory. ' + Math.ceil(item.seconds / 60) + ' minutes allocated.</p>';
      }
      if (paused) html += '<p class="planned-study-paused">Press ' + (run.slot_seconds ? 'Resume' : 'Start session') + ' when you’re ready.</p>';
      work.innerHTML = html;
      if (item.type === 'fc' && revealed && options.pack.pictures_enabled && window.StudyPictures) {
        window.StudyPictures.pictures(work.querySelector('.planned-study-answer'), content, options.pack.study_pack_id);
      }
      answerLocked = false;
      if ($('[data-reveal]')) $('[data-reveal]').addEventListener('click', function () { revealed = true; renderWork(); });
      overlay.querySelectorAll('[data-rate]').forEach(function (button) { button.addEventListener('click', function () { record(item, button.dataset.rate); }); });
      overlay.querySelectorAll('[data-answer]').forEach(function (button) { button.addEventListener('click', function () {
        if (answerLocked) return;
        answerLocked = true;
        var correct = content.options[Number(button.dataset.answer)] === content.answer;
        overlay.querySelectorAll('[data-answer]').forEach(function (option) { option.disabled = true; });
        $('[data-feedback]').innerHTML = '<div class="planned-study-answer"><strong>' + (correct ? 'Correct' : 'Answer: ' + escape(content.answer)) + '</strong><p>' + escape(content.explanation || '') + '</p><button type="button" class="btn primary" data-question-next>Continue</button></div>';
        // Save the answer immediately; leaving while reading feedback loses no work.
        record(item, correct ? 'good' : 'retry', true);
        $('[data-question-next]').addEventListener('click', function () { revealed = false; renderWork(); });
      }); });
      if ($('[data-notes-next]')) $('[data-notes-next]').addEventListener('click', function () { checkpoint(); renderWork(); });
    }
    function record(item, action, keepFeedback) {
      if (run.run_status !== 'active') return;
      tick();
      if (item.retry) {
        if (run.retry_done.indexOf(item.id) >= 0) return;
        run.retry_done.push(item.id);
      } else {
        if (run.answers[item.id]) return;
        run.answers[item.id] = { type: item.type, correct: action !== 'retry' };
      }
      run.pending_reviews.push({ id: item.id, action: action, key: item.id + (item.retry ? ':retry' : ':first') });
      if (!current()) { run.run_status = 'paused'; summary = !keepFeedback; }
      checkpoint();
      revealed = false;
      if (!keepFeedback) renderWork();
      renderTimer();
    }
    async function finish() {
      if (saving || !utils.canFinish(run)) return;
      saving = true;
      tick(); run.run_status = 'paused'; renderWork();
      try {
        await checkpoint();
        if (await options.flush() === false) throw new Error('Your card progress is saved on this device. Reconnect before finishing the session.');
        var response = await options.api('/api/study-plan/items/' + encodeURIComponent(session.id) + '/completion', { method: 'POST', body: JSON.stringify({ action: 'complete', source: 'tracked', revision: session.revision }) });
        session = response.session; finished = true;
        localStorage.removeItem(storageKey);
        saveMessage = 'Session completed · your study progress is saved';
      } catch (error) { saveMessage = error.message; }
      saving = false; renderWork(); renderTimer();
    }
    async function undo() {
      try {
        await options.api('/api/study-plan/items/' + encodeURIComponent(session.id) + '/completion', { method: 'POST', body: JSON.stringify({ action: 'reopen', revision: session.revision }) });
        window.location.href = '/plan';
      } catch (error) { saveMessage = error.message; renderTimer(); }
    }
    function cleanup() {
      disposed = true;
      clearInterval(interval); document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', online); window.removeEventListener('pagehide', pagehide);
      document.body.classList.remove('planned-study-open'); overlay.remove(); controller = null;
      if (previousFocus && previousFocus.focus) previousFocus.focus();
    }
    async function leave() {
      tick(); run.run_status = 'paused';
      if (!finished) { try { await checkpoint(); await options.flush(); } catch (_error) { /* Durable local checkpoint is retained. */ } }
      cleanup(); options.onLeave();
    }
    function visibility() { if (document.hidden && !finished) { tick(true); run.run_status = 'paused'; checkpoint(); renderWork(); renderTimer(); } }
    function online() { if (!finished) checkpoint(); }
    function pagehide() { if (!finished) { tick(); run.run_status = 'paused'; persist(); } }
    $('[data-leave]').addEventListener('click', leave);
    $('[data-summary]').addEventListener('click', function () { summary = !summary; renderWork(); });
    $('[data-pause]').addEventListener('click', function () { tick(); run.run_status = run.run_status === 'active' ? 'paused' : 'active'; lastTick = Date.now(); checkpoint(); renderWork(); renderTimer(); });
    $('[data-timer]').addEventListener('change', async function (event) {
      var selectedMode = event.target.value;
      $('[data-pause]').disabled = true; event.target.disabled = true;
      try {
        await syncChain.catch(function () {});
        var response = await options.api('/api/study-plan/items/' + encodeURIComponent(options.sessionId) + '/run', { method: 'POST', body: JSON.stringify({ timer_mode: selectedMode }) });
        run = response.run; session = response.session; run.retry_done = run.retry_done || []; run.pending_reviews = [];
        localStorage.setItem('planned_timer_' + options.uid, run.timer_mode);
        persist(); renderWork();
      } catch (error) { saveMessage = error.message; }
      $('[data-timer]').value = run.timer_mode; renderTimer();
    });
    overlay.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); tick(); run.run_status = 'paused'; summary = true; checkpoint(); renderWork(); renderTimer(); }
      if (event.key === 'Tab') {
        var nodes = Array.from(overlay.querySelectorAll('button:not(:disabled), a, select:not(:disabled)')).filter(function (node) { return node.offsetParent !== null; });
        if (!nodes.length) return;
        if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes[nodes.length - 1].focus(); }
        if (!event.shiftKey && document.activeElement === nodes[nodes.length - 1]) { event.preventDefault(); nodes[0].focus(); }
      }
    });
    document.addEventListener('visibilitychange', visibility); window.addEventListener('online', online); window.addEventListener('pagehide', pagehide);
    var interval = setInterval(tick, 250);
    controller = { leave: leave, invalidate: function () { tick(); run.run_status = 'paused'; persist(); cleanup(); } };
    renderWork(); renderTimer(); $('[data-pause]').focus();
    if (run.pending_reviews.length) checkpoint();
  }
  root.LectureProcessorPlannedStudy = { open: open, invalidate: function () { if (controller) controller.invalidate(); } };
})(window);
