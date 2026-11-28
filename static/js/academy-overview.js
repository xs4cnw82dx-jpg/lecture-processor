(function () {
  'use strict';
  const xped = window.Xped;
  const { copy, number, date, relative, language } = xped.i18n;
  const el = id => document.getElementById('ao-' + id);
  const status = el('status');
  const percent = v => v == null ? '—' : number(v / 100, { style: 'percent', maximumFractionDigits: 1 });
  const duration = secs => secs == null ? '—' : number(secs / 60, { maximumFractionDigits: 1 }) + ' min';
  const defaultGroup = name => name === 'default' ? copy('Algemene groep','Allgemeine Gruppe') : name;
  const courseUrl = id => '/expedities/' + encodeURIComponent(id);
  const presets = [...document.querySelectorAll('[data-preset]')];
  const lang = value => typeof value === 'string' ? value : value?.[language] || value?.nl || value?.de || '';
  const docs = new URLSearchParams(location.search);
  let generation = 0;
  let data, user, api, auth;
  let sorting = 'updatedAt';
  let ascending = false;
  let metricFilter = '';
  let showRoutes = false;
  const headings = [
    ['title','Expeditie','Expedition'], ['shareEnabled','Status','Status'], ['languages','Talen','Sprachen'],
    ['sessions','Sessies','Sitzungen'], ['completion','Voltooiing','Abschlussquote'],
    ['medianSeconds','Actief / geschat','Aktiv / geschätzt'], ['drop','Grootste uitval','Größter Rückgang'],
    ['updatedAt','Bijgewerkt','Aktualisiert'], ['owner','Eigenaar','Eigentümer'],
  ];
  const metrics = [
    ['sessions','Gestarte sessies','Gestartete Sitzungen','Sessies die in deze periode zijn gestart en gedeeld.','Geteilte Sitzungen, die in diesem Zeitraum begonnen haben.'],
    ['completion','Voltooiingsgraad','Abschlussquote','Afgeronde sessies als aandeel van alle gestarte sessies.','Abgeschlossene Sitzungen als Anteil aller gestarteten Sitzungen.'],
    ['medianSeconds','Mediane actieve tijd','Mediane aktive Zeit','Het midden van de gemeten actieve tijden in gedeelde sessies.','Der mittlere Wert der gemessenen aktiven Zeiten in geteilten Sitzungen.'],
    ['active','Actieve expedities','Aktive Expeditionen','Expedities met minstens één gedeelde sessie in deze periode.','Expeditionen mit mindestens einer geteilten Sitzung in diesem Zeitraum.'],
  ];

  function node(tag, text, cls) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    return n;
  }
  function bar(value, max, label) {
    const p = node('progress', null, 'ao-track');
    p.max = Math.max(1, max); p.value = value || 0; p.setAttribute('aria-label', label);
    return p;
  }
  function link(title, href, cls) {
    const a = node('a', title, cls); a.href = href; return a;
  }
  function notice(text) { status.textContent = text; status.hidden = !text; }
  function hideContent() {
    for (const id of ['library','welcome','start','stats','courses','feedback','retry','signin','contact']) {
      if (el(id)) el(id).hidden = true;
    }
    for (const id of ['rows','feedback-list','kpis','completion','distribution']) el(id).replaceChildren();
  }
  function welcome(title, body, action) {
    el('welcome-title').textContent = title; el('welcome-body').textContent = body;
    el('welcome').hidden = false;
    if (action && el(action)) el(action).hidden = false;
  }
  function routeStrip(parent, stations) {
    if (!window.XpedAcademyControls) return;
    const localized = stations.map(s => ({title:lang(s.title), steps:s.steps}));
    parent.replaceChildren(window.XpedAcademyControls.routeStrip(localized, {
      size:'compact', label:copy('Route met ','Route mit ') + number(stations.length) + copy(' stations',' Stationen'),
    }));
  }
  function drawTemplates() {
    presets.forEach(btn => {
      const stations = btn.dataset.steps.split(',').map((step, i) => ({title: 'Station ' + number(i + 1), steps:Number(step)}));
      routeStrip(btn.querySelector('.ao-template-route'), stations);
    });
  }
  function metricValue(key,value) {
    if (value == null) return '—';
    if (key === 'completion') return percent(value);
    if (key === 'medianSeconds') return duration(value);
    return number(value);
  }
  function sparkline(series) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg','svg');
    svg.classList.add('ao-spark'); svg.setAttribute('viewBox','0 0 80 24'); svg.setAttribute('aria-hidden','true');
    const path = document.createElementNS(svg.namespaceURI,'path');
    const max = Math.max(1,...series.filter(n => n != null));
    let move = true;
    const d = series.map((v,i) => {
      if (v == null) { move = true; return ''; }
      const segment = (move ? 'M' : 'L') + (1 + 78*i/Math.max(1,series.length-1)) + ',' + (22 - 19*v/max);
      move = false; return segment;
    }).join(' ');
    path.setAttribute('d',d); path.setAttribute('fill','none'); path.setAttribute('stroke','currentColor'); path.setAttribute('stroke-width','2');
    svg.append(path); return svg;
  }
  function drawStats() {
    const {current,previous} = data;
    const completion = el('completion'), distribution = el('distribution'), kpis = el('kpis');
    const periodName = copy(' · gedeelde sessies',' · geteilte Sitzungen');
    const legend = node('div',null,'ao-split-counts');
    legend.append(node('span',number(current.completed) + copy(' afgerond',' abgeschlossen')),node('span',number(current.sessions-current.completed) + copy(' open',' offen')));
    completion.replaceChildren(node('div',percent(current.completion),'ao-metric-big'),
      bar(current.completed,current.sessions,copy('Voltooiing','Abschlussquote')),legend,node('p','n = ' + number(current.sessions) + periodName,'ao-caption'));
    const participants = data.courses.filter(c => c.metrics?.sessions > 0).sort((a,b) => b.metrics.sessions - a.metrics.sessions);
    distribution.replaceChildren();
    for (const course of participants.slice(0,5)) {
      const label = node('div',null,'ao-distribution-label');
      label.append(node('span',course.title),node('strong',number(course.metrics.sessions)));
      distribution.append(label,bar(course.metrics.sessions,participants[0].metrics.sessions,course.title));
    }
    if (!participants.length) distribution.append(node('p',copy('Nog geen gedeelde sessies in deze periode.','In diesem Zeitraum wurden noch keine Sitzungen geteilt.')));
    distribution.append(node('p','n = ' + number(current.sessions) + periodName,'ao-caption'));
    kpis.replaceChildren();
    metrics.forEach(([key,nl,de,desc,deDesc]) => {
      const b=node('button'); b.type='button'; b.title=copy(desc,deDesc); b.dataset.metric=key; b.setAttribute('aria-pressed',String(metricFilter === key));
      const delta = current[key] == null || previous[key] == null ? null : current[key] - previous[key];
      const change = delta == null ? '—' : (delta > 0 ? '+' : delta < 0 ? '−' : '') +
        (key === 'completion' ? number(Math.abs(delta),{maximumFractionDigits:1}) + ' pp' : metricValue(key,Math.abs(delta)));
      b.append(node('span',copy(nl,de)),node('strong',metricValue(key,current[key])),sparkline(data.trend.map(v => v[key])),
        node('small',change + copy(' t.o.v. vorige periode',' zur Vorperiode')));
      b.addEventListener('click',() => {
        metricFilter = metricFilter === key ? '' : key;
        drawStats(); drawTable(); el('courses').scrollIntoView({block:'nearest'}); el('kpis').querySelector('[data-metric="' + key + '"]').focus({preventScroll:true});
      });
      kpis.append(b);
    });
  }

  function filterControls() {
    const cohort = el('cohort'); const value = docs.get('cohort') || '';
    cohort.replaceChildren(new Option(copy('Alle groepen','Alle Gruppen'),''));
    [...new Set([...data.cohorts, ...(value ? [value] : [])])].forEach(name => cohort.add(new Option(defaultGroup(name),name)));
    cohort.value = value; cohort.dispatchEvent(new CustomEvent('academy:options'));
    const custom = docs.has('from');
    el('dates').hidden = !custom; el('custom').setAttribute('aria-expanded',String(custom));
    el('from').value = data.period.from; el('to').value = data.period.to;
    document.querySelectorAll('[data-days]').forEach(b => b.setAttribute('aria-pressed',String(!custom && b.dataset.days === (docs.get('days') || '30'))));
  }
  function drawFeedback() {
    const list=el('feedback-list'); list.replaceChildren();
    data.feedback.forEach(item => {
      const li=node('li'); const body=node('blockquote',item.comment);
      const label=[item.title,lang(item.step),relative(item.at)].filter(Boolean).join(' · ');
      li.append(body,link(label,courseUrl(item.id) + '/resultaten')); list.append(li);
    });
    el('feedback-empty').hidden = !!data.feedback.length;
  }
  function sortValue(course, key) {
    if (key === 'languages') return course.enabledLanguages.filter(v=>v!=='en').join(' ');
    if (key === 'drop') return course.drop?.percent;
    return course[key] ?? course.metrics?.[key];
  }
  function createCover(course) {
    const box=node('span',null,'ao-cover');
    const img=node('img'); img.alt=''; img.loading='lazy';
    const originals=['library','detour','choices','finish','steps','rest'];
    const seed = Array.from(course.id).reduce((n,c) => ((n * 31) + c.codePointAt(0)) >>> 0, 0);
    const path = course.coverMedia?.staticPath;
    img.src = typeof path === 'string' && path.startsWith('/static/images/xped/') ? path : '/static/images/xped/academy-' + originals[seed % originals.length] + '.webp';
    box.append(img); return box;
  }
  function translationCell(course) {
    const td=node('td');
    course.enabledLanguages.filter(l => ['de','nl'].includes(l)).forEach(code => {
      const coverage = course.languageCoverage[code] || {};
      const completed = Math.max(0,(coverage.translated || 0) - (coverage.needsReview || 0));
      const label = code.toUpperCase() + ' ' + number(completed) + '/' + number(coverage.total || 0);
      const wrap=node('span',null,'ao-cell'); wrap.title=label;
      wrap.append(node('span',code.toUpperCase()),bar(completed,coverage.total,label)); td.append(wrap);
    });
    return td;
  }
  function drawTable() {
    const htmlHead = el('table-head'), tbody=el('rows'); tbody.replaceChildren();
    const editorial = data.studioAdmin || data.canCreate || data.courses.some(c => c.role !== 'translate');
    const columns = editorial ? headings : headings.filter(([k]) => ['title','languages','updatedAt'].includes(k));
    let rows = [...data.courses];
    if (metricFilter) rows = rows.filter(c => metricFilter === 'medianSeconds' ? c.metrics?.measured > 0 : metricFilter === 'completion' ? c.metrics?.completed > 0 : c.metrics?.sessions > 0);
    rows.sort((a,b) => {
      const x=sortValue(a,sorting), y=sortValue(b,sorting);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      const cmp=typeof x === 'string' ? x.localeCompare(String(y),language) : Number(x)-Number(y);
      return ascending ? cmp : -cmp;
    });
    const tr=node('tr');
    for (const [key,nl,de] of columns) {
      const th=node('th'); th.scope='col';
      const sort=node('button',copy(nl,de)); sort.type='button';
      if (sorting===key) { th.setAttribute('aria-sort',ascending?'ascending':'descending'); sort.append(node('span',ascending?' ↑':' ↓')); }
      sort.addEventListener('click',() => { ascending = sorting === key ? !ascending : ['title','owner','languages'].includes(key); sorting=key; drawTable(); htmlHead.querySelector('[aria-sort] button').focus(); });
      th.append(sort); tr.append(th);
    }
    htmlHead.replaceChildren(tr);
    rows.forEach(c => {
      const row=node('tr'), title=node('td'), a=link(null,courseUrl(c.id),'ao-course-link');
      a.append(createCover(c),node('span',c.title)); title.append(a);
      if (showRoutes) { const strip=node('div'); routeStrip(strip,c.stations || []); title.append(strip); }
      row.append(title);
      if (editorial) row.append(node('td',c.shareEnabled ? copy('Gedeeld','Geteilt') : copy('Concept','Entwurf'), c.shareEnabled?'ao-published':''));
      row.append(translationCell(c));
      if (editorial) row.append(node('td',c.metrics ? number(c.metrics.sessions) : '—'),node('td',percent(c.metrics?.completion)),
        node('td',duration(c.metrics?.medianSeconds) + ' / ' + number(c.estimate || 0) + ' min'),
        node('td',c.drop ? lang(c.drop.title) + ' · ' + percent(c.drop.percent) : '—'));
      row.append(node('td',c.updatedAt ? date(c.updatedAt * 1000,{dateStyle:'medium'}) : '—'));
      if (editorial) row.append(node('td',c.owner || '—'));
      row.addEventListener('click',event => { if (!event.target.closest('a,button') && !window.getSelection()?.toString()) location.assign(a.href); });
      tbody.append(row);
    });
    el('table-empty').hidden = !!rows.length;
  }

  function render() {
    notice(''); el('loading').hidden = true;
    window.dispatchEvent(new CustomEvent('academy:workspace-access',{detail:{canCreate:data.canCreate,studioAdmin:data.studioAdmin,courses:data.courses}}));
    const canEdit = data.canCreate || data.studioAdmin;
    const translationsOnly = !canEdit && data.courses.length && data.courses.every(c => c.role === 'translate');
    el('title').textContent = canEdit || !data.courses.length ? copy('Overzicht','Übersicht') : translationsOnly ? copy('Mijn vertaalopdrachten','Meine Übersetzungsaufträge') : copy('Gedeeld met mij','Mit mir geteilt');
    if (!data.courses.length) {
      if (canEdit) {
        welcome(copy('Nog geen expedities','Noch keine Expeditionen'),
          copy('Geef je eerste expeditie vorm. Kies hieronder een opzet en voeg je eigen stations en stappen toe.','Gestalten Sie Ihre erste Expedition. Wählen Sie unten eine Vorlage und ergänzen Sie Ihre Stationen und Schritte.'));
        el('start').hidden=false; drawTemplates();
      } else {
        welcome(copy('Toegang op uitnodiging','Zugang auf Einladung'),copy('Vraag de beheerder om een uitnodiging om hier expedities te maken of te bewerken. Als deelnemer gebruik je de link die je hebt gekregen.','Bitten Sie die Administration um eine Einladung, um Expeditionen zu erstellen oder zu bearbeiten. Als teilnehmende Person nutzen Sie Ihren persönlichen Lernlink.'),'contact');
      }
      return;
    }
    el('library').hidden=false; el('courses').hidden=false;
    if (!translationsOnly) {
      filterControls(); drawStats(); drawFeedback(); el('stats').hidden=false; el('feedback').hidden=false;
    }
    drawTable();
  }

  async function refresh() {
    const request = ++generation;
    hideContent(); el('loading').hidden=false;
    notice(copy('Je werkruimte wordt opgehaald…','Ihr Arbeitsbereich wird geladen…'));
    try {
      const response = await api.authFetch('/api/academy/overview?' + docs);
      if (!response.ok) throw new Error('overview');
      const result = await response.json();
      if (request !== generation || user?.uid !== auth.currentUser?.uid) return;
      data=result; render();
    } catch (_) {
      if (request !== generation) return;
      el('loading').hidden=true; el('retry').hidden=false;
      notice(copy('Je overzicht kon niet worden opgehaald.','Ihre Übersicht konnte nicht geladen werden.'));
    }
  }
  function changePeriod() {
    const params=docs.toString(); history.replaceState(null,'',location.pathname + (params ? '?' + params : ''));
    metricFilter=''; refresh();
  }
  el('cohort').addEventListener('change',event => { if (event.target.value) docs.set('cohort',event.target.value); else docs.delete('cohort'); changePeriod(); });
  document.querySelectorAll('[data-days]').forEach(btn => btn.addEventListener('click',() => {
    docs.delete('from'); docs.delete('to'); docs.set('days',btn.dataset.days); changePeriod();
  }));
  el('custom').addEventListener('click',() => {
    const open = el('dates').hidden; el('dates').hidden=!open; el('custom').setAttribute('aria-expanded',String(open)); if (open) el('from').focus();
  });
  el('filters').addEventListener('submit',evt => {
    evt.preventDefault(); const start=el('from').value, end=el('to').value;
    if (!start || !end || start>end) { notice(copy('Kies een geldige begin- en einddatum.','Wählen Sie ein gültiges Anfangs- und Enddatum.')); return; }
    docs.delete('days'); docs.set('from',start); docs.set('to',end); changePeriod();
  });
  el('route-toggle').addEventListener('click',() => { showRoutes=!showRoutes; el('route-toggle').setAttribute('aria-pressed',String(showRoutes)); drawTable(); });
  el('rows').addEventListener('keydown',event => {
    if (!['j','k','ArrowUp','ArrowDown'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const links = [...el('rows').querySelectorAll('.ao-course-link')], idx=links.indexOf(event.target);
    if (idx<0) return;
    event.preventDefault(); links[Math.max(0,Math.min(links.length-1,idx+(['j','ArrowDown'].includes(event.key)?1:-1)))].focus();
  });
  el('retry').addEventListener('click',refresh);
  presets.forEach(btn => btn.addEventListener('click', async () => {
    if (!user || btn.disabled) return;
    const creatingAs=user.uid;
    presets.forEach(other => {other.disabled=true;}); notice(copy('De expeditie wordt aangemaakt…','Die Expedition wird erstellt…'));
    try {
      const title=btn.querySelector('strong').textContent;
      const payload=window.XpedElearningModel.createExpeditionPreset(btn.dataset.preset,title,'nl',{academy:true});
      payload.enabledLanguages=['nl','de'];
      const res=await api.authFetch('/api/elearning/expeditions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if (!res.ok) throw new Error('create');
      const result=await res.json();
      if (auth.currentUser?.uid===creatingAs) location.assign(courseUrl(result.expedition.id) + '/bewerken');
    } catch (_) {
      if (auth.currentUser?.uid===creatingAs) notice(copy('Aanmaken is niet gelukt. Probeer het opnieuw.','Die Expedition konnte nicht erstellt werden. Versuchen Sie es erneut.'));
    } finally { presets.forEach(other => {other.disabled=false;}); }
  }));
  try {
    auth=xped.bootstrap.getAuth(); api=xped.auth.createAuthClient(auth);
    xped.bootstrap.onAuthStateReady(auth, next => {
      user=next; data=null; generation++; hideContent();
      if (user) { refresh(); return; }
      notice(''); el('loading').hidden=true;
      welcome(copy('Welkom bij xPED Academy','Willkommen in der xPED Academy'),
        copy('Maak en beheer interactieve expedities over pijn. Log in om je werkruimte te openen.','Erstellen und verwalten Sie interaktive Expeditionen rund um das Thema Schmerz. Melden Sie sich an, um Ihren Arbeitsbereich zu öffnen.'),'signin');
    });
  } catch (_) {
    hideContent(); el('loading').hidden=true;
    notice(copy('Inloggen is tijdelijk niet beschikbaar. Ververs de pagina om het opnieuw te proberen.','Die Anmeldung ist vorübergehend nicht verfügbar. Laden Sie die Seite erneut.'));
  }
})();
