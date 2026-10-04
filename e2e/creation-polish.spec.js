const {test,expect}=require('@playwright/test');
const fs=require('node:fs');
const path=require('node:path');
const {installAccountFixture}=require('./helpers/batch-fixture');
const evidence='/tmp/study-flow-creation-evidence';fs.mkdirSync(evidence,{recursive:true});
test.use({serviceWorkers:'block'});
async function fixture(page){
 await installAccountFixture(page);
 await page.route(/\/static\/js\/(index-app|index-mode-config|buy-credits|batch-mode|lecture-downloader)(\.min)?\.js(?:\?.*)?$/,r=>r.fulfill({contentType:'application/javascript',path:path.resolve('static/js',new URL(r.request().url()).pathname.split('/').pop().replace('.min.js','.js'))}));
 await page.route('**/api/auth/user',r=>r.fulfill({json:{uid:'a',preferences:{output_language:'english',onboarding_completed:true},credits:{lecture_standard:0,slides:0,interview_short:0}}}));
 await page.route('**/api/verify-email',r=>r.fulfill({json:{allowed:true}}));
}
for(const width of [1440,1024,390])test(`creation guidance and spacing at ${width}`,async({page})=>{
 await fixture(page);await page.setViewportSize({width,height:1000});
 await page.goto('/buy_credits');await page.evaluate(()=>document.fonts.ready);
 for(const category of await page.locator('.category').all()){
  const description=await category.locator('.credit-category-description').boundingBox();const card=await category.locator('.bundle-buy-btn').first().boundingBox();expect(card.y-description.y-description.height).toBeLessThanOrEqual(18);
 }
 await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:`${evidence}/credits-${width}.png`,fullPage:true,animations:'disabled'});
 await page.goto('/lecture-notes');await page.locator('#other-audio-toggle').click();await page.locator('#audio-url-advanced-toggle').click();await expect(page.locator('#audio-url-advanced-panel')).toHaveAttribute('aria-hidden','false');
 await expect.poll(async()=>{const h=await page.locator('#other-audio-toggle').boundingBox();const t=await page.locator('#audio-recorder-timer').boundingBox();return t.y-h.y-h.height;}).toBeGreaterThanOrEqual(16);
 await expect(page.locator('#audio-url-advanced-panel')).toContainText('Cmd + Option + I');await expect(page.locator('#audio-url-advanced-panel')).toContainText('Ctrl + Shift + I');
 await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:`${evidence}/record-import-${width}.png`,fullPage:true,animations:'disabled'});
 await page.locator('#other-audio-toggle').click();await expect.poll(()=>page.locator('#other-audio-body').evaluate(e=>e.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
 await page.goto('/batch_mode');const disclosure=page.locator('.row-url-import').first();await disclosure.locator('summary').click();await expect(disclosure).toContainText('Cmd + Option + I');
 await expect.poll(async()=>{const r=await disclosure.locator('.row-url-row').boundingBox();const h=await disclosure.locator('.row-url-help').boundingBox();return h.y-r.y-r.height;}).toBeGreaterThanOrEqual(15);
 await page.evaluate(()=>window.scrollTo({top:0,behavior:'instant'}));await page.screenshot({path:`${evidence}/batch-import-${width}.png`,fullPage:true,animations:'disabled'});
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
});
test('playlist-first guidance is consistent across public and download pages',async({page})=>{
 await fixture(page);
 for(const url of ['/features','/helpcenter','/FAQ','/lecture-downloader']){
  await page.goto(url);if(url==='/FAQ')await page.getByText('What does “Import from lecture video URL” mean?',{exact:true}).click();
  await expect(page.locator('body')).toContainText('Cmd + Option + I');await expect(page.locator('body')).toContainText('Ctrl + Shift + I');await expect(page.locator('body')).toContainText('index.m3u8');
  await expect(page.locator('body')).not.toContainText(/normal lecture.*page|If the page cannot be resolved|page URL first/);
 }
});
for(const url of ['/buy_credits','/lecture-notes'])test(`checkout Back and persisted restore reset controls when entering from ${url}`,async({page})=>{
 await fixture(page);let attempts=0;let hold=false;let release;
 await page.route('**/api/create-checkout-session',async r=>{attempts++;if(hold)await new Promise(resolve=>{release=resolve;});await r.fulfill({json:{checkout_url:'/__mock_checkout'}});});
 await page.route('**/__mock_checkout',r=>r.fulfill({contentType:'text/html',body:'<!doctype html><h1>Mock checkout</h1>'}));
 async function open(){await page.goto(url);if(url==='/lecture-notes')await page.getByRole('link',{name:'Buy more credits',exact:true}).click();}
 await open();await expect(page).toHaveURL(/buy_credits$/);let button=page.locator('.bundle-buy-btn[data-bundle-id="lecture_5"]');await button.click();await expect(page).toHaveURL(/__mock_checkout/);await page.goBack();
 if(url==='/lecture-notes'&&!(await button.isVisible()))await page.getByRole('link',{name:'Buy more credits',exact:true}).click();
 await expect(button).toBeEnabled();await expect(button).not.toContainText('Redirecting');expect(attempts).toBe(1);
 hold=true;await button.click();await expect.poll(()=>attempts).toBe(2);await expect(button).toBeDisabled();
 // Exercise the persisted lifecycle even when the test browser disables real bfcache.
 await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
 await expect(button).toBeEnabled();await expect(button).not.toContainText('Redirecting');release();await page.waitForLoadState('networkidle');await expect(page).toHaveURL(/buy_credits$/);
 hold=false;await button.click();await expect(page).toHaveURL(/__mock_checkout/);expect(attempts).toBe(3);
});
