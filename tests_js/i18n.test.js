const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load(saved) {
  const context = { localStorage: { getItem: () => saved } };
  context.window = context;
  vm.createContext(context);
  ['i18n-catalog.js', 'i18n-supplement.js', 'i18n-dynamic.js', 'i18n-dynamic-learning.js', 'i18n-dynamic-tools.js', 'i18n.js'].forEach((name) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js', name), 'utf8'), context);
  });
  return context.LectureI18n;
}

test('interface language uses explicit saved preference instead of browser language', () => {
  const i18n = load('{"language":"nl","theme":"dark"}');
  assert.equal(i18n.locale(), 'nl-NL');
  assert.equal(i18n.t('Study Plan'), 'Studieplanning');
  assert.equal(i18n.t('Choose the language for menus, buttons and guidance.'), 'Kies de taal voor menu’s, knoppen en uitleg.');
  i18n.setLanguage('en');
  assert.equal(i18n.t('Study Plan'), 'Study Plan');
  assert.equal(i18n.locale(), 'en-GB');
});

test('invalid or unavailable preferences default to English', () => {
  assert.equal(load('broken').getLanguage(), 'en');
  assert.equal(load('{"language":"xx"}').getLanguage(), 'en');
});

test('progress due counts name the all-pack scope in both interface languages', () => {
  const i18n = load('{"language":"nl"}');
  assert.equal(i18n.t('{count} due now · all packs', { count: 6 }), '6 nu te herhalen · alle pakketten');
  assert.equal(i18n.t('{count} cards due · all packs', { count: 6 }), '6 kaarten te herhalen · alle pakketten');
  i18n.setLanguage('en');
  assert.equal(i18n.t('{count} due now · all packs', { count: 6 }), '6 due now · all packs');
});

test('bounded UI counts and whole phrases translate without replacing arbitrary substrings', () => {
  const i18n = load('{"language":"nl"}');
  assert.equal(i18n.t('1 card'), '1 kaart');
  assert.equal(i18n.t('12 cards'), '12 kaarten');
  assert.equal(i18n.t('14 tools found'), '14 hulpmiddelen gevonden');
  assert.equal(i18n.t('2 cards · 1 question'), '2 kaarten · 1 vraag');
  assert.equal(i18n.t('7 days left'), 'Nog 7 dagen');
  assert.equal(i18n.t('Flashcards + test · 🇬🇧 English'), 'Leerkaarten en oefentoets · 🇬🇧 Engels');
  assert.equal(i18n.t('Question 2 of 12'), 'Vraag 2 van 12');
  assert.equal(i18n.t('  Save  '), '  Opslaan  ');
  assert.equal(i18n.t('Save my custom physiology notes'), 'Save my custom physiology notes');
  assert.equal(i18n.t('custom@example.com'), 'custom@example.com');
  assert.equal(i18n.t('Hello {name}', { name: '<b>Jay</b>' }), 'Hello <b>Jay</b>');
});

test('the original Dutch Physio interface has English equivalents', () => {
  const i18n = load('{}');
  assert.equal(i18n.t('Kennisbank'), 'Knowledge base');
  assert.equal(i18n.t('Nieuwe casus'), 'New case');
  i18n.setLanguage('nl');
  assert.equal(i18n.t('Kennisbank'), 'Kennisbank');
});

test('study feedback preserves runtime values in Dutch and English', () => {
  const i18n = load('{"language":"nl"}');
  const summary = '{answered} / {total} target answers saved · {minutes} active min · {remaining} in planned slot';
  for (const [answered, minutes, remaining] of [[0, 0, '45:00'], [1, 1, '43:59'], [3, 45, '0:00']]) {
    const params = { answered, total: 3, minutes, remaining };
    assert.equal(i18n.t(summary, params), `${answered} / 3 antwoorden opgeslagen · ${minutes} actieve min · ${remaining} in geplande tijd`);
  }
  assert.equal(i18n.t('{time} logged. Session completed.', { time: '12 min' }), '12 min geregistreerd. Sessie afgerond.');
  assert.equal(i18n.t('Pauses when you leave this tab. Timer type stays fixed once started.'), 'Pauzeert als je dit tabblad verlaat. Het timertype blijft na de start hetzelfde.');
  assert.equal(i18n.t('Take a short break. Study controls will return when the next focus period starts.'), 'Neem een korte pauze. Je kunt verder studeren zodra de volgende focusperiode begint.');
  assert.equal(i18n.t('Flashcards · Focused session'), 'Leerkaarten · Gerichte studiesessie');
  for (const [source, translated] of [['Paused', 'Gepauzeerd'], ['Finish session', 'Sessie afronden'], ['Correct!', 'Goed!'], ['Saved.', 'Opgeslagen.'], ['— days', '— dagen'], ['— cards', '— kaarten']]) {
    assert.equal(i18n.t(source), translated);
  }
  i18n.setLanguage('en');
  assert.equal(i18n.t(summary, { answered: 1, total: 3, minutes: 1, remaining: '43:59' }), '1 / 3 target answers saved · 1 active min · 43:59 in planned slot');
  assert.equal(i18n.t('{time} logged. Session completed.', { time: '12 min' }), '12 min logged. Session completed.');
});

