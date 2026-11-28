(function () {
  'use strict';
  var uiText = typeof window !== 'undefined' && window.Xped && window.Xped.i18n ? window.Xped.i18n.t : function (message) { return message; };
  var platformDownload = window.Xped ? window.Xped.download : window.LectureProcessorDownload;
  var platformUx = window.Xped ? window.Xped.ux : window.LectureProcessorUx;
  var platformBootstrap = window.Xped ? window.Xped.bootstrap : window.LectureProcessorBootstrap;
  var platformAuth = window.Xped ? window.Xped.auth : window.LectureProcessorAuth;

  var Model = window.XpedElearningModel;
  var expeditionId = document.body.dataset.expeditionId || '';
  var kpisEl = document.getElementById('el-resp-kpis');
  var funnelEl = document.getElementById('el-resp-funnel');
  var blocksEl = document.getElementById('el-resp-blocks');
  var feedbackEl = document.getElementById('el-resp-feedback');

  var cohortSelect = document.getElementById('el-resp-cohort');
  var langSelect = document.getElementById('el-resp-lang');
  var status = document.getElementById('el-resp-status');
  var report = document.getElementById('el-response-report');
  var actions = document.getElementById('el-response-actions');
  var label = document.getElementById('el-resp-expedition');
  var retry = document.getElementById('el-resp-retry');
  var exportFilteredBtn = document.getElementById('el-resp-export-csv');
  var exportAllBtn = document.getElementById('el-resp-export-all-csv');
  var hasLoadedOnce = false;
  var requestId = 0;
  var auth;
  try { auth = platformBootstrap.getAuth(); } catch (_) { /* SDK unavailable */ }
  if (!auth && document.querySelector('meta[name="academy-signin"]')) {
    status.textContent = uiText('Sign-in is temporarily unavailable. Reload this page to try again.');
    return;
  }
  var client = platformAuth.createAuthClient(auth);
  cohortSelect.addEventListener('change', loadResponses);
  langSelect.addEventListener('change', loadResponses);
  retry.addEventListener('click', loadResponses);

  function activityName(type, lang) {
    var names = {
      mcq: ['Meerkeuzevraag', 'Multiple choice', 'Multiple-Choice-Frage'],
      myth_fact: ['Feit of fabel', 'Myth or fact', 'Mythos oder Fakt'],
      scale: ['Schaalvraag', 'Rating scale', 'Skalenfrage'],
      wordcloud: ['Woordwolk', 'Word cloud', 'Wortwolke'],
      ranking: ['Rangschikking', 'Ranking', 'Rangfolge'],
      reflection: ['Reflectie', 'Reflection', 'Reflexion'],
      balance_scale: ['Draagkracht en draaglast', 'Balance scale', 'Belastung und Ressourcen'],
      mini_plan: ['Persoonlijk miniplan', 'Personal mini-plan', 'Persönlicher Mini-Plan'],
    };
    return names[type] ? names[type][lang === 'nl' ? 0 : lang === 'de' ? 2 : 1] : Model.getBlockMeta(type).label;
  }

  function syncExportButtons() {
    var hasFilter = !!(cohortSelect.value || langSelect.value);
    if (exportFilteredBtn) {
      exportFilteredBtn.textContent = hasFilter ? uiText('Export filtered CSV') : uiText('Export CSV');
    }
    if (exportAllBtn) {
      exportAllBtn.hidden = !hasFilter;
    }
  }

  // Chart cards: interface labels follow the interface language; numbers use its locale.
  var NOT_COMPLETED = { nl: 'Niet voltooid', de: 'Nicht abgeschlossen', en: 'Not completed' };
  function uiLanguage() {
    if (window.Xped && window.Xped.i18n) return window.Xped.i18n.language;
    var i18n = window.LectureI18n;
    var lang = (i18n && i18n.getLanguage && i18n.getLanguage()) || document.documentElement.lang || 'en';
    return NOT_COMPLETED[lang] ? lang : 'en';
  }
  function uiLocale() {
    return { nl: 'nl-NL', de: 'de-DE', en: 'en-GB' }[uiLanguage()];
  }
  function formatPercent(value) {
    var share = Math.max(0, Number(value) || 0) / 100;
    return new Intl.NumberFormat(uiLocale(), { style: 'percent', maximumFractionDigits: 1 }).format(share);
  }
  function formatScore(value) {
    return value === null || value === undefined ? '—' : new Intl.NumberFormat(uiLocale(), { maximumFractionDigits: 1 }).format(value);
  }
  function sessionsLabel(count) {
    return count + (count === 1 ? uiText(' session') : uiText(' sessions'));
  }

  // One labelled bar: the label left, the count and share right, the bar beneath.
  function chartRow(name, count, percent, good) {
    var row = document.createElement('div');
    row.className = 'el-chart-row' + (good ? ' is-good' : '');
    var label = document.createElement('span');
    label.className = 'el-chart-label';
    label.setAttribute('translate', 'no');
    label.textContent = name;
    var value = document.createElement('span');
    value.className = 'el-chart-value';
    var amount = document.createElement('strong');
    amount.textContent = String(count);
    var share = document.createElement('span');
    share.className = 'el-chart-share';
    share.dataset.percent = String(percent);
    share.textContent = formatPercent(percent);
    value.append(amount, ' ', share);
    row.append(label, value, chartBar(percent, good ? 'is-good' : ''));
    return row;
  }

  // Bars are <progress> elements: the page policy forbids inline styles.
  function chartBar(value, className, max) {
    var bar = document.createElement('progress');
    bar.className = 'el-chart-bar' + (className ? ' ' + className : '');
    bar.max = max || 100;
    bar.value = Math.max(0, Math.min(bar.max, Number(value) || 0));
    bar.setAttribute('aria-hidden', 'true');
    return bar;
  }

  function chartNote(text) {
    var note = document.createElement('p');
    note.className = 'el-chart-note';
    note.textContent = text;
    return note;
  }

  function splitFigure(label, value, good, own) {
    var item = document.createElement('div');
    item.className = 'el-split-figure' + (good ? ' is-good' : '');
    var term = document.createElement('dt');
    term.textContent = label;
    if (own) term.setAttribute('translate', 'no');
    var amount = document.createElement('dd');
    amount.textContent = value;
    item.append(term, amount);
    return item;
  }

  // Completion as two shares of one bar, with the supporting figures beneath.
  var lastSummary = null;
  function renderSummary(summary) {
    lastSummary = summary;
    var total = Number(summary.totalSessions) || 0;
    var rate = summary.completionRate !== undefined && summary.completionRate !== null
      ? Number(summary.completionRate) : (total ? 100 * (Number(summary.completedSessions) || 0) / total : 0);
    var completed = summary.completedSessions !== undefined ? Number(summary.completedSessions) || 0 : Math.round(total * rate / 100);
    var title = document.createElement('h2');
    title.id = 'el-resp-kpis-title';
    title.textContent = uiText('Completion rate');
    var shares = document.createElement('dl');
    shares.className = 'el-split-figures';
    shares.append(
      splitFigure(uiText('Completed'), total ? formatPercent(rate) : '—', true),
      splitFigure(NOT_COMPLETED[uiLanguage()], total ? formatPercent(100 - rate) : '—', false, true)
    );
    var bar = chartBar(total ? rate : 0, 'el-split-bar' + (total ? '' : ' is-empty'));
    var counts = document.createElement('div');
    counts.className = 'el-split-counts';
    var left = document.createElement('span');
    left.textContent = sessionsLabel(completed);
    var right = document.createElement('span');
    right.textContent = sessionsLabel(Math.max(0, total - completed));
    counts.append(left, right);
    counts.hidden = !total;
    var figures = document.createElement('dl');
    figures.className = 'el-split-stats';
    var seconds = Number(summary.medianSeconds) || 0;
    figures.append(
      splitFigure(uiText('Testers'), String(total)),
      splitFigure(uiText('Median Time'), seconds && seconds < 60 ? '<1 min' : Math.round(seconds / 60) + ' min')
    );
    if (summary.avgClarity !== null && summary.avgClarity !== undefined || summary.avgEngagement !== null && summary.avgEngagement !== undefined) {
      figures.append(splitFigure(uiText('Clarity / Engagement'), formatScore(summary.avgClarity) + ' / ' + formatScore(summary.avgEngagement)));
    }
    kpisEl.replaceChildren(title, shares, bar, counts, figures);
  }

  async function loadResponses() {
    var sequence = ++requestId;
    retry.hidden = true;
    syncExportButtons();
    // UX-119: Keep existing report visible with subtle Updating state while switching filters
    if (hasLoadedOnce && !report.hidden) {
      var scope = [cohortSelect.value || uiText('all cohorts'), langSelect.value.toUpperCase() || uiText('all languages')];
      status.textContent = uiText('Updating ') + scope.join(' · ') + '. Previous results are shown below.';
      report.setAttribute('aria-busy', 'true');
      report.classList.add('el-resp-updating');
    } else {
      report.setAttribute('aria-busy', 'true');
      status.textContent = uiText('Loading responses…');
      report.hidden = true;
    }
    try {
      var qs = new URLSearchParams();
      var cohort = cohortSelect.value;
      if (cohort) qs.set('cohort', cohort);
      if (langSelect.value) qs.set('language', langSelect.value);
      var base = '/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/responses';
      var resp = await client.authFetch(base + (qs.size ? '?' + qs : ''));
      var data = await resp.json();
      if (sequence !== requestId) return;
      if (!resp.ok) throw new Error(uiText(data.error) || uiText('Could not load responses.'));
      var courseLang = data.expedition.defaultLanguage || 'nl';
      var reportLang = langSelect.value || document.documentElement.lang || courseLang;
      label.textContent = data.expedition.title || '';
      cohortSelect.replaceChildren(new Option(uiText('All cohorts'), ''));
      (data.cohorts || []).forEach(function (name) { cohortSelect.add(new Option(name, name)); });
      if (cohort && !Array.from(cohortSelect.options).some(function (o) { return o.value === cohort; })) {
        cohortSelect.add(new Option(cohort, cohort));
      }
      cohortSelect.value = cohort;
      syncExportButtons();
      status.textContent = cohort || langSelect.value
        ? uiText('Showing responses for ') + [cohort, langSelect.value.toUpperCase()].filter(Boolean).join(' · ')
        : uiText('Showing all responses');
      report.classList.remove('el-resp-updating');
      report.setAttribute('aria-busy', 'false');
      report.hidden = false;
      hasLoadedOnce = true;

      var s = data.summary || {};
      renderSummary(s);

      // Reach per step, grouped by station
      funnelEl.textContent = '';
      var maxReached = Math.max(1, s.totalSessions || 1);
      var stationGroup = null;
      var stationId = null;
      (data.funnel || []).forEach(function (row) {
        if (!stationGroup || row.moduleId !== stationId) {
          stationId = row.moduleId;
          stationGroup = document.createElement('div');
          stationGroup.className = 'el-chart-group';
          var stationTitle = document.createElement('h3');
          stationTitle.className = 'el-chart-group-title';
          stationTitle.setAttribute('translate', 'no');
          stationTitle.textContent = Model.getLocalized(row.moduleTitle, reportLang, courseLang);
          stationGroup.appendChild(stationTitle);
          funnelEl.appendChild(stationGroup);
        }
        var pct = Math.round((row.reached / maxReached) * 100);
        stationGroup.appendChild(chartRow(Model.getLocalized(row.stepTitle, reportLang, courseLang), row.reached, pct));
      });
      if (funnelEl.childElementCount) funnelEl.appendChild(chartNote('n = ' + (s.totalSessions || 0)));

      document.getElementById('el-resp-funnel-card').hidden = !funnelEl.childElementCount;

      // Question charts (UX-116, UX-117, UX-120)
      blocksEl.textContent = '';
      var statsMap = data.blockStats || {};
      (data.expedition.modules || []).forEach(function (mod, mIdx) {
        (mod.steps || []).forEach(function (step, sIdx) {
          (step.blocks || []).forEach(function (blk) {
            var agg = statsMap[blk.id];
            if (!agg) return;
            var name = activityName(blk.type, reportLang);
            var position = uiText('Station ') + (mIdx + 1) + ' · ' + (reportLang === 'de' ? uiText('Schritt') : reportLang === 'nl' ? uiText('Stap') : uiText('Step')) + ' ' + (sIdx + 1);
            var card = document.createElement('article');
            card.className = 'el-exp-card';
            var h = document.createElement('h2');
            h.setAttribute('translate', 'no');
            var authoredTitle = Model.getLocalized(blk.data.question || blk.data.statement || blk.data.prompt || blk.data.title, reportLang, courseLang);
            h.textContent = authoredTitle || name + ' · ' + position;
            card.appendChild(h);
            var sub = chartNote('n = ' + agg.count + (authoredTitle ? ' · ' + name + ' · ' + position : ''));
            sub.setAttribute('translate', 'no');
            if (agg.average !== undefined && agg.average !== null) {
              var avg = document.createElement('strong');
              avg.textContent = uiText('Average score: ') + agg.average;
              card.appendChild(avg);
            }
            if (blk.type === 'balance_scale' && (agg.avgLoad !== null || agg.avgResource !== null)) {
              var balRow = document.createElement('div');
              balRow.className = 'el-summary-balance-grid';
              var lc = document.createElement('div');
              lc.className = 'el-summary-balance-col';
              var lt = document.createElement('strong');
              lt.textContent = uiText('Avg Load (Draaglast): ') + (agg.avgLoad !== null ? agg.avgLoad : '—');
              lc.appendChild(lt);
              var rc = document.createElement('div');
              rc.className = 'el-summary-balance-col';
              var rt = document.createElement('strong');
              rt.textContent = uiText('Avg Resources (Draagkracht): ') + (agg.avgResource !== null ? agg.avgResource : '—');
              rc.appendChild(rt);
              balRow.appendChild(lc);
              balRow.appendChild(rc);
              card.appendChild(balRow);
            }
            if (agg.counts) {
              var isMulti = blk.type === 'mcq' && !!(blk.settings && blk.settings.allowMultiple);
              var denom = isMulti
                ? Math.max(1, agg.count || 1)
                : (Object.keys(agg.counts).reduce(function (acc, k) { return acc + (agg.counts[k] || 0); }, 0) || 1);
              if (isMulti) {
                var mNote = document.createElement('p');
                mNote.className = 'el-exp-meta';
                mNote.textContent = uiText('Share of ') + agg.count + (agg.count === 1 ? uiText(' respondent.') : uiText(' respondents.')) + uiText(' Each could choose more than one option, so the total can exceed 100%.');
                card.appendChild(mNote);
              }
              var choices = (blk.data.options || []).map(function (option) { return option.id; });
              var keys = Array.from(new Set(choices.concat(Object.keys(agg.counts))));
              var rows = document.createElement('div');
              rows.className = 'el-chart-rows';
              keys.forEach(function (k) {
                var cnt = agg.counts[k] || 0;
                var pct = Math.min(100, Math.round((cnt / denom) * 100));
                var opt = (blk.data.options || []).find(function (o) { return o.id === k; });
                var isRight = (blk.type === 'myth_fact' && k === (blk.data.correctAnswer || 'myth')) || !!(opt && opt.isCorrect && blk.data.graded !== false);
                var name = opt ? Model.getLocalized(opt.label, reportLang, courseLang) : (k === 'myth' || k === 'fact' ? Model.ui(reportLang, k) : k);
                var row = chartRow(name, cnt, pct, isRight);
                if (isRight && window.XpedElearningIcons) {
                  var chkIco = window.XpedElearningIcons.icon('check', 14);
                  chkIco.classList.add('el-resp-check-ico');
                  chkIco.setAttribute('aria-hidden', 'true');
                  row.querySelector('.el-chart-label').appendChild(chkIco);
                }
                rows.appendChild(row);
              });
              card.appendChild(rows);
            }
            if (Array.isArray(agg.words) && agg.words.length) {
              var tags = document.createElement('div');
              tags.className = 'xped-word-tags';
              agg.words.slice(0, 15).forEach(function (w) {
                var ch = document.createElement('span');
                ch.className = 'xped-word-chip';
                ch.setAttribute('translate', 'no');
                ch.textContent = w.word + ' (' + w.count + ')';
                tags.appendChild(ch);
              });
              card.appendChild(tags);
            }
            if (Array.isArray(agg.samples) && agg.samples.length) {
              // UX-117: Explicit count + Show all toggle instead of silent slice(0, 8)
              var samplesWrap = document.createElement('div');
              var showLimit = 8;
              var showingAll = false;
              function drawSamples() {
                samplesWrap.textContent = '';
                var shown = showingAll ? agg.samples : agg.samples.slice(0, showLimit);
                var cntMeta = document.createElement('p');
                cntMeta.className = 'el-exp-meta';
                var total = agg.sampleTotal === undefined ? agg.samples.length : agg.sampleTotal;
                cntMeta.textContent = uiText('Showing ') + shown.length + uiText(' of ') + total + uiText(' reflection excerpts');
                if (total > agg.samples.length) cntMeta.textContent += '. Export the CSV for all responses.';
                samplesWrap.appendChild(cntMeta);
                shown.forEach(function (txt) {
                  var q = document.createElement('blockquote');
                  q.className = 'el-translate-source';
                  q.setAttribute('translate', 'no');
                  q.textContent = txt;
                  samplesWrap.appendChild(q);
                });
                if (agg.samples.length > showLimit) {
                  var moreBtn = document.createElement('button');
                  moreBtn.type = 'button';
                  moreBtn.className = 'btn small';
                  moreBtn.textContent = showingAll ? uiText('Show fewer') : (uiText('Show ') + agg.samples.length + uiText(' excerpts'));
                  moreBtn.addEventListener('click', function () {
                    showingAll = !showingAll;
                    drawSamples();
                    samplesWrap.querySelector('button').focus();
                  });
                  samplesWrap.appendChild(moreBtn);
                }
              }
              drawSamples();
              card.appendChild(samplesWrap);
            }
            card.appendChild(sub);
            blocksEl.appendChild(card);
          });
        });
      });

      // Slide-by-Slide Reviewer Comments with deep links to Builder (UX-118)
      var commentsCard = document.getElementById('el-resp-comments-card');
      var commentsEl = document.getElementById('el-resp-comments');
      var scList = data.stepComments || [];
      if (commentsCard && commentsEl) {
        commentsEl.textContent = '';
        commentsCard.hidden = !scList.length;
        scList.forEach(function (item) {
          var c = document.createElement('div');
          c.className = 'el-resp-comment-card';
          var m = document.createElement('div');
          m.className = 'el-resp-comment-meta';
          m.setAttribute('translate', 'no');
          m.textContent = (item.moduleTitle || uiText('Station')) + ' · ' + (item.stepTitle || uiText('Step')) + ' (' + (item.cohort || uiText('review')) + ' · ' + String(item.language || 'nl').toUpperCase() + ')';
          var bodyP = document.createElement('div');
          bodyP.setAttribute('translate', 'no');
          bodyP.textContent = item.comment;
          c.append(m, bodyP);
          var station = (data.expedition.modules || []).find(function (module) {
            return (module.steps || []).some(function (step) { return step.id === item.stepId; });
          });
          if (station) {
            var jump = document.createElement('a');
            jump.className = 'el-action-link';
            var qJump = new URLSearchParams({ step: item.stepId, from: 'responses' });
            qJump.set('module', station.id);
            jump.href = Model.coursePaths(expeditionId).edit + '?' + qJump.toString();
            jump.textContent = uiText('Open in builder →');
            c.appendChild(jump);
          } else {
            var unavailable = document.createElement('span');
            unavailable.className = 'el-exp-meta';
            unavailable.textContent = uiText('Step no longer available');
            c.appendChild(unavailable);
          }
          commentsEl.appendChild(c);
        });
      }

      // Pilot Feedback
      feedbackEl.textContent = '';
      var fb = data.pilotFeedback || [];
      if (!fb.length) {
        feedbackEl.textContent = uiText('No pilot usability feedback submitted yet.');
      } else {
        fb.forEach(function (item) {
          var row = document.createElement('div');
          row.className = 'el-member-row';
          var left = document.createElement('div');
          left.textContent = '[' + item.cohort + ' · ' + String(item.language || 'nl').toUpperCase() + uiText('] Clarity: ') + (item.clarity || '—') + '/5 · Engagement: ' + (item.engagement || '—') + '/5 — ' + (item.comment || uiText('(no comment)'));
          row.appendChild(left);
          feedbackEl.appendChild(row);
        });
      }
    } catch (err) {
      if (sequence !== requestId || err.code === 'auth/session-changed') return;
      report.classList.remove('el-resp-updating');
      report.setAttribute('aria-busy', 'false');
      report.hidden = !hasLoadedOnce;
      status.textContent = hasLoadedOnce ? err.message + uiText(' Previous results are still shown.') : err.message;
      retry.hidden = false;
    }
  }

  async function downloadCsv(filtered) {
    try {
      var qs = new URLSearchParams();
      if (filtered) {
        if (cohortSelect.value) qs.set('cohort', cohortSelect.value);
        if (langSelect.value) qs.set('language', langSelect.value);
      }
      var url = '/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/responses/export.csv' + (qs.size ? '?' + qs : '');
      var resp = await client.authFetch(url);
      if (!resp.ok) throw new Error(uiText('Could not export responses.'));
      var suffix = filtered && qs.size ? ('-' + Array.from(qs.values()).join('-')) : '';
      await platformDownload.downloadResponseBlob(resp, 'xped-responses-' + expeditionId + suffix + '.csv');
    } catch (err) {
      if (err.code !== 'auth/session-changed') platformUx.toast(err.message, { type: 'error' });
    }
  }

  // The Dutch catalog can arrive after the first render: reformat numbers and
  // the labels this script localizes itself, without fetching again.
  window.addEventListener('lp:language-changed', function () {
    if (!lastSummary || report.hidden) return;
    renderSummary(lastSummary);
    report.querySelectorAll('.el-chart-share[data-percent]').forEach(function (share) {
      share.textContent = formatPercent(share.dataset.percent);
    });
  });

  if (exportFilteredBtn) exportFilteredBtn.addEventListener('click', function () { downloadCsv(true); });
  if (exportAllBtn) exportAllBtn.addEventListener('click', function () { downloadCsv(false); });

  function accountChanged(user) {
    ++requestId;
    hasLoadedOnce = false;
    report.setAttribute('aria-busy', 'false');
    report.hidden = true;
    report.classList.remove('el-resp-updating');
    actions.hidden = !user;
    retry.hidden = true;
    document.getElementById('el-signin').hidden = !!user;
    label.textContent = '';
    lastSummary = null;
    [kpisEl, funnelEl, blocksEl, feedbackEl, document.getElementById('el-resp-comments')].forEach(function (el) { el.replaceChildren(); });
    cohortSelect.replaceChildren(new Option(uiText('All cohorts'), ''));
    langSelect.value = '';
    syncExportButtons();
    if (user) loadResponses();
    else status.textContent = uiText('Sign in to view responses.');
  }
  if (auth) auth.onAuthStateChanged(accountChanged);
  else accountChanged(null);
})();
