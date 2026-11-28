/* Active time per expedition step.
   Counts only while a step is open, the page is visible and the learner was
   active within the idle window. One continuous visit counts for at most the
   visit cap. Totals are cumulative per step for one sharing session, so a
   receiver can keep the larger value and never double-count a resend. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.XpedStepTimer = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  var IDLE_MS = 60 * 1000;
  var VISIT_CAP_MS = 15 * 60 * 1000;

  function createStepTimer(options) {
    var opts = options || {};
    var clock = typeof opts.now === 'function' ? opts.now : Date.now;
    var idleMs = opts.idleMs > 0 ? opts.idleMs : IDLE_MS;
    var capMs = opts.visitCapMs > 0 ? opts.visitCapMs : VISIT_CAP_MS;
    var totals = Object.create(null);
    var current = null;
    var visitMs = 0;
    var visible = true;
    var lastAt = clock();
    var lastActivity = lastAt;

    // Credit the time since the last event, bounded by the idle window and the visit cap.
    function advance(at) {
      if (current && visible) {
        var until = Math.min(at, lastActivity + idleMs);
        var gained = Math.min(Math.max(0, until - lastAt), Math.max(0, capMs - visitMs));
        if (gained > 0) {
          visitMs += gained;
          totals[current] = (totals[current] || 0) + gained;
        }
      }
      lastAt = Math.max(lastAt, at);
    }

    return {
      enter: function (stepId) {
        var at = clock();
        advance(at);
        if (stepId !== current) {
          current = stepId || null;
          visitMs = 0;
        }
        lastActivity = at;
      },
      leave: function () {
        advance(clock());
        current = null;
        visitMs = 0;
      },
      activity: function () {
        var at = clock();
        advance(at);
        lastActivity = at;
      },
      setVisible: function (isVisible) {
        var at = clock();
        advance(at);
        visible = !!isVisible;
        if (visible) lastActivity = at;
      },
      // Whole seconds per step; steps under one second are left out.
      seconds: function () {
        advance(clock());
        var out = {};
        Object.keys(totals).forEach(function (stepId) {
          var whole = Math.floor(totals[stepId] / 1000);
          if (whole > 0) out[stepId] = whole;
        });
        return out;
      },
      milliseconds: function () {
        advance(clock());
        var out = {};
        Object.keys(totals).forEach(function (stepId) { out[stepId] = Math.round(totals[stepId]); });
        return out;
      },
      // Restore saved totals for the same session; invalid entries are ignored.
      load: function (saved) {
        if (!saved || typeof saved !== 'object') return;
        Object.keys(saved).forEach(function (stepId) {
          var value = Number(saved[stepId]);
          if (stepId && Number.isFinite(value) && value > 0) totals[stepId] = Math.max(totals[stepId] || 0, value);
        });
      },
      reset: function () {
        advance(clock());
        totals = Object.create(null);
        visitMs = 0;
      },
    };
  }

  return { createStepTimer: createStepTimer, IDLE_MS: IDLE_MS, VISIT_CAP_MS: VISIT_CAP_MS };
});
