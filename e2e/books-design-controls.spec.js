const { test, expect } = require('@playwright/test');
const field = (page, name) => page.locator(`[data-field="${name}"]`);
async function studio(page, xped = false) {
  await page.route('**/static/js/firebase-bootstrap.js', route => route.fulfill({contentType:'text/javascript',body:'window.LectureProcessorBootstrap={getAuth:()=>({currentUser:null,onAuthStateChanged:fn=>queueMicrotask(()=>fn(null))})};'}));
  await page.goto('/books');
  await page.getByRole('button',{name:'＋ New book',exact:true}).click();
  await page.locator('[data-template="blank"]').click();
  await expect(page.locator('#save-state')).toHaveText('Saved on this device');
  if (xped) {
    await page.locator('summary').filter({hasText:'Book palette & themes'}).click();
    await page.getByRole('button',{name:'Choose a book theme',exact:true}).click();
    await page.locator('[data-theme="xped"]').click();
    await page.locator('[data-xped-variant="route"]').click();
    await page.locator('.book-cover-grid').screenshot({path:test.info().outputPath('xped-cover-pairs.png')});
    await page.getByRole('button',{name:'Apply xPED',exact:true}).click();
  }
}
async function extra(page,type) {
  await page.getByRole('button',{name:'More tools',exact:true}).click();
  await page.locator(`[data-extra="${type}"]`).click();
}
async function drag(page,locator,dx,dy) {
  const r=await locator.boundingBox();
  await page.mouse.move(r.x+r.width/2,r.y+r.height/2); await page.mouse.down();
  await page.mouse.move(r.x+r.width/2+dx,r.y+r.height/2+dy,{steps:8}); await page.mouse.up();
}

test('logos move, resize, reset and persist; page numbers have a visible center preset and free placement', async({page})=>{
  await page.setViewportSize({width:1512,height:1000});
  await studio(page,true);
  const logo=page.locator('#book-spread svg [data-furniture="logo"]');
  const before=await logo.boundingBox();
  await drag(page,logo,70,-50);
  await expect(page.locator('#inspector h2')).toHaveText('xPED logo');
  const moved=await logo.boundingBox();expect(moved.x).toBeGreaterThan(before.x+30);
  await field(page,'furniture.w').fill('28');
  await expect(field(page,'furniture.w')).toHaveValue('28');
  await page.reload();
  await page.locator('#book-spread svg [data-furniture="logo"]').click();
  await expect(field(page,'furniture.w')).toHaveValue('28');
  await page.locator('#inspector #reset-furniture').click();
  await expect(field(page,'furniture.w')).not.toHaveValue('28');
  await page.getByRole('button',{name:'Next pages',exact:true}).click();
  await page.getByRole('button',{name:'Page numbers',exact:true}).click();
  await field(page,'pageNumbers.enabled').setChecked(true);
  await page.getByRole('button',{name:'Bottom center',exact:true}).click();
  await expect(page.getByRole('button',{name:'Bottom center',exact:true})).toHaveAttribute('aria-pressed','true');
  const number=page.locator('#book-spread svg [data-furniture="number"]').first();
  await drag(page,number,40,-25);
  await expect(page.locator('#inspector h2')).toHaveText('Page number');
  const left=await field(page,'furniture.x').inputValue();
  await page.reload();
  await page.getByRole('button',{name:'Next pages',exact:true}).click();
  await page.locator('#book-spread svg [data-furniture="number"]').first().click();
  await expect(field(page,'furniture.x')).toHaveValue(left);
  await field(page,'pageNumbers.enabled').setChecked(false);
  await page.locator('.book-sheet').first().press('ArrowRight');
  await expect(page.locator('#page-position')).toHaveText('Back cover');
});

