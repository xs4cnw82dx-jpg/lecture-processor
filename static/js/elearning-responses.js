(function () {
  'use strict';

  var Model = window.XpedElearningModel;
  var Icons = window.XpedElearningIcons;
  var expeditionId = document.body.dataset.expeditionId || '';
  var selectedCohort = '';
  var selectedLang = '';
  var kpisEl = document.getElementById('el-resp-kpis');
  var funnelEl = document.getElementById('el-resp-funnel');
  var blocksEl = document.getElementById('el-resp-blocks');
  var feedbackEl = document.getElementById('el-resp-feedback');

  var LANG_FILTER_ITEMS = [
    { value: '', label: 'All languages' },
    { value: 'nl', label: 'Nederlands (NL)', shortLabel: 'NL' },
    { value: 'en', label: 'English (EN)', shortLabel: 'EN' },
    { value: 'de', label: 'Deutsch (DE)', shortLabel: 'DE' },
  ];
  var cohortDD = Icons.createDropdown({
    ariaLabel: 'Filter by cohort',
    items: [{ value: '', label: 'All cohorts' }],
    value: '',
    onChange: function (v) { selectedCohort = v; loadResponses(); },
  });
  var langDD = Icons.createDropdown({
    leadingIcon: 'globe',
    ariaLabel: 'Filter by language',
    items: LANG_FILTER_ITEMS,
    value: '',
    onChange: function (v) { selectedLang = v; langDD.setItems(LANG_FILTER_ITEMS, v); loadResponses(); },
  });
  var cohortHost = document.getElementById('el-resp-cohort-host');
  var langHost = document.getElementById('el-resp-lang-host');
  if (cohortHost) cohortHost.appendChild(cohortDD.el);
  if (langHost) langHost.appendChild(langDD.el);

  async function authHeaders() {
    var headers = {};
    if (window.firebase && firebase.auth && firebase.auth().currentUser) {
      headers.Authorization = 'Bearer ' + (await firebase.auth().currentUser.getIdToken());
    }
    return headers;
  }

  async function loadResponses() {
    try {
      var qs = [];
      if (selectedCohort) qs.push('cohort=' + encodeURIComponent(selectedCohort));
      if (selectedLang) qs.push('language=' + encodeURIComponent(selectedLang));
      var url = '/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/responses' + (qs.length ? ('?' + qs.join('&')) : '');
      var resp = await fetch(url, { headers: await authHeaders() });
      var data = await resp.json().catch(function () { return {}; });
      if (!resp.ok) throw new Error(data.error || 'Could not load responses.');

      document.getElementById('el-resp-title').textContent = (data.expedition.title || 'Expedition') + ' — Responses';

      var cohortItems = [{ value: '', label: 'All cohorts' }].concat(
        (data.cohorts || []).map(function (c) { return { value: c, label: c }; })
      );
      cohortDD.setItems(cohortItems, selectedCohort);

      // KPIs
      var s = data.summary || {};
      kpisEl.textContent = '';
      [
        ['Testers', String(s.totalSessions || 0)],
        ['Completion Rate', (s.completionRate || 0) + '%'],
        ['Median Time', Math.round((s.medianSeconds || 0) / 60) + ' min'],
        ['Clarity / Engagement', (s.avgClarity || '—') + ' / ' + (s.avgEngagement || '—')],
      ].forEach(function (pair) {
        var card = document.createElement('div');
        card.className = 'el-kpi-card';
        var sp = document.createElement('span');
        sp.textContent = pair[0];
        var st = document.createElement('strong');
        st.textContent = pair[1];
        card.appendChild(sp);
        card.appendChild(st);
        kpisEl.appendChild(card);
      });

      // Funnel
      funnelEl.textContent = '';
      var maxReached = Math.max(1, s.totalSessions || 1);
      (data.funnel || []).forEach(function (row) {
        var pct = Math.round((row.reached / maxReached) * 100);
        var div = document.createElement('div');
        div.className = 'xped-bar-row';
        var lbl = document.createElement('span');
        lbl.textContent = Model.getLocalized(row.moduleTitle, 'nl', 'nl') + ' · ' + Model.getLocalized(row.stepTitle, 'nl', 'nl') + ' — ' + row.reached + ' (' + pct + '%)';
        var track = document.createElement('div');
        track.className = 'xped-bar-track';
        var fill = document.createElement('div');
        fill.className = 'xped-bar-fill';
        fill.style.width = pct + '%';
        track.appendChild(fill);
        div.appendChild(lbl);
        div.appendChild(track);
        funnelEl.appendChild(div);
      });

      // Question charts
      blocksEl.textContent = '';
      var statsMap = data.blockStats || {};
      (data.expedition.modules || []).forEach(function (mod) {
        (mod.steps || []).forEach(function (step) {
          (step.blocks || []).forEach(function (blk) {
            var agg = statsMap[blk.id];
            if (!agg) return;
            var card = document.createElement('article');
            card.className = 'el-exp-card';
            var h = document.createElement('h2');
            h.textContent = Model.getLocalized(blk.data.question || blk.data.statement || blk.data.prompt || blk.data.title, 'nl', 'nl') || blk.type;
            card.appendChild(h);
            var sub = document.createElement('p');
            sub.className = 'el-exp-meta';
            sub.textContent = agg.count + ' responses · ' + blk.type;
            card.appendChild(sub);
            if (agg.average !== undefined && agg.average !== null) {
              var avg = document.createElement('strong');
              avg.textContent = 'Average score: ' + agg.average;
              card.appendChild(avg);
            }
            if (blk.type === 'balance_scale' && (agg.avgLoad !== null || agg.avgResource !== null)) {
              var balRow = document.createElement('div');
              balRow.className = 'el-summary-balance-grid';
              var lc = document.createElement('div');
              lc.className = 'el-summary-balance-col';
              var lt = document.createElement('strong');
              lt.textContent = 'Avg Load (Draaglast): ' + (agg.avgLoad !== null ? agg.avgLoad : '—');
              lc.appendChild(lt);
              var rc = document.createElement('div');
              rc.className = 'el-summary-balance-col';
              var rt = document.createElement('strong');
              rt.textContent = 'Avg Resources (Draagkracht): ' + (agg.avgResource !== null ? agg.avgResource : '—');
              rc.appendChild(rt);
              balRow.appendChild(lc);
              balRow.appendChild(rc);
              card.appendChild(balRow);
            }
            if (agg.counts) {
              var totalVotes = Object.keys(agg.counts).reduce(function (acc, k) { return acc + (agg.counts[k] || 0); }, 0) || 1;
              Object.keys(agg.counts).forEach(function (k) {
                var cnt = agg.counts[k] || 0;
                var pct = Math.round((cnt / totalVotes) * 100);
                var row = document.createElement('div');
                row.className = 'xped-bar-row';
                var opt = (blk.data.options || []).find(function (o) { return o.id === k; });
                var isRight = (blk.type === 'myth_fact' && k === (blk.data.correctAnswer || 'myth')) || !!(opt && opt.isCorrect);
                var name = opt ? Model.getLocalized(opt.label, 'nl', 'nl') : (k === 'myth' ? 'Fabel' : (k === 'fact' ? 'Feit' : k));
                var head = document.createElement('div');
                head.className = 'el-resp-bar-head';
                var nSp = document.createElement('span');
                nSp.className = 'el-resp-bar-name';
                nSp.textContent = name;
                if (isRight && window.XpedElearningIcons) {
                  var chkIco = window.XpedElearningIcons.icon('check', 14);
                  chkIco.classList.add('el-resp-check-ico');
                  nSp.appendChild(chkIco);
                }
                var pSp = document.createElement('span');
                pSp.textContent = cnt + ' (' + pct + '%)';
                head.appendChild(nSp);
                head.appendChild(pSp);
                var track = document.createElement('div');
                track.className = 'xped-bar-track';
                var fill = document.createElement('div');
                fill.className = 'xped-bar-fill el-resp-bar-fill' + (isRight ? ' is-correct' : '');
                fill.style.width = pct + '%';
                track.appendChild(fill);
                row.appendChild(head);
                row.appendChild(track);
                card.appendChild(row);
              });
            }
            if (Array.isArray(agg.words) && agg.words.length) {
              var tags = document.createElement('div');
              tags.className = 'xped-word-tags';
              agg.words.slice(0, 15).forEach(function (w) {
                var ch = document.createElement('span');
                ch.className = 'xped-word-chip';
                ch.textContent = w.word + ' (' + w.count + ')';
                tags.appendChild(ch);
              });
              card.appendChild(tags);
            }
            if (Array.isArray(agg.samples) && agg.samples.length) {
              agg.samples.slice(0, 8).forEach(function (txt) {
                var q = document.createElement('blockquote');
                q.className = 'el-translate-source';
                q.textContent = txt;
                card.appendChild(q);
              });
            }
            blocksEl.appendChild(card);
          });
        });
      });

      // Slide-by-Slide Reviewer Comments
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
          m.textContent = (item.moduleTitle || 'Station') + ' · ' + (item.stepTitle || 'Step') + ' (' + (item.cohort || 'review') + ' · ' + String(item.language || 'nl').toUpperCase() + ')';
          var bodyP = document.createElement('div');
          bodyP.textContent = item.comment;
          c.appendChild(m);
          c.appendChild(bodyP);
          commentsEl.appendChild(c);
        });
      }

      // Pilot Feedback
      feedbackEl.textContent = '';
      var fb = data.pilotFeedback || [];
      if (!fb.length) {
        feedbackEl.textContent = 'No pilot usability feedback submitted yet.';
      } else {
        fb.forEach(function (item) {
          var row = document.createElement('div');
          row.className = 'el-member-row';
          var left = document.createElement('div');
          left.textContent = '[' + item.cohort + ' · ' + String(item.language || 'nl').toUpperCase() + '] Clarity: ' + (item.clarity || '—') + '/5 · Engagement: ' + (item.engagement || '—') + '/5 — ' + (item.comment || '(no comment)');
          row.appendChild(left);
          feedbackEl.appendChild(row);
        });
      }
    } catch (err) {
      kpisEl.textContent = err.message;
    }
  }

  document.getElementById('el-resp-export-csv').addEventListener('click', async function () {
    var resp = await fetch('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/responses/export.csv', {
      headers: await authHeaders(),
    });
    if (!resp.ok) return;
    var blob = await resp.blob();
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'xped-responses-' + expeditionId + '.csv';
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  });

  if (window.firebase && firebase.auth) {
    firebase.auth().onAuthStateChanged(function (user) {
      if (user) loadResponses();
    });
  } else {
    loadResponses();
  }
})();
