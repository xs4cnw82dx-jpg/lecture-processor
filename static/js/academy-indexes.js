(function () {
  'use strict';

  const main = document.querySelector('[data-index-kind]');
  if (!main) return;
  const xped = window.Xped;
  const { t: uiText, locale } = xped.i18n;
  const isResults = main.dataset.indexKind === 'results';
  const status = document.getElementById('ac-index-status');
  const list = document.getElementById('ac-index-list');
  const empty = document.getElementById('ac-index-empty');
  const signIn = document.getElementById('ac-index-signin');
  const retry = document.getElementById('ac-index-retry');
  let auth;
  try { auth = xped.bootstrap.getAuth(); } catch (_) {
    status.textContent = uiText('indexes.authUnavailable');
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
    title.textContent = expedition.title || uiText('indexes.untitled');
    const detail = document.createElement('span');
    detail.className = 'ac-entry-detail';
    if (isResults) {
      detail.textContent = uiText('indexes.seeResults');
    } else {
      const coverage = (expedition.languageCoverage || {})[language] || {};
      const review = Number(coverage.needsReview) || 0;
      const langName = language === 'de' ? 'Deutsch' : 'Nederlands';
      detail.textContent = review ? langName + ' · ' + uiText('count.needsReview', { count: review }) : langName;
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
      status.textContent = uiText('indexes.signInPrompt');
      return;
    }
    status.textContent = uiText('indexes.loading');
    try {
      const response = await api.authFetch('/api/elearning/expeditions');
      if (!response.ok) throw new Error('list');
      const data = await response.json();
      if (revision !== request || auth.currentUser?.uid !== user.uid) return;
      const rows = [];
      const available = (data.expeditions || []).filter(course => !course.deletionPending && course.id);
      available.sort((a, b) => String(a.title || '').localeCompare(String(b.title || ''), locale));
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
      status.textContent = uiText('indexes.loadFailed');
      retry.hidden = false;
    }
  }
  retry.addEventListener('click', () => load(auth.currentUser));
  xped.bootstrap.onAuthStateReady(auth, load);
})();
