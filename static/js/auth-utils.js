(function (global) {
  'use strict';

  function createAuthClient(auth, options) {
    var opts = options || {};
    var cachedToken = null;
    var tokenUser = null;
    var sessionRevision = 0;
    var observedUid = null;

    function getCurrentUser() {
      if (typeof opts.getCurrentUser === 'function') {
        return opts.getCurrentUser();
      }
      if (auth && auth.currentUser) {
        return auth.currentUser;
      }
      return null;
    }

    function observeIdentity() {
      var user = getCurrentUser();
      var uid = user ? String(user.uid || '') : null;
      if (observedUid !== uid) {
        observedUid = uid;
        sessionRevision += 1;
        cachedToken = null;
        tokenUser = null;
      }
      return user;
    }

    function sessionChangedError() {
      var error = new Error('Your account changed. Please try again.');
      error.code = 'auth/session-changed';
      return error;
    }

    function captureSession() {
      var user = observeIdentity();
      var revision = sessionRevision;
      var uid = user ? String(user.uid || '') : null;
      function isCurrent() {
        var current = observeIdentity();
        return revision === sessionRevision && current === user && (current ? String(current.uid || '') : null) === uid;
      }
      return {
        user: user,
        isCurrent: isCurrent,
        assertCurrent: function () { if (!isCurrent()) throw sessionChangedError(); }
      };
    }

    observeIdentity();
    // The observer also invalidates an A -> signed-out -> A transition that
    // happens while a request is waiting, even if Firebase reuses its user.
    if (auth && typeof auth.onAuthStateChanged === 'function') {
      var lastNotifiedUid = observedUid;
      auth.onAuthStateChanged(function (user) {
        var notifiedUid = user ? String(user.uid || '') : null;
        observeIdentity();
        // Firebase may queue notifications: currentUser can already be A
        // again when the intervening signed-out notification is delivered.
        if (notifiedUid !== lastNotifiedUid && notifiedUid !== observedUid) {
          sessionRevision += 1;
          cachedToken = null;
          tokenUser = null;
        }
        lastNotifiedUid = notifiedUid;
      });
    }

    function tokenForSession(session, forceRefresh) {
      return Promise.resolve().then(function () {
        session.assertCurrent();
        if (!session.user || typeof session.user.getIdToken !== 'function') {
          throw new Error(opts.notSignedInMessage || 'Not signed in');
        }
        // Firebase already caches tokens for their owner. Never reuse a token
        // supplied by a different caller or by an earlier account.
        return session.user.getIdToken(!!forceRefresh);
      }).then(function (token) {
        session.assertCurrent();
        cachedToken = token || null;
        tokenUser = session.user;
        return cachedToken;
      });
    }

    function ensureToken(forceRefresh) {
      return tokenForSession(captureSession(), forceRefresh);
    }

    function guardResponse(response, session) {
      // Account changes can occur after headers arrive but before a large JSON
      // or file body finishes. Do not deliver that old account's body either.
      ['json', 'text', 'blob', 'arrayBuffer', 'formData', 'bytes'].forEach(function (method) {
        if (typeof response[method] !== 'function') return;
        var read = response[method].bind(response);
        response[method] = function () {
          return Promise.resolve().then(function () {
            session.assertCurrent();
            return read();
          }).then(function (body) {
            session.assertCurrent();
            return body;
          });
        };
      });
      if (typeof response.clone === 'function') {
        var clone = response.clone.bind(response);
        response.clone = function () {
          session.assertCurrent();
          return guardResponse(clone(), session);
        };
      }
      return response;
    }

    function buildHeaders(baseHeaders, token, setJsonContentType, body) {
      var headers = Object.assign({}, baseHeaders || {});
      headers.Authorization = 'Bearer ' + token;
      var isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
      if (setJsonContentType && body && !isFormData && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
      return headers;
    }

    function authFetch(url, options, fetchOptions) {
      var requestOptions = options || {};
      var settings = fetchOptions || {};
      var retryOn401 = settings.retryOn401 !== false;
      var ensureJsonContentType = !!settings.ensureJsonContentType;
      var session = captureSession();

      function send(forceRefresh) {
        return tokenForSession(session, forceRefresh)
        .then(function (token) {
          session.assertCurrent();
          return fetch(url, Object.assign({}, requestOptions, {
            headers: buildHeaders(requestOptions.headers, token, ensureJsonContentType, requestOptions.body)
          }));
        });
      }

      return send(false)
        .then(function (response) {
          session.assertCurrent();
          if (response.status === 401 && retryOn401) {
            return send(true);
          }
          return response;
        }).then(function (response) {
          session.assertCurrent();
          return guardResponse(response, session);
        });
    }

    function setToken(token) {
      // Compatibility for older pages. Only tokenForSession may populate the
      // snapshot: a manually supplied token may belong to a previous user.
      if (!token) clearToken();
      return getToken();
    }

    function clearToken() {
      cachedToken = null;
      tokenUser = null;
    }

    function getToken() {
      var user = observeIdentity();
      return user && tokenUser === user ? cachedToken : null;
    }

    return {
      authFetch: authFetch,
      ensureToken: ensureToken,
      setToken: setToken,
      clearToken: clearToken,
      getToken: getToken,
      captureSession: captureSession,
    };
  }

  function getCurrentReturnPath() {
    var location = global.location || {};
    var pathname = String(location.pathname || '/');
    var search = String(location.search || '');
    var hash = String(location.hash || '');
    return pathname + search + hash;
  }

  function normalizeReturnPath(nextPath) {
    var safePath = String(nextPath || getCurrentReturnPath() || '/').trim();
    if (!safePath || safePath.charAt(0) !== '/' || safePath.indexOf('//') === 0) {
      return '/';
    }
    return safePath;
  }

  function buildSignInUrl(nextPath, authView) {
    var view = String(authView || 'signin').trim().toLowerCase();
    if (view !== 'signin' && view !== 'signup' && view !== 'reset') {
      view = 'signin';
    }
    return '/lecture-notes?auth=' + encodeURIComponent(view)
      + '&next=' + encodeURIComponent(normalizeReturnPath(nextPath));
  }

  function updateSignInLinks(root) {
    var container = root || global.document;
    if (!container || typeof container.querySelectorAll !== 'function') return;
    Array.prototype.slice.call(container.querySelectorAll('a[href="/lecture-notes?auth=signin"], a[data-sign-in-return]')).forEach(function (link) {
      var nextPath = link.getAttribute('data-sign-in-return') || getCurrentReturnPath();
      link.href = buildSignInUrl(nextPath, 'signin');
    });
  }

  global.LectureProcessorAuth = {
    createAuthClient: createAuthClient,
    buildSignInUrl: buildSignInUrl,
    getCurrentReturnPath: getCurrentReturnPath,
    normalizeReturnPath: normalizeReturnPath,
    updateSignInLinks: updateSignInLinks,
  };
})(window);
