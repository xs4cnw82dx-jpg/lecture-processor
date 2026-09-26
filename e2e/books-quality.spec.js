const {test, expect} = require('@playwright/test');
const field = (page, name) => page.locator(`[data-field="${name}"]`);
async function studio(page) {
  await page.route('**/static/js/firebase-bootstrap.js', route => route.fulfill({contentType:'text/javascript',body:'window.LectureProcessorBootstrap={getAuth:()=>({currentUser:null,onAuthStateChanged:fn=>queueMicrotask(()=>fn(null))})};'}));
  await page.goto('/books');
  await page.getByRole('button',{name:'＋ New book',exact:true}).click();
  await page.locator('[data-template="blank"]').click();
  await expect(page.locator('#save-state')).toHaveText('Saved on this device');
}
async function seed(page, kind) {
  const id=new URL(page.url()).pathname.split('/').pop();
  await page.goto('/books');
  await page.evaluate(async ({kind,id}) => {
    const b=await window.BookStorage.getBook(id), M=window.BookModel;
    if(kind==='image') b.pages[0].items=[M.object('image',{w:60,h:30,x:20,y:40,assetId:'missing-image'})];
    if(kind==='locked-drawing') b.pages[0].items=[M.object('drawing',{name:'Locked sketch',locked:true,x:20,y:40,w:50,h:40,points:[[0,0,1],[50,40,1]]})];
    if(kind==='full') b.pages[0].items=Array.from({length:300},(_,i)=>M.object('shape',{x:i%10*12,y:Math.floor(i/10)*5,w:2,h:2}));
    await window.BookStorage.putBook(b);
  }, {kind,id});
  await page.goto(`/books/${id}`);
  await expect(page.locator('#workspace')).toBeVisible();
}

test('odd interior pages show only real pages and facing-page selection stays in sync',async({page})=>{
  await studio(page);
  await page.getByRole('button',{name:'Next pages',exact:true}).click();
  await page.locator('.book-sheet').nth(1).click({position:{x:100,y:100}});
  await expect(page.locator('.book-thumb[aria-current="true"]')).toContainText('Page 2');
  await expect(page.locator('.book-sheet[data-active="true"]')).toHaveAttribute('aria-label','Page 2: Untitled page');
  await expect(page.locator('.book-thumb[data-visible="true"]')).toHaveCount(2);
  await page.getByRole('button',{name:'Add page',exact:true}).click();
  await expect(page.locator('.book-thumb')).toHaveCount(5);
  await expect(page.locator('.book-sheet')).toHaveCount(1);
  await expect(page.locator('.book-sheet.blank')).toHaveCount(0);
  await expect(page.locator('.book-sheet')).toHaveAttribute('aria-label','Page 3: Untitled page');
  await page.getByRole('button',{name:'Add text',exact:true}).click();
  await page.getByRole('textbox',{name:'Text',exact:true}).fill('This page is real and editable');
  await expect(page.locator('#book-spread')).toContainText('This page is real and editable');
  await page.getByRole('button',{name:'Page settings',exact:true}).click();
  await page.getByRole('button',{name:'Delete page',exact:true}).click();
  await expect(page.locator('.book-thumb')).toHaveCount(4);
});

test('inline text survives viewport resizing, retains its caret, and leaves other thumbnails intact',async({page})=>{
  await studio(page);
  await page.getByRole('button',{name:'Add text',exact:true}).click();
  await page.getByRole('button',{name:'Edit text on page',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'Edit text on page',exact:true});
  await editor.fill('A sentence that stays open');
  await editor.press('ArrowLeft');

  await page.setViewportSize({width:1100,height:850});
  await expect(editor).toBeFocused();
  await editor.press('!');
  await expect(editor).toHaveValue('A sentence that stays ope!n');
  await page.evaluate(async()=>{ await document.fonts.ready; await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); window.qualityThumb=document.querySelectorAll('.book-thumb-preview svg')[1]; });
  await editor.press('?');
  expect(await page.evaluate(()=>window.qualityThumb===document.querySelectorAll('.book-thumb-preview svg')[1])).toBe(true);
  await editor.press('Escape');
  await expect(page.locator('.book-sheet')).toBeFocused();
  await expect(page.locator('#book-spread')).toContainText('A sentence that stays ope!?n');
});

