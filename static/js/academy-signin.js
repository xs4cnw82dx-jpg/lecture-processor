(function () {
  'use strict';

  const byId = function (id) { return document.getElementById('academy-' + id); };
  const form = byId('auth-form');
  const email = byId('email');
  const password = byId('password');
  const status = byId('auth-status');
  const views = {
    signin: ['Sign in', 'Open your expeditions in xPEDitie Pijn Studio.', 'Sign in'],
    signup: ['Create an account', 'Use your email address to create a Studio account.', 'Create account'],
    reset: ['Reset your password', 'We’ll send a password reset link to your email address.', 'Send reset link'],
    verify: ['Verify your email', 'Follow the verification link in your email to open the Studio.', '']
  };
  let view = 'signin';
  let busy = false;
  let auth;
  try { auth = window.Xped.bootstrap.getAuth(); } catch (_) {
    byId('auth-credentials').hidden = true;
    status.textContent = 'Sign-in is temporarily unavailable. Reload this page to try again.';
    return;
  }

  function show(nextView) {
    view = nextView;
    const labels = views[view];
    byId('auth-title').textContent = labels[0];
    byId('auth-intro').textContent = labels[1];
    byId('submit').textContent = labels[2];
    byId('auth-credentials').hidden = view === 'verify';
    byId('verify').hidden = view !== 'verify';
    byId('google').hidden = view === 'reset';
    byId('signup').hidden = view !== 'signin';
    byId('reset').hidden = view !== 'signin';
    byId('login').hidden = view === 'signin';
    const hasPassword = view === 'signin' || view === 'signup';
    byId('password-label').hidden = !hasPassword;
    password.hidden = !hasPassword;
    password.required = hasPassword;
    password.autocomplete = view === 'signup' ? 'new-password' : 'current-password';
    password.value = '';
    status.textContent = '';
  }

  function continueWithUser(user) {
    if (!user) return;
    const next = new URLSearchParams(window.location.search).get('next') || '/';
    var url;
    try { url = new URL(next, window.location.origin); } catch (_) { url = new URL('/', window.location.origin); }
    var allowed = url.origin === window.location.origin && (
      ['/', '/instellingen', '/account', '/team', '/vertalingen', '/resultaten', '/expedities', '/physio/elearning'].includes(url.pathname)
      || url.pathname.startsWith('/expedities/') || url.pathname.startsWith('/physio/elearning/')
    );
    const accountReturn = allowed && ['/account', '/instellingen'].includes(url.pathname);
    if (!user.emailVerified && !accountReturn) { show('verify'); return; }
    const target = allowed ? url.pathname + url.search + url.hash : '/';
    window.location.replace(target);
  }

  const errors = {
    'auth/invalid-credential': 'Check your email and password and try again.',
    'auth/wrong-password': 'Check your email and password and try again.',
    'auth/user-not-found': 'Check your email and password and try again.',
    'auth/email-already-in-use': 'This email already has an account. Sign in or reset your password.',
    'auth/weak-password': 'Choose a stronger password and try again.',
    'auth/invalid-email': 'Enter a valid email address.',
    'auth/popup-blocked': 'Allow the Google sign-in window or sign in with email.',
    'auth/popup-closed-by-user': 'Google sign-in was cancelled.',
    'auth/too-many-requests': 'Please wait a moment before trying again.',
    'auth/network-request-failed': 'Check your connection and try again.'
  };

  async function run(action) {
    if (busy) return;
    busy = true;
    status.textContent = '';
    const buttons = document.querySelectorAll('#main-content button');
    for (const button of buttons) button.disabled = true;
    try { await action(); } catch (error) {
      status.textContent = errors[error.code] || 'The request could not be completed. Please try again.';
    } finally {
      busy = false;
      for (const button of buttons) button.disabled = false;
    }
  }

  byId('signup').addEventListener('click', function () { show('signup'); email.focus(); });
  byId('login').addEventListener('click', function () { show('signin'); email.focus(); });
  byId('reset').addEventListener('click', function () { show('reset'); email.focus(); });
  byId('google').addEventListener('click', function () {
    run(async function () {
      const result = await auth.signInWithPopup(new window.firebase.auth.GoogleAuthProvider());
      continueWithUser(result.user);
    });
  });
  form.addEventListener('submit', function (event) {
    event.preventDefault();
    run(async function () {
      if (view === 'reset') {
        await auth.sendPasswordResetEmail(email.value.trim());
        status.textContent = 'If your email has an account, check your inbox for a reset link.';
      } else if (view === 'signup') {
        const result = await auth.createUserWithEmailAndPassword(email.value.trim(), password.value);
        show('verify');
        await result.user.sendEmailVerification();
        status.textContent = 'Verification email sent.';
      } else {
        const result = await auth.signInWithEmailAndPassword(email.value.trim(), password.value);
        continueWithUser(result.user);
      }
    });
  });
  byId('resend').addEventListener('click', function () {
    run(async function () {
      await auth.currentUser.sendEmailVerification();
      status.textContent = 'Verification email sent.';
    });
  });
  byId('check').addEventListener('click', function () {
    run(async function () {
      await auth.currentUser.reload();
      if (!auth.currentUser.emailVerified) {
        status.textContent = 'Your email has not been verified yet. Check your inbox for the link.';
        return;
      }
      await auth.currentUser.getIdToken(true);
      continueWithUser(auth.currentUser);
    });
  });
  byId('switch').addEventListener('click', function () {
    run(async function () { await auth.signOut(); show('signin'); email.focus(); });
  });
  auth.onAuthStateChanged(function (user) {
    if (busy) return;
    if (user) continueWithUser(user);
    else if (view === 'verify') show('signin');
  });
})();
