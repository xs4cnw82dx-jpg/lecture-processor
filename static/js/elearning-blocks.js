(function (root) {
  'use strict';
  var uiText = typeof window !== 'undefined' && window.Xped && window.Xped.i18n ? window.Xped.i18n.t : function (message) { return message; };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  var renderInstance = 0;
  var svgNs = 'http://www.w3.org/2000/svg';

  function pinMarker(pin, ordinal) {
    var point = document.createElementNS(svgNs, 'svg');
    point.setAttribute('x', (pin.x ?? 50) + '%');
    point.setAttribute('y', (pin.y ?? 50) + '%');
    point.setAttribute('width', '1');
    point.setAttribute('height', '1');
    point.setAttribute('overflow', 'visible');
    point.classList.add('xped-hotspot-pin');
    var color = /^#[0-9a-f]{6}$/i.test(pin.color || '') ? pin.color : '#0072ce';
    var circle = document.createElementNS(svgNs, 'circle');
    circle.setAttribute('r', '16');
    circle.setAttribute('fill', color);
    var number = document.createElementNS(svgNs, 'text');
    number.setAttribute('text-anchor', 'middle');
    number.setAttribute('dy', '.35em');
    number.setAttribute('fill', root.XpedElearningModel.pinTextColor(color));
    number.textContent = String(ordinal);
    point.append(circle, number);
    return point;
  }

  function colorSwatch(hex) {
    var svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('viewBox', '0 0 20 20');
    svg.setAttribute('width', '20');
    svg.setAttribute('height', '20');
    var dot = document.createElementNS(svgNs, 'circle');
    dot.setAttribute('cx', '10');
    dot.setAttribute('cy', '10');
    dot.setAttribute('r', '10');
    dot.setAttribute('fill', /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#0072ce');
    svg.appendChild(dot);
    return svg;
  }

  // Reuse bounded numeric rules on the course stylesheet for image positioning.
  var imageRules = new WeakMap();
  function imageProperty(image, property, value, unit) {
    var sheet = document.querySelector('link[data-elearning-styles]')?.sheet;
    if (!sheet) return;
    var rules = imageRules.get(sheet) || new Set();
    imageRules.set(sheet, rules);
    var name = property + '-' + value;
    if (!rules.has(name)) {
      sheet.insertRule('.' + name + '{--' + property + ':' + value + unit + '}', sheet.cssRules.length);
      rules.add(name);
    }
    image.classList.add(name);
  }

  function integer(value, min, max, fallback) {
    return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
  }

  function setImageFocal(image, x, y) {
    imageProperty(image, 'xped-focal-x', integer(x, 0, 100, 50), '%');
    imageProperty(image, 'xped-focal-y', integer(y, 0, 100, 50), '%');
  }

  function framePortrait(image, data) {
    imageProperty(image, 'portrait-zoom', integer(data.portraitZoom, 50, 250, 100), '%');
    imageProperty(image, 'portrait-x', integer(data.portraitX, -75, 75, 0), '%');
    imageProperty(image, 'portrait-y', integer(data.portraitY, -75, 75, 0), '%');
  }

  function makeEditable(node, placeholder, editable, onCommit, onFocus) {
    if (!editable) return node;
    root.XpedElearningModel.bindEditableText(node, placeholder, true, onCommit);
    node.addEventListener('click', function (e) { e.stopPropagation(); });
    if (typeof onFocus === 'function') {
      node.addEventListener('focus', function () { onFocus(); });
      node.addEventListener('pointerdown', function () { onFocus(); });
    }
    return node;
  }

  function createDropzone(label, sublabel, accept, onFile) {
    var Icons = root.XpedElearningIcons;
    var control = el('div', 'el-upload-control');
    var dz = el('button', 'el-dropzone');
    dz.type = 'button';
    dz.setAttribute('aria-label', label + (sublabel ? ' — ' + sublabel : ''));
    if (Icons) dz.appendChild(Icons.icon('upload', 22));
    dz.appendChild(el('strong', '', label));
    dz.appendChild(el('span', '', sublabel));
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.hidden = true;
    control.append(dz, inp);

    function triggerChoose() {
      if (typeof onFile === 'function') inp.click();
    }
    dz.addEventListener('click', function (e) {
      e.stopPropagation();
      triggerChoose();
    });
    inp.addEventListener('change', function () {
      if (inp.files && inp.files[0] && typeof onFile === 'function') onFile(inp.files[0]);
      inp.value = '';
    });
    dz.addEventListener('dragover', function (e) {
      e.preventDefault();
      dz.classList.add('is-dragover');
    });
    dz.addEventListener('dragleave', function () { dz.classList.remove('is-dragover'); });
    dz.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      dz.classList.remove('is-dragover');
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0] && typeof onFile === 'function') {
        onFile(e.dataTransfer.files[0]);
      }
    });
    return control;
  }

  function renderPeerBars(parent, block, agg, lang, defaultLang) {
    var Model = root.XpedElearningModel;
    if (!agg || !agg.count) return;
    var box = el('div', 'xped-peer-box');
    box.appendChild(el('p', 'xped-peer-title', Model.ui(lang, 'peerResults') + ' · ' + Model.ui(lang, 'responsesCount', { n: agg.count })));
    if (block.type === 'mcq') {
      var counts = agg.counts || {};
      (block.data.options || []).forEach(function (opt) {
        var c = counts[opt.id] || 0;
        var pct = Math.round((c / Math.max(1, agg.count)) * 100);
        var row = el('div', 'xped-bar-row');
        row.appendChild(el('span', '', Model.getLocalized(opt.label, lang, defaultLang) + ' — ' + pct + '%'));
        var meter = el('progress', 'xped-peer-progress');
        meter.max = 100;
        meter.value = pct;
        meter.setAttribute('aria-hidden', 'true');
        row.appendChild(meter);
        box.appendChild(row);
      });
    } else if (block.type === 'scale') {
      box.appendChild(el('p', 'xped-caption', uiText('Average: ') + (agg.average !== null ? agg.average : '—')));
    } else if (block.type === 'wordcloud' && Array.isArray(agg.words)) {
      var tags = el('div', 'xped-word-tags');
      agg.words.slice(0, 20).forEach(function (entry) {
        tags.appendChild(el('span', 'xped-word-chip', entry.word + ' (' + entry.count + ')'));
      });
      box.appendChild(tags);
    }
    parent.appendChild(box);
  }

  function renderBalanceSvg(loadTotal, resTotal) {
    var ns = 'http://www.w3.org/2000/svg';
    function sEl(tag, attrs) {
      var n = document.createElementNS(ns, tag);
      Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
      return n;
    }
    var diff = Math.max(-18, Math.min(18, (resTotal - loadTotal) * 2.4));
    var svg = sEl('svg', { viewBox: '0 0 360 144', class: 'xped-balance-svg', role: 'img', 'aria-label': uiText('Balance scale visual') });
    // Sleek light stand on deep navy stage
    svg.appendChild(sEl('path', { d: 'M 142 134 L 218 134 L 190 120 L 170 120 Z', fill: 'rgba(255,255,255,0.22)' }));
    svg.appendChild(sEl('rect', { x: 176, y: 46, width: 8, height: 76, rx: 4, fill: 'rgba(255,255,255,0.34)' }));
    var beam = sEl('g', { class: 'xped-balance-beam', transform: 'rotate(' + diff + ' 180 48.5)' });
    beam.appendChild(sEl('rect', { x: 52, y: 44, width: 256, height: 9, rx: 4.5, fill: '#ffffff' }));
    beam.appendChild(sEl('circle', { cx: 180, cy: 48.5, r: 9, fill: '#ffd617', stroke: '#062940', 'stroke-width': 3 }));
    // Left pan (Load - coral)
    beam.appendChild(sEl('line', { x1: 74, y1: 53, x2: 74, y2: 88, stroke: 'rgba(255,255,255,0.55)', 'stroke-width': 2 }));
    beam.appendChild(sEl('rect', { x: 40, y: 86, width: 68, height: 12, rx: 6, fill: '#f27874' }));
    var loadR = Math.min(19, 7 + loadTotal * 1.4);
    beam.appendChild(sEl('circle', { cx: 74, cy: 84 - loadR, r: loadR, fill: '#f27874', opacity: '0.92' }));
    // Right pan (Resources - bright mint)
    beam.appendChild(sEl('line', { x1: 286, y1: 53, x2: 286, y2: 88, stroke: 'rgba(255,255,255,0.55)', 'stroke-width': 2 }));
    beam.appendChild(sEl('rect', { x: 252, y: 86, width: 68, height: 12, rx: 6, fill: '#1fe4a9' }));
    var resR = Math.min(19, 7 + resTotal * 1.4);
    beam.appendChild(sEl('circle', { cx: 286, cy: 84 - resR, r: resR, fill: '#1fe4a9', opacity: '0.92' }));
    svg.appendChild(beam);
    return svg;
  }

  function linkDestination(line, start) {
    var depth = 0;
    var url = '';
    for (var i = start; i < line.length; i++) {
      var ch = line[i];
      // Older stored links can contain unescaped spaces in the URL path.
      if (ch === '\\' && /[\\()]/.test(line[i + 1] || '')) {
        url += line[++i];
        continue;
      }
      if (ch === '(') depth++;
      if (ch === ')' && depth-- === 0) {
        var valid = root.XpedElearningModel.normalizeCitationLink(url);
        return valid.url ? {url: valid.url, end: i + 1} : null;
      }
      url += ch;
    }
    return null;
  }

  function appendInlineTokens(parent, line) {
    // Markup is interpreted only as text, emphasis or an HTTP(S) link.
    // Escaped editor punctuation stays literal, including inside link labels.
    var tokens = /\\([\\*[\]#.•()\-])|\*\*((?:\\.|[^*\\]|\*(?!\*))+?)\*\*|\[((?:\\.|[^\]\\])+)\]\((?=https?:\/\/)/gi;
    var last = 0;
    var m;
    while ((m = tokens.exec(line)) !== null) {
      if (m.index > last) parent.append(document.createTextNode(line.slice(last, m.index)));
      if (m[1]) {
        parent.append(document.createTextNode(m[1]));
      } else if (m[2]) {
        var strong = document.createElement('strong');
        appendInlineTokens(strong, m[2]);
        parent.appendChild(strong);
      } else {
        var destination = linkDestination(line, tokens.lastIndex);
        if (destination && !parent.closest('a')) {
          var link = document.createElement('a');
          link.href = destination.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          parent.appendChild(link);
          appendInlineTokens(link, m[3]);
          tokens.lastIndex = destination.end;
        } else {
          parent.append(document.createTextNode(m[0]));
        }
      }
      last = tokens.lastIndex;
    }
    if (last < line.length) parent.append(document.createTextNode(line.slice(last)));
  }

  function renderFormattedBody(text) {
    var box = el('div', 'xped-richtext-body');
    var lines = String(text || '').split('\n');
    var listEl = null;
    var listKind = '';
    lines.forEach(function (raw) {
      var trimmed = raw.trim();
      if (!trimmed) {
        listEl = null;
        listKind = '';
        return;
      }
      var h3m = trimmed.match(/^##\s+(.+)$/);
      var h4m = trimmed.match(/^###\s+(.+)$/);
      var ulm = trimmed.match(/^(?:[-•*])\s+(.+)$/);
      var olm = trimmed.match(/^\d+[.)]\s+(.+)$/);
      if (h4m || h3m) {
        listEl = null;
        listKind = '';
        var hx = el(h4m ? 'h3' : 'h2', 'xped-richtext-subhead');
        appendInlineTokens(hx, (h4m || h3m)[1]);
        box.appendChild(hx);
      } else if (ulm) {
        if (!listEl || listKind !== 'ul') {
          listEl = el('ul', 'xped-richtext-list');
          listKind = 'ul';
          box.appendChild(listEl);
        }
        var uli = document.createElement('li');
        appendInlineTokens(uli, ulm[1]);
        listEl.appendChild(uli);
      } else if (olm) {
        if (!listEl || listKind !== 'ol') {
          listEl = el('ol', 'xped-richtext-list is-ordered');
          listKind = 'ol';
          box.appendChild(listEl);
        }
        var oli = document.createElement('li');
        appendInlineTokens(oli, olm[1]);
        listEl.appendChild(oli);
      } else {
        listEl = null;
        listKind = '';
        var p = document.createElement('p');
        appendInlineTokens(p, raw);
        box.appendChild(p);
      }
    });
    return box;
  }

  // The editor and the learner share the same portable Markdown subset.
  function richTextMarkdown(editor) {
    function serialize(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent.replace(/\u00a0/g, ' ').replace(/[\\*[\]]/g, '\\$&')
          .replace(/^([ \t]*)(#{2,3}|[-•]|\d+[.)])(?=\s|$)/gm, function (_, indent, marker) {
            return indent + marker.slice(0, -1) + '\\' + marker.slice(-1);
          });
      }
      var text = Array.from(node.childNodes, serialize).join('');
      switch (node.nodeName) {
        case 'BR': return '\n';
        case 'STRONG': case 'B': return text ? '**' + text + '**' : '';
        case 'A': {
          var url = root.XpedElearningModel.normalizeCitationLink(node.getAttribute('href')).url;
          return url ? '[' + text + '](' + url.replace(/[\\()]/g, '\\$&') + ')' : text;
        }
        case 'H2': return '## ' + text.trimEnd() + '\n';
        case 'H3': return '### ' + text.trimEnd() + '\n';
        case 'OL': case 'UL':
          return Array.from(node.children, function (li, index) {
            return (node.nodeName === 'OL' ? (index + 1) + '. ' : '- ') + serialize(li).trimEnd() + '\n';
          }).join('');
        case 'DIV': case 'P': return text.replace(/\n$/, '') + '\n';
        default: return text;
      }
    }
    // Chromium may produce a plain text node followed by one or more divs.
    var result = '';
    Array.from(editor.childNodes).forEach(function (child) {
      if (/^(DIV|P|H2|H3|OL|UL)$/.test(child.nodeName) && result && !result.endsWith('\n')) result += '\n';
      result += serialize(child);
    });
    return result.trimEnd();
  }

  function renderBlock(block, ctx) {
    var Model = root.XpedElearningModel;
    var Icons = root.XpedElearningIcons;
    var lang = ctx.lang || 'nl';
    var defLang = ctx.defaultLang || 'nl';
    var interactive = !!ctx.interactive;
    var setMediaSource = ctx.setMediaSource || function (element, url) { element.src = url; };
    var editable = !!ctx.editable;
    var answers = ctx.answers || {};
    var onAnswer = ctx.onAnswer || function () {};
    var onEdit = ctx.onEdit || function () {};
    var onFocusBlock = typeof ctx.onFocusBlock === 'function' ? ctx.onFocusBlock : function () {};
    var onUploadFile = ctx.onUploadFile || null;
    var fetchAggregate = ctx.fetchAggregate || null;
    var assetUrl = ctx.assetUrl || function () { return ''; };
    var stepTitle = String(ctx.stepTitle || '').trim();
    var stepTitleLower = stepTitle.toLowerCase();
    var instanceId = block.id + '-' + (++renderInstance);
    function labelControl(control, heading) {
      if (heading.textContent.trim()) {
        heading.id = 'question-' + instanceId;
        control.setAttribute('aria-labelledby', heading.id);
      } else {
        control.setAttribute('aria-label', stepTitle || Model.ui(lang, 'yourAnswer'));
      }
    }
    var stepHasAnswered = !!ctx.stepHasAnswered;
    var highlightBlockId = ctx.highlightBlockId || '';
    var data = block.data || {};
    function field(node, localized) {
      if (ctx.onLocalizedField) ctx.onLocalizedField(node, localized);
      return node;
    }
    // Each editable copy field uses its chosen semantic element in all three views.
    var styleToolbar;
    function styledField(key, defaultTag, className, text) {
      var style = block.settings?.textStyles?.[key];
      var tag = ['p', 'h2', 'h3'].includes(style) ? style : defaultTag;
      var node = el(tag, className, text);
      if (style === tag) node.dataset.textStyle = tag;
      if (!editable) return node;
      node.dataset.formatField = key;
      node.addEventListener('focus', function () {
        styleToolbar?.remove();
        styleToolbar = el('div', 'el-fmt-bar el-field-style');
        styleToolbar.setAttribute('role', 'group');
        styleToolbar.setAttribute('aria-label', root.ElearningHost?.i18n?.t('Text style') || uiText('Text style'));
        [['p', 'Paragraph'], ['h2', 'Heading 2'], ['h3', 'Heading 3']].forEach(function (option) {
          var button = el('button', 'el-fmt-btn', option[0].toUpperCase());
          button.type = 'button';
          button.title = root.ElearningHost?.i18n?.t(option[1]) || option[1];
          button.setAttribute('aria-label', button.title);
          button.setAttribute('aria-pressed', String(option[0] === tag));
          button.addEventListener('mousedown', function (ev) { ev.preventDefault(); });
          button.addEventListener('click', function (ev) {
            ev.stopPropagation();
            onEdit(block, 'style:' + key, option[0]);
          });
          styleToolbar.appendChild(button);
        });
        node.after(styleToolbar);
      });
      return node;
    }
    function appendCopy(parent, key, className, placeholder) {
      var value = Model.getLocalized(data[key], lang, defLang);
      if (!editable && !value) return;
      var node = styledField(key, 'p', className, value);
      field(node, data[key]);
      parent.appendChild(makeEditable(node, placeholder, editable, function (v) { onEdit(block, key, v); }, notifyFocus));
    }
    var revealAfter = !!(block.settings && block.settings.revealAfterAnswer);

    function notifyFocus() {
      if (editable && block && block.id) onFocusBlock(block.id);
    }

    var wrap = el('div', 'xped-block xped-block-' + block.type);
    wrap.setAttribute('data-block-id', block.id || '');
    if (editable) {
      wrap.addEventListener('focusin', notifyFocus);
    }
    if (highlightBlockId && highlightBlockId === block.id) {
      wrap.classList.add('is-tr-highlighted');
    }
    if (revealAfter && interactive) {
      wrap.classList.add(stepHasAnswered ? 'xped-reveal-unlocked' : 'xped-reveal-locked');
      wrap.setAttribute('data-reveal-after', '1');

    }
    if (revealAfter && editable) {
      var rTag = el('div', 'xped-author-cue');
      if (Icons) rTag.appendChild(Icons.icon('eye', 13));
      rTag.appendChild(document.createTextNode(uiText('Reveals after learner answers')));
      wrap.appendChild(rTag);
    }

    function appendTranscript(host) {
      var tr = Model.getLocalized(data.transcript, lang, defLang);
      if (tr) {
        var det = el('details', 'xped-details is-transcript');
        var sum = document.createElement('summary');
        sum.appendChild(el('span', '', Model.ui(lang, 'transcriptDefault')));
        if (Icons) {
          var ch = Icons.icon('chevronDown', 16);
          ch.classList.add('xped-details-chev');
          sum.appendChild(ch);
        }
        det.appendChild(sum);
        det.appendChild(field(el('div', 'xped-details-body', tr), data.transcript));
        host.appendChild(det);
      }
    }

    if (block.type === 'richtext') {
      var h = Model.getLocalized(data.heading, lang, defLang);
      var b = Model.getLocalized(data.body, lang, defLang);
      if (h || editable) {
        var hEl = styledField('heading', 'h2', 'xped-question-text', h);
        field(hEl, data.heading);
        makeEditable(hEl, uiText('Optional section heading…'), editable, function (v) { onEdit(block, 'heading', v); }, notifyFocus);
        wrap.appendChild(hEl);
      }
      if (editable) {
        var fmtBar = el('div', 'el-fmt-bar');
        fmtBar.setAttribute('role', 'toolbar');
        fmtBar.setAttribute('aria-label', uiText('Text formatting'));
        var linkBox = el('div', 'el-fmt-link-popover');
        linkBox.hidden = true;
        var editor = renderFormattedBody(b);
        editor.classList.add('xped-richtext-editor');
        editor.contentEditable = 'true';
        editor.spellcheck = true;
        editor.setAttribute('role', 'textbox');
        editor.setAttribute('aria-label', uiText('Paragraph text'));
        editor.setAttribute('aria-multiline', 'true');
        editor.setAttribute('data-placeholder', 'Write a paragraph…');
        var selectionRange;
        function rememberSelection() {
          var selection = window.getSelection();
          if (selection.rangeCount && editor.contains(selection.getRangeAt(0).commonAncestorContainer)) {
            selectionRange = selection.getRangeAt(0).cloneRange();
          }
        }
        function restoreSelection() {
          editor.focus();
          var selection = window.getSelection();
          if (!selectionRange || !editor.contains(selectionRange.commonAncestorContainer)) {
            selectionRange = document.createRange();
            selectionRange.selectNodeContents(editor);
            selectionRange.collapse(false);
          }
          selection.removeAllRanges();
          selection.addRange(selectionRange);
        }
        function persistBody() {
          onEdit(block, 'body', richTextMarkdown(editor));
          rememberSelection();
        }
        function format(command, value) {
          restoreSelection();
          if (command === 'formatBlock' && value === 'p') {
            if (document.queryCommandState('insertUnorderedList')) document.execCommand('insertUnorderedList');
            if (document.queryCommandState('insertOrderedList')) document.execCommand('insertOrderedList');
          }
          document.execCommand(command, false, value);
          rememberSelection();
        }
        editor.addEventListener('input', persistBody);
        editor.addEventListener('focusout', rememberSelection);
        editor.addEventListener('pointerup', rememberSelection);
        editor.addEventListener('keyup', rememberSelection);
        editor.addEventListener('click', function (ev) { ev.stopPropagation(); notifyFocus(); });
        editor.addEventListener('paste', function (ev) {
          ev.preventDefault();
          document.execCommand('insertText', false, ev.clipboardData.getData('text/plain'));
        });
        editor.addEventListener('drop', function (ev) { ev.preventDefault(); });

        var linkTextInp = el('input', 'xped-input el-fmt-link-inp');
        linkTextInp.type = 'text';
        linkTextInp.placeholder = uiText('Link text (e.g. Read guideline)');
        linkTextInp.setAttribute('aria-label', uiText('Link text'));
        var linkUrlInp = el('input', 'xped-input el-fmt-link-inp');
        linkUrlInp.type = 'url';
        linkUrlInp.placeholder = 'https://… or DOI 10.xxxx/…';
        linkUrlInp.setAttribute('aria-label', uiText('Link URL'));
        var linkErr = el('span', 'el-fmt-link-err');
        linkErr.setAttribute('role', 'alert');
        var linkApply = el('button', 'el-btn el-btn-primary el-btn-sm', uiText('Insert link'));
        linkApply.type = 'button';
        var linkCancel = el('button', 'el-btn el-btn-sm', uiText('Cancel'));
        linkCancel.type = 'button';

        function closeLinkBox(restoreFocus) {
          linkBox.hidden = true;
          linkErr.textContent = '';
          if (restoreFocus) restoreSelection();
        }
        linkApply.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var norm = Model.normalizeCitationLink(linkUrlInp.value);
          if (!norm.url) {
            linkErr.textContent = uiText('Enter a valid https:// URL or DOI.');
            linkUrlInp.focus();
            return;
          }
          var label = linkTextInp.value.trim() || norm.label || norm.host;
          var link = document.createElement('a');
          link.href = norm.url;
          link.textContent = label;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          closeLinkBox(true);
          // Keep formatting on a selected label, including bold within the link.
          if (window.getSelection().toString() === label) {
            document.execCommand('createLink', false, norm.url);
          } else {
            document.execCommand('insertHTML', false, link.outerHTML);
          }
        });
        linkCancel.addEventListener('click', function (ev) {
          ev.stopPropagation();
          closeLinkBox(true);
        });
        [linkTextInp, linkUrlInp].forEach(function (inpEl) {
          inpEl.addEventListener('click', function (ev) { ev.stopPropagation(); });
          inpEl.addEventListener('keydown', function (ev) {
            if (ev.key === 'Enter') { ev.preventDefault(); linkApply.click(); }
            if (ev.key === 'Escape') { ev.preventDefault(); closeLinkBox(true); }
          });
        });
        var linkRow = el('div', 'el-fmt-link-row');
        linkRow.append(linkTextInp, linkUrlInp, linkApply, linkCancel);
        linkBox.append(linkRow, linkErr);

        [
          { label: 'P', title: uiText('Paragraph (clear heading/list)'), fn: function () { format('formatBlock', 'p'); } },
          { label: 'H2', title: uiText('Section heading'), fn: function () { format('formatBlock', 'h2'); } },
          { label: 'H3', title: uiText('Subheading'), fn: function () { format('formatBlock', 'h3'); } },
          { ico: 'bold', title: uiText('Bold text'), fn: function () { format('bold'); } },
          { ico: 'list', title: uiText('Bullet list (toggle selected lines)'), fn: function () { format('insertUnorderedList'); } },
          { label: '1.', title: uiText('Numbered list (toggle selected lines)'), fn: function () { format('insertOrderedList'); } },
          { ico: 'link', title: uiText('Insert link'), fn: function () {
            restoreSelection();
            linkTextInp.value = window.getSelection().toString().trim();
            linkUrlInp.value = '';
            linkErr.textContent = '';
            linkBox.hidden = false;
            (linkTextInp.value ? linkUrlInp : linkTextInp).focus();
          } },
        ].forEach(function (tool) {
          var tb = el('button', 'el-fmt-btn');
          tb.type = 'button';
          tb.title = tool.title;
          tb.setAttribute('aria-label', tool.title);
          if (tool.ico && Icons) tb.appendChild(Icons.icon(tool.ico, 14));
          else tb.textContent = tool.label;
          tb.addEventListener('mousedown', function (ev) { rememberSelection(); ev.preventDefault(); });
          tb.addEventListener('click', function (ev) { ev.stopPropagation(); notifyFocus(); tool.fn(); });
          fmtBar.appendChild(tb);
        });
        wrap.appendChild(fmtBar);
        wrap.appendChild(linkBox);
        wrap.appendChild(editor);
      } else {
        wrap.appendChild(field(renderFormattedBody(b), data.body));
      }
      return wrap;
    }

    if (block.type === 'video') {
      var embedSrc = Model.buildEmbedSrc(data, lang);
      // UX-032: Omit empty optional video blocks in learner/preview mode
      if (!editable && !embedSrc) {
        return document.createDocumentFragment();
      }
      var vt = Model.getLocalized(data.title, lang, defLang);
      if (vt || editable) {
        var vth = styledField('title', 'h3', 'xped-question-text', vt);
        field(vth, data.title);
        makeEditable(vth, uiText('Optional video title…'), editable, function (v) { onEdit(block, 'title', v); }, notifyFocus);
        wrap.appendChild(vth);
      }
      if (embedSrc) {
        var frame = el('div', 'xped-video-frame');
        var iframe = document.createElement('iframe');
        iframe.src = embedSrc;
        iframe.title = vt || uiText('Educational video');
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
        iframe.allowFullscreen = true;
        iframe.loading = 'lazy';
        frame.appendChild(iframe);
        wrap.appendChild(frame);
      } else {
        var ph = el('div', 'el-dropzone el-video-dropzone');
        if (Icons) ph.appendChild(Icons.icon('video', 24));
        ph.appendChild(el('strong', '', uiText('Add a YouTube or Vimeo Video')));
        ph.appendChild(el('span', '', uiText('Paste any video link below (timestamps like ?t=1m20s are detected automatically).')));
        var vRow = el('div', 'el-video-inline-row');
        var vInp = document.createElement('input');
        vInp.type = 'url';
        vInp.className = 'xped-input';
        vInp.placeholder = 'https://www.youtube.com/watch?v=…';
        vInp.setAttribute('aria-label', uiText('Video URL'));
        vInp.addEventListener('click', function (e) { e.stopPropagation(); notifyFocus(); });
        var vBtn = el('button', 'el-btn el-btn-primary el-btn-sm', uiText('Embed Video'));
        vBtn.type = 'button';
        vBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          if (vInp.value.trim()) onEdit(block, 'videoUrl', vInp.value.trim());
        });
        vInp.addEventListener('keydown', function (e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            if (vInp.value.trim()) onEdit(block, 'videoUrl', vInp.value.trim());
          }
        });
        vRow.appendChild(vInp);
        vRow.appendChild(vBtn);
        ph.appendChild(vRow);
        wrap.appendChild(ph);
      }
      var cap = Model.getLocalized(data.caption, lang, defLang);
      if (cap || editable) {
        var capEl = styledField('caption', 'p', 'xped-caption', cap);
        field(capEl, data.caption);
        makeEditable(capEl, uiText('Optional caption…'), editable, function (v) { onEdit(block, 'caption', v); }, notifyFocus);
        wrap.appendChild(capEl);
      }
      appendTranscript(wrap);
      return wrap;
    }

    if (block.type === 'image') {
      var layout = data.layout || 'full';
      var align = data.align || 'center';
      var imgWrap = el('div', 'xped-image-block layout-' + layout + ' align-' + align);
      var url = Model.resolveMediaUrl(data.media, data.mediaOverrides, lang, assetUrl);
      var fig = el('figure', 'xped-image-figure');
      if (url) {
        var img = document.createElement('img');
        setMediaSource(img, url);
        field(img, data.alt);
        img.alt = Model.getLocalized(data.alt, lang, defLang) || '';
        img.loading = 'lazy';
        if (data.crop) img.classList.add('is-cropped');
        if (data.crop) setImageFocal(img, data.focalX, data.focalY);
        fig.appendChild(img);
      } else if (editable) {
        fig.appendChild(createDropzone(
          uiText('Drop an image here or click to upload'),
          uiText('PNG, JPG or WebP — or pick an official xPED illustration on the right'),
          'image/png,image/jpeg,image/webp',
          onUploadFile ? function (file) { onUploadFile(block, file); } : null
        ));
      } else {
        return document.createDocumentFragment();
      }
      var icap = Model.getLocalized(data.caption, lang, defLang);
      if (icap || editable) {
        var fcap = el('figcaption');
        appendCopy(fcap, 'caption', 'xped-caption', uiText('Optional image caption…'));
        fig.appendChild(fcap);
      }
      imgWrap.appendChild(fig);
      if (layout === 'split-left' || layout === 'split-right' || data.sideTextBelow) {
        var side = el('div');
        var sh = Model.getLocalized(data.sideHeading, lang, defLang);
        var sb = Model.getLocalized(data.sideBody, lang, defLang);
        if (sh || editable) {
          var shEl = styledField('sideHeading', 'h3', 'xped-question-text', sh);
          field(shEl, data.sideHeading);
          makeEditable(shEl, uiText('Heading…'), editable, function (v) { onEdit(block, 'sideHeading', v); }, notifyFocus);
          side.appendChild(shEl);
        }
        var sbEl = styledField('sideBody', 'p', 'xped-richtext-body', sb);
        field(sbEl, data.sideBody);
        makeEditable(sbEl, uiText('Supporting explanation beside this visual…'), editable, function (v) { onEdit(block, 'sideBody', v); }, notifyFocus);
        side.appendChild(sbEl);
        imgWrap.appendChild(side);
      }
      wrap.appendChild(imgWrap);
      return wrap;
    }

    if (block.type === 'audio') {
      var aUrl = Model.resolveMediaUrl(data.media, data.mediaOverrides, lang, assetUrl);
      if (!editable && !aUrl && !Model.getLocalized(data.transcript, lang, defLang)) return document.createDocumentFragment();
      var card = el('div', 'xped-audio-card');
      var at = styledField('title', 'h3', 'xped-question-text', Model.getLocalized(data.title, lang, defLang));
      field(at, data.title);
      makeEditable(at, uiText('Audio exercise title…'), editable, function (v) { onEdit(block, 'title', v); });
      if (editable || at.textContent.trim()) card.appendChild(at);
      var desc = Model.getLocalized(data.description, lang, defLang);
      if (desc || editable) {
        var ad = styledField('description', 'p', 'xped-caption', desc);
        field(ad, data.description);
        makeEditable(ad, uiText('Short instruction for the learner…'), editable, function (v) { onEdit(block, 'description', v); });
        card.appendChild(ad);
      }
      if (aUrl) {
        var audio = document.createElement('audio');
        audio.controls = true;
        setMediaSource(audio, aUrl);
        card.appendChild(audio);
      } else if (editable) {
        card.appendChild(createDropzone(
          uiText('Drop an audio clip here or click to upload'),
          uiText('MP3, M4A or OGG (up to 15 MB)'),
          'audio/*',
          editable && onUploadFile ? function (file) { onUploadFile(block, file); } : null
        ));
      }
      appendTranscript(card);
      wrap.appendChild(card);
      return wrap;
    }

    if (block.type === 'callout') {
      var box = el('div', 'xped-callout tone-' + (data.tone || 'tip'));
      var iconBox = el('div', 'xped-callout-icon');
      if (Icons) iconBox.appendChild(Icons.icon(data.tone === 'bio' ? 'spark' : 'book', 17));
      box.appendChild(iconBox);
      var contentCol = el('div');
      var ct = styledField('title', 'h3', 'xped-callout-title', Model.getLocalized(data.title, lang, defLang));
      field(ct, data.title);
      makeEditable(ct, uiText('Key takeaway title…'), editable, function (v) { onEdit(block, 'title', v); });
      var cb = styledField('body', 'p', '', Model.getLocalized(data.body, lang, defLang));
      field(cb, data.body);
      makeEditable(cb, uiText('Write a concise takeaway message…'), editable, function (v) { onEdit(block, 'body', v); });
      if (editable || ct.textContent.trim()) contentCol.appendChild(ct);
      contentCol.appendChild(cb);
      box.appendChild(contentCol);
      wrap.appendChild(box);
      return wrap;
    }

    if (block.type === 'story') {
      var sc = el('div', 'xped-story-card');
      var sUrl = Model.resolveMediaUrl(data.media, null, lang, assetUrl);
      if (sUrl) {
        var portrait = el('span', 'xped-story-avatar');
        var av = document.createElement('img');
        framePortrait(av, data);
        setMediaSource(av, sUrl);
        av.alt = data.speakerName || uiText('Speaker');
        portrait.appendChild(av);
        sc.appendChild(portrait);
      }
      var bodyCol = el('div');
      var bq = el('blockquote', 'xped-story-quote');
      appendCopy(bq, 'quote', '', uiText('Write a patient or clinician quote…'));
      bodyCol.appendChild(bq);
      var meta = el('div', 'xped-story-meta');
      var spName = el('strong', '', data.speakerName || (editable ? '' : uiText('Naam')));
      field(spName, data.speakerName);
      makeEditable(spName, uiText('Speaker name'), editable, function (v) { onEdit(block, 'speakerName', v); });
      meta.appendChild(spName);
      var role = Model.getLocalized(data.speakerRole, lang, defLang);
      if (role || editable) {
        meta.appendChild(document.createTextNode(' · '));
        var roleEl = el('span', '', role);
        field(roleEl, data.speakerRole);
        makeEditable(roleEl, uiText('Role (e.g. Ervaringsverhaal)'), editable, function (v) { onEdit(block, 'speakerRole', v); });
        meta.appendChild(roleEl);
      }
      bodyCol.appendChild(meta);
      sc.appendChild(bodyCol);
      wrap.appendChild(sc);
      return wrap;
    }

    if (block.type === 'sources') {
      var validSources = (data.items || []).filter(function (item) {
        return editable || Model.getLocalized(item.citation, lang, defLang).trim() || String(item.url || '').trim();
      });
      if (!editable && !validSources.length) {
        return document.createDocumentFragment();
      }
      var shell = el('div', 'xped-sources-shell');
      var sdet = el('details', 'xped-details xped-sources-box');
      sdet._appDisclosure = true;
      var ssum = document.createElement('summary');
      ssum.className = 'xped-sources-summary';
      var tri = el('span', 'xped-sources-tri');
      tri.setAttribute('aria-hidden', 'true');
      ssum.appendChild(tri);
      ssum.appendChild(field(el('span', 'xped-sources-label', Model.getLocalized(data.title, lang, defLang) || Model.ui(lang, 'sourcesBar')), data.title));
      sdet.appendChild(ssum);
      var sbody = el('div', 'xped-details-body xped-sources-body');
      var ul = el('ul', 'xped-sources-list');
      validSources.forEach(function (item) {
        var li = el('li');
        var citTxt = Model.getLocalized(item.citation, lang, defLang);
        var citation = field(el('span', '', citTxt), item.citation);
        makeEditable(citation, uiText('Add a scientific reference…'), editable, function (v) { onEdit(block, 'citation:' + item.id, v); }, notifyFocus);
        li.appendChild(citation);
        var linkMeta = Model.normalizeCitationLink(item.url);
        if (linkMeta.url) {
          li.appendChild(document.createTextNode(' '));
          var a = document.createElement('a');
          a.href = linkMeta.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.className = 'xped-source-link';
          a.textContent = linkMeta.host === 'doi.org'
            ? linkMeta.label
            : Model.ui(lang, 'openSource', { host: linkMeta.host });
          li.appendChild(a);
        }
        ul.appendChild(li);
      });
      sbody.appendChild(ul);
      sdet.appendChild(sbody);
      var sourceAnimation;
      var expanding;
      ssum.addEventListener('click', function (event) {
        event.preventDefault();
        expanding = sourceAnimation ? !expanding : !sdet.open;
        var from = sdet.getBoundingClientRect().height;
        if (sourceAnimation) sourceAnimation.cancel();
        if (!sdet.animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          sourceAnimation = null;
          sdet.open = expanding;
          return;
        }
        sdet.open = true;
        var to = expanding ? sdet.getBoundingClientRect().height : ssum.getBoundingClientRect().height;
        var animation = sdet.animate([{height: from + 'px'}, {height: to + 'px'}],
          {duration: 200, easing: 'ease-out'});
        sourceAnimation = animation;
        animation.onfinish = function () {
          if (sourceAnimation !== animation) return;
          sdet.open = expanding;
          sourceAnimation = null;
        };
      });
      shell.appendChild(sdet);
      wrap.appendChild(shell);
      return wrap;
    }

    if (block.type === 'mcq') {
      var qh = styledField('question', 'h3', 'xped-question-text', Model.getLocalized(data.question, lang, defLang));
      field(qh, data.question);
      makeEditable(qh, uiText('Click to write your question…'), editable, function (v) { onEdit(block, 'question', v); }, notifyFocus);
      if (editable || qh.textContent.trim()) wrap.appendChild(qh);
      var sub = Model.getLocalized(data.subtitle, lang, defLang);
      if (sub || editable) {
        var subEl = styledField('subtitle', 'p', 'xped-caption', sub);
        field(subEl, data.subtitle);
        makeEditable(subEl, uiText('Optional helper subtitle…'), editable, function (v) { onEdit(block, 'subtitle', v); }, notifyFocus);
        wrap.appendChild(subEl);
      }
      var current = answers[block.id];
      var allowMulti = !!(block.settings && block.settings.allowMultiple);
      var selectedList = Array.isArray(current) ? current.slice() : (current ? [current] : []);
      var hasGradedKey = (data.graded !== false) && (data.options || []).some(function (o) { return !!o.isCorrect; });
      var needsSubmit = interactive && allowMulti && hasGradedKey && data.checkMode !== 'immediate';
      var isChecked = !needsSubmit ? selectedList.length > 0 : (Array.isArray(current) && current.length > 0);
      var grid = el('div', 'xped-options-grid');
      grid.setAttribute('role', allowMulti ? 'group' : 'radiogroup');
      labelControl(grid, qh);
      var checkRow = el('div', 'xped-mcq-check-row');
      var feedbackHost = el('div');
      feedbackHost.setAttribute('aria-live', 'polite');
      var peerHost = el('div');
      var letters = 'ABCDEFGHIJKLMNOPQRST';

      function evaluateMultiSet(sel) {
        var correctIds = (data.options || []).filter(function (o) { return !!o.isCorrect; }).map(function (o) { return o.id; });
        var selSet = Object.create(null);
        sel.forEach(function (id) { selSet[id] = true; });
        var rightSelected = correctIds.filter(function (id) { return !!selSet[id]; }).length;
        var wrongSelected = sel.filter(function (id) { return correctIds.indexOf(id) < 0; }).length;
        if (rightSelected === correctIds.length && wrongSelected === 0 && correctIds.length > 0) return 'exact';
        if (rightSelected > 0) return 'partial';
        return 'wrong';
      }

      function applyMcqClasses(sel, revealed) {
        var showGrade = revealed && sel.length > 0 && hasGradedKey;
        Array.prototype.forEach.call(grid.children, function (child, i) {
          var o = data.options[i];
          var s = sel.indexOf(o.id) >= 0;
          var cls = 'xped-option-btn';
          if (showGrade) {
            if (o.isCorrect) cls += ' is-correct';
            else if (s) cls += ' is-incorrect';
            else cls += ' is-muted';
            if (s) cls += ' is-chosen';
          } else if (s) {
            cls += ' is-selected is-chosen';
          }
          child.className = cls;
          child.setAttribute('aria-checked', s ? 'true' : 'false');
          if (interactive && !allowMulti) child.tabIndex = s || (!sel.length && i === 0) ? 0 : -1;
          var oldKey = child.querySelector('.xped-option-key');
          if (oldKey) oldKey.remove();
          var badge = child.querySelector('.xped-option-state');
          if (badge) {
            badge.textContent = '';
            if (s) {
              var incorrect = showGrade && !o.isCorrect;
              if (Icons) badge.appendChild(Icons.icon(incorrect ? 'x' : 'check', 16));
              else badge.textContent = incorrect ? '×' : '✓';
            }
            if (showGrade && o.isCorrect) {
              child.appendChild(el('span', 'xped-option-key', Model.ui(lang, 'correctChoice')));
            } else if (showGrade && s) {
              child.appendChild(el('span', 'xped-option-key sr-only', Model.ui(lang, 'incorrectChoice')));
            }
          }
        });
      }

      function showMcqFeedback(sel, revealed) {
        feedbackHost.textContent = '';
        peerHost.textContent = '';
        if (!sel.length || !revealed) return;
        var fbTexts = [];
        sel.forEach(function (sid) {
          var opt = (data.options || []).find(function (o) { return o.id === sid; });
          var txt = opt && Model.getLocalized(opt.feedback, lang, defLang);
          if (txt && fbTexts.indexOf(txt) < 0) fbTexts.push(txt);
        });
        var expTxt = Model.getLocalized(data.explanation, lang, defLang);
        if (!fbTexts.length && expTxt) fbTexts.push(expTxt);
        var outcome = null;
        if (hasGradedKey) {
          if (allowMulti) {
            outcome = evaluateMultiSet(sel);
          } else {
            var chosenOpt = (data.options || []).find(function (o) { return o.id === sel[0]; });
            outcome = (chosenOpt && chosenOpt.isCorrect) ? 'exact' : 'wrong';
          }
        }
        if (fbTexts.length || hasGradedKey) {
          var boxCls = outcome === 'exact' ? 'is-correct' : (outcome === 'partial' || outcome === 'wrong' ? 'is-gentle' : 'is-neutral');
          var box = el('div', 'xped-feedback-box ' + boxCls);
          if (outcome === 'exact') {
            box.appendChild(el('strong', 'xped-feedback-lead', allowMulti ? Model.ui(lang, 'allCorrect') : Model.ui(lang, 'rightLead')));
          } else if (outcome === 'partial') {
            box.appendChild(el('strong', 'xped-feedback-lead', Model.ui(lang, 'partialCorrect')));
          } else if (outcome === 'wrong') {
            box.appendChild(el('strong', 'xped-feedback-lead', Model.ui(lang, 'wrongMythLead')));
          }
          fbTexts.forEach(function (txt) {
            box.appendChild(el('p', 'xped-feedback-text', txt));
          });
          feedbackHost.appendChild(box);
        }
        if (interactive && block.settings && block.settings.showPeerResults && fetchAggregate) {
          fetchAggregate(block.id).then(function (agg) {
            peerHost.textContent = '';
            renderPeerBars(peerHost, block, agg, lang, defLang);
          });
        }
      }

      var checkBtn = null;
      if (needsSubmit) {
        checkBtn = el('button', 'xped-btn xped-btn-primary', Model.ui(lang, 'checkAnswers'));
        checkBtn.type = 'button';
        checkBtn.disabled = selectedList.length === 0;
        checkBtn.addEventListener('click', function () {
          isChecked = true;
          onAnswer(block.id, selectedList.slice());
          applyMcqClasses(selectedList, true);
          showMcqFeedback(selectedList, true);
        });
        checkRow.appendChild(checkBtn);
      }

      (data.options || []).forEach(function (opt, idx) {
        var btn = el('button', 'xped-option-btn');
        btn.type = 'button';
        btn.setAttribute('role', allowMulti ? 'checkbox' : 'radio');
        btn.setAttribute('aria-checked', selectedList.indexOf(opt.id) >= 0 ? 'true' : 'false');
        btn.appendChild(el('span', 'xped-option-letter', letters[idx] || String(idx + 1)));
        var lblSpan = field(el('span', 'xped-option-label', Model.getLocalized(opt.label, lang, defLang)), opt.label);
        if (editable) {
          makeEditable(lblSpan, uiText('Option ') + (idx + 1), true, function (v) { onEdit(block, 'option:' + opt.id, v); }, notifyFocus);
        }
        btn.appendChild(lblSpan);
        var stateMark = el('span', 'xped-option-state');
        stateMark.setAttribute('aria-hidden', 'true');
        btn.appendChild(stateMark);
        if (interactive) {
          btn.addEventListener('click', function () {
            var nextSel = allowMulti
              ? (selectedList.indexOf(opt.id) >= 0 ? selectedList.filter(function (x) { return x !== opt.id; }) : selectedList.concat([opt.id]))
              : [opt.id];
            selectedList = nextSel;
            if (needsSubmit) {
              if (isChecked) onAnswer(block.id, []);
              isChecked = false;
              if (checkBtn) checkBtn.disabled = selectedList.length === 0;
              applyMcqClasses(nextSel, false);
              showMcqFeedback(nextSel, false);
            } else {
              onAnswer(block.id, allowMulti ? nextSel : nextSel[0]);
              applyMcqClasses(nextSel, true);
              showMcqFeedback(nextSel, true);
            }
          });
        }
        if (interactive && !allowMulti) {
          btn.addEventListener('keydown', function (ev) {
            var delta = ['ArrowRight', 'ArrowDown'].includes(ev.key) ? 1 : (['ArrowLeft', 'ArrowUp'].includes(ev.key) ? -1 : 0);
            if (!delta) return;
            ev.preventDefault();
            var options = grid.children;
            var next = options[(idx + delta + options.length) % options.length];
            next.focus();
            next.click();
          });
        }
        grid.appendChild(btn);
      });
      applyMcqClasses(selectedList, isChecked);
      wrap.appendChild(grid);
      if (needsSubmit) wrap.appendChild(checkRow);

      if (editable) {
        var addOptBtn = el('button', 'el-quiet-add-step', uiText('+ Add option'));
        addOptBtn.type = 'button';
        addOptBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          onEdit(block, 'addOption', '');
        });
        wrap.appendChild(addOptBtn);
      }

      wrap.appendChild(feedbackHost);
      wrap.appendChild(peerHost);
      if (selectedList.length && isChecked) showMcqFeedback(selectedList, true);
      return wrap;
    }

    if (block.type === 'myth_fact') {
      // ZERO redundant "FABEL / FEIT" eyebrow above the statement!
      var stEl = styledField('statement', 'h3', 'xped-question-text', Model.getLocalized(data.statement, lang, defLang));
      field(stEl, data.statement);
      makeEditable(stEl, uiText('Click to write a common pain belief statement…'), editable, function (v) { onEdit(block, 'statement', v); }, notifyFocus);
      if (editable || stEl.textContent.trim()) wrap.appendChild(stEl);

      var picked = answers[block.id] || '';
      var row = el('div', 'xped-myth-row');
      row.setAttribute('role', 'group');
      labelControl(row, stEl);
      var fb = el('div');

      function applyMythClasses(choice) {
        var rightVal = data.correctAnswer || 'myth';
        Array.prototype.forEach.call(row.children, function (c, i) {
          var v = i === 0 ? 'myth' : 'fact';
          var cls = 'xped-option-btn xped-myth-btn';
          var icoSlot = c.querySelector('.xped-myth-status-ico');
          if (icoSlot) icoSlot.textContent = '';
          c.setAttribute('aria-pressed', choice === v ? 'true' : 'false');
          if (choice) {
            if (v === rightVal) {
              cls += ' is-correct';
              if (icoSlot && Icons) icoSlot.appendChild(Icons.icon('checkCircle', 18));
            } else if (choice === v) {
              cls += ' is-incorrect';
              if (icoSlot && Icons) icoSlot.appendChild(Icons.icon('x', 18));
            } else {
              cls += ' is-muted';
            }
          }
          c.className = cls;
        });
      }

      function drawMythFeedback(choice) {
        fb.textContent = '';
        if (!choice) return;
        var rightVal = data.correctAnswer || 'myth';
        var isRight = choice === rightVal;
        var box = el('div', 'xped-feedback-box ' + (isRight ? 'is-correct' : 'is-gentle'));
        var leadText = isRight ? Model.ui(lang, 'rightLead') : Model.ui(lang, 'wrongMythLead');
        box.appendChild(el('strong', 'xped-feedback-lead', leadText));
        var ansLabel = rightVal === 'fact' ? Model.ui(lang, 'fact') : Model.ui(lang, 'myth');
        var expText = Model.getLocalized(data.explanation, lang, defLang) || '';
        var p = el('p', 'xped-feedback-text');
        if (expText && expText.toLowerCase().indexOf(ansLabel.toLowerCase()) !== 0) {
          p.appendChild(el('strong', '', ansLabel + ': '));
        }
        p.appendChild(document.createTextNode(expText));
        var srcMeta = Model.normalizeCitationLink(data.sourceUrl);
        if (srcMeta.url) {
          var a = document.createElement('a');
          a.href = srcMeta.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = ' ' + (Model.getLocalized(data.sourceLabel, lang, defLang) || srcMeta.label || Model.ui(lang, 'sourcesBar'));
          p.appendChild(a);
        }
        box.appendChild(p);
        box.appendChild(el('p', 'xped-caption', Model.ui(lang, 'yourAnswer') + ': ' + Model.ui(lang, choice)));
        fb.appendChild(box);
      }

      // UX-105: Neutral before answering — zero pre-answer X/Check cues!
      ['myth', 'fact'].forEach(function (val) {
        var btn = el('button', 'xped-option-btn xped-myth-btn');
        btn.type = 'button';
        btn.setAttribute('aria-pressed', picked === val ? 'true' : 'false');
        var icoSlot = el('span', 'xped-myth-status-ico');
        icoSlot.setAttribute('aria-hidden', 'true');
        btn.appendChild(icoSlot);
        btn.appendChild(el('span', '', Model.ui(lang, val)));
        if (interactive) {
          btn.addEventListener('click', function () {
            picked = val;
            onAnswer(block.id, val);
            applyMythClasses(val);
            drawMythFeedback(val);
          });
        }
        row.appendChild(btn);
      });
      if (picked) applyMythClasses(picked);
      wrap.appendChild(row);
      wrap.appendChild(fb);
      if (picked) drawMythFeedback(picked);
      return wrap;
    }

    if (block.type === 'scale') {
      var sq = styledField('question', 'h3', 'xped-question-text', Model.getLocalized(data.question, lang, defLang));
      field(sq, data.question);
      makeEditable(sq, uiText('Click to write your scale prompt…'), editable, function (v) { onEdit(block, 'question', v); }, notifyFocus);
      if (editable || sq.textContent.trim()) wrap.appendChild(sq);
      var minV = Number.isFinite(data.min) ? data.min : 0;
      var maxV = Number.isFinite(data.max) ? data.max : 10;
      var midV = Math.round((minV + maxV) / 2);
      var hasValue = answers[block.id] !== undefined && answers[block.id] !== null && answers[block.id] !== '';
      var curVal = hasValue ? Number(answers[block.id]) : midV;
      var sw = el('div', 'xped-scale-wrap' + (!hasValue && interactive ? ' is-untouched' : ''));
      var topRow = el('div', 'xped-step-kicker-row');
      topRow.appendChild(el('span', '', Model.ui(lang, 'yourAnswer')));
      var pillWrap = el('div', 'el-btn-row');
      var pill = el('span', 'xped-scale-value-pill' + (!hasValue && interactive ? ' is-untouched' : ''), hasValue || !interactive ? String(curVal) : Model.ui(lang, 'notChosenYet'));
      pillWrap.appendChild(pill);
      var midBtn = null;
      if (interactive && !hasValue) {
        midBtn = el('button', 'xped-btn xped-btn-ghost xped-scale-mid-btn', Model.ui(lang, 'chooseMidpoint', { n: midV }));
        midBtn.type = 'button';
        pillWrap.appendChild(midBtn);
      }
      topRow.appendChild(pillWrap);
      sw.appendChild(topRow);

      var slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'xped-range';
      slider.min = String(minV);
      slider.max = String(maxV);
      slider.value = String(curVal);
      labelControl(slider, sq);
      var lblsId = 'scale-end-' + instanceId;
      slider.setAttribute('aria-describedby', lblsId);
      slider.setAttribute('aria-valuetext', hasValue ? String(curVal) : Model.ui(lang, 'notChosenYet'));

      var peerHostS = el('div');
      function commitScaleVal(valNum, loadPeers) {
        hasValue = true;
        sw.classList.remove('is-untouched');
        pill.classList.remove('is-untouched');
        pill.textContent = String(valNum);
        slider.value = String(valNum);
        slider.setAttribute('aria-valuetext', String(valNum));
        if (midBtn && midBtn.parentNode) midBtn.remove();
        onAnswer(block.id, valNum);
        if (loadPeers && block.settings && block.settings.showPeerResults && fetchAggregate) {
          fetchAggregate(block.id).then(function (agg) {
            peerHostS.textContent = '';
            renderPeerBars(peerHostS, block, agg, lang, defLang);
          });
        }
      }
      if (interactive) {
        if (midBtn) midBtn.addEventListener('click', function () { commitScaleVal(midV, true); });
        slider.addEventListener('input', function () { commitScaleVal(Number(slider.value), false); });
        slider.addEventListener('change', function () { commitScaleVal(Number(slider.value), true); });
        slider.addEventListener('pointerup', function () {
          if (!hasValue) commitScaleVal(Number(slider.value), true);
        });
      }
      sw.appendChild(slider);
      var lbls = el('div', 'xped-scale-labels');
      lbls.id = lblsId;
      lbls.appendChild(field(el('span', '', minV + ' · ' + Model.getLocalized(data.minLabel, lang, defLang)), data.minLabel));
      lbls.appendChild(field(el('span', '', maxV + ' · ' + Model.getLocalized(data.maxLabel, lang, defLang)), data.maxLabel));
      sw.appendChild(lbls);
      wrap.appendChild(sw);
      var sfb = Model.getLocalized(data.feedback, lang, defLang);
      if (sfb) wrap.appendChild(el('p', 'xped-caption', sfb));
      wrap.appendChild(peerHostS);
      return wrap;
    }

    if (block.type === 'reflection') {
      var rp = styledField('prompt', 'h3', 'xped-question-text', Model.getLocalized(data.prompt, lang, defLang));
      field(rp, data.prompt);
      makeEditable(rp, uiText('Click to write your reflection prompt…'), editable, function (v) { onEdit(block, 'prompt', v); });
      if (editable || rp.textContent.trim()) wrap.appendChild(rp);
      var ta = document.createElement('textarea');
      ta.className = 'xped-textarea';
      ta.rows = 4;
      labelControl(ta, rp);
      if (ctx.collectResponses) {
        var reflectionNote = el('p', 'xped-caption', Model.ui(lang, 'reflectionAccess'));
        reflectionNote.id = 'reflection-access-' + instanceId;
        wrap.appendChild(reflectionNote);
        ta.setAttribute('aria-describedby', reflectionNote.id);
      }
      field(ta, data.placeholder);
      ta.placeholder = Model.getLocalized(data.placeholder, lang, defLang);
      ta.value = String(answers[block.id] || '');
      ta.readOnly = !interactive;
      if (interactive) ta.addEventListener('input', function () { onAnswer(block.id, ta.value); });
      wrap.appendChild(ta);
      return wrap;
    }

    if (block.type === 'wordcloud') {
      var wq = styledField('question', 'h3', 'xped-question-text', Model.getLocalized(data.question, lang, defLang));
      field(wq, data.question);
      makeEditable(wq, uiText('Click to write your word cloud question…'), editable, function (v) { onEdit(block, 'question', v); }, notifyFocus);
      if (editable || wq.textContent.trim()) wrap.appendChild(wq);
      var maxW = data.maxWords || 3;
      var words = Array.isArray(answers[block.id]) ? answers[block.id].slice() : [];
      var rowW = el('div', 'xped-input-actions');
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'xped-input';
      field(inp, data.placeholder);
      inp.placeholder = Model.getLocalized(data.placeholder, lang, defLang) || Model.ui(lang, 'addWordPlaceholder');
      labelControl(inp, wq);
      if (ctx.sharedAnswer) {
        var wordNotice = el('p', 'xped-caption', Model.ui(lang, 'sharedWords'));
        wordNotice.id = 'wordcloud-access-' + instanceId;
        wrap.appendChild(wordNotice);
        inp.setAttribute('aria-describedby', wordNotice.id);
      }
      inp.disabled = !interactive;
      var addBtn = el('button', 'xped-btn xped-btn-secondary', Model.ui(lang, 'addWordBtn'));
      addBtn.type = 'button';
      addBtn.disabled = !interactive;
      var countLine = el('p', 'xped-caption xped-limit-meta');
      countLine.setAttribute('aria-live', 'polite');
      var tagsBox = el('div', 'xped-word-tags');
      var peerBoxW = el('div');

      function updateWordCount(limitHit) {
        if (limitHit) {
          countLine.textContent = Model.ui(lang, 'wordsLimitReached', { max: maxW });
          countLine.classList.add('is-warn');
        } else {
          countLine.textContent = Model.ui(lang, 'wordsRemaining', { n: words.length, max: maxW });
          countLine.classList.remove('is-warn');
        }
      }

      function drawTags(focusIndex) {
        tagsBox.textContent = '';
        var rmButtons = [];
        words.forEach(function (w, idx) {
          var chip = el('span', 'xped-word-chip');
          chip.appendChild(el('span', '', w));
          if (interactive) {
            var rm = el('button', 'xped-word-rm', '×');
            rm.type = 'button';
            rm.setAttribute('aria-label', Model.ui(lang, 'removeWord', { word: w }));
            rm.addEventListener('click', function () {
              words.splice(idx, 1);
              onAnswer(block.id, words.slice());
              drawTags(Math.min(idx, words.length - 1));
            });
            rmButtons.push(rm);
            chip.appendChild(rm);
          }
          tagsBox.appendChild(chip);
        });
        updateWordCount(false);
        if (typeof focusIndex === 'number') {
          if (rmButtons[focusIndex]) rmButtons[focusIndex].focus();
          else if (interactive) inp.focus();
        }
      }

      function addWord() {
        var val = inp.value.trim();
        if (!val) return;
        if (words.length >= maxW) {
          updateWordCount(true);
          return;
        }
        words.push(val);
        inp.value = '';
        onAnswer(block.id, words.slice());
        drawTags();
        if (block.settings && block.settings.showPeerResults && fetchAggregate) {
          fetchAggregate(block.id).then(function (agg) {
            peerBoxW.textContent = '';
            renderPeerBars(peerBoxW, block, agg, lang, defLang);
          });
        }
      }
      if (interactive) {
        addBtn.addEventListener('click', addWord);
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addWord(); } });
      }
      rowW.appendChild(inp);
      rowW.appendChild(addBtn);
      wrap.appendChild(rowW);
      wrap.appendChild(countLine);
      wrap.appendChild(tagsBox);
      wrap.appendChild(peerBoxW);
      drawTags();
      return wrap;
    }

    if (block.type === 'ranking') {
      var rq = styledField('question', 'h3', 'xped-question-text', Model.getLocalized(data.question, lang, defLang));
      field(rq, data.question);
      makeEditable(rq, uiText('Click to write your ranking prompt…'), editable, function (v) { onEdit(block, 'question', v); }, notifyFocus);
      if (editable || rq.textContent.trim()) wrap.appendChild(rq);
      var items = data.items || [];
      var order = Array.isArray(answers[block.id]) && answers[block.id].length === items.length
        ? answers[block.id].slice()
        : items.map(function (it) { return it.id; });
      var liveRank = el('span', 'sr-only');
      liveRank.setAttribute('aria-live', 'polite');
      var listEl = el('div', 'xped-options-grid');

      function drawRank(focusTarget) {
        listEl.textContent = '';
        order.forEach(function (id, idx) {
          var item = items.find(function (it) { return it.id === id; });
          if (!item) return;
          var itemLabel = Model.getLocalized(item.label, lang, defLang);
          var r = el('div', 'xped-rank-item');
          var left = el('div', 'el-btn-row');
          left.appendChild(el('span', 'xped-rank-pos', String(idx + 1)));
          left.appendChild(field(el('span', '', itemLabel), item.label));
          r.appendChild(left);
          if (interactive) {
            var acts = el('div', 'el-btn-row');
            var up = el('button', 'el-icon-btn');
            up.type = 'button';
            up.setAttribute('aria-label', Model.ui(lang, 'up') + ' - ' + itemLabel);
            up.setAttribute('data-rank-id', id);
            up.setAttribute('data-rank-dir', 'up');
            up.disabled = idx === 0;
            if (Icons) up.appendChild(Icons.icon('chevronUp', 16));
            up.addEventListener('click', function () {
              var tmp = order[idx - 1];
              order[idx - 1] = order[idx];
              order[idx] = tmp;
              onAnswer(block.id, order.slice());
              liveRank.textContent = Model.ui(lang, 'movedItem', { label: itemLabel, pos: idx, total: order.length });
              drawRank({ id: id, dir: idx - 1 === 0 ? 'down' : 'up' });
            });
            var dn = el('button', 'el-icon-btn');
            dn.type = 'button';
            dn.setAttribute('aria-label', Model.ui(lang, 'down') + ' - ' + itemLabel);
            dn.setAttribute('data-rank-id', id);
            dn.setAttribute('data-rank-dir', 'down');
            dn.disabled = idx === order.length - 1;
            if (Icons) dn.appendChild(Icons.icon('chevronDown', 16));
            dn.addEventListener('click', function () {
              var tmp = order[idx + 1];
              order[idx + 1] = order[idx];
              order[idx] = tmp;
              onAnswer(block.id, order.slice());
              liveRank.textContent = Model.ui(lang, 'movedItem', { label: itemLabel, pos: idx + 2, total: order.length });
              drawRank({ id: id, dir: idx + 1 === order.length - 1 ? 'up' : 'down' });
            });
            acts.appendChild(up);
            acts.appendChild(dn);
            r.appendChild(acts);
          }
          listEl.appendChild(r);
        });
        if (focusTarget) {
          var nextFocus = listEl.querySelector('button[data-rank-id="' + CSS.escape(focusTarget.id) + '"][data-rank-dir="' + focusTarget.dir + '"]');
          if (nextFocus && !nextFocus.disabled) nextFocus.focus();
        }
      }
      drawRank();
      wrap.appendChild(liveRank);
      wrap.appendChild(listEl);
      return wrap;
    }

    if (block.type === 'hotspot') {
      var ht = styledField('title', 'h3', 'xped-question-text', Model.getLocalized(data.title, lang, defLang));
      field(ht, data.title);
      makeEditable(ht, uiText('Interactive visual title…'), editable, function (v) { onEdit(block, 'title', v); }, notifyFocus);
      if (editable || ht.textContent.trim()) wrap.appendChild(ht);
      var inst = Model.getLocalized(data.instruction, lang, defLang);
      if (inst || editable) {
        wrap.appendChild(field(el('p', 'xped-caption', editable ? uiText('Tip: click the image to add a pin, or drag any pin to reposition it.') : inst), data.instruction));
      }
      var hUrl = Model.resolveMediaUrl(data.media, null, lang, assetUrl);
      var rawPins = data.pins || [];
      // UX-043: Omit blank/unlabelled pins in learner/preview mode
      var pins = editable ? rawPins : rawPins.filter(function (p) {
        return Model.getLocalized(p.label, lang, defLang).trim() && Model.getLocalized(p.detail, lang, defLang).trim();
      });
      if (!editable && !pins.length) return document.createDocumentFragment();
      // UX-044: Start unanswered hotspots in neutral state (restore saved choice on return)
      var savedPinId = answers[block.id] || '';
      var activePinId = pins.some(function (p) { return p.id === savedPinId; })
        ? savedPinId
        : (editable ? ((ctx.selectedPinId && pins.some(function (p) { return p.id === ctx.selectedPinId; }) ? ctx.selectedPinId : (pins[0] && pins[0].id)) || '') : '');
      var detailBox = el('div');

      function drawPinDetail(pid) {
        detailBox.textContent = '';
        var pin = pins.find(function (p) { return p.id === pid; });
        if (!pin) {
          if (pins.length) {
            detailBox.appendChild(el('p', 'xped-caption xped-hotspot-prompt', Model.ui(lang, 'hotspotUnselected')));
          }
          return;
        }
        var box = el('div', 'xped-feedback-box is-neutral');
        var lblTxt = Model.getLocalized(pin.label, lang, defLang);
        var pinTitle = field(el('strong', 'xped-pin-title', lblTxt), pin.label);
        var pinBody = field(el('p', 'xped-pin-detail', Model.getLocalized(pin.detail, lang, defLang)), pin.detail);
        makeEditable(pinTitle, uiText('Name this point…'), editable, function (v) {
          onEdit(block, 'pinLabel:' + pin.id, v);
          var chipLabel = fbBar.querySelector('[data-pin-id="' + CSS.escape(pin.id) + '"] .xped-pin-label');
          if (chipLabel) chipLabel.textContent = v;
        }, notifyFocus);
        makeEditable(pinBody, uiText('Explain this point…'), editable, function (v) { onEdit(block, 'pinDetail:' + pin.id, v); }, notifyFocus);
        box.append(pinTitle, pinBody);
        detailBox.appendChild(box);
      }

      function selectPin(pin) {
        activePinId = pin.id;
        if (interactive) onAnswer(block.id, pin.id);
        if (editable) onEdit(block, 'selectPin', pin.id);
        wrap.querySelectorAll('.xped-hotspot-pin').forEach(function (point, index) {
          point.classList.toggle('is-active', pins[index] && pins[index].id === pin.id);
        });
        fbBar.querySelectorAll('button').forEach(function (button, index) {
          button.setAttribute('aria-pressed', String(pins[index] && pins[index].id === pin.id));
        });
        drawPinDetail(pin.id);
      }

      if (hUrl) {
        var stage = el('div', 'xped-hotspot-stage' + (editable ? ' is-placeable' : ''));
        var himg = document.createElement('img');
        setMediaSource(himg, hUrl);
        field(himg, data.alt);
        himg.alt = Model.getLocalized(data.alt, lang, defLang) || '';
        stage.appendChild(himg);
        var draggedPin = false;
        if (editable) {
          stage.addEventListener('click', function (e) {
            if (draggedPin) { draggedPin = false; return; }
            if (e.target.closest('.xped-hotspot-pin')) return;
            e.stopPropagation();
            notifyFocus();
            var rect = stage.getBoundingClientRect();
            var x = Math.max(2, Math.min(98, Math.round(((e.clientX - rect.left) / rect.width) * 100)));
            var y = Math.max(2, Math.min(98, Math.round(((e.clientY - rect.top) / rect.height) * 100)));
            onEdit(block, 'addPin', { x: x, y: y });
          });
        }
        var ns = 'http://www.w3.org/2000/svg';
        var overlay = document.createElementNS(ns, 'svg');
        overlay.classList.add('xped-hotspot-overlay');
        overlay.setAttribute('aria-hidden', 'true');
        pins.forEach(function (pin, idx) {
          var point = pinMarker(pin, idx + 1);
          point.classList.toggle('is-active', pin.id === activePinId);
          var circle = point.querySelector('circle');

          if (editable) {
            var dragging = false;
            var moved = false;
            var curX = pin.x ?? 50;
            var curY = pin.y ?? 50;
            circle.addEventListener('pointerdown', function (ev) {
              ev.stopPropagation();
              notifyFocus();
              dragging = true;
              moved = false;
              if (circle.setPointerCapture) {
                try { circle.setPointerCapture(ev.pointerId); } catch (_e) {}
              }
            });
            circle.addEventListener('pointermove', function (ev) {
              if (!dragging) return;
              var rect = stage.getBoundingClientRect();
              if (!rect.width || !rect.height) return;
              curX = Math.max(2, Math.min(98, Math.round(((ev.clientX - rect.left) / rect.width) * 100)));
              curY = Math.max(2, Math.min(98, Math.round(((ev.clientY - rect.top) / rect.height) * 100)));
              point.setAttribute('x', curX + '%');
              point.setAttribute('y', curY + '%');
              moved = true;
            });
            circle.addEventListener('pointerup', function (ev) {
              if (!dragging) return;
              dragging = false;
              ev.stopPropagation();
              if (moved) {
                draggedPin = true;
                onEdit(block, 'movePin', { id: pin.id, x: curX, y: curY });
              } else {
                selectPin(pin);
              }
            });
            circle.addEventListener('pointercancel', function () {
              dragging = false;
              point.setAttribute('x', (pin.x ?? 50) + '%');
              point.setAttribute('y', (pin.y ?? 50) + '%');
            });
          } else {
            point.addEventListener('click', function (event) {
              event.stopPropagation();
              selectPin(pin);
            });
          }
          overlay.appendChild(point);
        });
        stage.appendChild(overlay);
        wrap.appendChild(stage);
      }
      var fbBar = el('div', 'xped-hotspot-fallback');
      pins.forEach(function (pin, idx) {
        var chip = el('button', 'xped-btn xped-btn-secondary');
        chip.type = 'button';
        if (pin.color) {
          var swatch = colorSwatch(pin.color);
          swatch.classList.add('xped-pin-chip-dot');
          chip.appendChild(swatch);
        }
        chip.append(document.createTextNode((idx + 1) + '. '), field(el('span', 'xped-pin-label', Model.getLocalized(pin.label, lang, defLang) || uiText('Point')), pin.label));
        chip.dataset.pinId = pin.id;
        chip.setAttribute('aria-pressed', String(pin.id === activePinId));
        chip.addEventListener('click', function (e) { e.stopPropagation(); selectPin(pin); });
        if (editable) {
          chip.addEventListener('keydown', function (e) {
            var step = e.shiftKey ? 5 : 1;
            var dx = e.key === 'ArrowRight' ? step : (e.key === 'ArrowLeft' ? -step : 0);
            var dy = e.key === 'ArrowDown' ? step : (e.key === 'ArrowUp' ? -step : 0);
            if (!dx && !dy) return;
            e.preventDefault();
            e.stopPropagation();
            var nx = Math.max(2, Math.min(98, Math.round((pin.x ?? 50) + dx)));
            var ny = Math.max(2, Math.min(98, Math.round((pin.y ?? 50) + dy)));
            onEdit(block, 'movePin', { id: pin.id, x: nx, y: ny, keyboard: true });
          });
        }
        fbBar.appendChild(chip);
      });
      wrap.appendChild(fbBar);
      wrap.appendChild(detailBox);
      drawPinDetail(activePinId);
      return wrap;
    }

    if (block.type === 'balance_scale') {
      // Avoid unnatural title doubling if Step Title already names the scale
      var bTitle = Model.getLocalized(data.title, lang, defLang);
      if ((bTitle && bTitle.toLowerCase() !== stepTitleLower && !stepTitleLower.includes('weegschaal') && !stepTitleLower.includes('balance') && !stepTitleLower.includes('waage')) || editable) {
        var bth = styledField('title', 'h3', 'xped-question-text', bTitle);
        field(bth, data.title);
        makeEditable(bth, uiText('Optional balance scale subtitle…'), editable, function (v) { onEdit(block, 'title', v); });
        wrap.appendChild(bth);
      }
      var bintro = Model.getLocalized(data.intro, lang, defLang);
      if (bintro || editable) {
        var bi = styledField('intro', 'p', 'xped-caption', bintro);
        field(bi, data.intro);
        makeEditable(bi, uiText('Short friendly instruction…'), editable, function (v) { onEdit(block, 'intro', v); });
        wrap.appendChild(bi);
      }
      var factors = data.factors || [];
      var vals = (answers[block.id] && typeof answers[block.id] === 'object') ? Object.assign({}, answers[block.id]) : {};
      factors.forEach(function (f) { vals[f.id] = Model.balanceScore(vals[f.id]) ?? 1; });

      var stageBox = el('div', 'xped-balance-stage');
      var visBand = el('div', 'xped-balance-visual-band');
      var statusEl = el('div', 'xped-balance-status');
      var svgSlot = el('div');
      visBand.appendChild(statusEl);
      visBand.appendChild(svgSlot);
      stageBox.appendChild(visBand);

      var tipWrap = el('div', 'xped-balance-tip-wrap');

      var interacted = !!(answers[block.id] && typeof answers[block.id] === 'object');

      function updateBalanceVisual() {
        var loadT = 0;
        var resT = 0;
        factors.forEach(function (f) {
          var v = Number(vals[f.id] || 0);
          if (f.category === 'resource') resT += v;
          else loadT += v;
        });
        var statusMap = {
          nl: loadT > resT ? 'Meer draaglast' : (resT > loadT ? 'Sterke draagkracht' : 'In balans'),
          en: loadT > resT ? 'Higher load' : (resT > loadT ? 'Strong resources' : 'In balance'),
          de: loadT > resT ? 'Höhere Belastung' : (resT > loadT ? 'Starke Ressourcen' : 'Im Gleichgewicht'),
        };
        statusEl.textContent = (statusMap[lang] || statusMap.nl) + ' · ' + loadT + uiText(' vs ') + resT;
        svgSlot.textContent = '';
        var svgNode = renderBalanceSvg(loadT, resT);
        if (interactive && !interacted) svgNode.classList.add('is-cue-sway');
        svgSlot.appendChild(svgNode);
        tipWrap.textContent = '';
        var tipKey = loadT > resT ? 'overloadTip' : 'balancedTip';
        var tipText = loadT > resT
          ? Model.getLocalized(data.overloadTip, lang, defLang)
          : Model.getLocalized(data.balancedTip, lang, defLang);
        if (tipText || editable) {
          var tip = field(el('div', 'xped-feedback-box ' + (loadT > resT ? 'is-gentle' : 'is-correct'), tipText), data[tipKey]);
          tipWrap.appendChild(makeEditable(tip, uiText('Balance feedback'), editable, function (v) { onEdit(block, tipKey, v); }));
        }
      }

      function balanceColumn(category, key) {
        var column = el('div', 'xped-balance-col is-' + category);
        var title = field(el('div', 'xped-balance-col-head', Model.getLocalized(data[key], lang, defLang) || Model.ui(lang, category)), data[key]);
        column.appendChild(makeEditable(title, uiText('Column title'), editable, function (v) { onEdit(block, key, v); }));
        return column;
      }

      var cols = el('div', 'xped-balance-cols');
      var loadCol = balanceColumn('load', 'loadLabel');
      var resCol = balanceColumn('resource', 'resourceLabel');

      factors.forEach(function (f) {
        var fWrap = el('div', 'xped-balance-factor');
        var flab = document.createElement('label');
        var vSpan = el('span', '', String(vals[f.id]) + '/3');
        var factorName = field(el('span', '', Model.getLocalized(f.label, lang, defLang)), f.label);
        flab.appendChild(makeEditable(factorName, uiText('Factor name'), editable, function (v) { onEdit(block, 'factorLabel:' + f.id, v); }));
        flab.appendChild(vSpan);
        var rng = document.createElement('input');
        rng.type = 'range';
        flab.htmlFor = rng.id = 'factor-' + instanceId + '-' + f.id;
        rng.className = 'xped-range ' + (f.category === 'resource' ? 'is-resource' : 'is-load');
        rng.min = '0';
        rng.max = '3';
        rng.value = String(vals[f.id]);
        rng.disabled = !interactive && !editable;
        if (interactive || editable) {
          rng.addEventListener('input', function () {
            interacted = true;
            vals[f.id] = Number(rng.value);
            vSpan.textContent = rng.value + '/3';
            if (interactive) onAnswer(block.id, Object.assign({}, vals));
            updateBalanceVisual();
          });
        }
        fWrap.appendChild(flab);
        fWrap.appendChild(rng);
        if (f.category === 'resource') resCol.appendChild(fWrap);
        else loadCol.appendChild(fWrap);
      });

      cols.appendChild(loadCol);
      cols.appendChild(resCol);
      stageBox.appendChild(cols);
      stageBox.appendChild(tipWrap);
      wrap.appendChild(stageBox);
      updateBalanceVisual();
      return wrap;
    }

    if (block.type === 'bps_triad') {
      var bpt = styledField('title', 'h3', 'xped-question-text', Model.getLocalized(data.title, lang, defLang));
      field(bpt, data.title);
      makeEditable(bpt, uiText('Biopsychosocial heading…'), editable, function (v) { onEdit(block, 'title', v); });
      if (editable || bpt.textContent.trim()) wrap.appendChild(bpt);
      appendCopy(wrap, 'intro', 'xped-caption', uiText('Short friendly instruction…'));
      var tabs = el('div', 'xped-bps-tabs');
      tabs.setAttribute('role', 'tablist');
      var panel = el('div', 'xped-bps-panel');
      var activeKey = 'bio';
      var defs = [
        { key: 'bio', title: Model.getLocalized(data.bioTitle, lang, defLang) || Model.ui(lang, 'bio'), body: Model.getLocalized(data.bioBody, lang, defLang) },
        { key: 'psycho', title: Model.getLocalized(data.psychoTitle, lang, defLang) || Model.ui(lang, 'psycho'), body: Model.getLocalized(data.psychoBody, lang, defLang) },
        { key: 'social', title: Model.getLocalized(data.socialTitle, lang, defLang) || Model.ui(lang, 'social'), body: Model.getLocalized(data.socialBody, lang, defLang) },
      ];
      function showTab(key) {
        activeKey = key;
        Array.prototype.forEach.call(tabs.children, function (btn, i) {
          var on = defs[i].key === activeKey;
          btn.classList.toggle('is-active', on);
          btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        var item = defs.find(function (d) { return d.key === activeKey; });
        field(panel, data[key + uiText('Body')]);
        panel.textContent = (item && item.body) || (editable ? uiText('Add an explanation in properties.') : '');
      }
      defs.forEach(function (d) {
        var tb = field(el('button', 'xped-bps-tab', d.title), data[d.key + uiText('Title')]);
        tb.type = 'button';
        tb.setAttribute('role', 'tab');
        tb.setAttribute('data-bps', d.key);
        tb.addEventListener('click', function () { showTab(d.key); });
        tabs.appendChild(tb);
      });
      wrap.appendChild(tabs);
      wrap.appendChild(panel);
      showTab('bio');
      return wrap;
    }

    if (block.type === 'mini_plan') {
      var mpt = styledField('title', 'h3', 'xped-question-text', Model.getLocalized(data.title, lang, defLang));
      field(mpt, data.title);
      makeEditable(mpt, uiText('Mini-plan heading…'), editable, function (v) { onEdit(block, 'title', v); }, notifyFocus);
      if (editable || mpt.textContent.trim()) wrap.appendChild(mpt);
      appendCopy(wrap, 'intro', 'xped-caption', uiText('Short friendly instruction…'));
      var maxSel = data.maxSelect || 3;
      var planState = Model.normalizeMiniPlanAnswer(answers[block.id], data.suggestions, lang, defLang);
      var planCount = el('p', 'xped-caption xped-limit-meta');
      planCount.setAttribute('aria-live', 'polite');
      var chips = el('div', 'xped-plan-chips');

      function totalSelected() {
        return planState.ids.length + planState.custom.length;
      }

      function updatePlanMeta(limitHit) {
        if (limitHit) {
          planCount.textContent = Model.ui(lang, 'goalsLimitReached', { max: maxSel });
          planCount.classList.add('is-warn');
        } else {
          planCount.textContent = Model.ui(lang, 'goalsSelectedCount', { n: totalSelected(), max: maxSel });
          planCount.classList.remove('is-warn');
        }
      }

      function commitPlan() {
        onAnswer(block.id, { ids: planState.ids.slice(), custom: planState.custom.slice() });
      }

      function drawChips() {
        chips.textContent = '';
        (data.suggestions || []).forEach(function (sug) {
          var txt = Model.getLocalized(sug.label, lang, defLang);
          var isOn = planState.ids.indexOf(sug.id) >= 0;
          var btn = el('button', 'xped-plan-chip' + (isOn ? ' is-selected' : ''));
          btn.type = 'button';
          btn.setAttribute('aria-pressed', isOn ? 'true' : 'false');
          if (Icons) btn.appendChild(Icons.icon(isOn ? 'check' : 'plus', 14));
          btn.appendChild(field(el('span', '', txt), sug.label));
          if (interactive) {
            btn.addEventListener('click', function () {
              if (planState.ids.indexOf(sug.id) >= 0) {
                planState.ids = planState.ids.filter(function (c) { return c !== sug.id; });
                commitPlan();
                drawChips();
              } else if (totalSelected() < maxSel) {
                planState.ids.push(sug.id);
                commitPlan();
                drawChips();
              } else {
                updatePlanMeta(true);
              }
            });
          }
          chips.appendChild(btn);
        });
        planState.custom.forEach(function (customItem) {
          var cbtn = el('button', 'xped-plan-chip is-selected');
          cbtn.type = 'button';
          cbtn.setAttribute('aria-pressed', 'true');
          if (Icons) cbtn.appendChild(Icons.icon('check', 14));
          cbtn.appendChild(document.createTextNode(customItem));
          if (interactive) {
            cbtn.addEventListener('click', function () {
              planState.custom = planState.custom.filter(function (c) { return c !== customItem; });
              commitPlan();
              drawChips();
            });
          }
          chips.appendChild(cbtn);
        });
        updatePlanMeta(false);
      }
      drawChips();
      wrap.appendChild(planCount);
      wrap.appendChild(chips);
      if (data.allowCustom !== false) {
        var customRow = el('div', 'xped-input-actions');
        var cinp = document.createElement('input');
        cinp.type = 'text';
        cinp.className = 'xped-input';
        cinp.placeholder = Model.ui(lang, 'customGoalPlaceholder');
        cinp.setAttribute('aria-label', cinp.placeholder);
        var cadd = el('button', 'xped-btn xped-btn-secondary', Model.ui(lang, 'addGoal'));
        cadd.type = 'button';
        cinp.disabled = cadd.disabled = !interactive;
        function addCustomGoal() {
          var v = cinp.value.trim();
          if (!v) return;
          if (totalSelected() >= maxSel) {
            updatePlanMeta(true);
            return;
          }
          if (planState.custom.indexOf(v) < 0) planState.custom.push(v);
          cinp.value = '';
          commitPlan();
          drawChips();
        }
        cadd.addEventListener('click', addCustomGoal);
        cinp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addCustomGoal(); } });
        customRow.appendChild(cinp);
        customRow.appendChild(cadd);
        wrap.appendChild(customRow);
      }
      return wrap;
    }

    if (block.type === 'custom_visual') {
      // Placeholder briefs belong to the authoring canvas.
      if (!editable && !['alarm-dial', 'breathing-circle', 'percentage'].includes(data.preset)
          && !(data.preset === 'custom-svg' && data.svgMarkup)) {
        return document.createDocumentFragment();
      }
      var cvt = Model.getLocalized(data.title, lang, defLang);
      if (cvt || editable) {
        var cvh = styledField('title', 'h3', 'xped-question-text', cvt);
        field(cvh, data.title);
        makeEditable(cvh, uiText('Visual / animation title…'), editable, function (v) { onEdit(block, 'title', v); });
        wrap.appendChild(cvh);
      }

      var preset = data.preset || 'placeholder';
      var heightCls = 'height-' + (data.height || 'medium');
      var cvStage = el('div', 'xped-visual-stage ' + heightCls);

      if (preset === 'percentage') {
        var value = Math.min(100, Math.max(0, Number(data.percentage ?? 50)));
        cvStage.className = 'xped-chart';
        var label = el('strong', 'xped-chart-number', new Intl.NumberFormat(lang, { style: 'percent', maximumFractionDigits: 2 }).format(value / 100));
        var bar = el('progress', 'xped-summary-bar');
        bar.max = 100;
        bar.value = value;
        bar.setAttribute('aria-label', Model.getLocalized(data.alt, lang, defLang) || cvt);
        cvStage.append(label, bar);
      } else if (preset === 'alarm-dial') {
        var nsA = 'http://www.w3.org/2000/svg';
        var sA = function (tag, attrs) {
          var n = document.createElementNS(nsA, tag);
          Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
          return n;
        };
        var svgA = sA('svg', { viewBox: '0 0 360 180', class: 'xped-preset-svg', role: 'img', 'aria-label': Model.getLocalized(data.alt, lang, defLang) || uiText('Alarm sensitivity dial') });
        svgA.appendChild(sA('path', { d: 'M 70 148 A 110 110 0 0 1 290 148', fill: 'none', stroke: 'rgba(255,255,255,0.16)', 'stroke-width': 18, 'stroke-linecap': 'round' }));
        svgA.appendChild(sA('path', { d: 'M 70 148 A 110 110 0 0 1 180 38', fill: 'none', stroke: '#1fe4a9', 'stroke-width': 18, 'stroke-linecap': 'round' }));
        svgA.appendChild(sA('path', { d: 'M 180 38 A 110 110 0 0 1 258 70', fill: 'none', stroke: '#ffd617', 'stroke-width': 18, 'stroke-linecap': 'round' }));
        svgA.appendChild(sA('path', { d: 'M 258 70 A 110 110 0 0 1 290 148', fill: 'none', stroke: '#f27874', 'stroke-width': 18, 'stroke-linecap': 'round' }));
        var needle = sA('g', { class: 'xped-alarm-needle' });
        needle.appendChild(sA('line', { x1: 180, y1: 148, x2: 180, y2: 60, stroke: '#ffffff', 'stroke-width': 5, 'stroke-linecap': 'round' }));
        needle.appendChild(sA('circle', { cx: 180, cy: 148, r: 11, fill: '#ffd617', stroke: '#062940', 'stroke-width': 3 }));
        svgA.appendChild(needle);
        cvStage.classList.add('is-navy');
        cvStage.appendChild(svgA);
      } else if (preset === 'breathing-circle') {
        var nsB = 'http://www.w3.org/2000/svg';
        var sB = function (tag, attrs) {
          var n = document.createElementNS(nsB, tag);
          Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
          return n;
        };
        var svgB = sB('svg', { viewBox: '0 0 220 220', class: 'xped-preset-svg', role: 'img', 'aria-label': Model.getLocalized(data.alt, lang, defLang) || uiText('Guided calm breathing circle') });
        svgB.appendChild(sB('circle', { cx: 110, cy: 110, r: 86, fill: 'none', stroke: 'rgba(255,255,255,0.16)', 'stroke-width': 2 }));
        svgB.appendChild(sB('circle', { cx: 110, cy: 110, r: 58, fill: 'rgba(31,228,169,0.22)', class: 'xped-breath-outer' }));
        svgB.appendChild(sB('circle', { cx: 110, cy: 110, r: 34, fill: '#1fe4a9', class: 'xped-breath-inner' }));
        cvStage.classList.add('is-navy');
        cvStage.appendChild(svgB);
      } else if (preset === 'custom-svg' && data.svgMarkup) {
        var illustration = el('img', 'xped-custom-svg-art');
        illustration.alt = Model.getLocalized(data.alt, lang, defLang) || cvt || '';
        illustration.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(data.svgMarkup);
        cvStage.appendChild(illustration);
      } else {
        cvStage.classList.add('is-blueprint');
        var bpTop = el('div', 'xped-bp-head');
        var tag = el('span', 'xped-bp-tag');
        if (Icons) tag.appendChild(Icons.icon('wand', 14));
        tag.appendChild(document.createTextNode(uiText('Custom SVG / Animation Slot · #') + (data.slotId || block.id)));
        bpTop.appendChild(tag);
        if (editable) {
          var cpWrap = el('span', 'el-copy-wrap');
          var cpBtn = el('button', 'el-btn el-btn-sm el-copy-btn');
          cpBtn.type = 'button';
          if (Icons) cpBtn.appendChild(Icons.icon('copy', 13));
          cpBtn.appendChild(document.createTextNode(uiText('Copy Agent Brief')));
          var cpStatus = el('span', 'el-copy-tip');
          cpStatus.setAttribute('role', 'status');
          var fallbackWrap = el('div', 'xped-bp-copy-fallback');
          fallbackWrap.hidden = true;
          cpBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var promptText = 'Build an accessible, prefers-reduced-motion-safe SVG animation for xPEDitie Pijn slot #'
              + (data.slotId || block.id) + ' (height: ' + (data.height || 'medium') + ').\n'
              + 'Brand colors: Navy #062940, Blue #007ACC, Mint #1FE4A9, Yellow #FFD617, Warm Sand #F6F1E9.\n'
              + 'Brief: ' + (data.agentBrief || 'Calm pain education visual.');
            function showFallback() {
              cpBtn.removeAttribute('data-copied');
              cpBtn.setAttribute('data-failed', '');
              cpStatus.textContent = uiText('Clipboard blocked — copy manually below');
              fallbackWrap.textContent = '';
              var fbTa = el('textarea', 'xped-textarea');
              fbTa.rows = 4;
              fbTa.readOnly = true;
              fbTa.value = promptText;
              fbTa.setAttribute('aria-label', uiText('Agent brief text to copy'));
              fbTa.addEventListener('click', function (ev) { ev.stopPropagation(); fbTa.select(); });
              var closeFb = el('button', 'el-btn el-btn-sm', 'Hide');
              closeFb.type = 'button';
              closeFb.addEventListener('click', function (ev) { ev.stopPropagation(); fallbackWrap.hidden = true; });
              fallbackWrap.append(el('p', 'xped-caption', 'Select and press Cmd/Ctrl+C to copy this brief:'), fbTa, closeFb);
              fallbackWrap.hidden = false;
              fbTa.focus();
              fbTa.select();
            }
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(promptText).then(function () {
                fallbackWrap.hidden = true;
                cpBtn.removeAttribute('data-failed');
                cpBtn.setAttribute('data-copied', '');
                cpStatus.textContent = uiText('Brief copied');
                setTimeout(function () {
                  cpBtn.removeAttribute('data-copied');
                  cpStatus.textContent = '';
                }, 2200);
              }).catch(showFallback);
            } else {
              showFallback();
            }
          });
          cpWrap.append(cpBtn, cpStatus);
          bpTop.appendChild(cpWrap);
        }
        cvStage.appendChild(bpTop);
        if (editable && fallbackWrap) cvStage.appendChild(fallbackWrap);
        var briefP = el('p', 'xped-bp-brief', data.agentBrief || uiText('Describe the SVG or animation you want a coding agent to create here later…'));
        if (editable) {
          field(briefP, data.agentBrief);
          makeEditable(briefP, uiText('Describe the SVG or animation for a coding agent…'), true, function (v) { onEdit(block, 'agentBrief', v); });
        }
        cvStage.appendChild(briefP);
        if (editable) {
          cvStage.appendChild(el('span', 'xped-bp-foot', uiText('Pick a built-in animation preset or paste finished SVG code in Settings →')));
        }
      }

      wrap.appendChild(cvStage);
      var cvCap = Model.getLocalized(data.caption, lang, defLang);
      if (cvCap || editable) {
        var cvCapEl = styledField('caption', 'p', 'xped-caption', cvCap);
        field(cvCapEl, data.caption);
        makeEditable(cvCapEl, uiText('Optional visual caption…'), editable, function (v) { onEdit(block, 'caption', v); });
        wrap.appendChild(cvCapEl);
      }
      if (preset === 'percentage') {
        var citationText = Model.getLocalized(data.citation, lang, defLang);
        var source = Model.normalizeCitationLink(data.sourceUrl);
        if (citationText || source.url) {
          var credit = el(source.url ? 'a' : 'p', 'xped-caption', citationText || source.label);
          if (source.url) { credit.href = source.url; credit.target = '_blank'; credit.rel = 'noopener noreferrer'; }
          wrap.appendChild(credit);
        }
      }
      return wrap;
    }

    return wrap;
  }

  root.XpedElearningBlocks = {
    renderBlock: renderBlock,
    pinMarker: pinMarker,
    colorSwatch: colorSwatch,
    createDropzone: createDropzone,
  };
})(typeof window !== 'undefined' ? window : globalThis);
