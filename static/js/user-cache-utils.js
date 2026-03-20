(function (global) {
  'use strict';

  function getStoragePrefix() {
    return 'lp_ui_v2:';
  }

  function buildStorageKey(key) {
    return getStoragePrefix() + String(key || '');
  }

  function getJson(key, fallbackValue, uiCache) {
    if (uiCache && typeof uiCache.getJson === 'function') {
      return uiCache.getJson(key, fallbackValue);
    }
    try {
      var raw = global.localStorage ? global.localStorage.getItem(buildStorageKey(key)) : null;
      return raw ? JSON.parse(raw) : fallbackValue;
    } catch (_) {
      return fallbackValue;
    }
  }

  function setJson(key, value, uiCache) {
    if (uiCache && typeof uiCache.setJson === 'function') {
      return uiCache.setJson(key, value);
    }
    try {
      if (!global.localStorage) return false;
      global.localStorage.setItem(buildStorageKey(key), JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function getString(key, fallbackValue, uiCache) {
    if (uiCache && typeof uiCache.getString === 'function') {
      return uiCache.getString(key, fallbackValue);
    }
    try {
      if (!global.localStorage) return fallbackValue;
      var raw = global.localStorage.getItem(buildStorageKey(key));
      return raw === null ? fallbackValue : raw;
    } catch (_) {
      return fallbackValue;
    }
  }

  function setString(key, value, uiCache) {
    if (uiCache && typeof uiCache.setString === 'function') {
      return uiCache.setString(key, value);
    }
    try {
      if (!global.localStorage) return false;
      global.localStorage.setItem(buildStorageKey(key), String(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function remove(key, uiCache) {
    if (uiCache && typeof uiCache.remove === 'function') {
      return uiCache.remove(key);
    }
    try {
      if (!global.localStorage) return false;
      global.localStorage.removeItem(buildStorageKey(key));
      return true;
    } catch (_) {
      return false;
    }
  }

  function normalizeUserId(userOrUid) {
    var uid = userOrUid && typeof userOrUid === 'object' ? userOrUid.uid : userOrUid;
    return String(uid || '').trim();
  }

  function buildUserScopedKey(userOrUid, key) {
    var safeUid = normalizeUserId(userOrUid);
    if (!safeUid) return '';
    return 'user:' + safeUid + ':' + String(key || '');
  }

  function getUserJson(userOrUid, key, fallbackValue, uiCache) {
    var scopedKey = buildUserScopedKey(userOrUid, key);
    if (!scopedKey) return fallbackValue;
    if (uiCache && typeof uiCache.getUserJson === 'function') {
      return uiCache.getUserJson(normalizeUserId(userOrUid), key, fallbackValue);
    }
    return getJson(scopedKey, fallbackValue, uiCache);
  }

  function setUserJson(userOrUid, key, value, uiCache) {
    var scopedKey = buildUserScopedKey(userOrUid, key);
    if (!scopedKey) return false;
    if (uiCache && typeof uiCache.setUserJson === 'function') {
      return uiCache.setUserJson(normalizeUserId(userOrUid), key, value);
    }
    return setJson(scopedKey, value, uiCache);
  }

  function clearUserScope(userOrUid, keys, uiCache) {
    var safeUid = normalizeUserId(userOrUid);
    if (!safeUid) return false;
    if (uiCache && typeof uiCache.clearUserScope === 'function') {
      uiCache.clearUserScope(safeUid);
      return true;
    }
    (Array.isArray(keys) ? keys : []).forEach(function (key) {
      remove('user:' + safeUid + ':' + String(key || ''), uiCache);
    });
    return true;
  }

  var exported = {
    buildUserScopedKey: buildUserScopedKey,
    clearUserScope: clearUserScope,
    getJson: getJson,
    getString: getString,
    getUserJson: getUserJson,
    remove: remove,
    setJson: setJson,
    setString: setString,
    setUserJson: setUserJson,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  global.LectureProcessorUserCache = Object.assign({}, global.LectureProcessorUserCache || {}, exported);
})(typeof window !== 'undefined' ? window : globalThis);
