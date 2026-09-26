const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeHex, hexToHsv, hsvToHex } = require('../static/js/book-color-picker.js');

test('pasted and shorthand hex colors normalize without accepting invalid entries', () => {
  assert.equal(normalizeHex('  #aBc  '), '#aabbcc');
  assert.equal(normalizeHex('ABC'), '#aabbcc');
  assert.equal(normalizeHex('4F46E5'), '#4f46e5');
  for (const value of ['', '#', '#ab', '#abcd', '#abcdefg', 'red', '#ggg']) {
    assert.equal(normalizeHex(value), null);
  }
});

test('hex and HSV conversions preserve actual chosen colors including grayscale', () => {
  for (const color of ['#ffffff', '#000000', '#ff0000', '#00ff00', '#0000ff', '#7a90c4', '#808080']) {
    assert.equal(hsvToHex(hexToHsv(color)), color);
  }
});
