const { expectProductControls } = require('./helpers/control-audit');
const { test, expect } = require("@playwright/test");
const { readFileSync } = require("node:fs");
test.beforeEach(async ({page}) => { await page.route("**/static/js/study.min.js*", route => route.fulfill({contentType:"text/javascript",body:readFileSync("static/js/study.js","utf8")})); });
async function installLibrary(page, options = {}) {
  const firebaseStub = `(function () {
    var user = { uid: 'owner', email: 'student@example.com', getIdToken: function () { return Promise.resolve('test-token'); } };
    var auth = { currentUser: user, setPersistence: function () { return Promise.resolve(); }, authStateReady: function () { return Promise.resolve(); }, onAuthStateChanged: function (callback) { setTimeout(function () { callback(user); }, 0); return function () {}; } };
    function factory() { return auth; } factory.Auth = { Persistence: { LOCAL: 'local' } };
    window.firebase = { app: function () { return {}; }, initializeApp: function () { return {}; }, auth: factory };
  })();`;
  await page.addInitScript({ content: firebaseStub });
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: firebaseStub }));
  const folders = [{ folder_id: 'anatomy', name: 'Anatomy and physiology', parent_folder_id: '', is_pinned: false },
    { folder_id: 'muscles', name: 'Muscles of the lower limb', parent_folder_id: 'anatomy', is_pinned: false }];
  const packs = options.packs || [];
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let body = {};
    if (options.route && await options.route(route)) return;
    if (path === '/api/study-folders') body = { folders };
    else if (path === '/api/study-folders/anatomy' && request.method() === 'PATCH') {
      Object.assign(folders[0], request.postDataJSON());
      body = { ok: true, folder: folders[0] };
    } else if (path.endsWith('/share')) body = { access_scope: 'private', share_url: '' };
    else if (path === '/api/study-packs') body = { study_packs: packs, has_more: false };
    else if (path.startsWith('/api/study-packs/')) {
      const pack = packs.find(item => item.study_pack_id === path.split('/').pop());
      if (pack) {
        if (request.method() === 'PATCH') Object.assign(pack, request.postDataJSON());
        body = pack;
      }
    }
    else if (path === '/api/auth/user') body = { uid: 'owner', email_verified: true, onboarding_completed: true, allowed: true };
    else if (path === '/api/study-plan/membership') body = { pack_ids: [] };
    else if (path.includes('progress')) body = { card_states: {}, daily_progress: {} };
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
  });
}

