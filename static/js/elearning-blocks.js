(function (root) {
  'use strict';

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function makeEditable(node, placeholder, editable, onCommit) {
    if (!editable) return node;
    node.contentEditable = 'true';
    node.spellcheck = true;
    node.classList.add('el-inline-edit');
    node.setAttribute('data-placeholder', placeholder || '');
    node.addEventListener('click', function (e) { e.stopPropagation(); });
    node.addEventListener('blur', function () {
      if (typeof onCommit === 'function') onCommit(node.textContent || '');
    });
    return node;
  }

  function createDropzone(label, sublabel, accept, onFile) {
    var Icons = root.XpedElearningIcons;
    var dz = el('div', 'el-dropzone');
    dz.tabIndex = 0;
    if (Icons) dz.appendChild(Icons.icon('upload', 22));
    dz.appendChild(el('strong', '', label));
    dz.appendChild(el('span', '', sublabel));
    var inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = accept;
    inp.hidden = true;
    dz.appendChild(inp);

    dz.addEventListener('click', function (e) {
      e.stopPropagation();
      if (typeof onFile === 'function') inp.click();
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
    return dz;
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
        var track = el('div', 'xped-bar-track');
        var fill = el('div', 'xped-bar-fill');
        fill.style.width = pct + '%';
        track.appendChild(fill);
        row.appendChild(track);
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
    var beam = sEl('g', { class: 'xped-balance-beam' });
    beam.style.transform = 'rotate(' + diff + 'deg)';
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
    var ul = null;
    lines.forEach(function (raw) {
      var trimmed = raw.trim();
      if (!trimmed) {
        ul = null;
        return;
      }
      if (trimmed.indexOf('- ') === 0 || trimmed.indexOf('• ') === 0) {
        if (!ul) {
          ul = el('ul', 'xped-richtext-list');
          box.appendChild(ul);
        }
        var li = document.createElement('li');
        appendInlineTokens(li, trimmed.slice(2));
        ul.appendChild(li);
      } else {
        ul = null;
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
    var editable = !!ctx.editable;
    var answers = ctx.answers || {};
    var onAnswer = ctx.onAnswer || function () {};
    var onEdit = ctx.onEdit || function () {};
    var onUploadFile = ctx.onUploadFile || null;
    var fetchAggregate = ctx.fetchAggregate || null;
    var assetUrl = ctx.assetUrl || function () { return ''; };
    var stepTitleLower = String(ctx.stepTitle || '').trim().toLowerCase();
    var stepHasAnswered = !!ctx.stepHasAnswered;
    var highlightBlockId = ctx.highlightBlockId || '';
    var data = block.data || {};
    var revealAfter = !!(block.settings && block.settings.revealAfterAnswer);

    var wrap = el('div', 'xped-block xped-block-' + block.type);
    wrap.setAttribute('data-block-id', block.id || '');
    if (highlightBlockId && highlightBlockId === block.id) {
      wrap.classList.add('is-tr-highlighted');
    }
    if (revealAfter && interactive && !stepHasAnswered) {
      wrap.classList.add('xped-reveal-locked');
      wrap.setAttribute('data-reveal-after', '1');
    } else if (revealAfter && interactive && stepHasAnswered) {
      wrap.classList.add('xped-reveal-unlocked');
    }
    if (revealAfter && editable) {
      var rTag = el('div', 'xped-author-cue');
      if (Icons) rTag.appendChild(Icons.icon('eye', 13));
      rTag.appendChild(document.createTextNode('Reveals after learner answers'));
      wrap.appendChild(rTag);
    }

    if (block.type === 'richtext') {
      var h = Model.getLocalized(data.heading, lang, defLang);
      var b = Model.getLocalized(data.body, lang, defLang);
      if (h || editable) {
        var hEl = el('h3', 'xped-question-text', h);
        makeEditable(hEl, 'Optional section heading…', editable, function (v) { onEdit(block, 'heading', v); });
        wrap.appendChild(hEl);
      }
      if (editable) {
        var fmtBar = el('div', 'el-fmt-bar');
        var rtTa = document.createElement('textarea');
        rtTa.className = 'xped-richtext-editor';
        rtTa.rows = Math.max(3, Math.min(10, String(b || '').split('\n').length + 1));
        rtTa.value = b || '';
        rtTa.placeholder = 'Write calm, clear explanation text… (use Bold or Bullet buttons above)';
        rtTa.addEventListener('click', function (e) { e.stopPropagation(); });
        rtTa.addEventListener('input', function () {
          rtTa.rows = Math.max(3, Math.min(10, rtTa.value.split('\n').length + 1));
        });
        rtTa.addEventListener('blur', function () { onEdit(block, 'body', rtTa.value); });

        function wrapSel(prefix, suffix, fallback) {
          var s = rtTa.selectionStart || 0;
          var e = rtTa.selectionEnd || 0;
          var sel = rtTa.value.slice(s, e) || fallback;
          rtTa.value = rtTa.value.slice(0, s) + prefix + sel + suffix + rtTa.value.slice(e);
          rtTa.focus();
          onEdit(block, 'body', rtTa.value);
        }
        [
          { ico: 'bold', title: 'Bold text', fn: function () { wrapSel('**', '**', 'belangrijk woord'); } },
          { ico: 'list', title: 'Add bullet line', fn: function () { wrapSel('\n- ', '', 'Kernpunt'); } },
          { ico: 'link', title: 'Add link', fn: function () { wrapSel('[', '](https://example.org)', 'Lees meer'); } },
        ].forEach(function (tool) {
          var tb = el('button', 'el-fmt-btn');
          tb.type = 'button';
          tb.title = tool.title;
          if (Icons) tb.appendChild(Icons.icon(tool.ico, 14));
          tb.addEventListener('click', function (ev) { ev.stopPropagation(); tool.fn(); });
          fmtBar.appendChild(tb);
        });
        wrap.appendChild(fmtBar);
        wrap.appendChild(rtTa);
      } else {
        wrap.appendChild(renderFormattedBody(b));
      }
      return wrap;
    }

    if (block.type === 'video') {
      var vt = Model.getLocalized(data.title, lang, defLang);
      if (vt || editable) {
        var vth = el('h3', 'xped-question-text', vt);
        makeEditable(vth, 'Optional video title…', editable, function (v) { onEdit(block, 'title', v); });
        wrap.appendChild(vth);
      }
      var embedSrc = Model.buildEmbedSrc(data, lang);
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
        if (editable) {
          var vRow = el('div', 'el-video-inline-row');
          var vInp = document.createElement('input');
          vInp.type = 'url';
          vInp.className = 'xped-input';
          vInp.placeholder = 'https://www.youtube.com/watch?v=…';
          vInp.addEventListener('click', function (e) { e.stopPropagation(); });
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
        }
        wrap.appendChild(ph);
      }
      var cap = Model.getLocalized(data.caption, lang, defLang);
      if (cap || editable) {
        var capEl = el('p', 'xped-caption', cap);
        makeEditable(capEl, 'Optional caption…', editable, function (v) { onEdit(block, 'caption', v); });
        wrap.appendChild(capEl);
      }
      var tr = Model.getLocalized(data.transcript, lang, defLang);
      if (tr) {
        var det = el('details', 'xped-details');
        var sum = document.createElement('summary');
        sum.appendChild(el('span', '', Model.ui(lang, 'transcriptDefault')));
        if (Icons) {
          var ch = Icons.icon('chevronDown', 16);
          ch.classList.add('xped-details-chev');
          sum.appendChild(ch);
        }
        det.appendChild(sum);
        det.appendChild(el('div', 'xped-details-body', tr));
        wrap.appendChild(det);
      }
      return wrap;
    }

    if (block.type === 'image') {
      var layout = data.layout || 'full';
      var imgWrap = el('div', 'xped-image-block layout-' + layout);
      var url = Model.resolveMediaUrl(data.media, data.mediaOverrides, lang, assetUrl);
      var fig = el('figure', 'xped-image-figure');
      if (url) {
        var img = document.createElement('img');
        img.src = url;
        img.alt = Model.getLocalized(data.alt, lang, defLang) || '';
        img.loading = 'lazy';
        fig.appendChild(img);
      } else {
        fig.appendChild(createDropzone(
          'Drop an image here or click to upload',
          'PNG, JPG or WebP — or pick an official xPED illustration on the right',
          'image/png,image/jpeg,image/webp',
          editable && onUploadFile ? function (file) { onUploadFile(block, file); } : null
        ));
      }
      var icap = Model.getLocalized(data.caption, lang, defLang);
      if (icap || editable) {
        var fcap = el('figcaption', 'xped-caption', icap);
        makeEditable(fcap, 'Optional image caption…', editable, function (v) { onEdit(block, 'caption', v); });
        fig.appendChild(fcap);
      }
      imgWrap.appendChild(fig);
      if (layout === 'split-left' || layout === 'split-right') {
        var side = el('div');
        var sh = Model.getLocalized(data.sideHeading, lang, defLang);
        var sb = Model.getLocalized(data.sideBody, lang, defLang);
        if (sh || editable) {
          var shEl = el('h3', 'xped-question-text', sh);
          makeEditable(shEl, 'Heading…', editable, function (v) { onEdit(block, 'sideHeading', v); });
          side.appendChild(shEl);
        }
        var sbEl = el('p', 'xped-richtext-body', sb);
        makeEditable(sbEl, 'Supporting explanation beside this visual…', editable, function (v) { onEdit(block, 'sideBody', v); });
        side.appendChild(sbEl);
        imgWrap.appendChild(side);
      }
      wrap.appendChild(imgWrap);
      return wrap;
    }

    if (block.type === 'audio') {
      var card = el('div', 'xped-audio-card');
      var at = el('h3', 'xped-question-text', Model.getLocalized(data.title, lang, defLang));
      makeEditable(at, 'Audio exercise title…', editable, function (v) { onEdit(block, 'title', v); });
      card.appendChild(at);
      var desc = Model.getLocalized(data.description, lang, defLang);
      if (desc || editable) {
        var ad = el('p', 'xped-caption', desc);
        makeEditable(ad, 'Short instruction for the learner…', editable, function (v) { onEdit(block, 'description', v); });
        card.appendChild(ad);
      }
      var aUrl = Model.resolveMediaUrl(data.media, data.mediaOverrides, lang, assetUrl);
      if (aUrl) {
        var audio = document.createElement('audio');
        audio.controls = true;
        audio.src = aUrl;
        card.appendChild(audio);
      } else {
        card.appendChild(createDropzone(
          'Drop an audio clip here or click to upload',
          'MP3, M4A or OGG (up to 15 MB)',
          'audio/*',
          editable && onUploadFile ? function (file) { onUploadFile(block, file); } : null
        ));
      }
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
      makeEditable(ct, 'Key takeaway title…', editable, function (v) { onEdit(block, 'title', v); });
      var cb = el('p', '', Model.getLocalized(data.body, lang, defLang));
      makeEditable(cb, 'Write a concise takeaway message…', editable, function (v) { onEdit(block, 'body', v); });
      contentCol.appendChild(ct);
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
        av.src = sUrl;
        av.alt = data.speakerName || 'Speaker';
        sc.appendChild(av);
      }
      var bodyCol = el('div');
      var bq = el('blockquote', 'xped-story-quote', Model.getLocalized(data.quote, lang, defLang));
      makeEditable(bq, 'Click to write a real patient or clinician quote…', editable, function (v) { onEdit(block, 'quote', v); });
      bodyCol.appendChild(bq);
      var meta = el('div', 'xped-story-meta');
      var spName = el('strong', '', data.speakerName || (editable ? '' : 'Naam'));
      makeEditable(spName, 'Speaker name', editable, function (v) { onEdit(block, 'speakerName', v); });
      meta.appendChild(spName);
      var role = Model.getLocalized(data.speakerRole, lang, defLang);
      if (role || editable) {
        meta.appendChild(document.createTextNode(' · '));
        var roleEl = el('span', '', role);
        makeEditable(roleEl, 'Role (e.g. Ervaringsverhaal)', editable, function (v) { onEdit(block, 'speakerRole', v); });
        meta.appendChild(roleEl);
      }
      bodyCol.appendChild(meta);
      sc.appendChild(bodyCol);
      wrap.appendChild(sc);
      return wrap;
    }

    if (block.type === 'sources') {
      var sdet = el('details', 'xped-details');
      var ssum = document.createElement('summary');
      ssum.appendChild(el('span', '', Model.getLocalized(data.title, lang, defLang) || Model.ui(lang, 'sourcesDefault')));
      if (Icons) {
        var sch = Icons.icon('chevronDown', 16);
        sch.classList.add('xped-details-chev');
        ssum.appendChild(sch);
      }
      sdet.appendChild(ssum);
      var sbody = el('div', 'xped-details-body');
      var ul = el('ul', 'xped-sources-list');
      (data.items || []).forEach(function (item) {
        var li = el('li');
        li.appendChild(document.createTextNode(Model.getLocalized(item.citation, lang, defLang) || 'Add scientific reference in Settings…'));
        if (item.url) {
          li.appendChild(document.createTextNode(' '));
          var a = document.createElement('a');
          a.href = item.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = 'Link';
          li.appendChild(a);
        }
        ul.appendChild(li);
      });
      sbody.appendChild(ul);
      sdet.appendChild(sbody);
      wrap.appendChild(sdet);
      return wrap;
    }

    if (block.type === 'mcq') {
      var qh = el('h3', 'xped-question-text', Model.getLocalized(data.question, lang, defLang));
      makeEditable(qh, 'Click to write your question…', editable, function (v) { onEdit(block, 'question', v); });
      wrap.appendChild(qh);
      var sub = Model.getLocalized(data.subtitle, lang, defLang);
      if (sub || editable) {
        var subEl = el('p', 'xped-caption', sub);
        makeEditable(subEl, 'Optional helper subtitle…', editable, function (v) { onEdit(block, 'subtitle', v); });
        wrap.appendChild(subEl);
      }
      var current = answers[block.id];
      var allowMulti = !!(block.settings && block.settings.allowMultiple);
      var selectedList = Array.isArray(current) ? current : (current ? [current] : []);
      var grid = el('div', 'xped-options-grid');
      var feedbackHost = el('div');
      var peerHost = el('div');
      var letters = 'ABCDEFGHIJKLMNOPQRST';

      var hasGradedKey = (data.options || []).some(function (o) { return !!o.isCorrect; });

      function applyMcqClasses(sel) {
        var answered = sel.length > 0;
        Array.prototype.forEach.call(grid.children, function (child, i) {
          var o = data.options[i];
          var s = sel.indexOf(o.id) >= 0;
          var cls = 'xped-option-btn';
          if (answered && hasGradedKey) {
            if (o.isCorrect) cls += ' is-correct';
            else if (s) cls += ' is-incorrect';
            else cls += ' is-muted';
          } else if (s) {
            cls += ' is-selected';
          }
          child.className = cls;
        });
      }

      function showMcqFeedback(sel) {
        feedbackHost.textContent = '';
        if (!sel.length) return;
        var chosenOpt = (data.options || []).find(function (o) { return o.id === sel[0]; });
        var fbText = (chosenOpt && Model.getLocalized(chosenOpt.feedback, lang, defLang)) || Model.getLocalized(data.explanation, lang, defLang);
        var isRight = hasGradedKey ? !!(chosenOpt && chosenOpt.isCorrect) : null;
        if (fbText || hasGradedKey) {
          var box = el('div', 'xped-feedback-box ' + (isRight === true ? 'is-correct' : (isRight === false ? 'is-gentle' : 'is-neutral')));
          if (isRight === true) {
            box.appendChild(el('strong', 'xped-feedback-lead', Model.ui(lang, 'rightLead')));
          } else if (isRight === false) {
            box.appendChild(el('strong', 'xped-feedback-lead', Model.ui(lang, 'wrongMythLead')));
          }
          if (fbText) box.appendChild(el('p', 'xped-feedback-text', fbText));
          feedbackHost.appendChild(box);
        }
        if (interactive && block.settings && block.settings.showPeerResults && fetchAggregate) {
          fetchAggregate(block.id).then(function (agg) {
            peerHost.textContent = '';
            renderPeerBars(peerHost, block, agg, lang, defLang);
          });
        }
      }

      (data.options || []).forEach(function (opt, idx) {
        var btn = el('button', 'xped-option-btn');
        btn.type = 'button';
        btn.appendChild(el('span', 'xped-option-letter', letters[idx] || String(idx + 1)));
        var lblSpan = el('span', '', Model.getLocalized(opt.label, lang, defLang));
        if (editable) {
          makeEditable(lblSpan, 'Option ' + (idx + 1), true, function (v) { onEdit(block, 'option:' + opt.id, v); });
        }
        btn.appendChild(lblSpan);
        if (interactive) {
          btn.addEventListener('click', function () {
            var nextSel = allowMulti
              ? (selectedList.indexOf(opt.id) >= 0 ? selectedList.filter(function (x) { return x !== opt.id; }) : selectedList.concat([opt.id]))
              : [opt.id];
            selectedList = nextSel;
            onAnswer(block.id, allowMulti ? nextSel : nextSel[0]);
            applyMcqClasses(nextSel);
            showMcqFeedback(nextSel);
          });
        }
        grid.appendChild(btn);
      });
      if (selectedList.length) applyMcqClasses(selectedList);
      wrap.appendChild(grid);

      if (editable) {
        var addOptBtn = el('button', 'el-quiet-add-step', '+ Add option');
        addOptBtn.type = 'button';
        addOptBtn.style.marginTop = '8px';
        addOptBtn.addEventListener('click', function (e) {
          e.stopPropagation();
          onEdit(block, 'addOption', '');
        });
        wrap.appendChild(addOptBtn);
      }

      wrap.appendChild(feedbackHost);
      wrap.appendChild(peerHost);
      if (selectedList.length) showMcqFeedback(selectedList);
      return wrap;
    }

    if (block.type === 'myth_fact') {
      // ZERO redundant "FABEL / FEIT" eyebrow above the statement!
      var stEl = el('h3', 'xped-question-text', Model.getLocalized(data.statement, lang, defLang));
      makeEditable(stEl, 'Click to write a common pain belief statement…', editable, function (v) { onEdit(block, 'statement', v); });
      wrap.appendChild(stEl);

      var picked = answers[block.id] || '';
      var row = el('div', 'xped-myth-row');
      var fb = el('div');

      function applyMythClasses(choice) {
        var rightVal = data.correctAnswer || 'myth';
        Array.prototype.forEach.call(row.children, function (c, i) {
          var v = i === 0 ? 'myth' : 'fact';
          var cls = 'xped-option-btn xped-myth-btn';
          if (choice) {
            if (v === rightVal) cls += ' is-correct';
            else if (choice === v) cls += ' is-incorrect';
            else cls += ' is-muted';
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
        if (data.sourceUrl) {
          var a = document.createElement('a');
          a.href = data.sourceUrl;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.textContent = ' ' + (Model.getLocalized(data.sourceLabel, lang, defLang) || 'Bron');
          p.appendChild(a);
        }
        box.appendChild(p);
        fb.appendChild(box);
      }

      [{ val: 'myth', ico: 'xCircle' }, { val: 'fact', ico: 'checkCircle' }].forEach(function (cfg) {
        var btn = el('button', 'xped-option-btn xped-myth-btn');
        btn.type = 'button';
        if (Icons) btn.appendChild(Icons.icon(cfg.ico, 19));
        btn.appendChild(el('span', '', Model.ui(lang, cfg.val)));
        if (interactive) {
          btn.addEventListener('click', function () {
            picked = cfg.val;
            onAnswer(block.id, cfg.val);
            applyMythClasses(cfg.val);
            drawMythFeedback(cfg.val);
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
      makeEditable(sq, 'Click to write your scale prompt…', editable, function (v) { onEdit(block, 'question', v); });
      wrap.appendChild(sq);
      var minV = Number.isFinite(data.min) ? data.min : 0;
      var maxV = Number.isFinite(data.max) ? data.max : 10;
      var curVal = answers[block.id] !== undefined ? Number(answers[block.id]) : Math.round((minV + maxV) / 2);
      var sw = el('div', 'xped-scale-wrap');
      var topRow = el('div', 'xped-step-kicker-row');
      topRow.appendChild(el('span', '', Model.ui(lang, 'yourAnswer')));
      var pill = el('span', 'xped-scale-value-pill', String(curVal));
      topRow.appendChild(pill);
      sw.appendChild(topRow);
      var slider = document.createElement('input');
      slider.type = 'range';
      slider.className = 'xped-range';
      slider.min = String(minV);
      slider.max = String(maxV);
      slider.value = String(curVal);
      var peerHostS = el('div');
      if (interactive) {
        slider.addEventListener('input', function () {
          pill.textContent = slider.value;
          onAnswer(block.id, Number(slider.value));
        });
        slider.addEventListener('change', function () {
          if (block.settings && block.settings.showPeerResults && fetchAggregate) {
            fetchAggregate(block.id).then(function (agg) {
              peerHostS.textContent = '';
              renderPeerBars(peerHostS, block, agg, lang, defLang);
            });
          }
        });
      }
      sw.appendChild(slider);
      var lbls = el('div', 'xped-scale-labels');
      lbls.appendChild(el('span', '', Model.getLocalized(data.minLabel, lang, defLang)));
      lbls.appendChild(el('span', '', Model.getLocalized(data.maxLabel, lang, defLang)));
      sw.appendChild(lbls);
      wrap.appendChild(sw);
      var sfb = Model.getLocalized(data.feedback, lang, defLang);
      if (sfb) wrap.appendChild(el('p', 'xped-caption', sfb));
      wrap.appendChild(peerHostS);
      return wrap;
    }

    if (block.type === 'reflection') {
      var rp = el('h3', 'xped-question-text', Model.getLocalized(data.prompt, lang, defLang));
      makeEditable(rp, 'Click to write your reflection prompt…', editable, function (v) { onEdit(block, 'prompt', v); });
      wrap.appendChild(rp);
      var ta = document.createElement('textarea');
      ta.className = 'xped-textarea';
      ta.rows = 4;
      ta.placeholder = Model.getLocalized(data.placeholder, lang, defLang);
      ta.value = String(answers[block.id] || '');
      ta.readOnly = !interactive;
      if (interactive) ta.addEventListener('input', function () { onAnswer(block.id, ta.value); });
      wrap.appendChild(ta);
      var note = Model.getLocalized(data.helperNote, lang, defLang);
      if (note) wrap.appendChild(el('p', 'xped-caption', note));
      return wrap;
    }

    if (block.type === 'wordcloud') {
      var wq = el('h3', 'xped-question-text', Model.getLocalized(data.question, lang, defLang));
      makeEditable(wq, 'Click to write your word cloud question…', editable, function (v) { onEdit(block, 'question', v); });
      wrap.appendChild(wq);
      var maxW = data.maxWords || 3;
      var words = Array.isArray(answers[block.id]) ? answers[block.id].slice() : [];
      var rowW = el('div', 'el-btn-row');
      var inp = document.createElement('input');
      inp.type = 'text';
      inp.className = 'xped-input';
      inp.style.flex = '1';
      inp.placeholder = Model.getLocalized(data.placeholder, lang, defLang) || Model.ui(lang, 'addWordPlaceholder');
      inp.disabled = !interactive;
      var addBtn = el('button', 'xped-btn xped-btn-secondary', Model.ui(lang, 'addWordBtn'));
      addBtn.type = 'button';
      addBtn.disabled = !interactive;
      var tagsBox = el('div', 'xped-word-tags');
      var peerBoxW = el('div');
      function drawTags() {
        tagsBox.textContent = '';
        words.forEach(function (w, idx) {
          var chip = el('span', 'xped-word-chip', w);
          if (interactive) {
            var rm = el('button', '', '×');
            rm.type = 'button';
            rm.addEventListener('click', function () {
              words.splice(idx, 1);
              onAnswer(block.id, words.slice());
              drawTags();
            });
            chip.appendChild(rm);
          }
          tagsBox.appendChild(chip);
        });
      }
      function addWord() {
        var val = inp.value.trim();
        if (!val || words.length >= maxW) return;
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
      wrap.appendChild(tagsBox);
      wrap.appendChild(peerBoxW);
      drawTags();
      return wrap;
    }

    if (block.type === 'ranking') {
      var rq = el('h3', 'xped-question-text', Model.getLocalized(data.question, lang, defLang));
      makeEditable(rq, 'Click to write your ranking prompt…', editable, function (v) { onEdit(block, 'question', v); });
      wrap.appendChild(rq);
      var items = data.items || [];
      var order = Array.isArray(answers[block.id]) && answers[block.id].length === items.length
        ? answers[block.id].slice()
        : items.map(function (it) { return it.id; });
      var listEl = el('div', 'xped-options-grid');
      function drawRank() {
        listEl.textContent = '';
        order.forEach(function (id, idx) {
          var item = items.find(function (it) { return it.id === id; });
          if (!item) return;
          var r = el('div', 'xped-rank-item');
          var left = el('div', 'el-btn-row');
          left.appendChild(el('span', 'xped-rank-pos', String(idx + 1)));
          left.appendChild(el('span', '', Model.getLocalized(item.label, lang, defLang)));
          r.appendChild(left);
          if (interactive) {
            var acts = el('div', 'el-btn-row');
            var up = el('button', 'el-icon-btn');
            up.type = 'button';
            up.disabled = idx === 0;
            if (Icons) up.appendChild(Icons.icon('chevronUp', 16));
            up.addEventListener('click', function () {
              var tmp = order[idx - 1];
              order[idx - 1] = order[idx];
              order[idx] = tmp;
              onAnswer(block.id, order.slice());
              drawRank();
            });
            var dn = el('button', 'el-icon-btn');
            dn.type = 'button';
            dn.disabled = idx === order.length - 1;
            if (Icons) dn.appendChild(Icons.icon('chevronDown', 16));
            dn.addEventListener('click', function () {
              var tmp = order[idx + 1];
              order[idx + 1] = order[idx];
              order[idx] = tmp;
              onAnswer(block.id, order.slice());
              drawRank();
            });
            acts.appendChild(up);
            acts.appendChild(dn);
            r.appendChild(acts);
          }
          listEl.appendChild(r);
        });
      }
      drawRank();
      wrap.appendChild(listEl);
      return wrap;
    }

    if (block.type === 'hotspot') {
      var ht = el('h3', 'xped-question-text', Model.getLocalized(data.title, lang, defLang));
      makeEditable(ht, 'Interactive visual title…', editable, function (v) { onEdit(block, 'title', v); });
      wrap.appendChild(ht);
      var inst = Model.getLocalized(data.instruction, lang, defLang);
      if (inst || editable) {
        wrap.appendChild(el('p', 'xped-caption', editable ? 'Tip: click directly anywhere on the image below to add a hotspot pin.' : inst));
      }
      var hUrl = Model.resolveMediaUrl(data.media, null, lang, assetUrl);
      var pins = data.pins || [];
      var activePinId = answers[block.id] || (pins[0] && pins[0].id) || '';
      var detailBox = el('div');

      function drawPinDetail(pid) {
        detailBox.textContent = '';
        var pin = pins.find(function (p) { return p.id === pid; });
        if (!pin) return;
        var box = el('div', 'xped-feedback-box is-neutral');
        box.appendChild(el('strong', '', Model.getLocalized(pin.label, lang, defLang) + ': '));
        box.appendChild(document.createTextNode(Model.getLocalized(pin.detail, lang, defLang) || 'Add explanation in Settings.'));
        detailBox.appendChild(box);
      }

      if (hUrl) {
        var stage = el('div', 'xped-hotspot-stage' + (editable ? ' is-placeable' : ''));
        var himg = document.createElement('img');
        himg.src = hUrl;
        himg.alt = Model.getLocalized(data.alt, lang, defLang) || '';
        stage.appendChild(himg);
        if (editable) {
          stage.addEventListener('click', function (e) {
            if (e.target.closest('.xped-hotspot-pin')) return;
            e.stopPropagation();
            var rect = stage.getBoundingClientRect();
            var x = Math.round(((e.clientX - rect.left) / rect.width) * 100);
            var y = Math.round(((e.clientY - rect.top) / rect.height) * 100);
            onEdit(block, 'addPin', { x: x, y: y });
          });
        }
        pins.forEach(function (pin, idx) {
          var isCue = interactive && !answers[block.id] && idx === 0;
          var pBtn = el('button', 'xped-hotspot-pin' + (pin.id === activePinId ? ' is-active' : '') + (isCue ? ' is-cue-pulse' : ''), String(idx + 1));
          pBtn.type = 'button';
          pBtn.style.left = (pin.x || 50) + '%';
          pBtn.style.top = (pin.y || 50) + '%';
          pBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            activePinId = pin.id;
            if (interactive) onAnswer(block.id, pin.id);
            Array.prototype.forEach.call(stage.querySelectorAll('.xped-hotspot-pin'), function (n, i) {
              n.classList.toggle('is-active', pins[i].id === activePinId);
            });
            drawPinDetail(activePinId);
          });
          stage.appendChild(pBtn);
        });
        wrap.appendChild(stage);
      }
      var fbBar = el('div', 'xped-hotspot-fallback');
      pins.forEach(function (pin, idx) {
        var chip = el('button', 'el-btn el-btn-sm', (idx + 1) + '. ' + (Model.getLocalized(pin.label, lang, defLang) || ('Point ' + (idx + 1))));
        chip.type = 'button';
        chip.addEventListener('click', function () {
          activePinId = pin.id;
          if (interactive) onAnswer(block.id, pin.id);
          drawPinDetail(activePinId);
        });
        fbBar.appendChild(chip);
      });
      wrap.appendChild(fbBar);
      wrap.appendChild(detailBox);
      if (activePinId) drawPinDetail(activePinId);
      return wrap;
    }

    if (block.type === 'balance_scale') {
      // Avoid unnatural title doubling if Step Title already names the scale
      var bTitle = Model.getLocalized(data.title, lang, defLang);
      if ((bTitle && bTitle.toLowerCase() !== stepTitleLower && !stepTitleLower.includes('weegschaal') && !stepTitleLower.includes('balance') && !stepTitleLower.includes('waage')) || editable) {
        var bth = el('h3', 'xped-question-text', bTitle);
        makeEditable(bth, 'Optional balance scale subtitle…', editable, function (v) { onEdit(block, 'title', v); });
        wrap.appendChild(bth);
      }
      var bintro = Model.getLocalized(data.intro, lang, defLang);
      if (bintro || editable) {
        var bi = el('p', 'xped-caption', bintro);
        bi.style.marginBottom = '14px';
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
        if (tipText) tipWrap.appendChild(el('div', 'xped-feedback-box ' + (loadT > resT ? 'is-gentle' : 'is-correct'), tipText));
      }

      var cols = el('div', 'xped-balance-cols');
      var loadCol = el('div', 'xped-balance-col is-load');
      loadCol.appendChild(el('div', 'xped-balance-col-head', Model.getLocalized(data.loadLabel, lang, defLang) || Model.ui(lang, 'load')));
      var resCol = el('div', 'xped-balance-col is-resource');
      resCol.appendChild(el('div', 'xped-balance-col-head', Model.getLocalized(data.resourceLabel, lang, defLang) || Model.ui(lang, 'resource')));

      factors.forEach(function (f) {
        var fWrap = el('div', 'xped-balance-factor');
        var flab = document.createElement('label');
        var vSpan = el('span', '', String(vals[f.id]) + '/3');
        flab.appendChild(el('span', '', Model.getLocalized(f.label, lang, defLang)));
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
      makeEditable(bpt, 'Biopsychosocial heading…', editable, function (v) { onEdit(block, 'title', v); });
      wrap.appendChild(bpt);
      var tintro = Model.getLocalized(data.intro, lang, defLang);
      if (tintro) wrap.appendChild(el('p', 'xped-caption', tintro));
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
        panel.textContent = (item && item.body) || 'Add explanation for this dimension in Settings…';
      }
      defs.forEach(function (d) {
        var tb = el('button', 'xped-bps-tab', d.title);
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
      makeEditable(mpt, 'Mini-plan heading…', editable, function (v) { onEdit(block, 'title', v); });
      wrap.appendChild(mpt);
      var mintro = Model.getLocalized(data.intro, lang, defLang);
      if (mintro) wrap.appendChild(el('p', 'xped-caption', mintro));
      var maxSel = data.maxSelect || 3;
      var chosen = Array.isArray(answers[block.id]) ? answers[block.id].slice() : [];
      var chips = el('div', 'xped-plan-chips');
      function drawChips() {
        chips.textContent = '';
        (data.suggestions || []).forEach(function (sug) {
          var txt = Model.getLocalized(sug.label, lang, defLang);
          var isOn = chosen.indexOf(txt) >= 0;
          var btn = el('button', 'xped-plan-chip' + (isOn ? ' is-selected' : ''));
          btn.type = 'button';
          if (Icons) btn.appendChild(Icons.icon(isOn ? 'check' : 'plus', 14));
          btn.appendChild(document.createTextNode(txt));
          if (interactive) {
            btn.addEventListener('click', function () {
              if (chosen.indexOf(txt) >= 0) chosen = chosen.filter(function (c) { return c !== txt; });
              else if (chosen.length < maxSel) chosen.push(txt);
              onAnswer(block.id, chosen.slice());
              drawChips();
            });
          }
          chips.appendChild(btn);
        });
        chosen.forEach(function (customItem) {
          var isPreset = (data.suggestions || []).some(function (s) { return Model.getLocalized(s.label, lang, defLang) === customItem; });
          if (isPreset) return;
          var cbtn = el('button', 'xped-plan-chip is-selected');
          cbtn.type = 'button';
          if (Icons) cbtn.appendChild(Icons.icon('check', 14));
          cbtn.appendChild(document.createTextNode(customItem));
          cbtn.type = 'button';
          if (interactive) {
            cbtn.addEventListener('click', function () {
              chosen = chosen.filter(function (c) { return c !== customItem; });
              onAnswer(block.id, chosen.slice());
              drawChips();
            });
          }
          chips.appendChild(cbtn);
        });
      }
      drawChips();
      wrap.appendChild(chips);
      if (data.allowCustom && interactive) {
        var customRow = el('div', 'el-btn-row');
        customRow.style.marginTop = '12px';
        var cinp = document.createElement('input');
        cinp.type = 'text';
        cinp.className = 'xped-input';
        cinp.style.flex = '1';
        cinp.placeholder = Model.ui(lang, 'customGoalPlaceholder');
        var cadd = el('button', 'xped-btn xped-btn-secondary', Model.ui(lang, 'addGoal'));
        cadd.type = 'button';
        cadd.addEventListener('click', function () {
          var v = cinp.value.trim();
          if (!v || chosen.length >= maxSel) return;
          chosen.push(v);
          cinp.value = '';
          onAnswer(block.id, chosen.slice());
          drawChips();
        });
        customRow.appendChild(cinp);
        customRow.appendChild(cadd);
        wrap.appendChild(customRow);
      }
      return wrap;
    }

    if (block.type === 'custom_visual') {
      var cvt = Model.getLocalized(data.title, lang, defLang);
      if (cvt || editable) {
        var cvh = el('h3', 'xped-question-text', cvt);
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
        try {
          var parser = new DOMParser();
          var doc = parser.parseFromString(data.svgMarkup, 'image/svg+xml');
          var svgNode = doc.documentElement;
          if (svgNode && svgNode.tagName && svgNode.tagName.toLowerCase() === 'svg') {
            svgNode.querySelectorAll('script, foreignObject, iframe, object, embed').forEach(function (n) { n.remove(); });
            svgNode.querySelectorAll('*').forEach(function (n) {
              Array.prototype.slice.call(n.attributes || []).forEach(function (attr) {
                if (/^on/i.test(attr.name) || /javascript:/i.test(attr.value)) n.removeAttribute(attr.name);
              });
            });
            svgNode.classList.add('xped-custom-svg-art');
            cvStage.appendChild(document.importNode(svgNode, true));
          }
        } catch (_err) {
          cvStage.appendChild(el('p', 'xped-caption', 'Invalid SVG markup — check Settings.'));
        }
      } else {
        cvStage.classList.add('is-blueprint');
        var bpTop = el('div', 'xped-bp-head');
        var tag = el('span', 'xped-bp-tag');
        if (Icons) tag.appendChild(Icons.icon('wand', 14));
        tag.appendChild(document.createTextNode('Custom SVG / Animation Slot · #' + (data.slotId || block.id)));
        bpTop.appendChild(tag);
        if (editable) {
          var cpBtn = el('button', 'el-btn el-btn-sm');
          cpBtn.type = 'button';
          if (Icons) cpBtn.appendChild(Icons.icon('copy', 13));
          cpBtn.appendChild(document.createTextNode('Copy Agent Brief'));
          cpBtn.addEventListener('click', function (e) {
            e.stopPropagation();
            var promptText = 'Build an accessible, prefers-reduced-motion-safe SVG animation for xPEDitie Pijn slot #'
              + (data.slotId || block.id) + ' (height: ' + (data.height || 'medium') + ').\n'
              + 'Brand colors: Navy #062940, Blue #007ACC, Mint #1FE4A9, Yellow #FFD617, Warm Sand #F6F1E9.\n'
              + 'Brief: ' + (data.agentBrief || 'Calm pain education visual.');
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(promptText).then(function () {
                cpBtn.textContent = 'Brief Copied!';
                setTimeout(function () {
                  cpBtn.textContent = '';
                  if (Icons) cpBtn.appendChild(Icons.icon('copy', 13));
                  cpBtn.appendChild(document.createTextNode('Copy Agent Brief'));
                }, 1800);
              }).catch(function () {});
            }
          });
          bpTop.appendChild(cpBtn);
        }
        cvStage.appendChild(bpTop);
        var briefP = el('p', 'xped-bp-brief', data.agentBrief || 'Describe the SVG or animation you want a coding agent to create here later…');
        if (editable) {
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
        makeEditable(cvCapEl, 'Optional visual caption…', editable, function (v) { onEdit(block, 'caption', v); });
        wrap.appendChild(cvCapEl);
      }
      return wrap;
    }

    return wrap;
  }

  root.XpedElearningBlocks = {
    renderBlock: renderBlock,
    createDropzone: createDropzone,
  };
})(typeof window !== 'undefined' ? window : globalThis);
