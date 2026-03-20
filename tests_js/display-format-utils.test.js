const test = require('node:test');
const assert = require('node:assert/strict');

const displayFormatUtils = require('../static/js/display-format-utils.js');

test('formatCount handles singular and plural labels', () => {
  assert.equal(displayFormatUtils.formatCount(1, 'card'), '1 card');
  assert.equal(displayFormatUtils.formatCount(2, 'card'), '2 cards');
  assert.equal(displayFormatUtils.formatCount(1, 'question'), '1 question');
});

test('formatPackCounts combines both count labels consistently', () => {
  assert.equal(displayFormatUtils.formatPackCounts(1, 2), '1 card · 2 questions');
  assert.equal(displayFormatUtils.formatPackCounts(3, 1), '3 cards · 1 question');
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
