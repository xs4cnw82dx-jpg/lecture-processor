/* Runs synchronously in the head so saved appearance is applied before paint. */
(function () {
  'use strict';
  const KEY = 'lp-preferences';
  const root = document.documentElement;
  function apply(preferences) {
    root.dataset.theme = preferences && preferences.theme === 'dark' ? 'dark' : 'light';
  }
  function read() {
    try { return JSON.parse(localStorage.getItem(KEY) || '{}'); }
    catch (_error) { return {}; }
  }
  function importCompanionAppearance() {
    if (root.dataset.localCompanion !== 'true' || !window.location
      || !['localhost', '127.0.0.1', '[::1]'].includes(window.location.hostname)) return;
    const url = new URL(window.location.href);
    const saved = read();
    const preferences = saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
    const theme = url.searchParams.get('lp_theme');
    const language = url.searchParams.get('lp_language');
    if (theme === 'dark' || theme === 'light') preferences.theme = theme;
    if (language === 'nl' || language === 'en') preferences.language = language;
    try { localStorage.setItem(KEY, JSON.stringify(preferences)); } catch (_error) { /* Private browsing can deny storage. */ }
    if (language === 'nl' || language === 'en') root.lang = language;
    if (url.searchParams.has('lp_theme') || url.searchParams.has('lp_language')) {
      url.searchParams.delete('lp_theme');
      url.searchParams.delete('lp_language');
      window.history.replaceState(window.history.state, '', url.href);
    }
    return preferences;
  }
  apply(importCompanionAppearance() || read());
  window.addEventListener('lp:preferences-changed', function (event) { apply(event.detail); });
  window.addEventListener('storage', function (event) {
    // Signed-in tabs use the account-scoped controller's storage listener.
    if (window.LecturePreferences && window.LecturePreferences.get().signedIn) return;
    if (event.key === KEY || event.key === null) apply(read());
  });
  window.LPTheme = Object.freeze({ apply });
}());
