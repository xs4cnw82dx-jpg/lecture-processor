(function () {
  'use strict';

  var frame = document.documentElement;
  var settings = document.getElementById('ac-settings-toggle');
  var panel = document.getElementById('ac-settings-popover');
  var rail = document.getElementById('ac-rail');
  var menu = document.getElementById('ac-nav-toggle');
  var backdrop = document.querySelector('.ac-nav-backdrop');
  var fold = document.getElementById('ac-fold');
  var search = document.getElementById('ac-search');
  var searchTrigger = document.getElementById('ac-search-trigger');
  var compact = window.matchMedia('(max-width: 1023px)');
  var inerted = [];
  var previousFocus;
  var courseCrumb = document.querySelector('[data-ac-course-name]');
  if (courseCrumb) {
    document.addEventListener('academy:course-title', function (event) {
      courseCrumb.textContent = event.detail || courseCrumb.dataset.default;
    });
  }

  function closeSettings(focusButton) {
    if (!panel || panel.hidden) return;
    panel.hidden = true;
    settings.setAttribute('aria-expanded', 'false');
    if (focusButton) settings.focus();
  }

  if (settings && panel) {
    settings.addEventListener('click', function () {
      if (!panel.hidden) { closeSettings(false); return; }
      panel.hidden = false;
      settings.setAttribute('aria-expanded', 'true');
    });
    document.addEventListener('pointerdown', function (event) {
      if (!panel.contains(event.target) && !settings.contains(event.target)) closeSettings(false);
    });
    document.addEventListener('focusin', function (event) {
      if (!panel.contains(event.target) && !settings.contains(event.target)) closeSettings(false);
    });
  }

  function setDrawer(open, focusTrigger) {
    if (!rail || !menu) return;
    inerted.forEach(function (node) { node.inert = false; });
    inerted = [];
    if (open && compact.matches) {
      closeSettings(false);
      previousFocus = document.activeElement;
      frame.dataset.acDrawer = 'open';
      rail.inert = false;
      rail.setAttribute('role', 'dialog');
      rail.setAttribute('aria-modal', 'true');
      backdrop.hidden = false;
      menu.setAttribute('aria-expanded', 'true');
      rail.querySelector('[data-ac-close-nav]').focus();
      Array.from(document.body.children).forEach(function (node) {
        if (node !== rail && node !== backdrop && !node.inert && !['SCRIPT','LINK','STYLE'].includes(node.tagName)) {
          node.inert = true;
          inerted.push(node);
        }
      });
    } else {
      delete frame.dataset.acDrawer;
      rail.removeAttribute('role');
      rail.removeAttribute('aria-modal');
      rail.inert = compact.matches;
      backdrop.hidden = true;
      menu.setAttribute('aria-expanded', 'false');
      if (focusTrigger && previousFocus && previousFocus.isConnected) previousFocus.focus();
    }
  }

  function setFolded(value) {
    frame.toggleAttribute('data-ac-folded', value);
    if (!fold) return;
    var title = value ? fold.dataset.expand : fold.dataset.collapse;
    fold.querySelector('span').textContent = title;
    fold.title = title;
    fold.setAttribute('aria-label', title);
    fold.setAttribute('aria-expanded', String(!value));
  }

  if (rail && menu) {
    menu.addEventListener('click', function () { setDrawer(true, false); });
    document.querySelectorAll('[data-ac-close-nav]').forEach(function (button) {
      button.addEventListener('click', function () { setDrawer(false, true); });
    });
    compact.addEventListener('change', function () { setDrawer(false, false); closeSettings(false); });
    setDrawer(false, false);
    window.addEventListener('pageshow', function (event) {
      if (event.persisted) { setDrawer(false, false); closeSettings(false); }
    });
  }
  if (fold) {
    try { setFolded(localStorage.getItem('xped.sidebar.compact') === '1'); }
    catch (_) { setFolded(false); }
    fold.addEventListener('click', function () {
      var next = !frame.hasAttribute('data-ac-folded');
      setFolded(next);
      try { localStorage.setItem('xped.sidebar.compact', next ? '1' : '0'); }
      catch (_) { /* The preference still applies on this page. */ }
    });
  }

  var input = document.getElementById('ac-jump');
  var destinations = search ? Array.from(search.querySelectorAll('[data-ac-pages] > a')) : [];
  function matchedLetters(value) {
    return value.trim().toLocaleLowerCase(document.documentElement.lang || 'nl')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  function filterDestinations() {
    var query = matchedLetters(input.value);
    destinations.forEach(function (link) {
      link.hidden = link.hasAttribute('data-ac-unavailable') || !matchedLetters(link.textContent).includes(query);
    });
    search.querySelector('[data-ac-no-results]').hidden = destinations.some(function (link) { return !link.hidden; });
  }
  function showSearch() {
    if (!search || typeof search.showModal !== 'function' || search.open) return;
    if (document.querySelector('dialog[open]') || frame.dataset.acDrawer === 'open') return;
    closeSettings(false);
    input.value = '';
    filterDestinations();
    search.showModal();
    input.setAttribute('aria-expanded', 'true');
    input.focus();
  }
  if (search) {
    if (searchTrigger) {
      searchTrigger.addEventListener('click', showSearch);
      if (!/Mac|iPhone|iPad/i.test(navigator.platform)) searchTrigger.querySelector('kbd').textContent = 'Ctrl K';
    }
    search.querySelector('[data-ac-close-search]').addEventListener('click', function () { search.close(); });
    search.addEventListener('click', function (event) {
      if (event.target !== search) return;
      var rect = search.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) search.close();
    });
    input.addEventListener('input', filterDestinations);
    search.addEventListener('close', function () {
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    });
    input.addEventListener('keydown', function (event) {
      if (event.isComposing || !['Enter', 'ArrowDown', 'ArrowUp'].includes(event.key)) return;
      var matches = Array.from(search.querySelectorAll('[role="option"]')).filter(function (option) {
        return !option.closest('[hidden]') && !option.hasAttribute('data-ac-unavailable');
      });
      if (!matches.length) return;
      event.preventDefault();
      var current = document.getElementById(input.getAttribute('aria-activedescendant'));
      var index = matches.indexOf(current);
      if (event.key === 'Enter') {
        matches[Math.max(0, index)].click();
        return;
      }
      if (current) current.setAttribute('aria-selected', 'false');
      if (event.key === 'ArrowDown') index = (index + 1) % matches.length;
      else index = index <= 0 ? matches.length - 1 : index - 1;
      var next = matches[index];
      next.setAttribute('aria-selected', 'true');
      input.setAttribute('aria-activedescendant', next.id);
      next.scrollIntoView({block:'nearest'});
    });
  }
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') {
      if (frame.dataset.acDrawer === 'open') { event.preventDefault(); setDrawer(false, true); }
      else closeSettings(true);
    }
    if (event.key === 'Tab' && frame.dataset.acDrawer === 'open') {
      var links = Array.from(rail.querySelectorAll('a,button')).filter(function (link) { return link.getClientRects().length; });
      if (event.shiftKey && document.activeElement === links[0]) { event.preventDefault(); links.at(-1).focus(); }
      else if (!event.shiftKey && document.activeElement === links.at(-1)) { event.preventDefault(); links[0].focus(); }
    }
    if (search && (event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (search.open) search.close(); else showSearch();
    }
  });
})();
