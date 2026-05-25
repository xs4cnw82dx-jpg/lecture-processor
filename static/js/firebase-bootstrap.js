(function (global) {
  'use strict';

  var FIREBASE_CONFIG = {
    apiKey: 'AIzaSyBAAeEUCPNvP5qnqpP3M6HnFZ6vaaijUvM',
    authDomain: 'lecture-processor-cdff6.firebaseapp.com',
    projectId: 'lecture-processor-cdff6',
    storageBucket: 'lecture-processor-cdff6.firebasestorage.app',
    messagingSenderId: '374793454161',
    appId: '1:374793454161:web:c68b21590e9a1fafa32e70',
  };

  function ensureFirebaseApp() {
    if (!global.firebase) {
      throw new Error('Firebase SDK is not loaded.');
    }
    try {
      return global.firebase.app();
    } catch (_error) {
      return global.firebase.initializeApp(FIREBASE_CONFIG);
    }
  }

  function getAuth() {
    ensureFirebaseApp();
    var auth = global.firebase.auth();
    if (!auth.__lectureProcessorLocalPersistenceSet && auth.setPersistence && global.firebase.auth.Auth && global.firebase.auth.Auth.Persistence) {
      auth.__lectureProcessorLocalPersistenceSet = true;
      auth.setPersistence(global.firebase.auth.Auth.Persistence.LOCAL).catch(function () {});
    }
    return auth;
  }

  function getAuthStorageKey(auth) {
    if (!auth || !auth.app || !auth.app.options || !auth.app.name) return null;
    return 'firebase:authUser:' + String(auth.app.options.apiKey || '') + ':' + String(auth.app.name || '');
  }

  function hasPersistedAuthSession(auth) {
    try {
      if (!auth || typeof global.localStorage === 'undefined') return false;
      var key = getAuthStorageKey(auth);
      if (!key) return false;
      var raw = global.localStorage.getItem(key);
      if (!raw) return false;
      if (typeof raw !== 'string') return true;
      try {
        var parsed = JSON.parse(raw);
        return !!parsed && !!parsed.stsTokenManager && !!parsed.stsTokenManager.refreshToken;
      } catch (_error) {
        return true;
      }
    } catch (_error) {
      return false;
    }
  }

  function userAuthStateKey(user) {
    if (!user || !user.uid) return 'signed-out';
    return 'uid:' + String(user.uid);
  }

  function onAuthStateReady(auth, callback, options) {
    var opts = options || {};
    if (typeof callback !== 'function') {
      return function () {};
    }
    if (!auth || typeof auth.onAuthStateChanged !== 'function') {
      callback(null);
      return function () {};
    }

    var settled = false;
    var lastStateKey = null;
    var persistedSession = hasPersistedAuthSession(auth);
    var fallbackMs = Math.max(0, Number(opts.fallbackMs || 1200));
    var fallbackTimer = null;

    function emitIfChanged(user) {
      var nextKey = userAuthStateKey(user);
      if (nextKey === lastStateKey) return;
      lastStateKey = nextKey;
      callback(user || null);
    }

    function finalizeFromCurrentState() {
      if (settled) return;
      settled = true;
      if (fallbackTimer) {
        global.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
      emitIfChanged(auth.currentUser || null);
    }

    var unsubscribe = auth.onAuthStateChanged(function (user) {
      if (!settled) {
        if (user) {
          settled = true;
          if (fallbackTimer) {
            global.clearTimeout(fallbackTimer);
            fallbackTimer = null;
          }
          emitIfChanged(user);
          return;
        }
        if (!persistedSession) {
          settled = true;
          emitIfChanged(null);
          return;
        }
        return;
      }
      emitIfChanged(user);
    });

    if (typeof auth.authStateReady === 'function') {
      try {
        Promise.resolve(auth.authStateReady())
          .then(function () {
            finalizeFromCurrentState();
          })
          .catch(function () {
            finalizeFromCurrentState();
          });
      } catch (_error) {
        finalizeFromCurrentState();
      }
    } else if (persistedSession) {
      fallbackTimer = global.setTimeout(function () {
        finalizeFromCurrentState();
      }, fallbackMs);
    } else {
      emitIfChanged(null);
      settled = true;
    }

    return function () {
      if (typeof unsubscribe === 'function') {
        unsubscribe();
      }
      if (fallbackTimer) {
        global.clearTimeout(fallbackTimer);
        fallbackTimer = null;
      }
    };
  }

  global.LectureProcessorBootstrap = {
    firebaseConfig: FIREBASE_CONFIG,
    ensureFirebaseApp: ensureFirebaseApp,
    getAuth: getAuth,
    onAuthStateReady: onAuthStateReady,
  };
})(window);
