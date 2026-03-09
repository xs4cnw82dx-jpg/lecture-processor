(function () {
  'use strict';

  var PREFIX = 'lp_ui_v2:';

  function toKey(key) {
    return PREFIX + String(key || '').trim();
  }

  function userScope(uid) {
    var safeUid = String(uid || '').trim();
    return safeUid ? ('user:' + safeUid + ':') : '';
  }

  function toUserKey(uid, key) {
    var scope = userScope(uid);
    if (!scope) return String(key || '').trim();
    return scope + String(key || '').trim();
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

  function getUserJson(uid, key, fallbackValue) {
    var safeUid = String(uid || '').trim();
    if (!safeUid) return fallbackValue;
    return getJson(toUserKey(safeUid, key), fallbackValue);
  }

  function setUserJson(uid, key, value) {
    var safeUid = String(uid || '').trim();
    if (!safeUid) return false;
    return setJson(toUserKey(safeUid, key), value);
  }

  function getUserString(uid, key, fallbackValue) {
    var safeUid = String(uid || '').trim();
    if (!safeUid) return fallbackValue;
    return getString(toUserKey(safeUid, key), fallbackValue);
  }

  function setUserString(uid, key, value) {
    var safeUid = String(uid || '').trim();
    if (!safeUid) return false;
    return setString(toUserKey(safeUid, key), value);
  }

  function removeUser(uid, key) {
    var safeUid = String(uid || '').trim();
    if (!safeUid) return false;
    return remove(toUserKey(safeUid, key));
  }

  function clearUserScope(uid) {
    var scope = userScope(uid);
    if (!scope) return false;
    try {
      var prefix = toKey(scope);
      var removals = [];
      for (var i = 0; i < window.localStorage.length; i += 1) {
        var entryKey = window.localStorage.key(i);
        if (entryKey && entryKey.indexOf(prefix) === 0) {
          removals.push(entryKey);
        }
      }
      removals.forEach(function (entryKey) {
        window.localStorage.removeItem(entryKey);
      });
      return true;
    } catch (_) {
      return false;
    }
  }

  window.LectureProcessorUiCache = {
    prefix: PREFIX,
    getJson: getJson,
    setJson: setJson,
    getString: getString,
    setString: setString,
    remove: remove,
    getUserJson: getUserJson,
    setUserJson: setUserJson,
    getUserString: getUserString,
    setUserString: setUserString,
    removeUser: removeUser,
    clearUserScope: clearUserScope,
  };
})();
