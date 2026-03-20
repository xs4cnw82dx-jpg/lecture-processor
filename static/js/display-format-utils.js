(function (root) {
  'use strict';

  function safeInteger(value) {
    if (typeof value === 'boolean') return null;
    var parsed = parseInt(String(value == null ? '' : value).trim(), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  function buildLocaleList() {
    var locales = [];
    try {
      if (Array.isArray(root.navigator && root.navigator.languages)) {
        root.navigator.languages.forEach(function (locale) {
          var value = String(locale || '').trim();
          if (value && locales.indexOf(value) < 0) locales.push(value);
        });
      }
      var navigatorLocale = String((root.navigator && root.navigator.language) || '').trim();
      if (navigatorLocale && locales.indexOf(navigatorLocale) < 0) locales.push(navigatorLocale);
    } catch (_error) {
      // Ignore locale probing failures.
    }
    if (locales.indexOf('en-GB') < 0) locales.push('en-GB');
    return locales.length ? locales : ['en-GB'];
  }

  function fallbackCurrencyDisplay(amount, code) {
    var safeCode = String(code || 'EUR').toUpperCase();
    if (safeCode === 'EUR') return '\u20ac' + amount.toFixed(2);
    if (safeCode === 'USD') return '$' + amount.toFixed(2);
    if (safeCode === 'GBP') return '\u00a3' + amount.toFixed(2);
    return safeCode + ' ' + amount.toFixed(2);
  }

  function formatCurrencyFromCents(cents, currency, options) {
    var amount = Number(cents || 0) / 100;
    var code = String(currency || 'EUR').trim().toUpperCase() || 'EUR';
    var settings = options && typeof options === 'object' ? options : {};
    var formatOptions = {
      style: 'currency',
      currency: code,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    };
    if (settings.currencyDisplay) {
      formatOptions.currencyDisplay = settings.currencyDisplay;
    }
    try {
      return new Intl.NumberFormat(buildLocaleList(), formatOptions).format(amount);
    } catch (_error) {
      return fallbackCurrencyDisplay(amount, code);
    }
  }

  function formatDateTimeFromEpochSeconds(epochSeconds, options) {
    var value = Number(epochSeconds || 0);
    if (!value) return 'Unknown date';
    var settings = options && typeof options === 'object' ? options : {};
    var date = new Date(value * 1000);
    if (Number.isNaN(date.getTime())) return 'Unknown date';
    var formatOptions = Object.assign({
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    }, settings.intlOptions || {});
    try {
      return new Intl.DateTimeFormat(buildLocaleList(), formatOptions).format(date);
    } catch (_error) {
      return date.toISOString().slice(0, 16).replace('T', ' ');
    }
  }

  function formatCount(value, singular, plural) {
    var count = Math.max(0, safeInteger(value) || 0);
    var singularLabel = String(singular || 'item');
    var pluralLabel = String(plural || (singularLabel + 's'));
    return count + ' ' + (count === 1 ? singularLabel : pluralLabel);
  }

  function formatPackCounts(flashcardsCount, questionCount) {
    return [
      formatCount(flashcardsCount, 'card'),
      formatCount(questionCount, 'question')
    ].join(' \u00b7 ');
  }

  function applyPricingCatalog(target) {
    var rootNode = target && typeof target.querySelectorAll === 'function' ? target : root.document;
    if (!rootNode) return;

    Array.prototype.slice.call(rootNode.querySelectorAll('.price[data-price-cents], .bundle-price[data-price-cents]')).forEach(function (node) {
      node.textContent = formatCurrencyFromCents(node.getAttribute('data-price-cents'), node.getAttribute('data-currency'));
    });

    Array.prototype.slice.call(rootNode.querySelectorAll('.bundle-price-per')).forEach(function (node) {
      var cents = node.getAttribute('data-price-per-cents');
      if (cents == null || cents === '') {
        node.textContent = '';
        return;
      }
      node.textContent = formatCurrencyFromCents(cents, node.getAttribute('data-currency')) + ' per credit';
    });

    Array.prototype.slice.call(rootNode.querySelectorAll('.bundle-buy-btn[data-bundle-name][data-price-cents]')).forEach(function (button) {
      var bundleName = String(button.getAttribute('data-bundle-name') || 'credit bundle').trim();
      var priceText = formatCurrencyFromCents(button.getAttribute('data-price-cents'), button.getAttribute('data-currency'));
      button.setAttribute('aria-label', 'Buy ' + bundleName + ' for ' + priceText);
    });
  }

  var exported = {
    applyPricingCatalog: applyPricingCatalog,
    formatCount: formatCount,
    formatCurrencyFromCents: formatCurrencyFromCents,
    formatDateTimeFromEpochSeconds: formatDateTimeFromEpochSeconds,
    formatPackCounts: formatPackCounts
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  root.LectureProcessorDisplayFormatUtils = Object.assign({}, root.LectureProcessorDisplayFormatUtils || {}, exported);
})(typeof window !== 'undefined' ? window : globalThis);
