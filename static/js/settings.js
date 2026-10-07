(function () {
  'use strict';
  function init() {
    var preferences = window.LecturePreferences;
    if (!preferences) return;
    var theme = document.getElementById('settings-dark-mode');
    var language = document.getElementById('settings-language');
    var status = document.getElementById('settings-status');
    var retry = document.getElementById('settings-retry');
    var controls = document.getElementById('settings-controls');
    var auth = document.getElementById('settings-auth');
    function render() {
      var state = preferences.get();
      controls.disabled = !state.signedIn || !state.ready || state.saving;
      controls.setAttribute('aria-busy', String(state.saving));
      theme.checked = state.theme === 'dark';
      language.value = state.language;
      language.dispatchEvent(new Event('change'));
      auth.hidden = state.signedIn;
      retry.hidden = !state.error || state.ready;
      status.classList.toggle('is-error', !!state.error);
      status.textContent = state.error || (state.saving ? 'Saving your preferences…' : (!state.ready ? 'Loading your preferences…' : (state.signedIn ? 'Your preferences are saved to your account.' : 'Sign in to save your preferences.')));
    }
    theme.addEventListener('change', function (event) {
      if (!event.isTrusted) return;
      preferences.update({ theme: theme.checked ? 'dark' : 'light' });
    });
    // The website-styled selector dispatches its own change event.
    var rendering = false;
    language.addEventListener('change', function () {
      if (rendering || language.value === preferences.get().language) return;
      preferences.update({ language: language.value });
    });
    function refresh() { rendering = true; render(); rendering = false; }
    retry.addEventListener('click', function () { preferences.retry(); });
    window.addEventListener('lp:preferences-changed', refresh);
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
