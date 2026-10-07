const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync('static/js/theme.js', 'utf8');
function boot(stored, blocked = false, companionUrl = null, marker = true) {
  const listeners = {};
  const root = { dataset: companionUrl && marker ? { localCompanion: 'true' } : {} };
  const state = { stored };
  const window = { addEventListener: (name, fn) => { listeners[name] = fn; } };
  if (companionUrl) {
    window.location = new URL(companionUrl);
    window.history = { replaceState: (_state, _title, url) => { window.location = new URL(url); } };
  }
  vm.runInNewContext(source, { URL, window, document: { documentElement: root }, localStorage: {
    getItem: () => { if (blocked) throw new Error('Storage denied'); return state.stored; },
    setItem: (_key, value) => { if (blocked) throw new Error('Storage denied'); state.stored = value; }
  } });
  return { listeners, root, state, window };
}
test('appearance applies before DOM content is available and responds to saved settings', () => {
  const app = boot('{"theme":"dark","language":"nl"}');
  assert.equal(app.root.dataset.theme, 'dark');
  app.listeners['lp:preferences-changed']({ detail: { theme: 'light' } });
  assert.equal(app.root.dataset.theme, 'light');
  app.window.LPTheme.apply({ theme: 'dark' });
  assert.equal(app.root.dataset.theme, 'dark');
});
test('malformed or unavailable device storage cannot prevent the page loading', () => {
  for (const stored of ['{', 'null', '1', '"dark"', '{"theme":"unknown"}']) {
    assert.equal(boot(stored).root.dataset.theme, 'light');
  }
  assert.equal(boot('', true).root.dataset.theme, 'light');
});
test('cross-tab appearance updates and cleared storage update the current page', () => {
  const app = boot('{"theme":"dark"}');
  app.state.stored = '{"theme":"light"}';
  app.listeners.storage({ key: 'unrelated' });
  assert.equal(app.root.dataset.theme, 'dark');
  app.listeners.storage({ key: 'lp-preferences' });
  assert.equal(app.root.dataset.theme, 'light');
  app.window.LPTheme.apply({ theme: 'dark' });
  app.state.stored = null;
  app.listeners.storage({ key: null });
  assert.equal(app.root.dataset.theme, 'light');
});

test('local companion imports only validated display values and removes them from its URL', () => {
  const app = boot('1', false, 'http://127.0.0.1:8765/physio?lp_theme=dark&lp_language=nl&unrelated=retain');
  assert.equal(app.root.dataset.theme, 'dark');
  assert.equal(JSON.parse(app.state.stored).language, 'nl');
  assert.equal(app.window.location.search, '?unrelated=retain');
  const invalid = boot('{"theme":"dark","language":"nl"}', false, 'http://localhost:8765/physio?lp_theme=evil&lp_language=other');
  assert.equal(invalid.root.dataset.theme, 'dark');
  assert.equal(JSON.parse(invalid.state.stored).language, 'nl');
  assert.equal(boot('{}', true, 'http://localhost:8765/physio?lp_theme=dark').root.dataset.theme, 'dark');
});
test('appearance query parameters are never imported on the hosted website or ordinary pages', () => {
  assert.equal(boot('{}', false, 'https://lectureprocessor.com/physio?lp_theme=dark').root.dataset.theme, 'light');
  assert.equal(boot('{}', false, 'http://localhost:8765/physio?lp_theme=dark', false).root.dataset.theme, 'light');
});

test('signed-in appearance follows the account controller, not another account device cache', () => {
  const app = boot('{"theme":"dark"}');
  app.window.LecturePreferences = { get: () => ({ signedIn: true }) };
  app.state.stored = '{"theme":"light"}';
  app.listeners.storage({ key: 'lp-preferences' });
  assert.equal(app.root.dataset.theme, 'dark');
  app.listeners['lp:preferences-changed']({ detail: { theme: 'light' } });
  assert.equal(app.root.dataset.theme, 'light');
});
