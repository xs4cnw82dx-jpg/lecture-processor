(function (global) {
  'use strict';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function sanitizeHtmlFragment(rawHtml, options) {
    var html = String(rawHtml == null ? '' : rawHtml);
    if (global.DOMPurify && typeof global.DOMPurify.sanitize === 'function') {
      return global.DOMPurify.sanitize(html, options || {});
    }
    return escapeHtml(html);
  }

  function setSafeInnerHtml(element, rawHtml, options) {
    if (!element) return;
    element.innerHTML = sanitizeHtmlFragment(rawHtml, options);
  }

  function setSanitizedHtml(element, rawHtml, options) {
    if (!element) return;
    var html = String(rawHtml == null ? '' : rawHtml);
    if (global.DOMPurify && typeof global.DOMPurify.sanitize === 'function') {
      element.innerHTML = global.DOMPurify.sanitize(html, options || {});
      return;
    }
    element.textContent = html;
  }

  var api = {
    escapeHtml: escapeHtml,
    sanitizeHtmlFragment: sanitizeHtmlFragment,
    setSafeInnerHtml: setSafeInnerHtml,
    setSanitizedHtml: setSanitizedHtml
  };
  global.LectureProcessorHtml = api;
  // Node unit tests load page scripts (e.g. physio-local.js) that require this file.
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
