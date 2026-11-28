(function (root) {
  'use strict';
  const language = document.documentElement.lang === 'de' ? 'de' : 'nl';
  const locale = language === 'de' ? 'de-DE' : 'nl-NL';
  const messages = root.XpedMessages || {};
  const cardinals = new Intl.PluralRules(locale);
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
    const message = messages[key] ?? key;
    if (typeof message === 'string') {
      return values ? message.replace(/\{(\w+)\}/g, (field, name) => values[name] ?? field) : message;
    }
    const count = values?.[message.plural];
    if (!Number.isInteger(count)) throw new TypeError('Academy plural counts must be integers');
    const choices = message.choices;
    const text = choices['=' + count] ?? choices[cardinals.select(count)] ?? choices.other;
    return text.replace(/#|\{(\w+)\}/g, (field, name) => field === '#' ? number(count) : values[name] ?? field);
  }
  function courseStatus(course) {
    if (course.shareEnabled && course.collectResponses) return ['collecting', copy('Verzamelt resultaten', 'Erfasst Ergebnisse')];
    if (course.shareEnabled) return ['live', 'Live'];
    if (course.hasPublished) return ['paused', copy('Gepauzeerd', 'Pausiert')];
    return ['draft', copy('Concept', 'Entwurf')];
  }
  function number(value, options) { return new Intl.NumberFormat(locale, options).format(value); }
  function date(value, options) { return new Intl.DateTimeFormat(locale, { hourCycle: 'h23', ...options }).format(value); }
  function percent(value) {
    return Number.isFinite(value) ? number(value / 100, { style: 'percent', maximumFractionDigits: Math.abs(value) < 10 ? 1 : 0 }) : '—';
  }
  function duration(seconds, style = 'minutes') {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';
    const unit = (value, name, digits = 0) => number(value, {
      style: 'unit', unit: name, unitDisplay: 'short', maximumFractionDigits: digits,
    });
    if (style === 'minutes') return unit(seconds / 60, 'minute', 1);
    const total = Math.round(seconds);
    const clock = number(Math.floor(total / 60)) + ':' + number(total % 60, { minimumIntegerDigits: 2 });
    if (style === 'clock') return clock;
    if (total < 3600) return clock + ' ' + copy('min', 'Min.');
    const minutes = Math.floor(total / 60);
    return number(Math.floor(minutes / 60)) + ':' + number(minutes % 60, { minimumIntegerDigits: 2 }) + ' ' + copy('uur', 'Std.');
  }
  function relative(epochSeconds, now = Date.now()) {
    const seconds = Math.trunc((epochSeconds * 1000 - now) / 1000);
    const days = Math.abs(seconds) >= 86400;
    const hours = Math.abs(seconds) >= 3600;
    const minutes = Math.abs(seconds) >= 60;
    const unit = days ? 'day' : hours ? 'hour' : minutes ? 'minute' : 'second';
    const amount = Math.trunc(seconds / (days ? 86400 : hours ? 3600 : minutes ? 60 : 1));
    return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(amount, unit);
  }
  function localizeCalendars(scope = document) {
    const inputs = scope.querySelectorAll('input[type=date]');
    if (!inputs.length || !root.Xped?.ux?.enhanceDateInput) return;
    const uiText = t;
    const labels = {
      choose: uiText('calendar.choose'), date: uiText('calendar.date'),
      previous: uiText('calendar.previous'), next: uiText('calendar.next'),
      today: uiText('calendar.today'), clear: uiText('calendar.clear'), close: uiText('calendar.close'),
    };
    // 1 January 2024 was Monday. UTC keeps headings in order in every timezone.
    const weekdays = Array.from({ length: 7 }, (_, i) => date(Date.UTC(2024, 0, i + 1), { weekday: 'short', timeZone: 'UTC' }));
    for (const input of inputs) root.Xped.ux.enhanceDateInput(input, { date, weekdays, labels });
  }
  document.addEventListener('DOMContentLoaded', () => localizeCalendars(), { once: true });
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
  root.Xped.i18n = Object.freeze({ language, locale, copy, t, courseStatus, number, date, relative, percent, duration, localizeCalendars, theme: () => selectedTheme, setLanguage, setTheme });
})(window);
