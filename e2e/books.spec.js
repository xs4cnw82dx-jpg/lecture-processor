const {test,expect}=require('@playwright/test');
const fs=require('fs');
const tinyPNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAMgAAACWCAYAAACb3McZAAABnklEQVR4nO3VMRGAMAAEwYB/JamRgwgkxEByGNgtv7/5653fM4Ctez8DAoEfHgSCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBIJAIAgEgkAgCASCQCAIBMbZAjdEBFaP6faTAAAAAElFTkSuQmCC','base64');

async function localStudio(page){
  await page.route('**/static/js/firebase-bootstrap.js',route=>route.fulfill({contentType:'text/javascript',body:'window.LectureProcessorBootstrap={getAuth:()=>({currentUser:null,onAuthStateChanged:fn=>queueMicrotask(()=>fn(null))})};'}));
  await page.goto('/books');
  await page.getByRole('button',{name:'＋ New book',exact:true}).click();
  await page.getByRole('button',{name:'Picture book A little room for a big adventure.',exact:true}).click();
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#save-state')).toHaveText('Saved on this device');
}
const field=(page,name)=>page.locator('[data-field="'+name+'"]');

test('local books fit the viewport, retain text, respect focus and manage pages',async({page})=>{
  await localStudio(page);
  const pageBounds=await page.locator('.book-sheet').boundingBox();
  const viewport=page.viewportSize();
  expect(pageBounds.height).toBeLessThan(viewport.height-130);
  await page.getByRole('button',{name:'Add text',exact:true}).click();
  await page.getByRole('textbox',{name:'Text',exact:true}).fill('A small fox found a bright idea.');
  await field(page,'style.font').selectOption('Andika');
  await field(page,'style.weight').selectOption('700');
  await expect(field(page,'style.weight')).toHaveValue('700');
  await field(page,'style.font').selectOption('Nunito');
  await expect(field(page,'style.weight')).toHaveAttribute('type','range');
  await page.locator('#object-text').press('ArrowRight');
  await expect(page.locator('#page-position')).toHaveText('Front cover');
  await page.locator('#book-spread').click({position:{x:6,y:6}});
  await page.keyboard.press('Shift+N');
  await expect(page.locator('.book-thumb')).toHaveCount(5);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.book-thumb')).toHaveCount(4);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.locator('.book-thumb')).toHaveCount(5);
  await page.getByRole('button',{name:'Delete page',exact:true}).click();
  await expect(page.locator('.book-thumb')).toHaveCount(4);
  await page.getByRole('button',{name:'History',exact:true}).click();
  await page.getByRole('button',{name:'Restore page',exact:true}).click();
  await expect(page.locator('.book-thumb')).toHaveCount(5);
  await page.reload();
  await expect(page.locator('.book-thumb')).toHaveCount(5);
  if(await page.getByRole('button',{name:'First page',exact:true}).isEnabled())await page.getByRole('button',{name:'First page',exact:true}).click();
  await expect(page.locator('#book-spread svg')).toContainText('A small fox found a bright idea.');
});

test('multiple image drops target the visible page, stay small and undo together',async({page})=>{
  await localStudio(page);
  await page.getByRole('button',{name:'Next pages',exact:true}).click();
  const sheet=page.locator('.book-sheet').nth(1),box=await sheet.boundingBox();
  const data=await page.evaluateHandle(bytes=>{const d=new DataTransfer();for(const name of ['one.png','two.png'])d.items.add(new File([new Uint8Array(bytes)],name,{type:'image/png'}));return d;},Array.from(tinyPNG));
  await sheet.dispatchEvent('dragover',{dataTransfer:data});
  await expect(sheet).toHaveClass(/drop-target/);
  await sheet.dispatchEvent('drop',{dataTransfer:data,clientX:box.x+box.width/2,clientY:box.y+box.height/2});
  await expect(sheet.locator('image')).toHaveCount(2);
  await expect(page.locator('.book-sheet').first().locator('image')).toHaveCount(0);
  expect(Number(await field(page,'w').inputValue())).toBeLessThanOrEqual(74.3);
  expect(Number(await field(page,'h').inputValue())).toBeLessThanOrEqual(105);
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(sheet.locator('image')).toHaveCount(0);
  await page.getByRole('button',{name:'Redo',exact:true}).click();
  await expect(sheet.locator('image')).toHaveCount(2);
  await page.reload();
  await page.getByRole('button',{name:'Next pages',exact:true}).click();
  await expect(page.locator('.book-sheet').nth(1).locator('image')).toHaveCount(2);
});

