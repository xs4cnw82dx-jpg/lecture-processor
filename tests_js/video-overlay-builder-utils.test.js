const test = require('node:test');
const assert = require('node:assert/strict');

const utils = require('../static/js/video-overlay-builder-utils.js');

test('createTableData clamps invalid table sizes to a usable grid', () => {
  const table = utils.createTableData(0, -2);

  assert.equal(table.rowCount, 1);
  assert.equal(table.colCount, 1);
  assert.deepEqual(table.cells, [['Column 1']]);
});

test('resizeTableData preserves existing cells and keeps tables rectangular', () => {
  const original = {
    cells: [
      ['A', 'B'],
      ['1', '2'],
    ],
  };

  const resized = utils.resizeTableData(original, 3, 3);

  assert.equal(resized.rowCount, 3);
  assert.equal(resized.colCount, 3);
  assert.deepEqual(resized.cells[0], ['A', 'B', 'Column 3']);
  assert.deepEqual(resized.cells[1], ['1', '2', '']);
  assert.deepEqual(resized.cells[2], ['', '', '']);
});

test('normalizeTableData repairs ragged pasted table data', () => {
  const repaired = utils.normalizeTableData({
    rowCount: 3,
    colCount: 2,
    cells: [
      ['Only one header'],
      ['A', 'B', 'Ignored'],
    ],
  });

  assert.deepEqual(repaired.cells, [
    ['Only one header', 'Column 2'],
    ['A', 'B'],
    ['', ''],
  ]);
});

test('buildAnimationSchedule clamps delays and sorts stable by timing', () => {
  const schedule = utils.buildAnimationSchedule([
    { id: 'late', delay: 50, duration: 20, animation: 'unknown' },
    { id: 'first', delay: 0.5, duration: 0.2, animation: 'fade' },
    { id: 'same-delay', delay: 0.5, duration: 0.3, animation: 'wipe' },
  ], 12);

  assert.deepEqual(schedule.map((entry) => entry.id), ['first', 'same-delay', 'late']);
  assert.equal(schedule[0].delayMs, 500);
  assert.equal(schedule[2].delayMs, 12000);
  assert.equal(schedule[2].durationMs, 10000);
  assert.equal(schedule[2].animation, 'rise');
});

test('normalizeOverlayItem preserves shape and arrow overlay types', () => {
  assert.equal(utils.normalizeOverlayItem({ type: 'shape', title: 'Circle' }).type, 'shape');
  assert.equal(utils.normalizeOverlayItem({ type: 'arrow', title: 'Callout' }).type, 'arrow');
});
