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
    return global.firebase.auth();
  }

  global.LectureProcessorBootstrap = {
    firebaseConfig: FIREBASE_CONFIG,
    ensureFirebaseApp: ensureFirebaseApp,
    getAuth: getAuth,
  };
})(window);
