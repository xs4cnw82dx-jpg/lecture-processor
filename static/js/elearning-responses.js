(function () {
  'use strict';

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
  var requestId = 0;
  var auth;
  try { auth = window.LectureProcessorBootstrap.getAuth(); } catch (_) { /* SDK unavailable */ }
  var client = window.LectureProcessorAuth.createAuthClient(auth);
  cohortSelect.addEventListener('change', loadResponses);
  langSelect.addEventListener('change', loadResponses);
  retry.addEventListener('click', loadResponses);

  function responseBar(percent, correct) {
    var bar = document.createElement('progress');
    bar.className = 'el-response-bar' + (correct ? ' is-correct' : '');
    bar.max = 100;
    bar.value = percent;
    bar.setAttribute('aria-hidden', 'true');
    return bar;
  }

  async function loadResponses() {
    var sequence = ++requestId;
    retry.hidden = true;
    status.textContent = 'Loading responses…';
    report.hidden = true;
    try {
      var qs = new URLSearchParams();
      var cohort = cohortSelect.value;
      if (cohort) qs.set('cohort', cohort);
      if (langSelect.value) qs.set('language', langSelect.value);
      var base = '/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/responses';
      var resp = await client.authFetch(base + (qs.size ? '?' + qs : ''));
      var data = await resp.json();
      if (sequence !== requestId) return;
      if (!resp.ok) throw new Error(data.error || 'Could not load responses.');
      var courseLang = data.expedition.defaultLanguage || 'nl';
      var reportLang = langSelect.value || document.documentElement.lang || courseLang;
      label.textContent = data.expedition.title || '';
      cohortSelect.replaceChildren(new Option('All cohorts', ''));
      (data.cohorts || []).forEach(function (name) { cohortSelect.add(new Option(name, name)); });
      if (cohort && !Array.from(cohortSelect.options).some(function (o) { return o.value === cohort; })) {
        cohortSelect.add(new Option(cohort, cohort));
      }
      cohortSelect.value = cohort;
      status.textContent = '';
      report.hidden = false;
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
        lbl.setAttribute('translate', 'no');
        lbl.textContent = Model.getLocalized(row.moduleTitle, reportLang, courseLang) + ' · ' + Model.getLocalized(row.stepTitle, reportLang, courseLang) + ' — ' + row.reached + ' (' + pct + '%)';
        div.append(lbl, responseBar(pct));
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
            h.setAttribute('translate', 'no');
            h.textContent = Model.getLocalized(blk.data.question || blk.data.statement || blk.data.prompt || blk.data.title, reportLang, courseLang) || blk.type;
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
                var name = opt ? Model.getLocalized(opt.label, reportLang, courseLang) : (k === 'myth' || k === 'fact' ? Model.ui(reportLang, k) : k);
                var head = document.createElement('div');
                head.className = 'el-resp-bar-head';
                var nSp = document.createElement('span');
                nSp.className = 'el-resp-bar-name';
                nSp.setAttribute('translate', 'no');
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
                row.append(head, responseBar(pct, isRight));
                card.appendChild(row);
              });
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
              agg.samples.slice(0, 8).forEach(function (txt) {
                var q = document.createElement('blockquote');
                q.className = 'el-translate-source';
                q.setAttribute('translate', 'no');
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
          m.setAttribute('translate', 'no');
          m.textContent = (item.moduleTitle || 'Station') + ' · ' + (item.stepTitle || 'Step') + ' (' + (item.cohort || 'review') + ' · ' + String(item.language || 'nl').toUpperCase() + ')';
          var bodyP = document.createElement('div');
          bodyP.setAttribute('translate', 'no');
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
      if (sequence !== requestId || err.code === 'auth/session-changed') return;
      report.hidden = true;
      status.textContent = err.message;
      retry.hidden = false;
    }
  }

  document.getElementById('el-resp-export-csv').addEventListener('click', async function () {
    try {
      var resp = await client.authFetch('/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/responses/export.csv');
      if (!resp.ok) throw new Error('Could not export responses.');
      await window.LectureProcessorDownload.downloadResponseBlob(resp, 'xped-responses-' + expeditionId + '.csv');
    } catch (err) {
      if (err.code !== 'auth/session-changed') window.LectureProcessorUx.toast(err.message, { type: 'error' });
    }
  });

  function accountChanged(user) {
    ++requestId;
    report.hidden = true;
    actions.hidden = !user;
    retry.hidden = true;
    document.getElementById('el-signin').hidden = !!user;
    label.textContent = '';
    [kpisEl, funnelEl, blocksEl, feedbackEl, document.getElementById('el-resp-comments')].forEach(function (el) { el.replaceChildren(); });
    cohortSelect.replaceChildren(new Option('All cohorts', ''));
    langSelect.value = '';
    if (user) loadResponses();
    else status.textContent = 'Sign in to view responses.';
  }
  if (auth) auth.onAuthStateChanged(accountChanged);
  else accountChanged(null);
})();
