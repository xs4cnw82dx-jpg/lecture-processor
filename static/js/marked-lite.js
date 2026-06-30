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

  function isSafeHref(value) {
    var href = String(value || '').trim();
    return /^(https?:|mailto:|\/|#)/i.test(href) && !/[\u0000-\u001f]/.test(href);
  }

  function renderInline(value) {
    var codeSpans = [];
    var text = escapeHtml(value).replace(/`([^`]+)`/g, function (_match, code) {
      var token = '\u0000CODE' + codeSpans.length + '\u0000';
      codeSpans.push('<code>' + code + '</code>');
      return token;
    });

    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (match, label, href) {
      var rawHref = String(href || '').replace(/&amp;/g, '&');
      if (!isSafeHref(rawHref)) return label;
      return '<a href="' + escapeHtml(rawHref) + '" target="_blank" rel="noopener">' + label + '</a>';
    });
    text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    text = text.replace(/_([^_]+)_/g, '<em>$1</em>');

    codeSpans.forEach(function (html, index) {
      text = text.replace('\u0000CODE' + index + '\u0000', html);
    });
    return text;
  }

  function renderList(lines, startIndex, ordered) {
    var html = ordered ? '<ol>' : '<ul>';
    var index = startIndex;
    var pattern = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
    while (index < lines.length) {
      var match = lines[index].match(pattern);
      if (!match) break;
      html += '<li>' + renderInline(match[1]) + '</li>';
      index += 1;
    }
    html += ordered ? '</ol>' : '</ul>';
    return { html: html, nextIndex: index };
  }

  function renderParagraph(lines, startIndex) {
    var parts = [];
    var index = startIndex;
    while (index < lines.length) {
      var line = lines[index];
      if (!line.trim()) break;
      if (/^\s*#{1,6}\s+/.test(line) || /^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line) || /^\s*>/.test(line) || /^\s*```/.test(line) || /^\s*---+\s*$/.test(line)) {
        break;
      }
      parts.push(renderInline(line.trim()));
      index += 1;
    }
    return { html: '<p>' + parts.join('<br>') + '</p>', nextIndex: index };
  }

  function parse(markdown) {
    var source = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n');
    if (!source.trim()) return '';
    var lines = source.split('\n');
    var output = [];
    var index = 0;

    while (index < lines.length) {
      var line = lines[index];
      if (!line.trim()) {
        index += 1;
        continue;
      }

      var fenceMatch = line.match(/^\s*```/);
      if (fenceMatch) {
        var codeLines = [];
        index += 1;
        while (index < lines.length && !/^\s*```/.test(lines[index])) {
          codeLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) index += 1;
        output.push('<pre><code>' + escapeHtml(codeLines.join('\n')) + '</code></pre>');
        continue;
      }

      var headingMatch = line.match(/^\s*(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        var level = headingMatch[1].length;
        output.push('<h' + level + '>' + renderInline(headingMatch[2].trim()) + '</h' + level + '>');
        index += 1;
        continue;
      }

      if (/^\s*---+\s*$/.test(line)) {
        output.push('<hr>');
        index += 1;
        continue;
      }

      if (/^\s*>/.test(line)) {
        var quoteLines = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) {
          quoteLines.push(lines[index].replace(/^\s*>\s?/, ''));
          index += 1;
        }
        output.push('<blockquote><p>' + quoteLines.map(renderInline).join('<br>') + '</p></blockquote>');
        continue;
      }

      if (/^\s*[-*+]\s+/.test(line)) {
        var unordered = renderList(lines, index, false);
        output.push(unordered.html);
        index = unordered.nextIndex;
        continue;
      }

      if (/^\s*\d+[.)]\s+/.test(line)) {
        var ordered = renderList(lines, index, true);
        output.push(ordered.html);
        index = ordered.nextIndex;
        continue;
      }

      var paragraph = renderParagraph(lines, index);
      output.push(paragraph.html);
      index = paragraph.nextIndex;
    }

    return output.join('\n');
  }

  global.marked = global.marked || {};
  global.marked.parse = global.marked.parse || parse;
  global.marked.setOptions = global.marked.setOptions || function () {};
})(window);
