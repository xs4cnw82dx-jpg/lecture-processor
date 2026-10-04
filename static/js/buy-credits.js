(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;
  var displayFormatUtils = window.LectureProcessorDisplayFormatUtils || {};

  var toast = document.getElementById('buy-credits-toast');
  var authPanel = document.getElementById('buy-credits-auth-panel');
  var signInLink = document.getElementById('buy-credits-signin-link');
  var historyList = document.getElementById('purchase-history-list');
  var refreshHistoryBtn = document.getElementById('refresh-purchase-history-btn');
  var checkoutBusy = false;
  var checkoutAttempt = 0;
  var paymentResultChecked = false;
  var paymentSessionId = '';
  var paymentStatus = '';
  var paymentNeedsConfirmation = false;
  var paymentPanel = document.getElementById('payment-result');
  var paymentRetry = document.getElementById('payment-result-retry');
  var authStateResolved = !auth || !!auth.currentUser;
  var accountRevision = 0;
  var accountUid = getCurrentUser() ? getCurrentUser().uid : null;

  function getCurrentUser() {
    return auth && auth.currentUser ? auth.currentUser : null;
  }

  function captureAccount() {
    var user = getCurrentUser();
    var revision = accountRevision;
    return function () { return user === getCurrentUser() && revision === accountRevision; };
  }

  function getSignInHref(bundleId) {
    var currentParams = new URLSearchParams(window.location.search);
    var pendingSession = paymentSessionId || currentParams.get('session_id');
    var pendingStatus = paymentStatus || currentParams.get('payment');
    var nextParams = new URLSearchParams();
    var safeBundle = String(bundleId || '').trim();
    if (pendingStatus === 'success' && pendingSession) {
      nextParams.set('payment', 'success');
      nextParams.set('session_id', pendingSession);
    } else if (safeBundle) nextParams.set('bundle_id', safeBundle);
    var next = '/buy_credits' + (nextParams.toString() ? '?' + nextParams.toString() : '');
    if (typeof authUtils.buildSignInUrl === 'function') {
      return authUtils.buildSignInUrl(next);
    }
    return '/lecture-notes?auth=signin&next=' + encodeURIComponent(next);
  }

  function showToast(message, type) {
    if (!toast) return;
    toast.textContent = String(message || '');
    toast.classList.remove('error');
    if (type === 'error') toast.classList.add('error');
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    toast.classList.add('visible');
    window.setTimeout(function () {
      toast.classList.remove('visible');
      toast.classList.remove('error');
      toast.setAttribute('role', 'status');
      toast.setAttribute('aria-live', 'polite');
    }, 2800);
  }

  function updateSignedOutUi() {
    var signedIn = !!getCurrentUser();
    if (authPanel) authPanel.hidden = signedIn || !authStateResolved;
    if (signInLink) signInLink.href = getSignInHref();
    setBundleButtons(false);
  }

  async function authFetch(path, options) {
    if (authClient && typeof authClient.authFetch === 'function') {
      return authClient.authFetch(path, options, { retryOn401: true });
    }
    var user = getCurrentUser();
    if (!user) throw new Error('Please sign in');
    var token = await user.getIdToken();
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
    return fetch(path, Object.assign({}, opts, { headers: headers }));
  }

  function setBundleButtons(disabled, activeBundle) {
    var signedIn = !!getCurrentUser();
    var needsSignIn = !signedIn && authStateResolved;
    document.querySelectorAll('.bundle-buy-btn').forEach(function (button) {
      button.disabled = !!disabled || !authStateResolved;
      if (needsSignIn) {
        button.setAttribute('aria-describedby', 'buy-credits-auth-panel');
      } else {
        button.removeAttribute('aria-describedby');
      }
      if (!button.dataset.baseText) {
        var ctaNode = button.querySelector('.cta');
        button.dataset.baseText = ctaNode ? ctaNode.textContent : 'Buy now';
      }
      var target = button.querySelector('.cta');
      if (!target) return;
      if (disabled && activeBundle && button.dataset.bundleId === activeBundle) {
        target.textContent = 'Redirecting...';
      } else if (!authStateResolved) {
        target.textContent = 'Checking account…';
      } else if (needsSignIn) {
        target.textContent = 'Sign in to buy';
      } else {
        target.textContent = button.dataset.baseText || 'Buy now';
      }
    });
  }

  async function purchaseBundle(bundleId) {
    if (!getCurrentUser()) {
      authStateResolved = true;
      updateSignedOutUi();
      if (signInLink) signInLink.href = getSignInHref(bundleId);
      showToast('Sign in to buy credits.', 'error');
      if (signInLink && typeof signInLink.focus === 'function') signInLink.focus();
      return;
    }
    if (checkoutBusy) return;
    var isCurrent = captureAccount();
    checkoutBusy = true;
    var attempt = ++checkoutAttempt;
    setBundleButtons(true, bundleId);
    try {
      var response = await authFetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundle_id: bundleId })
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!isCurrent() || attempt !== checkoutAttempt) return;
      if (!response.ok || !payload.checkout_url) {
        throw new Error(payload.error || 'Could not start checkout');
      }
      window.location.href = payload.checkout_url;
      return;
    } catch (error) {
      if (!isCurrent() || attempt !== checkoutAttempt) return;
      showToast(error && error.message ? error.message : 'Could not start checkout.', 'error');
      checkoutBusy = false;
      setBundleButtons(false);
    }
  }

  function formatPurchaseDate(epochSeconds) {
    if (displayFormatUtils && typeof displayFormatUtils.formatDateTimeFromEpochSeconds === 'function') {
      return displayFormatUtils.formatDateTimeFromEpochSeconds(epochSeconds);
    }
    return 'Unknown date';
  }

  function formatPrice(cents, currency) {
    if (displayFormatUtils && typeof displayFormatUtils.formatCurrencyFromCents === 'function') {
      return displayFormatUtils.formatCurrencyFromCents(cents, currency);
    }
    return '€0.00';
  }

  function setHistoryEmpty(message) {
    if (!historyList) return;
    historyList.innerHTML = '';
    var el = document.createElement('div');
    el.className = 'history-empty';
    el.textContent = String(message || '');
    historyList.appendChild(el);
  }

  function renderPurchaseHistory(items) {
    if (!historyList) return;
    historyList.innerHTML = '';
    if (!items || !items.length) {
      setHistoryEmpty('No purchases yet.');
      return;
    }

    items.forEach(function (purchase) {
      var row = document.createElement('div');
      row.className = 'purchase-row';

      var title = document.createElement('div');
      title.className = 'title';
      title.textContent = String(purchase.bundle_name || 'Credit bundle');

      var meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = formatPrice(purchase.price_cents, purchase.currency) + ' · ' + formatPurchaseDate(purchase.created_at);

      row.appendChild(title);
      row.appendChild(meta);
      historyList.appendChild(row);
    });
  }

  async function loadPurchaseHistory() {
    if (!historyList) return;
    if (!getCurrentUser()) {
      setHistoryEmpty(authStateResolved ? 'Sign in to view purchase history.' : 'Checking your account…');
      return;
    }
    setHistoryEmpty('Loading purchase history...');
    var isCurrent = captureAccount();
    try {
      var response = await authFetch('/api/purchase-history');
      if (!response.ok) throw new Error('Could not load purchase history');
      var payload = await response.json().catch(function () { return {}; });
      if (!isCurrent()) return;
      renderPurchaseHistory(payload.purchases || []);
    } catch (_) {
      if (!isCurrent()) return;
      setHistoryEmpty('Could not load purchase history right now.');
    }
  }

  async function refreshUserCredits() {
    var user = getCurrentUser();
    if (!user) return false;
    var isCurrent = captureAccount();
    try {
      if (typeof user.getIdToken === 'function') {
        await user.getIdToken(true);
      }
      if (!isCurrent()) return false;
      var response = await authFetch('/api/auth/user');
      if (!response.ok) return false;
      await response.json().catch(function () { return {}; });
      return isCurrent();
    } catch (_) {
      return false;
    }
  }

  async function confirmCheckoutSession(sessionId) {
    if (!sessionId) {
      return { ok: false, status: 'missing_session' };
    }
    if (!getCurrentUser()) {
      return { ok: false, status: 'not_signed_in' };
    }
    try {
      var response = await authFetch('/api/confirm-checkout-session?session_id=' + encodeURIComponent(sessionId));
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok) {
        return {
          ok: false,
          status: String(payload.status || 'confirm_failed'),
          error: String(payload.error || '')
        };
      }
      return {
        ok: true,
        status: String(payload.status || 'granted')
      };
    } catch (_) {
      return { ok: false, status: 'confirm_failed' };
    }
  }

  function showPaymentResult(message, type, retry) {
    if (!paymentPanel) return;
    paymentPanel.hidden = false;
    paymentPanel.dataset.state = type || 'success';
    document.getElementById('payment-result-title').textContent = type === 'error' ? 'Payment needs attention' : type === 'pending' ? 'Waiting for confirmation' : type === 'cancelled' ? 'Checkout cancelled' : 'Payment confirmed';
    document.getElementById('payment-result-message').textContent = message;
    if (paymentRetry) { paymentRetry.hidden = !retry; paymentRetry.disabled = false; }
  }

  async function checkPaymentResult() {
    if (paymentResultChecked) return;
    paymentResultChecked = true;
    var params = new URLSearchParams(window.location.search);
    var status = params.get('payment') || paymentStatus;
    var sessionId = params.get('session_id') || paymentSessionId;
    paymentSessionId = sessionId;
    paymentStatus = status;
    if (params.get('payment') === 'success') paymentNeedsConfirmation = true;
    if (!status) return;
    var isCurrent = captureAccount();
    if (status === 'success') {
      var confirmation = await confirmCheckoutSession(sessionId);
      if (!isCurrent()) return;
      if (confirmation.ok) {
        paymentNeedsConfirmation = false;
        var refreshed = await refreshUserCredits();
        if (!isCurrent()) return;
        await loadPurchaseHistory();
        if (!isCurrent()) return;
        if (confirmation.status === 'already_processed') {
          showPaymentResult(refreshed ? 'Payment already confirmed. Credits are available.' : 'Payment already confirmed. Credits may take a few seconds to appear.');
        } else if (refreshed) {
          showPaymentResult('Payment successful. Credits updated.');
        } else {
          showPaymentResult('Payment successful. Credits may take a few seconds to appear.');
        }
      } else if (confirmation.status === 'pending_payment') {
        showPaymentResult('Payment received. Confirmation is still pending.', 'pending', true);
      } else if (confirmation.status === 'account_deletion_in_progress') {
        showPaymentResult('Payment could not be applied because account deletion is in progress.', 'error');
      } else if (confirmation.status === 'not_signed_in') {
        authStateResolved = true;
        updateSignedOutUi();
        showPaymentResult('Sign in to apply your payment credits.', 'pending', true);
      } else {
        showPaymentResult('Could not confirm payment yet. Check again shortly; you do not need to make another purchase.', 'error', true);
      }
    } else if (status === 'cancelled') {
      showPaymentResult('No credits were purchased. You can choose a bundle whenever you are ready.', 'cancelled');
    }
    window.history.replaceState({}, '', '/buy_credits');
  }

  function maybeResumeBundleIntent() {
    if (!getCurrentUser() || checkoutBusy) return;
    var params = new URLSearchParams(window.location.search);
    if (params.get('payment')) return;
    var bundleId = String(params.get('bundle_id') || '').trim();
    if (!bundleId) return;
    params.delete('bundle_id');
    var nextQuery = params.toString();
    window.history.replaceState({}, '', '/buy_credits' + (nextQuery ? '?' + nextQuery : ''));
    purchaseBundle(bundleId);
  }

  document.querySelectorAll('.bundle-buy-btn').forEach(function (button) {
    button.addEventListener('click', function () {
      purchaseBundle(button.dataset.bundleId || '');
    });
  });

  function resetCheckoutNavigation() {
    checkoutAttempt += 1;
    checkoutBusy = false;
    setBundleButtons(false);
  }
  // Browsers may restore the original DOM and JavaScript heap from checkout.
  // Reset before caching and again on restoration; never create another session.
  window.addEventListener('pagehide', resetCheckoutNavigation);
  window.addEventListener('pageshow', function (event) {
    if (event.persisted) resetCheckoutNavigation();
  });

  if (displayFormatUtils && typeof displayFormatUtils.applyPricingCatalog === 'function') {
    displayFormatUtils.applyPricingCatalog(document);
  }

  if (refreshHistoryBtn) {
    refreshHistoryBtn.addEventListener('click', function () {
      loadPurchaseHistory();
    });
  }

  if (paymentRetry) paymentRetry.addEventListener('click', function () {
    paymentRetry.disabled = true;
    paymentResultChecked = false;
    checkPaymentResult();
  });

  updateSignedOutUi();

  if (auth && typeof bootstrap.onAuthStateReady === 'function') {
    bootstrap.onAuthStateReady(auth, function () {
      var nextUid = getCurrentUser() ? getCurrentUser().uid : null;
      if (nextUid !== accountUid) {
        accountRevision += 1;
        accountUid = nextUid;
        checkoutBusy = false;
        if (toast) toast.classList.remove('visible');
        if (paymentPanel) paymentPanel.hidden = true;
        if (paymentNeedsConfirmation) paymentResultChecked = false;
        else { paymentSessionId = ''; paymentStatus = ''; }
        setHistoryEmpty(nextUid ? 'Loading purchase history...' : 'Sign in to view purchase history.');
      }
      authStateResolved = true;
      updateSignedOutUi();
      checkPaymentResult();
      loadPurchaseHistory();
      maybeResumeBundleIntent();
    });
  } else {
    authStateResolved = true;
    updateSignedOutUi();
    checkPaymentResult();
    loadPurchaseHistory();
    maybeResumeBundleIntent();
  }
})();
