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

  var authStateRecords = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
  var authStateRecordList = [];

  function authStateKey(user) {
    return user && user.uid ? ('uid:' + String(user.uid)) : 'signed-out';
  }

  function queueAuthCallback(callback, user) {
    if (global.Promise && typeof global.Promise.resolve === 'function') {
      global.Promise.resolve().then(function () {
        return callback(user || null);
      }).catch(function () {});
      return;
    }
    global.setTimeout(function () {
      try {
        callback(user || null);
      } catch (_error) {}
    }, 0);
  }

  function createAuthStateRecord(auth) {
    return {
      auth: auth,
      started: false,
      resolved: false,
      user: auth && auth.currentUser ? auth.currentUser : null,
      listeners: [],
      readyPromise: null,
      resolveReady: null,
      lastNotifiedKey: null,
      unsubscribe: null,
    };
  }

  function getAuthStateRecord(auth) {
    if (authStateRecords && auth && (typeof auth === 'object' || typeof auth === 'function')) {
      var existing = authStateRecords.get(auth);
      if (existing) return existing;
      var next = createAuthStateRecord(auth);
      authStateRecords.set(auth, next);
      return next;
    }
    for (var index = 0; index < authStateRecordList.length; index += 1) {
      if (authStateRecordList[index].auth === auth) return authStateRecordList[index];
    }
    var fallback = createAuthStateRecord(auth);
    authStateRecordList.push(fallback);
    return fallback;
  }

  function settleAuthState(record, user) {
    var nextUser = user || null;
    var firstResolution = !record.resolved;
    record.user = nextUser;
    record.resolved = true;
    if (record.resolveReady) {
      var resolve = record.resolveReady;
      record.resolveReady = null;
      resolve(nextUser);
    }

    var nextKey = authStateKey(nextUser);
    if (!firstResolution && record.lastNotifiedKey === nextKey) return;
    record.lastNotifiedKey = nextKey;
    record.listeners.slice().forEach(function (listener) {
      try {
        var result = listener(nextUser);
        if (result && typeof result.catch === 'function') {
          result.catch(function (error) {
            global.setTimeout(function () { throw error; }, 0);
          });
        }
      } catch (error) {
        global.setTimeout(function () { throw error; }, 0);
      }
    });
  }

  function startAuthStateObserver(auth, record) {
    if (record.started) {
      return record.readyPromise || global.Promise.resolve(record.user || null);
    }
    record.started = true;
    record.readyPromise = new global.Promise(function (resolve) {
      record.resolveReady = resolve;
    });

    if (!auth || typeof auth.onAuthStateChanged !== 'function') {
      settleAuthState(record, null);
      return record.readyPromise;
    }

    try {
      record.unsubscribe = auth.onAuthStateChanged(function (user) {
        settleAuthState(record, user || null);
      }, function () {
        settleAuthState(record, auth.currentUser || null);
      });
    } catch (_error) {
      settleAuthState(record, auth.currentUser || null);
      return record.readyPromise;
    }

    if (auth.currentUser) {
      settleAuthState(record, auth.currentUser);
    } else if (typeof auth.authStateReady === 'function') {
      try {
        global.Promise.resolve(auth.authStateReady()).then(function () {
          if (!record.resolved) settleAuthState(record, auth.currentUser || null);
        }).catch(function () {
          if (!record.resolved) settleAuthState(record, auth.currentUser || null);
        });
      } catch (_readyError) {
        if (!record.resolved) settleAuthState(record, auth.currentUser || null);
      }
    }

    return record.readyPromise;
  }

  function onAuthStateReady(auth, callback) {
    if (typeof callback !== 'function') return function () {};
    if (!auth) {
      queueAuthCallback(callback, null);
      return function () {};
    }

    var record = getAuthStateRecord(auth);
    var unsubscribed = false;
    var delivered = false;
    var listener = function (user) {
      if (unsubscribed) return;
      delivered = true;
      callback(user || null);
    };
    record.listeners.push(listener);
    startAuthStateObserver(auth, record);
    if (record.resolved && !delivered) {
      queueAuthCallback(listener, record.user || null);
    }
    return function () {
      unsubscribed = true;
      var index = record.listeners.indexOf(listener);
      if (index >= 0) record.listeners.splice(index, 1);
    };
  }

  function authStateReady(auth) {
    if (!auth) return global.Promise.resolve(null);
    var record = getAuthStateRecord(auth);
    return startAuthStateObserver(auth, record);
  }

  function getAuthState(auth) {
    if (!auth) return { resolved: true, user: null };
    var record = getAuthStateRecord(auth);
    startAuthStateObserver(auth, record);
    return {
      resolved: !!record.resolved,
      user: record.user || null,
    };
  }

  global.LectureProcessorBootstrap = {
    authStateReady: authStateReady,
    firebaseConfig: FIREBASE_CONFIG,
    ensureFirebaseApp: ensureFirebaseApp,
    getAuthState: getAuthState,
    getAuth: getAuth,
    onAuthStateReady: onAuthStateReady,
  };
})(window);
