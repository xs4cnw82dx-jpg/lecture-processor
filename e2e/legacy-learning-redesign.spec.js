const { test, expect } = require('@playwright/test');
test('retained planner uses shared date controls and calendar editor remains usable', async ({page}, testInfo) => {
  test.skip(process.env.STUDY_PLAN_V2 !== '0', 'Run explicitly with the supported legacy planner flag.');
  const stub = `(function(){var user={uid:'legacy-fixture',email:'student@example.com',getIdToken:()=>Promise.resolve('fixture')};var auth={currentUser:user,onAuthStateChanged:fn=>{queueMicrotask(()=>fn(user));return ()=>{};}};window.LectureProcessorBootstrap={getAuth:()=>auth,onAuthStateReady:(_auth,fn)=>fn(user)};})();`;
  await page.route('**/static/js/firebase-bootstrap.js', route=>route.fulfill({contentType:'text/javascript',body:stub}));
  let saved;
  await page.route('**/api/**',route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    let body={};
    if(path==='/api/study-folders') body={folders:[{folder_id:'anatomy',name:'Anatomy',exam_date:'2026-10-30'}]};
    if(path==='/api/study-packs') body={study_packs:[],packs:[]};
    if(path==='/api/study-progress') body={daily_goal:20,timezone:'Europe/Amsterdam'};
    if(path==='/api/study-folders/anatomy'){saved=request.postDataJSON();body={ok:true};}
    if(path==='/api/planner/sessions') body={sessions:[]};
    return route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('/plan');
  await expect(page.locator('#planner-content')).toBeVisible();
  await page.getByRole('button',{name:/Exam date for Anatomy:/}).first().click();
  await expect(page.getByRole('dialog',{name:'Choose a date'})).toBeVisible();
  await page.getByRole('button',{name:/31 October 2026/}).click();
  await expect.poll(()=>saved?.exam_date).toBe('2026-10-31');
  await page.screenshot({path:testInfo.outputPath('legacy-plan.png'),animations:'disabled'});
  await page.goto('/calendar');
  await page.locator('#add-session-btn').click();
  await expect(page.locator('#session-modal-overlay')).toBeVisible();
  await page.getByRole('button',{name:/Date:/}).click();
  await expect(page.getByRole('dialog',{name:'Choose a date'})).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#session-modal-overlay')).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  await page.screenshot({path:testInfo.outputPath('legacy-calendar-mobile.png'),animations:'disabled'});
});
