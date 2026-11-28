(function (root) {
  'use strict';
  var uiText = typeof window !== 'undefined' && window.Xped && window.Xped.i18n ? window.Xped.i18n.t : function (message) { return message; };

  function makeEditable(node, placeholder, editable, onCommit) {
    if (!editable) return node;
    root.XpedElearningModel.bindEditableText(node, placeholder, true, onCommit);
    node.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && node.tagName !== 'P') {
        e.preventDefault();
        node.blur();
      }
    });
    return node;
  }

  function renderConsent(container, lang, modules, options, onChoose) {
    var Model = root.XpedElearningModel;
    var form = document.createElement('form');
    form.className = 'xped-card el-consent-card';
    var title = document.createElement('h1');
    title.className = 'xped-step-title';
    var academy = document.documentElement.hasAttribute('data-academy-player') || document.documentElement.dataset.product === 'academy';
    title.textContent = Model.ui(lang, academy ? 'consentHeading' : 'consentTitle');
    var intro = document.createElement('p');
    intro.textContent = Model.ui(lang, 'consentIntro');
    if (options.cohort && options.cohort !== 'default') intro.textContent += ' ' + Model.ui(lang, 'consentCohort', { group: options.cohort });
    if (options.changing) intro.textContent += ' ' + Model.ui(lang, 'consentChangeNote');
    var choices = document.createElement('fieldset');
    var question = document.createElement('legend');
    question.textContent = Model.ui(lang, 'consentQuestion');
    choices.appendChild(question);
    var next = document.createElement('button');
    next.type = 'submit';
    next.className = 'xped-btn xped-btn-sun';
    next.textContent = Model.ui(lang, 'next');
    var error = document.createElement('p');
    error.className = 'el-consent-error';
    if (academy) {
      form.noValidate = true;
      error.id = Model.uid('sharing-choice');
      error.setAttribute('role', 'alert');
    } else {
      next.disabled = true;
    }
    var details = [];
    var description = Model.ui(lang, 'authorAccess');
    if (options.showPeerResults) {
      var shared = modules.flatMap(function (module) {
        return module.steps.flatMap(function (step) { return step.blocks; });
      }).filter(function (block) { return block.settings && block.settings.showPeerResults; });
      if (shared.some(function (block) { return block.type !== 'wordcloud'; })) details.push(Model.ui(lang, 'sharedResults'));
      if (shared.some(function (block) { return block.type === 'wordcloud'; })) details.push(Model.ui(lang, 'sharedWords'));
    }
    if (options.allowStepComments || options.collectPilotFeedback) details.push(Model.ui(lang, 'consentFeedback'));
    [['share', 'consentShare', description], ['private', 'consentPrivate', Model.ui(lang, 'consentPrivateNote')]].forEach(function (item) {
      var label = document.createElement('label');
      var input = document.createElement('input');
      input.type = 'radio';
      input.name = 'sharing';
      input.value = item[0];
      input.required = true;
      var words = document.createElement('span');
      var heading = document.createElement('strong');
      heading.textContent = Model.ui(lang, item[1]);
      var detail = document.createElement('span');
      detail.textContent = item[2];
      words.append(heading, detail);
      label.append(input, words);
      choices.appendChild(label);
      input.addEventListener('change', function () {
        next.disabled = false;
        error.textContent = '';
        choices.removeAttribute('aria-describedby');
        choices.querySelectorAll('[aria-invalid]').forEach(function (radio) { radio.removeAttribute('aria-invalid'); });
      });
    });
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var choice = new FormData(form).get('sharing');
      if (choice !== 'private' && choice !== 'share') {
        if (academy) {
          error.textContent = Model.ui(lang, 'consentChoiceRequired');
          choices.setAttribute('aria-describedby', error.id);
          choices.querySelectorAll('input').forEach(function (radio) { radio.setAttribute('aria-invalid', 'true'); });
          choices.querySelector('input').focus();
        }
        return;
      }
      onChoose(choice);
    });
    form.append(title, intro, choices);
    if (academy) form.appendChild(error);
    if (details.length) {
      var disclosure = document.createElement('details');
      var summary = document.createElement('summary');
      summary.textContent = Model.ui(lang, 'consentDetails');
      var note = document.createElement('p');
      note.textContent = details.join(' ');
      disclosure.append(summary, note);
      form.appendChild(disclosure);
    }
    form.appendChild(next);
    container.replaceChildren(form);
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
    var isAcademy = document.documentElement.hasAttribute('data-academy-player') || document.documentElement.dataset.product === 'academy';
    var genericEyebrow = /^(?:xpeditie pijn|xpedition pain|xpedition schmerz)$/i.test(eyText.trim());
    if ((eyText || editable) && (!isAcademy || (eyText && !genericEyebrow))) {
      var kicker = document.createElement('div');
      kicker.className = 'xped-hero-kicker';
      var eySpan = document.createElement('span');
      eySpan.textContent = eyText;
      if (options.onLocalizedField) options.onLocalizedField(eySpan, sp.eyebrow);
      makeEditable(eySpan, 'xPEDitie Pijn', editable, function (v) { onEditField('eyebrow', v); });
      kicker.appendChild(eySpan);
      col.appendChild(kicker);
    }

    var h1 = document.createElement('h1');
    h1.className = 'xped-hero-title';
    h1.textContent = Model.getLocalized(sp.title, lang, defLang) || (editable ? '' : (exp.title || ''));
    if (options.onLocalizedField) options.onLocalizedField(h1, sp.title);
    makeEditable(h1, uiText('Click to write your xPEDitie title…'), editable, function (v) { onEditField('title', v); });
    col.appendChild(h1);

    var subText = Model.getLocalized(sp.subtitle, lang, defLang);
    if (subText || editable) {
      var p = document.createElement('p');
      p.className = 'xped-hero-subtitle';
      p.textContent = subText;
      if (options.onLocalizedField) options.onLocalizedField(p, sp.subtitle);
      makeEditable(p, uiText('Click to add a calm welcome introduction…'), editable, function (v) { onEditField('subtitle', v); });
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
        if (options.onLocalizedField) options.onLocalizedField(spn, hl.text);
        makeEditable(spn, uiText('Highlight bullet…'), editable, function (v) { onEditField('highlight:' + hl.id, v); });
        li.appendChild(spn);
        if (editable) {
          var tools = document.createElement('span');
          tools.className = 'xped-hl-tools';
          if (hlIdx > 0 && typeof onMoveHighlight === 'function') {
            var upB = document.createElement('button');
            upB.type = 'button';
            upB.className = 'xped-hl-btn';
            upB.title = uiText('Move up');
            if (Icons) upB.appendChild(Icons.icon('chevronUp', 13));
            upB.addEventListener('click', function () { onMoveHighlight(hlIdx, -1); });
            tools.appendChild(upB);
          }
          if (hlIdx < sp.highlights.length - 1 && typeof onMoveHighlight === 'function') {
            var dnB = document.createElement('button');
            dnB.type = 'button';
            dnB.className = 'xped-hl-btn';
            dnB.title = uiText('Move down');
            if (Icons) dnB.appendChild(Icons.icon('chevronDown', 13));
            dnB.addEventListener('click', function () { onMoveHighlight(hlIdx, 1); });
            tools.appendChild(dnB);
          }
          if (typeof onDeleteHighlight === 'function') {
            var rmB = document.createElement('button');
            rmB.type = 'button';
            rmB.className = 'xped-hl-btn';
            rmB.title = uiText('Remove highlight');
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
    if (options.onLocalizedField) options.onLocalizedField(ctaSpan, sp.ctaLabel);
    ctaSpan.textContent = hasProgress
      ? Model.ui(lang, 'continueExpedition')
      : (Model.getLocalized(sp.ctaLabel, lang, defLang) || Model.ui(lang, 'startExpedition'));
    if (editable) {
      makeEditable(ctaSpan, uiText('Start button label'), true, function (v) { onEditField('ctaLabel', v); });
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
      ifr.title = uiText('Intro video');
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
        onLocalizedField: options.onLocalizedField,
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
      title.textContent = Model.getLocalized(mod.title, lang, defaultLang) || (uiText('Station ') + (idx + 1));
      if (options.onLocalizedField) options.onLocalizedField(title, mod.title);
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
        if (options.onLocalizedField) options.onLocalizedField(sub, mod.subtitle);
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

  function renderSummaryCard(exp, answers, lang) {
    var Model = root.XpedElearningModel;
    var defLang = exp.defaultLanguage || 'nl';
    var card = document.createElement('article');
    card.className = 'xped-card xped-completion-card';
    var start = exp.startPage || {};
    function summaryText(key, fallback) {
      return Model.getLocalized(start[key], lang, defLang) || (fallback ? Model.ui(lang, fallback) : '');
    }
    var h1 = document.createElement('h1');
    h1.className = 'xped-step-title';
    h1.textContent = summaryText('summaryTitle', 'summaryTitle');
    var sub = document.createElement('p');
    sub.className = 'xped-caption';
    var courseName = document.createElement('p');
    courseName.className = 'xped-print-course';
    courseName.textContent = Model.getLocalized(exp.localizedTitle, lang, defLang) || exp.title || '';
    card.append(courseName, h1, sub);
    if (root.XpedAcademyControls) {
      var visibleStations = (exp.modules || []).filter(function (station) { return station.visibleToLearners !== false; });
      if (visibleStations.length > 1) card.appendChild(root.XpedAcademyControls.routeStrip(visibleStations, { size: 'large' }));
    }

    var reflections = [];
    var plans = [];
    var balances = [];
    var insights = [];
    (exp.modules || []).forEach(function (m) {
      if (m.visibleToLearners === false) return;
      (m.steps || []).forEach(function (s) {
        (s.blocks || []).forEach(function (b) {
          var ans = answers[b.id];
          if (b.type !== 'myth_fact' && b.settings && b.settings.saveToSummary === false) return;
          if (b.type === 'reflection' && typeof ans === 'string' && ans.trim()) {
            reflections.push({ q: Model.getLocalized(b.data.prompt, lang, defLang), a: ans });
          } else if (b.type === 'mini_plan' && Model.hasMeaningfulAnswer(ans)) {
            var normPlan = Model.normalizeMiniPlanAnswer(ans, (b.data && b.data.suggestions) || [], lang, defLang);
            normPlan.ids.forEach(function (sid) {
              var sug = ((b.data && b.data.suggestions) || []).find(function (item) { return item.id === sid; });
              if (sug) {
                var lbl = Model.getLocalized(sug.label, lang, defLang);
                if (lbl) plans.push(lbl);
              }
            });
            normPlan.custom.forEach(function (txt) {
              if (txt) plans.push(txt);
            });
          } else if (b.type === 'balance_scale' && ans && typeof ans === 'object') {
            if (!(b.data.factors || []).some(function (f) { return Model.balanceScore(ans[f.id]) !== null; })) return;
            var loadT = 0;
            var resT = 0;
            var loadNames = [];
            var resNames = [];
            (b.data.factors || []).forEach(function (f) {
              var v = Model.balanceScore(ans[f.id]) ?? 0;
              var lbl = Model.getLocalized(f.label, lang, defLang);
              if (f.category === 'resource') {
                resT += v;
                if (v >= 2 && lbl) resNames.push(lbl + ' (' + v + '/3)');
              } else {
                loadT += v;
                if (v >= 2 && lbl) loadNames.push(lbl + ' (' + v + '/3)');
              }
            });
            var resources = b.data.factors.filter(function (f) { return f.category === 'resource'; }).length;
            balances.push({ loadT: loadT, resT: resT, loadNames: loadNames, resNames: resNames,
              loadMax: 3 * (b.data.factors.length - resources), resMax: 3 * resources });
          } else if (b.type === 'myth_fact' && ans) {
            var expTxt = Model.getLocalized(b.data.explanation, lang, defLang);
            if (expTxt) insights.push(expTxt);
          }
        });
      });
    });

    if (balances.length) {
      var bSec = document.createElement('div');
      bSec.className = 'el-summary-section';
      var bh = document.createElement('h2');
      bh.textContent = Model.ui(lang, 'myBalance');
      bSec.appendChild(bh);
      balances.forEach(function (bal) {
        var bGrid = document.createElement('div');
        bGrid.className = 'el-summary-balance-grid';
        function balanceColumn(key, total, maximum, names) {
          if (!maximum) return;
          var column = document.createElement('div');
          column.className = 'el-summary-balance-col';
          var heading = document.createElement('strong');
          heading.textContent = Model.ui(lang, key) + ' · ' + total + '/' + maximum;
          var bar = document.createElement('progress');
          bar.className = 'xped-summary-bar is-' + key;
          bar.max = maximum;
          bar.value = total;
          bar.setAttribute('aria-label', Model.ui(lang, key));
          column.append(heading, bar, document.createTextNode(names.join(', ')));
          bGrid.appendChild(column);
        }
        balanceColumn('load', bal.loadT, bal.loadMax, bal.loadNames);
        balanceColumn('resource', bal.resT, bal.resMax, bal.resNames);
        bSec.appendChild(bGrid);
      });
      card.appendChild(bSec);
    }

    if (plans.length) {
      var pSec = document.createElement('div');
      pSec.className = 'el-summary-section';
      var ph = document.createElement('h2');
      ph.textContent = summaryText('summaryPlanHeading', 'myMiniPlan');
      pSec.appendChild(ph);
      var ul = document.createElement('ul');
      ul.className = 'xped-sources-list';
      plans.forEach(function (item) {
        var li = document.createElement('li');
        li.textContent = item;
        ul.appendChild(li);
      });
      pSec.appendChild(ul);
      card.appendChild(pSec);
    }

    if (insights.length) {
      var iSec = document.createElement('div');
      iSec.className = 'el-summary-section';
      var ih = document.createElement('h2');
      ih.textContent = Model.ui(lang, 'myInsights');
      iSec.appendChild(ih);
      var iul = document.createElement('ul');
      iul.className = 'xped-sources-list';
      insights.forEach(function (txt) {
        var li = document.createElement('li');
        li.textContent = txt;
        iul.appendChild(li);
      });
      iSec.appendChild(iul);
      card.appendChild(iSec);
    }

    if (reflections.length) {
      var rSec = document.createElement('div');
      rSec.className = 'el-summary-section';
      var rh = document.createElement('h2');
      rh.textContent = Model.ui(lang, 'myReflections');
      rSec.appendChild(rh);
      reflections.forEach(function (ref) {
        var q = document.createElement('strong');
        q.textContent = ref.q;
        var a = document.createElement('p');
        a.textContent = ref.a;
        a.className = 'el-reflection-answer';
        rSec.appendChild(q);
        rSec.appendChild(a);
      });
      card.appendChild(rSec);
    }

    var hasAnswers = !!(plans.length || reflections.length || balances.length || insights.length);
    sub.textContent = summaryText('summaryIntro', hasAnswers ? 'summarySubtitle' : 'summaryEmpty');
    var closing = summaryText('summaryClosing');
    if (closing) {
      var note = document.createElement('p');
      note.textContent = closing;
      card.appendChild(note);
    }
    if (hasAnswers) {
      var exportRow = document.createElement('div');
      exportRow.className = 'xped-summary-export el-no-print';
      var status = document.createElement('span');
      status.setAttribute('role', 'status');
      var manual = document.createElement('textarea');
      manual.className = 'xped-textarea';
      manual.hidden = true;
      manual.readOnly = true;
      manual.setAttribute('aria-label', Model.ui(lang, 'copySummary'));
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'xped-btn xped-btn-secondary';
      copy.textContent = Model.ui(lang, 'copySummary');
      copy.addEventListener('click', async function () {
        var parts = Array.from(card.children).filter(function (part) {
          return !part.matches('.xped-summary-export, .el-player-nav');
        });
        var text = parts.map(function (part) { return part.innerText.trim(); }).join('\n\n');
        try {
          await navigator.clipboard.writeText(text);
          manual.hidden = true;
          status.textContent = Model.ui(lang, 'summaryCopied');
        } catch (_err) {
          manual.value = text;
          manual.hidden = false;
          status.textContent = Model.ui(lang, 'summaryCopyManual');
          manual.focus();
          manual.select();
        }
      });
      var print = document.createElement('button');
      print.type = 'button';
      print.className = 'xped-btn xped-btn-secondary';
      print.textContent = Model.ui(lang, 'printSummary');
      print.addEventListener('click', function () { window.print(); });
      exportRow.append(copy, print, status, manual);
      card.appendChild(exportRow);
    }
    return card;
  }

  root.XpedElearningRouteMap = {
    renderConsent: renderConsent,
    renderSummaryCard: renderSummaryCard,
    renderRouteMap: renderRouteMap,
    renderStartPage: renderStartPage,
  };
})(typeof window !== 'undefined' ? window : globalThis);
