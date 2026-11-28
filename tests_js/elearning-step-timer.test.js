import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStepTimer } = require('../static/js/elearning-step-timer.js');

function clockAt(start = 1_000_000) {
  let now = start;
  return { now: () => now, wait: ms => { now += ms; } };
}

test('time counts on the open step and stops when the learner moves on', () => {
  const clock = clockAt();
  const timer = createStepTimer({ now: clock.now });
  timer.enter('intro');
  clock.wait(20_000);
  timer.activity();
  clock.wait(10_000);
  timer.enter('quiz');
  clock.wait(5_000);
  timer.leave();
  clock.wait(30_000);
  assert.deepEqual(timer.seconds(), { intro: 30, quiz: 5 });
});

test('an idle learner stops counting after the idle window and resumes on activity', () => {
  const clock = clockAt();
  const timer = createStepTimer({ now: clock.now, idleMs: 60_000 });
  timer.enter('reading');
  clock.wait(5 * 60_000);
  assert.deepEqual(timer.seconds(), { reading: 60 });
  timer.activity();
  clock.wait(15_000);
  assert.deepEqual(timer.seconds(), { reading: 75 });
});

test('a hidden page does not count, and showing it again restarts the idle window', () => {
  const clock = clockAt();
  const timer = createStepTimer({ now: clock.now });
  timer.enter('video');
  clock.wait(10_000);
  timer.setVisible(false);
  clock.wait(10 * 60_000);
  timer.setVisible(true);
  clock.wait(20_000);
  assert.deepEqual(timer.seconds(), { video: 30 });
});

test('one visit counts for at most the visit cap, and a new visit counts again', () => {
  const clock = clockAt();
  const timer = createStepTimer({ now: clock.now, idleMs: 60_000, visitCapMs: 120_000 });
  timer.enter('long');
  for (let minute = 0; minute < 5; minute += 1) {
    clock.wait(50_000);
    timer.activity();
  }
  assert.deepEqual(timer.seconds(), { long: 120 });
  timer.enter('next');
  timer.enter('long');
  clock.wait(30_000);
  assert.deepEqual(timer.seconds(), { long: 150 });
});

test('re-entering the same step continues the visit instead of resetting the cap', () => {
  const clock = clockAt();
  const timer = createStepTimer({ now: clock.now, visitCapMs: 60_000 });
  timer.enter('step');
  clock.wait(45_000);
  timer.enter('step');
  clock.wait(45_000);
  assert.deepEqual(timer.seconds(), { step: 60 });
});

test('totals are cumulative, ignore sub-second steps and restore from saved milliseconds', () => {
  const clock = clockAt();
  const timer = createStepTimer({ now: clock.now });
  timer.load({ intro: 12_400, broken: 'x', negative: -5, '': 10_000 });
  timer.enter('glance');
  clock.wait(400);
  timer.enter('intro');
  clock.wait(1_000);
  assert.deepEqual(timer.seconds(), { intro: 13 });
  assert.deepEqual(timer.milliseconds(), { intro: 13_400, glance: 400 });
  timer.reset();
  clock.wait(3_000);
  assert.deepEqual(timer.seconds(), { intro: 3 });
});
