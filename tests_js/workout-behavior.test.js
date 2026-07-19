const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadBehaviorUtils() {
  const window = {
    WorkoutUtils: {},
    LectureProcessorHtml: { escapeHtml: (value) => String(value) },
    LectureProcessorUx: {},
  };
  const context = vm.createContext({
    window,
    document: { addEventListener() {} },
    navigator: { onLine: true },
    Promise,
    Date,
    Math,
    Number,
    String,
    Object,
    Array,
    JSON,
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'workout.js'), 'utf8');
  vm.runInContext(source, context, { filename: 'workout.js' });
  return window.WorkoutBehaviorUtils;
}

test('trend model reports real dates, extrema, and latest change', () => {
  const utils = loadBehaviorUtils();
  const model = utils.trendModel([
    { date: '2026-07-01', weight_kg: 63.2 },
    { date: '2026-07-08', weight_kg: 62.4 },
    { date: '2026-07-15', weight_kg: 62.7 },
  ], (entry) => entry.weight_kg);

  assert.deepEqual(Array.from(model.dates), ['2026-07-01', '2026-07-08', '2026-07-15']);
  assert.equal(model.min, 62.4);
  assert.equal(model.max, 63.2);
  assert.equal(model.latest, 62.7);
  assert.ok(Math.abs(model.change - 0.3) < 1e-9);
});

test('share cancellation recognizes AbortError without fallback copying', () => {
  const utils = loadBehaviorUtils();
  assert.equal(utils.isAbortError({ name: 'AbortError' }), true);
  assert.equal(utils.isAbortError({ code: 20 }), true);
  assert.equal(utils.isAbortError(new Error('share failed')), false);
});
