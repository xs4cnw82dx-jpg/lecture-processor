(function () {
  'use strict';
  var uiText = typeof window !== 'undefined' && window.Xped && window.Xped.i18n ? window.Xped.i18n.t : function (message) { return message; };

  const byId = function (id) { return document.getElementById('academy-' + id); };
  const form = byId('auth-form');
  const email = byId('email');
  const password = byId('password');
  const status = byId('auth-status');
  const views = {
    signin: [uiText('Sign in'), uiText('Open your expeditions in xPEDitie Pijn Studio.'), uiText('Sign in')],
    signup: [uiText('Create an account'), uiText('Use your email address to create a Studio account.'), uiText('Create account')],
    reset: [uiText('Reset your password'), uiText('We’ll send a password reset link to your email address.'), uiText('Send reset link')],
    verify: [uiText('Verify your email'), uiText('Follow the verification link in your email to open the Studio.'), '']
  };
  let view = 'signin';
  let busy = false;
  let auth;
  try { auth = window.Xped.bootstrap.getAuth(); } catch (_) {
    byId('auth-credentials').hidden = true;
    status.textContent = uiText('Sign-in is temporarily unavailable. Reload this page to try again.');
    return;
  }

  auth.languageCode = window.Xped.i18n.language;

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
    'auth/invalid-credential': uiText('Check your email and password and try again.'),
    'auth/wrong-password': uiText('Check your email and password and try again.'),
    'auth/user-not-found': uiText('Check your email and password and try again.'),
    'auth/email-already-in-use': uiText('This email already has an account. Sign in or reset your password.'),
    'auth/weak-password': uiText('Choose a stronger password and try again.'),
    'auth/invalid-email': uiText('Enter a valid email address.'),
    'auth/popup-blocked': uiText('Allow the Google sign-in window or sign in with email.'),
    'auth/popup-closed-by-user': uiText('Google sign-in was cancelled.'),
    'auth/too-many-requests': uiText('Please wait a moment before trying again.'),
    'auth/network-request-failed': uiText('Check your connection and try again.')
  };

  async function run(action) {
    if (busy) return;
    busy = true;
    status.textContent = '';
    const buttons = document.querySelectorAll('#main-content button');
    const active = document.activeElement;
    const trigger = active?.matches('#main-content button') ? active : byId('submit');
    trigger.setAttribute('aria-busy', 'true');
    for (const button of buttons) button.disabled = true;
    try { await action(); } catch (error) {
      status.textContent = errors[error.code] || uiText('The request could not be completed. Please try again.');
    } finally {
      busy = false;
      trigger.removeAttribute('aria-busy');
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
        status.textContent = uiText('If your email has an account, check your inbox for a reset link.');
      } else if (view === 'signup') {
        const result = await auth.createUserWithEmailAndPassword(email.value.trim(), password.value);
        show('verify');
        await result.user.sendEmailVerification();
        status.textContent = uiText('Verification email sent.');
      } else {
        const result = await auth.signInWithEmailAndPassword(email.value.trim(), password.value);
        continueWithUser(result.user);
      }
    });
  });
  byId('resend').addEventListener('click', function () {
    run(async function () {
      await auth.currentUser.sendEmailVerification();
      status.textContent = uiText('Verification email sent.');
    });
  });
  byId('check').addEventListener('click', function () {
    run(async function () {
      await auth.currentUser.reload();
      if (!auth.currentUser.emailVerified) {
        status.textContent = uiText('Your email has not been verified yet. Check your inbox for the link.');
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