const cards = Array.from({length:6}, (_,index) => ({front:`Movement ${index+1}`,back:`Action ${index+1}`}));
function studyPack(extra={}) { return {study_pack_id:'flow',title:'Movement and memory',mode:'manual',notes_markdown:'# Movement and memory\n\nSix useful movements to recall.',flashcards:cards,flashcards_count:6,test_questions:[],...extra}; }
async function enterMode(page, mode) {
  await page.locator('#open-learn-btn').click();
  for(const name of ['flashcards','test','write','match']) {
    const button=page.locator('#lesson-card-'+name);
    if(await button.isVisible() && (await button.getAttribute('aria-pressed')==='true') !== (name===mode)) await button.click();
  }
  await page.locator('#setup-start-btn').click();
  await expect(page.locator('#learn-mode-label')).toHaveText(mode==='write'?'Write':'Match');
}
test('Write gives correct, incorrect and revealed feedback through completion on desktop and mobile', async({page},testInfo)=>{
  await installLibrary(page,{packs:[studyPack()]});
  await page.setViewportSize({width:1440,height:960});
  await page.goto('/study?pack_id=flow');
  await expect(page.locator('#hl-download')).toBeHidden();
  await page.locator('#export-menu-btn').click();
  await expect(page.locator('#export-pack-notes-btn')).toBeVisible();
  await expect(page.locator('#export-annotated-notes-btn')).toBeVisible();
  await page.keyboard.press('Escape');
  await enterMode(page,'write');
  for(let index=0;index<6;index++) {
    const prompt=await page.locator('#write-prompt').textContent();
    const answer=prompt.replace('Movement','Action');
    if(index===0) {
      await page.locator('#write-input').fill('A different movement');
      await page.locator('#write-check-btn').click();
      await expect(page.locator('#write-feedback')).toContainText('Incorrect. Expected: '+answer);
      await expectProductControls(page);
  await page.screenshot({path:testInfo.outputPath('write-feedback-desktop.png'),animations:'disabled'});
    } else if(index===1) {
      await page.locator('#write-reveal-btn').click();
      await expect(page.locator('#write-feedback')).toHaveText('Answer: '+answer);
    } else {
      await page.locator('#write-input').fill(answer);
      await page.locator('#write-check-btn').click();
      await expect(page.locator('#write-feedback')).toHaveText('Correct!');
    }
    if(index===5) { await page.setViewportSize({width:390,height:844}); await expect(page.locator('#write-reveal-btn')).toBeInViewport(); expect(await page.locator('.write-input-row').evaluate(node=>node.scrollWidth<=node.clientWidth)).toBeTruthy(); await expectProductControls(page);
  await page.screenshot({path:testInfo.outputPath('write-complete-mobile.png'),animations:'disabled'}); }
    await page.locator('#write-next-btn').click();
  }
  await expect(page.locator('#toast')).toContainText('All cards completed!');
  await page.locator('#learn-back-library-btn').click();
  await expect(page.locator('#pack-summary-title')).toBeVisible();
});
test('Match handles wrong pairs, results, history and replay at narrow width', async({page},testInfo)=>{
  await installLibrary(page,{packs:[studyPack()]});
  await page.setViewportSize({width:390,height:844});
  await page.goto('/study?pack_id=flow');
  await enterMode(page,'match');
  await page.getByRole('button',{name:'Movement 1',exact:true}).click();
  await page.getByRole('button',{name:'Action 2',exact:true}).click();
  await expect(page.locator('.wrong-flash')).toHaveCount(2);
  await expect(page.locator('.wrong-flash')).toHaveCount(0);
  await expectProductControls(page);
  await page.screenshot({path:testInfo.outputPath('match-grid-mobile.png'),animations:'disabled'});
  for(let i=1;i<=6;i++) { await page.getByRole('button',{name:'Movement '+i,exact:true}).click();await page.getByRole('button',{name:'Action '+i,exact:true}).click(); }
  await expect(page.locator('#match-results')).toBeVisible();
  await expect(page.locator('#match-results-history')).toContainText('1st:');
  await expectProductControls(page);
  await page.screenshot({path:testInfo.outputPath('match-results-mobile.png'),animations:'disabled'});
  await page.locator('#match-play-again').click();
  await expect(page.locator('#match-grid .match-cell')).toHaveCount(12);
  await expect(page.locator('#match-results')).toBeHidden();
  await expect(page.locator('#match-grid .matched')).toHaveCount(0);
});
async function codingFixture(page) {
  const transcript='Starting university felt overwhelming. Studying together helped me gain confidence.';
  const codes=[{code_id:'pressure',name:'Study pressure',color:'teal',description:'Experiences of workload'},{code_id:'support',name:'Peer support',color:'blue',description:'Help from classmates'}];
  const draft={run_id:'draft1',status:'draft',proposed_codes:[{code_id:'confidence',name:'Growing confidence',color:'pink'}],proposed_quotations:[{text:'Studying together helped me gain confidence.',start_offset:39,end_offset:transcript.length}]};
  const state={pack_id:'flow',transcript,codes,quotations:[],latest_run:draft,ai_estimate:{credit_cost:1},palette:[{key:'teal',hex:'#CCFBF1',label:'Teal'},{key:'blue',hex:'#DBEAFE',label:'Blue'},{key:'pink',hex:'#FCE7F3',label:'Pink'}]};
  const calls=[];
  await installLibrary(page,{packs:[studyPack({mode:'interview',title:'Student belonging interview',flashcards:[],flashcards_count:0,notes_markdown:'# Student belonging\n\n'+transcript})],route:async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(!path.startsWith('/api/interview-coding/'))return false;
    calls.push({path,method:req.method(),body:req.postDataJSON()});let body=state;
    if(path.endsWith('/accept')) { state.codes.push(...draft.proposed_codes);state.latest_run={...draft,status:'accepted'};body={state}; }
    else if(path.endsWith('/reject')) {state.latest_run={...draft,status:'rejected'};body={ok:true};}
    else if(path.endsWith('/merge')) {const source=path.split('/').at(-2);state.codes=state.codes.filter(code=>code.code_id!==source);body={ok:true};}
    await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});return true;
  }});
  await page.goto('/study?pack_id=flow');
  await page.locator('#open-learn-btn').click();
  await expect(page.locator('#coding-ai-panel')).toContainText('AI draft ready to review');
  return {state,calls};
}
test('coding draft review accepts suggestions then confirms and merges codes',async({page},testInfo)=>{
  await page.setViewportSize({width:1440,height:960});
  const {calls}=await codingFixture(page);
  await expect(page.locator('#coding-close-btn')).toBeInViewport();
  const textBox=await page.locator('.coding-segment-text').boundingBox();
  const labelBox=await page.locator('.coding-segment-meta').boundingBox();
  expect(textBox.y-labelBox.y).toBeLessThan(50);
  await expectProductControls(page);
  await page.screenshot({path:testInfo.outputPath('coding-draft-desktop.png'),animations:'disabled'});
  await page.locator('.coding-more-actions summary').click();
  await expect(page.locator('#coding-reset-btn')).toBeVisible();
  await expectProductControls(page);
  await page.screenshot({path:testInfo.outputPath('coding-more-open.png'),animations:'disabled'});
  await page.keyboard.press('Escape');
  await expect(page.locator('#coding-reset-btn')).toBeHidden();
  await expect(page.locator('.coding-more-actions summary')).toBeFocused();
  await page.locator('[data-ai-draft-action="accept"]').click();
  await expect(page.locator('#coding-code-list')).toContainText('Growing confidence');
  await expect(page.locator('#coding-ai-panel')).toBeHidden();
  await page.locator('#coding-code-list [data-code-id="pressure"]').click();
  await page.locator('#coding-merge-code-btn').click();
  await page.locator('#coding-code-list [data-code-id="support"]').click();
  const dialog=page.getByRole('dialog',{name:'Merge Codes',exact:true});
  await expect(dialog).toBeVisible();
  await expectProductControls(page);
  await page.screenshot({path:testInfo.outputPath('coding-merge-confirm.png'),animations:'disabled'});
  await dialog.getByRole('button',{name:'Merge Codes',exact:true}).click();
  await expect(page.locator('#coding-code-list [data-code-id="pressure"]')).toHaveCount(0);
  expect(calls.find(call=>call.path.endsWith('/pressure/merge')).body).toEqual({target_code_id:'support'});
  await expectProductControls(page);
  await page.screenshot({path:testInfo.outputPath('coding-accepted-desktop.png'),animations:'disabled'});
});
test('coding draft rejection keeps manual codes and remains usable on mobile',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});
  const {state}=await codingFixture(page);
  await expect.poll(async () => (await page.locator('#coding-transcript').boundingBox()).width).toBeGreaterThan(280);
  await expectProductControls(page);
  await page.screenshot({path:testInfo.outputPath('coding-draft-mobile.png'),animations:'disabled'});
  await page.locator('[data-ai-draft-action="reject"]').click();
  await expect(page.locator('#coding-ai-panel')).toBeHidden();
  expect(state.codes).toHaveLength(2);
  await expect(page.locator('#coding-code-list')).toContainText('Peer support');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.locator('#coding-transcript').scrollIntoViewIfNeeded();
  await expectProductControls(page);
  await page.screenshot({path:testInfo.outputPath('coding-rejected-mobile.png'),animations:'disabled'});
});
test('one Library export menu retains original and annotated notes downloads',async({page})=>{
  const exports=[];
  await installLibrary(page,{packs:[studyPack()],route:async route=>{
    const req=route.request(),path=new URL(req.url()).pathname;
    if(!path.endsWith('/export-notes') && !path.endsWith('/export-annotated-pdf'))return false;
    exports.push({path,method:req.method(),body:req.postDataJSON()});
    await route.fulfill({contentType:'application/octet-stream',headers:{'Content-Disposition':'attachment; filename="notes.fixture"'},body:'fixture download'});return true;
  }});
  await page.goto('/study?pack_id=flow');
  await expect(page.locator('#hl-download')).toBeHidden();
  await page.locator('#export-menu-btn').click();
  const original=page.waitForEvent('download');
  await page.locator('#export-pack-notes-btn').click();
  await original;
  await expect(page.locator('#export-menu-list')).toHaveJSProperty('inert', true);
  await expect(page.locator('#export-menu-list')).toBeHidden();
  await page.locator('#export-menu-btn').click();
  const annotated=page.waitForEvent('download');
  await page.locator('#export-annotated-notes-btn').click();
  await annotated;
  expect(exports.map(item=>item.path)).toEqual(['/api/study-packs/flow/export-notes','/api/study-packs/flow/export-annotated-pdf']);
  expect(exports[1].method).toBe('POST');
  expect(JSON.stringify(exports[1].body)).toContain('Movement and memory');
});
