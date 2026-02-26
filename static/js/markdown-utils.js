(function (global) {
  'use strict';

  var DEFAULT_ALLOWED_TAGS = [
    'h1', 'h2', 'h3', 'h4', 'p', 'br', 'strong', 'em', 'code', 'pre',
    'ul', 'ol', 'li', 'blockquote', 'a', 'hr'
  ];
  var DEFAULT_ALLOWED_ATTR = ['href', 'title', 'target', 'rel'];

  function getHtmlUtils() {
    return global.LectureProcessorHtml || {};
  }

  function preprocessSource(source, preprocess) {
    if (typeof preprocess === 'function') {
      try {
        return String(preprocess(source));
      } catch (_) {
        return source;
      }
    }
    return source;
  }

  function parseMarkdownToSafeHtml(markdown, options) {
    var opts = options || {};
    var source = String(markdown == null ? '' : markdown);
    source = preprocessSource(source, opts.preprocess);
    if (!source.trim()) return '';

    var htmlUtils = getHtmlUtils();
    var sanitizeHtmlFragment = htmlUtils.sanitizeHtmlFragment || function (rawHtml) {
      var html = String(rawHtml == null ? '' : rawHtml);
      if (global.DOMPurify && typeof global.DOMPurify.sanitize === 'function') {
        return global.DOMPurify.sanitize(html);
      }
      return html;
    };
    var escapeHtml = htmlUtils.escapeHtml || function (value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    };

    if (global.marked && typeof global.marked.parse === 'function') {
      if (typeof global.marked.setOptions === 'function') {
        global.marked.setOptions({ gfm: true, breaks: true, mangle: false, headerIds: false });
      }
      var rawHtml = global.marked.parse(source);
      return sanitizeHtmlFragment(rawHtml, {
        ALLOWED_TAGS: opts.allowedTags || DEFAULT_ALLOWED_TAGS,
        ALLOWED_ATTR: opts.allowedAttr || DEFAULT_ALLOWED_ATTR,
      });
    }

    return escapeHtml(source).replace(/\n/g, '<br>');
  }

  global.LectureProcessorMarkdown = {
    parseMarkdownToSafeHtml: parseMarkdownToSafeHtml,
    DEFAULT_ALLOWED_TAGS: DEFAULT_ALLOWED_TAGS.slice(),
    DEFAULT_ALLOWED_ATTR: DEFAULT_ALLOWED_ATTR.slice(),
  };
})(window);
