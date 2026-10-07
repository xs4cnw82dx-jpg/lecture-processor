(function () {
  'use strict';

  var root = document.querySelector('[data-companion-url]');
  var companionUrl = String((root && root.dataset.companionUrl) || 'http://127.0.0.1:8765/physio').replace(/\/$/, '');
  var healthUrl = companionUrl.replace(/\/physio$/, '') + '/healthz';
  var status = document.getElementById('physio-launcher-status');
  var retry = document.getElementById('physio-retry-companion');
  var openLink = document.getElementById('physio-open-companion');

  function companionTarget() {
    var target = new URL(companionUrl, window.location.href);
    // Transfer only display preferences to the separate local workspace origin.
    target.searchParams.set('lp_theme', document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
    var language = window.LectureI18n ? window.LectureI18n.getLanguage() : document.documentElement.lang;
    target.searchParams.set('lp_language', language === 'nl' ? 'nl' : 'en');
    return target.href;
  }
  function updateLink() { if (openLink) openLink.href = companionTarget(); }
  updateLink();
  document.addEventListener('DOMContentLoaded', updateLink, { once: true });
  window.addEventListener('lp:preferences-changed', updateLink);
  window.addEventListener('lp:language-changed', updateLink);
  if (openLink) openLink.addEventListener('click', updateLink);

  async function checkCompanion() {
    if (!status || (retry && retry.disabled)) return false;
    if (retry) retry.disabled = true;
    status.className = 'physio-launcher-status';
    status.lastElementChild.textContent = 'Lokale companion controleren…';
    try {
      await fetch(healthUrl, { mode: 'no-cors', cache: 'no-store' });
      status.classList.add('is-online');
      status.lastElementChild.textContent = 'Companion is bereikbaar — werkruimte wordt geopend.';
      window.setTimeout(function () { window.location.assign(companionTarget()); }, 350);
      return true;
    } catch (_error) {
      status.classList.add('is-offline');
      status.lastElementChild.textContent = 'Companion is nog niet bereikbaar. Start hem lokaal en probeer opnieuw.';
      return false;
    } finally { if (retry) retry.disabled = false; }
  }

  if (retry) retry.addEventListener('click', checkCompanion);
  checkCompanion();
})();
