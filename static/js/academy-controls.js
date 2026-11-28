(function (root) {
  'use strict';

  const doc = document;
  const studio = doc.documentElement.dataset.product === 'academy';
  const segmentSelector = '.el-text-scale-group, .el-theme-toggle-group';
  const optionSelector = 'select:not([multiple]):not([size]):not([data-app-select]):not([hidden])';

  function enhanceSelects(scope) {
    const ux = root.Xped?.ux;
    if (!studio || !ux?.enhanceNativeSelect) return;
    const selects = [...scope.querySelectorAll(optionSelector)];
    if (scope.matches?.(optionSelector)) selects.push(scope);
    for (const select of selects) {
      select.dataset.appSelect = '';
      const german = doc.documentElement.lang === 'de';
      select.dataset.appSelectSearchPlaceholder = german ? 'Option suchen…' : 'Zoek een optie…';
      select.dataset.appSelectSearchLabel = german ? 'Optionen durchsuchen' : 'Opties doorzoeken';
      ux.enhanceNativeSelect(select);
    }
  }

  function initSelectTypeahead() {
    let current;
    let letters = '';
    let lastAt = 0;
    doc.addEventListener('keydown', event => {
      if (event.key.length !== 1 || event.key === ' ' || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const select = event.target.closest?.('.app-select-upgraded');
      if (!select || event.target.closest('input') || select.querySelector('.app-select-search')) return;
      const now = Date.now();
      const letter = event.key.toLocaleLowerCase(doc.documentElement.lang);
      if (current !== select || now - lastAt > 700 || letters === letter) letters = '';
      current = select;
      lastAt = now;
      letters += letter;
      const options = [...select.querySelectorAll('[role="option"]:not([disabled])')];
      const previous = options.indexOf(doc.activeElement);
      const ordered = letters.length === 1 ? options.slice(previous + 1).concat(options.slice(0, previous + 1)) : options;
      const match = ordered.find(option => option.textContent.trim().toLocaleLowerCase(doc.documentElement.lang).startsWith(letters));
      if (!match) return;
      event.preventDefault();
      const trigger = select.querySelector('[aria-haspopup]');
      if (trigger.getAttribute('aria-expanded') === 'false') trigger.click();
      match.focus();
    });
  }

  function syncSegments(group) {
    group.setAttribute('role', 'radiogroup');
    const buttons = group.querySelectorAll('button');
    for (const button of buttons) {
      const selected = button.classList.contains('is-active');
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-checked', String(selected));
      button.removeAttribute('aria-pressed');
      button.tabIndex = selected ? 0 : -1;
    }
  }

  function initSegments() {
    for (const group of doc.querySelectorAll(segmentSelector)) {
      syncSegments(group);
      const observer = new MutationObserver(() => syncSegments(group));
      observer.observe(group, { subtree: true, attributes: true, attributeFilter: ['class', 'aria-pressed'] });
      group.addEventListener('keydown', function (event) {
        const keys = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown', 'Home', 'End'];
        if (!keys.includes(event.key)) return;
        const buttons = [...group.querySelectorAll('button:not(:disabled)')];
        const position = buttons.indexOf(event.target);
        if (position < 0) return;
        let next = (position + (keys.indexOf(event.key) < 2 ? -1 : 1) + buttons.length) % buttons.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = buttons.length - 1;
        event.preventDefault();
        buttons[next].click();
        buttons[next].focus();
      });
    }
  }

  function initTips() {
    const tip = doc.createElement('div');
    tip.className = 'academy-control-tip';
    tip.setAttribute('role', 'tooltip');
    tip.id = 'academy-control-tip';
    tip.hidden = true;
    if ('showPopover' in tip) tip.popover = 'manual';
    doc.body.append(tip);
    let active;
    let timer;
    function close() {
      clearTimeout(timer);
      if (active) {
        active.classList.remove('academy-tip-target');
        const ids = (active.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== tip.id);
        if (ids.length) active.setAttribute('aria-describedby', ids.join(' '));
        else active.removeAttribute('aria-describedby');
      }
      active = null;
      if (tip.hidePopover && tip.matches(':popover-open')) tip.hidePopover();
      tip.hidden = true;
    }
    function offer(event) {
      const button = event.target.closest?.('button[title], a[title], time[title], [data-academy-tip]');
      if (!button || button.disabled || button.matches('[aria-expanded="true"]')) return;
      if (active === button && (event.type !== 'focusin' || !tip.hidden)) return;
      close();
      if (button.title) {
        button.dataset.academyTip = button.title;
        if (!button.hasAttribute('aria-label') && !button.textContent.trim()) button.setAttribute('aria-label', button.title);
        button.removeAttribute('title');
      }
      active = button;
      const show = () => {
        if (!button.isConnected || button !== active) return close();
        (button.closest('dialog[open]') || doc.body).append(tip);
        tip.textContent = button.dataset.academyTip;
        const ids = (button.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
        button.setAttribute('aria-describedby', [...new Set([...ids, tip.id])].join(' '));
        button.classList.add('academy-tip-target');
        tip.hidden = false;
        tip.showPopover?.();
      };
      if (event.type === 'focusin') show();
      else timer = setTimeout(show, 400);
    }
    doc.addEventListener('pointerover', offer);
    doc.addEventListener('focusin', offer);
    for (const name of ['pointerout','focusout']) doc.addEventListener(name, event => {
      if (active?.contains(event.target) && !active.contains(event.relatedTarget)) close();
    });
    doc.addEventListener('pointerdown', close);
    doc.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
    doc.addEventListener('scroll', close, true);
    root.addEventListener('resize', close);
  }

  // A scrolling tab row shows which edges hide more tabs, and keeps the current tab in view.
  const tabRowSelector = 'nav.xc-tabs, [role="tablist"]';
  function syncTabEdges(row) {
    const max = row.scrollWidth - row.clientWidth;
    const start = Math.abs(row.scrollLeft);
    row.classList.toggle('academy-tabs-start', max > 1 && start > 1);
    row.classList.toggle('academy-tabs-end', max > 1 && start < max - 1);
  }
  function watchTabRow(row) {
    if (row.hasAttribute('data-academy-tabs')) return;
    row.dataset.academyTabs = '';
    row.classList.add('academy-tab-row');
    row.addEventListener('scroll', () => syncTabEdges(row), { passive: true });
    if (root.ResizeObserver) new root.ResizeObserver(() => syncTabEdges(row)).observe(row);
    const current = row.querySelector('[aria-current], [aria-selected="true"], .is-active');
    if (current && row.scrollWidth > row.clientWidth) current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    syncTabEdges(row);
  }
  function initTabRows(scope) {
    if (!studio) return;
    const rows = [...scope.querySelectorAll(tabRowSelector)];
    if (scope.matches?.(tabRowSelector)) rows.push(scope);
    rows.forEach(watchTabRow);
  }

  // Typing in an open action menu moves to the next item that starts with those letters.
  function initMenuTypeahead() {
    let current;
    let letters = '';
    let lastAt = 0;
    doc.addEventListener('keydown', event => {
      if (event.key.length !== 1 || event.key === ' ' || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const menu = event.target.closest?.('[role="menu"]');
      if (!menu) return;
      const lang = doc.documentElement.lang;
      const now = Date.now();
      const letter = event.key.toLocaleLowerCase(lang);
      if (current !== menu || now - lastAt > 700 || letters === letter) letters = '';
      current = menu;
      lastAt = now;
      letters += letter;
      const items = [...menu.querySelectorAll('[role="menuitem"]:not([disabled]):not([aria-disabled="true"])')];
      const previous = items.indexOf(doc.activeElement);
      const ordered = letters.length === 1 ? items.slice(previous + 1).concat(items.slice(0, previous + 1)) : items;
      const match = ordered.find(item => item.textContent.trim().toLocaleLowerCase(lang).startsWith(letters));
      if (!match) return;
      event.preventDefault();
      match.focus();
    });
  }

  // A station per node; real step counts and measured reach are optional.
  function routeStrip(stations, options = {}) {
    const strip = doc.createElement('span');
    const size = ['compact', 'regular', 'large'].includes(options.size) ? options.size : 'regular';
    strip.className = 'academy-route-strip is-' + size;
    if (options.label) {
      strip.setAttribute('role', 'img');
      strip.setAttribute('aria-label', options.label);
    } else strip.setAttribute('aria-hidden', 'true');
    for (const station of stations || []) {
      const node = doc.createElement('span');
      node.className = 'academy-route-station';
      if (Number.isFinite(station.reached)) node.dataset.reach = station.reached < .35 ? 'low' : station.reached < .75 ? 'middle' : 'high';
      const count = Array.isArray(station.steps) ? station.steps.length : Number(station.steps) || 0;
      for (let i = 0; i < Math.min(5, count); i++) node.append(doc.createElement('i'));
      strip.append(node);
    }
    return strip;
  }

  function init() {
    enhanceSelects(doc);
    if (studio) {
      initSelectTypeahead();
      initMenuTypeahead();
      initTabRows(doc);
      new MutationObserver(changes => {
        for (const change of changes) for (const node of change.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (!node.closest('.app-select-upgraded')) enhanceSelects(node);
          initTabRows(node);
        }
      }).observe(doc.body, { childList: true, subtree: true });
    }
    initSegments();
    initTips();
  }
  root.XpedAcademyControls = { routeStrip };
  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init);
  else init();
})(window);
