(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var uiCache = window.LectureProcessorUiCache || null;
  var userCache = window.LectureProcessorUserCache || {};
  var uxUtils = window.LectureProcessorUx || {};

  var shell = document.getElementById('app-shell');
  var menuBtn = document.getElementById('app-shell-menu-btn');
  var overlay = document.getElementById('app-shell-overlay');
  var sidebar = document.getElementById('app-shell-sidebar');
  var shellMain = shell ? shell.querySelector('.app-shell-main') : null;
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
  var deleteAccountBtn = document.getElementById('shell-delete-account-btn');
  var signOutBtn = document.getElementById('signout-btn');
  var physioGroup = document.getElementById('shell-physio-group');
  var shellGroups = Array.prototype.slice.call(document.querySelectorAll('.app-shell-group[data-shell-group]')).map(function (group) {
    var key = String(group.getAttribute('data-shell-group') || '').trim();
    var trigger = group.querySelector('[data-shell-group-trigger]');
    var panelWrap = group.querySelector('.app-shell-group-panel-wrap');
    return {
      key: key,
      node: group,
      trigger: trigger,
      panelWrap: panelWrap
    };
  }).filter(function (group) { return !!group.key; });
  var exportOverlay = document.getElementById('shell-export-overlay');
  var exportCloseBtn = document.getElementById('shell-export-close');
  var exportCancelBtn = document.getElementById('shell-export-cancel');
  var exportConfirmBtn = document.getElementById('shell-export-confirm');
  var exportError = document.getElementById('shell-export-error');
  var exportCheckboxes = Array.prototype.slice.call(document.querySelectorAll('[data-export-key]'));
  var deleteAccountOverlay = document.getElementById('shell-delete-account-overlay');
  var deleteAccountCloseBtn = document.getElementById('shell-delete-account-close');
  var deleteAccountCancelBtn = document.getElementById('shell-delete-account-cancel');
  var deleteAccountConfirmBtn = document.getElementById('shell-delete-account-confirm');
  var deleteAccountTextInput = document.getElementById('shell-delete-account-text');
  var deleteAccountEmailInput = document.getElementById('shell-delete-account-email');
  var deleteAccountError = document.getElementById('shell-delete-account-error');
  var shellToast = document.getElementById('shell-toast');
  var mobileSidebarQuery = window.matchMedia ? window.matchMedia('(max-width: 1024px)') : null;
  var sidebarControlsInitialized = false;
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
  var lastSignedInUid = auth && auth.currentUser && auth.currentUser.uid ? String(auth.currentUser.uid) : '';
  var authStateResolved = !!(auth && auth.currentUser);
  var authObserverStartedAt = Date.now();
  var toastTimer = null;
  var deleteAccountInFlight = false;
  var SIDEBAR_FOCUSABLE_SELECTOR = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function normalizePath(pathname) {
    var normalized = String(pathname || '/').replace(/\/+$/, '');
    return normalized || '/';
  }

  function isActiveNavPath(href, currentPath) {
    if (href === currentPath) return true;
    if (href === '/plan' && currentPath === '/stats') return true;
    if (href === '/batch_mode') {
      return currentPath === '/batch_mode_slides_extraction'
        || currentPath === '/batch_mode_interview_transcription'
        || currentPath === '/batch_mode_audio_transcription'
        || currentPath === '/batch_mode_text_combine';
    }
    if (href === '/instant_batch_mode') {
      return currentPath === '/instant_batch_mode_slides_extraction'
        || currentPath === '/instant_batch_mode_interview_transcription'
        || currentPath === '/instant_batch_mode_audio_transcription'
        || currentPath === '/instant_batch_mode_text_combine';
    }
    return false;
  }

  function readCacheJson(key, fallbackValue) {
    return typeof userCache.getJson === 'function'
      ? userCache.getJson(key, fallbackValue, uiCache)
      : fallbackValue;
  }

  function writeCacheJson(key, value) {
    return typeof userCache.setJson === 'function'
      ? userCache.setJson(key, value, uiCache)
      : false;
  }

  function readCacheString(key, fallbackValue) {
    return typeof userCache.getString === 'function'
      ? userCache.getString(key, fallbackValue, uiCache)
      : fallbackValue;
  }

  function writeCacheString(key, value) {
    return typeof userCache.setString === 'function'
      ? userCache.setString(key, value, uiCache)
      : false;
  }

  function readUserCacheJson(userOrUid, key, fallbackValue) {
    return typeof userCache.getUserJson === 'function'
      ? userCache.getUserJson(userOrUid, key, fallbackValue, uiCache)
      : fallbackValue;
  }

  function writeUserCacheJson(userOrUid, key, value) {
    return typeof userCache.setUserJson === 'function'
      ? userCache.setUserJson(userOrUid, key, value, uiCache)
      : false;
  }

  function removeCacheKey(key) {
    return typeof userCache.remove === 'function'
      ? userCache.remove(key, uiCache)
      : false;
  }

  function clearUserScopedCaches(userOrUid) {
    if (typeof userCache.clearUserScope !== 'function') return;
    userCache.clearUserScope(userOrUid, ACCOUNT_SCOPED_CACHE_KEYS, uiCache);
  }

  function clearLegacyAccountCaches() {
    ['credits_breakdown', 'shell_profile', 'dashboard_summary:last', 'plan_summary:last', 'study_due_today:last'].forEach(removeCacheKey);
  }

  function clearVoiceNotesLocalData() {
    if (!window.indexedDB) return Promise.resolve(false);
    return new Promise(function (resolve) {
      var request = window.indexedDB.deleteDatabase('lecture-processor-voice-notes');
      request.onsuccess = function () { resolve(true); };
      request.onerror = function () { resolve(false); };
      request.onblocked = function () { resolve(false); };
    });
  }

  function showToast(message, variant) {
    if (!shellToast || !message) return;
    shellToast.textContent = String(message);
    shellToast.classList.remove('error', 'success');
    if (variant === 'error') shellToast.classList.add('error');
    if (variant === 'success') shellToast.classList.add('success');
    shellToast.setAttribute('role', variant === 'error' ? 'alert' : 'status');
    shellToast.setAttribute('aria-live', variant === 'error' ? 'assertive' : 'polite');
    shellToast.classList.add('visible');
    if (toastTimer) window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(function () {
      shellToast.classList.remove('visible');
      shellToast.setAttribute('role', 'status');
      shellToast.setAttribute('aria-live', 'polite');
    }, 2600);
  }

  function isMobileSidebar() {
    if (mobileSidebarQuery) return !!mobileSidebarQuery.matches;
    return (window.innerWidth || document.documentElement.clientWidth || 0) <= 1024;
  }

  function setElementInert(node, inert) {
    if (!node) return;
    if ('inert' in node) {
      node.inert = !!inert;
    }
    if (inert) {
      node.setAttribute('inert', '');
      return;
    }
    node.removeAttribute('inert');
  }

  function visibleSidebarFocusables() {
    if (!sidebar) return [];
    return Array.prototype.slice.call(sidebar.querySelectorAll(SIDEBAR_FOCUSABLE_SELECTOR)).filter(function (item) {
      return !item.hasAttribute('disabled') && item.getAttribute('aria-hidden') !== 'true' && item.offsetParent !== null;
    });
  }

  function focusFirstSidebarItem() {
    var items = visibleSidebarFocusables();
    if (items.length) {
      items[0].focus();
      return;
    }
    if (sidebar) sidebar.focus();
  }

  function trapSidebarFocus(event) {
    if (!isMobileSidebar() || !(shell && shell.classList.contains('sidebar-open'))) return;
    if (event.key !== 'Tab') return;
    var items = visibleSidebarFocusables();
    if (!items.length) {
      event.preventDefault();
      focusFirstSidebarItem();
      return;
    }
    var first = items[0];
    var last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function syncSidebarAccessibility(open) {
    var mobile = isMobileSidebar();
    var sidebarHidden = mobile && !open;
    var mainHidden = mobile && open;
    if (sidebar) {
      sidebar.setAttribute('aria-hidden', sidebarHidden ? 'true' : 'false');
      setElementInert(sidebar, sidebarHidden);
      sidebar.tabIndex = sidebarHidden ? -1 : 0;
    }
    if (overlay) {
      overlay.setAttribute('aria-hidden', mobile && open ? 'false' : 'true');
      overlay.tabIndex = -1;
    }
    if (shellMain) {
      if (mainHidden) shellMain.setAttribute('aria-hidden', 'true');
      else shellMain.removeAttribute('aria-hidden');
      setElementInert(shellMain, mainHidden);
    }
    if (menuBtn) menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function setSidebarOpen(open) {
    if (!shell) return;
    var restoreFocus = !open && isMobileSidebar() && sidebar && sidebar.contains(document.activeElement);
    shell.classList.toggle('sidebar-open', !!open);
    syncSidebarAccessibility(!!open);
    if (open && isMobileSidebar()) focusFirstSidebarItem();
    if (restoreFocus && menuBtn) menuBtn.focus();
  }

  function setupSidebarControls() {
    if (sidebarControlsInitialized) return;
    sidebarControlsInitialized = true;
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
    var syncCurrentState = function () {
      syncSidebarAccessibility(!!(shell && shell.classList.contains('sidebar-open')));
    };
    if (mobileSidebarQuery) {
      if (typeof mobileSidebarQuery.addEventListener === 'function') {
        mobileSidebarQuery.addEventListener('change', syncCurrentState);
      } else if (typeof mobileSidebarQuery.addListener === 'function') {
        mobileSidebarQuery.addListener(syncCurrentState);
      }
    } else {
      window.addEventListener('resize', syncCurrentState);
    }
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && shell && shell.classList.contains('sidebar-open')) {
        event.preventDefault();
        setSidebarOpen(false);
      }
      trapSidebarFocus(event);
    });
    setSidebarOpen(false);
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
      if (open) {
        accountMenuWrap.removeAttribute('inert');
      } else {
        accountMenuWrap.setAttribute('inert', '');
      }
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
    if (group.panelWrap) {
      group.panelWrap.setAttribute('aria-hidden', open ? 'false' : 'true');
      if (open) {
        group.panelWrap.removeAttribute('inert');
      } else {
        group.panelWrap.setAttribute('inert', '');
      }
    }
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
    if (typeof uxUtils.openModalOverlay === 'function') {
      uxUtils.openModalOverlay(authOverlay, {
        openClass: 'visible',
        onRequestClose: function () {
          if (typeof uxUtils.closeModalOverlay === 'function') {
            uxUtils.closeModalOverlay(authOverlay, { openClass: 'visible' });
          } else {
            authOverlay.classList.remove('visible');
            authOverlay.setAttribute('aria-hidden', 'true');
            authOverlay.hidden = true;
          }
        }
      });
      return true;
    }
    authOverlay.hidden = false;
    authOverlay.classList.add('visible');
    authOverlay.setAttribute('aria-hidden', 'false');
    return true;
  }

  function openSignInPortal() {
    if (openInlineAuthModal('signin')) return;
    var authUtils = window.LectureProcessorAuth || {};
    window.location.href = typeof authUtils.buildSignInUrl === 'function'
      ? authUtils.buildSignInUrl()
      : '/lecture-notes?auth=signin';
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
      var active = isActiveNavPath(href, currentPath);
      link.classList.toggle('active', !!active);
      if (active) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
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
    var unlimited = payload && payload.unlimited_credits ? payload.unlimited_credits : (credits.unlimited || {});
    var lecture = Number(credits.lecture_standard || 0) + Number(credits.lecture_extended || 0);
    var textExtraction = Number(credits.slides || 0);
    var interview = Number(credits.interview_short || 0) + Number(credits.interview_medium || 0) + Number(credits.interview_long || 0);
    return {
      lecture: lecture,
      textExtraction: textExtraction,
      interview: interview,
      total: lecture + textExtraction + interview,
      unlimited: {
        lecture: !!(unlimited && unlimited.lecture),
        slides: !!(unlimited && unlimited.slides),
        interview: !!(unlimited && unlimited.interview)
      }
    };
  }

  function hasAnyUnlimitedCredits(breakdown) {
    var unlimited = breakdown && breakdown.unlimited ? breakdown.unlimited : {};
    return !!(unlimited.lecture || unlimited.slides || unlimited.interview);
  }

  function formatShellCreditValue(breakdown, category, value) {
    var unlimited = breakdown && breakdown.unlimited ? breakdown.unlimited : {};
    return unlimited[category] ? 'Unlimited' : String(Number(value || 0));
  }

  function applyCreditBreakdown(breakdown) {
    if (!creditsTotalLabel) return;
    if (!breakdown) {
      creditsTotalLabel.textContent = 'Loading credits';
      if (creditsLink) creditsLink.setAttribute('aria-label', 'Buy credits, loading credits');
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
      total: Number(breakdown.total || 0),
      unlimited: breakdown.unlimited || {}
    };
    creditsTotalLabel.textContent = hasAnyUnlimitedCredits(next) ? 'Unlimited credits' : (next.total + ' credits');
    if (creditsLink) creditsLink.setAttribute('aria-label', 'Buy credits, ' + creditsTotalLabel.textContent);
    if (creditsLectureValue) creditsLectureValue.textContent = formatShellCreditValue(next, 'lecture', next.lecture);
    if (creditsTextValue) creditsTextValue.textContent = formatShellCreditValue(next, 'slides', next.textExtraction);
    if (creditsInterviewValue) creditsInterviewValue.textContent = formatShellCreditValue(next, 'interview', next.interview);
    if (creditsTotalValue) creditsTotalValue.textContent = hasAnyUnlimitedCredits(next) ? 'Unlimited' : String(next.total);
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
      if (adminBtn) adminBtn.hidden = !currentUserIsAdmin;
      setPhysioGroupVisible(!!payload.is_physio_allowed);
      markActiveNav();
    } catch (_) {}
  }

  function applySignedOutState(userOrUid) {
    clearUserScopedCaches(userOrUid);
    clearLegacyAccountCaches();
    currentUserIsAdmin = false;
    setAuthState('signed-out');
    if (adminBtn) adminBtn.hidden = true;
    setCreditsVisible(false);
    applyCreditBreakdown(null);
    if (userEmail) userEmail.textContent = 'Not signed in';
    if (userName) userName.textContent = 'Account';
    if (userInitial) userInitial.textContent = '?';
    if (signInBtn) signInBtn.hidden = false;
    if (accountWrap) accountWrap.hidden = true;
    setAccountMenuOpen(false);
    setPhysioGroupVisible(false);
  }

  function applyCachedProfile(user) {
    var cachedProfile = readUserCacheJson(user, CACHE_KEYS.profile, null);
    if (!cachedProfile || typeof cachedProfile !== 'object') return false;
    if (signInBtn) signInBtn.hidden = true;
    if (accountWrap) accountWrap.hidden = false;
    setAccountMenuOpen(false);
    if (userEmail) userEmail.textContent = String(cachedProfile.email || 'Checking sign-in...');
    if (userName) userName.textContent = String(cachedProfile.name || 'Account');
    if (userInitial) userInitial.textContent = String(cachedProfile.initial || '?').slice(0, 1).toUpperCase();
    currentUserIsAdmin = !!cachedProfile.isAdmin;
    if (adminBtn) adminBtn.hidden = !currentUserIsAdmin;
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
    setAccountMenuOpen(false);
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

  function revealSignInIfAuthStalls() {
    if (!shell || shell.getAttribute('data-auth-state') !== 'pending') return;
    if (auth && auth.currentUser) return;
    if (!authStateResolved && Date.now() - authObserverStartedAt < 6000) {
      window.setTimeout(revealSignInIfAuthStalls, 1200);
      return;
    }
    authStateResolved = true;
    setAuthState('signed-out');
    if (signInBtn) signInBtn.hidden = false;
    if (accountWrap) accountWrap.hidden = true;
    setCreditsVisible(false);
  }

  function setExportModalOpen(open) {
    if (!exportOverlay) return;
    if (open) {
      setExportError('');
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

  function setDeleteAccountError(message) {
    if (!deleteAccountError) return;
    var text = String(message || '').trim();
    deleteAccountError.textContent = text;
    deleteAccountError.hidden = !text;
  }

  function setDeleteAccountModalOpen(open) {
    if (!deleteAccountOverlay) return;
    if (open) {
      var expectedEmail = String((auth.currentUser && auth.currentUser.email) || '').trim();
      if (deleteAccountTextInput) deleteAccountTextInput.value = '';
      if (deleteAccountEmailInput) deleteAccountEmailInput.value = expectedEmail;
      setDeleteAccountError('');
      if (deleteAccountConfirmBtn) {
        deleteAccountConfirmBtn.disabled = false;
        deleteAccountConfirmBtn.textContent = 'Delete permanently';
      }
      setAccountMenuOpen(false);
      if (typeof uxUtils.openModalOverlay === 'function') {
        uxUtils.openModalOverlay(deleteAccountOverlay, {
          scopeRoot: shell,
          initialFocus: deleteAccountTextInput || deleteAccountConfirmBtn,
          onRequestClose: function () {
            setDeleteAccountModalOpen(false);
          }
        });
      } else {
        deleteAccountOverlay.hidden = false;
        deleteAccountOverlay.setAttribute('aria-hidden', 'false');
        if (deleteAccountTextInput) deleteAccountTextInput.focus();
      }
      return;
    }
    if (typeof uxUtils.closeModalOverlay === 'function') {
      uxUtils.closeModalOverlay(deleteAccountOverlay, {
        returnFocus: deleteAccountBtn
      });
    } else {
      deleteAccountOverlay.hidden = true;
      deleteAccountOverlay.setAttribute('aria-hidden', 'true');
      if (deleteAccountBtn) deleteAccountBtn.focus();
    }
    setDeleteAccountError('');
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

  function setExportError(message) {
    if (!exportError) return;
    var text = String(message || '').trim();
    exportError.textContent = text;
    exportError.hidden = !text;
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
      setExportError('Choose at least one export option.');
      return;
    }
    setExportError('');
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

  async function runAccountDeletion() {
    if (!auth.currentUser || deleteAccountInFlight) return;
    var expectedEmail = String(auth.currentUser.email || '').trim();
    if (!expectedEmail) {
      setDeleteAccountError('Could not verify account email. Please sign in again.');
      return;
    }
    var confirmText = String((deleteAccountTextInput && deleteAccountTextInput.value) || '').trim().toUpperCase();
    if (confirmText !== 'DELETE MY ACCOUNT') {
      setDeleteAccountError('Type DELETE MY ACCOUNT exactly to continue.');
      return;
    }
    var confirmEmail = String((deleteAccountEmailInput && deleteAccountEmailInput.value) || '').trim().toLowerCase();
    if (confirmEmail !== expectedEmail.toLowerCase()) {
      setDeleteAccountError('Email does not match your signed-in account.');
      return;
    }

    deleteAccountInFlight = true;
    if (deleteAccountConfirmBtn) {
      deleteAccountConfirmBtn.disabled = true;
      deleteAccountConfirmBtn.textContent = 'Deleting...';
    }
    try {
      var response = await authFetch('/api/account/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirm_text: 'DELETE MY ACCOUNT',
          confirm_email: confirmEmail
        })
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) throw new Error(payload.error || 'Could not delete account data.');

      var deletedUser = auth.currentUser;
      setDeleteAccountModalOpen(false);
      showToast('Account deleted. Signing out...', 'success');
      try {
        await fetch('/api/session/logout', { method: 'POST', credentials: 'include' });
      } catch (_) {}
      clearUserScopedCaches(deletedUser || lastSignedInUid);
      clearLegacyAccountCaches();
      try {
        await auth.signOut();
      } catch (_) {}
      await clearVoiceNotesLocalData();
      window.location.href = '/';
    } catch (error) {
      setDeleteAccountError(error.message || 'Could not delete account data.');
    } finally {
      deleteAccountInFlight = false;
      if (deleteAccountConfirmBtn) {
        deleteAccountConfirmBtn.disabled = false;
        deleteAccountConfirmBtn.textContent = 'Delete permanently';
      }
    }
  }

  setupSidebarControls();
  markActiveNav();
  shellGroups.forEach(function (group) {
    if (!group.trigger) return;
    group.trigger.addEventListener('click', function () {
      var next = !(group.node && group.node.classList.contains('is-open'));
      setShellGroupOpen(group.key, next);
      writeCacheString(groupCacheKey(group.key), next ? '1' : '0');
      group.trigger.classList.toggle('active', next);
    });
  });

  if (signInBtn) {
    signInBtn.addEventListener('click', function () {
      openSignInPortal();
    });
  }

  if (!auth) {
    setAuthState('signed-out');
    setCreditsVisible(false);
    if (signInBtn) signInBtn.hidden = false;
    maybeOpenAuthFromQuery();
    setupRoutePrefetch();
    window.LectureProcessorShell = Object.assign({}, window.LectureProcessorShell || {}, {
      showToast: showToast,
    });
    return;
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

  if (deleteAccountBtn) {
    deleteAccountBtn.addEventListener('click', function () {
      if (!auth.currentUser) {
        setAccountMenuOpen(false);
        showToast('Please sign in to delete your account.', 'error');
        return;
      }
      setDeleteAccountModalOpen(true);
    });
  }

  if (deleteAccountConfirmBtn) {
    deleteAccountConfirmBtn.addEventListener('click', runAccountDeletion);
  }

  if (deleteAccountCloseBtn) {
    deleteAccountCloseBtn.addEventListener('click', function () {
      setDeleteAccountModalOpen(false);
    });
  }

  if (deleteAccountCancelBtn) {
    deleteAccountCancelBtn.addEventListener('click', function () {
      setDeleteAccountModalOpen(false);
    });
  }

  if (deleteAccountOverlay) {
    deleteAccountOverlay.addEventListener('click', function (event) {
      if (event.target === deleteAccountOverlay && !deleteAccountInFlight) setDeleteAccountModalOpen(false);
    });
  }

  if (exportConfirmBtn) {
    exportConfirmBtn.addEventListener('click', runBundleExport);
  }

  exportCheckboxes.forEach(function (checkbox) {
    checkbox.addEventListener('change', function () {
      if (hasAnySelection(readExportSelection())) setExportError('');
    });
  });

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
      await clearVoiceNotesLocalData();
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
      if (deleteAccountOverlay && !deleteAccountOverlay.hidden && !deleteAccountInFlight) {
        event.preventDefault();
        setDeleteAccountModalOpen(false);
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

  bootstrap.onAuthStateReady(auth, function (user) {
    authStateResolved = true;
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
    setAccountMenuOpen(false);
    setCreditsVisible(true);
  } else {
    setCreditsVisible(false);
  }
  window.setTimeout(revealSignInIfAuthStalls, 1800);
  markActiveNav();
  maybeOpenAuthFromQuery();
  setupRoutePrefetch();
  window.LectureProcessorShell = Object.assign({}, window.LectureProcessorShell || {}, {
    showToast: showToast,
  });
})();
