const { test, expect } = require('@playwright/test');
async function picker(page) {
  await page.route('**/static/js/firebase-bootstrap.js', route => route.fulfill({contentType:'text/javascript',body:'window.LectureProcessorBootstrap={getAuth:()=>({currentUser:null,onAuthStateChanged:fn=>queueMicrotask(()=>fn(null))})};'}));
  await page.goto('/books');
  await page.getByRole('button', {name:'＋ New book', exact:true}).click();
  await page.locator('[data-template="blank"]').click();
  await expect(page.locator('#save-state')).toHaveText('Saved on this device');
  await page.getByRole('button', {name:'Add shape', exact:true}).click();
  await page.getByRole('button', {name:'Choose fill', exact:true}).click();
  await expect(page.locator('.book-color-popover')).toBeVisible();
}

test('invalid hex keeps the picker open and shorthand colors preview immediately', async ({page}) => {
  await picker(page);
  const input = page.locator('[data-field="fill"]'), hex = page.getByRole('textbox', {name:'Hex color', exact:true});
  const original = await input.inputValue();
  await hex.fill('#oops');
  await hex.press('Enter');
  await expect(hex).toBeFocused();
  await expect(hex).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#book-color-help')).toHaveText('Enter a color such as #4F46E5 or #ABC.');
  await expect(input).toHaveValue(original);
  await page.getByRole('button', {name:'Done', exact:true}).click();
  await expect(hex).toBeFocused();
  await hex.fill('#abc');
  await expect(input).toHaveValue('#aabbcc');
  await hex.fill('#no');
  await page.getByRole('slider', {name:'Brightness', exact:true}).press('End');
  await expect(hex).toHaveAttribute('aria-invalid', 'false');
  await page.getByRole('button', {name:'Done', exact:true}).click();
  await expect(page.locator('.book-color-popover')).toBeHidden();
});

test('keyboard tab boundaries close the picker and return to its trigger', async ({page}) => {
  await picker(page);
  await page.getByRole('button', {name:'Done', exact:true}).focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('.book-color-popover')).toBeHidden();
  await expect(page.getByRole('button', {name:'Choose fill', exact:true})).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('button', {name:'Close color picker', exact:true}).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('.book-color-popover')).toBeHidden();
  await expect(page.getByRole('button', {name:'Choose fill', exact:true})).toBeFocused();
});

test('secondary pointers cannot move or end an active spectrum drag', async ({page}) => {
  await picker(page);
  const spectrum = page.locator('.book-color-spectrum'), input = page.locator('[data-field="fill"]');
  const box = await spectrum.boundingBox();
  await page.mouse.move(box.x + box.width * .2, box.y + box.height * .2);
  await page.mouse.down();
  const before = await input.inputValue();
  await spectrum.dispatchEvent('pointerdown', {pointerId:99, pointerType:'touch', button:0, clientX:box.x + box.width, clientY:box.y + box.height});
  await spectrum.dispatchEvent('pointermove', {pointerId:99, pointerType:'touch', clientX:box.x + box.width, clientY:box.y + box.height});
  await spectrum.dispatchEvent('pointerup', {pointerId:99, pointerType:'touch'});
  await expect(input).toHaveValue(before);
  await page.mouse.move(box.x + box.width * .8, box.y + box.height * .7, {steps:3});
  await expect(input).not.toHaveValue(before);
  await page.mouse.up();
  const final = await input.inputValue();
  await page.mouse.move(box.x + box.width * .1, box.y + box.height * .1);
  await expect(input).toHaveValue(final);
});

test('the picker follows the visible viewport when the mobile keyboard opens', async ({page}) => {
  await page.setViewportSize({width:390, height:844});
  await page.addInitScript(() => {
    const viewport = new EventTarget();
    Object.assign(viewport, {offsetLeft:0, offsetTop:0, width:390, height:844});
    Object.defineProperty(window, 'visualViewport', {value:viewport, configurable:true});
  });
  await picker(page);
  await page.getByRole('textbox', {name:'Hex color', exact:true}).focus();
  await page.evaluate(() => {
    Object.assign(window.visualViewport, {height:400, offsetTop:90});
    window.visualViewport.dispatchEvent(new Event('resize'));
  });
  const box = await page.locator('.book-color-popover').boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(102);
  expect(box.y + box.height).toBeLessThanOrEqual(479);
  expect(box.x).toBeGreaterThanOrEqual(12);
  expect(box.x + box.width).toBeLessThanOrEqual(378);
});
