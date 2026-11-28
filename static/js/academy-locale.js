(function (root) {
  'use strict';
  const language = document.documentElement.lang === 'de' ? 'de' : 'nl';
  const locale = language === 'de' ? 'de-DE' : 'nl-NL';
  const messages = root.XpedMessages || {};
  const storageKey = 'xped-preferences';

  function readPreferences() {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) return JSON.parse(saved) || {};
      // Only migrate a valid appearance choice. The old Studio defaulted to English.
      const legacy = JSON.parse(localStorage.getItem('lp-preferences') || '{}');
      const value = legacy && ['light', 'dark'].includes(legacy.theme) ? { theme: legacy.theme } : {};
      localStorage.setItem(storageKey, JSON.stringify(value));
      return value;
    } catch (_) { return {}; }
  }

  function writePreference(key, value) {
    try { localStorage.setItem(storageKey, JSON.stringify({ ...readPreferences(), [key]: value })); }
    catch (_) { /* The current document can still apply the preference. */ }
  }

  function copy(nl, de) { return language === 'de' ? de : nl; }
  function t(key, values) {
    const text = messages[key] ?? key;
    return values ? text.replace(/\{(\w+)\}/g, (field, name) => values[name] ?? field) : text;
  }
  function courseStatus(course) {
    if (course.shareEnabled && course.collectResponses) return ['collecting', copy('Verzamelt resultaten', 'Erfasst Ergebnisse')];
    if (course.shareEnabled) return ['live', 'Live'];
    if (course.hasPublished) return ['paused', copy('Gepauzeerd', 'Pausiert')];
    return ['draft', copy('Concept', 'Entwurf')];
  }
  function number(value, options) { return new Intl.NumberFormat(locale, options).format(value); }
  function date(value, options) { return new Intl.DateTimeFormat(locale, options).format(value); }
  function relative(epochSeconds, now = Date.now()) {
    const seconds = Math.trunc((epochSeconds * 1000 - now) / 1000);
    const days = Math.abs(seconds) >= 86400;
    const hours = Math.abs(seconds) >= 3600;
    const minutes = Math.abs(seconds) >= 60;
    const unit = days ? 'day' : hours ? 'hour' : minutes ? 'minute' : 'second';
    const amount = Math.trunc(seconds / (days ? 86400 : hours ? 3600 : minutes ? 60 : 1));
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(amount, unit);
  }
  const systemAppearance = root.matchMedia ? root.matchMedia('(prefers-color-scheme: dark)') : null;
  const themes = ['system', 'light', 'dark'];
  let selectedTheme = readPreferences().theme;
  if (!themes.includes(selectedTheme)) selectedTheme = 'system';
  function applyAppearance() {
    const appearance = selectedTheme === 'system' ? (systemAppearance?.matches ? 'dark' : 'light') : selectedTheme;
    document.documentElement.dataset.theme = appearance;
  }
  function setTheme(next) {
    if (!themes.includes(next)) return;
    selectedTheme = next;
    writePreference('theme', next);
    applyAppearance();
  }
  function setLanguage(next) {
    if (!['nl', 'de'].includes(next)) return;
    document.cookie = 'xped-language=' + next + '; Path=/; Max-Age=31536000; SameSite=Lax' +
      (location.protocol === 'https:' ? '; Secure' : '');
    if (next !== language) location.reload();
  }
  applyAppearance();
  systemAppearance?.addEventListener('change', applyAppearance);
  root.Xped = root.Xped || {};
  root.ElearningHost = root.Xped;
  root.Xped.siteTitle = 'xPED Academy';
  root.Xped.coursePaths = function (id) {
    const base = '/expedities/' + encodeURIComponent(id);
    return { overview: base, edit: base + '/bewerken', report: base + '/resultaten' };
  };
  root.Xped.learnerPath = token => '/start/' + encodeURIComponent(token);
  root.Xped.translatorPath = token => '/vertalen/' + encodeURIComponent(token);
  root.Xped.i18n = Object.freeze({ language, locale, copy, t, courseStatus, number, date, relative, theme: () => selectedTheme, setLanguage, setTheme });
})(window);
