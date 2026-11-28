(function () {
  'use strict';

  var settings = document.querySelector('.academy-preferences');
  if (settings) {
    var language = document.getElementById('academy-language');
    var theme = document.getElementById('academy-theme');
    language.value = document.documentElement.lang === 'nl' ? 'nl' : 'en';
    theme.value = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    settings.addEventListener('change', function () {
      var preferences = { language: language.value, theme: theme.value };
      try { window.localStorage.setItem('lp-preferences', JSON.stringify(preferences)); } catch (_) { /* This tab can still apply the change. */ }
      window.dispatchEvent(new CustomEvent('lp:preferences-changed', { detail: preferences }));
    });
    window.addEventListener('lp:language-changed', function (event) { language.value = event.detail.language; });
    document.addEventListener('click', function (event) {
      if (!settings.contains(event.target)) settings.open = false;
    });
    settings.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { settings.open = false; settings.querySelector('summary').focus(); }
    });
  }

  var button = document.getElementById('academy-signout');
  var bootstrap = window.LectureProcessorBootstrap;
  if (window.LectureProcessorAuth) window.LectureProcessorAuth.updateSignInLinks();
  if (!button || !bootstrap) return;
  var auth;
  try { auth = bootstrap.getAuth(); } catch (_) { return; }

  var verify = document.getElementById('academy-verify-email');
  verify.href = '/signin?next=' + encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
  bootstrap.onAuthStateReady(auth, function (user) {
    button.hidden = !user;
    verify.hidden = !user || user.emailVerified !== false;
  });
  button.addEventListener('click', async function () {
    button.disabled = true;
    try {
      await auth.signOut();
      window.location.replace('/');
    } catch (_) {
      button.disabled = false;
      window.LectureProcessorUx.toast('Could not sign out. Please try again.', { type: 'error' });
    }
  });
})();
