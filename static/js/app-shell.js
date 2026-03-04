(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  if (!auth) return;

  var shell = document.getElementById('app-shell');
  var menuBtn = document.getElementById('app-shell-menu-btn');
  var overlay = document.getElementById('app-shell-overlay');
  var signInBtn = document.getElementById('shell-sign-in-btn');
  var creditsLink = document.getElementById('shell-credits-link');
  var accountWrap = document.getElementById('shell-account');
  var accountBtn = document.getElementById('shell-account-btn');
  var accountMenu = document.getElementById('shell-account-menu');
  var userEmail = document.getElementById('user-email');
  var userName = document.getElementById('shell-account-name');
  var userInitial = document.getElementById('shell-account-initial');
  var purchaseHistoryBtn = document.getElementById('shell-purchase-history-btn');
  var exportDataBtn = document.getElementById('shell-export-data-btn');
  var signOutBtn = document.getElementById('signout-btn');

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

  function markActiveNav() {
    var currentPath = String(window.location.pathname || '').replace(/\/+$/, '') || '/';
    var navLinks = Array.prototype.slice.call(document.querySelectorAll('.app-shell-link[href]'));
    navLinks.forEach(function (link) {
      var href = String(link.getAttribute('href') || '').replace(/\/+$/, '') || '/';
      var active = href === currentPath || (href === '/plan' && currentPath === '/stats');
      link.classList.toggle('active', !!active);
    });

    var extractionGroup = document.querySelector('.app-shell-group');
    if (extractionGroup) {
      var hasActiveChild = navLinks.some(function (link) {
        return link.classList.contains('sub') && link.classList.contains('active');
      });
      if (hasActiveChild) extractionGroup.setAttribute('open', 'open');
    }
  }

  function parseCredits(payload) {
    var credits = payload && payload.credits ? payload.credits : {};
    var lecture = Number(credits.lecture_standard || 0) + Number(credits.lecture_extended || 0);
    var slides = Number(credits.slides || 0);
    var interview = Number(credits.interview_short || 0) + Number(credits.interview_medium || 0) + Number(credits.interview_long || 0);
    return lecture + slides + interview;
  }

  async function authFetch(path, options) {
    var user = auth.currentUser;
    if (!user) throw new Error('Please sign in');
    var token = await user.getIdToken();
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
    return fetch(path, Object.assign({}, opts, { headers: headers }));
  }

  async function refreshCredits(user) {
    if (!creditsLink || !user) return;
    try {
      var response = await authFetch('/api/auth/user');
      if (!response.ok) return;
      var payload = await response.json();
      creditsLink.textContent = parseCredits(payload) + ' credits';
    } catch (_) {}
  }

  function applyAuth(user) {
    var signedIn = !!user;
    if (signInBtn) signInBtn.style.display = signedIn ? 'none' : '';
    if (accountWrap) accountWrap.style.display = signedIn ? '' : 'none';
    if (!signedIn) {
      if (creditsLink) creditsLink.textContent = 'Buy credits';
      if (userEmail) userEmail.textContent = 'Not signed in';
      if (userName) userName.textContent = 'Account';
      if (userInitial) userInitial.textContent = '?';
      return;
    }

    var email = String(user.email || 'user').trim();
    if (userEmail) userEmail.textContent = email;
    if (userName) userName.textContent = email.split('@')[0] || 'Account';
    if (userInitial) userInitial.textContent = (email.charAt(0) || '?').toUpperCase();
    refreshCredits(user);
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
      window.location.href = '/lecture-notes';
    });
  }

  if (accountBtn && accountMenu) {
    accountBtn.addEventListener('click', function (event) {
      event.stopPropagation();
      var next = !accountMenu.classList.contains('visible');
      setAccountMenuOpen(next);
    });
  }

  if (purchaseHistoryBtn) {
    purchaseHistoryBtn.addEventListener('click', function () {
      setAccountMenuOpen(false);
      window.location.href = '/buy_credits#purchase-history';
    });
  }

  if (exportDataBtn) {
    exportDataBtn.addEventListener('click', async function () {
      setAccountMenuOpen(false);
      try {
        var response = await authFetch('/api/account/export');
        if (!response.ok) throw new Error('Could not export data');
        var blob = await response.blob();
        var disposition = String(response.headers.get('Content-Disposition') || '');
        var match = disposition.match(/filename=\"?([^\";]+)\"?/i);
        var filename = (match && match[1]) ? match[1] : 'lecture-processor-account-export.json';
        var link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
      } catch (_) {}
    });
  }

  if (signOutBtn) {
    signOutBtn.addEventListener('click', async function () {
      try {
        await auth.signOut();
      } catch (_) {}
      window.location.href = '/dashboard';
    });
  }

  document.addEventListener('click', function (event) {
    if (accountWrap && !accountWrap.contains(event.target)) {
      setAccountMenuOpen(false);
    }
  });

  auth.onAuthStateChanged(function (user) {
    applyAuth(user || null);
  });

  markActiveNav();
})();