test('file picker, invalid images, backup and all print export choices work',async({page})=>{
  test.setTimeout(120000);
  await localStudio(page);
  await page.locator('#image-input').setInputFiles({name:'sketch.png',mimeType:'image/png',buffer:tinyPNG});
  await expect(page.locator('#book-spread image')).toHaveCount(1);
  await page.locator('#image-input').setInputFiles({name:'notes.txt',mimeType:'text/plain',buffer:Buffer.from('not an image')});
  await expect(page.locator('#upload-list')).toContainText('Choose a PNG, JPEG or WebP image.');
  await page.getByRole('button',{name:'Export',exact:true}).click();
  for(const [format,arrangement] of [['faithful','cut'],['faithful','fold'],['editable','cut'],['editable','fold'],['pdf','cut']]){
    await field(page,'exportFormat').selectOption(format);
    await field(page,'arrangement').selectOption(arrangement);
    const pending=page.waitForEvent('download');
    await page.getByRole('button',{name:'Download',exact:true}).click();
    const download=await pending;
    const file=await download.path();
    expect(fs.statSync(file).size).toBeGreaterThan(1000);
    expect(download.suggestedFilename()).toMatch(format==='pdf'?/\.pdf$/:/\.docx$/);
  }
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'Download backup',exact:true}).click();
  const archive=await (await pending).path();
  await page.getByRole('button',{name:'Close dialog',exact:true}).click();
  await page.getByRole('link',{name:'Book Studio library',exact:true}).click();
  await page.locator('#backup-input').setInputFiles(archive);
  await expect(page.locator('#workspace')).toBeVisible();
  await expect(page.locator('#book-spread image')).toHaveCount(1);
  await expect(page.locator('#book-title')).toHaveValue(/imported/);
});

test('mobile navigation, drawing and reduced-motion remain usable',async({page})=>{
  await page.setViewportSize({width:390,height:844});
  await page.emulateMedia({reducedMotion:'reduce'});
  await localStudio(page);
  await expect(page.locator('.book-sheet')).toHaveCount(1);
  await page.getByRole('button',{name:'Next pages',exact:true}).click();
  const metrics=await page.evaluate(()=>({width:document.body.scrollWidth,viewport:innerWidth,animation:getComputedStyle(document.getElementById('book-spread')).animationName,nav:document.querySelector('.book-navigation').getBoundingClientRect().bottom}));
  expect(metrics.width).toBeLessThanOrEqual(metrics.viewport);expect(metrics.animation).toBe('none');expect(metrics.nav).toBeLessThanOrEqual(844);
  await page.getByRole('button',{name:'Draw',exact:true}).click();
  const sheet=page.locator('.book-sheet');const box=await sheet.boundingBox();
  await sheet.dispatchEvent('pointerdown',{pointerType:'pen',pointerId:1,clientX:box.x+30,clientY:box.y+100,pressure:.7,bubbles:true});
  await page.dispatchEvent('body','pointermove',{pointerType:'pen',pointerId:1,clientX:box.x+100,clientY:box.y+120,pressure:.3,bubbles:true});
  await page.dispatchEvent('body','pointerup',{pointerType:'pen',pointerId:1,bubbles:true});
  await expect(page.locator('#book-spread svg path')).not.toHaveCount(0);
  await page.getByRole('button',{name:'Page settings',exact:true}).click();
  await expect(page.locator('#inspector')).toBeVisible();
  await page.getByRole('button',{name:'Close settings',exact:true}).click();
  await page.getByRole('button',{name:'Read',exact:true}).click();
  await expect(page.locator('.book-toolbar')).toBeHidden();
});
