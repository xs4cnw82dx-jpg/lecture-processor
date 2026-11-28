/* Search the current member's Academy destinations when the finder opens. */
(function () {
  'use strict';
  const dialog = document.getElementById('ac-search');
  if (!dialog) return;
  const query = document.getElementById('ac-jump');
  const extra = dialog.querySelector('[data-ac-matches]');
  const recentGroup = dialog.querySelector('[data-ac-recent]');
  const noResults = dialog.querySelector('[data-ac-no-results]');
  const pages = Array.from(dialog.querySelectorAll('[data-ac-pages] > a'));
  const copy = (nl, de) => window.Xped.i18n.copy(nl, de);
  const normalize = value => String(value || '').trim().toLocaleLowerCase(document.documentElement.lang)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const historyKey = 'xped.finder.history';
  let account, uid, salt = '', history = [], entries = [], pending, ready = false;

  function writeHistory() {
    try {
      if (uid && history.length) sessionStorage.setItem(historyKey, JSON.stringify({uid, salt, history}));
      else sessionStorage.removeItem(historyKey);
    } catch (_) { /* Recent destinations still work until the page closes. */ }
  }

  function readHistory() {
    try {
      const stored = JSON.parse(sessionStorage.getItem(historyKey));
      if (uid && stored?.uid === uid && typeof stored.salt === 'string' && Array.isArray(stored.history)) {
        salt = stored.salt;
        history = stored.history.filter(ref => typeof ref === 'string').slice(0, 4);
      } else {
        history = [];
        salt = '';
        sessionStorage.removeItem(historyKey);
      }
    } catch (_) { /* Keep the current member's in-memory history when storage is unavailable. */ }
    if (uid && !salt) salt = window.crypto.randomUUID();
  }

  function changeMember(nextUid) {
    const previousUid = uid;
    uid = nextUid;
    clearResults();
    history = [];
    salt = '';
    readHistory();
    if (previousUid || !uid) roleNav(false, false, []);
  }

  function remember(ref) {
    if (!ref || !uid || uid !== account?.currentUser?.uid) return;
    history = [ref, ...history.filter(existing => existing !== ref)].slice(0, 4);
    writeHistory();
  }

  function roleNav(canCreate, admin, roles) {
    const allowed = { '/team':admin, '/resultaten':canCreate || roles.some(r => r === 'owner' || r === 'edit'), '/vertalingen':canCreate || roles.length > 0 };
    document.querySelectorAll('#ac-rail .ac-route, #ac-search [data-ac-pages] > a').forEach(link => {
      if (Object.hasOwn(allowed, link.pathname)) {
        link.toggleAttribute('data-ac-unavailable', !allowed[link.pathname]);
        if (!link.closest('dialog')) link.hidden = !allowed[link.pathname];
      }
    });
  }

  function clearResults() {
    entries = [];
    ready = false;
    pending = null;
    extra.replaceChildren();
    recentGroup.replaceChildren();
    recentGroup.hidden = true;
  }

  // Course/outline IDs are opaque. A member email can only be identified from
  // a fresh authorized roster. Persist a tab-salted digest for those links.
  async function personRef(email, memberSalt) {
    if (!window.crypto.subtle) return null;
    const data = new TextEncoder().encode(memberSalt + '\0' + email.toLowerCase());
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    return 'person:' + Array.from(new Uint8Array(digest).slice(0, 16), value => value.toString(16).padStart(2, '0')).join('');
  }

  async function destinations(payload, memberSalt) {
    const actions = copy('Acties', 'Aktionen');
    const result = [];
    const add = (group, title, href, ref, context = '', words = [], action = null) => {
      result.push({group, title, href, ref, context, action, words:[title, ...words].map(normalize)});
    };
    if (payload.canCreate) add(actions, copy('Nieuwe expeditie', 'Neue Expedition'), '/expedities?actie=nieuw', 'new');
    [
      [copy('Interface in het Duits', 'Oberfläche auf Deutsch'), () => document.querySelector('[data-academy-language="de"]')?.click()],
      [copy('Interface in het Nederlands', 'Oberfläche auf Niederländisch'), () => document.querySelector('[data-academy-language="nl"]')?.click()],
      [copy('Donkere weergave', 'Dunkle Darstellung'), () => window.Xped.i18n.setTheme('dark')],
      [copy('Lichte weergave', 'Helle Darstellung'), () => window.Xped.i18n.setTheme('light')],
    ].forEach(([title, action]) => add(actions, title, null, null, '', [], action));

    const kinds = {course:copy('Expedities', 'Expeditionen'), station:copy('Stations', 'Stationen'), step:copy('Stappen', 'Schritte')};
    for (const item of payload.items) {
      if (!Object.hasOwn(kinds, item.type)) continue;
      const base = '/expedities/' + encodeURIComponent(item.course);
      const title = item.title || item.labels?.[document.documentElement.lang] || item.labels?.nl || item.labels?.de || '';
      if (item.type === 'course' && item.role !== 'translate') {
        add(actions, copy('Resultaten van ', 'Ergebnisse von ') + title, base + '/resultaten', 'results:' + item.course);
      }
      const params = new URLSearchParams();
      if (item.role === 'translate') params.set('modus', 'vertalen');
      if (item.station) params.set('module', item.station);
      if (item.step) params.set('step', item.step);
      const path = item.type === 'course' ? base : base + '/bewerken?' + params;
      const id = item.type === 'course' ? item.course : item.course + ':' + (item.type === 'station' ? item.station : item.step);
      add(kinds[item.type], title, path, item.type + ':' + id, item.parent, Object.values(item.labels || {}));
    }
    if (payload.studioAdmin) {
      const people = await Promise.all((payload.people || []).map(async email => [email, await personRef(email, memberSalt)]));
      for (const [email, ref] of people) add(copy('Personen', 'Personen'), email, '/team?persoon=' + encodeURIComponent(email), ref);
    }
    return result;
  }

  function addItem(group, entry) {
    const button = document.createElement(entry.href ? 'a' : 'button');
    if (entry.href) button.href = entry.href; else button.type = 'button';
    button.className = 'ac-finder-item';
    const title = document.createElement('span');
    title.textContent = entry.title;
    button.append(title);
    if (entry.context) {
      const detail = document.createElement('small');
      detail.textContent = entry.context;
      button.append(detail);
    }
    button.addEventListener('click', () => {
      remember(entry.ref);
      if (entry.action) { dialog.close(); entry.action(); }
    });
    group.append(button);
  }

  function group(label) {
    const block = document.createElement('div');
    block.className = 'ac-finder-group';
    const caption = document.createElement('p');
    caption.textContent = label;
    block.append(caption);
    return block;
  }

  function pageEntry(link) {
    return {title:link.querySelector('span').textContent, href:link.pathname, ref:'page:' + link.pathname};
  }
  pages.forEach(link => link.addEventListener('click', () => {
    if (!link.hasAttribute('data-ac-unavailable')) remember(pageEntry(link).ref);
  }));

  function authorizedRecents() {
    const authorized = new Map(entries.filter(entry => entry.ref).map(entry => [entry.ref, entry]));
    pages.filter(page => !page.hasAttribute('data-ac-unavailable')).forEach(page => {
      const entry = pageEntry(page);
      authorized.set(entry.ref, entry);
    });
    return history.map(ref => authorized.get(ref)).filter(Boolean);
  }

  function render() {
    extra.replaceChildren();
    recentGroup.replaceChildren();
    const term = normalize(query.value);
    const recent = !term && ready ? authorizedRecents() : [];
    recentGroup.hidden = !recent.length;
    if (recent.length) {
      const block = group(copy('Recent geopend', 'Zuletzt geöffnet'));
      recent.forEach(entry => addItem(block, entry));
      recentGroup.append(block);
    }
    const recentRefs = new Set(recent.map(entry => entry.ref));
    pages.forEach(page => {
      page.hidden = page.hasAttribute('data-ac-unavailable') || !normalize(page.textContent).includes(term) || recentRefs.has(pageEntry(page).ref);
    });
    if (term.length >= 2) {
      const groups = new Map();
      for (const entry of entries.filter(item => item.words.some(word => word.includes(term))).slice(0, 24)) {
        if (!groups.has(entry.group)) {
          const block = group(entry.group);
          groups.set(entry.group, block);
          extra.append(block);
        }
        addItem(groups.get(entry.group), entry);
      }
    }
    noResults.hidden = pages.some(page => !page.hidden) || !!extra.childElementCount || !!recent.length || !!pending;
  }

  async function load() {
    clearResults();
    if (!dialog.open || !uid || uid !== account?.currentUser?.uid) { render(); return; }
    const request = {};
    pending = request;
    const member = uid;
    render();
    try {
      const response = await window.Xped.auth.createAuthClient(account).authFetch('/api/academy/navigation');
      if (pending !== request || account.currentUser?.uid !== member) return;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) { roleNav(false, false, []); history = []; writeHistory(); }
        return;
      }
      const payload = await response.json();
      const found = await destinations(payload, salt);
      if (pending !== request || account.currentUser?.uid !== member) return;
      roleNav(payload.canCreate, payload.studioAdmin, payload.items.filter(item => item.type === 'course').map(item => item.role));
      entries = found;
      ready = true;
      history = authorizedRecents().map(entry => entry.ref);
      writeHistory();
    } catch (_) { /* The local page shortcuts remain available. */ }
    finally { if (pending === request) { pending = null; render(); } }
  }

  try {
    account = window.Xped.bootstrap.getAuth();
    account.onAuthStateChanged(user => {
      if (uid === (user?.uid || null)) return;
      changeMember(user?.uid || null);
      if (dialog.open) load();
    });
  } catch (_) { /* Signed-out visitors can still use the local page shortcuts. */ }

  new MutationObserver(() => {
    if (dialog.open) load(); else clearResults();
  }).observe(dialog, {attributes:true, attributeFilter:['open']});
  window.addEventListener('academy:workspace-access', event => {
    const {canCreate, studioAdmin, courses} = event.detail;
    roleNav(canCreate, studioAdmin, courses.map(course => course.role));
    if (dialog.open) load();
  });
  query.addEventListener('input', render);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && dialog.open) load();
  });
  window.addEventListener('pagehide', clearResults);
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    if (uid) readHistory();
    if (dialog.open) load();
  });
})();
