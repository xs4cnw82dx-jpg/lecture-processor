(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var uiCache = window.LectureProcessorUiCache || null;
  if (!auth) return;

  var shell = document.getElementById('app-shell');
  var menuBtn = document.getElementById('app-shell-menu-btn');
  var overlay = document.getElementById('app-shell-overlay');
  var signInBtn = document.getElementById('shell-sign-in-btn');
  var creditsLink = document.getElementById('shell-credits-link');
  var creditsTotalLabel = document.getElementById('shell-credits-total');
  var creditsTooltip = document.getElementById('shell-credits-tooltip');
  var creditsLectureValue = document.getElementById('shell-credit-lecture');
  var creditsTextValue = document.getElementById('shell-credit-text');
  var creditsInterviewValue = document.getElementById('shell-credit-interview');
  var creditsTotalValue = document.getElementById('shell-credit-total');
  var accountWrap = document.getElementById('shell-account');
  var accountBtn = document.getElementById('shell-account-btn');
  var accountMenu = document.getElementById('shell-account-menu');
  var userEmail = document.getElementById('user-email');
  var userName = document.getElementById('shell-account-name');
  var userInitial = document.getElementById('shell-account-initial');
  var purchaseHistoryBtn = document.getElementById('shell-purchase-history-btn');
  var adminBtn = document.getElementById('shell-admin-btn');
  var exportDataBtn = document.getElementById('shell-export-data-btn');
  var signOutBtn = document.getElementById('signout-btn');
  var toolsGroup = document.getElementById('shell-tools-group');
  var toolsGroupSummary = toolsGroup ? toolsGroup.querySelector('summary') : null;
  var batchGroup = document.getElementById('shell-batch-group');
  var batchGroupSummary = batchGroup ? batchGroup.querySelector('summary') : null;
  var exportOverlay = document.getElementById('shell-export-overlay');
  var exportCloseBtn = document.getElementById('shell-export-close');
  var exportCancelBtn = document.getElementById('shell-export-cancel');
  var exportConfirmBtn = document.getElementById('shell-export-confirm');
  var exportCheckboxes = Array.prototype.slice.call(document.querySelectorAll('[data-export-key]'));
  var shellToast = document.getElementById('shell-toast');
  var CACHE_KEYS = {
    credits: 'credits_breakdown',
    toolsExpanded: 'tools_group_expanded',
    batchExpanded: 'batch_group_expanded'
  };

  var currentUserIsAdmin = false;
  var toastTimer = null;

  function normalizePath(pathname) {
    var normalized = String(pathname || '/').replace(/\/+$/, '');
    return normalized || '/';
  }

  function readCacheJson(key, fallbackValue) {
    if (uiCache && typeof uiCache.getJson === 'function') {
      return uiCache.getJson(key, fallbackValue);
    }
    try {
      var raw = window.localStorage.getItem('lp_ui_v2:' + key);
      return raw ? JSON.parse(raw) : fallbackValue;
    } catch (_) {
      return fallbackValue;
    }
  }

  function writeCacheJson(key, value) {
    if (uiCache && typeof uiCache.setJson === 'function') {
      return uiCache.setJson(key, value);
    }
    try {
      window.localStorage.setItem('lp_ui_v2:' + key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function readCacheString(key, fallbackValue) {
    if (uiCache && typeof uiCache.getString === 'function') {
      return uiCache.getString(key, fallbackValue);
    }
    try {
      var raw = window.localStorage.getItem('lp_ui_v2:' + key);
      return raw === null ? fallbackValue : raw;
    } catch (_) {
      return fallbackValue;
    }
  }

  function writeCacheString(key, value) {
    if (uiCache && typeof uiCache.setString === 'function') {
      return uiCache.setString(key, value);
    }
    try {
      window.localStorage.setItem('lp_ui_v2:' + key, String(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  function showToast(message, variant) {
    if (!shellToast || !message) return;
    shellToast.textContent = String(message);
    shellToast.classList.remove('error');
    if (variant === 'error') shellToast.classList.add('error');
    shellToast.classList.add('visible');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      shellToast.classList.remove('visible');
    }, 2600);
  }

  function setSidebarOpen(open) {
    if (!shell) return;
    shell.classList.toggle('sidebar-open', !!open);
    if (menuBtn) menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function setAccountMenuOpen(open) {
    if (!accountMenu || !accountBtn) return;
    accountMenu.classList.toggle('visible', !!open);
    accountBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function syncToolsGroupAria() {
    if (!toolsGroup || !toolsGroupSummary) return;
    toolsGroupSummary.setAttribute('aria-expanded', toolsGroup.open ? 'true' : 'false');
  }

  function syncBatchGroupAria() {
    if (!batchGroup || !batchGroupSummary) return;
    batchGroupSummary.setAttribute('aria-expanded', batchGroup.open ? 'true' : 'false');
  }

  function markActiveNav() {
    var currentPath = normalizePath(window.location.pathname || '/');
    var navLinks = Array.prototype.slice.call(document.querySelectorAll('.app-shell-link[href]'));
    var hasActiveChild = false;
    var hasActiveBatchChild = false;

    navLinks.forEach(function (link) {
      var href = normalizePath(link.getAttribute('href') || '/');
      var active = href === currentPath || (href === '/plan' && currentPath === '/stats');
      link.classList.toggle('active', !!active);
      if (active && link.classList.contains('sub')) hasActiveChild = true;
      if (active && link.classList.contains('nested')) hasActiveBatchChild = true;
    });

    hydrateToolsGroupState(hasActiveChild);
    hydrateBatchGroupState(hasActiveBatchChild);
    syncToolsGroupAria();
    syncBatchGroupAria();
    if (batchGroupSummary) batchGroupSummary.classList.toggle('active', hasActiveBatchChild);
  }

  function hydrateToolsGroupState(hasActiveChild) {
    if (!toolsGroup) return;
    var stored = readCacheString(CACHE_KEYS.toolsExpanded, '');
    if (stored === '1') {
      toolsGroup.open = true;
      return;
    }
    if (stored === '0') {
      toolsGroup.open = false;
      return;
    }
    if (hasActiveChild) {
      toolsGroup.open = true;
    }
  }

  function hydrateBatchGroupState(hasActiveChild) {
    if (!batchGroup) return;
    var stored = readCacheString(CACHE_KEYS.batchExpanded, '');
    if (stored === '1') {
      batchGroup.open = true;
      return;
    }
    if (stored === '0') {
      batchGroup.open = false;
      return;
    }
    if (hasActiveChild) {
      batchGroup.open = true;
    }
  }

  function parseCreditBreakdown(payload) {
    var credits = payload && payload.credits ? payload.credits : {};
    var lecture = Number(credits.lecture_standard || 0) + Number(credits.lecture_extended || 0);
    var textExtraction = Number(credits.slides || 0);
    var interview = Number(credits.interview_short || 0) + Number(credits.interview_medium || 0) + Number(credits.interview_long || 0);
    return {
      lecture: lecture,
      textExtraction: textExtraction,
      interview: interview,
      total: lecture + textExtraction + interview
    };
  }

  function applyCreditBreakdown(breakdown) {
    if (!creditsTotalLabel) return;
    if (!breakdown) {
      creditsTotalLabel.textContent = '\u2014 credits';
      if (creditsLectureValue) creditsLectureValue.textContent = '\u2014';
      if (creditsTextValue) creditsTextValue.textContent = '\u2014';
      if (creditsInterviewValue) creditsInterviewValue.textContent = '\u2014';
      if (creditsTotalValue) creditsTotalValue.textContent = '\u2014';
      return;
    }
    var next = {
      lecture: Number(breakdown.lecture || 0),
      textExtraction: Number(breakdown.textExtraction || 0),
      interview: Number(breakdown.interview || 0),
      total: Number(breakdown.total || 0)
    };
    creditsTotalLabel.textContent = next.total + ' credits';
    if (creditsLectureValue) creditsLectureValue.textContent = String(next.lecture);
    if (creditsTextValue) creditsTextValue.textContent = String(next.textExtraction);
    if (creditsInterviewValue) creditsInterviewValue.textContent = String(next.interview);
    if (creditsTotalValue) creditsTotalValue.textContent = String(next.total);
  }

  async function authFetch(path, options) {
    var user = auth.currentUser;
    if (!user) throw new Error('Please sign in');
    var token = await user.getIdToken();
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
    return fetch(path, Object.assign({}, opts, { headers: headers }));
  }

  function getDispositionFilename(disposition, fallback) {
    var source = String(disposition || '');
    var matched = source.match(/filename\*=(?:UTF-8'')?([^;]+)/i);
    if (matched && matched[1]) return decodeURIComponent(matched[1]).replace(/^["']|["']$/g, '');
    matched = source.match(/filename=\"?([^\";]+)\"?/i);
    if (matched && matched[1]) return matched[1];
    return fallback;
  }

  function triggerBlobDownload(blob, filename) {
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    window.setTimeout(function () {
      URL.revokeObjectURL(link.href);
    }, 1200);
  }

  async function refreshUserProfile(user) {
    if (!user) return;
    try {
      var response = await authFetch('/api/auth/user');
      if (!response.ok) return;
      var payload = await response.json();
      var breakdown = parseCreditBreakdown(payload);
      currentUserIsAdmin = !!payload.is_admin;
      applyCreditBreakdown(breakdown);
      writeCacheJson(CACHE_KEYS.credits, breakdown);
      if (adminBtn) adminBtn.style.display = currentUserIsAdmin ? '' : 'none';
    } catch (_) {}
  }

  function applySignedOutState() {
    currentUserIsAdmin = false;
    if (adminBtn) adminBtn.style.display = 'none';
    if (creditsLink) creditsLink.classList.remove('is-open');
    if (userEmail) userEmail.textContent = 'Not signed in';
    if (userName) userName.textContent = 'Account';
    if (userInitial) userInitial.textContent = '?';
  }

  function applyAuth(user) {
    var signedIn = !!user;
    if (signInBtn) signInBtn.hidden = signedIn;
    if (accountWrap) accountWrap.hidden = !signedIn;
    if (!signedIn) {
      applySignedOutState();
      return;
    }

    var email = String(user.email || 'user').trim();
    if (userEmail) userEmail.textContent = email;
    if (userName) userName.textContent = email.split('@')[0] || 'Account';
    if (userInitial) userInitial.textContent = (email.charAt(0) || '?').toUpperCase();
    refreshUserProfile(user);
  }

  function setExportModalOpen(open) {
    if (!exportOverlay) return;
    exportOverlay.hidden = !open;
    if (open) {
      setAccountMenuOpen(false);
      if (exportConfirmBtn) exportConfirmBtn.focus();
      return;
    }
    if (exportDataBtn) exportDataBtn.focus();
  }

  function readExportSelection() {
    var include = {};
    exportCheckboxes.forEach(function (item) {
      var key = item.getAttribute('data-export-key');
      if (!key) return;
      include[key] = !!item.checked;
    });
    return include;
  }

  function hasAnySelection(include) {
    return Object.keys(include).some(function (key) { return !!include[key]; });
  }

  function setupRoutePrefetch() {
    var links = Array.prototype.slice.call(document.querySelectorAll('.app-shell-link[href]'));
    var prefetched = Object.create(null);
    links.forEach(function (link) {
      var href = String(link.getAttribute('href') || '').trim();
      if (!href || href.charAt(0) !== '/' || prefetched[href]) return;
      var triggerPrefetch = function () {
        if (prefetched[href]) return;
        prefetched[href] = true;
        try {
          var prefetch = document.createElement('link');
          prefetch.rel = 'prefetch';
          prefetch.href = href;
          prefetch.as = 'document';
          document.head.appendChild(prefetch);
        } catch (_) {}
      };
      link.addEventListener('mouseenter', triggerPrefetch, { once: true });
      link.addEventListener('focus', triggerPrefetch, { once: true });
    });
  }

  async function runBundleExport() {
    if (!auth.currentUser) {
      showToast('Please sign in to export your data.', 'error');
      return;
    }
    var include = readExportSelection();
    if (!hasAnySelection(include)) {
      showToast('Choose at least one export option.', 'error');
      return;
    }
    if (exportConfirmBtn) exportConfirmBtn.disabled = true;
    try {
      var response = await authFetch('/api/account/export-bundle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'account', include: include })
      });
      if (!response.ok) {
        var fallbackResponse = null;
        if (response.status === 404 && include.account_json && !include.flashcards_csv && !include.practice_tests_csv && !include.lecture_notes_docx && !include.lecture_notes_pdf_marked && !include.lecture_notes_pdf_unmarked) {
          fallbackResponse = await authFetch('/api/account/export');
        }
        if (!fallbackResponse || !fallbackResponse.ok) throw new Error('Could not export data');
        var fallbackBlob = await fallbackResponse.blob();
        var fallbackName = getDispositionFilename(fallbackResponse.headers.get('Content-Disposition'), 'lecture-processor-account-export.json');
        triggerBlobDownload(fallbackBlob, fallbackName);
        showToast('Legacy JSON export downloaded.');
        setExportModalOpen(false);
        return;
      }

      var blob = await response.blob();
      var filename = getDispositionFilename(response.headers.get('Content-Disposition'), 'lecture-processor-export.zip');
      triggerBlobDownload(blob, filename);
      showToast('Export ZIP download started.');
      setExportModalOpen(false);
    } catch (_) {
      showToast('Could not export data right now.', 'error');
    } finally {
      if (exportConfirmBtn) exportConfirmBtn.disabled = false;
    }
  }

  if (toolsGroup) {
    toolsGroup.addEventListener('toggle', function () {
      syncToolsGroupAria();
      writeCacheString(CACHE_KEYS.toolsExpanded, toolsGroup.open ? '1' : '0');
    });
  }

  if (batchGroup) {
    batchGroup.addEventListener('toggle', function () {
      syncBatchGroupAria();
      writeCacheString(CACHE_KEYS.batchExpanded, batchGroup.open ? '1' : '0');
    });
  }

  if (menuBtn) {
    menuBtn.addEventListener('click', function () {
      var next = !(shell && shell.classList.contains('sidebar-open'));
      setSidebarOpen(next);
    });
  }

  if (overlay) {
    overlay.addEventListener('click', function () {
      setSidebarOpen(false);
    });
  }

  if (signInBtn) {
    signInBtn.addEventListener('click', function () {
      window.location.href = '/dashboard';
    });
  }

  if (accountBtn && accountMenu) {
    accountBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      var next = !accountMenu.classList.contains('visible');
      setAccountMenuOpen(next);
    });
  }

  if (creditsLink && creditsTooltip) {
    creditsLink.addEventListener('click', function (event) {
      if (!creditsLink.classList.contains('is-open')) {
        event.preventDefault();
        creditsLink.classList.add('is-open');
      } else {
        creditsLink.classList.remove('is-open');
      }
    });
  }

  if (purchaseHistoryBtn) {
    purchaseHistoryBtn.addEventListener('click', function () {
      setAccountMenuOpen(false);
      window.location.href = '/buy_credits#purchase-history';
    });
  }

  if (adminBtn) {
    adminBtn.addEventListener('click', async function () {
      setAccountMenuOpen(false);
      if (!auth.currentUser || !currentUserIsAdmin) {
        showToast('Admin access is only available for configured admin users.', 'error');
        return;
      }
      try {
        var response = await authFetch('/api/session/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        if (!response.ok) throw new Error('Could not start admin session');
        window.location.href = '/admin';
      } catch (_) {
        showToast('Could not open admin dashboard right now.', 'error');
      }
    });
  }

  if (exportDataBtn) {
    exportDataBtn.addEventListener('click', function () {
      if (!auth.currentUser) {
        setAccountMenuOpen(false);
        showToast('Please sign in to export your data.', 'error');
        return;
      }
      setExportModalOpen(true);
    });
  }

  if (exportConfirmBtn) {
    exportConfirmBtn.addEventListener('click', runBundleExport);
  }

  if (exportCloseBtn) {
    exportCloseBtn.addEventListener('click', function () {
      setExportModalOpen(false);
    });
  }

  if (exportCancelBtn) {
    exportCancelBtn.addEventListener('click', function () {
      setExportModalOpen(false);
    });
  }

  if (exportOverlay) {
    exportOverlay.addEventListener('click', function (event) {
      if (event.target === exportOverlay) setExportModalOpen(false);
    });
  }

  if (signOutBtn) {
    signOutBtn.addEventListener('click', async function () {
      try {
        await fetch('/api/session/logout', { method: 'POST', credentials: 'include' });
      } catch (_) {}
      try {
        await auth.signOut();
      } catch (_) {}
      window.location.href = '/dashboard';
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (exportOverlay && !exportOverlay.hidden) {
        event.preventDefault();
        setExportModalOpen(false);
      }
      setAccountMenuOpen(false);
      if (creditsLink) creditsLink.classList.remove('is-open');
    }
  });

  document.addEventListener('click', function (event) {
    if (accountWrap && !accountWrap.contains(event.target)) {
      setAccountMenuOpen(false);
    }
    if (creditsLink && !creditsLink.contains(event.target)) {
      creditsLink.classList.remove('is-open');
    }
  });

  auth.onAuthStateChanged(function (user) {
    applyAuth(user || null);
  });

  var cachedBreakdown = readCacheJson(CACHE_KEYS.credits, null);
  applyCreditBreakdown(cachedBreakdown);
  markActiveNav();
  setupRoutePrefetch();
})();
