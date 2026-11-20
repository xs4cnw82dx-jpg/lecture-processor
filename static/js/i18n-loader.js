/* Loads the Dutch interface catalogs only when they are needed.
   Runs synchronously from the page head, so the catalogs it writes stay ordered
   deferred scripts that run before i18n.js. i18n.js fetches them on a later switch. */
(function () {
  'use strict';
  var script = document.currentScript;
  var urls = String((script && script.getAttribute('data-i18n-catalogs')) || '').split(' ').filter(Boolean);
  window.LectureI18nCatalogUrls = urls;
  // Pages authored in Dutch always need them: their English view is translated back.
  var needed = Boolean(script && script.getAttribute('data-i18n-always'));
  try {
    needed = needed || JSON.parse(window.localStorage.getItem('lp-preferences') || '{}').language === 'nl';
  } catch (_error) { /* Storage can be unavailable in private windows; keep the page default. */ }
  if (needed) {
    urls.forEach(function (src) { document.write('<script src="' + src + '" defer><\/script>'); });
  }
})();
