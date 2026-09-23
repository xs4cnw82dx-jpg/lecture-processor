(function () {
  'use strict';
  const M=window.BookModel, D=window.BookStorage, $=id=>document.getElementById(id), esc=M.esc;
  const auth=window.LectureProcessorBootstrap.getAuth();
  let user=null,b=null,active='',selected=[],turn=0,tool='select',zoom=1,fit='book',reading=false,guides=true,snap=true,rulers=false;
  let localBooks=[],cloudBooks=[],collection='mine',dirty=false,changeCount=0,saving=null,saveTimer,localTimer,toastTimer,leaseToken='',undoStack=[],redoStack=[];
  let imageTarget='',replacement='',selectionRange=null,cloudAvailable=true,closed=false,opening=false;
  const renderedAssets={},fontCache={},coverCache={};
  let session=sessionStorage.getItem('book-tab-session')||M.id(),saveError='',uploads=0,lastRefresh=0;
  let savedPages={};
  const instance=M.id(),tabChannel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('book-studio-tabs'):null;
  if(tabChannel)tabChannel.onmessage=({data})=>{if(data.session!==session||data.instance===instance)return;if(data.type==='probe')tabChannel.postMessage({type:'occupied',session,instance});else if(data.type==='occupied'){session=M.id();sessionStorage.setItem('book-tab-session',session);}};
  if(tabChannel)tabChannel.postMessage({type:'probe',session,instance});
  sessionStorage.setItem('book-tab-session',session);
  let accessToken='',storedSelection=null;
  const action = fn => async event => {try{await fn(event);}catch(error){notify(error.message||'That did not work. Please try again.',true);}};
  const page=()=>b&&b.pages.find(p=>p.id===active)||b&&b.pages[0];
  const item=()=>page()&&page().items.find(o=>o.id===selected[0]);
  const editable=()=>!!b&&(b.local||!!leaseToken)&&!b.deleted;
  const metadata=()=>({title:b.title,folder:b.folder,tags:b.tags,favorite:b.favorite,palette:b.palette,styles:b.styles,illustration:b.illustration});
  const field=(label,name,value,type='text',extra='')=>`<label class="book-field"><span>${esc(label)}</span><input type="${type}" data-field="${name}" value="${esc(value)}" ${extra}></label>`;
  const selectField=(label,name,value,options)=>`<label class="book-field"><span>${esc(label)}</span><select data-field="${name}">${options.map(o=>{const v=Array.isArray(o)?o[0]:o,l=Array.isArray(o)?o[1]:o;return `<option value="${esc(v)}"${String(v)===String(value)?' selected':''}>${esc(l)}</option>`;}).join('')}</select></label>`;
  const toggle=(label,name,value)=>`<label class="book-switch"><span>${esc(label)}</span><input type="checkbox" class="app-toggle" role="switch" data-field="${name}"${value?' checked':''}></label>`;
  function notify(message,error=false){clearTimeout(toastTimer);$('book-toast').textContent=message;$('book-toast').classList.toggle('error',error);$('book-toast').hidden=false;toastTimer=setTimeout(()=>{$('book-toast').hidden=true;},error?9500:4200);}
  function status(message){$('save-state').textContent=message;}
  async function api(url,options={},blob=false){const headers={'X-Book-Session':session,...options.headers};if(user) headers.Authorization='Bearer '+await user.getIdToken();if(accessToken)headers['X-Book-Access']=accessToken;if(options.body&&!(options.body instanceof FormData))headers['Content-Type']='application/json';const r=await fetch(url,{...options,headers});if(!r.ok){let p;try{p=await r.json();}catch(_){p={error:'Could not reach the server. Your local draft is safe.'};}const e=new Error(p.error||'Please try again.');e.status=r.status;throw e;}return blob?r.blob():r.json();}
  async function loadLibrary(){localBooks=await D.listBooks();cloudBooks=[];if(user){try{const result=await api('/api/books');cloudBooks=result.books;cloudAvailable=result.storage_available;}catch(e){notify(e.message,true);}}renderLibrary();await loadCovers();}
  async function loadCovers(){for(const entry of cloudBooks.filter(x=>!x.deleted).slice(0,30)){if(b)return;try{const cached=localBooks.find(x=>x.id===entry.id&&!x.pending&&x.revision===entry.revision);const result=cached?{pages:[cached.pages[0]],assets:cached.assets}:await api('/api/books/'+entry.id+'?cover=1');coverCache[entry.id]=result.pages[0];for(const a of result.assets){if(renderedAssets[a.id])continue;const stored=await D.getAsset(a.id);let blob=stored&&stored.blob;if(!blob&&a.ready){blob=await api('/api/books/'+entry.id+'/assets/'+a.id,{},true);await D.putAsset({...a,blob});}if(blob)renderedAssets[a.id]={src:URL.createObjectURL(blob),width:a.width,height:a.height};}renderLibrary();}catch(_){/* The bookshelf remains usable if a cover cannot load. */}}}
  function renderLibrary(){
    if(b)return;
    let list=collection==='shared'?cloudBooks.filter(x=>x.role!=='owner'&&!x.deleted):collection==='local'?localBooks.filter(x=>x.local&&!x.deleted):collection==='trash'?[...localBooks.filter(x=>x.local&&x.deleted),...cloudBooks.filter(x=>x.deleted)]:user?cloudBooks.filter(x=>x.role==='owner'&&!x.deleted):localBooks.filter(x=>x.local&&!x.deleted);
    const query=$('book-search').value.toLowerCase();list=list.filter(x=>[x.title,x.folder,...(x.tags||[])].join(' ').toLowerCase().includes(query));
    const sort=$('book-sort').value;list.sort((a,b)=>sort==='title'?a.title.localeCompare(b.title):sort==='favorite'?Number(b.favorite)-Number(a.favorite)||b.updated_at-a.updated_at:b.updated_at-a.updated_at);
    $('book-grid').innerHTML=list.length?list.map(x=>{const cached=localBooks.find(l=>l.id===x.id),cover=coverCache[x.id]||(cached&&cached.pages&&cached.pages[0]);return `<article class="book-card"><button class="book-cover-button" data-open="${esc(x.id)}" aria-label="Open ${esc(x.title)}"><span class="book-mini-cover">${cover?M.svg(cover,renderedAssets):M.svg({...M.page('front'),items:[M.object('text',{text:x.title,y:38,w:108,h:90,style:{...M.baseStyle,font:'Fraunces',size:28}})]})}</span></button><div class="book-card-title"><h3>${x.favorite?'★ ':''}${esc(x.title)}</h3><button class="icon-btn" data-book-options="${esc(x.id)}" aria-label="Options for ${esc(x.title)}">•••</button></div><p>${esc(x.folder|| (x.local?'On this device':'Saved to cloud'))} · ${new Date(x.updated_at*1000).toLocaleDateString(undefined,{month:'short',day:'numeric'})}</p></article>`;}).join(''):`<div class="book-empty"><h2>${query?'No books found':collection==='trash'?'Nothing in the trash':collection==='shared'?'A place for shared stories':'Your next idea starts here'}</h2><p>${query?'Try another title, folder or tag.':collection==='shared'?'Books shared with your email address will appear here.':collection==='trash'?'Deleted books can be restored here.':'Start with a blank page or choose a little inspiration.'}</p>${!query&&['mine','local'].includes(collection)?'<button class="primary-btn" data-new>＋ Create a book</button>':''}</div>`;
  }
  function dialog(title,html){$('dialog-content').innerHTML=`<h2>${esc(title)}</h2>${html}`;if(!$('book-dialog').open)$('book-dialog').showModal();}
  function closeDialog(){$('book-dialog').close();}
  function newBookDialog(){dialog('What will you make?',`<p class="book-muted">Every book starts with a cover and two inside pages. Add as many as your idea needs.</p><div class="book-template-grid">${[['blank','Blank sketchbook','A fresh page for anything.'],['story','Picture book','A little room for a big adventure.'],['journal','Journal','Lined pages for everyday discoveries.'],['explain','Visual explanation','Make an idea easy to understand.']].map(t=>`<button class="book-template" data-template="${t[0]}"><strong>${t[1]}</strong><span class="book-muted">${t[2]}</span></button>`).join('')}</div>`);}
  async function create(template){const next=M.book(template);await D.putBook(next);closeDialog();await openBook(next.id);}
  function currentSpreads(){return M.spreads(b.pages,fit==='page'||window.innerWidth<=780);}
  function syncTurn(){const spreads=currentSpreads(),index=spreads.findIndex(s=>s.includes(active));turn=Math.max(0,index);return spreads;}
  async function openBook(id){
    if(opening)return;opening=true;
    try{
      if(b&&dirty)await persist();
      if(b&&!b.local&&leaseToken)await release();
      b=await D.getBook(id);leaseToken='';selected=[];undoStack=[];redoStack=[];dirty=false;changeCount=0;
      accessToken=sessionStorage.getItem('book-access-'+id)||'';
      if(!id.startsWith('local-')){
        const local=b;
        const result=await api('/api/books/'+id);
        b={...result.book,pages:result.book.page_ids.map(pid=>result.pages.find(p=>p.id===pid)).filter(Boolean),deletedPages:(result.book.deleted_page_ids||[]).map(pid=>result.pages.find(p=>p.id===pid)).filter(Boolean),assets:result.assets,local:false};
        if(local&&local.pending){await D.putBook({...local,id:'local-recovery-'+M.id(),title:local.title+' (recovered draft)',local:true,pending:false,role:'owner'});notify('Your unsaved changes are safe in a recovered draft on your bookshelf.');}
      }
      if(!b)throw new Error('This book is no longer available on this device.');
      active=b.pages[0].id;turn=0;zoom=1;reading=false;document.body.classList.remove('book-reading');
      $('library').hidden=true;$('workspace').hidden=false;$('title-wrap').hidden=false;['reading','share','export'].forEach(i=>$(i).hidden=false);
      $('book-title').value=b.title;history.replaceState({},'', '/books/'+id);
      savedPages=Object.fromEntries(b.pages.concat(b.deletedPages||[]).map(p=>[p.id,JSON.stringify(p)]));saveError='';
      await loadAssets();renderAll();
      if(!b.local&&!b.deleted&&(b.role==='owner'||b.role==='edit')){
        const resume=sessionStorage.getItem('book-lease-'+id);
        try{await acquire(false,resume);}catch(_){notify('Opened for viewing. You can start editing when the book is available.');}
      }
      await D.putBook(b);updateStatus();
    }finally{opening=false;}
  }
  async function loadAssets(original=false){
    const current=b;
    for(const a of current.assets){
      const stored=await D.getAsset(a.id);let blob=stored&&stored.blob;
      if(!blob&&!current.local&&a.ready){try{blob=await api('/api/books/'+current.id+'/assets/'+a.id+(original?'?original=1':''),{},true);await D.putAsset({...a,blob});}catch(e){notify(e.message,true);continue;}}
      if(blob&&!renderedAssets[a.id])renderedAssets[a.id]={src:URL.createObjectURL(blob),width:a.width,height:a.height,blob};
    }
  }
  async function acquire(takeover=false,resume=''){
    if(b.local)return;
    const result=await api('/api/books/'+b.id+'/lease',{method:'POST',body:JSON.stringify({action:'acquire',takeover,lease_token:resume||leaseToken})});
    leaseToken=result.lease_token;sessionStorage.setItem('book-lease-'+b.id,leaseToken);const remote=await api('/api/books/'+b.id+'/revision');if(remote.book.revision!==b.revision){if(dirty){await D.putBook({...M.clone(b),id:'local-recovery-'+M.id(),title:b.title+' (recovered draft)',local:true,pending:false,role:'owner'});notify('A newer version is open. Your unsaved changes are in a recovered draft.');}dirty=false;await reloadRemote();}updateStatus();renderInspector();
  }
  async function release(){if(!b||b.local||!leaseToken)return;await persist();await api('/api/books/'+b.id+'/lease',{method:'POST',body:JSON.stringify({action:'release',lease_token:leaseToken})});leaseToken='';sessionStorage.removeItem('book-lease-'+b.id);updateStatus();renderInspector();}
  function updateStatus(){if(!b)return;const can=editable();$('book-title').disabled=!can;$('edit-turn').hidden=b.local||can||!['owner','edit'].includes(b.role)||b.deleted;$('finish-turn').hidden=b.local||!can;$('share').disabled=b.deleted;$('export').disabled=!b.local&&!['owner','edit'].includes(b.role);$('editor-status').textContent=b.local?'':can?'Your editing turn':b.editor?b.editor.name+' is editing':'Viewing';$('edit-turn').textContent=b.editor&&b.role==='owner'?'Start / take over':'Start editing';status(saveError?'Needs attention':saving?'Saving…':dirty?(b.local?'Saved on this device':'Saving…'):b.local?'Saved on this device':'Saved to cloud');if(lastRefresh&&!can)$('editor-status').textContent+=' · Updated '+new Date(lastRefresh).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});document.querySelectorAll('[data-add],#add-image,#add-page,#add-page-side').forEach(el=>el.disabled=!can);$('undo').disabled=!can||!undoStack.length;$('redo').disabled=!can||!redoStack.length;}
  function checkpoint(){if(!editable())return false;undoStack.push(M.clone({pages:b.pages,deletedPages:b.deletedPages,...metadata(),activePage:active}));if(undoStack.length>60)undoStack.shift();redoStack=[];return true;}
  function changed(render=true){syncLinkedItems();b.updated_at=Date.now()/1000;dirty=true;b.pending=!b.local;changeCount++;clearTimeout(localTimer);D.putBook(b).catch(e=>{saveError=e.message;status('Needs attention');notify(e.message,true);});clearTimeout(saveTimer);if(!b.local)saveTimer=setTimeout(()=>persist().catch(e=>notify(e.message,true)),5000);if(render)renderAll();else updateStatus();}
  async function persist(){
    if(!b)return;if(saving){await saving;if(dirty&&leaseToken)return persist();return;}
    const current=b;
    await D.putBook(current);
    if(current.local){dirty=false;updateStatus();return;}
    if(!dirty||!leaseToken||uploads||current.assets.some(a=>a.local))return;
    const count=changeCount,sent=M.clone({pages:current.pages.concat(current.deletedPages||[]).filter(p=>savedPages[p.id]!==JSON.stringify(p)),page_ids:current.pages.map(p=>p.id),deleted_page_ids:(current.deletedPages||[]).map(p=>p.id),metadata:metadata(),base_revision:current.revision,lease_token:leaseToken});
    status('Saving…');
    saving=(async()=>{
      try{const result=await api('/api/books/'+current.id,{method:'PUT',body:JSON.stringify(sent)});if(b!==current)return;current.revision=result.revision;sent.pages.forEach(p=>savedPages[p.id]=JSON.stringify(p));saveError='';if(changeCount===count){dirty=false;current.pending=false;}await D.putBook(current);updateStatus();}
      catch(e){if(e.status===409||e.status===403){leaseToken='';sessionStorage.removeItem('book-lease-'+current.id);}saveError=e.message;updateStatus();throw e;}
      finally{saving=null;updateStatus();}
    })();return saving;
  }
  function renderAll(){if(!b)return;renderPages();renderStage();renderInspector();updateStatus();}
  function renderPages(){syncTurn();$('page-list').innerHTML=b.pages.map((p,i)=>`<button class="book-thumb" draggable="${editable()}" data-page="${p.id}" aria-current="${p.id===active}" aria-label="${esc(p.role==='page'?'Page '+i:p.title)}"><span class="book-thumb-preview">${M.svg(p,renderedAssets)}</span><span>${esc(p.role==='page'?'Page '+i:p.title)}</span></button>`).join('');}
  const layoutRules=new Map();let layoutCount=0;
  function layoutRule(selector,properties){const sheet=Array.from(document.styleSheets).find(s=>s.href&&s.href.includes('book-studio.css'));if(!sheet)return;layoutRules.set(selector,Object.entries(properties).map(([key,value])=>key.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())+':'+value).join(';'));while(layoutCount){sheet.deleteRule(sheet.cssRules.length-1);layoutCount--;}for(const [target,body] of layoutRules){sheet.insertRule(target+'{'+body+'}',sheet.cssRules.length);layoutCount++;}}
  function fitStage(){if(!b||!$('book-spread').children.length)return;const count=$('book-spread').children.length,rect=$('book-viewport').getBoundingClientRect();const height=Math.max(120,Math.min(rect.height-58,(rect.width-64)/count/M.W*M.H))*zoom;layoutRule('.book-sheet',{width:(height/M.H*M.W)+'px',height:height+'px'});$('zoom-value').textContent=Math.round(zoom*100)+'%';renderSelection();}
  function renderStage(direction=0){
    const spreads=syncTurn(),ids=spreads[turn]||spreads[0];
    $('book-spread').className='book-spread'+(ids.length===2?' two-pages':'')+(direction>0?' book-turn':direction<0?' book-turn-back':'');
    $('book-spread').innerHTML=ids.map(pid=>{const p=b.pages.find(p=>p.id===pid);return p?`<div class="book-sheet" data-page-id="${p.id}" data-active="${p.id===active}" tabindex="0" aria-label="${esc(p.title||'Book page')}">${rulers?'<div class="book-ruler"><span>0</span><span>50</span><span>100</span><span>148.5 mm</span></div>':''}${M.svg(p,renderedAssets,{guides:guides&&!reading})}</div>`:'<div class="book-sheet blank" aria-label="Blank page"></div>';}).join('');
    const p=page(),index=b.pages.indexOf(p);$('page-position').textContent=p.role==='front'?'Front cover':p.role==='back'?'Back cover':ids.filter(Boolean).map(id=>b.pages.findIndex(p=>p.id===id)).join('–')+' / '+(b.pages.length-2);
    $('first-page').disabled=$('prev-page').disabled=turn===0;$('last-page').disabled=$('next-page').disabled=turn===spreads.length-1;
    document.title=b.title+' · Book Studio';fitStage();
  }
  function renderSelection(){for(const key of layoutRules.keys())if(key.startsWith('.book-selection'))layoutRules.delete(key);document.querySelectorAll('.book-selection').forEach(el=>el.remove());if(reading||!editable())return;const sheet=$('book-spread').querySelector('[data-page-id="'+active+'"]');if(!sheet)return;const scale=sheet.clientWidth/M.W;selected.forEach(id=>{const o=page().items.find(x=>x.id===id);if(!o||o.locked)return;const el=document.createElement('div');el.className='book-selection';el.dataset.object=id;layoutRule('.book-selection[data-object="'+id+'"]',{left:o.x*scale+'px',top:o.y*scale+'px',width:o.w*scale+'px',height:o.h*scale+'px',transform:'rotate('+o.rotation+'deg)'});el.innerHTML=['nw','ne','sw','se'].map(c=>`<button class="book-handle ${c}" data-handle="${c}" data-object="${id}" aria-label="Resize ${esc(o.name)} from ${c}"></button>`).join('');sheet.appendChild(el);});}
  function go(offset,absolute){const spreads=currentSpreads();turn=absolute===undefined?M.clamp(turn+offset,0,spreads.length-1):absolute;const prev=active;active=spreads[turn].find(Boolean);selected=[];selectionRange=null;renderStage(offset|| (prev===active?0:1));renderPages();renderInspector();}
  function renderInspector(){
    if(!b)return;const p=page(),o=item(),disabled=!editable();let html=`<div class="book-panel-heading"><h2>${o?esc(o.name||o.type):'Page settings'}</h2><button class="icon-btn" id="close-inspector" aria-label="Close settings">×</button></div>`;
    if(disabled)html+='<p class="book-status-banner">'+(b.deleted?'Restore this book from your bookshelf to edit it.':b.local?'':b.editor?esc(b.editor.name)+' is editing. You can read and leave comments.':'You are viewing this book.')+'</p>';
    if(o){
      html+=field('Object name','name',o.name);
      if(o.type==='text'){
        html+=`<label class="book-field"><span>Text</span><textarea id="object-text" aria-label="Text">${esc(o.runs&&o.runs.length?o.runs.map(r=>r.text).join(''):o.text)}</textarea></label>`;
        html+=selectField('Text style','styleName',o.styleName,[['','Custom'],['heading','Heading'],['body','Body'],['caption','Caption']]);
        html+=selectField('Font','style.font',o['style'].font,['Andika','Playpen Sans','Nunito','Comic Neue','Fraunces']);
        html+='<div class="book-row">'+field('Size (pt)','style.size',o['style'].size,'number','min="6" max="160"')+field('Color','style.color',o['style'].color,'color')+'</div>';
        const weights=o['style'].font==='Andika'?[400,700]:o['style'].font==='Comic Neue'?[300,400,700]:null;
        html+=weights?selectField('Thickness','style.weight',o['style'].weight,weights.map(w=>[w,w===300?'Light':w===400?'Regular':'Bold'])):field('Thickness · '+o['style'].weight,'style.weight',o['style'].weight,'range',`min="${o['style'].font==='Nunito'?200:100}" max="${o['style'].font==='Playpen Sans'?800:o['style'].font==='Fraunces'?900:1000}" step="10"`);
        html+='<div class="book-segmented">'+[['italic','Italic'],['underline','Underline'],['highlightOn','Highlight']].map(([key,label])=>`<button data-style-toggle="${key}"${key==='italic'&&o['style'].font==='Playpen Sans'?' disabled title="This font has no italic style"':''} aria-pressed="${o.style[key]}">${label}</button>`).join('')+'</div>';
        html+=selectField('Alignment','style.align',o['style'].align,[['left','Left'],['center','Center'],['right','Right']]);
        html+='<details><summary>Text spacing & effects</summary><div class="book-row">'+field('Line spacing','style.lineHeight',o['style'].lineHeight,'number','min="0.8" max="3" step="0.1"')+field('Letter spacing','style.letterSpacing',o['style'].letterSpacing,'number','min="-2" max="10" step="0.2"')+'</div>'+field('Outline','style.outline',o['style'].outline,'range','min="0" max="4" step="0.1"')+field('Highlight color','style.highlight',o['style'].highlight,'color')+'<button class="secondary-btn" id="save-text-style">Update book text style</button></details>';
      }
      if(o.type==='image'){
        html+='<div class="book-segmented">'+[['small','Small'],['medium','Medium'],['large','Large'],['fit','Fit page']].map(([v,l])=>`<button data-size="${v}">${l}</button>`).join('')+'</div>';
        html+=toggle('Keep proportions','aspectLock',o.aspectLock);
        html+='<div class="book-row"><button class="secondary-btn" id="replace-image">Replace</button><button class="secondary-btn" id="illustration-assistant">Illustration prompt</button></div>';
        html+=selectField('Image fit','fit',o.fit,[['contain','Show whole image'],['cover','Crop to fill']]);
        html+='<details><summary>Crop & edges</summary>'+field('Horizontal crop','cropX',o.cropX,'range','min="0" max="100"')+field('Vertical crop','cropY',o.cropY,'range','min="0" max="100"')+selectField('Mask','mask',o.mask,[['none','Rectangle'],['rounded','Rounded'],['circle','Oval']])+field('Soft edges','feather',o.feather,'range','min="0" max="20"')+'</details>';
        html+='<div class="book-button-stack"><button class="secondary-btn" id="fill-page">Fill page</button><button class="secondary-btn" id="span-pages">'+(o.spanId?'Split spread illustration':'Span both pages')+'</button><button class="ghost-btn" id="download-original">Download original</button></div>';
      }
      if(o.type==='shape')html+=selectField('Shape','shape',o.shape,M.shapeOptions.map(s=>[s.value,s.label]));
      if(['shape','arrow','drawing','table','flow'].includes(o.type))html+='<div class="book-row">'+field('Fill','fill',o.fill,'color')+field('Line','stroke',o.stroke,'color')+'</div>'+field('Line thickness','strokeWidth',o.strokeWidth,'range','min="0.1" max="10" step="0.1"');
      if(o.type==='table')html+=`<label class="book-field"><span>Table · separate columns with |</span><textarea id="table-content">${esc(o.cells.map(r=>r.join(' | ')).join('\n'))}</textarea></label>`;
      if(o.type==='flow')html+=`<label class="book-field"><span>Steps · one per line</span><textarea id="flow-content">${esc(o.steps.join('\n'))}</textarea></label>`;
      html+='<h3>Position & size</h3><div class="book-row">'+field('Width (mm)','w',+o.w.toFixed(1),'number','min="1" max="297" step="0.5"')+field('Height (mm)','h',+o.h.toFixed(1),'number','min="1" max="420" step="0.5"')+'</div><details><summary>More position controls</summary><div class="book-row">'+field('Left (mm)','x',+o.x.toFixed(1),'number','step="0.5"')+field('Top (mm)','y',+o.y.toFixed(1),'number','step="0.5"')+'</div>'+field('Rotation','rotation',o.rotation,'range','min="-180" max="180"')+field('Opacity','opacity',o.opacity,'range','min="0.1" max="1" step="0.05"')+'</details>';
      html+='<div class="book-segmented"><button data-align="left">Left</button><button data-align="center">Center</button><button data-align="right">Right</button></div><div class="book-row"><button class="secondary-btn" id="duplicate-object">Duplicate</button><button class="ghost-btn book-danger" id="delete-object">Delete</button></div>';
      if(selected.length>1||o.group)html+='<button class="secondary-btn" id="group-objects">'+(o.group?'Ungroup':'Group selected')+'</button>';
    } else {
      html+=field('Page title','page.title',p.title)+field('Paper color','page.background',p.background,'color')+selectField('Paper','page.texture',p.texture,[['plain','Plain'],['grain','Subtle grain'],['lined','Lined'],['dots','Dotted'],['grid','Grid']]);
      html+=toggle('Print-safe guides','guides',guides)+toggle('Snap to grid','snap',snap)+toggle('Ruler','rulers',rulers);
      html+='<div class="book-button-stack"><button class="secondary-btn" id="duplicate-page">Duplicate page</button><button class="secondary-btn" id="duplicate-spread">Duplicate spread</button><button class="ghost-btn book-danger" id="delete-page">Delete page</button></div><h3>Book colors</h3><div class="book-row">'+b.palette.slice(0,4).map((c,i)=>field('Color '+(i+1),'palette.'+i,c,'color')).join('')+'</div><button class="secondary-btn" id="illustration-assistant">Illustration prompt</button>';
    }
    if(tool!=='select')html+='<h3>Drawing</h3>'+selectField('Tool','tool',tool,[['select','Select'],['pen','Pen'],['pencil','Pencil'],['highlighter','Highlighter'],['eraser','Eraser']])+field('Color','brushColor',brushColor,'color')+field('Thickness','brushWidth',brushWidth,'range','min="0.2" max="6" step="0.1"');
    html+='<h3>Layers</h3>'+p.items.slice().reverse().map(o=>`<div class="book-layer${selected.includes(o.id)?' selected':''}"><button data-select-object="${o.id}">${esc(o.name||o.type)}</button><button class="icon-btn" data-layer-up="${o.id}" aria-label="Move ${esc(o.name)} forward">↑</button><button class="icon-btn" data-lock="${o.id}" aria-label="${o.locked?'Unlock':'Lock'} ${esc(o.name)}">${o.locked?'●':'○'}</button><button class="icon-btn" data-hide="${o.id}" aria-label="${o.hidden?'Show':'Hide'} ${esc(o.name)}">${o.hidden?'−':'◉'}</button></div>`).join('');
    $('inspector').innerHTML=html;
    if(disabled)$('inspector').querySelectorAll('input,textarea,select,button:not(#close-inspector)').forEach(e=>e.disabled=true);
  }
  function applyStyle(key,value){const o=item();if(!o)return;const range=selectionRange;
    if(range&&range.end>range.start&&o.type==='text'){
      const runs=o.runs&&o.runs.length?o.runs:[{text:o.text,style:{...o.style}}];let offset=0,next=[];
      runs.forEach(r=>{const end=offset+r.text.length,startCut=Math.max(0,range.start-offset),endCut=Math.min(r.text.length,range.end-offset);if(startCut<endCut){if(startCut)next.push({text:r.text.slice(0,startCut),style:{...r.style}});next.push({text:r.text.slice(startCut,endCut),style:{...r.style,[key]:value}});if(endCut<r.text.length)next.push({text:r.text.slice(endCut),style:{...r.style}});}else next.push(r);offset=end;});o.runs=next;
    }else{o.style[key]=value;if(o.runs)o.runs=o.runs.map(r=>({...r,style:{...r.style,[key]:value}}));}
  }
  let brushColor='#263343',brushWidth=.8;
  function changeField(input){
    const name=input.dataset.field;if(!name)return;
    const value=input.type==='checkbox'?input.checked:['range','number'].includes(input.type)?Number(input.value):input.value;
    if(['guides','snap','rulers','tool','brushColor','brushWidth'].includes(name)){if(name==='guides')guides=value;if(name==='snap')snap=value;if(name==='rulers')rulers=value;if(name==='tool')tool=value;if(name==='brushColor')brushColor=value;if(name==='brushWidth')brushWidth=value;renderStage();return;}
    if(!checkpoint())return;const o=item();
    if(name.startsWith('page.'))page()[name.slice(5)]=value;
    else if(name.startsWith('palette.'))b.palette[+name.split('.')[1]]=value;
    else if(o){
      if(name.startsWith('style.')){applyStyle(name.slice(6),value);if(name==='style.font'){
        if(value==='Andika')applyStyle('weight',o['style'].weight>=600?700:400);
        if(value==='Comic Neue')applyStyle('weight',o['style'].weight<350?300:o['style'].weight<600?400:700);
        if(value==='Playpen Sans'){applyStyle('weight',Math.min(800,o['style'].weight));applyStyle('italic',false);}
      }}else if(name==='styleName'){o.styleName=value;if(b.styles[value]){o.style=M.clone(b.styles[value]);o.runs=[];}}
      else {const oldW=o.w,oldH=o.h;if((name==='w'||name==='h')&&o.type==='image'&&o.aspectLock){const ratio=o.w/o.h;if(name==='w')o.h=Math.max(.2,value/ratio);else o.w=Math.max(.2,value*ratio);}o[name]=value;if(['w','h'].includes(name))o[name]=M.clamp(value,.2,name==='w'?297:420);if(o.type==='drawing'&&['w','h'].includes(name))o.points=o.points.map(p=>[p[0]*o.w/oldW,p[1]*o.h/oldH,p[2]]);}
    }
    changed(false);renderStage();renderPages();if(input.tagName==='SELECT'||input.type==='checkbox')renderInspector();
  }
  function syncLinkedItems(){const o=item();if(!o||!o.spanId)return;b.pages.forEach(p=>p.items.forEach(other=>{if(other.spanId===o.spanId&&other.id!==o.id){const keep={id:other.id,spanSide:other.spanSide};Object.assign(other,M.clone(o),keep);}}));}
  function keepSpreadsTogether(){const result=M.preserveSpreads(b.pages);if(result.length>100){const previous=undoStack.pop();if(previous){const {activePage,...snapshot}=previous;Object.assign(b,snapshot);active=activePage;}throw new Error('This change needs a blank page to keep the spread together. The book is at its page limit.');}b.pages=result;}
  function addObject(type){if(!checkpoint())return;const styles=type==='text'?{style:M.clone(b.styles.body),styleName:'body'}:{};const o=M.object(type,styles);if(type==='shape'){o.w=42;o.h=42;o.x=53;o.y=74;}if(type==='image')return;page().items.push(o);selected=[o.id];tool='select';changed();if(window.innerWidth<=780)$('inspector').classList.add('mobile-open');}
  function addPage(){if(!checkpoint())return;if(b.pages.length>=100){notify('This book has reached 100 pages.',true);return;}const index=Math.min(b.pages.length-1,Math.max(1,b.pages.indexOf(page())+1));const p=M.page();p.background=page().background;p.texture=page().texture;b.pages.splice(index,0,p);keepSpreadsTogether();active=p.id;selected=[];changed();}
  function deletePage(){const p=page();if(p.role!=='page'){notify('Keep the cover and back cover. You can clear their objects instead.');return;}if(b.pages.length<=4){notify('Keep at least two inside pages in your book.');return;}if(!checkpoint())return;const i=b.pages.indexOf(p);if(p.items.some(o=>o.spanId)){notify('Split the spread illustration before deleting this page.');return;}b.deletedPages.push(p);b.pages.splice(i,1);keepSpreadsTogether();active=b.pages[Math.min(i,b.pages.length-1)].id;selected=[];changed();}
  function copyPage(p){const next=M.clone(p);next.id=M.id();next.role='page';next.title=p.title+' copy';const groups={};next.items.forEach(o=>{o.id=M.id();if(o.group)o.group=groups[o.group]||(groups[o.group]=M.id());});return next;}
  function duplicatePages(spread){if(!checkpoint())return;const sources=spread?currentSpreads()[turn].filter(Boolean).map(id=>b.pages.find(p=>p.id===id)):[page()];if(!spread&&page().items.some(o=>o.spanId)){notify('Use Duplicate spread to keep this illustration together.');return;}if(b.pages.length+sources.length>100){notify('This book has reached its page limit.');return;}const copies=sources.map(copyPage),spanMap={};copies.forEach(p=>p.items.forEach(o=>{if(o.spanId)o.spanId=spanMap[o.spanId]||(spanMap[o.spanId]=M.id());}));b.pages.splice(Math.min(b.pages.length-1,b.pages.indexOf(sources[sources.length-1])+1),0,...copies);keepSpreadsTogether();active=copies[0].id;selected=[];changed();}
  function duplicateObject(){if(!checkpoint())return;const copies=page().items.filter(o=>selected.includes(o.id)).map(o=>({...M.clone(o),id:M.id(),x:Math.min(M.W-o.w,o.x+4),y:Math.min(M.H-o.h,o.y+4),spanId:'',spanSide:'',group:''}));page().items.push(...copies);selected=copies.map(o=>o.id);changed();}
  function deleteObjects(){if(!checkpoint())return;const spanIds=page().items.filter(o=>selected.includes(o.id)).map(o=>o.spanId).filter(Boolean);b.pages.forEach(p=>{p.items=p.items.filter(o=>!selected.includes(o.id)&&!spanIds.includes(o.spanId));});selected=[];changed();}
  function undo(redo=false){if(!editable())return;const from=redo?redoStack:undoStack,to=redo?undoStack:redoStack;if(!from.length)return;to.push(M.clone({pages:b.pages,deletedPages:b.deletedPages,...metadata(),activePage:active}));const {activePage,...snapshot}=from.pop();Object.assign(b,snapshot);active=b.pages.some(p=>p.id===activePage)?activePage:b.pages[0].id;selected=[];changed();}
  function sizeImage(preset){const o=item(),a=b.assets.find(a=>a.id===o.assetId);if(!o||!a||!checkpoint())return;Object.assign(o,M.imageSize(a.width,a.height,preset));o.x=M.clamp(o.x,0,M.W-o.w);o.y=M.clamp(o.y,0,M.H-o.h);changed();}
  function spanImage(){const o=item();if(!o||!checkpoint())return;if(o.spanId){const span=o.spanId;b.pages.forEach(p=>{p.items=p.items.filter(x=>x.spanId!==span||x.id===o.id);});o.spanId='';o.spanSide='';changed();return;}const ids=M.spreads(b.pages).find(s=>s.includes(active));if(!ids||ids.length!==2||!ids.every(Boolean)){notify('Choose two facing inside pages first.');return;}const span=M.id(),left=b.pages.find(p=>p.id===ids[0]),right=b.pages.find(p=>p.id===ids[1]);page().items=page().items.filter(x=>x.id!==o.id);const h=Math.min(M.H,o.h),y=M.clamp(o.y,0,M.H-h);left.items.push({...M.clone(o),id:M.id(),spanId:span,spanSide:'left',x:0,y,w:M.W,h,fit:'cover'});right.items.push({...M.clone(o),id:M.id(),spanId:span,spanSide:'right',x:0,y,w:M.W,h,fit:'cover'});selected=[];changed();}
  function resizePoint(o,delta,corner){let x=o.x,y=o.y,w=o.w,h=o.h;const left=corner.includes('w'),top=corner.includes('n');w=Math.max(2,o.w+(left?-delta.x:delta.x));h=Math.max(2,o.h+(top?-delta.y:delta.y));if(o.aspectLock&&o.type==='image'){const ratio=o.w/o.h;if(Math.abs(delta.x)>Math.abs(delta.y))h=w/ratio;else w=h*ratio;}if(left)x=o.x+o.w-w;if(top)y=o.y+o.h-h;return {x,y,w:Math.min(297,w),h:Math.min(420,h)};}
  function pointer(event){
    const sheet=event.target.closest('[data-page-id]');if(!sheet||!b)return;
    const pid=sheet.dataset.pageId;if(pid!==active){active=pid;selected=[];}
    if(!editable()||reading){const startX=event.clientX;sheet.onpointerup=e=>{if(Math.abs(e.clientX-startX)>60)go(e.clientX<startX?1:-1);sheet.onpointerup=null;};return;}
    const rect=sheet.getBoundingClientRect(),scale=rect.width/M.W,start={x:(event.clientX-rect.left)/scale,y:(event.clientY-rect.top)/scale};
    const objectNode=event.target.closest('[data-object]'),handle=event.target.closest('[data-handle]');
    if(tool==='eraser'){const target=objectNode&&page().items.find(o=>o.id===objectNode.dataset.object);if(target&&target.type==='drawing'&&checkpoint()){page().items=page().items.filter(o=>o!==target);changed();}return;}
    if(['pen','pencil','highlighter'].includes(tool)){
      if(!checkpoint())return;const p=page(),o=M.object('drawing',{name:tool==='pen'?'Pen drawing':tool==='pencil'?'Pencil drawing':'Highlight',x:0,y:0,w:M.W,h:M.H,brush:tool,stroke:brushColor,strokeWidth:brushWidth,points:[[start.x,start.y,event.pressure||.5]]});p.items.push(o);selected=[];
      const move=e=>{if(o.points.length>=3000)return;const x=M.clamp((e.clientX-rect.left)/scale,0,M.W),y=M.clamp((e.clientY-rect.top)/scale,0,M.H);const last=o.points[o.points.length-1];if(Math.hypot(x-last[0],y-last[1])<.3)return;o.points.push([x,y,e.pressure||.5]);renderStage();};
      const up=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',up);const xs=o.points.map(p=>p[0]),ys=o.points.map(p=>p[1]);o.x=Math.min(...xs);o.y=Math.min(...ys);o.w=Math.max(1,Math.max(...xs)-o.x);o.h=Math.max(1,Math.max(...ys)-o.y);o.points=o.points.map(p=>[p[0]-o.x,p[1]-o.y,p[2]]);changed();};document.addEventListener('pointermove',move);document.addEventListener('pointerup',up);document.addEventListener('pointercancel',up);event.preventDefault();return;
    }
    if(!objectNode){selected=[];selectionRange=null;renderSelection();renderInspector();const sx=event.clientX;const release=e=>{if((start.x<12||start.x>M.W-12)&&Math.abs(e.clientX-sx)>70)go(e.clientX<sx?1:-1);document.removeEventListener('pointerup',release);};document.addEventListener('pointerup',release);return;}
    const o=page().items.find(x=>x.id===objectNode.dataset.object);if(!o||o.locked)return;
    if(event.shiftKey&&!handle){selected=selected.includes(o.id)?selected.filter(id=>id!==o.id):selected.concat(o.id);renderSelection();renderInspector();return;}
    if(!selected.includes(o.id))selected=o.group?page().items.filter(x=>x.group===o.group&&!x.locked).map(x=>x.id):[o.id];
    selectionRange=null;renderSelection();renderInspector();
    const originals=page().items.filter(x=>selected.includes(x.id)).map(M.clone);let moved=false;
    const move=e=>{const delta={x:(e.clientX-event.clientX)/scale,y:(e.clientY-event.clientY)/scale};if(!moved&&Math.hypot(delta.x,delta.y)<.5)return;if(!moved){checkpoint();moved=true;}originals.forEach(original=>{const target=page().items.find(x=>x.id===original.id);if(!target)return;if(handle){Object.assign(target,resizePoint(original,delta,handle.dataset.handle));if(target.type==='drawing')target.points=original.points.map(p=>[p[0]*target.w/original.w,p[1]*target.h/original.h,p[2]]);}else{target.x=M.clamp(original.x+delta.x,-target.w+4,M.W-4);target.y=M.clamp(original.y+delta.y,-target.h+4,M.H-4);if(snap&&!e.altKey){target.x=Math.round(target.x/2)*2;target.y=Math.round(target.y/2)*2;}}});syncLinkedItems();renderStage();};
    const up=()=>{document.removeEventListener('pointermove',move);document.removeEventListener('pointerup',up);document.removeEventListener('pointercancel',up);if(moved)changed();};document.addEventListener('pointermove',move);document.addEventListener('pointerup',up);document.addEventListener('pointercancel',up);event.preventDefault();
  }
  async function imageInfo(file){if(!['image/png','image/jpeg','image/webp'].includes(file.type))throw new Error('Choose a PNG, JPEG or WebP image.');if(file.size>10*1024*1024)throw new Error('This image is larger than 10 MB. Choose a smaller file.');let bitmap;try{bitmap=await createImageBitmap(file);}catch(_){throw new Error('This image could not be opened. Try saving it again as a PNG, JPEG or WebP.');}const dimensions={width:bitmap.width,height:bitmap.height};bitmap.close();if(dimensions.width*dimensions.height>32000000)throw new Error('Resize this image to at most 32 megapixels.');return dimensions;}
  async function importImages(files,pid,point){
    if(!editable()){notify('Start an editing turn before adding images.');return;}
    const current=b,p=current.pages.find(p=>p.id===pid)||page();if(!checkpoint())return;
    uploads++;let offset=0;try{for(const file of Array.from(files)){
      const progress=document.createElement('div');progress.className='book-upload';progress.textContent='Adding '+file.name+'…';$('upload-list').appendChild(progress);
      try{
        const dims=await imageInfo(file);if(current.assets.reduce((n,a)=>n+a.size,0)+file.size>25*1024*1024)throw new Error('This book has reached its image allowance.');
        const aid=M.id(),asset={id:aid,name:file.name||'Pasted image',size:file.size,...dims,mime:file.type,local:true};
        await D.putAsset({...asset,blob:file});current.assets.push(asset);renderedAssets[aid]={src:URL.createObjectURL(file),...dims,blob:file};
        const old=replacement&&p.items.find(o=>o.id===replacement);let o;
        if(old){o=old;if(!o.originalAssetId)o.originalAssetId=o.assetId;o.assetId=aid;replacement='';}
        else{const size=M.imageSize(dims.width,dims.height);o=M.object('image',{...size,assetId:aid,name:asset.name,x:M.clamp((point?point.x-size.w/2:(M.W-size.w)/2)+offset,0,M.W-size.w),y:M.clamp((point?point.y-size.h/2:(M.H-size.h)/2)+offset,0,M.H-size.h)});p.items.push(o);offset+=5;}
        if(b===current){active=p.id;selected=[o.id];changed();}
        progress.textContent=file.name+' · Saved on this device';
        if(!current.local){
          try{await uploadOne(asset,file,current);progress.remove();}
          catch(e){saveError=e.message;updateStatus();progress.textContent=file.name+' · '+e.message;const retry=document.createElement('button');retry.className='secondary-btn';retry.textContent='Retry';retry.onclick=action(async()=>{if(b!==current)throw new Error('Open this book before retrying.');await uploadOne(asset,file,current);progress.remove();});progress.appendChild(retry);}
        }else setTimeout(()=>progress.remove(),2500);
      }catch(e){progress.textContent=e.message;setTimeout(()=>progress.remove(),9000);}
    }
    }finally{uploads--;changed();}
  }
  async function uploadOne(asset,file,current){
    // Flush only after remapping all local references, so no local asset IDs reach cloud pages.
    clearTimeout(saveTimer);if(saving)await saving;
    if(!leaseToken)throw new Error('Start a new editing turn, then retry the image upload.');
    const form=new FormData();form.append('image',file,asset.name);form.append('lease_token',leaseToken);form.append('base_revision',current.revision);
    const result=await api('/api/books/'+current.id+'/assets',{method:'POST',body:form}),remote=result.asset;
    await D.putAsset({...remote,blob:file});renderedAssets[remote.id]=renderedAssets[asset.id];
    current.pages.concat(current.deletedPages||[],...(current.versions||[]).map(v=>v.pages.concat(v.deletedPages||[])),...undoStack.map(v=>v.pages.concat(v.deletedPages||[])),...redoStack.map(v=>v.pages.concat(v.deletedPages||[]))).forEach(p=>p.items.forEach(o=>{if(o.assetId===asset.id)o.assetId=remote.id;if(o.originalAssetId===asset.id)o.originalAssetId=remote.id;}));
    current.assets=current.assets.map(a=>a.id===asset.id?remote:a);
    if(b===current){changed();if(!uploads&&!current.assets.some(a=>a.local))await persist();}
  }
  async function publish(){
    if(!user){await signIn();if(!user)return;}
    if(!b.local)return;
    const old=M.clone(b),draftId=b.id;const initial=M.clone(b.pages);initial.forEach(p=>p.items.forEach(o=>{o.assetId='';o.originalAssetId='';}));
    const result=await api('/api/books',{method:'POST',body:JSON.stringify({...metadata(),pages:initial})});
    Object.assign(b,result.book,{local:false,role:'owner'});await acquire();
    try{for(const a of old.assets){const stored=await D.getAsset(a.id);if(stored&&stored.blob)await uploadOne(a,stored.blob,b);}changed();await persist();if(b.assets.some(a=>a.local))throw new Error('Some images still need to upload. Your local copy is safe.');for(const v of b.versions||[]){await api('/api/books/'+b.id+'/history',{method:'POST',body:JSON.stringify({name:v.name,pages:v.pages.concat(v.deletedPages||[]),page_ids:v.pages.map(p=>p.id),deleted_page_ids:(v.deletedPages||[]).map(p=>p.id),metadata:v.metadata||metadata(),lease_token:leaseToken,base_revision:b.revision})});}await D.deleteBook(draftId);history.replaceState({},'','/books/'+b.id);notify('Your book is saved to your account.');}
    catch(e){await D.putBook({...old,id:draftId});throw e;}
    renderAll();
  }
  async function signIn(){try{const provider=new firebase.auth.GoogleAuthProvider();await auth.signInWithPopup(provider);}catch(e){throw new Error(e.code==='auth/popup-blocked'?'Allow the Google sign-in window, then try again.':e.code==='auth/popup-closed-by-user'?'Sign-in was closed. Your local books are still here.':'Google sign-in could not finish. Please try again.');}}
  function download(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000);}
  async function dataUrl(blob){return new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('This image could not be read.'));reader.readAsDataURL(blob);});}
  async function fontCss(pages){
    const families=new Set(pages.flatMap(p=>p.items.filter(o=>['text','flow','table'].includes(o.type)).flatMap(o=>[o['style'].font,...(o.runs||[]).map(r=>r['style'].font)])));
    const response=await fetch('/static/css/book-studio.css'),css=await response.text();
    const faces=css.match(/@font-face\{[^}]+\}/g)||[];let embedded='';
    for(const face of faces){const family=(face.match(/font-family:([^;]+)/)||[])[1]?.replace(/'/g,'');if(!families.has(family))continue;const url=(face.match(/url\('([^']+)'\)/)||[])[1];if(!url)continue;if(!fontCache[url])fontCache[url]=await dataUrl(await (await fetch(url)).blob());embedded+=face.replace(url,fontCache[url]).replace(/font-display:swap/g,'font-display:block');}
    return embedded;
  }
  async function raster(p,assets,fonts,options){
    const svg=M.svg(p,assets,{...options,fonts}).replace('width="148.5" height="210"','width="1754" height="2480"');
    const url=URL.createObjectURL(new Blob([svg],{type:'image/svg+xml'}));
    try{const image=new Image();image.src=url;await image.decode();const canvas=document.createElement('canvas');canvas.width=1754;canvas.height=2480;const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0);const result=canvas.toDataURL('image/png');canvas.width=canvas.height=1;return result;}finally{URL.revokeObjectURL(url);}
  }
  function exportDialog(){const issues=M.checks(b);dialog('Export your book',`<p class="book-muted">Choose how you want to use your book. Your original stays editable here.</p><div class="book-row">${selectField('File','exportFormat','faithful',[['faithful','Word · exact appearance'],['editable','Word · editable text & shapes'],['pdf','PDF · ready to print']])}${selectField('Paper arrangement','arrangement','cut',[['cut','Cut and bind'],['fold','Fold and staple']])}</div><div id="export-advice" class="book-status-banner">Print single-sided on A4 landscape. Cut along the middle and assemble the pages in reading order.</div><div class="book-row">${toggle('Show center guide','exportGuides',true)}${toggle('Save ink','economy',false)}</div>${issues.length?'<details><summary>'+issues.length+' things to check before printing</summary><ul class="book-check-list">'+issues.map(i=>'<li>'+esc(i)+'</li>').join('')+'</ul></details>':'<p class="book-muted">Your pages are ready for a closer look.</p>'}<div id="editable-notes"></div><h3>Sheet preview</h3><div id="print-preview" class="book-print-preview"></div><div class="book-row"><button class="primary-btn" id="download-export">Download</button><button class="secondary-btn" id="download-backup">Download backup</button></div><p class="book-muted" id="export-progress" role="status"></p>`);printPreview();}
  function printPreview(){const arrangement=$('dialog-content').querySelector('[data-field=arrangement]').value,format=$('dialog-content').querySelector('[data-field=exportFormat]').value;const pairs=M.sheetPairs(b.pages,arrangement);$('print-preview').innerHTML=pairs.map((pair,i)=>`<div><div class="book-print-sheet">${pair.map(index=>index===null?'<div class="empty-half"></div>':M.svg(b.pages[index],renderedAssets)).join('')}</div><small class="book-muted">${arrangement==='fold'?'Sheet '+(Math.floor(i/2)+1)+' · '+(i%2?'back':'front'):'Sheet '+(i+1)} · ${pair.map(index=>index===null?'Blank':index===0?'Cover':index===b.pages.length-1?'Back cover':'Page '+index).join(' / ')}</small></div>`).join('');$('export-advice').textContent=(arrangement==='fold'?'Print on both sides of A4 landscape, flipping on the short edge. Pages are already arranged for folding; leave the printer’s booklet option off.':'Print single-sided on A4 landscape. Cut along the middle and assemble the pages in reading order.')+(format==='editable'?' Install the book fonts for the closest match. Word changes stay in the downloaded file.':'');
    const notes=[];if(format==='editable'){b.pages.forEach((p,i)=>p.items.filter(o=>!o.hidden).forEach(o=>{const name=(p.role==='page'?'Page '+i:p.title)+' · '+o.name;if(!M.nativeEligible(o))notes.push(name+': kept as an image.');else if(o.type==='text'){const weights=new Set((o.runs.length?o.runs:[o]).map(r=>r['style'].weight));weights.forEach(w=>{if(![400,700].includes(w))notes.push(name+': thickness '+w+' becomes '+(w>=600?'Bold (700)':'Regular (400)')+'.');});}}));}
    $('editable-notes').innerHTML=format==='editable'?'<p class="book-muted">Text boxes and simple shapes stay editable. Word may adjust wrapping and layer order.</p><details><summary>'+notes.length+' export adjustments</summary><ul class="book-check-list">'+notes.map(n=>'<li>'+esc(n)+'</li>').join('')+'</ul></details><a class="secondary-btn" href="/api/books/fonts" download>Download book fonts</a>':'';
  }
  async function doExport(){
    if(!b.local)await persist();
    if(dirty&&!b.local)throw new Error('Save your latest changes before exporting. Start an editing turn or download a backup.');
    if(b.assets.some(a=>a.local)&&!b.local)throw new Error('Finish uploading your images before exporting.');
    const button=$('download-export');button.disabled=true;
    const snapshot=M.clone(b),format=$('dialog-content').querySelector('[data-field=exportFormat]').value,arrangement=$('dialog-content').querySelector('[data-field=arrangement]').value,economy=$('dialog-content').querySelector('[data-field=economy]').checked,showGuides=$('dialog-content').querySelector('[data-field=exportGuides]').checked;
    try{
      $('export-progress').textContent='Preparing fonts and illustrations…';await document.fonts.ready;
      const fonts=await fontCss(snapshot.pages),assets={};
      for(const a of snapshot.assets){let stored=await D.getAsset(a.id),blob=stored&&stored.blob;if(!snapshot.local){blob=await api('/api/books/'+snapshot.id+'/assets/'+a.id+'?original=1',{},true);}if(blob)assets[a.id]={src:await dataUrl(blob),width:a.width,height:a.height};else throw new Error('An illustration is missing. Reload it before exporting.');}
      const previews=[];for(let i=0;i<snapshot.pages.length;i++){$('export-progress').textContent='Preparing page '+(i+1)+' of '+snapshot.pages.length+'…';previews.push(await raster(snapshot.pages[i],assets,fonts,{editable:format==='editable',economy}));}
      $('export-progress').textContent='Creating your download…';
      const blob=await api('/api/books/export',{method:'POST',body:JSON.stringify({title:snapshot.title,pages:snapshot.pages,previews,format,arrangement,economy,guides:showGuides,book_id:snapshot.local?null:snapshot.id,revision:snapshot.revision})},true);
      download(blob,(snapshot.title||'Book')+' - '+(arrangement==='fold'?'fold and staple':'cut and bind')+(format==='editable'?' - editable':'')+'.'+(format==='pdf'?'pdf':'docx'));$('export-progress').textContent='Your book is ready. Check your downloads.';
    }finally{button.disabled=false;}
  }
  async function backup(){
    const snapshot=M.clone(b),files={};
    if(!snapshot.local){const history=await api('/api/books/'+snapshot.id+'/history?include_pages=1');snapshot.versions=history.versions;}
    files['book.json']=window.BookZip.strToU8(JSON.stringify(snapshot));
    for(const a of snapshot.assets){const stored=await D.getAsset(a.id);let blob=stored&&stored.blob;if(!snapshot.local&&a.ready)blob=await api('/api/books/'+snapshot.id+'/assets/'+a.id+'?original=1',{},true);if(!blob)throw new Error('An illustration is missing. Load it before downloading a backup.');files['assets/'+a.id]=new Uint8Array(await blob.arrayBuffer());}
    download(new Blob([window.BookZip.zipSync(files,{level:1})],{type:'application/zip'}),snapshot.title+' - backup.zip');notify('Backup downloaded.');
  }
  async function importBackup(file){
    if(file.size>40*1024*1024)throw new Error('Choose a backup smaller than 40 MB.');let uncompressed=0;
    const entries=window.BookZip.unzipSync(new Uint8Array(await file.arrayBuffer()),{filter:entry=>{uncompressed+=entry.originalSize;if(uncompressed>80*1024*1024)throw new Error('This backup is too large.');return entry.name==='book.json'||/^assets\/[a-zA-Z0-9_-]+$/.test(entry.name);}});
    if(!entries['book.json'])throw new Error('This is not a Book Studio backup.');const raw=M.readBackup(JSON.parse(window.BookZip.strFromU8(entries['book.json'])));
    const next={...raw,assets:[]},mapping={};let assetBytes=0;
    for(const old of raw.assets){const bytes=entries['assets/'+old.id];if(!bytes)throw new Error('An illustration is missing from this backup.');const blob=new Blob([bytes],{type:old.mime});assetBytes+=blob.size;if(assetBytes>25*1024*1024)throw new Error('This backup exceeds the book image allowance.');const info=await imageInfo(blob),aid=M.id();mapping[old.id]=aid;const asset={...old,...info,id:aid,local:true,ready:false,size:blob.size};await D.putAsset({...asset,blob});next.assets.push(asset);}
    next.pages.concat(next.deletedPages,...next.versions.map(v=>v.pages.concat(v.deletedPages))).forEach(p=>p.items.forEach(o=>{if(o.assetId)o.assetId=mapping[o.assetId]||'';if(o.originalAssetId)o.originalAssetId=mapping[o.originalAssetId]||'';}));await D.putBook(next);await openBook(next.id);notify('Backup opened as a new local book.');
  }
  async function shareDialog(){if(b.local){dialog('Save your book to share it','<p class="book-muted">Save this book to your account first. Then you can invite people or create a sharing link.</p><button class="primary-btn" id="publish-book">Save to my account</button>');return;}if(b.role!=='owner'){notify('Only the owner can change sharing.');return;}await persist();const settings=await api('/api/books/'+b.id+'/sharing');dialog('Share your book',`<p class="book-muted">Your book is private until you invite someone or create a link. Only one person edits at a time.</p><h3>Invite by email</h3><div class="book-row">${field('Email address','inviteEmail','','email')}${selectField('Access','inviteRole','edit',[['view','View & comment'],['edit','Edit']])}</div><button class="secondary-btn" id="invite-member">Add person</button><div id="members">${Object.entries(settings.members).map(([email,role])=>`<p>${esc(email)} · ${role==='edit'?'Edit':'View'} <button class="ghost-btn" data-remove-member="${esc(email)}">Remove</button></p>`).join('')}</div><h3>Sharing link</h3><div class="book-row">${selectField('Access','linkRole','view',[['view','View & comment'],['edit','Edit']])}${selectField('Expires','linkDays',7,[[7,'In 7 days'],[30,'In 30 days'],[0,'No expiry']])}</div>${toggle('Require sign-in','linkSignin',false)}<button class="primary-btn" id="create-link">Create link</button><div id="share-result"></div><h3>Existing links</h3>${settings.links.filter(l=>!l.revoked).map(l=>`<p>${l.role==='edit'?'Edit':'View'} link · ${l.require_signin?'Sign-in required':'Guests welcome'} <button class="ghost-btn" data-revoke="${l.id}">Turn off</button></p>`).join('')||'<p class="book-muted">No active links.</p>'}`);$('dialog-content')._members=settings.members;}
  async function invite(remove){const members={...$('dialog-content')._members};if(remove)delete members[remove];else{const email=$('dialog-content').querySelector('[data-field=inviteEmail]').value.trim().toLowerCase();members[email]=$('dialog-content').querySelector('[data-field=inviteRole]').value;}await api('/api/books/'+b.id+'/sharing',{method:'POST',body:JSON.stringify({members})});leaseToken='';await reloadRemote();await shareDialog();notify(remove?'Access removed.':'Access added. Share the book address with them.');}
  async function createLink(){const role=$('dialog-content').querySelector('[data-field=linkRole]').value,days=+$('dialog-content').querySelector('[data-field=linkDays]').value,require_signin=$('dialog-content').querySelector('[data-field=linkSignin]').checked;const result=await api('/api/books/'+b.id+'/sharing',{method:'POST',body:JSON.stringify({role,days,require_signin})});$('share-result').innerHTML=`<label class="book-field"><span>Share this link</span><input id="share-url" readonly value="${esc(result.url)}"></label><button class="secondary-btn" id="copy-link">Copy link</button>`;}
  async function reloadRemote(){if(!b||b.local)return;const result=await api('/api/books/'+b.id+'?since='+b.revision),remote=result.book;const pagesById=new Map(b.pages.concat(b.deletedPages||[],result.pages).map(p=>[p.id,p]));Object.assign(b,remote,{pages:remote.page_ids.map(id=>pagesById.get(id)).filter(Boolean),deletedPages:(remote.deleted_page_ids||[]).map(id=>pagesById.get(id)).filter(Boolean),assets:result.assets,local:false});savedPages=Object.fromEntries(b.pages.concat(b.deletedPages).map(p=>[p.id,JSON.stringify(p)]));if(!b.pages.some(p=>p.id===active))active=b.pages[0].id;await loadAssets();await D.putBook(b);renderAll();}
  function detailsDialog(){dialog('Book details',field('Title','detailsTitle',b.title)+field('Folder','detailsFolder',b.folder)+field('Tags · separate with commas','detailsTags',(b.tags||[]).join(', '))+toggle('Favorite','detailsFavorite',b.favorite)+'<div class="book-row"><button class="primary-btn" id="save-details">Save details</button><button class="secondary-btn" id="copy-book">Make a copy</button></div>'+(b.local?'<button class="secondary-btn" id="publish-book">Save to my account</button>':''));}
  async function copyBook(source=b){if(!source.local){for(const a of source.assets){if(a.ready){const blob=await api('/api/books/'+source.id+'/assets/'+a.id+'?original=1',{},true);await D.putAsset({...a,blob});}}}const next=M.clone(source);if(!source.local)next.versions=(await api('/api/books/'+source.id+'/history?include_pages=1')).versions;next.id='local-'+M.id();next.local=true;next.role='owner';next.revision=0;next.pending=false;next.deleted=false;next.title+=' (copy)';next.updated_at=Date.now()/1000;next.assets=next.assets.map(a=>({...a,local:true}));await D.putBook(next);closeDialog();if(b&&!b.local&&leaseToken)await release();await openBook(next.id);notify('A new copy is ready on this device.');}
  function illustrationDialog(){const p=page(),o=item();dialog('Illustration prompt',`<p class="book-muted">Turn a sketch into artwork that feels at home in your book. Attach your sketch and character references in ChatGPT.</p>${field('Drawing style','illustrationStyle',b.illustration.style)}<label class="book-field"><span>Characters and details to keep</span><textarea id="character-details">${esc(b.illustration.characters)}</textarea></label>${field('Leave space for text','illustrationSpace',b.illustration.space)}${toggle('Blend into page','illustrationBlend',b.illustration.blend)}${toggle('Transparent background','illustrationTransparent',b.illustration.transparent)}<label class="book-field"><span>Your prompt</span><textarea id="illustration-prompt" rows="7">${esc(M.prompt(b,p,o))}</textarea></label><div class="book-row"><button class="primary-btn" id="copy-prompt">Copy prompt</button><a class="secondary-btn" href="${esc(document.body.dataset.chatgptUrl||'https://chatgpt.com/')}" target="_blank" rel="noopener noreferrer">Open ChatGPT</a></div>${o&&o.type==='image'?'<button class="secondary-btn" id="download-reference">Download sketch/reference</button>':''}<p class="book-muted">In ChatGPT, choose image creation, attach your sketch and paste the prompt. Download the result, then drag it onto your book or use Replace.</p>`);}
  function updatePrompt(){if(!editable())return;const get=name=>$('dialog-content').querySelector('[data-field='+name+']');b.illustration={style:get('illustrationStyle').value,characters:$('character-details').value,space:get('illustrationSpace').value,blend:get('illustrationBlend').checked,transparent:get('illustrationTransparent').checked};$('illustration-prompt').value=M.prompt(b,page(),item());changed(false);}
  async function original(reference=false){const o=item(),id=reference?(o.originalAssetId||o.assetId):o.assetId;const a=b.assets.find(a=>a.id===id);if(!a)throw new Error('This original is unavailable.');const stored=await D.getAsset(id),blob=b.local?stored&&stored.blob:await api('/api/books/'+b.id+'/assets/'+id+'?original=1',{},true);if(blob)download(blob,a.name);}
  async function assetsDialog(){await loadAssets();dialog('Your illustrations',`<p class="book-muted">Keep characters and sketches close by. Choose an image to add it to the current page.</p><button class="secondary-btn" id="asset-upload">＋ Add images</button><div class="book-asset-grid">${b.assets.map(a=>`<div class="book-asset-card">${renderedAssets[a.id]?`<img src="${esc(renderedAssets[a.id].src)}" alt="${esc(a.name)}">`:''}<p>${esc(a.name)}</p><button class="secondary-btn" data-use-asset="${a.id}">Add to page</button><button class="ghost-btn" data-remove-asset="${a.id}">Remove unused</button></div>`).join('')}</div>`);}
  async function historyDialog(){let versions=b.versions||[];if(!b.local)versions=(await api('/api/books/'+b.id+'/history')).versions;dialog('History & recovery',`<p class="book-muted">Keep a named version before trying a new idea. Restoring a version can be undone.</p>${field('Version name','versionName','')}<button class="primary-btn" id="save-version">Save version</button><h3>Saved versions</h3>${versions.map(v=>`<p>${esc(v.name)} <button class="secondary-btn" data-restore-version="${v.id}">Restore</button></p>`).join('')||'<p class="book-muted">No named versions yet.</p>'}<h3>Deleted pages</h3>${(b.deletedPages||[]).map(p=>`<p>${esc(p.title)} <button class="secondary-btn" data-restore-page="${p.id}">Restore page</button></p>`).join('')||'<p class="book-muted">No deleted pages.</p>'}<button class="secondary-btn" id="recover-copy">Save recovery copy on this device</button>`);}
  async function saveVersion(){if(!editable())return;const name=$('dialog-content').querySelector('[data-field=versionName]').value||'Saved version';if(b.local){if(b.versions.length>=20)throw new Error('You can keep up to 20 versions per book.');b.versions.push({id:M.id(),name,created_at:Date.now()/1000,pages:M.clone(b.pages),deletedPages:M.clone(b.deletedPages),metadata:M.clone(metadata())});changed(false);await D.putBook(b);}else{await persist();await api('/api/books/'+b.id+'/history',{method:'POST',body:JSON.stringify({name,lease_token:leaseToken,base_revision:b.revision})});}await historyDialog();}
  async function restoreVersion(id){if(!checkpoint())return;let version;if(b.local)version=b.versions.find(v=>v.id===id);else{version=await api('/api/books/'+b.id+'/history',{method:'POST',body:JSON.stringify({restore:id,lease_token:leaseToken,base_revision:b.revision})});version={...version,pages:version.page_ids.map(pid=>version.pages.find(p=>p.id===pid)),deletedPages:(version.deleted_page_ids||[]).map(pid=>version.pages.find(p=>p.id===pid))};}Object.assign(b,version.metadata,{pages:M.clone(version.pages),deletedPages:M.clone(version.deletedPages||[])});active=b.pages[0].id;selected=[];changed();closeDialog();}
  async function commentsDialog(){if(b.local){dialog('Comments','<p class="book-muted">Save your book to your account to invite comments.</p><button class="primary-btn" id="publish-book">Save to my account</button>');return;}const result=await api('/api/books/'+b.id+'/comments');dialog('Comments',`<p class="book-muted">Leave a note on ${esc(page().title)}${item()?' · '+esc(item().name):''}.</p><label class="book-field"><span>Your comment</span><textarea id="comment-text" maxlength="2000"></textarea></label><button class="primary-btn" id="add-comment">Add comment</button><div class="book-comments">${result.comments.filter(c=>!c.resolved).map(c=>`<article><strong>${esc(c.author)}</strong><small> · ${esc((b.pages.find(p=>p.id===c.page_id)||{}).title||'Deleted page')}</small><p>${esc(c.text)}</p><button class="ghost-btn" data-comment-page="${esc(c.page_id)}">Go to page</button><button class="ghost-btn" data-resolve-comment="${c.id}">Resolve</button></article>`).join('')||'<p class="book-muted">No comments yet.</p>'}</div>`);}
  async function bookOptions(id){const source=localBooks.find(x=>x.id===id)||cloudBooks.find(x=>x.id===id);dialog(source.title,`<div class="book-button-stack"><button class="primary-btn" data-open="${id}">Open book</button>${source.role==='owner'||source.local?`<button class="secondary-btn" data-library-favorite="${id}">${source.favorite?'Remove favorite':'Add to favorites'}</button><button class="secondary-btn" data-library-delete="${id}">${source.deleted?'Restore book':'Move to trash'}</button>`:''}</div>`);}
  async function libraryChange(id,key){const local=localBooks.find(x=>x.id===id),source=local&&local.local?local:cloudBooks.find(x=>x.id===id);const value=!source[key];if(source.local){source[key]=value;await D.putBook(source);}else await api('/api/books/'+id,{method:'PATCH',body:JSON.stringify({[key]:value})});closeDialog();await loadLibrary();}
  document.addEventListener('click', action(async event=>{
    const target=event.target.closest('button,a');if(!target)return;const ds=target.dataset,id=target.id;
    if(ds.template)return create(ds.template);
    if(ds.open){closeDialog();return openBook(ds.open);}
    if(ds.bookOptions)return bookOptions(ds.bookOptions);
    if(ds.libraryFavorite)return libraryChange(ds.libraryFavorite,'favorite');
    if(ds.libraryDelete)return libraryChange(ds.libraryDelete,'deleted');
    if(ds.collection){collection=ds.collection;document.querySelectorAll('[data-collection]').forEach(el=>el.setAttribute('aria-selected',String(el===target)));return renderLibrary();}
    if(ds.new!==undefined||id==='new-book')return newBookDialog();
    if(id==='sign-in')return signIn();
    if(id==='import-backup')return $('backup-input').click();
    if(!b)return;
    if(ds.page){active=ds.page;selected=[];renderAll();return;}
    if(ds.add)return addObject(ds.add);
    if(ds.tool){tool=ds.tool;document.querySelectorAll('[data-tool]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.tool===tool)));renderInspector();return;}
    if(ds.size)return sizeImage(ds.size);
    if(ds.align&&item()&&checkpoint()){const o=item();o.x=ds.align==='left'?10:ds.align==='center'?(M.W-o.w)/2:M.W-o.w-10;changed();return;}
    if(ds.styleToggle&&item()&&checkpoint()){applyStyle(ds.styleToggle,!item().style[ds.styleToggle]);changed();return;}
    if(ds.selectObject){selected=[ds.selectObject];renderSelection();renderInspector();return;}
    if(ds.lock||ds.hide||ds.layerUp){if(!checkpoint())return;const oid=ds.lock||ds.hide||ds.layerUp,o=page().items.find(x=>x.id===oid);if(ds.lock)o.locked=!o.locked;if(ds.hide)o.hidden=!o.hidden;if(ds.layerUp){const ix=page().items.indexOf(o);page().items.splice(ix,1);page().items.splice(Math.min(ix+1,page().items.length),0,o);}changed();return;}
    if(ds.removeMember)return invite(ds.removeMember);
    if(ds.revoke){await api('/api/books/'+b.id+'/sharing',{method:'POST',body:JSON.stringify({revoke:ds.revoke})});return shareDialog();}
    if(ds.restoreVersion)return restoreVersion(ds.restoreVersion);
    if(ds.restorePage){if(!checkpoint())return;const p=b.deletedPages.find(p=>p.id===ds.restorePage);if(b.pages.length>=100)throw new Error('This book already has 100 pages.');b.deletedPages=b.deletedPages.filter(p=>p.id!==ds.restorePage);b.pages.splice(b.pages.length-1,0,p);active=p.id;changed();return closeDialog();}
    if(ds.commentPage){if(b.pages.some(p=>p.id===ds.commentPage)){active=ds.commentPage;selected=[];renderAll();closeDialog();}return;}
    if(ds.resolveComment){await api('/api/books/'+b.id+'/comments',{method:'POST',body:JSON.stringify({resolve:ds.resolveComment,resolved:true})});return commentsDialog();}
    if(ds.useAsset){if(!checkpoint())return;const a=b.assets.find(a=>a.id===ds.useAsset),size=M.imageSize(a.width,a.height),o=M.object('image',{...size,assetId:a.id,name:a.name,x:(M.W-size.w)/2,y:(M.H-size.h)/2});page().items.push(o);selected=[o.id];changed();closeDialog();return;}
    if(ds.removeAsset){if(!editable())return;const aid=ds.removeAsset;if(b.pages.concat(b.deletedPages).some(p=>p.items.some(o=>o.assetId===aid||o.originalAssetId===aid))||(b.versions||[]).some(v=>v.pages.some(p=>p.items.some(o=>o.assetId===aid||o.originalAssetId===aid))))throw new Error('This image is used in a page or saved version.');if(!b.local){await persist();const removed=await api('/api/books/'+b.id+'/assets/'+aid,{method:'DELETE',body:JSON.stringify({lease_token:leaseToken,base_revision:b.revision})});b.revision=removed.revision;}b.assets=b.assets.filter(a=>a.id!==aid);await D.deleteAsset(aid);changed();return assetsDialog();}
    switch(id){
      case 'edit-turn': if(b.editor&&b.role==='owner'){dialog('Take an editing turn?',`<p>${esc(b.editor.name)} is editing. Taking over ends their editing turn. Any changes they have not saved will stay on their device for recovery.</p><button class="primary-btn" id="confirm-takeover">Take over editing</button>`);}else await acquire();break;
      case 'confirm-takeover':await acquire(true);closeDialog();await reloadRemote();break;
      case 'finish-turn':await release();break;
      case 'add-page':case 'add-page-side':addPage();break;
      case 'first-page':go(-1,0);break;
      case 'prev-page':go(-1);break;
      case 'next-page':go(1);break;
      case 'last-page':go(1,currentSpreads().length-1);break;
      case 'page-position':dialog('Go to a page',`<div class="book-button-stack">${b.pages.map((p,i)=>`<button class="secondary-btn" data-jump="${p.id}">${esc(p.role==='page'?'Page '+i:p.title)}</button>`).join('')}</div>`);break;
      case 'zoom-in':zoom=M.clamp(zoom+.1,.4,2.5);fitStage();break;
      case 'zoom-out':zoom=M.clamp(zoom-.1,.4,2.5);fitStage();break;
      case 'reading':reading=!reading;document.body.classList.toggle('book-reading',reading);target.textContent=reading?'Edit view':'Read';selected=[];renderAll();break;
      case 'undo':undo();break;case 'redo':undo(true);break;
      case 'add-image':case 'asset-upload':imageTarget=active;replacement='';$('image-input').click();break;
      case 'replace-image':replacement=item().id;imageTarget=active;$('image-input').click();break;
      case 'duplicate-page':duplicatePages(false);break;
      case 'duplicate-spread':duplicatePages(true);break;
      case 'delete-page':deletePage();break;
      case 'duplicate-object':duplicateObject();break;
      case 'delete-object':deleteObjects();break;
      case 'group-objects':if(checkpoint()){const group=item().group,next=group?'':M.id();page().items.filter(o=>group?o.group===group:selected.includes(o.id)).forEach(o=>o.group=next);changed();}break;
      case 'fill-page':if(checkpoint()){Object.assign(item(),{x:0,y:0,w:M.W,h:M.H,fit:'cover'});changed();}break;
      case 'span-pages':spanImage();break;
      case 'download-original':await original();break;
      case 'download-reference':await original(true);break;
      case 'save-text-style':if(checkpoint()){const o=item(),name=o.styleName||'body';b.styles[name]=M.clone(o.style);b.pages.forEach(p=>p.items.forEach(x=>{if(x.type==='text'&&x.styleName===name){x.style=M.clone(o.style);x.runs=[];}}));changed();notify('Your '+name+' style is updated throughout the book.');}break;
      case 'page-settings':$('inspector').classList.add('mobile-open');renderInspector();break;
      case 'close-inspector':$('inspector').classList.remove('mobile-open');selected=[];renderSelection();break;
      case 'organize':detailsDialog();break;
      case 'save-details':if(checkpoint()){const val=name=>$('dialog-content').querySelector('[data-field='+name+']');b.title=val('detailsTitle').value.trim()||'Untitled book';b.folder=val('detailsFolder').value;b.tags=val('detailsTags').value.split(',').map(x=>x.trim()).filter(Boolean);b.favorite=val('detailsFavorite').checked;$('book-title').value=b.title;changed();closeDialog();}break;
      case 'copy-book':case 'recover-copy':await copyBook();break;
      case 'publish-book':await publish();closeDialog();break;
      case 'share':await shareDialog();break;
      case 'invite-member':await invite();break;
      case 'create-link':await createLink();break;
      case 'copy-link':await navigator.clipboard.writeText($('share-url').value);notify('Link copied.');break;
      case 'illustration-assistant':illustrationDialog();break;
      case 'copy-prompt':await navigator.clipboard.writeText($('illustration-prompt').value);notify('Prompt copied.');break;
      case 'assets':await assetsDialog();break;
      case 'history':await historyDialog();break;
      case 'save-version':await saveVersion();break;
      case 'comments':await commentsDialog();break;
      case 'add-comment':await api('/api/books/'+b.id+'/comments',{method:'POST',body:JSON.stringify({text:$('comment-text').value,page_id:active,item_id:selected[0]||''})});await commentsDialog();break;
      case 'export':exportDialog();break;
      case 'download-export':await doExport();break;
      case 'download-backup':await backup();break;
      case 'more-tools':dialog('Add something',`<div class="book-template-grid"><button class="book-template" data-extra="arrow"><strong>Arrow</strong>Connect your ideas</button><button class="book-template" data-extra="table"><strong>Table</strong>Organize a few details</button><button class="book-template" data-extra="flow"><strong>Flow</strong>Explain step by step</button><button class="book-template" data-drawing="pencil"><strong>Pencil</strong>Soft sketch lines</button><button class="book-template" data-drawing="highlighter"><strong>Highlighter</strong>A little emphasis</button><button class="book-template" data-drawing="eraser"><strong>Eraser</strong>Remove drawing strokes</button></div><div class="book-row"><button class="secondary-btn" id="page-menu">Page options</button><button class="secondary-btn" id="organize">Book details</button><button class="secondary-btn" id="history">History</button><button class="secondary-btn" id="comments">Comments</button></div>`);break;
      case 'page-menu':dialog('Page options','<div class="book-button-stack"><button class="secondary-btn" id="duplicate-page">Duplicate page</button><button class="secondary-btn" id="duplicate-spread">Duplicate spread</button><button class="secondary-btn" id="organize">Book details</button><button class="secondary-btn" id="history">History & deleted pages</button><button class="ghost-btn book-danger" id="delete-page">Delete page</button></div>');break;
      case 'shortcuts':dialog('A few handy shortcuts','<ul class="book-help-list"><li>← / →: turn pages</li><li>Home / End: first / last page</li><li>Alt + ← / →: turn while selecting an object</li><li>Shift + N: add a page</li><li>⌘ / Ctrl + Z: undo</li><li>⌘ / Ctrl + Shift + Z: redo</li><li>Arrow keys: nudge selected objects</li><li>Shift + arrow: nudge further</li><li>Shift + click: select multiple objects</li><li>Escape: clear selection</li><li>Hold Alt while dragging: temporarily ignore snapping</li></ul>');break;
    }
    if(ds.jump){active=ds.jump;selected=[];renderAll();closeDialog();}
    if(ds.extra){addObject(ds.extra);closeDialog();}
    if(ds.drawing){tool=ds.drawing;renderInspector();$('inspector').classList.add('mobile-open');closeDialog();}
  }));
  $('inspector').addEventListener('change',action(e=>{if(e.target.tagName==='SELECT'||e.target.type==='checkbox'||e.target.type==='color')changeField(e.target);}));
  $('inspector').addEventListener('input',e=>{
    if(e.target.dataset.field&&!['checkbox','color'].includes(e.target.type)){changeField(e.target);if(e.target.dataset.field==='style.weight')e.target.previousElementSibling.textContent='Thickness · '+e.target.value;return;}
    const o=item();if(!o||!editable())return;
    if(e.target.id==='object-text'){checkpoint();o.text=e.target.value;o.runs=[];selectionRange=null;changed(false);renderStage();renderPages();}
    if(e.target.id==='table-content'){checkpoint();o.cells=e.target.value.split('\n').slice(0,8).map(r=>r.split('|').slice(0,8).map(s=>s.trim()));changed(false);renderStage();}
    if(e.target.id==='flow-content'){checkpoint();o.steps=e.target.value.split('\n').slice(0,8);changed(false);renderStage();}
  });
  $('inspector').addEventListener('select',e=>{if(e.target.id==='object-text')selectionRange={start:e.target.selectionStart,end:e.target.selectionEnd};});
  $('dialog-content').addEventListener('change',action(e=>{const field=e.target.dataset.field;if(['arrangement','exportFormat'].includes(field))printPreview();if(field&&field.startsWith('illustration'))updatePrompt();}));
  $('dialog-content').addEventListener('input',e=>{if(e.target.id==='character-details')updatePrompt();});
  $('book-title').addEventListener('input',()=>{if(!editable())return;b.title=$('book-title').value.trim()||'Untitled book';changed(false);});
  $('book-search').addEventListener('input',renderLibrary);$('book-sort').addEventListener('change',renderLibrary);
  $('fit-mode').addEventListener('change',()=>{fit=$('fit-mode').value;zoom=1;renderStage();});
  $('image-input').addEventListener('change',action(async()=>{const files=Array.from($('image-input').files);$('image-input').value='';await importImages(files,imageTarget||active);}));
  $('backup-input').addEventListener('change',action(async()=>{const file=$('backup-input').files[0];$('backup-input').value='';if(file)await importBackup(file);}));
  $('book-spread').addEventListener('pointerdown',pointer);
  $('book-spread').addEventListener('dblclick',e=>{const node=e.target.closest('[data-object]');if(node&&item()&&editable()){if(item().type==='text'){$('object-text').focus();$('object-text').select();}$('inspector').classList.add('mobile-open');}else if(e.target.closest('[data-page-id]'))$('inspector').classList.add('mobile-open');});
  let draggedPage='';
  $('page-list').addEventListener('dragstart',e=>{const node=e.target.closest('[data-page]');if(!node||!editable())return;e.dataTransfer.setData('application/x-book-page',node.dataset.page);draggedPage=node.dataset.page;});
  $('page-list').addEventListener('dragover',e=>{if(draggedPage)e.preventDefault();});
  $('page-list').addEventListener('drop',e=>{if(!draggedPage)return;e.preventDefault();const target=e.target.closest('[data-page]');if(!target)return;const source=b.pages.find(p=>p.id===draggedPage),dest=b.pages.find(p=>p.id===target.dataset.page);draggedPage='';if(!source||source.role!=='page'||dest.role!=='page'||source===dest)return;if(!checkpoint())return;const linked=source.items.find(o=>o.spanId),group=linked?b.pages.filter(p=>p.items.some(o=>o.spanId===linked.spanId)):[source];if(group.includes(dest))return;b.pages=b.pages.filter(p=>!group.includes(p));const index=b.pages.indexOf(dest);b.pages.splice(index,0,...group);keepSpreadsTogether();changed();});
  $('page-list').addEventListener('dragend',()=>draggedPage='');
  document.addEventListener('dragover',e=>{if(e.dataTransfer.types.includes('Files')){e.preventDefault();document.querySelectorAll('.drop-target').forEach(n=>n.classList.remove('drop-target'));const sheet=e.target.closest('[data-page-id]');if(sheet&&editable())sheet.classList.add('drop-target');}});
  document.addEventListener('dragleave',e=>{if(!e.relatedTarget)document.querySelectorAll('.drop-target').forEach(n=>n.classList.remove('drop-target'));});
  document.addEventListener('drop',action(async e=>{if(!e.dataTransfer.files.length)return;e.preventDefault();document.querySelectorAll('.drop-target').forEach(n=>n.classList.remove('drop-target'));const sheet=e.target.closest('[data-page-id]');if(!sheet||!b){notify('Open a book and drop the image onto a page.');return;}const rect=sheet.getBoundingClientRect();replacement='';await importImages(e.dataTransfer.files,sheet.dataset.pageId,{x:(e.clientX-rect.left)/rect.width*M.W,y:(e.clientY-rect.top)/rect.height*M.H});}));
  document.addEventListener('paste',action(async e=>{if(!b||!editable()||$('book-dialog').open)return;const files=Array.from(e.clipboardData.items).filter(i=>i.kind==='file'&&i.type.startsWith('image/')).map(i=>i.getAsFile());if(files.length){e.preventDefault();replacement='';await importImages(files,active);}}));
  document.addEventListener('keydown',e=>{
    if(!b||$('book-dialog').open||e.target.closest('input,textarea,select,[contenteditable=true]'))return;
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='y'){e.preventDefault();undo(true);return;}
    if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo(e.shiftKey);return;}
    if(e.key==='Escape'){selected=[];tool='select';$('inspector').classList.remove('mobile-open');renderAll();return;}
    if(e.shiftKey&&e.key.toLowerCase()==='n'){e.preventDefault();addPage();return;}
    if((e.key==='Delete'||e.key==='Backspace')&&selected.length){e.preventDefault();deleteObjects();return;}
    if(e.key==='Home'||e.key==='End'){e.preventDefault();go(e.key==='Home'?-1:1,e.key==='Home'?0:currentSpreads().length-1);return;}
    if(e.key.startsWith('Arrow')){e.preventDefault();if(selected.length&&!e.altKey&&editable()){checkpoint();const step=e.shiftKey?5:.5;page().items.filter(o=>selected.includes(o.id)&&!o.locked).forEach(o=>{o.x+=e.key==='ArrowRight'?step:e.key==='ArrowLeft'?-step:0;o.y+=e.key==='ArrowDown'?step:e.key==='ArrowUp'?-step:0;});changed();}else if(e.key==='ArrowLeft'||e.key==='ArrowRight')go(e.key==='ArrowRight'?1:-1);}
  });
  let pollBusy=false;
  setInterval(async()=>{
    if(!b||b.local||document.hidden||opening||pollBusy)return;pollBusy=true;
    try{const result=await api('/api/books/'+b.id+'/revision');lastRefresh=Date.now();const editorChanged=JSON.stringify(b.editor)!==JSON.stringify(result.book.editor);b.editor=result.book.editor;b.role=result.book.role;if(leaseToken&&(!result.book.editor||!['owner','edit'].includes(b.role))){leaseToken='';sessionStorage.removeItem('book-lease-'+b.id);}if(!leaseToken&&!dirty&&result.book.revision!==b.revision)await reloadRemote();updateStatus();if(editorChanged&&!leaseToken)renderInspector();}
    catch(e){if(e.status===403){leaseToken='';b.role='';saveError=e.message;notify('Access to this book has changed. Your unsaved draft remains on this device.',true);updateStatus();}else status('Updates paused · Reconnecting…');}
    finally{pollBusy=false;}
  },5000);
  setInterval(async()=>{if(!b||b.local||!leaseToken)return;try{await api('/api/books/'+b.id+'/lease',{method:'POST',body:JSON.stringify({action:'renew',lease_token:leaseToken})});}catch(e){leaseToken='';updateStatus();notify(e.message,true);}},20000);
  window.addEventListener('resize',()=>{if(b){renderStage();}});
  window.addEventListener('online',()=>{if(b&&dirty&&leaseToken)persist().catch(e=>notify(e.message,true));});
  window.addEventListener('beforeunload',e=>{if(b){D.putBook(b).catch(()=>{});if(dirty&&!b.local){e.preventDefault();e.returnValue='';}}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden&&b){D.putBook(b).catch(()=>{});if(dirty&&leaseToken)persist().catch(()=>{});}});
  document.fonts.ready.then(()=>{if(b)renderAll();else renderLibrary();});
  async function boot(){
    await new Promise(resolve=>setTimeout(resolve,80));user=auth.currentUser;$('sign-in').hidden=!!user;$('account-name').hidden=!user;$('account-name').textContent=user?(user.displayName||user.email):'';
    const share=document.body.dataset.shareToken;let id=document.body.dataset.bookId;
    if(share){
      dialog('Open a shared book',field('Your name','guestName',user?(user.displayName||''):'')+'<p class="book-muted">Your name appears with comments and while you edit.</p><button class="primary-btn" id="open-shared">Open book</button>');
      $('open-shared').onclick=action(async()=>{const name=$('dialog-content').querySelector('[data-field=guestName]').value;const result=await api('/api/books/share-session',{method:'POST',body:JSON.stringify({token:share,name})});sessionStorage.setItem('book-access-'+result.book_id,result.access_token);closeDialog();await openBook(result.book_id);});
    }else if(id){try{await openBook(id);}catch(e){b=null;notify(e.message,true);await loadLibrary();}}
    else await loadLibrary();
  }
  let initialized=false;
  auth.onAuthStateChanged(action(async next=>{user=next;$('sign-in').hidden=!!next;$('account-name').hidden=!next;$('account-name').textContent=next?(next.displayName||next.email):'';if(!initialized){initialized=true;await boot();}else if(!b)await loadLibrary();else if(b.local&&next){notify('Signed in. Use Book details to save this draft to your account.');}}));
})();
