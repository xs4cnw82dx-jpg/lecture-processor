(function () {
  'use strict';

  var root = document.querySelector('[data-companion-url]');
  var companionUrl = String((root && root.dataset.companionUrl) || 'http://127.0.0.1:8765/physio').replace(/\/$/, '');
  var healthUrl = companionUrl.replace(/\/physio$/, '') + '/healthz';
  var status = document.getElementById('physio-launcher-status');
  var retry = document.getElementById('physio-retry-companion');

  async function checkCompanion() {
    if (!status) return false;
    status.className = 'physio-launcher-status';
    status.lastElementChild.textContent = 'Lokale companion controleren…';
    try {
      await fetch(healthUrl, { mode: 'no-cors', cache: 'no-store' });
      status.classList.add('is-online');
      status.lastElementChild.textContent = 'Companion is bereikbaar — werkruimte wordt geopend.';
      window.setTimeout(function () { window.location.assign(companionUrl); }, 350);
      return true;
    } catch (_error) {
      status.classList.add('is-offline');
      status.lastElementChild.textContent = 'Companion is nog niet bereikbaar. Start hem lokaal en probeer opnieuw.';
      return false;
    }
  }

  if (retry) retry.addEventListener('click', checkCompanion);
  checkCompanion();
})();
