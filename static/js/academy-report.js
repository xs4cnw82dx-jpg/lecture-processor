(function () {
  'use strict';
  var platformDownload = window.Xped.download;
  var platformUx = window.Xped.ux;
  var platformBootstrap = window.Xped.bootstrap;
  var platformAuth = window.Xped.auth;

  var i18n = window.Xped.i18n;
  var uiText = i18n.t;
  var Model = window.XpedElearningModel;
  var expeditionId = document.body.dataset.expeditionId || '';
  var kpisEl = document.getElementById('el-resp-kpis');
  var funnelEl = document.getElementById('el-resp-funnel');
  var blocksEl = document.getElementById('el-resp-blocks');
  var feedbackEl = document.getElementById('el-resp-feedback');

  var groupField = document.getElementById('academy-report-groups');
  var activeGroups = new Set();
  var dates = document.getElementById('academy-date-filter');
  var fromDate = dates.elements.from;
  var toDate = dates.elements.to;
  var chips = document.getElementById('academy-filter-chips');
  var langSelect = document.getElementById('el-resp-lang');
  var pageTitle = document.title;
  var periodSelect = document.getElementById('el-resp-period');
  var timeEl = document.getElementById('el-resp-time');
  var trendEl = document.getElementById('el-resp-trend');
  var orderEl = document.getElementById('el-resp-order');
  var status = document.getElementById('el-resp-status');
  var report = document.getElementById('el-response-report');
  var actions = document.getElementById('el-response-actions');
  var label = document.getElementById('el-resp-expedition');
  var retry = document.getElementById('el-resp-retry');
  var exportFilteredBtn = document.getElementById('el-resp-export-csv');
  var hasLoadedOnce = false;
  var requestId = 0;
  var auth;
  try { auth = platformBootstrap.getAuth(); } catch (_) { /* SDK unavailable */ }
  if (!auth && document.querySelector('meta[name="academy-signin"]')) {
    status.textContent = uiText('Sign-in is temporarily unavailable. Reload this page to try again.');
    return;
  }
  var client = platformAuth.createAuthClient(auth);
  groupField.addEventListener('change', function (event) {
    var box = event.target;
    if (box.checked) activeGroups.add(box.value); else activeGroups.delete(box.value);
    loadResponses();
  });
  dates.addEventListener('submit', function (event) {
    event.preventDefault();
    if (fromDate.value && toDate.value && toDate.value < fromDate.value) {
      toDate.setCustomValidity(uiText('report.invalidDates'));
      toDate.reportValidity();
      return;
    }
    periodSelect.value = '';
    dates.parentElement.open = false;
    loadResponses();
  });
  dates.addEventListener('input',function () { toDate.setCustomValidity(''); });
  langSelect.addEventListener('change', loadResponses);
  periodSelect.addEventListener('change', function () { fromDate.value = toDate.value = ''; loadResponses(); });
  retry.addEventListener('click', loadResponses);

  function activityName(type) {
    var names = {
      mcq: uiText('report.activity.mcq'),
      myth_fact: uiText('report.activity.myth_fact'),
      scale: uiText('report.activity.scale'),
      wordcloud: uiText('report.activity.wordcloud'),
      ranking: uiText('report.activity.ranking'),
      reflection: uiText('report.activity.reflection'),
      balance_scale: uiText('report.activity.balance_scale'),
      mini_plan: uiText('report.activity.mini_plan'),
    };
    return names[type] || Model.getBlockMeta(type).label;
  }

  function formatDuration(seconds) {
    return i18n.duration(seconds, 'compact');
  }
  function formatDurationRange(low, high) {
    if (!Number.isFinite(low) || !Number.isFinite(high)) return '—';
    return formatDuration(low) + ' – ' + formatDuration(high);
  }
  function formatPercent(value) {
    return i18n.percent(value);
  }
  function formatScore(value) {
    return value == null ? '—' : i18n.number(value, { maximumFractionDigits: 1 });
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

  // Filters live in the address, so a report view can be shared or reloaded.
  function filterQuery() {
    var qs = new URLSearchParams();
    activeGroups.forEach(function (name) { qs.append('cohort', name); });
    if (fromDate.value) qs.set('from', fromDate.value);
    if (toDate.value) qs.set('to', toDate.value);
    if (langSelect.value) qs.set('language', langSelect.value);
    if (periodSelect.value) qs.set('days', periodSelect.value);
    return qs;
  }
  function syncAddress() {
    var qs = filterQuery();
    window.history.replaceState(window.history.state, '', window.location.pathname + (qs.size ? '?' + qs : '') + window.location.hash);
    var editorLink = document.getElementById('academy-report-editor');
    var editorQuery = new URLSearchParams({ from: 'responses' });
    if (qs.size) editorQuery.set('filters', qs.toString());
    editorLink.href = Model.coursePaths(expeditionId).edit + '?' + editorQuery;
  }
  // Options are rebuilt rather than relabelled, so the enhanced select picks up the new text.
  function labelPeriods() {
    var value = periodSelect.value;
    periodSelect.setAttribute('aria-label', uiText('Period'));
    periodSelect.replaceChildren.apply(periodSelect, ['', '7', '30', '90'].map(function (days) {
      return new Option(days ? uiText('Last {n} days', { n: days }) : uiText('All time'), days);
    }));
    periodSelect.value = value;
  }
  (function restoreFilters() {
    var params = new URLSearchParams(window.location.search);
    labelPeriods();
    if (/^(7|30|90)$/.test(params.get('days') || '')) periodSelect.value = params.get('days');
    var lang = params.get('language') || '';
    if (Array.from(langSelect.options).some(function (option) { return option.value === lang; })) langSelect.value = lang;
    activeGroups = new Set(params.getAll('cohort').filter(function (name) { return /^[a-zA-Z0-9_.-]{1,48}$/.test(name); }));
    fromDate.value = params.get('from') || '';
    toDate.value = params.get('to') || '';
  })();

  function groupName(value) { return value === 'default' ? uiText('report.ungrouped') : value; }

  function renderFilterControls(cohorts) {
    var legend = groupField.querySelector('legend');
    groupField.replaceChildren(legend);
    new Set([...cohorts, ...activeGroups]).forEach(function (name) {
      var label = document.createElement('label'), box = document.createElement('input');
      box.type = 'checkbox';
      box.value = name;
      box.checked = activeGroups.has(name);
      label.append(box, groupName(name));
      groupField.append(label);
    });
    if (!cohorts.length && !activeGroups.size) {
      var empty = document.createElement('p');
      empty.textContent = uiText('report.noGroups');
      groupField.append(empty);
    }
    chips.replaceChildren();
    for (const [key, value] of filterQuery()) {
      var chip = document.createElement('button');
      var labels = {cohort:groupName(value),from:uiText('report.fromPrefix') + value,to:uiText('report.untilPrefix') + value,
        language:value.toUpperCase(),days:uiText('Last {n} days',{n:value})};
      chip.textContent = labels[key] + ' ×';
      chip.setAttribute('aria-label',uiText('report.removeFilter') + labels[key]);
      chip.onclick = function () {
        if (key === 'cohort') activeGroups.delete(value);
        if (key === 'language') langSelect.value='';
        if (key === 'days') periodSelect.value='';
        if (key === 'from') fromDate.value='';
        if (key === 'to') toDate.value='';
        loadResponses();
      };
      chips.appendChild(chip);
    }
    chips.hidden = !chips.childElementCount;
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

  // A labelled bar for any measure: the label left, the value and detail right.
  function barRow(name, amountText, detailText, value, max, className) {
    var row = document.createElement('div');
    row.className = 'el-chart-row' + (className ? ' ' + className : '');
    var label = document.createElement('span');
    label.className = 'el-chart-label';
    label.setAttribute('translate', 'no');
    label.textContent = name;
    var amount = document.createElement('span');
    amount.className = 'el-chart-value';
    amount.setAttribute('translate', 'no');
    var strong = document.createElement('strong');
    strong.textContent = amountText;
    amount.appendChild(strong);
    if (detailText) {
      var detail = document.createElement('span');
      detail.textContent = detailText;
      amount.append(' ', detail);
    }
    row.append(label, amount, chartBar(value, '', max || 100));
    return row;
  }

  function chartNote(text) {
    var note = document.createElement('p');
    note.className = 'el-chart-note';
    note.textContent = text;
    return note;
  }

  // A figure with an optional definition: an info button shows it, and the value is described by it.
  var definitionCount = 0;
  function splitFigure(label, value, good, own, definition) {
    var item = document.createElement('div');
    item.className = 'el-split-figure' + (good ? ' is-good' : '') + (definition ? ' has-definition' : '');
    var term = document.createElement('dt');
    term.textContent = label;
    if (own) term.setAttribute('translate', 'no');
    var amount = document.createElement('dd');
    amount.className = 'academy-metric-value';
    amount.textContent = value;
    item.append(term, amount);
    if (definition) {
      var text = document.createElement('dd');
      text.className = 'academy-metric-definition';
      text.id = 'academy-metric-definition-' + (++definitionCount);
      text.setAttribute('translate', 'no');
      text.hidden = true;
      text.textContent = definition;
      var info = document.createElement('button');
      info.type = 'button';
      info.className = 'academy-metric-info';
      info.textContent = 'i';
      info.setAttribute('translate', 'no');
      info.setAttribute('aria-label', uiText('About {name}', { name: label }));
      info.setAttribute('aria-expanded', 'false');
      info.setAttribute('aria-controls', text.id);
      info.addEventListener('click', function () {
        text.hidden = !text.hidden;
        info.setAttribute('aria-expanded', String(!text.hidden));
      });
      term.append(' ', info);
      amount.setAttribute('aria-describedby', text.id);
      item.appendChild(text);
    }
    return item;
  }

  // A station's time is compared with its estimate only from this many timed sessions.
  var MIN_ESTIMATE_SAMPLE = 5;

  // Time spent: course figures, then one bar per station that opens into its steps.
  function renderTime(data, reportLang, courseLang) {
    var summary = data.summary || {};
    var active = summary.activeSeconds;
    var title = document.createElement('h2');
    title.id = 'el-resp-time-title';
    title.setAttribute('translate', 'no');
    title.textContent = uiText('Time spent');
    timeEl.hidden = !(data.funnel || []).length;
    if (!active) {
      timeEl.replaceChildren(title, chartNote(uiText('No measured time yet. Time is only measured for learners who chose to share.')));
      return;
    }
    var figures = document.createElement('dl');
    figures.className = 'el-split-stats el-time-figures';
    figures.append(
      splitFigure(uiText('Median active time'), formatDuration(active.median), false, true, uiText('The middle active time per session, only for sessions with measured time. Active time counts while the page is open and the learner is using it, up to 15 minutes per visit.')),
      splitFigure(uiText('Middle half'), formatDurationRange(active.p25, active.p75), false, true, uiText('Half of the sessions with measured time fall between these two values (25th to 75th percentile).')),
      splitFigure(uiText('Sessions with measured time'), String(summary.timedSessions || active.count), false, true, uiText('Shared sessions whose active time was measured. This only happens after consent to time measurement.'))
    );
    var stations = (data.stations || []).filter(function (station) { return station.time; });
    var slowestStation = Math.max.apply(null, stations.map(function (station) { return station.time.median; }).concat(1));
    var list = document.createElement('div');
    list.className = 'el-time-stations';
    stations.forEach(function (station) {
      var estimate = Number(station.estimatedMinutes) || 0;
      var difference = estimate > 0 ? station.time.median - estimate * 60 : 0;
      var notable = estimate > 0 && station.time.count >= MIN_ESTIMATE_SAMPLE && Math.abs(difference) > estimate * 60 * 0.5;
      var detail = 'P75 ' + formatDuration(station.time.p75) + (estimate ? ' · ' + uiText('estimated {n} min', { n: estimate }) : '');
      var row = barRow(Model.getLocalized(station.moduleTitle, reportLang, courseLang), formatDuration(station.time.median),
        detail, station.time.median, slowestStation, notable ? (difference > 0 ? 'is-over' : 'is-under') : '');
      if (notable) {
        var flag = document.createElement('span');
        flag.className = 'el-chart-flag' + (difference < 0 ? ' is-under' : '');
        flag.textContent = difference > 0 ? uiText('+{amount} longer than estimated', { amount: formatDuration(difference) }) : uiText('−{amount} shorter than estimated', { amount: formatDuration(-difference) });
        flag.title = uiText('Shown when the median differs from the estimate by more than half and at least {n} sessions have measured time.', { n: MIN_ESTIMATE_SAMPLE });
        row.querySelector('.el-chart-value').append(' ', flag);
      }
      var item = document.createElement('details');
      item.className = 'el-time-station';
      // Opt out of the shared disclosure enhancer, which would restyle this chart row as a panel.
      item._appDisclosure = true;
      var head = document.createElement('summary');
      head.appendChild(row);
      var steps = document.createElement('div');
      steps.className = 'el-chart-rows el-time-steps';
      var stationSteps = (data.funnel || []).filter(function (step) { return step.moduleId === station.moduleId && step.time; });
      var slowestStep = Math.max.apply(null, stationSteps.map(function (step) { return step.time.median; }).concat(1));
      stationSteps.forEach(function (step) {
        steps.appendChild(barRow(Model.getLocalized(step.stepTitle, reportLang, courseLang), formatDuration(step.time.median),
          'P75 ' + formatDuration(step.time.p75) + ' · ' + uiText('n {n}', { n: step.time.count }), step.time.median, slowestStep));
      });
      item.append(head, steps);
      list.appendChild(item);
    });
    var distribution = document.createElement('figure');
    distribution.className = 'academy-time-distribution';
    var totals = stations.map(function (station) { return station.activeSecondsTotal || 0; });
    var total = totals.reduce(function (sum, value) { return sum+value; },0);
    var hasDistribution = totals.filter(function (seconds) { return seconds > 0; }).length > 1;
    if (hasDistribution) {
      var svg = svgNode('svg',{viewBox:'0 0 100 8',preserveAspectRatio:'none','aria-hidden':'true'});
      var shares = document.createElement('table');
      var shareCaption = shares.createCaption();
      shareCaption.textContent = uiText('report.stationTimeShare');
      var columns = shares.createTHead().insertRow();
      [uiText('report.stationColumn'), uiText('report.timeShareColumn')].forEach(function (name) {
        var heading = document.createElement('th');
        heading.scope = 'col';
        heading.textContent = name;
        columns.append(heading);
      });
      var values = shares.createTBody();
      var left = 0;
      stations.forEach(function (station,i) {
        var percent = 100*totals[i]/total;
        var row = values.insertRow();
        var stationName = document.createElement('th');
        stationName.scope = 'row';
        stationName.textContent = Model.getLocalized(station.moduleTitle, reportLang, courseLang);
        row.append(stationName);
        row.insertCell().textContent = formatPercent(percent);
        svg.appendChild(svgNode('rect',{x:left,y:0,width:percent,height:8,class:'academy-time-segment tone-'+i%4}));
        left += percent;
      });
      distribution.append(svg, shares);
    }
    distribution.hidden = !hasDistribution;
    timeEl.replaceChildren(title, figures, distribution, list, chartNote(uiText('n = {n} sessions with measured time. Active time counts only while the page is open and the learner is using it, up to 15 minutes per visit. Open a station for the time per step.', { n: summary.timedSessions || active.count })));
  }

  var SVG_NS = 'http://www.w3.org/2000/svg';
  function svgNode(name, attributes) {
    var node = document.createElementNS(SVG_NS, name);
    Object.keys(attributes || {}).forEach(function (key) { node.setAttribute(key, attributes[key]); });
    return node;
  }
  function weekLabel(isoDate) {
    return i18n.date(new Date(isoDate + 'T00:00:00Z'), { day: 'numeric', month: 'short', timeZone: 'UTC' });
  }

  // Weekly starts (neutral) with completions (mint) drawn over them, plus a table for screen readers.
  function renderTrend(weekly) {
    var weeks = Array.isArray(weekly) ? weekly : [];
    trendEl.hidden = !weeks.length;
    if (trendEl.hidden) {
      trendEl.replaceChildren();
      return;
    }
    var title = document.createElement('h2');
    title.id = 'el-resp-trend-title';
    title.setAttribute('translate', 'no');
    title.textContent = uiText('Weekly activity');
    if (weeks.length === 1) {
      var only = weeks[0];
      var description = uiText('Week of') + ' ' + weekLabel(only.week) + ' · ' + uiText('Started') + ' ' + only.started + ' · ' + uiText('Completed') + ' ' + only.completed;
      if (only.revision) description += ' · v' + only.revision.revision;
      trendEl.replaceChildren(title, chartNote(description));
      return;
    }
    var legend = document.createElement('div');
    legend.className = 'el-trend-legend';
    legend.setAttribute('aria-hidden', 'true');
    [['is-started', uiText('Started')], ['is-completed', uiText('Completed')]].forEach(function (entry) {
      var key = document.createElement('span');
      key.className = 'el-trend-key ' + entry[0];
      key.textContent = entry[1];
      legend.appendChild(key);
    });
    var started = weeks.reduce(function (sum, week) { return sum + week.started; }, 0);
    var completed = weeks.reduce(function (sum, week) { return sum + week.completed; }, 0);
    // Drawn at the card's real width so labels keep their size; redrawn on resize.
    var width = Math.max(260, Math.round(trendEl.clientWidth - 40));
    trendWidth = width;
    var plot = 132;
    var slot = width / weeks.length;
    var barWidth = Math.max(4, Math.min(28, slot * 0.58));
    var most = Math.max.apply(null, weeks.map(function (week) { return week.started; }).concat(1));
    var chart = svgNode('svg', { viewBox: '0 0 ' + width + ' 160', width: width, height: 160, class: 'el-trend-chart', role: 'img',
      'aria-label': uiText('{weeks} weeks: {started} sessions started, {completed} completed.', { weeks: weeks.length, started: started, completed: completed }) });
    chart.appendChild(svgNode('line', { x1: 0, x2: width, y1: plot + 0.5, y2: plot + 0.5, class: 'el-trend-axis' }));
    var every = Math.ceil(weeks.length / Math.max(2, Math.floor(width / 84)));
    weeks.forEach(function (week, index) {
      var x = index * slot + (slot - barWidth) / 2;
      var group = svgNode('g');
      var hint = svgNode('title');
      hint.textContent = uiText('Week of') + ' ' + weekLabel(week.week) + ': ' + week.started + ' · ' + week.completed;
      group.appendChild(hint);
      var startHeight = plot * week.started / most;
      var doneHeight = plot * week.completed / most;
      group.appendChild(svgNode('rect', { x: x, y: plot - startHeight, width: barWidth, height: startHeight, rx: 3, class: 'el-trend-started' }));
      group.appendChild(svgNode('rect', { x: x, y: plot - doneHeight, width: barWidth, height: doneHeight, rx: 3, class: 'el-trend-completed' }));
      if (week.revision) {
        var marker = svgNode('line', {x1: x+barWidth/2, x2: x+barWidth/2, y1: 4, y2: plot, class:'academy-report-revision'});
        var caption = svgNode('title');
        caption.textContent = 'v' + week.revision.revision + ' · ' + i18n.date(week.revision.at * 1000, { dateStyle: 'medium', timeZone: 'UTC' });
        marker.appendChild(caption);
        group.appendChild(marker);
      }
      chart.appendChild(group);
      if (index % every === 0 || index === weeks.length - 1) {
        var tick = svgNode('text', { x: x + barWidth / 2, y: 154, 'text-anchor': 'middle', class: 'el-trend-label' });
        tick.textContent = weekLabel(week.week);
        chart.appendChild(tick);
      }
    });
    var table = document.createElement('table');
    table.className = 'academy-week-table';
    var caption = document.createElement('caption');
    caption.textContent = uiText('Weekly activity');
    var headRow = table.createTHead().insertRow();
    [uiText('Week of'), uiText('Started'), uiText('Completed'), uiText('report.publicVersion')].forEach(function (text) {
      var cell = document.createElement('th');
      cell.scope = 'col';
      cell.textContent = text;
      headRow.appendChild(cell);
    });
    var body = table.createTBody();
    weeks.forEach(function (week) {
      var row = body.insertRow();
      [weekLabel(week.week), week.started, week.completed, week.revision ? 'v' + week.revision.revision : '—'].forEach(function (value) { row.insertCell().textContent = String(value); });
    });
    table.prepend(caption);
    var details = document.createElement('details');
    details.className = 'academy-chart-table';
    var hint = document.createElement('summary');
    hint.textContent = uiText('report.viewTable');
    details.append(hint,table);
    var figure = document.createElement('figure');
    var captionNode = document.createElement('figcaption');
    captionNode.textContent = uiText('{weeks} weeks: {started} sessions started, {completed} completed.', {weeks: weeks.length, started: started, completed: completed});
    figure.append(chart,captionNode);
    trendEl.replaceChildren(title, legend, figure, details, chartNote(uiText('Sessions by the week they started (Monday to Sunday).')));
  }

  var trendWidth = 0;
  if (window.ResizeObserver) {
    new window.ResizeObserver(function () {
      if (!lastAnalytics || trendEl.hidden) return;
      if (Math.abs(Math.round(trendEl.clientWidth - 40) - trendWidth) > 8) renderTrend(lastAnalytics.data.weekly);
    }).observe(trendEl);
  }

  // One bar split across all answers: correct in mint, other answers in alternating neutrals.
  function answerMix(keys, counts, rightKeys, text) {
    var total = keys.reduce(function (sum, key) { return sum + (counts[key] || 0); }, 0);
    var mix = document.createElement('div');
    mix.className = 'academy-answer-mix';
    var bar = svgNode('svg', { viewBox: '0 0 100 8', preserveAspectRatio: 'none', class: 'academy-answer-bar', 'aria-hidden': 'true', focusable: 'false' });
    var x = 0;
    var others = 0;
    keys.forEach(function (key) {
      var width = total ? 100 * (counts[key] || 0) / total : 0;
      if (!width) return;
      bar.appendChild(svgNode('rect', { x: x, y: 0, width: width, height: 8,
        class: rightKeys[key] ? 'is-correct' : 'is-other tone-' + (others++ % 2) }));
      x += width;
    });
    var summary = document.createElement('p');
    summary.className = 'academy-answer-mix-text';
    summary.setAttribute('translate', 'no');
    summary.textContent = text;
    mix.append(bar, summary);
    return mix;
  }

  // Graded questions can be listed with the least often correctly answered first.
  var questionOrder = 'hardest';
  function applyQuestionOrder() {
    var cards = Array.from(blocksEl.children);
    cards.sort(function (a, b) {
      if (questionOrder === 'hardest') {
        var left = a.dataset.correct;
        var right = b.dataset.correct;
        if (left !== undefined && right !== undefined && Number(left) !== Number(right)) return Number(left) - Number(right);
        if (left !== undefined && right === undefined) return -1;
        if (left === undefined && right !== undefined) return 1;
      }
      return Number(a.dataset.order) - Number(b.dataset.order);
    });
    blocksEl.append.apply(blocksEl, cards);
  }
  function renderOrderControl() {
    orderEl.replaceChildren();
    orderEl.hidden = blocksEl.querySelectorAll('[data-correct]').length < 2;
    if (orderEl.hidden) return;
    var name = document.createElement('span');
    name.id = 'el-resp-order-label';
    name.className = 'el-resp-order-label';
    name.textContent = uiText('Question order');
    var group = document.createElement('div');
    group.className = 'el-seg';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-labelledby', name.id);
    [['course', uiText('Course order')], ['hardest', uiText('Least often correct first')]].forEach(function (choice) {
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = choice[1];
      button.setAttribute('aria-pressed', String(questionOrder === choice[0]));
      button.addEventListener('click', function () {
        questionOrder = choice[0];
        renderOrderControl();
        applyQuestionOrder();
        orderEl.querySelector('[aria-pressed="true"]').focus();
      });
      group.appendChild(button);
    });
    orderEl.setAttribute('translate', 'no');
    orderEl.append(name, group);
  }

  // Completion as two shares of one bar, with the supporting figures beneath.
  var lastAnalytics = null;
  function renderSummary(summary) {
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
      splitFigure(uiText('Completed'), total ? formatPercent(rate) : '—', true, false, uiText('Shared sessions that reached the end of the expedition, divided by all shared sessions within your filters.')),
      splitFigure(uiText('Not completed'), total ? formatPercent(100 - rate) : '—', false, true, uiText('Shared sessions within your filters that have not reached the end yet.'))
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
    // Wall-clock duration is not shown: only measured active time is reported.
    var active = summary.activeSeconds;
    figures.append(
      splitFigure(uiText('Testers'), String(total), false, false, uiText('Shared sessions within your filters. Private sessions are never counted.')),
      splitFigure(uiText('Median active time'), active ? formatDuration(active.median) : '—', false, true, uiText('The middle active time per session, only for sessions with measured time. Active time counts while the page is open and the learner is using it, up to 15 minutes per visit.'))
    );
    // Each pilot rating is its own 1–5 figure; definitions sit with the figure they explain.
    [['avgClarity', uiText('Clarity'), uiText('Average clarity score from pilot feedback, on a scale from 1 (unclear) to 5 (very clear).')], ['avgEngagement', uiText('Engagement'), uiText('Average engagement score from pilot feedback, on a scale from 1 (low) to 5 (very engaged).')]].forEach(function (rating) {
      var value = summary[rating[0]];
      if (value === null || value === undefined) return;
      figures.append(splitFigure(rating[1], uiText('{value} / 5', { value: formatScore(value) }), false, true, rating[2]));
    });
    kpisEl.replaceChildren(title, shares, bar, counts, figures);
  }

  async function loadResponses() {
    var sequence = ++requestId;
    retry.hidden = true;
    // UX-119: Keep existing report visible with subtle Updating state while switching filters
    if (hasLoadedOnce && !report.hidden) {
      status.textContent = uiText('report.updating');
      report.setAttribute('aria-busy', 'true');
      report.classList.add('el-resp-updating');
    } else {
      report.setAttribute('aria-busy', 'true');
      status.textContent = uiText('Loading responses…');
      report.hidden = true;
    }
    try {
      var qs = filterQuery();
      syncAddress();
      var base = '/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/responses';
      var resp = await client.authFetch(base + (qs.size ? '?' + qs : ''));
      var data = await resp.json();
      if (sequence !== requestId) return;
      if (!resp.ok) throw new Error(data.error || uiText('Could not load responses.'));
      var courseLang = data.expedition.defaultLanguage || 'nl';
      var reportLang = langSelect.value || i18n.language;
      label.textContent = data.expedition.title || '';
      document.title = label.textContent ? uiText('report.title') + ' · ' + label.textContent + ' · xPED Academy' : pageTitle;
      document.dispatchEvent(new CustomEvent('academy:course-title',{detail:label.textContent}));
      renderFilterControls(data.cohorts || []);
      labelPeriods();
      status.textContent = uiText('report.filteredResults');
      report.classList.remove('el-resp-updating');
      report.setAttribute('aria-busy', 'false');
      report.hidden = false;
      hasLoadedOnce = true;

      var s = data.summary || {};
      renderSummary(s);
      lastAnalytics = { data: data, reportLang: reportLang, courseLang: courseLang };
      renderTime(data, reportLang, courseLang);
      renderTrend(data.weekly);

      // Reach per step, grouped by station
      funnelEl.textContent = '';
      var maxReached = Math.max(1, s.totalSessions || 1);
      var stationGroup = null;
      var stationId = null;
      var drops = (data.funnel || []).map(function (row) { return row.lostFromPrevious || 0; });
      var largestDrop = Math.max.apply(null, drops.concat(0));
      const measuredStations = (data.stations || []).filter(station => Number.isFinite(station.reached));
      if (measuredStations.length > 1 && s.totalSessions > 0) {
        const route = measuredStations.map(station => ({
          title:Model.getLocalized(station.moduleTitle,reportLang,courseLang),
          reached:station.reached / s.totalSessions,
        }));
        const label = uiText('report.stationReach') + ' · ' +
          route.map(station => station.title + ' ' + formatPercent(100 * station.reached)).join(', ');
        funnelEl.appendChild(window.XpedAcademyControls.routeStrip(route,{size:'regular',label}));
      }
      (data.funnel || []).forEach(function (row, index) {
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
        var pct = (row.reached / maxReached) * 100;
        var reachRow = chartRow(Model.getLocalized(row.stepTitle, reportLang, courseLang), row.reached, pct);
        if (drops[index]) {
          var previous = row.previousReached;
          var drop = document.createElement('span');
          drop.className = 'el-chart-drop' + (drops[index] === largestDrop ? ' is-largest' : '');
          drop.title = uiText('Drop-off from the previous step');
          drop.textContent = '−' + drops[index] + ' (−' + formatPercent(100 * drops[index] / previous) + ')';
          reachRow.querySelector('.el-chart-value').append(' ', drop);
        }
        var stepLink = document.createElement('button');
        stepLink.className = 'academy-report-step';
        stepLink.textContent = Model.getLocalized(row.stepTitle, reportLang, courseLang);
        stepLink.addEventListener('click', function () { window.Xped.reportDetails.openStep(row.stepId); });
        var stepSummary = document.createElement('span');
        stepSummary.className = 'academy-step-summary';
        stepSummary.id = 'academy-step-summary-' + index;
        stepSummary.setAttribute('role', 'tooltip');
        stepSummary.setAttribute('translate', 'no');
        stepSummary.textContent = uiText('Reached {reached} · continued {continued} · median active time {time}', {
          reached: row.reached,
          continued: row.continued === undefined || row.continued === null ? '—' : row.continued,
          time: row.time ? formatDuration(row.time.median) : uiText('not measured'),
        });
        stepLink.setAttribute('aria-describedby', stepSummary.id);
        stepLink.addEventListener('keydown', function (event) {
          if (event.key === 'Escape') stepSummary.classList.add('is-dismissed');
        });
        ['blur', 'mouseleave'].forEach(function (type) {
          stepLink.addEventListener(type, function () { stepSummary.classList.remove('is-dismissed'); });
        });
        reachRow.querySelector('.el-chart-label').replaceChildren(stepLink, stepSummary);
        stationGroup.appendChild(reachRow);
      });
      if (funnelEl.childElementCount) {
        let caption = 'n = ' + (s.totalSessions || 0);
        if (drops.length > 1) caption += ' · ' + uiText('report.stepDropMeaning');
        if (largestDrop) {
          const steps = data.funnel.filter((row, i) => drops[i] === largestDrop)
            .map(row => Model.getLocalized(row.stepTitle,reportLang,courseLang));
          caption += ' · ' + uiText('report.worstDrop') + steps.join(', ') + ' (−' + largestDrop + ')';
        }
        funnelEl.appendChild(chartNote(caption));
      }

      document.getElementById('el-resp-funnel-card').hidden = !funnelEl.childElementCount;

      // Question charts (UX-116, UX-117, UX-120)
      blocksEl.textContent = '';
      var statsMap = data.blockStats || {};
      var cardOrder = 0;
      (data.expedition.modules || []).forEach(function (mod, mIdx) {
        (mod.steps || []).forEach(function (step, sIdx) {
          (step.blocks || []).forEach(function (blk) {
            var agg = statsMap[blk.id];
            if (!agg) return;
            var name = activityName(blk.type);
            var position = uiText('Station ') + (mIdx + 1) + ' · ' + (reportLang === 'de' ? uiText('Schritt') : reportLang === 'nl' ? uiText('Stap') : uiText('Step')) + ' ' + (sIdx + 1);
            var card = document.createElement('article');
            card.className = 'el-exp-card';
            card.dataset.order = String(cardOrder++);
            card.dataset.step = step.id;
            var h = document.createElement('h2');
            h.setAttribute('translate', 'no');
            var authoredTitle = Model.getLocalized(blk.data.question || blk.data.statement || blk.data.prompt || blk.data.title, reportLang, courseLang);
            h.textContent = authoredTitle || name + ' · ' + position;
            // The statement is clamped to two lines; the full text stays readable on hover and to assistive technology.
            if (authoredTitle) h.title = authoredTitle;
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
              var rightKeys = {};
              keys.forEach(function (k) {
                var cnt = agg.counts[k] || 0;
                var pct = Math.min(100, Math.round((cnt / denom) * 100));
                var opt = (blk.data.options || []).find(function (o) { return o.id === k; });
                var isRight = (blk.type === 'myth_fact' && k === (blk.data.correctAnswer || 'myth')) || !!(opt && opt.isCorrect && blk.data.graded !== false);
                var name = opt ? Model.getLocalized(opt.label, reportLang, courseLang) : (k === 'myth' || k === 'fact' ? Model.ui(reportLang, k) : k);
                rightKeys[k] = isRight;
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
              if (agg.gradedAnswers) {
                card.dataset.correct = String(agg.correctAnswers / agg.gradedAnswers);
                var correctText = uiText('{pct} answered correctly', {pct: formatPercent(100 * agg.correctAnswers / agg.gradedAnswers)}) + ' · ' + agg.correctAnswers + '/' + agg.gradedAnswers;
                if (isMulti) card.appendChild(chartNote(correctText));
                else card.insertBefore(answerMix(keys, agg.counts, rightKeys, correctText), h.nextSibling);
              }
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
                if (total > agg.samples.length) cntMeta.textContent += ' ' + uiText('Export the CSV for all responses.');
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
      renderOrderControl();
      applyQuestionOrder();
      window.Xped.reportDetails.render(data);

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
          m.textContent = (item.moduleTitle || uiText('Station')) + ' · ' + (item.stepTitle || uiText('Step')) + ' (' + groupName(item.cohort || 'default') + ' · ' + String(item.language || 'nl').toUpperCase() + ')';
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
            if (qs.size) qJump.set('filters', qs.toString());
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
          left.textContent = '[' + item.cohort + ' · ' + String(item.language || 'nl').toUpperCase() + '] Clarity: ' + (item.clarity || '—') + '/5 · Engagement: ' + (item.engagement || '—') + '/5 — ' + (item.comment || uiText('(no comment)'));
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

  async function downloadCsv(filtered, extension = 'csv') {
    try {
      var qs = filtered ? filterQuery() : new URLSearchParams();
      var url = '/api/elearning/expeditions/' + encodeURIComponent(expeditionId) + '/responses/export.' + extension + (qs.size ? '?' + qs : '');
      var resp = await client.authFetch(url);
      if (!resp.ok) throw new Error(uiText('Could not export responses.'));
      var suffix = filtered && qs.size ? ('-' + Array.from(qs.values()).join('-')) : '';
      await platformDownload.downloadResponseBlob(resp, 'xped-responses-' + expeditionId + suffix + '.' + extension);
    } catch (err) {
      if (err.code !== 'auth/session-changed') platformUx.toast(err.message, { type: 'error' });
    }
  }

  if (exportFilteredBtn) exportFilteredBtn.addEventListener('click', function () { downloadCsv(true); });
  document.getElementById('el-resp-export-xlsx').addEventListener('click', function () { downloadCsv(true, 'xlsx'); });

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
    document.title = pageTitle;
    document.dispatchEvent(new CustomEvent('academy:course-title',{detail:''}));
    lastAnalytics = null;
    window.Xped.reportDetails.reset();
    [kpisEl, funnelEl, blocksEl, feedbackEl, timeEl, trendEl, orderEl, document.getElementById('el-resp-comments')].forEach(function (el) { el.replaceChildren(); });
    timeEl.hidden = trendEl.hidden = orderEl.hidden = true;
    groupField.querySelectorAll('label,p').forEach(function (item) { item.remove(); });
    chips.hidden = true;
    if (user) loadResponses();
    else status.textContent = uiText('Sign in to view responses.');
  }
  if (auth) auth.onAuthStateChanged(accountChanged);
  else accountChanged(null);
})();
