(function (root) {
  'use strict';
  var utils = root.LectureProcessorPlannedStudyUtils;
  var active = null;
  function clock(seconds) { return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }
  function translate(message, params) {
    if (root.LectureI18n) return root.LectureI18n.t(message, params);
    return message.replace(/\{(\w+)\}/g, function (match, name) { return params && name in params ? String(params[name]) : match; });
  }

  async function open(options) {
    if (active) await active.close();
    if (options.isCurrentUser && !options.isCurrentUser()) return null;
    var cache = root.LectureProcessorStudyCache;
    var cacheSession = cache ? cache.capture(options.uid) : null;
    function clearUnavailableSession(packId) {
      var cleared = !!(cache && cache.removePlannedSession && cache.removePlannedSession(options.uid, options.sessionId, packId));
      if (options.onUnavailable) cleared = options.onUnavailable(cleared) !== false && cleared;
      return cleared;
    }
    var result;
    try {
      result = await options.api('/api/study-plan/items/' + encodeURIComponent(options.sessionId) + '/run', {method:'POST',body:'{}'});
    } catch (error) {
      if (error.status === 404 && (!options.isCurrentUser || options.isCurrentUser())) {
        if (options.onAvailability) options.onAvailability(false);
        var cleared = clearUnavailableSession(String((options.pack || {}).study_pack_id || ''));
        error.message = translate(cleared ? 'Study session unavailable.' : 'Study session unavailable. Device storage could not be cleared.');
      }
      throw error;
    }
    if (options.isCurrentUser && !options.isCurrentUser()) return null;
    var session = result.session;
    if (result.pack && options.onPack) options.onPack(result.pack);
    var storageKey = 'planned_run_' + options.uid + '_' + result.run.activity_id;
    var packId = String((result.pack || options.pack || {}).study_pack_id || result.run.pack_id || '');
    var local = cache ? cache.get(options.uid, 'planned', result.run.activity_id) : null;
    var legacy = null, legacyRecords = new Map();
    function matchingContent(candidate) {
      return candidate && (!candidate.uid || candidate.uid === options.uid) && (!candidate.pack_id || candidate.pack_id === packId) &&
        candidate.activity_id === result.run.activity_id && typeof candidate.content_fingerprint === 'string' && !!candidate.content_fingerprint &&
        candidate.content_fingerprint === result.run.content_fingerprint && candidate.generation === result.run.generation;
    }
    function readLegacyRecord(key) {
      try {
        var raw = localStorage.getItem(key);
        var candidate = JSON.parse(raw || 'null');
        if (!matchingContent(candidate)) return null;
        legacyRecords.set(key, raw);
        if (options.onLegacyKey) options.onLegacyKey(key, raw);
        return candidate;
      } catch (_) { return null; }
    }
    function removeLegacyRecord(key) {
      if (!legacyRecords.has(key)) return true;
      try {
        if (localStorage.getItem(key) === legacyRecords.get(key)) localStorage.removeItem(key);
        legacyRecords.delete(key);
        return true;
      } catch (_) { return false; }
    }
    legacy = readLegacyRecord(storageKey);
    if (!local && matchingContent(legacy)) local = legacy;
    var run = utils.mergeCheckpoint(result.run, local);
    var localPending = local && (Number(local.checkpoint_revision || 0) > Number(result.run.checkpoint_revision || 0) || (local.pending_reviews || []).length);
    if (matchingContent(local) && run === result.run && localPending && (local.mode_generation || 0) !== (run.mode_generation || 0)) {
      if (!cache || !cache.set(cacheSession, 'conflict', run.activity_id, local, { packId: packId, pending: true })) {
        throw new Error('Your earlier unsynced attempt could not be saved on this device. Keep this tab open.');
      }
      if (options.onConflict) options.onConflict('A newer session mode was opened elsewhere. Your unsynced earlier attempt is kept on this device; review those cards again to save them.');
    }
    try {
      var legacyConflict = readLegacyRecord(storageKey + '_conflict');
      if (matchingContent(legacyConflict) && cache && !cache.get(options.uid, 'conflict', run.activity_id) &&
          cache.set(cacheSession, 'conflict', run.activity_id, legacyConflict, { packId: packId, pending: true })) {
        removeLegacyRecord(storageKey + '_conflict');
      }
    } catch (_) { /* Retain the legacy copy until a replacement is durable. */ }
    run.pending_reviews = run.pending_reviews || [];
    run.retry_done = run.retry_done || [];
    run.run_status = 'paused';
    var disposed = false, finished = false, unavailable = false, unavailableCleared = false;
    var syncing = Promise.resolve(), lastTick = Date.now(), lastSync = Date.now();
    var message = 'Progress saved', finishing = false, slotStopped = run.slot_seconds >= run.duration_seconds;
    var acknowledgedRevision = Number(result.run.checkpoint_revision || 0), deviceSaved = false;
    var host = options.host;
    host.hidden = false;
    host.innerHTML = '<section class="learn-session-tracker" aria-label="Planned study session"><div class="learn-session-toolbar"><div class="learn-session-clock"><strong data-clock>0:00</strong><span data-phase></span></div><div class="learn-session-timer-label"><span>Timer</span><strong data-timer-label></strong></div><button type="button" class="btn" data-pause>Pause</button><button type="button" class="btn" data-finish>Finish session</button></div><div class="learn-session-meta"><span data-targets></span><span data-save role="status" aria-live="polite"></span></div><p class="learn-session-explanation">Pauses when you leave this tab. Timer type stays fixed once started.</p><p class="learn-session-break" data-break hidden>Take a short break. Study controls will return when the next focus period starts.</p></section>';
    var $ = function (selector) { return host.querySelector(selector); };
    function isCurrent() { return !disposed && !unavailable && (!options.isCurrentUser || options.isCurrentUser()); }
    function storeRun() {
      if (!isCurrent() || finished) return false;
      deviceSaved = !!(cache && cache.set(cacheSession, 'planned', run.activity_id, run, {
        packId: packId, pending: run.checkpoint_revision > acknowledgedRevision || !!run.pending_reviews.length
      }));
      if (deviceSaved && matchingContent(legacy)) {
        if (removeLegacyRecord(storageKey)) legacy = null;
      }
      return deviceSaved;
    }
    function persist() {
      if (!isCurrent() || finished) return false;
      run.checkpoint_revision += 1;
      if (!storeRun()) message = 'Keep this tab open until progress is saved.';
      return deviceSaved;
    }
    function hasPending() {
      return !finished && !unavailable && (run.checkpoint_revision > acknowledgedRevision || !!run.pending_reviews.length);
    }
    async function flushPending() {
      if (unavailable) return unavailableCleared && (!options.isCurrentUser || options.isCurrentUser());
      if (!isCurrent()) return false;
      if (finished) return true;
      tick(true); run.run_status = 'paused'; render();
      try {
        await checkpoint();
        await syncing;
        return isCurrent() && !hasPending();
      } catch (_) { return unavailable && unavailableCleared && (!options.isCurrentUser || options.isCurrentUser()); }
    }
    function render() {
      if (disposed) return;
      var phase = utils.timerState(run);
      $('[data-clock]').textContent = clock(phase.phaseRemaining);
      $('[data-phase]').textContent = translate(unavailable ? 'Session unavailable' : finished ? 'Session complete' : run.run_status !== 'active' ? 'Paused' : phase.onBreak ? 'Break' : 'Focus');
      $('[data-timer-label]').textContent = translate(run.timer_mode === 'pomodoro' ? 'Pomodoro · 25 / 5' : 'Countdown');
      $('[data-pause]').textContent = translate(run.run_status === 'active' ? 'Pause' : 'Continue');
      $('[data-finish]').textContent = translate('Finish session');
      $('[data-pause]').disabled = finished || unavailable;
      $('[data-finish]').disabled = finishing || finished || unavailable;
      var count = Object.keys(run.answers || {}).length;
      $('[data-targets]').hidden = unavailable;
      $('[data-targets]').textContent = translate('{answered} / {total} target answers saved · {minutes} active min · {remaining} in planned slot', {
        answered: count, total: run.queue.filter(function (item) { return item.type !== 'notes'; }).length,
        minutes: Math.floor(run.active_seconds / 60), remaining: clock(phase.remaining)
      });
      $('[data-save]').textContent = translate(message);
      $('[data-break]').hidden = unavailable || !phase.onBreak;
      if (options.onAvailability) options.onAvailability(!finished && !unavailable && run.run_status === 'active' && !phase.onBreak);
    }
    function markUnavailable(error) {
      if (error.status !== 404 || !isCurrent() || finished) return false;
      unavailable = true; run.run_status = 'unavailable'; finishing = false;
      stopWriters();
      message = 'This planned session is no longer available. Open Study Plan to choose another session.';
      render();
      unavailableCleared = clearUnavailableSession(packId);
      if (!unavailableCleared) message = 'Study session unavailable. Device storage could not be cleared.';
      render();
      return true;
    }
    function checkpoint() {
      if (!isCurrent() || finished) return Promise.resolve(null);
      persist();
      var payload = JSON.parse(JSON.stringify(run));
      message = 'Saving…'; render();
      var job = syncing.catch(function () {}).then(function () {
        if (!isCurrent() || finished) throw new Error('Your account changed. Open the session again.');
        return options.api('/api/study-plan/runs/' + encodeURIComponent(run.activity_id), {method:'PUT',body:JSON.stringify(payload)});
      }).then(function (response) {
        if (!isCurrent() || finished) return response;
        if (response.run.checkpoint_revision > run.checkpoint_revision) throw Object.assign(new Error('Another tab updated this session. Reopen it to continue with the latest saved progress.'),{status:409});
        (payload.pending_reviews || []).forEach(function (review) {
          if (!run.pending_reviews.some(function (pending) { return pending.key === review.key; })) return;
          run.pending_reviews = run.pending_reviews.filter(function (pending) { return pending.key !== review.key; });
        });
        acknowledgedRevision = Math.max(acknowledgedRevision, payload.checkpoint_revision);
        if (options.onProgress) options.onProgress(response);
        storeRun();
        message = run.checkpoint_revision <= acknowledgedRevision ? 'Progress saved' : deviceSaved ? 'Saving…' : 'Keep this tab open until progress is saved.';
        render(); return response;
      }).catch(function (error) {
        if (!isCurrent() || finished) throw error;
        if (markUnavailable(error)) throw error;
        if (error.status === 409) { run.run_status = 'paused'; message = error.message; }
        else message = deviceSaved ? 'Saved on this device · reconnect to sync' : 'Keep this tab open until progress is saved.';
        render(); throw error;
      });
      syncing = job; job.catch(function () {}); lastSync = Date.now(); return job;
    }
    function tick(includeHidden) {
      var now = Date.now(), elapsed = Math.floor((now - lastTick) / 1000);
      if (!isCurrent() || run.run_status !== 'active' || (document.hidden && !includeHidden) || finished) { lastTick = now; return; }
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
      if (unavailable) throw new Error(translate('Study session unavailable.'));
      if (!isCurrent() || finished) throw new Error('This session is complete. Open a new session to continue.');
      tick(); run.run_status = 'paused';
      await checkpoint(); // Never switch away from locally unsynced answers.
      if (!isCurrent() || finished) throw new Error('Your account changed. Open the session again.');
      var response;
      try {
        response = await options.api('/api/study-plan/items/' + encodeURIComponent(options.sessionId) + '/run', {method:'POST',body:JSON.stringify({study_mode:mode,timer_mode:timerMode || run.timer_mode})});
      } catch (error) { markUnavailable(error); throw error; }
      if (!isCurrent()) throw new Error('Your account changed. Open the session again.');
      run = response.run; session = response.session;
      acknowledgedRevision = Number(run.checkpoint_revision || 0);
      run.pending_reviews = []; run.retry_done = run.retry_done || [];
      run.run_status = 'active'; lastTick = Date.now(); persist(); render();
      return run;
    }
    function record(id, action) {
      if (!isCurrent()) return false;
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
      if (!isCurrent() || finishing || finished) return;
      if (!utils.canFinish(run)) { message = 'Finish the remaining planned targets, or study for the rest of your planned slot. Changing mode keeps those targets.'; render(); return; }
      finishing = true; tick(); run.run_status = 'paused';
      try {
        await checkpoint();
        if (!isCurrent()) return;
        if (await options.flush() === false) throw new Error('Reconnect to sync your card progress before finishing.');
        if (!isCurrent()) return;
        var response = await options.api('/api/study-plan/items/' + encodeURIComponent(session.id) + '/completion', {method:'POST',body:JSON.stringify({action:'complete',source:'tracked',revision:session.revision})});
        if (!isCurrent()) return;
        session = response.session; finished = true;
        var cleared = !!cache;
        if (cache) {
          cleared = cache.remove(options.uid, 'planned', run.activity_id) && cleared;
          cleared = cache.remove(options.uid, 'conflict', run.activity_id) && cleared;
        }
        cleared = removeLegacyRecord(storageKey) && cleared;
        cleared = removeLegacyRecord(storageKey + '_conflict') && cleared;
        if (options.onFinish && options.onFinish() === false) cleared = false;
        message = cleared ? 'Session complete · your plan and progress are saved' : 'Session complete · your plan and progress are saved. Device storage could not be cleared.';
      } catch (error) {
        if (!unavailable && isCurrent() && !markUnavailable(error)) message = error.message;
      }
      finishing = false; render();
    }
    async function close() {
      if (disposed) return;
      if (!unavailable) {
        tick(); run.run_status = 'paused';
        if (!finished) { try { await checkpoint(); if (isCurrent()) await options.flush(); } catch (_) { /* Local checkpoint is retained. */ } }
      }
      invalidate();
    }
    function stopWriters() {
      clearInterval(interval); document.removeEventListener('visibilitychange',visibility); window.removeEventListener('online',online); window.removeEventListener('pagehide',pagehide);
    }
    function invalidate() {
      if (disposed) return;
      if (!unavailable) run.run_status = 'paused';
      disposed = true;
      stopWriters();
      window.removeEventListener('lp:language-changed', render);
      if (active === api) { host.replaceChildren(); host.hidden = true; active = null; }
    }
    function discard() {
      invalidate();
      var cleared = !!cache;
      if (cache) {
        cleared = cache.remove(options.uid, 'planned', run.activity_id) && cleared;
        cleared = cache.remove(options.uid, 'conflict', run.activity_id) && cleared;
      }
      cleared = removeLegacyRecord(storageKey) && cleared;
      cleared = removeLegacyRecord(storageKey + '_conflict') && cleared;
      return cleared;
    }
    function visibility() { if (isCurrent() && !finished && document.hidden) { tick(true); run.run_status = 'paused'; checkpoint(); render(); } }
    function online() { if (isCurrent() && !finished) checkpoint(); }
    function pagehide() { if (isCurrent() && !finished) { tick(true); run.run_status = 'paused'; persist(); } }
    $('[data-pause]').addEventListener('click',function () { if (!isCurrent() || finished) return; tick(); run.run_status = run.run_status === 'active' ? 'paused' : 'active'; lastTick = Date.now(); checkpoint(); render(); });
    $('[data-finish]').addEventListener('click',finish);
    var interval = setInterval(tick,1000);
    document.addEventListener('visibilitychange',visibility); window.addEventListener('online',online); window.addEventListener('pagehide',pagehide);
    window.addEventListener('lp:language-changed', render);
    var api = {invalidate:invalidate,discard:discard,hasPending:hasPending,flushPending:flushPending,isFinished:function () { return finished; },isUnavailable:function () { return unavailable; },pause:function () { if (!isCurrent() || finished) return; tick(); run.run_status = 'paused'; checkpoint(); render(); },changeMode:changeMode,record:record,close:close,checkpoint:checkpoint,getRun:function () { return run; }};
    active = api;
    try { await changeMode(options.studyMode,options.timerMode); } catch (error) { await close(); throw error; }
    return api;
  }
  root.LectureProcessorPlannedStudy = {open:open,invalidate:function () { if (active) active.invalidate(); }};
})(window);
