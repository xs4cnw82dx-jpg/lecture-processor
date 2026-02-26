(function (global) {
  'use strict';

  function hasOption(options, key) {
    return Object.prototype.hasOwnProperty.call(options || {}, key);
  }

  function optionOr(options, key, fallback) {
    return hasOption(options, key) ? options[key] : fallback;
  }

  function safeSetText(element, text) {
    if (!element) return;
    element.textContent = String(text == null ? '' : text);
  }

  function applyAuthState(options) {
    var opts = options || {};
    var user = opts.user || null;

    var signedOutText = opts.signedOutText || 'Not signed in';
    var signedInText;
    if (typeof opts.signedInText === 'function') {
      signedInText = opts.signedInText(user);
    } else if (typeof opts.signedInText === 'string') {
      signedInText = opts.signedInText;
    } else {
      var email = user && user.email ? user.email : 'Signed in';
      signedInText = (opts.signedInPrefix || 'Signed in as ') + email;
    }

    safeSetText(opts.userTextEl, user ? signedInText : signedOutText);

    if (opts.signOutBtn) {
      opts.signOutBtn.style.display = user
        ? (opts.signOutSignedInDisplay || 'inline-flex')
        : (opts.signOutSignedOutDisplay || 'none');
    }

    if (opts.authRequiredEl) {
      opts.authRequiredEl.style.display = user
        ? (opts.authRequiredSignedInDisplay || 'none')
        : (opts.authRequiredSignedOutDisplay || 'block');
    }

    if (opts.mainContentEl) {
      opts.mainContentEl.style.display = user
        ? (opts.mainContentSignedInDisplay || 'block')
        : (opts.mainContentSignedOutDisplay || 'none');
    }
  }

  function bindSignOutButton(button, auth, redirectPath) {
    if (!button || !auth) return;
    var target = redirectPath || '/dashboard';
    button.addEventListener('click', async function () {
      try {
        await auth.signOut();
      } catch (_) {
      } finally {
        if (target) {
          window.location.href = target;
        }
      }
    });
  }

  function bindRedirectButton(button, path) {
    if (!button) return;
    var target = path || '/dashboard';
    button.addEventListener('click', function () {
      window.location.href = target;
    });
  }

  function bindAuthCta(auth, options) {
    if (!auth || typeof auth.onAuthStateChanged !== 'function') return;
    var opts = options || {};
    var labelEl = opts.labelEl || null;
    var linkEl = opts.linkEl || null;
    var signedInText = opts.signedInText || 'Dashboard';
    var signedOutText = opts.signedOutText || 'Sign in';
    var signedInHref = opts.signedInHref || '/dashboard';
    var signedOutHref = opts.signedOutHref || '/dashboard';

    auth.onAuthStateChanged(function (user) {
      if (labelEl) {
        safeSetText(labelEl, user ? signedInText : signedOutText);
      }
      if (linkEl) {
        linkEl.href = user ? signedInHref : signedOutHref;
      }
      if (typeof opts.onChange === 'function') {
        opts.onChange(user);
      }
    });
  }

  function applyProtectedPageAuthState(options) {
    var opts = options || {};
    var signedInText = opts.signedInText;
    if (!signedInText) {
      signedInText = function (activeUser) {
        return activeUser && activeUser.email ? activeUser.email : 'Signed in';
      };
    }

    applyAuthState({
      user: opts.user || null,
      userTextEl: opts.userTextEl,
      signOutBtn: opts.signOutBtn,
      authRequiredEl: opts.authRequiredEl,
      mainContentEl: opts.mainContentEl,
      signedOutText: optionOr(opts, 'signedOutText', 'Not signed in'),
      signedInText: signedInText,
      signOutSignedOutDisplay: optionOr(opts, 'signOutSignedOutDisplay', 'none'),
      signOutSignedInDisplay: optionOr(opts, 'signOutSignedInDisplay', 'inline-flex'),
      authRequiredSignedOutDisplay: optionOr(opts, 'authRequiredSignedOutDisplay', 'block'),
      authRequiredSignedInDisplay: optionOr(opts, 'authRequiredSignedInDisplay', 'none'),
      mainContentSignedOutDisplay: optionOr(opts, 'mainContentSignedOutDisplay', 'none'),
      mainContentSignedInDisplay: optionOr(opts, 'mainContentSignedInDisplay', 'block'),
    });
  }

  global.LectureProcessorTopbar = {
    applyAuthState: applyAuthState,
    applyProtectedPageAuthState: applyProtectedPageAuthState,
    bindAuthCta: bindAuthCta,
    bindSignOutButton: bindSignOutButton,
    bindRedirectButton: bindRedirectButton,
  };
})(window);
