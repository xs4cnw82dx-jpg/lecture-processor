(function () {
  'use strict';

  const locale = window.Xped.i18n;
  const uiText = locale.t;
  let preferenceVersion = 0;
  let writing = Promise.resolve();
  let interacted = false;
  document.addEventListener('input', () => { interacted = true; }, { once: true });
  const languageControls = document.querySelectorAll('#academy-language, [data-academy-language]');
  const themeControls = document.querySelectorAll('#academy-theme, [data-academy-theme]');

  function checkControls(controls, key, chosen) {
    controls.forEach(control => {
      if (control.tagName === 'SELECT') control.value = chosen;
      else if (control.type === 'radio') control.checked = control.dataset[key] === chosen;
      else control.setAttribute('aria-pressed', String(control.dataset[key] === chosen));
    });
  }
  checkControls(languageControls, 'academyLanguage', locale.language);
  checkControls(themeControls, 'academyTheme', locale.theme());
  themeControls.forEach(control => {
    control.addEventListener(control.tagName === 'SELECT' || control.type === 'radio' ? 'change' : 'click', () => {
      const next = control.dataset.academyTheme || control.value;
      locale.setTheme(next);
      checkControls(themeControls, 'academyTheme', next);
    });
  });
  async function changeLanguage(next) {
    if (!['nl', 'de'].includes(next)) return;
    const requestVersion = ++preferenceVersion;
    const user = auth && auth.currentUser;
    if (user && user.emailVerified) {
      try {
        const token = await user.getIdToken();
        if (auth.currentUser !== user || requestVersion !== preferenceVersion) return;
        // Queue writes from this tab. Older selections must not arrive after a newer one.
        writing = writing.catch(() => {}).then(() => {
          if (requestVersion !== preferenceVersion || auth.currentUser !== user) return undefined;
          return fetch('/api/academy/preferences', {
          method: 'PUT', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ language: next })
          });
        });
        const response = await writing;
        if (!response) return;
        if (!response.ok) throw new Error('preference_unavailable');
      } catch (_) {
        if (requestVersion === preferenceVersion) {
          checkControls(languageControls, 'academyLanguage', locale.language);
          const ux = window.Xped.ux;
          if (ux) ux.toast(uiText('settings.preferenceFailed'), { type: 'error' });
        }
        return;
      }
    }
    if (requestVersion === preferenceVersion && (!user || auth.currentUser === user)) locale.setLanguage(next);
  }
  languageControls.forEach(control => {
    control.addEventListener(control.tagName === 'SELECT' || control.type === 'radio' ? 'change' : 'click',
      () => changeLanguage(control.dataset.academyLanguage || control.value));
  });
  var button = document.getElementById('academy-signout');
  var bootstrap = window.Xped.bootstrap;
  const authLinks = window.Xped.auth;
  if (authLinks) authLinks.updateSignInLinks();
  if (!bootstrap) return;
  var auth;
  try { auth = bootstrap.getAuth(); } catch (_) { return; }

  var verify = document.getElementById('academy-verify-email');
  if (verify) verify.href = '/inloggen?next=' + encodeURIComponent(window.location.pathname + window.location.search + window.location.hash);
  const uiText = locale.t;
  var actor;
  bootstrap.onAuthStateReady(auth, async function (user) {
    const nextActor = user?.uid || null;
    if (actor !== undefined && actor !== nextActor) window.Xped.ux.clearToasts();
    actor = nextActor;
    const requestVersion = ++preferenceVersion;
    if (button) button.hidden = !user;
    if (verify) verify.hidden = !user || user.emailVerified !== false;
    if (!user || !user.emailVerified) return;
    try {
      const token = await user.getIdToken();
      const response = await fetch('/api/academy/preferences', { headers: { Authorization: 'Bearer ' + token } });
      if (!response.ok) return;
      const saved = (await response.json()).language;
      if (saved && saved !== locale.language && auth.currentUser === user &&
          requestVersion === preferenceVersion && !interacted) locale.setLanguage(saved);
    } catch (_) { /* The language cookie still works while offline. */ }
  });
  if (!button) return;
  button.addEventListener('click', async function () {
    button.disabled = true;
    try {
      await auth.signOut();
      window.location.replace('/');
    } catch (_) {
      button.disabled = false;
      window.Xped.ux.toast(uiText('settings.signOutFailed'), { type: 'error' });
    }
  });
})();
