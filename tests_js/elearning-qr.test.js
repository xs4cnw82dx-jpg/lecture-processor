const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
const qrcode = require('../static/js/vendor/qrcode-generator-2.0.4/qrcode.min.js');

test('a cohort share code renders the full encoded link and preserves its quiet zone on download', () => {
  const link = new URL('https://example.com/elearning/p/sample-link');
  link.searchParams.set('cohort', 'Onderwijs – Düsseldorf '.repeat(3));
  const url = link.toString();
  const document = {
    createElementNS: () => ({
      children: [], attributes: {},
      setAttribute(key, value) { this.attributes[key] = value; },
      appendChild(child) { this.children.push(child); },
    }),
  };
  const context = { window: { qrcode }, document };
  vm.runInNewContext(readFileSync('static/js/elearning-qr.js', 'utf8'), context);
  const svg = context.window.XpedElearningQR.createSvgElement(url);
  const expected = qrcode(0, 'M');
  expected.addData(url, 'Byte');
  expected.make();
  const count = expected.getModuleCount();
  assert.equal(svg.attributes.viewBox, '0 0 ' + (count + 8) + ' ' + (count + 8));
  assert.equal(svg.attributes.xmlns, 'http://www.w3.org/2000/svg');
  const modules = new Set([...svg.children[1].attributes.d.matchAll(/M(\d+),(\d+)h1v1h-1z/g)].map(match => match[1] + ',' + match[2]));
  let dark = 0;
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      assert.equal(modules.has((col + 4) + ',' + (row + 4)), expected.isDark(row, col));
      if (expected.isDark(row, col)) dark++;
    }
  }
  assert.equal(modules.size, dark);
});
