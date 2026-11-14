const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadUx(matchMedia) {
  const window = { matchMedia, addEventListener() {} };
  const document = { readyState: 'loading', addEventListener() {} };
  vm.runInNewContext(readFileSync(path.join(__dirname, '../static/js/ux-utils.js'), 'utf8'), { window, document });
  return window.LectureProcessorUx;
}

test('shared motion preference returns false when media queries are unavailable', () => {
  assert.equal(loadUx().prefersReducedMotion(), false);
});

for (const reduced of [true, false]) {
  test(`shared motion preference reflects reduced motion ${reduced}`, () => {
    const queries = [];
    const ux = loadUx(query => { queries.push(query); return { matches: reduced }; });
    assert.equal(ux.prefersReducedMotion(), reduced);
    assert.deepEqual(queries, ['(prefers-reduced-motion: reduce)']);
  });
}

test('shared motion preference follows a change made after page load', () => {
  let reduced = false;
  const ux = loadUx(() => ({ matches: reduced }));
  assert.equal(ux.prefersReducedMotion(), false);
  reduced = true;
  assert.equal(ux.prefersReducedMotion(), true);
});
