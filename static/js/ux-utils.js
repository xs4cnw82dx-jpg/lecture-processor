(function (global) {
  'use strict';

  var modalStateMap = typeof WeakMap === 'function' ? new WeakMap() : null;

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

  function toArray(value) {
    return Array.prototype.slice.call(value || []);
  }

  function uniqueNodes(nodes) {
    var seen = [];
    return toArray(nodes).filter(function (node) {
      if (!node || seen.indexOf(node) >= 0) return false;
      seen.push(node);
      return true;
    });
  }

  function resolveElement(value, overlay) {
    if (!value) return null;
    if (typeof value === 'function') {
      try {
        return value(overlay) || null;
      } catch (_) {
        return null;
      }
    }
    if (typeof value === 'string') {
      return (overlay && overlay.querySelector(value)) || document.querySelector(value);
    }
    if (value && value.nodeType === 1) return value;
    return null;
  }

  function collectBackgroundNodes(overlay, scopeRoot) {
    var hiddenNodes = [];
    var current = overlay;
    var stopNode = scopeRoot && scopeRoot.nodeType === 1 ? scopeRoot : document.body;
    while (current && current.parentElement) {
      var parent = current.parentElement;
      hiddenNodes = hiddenNodes.concat(toArray(parent.children).filter(function (child) {
        return child !== current;
      }));
      if (current === stopNode || parent === stopNode) break;
      current = parent;
    }
    return uniqueNodes(hiddenNodes);
  }

  function applyBackgroundInertness(nodes) {
    return toArray(nodes).map(function (node) {
      var state = {
        node: node,
        ariaHidden: node.getAttribute('aria-hidden'),
        hadInert: node.hasAttribute('inert'),
      };
      node.setAttribute('aria-hidden', 'true');
      node.setAttribute('inert', '');
      return state;
    });
  }

  function restoreBackgroundInertness(entries) {
    toArray(entries).forEach(function (entry) {
      if (!entry || !entry.node) return;
      if (entry.ariaHidden === null) entry.node.removeAttribute('aria-hidden');
      else entry.node.setAttribute('aria-hidden', entry.ariaHidden);
      if (entry.hadInert) entry.node.setAttribute('inert', '');
      else entry.node.removeAttribute('inert');
    });
  }

  function getInitialFocusTarget(overlay, options) {
    var opts = options || {};
    var preferred = resolveElement(opts.initialFocus, overlay);
    if (preferred) return preferred;
    var focusables = getFocusableElements(overlay, opts);
    if (focusables.length) return focusables[0];
    var container = getModalContainer(overlay, opts);
    if (!container) return null;
    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
    return container;
  }

  function openModalOverlay(overlay, options) {
    if (!overlay) return null;
    var opts = options || {};
    if (modalStateMap && modalStateMap.has(overlay)) {
      return modalStateMap.get(overlay);
    }
    var scopeRoot = resolveElement(opts.scopeRoot, overlay) || document.body;
    var previousActive = document.activeElement;
    var previousOverflow = document.body.style.overflow;
    var state = {
      backgroundState: applyBackgroundInertness(collectBackgroundNodes(overlay, scopeRoot)),
      previousActive: previousActive,
      previousOverflow: previousOverflow,
      onKeyDown: null,
    };

    overlay.hidden = false;
    if (opts.openClass) overlay.classList.add(opts.openClass);
    overlay.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';

    state.onKeyDown = function (event) {
      if (overlay.hidden) return;
      if (event.key === 'Escape' && typeof opts.onRequestClose === 'function') {
        event.preventDefault();
        opts.onRequestClose(event);
        return;
      }
      if (event.key !== 'Tab') return;
      var focusables = getFocusableElements(overlay, opts);
      if (!focusables.length) {
        var container = getModalContainer(overlay, opts);
        if (container) {
          event.preventDefault();
          container.focus();
        }
        return;
      }
      var currentIndex = focusables.indexOf(document.activeElement);
      if (event.shiftKey) {
        if (currentIndex <= 0) {
          event.preventDefault();
          focusables[focusables.length - 1].focus();
        }
        return;
      }
      if (currentIndex === -1 || currentIndex === focusables.length - 1) {
        event.preventDefault();
        focusables[0].focus();
      }
    };

    document.addEventListener('keydown', state.onKeyDown, true);
    window.setTimeout(function () {
      var initialTarget = getInitialFocusTarget(overlay, opts);
      if (initialTarget) initialTarget.focus();
    }, 0);

    if (modalStateMap) modalStateMap.set(overlay, state);
    return state;
  }

  function closeModalOverlay(overlay, options) {
    if (!overlay) return null;
    var opts = options || {};
    var state = modalStateMap ? modalStateMap.get(overlay) : null;
    overlay.setAttribute('aria-hidden', 'true');
    if (opts.openClass) overlay.classList.remove(opts.openClass);
    overlay.hidden = true;
    if (!state) {
      document.body.style.overflow = '';
      return null;
    }
    if (state.onKeyDown) {
      document.removeEventListener('keydown', state.onKeyDown, true);
    }
    restoreBackgroundInertness(state.backgroundState);
    document.body.style.overflow = state.previousOverflow || '';
    if (opts.restoreFocus !== false) {
      var focusTarget = resolveElement(opts.returnFocus, overlay) || state.previousActive;
      if (focusTarget && typeof focusTarget.focus === 'function') {
        window.setTimeout(function () {
          focusTarget.focus();
        }, 0);
      }
    }
    if (modalStateMap) modalStateMap.delete(overlay);
    return state;
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
    if (global.navigator && Array.isArray(global.navigator.languages) && global.navigator.languages.length) {
      var locales = global.navigator.languages.filter(Boolean);
      if (locales.length) return locales;
    }
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
    openModalOverlay: openModalOverlay,
    closeModalOverlay: closeModalOverlay,
    formatDateTime: formatDateTime,
    formatDate: formatDate,
    formatTime: formatTime,
  };
})(window);
