const { test, expect } = require('./helpers/academy-service');

test('independent Studio notices expire after five seconds and pause separately on hover and focus', async ({academyPage: page, academyOrigin}, info) => {
  await page.setViewportSize({width:1280,height:860});
  await page.goto(academyOrigin + '/hulp');
  await page.clock.install();
  const notice = (text, type) => page.evaluate(({text,type}) => window.Xped.ux.toast(text,{type}), {text,type});
  await notice('Eerste melding','success');
  await page.clock.runFor(2000);
  await notice('Tweede melding','error');
  const first = page.getByRole('status').filter({hasText:'Eerste melding'});
  const second = page.getByRole('alert').filter({hasText:'Tweede melding'});
  await expect(first.locator('[aria-hidden="true"]')).toHaveText('✓');
  await first.hover();
  await info.attach('desktop-notices', {body:await page.screenshot(),contentType:'image/png'});
  const desktop=await first.boundingBox();
  expect(desktop.x+desktop.width).toBeCloseTo(1256,0);
  await page.clock.runFor(3500);
  await expect(second).toBeVisible();
  await second.focus();
  await page.mouse.move(100,100);
  await page.clock.runFor(3100);
  await expect(first).toHaveCount(0);
  await expect(second).toBeVisible();
  await page.locator('#ac-settings-toggle').focus();
  await page.clock.runFor(1700);
  await expect(second).toHaveCount(0);
});

test('the stack protects a focused action, bounds its size and centers German messages on mobile', async ({academyPage: page, academyOrigin}, info) => {
  await page.context().addCookies([{name:'xped-language',value:'de',url:academyOrigin}]);
  await page.setViewportSize({width:390,height:844});
  await page.goto(academyOrigin + '/hulp');
  await page.evaluate(() => {
    window.Xped.ux.toast('Expedition duplicated.',{type:'success',action:{label:'Open',href:'/expedities'}});
    window.Xped.ux.toast('Zweite Nachricht');
    window.Xped.ux.toast('Dritte Nachricht');
  });
  const link=page.getByRole('link',{name:'Öffnen',exact:true});
  await expect(link).toHaveAttribute('href','/expedities');
  await link.focus();
  await page.evaluate(() => window.Xped.ux.toast('Could not sign out. Please try again.',{type:'error'}));
  const stack=page.locator('.ac-toast-stack');
  await expect(stack.locator(':scope > *')).toHaveCount(3);
  await expect(stack).not.toContainText('Zweite Nachricht');
  await expect(link).toBeFocused();
  await expect(stack.getByRole('alert')).toContainText('abgemeldet');
  const item=stack.getByRole('status').filter({hasText:'Kopie erstellt.'});
  const box=await item.boundingBox();
  expect(box.x+box.width/2).toBeCloseTo(195,0);
  await info.attach('mobile-notices', {body:await page.screenshot(),contentType:'image/png'});
  await link.press('Enter');
  await expect(page).toHaveURL(academyOrigin + '/expedities');
});
