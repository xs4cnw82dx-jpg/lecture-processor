(function (root) {
  'use strict';

  function withAuthHeaders(opts, activeToken) {
    var requestOptions = opts || {};
    var headers = Object.assign({}, requestOptions.headers || {}, {
      Authorization: 'Bearer ' + String(activeToken || ''),
    });
    var isFormData = typeof FormData !== 'undefined' && requestOptions.body instanceof FormData;
    if (requestOptions.body && !isFormData && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    return Object.assign({}, requestOptions, { headers: headers });
  }

  function createStudyApiClient(options) {
    var settings = options && typeof options === 'object' ? options : {};
    var authClient = settings.authClient || null;
    var auth = settings.auth || null;
    var fetchImpl = typeof settings.fetchImpl === 'function'
      ? settings.fetchImpl
      : function () { return root.fetch.apply(root, arguments); };
    var getToken = typeof settings.getToken === 'function' ? settings.getToken : function () { return ''; };
    var setToken = typeof settings.setToken === 'function' ? settings.setToken : function () { };

    function ensureAuthToken(forceRefresh) {
      if (authClient && typeof authClient.ensureToken === 'function') {
        return authClient.ensureToken(!!forceRefresh).then(function (nextToken) {
          setToken(nextToken);
          return nextToken;
        });
      }
      if (!auth || !auth.currentUser) {
        return Promise.reject(new Error('Please sign in'));
      }
      var cachedToken = String(getToken() || '');
      if (cachedToken && !forceRefresh) {
        return Promise.resolve(cachedToken);
      }
      return auth.currentUser.getIdToken(!!forceRefresh).then(function (nextToken) {
        setToken(nextToken);
        return nextToken;
      });
    }

    function performAuthenticatedFetch(path, requestOptions, allowRefresh) {
      if (authClient && typeof authClient.authFetch === 'function') {
        return authClient.authFetch(path, requestOptions, {
          retryOn401: allowRefresh !== false,
          ensureJsonContentType: true,
        }).then(function (response) {
          if (typeof authClient.getToken === 'function') {
            var latestToken = authClient.getToken();
            if (latestToken) {
              setToken(latestToken);
            }
          }
          return response;
        });
      }

      return ensureAuthToken(false).then(function (activeToken) {
        return fetchImpl(path, withAuthHeaders(requestOptions, activeToken));
      }).then(function (response) {
        if (response.status === 401 && allowRefresh !== false) {
          return ensureAuthToken(true).then(function (refreshedToken) {
            return fetchImpl(path, withAuthHeaders(requestOptions, refreshedToken));
          });
        }
        return response;
      });
    }

    function apiCall(path, requestOptions) {
      return performAuthenticatedFetch(path, requestOptions, true).then(function (response) {
        var contentType = response.headers.get('content-type') || '';
        var isJson = contentType.indexOf('application/json') >= 0;
        return (isJson ? response.json() : Promise.resolve(null)).then(function (data) {
          if (!response.ok) {
            if (response.status === 401) {
              throw new Error('Session expired. Please sign in again.');
            }
            throw new Error((data && data.error) || 'Request failed');
          }
          return data;
        });
      });
    }

    function authenticatedFetch(path, requestOptions, allowRefresh) {
      return performAuthenticatedFetch(path, requestOptions, allowRefresh !== false);
    }

    return {
      apiCall: apiCall,
      authenticatedFetch: authenticatedFetch,
      ensureAuthToken: ensureAuthToken,
      performAuthenticatedFetch: performAuthenticatedFetch,
    };
  }

  function downloadStudyPackSource(packId, type, format, options) {
    var settings = options && typeof options === 'object' ? options : {};
    var authenticatedFetch = settings.authenticatedFetch;
    var downloadUtils = settings.downloadUtils || {};
    if (typeof authenticatedFetch !== 'function') {
      return Promise.reject(new Error('Authenticated fetch is unavailable.'));
    }

    var safeType = type === 'transcript' ? 'transcript' : 'slides';
    var safeFormat = format === 'docx' ? 'docx' : 'md';
    var fallback = 'study-pack-' + packId + '-' + safeType + '.' + safeFormat;
    var path = '/api/study-packs/' + encodeURIComponent(packId)
      + '/export-source?type=' + encodeURIComponent(safeType)
      + '&format=' + encodeURIComponent(safeFormat);

    return authenticatedFetch(path).then(function (response) {
      if (!response.ok) {
        return response.json().catch(function () { return {}; }).then(function (payload) {
          throw new Error(payload.error || 'Could not export source output');
        });
      }
      if (typeof downloadUtils.downloadResponseBlob === 'function') {
        return downloadUtils.downloadResponseBlob(response, fallback);
      }
      return response.blob().then(function (blob) {
        if (typeof downloadUtils.saveBlobAsFile === 'function') {
          downloadUtils.saveBlobAsFile(blob, fallback);
          return fallback;
        }
        var url = URL.createObjectURL(blob);
        var anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = fallback;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        URL.revokeObjectURL(url);
        return fallback;
      });
    });
  }

  var exported = {
    createStudyApiClient: createStudyApiClient,
    downloadStudyPackSource: downloadStudyPackSource,
    withAuthHeaders: withAuthHeaders,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  root.LectureProcessorStudyApi = Object.assign({}, root.LectureProcessorStudyApi || {}, exported);
})(typeof window !== 'undefined' ? window : globalThis);
