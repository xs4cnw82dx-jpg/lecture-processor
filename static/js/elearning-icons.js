(function (root) {
  'use strict';

  var NS = 'http://www.w3.org/2000/svg';

  var PATHS = {
    arrowLeft: ['M19 12H5', 'M12 19l-7-7 7-7'],
    arrowRight: ['M5 12h14', 'M12 5l7 7-7 7'],
    chevronDown: ['M6 9l6 6 6-6'],
    chevronUp: ['M18 15l-6-6-6 6'],
    chevronRight: ['M9 18l6-6-6-6'],
    plus: ['M12 5v14', 'M5 12h14'],
    x: ['M18 6L6 18', 'M6 6l12 12'],
    check: ['M20 6L9 17l-5-5'],
    checkCircle: ['M22 11.08V12a10 10 0 1 1-5.93-9.14', 'M22 4L12 14.01l-3-3'],
    xCircle: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M15 9l-6 6', 'M9 9l6 6'],
    alertCircle: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 8v4', 'M12 16h.01'],
    cloudCheck: ['M20 16.2A4.5 4.5 0 0 0 17.5 8h-1.8A7 7 0 1 0 4 14.9', 'M9 15l2 2 4-4'],
    messageCircle: ['M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'],
    search: ['M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z', 'M21 21l-4.35-4.35'],
    refresh: ['M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5'],
    bold: ['M6 4h8a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z', 'M6 12h9a4 4 0 0 1 4 4 4 4 0 0 1-4 4H6z'],
    list: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'],
    link: ['M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
    pause: ['M6 4h4v16H6z', 'M14 4h4v16h-4z'],
    type: ['M4 7V4h16v3', 'M9 20h6', 'M12 4v16'],
    sliders: ['M4 21v-7', 'M4 10V3', 'M12 21v-9', 'M12 8V3', 'M20 21v-5', 'M20 12V3', 'M1 14h6', 'M9 8h6', 'M17 16h6'],
    info: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M12 16v-4', 'M12 8h.01'],
    code: ['M16 18l6-6-6-6', 'M8 6l-6 6 6 6'],
    wand: ['M15 4V2', 'M15 16v-2', 'M8 9h2', 'M20 9h2', 'M17.8 11.8L19 13', 'M15 9h0', 'M17.8 6.2L19 5', 'M3 21l9-9', 'M12.2 6.2L11 5'],
    play: ['M5 3l14 9-14 9V3z'],
    undo: ['M3 7v6h6', 'M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13'],
    redo: ['M21 7v6h-6', 'M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13'],
    grip: ['M9 6h.01', 'M9 12h.01', 'M9 18h.01', 'M15 6h.01', 'M15 12h.01', 'M15 18h.01'],
    copy: ['M8 8h12v12H8z', 'M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3'],
    trash: ['M3 6h18', 'M8 6V4h8v2', 'M19 6l-1 14H6L5 6'],
    share: ['M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8', 'M16 6l-4-4-4 4', 'M12 2v13'],
    more: ['M5 12h.01', 'M12 12h.01', 'M19 12h.01'],
    globe: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M2 12h20', 'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z'],
    compass: ['M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z', 'M16.24 7.76l-2.12 6.36-6.36 2.12 2.12-6.36 6.36-2.12z'],
    map: ['M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z', 'M8 2v16', 'M16 6v16'],
    monitor: ['M2 4h20v12H2z', 'M8 20h8', 'M12 16v4'],
    phone: ['M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z', 'M12 18h.01'],
    upload: ['M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4', 'M17 8l-5-5-5 5', 'M12 3v12'],
    note: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6', 'M8 13h8', 'M8 17h5'],
    spark: ['M12 3l1.9 5.8L20 10.7l-5 3.8 1.9 6L12 17l-4.9 3.5 1.9-6-5-3.8 6.1-1.9L12 3z'],
    video: ['M23 7l-7 5 7 5V7z', 'M1 5h15a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H1V5z'],
    image: ['M3 5h18a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z', 'M8.5 10.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z', 'M21 15l-5-5L5 21'],
    book: ['M4 19.5A2.5 2.5 0 0 1 6.5 17H20', 'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'],
    scale: ['M12 3v18', 'M4 7h16', 'M7 7l-3 7h6l-3-7z', 'M17 7l-3 7h6l-3-7z', 'M8 21h8'],
    external: ['M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6', 'M15 3h6v6', 'M10 14L21 3'],
    eye: ['M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z', 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
    chart: ['M18 20V10', 'M12 20V4', 'M6 20v-6'],
    print: ['M6 9V2h12v7', 'M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2', 'M6 14h12v8H6z'],
  };

  function icon(name, size) {
    var sz = size || 17;
    var svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', String(sz));
    svg.setAttribute('height', String(sz));
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.85');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.classList.add('el-icon');
    (PATHS[name] || PATHS.spark).forEach(function (d) {
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    });
    return svg;
  }

  /* Smooth animated accessible dropdown menu component (replaces raw OS selects & menus). */
  var closeActiveMenu = null;

  function createDropdown(options) {
    var wrap = document.createElement('div');
    wrap.className = 'el-dd' + (options.className ? (' ' + options.className) : '');
    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = options.triggerClass || 'el-dd-trigger';
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    if (options.ariaLabel) trigger.setAttribute('aria-label', options.ariaLabel);

    var labelSpan = document.createElement('span');
    labelSpan.className = 'el-dd-label';
    if (options.leadingIcon) trigger.appendChild(icon(options.leadingIcon, 16));
    trigger.appendChild(labelSpan);
    var chev = icon('chevronDown', 14);
    chev.classList.add('el-dd-chevron');
    if (options.showChevron !== false) trigger.appendChild(chev);

    var menu = document.createElement('div');
    menu.className = 'el-dd-menu' + (options.align === 'right' ? ' is-right' : '');
    menu.setAttribute('role', 'menu');

    var isOpen = false;
    function close() { setOpen(false); }
    function outside(event) {
      if (!wrap.contains(event.target)) close();
    }
    function setOpen(next) {
      if (!!next === isOpen) return;
      if (next && closeActiveMenu) closeActiveMenu();
      isOpen = !!next;
      wrap.classList.toggle('is-open', isOpen);
      menu.inert = !isOpen;
      trigger.setAttribute('aria-expanded', String(isOpen));
      if (isOpen) {
        closeActiveMenu = close;
        document.addEventListener('pointerdown', outside);
        document.addEventListener('focusin', outside);
      } else {
        closeActiveMenu = null;
        document.removeEventListener('pointerdown', outside);
        document.removeEventListener('focusin', outside);
      }
    }
    menu.inert = true;

    function setItems(items, currentValue) {
      menu.textContent = '';
      var activeLabel = options.placeholder || '';
      (items || []).forEach(function (item) {
        if (item.divider) {
          var sep = document.createElement('div');
          sep.className = 'el-dd-sep';
          sep.setAttribute('role', 'separator');
          menu.appendChild(sep);
          return;
        }
        var btn = document.createElement(item.href ? 'a' : 'button');
        if (item.href) { btn.href = item.href; btn.target = '_blank'; btn.rel = 'noopener'; }
        else btn.type = 'button';
        btn.className = 'el-dd-item' + (item.danger ? ' is-danger' : '') + (item.value !== undefined && item.value === currentValue ? ' is-selected' : '');
        btn.setAttribute('role', 'menuitem');
        if (item.icon) btn.appendChild(icon(item.icon, 15));
        var txt = document.createElement('span');
        txt.textContent = item.label;
        btn.appendChild(txt);
        if (item.value !== undefined && item.value === currentValue) {
          activeLabel = item.shortLabel || item.label;
          var chk = icon('check', 14);
          chk.classList.add('el-dd-check');
          btn.appendChild(chk);
        }
        btn.addEventListener('click', function () {
          trigger.focus();
          close();
          if (typeof item.onClick === 'function') item.onClick();
          else if (typeof options.onChange === 'function') options.onChange(item.value);
        });
        menu.appendChild(btn);
      });
      if (options.fixedLabel !== undefined) labelSpan.textContent = options.fixedLabel;
      else if (activeLabel) labelSpan.textContent = activeLabel;
    }

    trigger.addEventListener('click', function () {
      setOpen(!isOpen);
      if (isOpen) menu.querySelector('[role="menuitem"]')?.focus();
    });
    wrap.addEventListener('keydown', function (event) {
      var items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
      if (!items.length) return;
      if (event.key === 'Escape' && isOpen) {
        event.preventDefault();
        event.stopPropagation();
        close();
        trigger.focus();
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      setOpen(true);
      var index = items.indexOf(document.activeElement);
      if (event.key === 'Home') index = 0;
      if (event.key === 'End') index = items.length - 1;
      if (event.key === 'ArrowDown') index = (index + 1) % items.length;
      if (event.key === 'ArrowUp') index = index <= 0 ? items.length - 1 : index - 1;
      items[index].focus();
    });
    wrap.appendChild(trigger);
    wrap.appendChild(menu);
    setItems(options.items || [], options.value);

    return {
      el: wrap,
      trigger: trigger,
      setItems: setItems,
      setOpen: setOpen,
    };
  }

  /* Modern Web Guidance: Top-layer <dialog> smooth exit helper for browsers lacking overlay/discrete display transition. */
  function supportsTopLayerExit() {
    return window.CSS && window.CSS.supports('overlay', 'auto') && window.CSS.supports('transition-behavior', 'allow-discrete');
  }

  async function closeDialogAnimated(dialog) {
    if (!dialog || !dialog.open) return;
    if (!supportsTopLayerExit()) {
      dialog.setAttribute('data-closing', '');
      var anims = typeof dialog.getAnimations === 'function' ? dialog.getAnimations({ subtree: true }) : [];
      if (anims.length) {
        await Promise.race([
          Promise.allSettled(anims.map(function (a) { return a.finished; })),
          new Promise(function (r) { setTimeout(r, 400); }),
        ]);
      }
      if (!dialog.hasAttribute('data-closing')) return;
      dialog.removeAttribute('data-closing');
    }
    dialog.close();
  }

  function wireAnimatedDialogs() {
    document.querySelectorAll('dialog.el-dialog').forEach(function (dlg) {
      if (dlg._elAnimatedWired) return;
      dlg._elAnimatedWired = true;
      dlg.querySelectorAll('form[method="dialog"] button.el-icon-btn').forEach(function (btn) {
        btn.className = 'el-icon-btn';
        btn.textContent = '';
        btn.appendChild(icon('x', 17));
      });
      dlg.addEventListener('cancel', function (e) {
        e.preventDefault();
        closeDialogAnimated(dlg);
      });
    });
  }

  root.XpedElearningIcons = {
    icon: icon,
    createDropdown: createDropdown,
    closeDialogAnimated: closeDialogAnimated,
    wireAnimatedDialogs: wireAnimatedDialogs,
  };
})(typeof window !== 'undefined' ? window : globalThis);
