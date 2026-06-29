(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var topbarUtils = window.LectureProcessorTopbar || {};
  var authUtils = window.LectureProcessorAuth || {};
  var authBtn = document.getElementById('public-auth-btn');
  var authLabel = document.getElementById('public-auth-label');
  var signInHref = typeof authUtils.buildSignInUrl === 'function'
    ? authUtils.buildSignInUrl()
    : '/lecture-notes?auth=signin';

  if (!auth || !authBtn || !authLabel) return;

  if (typeof topbarUtils.bindAuthCta === 'function') {
    topbarUtils.bindAuthCta(auth, {
      labelEl: authLabel,
      linkEl: authBtn,
      signedInText: 'Dashboard',
      signedOutText: 'Sign in',
      signedInHref: '/dashboard',
      signedOutHref: signInHref
    });
    return;
  }

  bootstrap.onAuthStateReady(auth, function (user) {
    authLabel.textContent = user ? 'Dashboard' : 'Sign in';
    authBtn.href = user ? '/dashboard' : signInHref;
  });
})();