test('lines and filled arrows support right-click bends, free movement, markers, undo and reload',async({page})=>{
  await studio(page);
  await extra(page,'line');
  await expect(field(page,'fill')).toHaveCount(0);
  await page.getByRole('button',{name:'Add bend',exact:true}).click();
  await expect(page.locator('.book-path-point')).toHaveCount(3);
  await drag(page,page.locator('[data-path-point="1"]'),0,75);
  const original=await field(page,'h').inputValue();expect(Number(original)).toBeGreaterThan(15);
  await field(page,'nodeMarkers').setChecked(true);
  await field(page,'markerDiameter').evaluate(el=>{el.value='7';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await chooseField(page, 'pathMode', 'smooth');
  await chooseField(page, 'arrowLine', 'dashed');
  await expect(page.locator('#book-spread [data-object] circle[fill="#ffd617"],#book-spread [data-object] circle[fill="#FFD617"]')).toHaveCount(1);
  await page.locator('[data-path-point="1"]').click({button:'right'});
  await expect(page.getByRole('menu',{name:'Edit line'})).toBeVisible();
  await page.getByRole('menuitem',{name:'Add bend here'}).click();
  await expect(page.locator('.book-path-point')).toHaveCount(4);
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.locator('#book-spread [data-object] circle')).toHaveCount(1);
  await extra(page,'arrow');
  await field(page,'stroke').evaluate(el=>{el.value='#127ac4';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await expect(field(page,'arrowFill')).toHaveValue('#127ac4');
  await field(page,'arrowFill').evaluate(el=>{el.value='#cc2244';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await expect(page.locator('#book-spread [data-object] [fill="#cc2244"]').first()).toBeVisible();
  await page.reload();
  await expect(page.locator('#book-spread [data-object] [fill="#cc2244"]').first()).toBeVisible();
  await page.locator('#book-spread [data-object]').last().click();
  await page.locator('[data-path-point="0"]').press('Alt+ArrowRight');
  await expect(page.locator('#page-position')).toContainText('1–2');
});

test('color popover previews live and closes with its trigger, outside click and Escape without reopening',async({page})=>{
  await studio(page);
  await page.getByRole('button',{name:'Add shape',exact:true}).click();
  const input=field(page,'fill');
  const trigger=input.locator('..').locator('button');
  await trigger.click();
  await expect(page.locator('.book-color-popover')).toBeVisible();
  await trigger.click();
  await expect(page.locator('.book-color-popover')).toBeHidden();
  await trigger.click();
  await page.getByRole('button',{name:'Page numbers',exact:true}).click();
  await expect(page.locator('.book-color-popover')).toBeHidden();
  await page.locator('#book-spread [data-object]').first().click();
  await field(page,'fill').locator('..').locator('button').click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.book-color-popover')).toBeHidden();
  await expect(field(page,'fill')).toBeAttached();
});

test('color spectrum drags are live, preserve hue on white and undo as one edit',async({page})=>{
  await studio(page);
  await page.getByRole('button',{name:'Add shape',exact:true}).click();
  const original=await field(page,'fill').inputValue();
  await page.getByRole('button',{name:'Choose fill',exact:true}).click();
  await page.getByRole('textbox',{name:'Hex color',exact:true}).fill('#ffffff');
  await page.getByRole('slider',{name:'Hue',exact:true}).press('End');
  await expect(page.getByRole('slider',{name:'Hue',exact:true})).toHaveValue('359');
  const spectrum=page.locator('.book-color-spectrum'), box=await spectrum.boundingBox();
  await page.mouse.move(box.x+box.width*.2,box.y+box.height*.2); await page.mouse.down();
  await page.mouse.move(box.x+box.width*.8,box.y+box.height*.35,{steps:12}); await page.mouse.up();
  const after=await field(page,'fill').inputValue();expect(after).not.toBe('#ffffff');
  await expect(page.locator(`#book-spread [data-object] [fill="${after}"]`).first()).toBeVisible();
  await page.getByRole('button',{name:'Done',exact:true}).click();
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.locator(`#book-spread [data-object] [fill="${original}"]`).first()).toBeVisible();
  await page.getByRole('button',{name:'Redo',exact:true}).click();
  await expect(page.locator(`#book-spread [data-object] [fill="${after}"]`).first()).toBeVisible();
});

test('narrow-screen color picker keeps its trigger reachable and stays inside the viewport',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await studio(page);
  await page.getByRole('button',{name:'Add shape',exact:true}).click();
  await page.getByRole('button',{name:'Choose fill',exact:true}).click();
  const popup=page.locator('.book-color-popover');await expect(popup).toBeVisible();
  const rect=await popup.boundingBox();expect(rect.x).toBeGreaterThanOrEqual(0);expect(rect.x+rect.width).toBeLessThanOrEqual(390);expect(rect.y+rect.height).toBeLessThanOrEqual(845);
  await page.getByRole('button',{name:'Choose fill',exact:true}).click();
  await expect(popup).toBeHidden();
});

async function chooseField(page, name, value) {
  const native = field(page, name);
  const label = await native.locator('option').evaluateAll((options, selected) => options.find(option => option.value === String(selected)).textContent, value);
  await native.locator('..').locator('.app-select-button').click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await expect(field(page, name)).toHaveValue(String(value));
}
