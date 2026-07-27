const test = require('node:test');
const assert = require('node:assert/strict');

const modeConfig = require('../static/js/index-mode-config.js');

test('every processing mode has immutable requirements and progress steps', () => {
  assert.deepEqual(Object.keys(modeConfig).sort(), ['interview', 'lecture-notes', 'slides-only']);
  assert.equal(modeConfig['lecture-notes'].needsPdf, true);
  assert.equal(modeConfig['lecture-notes'].needsAudio, true);
  assert.equal(modeConfig['slides-only'].needsAudio, false);
  assert.equal(modeConfig.interview.titleLabel, 'Interview Title / Name');
  assert.ok(modeConfig.interview.steps.length > 0);
  assert.equal(Object.isFrozen(modeConfig), true);
  assert.equal(Object.isFrozen(modeConfig['lecture-notes'].steps), true);
});
