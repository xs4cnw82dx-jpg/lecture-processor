const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load(saved) {
  const context = { localStorage: { getItem: () => saved } };
  vm.createContext(context);
  ['i18n-catalog.js', 'i18n-supplement.js', 'i18n.js'].forEach((name) => {
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
