/* Interface localization. User-authored and generated material stays in its original language. */
(function (root) {
  'use strict';
  var catalog = root.LectureI18nCatalog || { nl: {}, en: {} };
  // Custom controls can copy an already translated option into a new node.
  // Keep those interface labels reversible when returning to English.
  catalog.en = catalog.en || {};
  Object.keys(catalog.nl || {}).forEach(function (source) {
    var translated = catalog.nl[source];
    if (translated !== source && !Object.prototype.hasOwnProperty.call(catalog.en, translated)) catalog.en[translated] = source;
  });
  var language = 'en';
  try { language = JSON.parse(root.localStorage.getItem('lp-preferences') || '{}').language === 'nl' ? 'nl' : 'en'; } catch (_error) { /* Storage can be unavailable in private windows. */ }
  var originals = new WeakMap();
  var attributeOriginals = new WeakMap();
  var observer;
  var queued = new Set();
  var scheduled = false;
  // These are content surfaces, not interface copy. Keep even exact matches ("Save", "Today") untouched.
  var contentBoundary = [
    'script', 'style', 'code', 'pre', 'textarea', 'svg', 'math', '[contenteditable]', '[translate="no"]', '[data-i18n-ignore]',
    '#shell-account-name', '#shell-account-initial', '#user-email', '#user-meta',
    '#dash-sessions-list .list-item h3', '#dash-packs-list .list-item h3',
    '.dashboard-due-pack-head h3', '.dashboard-due-cards li',
    '#notes-view', '#voice-notes-surface', '#pack-summary-title', '#setup-pack-name', '#learn-title', '#audio-pack-title',
    '#write-prompt', '#learn-q-text', '#learn-q-options', '#learn-q-expl',
    '#pack-folder-label', '#pack-folder-menu [data-value]:not([data-value=""])',
    '#coding-code-picker-label', '.builder-preview-value', '.peek-front', '.peek-answer', '.learn-list-front', '.learn-list-back',
    '.calendar-feed-item strong',
    '#session-editor-pack option:not([value=""])', '#pack-folder-select option:not([value=""])', '#builder-folder-select option:not([value=""])',
    '[data-file-name]', '#pdf-name', '#audio-name', '#file-name', '#transcriber-file-name', '.bs-batch-title', '.bs-heading h1', '.bs-heading h2', '.bs-result-identity h3',
    '.workout-schedule-copy strong', '.workout-routine-head h3', '.workout-routine-head p',
    '.workout-record-row strong', '.workout-history-card strong', '.workout-exercise-head h2', '.workout-exercise-cues',
    '.workout-exercise-option strong', '.workout-start-test strong', '#workout-logger-title', '#workout-cycle-label',
    '#workout-trend-select option', '#workout-routine-add-exercise option',
    '.book-thumb-title', '.book-layer [data-select-object] > span', '.book-asset-card p', '.book-asset-card img',
    '.book-version strong', '.book-comments article strong', '.book-comments article p',
    '#shared-study-title', '#shared-folder-pack-title', '#shared-notes-view', '#shared-folder-notes-view',
    '.shared-card-front', '.shared-card-back', '.shared-question-options', '.shared-question-explanation',
    '.markdown', '.markdown-body', '.notes-content', '.notes-rendered', '.rendered-markdown', '.transcript-content',
    '.item-title', '.voice-note-title', '.book-card-title h3', '.book-mini-cover', '.book-canvas', '.book-version-preview',
    '.calendar-session-title', '.session-row h3', '.managed-goal h2', '.managed-goal-packs', '.goal-progress-item h3',
    '.wizard-pack-copy strong', '.wizard-pack-copy > span:not(.pack-materials)', '.schedule-pack-key', '.preview-session > span',
    '.processing-now-item-title', '.shared-question-title', '.coding-code-name', '.coding-code-picker-option-name',
    '.coding-ai-preview-text', '.coding-preview-chip', '.coding-quote-code', '.coding-margin-chip', '.coding-quote-text',
    '.builder-expandable > summary > span:nth-child(2)', '.enhanced-select-trigger [data-user-content]',
    '#coding-transcript', '#notes-content', '#notes-fullscreen-content', '#notes-preview', '#transcript-output',
    '#flashcard-front', '#flashcard-back', '#learn-flashcard-front', '#learn-flashcard-back', '#question-text',
    '#study-pack-title', '#selected-pack-title', '#session-pack-title', '#share-workout-title',
    '[data-pack-title]', '[data-user-content]', '.question-options', '.answer-option', '.match-tile', '.flashcard-face'
  ].join(',');
  var attributes = ['aria-label', 'aria-description', 'aria-valuetext', 'title', 'placeholder', 'alt'];
  function normalized(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
  function translate(value, params) {
    var text = String(value == null ? '' : value);
    var key = normalized(text);
    var translated = Object.prototype.hasOwnProperty.call(catalog[language] || {}, key) ? catalog[language][key] : key;
    if (translated === key && language === 'nl') {
      // Only bounded UI count formats, never arbitrary substitutions inside prose or user text.
      var count = /^(\d+) (cards?|flashcards?|questions?|practice questions?|sessions?|minutes?|hours?|days?|workouts?|notes?|tools?|selected)$/.exec(key);
      var nouns = { card: 'kaart', cards: 'kaarten', flashcard: 'leerkaart', flashcards: 'leerkaarten', question: 'vraag', questions: 'vragen', 'practice question': 'oefenvraag', 'practice questions': 'oefenvragen', session: 'sessie', sessions: 'sessies', minute: 'minuut', minutes: 'minuten', hour: 'uur', hours: 'uur', day: 'dag', days: 'dagen', workout: 'training', workouts: 'trainingen', note: 'notitie', notes: 'notities', tool: 'hulpmiddel', tools: 'hulpmiddelen', selected: 'geselecteerd' };
      if (count) translated = count[1] + ' ' + nouns[count[2]];
      var advancedSummary = /^(No study tools|Flashcards only|Practice test only|Flashcards \+ test|No extras|\d+ extras?) · (.+)$/.exec(key);
      if (advancedSummary) translated = translate(advancedSummary[1]) + ' · ' + translate(advancedSummary[2]);
      var foundTools = /^(\d+) tools? found$/.exec(key);
      if (foundTools) translated = foundTools[1] + (foundTools[1] === '1' ? ' hulpmiddel gevonden' : ' hulpmiddelen gevonden');
      var remainingDays = /^(\d+) days? (left|remaining)$/.exec(key);
      if (remainingDays) translated = 'Nog ' + remainingDays[1] + (remainingDays[1] === '1' ? ' dag' : ' dagen');
      var composedCounts = /^(\d+) (cards?|flashcards?) · (\d+) (questions?|practice questions?)$/.exec(key);
      if (composedCounts) translated = translate(composedCounts[1] + ' ' + composedCounts[2]) + ' · ' + translate(composedCounts[3] + ' ' + composedCounts[4]);
      var pricingVersion = /^Pricing version: ([\dA-Za-z_.-]+)$/.exec(key);
      if (pricingVersion) translated = 'Prijsversie: ' + pricingVersion[1];
      var numbered = /^(Card|Question|Flashcard|Step) (\d+)(?: of (\d+))?$/.exec(key);
      if (numbered) translated = ({ Card: 'Kaart', Question: 'Vraag', Flashcard: 'Leerkaart', Step: 'Stap' })[numbered[1]] + ' ' + numbered[2] + (numbered[3] ? ' van ' + numbered[3] : '');
    }
    if (translated === key && !params) return text;
    if (params) Object.keys(params).forEach(function (name) { translated = translated.replaceAll('{' + name + '}', String(params[name])); });
    return text.slice(0, text.length - text.trimStart().length) + translated + text.slice(text.trimEnd().length);
  }
  function excluded(element) { return !element || Boolean(element.closest(contentBoundary)); }
  function translateText(node) {
    if (excluded(node.parentElement) || !normalized(node.nodeValue)) return;
    var old = originals.get(node);
    // A page renderer can overwrite an existing node. Its new value becomes the new source.
    var source = old && node.nodeValue === old.rendered ? old.source : node.nodeValue;
    var rendered = translate(source);
    originals.set(node, { source: source, rendered: rendered });
    if (node.nodeValue !== rendered) node.nodeValue = rendered;
  }
  function translateAttributes(element) {
    if (excluded(element)) return;
    var saved = attributeOriginals.get(element) || {};
    attributes.forEach(function (name) {
      if (!element.hasAttribute(name)) return;
      var current = element.getAttribute(name);
      var old = saved[name];
      var source = old && old.rendered === current ? old.source : current;
      var rendered = translate(source);
      saved[name] = { source: source, rendered: rendered };
      if (current !== rendered) element.setAttribute(name, rendered);
    });
    attributeOriginals.set(element, saved);
  }
  function localize(target) {
    if (!target) return;
    if (target.nodeType === 3) { translateText(target); return; }
    if (target.nodeType !== 1 && target.nodeType !== 9) return;
    if (target.nodeType === 1 && excluded(target)) return;
    if (target.nodeType === 1) translateAttributes(target);
    var walker = root.document.createTreeWalker(target, 5, {
      acceptNode: function (node) {
        if (node.nodeType === 1 && excluded(node)) return 2;
        return 1;
      }
    });
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeType === 3) translateText(node);
      else translateAttributes(node);
    }
  }
  function flush() {
    scheduled = false;
    if (observer) observer.disconnect();
    queued.forEach(function (node) { if (node.isConnected) localize(node); });
    queued.clear();
    observe();
  }
  function observe() {
    if (observer) observer.observe(root.document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: attributes });
  }
  function setLanguage(value) {
    language = value === 'nl' ? 'nl' : 'en';
    if (!root.document) return language;
    root.document.documentElement.lang = language;
    queued.add(root.document.documentElement);
    flush();
    root.dispatchEvent(new CustomEvent('lp:language-changed', { detail: { language: language, locale: locale() } }));
    return language;
  }
  function locale() { return language === 'nl' ? 'nl-NL' : 'en-GB'; }
  var api = { t: translate, setLanguage: setLanguage, getLanguage: function () { return language; }, locale: locale, localize: localize, isContent: excluded };
  root.LectureI18n = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root.document) return;
  root.document.documentElement.lang = language;
  function start() {
    localize(root.document.documentElement);
    observer = new MutationObserver(function (records) {
      records.forEach(function (record) {
        if (record.type === 'childList') record.addedNodes.forEach(function (node) { queued.add(node); });
        else queued.add(record.target);
      });
      if (!scheduled && queued.size) { scheduled = true; queueMicrotask(flush); }
    });
    observe();
  }
  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  root.addEventListener('lp:preferences-changed', function (event) {
    var next = event.detail && event.detail.language === 'nl' ? 'nl' : 'en';
    if (next !== language) setLanguage(next);
  });
})(typeof window !== 'undefined' ? window : globalThis);
