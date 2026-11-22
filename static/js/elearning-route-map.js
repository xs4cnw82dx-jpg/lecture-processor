(function (root) {
  'use strict';

  function makeEditable(node, placeholder, editable, onCommit) {
    if (!editable) return node;
    node.contentEditable = 'true';
    node.spellcheck = true;
    node.classList.add('el-inline-edit');
    node.setAttribute('data-placeholder', placeholder || '');
    node.addEventListener('blur', function () {
      if (typeof onCommit === 'function') onCommit(node.textContent || '');
    });
    node.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && node.tagName !== 'P') {
        e.preventDefault();
        node.blur();
      }
    });
    return node;
  }

  function renderStartPage(container, options) {
    var Model = root.XpedElearningModel;
    var Icons = root.XpedElearningIcons;
    var exp = options.exp;
    var sp = (exp && exp.startPage) || {};
    var lang = options.lang || 'nl';
    var defLang = (exp && exp.defaultLanguage) || 'nl';
    var editable = !!options.editable;
    var hasProgress = !!options.hasProgress;
    var completedModuleIds = options.completedModuleIds || [];
    var assetUrl = options.assetUrl || function () { return ''; };
    var onStart = options.onStart;
    var onSelectModule = options.onSelectModule;
    var onEditField = options.onEditField || function () {};
    var onDeleteHighlight = options.onDeleteHighlight;
    var onMoveHighlight = options.onMoveHighlight;

    container.textContent = '';
    var shell = document.createElement('div');
    shell.className = 'xped-start-shell';

    var band = document.createElement('section');
    band.className = 'xped-hero-band';

    var mediaUrl = Model.resolveMediaUrl(sp.heroMedia, sp.heroMediaOverrides, lang, assetUrl);
    var grid = document.createElement('div');
    grid.className = 'xped-hero-grid' + (mediaUrl ? '' : ' no-media');

    var col = document.createElement('div');
    col.className = 'xped-hero-copy';

    var eyText = Model.getLocalized(sp.eyebrow, lang, defLang);
    if (eyText || editable) {
      var kicker = document.createElement('div');
      kicker.className = 'xped-hero-kicker';
      var eySpan = document.createElement('span');
      eySpan.textContent = eyText;
      makeEditable(eySpan, 'xPEDitie Pijn', editable, function (v) { onEditField('eyebrow', v); });
      kicker.appendChild(eySpan);
      col.appendChild(kicker);
    }

    var h1 = document.createElement('h1');
    h1.className = 'xped-hero-title';
    h1.textContent = Model.getLocalized(sp.title, lang, defLang) || (editable ? '' : (exp.title || ''));
    makeEditable(h1, 'Click to write your xPEDitie title…', editable, function (v) { onEditField('title', v); });
    col.appendChild(h1);

    var subText = Model.getLocalized(sp.subtitle, lang, defLang);
    if (subText || editable) {
      var p = document.createElement('p');
      p.className = 'xped-hero-subtitle';
      p.textContent = subText;
      makeEditable(p, 'Click to add a calm welcome introduction…', editable, function (v) { onEditField('subtitle', v); });
      col.appendChild(p);
    }

    var visibleMods = (exp.modules || []).filter(function (m) { return m.visibleToLearners !== false; });
    var totalMin = visibleMods.reduce(function (acc, m) { return acc + (m.estimatedMinutes || 5); }, 0);

    var details = document.createElement('div');
    details.className = 'xped-course-details';
    var highlights;
    if (sp.highlights && sp.highlights.length) {
      var ul = document.createElement('ul');
      ul.className = 'xped-hero-highlights';
      sp.highlights.forEach(function (hl, hlIdx) {
        var txt = Model.getLocalized(hl.text, lang, defLang);
        if (!txt && !editable) return;
        var li = document.createElement('li');
        if (Icons) li.appendChild(Icons.icon('check', 16));
        var spn = document.createElement('span');
        spn.className = 'xped-hl-text';
        spn.textContent = txt;
        makeEditable(spn, 'Highlight bullet…', editable, function (v) { onEditField('highlight:' + hl.id, v); });
        li.appendChild(spn);
        if (editable) {
          var tools = document.createElement('span');
          tools.className = 'xped-hl-tools';
          if (hlIdx > 0 && typeof onMoveHighlight === 'function') {
            var upB = document.createElement('button');
            upB.type = 'button';
            upB.className = 'xped-hl-btn';
            upB.title = 'Move up';
            if (Icons) upB.appendChild(Icons.icon('chevronUp', 13));
            upB.addEventListener('click', function () { onMoveHighlight(hlIdx, -1); });
            tools.appendChild(upB);
          }
          if (hlIdx < sp.highlights.length - 1 && typeof onMoveHighlight === 'function') {
            var dnB = document.createElement('button');
            dnB.type = 'button';
            dnB.className = 'xped-hl-btn';
            dnB.title = 'Move down';
            if (Icons) dnB.appendChild(Icons.icon('chevronDown', 13));
            dnB.addEventListener('click', function () { onMoveHighlight(hlIdx, 1); });
            tools.appendChild(dnB);
          }
          if (typeof onDeleteHighlight === 'function') {
            var rmB = document.createElement('button');
            rmB.type = 'button';
            rmB.className = 'xped-hl-btn';
            rmB.title = 'Remove highlight';
            if (Icons) rmB.appendChild(Icons.icon('x', 13));
            rmB.addEventListener('click', function () { onDeleteHighlight(hl.id); });
            tools.appendChild(rmB);
          }
          li.appendChild(tools);
        }
        ul.appendChild(li);
      });
      if (ul.children.length) {
        highlights = document.createElement('section');
        highlights.className = 'xped-highlights-section';
        var heading = document.createElement('h2');
        heading.textContent = Model.ui(lang, 'courseHighlights');
        highlights.append(heading, ul);
      }
    }

    var ctaRow = document.createElement('div');
    ctaRow.className = 'xped-hero-cta-row';
    var cta = document.createElement('button');
    cta.type = 'button';
    cta.className = 'xped-btn xped-btn-sun';
    var ctaSpan = document.createElement('span');
    ctaSpan.textContent = hasProgress
      ? Model.ui(lang, 'continueExpedition')
      : (Model.getLocalized(sp.ctaLabel, lang, defLang) || Model.ui(lang, 'startExpedition'));
    if (editable) {
      makeEditable(ctaSpan, 'Start button label', true, function (v) { onEditField('ctaLabel', v); });
    }
    cta.appendChild(ctaSpan);
    if (Icons) cta.appendChild(Icons.icon('arrowRight', 18));
    cta.disabled = !visibleMods.length && !editable;
    if (!editable && typeof onStart === 'function') cta.addEventListener('click', function () { onStart(); });
    ctaRow.appendChild(cta);
    col.appendChild(ctaRow);

    grid.appendChild(col);

    if (mediaUrl) {
      var art = document.createElement('div');
      art.className = 'xped-hero-art';
      var img = document.createElement('img');
      if (options.setMediaSource) options.setMediaSource(img, mediaUrl);
      else img.src = mediaUrl;
      img.alt = '';
      art.appendChild(img);
      grid.appendChild(art);
    }
    band.appendChild(grid);

    shell.appendChild(band);
    if (options.disclosure) shell.appendChild(options.disclosure);

    if (sp.heroVideoEmbedUrl) {
      var vSec = document.createElement('div');
      vSec.className = 'xped-hero-video-wrap';
      var vf = document.createElement('div');
      vf.className = 'xped-video-frame';
      var ifr = document.createElement('iframe');
      ifr.src = sp.heroVideoEmbedUrl;
      ifr.title = 'Intro video';
      ifr.allowFullscreen = true;
      vf.appendChild(ifr);
      vSec.appendChild(vf);
      shell.appendChild(vSec);
    }

    if (visibleMods.length && (!exp.theme || exp.theme.showRouteMap !== false)) {
      var rSec = document.createElement('section');
      rSec.className = 'xped-route-section';

      var intro = document.createElement('div');
      intro.className = 'xped-route-intro';
      var rh2 = document.createElement('h2');
      rh2.textContent = Model.ui(lang, 'routeTitle');
      intro.appendChild(rh2);
      var rSub = document.createElement('span');
      rSub.className = 'xped-route-count';
      rSub.textContent = visibleMods.length + ' ' + Model.ui(lang, visibleMods.length === 1 ? 'station' : 'stations') + ' · ~' + totalMin + ' ' + Model.ui(lang, 'minutes');
      intro.appendChild(rSub);
      rSec.appendChild(intro);

      var host = document.createElement('div');
      renderRouteMap(host, {
        modules: visibleMods,
        lang: lang,
        defaultLang: defLang,
        completedModuleIds: completedModuleIds,
        activeModuleId: (visibleMods.find(function (m) { return completedModuleIds.indexOf(m.id) < 0; }) || visibleMods[0]).id,
        onSelect: onSelectModule,
        compact: false,
      });
      rSec.appendChild(host);
      details.appendChild(rSec);
    }

    if (highlights) details.appendChild(highlights);
    if (details.childElementCount) shell.appendChild(details);
    container.appendChild(shell);
  }

  /* Unified Connected Journey Path: each station owns ONE waypoint node directly on the connecting spine.
     Scales cleanly for 1, 2, 3, 5, 7, or 12 stations on desktop and mobile with zero desync or duplicated badges. */
  function renderRouteMap(container, options) {
    var Model = root.XpedElearningModel;
    var Icons = root.XpedElearningIcons;
    var modules = (options && options.modules) || [];
    var lang = (options && options.lang) || 'nl';
    var defaultLang = (options && options.defaultLang) || 'nl';
    var completedModuleIds = (options && options.completedModuleIds) || [];
    var activeModuleId = (options && options.activeModuleId) || '';
    var onSelect = options && options.onSelect;
    var compact = !!(options && options.compact);

    container.textContent = '';
    if (!modules.length) return;

    var track = document.createElement('ol');
    track.className = 'xped-journey-track' + (compact ? ' is-compact' : '') + (modules.length === 1 ? ' is-single' : '');

    modules.forEach(function (mod, idx) {
      var isDone = completedModuleIds.indexOf(mod.id) >= 0;
      var isActive = !isDone && mod.id === activeModuleId;
      var dom = mod.domain || 'general';
      var domLabel = (Model.DOMAIN_LABELS[dom] && Model.DOMAIN_LABELS[dom][lang]) || '';

      var li = document.createElement('li');
      li.className = 'xped-journey-stop domain-' + dom + (isDone ? ' is-done' : '') + (isActive ? ' is-active' : '');
      if (isActive) li.setAttribute('aria-current', 'step');

        var markerCol = document.createElement('div');
      markerCol.className = 'xped-journey-marker-col';
      var node = document.createElement('span');
      node.className = 'xped-journey-node';
      if (isDone && Icons) {
        node.appendChild(Icons.icon('check', 16));
      } else {
        node.textContent = String(idx + 1);
      }
      markerCol.appendChild(node);
      if (idx < modules.length - 1) {
        var line = document.createElement('span');
        line.className = 'xped-journey-line' + (isDone ? ' is-done' : '');
        line.setAttribute('aria-hidden', 'true');
        markerCol.appendChild(line);
      }
      li.appendChild(markerCol);

      var btn = document.createElement(typeof onSelect === 'function' ? 'button' : 'div');
      if (typeof onSelect === 'function') btn.type = 'button';
      btn.className = 'xped-journey-card';

      var cardMain = document.createElement('div');
      cardMain.className = 'xped-journey-card-main';

      var title = document.createElement('strong');
      title.className = 'xped-journey-title';
      title.textContent = Model.getLocalized(mod.title, lang, defaultLang) || ('Station ' + (idx + 1));
      cardMain.appendChild(title);

      var topMeta = document.createElement('div');
      topMeta.className = 'xped-journey-card-meta';
      if (domLabel) {
        var domTag = document.createElement('span');
        domTag.className = 'xped-journey-domain';
        var dot = document.createElement('span');
        dot.className = 'xped-domain-dot domain-' + dom;
        domTag.appendChild(dot);
        domTag.appendChild(document.createTextNode(domLabel));
        topMeta.appendChild(domTag);
      }
      var mins = document.createElement('span');
      mins.className = 'xped-journey-time';
      mins.textContent = '~' + (mod.estimatedMinutes || 5) + ' ' + Model.ui(lang, 'minutes');
      topMeta.appendChild(mins);
      cardMain.appendChild(topMeta);

      var subTxt = Model.getLocalized(mod.subtitle, lang, defaultLang);
      if (subTxt) {
        var sub = document.createElement('p');
        sub.className = 'xped-journey-sub';
        sub.textContent = subTxt;
        cardMain.appendChild(sub);
      }
      btn.appendChild(cardMain);

      var arrowWrap = document.createElement('span');
      arrowWrap.className = 'xped-journey-arrow';
      if (Icons) arrowWrap.appendChild(Icons.icon('arrowRight', 17));
      if (typeof onSelect === 'function') btn.appendChild(arrowWrap);

      if (typeof onSelect === 'function') {
        btn.addEventListener('click', function () { onSelect(mod, idx); });
      }
      li.appendChild(btn);
      track.appendChild(li);
    });

    container.appendChild(track);
  }

  root.XpedElearningRouteMap = {
    renderRouteMap: renderRouteMap,
    renderStartPage: renderStartPage,
  };
})(typeof window !== 'undefined' ? window : globalThis);
