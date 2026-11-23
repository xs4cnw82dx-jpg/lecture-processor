(function (root) {
  'use strict';

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

  // Create only integer percentage rules on the course's first-party stylesheet.
  var focalRules = new WeakMap();
  function setImageFocal(img, x, y) {
    var sheet = document.querySelector('link[href*="/css/xped-theme.css"]')?.sheet;
    if (!sheet) return;
    var rules = focalRules.get(sheet) || new Set();
    focalRules.set(sheet, rules);
    [x, y].forEach(function (value, i) {
      var axis = i ? 'y' : 'x';
      var percent = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : 50;
      var name = 'xped-focal-' + axis + '-' + percent;
      if (!rules.has(name)) {
        sheet.insertRule('.' + name + '{--xped-focal-' + axis + ':' + percent + '%}', sheet.cssRules.length);
        rules.add(name);
      }
      img.classList.add(name);
    });
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
      box.appendChild(el('p', 'xped-caption', 'Average: ' + (agg.average !== null ? agg.average : '—')));
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
    var svg = sEl('svg', { viewBox: '0 0 360 144', class: 'xped-balance-svg', role: 'img', 'aria-label': 'Balance scale visual' });
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

  function appendInlineTokens(parent, line) {
    // Safe DOM parser for **bold** and [label](https://...) with zero innerHTML
    var regex = /\*\*([^*]+)\*\*|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    var last = 0;
    var m;
    while ((m = regex.exec(line)) !== null) {
      if (m.index > last) parent.appendChild(document.createTextNode(line.slice(last, m.index)));
      if (m[1]) {
        parent.appendChild(el('strong', '', m[1]));
      } else if (m[2] && m[3]) {
        var a = document.createElement('a');
        a.href = m[3];
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.textContent = m[2];
        parent.appendChild(a);
      }
      last = regex.lastIndex;
    }
    if (last < line.length) parent.appendChild(document.createTextNode(line.slice(last)));
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
      rTag.appendChild(document.createTextNode('Reveals after learner answers'));
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
        var hEl = el('h2', 'xped-question-text', h);
        field(hEl, data.heading);
        makeEditable(hEl, 'Optional section heading…', editable, function (v) { onEdit(block, 'heading', v); }, notifyFocus);
        wrap.appendChild(hEl);
      }
      if (editable) {
        var fmtBar = el('div', 'el-fmt-bar');
        fmtBar.setAttribute('role', 'toolbar');
        fmtBar.setAttribute('aria-label', 'Text formatting');
        var linkBox = el('div', 'el-fmt-link-popover');
        linkBox.hidden = true;
        var rtTa = document.createElement('textarea');
        rtTa.className = 'xped-richtext-editor';
        rtTa.rows = Math.max(3, Math.min(12, String(b || '').split('\n').length + 1));
        rtTa.value = b || '';
        rtTa.setAttribute('aria-label', 'Paragraph text');
        rtTa.placeholder = 'Write calm, clear explanation text…';
        rtTa.addEventListener('click', function (e) { e.stopPropagation(); notifyFocus(); });
        rtTa.addEventListener('input', function () {
          rtTa.rows = Math.max(3, Math.min(12, rtTa.value.split('\n').length + 1));
          onEdit(block, 'body', rtTa.value);
        });

        function replaceRange(start, end, replacement, selStartOffset, selEndOffset) {
          rtTa.focus();
          rtTa.setSelectionRange(start, end);
          // Using the editing command keeps the replacement in the native textarea undo stack.
          if (!document.execCommand('insertText', false, replacement)) rtTa.setRangeText(replacement, start, end);
          rtTa.rows = Math.max(3, Math.min(12, rtTa.value.split('\n').length + 1));
          rtTa.focus();
          rtTa.setSelectionRange(start + selStartOffset, start + selEndOffset);
          onEdit(block, 'body', rtTa.value);
        }

        function toggleBold() {
          var s = rtTa.selectionStart || 0;
          var e = rtTa.selectionEnd || 0;
          var sel = rtTa.value.slice(s, e);
          if (sel) {
            if (rtTa.value.slice(Math.max(0, s - 2), s) === '**' && rtTa.value.slice(e, e + 2) === '**') {
              replaceRange(s - 2, e + 2, sel, 0, sel.length);
            } else if (sel.indexOf('**') === 0 && sel.lastIndexOf('**') === sel.length - 2 && sel.length >= 4) {
              var unwrapped = sel.slice(2, -2);
              replaceRange(s, e, unwrapped, 0, unwrapped.length);
            } else {
              replaceRange(s, e, '**' + sel + '**', 2, 2 + sel.length);
            }
          } else {
            var phText = 'key point';
            replaceRange(s, e, '**' + phText + '**', 2, 2 + phText.length);
          }
        }

        function transformSelectedLines(mode) {
          var val = rtTa.value;
          var s = rtTa.selectionStart || 0;
          var e = rtTa.selectionEnd || 0;
          var lineStart = val.lastIndexOf('\n', Math.max(0, s - 1)) + 1;
          var lineEndIdx = val.indexOf('\n', e > s && val[e - 1] === '\n' ? e - 1 : e);
          var lineEnd = lineEndIdx < 0 ? val.length : lineEndIdx;
          var blockText = val.slice(lineStart, lineEnd);
          var lines = blockText.split('\n');
          var allMatch = false;
          if (mode === 'ul') allMatch = lines.every(function (l) { return !l.trim() || /^[-•*]\s+/.test(l); });
          else if (mode === 'ol') allMatch = lines.every(function (l) { return !l.trim() || /^\d+[.)]\s+/.test(l); });
          else if (mode === 'h2') allMatch = lines.every(function (l) { return !l.trim() || /^##\s+/.test(l); });
          else if (mode === 'h3') allMatch = lines.every(function (l) { return !l.trim() || /^###\s+/.test(l); });

          var numCounter = 1;
          var nextLines = lines.map(function (l) {
            var stripped = l.replace(/^(?:###?\s+|[-•*]\s+|\d+[.)]\s+)/, '');
            if (mode === 'p' || allMatch) return stripped;
            if (!stripped.trim()) {
              if (mode === 'ul') return '- ';
              if (mode === 'ol') return (numCounter++) + '. ';
              if (mode === 'h2') return '## ';
              if (mode === 'h3') return '### ';
              return '';
            }
            if (mode === 'ul') return '- ' + stripped;
            if (mode === 'ol') return (numCounter++) + '. ' + stripped;
            if (mode === 'h2') return '## ' + stripped;
            if (mode === 'h3') return '### ' + stripped;
            return stripped;
          });
          var joined = nextLines.join('\n');
          replaceRange(lineStart, lineEnd, joined, 0, joined.length);
        }

        // Inline Link Editor (UX-028: never inserts example.org)
        var linkRange = { s: 0, e: 0 };
        var linkTextInp = el('input', 'xped-input el-fmt-link-inp');
        linkTextInp.type = 'text';
        linkTextInp.placeholder = 'Link text (e.g. Read guideline)';
        linkTextInp.setAttribute('aria-label', 'Link text');
        var linkUrlInp = el('input', 'xped-input el-fmt-link-inp');
        linkUrlInp.type = 'url';
        linkUrlInp.placeholder = 'https://… or DOI 10.xxxx/…';
        linkUrlInp.setAttribute('aria-label', 'Link URL');
        var linkErr = el('span', 'el-fmt-link-err');
        linkErr.setAttribute('role', 'alert');
        var linkApply = el('button', 'el-btn el-btn-primary el-btn-sm', 'Insert link');
        linkApply.type = 'button';
        var linkCancel = el('button', 'el-btn el-btn-sm', 'Cancel');
        linkCancel.type = 'button';

        function closeLinkBox(restoreFocus) {
          linkBox.hidden = true;
          linkErr.textContent = '';
          if (restoreFocus) {
            rtTa.focus();
            rtTa.setSelectionRange(linkRange.s, linkRange.e);
          }
        }
        linkApply.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var norm = Model.normalizeCitationLink(linkUrlInp.value);
          if (!norm.url) {
            linkErr.textContent = 'Enter a valid https:// URL or DOI.';
            linkUrlInp.focus();
            return;
          }
          var label = linkTextInp.value.trim() || norm.label || norm.host;
          var md = '[' + label + '](' + norm.url + ')';
          linkBox.hidden = true;
          linkErr.textContent = '';
          replaceRange(linkRange.s, linkRange.e, md, 0, md.length);
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
          { label: 'P', title: 'Paragraph (clear heading/list)', fn: function () { transformSelectedLines('p'); } },
          { label: 'H2', title: 'Section heading', fn: function () { transformSelectedLines('h2'); } },
          { label: 'H3', title: 'Subheading', fn: function () { transformSelectedLines('h3'); } },
          { ico: 'bold', title: 'Bold text', fn: toggleBold },
          { ico: 'list', title: 'Bullet list (toggle selected lines)', fn: function () { transformSelectedLines('ul'); } },
          { label: '1.', title: 'Numbered list (toggle selected lines)', fn: function () { transformSelectedLines('ol'); } },
          { ico: 'link', title: 'Insert link', fn: function () {
            linkRange = { s: rtTa.selectionStart || 0, e: rtTa.selectionEnd || 0 };
            linkTextInp.value = rtTa.value.slice(linkRange.s, linkRange.e).trim();
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
          tb.addEventListener('click', function (ev) { ev.stopPropagation(); notifyFocus(); tool.fn(); });
          fmtBar.appendChild(tb);
        });
        wrap.appendChild(fmtBar);
        wrap.appendChild(linkBox);
        wrap.appendChild(rtTa);
        var formatted = el('div', 'xped-richtext-sample');
        formatted.hidden = true;
        var sample = el('button', 'el-fmt-btn el-fmt-read', 'Read');
        sample.type = 'button';
        sample.setAttribute('aria-label', 'Preview formatted text');
        sample.setAttribute('aria-pressed', 'false');
        sample.addEventListener('click', function () {
          formatted.hidden = !formatted.hidden;
          rtTa.hidden = !formatted.hidden;
          sample.setAttribute('aria-pressed', String(!formatted.hidden));
          sample.textContent = formatted.hidden ? 'Read' : 'Edit';
          sample.setAttribute('aria-label', formatted.hidden ? 'Preview formatted text' : 'Edit paragraph text');
          formatted.replaceChildren(renderFormattedBody(rtTa.value));
          Array.from(fmtBar.children).forEach(function (tool) { if (tool !== sample) tool.disabled = !formatted.hidden; });
          if (formatted.hidden) rtTa.focus();
        });
        fmtBar.appendChild(sample);
        wrap.appendChild(formatted);
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
        var vth = el('h3', 'xped-question-text', vt);
        field(vth, data.title);
        makeEditable(vth, 'Optional video title…', editable, function (v) { onEdit(block, 'title', v); }, notifyFocus);
        wrap.appendChild(vth);
      }
      if (embedSrc) {
        var frame = el('div', 'xped-video-frame');
        var iframe = document.createElement('iframe');
        iframe.src = embedSrc;
        iframe.title = vt || 'Educational video';
        iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
        iframe.allowFullscreen = true;
        iframe.loading = 'lazy';
        frame.appendChild(iframe);
        wrap.appendChild(frame);
      } else {
        var ph = el('div', 'el-dropzone el-video-dropzone');
        if (Icons) ph.appendChild(Icons.icon('video', 24));
        ph.appendChild(el('strong', '', 'Add a YouTube or Vimeo Video'));
        ph.appendChild(el('span', '', 'Paste any video link below (timestamps like ?t=1m20s are detected automatically).'));
        var vRow = el('div', 'el-video-inline-row');
        var vInp = document.createElement('input');
        vInp.type = 'url';
        vInp.className = 'xped-input';
        vInp.placeholder = 'https://www.youtube.com/watch?v=…';
        vInp.setAttribute('aria-label', 'Video URL');
        vInp.addEventListener('click', function (e) { e.stopPropagation(); notifyFocus(); });
        var vBtn = el('button', 'el-btn el-btn-primary el-btn-sm', 'Embed Video');
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
        var capEl = el('p', 'xped-caption', cap);
        field(capEl, data.caption);
        makeEditable(capEl, 'Optional caption…', editable, function (v) { onEdit(block, 'caption', v); }, notifyFocus);
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
          'Drop an image here or click to upload',
          'PNG, JPG or WebP — or pick an official xPED illustration on the right',
          'image/png,image/jpeg,image/webp',
          onUploadFile ? function (file) { onUploadFile(block, file); } : null
        ));
      } else {
        return document.createDocumentFragment();
      }
      var icap = Model.getLocalized(data.caption, lang, defLang);
      if (icap || editable) {
        var fcap = el('figcaption', 'xped-caption', icap);
        field(fcap, data.caption);
        makeEditable(fcap, 'Optional image caption…', editable, function (v) { onEdit(block, 'caption', v); }, notifyFocus);
        fig.appendChild(fcap);
      }
      imgWrap.appendChild(fig);
      if (layout === 'split-left' || layout === 'split-right' || data.sideTextBelow) {
        var side = el('div');
        var sh = Model.getLocalized(data.sideHeading, lang, defLang);
        var sb = Model.getLocalized(data.sideBody, lang, defLang);
        if (sh || editable) {
          var shEl = el('h3', 'xped-question-text', sh);
          field(shEl, data.sideHeading);
          makeEditable(shEl, 'Heading…', editable, function (v) { onEdit(block, 'sideHeading', v); }, notifyFocus);
          side.appendChild(shEl);
        }
        var sbEl = el('p', 'xped-richtext-body', sb);
        field(sbEl, data.sideBody);
        makeEditable(sbEl, 'Supporting explanation beside this visual…', editable, function (v) { onEdit(block, 'sideBody', v); }, notifyFocus);
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
      var at = el('h3', 'xped-question-text', Model.getLocalized(data.title, lang, defLang));
      field(at, data.title);
      makeEditable(at, 'Audio exercise title…', editable, function (v) { onEdit(block, 'title', v); });
      if (editable || at.textContent.trim()) card.appendChild(at);
      var desc = Model.getLocalized(data.description, lang, defLang);
      if (desc || editable) {
        var ad = el('p', 'xped-caption', desc);
        field(ad, data.description);
        makeEditable(ad, 'Short instruction for the learner…', editable, function (v) { onEdit(block, 'description', v); });
        card.appendChild(ad);
      }
      if (aUrl) {
        var audio = document.createElement('audio');
        audio.controls = true;
        setMediaSource(audio, aUrl);
        card.appendChild(audio);
      } else if (editable) {
        card.appendChild(createDropzone(
          'Drop an audio clip here or click to upload',
          'MP3, M4A or OGG (up to 15 MB)',
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
      var ct = el('h3', 'xped-callout-title', Model.getLocalized(data.title, lang, defLang));
      field(ct, data.title);
      makeEditable(ct, 'Key takeaway title…', editable, function (v) { onEdit(block, 'title', v); });
      var cb = el('p', '', Model.getLocalized(data.body, lang, defLang));
      field(cb, data.body);
      makeEditable(cb, 'Write a concise takeaway message…', editable, function (v) { onEdit(block, 'body', v); });
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
        var av = document.createElement('img');
        av.className = 'xped-story-avatar';
        setMediaSource(av, sUrl);
        av.alt = data.speakerName || 'Speaker';
        sc.appendChild(av);
      }
      var bodyCol = el('div');
      var bq = el('blockquote', 'xped-story-quote', Model.getLocalized(data.quote, lang, defLang));
      field(bq, data.quote);
      makeEditable(bq, 'Click to write a real patient or clinician quote…', editable, function (v) { onEdit(block, 'quote', v); });
      bodyCol.appendChild(bq);
      var meta = el('div', 'xped-story-meta');
      var spName = el('strong', '', data.speakerName || (editable ? '' : 'Naam'));
      field(spName, data.speakerName);
      makeEditable(spName, 'Speaker name', editable, function (v) { onEdit(block, 'speakerName', v); });
      meta.appendChild(spName);
      var role = Model.getLocalized(data.speakerRole, lang, defLang);
      if (role || editable) {
        meta.appendChild(document.createTextNode(' · '));
        var roleEl = el('span', '', role);
        field(roleEl, data.speakerRole);
        makeEditable(roleEl, 'Role (e.g. Ervaringsverhaal)', editable, function (v) { onEdit(block, 'speakerRole', v); });
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
        makeEditable(citation, 'Add a scientific reference…', editable, function (v) { onEdit(block, 'citation:' + item.id, v); }, notifyFocus);
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
      shell.appendChild(sdet);
      wrap.appendChild(shell);
      return wrap;
    }

    if (block.type === 'mcq') {
      var qh = el('h3', 'xped-question-text', Model.getLocalized(data.question, lang, defLang));
      field(qh, data.question);
      makeEditable(qh, 'Click to write your question…', editable, function (v) { onEdit(block, 'question', v); }, notifyFocus);
      if (editable || qh.textContent.trim()) wrap.appendChild(qh);
      var sub = Model.getLocalized(data.subtitle, lang, defLang);
      if (sub || editable) {
        var subEl = el('p', 'xped-caption', sub);
        field(subEl, data.subtitle);
        makeEditable(subEl, 'Optional helper subtitle…', editable, function (v) { onEdit(block, 'subtitle', v); }, notifyFocus);
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
              if (Icons) badge.appendChild(Icons.icon('check', 14));
              else badge.textContent = '✓';
            }
            if (showGrade && o.isCorrect) {
              child.appendChild(el('span', 'xped-option-key', Model.ui(lang, 'correctChoice')));
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
          makeEditable(lblSpan, 'Option ' + (idx + 1), true, function (v) { onEdit(block, 'option:' + opt.id, v); }, notifyFocus);
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
        var addOptBtn = el('button', 'el-quiet-add-step', '+ Add option');
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
      var stEl = el('h3', 'xped-question-text', Model.getLocalized(data.statement, lang, defLang));
      field(stEl, data.statement);
      makeEditable(stEl, 'Click to write a common pain belief statement…', editable, function (v) { onEdit(block, 'statement', v); }, notifyFocus);
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
      var sq = el('h3', 'xped-question-text', Model.getLocalized(data.question, lang, defLang));
      field(sq, data.question);
      makeEditable(sq, 'Click to write your scale prompt…', editable, function (v) { onEdit(block, 'question', v); }, notifyFocus);
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
      var rp = el('h3', 'xped-question-text', Model.getLocalized(data.prompt, lang, defLang));
      field(rp, data.prompt);
      makeEditable(rp, 'Click to write your reflection prompt…', editable, function (v) { onEdit(block, 'prompt', v); });
      if (editable || rp.textContent.trim()) wrap.appendChild(rp);
      var reflectionNote = el('p', 'xped-caption', Model.ui(lang, 'reflectionAccess'));
      reflectionNote.id = 'reflection-access-' + instanceId;
      wrap.appendChild(reflectionNote);
      var ta = document.createElement('textarea');
      ta.className = 'xped-textarea';
      ta.rows = 4;
      labelControl(ta, rp);
      ta.setAttribute('aria-describedby', reflectionNote.id);
      field(ta, data.placeholder);
      ta.placeholder = Model.getLocalized(data.placeholder, lang, defLang);
      ta.value = String(answers[block.id] || '');
      ta.readOnly = !interactive;
      if (interactive) ta.addEventListener('input', function () { onAnswer(block.id, ta.value); });
      wrap.appendChild(ta);
      return wrap;
    }

    if (block.type === 'wordcloud') {
      var wq = el('h3', 'xped-question-text', Model.getLocalized(data.question, lang, defLang));
      field(wq, data.question);
      makeEditable(wq, 'Click to write your word cloud question…', editable, function (v) { onEdit(block, 'question', v); }, notifyFocus);
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
      var rq = el('h3', 'xped-question-text', Model.getLocalized(data.question, lang, defLang));
      field(rq, data.question);
      makeEditable(rq, 'Click to write your ranking prompt…', editable, function (v) { onEdit(block, 'question', v); }, notifyFocus);
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
      var ht = el('h3', 'xped-question-text', Model.getLocalized(data.title, lang, defLang));
      field(ht, data.title);
      makeEditable(ht, 'Interactive visual title…', editable, function (v) { onEdit(block, 'title', v); }, notifyFocus);
      if (editable || ht.textContent.trim()) wrap.appendChild(ht);
      var inst = Model.getLocalized(data.instruction, lang, defLang);
      if (inst || editable) {
        wrap.appendChild(field(el('p', 'xped-caption', editable ? 'Tip: click the image to add a pin, or drag any pin to reposition it.' : inst), data.instruction));
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
        makeEditable(pinTitle, 'Name this point…', editable, function (v) {
          onEdit(block, 'pinLabel:' + pin.id, v);
          var chipLabel = fbBar.querySelector('[data-pin-id="' + CSS.escape(pin.id) + '"] .xped-pin-label');
          if (chipLabel) chipLabel.textContent = v;
        }, notifyFocus);
        makeEditable(pinBody, 'Explain this point…', editable, function (v) { onEdit(block, 'pinDetail:' + pin.id, v); }, notifyFocus);
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
        chip.append(document.createTextNode((idx + 1) + '. '), field(el('span', 'xped-pin-label', Model.getLocalized(pin.label, lang, defLang) || 'Point'), pin.label));
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
        var bth = el('h3', 'xped-question-text', bTitle);
        field(bth, data.title);
        makeEditable(bth, 'Optional balance scale subtitle…', editable, function (v) { onEdit(block, 'title', v); });
        wrap.appendChild(bth);
      }
      var bintro = Model.getLocalized(data.intro, lang, defLang);
      if (bintro || editable) {
        var bi = el('p', 'xped-caption', bintro);
        field(bi, data.intro);
        makeEditable(bi, 'Short friendly instruction…', editable, function (v) { onEdit(block, 'intro', v); });
        wrap.appendChild(bi);
      }
      var factors = data.factors || [];
      var vals = (answers[block.id] && typeof answers[block.id] === 'object') ? Object.assign({}, answers[block.id]) : {};
      factors.forEach(function (f) { if (vals[f.id] === undefined) vals[f.id] = 1; });

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
        statusEl.textContent = (statusMap[lang] || statusMap.nl) + ' · ' + loadT + ' vs ' + resT;
        svgSlot.textContent = '';
        var svgNode = renderBalanceSvg(loadT, resT);
        if (interactive && !interacted) svgNode.classList.add('is-cue-sway');
        svgSlot.appendChild(svgNode);
        tipWrap.textContent = '';
        var tipText = loadT > resT
          ? Model.getLocalized(data.overloadTip, lang, defLang)
          : Model.getLocalized(data.balancedTip, lang, defLang);
        if (tipText) tipWrap.appendChild(field(el('div', 'xped-feedback-box ' + (loadT > resT ? 'is-gentle' : 'is-correct'), tipText), loadT > resT ? data.overloadTip : data.balancedTip));
      }

      var cols = el('div', 'xped-balance-cols');
      var loadCol = el('div', 'xped-balance-col is-load');
      loadCol.appendChild(field(el('div', 'xped-balance-col-head', Model.getLocalized(data.loadLabel, lang, defLang) || Model.ui(lang, 'load')), data.loadLabel));
      var resCol = el('div', 'xped-balance-col is-resource');
      resCol.appendChild(field(el('div', 'xped-balance-col-head', Model.getLocalized(data.resourceLabel, lang, defLang) || Model.ui(lang, 'resource')), data.resourceLabel));

      factors.forEach(function (f) {
        var fWrap = el('div', 'xped-balance-factor');
        var flab = document.createElement('label');
        var vSpan = el('span', '', String(vals[f.id]) + '/3');
        flab.appendChild(field(el('span', '', Model.getLocalized(f.label, lang, defLang)), f.label));
        flab.appendChild(vSpan);
        var rng = document.createElement('input');
        rng.type = 'range';
        rng.className = 'xped-range ' + (f.category === 'resource' ? 'is-resource' : 'is-load');
        rng.min = '0';
        rng.max = '3';
        rng.value = String(vals[f.id]);
        rng.disabled = !interactive;
        if (interactive) {
          rng.addEventListener('input', function () {
            interacted = true;
            vals[f.id] = Number(rng.value);
            vSpan.textContent = rng.value + '/3';
            onAnswer(block.id, Object.assign({}, vals));
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
      var bpt = el('h3', 'xped-question-text', Model.getLocalized(data.title, lang, defLang));
      field(bpt, data.title);
      makeEditable(bpt, 'Biopsychosocial heading…', editable, function (v) { onEdit(block, 'title', v); });
      if (editable || bpt.textContent.trim()) wrap.appendChild(bpt);
      var tintro = Model.getLocalized(data.intro, lang, defLang);
      if (tintro) wrap.appendChild(field(el('p', 'xped-caption', tintro), data.intro));
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
        field(panel, data[key + 'Body']);
        panel.textContent = (item && item.body) || (editable ? 'Add an explanation in properties.' : '');
      }
      defs.forEach(function (d) {
        var tb = field(el('button', 'xped-bps-tab', d.title), data[d.key + 'Title']);
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
      var mpt = el('h3', 'xped-question-text', Model.getLocalized(data.title, lang, defLang));
      field(mpt, data.title);
      makeEditable(mpt, 'Mini-plan heading…', editable, function (v) { onEdit(block, 'title', v); }, notifyFocus);
      if (editable || mpt.textContent.trim()) wrap.appendChild(mpt);
      var mintro = Model.getLocalized(data.intro, lang, defLang);
      if (mintro) wrap.appendChild(field(el('p', 'xped-caption', mintro), data.intro));
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
      if (data.allowCustom && interactive) {
        var customRow = el('div', 'xped-input-actions');
        var cinp = document.createElement('input');
        cinp.type = 'text';
        cinp.className = 'xped-input';
        cinp.placeholder = Model.ui(lang, 'customGoalPlaceholder');
        cinp.setAttribute('aria-label', cinp.placeholder);
        var cadd = el('button', 'xped-btn xped-btn-secondary', Model.ui(lang, 'addGoal'));
        cadd.type = 'button';
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
      if (!editable && !['alarm-dial', 'breathing-circle'].includes(data.preset)
          && !(data.preset === 'custom-svg' && data.svgMarkup)) {
        return document.createDocumentFragment();
      }
      var cvt = Model.getLocalized(data.title, lang, defLang);
      if (cvt || editable) {
        var cvh = el('h3', 'xped-question-text', cvt);
        field(cvh, data.title);
        makeEditable(cvh, 'Visual / animation title…', editable, function (v) { onEdit(block, 'title', v); });
        wrap.appendChild(cvh);
      }

      var preset = data.preset || 'placeholder';
      var heightCls = 'height-' + (data.height || 'medium');
      var cvStage = el('div', 'xped-visual-stage ' + heightCls);

      if (preset === 'alarm-dial') {
        var nsA = 'http://www.w3.org/2000/svg';
        var sA = function (tag, attrs) {
          var n = document.createElementNS(nsA, tag);
          Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, String(attrs[k])); });
          return n;
        };
        var svgA = sA('svg', { viewBox: '0 0 360 180', class: 'xped-preset-svg', role: 'img', 'aria-label': Model.getLocalized(data.alt, lang, defLang) || 'Alarm sensitivity dial' });
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
        var svgB = sB('svg', { viewBox: '0 0 220 220', class: 'xped-preset-svg', role: 'img', 'aria-label': Model.getLocalized(data.alt, lang, defLang) || 'Guided calm breathing circle' });
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
        tag.appendChild(document.createTextNode('Custom SVG / Animation Slot · #' + (data.slotId || block.id)));
        bpTop.appendChild(tag);
        if (editable) {
          var cpWrap = el('span', 'el-copy-wrap');
          var cpBtn = el('button', 'el-btn el-btn-sm el-copy-btn');
          cpBtn.type = 'button';
          if (Icons) cpBtn.appendChild(Icons.icon('copy', 13));
          cpBtn.appendChild(document.createTextNode('Copy Agent Brief'));
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
              cpStatus.textContent = 'Clipboard blocked — copy manually below';
              fallbackWrap.textContent = '';
              var fbTa = el('textarea', 'xped-textarea');
              fbTa.rows = 4;
              fbTa.readOnly = true;
              fbTa.value = promptText;
              fbTa.setAttribute('aria-label', 'Agent brief text to copy');
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
                cpStatus.textContent = 'Brief copied';
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
        var briefP = el('p', 'xped-bp-brief', data.agentBrief || 'Describe the SVG or animation you want a coding agent to create here later…');
        if (editable) {
          field(briefP, data.agentBrief);
          makeEditable(briefP, 'Describe the SVG or animation for a coding agent…', true, function (v) { onEdit(block, 'agentBrief', v); });
        }
        cvStage.appendChild(briefP);
        if (editable) {
          cvStage.appendChild(el('span', 'xped-bp-foot', 'Pick a built-in animation preset or paste finished SVG code in Settings →'));
        }
      }

      wrap.appendChild(cvStage);
      var cvCap = Model.getLocalized(data.caption, lang, defLang);
      if (cvCap || editable) {
        var cvCapEl = el('p', 'xped-caption', cvCap);
        field(cvCapEl, data.caption);
        makeEditable(cvCapEl, 'Optional visual caption…', editable, function (v) { onEdit(block, 'caption', v); });
        wrap.appendChild(cvCapEl);
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
