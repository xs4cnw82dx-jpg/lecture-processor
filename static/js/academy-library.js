(function () {
  'use strict';
  const { language, t: uiText, courseStatus: state } = window.Xped.i18n;
  const headings = [
    ['title', uiText('library.course')], ['state', 'Status'],
    ['role', uiText('library.role')], ['stepCount', uiText('library.structure')],
    ['languages', uiText('library.languages')], ['updatedAt', uiText('library.updated')],
    ['actions', uiText('library.actions')],
  ];
  const help = document.getElementById('ac-library-help');
  const helpTrigger = document.getElementById('ac-library-keys');
  const grid = document.getElementById('el-dash-grid');
  const collator = new Intl.Collator(language, { numeric: true, sensitivity: 'base' });
  let sortKey = 'updatedAt', direction = -1;
  let renderLibrary;
  const narrow = window.matchMedia('(max-width: 1200px)');
  narrow.addEventListener('change', () => {
    grid.querySelectorAll('th button').forEach(button => { button.tabIndex = narrow.matches ? -1 : 0; });
  });
  const compactOrder = document.getElementById('ac-library-order');
  const compactSort = document.getElementById('ac-library-sort');
  const compactDirection = document.getElementById('ac-library-direction');
  for (const [key, label] of headings) {
    if (key !== 'actions') compactSort.add(new Option(label, key, false, key === sortKey));
  }
  compactSort.addEventListener('change', () => {
    sortKey = compactSort.value;
    direction = sortKey === 'updatedAt' ? -1 : 1;
    renderLibrary?.();
  });
  compactDirection.addEventListener('click', () => { direction *= -1; renderLibrary?.(); });


  function node(name, text, className) {
    const element = document.createElement(name);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function role(course) {
    if (course.role === 'owner') return uiText('library.owner');
    if (course.role === 'translate') return uiText('library.translator');
    return uiText('library.coauthor');
  }

  function sortedValue(course) {
    if (sortKey === 'state') return state(course)[1];
    if (sortKey === 'role') return role(course);
    if (sortKey === 'languages') return (course.enabledLanguages || ['nl']).filter(code => code === 'nl' || code === 'de').join(' ');
    return course[sortKey] ?? '';
  }

  function sorted(courses) {
    return courses.slice().sort((a,b) => {
      const first = sortedValue(a), second = sortedValue(b);
      return direction * (typeof first === 'number' && typeof second === 'number' ? first - second : collator.compare(first,second));
    });
  }

  function table(render) {
    renderLibrary = render;
    if (compactSort.value !== sortKey) {
      compactSort.value = sortKey;
      window.Xped.ux.refreshEnhancedSelect(compactSort);
    }
    compactDirection.textContent = direction === 1 ? '↑' : '↓';
    compactDirection.setAttribute('aria-label', direction === 1
      ? uiText('library.sortDesc') : uiText('library.sortAsc'));
    const table = node('table', undefined, 'ac-library-table');
    table.setAttribute('aria-label', uiText('library.courses'));
    const labels = table.createTHead().insertRow();
    for (const [key, label] of headings) {
      const th = node('th');
      th.scope = 'col'; th.dataset.column = key;
      if (key === 'actions') th.append(node('span', label, 'sr-only'));
      else {
        const button = node('button',label);
        button.type = 'button';
        button.tabIndex = narrow.matches ? -1 : 0;
        if (sortKey === key) {
          th.setAttribute('aria-sort',direction === 1 ? 'ascending' : 'descending');
          const caret = node('span', direction === 1 ? ' ↑' : ' ↓');
          caret.setAttribute('aria-hidden','true'); button.append(caret);
        }
        button.addEventListener('click', () => {
          direction = sortKey === key ? -direction : key === 'updatedAt' ? -1 : 1;
          sortKey = key;
          render(); grid.querySelector('th[aria-sort] button')?.focus();
        });
        th.append(button);
      }
      labels.append(th);
    }
    grid.append(table);
    return table.createTBody();
  }

  function fallbackCover(course) {
    const originals = ['library','detour','choices','finish','steps','rest'];
    const seed = Array.from(course.id).reduce((n,c) => (n * 31 + c.codePointAt(0)) >>> 0, 0);
    const img = new Image();
    img.alt = ''; img.loading = 'lazy'; img.className = 'is-xped-art';
    img.src = '/static/images/xped/academy-' + originals[seed % originals.length] + '.webp';
    return img;
  }

  function finishRow(row, course, main, languages, detail, time, actions) {
    const courseLink = main.querySelector('h2 a');
    if (courseLink) row.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey ||
        event.target.closest('a, button, input, time, [role="menu"]') || window.getSelection()?.toString()) return;
      courseLink.click();
    });
    const [kind, text] = state(course);
    const status = node('span',text,'ac-course-state');
    status.dataset.state = kind;
    const structure = node('span', uiText('count.stations', { count: course.moduleCount ?? 0 }));
    structure.append(node('small',uiText('count.steps', { count: course.stepCount ?? 0 })));
    const coverage = node('div'); coverage.append(languages,detail);
    const values = [main,status,node('span',role(course)),structure,coverage,time || node('span','—'),actions];
    values.forEach((value,i) => {
      const cell = row.insertCell();
      cell.dataset.column = headings[i][0];
      cell.dataset.label = headings[i][1];
      cell.append(value);
    });
  }

  helpTrigger.addEventListener('click', () => help.showModal());
  grid.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
      event.target.closest('input,textarea,select,[contenteditable="true"],[role="menu"],thead')) return;
    const active = event.target.closest('[data-expedition-row]');
    if (!active) return;
    const key = event.key;
    if (key === '?') { event.preventDefault(); help.showModal(); return; }
    if (key === '.') {
      const menu = active.querySelector('[aria-haspopup="menu"]');
      if (menu) { event.preventDefault(); if (menu.getAttribute('aria-expanded') !== 'true') menu.click(); }
      return;
    }
    if (!['j','k'].includes(key)) return;
    const links = [...grid.querySelectorAll('.el-exp-card-top h2 a')];
    const current = active.querySelector('.el-exp-card-top h2 a');
    const index = links.indexOf(current);
    if (index < 0) return;
    event.preventDefault();
    links[Math.max(0,Math.min(links.length-1,index+(key === 'j' ? 1 : -1)))].focus();
  });

  let countRequest = 0;
  async function showDeletionImpact(course, api) {
    const dialog = document.getElementById('el-delete-dialog');
    const confirm = document.getElementById('el-delete-confirm');
    let message = document.getElementById('ac-delete-impact');
    if (!message) {
      message = node('p');
      message.id = 'ac-delete-impact';
      message.setAttribute('role', 'status');
      document.getElementById('el-delete-dialog-msg').nextElementSibling.after(message);
      confirm.setAttribute('aria-describedby', message.id);
    }
    const version = ++countRequest;
    confirm.disabled = true;
    message.textContent = uiText('library.loadingImpact');
    let count;
    try {
      const result = await api('/api/elearning/expeditions/' + encodeURIComponent(course.id) + '/outline-results',
        {signal:AbortSignal.timeout(5000)});
      if (Number.isSafeInteger(result.totalSessions) && result.totalSessions >= 0) count = result.totalSessions;
    } catch (_) { /* The owner can still confirm with the explicit unknown-count warning. */ }
    if (version !== countRequest || !dialog.open) return;
    if (count === undefined) message.textContent = uiText('library.unknownImpact');
    else message.textContent = uiText('library.deletionImpact', { count });
    confirm.disabled = false;
  }

  window.XpedAcademyLibrary = {sorted, table, fallbackCover, finishRow, showDeletionImpact,
    showHelp(show) { compactOrder.hidden = !show; helpTrigger.hidden = !show; if (!show && help.open) help.close(); }};
})();
