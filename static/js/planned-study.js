(function (root) {
  'use strict';
  var utils = root.LectureProcessorPlannedStudyUtils;
  var active = null;
  function clock(seconds) { return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }

  async function open(options) {
    if (active) await active.close();
    var result = await options.api('/api/study-plan/items/' + encodeURIComponent(options.sessionId) + '/run', {method:'POST',body:'{}'});
    if (options.isCurrentUser && !options.isCurrentUser()) return null;
    var session = result.session;
    if (result.pack && options.onPack) options.onPack(result.pack);
    var storageKey = 'planned_run_' + options.uid + '_' + result.run.activity_id;
    var local; try { local = JSON.parse(localStorage.getItem(storageKey) || 'null'); } catch (_) { local = null; }
    var run = utils.mergeCheckpoint(result.run, local);
    if (local && run === result.run && (local.pending_reviews || []).length && (local.mode_generation || 0) !== (run.mode_generation || 0)) {
      try { localStorage.setItem(storageKey + '_conflict',JSON.stringify(local)); } catch (_) { /* Keep the active server mode authoritative. */ }
      if (options.onConflict) options.onConflict('A newer session mode was opened elsewhere. Your unsynced earlier attempt is kept on this device; review those cards again to save them.');
    }
    run.pending_reviews = run.pending_reviews || [];
    run.retry_done = run.retry_done || [];
    run.run_status = 'paused';
    var disposed = false, finished = false, syncing = Promise.resolve(), lastTick = Date.now(), lastSync = Date.now();
    var message = 'Progress saved', finishing = false, slotStopped = run.slot_seconds >= run.duration_seconds;
    var host = options.host;
    host.hidden = false;
    host.innerHTML = '<section class="learn-session-tracker" aria-label="Planned study session"><div class="learn-session-toolbar"><div class="learn-session-clock"><strong data-clock>0:00</strong><span data-phase></span></div><div class="learn-session-timer-label"><span>Timer</span><strong data-timer-label></strong></div><button type="button" class="btn" data-pause>Pause</button><button type="button" class="btn" data-finish>Finish session</button></div><div class="learn-session-meta"><span data-targets></span><span data-save role="status" aria-live="polite"></span></div><p class="learn-session-explanation">Pauses when you leave this tab. Timer type stays fixed once started.</p><p class="learn-session-break" data-break hidden>Take a short break. Study controls will return when the next focus period starts.</p></section>';
    var $ = function (selector) { return host.querySelector(selector); };
    function persist() {
      run.checkpoint_revision += 1;
      try { localStorage.setItem(storageKey, JSON.stringify(run)); } catch (_) { message = 'Keep this tab open until progress is saved.'; }
    }
    function render() {
      if (disposed) return;
      var phase = utils.timerState(run);
      $('[data-clock]').textContent = clock(phase.phaseRemaining);
      $('[data-phase]').textContent = finished ? 'Session complete' : run.run_status !== 'active' ? 'Paused' : phase.onBreak ? 'Break' : 'Focus';
      $('[data-timer-label]').textContent = run.timer_mode === 'pomodoro' ? 'Pomodoro · 25 / 5' : 'Countdown';
      $('[data-pause]').textContent = run.run_status === 'active' ? 'Pause' : 'Continue';
      $('[data-pause]').disabled = finished;
      $('[data-finish]').disabled = finishing || finished;
      var count = Object.keys(run.answers || {}).length;
      $('[data-targets]').textContent = count + ' / ' + run.queue.filter(function (item) { return item.type !== 'notes'; }).length + ' target answers saved · ' + Math.floor(run.active_seconds / 60) + ' active min · ' + clock(phase.remaining) + ' in planned slot';
      $('[data-save]').textContent = message;
      $('[data-break]').hidden = !phase.onBreak;
      if (options.onAvailability) options.onAvailability(!finished && run.run_status === 'active' && !phase.onBreak);
    }
    function checkpoint() {
      persist();
      var payload = JSON.parse(JSON.stringify(run));
      message = 'Saving…'; render();
      var job = syncing.catch(function () {}).then(function () {
        if (disposed || (options.isCurrentUser && !options.isCurrentUser())) throw new Error('Your account changed. Open the session again.');
        return options.api('/api/study-plan/runs/' + encodeURIComponent(run.activity_id), {method:'PUT',body:JSON.stringify(payload)});
      }).then(function (response) {
        if (disposed || (options.isCurrentUser && !options.isCurrentUser())) return response;
        if (response.run.checkpoint_revision > run.checkpoint_revision) throw Object.assign(new Error('Another tab updated this session. Reopen it to continue with the latest saved progress.'),{status:409});
        (payload.pending_reviews || []).forEach(function (review) {
          if (!run.pending_reviews.some(function (pending) { return pending.key === review.key; })) return;
          run.pending_reviews = run.pending_reviews.filter(function (pending) { return pending.key !== review.key; });
        });
        if (options.onProgress) options.onProgress(response);
        try { localStorage.setItem(storageKey, JSON.stringify(run)); } catch (_) { /* Remote checkpoint is durable. */ }
        message = 'Progress saved'; render(); return response;
      }).catch(function (error) {
        if (error.status === 409) { run.run_status = 'paused'; message = error.message; }
        else message = 'Saved on this device · reconnect to sync';
        render(); throw error;
      });
      syncing = job; job.catch(function () {}); lastSync = Date.now(); return job;
    }
    function tick(includeHidden) {
      var now = Date.now(), elapsed = Math.floor((now - lastTick) / 1000);
      if (run.run_status !== 'active' || (document.hidden && !includeHidden) || finished) { lastTick = now; return; }
      if (!elapsed) return;
      lastTick += elapsed * 1000;
      var previous = run.slot_seconds;
      run.slot_seconds += elapsed;
      var focus = utils.focusSeconds(run.slot_seconds,run.timer_mode,run.duration_seconds) - utils.focusSeconds(previous,run.timer_mode,run.duration_seconds);
      run.active_seconds += focus;
      if (options.getMode() === 'notes') run.notes_seconds += focus;
      if (!slotStopped && run.slot_seconds >= run.duration_seconds) { slotStopped = true; run.run_status = 'paused'; message = 'Your planned slot is complete. Finish to save it, or Continue to keep studying.'; checkpoint(); }
      persist(); render();
      if (Date.now() - lastSync >= 15000) checkpoint();
    }
    async function changeMode(mode, timerMode) {
      tick(); run.run_status = 'paused';
      await checkpoint(); // Never switch away from locally unsynced answers.
      var response = await options.api('/api/study-plan/items/' + encodeURIComponent(options.sessionId) + '/run', {method:'POST',body:JSON.stringify({study_mode:mode,timer_mode:timerMode || run.timer_mode})});
      if (disposed || (options.isCurrentUser && !options.isCurrentUser())) throw new Error('Your account changed. Open the session again.');
      run = response.run; session = response.session;
      run.pending_reviews = []; run.retry_done = run.retry_done || [];
      run.run_status = 'active'; lastTick = Date.now(); persist(); render();
      return run;
    }
    function record(id, action) {
      var item = run.queue.find(function (candidate) { return candidate.id === id; });
      if (!item || item.type === 'notes') return false;
      if (finished || utils.timerState(run).onBreak) { message = finished ? 'This session is complete.' : 'Your break is still running.'; render(); return false; }
      if (run.run_status !== 'active') { run.run_status = 'active'; lastTick = Date.now(); }
      tick();
      var answered = run.answers[id];
      if (answered) {
        if (answered.correct || run.retry_done.indexOf(id) >= 0) return false;
        run.retry_done.push(id);
      } else run.answers[id] = {type:item.type,correct:action !== 'retry'};
      run.pending_reviews.push({id:id,action:action,key:id + (answered ? ':retry' : ':first')});
      checkpoint(); return true;
    }
    async function finish() {
      if (finishing || finished) return;
      if (!utils.canFinish(run)) { message = 'Finish the remaining planned targets, or study for the rest of your planned slot. Changing mode keeps those targets.'; render(); return; }
      finishing = true; tick(); run.run_status = 'paused';
      try {
        await checkpoint();
        if (await options.flush() === false) throw new Error('Reconnect to sync your card progress before finishing.');
        var response = await options.api('/api/study-plan/items/' + encodeURIComponent(session.id) + '/completion', {method:'POST',body:JSON.stringify({action:'complete',source:'tracked',revision:session.revision})});
        session = response.session; finished = true; localStorage.removeItem(storageKey); message = 'Session complete · your plan and progress are saved';
      } catch (error) { message = error.message; }
      finishing = false; render();
    }
    async function close() {
      if (disposed) return;
      tick(); run.run_status = 'paused';
      if (!finished) { try { await checkpoint(); await options.flush(); } catch (_) { /* Local checkpoint is retained. */ } }
      disposed = true; clearInterval(interval); document.removeEventListener('visibilitychange',visibility); window.removeEventListener('online',online); window.removeEventListener('pagehide',pagehide);
      host.replaceChildren(); host.hidden = true; if (active === api) active = null;
    }
    function invalidate() {
      run.run_status = 'paused'; persist(); disposed = true;
      clearInterval(interval); document.removeEventListener('visibilitychange',visibility); window.removeEventListener('online',online); window.removeEventListener('pagehide',pagehide);
      host.replaceChildren(); host.hidden = true; if (active === api) active = null;
    }
    function visibility() { if (document.hidden) { tick(true); run.run_status = 'paused'; checkpoint(); render(); } }
    function online() { if (!finished) checkpoint(); }
    function pagehide() { if (!finished) { tick(true); run.run_status = 'paused'; persist(); } }
    $('[data-pause]').addEventListener('click',function () { tick(); run.run_status = run.run_status === 'active' ? 'paused' : 'active'; lastTick = Date.now(); checkpoint(); render(); });
    $('[data-finish]').addEventListener('click',finish);
    var interval = setInterval(tick,1000);
    document.addEventListener('visibilitychange',visibility); window.addEventListener('online',online); window.addEventListener('pagehide',pagehide);
    var api = {invalidate:invalidate,pause:function () { tick(); run.run_status = 'paused'; checkpoint(); render(); },changeMode:changeMode,record:record,close:close,checkpoint:checkpoint,getRun:function () { return run; }};
    active = api;
    try { await changeMode(options.studyMode,options.timerMode); } catch (error) { await close(); throw error; }
    return api;
  }
  root.LectureProcessorPlannedStudy = {open:open,invalidate:function () { if (active) active.invalidate(); }};
})(window);
