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

  global.LectureProcessorAuth = {
    createAuthClient: createAuthClient,
  };
})(window);
