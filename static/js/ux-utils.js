(function (global) {
  'use strict';

  function getModalContainer(overlay, options) {
    if (!overlay) return null;
    var opts = options || {};
    if (typeof opts.getContainer === 'function') {
      var fromCallback = opts.getContainer(overlay);
      if (fromCallback) return fromCallback;
    }
    if (opts.includeRoleDialog !== false) {
      var dialog = overlay.querySelector('[role="dialog"]');
      if (dialog) return dialog;
    }
    if (typeof opts.containerSelector === 'string' && opts.containerSelector) {
      var custom = overlay.querySelector(opts.containerSelector);
      if (custom) return custom;
    }
    return overlay.firstElementChild || overlay;
  }

  function getFocusableElements(overlay, options) {
    var opts = options || {};
    var container = getModalContainer(overlay, opts);
    if (!container) return [];
    var selector = opts.focusableSelector ||
      'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
    return Array.from(container.querySelectorAll(selector)).filter(function (el) {
      return el.offsetParent !== null || el === document.activeElement;
    });
  }

  function getVisibleMenuItems(menu, selector) {
    if (!menu) return [];
    var itemSelector = selector || 'button:not([disabled])';
    return Array.from(menu.querySelectorAll(itemSelector)).filter(function (item) {
      return (item.offsetParent !== null || item === document.activeElement) && !item.disabled;
    });
  }

  function focusMenuItem(menu, selector, mode) {
    var items = getVisibleMenuItems(menu, selector);
    if (!items.length) return;
    var targetMode = mode || 'first';
    if (targetMode === 'last') {
      items[items.length - 1].focus();
      return;
    }
    var activeIndex = items.indexOf(document.activeElement);
    if (targetMode === 'next') {
      items[(activeIndex + 1 + items.length) % items.length].focus();
      return;
    }
    if (targetMode === 'prev') {
      items[(activeIndex - 1 + items.length) % items.length].focus();
      return;
    }
    if (targetMode === 'active') {
      var selected = items.find(function (item) {
        return item.classList.contains('active') || item.getAttribute('aria-selected') === 'true';
      });
      (selected || items[0]).focus();
      return;
    }
    items[0].focus();
  }

  function toDate(value, options) {
    if (value instanceof Date) return value;
    var opts = options || {};
    if (value == null || value === '') return null;
    var normalized = value;
    if (typeof normalized === 'number' && opts.unit === 'seconds') {
      normalized = normalized * 1000;
    }
    var date = new Date(normalized);
    if (Number.isNaN(date.getTime())) return null;
    return date;
  }

  function getLocale(options) {
    var opts = options || {};
    if (opts.locale) return String(opts.locale);
    if (global.navigator && typeof global.navigator.language === 'string' && global.navigator.language) {
      return global.navigator.language;
    }
    return 'en-US';
  }

  function formatDateTime(value, options) {
    var opts = options || {};
    var date = toDate(value, opts);
    if (!date) return opts.fallback || '-';
    var locale = getLocale(opts);
    var intlOptions = opts.intlOptions || {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    };
    return date.toLocaleString(locale, intlOptions);
  }

  function formatDate(value, options) {
    var opts = options || {};
    var date = toDate(value, opts);
    if (!date) return opts.fallback || '-';
    var locale = getLocale(opts);
    var intlOptions = opts.intlOptions || {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    };
    return date.toLocaleDateString(locale, intlOptions);
  }

  function formatTime(value, options) {
    var opts = options || {};
    var date = toDate(value, opts);
    if (!date) return opts.fallback || '-';
    var locale = getLocale(opts);
    var intlOptions = opts.intlOptions || {
      hour: '2-digit',
      minute: '2-digit',
    };
    return date.toLocaleTimeString(locale, intlOptions);
  }

  global.LectureProcessorUx = {
    getModalContainer: getModalContainer,
    getFocusableElements: getFocusableElements,
    getVisibleMenuItems: getVisibleMenuItems,
    focusMenuItem: focusMenuItem,
    formatDateTime: formatDateTime,
    formatDate: formatDate,
    formatTime: formatTime,
  };
})(window);
