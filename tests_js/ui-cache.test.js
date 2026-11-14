const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../static/js/ui-cache.js'), 'utf8');

function fixture() {
  const values = new Map([
    ['lp_ui_v2:user:alice:dashboard', 'cached'],
    ['lp_ui_v2:user:alice:study_cache:planned:run', 'pending draft'],
    ['lp_ui_v2:user:alice:study_cache:learning:pack', 'learning position'],
    ['lp_ui_v2:user:alice:study_cache_other', 'unrelated cache'],
    ['lp_ui_v2:user:bob:dashboard', 'other account'],
  ]);
  const storage = { get length() { return values.size; }, key: index => [...values.keys()][index],
    removeItem: key => values.delete(key) };
  const context = vm.createContext({ window: { localStorage: storage } });
  vm.runInContext(source, context);
  return { cache: context.window.LectureProcessorUiCache, values };
}

test('generic user clear leaves study filtering to its owner when requested', () => {
  const { cache, values } = fixture();
  assert.equal(cache.clearUserScope('alice', { preserveStudyCache: true }), true);
  assert.deepEqual([...values.keys()], ['lp_ui_v2:user:alice:study_cache:planned:run',
    'lp_ui_v2:user:alice:study_cache:learning:pack', 'lp_ui_v2:user:bob:dashboard']);
});

test('generic user clear still removes all of its own account by default', () => {
  const { cache, values } = fixture();
  assert.equal(cache.clearUserScope('alice'), true);
  assert.deepEqual([...values.keys()], ['lp_ui_v2:user:bob:dashboard']);
});
