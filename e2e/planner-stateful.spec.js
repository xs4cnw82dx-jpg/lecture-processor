const {test,expect}=require('@playwright/test');
const {expectProductControls}=require('./helpers/control-audit');
test.describe.configure({mode:'serial'});
test.skip(process.env.PLANNER_STATEFUL_FIXTURE!=='1','Requires the isolated real planner backend fixture');
const headers={Authorization:'Bearer planner-fixture-token'};
function dateAfter(days){const d=new Date();d.setDate(d.getDate()+days);return d.toISOString().slice(0,10);}
async function bootstrap(page,request){
 await request.post('/__planner-fixture/reset');
 await page.addInitScript(()=>{
  const user={uid:'planner-fixture-user',email:'planner@example.test',getIdToken:()=>Promise.resolve('planner-fixture-token')};
  const listeners=[];const auth={currentUser:user,setPersistence:()=>Promise.resolve(),authStateReady:()=>Promise.resolve(),onAuthStateChanged:cb=>{listeners.push(cb);queueMicrotask(()=>cb(user));return()=>{};}};
  window.__plannerSignOut=()=>{auth.currentUser=null;listeners.forEach(cb=>cb(null));};
  const factory=()=>auth;factory.Auth={Persistence:{LOCAL:'local'}};window.firebase={app:()=>({}),initializeApp:()=>({}),auth:factory};
 });
 await page.route('https://www.gstatic.com/firebasejs/**',r=>r.fulfill({body:'',contentType:'text/javascript'}));
 await page.route('**/api/auth/user',r=>r.fulfill({json:{uid:'planner-fixture-user',email_verified:true,onboarding_completed:true,allowed:true}}));
 await page.goto('/plan');await expect(page.locator('#study-plan-workspace')).toBeVisible();
}
async function snapshot(request){const response=await request.get('/api/study-plan',{headers});expect(response.ok()).toBeTruthy();return response.json();}
async function configure(page,{title='Anatomy exam',pack='fixture_anatomy',deadline=dateAfter(8),time='17:00',editing=false}={}){
 if(!editing)await page.locator('#new-study-goal-btn').click();
 await page.locator('#wizard-pack-list input[value="'+pack+'"]').check();
 await page.locator('#wizard-next-btn').click();
 await page.locator('#wizard-goal-title').fill(title);await page.locator('#wizard-exam-date').fill(deadline);
 await page.locator('#wizard-next-btn').click();await page.locator('[data-availability-preset="daily"]').click();
 await page.locator('#wizard-start-time').fill(time);await page.locator('#wizard-next-btn').click();
 await expect(page.locator('[data-wizard-step="4"]')).toBeVisible();
}
async function accept(page){await page.locator('#wizard-next-btn').click();await expect(page.locator('#plan-wizard-overlay')).toBeHidden();}

test('real planner lifecycle preserves completed work across editing, multiple goals, conflicts and deletion',async({page,request},testInfo)=>{
 await bootstrap(page,request);await configure(page);await accept(page);
 let data=await snapshot(request);const goalId=data.goals[0].goal_id;expect(data.sessions.length).toBeGreaterThan(1);
 await page.reload();await expect(page.locator('[data-goal-id="'+goalId+'"]')).toContainText('Anatomy exam');
 const first=data.sessions.find(s=>s.status==='planned');
 await page.locator('[data-next-complete]').click();await page.locator('#study-log-minutes').fill('25');await page.locator('#study-log-submit').click();await expect(page.locator('#study-log-overlay')).toBeHidden();
 data=await snapshot(request);const completed=data.sessions.find(s=>s.status==='completed');expect(completed.id).toBe(first.id);
 await page.locator('[data-edit-goal="'+goalId+'"]').click();
 await configure(page,{editing:true,title:'Anatomy and cells',pack:'fixture_biology',deadline:dateAfter(10)});await accept(page);
 data=await snapshot(request);expect(data.goals.filter(g=>g.status==='active')).toHaveLength(1);expect(data.goals[0].goal_id).toBe(goalId);expect(data.goals[0].pack_ids).toHaveLength(2);expect(data.sessions.find(s=>s.id===completed.id).status).toBe('completed');
 await configure(page,{title:'Biology final',pack:'fixture_biology'});
 await expect(page.locator('#wizard-next-btn')).toBeDisabled();await expect(page.locator('#wizard-action-feedback')).toContainText('overlap');
 await page.screenshot({path:testInfo.outputPath('planner-conflict.png'),animations:'disabled'});
 await page.locator('#wizard-adjust-times-btn').click();await page.locator('#wizard-start-time').fill('18:00');await page.locator('#wizard-next-btn').click();await accept(page);
 await page.reload();data=await snapshot(request);expect(data.goals.filter(g=>g.status==='active')).toHaveLength(2);
 await page.locator('[data-plan-view="schedule"]').click();await expectProductControls(page);
 const colors=await page.locator('.schedule-pack-key').evaluateAll(nodes=>nodes.map(n=>getComputedStyle(n).getPropertyValue('--pack-color')));expect(new Set(colors).size).toBe(colors.length);
 await page.screenshot({path:testInfo.outputPath('planner-two-goals-calendar.png'),animations:'disabled'});
 await page.locator('#schedule-goals-btn').click();await page.setViewportSize({width:390,height:844});
 await page.screenshot({path:testInfo.outputPath('planner-goals-mobile.png'),animations:'disabled'});
 await page.locator('[data-delete-goal="'+goalId+'"]').click();await page.getByRole('button',{name:'Delete goal',exact:true}).click();
 await expect(page.locator('[data-goal-id="'+goalId+'"]')).toHaveCount(0);await page.reload();data=await snapshot(request);
 expect(data.goals.filter(g=>g.status==='active')).toHaveLength(1);expect(data.sessions.find(s=>s.id===completed.id).status).toBe('completed');
 expect(data.sessions.filter(s=>s.goal_id===goalId&&s.status==='planned')).toHaveLength(0);
 expect(data.sessions.some(s=>s.goal_id!==goalId&&s.status==='planned')).toBeTruthy();
});

