const { expectProductControls } = require('./helpers/control-audit');
const { test, expect } = require('@playwright/test');
const { readFileSync } = require('node:fs');

async function fixture(page) {
  const stub = `(function(){var user={uid:localStorage.getItem('dashboard-test-uid')||'owner',email:'student@example.com',displayName:'Student',getIdToken:function(){return Promise.resolve('test-token')}};var auth={currentUser:user,setPersistence:function(){return Promise.resolve()},authStateReady:function(){return Promise.resolve()},onAuthStateChanged:function(cb){setTimeout(function(){cb(user)},0);return function(){}}};function factory(){return auth}factory.Auth={Persistence:{LOCAL:'local'}};window.firebase={app:function(){return {}},initializeApp:function(){return {}},auth:factory}})();`;
  await page.addInitScript({ content: stub });
  await page.route('https://www.gstatic.com/firebasejs/**', route => route.fulfill({ contentType: 'application/javascript', body: stub }));
  await page.route('**/static/js/*.min.js*', route => {
    const name = new URL(route.request().url()).pathname.split('/').pop().replace('.min.js', '.js');
    if (['dashboard.js', 'shared-study.js'].includes(name)) return route.fulfill({ contentType: 'application/javascript', body: readFileSync('static/js/' + name, 'utf8') });
    return route.continue();
  });
  const pack = { study_pack_id: 'anatomy', title: 'Anatomy — movement and muscles', mode: 'manual', flashcards_count: 24, test_questions_count: 12,
    notes_markdown: '# How movement works\n\nMuscles act across joints. Follow the attachment points, understand the action, and explain the movement from memory.\n\n## Study with a purpose\n\n- Start with the main actions.\n- Compare muscles that work together.\n- Check your understanding with a question.\n\n| Joint | Movement |\n|---|---|\n| Elbow | Flexion |\n| Shoulder | Abduction |',
    flashcards: [{ front: 'What is flexion?', back: 'Movement that decreases the angle at a joint.' }], test_questions: [{ question: 'Which movement bends the elbow?', options: ['Flexion','Extension'], answer: 'Flexion', explanation: 'Flexion decreases the angle at the elbow.' }] };
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    let body = {};
    if (path === '/api/auth/user') body = { uid:'owner', allowed:true, onboarding_completed:true, email_verified:true };
    else if (path === '/api/planner/sessions') body = { sessions:[{ pack_id:'anatomy',title:'Study Anatomy — movement and muscles',pack_title:pack.title,date:'2026-10-10',time:'17:00',status:'planned' }] };
    else if (path === '/api/study-progress/summary') body = { active_plan_pack_ids:['anatomy'],current_streak:4,due_today:16,daily_goal:20,today_progress:12 };
    else if (path === '/api/study-packs') body = { study_packs:[pack] };
    else if (path === '/api/shared/visual') body = { entity_type:'folder',folder:{name:'Anatomy study group'},study_packs:[pack] };
    else if (path.includes('/api/shared/visual/packs/')) body = pack;
    return route.fulfill({ contentType:'application/json', body:JSON.stringify(body) });
  });
}

test('dashboard and shared material have useful desktop and mobile hierarchy', async ({ page }, testInfo) => {
  await fixture(page);
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('/dashboard');
  await expect(page.locator('#dash-continue-title')).toContainText('Anatomy');
  await expect(page.locator('#dash-sessions-list')).toContainText('Sat 10 Oct');
  await expectProductControls(page);
  await page.screenshot({animations:'disabled',path:testInfo.outputPath('dashboard-desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await expectProductControls(page);
  await page.screenshot({animations:'disabled',path:testInfo.outputPath('dashboard-mobile.png'),fullPage:true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.goto('/shared/visual');
  await expect(page.locator('#shared-folder-pack-title')).toContainText('Anatomy');
  await page.locator('#shared-folder-flashcards-list summary').click();
  await expect(page.locator('.shared-card-back')).toBeVisible();
  await expectProductControls(page);
  await page.screenshot({animations:'disabled',path:testInfo.outputPath('shared-mobile.png'),fullPage:true});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.setViewportSize({width:1440,height:1000});
  await expectProductControls(page);
  await page.screenshot({animations:'disabled',path:testInfo.outputPath('shared-desktop.png'),fullPage:true});
});


test('dashboard recent disclosure persists per account and rows are distinct without hover', async ({page}, testInfo) => {
  await fixture(page); await page.goto('/dashboard');
  const panel = page.locator('#dash-recent-packs');
  await expect(page.locator('#dashboard-page')).toHaveAttribute('data-load-state','ready');
  await expect(panel).toHaveAttribute('open','');
  const colors = await page.locator('#dash-packs-list .list-item').first().evaluate(row => ({background:getComputedStyle(row).backgroundColor,border:getComputedStyle(row).borderTopColor}));
  expect(colors.background).not.toBe('rgba(0, 0, 0, 0)'); expect(colors.border).not.toBe('rgba(0, 0, 0, 0)');
  await panel.locator('summary').click(); await expect(panel).not.toHaveAttribute('open','');
  await page.reload(); await expect(page.locator('#dashboard-page')).toHaveAttribute('data-load-state','ready');
  await expect(panel).not.toHaveAttribute('open','');
  await page.screenshot({path:testInfo.outputPath('dashboard-recent-collapsed.png'),fullPage:true});
  await page.evaluate(()=>localStorage.setItem('dashboard-test-uid','second-account'));
  await page.reload(); await expect(page.locator('#dashboard-page')).toHaveAttribute('data-load-state','ready');
  await expect(panel).toHaveAttribute('open','');
  await page.evaluate(()=>localStorage.removeItem('dashboard-test-uid'));
  await page.reload(); await expect(page.locator('#dashboard-page')).toHaveAttribute('data-load-state','ready');
  await expect(panel).not.toHaveAttribute('open','');
  await panel.locator('summary').click(); await expect(panel).toHaveAttribute('open','');
  await page.reload(); await expect(panel).toHaveAttribute('open','');
  await expect(page.locator('.dashboard-scope')).toHaveText('in your Study Plan');
});

test('dashboard does not recommend recent or orphan packs outside the active plan', async ({page}) => {
  await fixture(page);
  await page.route('**/api/study-progress/summary*', route => route.fulfill({json:{active_plan_pack_ids:[],current_streak:4,due_today:0,daily_goal:20,today_progress:12}}));
  await page.goto('/dashboard'); await expect(page.locator('#dashboard-page')).toHaveAttribute('data-load-state','ready');
  await expect(page.locator('#dash-continue-link')).toHaveAttribute('href','/plan');
  await expect(page.locator('#dash-due')).toHaveText('0 cards');
  await expect(page.locator('#dash-sessions-list')).toContainText('Plan your first study session');
  await expect(page.locator('#dash-packs-list')).toContainText('Anatomy');
});
