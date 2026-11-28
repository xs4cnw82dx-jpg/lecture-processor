(function () {
  'use strict';

  const main = document.querySelector('[data-index-kind]');
  if (!main) return;
  const xped = window.Xped;
  const copy = (nl, de) => xped.i18n.copy(nl, de);
  const isResults = main.dataset.indexKind === 'results';
  const status = document.getElementById('ac-index-status');
  const list = document.getElementById('ac-index-list');
  const empty = document.getElementById('ac-index-empty');
  const signIn = document.getElementById('ac-index-signin');
  const retry = document.getElementById('ac-index-retry');
  let auth;
  try { auth = xped.bootstrap.getAuth(); } catch (_) {
    status.textContent = copy('Inloggen is tijdelijk niet beschikbaar. Ververs de pagina om het opnieuw te proberen.', 'Die Anmeldung ist vorübergehend nicht verfügbar. Laden Sie die Seite neu.');
    return;
  }
  const api = xped.auth.createAuthClient(auth);
  let revision = 0;

  function courseEntry(expedition, language) {
    const li = document.createElement('li');
    const link = document.createElement('a');
    const course = '/expedities/' + encodeURIComponent(expedition.id);
    link.href = isResults ? course + '/resultaten' : course + '/bewerken?modus=vertalen&taal=' + language;
    const title = document.createElement('strong');
    title.translate = false;
    title.textContent = expedition.title || copy('Naamloze expeditie', 'Unbenannte Expedition');
    const detail = document.createElement('span');
    detail.className = 'ac-entry-detail';
    if (isResults) {
      detail.textContent = copy('Resultaten bekijken', 'Ergebnisse ansehen');
    } else {
      const coverage = (expedition.languageCoverage || {})[language] || {};
      const review = Number(coverage.needsReview) || 0;
      const langName = language === 'de' ? 'Deutsch' : 'Nederlands';
      detail.textContent = review ? langName + ' · ' + copy('Te controleren', 'Zu prüfen') + ' (' + new Intl.NumberFormat(document.documentElement.lang).format(review) + ')' : langName;
      if (review) detail.classList.add('ac-review-needed');
    }
    const arrow = document.createElement('span');
    arrow.setAttribute('aria-hidden','true');
    arrow.className = 'ac-entry-arrow';
    arrow.textContent = '→';
    link.append(title, detail, arrow);
    li.append(link);
    return li;
  }

  async function load(user) {
    const request = ++revision;
    list.replaceChildren();
    list.hidden = true;
    retry.hidden = true;
    empty.hidden = true;
    signIn.hidden = Boolean(user);
    status.hidden = false;
    if (!user) {
      status.textContent = copy('Log in om je expedities te bekijken.', 'Melden Sie sich an, um Ihre Expeditionen zu sehen.');
      return;
    }
    status.textContent = copy('Expedities ophalen…', 'Expeditionen werden geladen…');
    try {
      const response = await api.authFetch('/api/elearning/expeditions');
      if (!response.ok) throw new Error('list');
      const data = await response.json();
      if (revision !== request || auth.currentUser?.uid !== user.uid) return;
      const rows = [];
      const available = (data.expeditions || []).filter(course => !course.deletionPending && course.id);
      available.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), document.documentElement.lang));
      for (const course of available) {
        if (isResults) {
          if (course.role !== 'translate') rows.push(courseEntry(course));
          continue;
        }
        const primary = course.defaultLanguage || 'nl';
        const languages = (course.enabledLanguages || ['nl']).filter(code => ['nl','de'].includes(code) && code !== primary);
        for (const language of languages) rows.push(courseEntry(course, language));
      }
      list.replaceChildren(...rows);
      list.hidden = rows.length === 0;
      empty.hidden = rows.length > 0;
      status.hidden = true;
    } catch (_) {
      if (revision !== request) return;
      status.textContent = copy('De expedities konden niet worden opgehaald.', 'Die Expeditionen konnten nicht geladen werden.');
      retry.hidden = false;
    }
  }
  retry.addEventListener('click', () => load(auth.currentUser));
  xped.bootstrap.onAuthStateReady(auth, load);
})();