test('real acceptance errors remain actionable and retries never duplicate a committed goal',async({page,request},testInfo)=>{
 await bootstrap(page,request);await configure(page);
 await request.post('/__planner-fixture/fault',{data:{next_apply:'missing_index'}});await page.locator('#wizard-next-btn').click();
 await expect(page.locator('#wizard-action-feedback')).toContainText('temporarily unavailable');expect((await snapshot(request)).goals).toHaveLength(0);
 await page.screenshot({path:testInfo.outputPath('planner-save-error.png'),animations:'disabled'});await accept(page);
 await configure(page,{title:'Biology final',pack:'fixture_biology',time:'18:00'});
 await request.post('/__planner-fixture/fault',{data:{next_apply:'lost_response'}});await page.locator('#wizard-next-btn').click();
 await expect(page.locator('#wizard-action-feedback')).toContainText('could not confirm');expect((await snapshot(request)).goals.filter(g=>g.status==='active')).toHaveLength(2);
 await accept(page);await page.reload();expect((await snapshot(request)).goals.filter(g=>g.status==='active')).toHaveLength(2);
});

test('planner month navigation keeps its date picker open and keyboard focus inside',async({page,request})=>{
 await bootstrap(page,request);await page.locator('#new-study-goal-btn').click();await page.locator('#wizard-pack-list input[value="fixture_anatomy"]').check();await page.locator('#wizard-next-btn').click();
 await page.locator('#wizard-exam-date').click();const picker=page.locator('.date-picker-popover:not(.is-closing)');
 const original=await picker.locator('.date-picker-title').textContent();await picker.getByRole('button',{name:'Next month',exact:true}).click();await expect(picker).toBeVisible();await expect(picker.getByRole('button',{name:'Next month',exact:true})).toBeFocused();
 await picker.getByRole('button',{name:'Previous month',exact:true}).click();await expect(picker.locator('.date-picker-title')).toHaveText(original);await picker.locator('[data-picker-date]:not([disabled])').first().click();await expect(picker).toHaveCount(0);await expect(page.locator('#wizard-exam-date')).not.toHaveValue('');
});


test('clear entire plan confirms scope and retains completed history and packs after reload',async({page,request},testInfo)=>{
 await bootstrap(page,request);await configure(page);await accept(page);
 await page.locator('[data-next-complete]').click();await page.locator('#study-log-minutes').fill('25');await page.locator('#study-log-submit').click();await expect(page.locator('#study-log-overlay')).toBeHidden();
 const before=await snapshot(request);const completed=before.sessions.find(s=>s.status==='completed');
 await page.locator('#clear-study-plan-btn').click();
 const dialog=page.getByRole('dialog');await expect(dialog).toContainText('manual, overdue and unlinked');await expect(dialog).toContainText('learning progress stay safe');
 await page.screenshot({path:testInfo.outputPath('clear-plan-desktop.png'),animations:'disabled'});
 await page.getByRole('button',{name:'Keep my plan',exact:true}).click();expect((await snapshot(request)).goals.some(g=>g.status==='active')).toBe(true);
 await page.setViewportSize({width:390,height:844});await page.locator('#clear-study-plan-btn').click();
 await page.screenshot({path:testInfo.outputPath('clear-plan-mobile.png'),animations:'disabled'});
 await page.getByRole('button',{name:'Clear entire plan',exact:true}).last().click();
 await expect(page.locator('#goal-health-content')).toContainText('Start with a study goal');await page.reload();
 const after=await snapshot(request);expect(after.goals.filter(g=>g.status==='active')).toHaveLength(0);expect(after.sessions.filter(s=>s.status==='planned')).toHaveLength(0);
 expect(after.sessions.find(s=>s.id===completed.id).status).toBe('completed');expect(after.study_packs.length).toBe(before.study_packs.length);
});


test('reset confirmation cannot authorize a different account after sign out',async({page,request})=>{
 await bootstrap(page,request);await configure(page);await accept(page);
 let resets=0;page.on('request',req=>{if(req.url().includes('/api/study-plan/reset'))resets++;});
 await page.locator('#clear-study-plan-btn').click();await page.evaluate(()=>window.__plannerSignOut());
 await page.getByRole('button',{name:'Clear entire plan',exact:true}).last().click();
 await expect(page.locator('#study-plan-auth')).toBeVisible();expect(resets).toBe(0);
 expect((await snapshot(request)).goals.some(g=>g.status==='active')).toBe(true);
});
