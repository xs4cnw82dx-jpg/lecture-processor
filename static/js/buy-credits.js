(function () {
  'use strict';

  var bootstrap = window.LectureProcessorBootstrap || {};
  var auth = bootstrap.getAuth ? bootstrap.getAuth() : (window.firebase ? window.firebase.auth() : null);
  var authUtils = window.LectureProcessorAuth || {};
  var authClient = authUtils.createAuthClient ? authUtils.createAuthClient(auth, { notSignedInMessage: 'Please sign in' }) : null;

  var toast = document.getElementById('buy-credits-toast');
  var historyList = document.getElementById('purchase-history-list');
  var refreshHistoryBtn = document.getElementById('refresh-purchase-history-btn');
  var checkoutBusy = false;
  var paymentResultChecked = false;

  function showToast(message) {
    if (!toast) return;
    toast.textContent = String(message || '');
    toast.classList.add('visible');
    window.setTimeout(function () {
      toast.classList.remove('visible');
    }, 2800);
  }

  async function authFetch(path, options) {
    if (authClient && typeof authClient.authFetch === 'function') {
      return authClient.authFetch(path, options, { retryOn401: true });
    }
    var user = auth.currentUser;
    if (!user) throw new Error('Please sign in');
    var token = await user.getIdToken();
    var opts = options || {};
    var headers = Object.assign({}, opts.headers || {}, { Authorization: 'Bearer ' + token });
    return fetch(path, Object.assign({}, opts, { headers: headers }));
  }

  function setBundleButtons(disabled, activeBundle) {
    document.querySelectorAll('.bundle-buy-btn').forEach(function (button) {
      button.disabled = !!disabled;
      if (!button.dataset.baseText) {
        var ctaNode = button.querySelector('.cta');
        button.dataset.baseText = ctaNode ? ctaNode.textContent : 'Buy now';
      }
      var target = button.querySelector('.cta');
      if (!target) return;
      if (disabled && activeBundle && button.dataset.bundleId === activeBundle) {
        target.textContent = 'Redirecting...';
      } else {
        target.textContent = button.dataset.baseText || 'Buy now';
      }
    });
  }

  async function purchaseBundle(bundleId) {
    if (!auth.currentUser) {
      showToast('Please sign in first.');
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
      showToast(error && error.message ? error.message : 'Could not start checkout.');
      checkoutBusy = false;
      setBundleButtons(false);
    }
  }

  function formatPurchaseDate(epochSeconds) {
    var value = Number(epochSeconds || 0);
    if (!value) return 'Unknown date';
    try {
      return new Date(value * 1000).toLocaleString();
    } catch (_) {
      return 'Unknown date';
    }
  }

  function formatPrice(cents, currency) {
    var amount = Number(cents || 0) / 100;
    var code = String(currency || 'eur').toUpperCase();
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: code }).format(amount);
    } catch (_) {
      return '€' + amount.toFixed(2);
    }
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
    if (!auth.currentUser) {
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

  async function checkPaymentResult() {
    if (paymentResultChecked) return;
    paymentResultChecked = true;
    var params = new URLSearchParams(window.location.search);
    var status = params.get('payment');
    var sessionId = params.get('session_id');
    if (!status) return;
    if (status === 'success') {
      if (auth.currentUser && sessionId) {
        try {
          await authFetch('/api/confirm-checkout-session?session_id=' + encodeURIComponent(sessionId));
        } catch (_) {}
      }
      showToast('Payment successful. Credits updated.');
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

  if (refreshHistoryBtn) {
    refreshHistoryBtn.addEventListener('click', function () {
      loadPurchaseHistory();
    });
  }

  auth.onAuthStateChanged(function () {
    checkPaymentResult();
    loadPurchaseHistory();
  });
})();