test('static template interface copy is catalogued (brand names, formats and shortcuts stay literal)', () => {
  const context = {};
  context.window = context;
  vm.createContext(context);
  ['i18n-catalog.js', 'i18n-supplement.js', 'i18n-dynamic.js', 'i18n-dynamic-learning.js', 'i18n-dynamic-tools.js'].forEach(name => {
    const filename = path.join(__dirname, '../static/js', name);
    if (fs.existsSync(filename)) vm.runInContext(fs.readFileSync(filename, 'utf8'), context);
  });
  const catalog = context.LectureI18nCatalog;
  const neutral = new Set(['App', 'Lecture Processor', 'Physio', 'Physio Assistant', 'Screening', 'Tests', 'Network', 'kg', 'index.m3u8', 'yyyy-mm-dd', 'Cmd + Option + I', 'Ctrl + Shift + I', 'iPhone, iPad & Mac', './.venv/bin/python scripts/run_physio_companion.py']);
  const decode = value => value.replace(/&(?:amp|lt|gt|quot|apos|nbsp|mdash|ndash|hellip|middot|larr|rarr);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…', '&middot;': '·', '&larr;': '←', '&rarr;': '→' })[entity]).replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code))).replace(/\s+/g, ' ').trim();
  const missing = [];
  for (const file of fs.readdirSync(path.join(__dirname, '../templates')).filter(name => name.endsWith('.html'))) {
    const source = fs.readFileSync(path.join(__dirname, '../templates', file), 'utf8').replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    const phrases = [...source.matchAll(/>([^<>]+)</g)].map(match => match[1]);
    phrases.push(...[...source.matchAll(/(?:aria-label|placeholder|title)="([^"]+)"/g)].map(match => match[1]));
    for (const raw of phrases) {
      const phrase = decode(raw);
      if (!/[A-Za-z]{2}/.test(phrase) || /[{}]|^https?:|@example\.|^\d/.test(phrase) || neutral.has(phrase) || /^Step \d+$/.test(phrase)) continue;
      if (!Object.hasOwn(catalog.nl, phrase) && !Object.hasOwn(catalog.en, phrase)) missing.push(file + ': ' + phrase);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});


test('catalog files register each translation once per language', () => {
  const owners = new Map();
  const duplicates = [];
  let activeFile = '';
  let catalog;
  const context = {};
  context.window = context;
  Object.defineProperty(context, 'LectureI18nCatalog', {
    get: () => catalog,
    set(value) {
      if (value === catalog) return;
      catalog = {};
      for (const [language, entries] of Object.entries(value)) {
        for (const key of Object.keys(entries)) owners.set(language + ':' + key, activeFile);
        catalog[language] = new Proxy(entries, {
          set(target, key, translation) {
            const identity = language + ':' + key;
            if (owners.has(identity)) duplicates.push(identity + ' (' + owners.get(identity) + ' → ' + activeFile + ')');
            owners.set(identity, activeFile);
            target[key] = translation;
            return true;
          },
        });
      }
    },
  });
  vm.createContext(context);
  for (activeFile of ['i18n-catalog.js', 'i18n-dynamic.js', 'i18n-dynamic-learning.js', 'i18n-dynamic-tools.js', 'i18n-supplement.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/js', activeFile), 'utf8'), context);
  }
  assert.deepEqual(duplicates, []);
});

test('reader names retain their displayed translation in each language', () => {
  const i18n = load('{"language":"nl"}');
  assert.equal(i18n.t('Document Reader'), 'Documentlezer');
  assert.equal(i18n.t('Image Reader'), 'Afbeeldingslezer');
  assert.equal(i18n.t('URL Reader'), 'URL-lezer');
  i18n.setLanguage('en');
  assert.equal(i18n.t('Document Reader'), 'Document Reader');
  assert.equal(i18n.t('Image Reader'), 'Image Reader');
  assert.equal(i18n.t('URL Reader'), 'URL Reader');
});
