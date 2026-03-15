(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var uiCache = window.LectureProcessorUiCache || null;
  var uxUtils = window.LectureProcessorUx || {};
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
  var accountMenuWrap = document.getElementById('shell-account-menu-wrap');
  var accountMenu = document.getElementById('shell-account-menu');
  var userEmail = document.getElementById('user-email');
  var userName = document.getElementById('shell-account-name');
  var userInitial = document.getElementById('shell-account-initial');
  var purchaseHistoryBtn = document.getElementById('shell-purchase-history-btn');
  var adminBtn = document.getElementById('shell-admin-btn');
  var exportDataBtn = document.getElementById('shell-export-data-btn');
  var signOutBtn = document.getElementById('signout-btn');
  var physioGroup = document.getElementById('shell-physio-group');
  var shellGroups = Array.prototype.slice.call(document.querySelectorAll('.app-shell-group[data-shell-group]')).map(function (group) {
    var key = String(group.getAttribute('data-shell-group') || '').trim();
    var trigger = group.querySelector('[data-shell-group-trigger]');
    return {
      key: key,
      node: group,
      trigger: trigger
    };
  }).filter(function (group) { return !!group.key; });
  var exportOverlay = document.getElementById('shell-export-overlay');
  var exportCloseBtn = document.getElementById('shell-export-close');
  var exportCancelBtn = document.getElementById('shell-export-cancel');
  var exportConfirmBtn = document.getElementById('shell-export-confirm');
  var exportCheckboxes = Array.prototype.slice.call(document.querySelectorAll('[data-export-key]'));
  var shellToast = document.getElementById('shell-toast');
  var CACHE_KEYS = {
    credits: 'credits_breakdown',
    moreToolsExpanded: 'more_tools_group_expanded',
    profile: 'shell_profile'
  };
  var ACCOUNT_SCOPED_CACHE_KEYS = [
    CACHE_KEYS.credits,
    CACHE_KEYS.profile,
    'dashboard_summary',
    'plan_summary',
    'study_due_today'
  ];

  var currentUserIsAdmin = false;
  var lastSignedInUid = auth.currentUser && auth.currentUser.uid ? String(auth.currentUser.uid) : '';
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

  function readUserCacheJson(userOrUid, key, fallbackValue) {
    var uid = userOrUid && typeof userOrUid === 'object' ? userOrUid.uid : userOrUid;
    var safeUid = String(uid || '').trim();
    if (!safeUid) return fallbackValue;
    if (uiCache && typeof uiCache.getUserJson === 'function') {
      return uiCache.getUserJson(safeUid, key, fallbackValue);
    }
    return readCacheJson('user:' + safeUid + ':' + key, fallbackValue);
  }

  function writeUserCacheJson(userOrUid, key, value) {
    var uid = userOrUid && typeof userOrUid === 'object' ? userOrUid.uid : userOrUid;
    var safeUid = String(uid || '').trim();
    if (!safeUid) return false;
    if (uiCache && typeof uiCache.setUserJson === 'function') {
      return uiCache.setUserJson(safeUid, key, value);
    }
    return writeCacheJson('user:' + safeUid + ':' + key, value);
  }

  function removeCacheKey(key) {
    if (uiCache && typeof uiCache.remove === 'function') {
      return uiCache.remove(key);
    }
    try {
      window.localStorage.removeItem('lp_ui_v2:' + String(key || ''));
      return true;
    } catch (_) {
      return false;
    }
  }

  function clearUserScopedCaches(userOrUid) {
    var uid = userOrUid && typeof userOrUid === 'object' ? userOrUid.uid : userOrUid;
    var safeUid = String(uid || '').trim();
    if (!safeUid) return;
    if (uiCache && typeof uiCache.clearUserScope === 'function') {
      uiCache.clearUserScope(safeUid);
      return;
    }
    ACCOUNT_SCOPED_CACHE_KEYS.forEach(function (key) {
      removeCacheKey('user:' + safeUid + ':' + key);
    });
  }

  function clearLegacyAccountCaches() {
    ['credits_breakdown', 'shell_profile', 'dashboard_summary:last', 'plan_summary:last', 'study_due_today:last'].forEach(removeCacheKey);
  }

  function showToast(message, variant) {
    if (!shellToast || !message) return;
    shellToast.textContent = String(message);
    shellToast.classList.remove('error', 'success');
    if (variant === 'error') shellToast.classList.add('error');
    if (variant === 'success') shellToast.classList.add('success');
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

  function focusMenuItem(menu, direction) {
    if (!menu) return;
    var items = Array.prototype.slice.call(menu.querySelectorAll('[role="menuitem"]')).filter(function (item) {
      return !item.hasAttribute('disabled') && item.offsetParent !== null;
    });
    if (!items.length) return;
    if (direction === 'first') {
      items[0].focus();
      return;
    }
    if (direction === 'last') {
      items[items.length - 1].focus();
      return;
    }
    var currentIndex = items.indexOf(document.activeElement);
    if (currentIndex < 0) {
      items[0].focus();
      return;
    }
    if (direction === 'prev') {
      items[(currentIndex - 1 + items.length) % items.length].focus();
      return;
    }
    items[(currentIndex + 1) % items.length].focus();
  }

  function setAccountMenuOpen(open, focusMode) {
    if (!accountMenu || !accountBtn) return;
    if (accountWrap) accountWrap.classList.toggle('is-open', !!open);
    accountBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (accountMenuWrap) {
      accountMenuWrap.setAttribute('aria-hidden', open ? 'false' : 'true');
    }
    if (open && focusMode) {
      focusMenuItem(accountMenu, focusMode);
    }
  }

  function setAuthState(state) {
    if (!shell) return;
    shell.setAttribute('data-auth-state', String(state || 'pending'));
  }

  function groupCacheKey(groupKey) {
    var safeKey = String(groupKey || '').trim();
    if (!safeKey) return '';
    if (safeKey === 'more-tools') return CACHE_KEYS.moreToolsExpanded;
    return 'shell_group_open:' + safeKey;
  }

  function findShellGroup(groupKey) {
    var safeKey = String(groupKey || '').trim();
    for (var index = 0; index < shellGroups.length; index += 1) {
      if (shellGroups[index].key === safeKey) return shellGroups[index];
    }
    return null;
  }

  function setShellGroupOpen(groupKey, open) {
    var group = findShellGroup(groupKey);
    if (!group || !group.node || !group.trigger) return;
    group.node.classList.toggle('is-open', !!open);
    group.trigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    group.trigger.classList.toggle('active', !!open);
  }

  function hydrateShellGroupState(groupKey, hasActiveChild) {
    var stored = readCacheString(groupCacheKey(groupKey), '');
    if (stored === '1') {
      setShellGroupOpen(groupKey, true);
      return;
    }
    if (stored === '0') {
      setShellGroupOpen(groupKey, false);
      return;
    }
    setShellGroupOpen(groupKey, !!hasActiveChild);
  }

  function setPhysioGroupVisible(visible) {
    if (!physioGroup) return;
    physioGroup.hidden = !visible;
    if (!visible) {
      setShellGroupOpen('physio', false);
    }
  }

  function setAuthView(view) {
    var signinView = document.getElementById('signin-view');
    var signupView = document.getElementById('signup-view');
    var resetView = document.getElementById('reset-view');
    if (!signinView || !signupView || !resetView) return false;
    signinView.classList.remove('active');
    signupView.classList.remove('active');
    resetView.classList.remove('active');
    if (view === 'signup') {
      signupView.classList.add('active');
      return true;
    }
    if (view === 'reset') {
      resetView.classList.add('active');
      return true;
    }
    signinView.classList.add('active');
    return true;
  }

  function clearAuthMessages() {
    ['signin-error', 'signup-error', 'reset-error', 'reset-success'].forEach(function (id) {
      var node = document.getElementById(id);
      if (!node) return;
      node.textContent = '';
      node.classList.remove('visible');
    });
  }

  function openInlineAuthModal(view) {
    var authOverlay = document.getElementById('auth-overlay');
    if (!authOverlay) return false;
    if (!setAuthView(view || 'signin')) return false;
    clearAuthMessages();
    authOverlay.classList.add('visible');
    authOverlay.setAttribute('aria-hidden', 'false');
    return true;
  }

  function openSignInPortal() {
    if (openInlineAuthModal('signin')) return;
    window.location.href = '/lecture-notes?auth=signin';
  }

  function maybeOpenAuthFromQuery() {
    var params = new URLSearchParams(window.location.search || '');
    var authView = String(params.get('auth') || '').trim().toLowerCase();
    if (!authView) return;
    if (authView !== 'signin' && authView !== 'signup' && authView !== 'reset') {
      authView = 'signin';
    }
    if (!openInlineAuthModal(authView)) return;
    params.delete('auth');
    var query = params.toString();
    var nextUrl = window.location.pathname + (query ? ('?' + query) : '') + (window.location.hash || '');
    window.history.replaceState({}, '', nextUrl);
  }

  function markActiveNav() {
    var currentPath = normalizePath(window.location.pathname || '/');
    var navLinks = Array.prototype.slice.call(document.querySelectorAll('.app-shell-link[href]'));
    var activeByGroup = {};

    navLinks.forEach(function (link) {
      var href = normalizePath(link.getAttribute('href') || '/');
      var active = href === currentPath || (href === '/plan' && currentPath === '/stats');
      link.classList.toggle('active', !!active);
      if (active && link.classList.contains('sub')) {
        var groupNode = link.closest ? link.closest('.app-shell-group[data-shell-group]') : null;
        if (groupNode) {
          activeByGroup[String(groupNode.getAttribute('data-shell-group') || '').trim()] = true;
        }
      }
    });

    shellGroups.forEach(function (group) {
      hydrateShellGroupState(group.key, !!activeByGroup[group.key]);
      if (group.trigger) {
        group.trigger.classList.toggle(
          'active',
          !!activeByGroup[group.key] || !!(group.node && group.node.classList.contains('is-open'))
        );
      }
    });
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
      creditsTotalLabel.textContent = 'Loading credits';
      if (creditsLectureValue) creditsLectureValue.textContent = '...';
      if (creditsTextValue) creditsTextValue.textContent = '...';
      if (creditsInterviewValue) creditsInterviewValue.textContent = '...';
      if (creditsTotalValue) creditsTotalValue.textContent = '...';
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

  function setCreditsVisible(visible) {
    if (!creditsLink) return;
    creditsLink.hidden = !visible;
    if (!visible) {
      creditsLink.classList.remove('is-open');
    }
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
      writeUserCacheJson(user, CACHE_KEYS.credits, breakdown);
      writeUserCacheJson(user, CACHE_KEYS.profile, {
        email: String(user.email || payload.email || 'user'),
        name: String((payload.email || user.email || 'Account')).split('@')[0] || 'Account',
        initial: String((user.email || payload.email || '?').charAt(0) || '?').toUpperCase(),
        isAdmin: currentUserIsAdmin,
        isPhysioAllowed: !!payload.is_physio_allowed
      });
      if (adminBtn) adminBtn.style.display = currentUserIsAdmin ? '' : 'none';
      setPhysioGroupVisible(!!payload.is_physio_allowed);
      markActiveNav();
    } catch (_) {}
  }

  function applySignedOutState(userOrUid) {
    clearUserScopedCaches(userOrUid);
    clearLegacyAccountCaches();
    currentUserIsAdmin = false;
    setAuthState('signed-out');
    if (adminBtn) adminBtn.style.display = 'none';
    setCreditsVisible(false);
    applyCreditBreakdown(null);
    if (userEmail) userEmail.textContent = 'Not signed in';
    if (userName) userName.textContent = 'Account';
    if (userInitial) userInitial.textContent = '?';
    if (signInBtn) signInBtn.hidden = false;
    if (accountWrap) accountWrap.hidden = true;
    setPhysioGroupVisible(false);
  }

  function applyCachedProfile(user) {
    var cachedProfile = readUserCacheJson(user, CACHE_KEYS.profile, null);
    if (!cachedProfile || typeof cachedProfile !== 'object') return false;
    if (signInBtn) signInBtn.hidden = true;
    if (accountWrap) accountWrap.hidden = false;
    if (userEmail) userEmail.textContent = String(cachedProfile.email || 'Checking sign-in...');
    if (userName) userName.textContent = String(cachedProfile.name || 'Account');
    if (userInitial) userInitial.textContent = String(cachedProfile.initial || '?').slice(0, 1).toUpperCase();
    currentUserIsAdmin = !!cachedProfile.isAdmin;
    if (adminBtn) adminBtn.style.display = currentUserIsAdmin ? '' : 'none';
    setPhysioGroupVisible(!!cachedProfile.isPhysioAllowed);
    return true;
  }

  function applyUserIdentity(user) {
    var email = String((user && user.email) || 'user').trim();
    if (userEmail) userEmail.textContent = email;
    if (userName) userName.textContent = email.split('@')[0] || 'Account';
    if (userInitial) userInitial.textContent = (email.charAt(0) || '?').toUpperCase();
  }

  function hydrateCachedCredits(user) {
    var cachedBreakdown = readUserCacheJson(user, CACHE_KEYS.credits, null);
    applyCreditBreakdown(cachedBreakdown || null);
  }

  function applyAuth(user) {
    var signedIn = !!user;
    setAuthState(signedIn ? 'signed-in' : 'signed-out');
    if (signInBtn) signInBtn.hidden = signedIn;
    if (accountWrap) accountWrap.hidden = !signedIn;
    if (!signedIn) {
      applySignedOutState(lastSignedInUid);
      lastSignedInUid = '';
      return;
    }

    lastSignedInUid = String(user.uid || lastSignedInUid || '');
    setCreditsVisible(true);
    applyCachedProfile(user);
    applyUserIdentity(user);
    hydrateCachedCredits(user);
    refreshUserProfile(user);
  }

  function setExportModalOpen(open) {
    if (!exportOverlay) return;
    if (open) {
      setAccountMenuOpen(false);
      if (typeof uxUtils.openModalOverlay === 'function') {
        uxUtils.openModalOverlay(exportOverlay, {
          scopeRoot: shell,
          initialFocus: exportConfirmBtn,
          onRequestClose: function () {
            setExportModalOpen(false);
          }
        });
      } else {
        exportOverlay.hidden = false;
        exportOverlay.setAttribute('aria-hidden', 'false');
        if (exportConfirmBtn) exportConfirmBtn.focus();
      }
      return;
    }
    if (typeof uxUtils.closeModalOverlay === 'function') {
      uxUtils.closeModalOverlay(exportOverlay, {
        returnFocus: exportDataBtn
      });
    } else {
      exportOverlay.hidden = true;
      exportOverlay.setAttribute('aria-hidden', 'true');
      if (exportDataBtn) exportDataBtn.focus();
    }
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

  shellGroups.forEach(function (group) {
    if (!group.trigger) return;
    group.trigger.addEventListener('click', function () {
      var next = !(group.node && group.node.classList.contains('is-open'));
      setShellGroupOpen(group.key, next);
      writeCacheString(groupCacheKey(group.key), next ? '1' : '0');
      group.trigger.classList.toggle('active', next);
    });
  });

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
      openSignInPortal();
    });
  }

  if (accountBtn && accountMenu) {
    accountBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      var next = !(accountWrap && accountWrap.classList.contains('is-open'));
      setAccountMenuOpen(next);
    });
    accountBtn.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setAccountMenuOpen(true, 'first');
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setAccountMenuOpen(true, 'last');
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        var next = !(accountWrap && accountWrap.classList.contains('is-open'));
        setAccountMenuOpen(next, next ? 'first' : '');
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setAccountMenuOpen(false);
      }
    });
    accountMenu.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusMenuItem(accountMenu, 'next');
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusMenuItem(accountMenu, 'prev');
      }
      if (event.key === 'Home') {
        event.preventDefault();
        focusMenuItem(accountMenu, 'first');
      }
      if (event.key === 'End') {
        event.preventDefault();
        focusMenuItem(accountMenu, 'last');
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setAccountMenuOpen(false);
        accountBtn.focus();
      }
      if (event.key === 'Tab') {
        setAccountMenuOpen(false);
      }
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
    if (event.defaultPrevented) return;
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

  setAuthState('pending');
  applyCreditBreakdown(null);
  if (auth.currentUser) {
    lastSignedInUid = String(auth.currentUser.uid || lastSignedInUid || '');
    applyCachedProfile(auth.currentUser);
    applyUserIdentity(auth.currentUser);
    hydrateCachedCredits(auth.currentUser);
    if (signInBtn) signInBtn.hidden = true;
    if (accountWrap) accountWrap.hidden = false;
    setCreditsVisible(true);
  } else {
    setCreditsVisible(false);
  }
  markActiveNav();
  maybeOpenAuthFromQuery();
  setupRoutePrefetch();
  window.LectureProcessorShell = Object.assign({}, window.LectureProcessorShell || {}, {
    showToast: showToast,
  });
})();
