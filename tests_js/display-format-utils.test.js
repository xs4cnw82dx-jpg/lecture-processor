const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const displayFormatUtils = require('../static/js/display-format-utils.js');

function loadFormatter(language, browserLocale, activeLocale) {
  const window = {
    document: { documentElement: { lang: language } },
    navigator: { language: browserLocale, languages: [browserLocale] },
  };
  if (activeLocale) window.LectureI18n = { locale: () => activeLocale };
  vm.runInNewContext(readFileSync(path.join(__dirname, '../static/js/display-format-utils.js'), 'utf8'), { window, Intl });
  return window.LectureProcessorDisplayFormatUtils;
}

for (const [language, browserLocale, expectedLocale] of [['en', 'nl-NL', 'en-GB'], ['nl', 'en-GB', 'nl-NL']]) {
  test(`initial ${language} currency follows the page language with a ${browserLocale} browser`, () => {
    const formatter = loadFormatter(language, browserLocale);
    const expected = new Intl.NumberFormat(expectedLocale, { style: 'currency', currency: 'EUR' }).format(9.99);
    assert.equal(formatter.formatCurrencyFromCents(999, 'EUR'), expected);
  });
}

test('active interface locale and explicit currency display settings remain authoritative', () => {
  const formatter = loadFormatter('en', 'en-GB', 'nl-NL');
  const expected = new Intl.NumberFormat('nl-NL', { style: 'currency', currency: 'EUR', currencyDisplay: 'code' }).format(16.99);
  assert.equal(formatter.formatCurrencyFromCents(1699, 'EUR', { currencyDisplay: 'code' }), expected);
});

test('formatCount handles singular and plural labels', () => {
  assert.equal(displayFormatUtils.formatCount(1, 'card'), '1 card');
  assert.equal(displayFormatUtils.formatCount(2, 'card'), '2 cards');
  assert.equal(displayFormatUtils.formatCount(1, 'question'), '1 question');
});

test('formatPackCounts combines both count labels consistently', () => {
  assert.equal(displayFormatUtils.formatPackCounts(1, 2), '1 card · 2 questions');
  assert.equal(displayFormatUtils.formatPackCounts(3, 1), '3 cards · 1 question');
});

test('formatPackMode keeps saved manual packs from looking like processing jobs', () => {
  assert.equal(displayFormatUtils.formatPackMode('manual'), 'Study Pack');
  assert.equal(displayFormatUtils.formatPackMode('lecture-notes'), 'Lecture Notes');
  assert.equal(displayFormatUtils.formatPackMode('unexpected-mode'), 'Study Pack');
});

test('formatCurrencyFromCents formats currency from raw cents', () => {
  const eur = displayFormatUtils.formatCurrencyFromCents(1234, 'EUR');
  const usd = displayFormatUtils.formatCurrencyFromCents(999, 'USD');

  assert.match(eur, /€/);
  assert.match(eur, /12/);
  assert.match(usd, /\$/);
  assert.match(usd, /9/);
});

test('formatDateTimeFromEpochSeconds returns a fallback for missing timestamps', () => {
  assert.equal(displayFormatUtils.formatDateTimeFromEpochSeconds(0), 'Unknown date');
  assert.notEqual(displayFormatUtils.formatDateTimeFromEpochSeconds(1710000000), 'Unknown date');
});
