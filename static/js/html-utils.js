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

  global.LectureProcessorHtml = {
    escapeHtml: escapeHtml,
    sanitizeHtmlFragment: sanitizeHtmlFragment,
    setSafeInnerHtml: setSafeInnerHtml,
    setSanitizedHtml: setSanitizedHtml
  };
})(window);