test('blank numeric edits preserve image proportions and canvas selection releases inspector focus',async({page})=>{
  await studio(page);await seed(page,'image');
  await page.locator('#book-spread svg [data-object]').click();
  await field(page,'w').fill('');
  await field(page,'w').fill('80');
  await field(page,'h').click();
  await expect(field(page,'h')).toHaveValue('40');
  await field(page,'w').fill('');
  await field(page,'h').click();
  await expect(field(page,'w')).toHaveValue('80');
  await page.locator('#book-spread svg [data-object]').click();
  await page.keyboard.press('ArrowRight');
  await expect(field(page,'w')).toHaveValue('80');
  await expect(field(page,'x')).toHaveValue('20.5');
});

test('book title edits undo and redo together and update the browser title',async({page})=>{
  await studio(page);
  const original=await page.getByRole('textbox',{name:'Book title',exact:true}).inputValue();
  await page.getByRole('textbox',{name:'Book title',exact:true}).fill('A meaningful title');
  await expect(page).toHaveTitle('A meaningful title · Book Studio');
  await page.getByRole('button',{name:'Undo',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Book title',exact:true})).toHaveValue(original);
  await page.getByRole('button',{name:'Redo',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Book title',exact:true})).toHaveValue('A meaningful title');
});

test('reading mode prevents content shortcuts and canvas boundary navigation preserves selection',async({page})=>{
  await studio(page);
  await page.getByRole('button',{name:'Add shape',exact:true}).click();
  await page.locator('.book-sheet').press('Alt+ArrowLeft');
  await expect(page.locator('.book-selection')).toHaveCount(1);
  await page.getByRole('button',{name:'Read',exact:true}).click();
  await page.keyboard.press('Shift+N');await page.keyboard.press('ControlOrMeta+d');await page.keyboard.press('Backspace');
  await expect(page.locator('.book-thumb')).toHaveCount(4);
  await expect(page.locator('#book-spread svg [data-object]')).toHaveCount(1);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#page-position')).toHaveText('1–2 / 2');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Read',exact:true})).toBeVisible();
});

test('eraser respects locked drawings and selected tool indicators stay accurate',async({page})=>{
  await studio(page);await seed(page,'locked-drawing');
  await page.getByRole('button',{name:'Draw',exact:true}).click();
  await field(page,'tool').selectOption('eraser');
  await page.locator('#book-spread svg [data-object]').click();
  await expect(page.locator('#book-spread svg [data-object]')).toHaveCount(1);
  await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button',{name:'Select and move',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'Draw',exact:true}).click();
  await page.getByRole('button',{name:'Add shape',exact:true}).click();
  await expect(page.getByRole('button',{name:'Select and move',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:'Draw',exact:true})).toHaveAttribute('aria-pressed','false');
});

test('full pages refuse drawing and object creation without recording empty undo steps',async({page})=>{
  await studio(page);await seed(page,'full');
  await page.getByRole('button',{name:'Add shape',exact:true}).click();
  await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Draw',exact:true}).click();
  await page.locator('.book-sheet').click({position:{x:100,y:100}});
  await expect(page.locator('#book-spread svg [data-object]')).toHaveCount(300);
  await expect(page.getByRole('button',{name:'Undo',exact:true})).toBeDisabled();
});

test('inspector tabs use arrow-key navigation without nudging the selected object',async({page})=>{
  await studio(page);await page.getByRole('button',{name:'Add shape',exact:true}).click();
  await page.getByRole('tab',{name:'Settings',exact:true}).press('ArrowRight');
  await expect(page.getByRole('tab',{name:'Layers · 1',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByRole('tab',{name:'Layers · 1',exact:true})).toBeFocused();
  await page.getByRole('tab',{name:'Layers · 1',exact:true}).press('Home');
  await expect(field(page,'x')).toHaveValue('53');
  await expect(page.getByRole('tab',{name:'Settings',exact:true})).toHaveAttribute('aria-selected','true');
});

test('inline editing crosses the phone breakpoint without losing its page or caret',async({page})=>{
  await studio(page);
  await page.getByRole('button',{name:'Next pages',exact:true}).click();
  await page.locator('.book-sheet').nth(1).click({position:{x:100,y:100}});
  await page.getByRole('button',{name:'Add text',exact:true}).click();
  await page.getByRole('button',{name:'Edit text on page',exact:true}).click();
  const editor=page.getByRole('textbox',{name:'Edit text on page',exact:true});
  await editor.fill('My second page');await editor.press('ArrowLeft');
  await page.setViewportSize({width:760,height:850});
  await expect(page.locator('.book-sheet')).toHaveCount(1);
  await expect(editor).toBeFocused();await editor.press('!');
  await expect(editor).toHaveValue('My second pag!e');
  await page.getByRole('button',{name:'Next pages',exact:true}).click();
  await expect(page.locator('#page-position')).toHaveText('Back cover');
});

test('large proportion-locked images stay inside both saved dimension limits',async({page})=>{
  await studio(page);await seed(page,'image');
  await page.locator('#book-spread svg [data-object]').click();
  await field(page,'aspectLock').uncheck();
  await field(page,'w').fill('20');await field(page,'h').fill('100');
  await field(page,'aspectLock').check();
  await field(page,'w').fill('297');await field(page,'h').click();
  await expect(field(page,'w')).toHaveValue('84');
  await expect(field(page,'h')).toHaveValue('420');
});

test('a second pointer cannot move or end an active line-bend drag',async({page})=>{
  await studio(page);
  await page.getByRole('button',{name:'More tools',exact:true}).click();
  await page.locator('[data-extra="line"]').click();
  await page.getByRole('button',{name:'Add bend',exact:true}).click();
  const handle=page.locator('[data-path-point="1"]');
  const box=await handle.boundingBox();
  const point={clientX:box.x+box.width/2,clientY:box.y+box.height/2,bubbles:true,pointerType:'touch'};
  const before=await page.locator('#book-spread svg [data-object]').getAttribute('transform');
  await handle.dispatchEvent('pointerdown',{...point,pointerId:11});
  await page.locator('body').dispatchEvent('pointermove',{...point,pointerId:22,clientY:point.clientY+120});
  await page.locator('body').dispatchEvent('pointerup',{...point,pointerId:22});
  await expect(page.locator('#book-spread svg [data-object]')).toHaveAttribute('transform',before);
  await page.locator('body').dispatchEvent('pointermove',{...point,pointerId:11,clientY:point.clientY+80});
  await page.locator('body').dispatchEvent('pointerup',{...point,pointerId:11});
  expect(Number(await field(page,'h').inputValue())).toBeGreaterThan(15);
});

test('xPED river covers and an odd final page remain clear in the editor',async({page})=>{
  await page.setViewportSize({width:1512,height:960});
  await studio(page);
  await page.getByRole('textbox',{name:'Book title',exact:true}).fill('Een eigen route');
  await page.locator('summary').filter({hasText:'Book palette & themes'}).click();
  await page.getByRole('button',{name:'Choose a book theme',exact:true}).click();
  await page.locator('[data-theme="xped"]').click();
  await page.locator('[data-xped-variant="route"]').click();
  await page.getByRole('button',{name:'Apply xPED',exact:true}).click();
  await page.evaluate(async()=>{await document.fonts.ready;});
  await expect(page.locator('#book-spread svg path[data-xped-route="mint"]')).toHaveCount(1);
  await expect(page.locator('#book-spread svg path[data-xped-route="blue"]')).toHaveCount(1);
  await page.getByRole('button',{name:'Close settings',exact:true}).click();
  await expect(page.locator('#book-toast')).not.toBeVisible();
  await page.screenshot({animations:'disabled',path:test.info().outputPath('restored-river.png')});
  await page.getByRole('button',{name:'Last page',exact:true}).click();
  await page.screenshot({animations:'disabled',path:test.info().outputPath('restored-river-back.png')});
  await page.getByRole('button',{name:'Previous pages',exact:true}).click();
  await page.locator('.book-sheet').nth(1).click({position:{x:100,y:100}});
  await page.getByRole('button',{name:'Add page',exact:true}).click();
  await expect(page.locator('.book-sheet')).toHaveCount(1);
  await expect(page.locator('.book-thumb[aria-current="true"]')).toContainText('Page 3');
  await page.screenshot({animations:'disabled',path:test.info().outputPath('real-final-page.png')});
});
