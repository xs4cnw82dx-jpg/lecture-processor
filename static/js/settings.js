(function () {
  'use strict';
  function creditText(message, params) {
    if (window.LectureI18n && typeof window.LectureI18n.t === 'function') return window.LectureI18n.t(message, params);
    return message.replace(/\{(\w+)\}/g, function (match, key) { return params && params[key] !== undefined ? String(params[key]) : match; });
  }
  function initCredits() {
    var shell = window.LectureProcessorShell || {};
    var utils = window.LectureProcessorCreditUtils || {};
    var balance = document.getElementById('settings-credit-balance');
    var detail = document.getElementById('settings-credit-detail');
    var access = document.getElementById('settings-credit-access');
    var status = document.getElementById('settings-credit-status');
    var buy = document.getElementById('settings-buy-credits');
    var retry = document.getElementById('settings-credit-retry');
    if (!balance) return;
    function renderCredits() {
      var state = shell.getCreditState ? shell.getCreditState() : { status: 'signed-out' };
      var snapshot = state.snapshot;
      buy.hidden = state.status === 'signed-out';
      retry.hidden = state.status !== 'error';
      access.replaceChildren();
      if (!snapshot) {
        balance.textContent = creditText(state.status === 'signed-out' ? 'Sign in to see your balance.' : (state.status === 'error' ? 'Credits unavailable' : 'Loading credits'));
        detail.textContent = '';
      } else {
        balance.textContent = utils.formatCredits(snapshot.balance);
        detail.textContent = creditText(snapshot.scheme === 2 ? 'One balance for all your tools.' : 'Your credits are available in their original categories.');
        [['lecture', 'Lecture tools: no credits charged'], ['slides', 'Text extraction tools: no credits charged'], ['interview', 'Audio and interview tools: no credits charged']].forEach(function (entry) {
          if (!snapshot.unlimited[entry[0]]) return;
          var item = document.createElement('li');
          item.textContent = creditText(entry[1]);
          access.appendChild(item);
        });
      }
      access.hidden = !access.children.length;
      status.textContent = state.status === 'error' ? creditText('Could not refresh your balance. Please try again.') : (state.source === 'cache' ? creditText('Last known balance. Refreshing…') : '');
    }
    retry.addEventListener('click', function () { if (shell.refreshCredits) void shell.refreshCredits(); });
    window.addEventListener('lp:credits-changed', renderCredits);
    window.addEventListener('lp:language-changed', renderCredits);
    renderCredits();
  }
  function init() {
    initCredits();
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
