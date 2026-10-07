(function (global) {
  'use strict';
  var defaults = { language: 'en', theme: 'light' };
  var value = normalize(read('lp-preferences'));
  var user = null;
  var auth = null;
  var generation = 0;
  var ready = false;
  var saving = false;
  var error = '';
  function read(key) {
    try { return JSON.parse(global.localStorage.getItem(key)); } catch (_) { return null; }
  }
  function normalize(raw) {
    raw = raw || {};
    return { language: raw.language === 'nl' ? 'nl' : 'en', theme: raw.theme === 'dark' ? 'dark' : 'light' };
  }
  function snapshot() { return Object.assign({}, value, { signedIn: !!user, ready: ready, saving: saving, error: error }); }
  function emit() { global.dispatchEvent(new CustomEvent('lp:preferences-changed', { detail: snapshot() })); }
  function apply(next) {
    value = normalize(next);
    try {
      global.localStorage.setItem('lp-preferences', JSON.stringify(value));
      if (user) global.localStorage.setItem('lp-preferences:' + user.uid, JSON.stringify(value));
    } catch (_) {}
    emit();
  }
  function isCurrent(account, version) {
    return generation === version && user === account && (!auth || auth.currentUser === account);
  }
  async function request(account, method, patch) {
    var version = generation;
    var token = await account.getIdToken();
    if (!isCurrent(account, version)) throw new Error('Account changed.');
    var response = await global.fetch('/api/user-preferences', {
      method: method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: patch ? JSON.stringify(patch) : undefined
    });
    var data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not save your settings. Please try again.');
    return { language: (data.preferences || {}).interface_language, theme: (data.preferences || {}).theme };
  }
  async function hydrate(account) {
    var version = ++generation;
    user = account;
    ready = !account;
    saving = false;
    error = '';
    if (!account) { apply(defaults); return; }
    apply(read('lp-preferences:' + account.uid) || defaults);
    try {
      var next = await request(account, 'GET');
      if (!isCurrent(account, version)) return;
      ready = true;
      apply(next);
    } catch (_) {
      if (!isCurrent(account, version)) return;
      error = 'Could not load your settings. Please try again.';
      emit();
    }
  }
  async function update(patch) {
    if (!user || !ready || saving) return false;
    if ((patch.language !== undefined && ['en', 'nl'].indexOf(patch.language) === -1)
      || (patch.theme !== undefined && ['light', 'dark'].indexOf(patch.theme) === -1)) return false;
    var account = user;
    var version = generation;
    var previous = Object.assign({}, value);
    var payload = {};
    if (patch.language !== undefined) payload.interface_language = patch.language;
    if (patch.theme !== undefined) payload.theme = patch.theme;
    saving = true;
    error = '';
    apply(Object.assign({}, value, patch));
    try {
      var saved = await request(account, 'PUT', payload);
      if (!isCurrent(account, version)) return false;
      saving = false;
      apply(saved);
      return true;
    } catch (_) {
      if (!isCurrent(account, version)) return false;
      saving = false;
      error = 'Could not save your settings. Please try again.';
      apply(previous);
      return false;
    }
  }
  global.LecturePreferences = { get: snapshot, update: update, retry: function () { return hydrate(user); } };
  global.addEventListener('storage', function (event) {
    if (!user || saving || event.key !== 'lp-preferences:' + user.uid) return;
    var next = read(event.key);
    if (next) { value = normalize(next); emit(); }
  });
  function init() {
    var bootstrap = global.LectureProcessorBootstrap;
    if (!bootstrap || !global.firebase) { ready = true; emit(); return; }
    try {
      auth = bootstrap.getAuth();
      bootstrap.onAuthStateReady(auth, hydrate);
    } catch (_) { ready = true; emit(); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})(window);
