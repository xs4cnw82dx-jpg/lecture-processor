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
  var paymentResultChecked = false;
  var authStateResolved = !auth || !!auth.currentUser;

  function getCurrentUser() {
    return auth && auth.currentUser ? auth.currentUser : null;
  }

  function getSignInHref() {
    return '/lecture-notes?auth=signin';
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
      button.disabled = !!disabled;
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
      showToast('Sign in to buy credits.', 'error');
      if (signInLink && typeof signInLink.focus === 'function') signInLink.focus();
      return;
    }
    if (checkoutBusy) return;
    checkoutBusy = true;
    setBundleButtons(true, bundleId);
    try {
      var response = await authFetch('/api/create-checkout-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ bundle_id: bundleId })
      });
      var payload = await response.json().catch(function () { return {}; });
      if (!response.ok || !payload.checkout_url) {
        throw new Error(payload.error || 'Could not start checkout');
      }
      window.location.href = payload.checkout_url;
      return;
    } catch (error) {
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
      setHistoryEmpty('Sign in to view purchase history.');
      return;
    }
    setHistoryEmpty('Loading purchase history...');
    try {
      var response = await authFetch('/api/purchase-history');
      if (!response.ok) throw new Error('Could not load purchase history');
      var payload = await response.json().catch(function () { return {}; });
      renderPurchaseHistory(payload.purchases || []);
    } catch (_) {
      setHistoryEmpty('Could not load purchase history right now.');
    }
  }

  async function refreshUserCredits() {
    var user = getCurrentUser();
    if (!user) return false;
    try {
      if (typeof user.getIdToken === 'function') {
        await user.getIdToken(true);
      }
      var response = await authFetch('/api/auth/user');
      if (!response.ok) return false;
      await response.json().catch(function () { return {}; });
      return true;
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

  async function checkPaymentResult() {
    if (paymentResultChecked) return;
    paymentResultChecked = true;
    var params = new URLSearchParams(window.location.search);
    var status = params.get('payment');
    var sessionId = params.get('session_id');
    if (!status) return;
    if (status === 'success') {
      var confirmation = await confirmCheckoutSession(sessionId);
      if (confirmation.ok) {
        var refreshed = await refreshUserCredits();
        await loadPurchaseHistory();
        if (confirmation.status === 'already_processed') {
          showToast(refreshed ? 'Payment already confirmed. Credits are available.' : 'Payment already confirmed. Credits may take a few seconds to appear.');
        } else if (refreshed) {
          showToast('Payment successful. Credits updated.');
        } else {
          showToast('Payment successful. Credits may take a few seconds to appear.');
        }
      } else if (confirmation.status === 'pending_payment') {
        showToast('Payment received. Confirmation is still pending.');
      } else if (confirmation.status === 'account_deletion_in_progress') {
        showToast('Payment could not be applied because account deletion is in progress.');
      } else if (confirmation.status === 'not_signed_in') {
        authStateResolved = true;
        updateSignedOutUi();
        showToast('Sign in to apply your payment credits.', 'error');
      } else {
        showToast('Could not confirm payment yet. Please refresh and try again shortly.', 'error');
      }
    } else if (status === 'cancelled') {
      showToast('Payment cancelled.');
    }
    window.history.replaceState({}, '', '/buy_credits');
  }

  document.querySelectorAll('.bundle-buy-btn').forEach(function (button) {
    button.addEventListener('click', function () {
      purchaseBundle(button.dataset.bundleId || '');
    });
  });

  if (displayFormatUtils && typeof displayFormatUtils.applyPricingCatalog === 'function') {
    displayFormatUtils.applyPricingCatalog(document);
  }

  if (refreshHistoryBtn) {
    refreshHistoryBtn.addEventListener('click', function () {
      loadPurchaseHistory();
    });
  }

  updateSignedOutUi();

  if (auth && typeof bootstrap.onAuthStateReady === 'function') {
    bootstrap.onAuthStateReady(auth, function () {
      authStateResolved = true;
      updateSignedOutUi();
      checkPaymentResult();
      loadPurchaseHistory();
    });
  } else {
    authStateResolved = true;
    updateSignedOutUi();
    checkPaymentResult();
    loadPurchaseHistory();
  }
})();
