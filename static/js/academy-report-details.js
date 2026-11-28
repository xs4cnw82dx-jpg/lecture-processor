(function (root) {
  'use strict';

  const de = document.documentElement.lang === 'de';
  const copy = (nl, german) => de ? german : nl;
  // A missing count shows as a dash, never as NaN.
  const num = value => value === null || value === undefined || Number.isNaN(Number(value)) ? '—' : new Intl.NumberFormat(de ? 'de-DE' : 'nl-NL').format(value);
  const pct = (n, d) => d ? new Intl.NumberFormat(de ? 'de-DE' : 'nl-NL', { style: 'percent', maximumFractionDigits: 1 }).format(n / d) : '—';
  const duration = s => typeof s === 'number' ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : '—';
  const el = (tag, text) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const local = value => root.XpedElearningModel.getLocalized(value, de ? 'de' : 'nl', state.expedition.defaultLanguage);
  const host = document.getElementById('academy-station-report');
  const dialog = document.getElementById('academy-step-details');
  const columns = [
    ['name', copy('Station of stap', 'Station oder Schritt')],
    ['reached', copy('Bereikt', 'Erreicht')],
    ['continued', copy('Verder gegaan', 'Weitergegangen')],
    ['lost', copy('Niet verder', 'Nicht weiter')],
    ['time', copy('Mediane tijd', 'Medianzeit')],
    ['estimatedMinutes', copy('Richttijd', 'Richtzeit')],
    ['delta', copy('Verschil', 'Abweichung')],
    ['score', copy('Goed beantwoord', 'Richtig beantwortet')],
    ['comments', copy('Opmerkingen', 'Kommentare')],
  ];
  let state, selected = -1, sort = null, descending = false;
  const expanded = new Set();

  function button(text, action) {
    const node = el('button', text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  }

  function table(headers) {
    const node = el('table');
    const tr = node.createTHead().insertRow();
    for (const title of headers) {
      const th = el('th', title);
      th.scope = 'col';
      tr.append(th);
    }
    node.createTBody();
    return node;
  }

  function tableToggle(caption, headers, rows) {
    const details = el('details');
    details.className = 'academy-chart-table';
    const data = table(headers);
    data.createCaption().textContent = caption;
    rows.forEach(row => {
      const tr = data.tBodies[0].insertRow();
      row.forEach(value => { tr.insertCell().textContent = value; });
    });
    details.append(el('summary', copy('Tabel bekijken', 'Datentabelle anzeigen')), data);
    return details;
  }

  const dropLabel = copy('Uitval vanuit de vorige stap', 'Abbruch seit dem vorherigen Schritt');
  const withShare = (count, total) => num(count) + ' (' + pct(count, total) + ')';
  const drop = step => step.previousReached ? withShare(step.lostFromPrevious, step.previousReached) : '—';

  function timeDistribution(step) {
    const bins = step.timeHistogram || [];
    const title = copy('Verdeling van de actieve tijd', 'Verteilung der aktiven Zeit');
    const section = el('section');
    section.className = 'academy-time-histogram';
    section.append(el('h3', title));
    if (!bins.length) {
      section.append(el('p', copy('Nog geen gemeten tijd voor deze stap.', 'Für diesen Schritt wurde noch keine Zeit gemessen.')));
      return section;
    }
    const interval = bin => duration(bin.fromSeconds) + '–' + duration(bin.fromSeconds + 29);
    if (bins.length === 1) {
      const bin = bins[0];
      const noun = bin.sessionCount === 1 ? copy('sessie', 'Sitzung') : copy('sessies', 'Sitzungen');
      section.append(el('p', num(bin.sessionCount) + ' ' + noun + ' · ' + interval(bin) + ' (min:s)'));
      return section;
    }
    const figure = el('figure');
    const caption = copy('Aantal sessies per 30 seconden', 'Sitzungen je 30 Sekunden');
    figure.append(el('figcaption', caption));
    const list = el('ul');
    list.setAttribute('aria-hidden', 'true');
    const max = Math.max(...bins.map(bin => bin.sessionCount));
    for (const bin of bins) {
      const bar = el('progress');
      bar.className = 'el-chart-bar';
      bar.max = max;
      bar.value = bin.sessionCount;
      const item = el('li');
      item.append(el('span', interval(bin)), bar, el('strong', num(bin.sessionCount)));
      list.append(item);
    }
    figure.append(list);
    section.append(figure, tableToggle(caption, [copy('Tijd (min:s)', 'Zeit (Min:s)'), copy('Sessies', 'Sitzungen')],
      bins.map(bin => [interval(bin), num(bin.sessionCount)])));
    return section;
  }

  function openStep(id) {
    selected = state.funnel.findIndex(row => row.stepId === id);
    if (selected < 0) return;
    const current = state.funnel[selected];
    const module = state.expedition.modules.find(m => m.id === current.moduleId);
    const step = module.steps.find(s => s.id === id);
    const body = dialog.querySelector('[data-detail-body]');
    body.replaceChildren();
    dialog.querySelector('h2').textContent = local(current.stepTitle);
    dialog.querySelector('[data-detail-parent]').textContent = local(current.moduleTitle);
    const metrics = el('dl');
    const add = (k, v) => { metrics.append(el('dt', k), el('dd', v)); };
    add(copy('Bereikt', 'Erreicht'), num(current.reached) + ' / ' + num(state.summary.totalSessions) + ' (' + pct(current.reached, state.summary.totalSessions) + ')');
    if (current.previousReached != null) add(dropLabel, drop(current));
    add(copy('Verder gegaan', 'Weitergegangen'), num(current.continued) + ' / ' + num(current.reached));
    add(copy('Mediane actieve tijd', 'Mediane aktive Zeit'), current.time ? duration(current.time.median) + ' · P25–P75 ' + duration(current.time.p25) + '–' + duration(current.time.p75) + ' · n = ' + num(current.time.count) : '—');
    add(copy('Goed beantwoord', 'Richtig beantwortet'), num(current.correctAnswers) + ' / ' + num(current.gradedAnswers));
    body.append(metrics, timeDistribution(current));
    const results = Array.from(document.querySelectorAll('#el-resp-blocks > [data-step]')).filter(card => card.dataset.step === id);
    if (results.length) {
      body.append(el('h3', copy('Antwoorden', 'Antworten')));
      results.forEach(card => {
        const clone = card.cloneNode(true);
        clone.removeAttribute('id');
        clone.querySelectorAll('[id]').forEach(child => child.removeAttribute('id'));
        clone.querySelectorAll('button, details').forEach(child => child.remove());
        body.append(clone);
      });
    } else if (step.blocks.length) {
      body.append(el('p', copy('Voor deze stap zijn geen antwoorden gedeeld.', 'Für diesen Schritt wurden keine Antworten geteilt.')));
    }
    const notes = (state.stepComments || []).filter(n => n.stepId === id);
    if (notes.length) {
      body.append(el('h3', copy('Opmerkingen', 'Kommentare')));
      notes.forEach(note => body.append(el('blockquote', note.comment)));
    }
    const params = new URLSearchParams({ step: id, module: module.id, from: 'responses' });
    if (location.search) params.set('filters',location.search.slice(1));
    dialog.querySelector('[data-detail-edit]').href = root.XpedElearningModel.coursePaths(state.expedition.id).edit + '?' + params;
    dialog.querySelector('[data-detail-prev]').disabled = selected === 0;
    dialog.querySelector('[data-detail-next]').disabled = selected === state.funnel.length - 1;
    if (!dialog.open) dialog.showModal();
    dialog.querySelector('h2').focus();
  }

  dialog.querySelector('[data-detail-prev]').onclick = () => openStep(state.funnel[selected - 1].stepId);
  dialog.querySelector('[data-detail-next]').onclick = () => openStep(state.funnel[selected + 1].stepId);

  function sortValue(row, key) {
    if (key === 'name') return local(row.moduleTitle);
    if (key === 'time') return row.time?.median;
    if (key === 'score') return row.gradedAnswers ? row.correctAnswers / row.gradedAnswers : null;
    if (key === 'delta') return row.time && row.estimatedMinutes ? row.time.median - row.estimatedMinutes * 60 : null;
    return row[key];
  }

  function cells(tr, row, name) {
    tr.insertCell().append(name);
    const diff = sortValue(row, 'delta');
    [num(row.reached), num(row.continued), num(row.lost ?? (row.reached - row.continued)), duration(row.time?.median),
      row.estimatedMinutes ? num(row.estimatedMinutes) + ' min' : '—', diff == null ? '—' : (diff < 0 ? '−' : '+') + duration(Math.abs(diff)),
      pct(row.correctAnswers, row.gradedAnswers), num(row.comments)].forEach(value => { tr.insertCell().textContent = value; });
  }

  function stations(focusKey) {
    const title = el('h2', copy('Vergelijk de stations', 'Stationen vergleichen'));
    const data = table(columns.map(entry => entry[1]));
    data.createCaption().textContent = copy('Resultaten per station en stap', 'Ergebnisse pro Station und Schritt');
    columns.forEach(([key, label], index) => {
      const th = data.tHead.rows[0].cells[index];
      const trigger = button(label, () => {
        descending = sort === key ? !descending : !['name', 'time','estimatedMinutes'].includes(key);
        sort = key;
        stations('sort-' + key);
      });
      trigger.setAttribute('aria-label',label);
      trigger.dataset.focusKey = 'sort-' + key;
      th.replaceChildren(trigger);
      if (sort === key) th.setAttribute('aria-sort', descending ? 'descending' : 'ascending');
    });
    const items = [...state.stations];
    if (sort) items.sort((a, b) => {
      const x = sortValue(a, sort), y = sortValue(b, sort);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      return (typeof x === 'string' ? x.localeCompare(y, de ? 'de' : 'nl') : x - y) * (descending ? -1 : 1);
    });
    for (const row of items) {
      const trigger = button(local(row.moduleTitle), () => {
        if (expanded.has(row.moduleId)) expanded.delete(row.moduleId); else expanded.add(row.moduleId);
        stations(row.moduleId);
      });
      trigger.setAttribute('aria-label', local(row.moduleTitle));
      trigger.dataset.focusKey = row.moduleId;
      trigger.setAttribute('aria-expanded', String(expanded.has(row.moduleId)));
      cells(data.tBodies[0].insertRow(), row, trigger);
      if (expanded.has(row.moduleId)) {
        state.funnel.filter(step => step.moduleId === row.moduleId).forEach(step => {
          const tr = data.tBodies[0].insertRow();
          tr.className = 'academy-step-line';
          cells(tr, step, button(local(step.stepTitle), () => openStep(step.stepId)));
        });
      }
    }
    const scroller = el('div');
    scroller.className = 'academy-report-scroll';
    scroller.tabIndex = 0;
    scroller.setAttribute('role','region');
    scroller.setAttribute('aria-label',title.textContent);
    scroller.append(data);
    const definitions = el('details');
    definitions.append(el('summary',copy('Hoe we dit berekenen', 'Wie wir diese Werte berechnen')),
      el('p',copy('Bereik telt unieke gedeelde sessies binnen je filters. Verder gegaan betekent dat een sessie een latere stap bereikte of de cursus afrondde. Voor een station geldt de laatste stap. Goed beantwoord telt volledig juiste antwoorden op beoordeelde vragen. Privésessies tellen nergens mee.',
        'Reichweite zählt unterschiedliche geteilte Sitzungen im Filter. Weitergegangen heißt, dass ein späterer Schritt erreicht oder der Kurs abgeschlossen wurde. Bei Stationen gilt der letzte Schritt. Richtig beantwortet zählt vollständig richtige Antworten auf bewertete Fragen. Private Sitzungen sind ausgeschlossen.')));
    host.replaceChildren(title, scroller, definitions);
    host.hidden = !items.length;
    if (focusKey) Array.from(host.querySelectorAll('[data-focus-key]')).find(n=>n.dataset.focusKey===focusKey)?.focus();
  }

  function render(data) {
    state = data;
    stations();
    const funnel = document.getElementById('el-resp-funnel');
    const reachTable = tableToggle(copy('Bereik per stap', 'Reichweite je Schritt'),
      [copy('Stap', 'Schritt'), copy('Bereik van alle sessies', 'Anteil aller Sitzungen'), copy('Vorige stap bereikt', 'Vorherigen Schritt erreicht'), dropLabel],
      data.funnel.map(step => [local(step.stepTitle), withShare(step.reached, data.summary.totalSessions),
        step.previousReached == null ? '—' : num(step.previousReached), drop(step)]));
    funnel.append(reachTable);
    for (const card of document.querySelectorAll('#el-resp-blocks > [data-step]')) {
      const rows = Array.from(card.querySelectorAll('.el-chart-row'), r => [r.querySelector('.el-chart-label')?.textContent || '',r.querySelector('.el-chart-value')?.textContent || '']);
      if (rows.length) card.append(tableToggle(card.querySelector('h2, h3')?.textContent || '',[copy('Antwoord','Antwort'),copy('Aantal en aandeel','Anzahl und Anteil')],rows));
      card.append(button(copy('Stap bekijken', 'Schritt ansehen'), () => openStep(card.dataset.step)));
    }
  }
  function reset() {
    if (dialog.open) dialog.close();
    host.hidden = true;
    host.replaceChildren();
    dialog.querySelector('[data-detail-body]').replaceChildren();
    expanded.clear();
    state = null;
  }
  root.Xped.reportDetails = { render, openStep, reset };
})(window);
