(function () {
  'use strict';
  const xped = window.Xped;
  const { t: uiText, number, date, relative, language, percent, duration } = xped.i18n;
  const el = id => document.getElementById('ao-' + id);
  const status = el('status');
  const defaultGroup = name => name === 'default' ? uiText('overview.defaultGroup') : name;
  const courseUrl = id => '/expedities/' + encodeURIComponent(id);
  const presets = [...document.querySelectorAll('[data-preset]')];
  const lang = value => typeof value === 'string' ? value : value?.[language] || value?.nl || value?.de || '';
  const docs = new URLSearchParams(location.search);
  let generation = 0;
  let data, user, api, auth;
  const covers = new Map();
  const coverObserver = new IntersectionObserver(entries => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      coverObserver.unobserve(entry.target);
      void loadCover(entry.target);
    }
  });
  let dismissedArchive = new Set();
  let sorting = 'updatedAt';
  let ascending = false;
  let metricFilter = '';
  let showRoutes = false;
  const headings = [
    ['title', uiText('overview.column.title')],
    ['shareEnabled', uiText('overview.column.shareEnabled')],
    ['languages', uiText('overview.column.languages')],
    ['sessions', uiText('overview.column.sessions')],
    ['completion', uiText('overview.column.completion')],
    ['medianSeconds', uiText('overview.column.medianSeconds')],
    ['drop', uiText('overview.column.drop')],
    ['updatedAt', uiText('overview.column.updatedAt')],
    ['owner', uiText('overview.column.owner')],
  ];
  const metrics = [
    ['sessions', uiText('overview.metric.sessions'), uiText('overview.metric.sessionsHelp')],
    ['completion', uiText('overview.metric.completion'), uiText('overview.metric.completionHelp')],
    ['medianSeconds', uiText('overview.metric.medianSeconds'), uiText('overview.metric.medianSecondsHelp')],
    ['active', uiText('overview.metric.active'), uiText('overview.metric.activeHelp')],
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
    for (const id of ['library','welcome','start','stats','courses','feedback','archive','retry','signin','contact']) {
      if (el(id)) el(id).hidden = true;
    }
    for (const id of ['rows','feedback-list','archive-list','kpis','completion','distribution']) el(id).replaceChildren();
  }
  function welcome(title, body, action) {
    el('welcome-title').textContent = title; el('welcome-body').textContent = body;
    el('welcome').hidden = false;
    if (action && el(action)) el(action).hidden = false;
  }
  function routeStrip(parent, stations) {
    if (!window.XpedAcademyControls) return;
    const localized = stations.map(s => ({title:lang(s.title), steps:s.steps, reached:s.reached}));
    const reach = localized.filter(s => Number.isFinite(s.reached)).map(s => s.title + ' ' + percent(100 * s.reached));
    let label = uiText('overview.routeStations', { count: stations.length });
    if (reach.length) label += ' · ' + uiText('overview.reach') + ' · ' + reach.join(', ');
    parent.replaceChildren(window.XpedAcademyControls.routeStrip(localized, {
      size:'compact', label,
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
    if (key === 'medianSeconds') return duration(value, 'compact');
    return number(value);
  }
  function drawStats() {
    const {current,previous} = data;
    const completion = el('completion'), distribution = el('distribution'), kpis = el('kpis');
    const sample = uiText('overview.sample', { count: current.sessions });
    const legend = node('div',null,'ao-split-counts');
    const openCount = current.sessions - current.completed;
    legend.append(node('span',uiText('overview.completedCount', { count: number(current.completed) })),
      node('span',uiText('overview.openCount', { count: number(openCount) }) + (current.sessions ? ' · ' + percent(100 * openCount / current.sessions) : '')));
    completion.replaceChildren();
    if (current.sessions) {
      completion.append(node('div',percent(current.completion),'ao-metric-big'),
        bar(current.completed,current.sessions,uiText('overview.completion')),legend,
        node('p',sample,'ao-caption'));
    } else {
      completion.append(node('p',uiText('overview.completionUnavailable')));
    }
    const participants = data.courses.filter(c => c.metrics?.sessions > 0).sort((a,b) => b.metrics.sessions - a.metrics.sessions);
    distribution.replaceChildren();
    for (const course of participants.slice(0,5)) {
      const label = node('div',null,'ao-distribution-label');
      label.append(node('span',course.title),node('strong',number(course.metrics.sessions)));
      distribution.append(label);
      if (participants.length > 1) distribution.append(bar(course.metrics.sessions,participants[0].metrics.sessions,course.title));
    }
    if (!participants.length) distribution.append(node('p',uiText('overview.noSessions')));
    if (participants.length) distribution.append(node('p',sample,'ao-caption'));
    kpis.replaceChildren();
    metrics.forEach(([key,label,description]) => {
      const b=node('button'); b.type='button'; b.title=description; b.dataset.metric=key; b.setAttribute('aria-pressed',String(metricFilter === key));
      const delta = !previous.sessions || current[key] == null || previous[key] == null ? null : current[key] - previous[key];
      const change = delta == null ? null : (delta > 0 ? '+' : delta < 0 ? '−' : '') +
        (key === 'completion' ? number(Math.abs(delta),{maximumFractionDigits:1}) + ' pp' : metricValue(key,Math.abs(delta)));
      const comparison = node('small',change == null ? uiText('overview.noComparison') :
        uiText('overview.comparedToPrevious', { difference: change }));
      if (key === 'completion' && delta) comparison.dataset.direction = delta > 0 ? 'up' : 'down';
      b.append(node('span',label),node('strong',metricValue(key,current[key])),comparison);
      b.addEventListener('click',() => {
        metricFilter = metricFilter === key ? '' : key;
        drawStats(); drawTable(); el('courses').scrollIntoView({block:'nearest'}); el('kpis').querySelector('[data-metric="' + key + '"]').focus({preventScroll:true});
      });
      kpis.append(b);
    });
  }

  function filterControls() {
    const cohort = el('cohort'); const value = docs.get('cohort') || '';
    cohort.replaceChildren(new Option(uiText('overview.allGroups'),''));
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
  async function loadCover(img) {
    const path = img.dataset.asset;
    if (!covers.has(path)) {
      const session = api.captureSession();
      covers.set(path, api.authFetch(path).then(async response => {
        if (!response.ok) throw new Error('cover');
        const blob = await response.blob();
        session.assertCurrent();
        if (!blob.type.startsWith('image/')) throw new Error('cover');
        return URL.createObjectURL(blob);
      }));
    }
    const request = covers.get(path);
    try {
      const source = await request;
      if (img.isConnected && covers.get(path) === request) img.src = source;
    } catch (_) {
      if (covers.get(path) === request) covers.delete(path);
    }
  }

  function createCover(course) {
    const box=node('span',null,'ao-cover');
    const img=node('img'); img.alt=''; img.loading='lazy';
    if (course.coverMedia?.kind === 'asset' && course.coverMedia.assetId && !course.deletionPending) {
      img.dataset.asset = '/api/elearning/expeditions/' + encodeURIComponent(course.id) + '/assets/' + encodeURIComponent(course.coverMedia.assetId);
      coverObserver.observe(img);
      box.append(img);
      return box;
    }
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
      if (['owner','edit','translate'].includes(course.role) && !course.deletionPending && code !== course.defaultLanguage && coverage.needsReview > 0) {
        const action = uiText('overview.review') + ' (' + number(coverage.needsReview) + ')';
        const reviewLink = link(action,courseUrl(course.id) + '/bewerken?modus=vertalen&taal=' + code + '&filter=controleren','ao-review');
        reviewLink.setAttribute('aria-label',action + ' · ' + code.toUpperCase() + ' · ' + course.title);
        td.append(reviewLink);
      }
    });
    return td;
  }
  function archivedCourses() {
    return data.courses.filter(course => course.enabledLanguages.includes('en') && course.languageCoverage.en?.translated > 0);
  }
  function showArchivedCourses() {
    if (!data.studioAdmin) return;
    const courses = archivedCourses().filter(course => !dismissedArchive.has(course.id));
    const list = el('archive-list');
    list.replaceChildren();
    for (const course of courses) {
      const item = node('li');
      item.append(link(course.title,courseUrl(course.id)));
      list.append(item);
    }
    el('archive').hidden = !courses.length;
  }
  el('archive-dismiss').addEventListener('click', () => {
    if (!data?.studioAdmin || !user) return;
    archivedCourses().forEach(course => dismissedArchive.add(course.id));
    try { localStorage.setItem('xped.archive.seen.' + user.uid, JSON.stringify([...dismissedArchive])); } catch (_) { /* In-memory dismissal still works. */ }
    el('archive').hidden = true;
    el('courses-title').setAttribute('tabindex','-1');
    el('courses-title').focus();
  });

  function drawTable() {
    const htmlHead = el('table-head'), tbody=el('rows');
    coverObserver.disconnect(); tbody.replaceChildren();
    const editorial = data.studioAdmin || data.canCreate || data.courses.some(c => c.role !== 'translate');
    const columns = editorial ? headings : [
      ...headings.filter(([k]) => ['title','languages'].includes(k)),
      ['dueDate', uiText('overview.column.dueDate')], headings.find(([k]) => k === 'updatedAt'),
    ];
    let rows = [...data.courses];
    if (metricFilter) rows = rows.filter(c => metricFilter === 'medianSeconds' ? c.metrics?.measured > 0 : metricFilter === 'completion' ? c.metrics?.completed > 0 : c.metrics?.sessions > 0);
    rows.sort((a,b) => {
      const x=sortValue(a,sorting), y=sortValue(b,sorting);
      if (x == null || y == null) return x == null ? (y == null ? 0 : 1) : -1;
      const cmp=typeof x === 'string' ? x.localeCompare(String(y),language) : Number(x)-Number(y);
      return ascending ? cmp : -cmp;
    });
    const tr=node('tr');
    for (const [key,label] of columns) {
      const th=node('th'); th.scope='col';
      const sort=node('button',label); sort.type='button';
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
      if (editorial) {
        const [, state] = xped.i18n.courseStatus(c);
        row.append(node('td',state, c.shareEnabled ? 'ao-published' : ''));
      }
      row.append(translationCell(c));
      if (!editorial) {
        const due = node('td');
        if (c.dueDate) {
          const time = node('time', date(new Date(c.dueDate + 'T12:00:00'),{dateStyle:'medium'}));
          time.dateTime = c.dueDate; due.append(time);
        } else due.textContent = '—';
        row.append(due);
      }
      if (editorial) row.append(node('td',c.metrics ? number(c.metrics.sessions) : '—'),node('td',percent(c.metrics?.completion)),
        node('td',duration(c.metrics?.medianSeconds, 'compact') + ' / ' + duration((c.estimate || 0) * 60)),
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
    el('title').textContent = canEdit || !data.courses.length ? uiText('overview.title') : translationsOnly ? uiText('overview.myTranslations') : uiText('overview.sharedWithMe');
    if (!data.courses.length) {
      if (canEdit) {
        welcome(uiText('overview.noCourses'),
          uiText('overview.startHelp'));
        el('start').hidden=false; drawTemplates();
      } else {
        welcome(uiText('overview.invitedOnly'),uiText('overview.invitationHelp'),'contact');
      }
      return;
    }
    el('library').hidden=false; el('courses').hidden=false;
    showArchivedCourses();
    if (!translationsOnly) {
      filterControls(); drawStats(); drawFeedback(); el('stats').hidden=false; el('feedback').hidden=false;
    }
    drawTable();
  }

  async function refresh() {
    const request = ++generation;
    hideContent(); el('loading').hidden=true; notice('');
    const loadingTimer = setTimeout(() => {
      if (request !== generation) return;
      el('loading').hidden=false;
      notice(uiText('overview.loading'));
    }, 300);
    try {
      const response = await api.authFetch('/api/academy/overview?' + docs);
      if (!response.ok) throw new Error('overview');
      const result = await response.json();
      if (request !== generation || user?.uid !== auth.currentUser?.uid) return;
      data=result; render();
    } catch (_) {
      if (request !== generation) return;
      el('loading').hidden=true; el('retry').hidden=false;
      notice(uiText('overview.loadFailed'));
    } finally { clearTimeout(loadingTimer); }
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
    const open = el('dates').hidden;
    el('dates').hidden = !open;
    el('custom').setAttribute('aria-expanded', String(open));
    if (open) (el('from')._appDateInstance?.trigger || el('from')).focus();
  });
  el('filters').addEventListener('submit',evt => {
    evt.preventDefault(); const start=el('from').value, end=el('to').value;
    if (!start || !end || start>end) { notice(uiText('overview.invalidDates')); return; }
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
    presets.forEach(other => {other.disabled=true;}); notice(uiText('overview.creating'));
    try {
      const title=btn.querySelector('strong').textContent;
      const payload=window.XpedElearningModel.createExpeditionPreset(btn.dataset.preset,title,'nl',{academy:true});
      payload.enabledLanguages=['nl','de'];
      const res=await api.authFetch('/api/elearning/expeditions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
      if (!res.ok) throw new Error('create');
      const result=await res.json();
      if (auth.currentUser?.uid===creatingAs) location.assign(courseUrl(result.expedition.id) + '/bewerken');
    } catch (_) {
      if (auth.currentUser?.uid===creatingAs) notice(uiText('overview.createFailed'));
    } finally { presets.forEach(other => {other.disabled=false;}); }
  }));
  try {
    auth=xped.bootstrap.getAuth(); api=xped.auth.createAuthClient(auth);
    xped.bootstrap.onAuthStateReady(auth, next => {
      coverObserver.disconnect();
      covers.forEach(pending => pending.then(URL.revokeObjectURL).catch(() => {}));
      covers.clear();
      user=next; data=null; generation++; hideContent();
      try { dismissedArchive = new Set(user && JSON.parse(localStorage.getItem('xped.archive.seen.' + user.uid)) || []); }
      catch (_) { dismissedArchive = new Set(); }
      if (user) { refresh(); return; }
      notice(''); el('loading').hidden=true;
      welcome(uiText('overview.welcome'),
        uiText('overview.welcomeHelp'),'signin');
    });
  } catch (_) {
    hideContent(); el('loading').hidden=true;
    notice(uiText('overview.authUnavailable'));
  }
})();
