(function (global) {
  'use strict';

  function createAuthClient(auth, options) {
    var opts = options || {};
    var cachedToken = opts.initialToken || null;

    function getCurrentUser() {
      if (typeof opts.getCurrentUser === 'function') {
        return opts.getCurrentUser();
      }
      if (auth && auth.currentUser) {
        return auth.currentUser;
      }
      return null;
    }

    function ensureToken(forceRefresh) {
      var user = getCurrentUser();
      if (!user || typeof user.getIdToken !== 'function') {
        return Promise.reject(new Error(opts.notSignedInMessage || 'Not signed in'));
      }
      if (cachedToken && !forceRefresh) {
        return Promise.resolve(cachedToken);
      }
      return Promise.resolve(user.getIdToken(!!forceRefresh)).then(function (token) {
        cachedToken = token || null;
        return cachedToken;
      });
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

      return ensureToken(false)
        .then(function (token) {
          return fetch(url, Object.assign({}, requestOptions, {
            headers: buildHeaders(requestOptions.headers, token, ensureJsonContentType, requestOptions.body)
          }));
        })
        .then(function (response) {
          if (response.status === 401 && retryOn401) {
            return ensureToken(true).then(function (token) {
              return fetch(url, Object.assign({}, requestOptions, {
                headers: buildHeaders(requestOptions.headers, token, ensureJsonContentType, requestOptions.body)
              }));
            });
          }
          return response;
        });
    }

    function setToken(token) {
      cachedToken = token || null;
      return cachedToken;
    }

    function clearToken() {
      cachedToken = null;
    }

    function getToken() {
      return cachedToken;
    }

    return {
      authFetch: authFetch,
      ensureToken: ensureToken,
      setToken: setToken,
      clearToken: clearToken,
      getToken: getToken,
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
