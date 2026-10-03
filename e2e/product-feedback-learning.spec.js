const { test, expect } = require('@playwright/test');
const { readFileSync, mkdirSync } = require('node:fs');
const { expectProductControls } = require('./helpers/control-audit');
const evidence = '/tmp/product-feedback-learning-evidence';
mkdirSync(evidence, {recursive:true});
test.beforeEach(async ({page}) => { await page.route('**/static/js/*.min.js*', route => {
  const name = new URL(route.request().url()).pathname.split('/').pop().replace('.min.js','.js');
  return ['study.js','dashboard.js'].includes(name) ? route.fulfill({contentType:'text/javascript',body:readFileSync('static/js/'+name,'utf8')}) : route.continue();
}); });
async function installLibrary(page, options = {}) {
  const firebaseStub = `(function () {
    var user = { uid: 'owner', email: 'student@example.com', getIdToken: function () { return Promise.resolve('test-token'); } };
    var auth = { currentUser: user, setPersistence: function () { return Promise.resolve(); }, authStateReady: function () { return Promise.resolve(); }, onAuthStateChanged: function (callback) { setTimeout(function () { callback(user); }, 0); return function () {}; } };
    function factory() { return auth; } factory.Auth = { Persistence: { LOCAL: 'local' } };
    window.firebase = { app: function () { return {}; }, initializeApp: function () { return {}; }, auth: factory };
  })();`;
  await page.addInitScript({ content: firebaseStub });
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: firebaseStub }));
  const folders = [{ folder_id: 'anatomy', name: 'Anatomy and physiology', parent_folder_id: '', is_pinned: true },
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

const pack = {study_pack_id:'flow',title:'Movement and memory',mode:'manual',folder_id:'anatomy',notes_markdown:'# Movement and memory\nStudy the movement.',flashcards_count:3,test_questions_count:1,flashcards:[{front:'Due movement',back:'Due answer'},{front:'New movement',back:'New answer'},{front:'Future movement',back:'Future answer'}],test_questions:[{question:'Which movement?',options:['A','B'],answer:'A'}]};
const state = {fc_0:{seen:2,correct:1,last_review_date:'2000-01-01',next_review_date:'2000-01-02'},fc_2:{seen:2,correct:2,last_review_date:'2026-10-01',next_review_date:'2999-01-01'}};
async function fixture(page, extra={}) {
  await installLibrary(page,{packs:[pack],route:async route=>{
    const path=new URL(route.request().url()).pathname;
    let body;
    if(path==='/api/study-progress/due') body={due_count:1,packs:[{study_pack_id:'flow',title:pack.title,due_count:1,cards:[{id:'fc_0',front:'Due movement'}]}]};
    else if(path.includes('progress')) body={current_streak:3,due_today:1,daily_goal:20,today_progress:4,card_states:{flow:state}};
    else if(path==='/api/planner/sessions') body={sessions:[{id:'planned-1',pack_id:'flow',title:'Study movement',date:'2026-10-05',time:'17:00',status:'planned'}]};
    if(extra.route && await extra.route(route)) return true;
    if(body) {await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});return true;}
    return false;
  }});
}
for(const width of [1440,390]) test('folder composition, real collapse and contained menus at '+width,async({page})=>{
  await fixture(page); await page.setViewportSize({width,height:960});await page.goto('/study?pack_id=flow');
  if(width<600) await page.locator('#library-back-btn').click();
  const parent=page.locator('[data-folder-id=anatomy]'), child=page.locator('[data-folder-id=muscles]');
  await parent.locator('summary').click();
  await parent.locator('[data-toggle-pin]').click();
  await expect(parent.locator('.folder-pin')).toBeVisible();
  await expect(child).toBeVisible();
  await parent.getByRole('button',{name:'Collapse Anatomy and physiology'}).click();
  await expect(child).toHaveCount(0);
  await parent.getByRole('button',{name:'Expand Anatomy and physiology'}).click();
  await expect(child).toBeVisible();
  await page.waitForTimeout(240);
  await parent.locator('summary').click();
  await expect(parent.locator('.app-menu-panel')).toBeVisible();
  const box=await parent.locator('.app-menu-panel').boundingBox();expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(width);
  await expectProductControls(page);
  await page.screenshot({path:evidence+'/folders-'+width+'.png',fullPage:true,animations:'disabled'});
  await page.keyboard.press('Escape');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('Dashboard reveals actual cards and enters only due review; Continue points to planned picker',async({page})=>{
  await fixture(page);await page.setViewportSize({width:1440,height:1000});await page.goto('/dashboard');
  await expect(page.locator('#dash-continue-link')).toHaveAttribute('href','/study?pack_id=flow&mode=learn&plan_item_id=planned-1');
  await page.getByRole('button',{name:'See due cards'}).click();await expect(page.locator('#dash-due-list')).toContainText('Due movement');
  await expect(page.locator('#dash-due-list')).not.toContainText('New movement');
  await page.waitForTimeout(260);await page.screenshot({path:evidence+'/dashboard-due-1440.png',fullPage:true,animations:'disabled'});
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:evidence+'/dashboard-due-390.png',fullPage:true,animations:'disabled'});
  await page.getByRole('link',{name:'Review 1 due card'}).click();
  await expect(page.locator('#mode-picker')).toBeVisible();await expect(page.locator('#setup-main-content')).toBeHidden();
  await page.locator('[data-study-mode=flashcards]').click();
  await expect(page.locator('#learn-flashcard-front')).toHaveText('Due movement');
  await expect(page.locator('#learn-f-progress')).toHaveText('Card 1 of 1');
  await expect(page.locator('#learn-f-next')).toBeDisabled();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('direct learn link offers modes immediately without setup',async({page})=>{
  await fixture(page);await page.goto('/study?pack_id=flow&mode=learn');
  await expect(page.locator('#mode-picker')).toBeVisible();await expect(page.locator('#setup-main-content')).toBeHidden();
  await expect(page.locator('[data-study-mode=flashcards]')).toBeVisible();await expect(page.locator('[data-study-mode=test]')).toBeVisible();
  await page.screenshot({path:evidence+'/picker-free-1440.png',animations:'disabled'});
  await page.locator('[data-study-mode=write]').click();await expect(page.locator('#learn-mode-label')).toHaveText('Write');
});


test('all-new packs remain studyable through every priority preset',async({page})=>{
  await fixture(page,{route:async route=>{
    if(new URL(route.request().url()).pathname.includes('progress')) { await route.fulfill({contentType:'application/json',body:JSON.stringify({card_states:{flow:{}}})}); return true; } return false;
  }});
  for(const preset of ['balanced','random','lastminute','fixmistakes','hardfirst']) {
    await page.goto('/study?pack_id=flow');await page.locator('#open-learn-btn').click();
    const testMode=page.locator('#lesson-card-test');if(await testMode.getAttribute('aria-pressed')==='true') await testMode.click();
    await page.locator('[data-setup-pane=algorithm]').click();await page.locator('[data-preset='+preset+']').click();
    await expect(page.locator('.algo-availability')).toContainText('Empty categories are skipped');
    await page.locator('#setup-start-btn').click();await expect(page.locator('#learn-f-progress')).toHaveText('Card 1 of 3');
    const prompts=new Set();for(let i=0;i<3;i++){prompts.add(await page.locator('#learn-flashcard-front').textContent());if(i<2) { await page.locator('#learn-f-next').click(); await expect(page.locator('#learn-f-progress')).toHaveText('Card '+(i+2)+' of 3'); await expect(page.locator('#learn-flashcard-inner')).not.toHaveClass(/slide-left/); }}
    expect(prompts.size).toBe(3);
  }
});
test('empty due review never falls back to new cards',async({page})=>{
  await fixture(page,{route:async route=>{
    if(new URL(route.request().url()).pathname.includes('progress')) {await route.fulfill({contentType:'application/json',body:JSON.stringify({card_states:{flow:{}}})});return true;}return false;
  }});
  await page.goto('/study?pack_id=flow&mode=learn&review=due');
  await expect(page.locator('#mode-picker-context')).toContainText('all caught up');
  await expect(page.locator('[data-study-mode]')).toHaveCount(0);
  await expect(page.locator('#learn-stage')).toBeHidden();
});

test('question-only packs offer the direct Test choice without unavailable flashcard modes',async({page})=>{
  await installLibrary(page,{packs:[{...pack,flashcards:[],flashcards_count:0,notes_markdown:''}]});
  await page.goto('/study?pack_id=flow&mode=learn');
  await expect(page.locator('#mode-picker')).toBeVisible();
  await expect(page.locator('[data-study-mode=test]')).toBeVisible();
  await expect(page.locator('[data-study-mode=flashcards]')).toHaveCount(0);
  await page.locator('[data-study-mode=test]').click();
  await expect(page.locator('#learn-q-text')).toHaveText('Which movement?');
});
