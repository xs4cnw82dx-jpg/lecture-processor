(function (global) {
  'use strict';

  var modalStateMap = typeof WeakMap === 'function' ? new WeakMap() : null;
  var enhancedSelectInstances = [];
  var enhancedSelectListenersBound = false;
  var bodyScrollLockCount = 0;

  var validationSerial = 0;
  var firstInvalidControl = null;
  var validationFeedback = new WeakMap();
  function validationTarget(input) {
    if (input._appSelectInstance) return input._appSelectInstance.button;
    if (input._appDateInstance) return input._appDateInstance.trigger;
    return input;
  }
  function clearValidationFeedback(input) {
    var state = validationFeedback.get(input);
    if (!state || !input.validity.valid) return;
    state.targets.forEach(function (record) {
      var descriptions = (record.element.getAttribute('aria-describedby') || '').split(/\s+/).filter(function (id) { return id && id !== state.error.id; });
      if (descriptions.length) record.element.setAttribute('aria-describedby', descriptions.join(' '));
      else record.element.removeAttribute('aria-describedby');
      if (record.invalid === null) record.element.removeAttribute('aria-invalid');
      else record.element.setAttribute('aria-invalid', record.invalid);
    });
    state.error.remove(); validationFeedback.delete(input);
  }
  document.addEventListener('invalid', function (event) {
    var input = event.target;
    if (!input.validity || input.validity.valid) return;
    event.preventDefault();
    var target = validationTarget(input);
    var state = validationFeedback.get(input);
    if (!state) {
      var error = document.createElement('span');
      error.className = 'app-validation-error'; error.id = 'app-validation-error-' + (++validationSerial);
      error.setAttribute('role', 'alert');
      var anchor = input._appSelectInstance ? input._appSelectInstance.wrapper : input._appDateInstance ? input._appDateInstance.host : input;
      anchor.insertAdjacentElement('afterend', error);
      state = { error: error, targets: (target === input ? [input] : [input, target]).map(function (element) { return { element: element, invalid: element.getAttribute('aria-invalid') }; }) };
      validationFeedback.set(input, state);
      state.targets.forEach(function (record) {
        record.element.setAttribute('aria-invalid', 'true');
        var description = record.element.getAttribute('aria-describedby');
        record.element.setAttribute('aria-describedby', (description ? description + ' ' : '') + error.id);
      });
    }
    state.error.textContent = input.validationMessage || 'Check this field before continuing.';
    if (!firstInvalidControl) {
      firstInvalidControl = target;
      global.setTimeout(function () {
        var first = firstInvalidControl; firstInvalidControl = null;
        if (first && first.isConnected) first.focus();
      }, 0);
    }
  }, true);
  ['input', 'change'].forEach(function (name) { document.addEventListener(name, function (event) { if (event.target.validity) clearValidationFeedback(event.target); }, true); });

  function setHidden(element, hidden) {
    if (!element) return;
    element.hidden = !!hidden;
  }

  function setBodyScrollLocked(locked) {
    if (!document.body) return;
    if (locked) {
      bodyScrollLockCount += 1;
      document.body.classList.add('body-scroll-locked');
      return;
    }
    bodyScrollLockCount = Math.max(0, bodyScrollLockCount - 1);
    if (!bodyScrollLockCount) {
      document.body.classList.remove('body-scroll-locked');
    }
  }

  function createChevronIcon() {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    var polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    polyline.setAttribute('points', '6 9 12 15 18 9');
    svg.appendChild(polyline);
    return svg;
  }

  var layoutRules = new WeakMap();
  var layoutSerial = 0;
  function setLayoutStyles(element, values) {
    if (!element) return;
    var sheet = Array.from(document.styleSheets).find(function (entry) { return entry.href && entry.href.indexOf('/css/shared-ui.css') >= 0; });
    if (!sheet) return;
    var record = layoutRules.get(element);
    if (!record) { record = { id: 'app-layout-' + (++layoutSerial), values: {}, rule: null }; element.dataset.appLayout = record.id; layoutRules.set(element, record); }
    Object.keys(values).forEach(function (key) {
      if (!/^(width|height|left|top|max-height|max-width)$/.test(key)) return;
      var value = String(values[key]);
      if (value === '') delete record.values[key];
      else if (/^-?[\d.]+px$/.test(value)) record.values[key] = value;
    });
    if (record.rule) { var oldIndex = Array.from(sheet.cssRules).indexOf(record.rule); if (oldIndex >= 0) sheet.deleteRule(oldIndex); }
    if (!Object.keys(record.values).length) { record.rule = null; return; }
    var body = Object.keys(record.values).map(function (key) { return key + ':' + record.values[key] + ' !important'; }).join(';');
    var index = sheet.insertRule('[data-app-layout="' + record.id + '"]{' + body + '}', sheet.cssRules.length);
    record.rule = sheet.cssRules[index];
  }

  function clearLayoutStyles(element) {
    var record = layoutRules.get(element);
    if (!record) return;
    var values = {};
    Object.keys(record.values).forEach(function (key) { values[key] = ''; });
    setLayoutStyles(element, values);
    layoutRules.delete(element);
    delete element.dataset.appLayout;
  }

  var anchoredPanels = new Map();
  function positionAnchoredPanel(panel, anchor) {
    if (!anchor.isConnected) { anchoredPanels.delete(panel); return; }
    var rect = anchor.getBoundingClientRect();
    var width = Math.min(panel.classList.contains('app-date-panel') ? 304 : Math.max(panel.classList.contains('app-menu-panel') ? 228 : 180, rect.width), global.innerWidth - 24);
    setLayoutStyles(panel, { width: width + 'px', left: Math.max(12, Math.min(rect.left, global.innerWidth - width - 12)) + 'px' });
    var height = Math.min(panel.scrollHeight, 360, global.innerHeight - 24);
    var below = global.innerHeight - rect.bottom - 12;
    var above = rect.top - 12;
    var useAbove = below < height && above > below;
    var available = Math.max(100, useAbove ? above : below);
    setLayoutStyles(panel, { 'max-height': Math.min(height, available) + 'px', top: Math.max(12, useAbove ? rect.top - Math.min(height, available) - 7 : rect.bottom + 7) + 'px' });
  }
  function showAnchoredPanel(panel, anchor) {
    if (typeof panel.showPopover !== 'function') return;
    if (panel._closeTimer) global.clearTimeout(panel._closeTimer);
    panel.setAttribute('popover', 'manual');
    panel.showPopover();
    anchoredPanels.set(panel, anchor);
    positionAnchoredPanel(panel, anchor);
  }
  function hideAnchoredPanel(panel) {
    anchoredPanels.delete(panel);
    if (typeof panel.hidePopover !== 'function' || !panel.hasAttribute('popover')) return;
    panel._closeTimer = global.setTimeout(function () { if (panel.isConnected) panel.hidePopover(); clearLayoutStyles(panel); }, 200);
  }
  function repositionPanels() { anchoredPanels.forEach(function (anchor, panel) { positionAnchoredPanel(panel, anchor); }); }
  global.addEventListener('resize', repositionPanels);
  document.addEventListener('scroll', function (event) {
    if (event.target && event.target.closest && event.target.closest('.app-select-menu, .app-date-panel')) return;
    repositionPanels();
  }, true);

  function closeEnhancedSelectMenus(exceptionMenu) {
    enhancedSelectInstances = enhancedSelectInstances.filter(function (instance) { return instance.wrapper.isConnected; });
    enhancedSelectInstances.forEach(function (instance) {
      if (!instance || !instance.menu || instance.menu === exceptionMenu) return;
      instance.setOpen(false);
    });
  }

  function ensureEnhancedSelectListeners() {
    if (enhancedSelectListenersBound) return;
    enhancedSelectListenersBound = true;
    document.addEventListener('click', function (event) {
      if (event.target && event.target.closest('.app-select-upgraded')) return;
      closeEnhancedSelectMenus();
    });
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape') return;
      closeEnhancedSelectMenus();
    });
  }

  function refreshEnhancedSelect(selectEl, options) {
    if (!selectEl || !selectEl._appSelectInstance) return null;
    var instance = selectEl._appSelectInstance;
    if (typeof instance.rebuild === 'function') {
      instance.rebuild(options || {});
      return instance;
    }
    if (typeof instance.sync === 'function') {
      instance.sync();
    }
    return instance;
  }

  function enhanceNativeSelect(selectEl, options) {
    if (!selectEl) return null;
    if (selectEl._appSelectInstance) {
      refreshEnhancedSelect(selectEl, options);
      return selectEl._appSelectInstance;
    }
    var opts = options || {};
    var wrapperClass = String(opts.wrapperClass || 'app-select app-select-upgraded').trim();
    var buttonClass = String(opts.buttonClass || 'app-select-button').trim();
    var menuClass = String(opts.menuClass || 'app-select-menu').trim();
    var itemClass = String(opts.itemClass || 'app-select-item').trim();
    var labelClass = String(opts.labelClass || 'app-select-label').trim();
    var placeholder = String(opts.placeholder || 'Select').trim() || 'Select';

    ensureEnhancedSelectListeners();
    selectEl.hidden = true;
    selectEl.tabIndex = -1;
    selectEl.setAttribute('aria-hidden', 'true');
    selectEl.dataset.enhanced = 'true';

    var wrapper = document.createElement('div');
    wrapper.className = wrapperClass.indexOf('app-select-upgraded') >= 0
      ? wrapperClass
      : (wrapperClass + ' app-select-upgraded');

    var button = document.createElement('button');
    button.type = 'button';
    button.className = buttonClass;
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');

    var label = document.createElement('span');
    label.className = labelClass;
    button.appendChild(label);
    button.appendChild(createChevronIcon());

    var menu = document.createElement('div');
    menu.className = menuClass;
    menu.setAttribute('role', 'listbox');
    menu.inert = true;

    wrapper.appendChild(button);
    wrapper.appendChild(menu);
    selectEl.insertAdjacentElement('afterend', wrapper);

    if (!selectEl.id) {
      selectEl.id = 'app-native-select-' + Math.random().toString(36).slice(2, 8);
    }
    button.id = selectEl.id + '-button';
    label.id = selectEl.id + '-value';
    menu.id = selectEl.id + '-menu';
    button.setAttribute('aria-controls', menu.id);
    function findFieldLabelId() {
      var labelNode = null;
      Array.prototype.slice.call(document.querySelectorAll('label[for]')).some(function (candidate) {
        if (candidate.getAttribute('for') === selectEl.id) {
          labelNode = candidate;
          return true;
        }
        return false;
      });
      if (!labelNode) labelNode = selectEl.closest('label');
      if (!labelNode) {
        var host = selectEl.closest('.field, .form-field, .physio-field, .tool-field, .input-group, .select-field, .control-field');
        labelNode = host ? host.querySelector('.field-label, .form-label, .physio-label, .select-label, label, span') : null;
      }
      if (!labelNode) return '';
      if (labelNode.contains(selectEl)) {
        var directLabel = Array.prototype.find.call(labelNode.children, function (child) {
          return child !== selectEl && child !== wrapper && !child.contains(selectEl) && child.tagName !== 'INPUT';
        });
        if (!directLabel) {
          directLabel = document.createElement('span');
          Array.prototype.slice.call(labelNode.childNodes).forEach(function (node) {
            if (node.nodeType === 3 && node.textContent.trim()) directLabel.appendChild(node);
          });
          labelNode.prepend(directLabel);
        }
        labelNode = directLabel;
      }
      if (!labelNode.id) labelNode.id = selectEl.id + '-field-label';
      return labelNode.id;
    }
    var fieldLabelId = findFieldLabelId();
    button.setAttribute('aria-labelledby', (fieldLabelId ? fieldLabelId + ' ' : '') + label.id);
    if (!fieldLabelId && selectEl.getAttribute('aria-label')) {
      button.removeAttribute('aria-labelledby');
      button.setAttribute('aria-label', selectEl.getAttribute('aria-label'));
    }
    menu.setAttribute('aria-labelledby', button.id);

    function getItems() {
      return Array.prototype.slice.call(menu.querySelectorAll('.app-select-item[data-value]')).filter(function (item) {
        return !item.disabled && !item.hidden;
      });
    }

    function focusItem(direction) {
      var items = getItems();
      if (!items.length) return;
      var currentIndex = items.indexOf(document.activeElement);
      var activeIndex = Math.max(0, items.findIndex(function (item) {
        return item.classList.contains('active');
      }));
      var nextIndex = activeIndex;
      if (direction === 'first') nextIndex = 0;
      if (direction === 'last') nextIndex = items.length - 1;
      if (direction === 'next') nextIndex = currentIndex >= 0 ? (currentIndex + 1) % items.length : activeIndex;
      if (direction === 'prev') nextIndex = currentIndex >= 0 ? (currentIndex - 1 + items.length) % items.length : activeIndex;
      items.forEach(function (item) {
        item.tabIndex = -1;
      });
      items[nextIndex].tabIndex = 0;
      items[nextIndex].focus();
    }

    function setOpen(open, focusTarget) {
      var shouldOpen = !!open && !button.disabled;
      var search = menu.querySelector('.app-select-search');
      // Restore the complete list before measuring its popover height.
      if (shouldOpen && search) { search.value = ''; search.dispatchEvent(new Event('input')); }
      if (shouldOpen) { closeEnhancedSelectMenus(menu); showAnchoredPanel(menu, button); }
      else hideAnchoredPanel(menu);
      menu.classList.toggle('visible', shouldOpen);
      menu.inert = !shouldOpen;
      button.classList.toggle('open', shouldOpen);
      button.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
      if (shouldOpen) {
        if (search && !focusTarget) search.focus();
        else focusItem(focusTarget || 'active');
      }
    }

    function sync() {
      var activeText = '';
      Array.prototype.slice.call(menu.querySelectorAll('.app-select-item[data-value]')).forEach(function (item) {
        var isActive = item.getAttribute('data-value') === String(selectEl.value || '');
        item.classList.toggle('active', isActive);
        item.setAttribute('aria-selected', isActive ? 'true' : 'false');
        item.tabIndex = -1;
        if (isActive) activeText = item.textContent;
      });
      label.textContent = activeText || (
        selectEl.options[selectEl.selectedIndex]
          ? String(selectEl.options[selectEl.selectedIndex].textContent || '').trim()
          : placeholder
      ) || placeholder;
      if (!fieldLabelId && selectEl.getAttribute('aria-label')) button.setAttribute('aria-label', selectEl.getAttribute('aria-label') + ': ' + label.textContent);
      button.disabled = !!selectEl.disabled;
      if (selectEl.disabled) setOpen(false);
      if (selectEl.validity && selectEl.validity.valid) button.removeAttribute('aria-invalid');
      wrapper.classList.toggle('is-disabled', !!selectEl.disabled);
    }

    function rebuild(rebuildOptions) {
      var rebuildOpts = rebuildOptions || {};
      while (menu.firstChild) menu.removeChild(menu.firstChild);
      var optionHost = menu;
      if (selectEl.options.length >= 8) {
        button.setAttribute('aria-haspopup', 'dialog');
        menu.setAttribute('role', 'dialog');
        var search = document.createElement('input');
        search.type = 'search';
        search.className = 'app-select-search';
        search.placeholder = 'Find an option…';
        search.setAttribute('aria-label', 'Search options');
        menu.appendChild(search);
        optionHost = document.createElement('div');
        optionHost.setAttribute('role', 'listbox');
        optionHost.setAttribute('aria-labelledby', button.id);
        optionHost.id = menu.id + '-options';
        search.setAttribute('aria-controls', optionHost.id);
        menu.appendChild(optionHost);
        var emptyMessage = document.createElement('p');
        emptyMessage.className = 'app-select-empty';
        emptyMessage.setAttribute('role', 'status');
        emptyMessage.textContent = 'No options found. Try another search.';
        emptyMessage.hidden = true;
        menu.appendChild(emptyMessage);
        search.addEventListener('input', function () {
          var query = search.value.toLowerCase().trim();
          Array.prototype.forEach.call(menu.querySelectorAll('[data-value]'), function (item) {
            item.hidden = !!query && item.textContent.toLowerCase().indexOf(query) < 0;
          });
          emptyMessage.hidden = getItems().length > 0;
        });
      } else {
        menu.setAttribute('role', 'listbox');
        button.setAttribute('aria-haspopup', 'listbox');
      }
      Array.prototype.slice.call(selectEl.options || []).forEach(function (option) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = itemClass;
        item.dataset.value = String(option.value || '');
        item.textContent = String(option.textContent || option.value || placeholder);
        item.setAttribute('role', 'option');
        item.disabled = !!option.disabled;
        item.addEventListener('click', function () {
          if (selectEl.value !== option.value) {
            selectEl.value = option.value;
            selectEl.dispatchEvent(new Event('change', { bubbles: true }));
            if (typeof opts.onChange === 'function') {
              opts.onChange(option.value, selectEl);
            }
          }
          sync();
          setOpen(false);
          button.focus();
        });
        optionHost.appendChild(item);
      });
      if (rebuildOpts.value !== undefined) {
        selectEl.value = rebuildOpts.value;
      }
      sync();
    }

    button.addEventListener('click', function (event) {
      event.preventDefault();
      setOpen(!menu.classList.contains('visible'));
    });

    button.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setOpen(true, 'first');
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setOpen(true, 'last');
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        setOpen(!menu.classList.contains('visible'));
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
      }
    });

    menu.addEventListener('keydown', function (event) {
      if (event.target.matches('input')) {
        if (event.key === 'Home' || event.key === 'End') return;
        if (event.key === 'Enter') {
          event.preventDefault();
          var matches = getItems();
          if (matches.length === 1) matches[0].click();
          else focusItem('first');
          return;
        }
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusItem('next');
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusItem('prev');
      } else if (event.key === 'Home') {
        event.preventDefault();
        focusItem('first');
      } else if (event.key === 'End') {
        event.preventDefault();
        focusItem('last');
      } else if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setOpen(false);
        button.focus();
      } else if ((event.key === 'Enter' || event.key === ' ') && !event.target.matches('input')) {
        var item = document.activeElement && document.activeElement.closest('.app-select-item[data-value]');
        if (!item) return;
        event.preventDefault();
        item.click();
      } else if (event.key === 'Tab') {
        setOpen(false);
      }
    });

    selectEl.addEventListener('change', sync);

    var instance = {
      select: selectEl,
      wrapper: wrapper,
      button: button,
      menu: menu,
      label: label,
      setOpen: setOpen,
      rebuild: rebuild,
      sync: sync,
    };
    selectEl._appSelectInstance = instance;
    enhancedSelectInstances.push(instance);
    rebuild();
    return instance;
  }

  function enhanceDateInput(input) {
    if (!input || input._appDateInstance) return input && input._appDateInstance;
    var host = document.createElement('div');
    host.className = 'app-date';
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'app-date-trigger';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.setAttribute('aria-expanded', 'false');
    var panel = document.createElement('div');
    panel.className = 'app-date-panel';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Choose a date');
    panel.id = (input.id || 'date-' + Math.random().toString(36).slice(2)) + '-calendar';
    trigger.setAttribute('aria-controls', panel.id);
    host.append(trigger, panel);
    input.insertAdjacentElement('afterend', host);
    input.classList.add('app-date-native');
    input.tabIndex = -1;
    input.setAttribute('aria-hidden', 'true');
    var cursor;
    function parse(value) {
      return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? new Date(value + 'T12:00:00') : null;
    }
    function iso(date) {
      return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    }
    function allowed(date) {
      var key = iso(date);
      return (!input.min || key >= input.min) && (!input.max || key <= input.max);
    }
    function sync() {
      var value = parse(input.value);
      trigger.textContent = value ? value.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Choose a date';
      var labels = input.labels ? Array.from(input.labels).map(function (label) {
        return Array.from(label.childNodes).filter(function (node) { return node !== host && node !== input; }).map(function (node) { return node.textContent; }).join(' ').trim();
      }).join(' ') : '';
      trigger.setAttribute('aria-label', (input.getAttribute('aria-label') || labels || 'Date') + ': ' + trigger.textContent);
      trigger.disabled = input.disabled || input.readOnly;
    }
    function close(returnFocus) {
      if (panel.hidden) return;
      panel.inert = true;
      anchoredPanels.delete(panel);
      if (panel._dateAnimation) panel._dateAnimation.cancel();
      var reduced = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
      function finishClose() { panel.hidden = true; if (typeof panel.hidePopover === 'function' && panel.matches(':popover-open')) panel.hidePopover(); clearLayoutStyles(panel); }
      if (!reduced && panel.animate) {
        var animation = panel.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(4px)' }], { duration: 140 });
        panel._dateAnimation = animation;
        animation.finished.then(function () { if (panel._dateAnimation === animation) finishClose(); }).catch(function () {});
      } else finishClose();
      trigger.setAttribute('aria-expanded', 'false');
      if (returnFocus) trigger.focus();
    }
    function choose(date) {
      input.value = date ? iso(date) : '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      sync();
      close(true);
    }
    function button(text, label, action) {
      var result = document.createElement('button');
      result.type = 'button';
      result.textContent = text;
      if (label) result.setAttribute('aria-label', label);
      result.addEventListener('click', action);
      return result;
    }
    function render(focusDay) {
      panel.replaceChildren();
      var head = document.createElement('div');
      head.className = 'app-date-heading';
      var title = document.createElement('strong');
      title.textContent = cursor.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
      title.setAttribute('aria-live', 'polite');
      function moveMonth(amount) {
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + amount, 1, 12);
        render(false);
        panel.querySelector(amount < 0 ? '.app-date-heading button:first-child' : '.app-date-heading button:last-child').focus();
      }
      head.append(button('‹', 'Previous month', function () { moveMonth(-1); }), title, button('›', 'Next month', function () { moveMonth(1); }));
      var days = document.createElement('div');
      days.className = 'app-date-grid';
      ['Mo','Tu','We','Th','Fr','Sa','Su'].forEach(function (name) {
        var cell = document.createElement('span');
        cell.textContent = name;
        cell.setAttribute('aria-hidden', 'true');
        days.appendChild(cell);
      });
      var first = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 12);
      var offset = (first.getDay() + 6) % 7;
      var count = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
      for (var blank = 0; blank < offset; blank += 1) days.appendChild(document.createElement('span'));
      for (var number = 1; number <= count; number += 1) {
        (function (day) {
          var date = new Date(cursor.getFullYear(), cursor.getMonth(), day, 12);
          var cell = button(String(day), date.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }), function () { choose(date); });
          cell.dataset.date = iso(date);
          cell.disabled = !allowed(date);
          cell.tabIndex = day === cursor.getDate() ? 0 : -1;
          cell.setAttribute('aria-pressed', String(input.value === iso(date)));
          if (iso(date) === iso(new Date())) cell.setAttribute('aria-current', 'date');
          days.appendChild(cell);
        })(number);
      }
      var footer = document.createElement('div');
      footer.className = 'app-date-footer';
      var today = button('Today', null, function () { choose(new Date()); });
      today.disabled = !allowed(new Date());
      footer.appendChild(today);
      if (!input.required) footer.appendChild(button('Clear', null, function () { choose(null); }));
      footer.appendChild(button('Close', null, function () { close(true); }));
      panel.append(head, days, footer);
      if (focusDay) {
        var target = panel.querySelector('[data-date="' + iso(cursor) + '"]:not(:disabled)') || panel.querySelector('[data-date]:not(:disabled)') || panel.querySelector('.app-date-heading button');
        if (target) { target.tabIndex = 0; target.focus(); }
      }
    }
    trigger.addEventListener('click', function () {
      if (trigger.getAttribute('aria-expanded') === 'true') { close(true); return; }
      if (panel._dateAnimation) { panel._dateAnimation.cancel(); panel._dateAnimation = null; }
      panel.inert = false;
      document.querySelectorAll('.app-date-panel:not([hidden])').forEach(function (other) {
        if (other !== panel && other._close) other._close(false);
      });
      closeEnhancedSelectMenus();
      cursor = parse(input.value) || new Date();
      if (input.min && iso(cursor) < input.min) cursor = parse(input.min);
      if (input.max && iso(cursor) > input.max) cursor = parse(input.max);
      sync();
      panel.hidden = false;
      trigger.setAttribute('aria-expanded', 'true');
      host.classList.toggle('opens-above', trigger.getBoundingClientRect().bottom + 360 > global.innerHeight && trigger.getBoundingClientRect().top > 360);
      render(false);
      showAnchoredPanel(panel, trigger);
      render(true);
    });
    panel._close = close;
    panel.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return; }
      var active = event.target.dataset.date;
      if (!active) return;
      var change = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
      if (change !== undefined) {
        event.preventDefault();
        cursor = parse(active);
        cursor.setDate(cursor.getDate() + change);
        if (input.min && iso(cursor) < input.min) cursor = parse(input.min);
        if (input.max && iso(cursor) > input.max) cursor = parse(input.max);
        render(true);
      } else if (event.key === 'PageUp' || event.key === 'PageDown') {
        event.preventDefault();
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + (event.key === 'PageUp' ? -1 : 1), 1, 12);
        render(true);
      }
    });
    host.addEventListener('focusout', function () {
      global.setTimeout(function () { if (!host.contains(document.activeElement)) close(false); }, 0);
    });

    input.addEventListener('change', sync);
    input.addEventListener('input', function () { if (input.validity.valid) trigger.removeAttribute('aria-invalid'); sync(); });
    input._appDateInstance = { sync: sync, close: close, trigger: trigger, host: host };
    sync();
    return input._appDateInstance;
  }

  function enhanceMarkedSelects(root) {
    var scope = root || document;
    var selects = Array.prototype.slice.call(scope.querySelectorAll('select[data-app-select]'));
    if (scope.matches && scope.matches('select[data-app-select]')) selects.unshift(scope);
    selects.forEach(function (select) { enhanceNativeSelect(select); });
    var dates = Array.from(scope.querySelectorAll('input[data-app-date]'));
    if (scope.matches && scope.matches('input[data-app-date]')) dates.unshift(scope);
    dates.forEach(enhanceDateInput);
    var primitives = Array.from(scope.querySelectorAll('input[type="checkbox"],input[type="radio"]'));
    if (scope.matches && scope.matches('input[type="checkbox"],input[type="radio"]')) primitives.unshift(scope);
    primitives.forEach(function (input) {
      var style = getComputedStyle(input);
      // Leave existing drawn switches and hidden selection inputs intact.
      if (style.appearance === 'none' || style.opacity === '0' || style.display === 'none') return;
      input.classList.add(input.type === 'radio' ? 'app-radio-field' : 'app-checkbox-field');
    });
    enhanceDisclosures(scope);
  }

  function watchMarkedSelects() {
    enhanceMarkedSelects(document);
    if (typeof MutationObserver !== 'function' || !document.body) return;
    var observer = new MutationObserver(function (changes) {
      var dirty = new Set();
      changes.forEach(function (change) {
        var target = change.target.nodeType === 1 ? change.target : change.target.parentElement;
        var select = target && target.closest('select[data-app-select]');
        if (select) dirty.add(select);
        var date = target && target.closest('input[data-app-date]');
        if (date && date._appDateInstance) date._appDateInstance.sync();
        Array.prototype.forEach.call(change.addedNodes || [], function (node) {
          if (node.nodeType === 1 && !node.closest('.app-select-upgraded')) enhanceMarkedSelects(node);
        });
      });
      dirty.forEach(function (select) { refreshEnhancedSelect(select); });
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled', 'selected', 'readonly'] });
  }

  document.addEventListener('click', function (event) {
    // Month navigation replaces its button before this event reaches document.
    // The original event path still identifies the calendar that was clicked.
    var path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    document.querySelectorAll('.app-date-panel:not([hidden])').forEach(function (panel) {
      if (panel._close && path.indexOf(panel) < 0 && !panel.parentElement.contains(event.target)) panel._close(false);
    });
  });

  function prefersReducedMotion() {
    return global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function enhanceDisclosures(scope) {
    var list = Array.from(scope.querySelectorAll('details'));
    if (scope.matches && scope.matches('details')) list.unshift(scope);
    list.forEach(function (details) {
      if (details._appDisclosure) return;
      var summary = details.querySelector(':scope > summary');
      if (!summary) return;
      details._appDisclosure = true;
      details.classList.add('app-disclosure');
      var iconOnly = /^[•.⋯\s]+$/.test(summary.textContent.trim());
      if (iconOnly) {
        summary.textContent = '';
        var dots = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        dots.setAttribute('viewBox', '0 0 24 24'); dots.setAttribute('aria-hidden', 'true');
        dots.classList.add('app-menu-dots');
        [5,12,19].forEach(function (x) { var dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); dot.setAttribute('cx', String(x)); dot.setAttribute('cy', '12'); dot.setAttribute('r', '1.7'); dots.appendChild(dot); });
        summary.appendChild(dots);
        details.classList.add('app-menu-icon-only');
      } else {
        var chevron = createChevronIcon();
        chevron.classList.add('app-disclosure-chevron'); chevron.setAttribute('aria-hidden', 'true');
        summary.appendChild(chevron);
      }
      if (!details.hasAttribute('data-app-menu')) return;
      details.classList.add('app-action-menu');
      var panel = details.querySelector(':scope > .app-menu-panel');
      if (!panel) return;
      panel.id = panel.id || 'app-action-menu-' + (++layoutSerial);
      summary.setAttribute('aria-controls', panel.id);
      summary.setAttribute('aria-haspopup', 'menu');
      summary.setAttribute('aria-expanded', 'false');
      panel.setAttribute('role', 'menu'); panel.inert = true;
      panel.querySelectorAll('button,a[href]').forEach(function (item) { item.setAttribute('role', 'menuitem'); });
      details.addEventListener('toggle', function () {
        if (!details.open) {
          panel.inert = true; summary.setAttribute('aria-expanded', 'false');
          anchoredPanels.delete(panel);
          if (panel.matches(':popover-open')) panel.hidePopover();
          clearLayoutStyles(panel);
        }
      });
      details.addEventListener('keydown', function (event) {
        if (event.key === 'Escape' && details.open) {
          event.preventDefault(); event.stopPropagation(); setActionMenuOpen(details, false, true); return;
        }
        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault(); event.stopPropagation();
        if (!details.open) setActionMenuOpen(details, true);
        focusMenuItem(panel, '[role="menuitem"]:not(:disabled)', event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : event.key === 'ArrowDown' ? 'next' : 'prev');
      });
      details.addEventListener('focusout', function () {
        global.setTimeout(function () { if (details.open && !details.contains(document.activeElement)) setActionMenuOpen(details, false); }, 0);
      });
    });
  }

  function setActionMenuOpen(details, opening, restoreFocus) {
    var summary = details.querySelector(':scope > summary');
    var panel = details.querySelector(':scope > .app-menu-panel');
    if (!panel || !summary) return;
    if (panel._menuAnimation) panel._menuAnimation.cancel();
    panel._menuAnimation = null;
    if (opening) {
      document.querySelectorAll('details[data-app-menu][open]').forEach(function (other) { if (other !== details) setActionMenuOpen(other, false); });
      details.open = true;
      panel.inert = false;
      showAnchoredPanel(panel, summary);
    } else {
      panel.inert = true;
      anchoredPanels.delete(panel);
    }
    details.classList.toggle('is-menu-closing', !opening);
    summary.setAttribute('aria-expanded', String(opening));
    var finish = function () {
      if (!opening) {
        if (panel.matches(':popover-open')) panel.hidePopover();
        clearLayoutStyles(panel); details.open = false;
      }
      details.classList.remove('is-menu-closing');
    };
    if (!panel.animate || prefersReducedMotion()) finish();
    else {
      var animation = panel.animate(opening ? [{ opacity: 0, transform: 'translateY(-6px) scale(.98)' }, { opacity: 1, transform: 'translateY(0) scale(1)' }] : [{ opacity: 1, transform: 'translateY(0) scale(1)' }, { opacity: 0, transform: 'translateY(-4px) scale(.985)' }], { duration: opening ? 210 : 140, easing: 'cubic-bezier(.22,1,.36,1)' });
      panel._menuAnimation = animation;
      animation.finished.then(function () { if (panel._menuAnimation !== animation) return; panel._menuAnimation = null; finish(); }).catch(function () {});
    }
    if (restoreFocus) summary.focus({ preventScroll: true });
  }

  document.addEventListener('click', function (event) {
    document.querySelectorAll('details[data-app-menu][open]').forEach(function (details) {
      if (!details.contains(event.target)) setActionMenuOpen(details, false);
      else if (event.target.closest('.app-menu-panel button,.app-menu-panel a[href]')) {
        var panel = details.querySelector(':scope > .app-menu-panel');
        setActionMenuOpen(details, false, panel && panel.contains(document.activeElement));
      }
    });
    var summary = event.target.closest('details > summary');
    if (!summary || event.defaultPrevented) return;
    var details = summary.parentElement;
    if (details.hasAttribute('data-app-menu')) {
      event.preventDefault(); setActionMenuOpen(details, !details.open || details.classList.contains('is-menu-closing')); return;
    }
    event.preventDefault();
    if (details._detailsAnimation) details._detailsAnimation.cancel();
    var start = details.getBoundingClientRect().height;
    var opening = details._detailsClosing || !details.open;
    details._detailsClosing = !opening;
    details.dispatchEvent(new CustomEvent('app:disclosurechange', { detail: { open: opening } }));
    if (!details.animate || prefersReducedMotion()) { details.open = opening; details._detailsClosing = false; return; }
    details.open = true;
    details.classList.add('app-details-animating');
    var border = details.offsetHeight - details.clientHeight;
    var end = opening ? details.scrollHeight + border : summary.getBoundingClientRect().height + border + parseFloat(getComputedStyle(details).paddingTop) + parseFloat(getComputedStyle(details).paddingBottom);
    var animation = details.animate([{ height: start + 'px', opacity: opening ? .82 : 1 }, { height: end + 'px', opacity: 1 }], { duration: opening ? 240 : 180, easing: 'cubic-bezier(.22,1,.36,1)' });
    details._detailsAnimation = animation;
    animation.finished.then(function () {
      if (details._detailsAnimation !== animation) return;
      details.open = opening;
      details._detailsClosing = false;
      details._detailsAnimation = null;
      details.classList.remove('app-details-animating');
    }).catch(function () {});
  });

  function animateModal(overlay, opening, options) {
    if (overlay._surfaceAnimation) overlay._surfaceAnimation.cancel();
    overlay._surfaceAnimation = null;
    function finish() {
      overlay.hidden = !opening;
      if (!opening && options && options.openClass) overlay.classList.remove(options.openClass);
    }
    var panel = getModalContainer(overlay, options);
    var reduced = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!panel || typeof panel.animate !== 'function' || reduced) {
      finish();
      return;
    }
    var animation = panel.animate(opening ? [
      { opacity: 0, transform: 'translateY(10px) scale(.985)' },
      { opacity: 1, transform: 'translateY(0) scale(1)' }
    ] : [
      { opacity: 1, transform: 'translateY(0) scale(1)' },
      { opacity: 0, transform: 'translateY(6px) scale(.99)' }
    ], { duration: opening ? 220 : 140, easing: 'cubic-bezier(.22,1,.36,1)' });
    overlay._surfaceAnimation = animation;
    animation.finished.then(function () {
      if (overlay._surfaceAnimation !== animation) return;
      overlay._surfaceAnimation = null;
      finish();
    }).catch(function () {});
  }

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
      return el.getAttribute('tabindex') !== '-1' && !el.closest('[inert], [hidden]') && (el.offsetParent !== null || el === document.activeElement);
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
      items[activeIndex < 0 ? items.length - 1 : (activeIndex - 1 + items.length) % items.length].focus();
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
    var state = {
      backgroundState: applyBackgroundInertness(collectBackgroundNodes(overlay, scopeRoot)),
      previousActive: previousActive,
      hadBodyScrollLock: document.body && document.body.classList.contains('body-scroll-locked'),
      onKeyDown: null,
    };

    overlay.hidden = false;
    overlay.inert = false;
    if (opts.openClass) overlay.classList.add(opts.openClass);
    animateModal(overlay, true, opts);
    overlay.setAttribute('aria-hidden', 'false');
    if (!state.hadBodyScrollLock) {
      setBodyScrollLocked(true);
    }

    state.onKeyDown = function (event) {
      if (overlay.hidden || overlay.inert) return;
      if (event.key === 'Escape' && event.target.closest('.app-select-menu.visible, .app-date-panel:not([hidden]), .app-select-button[aria-expanded="true"], details[data-app-menu][open]')) return;
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
      if (!modalStateMap || !modalStateMap.has(overlay)) return;
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
    overlay.inert = true;
    animateModal(overlay, false, opts);
    if (!state) {
      return null;
    }
    if (state.onKeyDown) {
      document.removeEventListener('keydown', state.onKeyDown, true);
    }
    restoreBackgroundInertness(state.backgroundState);
    if (!state.hadBodyScrollLock) {
      setBodyScrollLocked(false);
    }
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

  function requestDialog(options) {
    var opts = options || {};
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'app-request-overlay';
      overlay.hidden = true;
      var form = document.createElement('form');
      form.className = 'app-request-dialog';
      form.setAttribute('role', 'dialog');
      form.setAttribute('aria-modal', 'true');
      var title = document.createElement('h2');
      title.id = 'app-request-' + Math.random().toString(36).slice(2);
      title.textContent = opts.title || 'Please confirm';
      form.setAttribute('aria-labelledby', title.id);
      var message = document.createElement('p');
      message.textContent = opts.message || '';
      message.id = title.id + '-message';
      form.setAttribute('aria-describedby', message.id);
      form.append(title, message);
      var input = null;
      if (opts.inputLabel) {
        var label = document.createElement('label');
        label.textContent = opts.inputLabel;
        input = document.createElement('input');
        input.type = 'text';
        input.value = opts.inputValue || '';
        input.required = true;
        input.maxLength = opts.maxLength || 500;
        label.appendChild(input);
        form.appendChild(label);
      }
      var actions = document.createElement('div');
      actions.className = 'app-request-actions';
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = opts.cancelLabel || 'Cancel';
      var confirm = document.createElement('button');
      confirm.type = 'submit';
      confirm.textContent = opts.confirmLabel || 'Continue';
      confirm.className = opts.destructive ? 'is-destructive' : 'is-primary';
      actions.append(cancel, confirm);
      form.appendChild(actions);
      overlay.appendChild(form);
      document.body.appendChild(overlay);
      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        closeModalOverlay(overlay);
        global.setTimeout(function () { overlay.remove(); }, 180);
        resolve(value);
      }
      cancel.addEventListener('click', function () { finish(null); });
      overlay.addEventListener('click', function (event) { if (event.target === overlay) finish(null); });
      form.addEventListener('submit', function (event) {
        event.preventDefault();
        if (input && !input.value.trim()) { input.setCustomValidity('Enter a value to continue.'); input.reportValidity(); return; }
        finish(input ? input.value.trim() : true);
      });
      if (input) input.addEventListener('input', function () { input.setCustomValidity(''); });
      openModalOverlay(overlay, { initialFocus: input || (opts.destructive ? cancel : confirm), onRequestClose: function () { finish(null); } });
    });
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
    setHidden: setHidden,
    setBodyScrollLocked: setBodyScrollLocked,
    closeEnhancedSelectMenus: closeEnhancedSelectMenus,
    enhanceNativeSelect: enhanceNativeSelect,
    enhanceDateInput: enhanceDateInput,
    setLayoutStyles: setLayoutStyles,
    clearLayoutStyles: clearLayoutStyles,
    enhanceMarkedSelects: enhanceMarkedSelects,
    refreshEnhancedSelect: refreshEnhancedSelect,
    getModalContainer: getModalContainer,
    getFocusableElements: getFocusableElements,
    getVisibleMenuItems: getVisibleMenuItems,
    focusMenuItem: focusMenuItem,
    requestDialog: requestDialog,
    openModalOverlay: openModalOverlay,
    closeModalOverlay: closeModalOverlay,
    formatDateTime: formatDateTime,
    formatDate: formatDate,
    formatTime: formatTime,
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watchMarkedSelects);
  else watchMarkedSelects();
})(window);
