/* Loads the Dutch interface catalogs only when they are needed.
   Runs synchronously from the page head, so the catalogs it writes stay ordered
   deferred scripts that run before i18n.js. i18n.js fetches them on a later switch. */
(function () {
  'use strict';
  var script = document.currentScript;
  var urls = String((script && script.getAttribute('data-i18n-catalogs')) || '').split(' ').filter(Boolean);
  var pageCatalog = document.querySelector('meta[name="i18n-page-catalog"]');
  if (pageCatalog && pageCatalog.content) urls.push(pageCatalog.content);
  window.LectureI18nCatalogUrls = urls;
  // Pages authored in Dutch always need them: their English view is translated back.
  var preload = { dutchSource: Boolean(script && script.getAttribute('data-i18n-always')), complete: false };
  window.LectureI18nPreload = preload;
  var needed = preload.dutchSource;
  try {
    needed = needed || JSON.parse(window.localStorage.getItem('lp-preferences') || '{}').language === 'nl';
  } catch (_error) { /* Storage can be unavailable in private windows; keep the page default. */ }
  if (needed) {
    var loaded = 0;
    function recordLoad(event) {
      if (event.target.tagName === 'SCRIPT' && event.target.hasAttribute('data-i18n-file')) {
        loaded += 1;
        preload.complete = loaded === urls.length;
      }
    }
    document.addEventListener('load', recordLoad, true);
    document.addEventListener('DOMContentLoaded', function () {
      document.removeEventListener('load', recordLoad, true);
    }, { once: true });
    urls.forEach(function (src) { document.write('<script src="' + src + '" data-i18n-file defer><\/script>'); });
  }
})();
