(function () {
  'use strict';

  var PREFIX = 'lp_ui_v2:';

  function toKey(key) {
    return PREFIX + String(key || '').trim();
  }

  function readRaw(key) {
    try {
      return window.localStorage.getItem(toKey(key));
    } catch (_) {
      return null;
    }
  }

  function writeRaw(key, value) {
    try {
      window.localStorage.setItem(toKey(key), String(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function remove(key) {
    try {
      window.localStorage.removeItem(toKey(key));
      return true;
    } catch (_) {
      return false;
    }
  }

  function getJson(key, fallbackValue) {
    var raw = readRaw(key);
    if (!raw) return fallbackValue;
    try {
      return JSON.parse(raw);
    } catch (_) {
      return fallbackValue;
    }
  }

  function setJson(key, value) {
    try {
      return writeRaw(key, JSON.stringify(value));
    } catch (_) {
      return false;
    }
  }

  function getString(key, fallbackValue) {
    var raw = readRaw(key);
    if (raw === null || raw === undefined || raw === '') return fallbackValue;
    return raw;
  }

  function setString(key, value) {
    return writeRaw(key, value);
  }

  window.LectureProcessorUiCache = {
    prefix: PREFIX,
    getJson: getJson,
    setJson: setJson,
    getString: getString,
    setString: setString,
    remove: remove,
  };
})();
