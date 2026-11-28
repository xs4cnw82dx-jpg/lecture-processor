/* Look up Academy destinations only after the member opens the keyboard finder. */
(function () {
  'use strict';
  const dialog = document.getElementById('ac-search');
  if (!dialog) return;
  const query = document.getElementById('ac-jump');
  const extra = dialog.querySelector('[data-ac-matches]');
  const noResults = dialog.querySelector('[data-ac-no-results]');
  const copy = (nl,de) => window.Xped.i18n.copy(nl,de);
  const normalize = value => String(value || '').trim().toLocaleLowerCase(document.documentElement.lang)
    .normalize('NFD').replace(/[\u0300-\u036f]/g,'');
  let cached, fetchedAs, loading, lastUid, account;
  let recent = [];
  let watchingIdentity = false;
  const roleNav = (canCreate, admin, roles) => {
    const allowed = { '/team':admin, '/resultaten':canCreate || roles.some(r => r === 'owner' || r === 'edit'), '/vertalingen':canCreate || roles.length>0 };
    document.querySelectorAll('#ac-rail .ac-route, #ac-search [data-ac-pages] a').forEach(a => {
      if (Object.hasOwn(allowed,a.pathname)) {
        a.toggleAttribute('data-ac-unavailable', !allowed[a.pathname]);
        if (!allowed[a.pathname]) a.hidden = true;
        else if (!a.closest('dialog')) a.hidden = false;
      }
    });
  };
  window.addEventListener('academy:workspace-access', event => {
    const {canCreate,studioAdmin,courses}=event.detail;
    roleNav(canCreate,studioAdmin,courses.map(c=>c.role));
  });
  function clearSession() {
    recent=[]; cached=null; fetchedAs=null; loading=null; extra.replaceChildren();
  }
  function addItem(group, title, action, context, href) {
    const button = document.createElement(href ? 'a' : 'button');
    if (href) button.href=href; else button.type='button';
    button.className='ac-finder-item';
    const titleNode=document.createElement('span');
    titleNode.textContent=title; button.append(titleNode);
    if (context) { const info=document.createElement('small'); info.textContent=context; button.append(info); }
    button.addEventListener('click',() => {
      if (href) recent=[{title,context,href},...recent.filter(r=>r.href!==href)].slice(0,4);
      if (action) { dialog.close(); action(); }
    });
    group.append(button);
  }
  function group(label) {
    const block=document.createElement('div'); block.className='ac-finder-group';
    const caption=document.createElement('p'); caption.textContent=label; block.append(caption);
    return block;
  }
  function render() {
    extra.replaceChildren();
    const term=normalize(query.value);
    const local=Array.from(dialog.querySelectorAll('[data-ac-pages] a')).some(a=>!a.hidden);
    if (!term && recent.length) {
      const recentGroup=group(copy('Recent geopend','Zuletzt geöffnet'));
      recent.forEach(r=>addItem(recentGroup,r.title,null,r.context,r.href)); extra.append(recentGroup);
    }
    if (term.length < 2 || !cached) { noResults.hidden=local || !!extra.children.length || !!loading; return; }
    const groups=new Map();
    const section=(name) => {
      if (!groups.has(name)) { const block=group(name); groups.set(name,block);extra.append(block); }
      return groups.get(name);
    };
    const actions=copy('Acties','Aktionen'), xped=window.Xped.i18n;
    [
      [copy('Nieuwe expeditie','Neue Expedition'),null,cached.canCreate?'/expedities?actie=nieuw':null],
      [copy('Interface in het Duits','Oberfläche auf Deutsch'),()=>document.querySelector('[data-academy-language="de"]')?.click()],
      [copy('Interface in het Nederlands','Oberfläche auf Niederländisch'),()=>document.querySelector('[data-academy-language="nl"]')?.click()],
      [copy('Donkere weergave','Dunkle Darstellung'),()=>xped.setTheme('dark')],
      [copy('Lichte weergave','Helle Darstellung'),()=>xped.setTheme('light')],
    ].forEach(([title, action, href]) => { if ((action || href) && normalize(title).includes(term)) addItem(section(actions),title,action,'',href); });
    let count=0;
    for (const item of cached.items) {
      const base='/expedities/'+encodeURIComponent(item.course);
      const kind={course:copy('Expedities','Expeditionen'),station:copy('Stations','Stationen'),step:copy('Stappen','Schritte')}[item.type];
      const title=item.title || item.labels?.[document.documentElement.lang] || item.labels?.nl || item.labels?.de || '';
      const text=[title,...Object.values(item.labels || {})].map(normalize);
      const resultTitle=copy('Resultaten van ','Ergebnisse von ')+title;
      if (item.type==='course' && item.role!=='translate' && normalize(resultTitle).includes(term) && count<24) {
        addItem(section(actions),resultTitle,null,'',base+'/resultaten'); count++;
      }
      if (!text.some(t=>t.includes(term)) || count>=24 || !kind) continue;
      const params=new URLSearchParams();
      if (item.role==='translate') params.set('modus','vertalen');
      if (item.station) params.set('module',item.station);
      if (item.step) params.set('step',item.step);
      const path=item.type==='course' ? base : base+'/bewerken?'+params;
      addItem(section(kind),title,null,item.parent || '',path); count++;
    }
    for (const email of cached.people || []) {
      if (count>=24 || !normalize(email).includes(term)) continue;
      addItem(section(copy('Personen','Personen')),email,null,'','/team?persoon='+encodeURIComponent(email)); count++;
    }
    noResults.hidden=local || !!extra.children.length;
  }
  async function load() {
    if (!dialog.open) return;
    try {
      account=window.Xped.bootstrap.getAuth();
      if (!watchingIdentity) {
        watchingIdentity=true;
        account.onAuthStateChanged(next => {
          if (lastUid && lastUid!==next?.uid) { clearSession(); lastUid=null; render(); }
        });
      }
      const identity=account.currentUser;
      if (!identity) { clearSession(); render(); return; }
      if (lastUid!==identity.uid) { clearSession(); lastUid=identity.uid; }
      if (fetchedAs===identity.uid) { render(); return; }
      if (loading) return;
      const req={}; loading=req;
      try {
        const res=await window.Xped.auth.createAuthClient(account).authFetch('/api/academy/navigation');
        if (!res.ok) return;
        const payload=await res.json();
        if (account.currentUser?.uid!==identity.uid || loading!==req) return;
        cached=payload; fetchedAs=identity.uid;
        roleNav(payload.canCreate,payload.studioAdmin,payload.items.filter(x=>x.type==='course').map(x=>x.role));
      } finally { if (loading===req) loading=null; }
    } catch (_) { /* The local page shortcuts remain available. */ }
    render();
  }
  new MutationObserver(() => { if (dialog.open) load(); }).observe(dialog,{attributes:true,attributeFilter:['open']});
  query.addEventListener('input',render);
  window.addEventListener('pagehide',clearSession);
  window.addEventListener('academy:workspace-access',() => { if (account && lastUid!==account.currentUser?.uid) clearSession(); });
})();
