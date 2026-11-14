const {test,expect}=require('@playwright/test');
const fs=require('node:fs');
const {installAccountFixture}=require('./helpers/batch-fixture');
const {expectProductControls}=require('./helpers/control-audit');
const evidence='/tmp/product-feedback-presentation';fs.mkdirSync(evidence,{recursive:true});
async function fixture(page) {
 await installAccountFixture(page);
 if(process.env.USE_MINIFIED_JS_ASSETS==='1')await page.route(/\/static\/js\/buy-credits(?:\.min)?\.js(?:\?.*)?$/,route=>route.continue());
}
for(const width of [1440,1024,768,390]) {
 test(`product presentation at ${width}px`,async({page})=>{
  await fixture(page);await page.setViewportSize({width,height:1000});
  for(const route of ['/','/features','/buy_credits']) {
   await page.goto(route);await page.evaluate(()=>document.fonts.ready);
   await expect(page.locator('h1')).toBeVisible();await expectProductControls(page);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),route).toBe(true);
   await expect(page.locator('body')).not.toContainText(/Tools Beta|smart grading|A calmer way to study/);
   await page.screenshot({path:`${evidence}/${route.slice(1)||'landing'}-${width}.png`,fullPage:true,animations:'disabled'});
   if(route==='/features'&&[1440,390].includes(width)) {await page.locator('#interviews').screenshot({path:`${evidence}/interviews-${width}.png`,animations:'disabled'});await page.locator('#modes').screenshot({path:`${evidence}/study-${width}.png`,animations:'disabled'});}
  }
 });
}
test('public workflow samples and editable time estimates reflect actual choices',async({page})=>{
 await fixture(page);await page.goto('/');
 await expect(page.locator('.hero')).toContainText('Transcribe your lecture recording');await expect(page.locator('.hero')).not.toContainText('Notes, flashcards, practice tests, and your next step');
 await expect(page.locator('.value-grid')).not.toContainText(/0[123] ·/);
 await page.goto('/features');await expect(page.locator('#capture')).toContainText('Brightspace or Kaltura');
 await expect(page.locator('#interviews')).toContainText('Onderzoeker');await expect(page.locator('#interviews')).toContainText('Geïnterviewde');
 await page.locator('#feature-sample-card').click();await expect(page.locator('#feature-card-text')).toContainText('Retrieving information');await page.locator('#feature-sample-card').click();await expect(page.locator('#feature-card-text')).toHaveText('What is active recall?');
 await page.locator('#calculator > summary').click();await page.locator('#calc-lectures').fill('10');await expect(page.locator('#calc-manual')).toHaveText('100h');await page.locator('#calc-review').fill('60');await expect(page.locator('#calc-lp')).toHaveText('150h');await expect(page.locator('#calc-saved')).toHaveText('-50h');
 await page.locator('#calculator > summary').click();await expect(page.locator('#calc-review')).toBeHidden();
});
test('unified credit bundles align and describe the action prices',async({page})=>{
 await fixture(page);await page.setViewportSize({width:1440,height:1000});await page.goto('/buy_credits');
 const bundles=page.locator('#credit-bundles .bundle-buy-btn');await expect(bundles).toHaveCount(3);
 const boxes=await bundles.evaluateAll(nodes=>nodes.map(node=>({top:node.getBoundingClientRect().top,height:node.getBoundingClientRect().height})));
 expect(new Set(boxes.map(box=>box.top)).size).toBe(1);expect(new Set(boxes.map(box=>box.height)).size).toBe(1);
 for(const bundle of await bundles.all()) {const price=await bundle.locator('.price').boundingBox();const label=await bundle.locator('.meta').boundingBox();expect(label.y).toBeGreaterThanOrEqual(price.y+price.height);}
 await expect(page.locator('#credit-cost-guide')).toBeVisible();await expect(page.locator('[data-credit-action]')).toHaveCount(11);
 await expect(page.locator('[data-credit-action="interview_extra"] [data-credit-rate="instant"]')).toHaveText('2');
 await expect(page.locator('[data-credit-action="interview_extra"] [data-credit-rate="overnight"]')).toHaveText('1');
});
