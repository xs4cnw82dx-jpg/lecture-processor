const { test, expect } = require('@playwright/test');
const Model = require('../static/js/elearning-model.js');

async function enter(page, blocks, configure = () => {}) {
  const course = Model.createExpeditionPreset('blank', 'Private fixture', 'en');
  course.enabledLanguages = ['en', 'nl', 'de'];
  const step = course.modules[0].steps[0];
  step.blocks = blocks;
  configure(course, step);
  await page.route('https://**', route => route.abort());
  await page.route('**/api/elearning/public/inspection', route => route.fulfill({ json: { expedition: course } }));
  await page.route('**/api/elearning/public/inspection/responses', route => route.fulfill({ json: { ok: true } }));
  await page.goto('/elearning/p/inspection?lang=en');
  await page.locator('.xped-hero-cta-row button').click();
}
function make(type, data = {}, settings = {}) {
  const block = Model.createBlock(type);
  Object.assign(block.data, data);
  Object.assign(block.settings, settings);
  return block;
}
const local = text => Model.loc(text, text, text);

test('unfinished media and pins stay out of the learner course and a selected point survives navigation', async ({ page }) => {
  const pins = make('hotspot');
  pins.data.pins[1].detail = local('Position yourself comfortably.');
  await enter(page, [make('video'), make('audio'), make('audio', {transcript:local('Read the exercise without audio.')}), pins], (_, step) => {
    step.title = local('Explore');
  });
  await expect(page.locator('.el-dropzone, .xped-block-video')).toHaveCount(0);
  await expect(page.locator('.xped-block-audio')).toHaveCount(1);
  await page.locator('.xped-block-audio summary').press('Enter');
  await expect(page.getByText('Read the exercise without audio.')).toBeVisible();
  await expect(page.locator('.xped-pin-chip-dot')).toHaveCount(1);
  await expect(page.getByText('Position yourself comfortably.')).toBeHidden();
  await page.locator('.xped-hotspot-fallback button').press('Enter');
  await expect(page.getByText('Position yourself comfortably.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: Model.ui('en', 'back'), exact: true }).click();
  await page.locator('.xped-hero-cta-row button').click();
  await expect(page.locator('.xped-hotspot-fallback button')).toHaveAttribute('aria-pressed', 'true');
});

test('checked sets grade independently of order and clearing a saved answer locks its explanation again', async ({ page }) => {
  const q = make('mcq', { graded: true, checkMode: 'submit' }, { allowMultiple: true });
  q.data.options.push({ ...q.data.options[0], id: 'third', label: local('Third'), isCorrect: true });
  q.data.options[0].isCorrect = true;
  const note = make('callout', { title: local('Answer discussion') }, { revealAfterAnswer: true });
  await enter(page, [q, note]);
  const choices = page.getByRole('checkbox');
  const submit = page.getByRole('button', { name: Model.ui('en', 'checkAnswers') });
  const noteTitle = page.getByRole('heading', { name: 'Answer discussion' });
  await choices.nth(1).click();
  await choices.first().click();
  await expect(page.locator('.xped-feedback-lead')).toHaveCount(0);
  await submit.click();
  await expect(page.locator('.xped-feedback-lead')).toHaveText(Model.ui('en', 'partialCorrect'));
  await expect(noteTitle).toBeVisible();
  await choices.first().click();
  await choices.nth(1).click();
  await choices.first().click();
  await choices.nth(1).click();
  await submit.click();
  await expect(page.locator('.xped-feedback-lead')).toHaveText(Model.ui('en', 'partialCorrect'));
  await choices.nth(1).click();
  await choices.nth(2).click();
  await submit.click();
  await expect(page.locator('.xped-feedback-lead')).toHaveText(Model.ui('en', 'allCorrect'));
  await page.getByRole('button', { name: Model.ui('en', 'back'), exact: true }).click();
  await page.locator('.xped-hero-cta-row button').click();
  await choices.first().click();
  await choices.nth(2).click();
  await expect(noteTitle).toBeHidden();
  await page.getByRole('button', { name: Model.ui('en', 'back'), exact: true }).click();
  await page.locator('.xped-hero-cta-row button').click();
  await expect(noteTitle).toBeHidden();
  await expect(choices.first()).toHaveAttribute('aria-checked', 'false');
});

test('scale, word limit, ranking and mini plan keep keyboard actions and draft text', async ({ page }) => {
  const scale = make('scale', { question: local('How confident?') });
  const cloud = make('wordcloud', { question: local('Name a word') });
  const ranking = make('ranking');
  const plan = make('mini_plan');
  await enter(page, [scale, make('scale', {question: local('How ready?')}), cloud, ranking, plan]);
  const slider = page.getByRole('slider', { name: 'How confident?' });
  await expect(slider).toHaveAttribute('aria-valuetext', Model.ui('en', 'notChosenYet'));
  await page.getByRole('button', { name: Model.ui('en', 'chooseMidpoint', { n: 5 }) }).first().click();
  await expect(slider).toHaveAttribute('aria-valuetext', '5');
  await expect(page.getByRole('slider', { name: 'How ready?' })).toHaveAttribute('aria-valuetext', Model.ui('en', 'notChosenYet'));
  const words = page.getByRole('textbox', { name: 'Name a word' });
  for (const word of ['one','two','three','four']) { await words.fill(word); await words.press('Enter'); }
  await expect(words).toHaveValue('four');
  await page.locator('.xped-block-wordcloud').getByRole('button', { name: Model.ui('en', 'addWordBtn'), exact: true }).click();
  await expect(page.getByText(Model.ui('en', 'wordsLimitReached', { max:3 }))).toBeVisible();
  await page.getByRole('button', { name: Model.ui('en', 'removeWord', {word:'two'}) }).press('Enter');
  await expect(page.getByRole('button', { name: Model.ui('en', 'removeWord', {word:'three'}) })).toBeFocused();
  await words.press('Enter');
  const up = page.getByRole('button', { name: Model.ui('en', 'up') + ' - Item 3' });
  await up.press('Enter');
  await expect(up).toBeFocused();
  await up.press('Enter');
  await expect(page.locator('.xped-rank-item').first()).toContainText('Item 3');
  const presets = page.locator('.xped-plan-chips button');
  for (let i=0;i<3;i++) await presets.nth(i).click();
  const custom = page.getByRole('textbox', {name:Model.ui('en', 'customGoalPlaceholder')});
  await custom.fill('Explore tomorrow');
  await custom.press('Enter');
  await expect(custom).toHaveValue('Explore tomorrow');
  await presets.nth(1).click();
  await custom.press('Enter');
  await expect(page.getByRole('button', {name:'Explore tomorrow'})).toHaveAttribute('aria-pressed','true');
});

test('Back retraces a branch across a station boundary including a resumed session', async ({ page }) => {
  const question = make('scale', {question: local('Confidence')});
  await enter(page, [question], (course, first) => {
    first.title = local('First');
    const step = n => ({ ...first, id: 'step-'+n, title: local('Step '+n), blocks: [], branching: [] });
    course.modules[0].steps.push(step(2), step(3), step(4));
    first.branching = [{blockId:question.id, operator:'lte', value:'5', targetStepId:'step-4'}];
    course.modules.push({...course.modules[0], id:'station-b', steps:[step(5)]});
  });
  await page.getByRole('button', {name:Model.ui('en', 'chooseMidpoint', {n:5})}).click();
  const next = page.getByRole('button', { name: Model.ui('en', 'next'), exact: true });
  const back = page.getByRole('button', { name: Model.ui('en', 'back'), exact: true });
  await next.click();
  await expect(page.locator('h1')).toHaveText('Step 4');
  await back.click();
  await expect(page.locator('h1')).toHaveText('First');
  await expect(page.locator('.xped-card')).toHaveClass(/anim-prev/);
  await next.click();
  await next.click();
  await page.getByRole('button', {name:Model.ui('en','milestoneNext')}).click();
  await expect(page.locator('h1')).toHaveText('Step 5');
  await page.reload();
  await page.locator('.xped-hero-cta-row button').click();
  await back.click();
  await expect(page.locator('h1')).toHaveText('Step 4');
  await back.click();
  await expect(page.locator('h1')).toHaveText('First');
});

const { editorFixture } = require('./helpers/xped-editor');
async function author(page, blocks) {
  const fixture = await editorFixture(page);
  fixture.exp.modules[0].steps[0].blocks = blocks;
  fixture.exp.modules[0].steps[0].title = local('Explore the evidence');
  await page.goto('/physio/elearning/visual/edit');
  await page.locator('.el-step-row').first().click();
  return fixture;
}
function inCanvas(page, block) { return page.locator('#el-canvas-card [data-block-id="' + block.id + '"]'); }
async function inspect(page, block) {
  const canvas = inCanvas(page, block);
  await canvas.click({ position: {x: 4, y: 4} });
}
async function select(page, label, option) {
  await page.getByRole('button', {name:label, exact:true}).click();
  // Editor fields are listboxes of options; the learner's language menu stays a menu.
  await page.getByRole('option', {name:option}).or(page.getByRole('menuitem', {name:option})).click();
}
test('format selected words, three lines and a DOI in place and inspect learner typography', async ({ page }) => {
  const rich = make('richtext', {body:local('one two three')});
  const fixture = await author(page, [rich]);
  const area = page.getByRole('textbox', {name:'Paragraph text'});
  const tool = name => page.getByRole('button', {name,exact:true});
  await area.evaluate(editor => {
    editor.focus();
    const word = document.createRange();
    word.setStart(editor.firstChild.firstChild, 4);
    word.setEnd(editor.firstChild.firstChild, 7);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(word);
  });
  await tool('Bold text').click();
  await expect(area.locator('strong,b')).toHaveText('two');
  await tool('Bold text').click();
  await expect(area.locator('strong,b')).toHaveCount(0);
  await tool('Insert link').click();
  await page.getByRole('textbox', {name:'Link URL'}).fill('10.3174/ajnr.A4173');
  await page.locator('.el-fmt-link-popover').getByRole('button', {name:'Insert link'}).click();
  await expect(area.getByRole('link',{name:'two'})).toHaveAttribute('href','https://doi.org/10.3174/ajnr.A4173');
  await expect.poll(() => fixture.writes.at(-1)?.body.modules[0].steps[0].blocks[0].data.body.en)
    .toBe('one [two](https://doi.org/10.3174/ajnr.A4173) three');
  await area.fill('Start'); await area.press('Enter'); await page.keyboard.type('Middle'); await area.press('Enter'); await page.keyboard.type('End');
  await area.press('ControlOrMeta+a');
  await tool('Bullet list (toggle selected lines)').click();
  await expect(area.locator('ul li')).toHaveText(['Start','Middle','End']);
  await area.press('ControlOrMeta+a');
  await tool('Numbered list (toggle selected lines)').click();
  await expect(area.locator('ol li')).toHaveCount(3);
  await area.fill('Findings'); await tool('Section heading').click();
  await expect(area.getByRole('heading',{level:2,name:'Findings'})).toBeVisible();
  await tool('Paragraph (clear heading/list)').click();
  await expect(area.getByText('Findings', { exact: true })).toHaveJSProperty('tagName', 'P');
  await area.press('ControlOrMeta+z');
  await expect(area.getByRole('heading',{level:2,name:'Findings'})).toBeVisible();
});
test('edit video trim as a pair, then explicitly choose a different video timestamp', async ({page}) => {
  const video = make('video', {url:'https://youtu.be/dQw4w9WgXcQ?t=90',videoId:'dQw4w9WgXcQ',provider:'youtube',embedUrl:'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',startSeconds:90,endSeconds:120});
  const fixture=await author(page,[video]); await inspect(page,video);
  const start=page.getByRole('textbox',{name:/Start Time/}); const end=page.getByRole('textbox',{name:/End Time/});
  await start.fill('1:15'); await end.fill('0:45');
  await expect(page.getByText(/End time .* must be after Start time/)).toBeVisible();
  await expect.poll(()=>fixture.writes.at(-1)?.body.modules[0].steps[0].blocks[0].data.endSeconds).toBe(120);
  const url=page.getByRole('textbox',{name:'YouTube or Vimeo URL'});
  await url.fill('https://youtu.be/abcdefghijk?t=15'); await url.press('Tab');
  await page.getByRole('button',{name:/Use link time/}).click();
  await expect(start).toHaveValue(/15/); await expect(end).toHaveValue('');
  await expect.poll(()=>fixture.writes.at(-1)?.body.modules[0].steps[0].blocks[0].data.startSeconds).toBe(15);
});
test('figure text, crop, zero focal point, official descriptions, removal and undo', async ({page})=>{
  const figure=make('image',{layout:'split-left',sideBody:local('A paragraph worth retaining.'),media:{kind:'xped',staticPath:Model.XPED_ASSETS[0].path}});
  await author(page,[figure]); await inspect(page,figure);
  await select(page,'Layout','Full Width');
  await expect(inCanvas(page,figure)).toContainText('A paragraph worth retaining.');
  const keep=page.getByRole('checkbox',{name:'Show the saved side text below this image'});
  await keep.uncheck(); await expect(inCanvas(page,figure)).not.toContainText('A paragraph worth retaining.');
  await keep.check();
  await page.getByRole('checkbox',{name:'Crop to a landscape frame'}).check();
  const focal=page.getByRole('spinbutton',{name:'Horizontal %'});
  await focal.fill('0'); await focal.press('Tab');
  await expect(inCanvas(page,figure).locator('img')).toHaveCSS('object-position','0% 50%');
  await page.locator('.el-asset-library summary').click();
  await page.getByRole('button',{name:Model.XPED_ASSETS[1].label, exact:true}).click();
  await expect(inCanvas(page,figure).locator('img')).toHaveAttribute('alt',Model.XPED_ASSETS[1].alt.en);
  await page.getByRole('button',{name:'Remove image',exact:true}).click();
  await expect(inCanvas(page,figure).locator('img')).toHaveCount(0);
  await page.locator('#el-undo-btn').click();
  await expect(inCanvas(page,figure).locator('img')).toHaveAttribute('alt',Model.XPED_ASSETS[1].alt.en);
});
test('source disclosure stays readable at phone width and inline reference changes keep identity', async ({page})=>{
  const citation='Brinjikji W, Luetmer PH, Comstock B, et al. Systematic literature review of imaging features of spinal degeneration in asymptomatic populations. AJNR Am J Neuroradiol. 2015;36:811–816.';
  const refs=make('sources',{title:local('Bron'),items:[1,2,3].map(i=>({id:'ref'+i,citation:local(i===2?citation:'Study '+i),url:'10.3174/ajnr.A417'+i}))});
  await author(page,[refs]); await inspect(page,refs);
  const source=inCanvas(page,refs);
  const summary=source.locator('summary');
  await summary.press('Enter');
  await expect(source.locator('details')).toHaveAttribute('open','');
  await source.locator('li .el-inline-edit').nth(1).fill(citation+' Follow-up.');
  const doi=page.getByRole('textbox',{name:/DOI or URL/}).nth(1);
  await doi.fill('10.3174/ajnr.A4173');
  await expect(source.locator('details')).toHaveAttribute('open','');
  await page.getByRole('button',{name:'Remove reference 2'}).click();
  await expect(source.locator('li')).toHaveCount(2);
  await page.locator('#el-undo-btn').click();
  await expect(source.locator('li')).toHaveCount(3);
  const field=page.getByRole('textbox',{name:'Citation (EN)',exact:true}).nth(1);
  await page.setViewportSize({width:390,height:844});
  await page.locator('.el-pane-btn[data-pane=inspector]').click();
  await expect(field).toHaveValue(citation+' Follow-up.');
  expect(await field.evaluate(el=>el.scrollWidth<=el.clientWidth+1 && el.scrollHeight<=el.clientHeight+2)).toBe(true);
});
test('an author can grade a new multi-select and use localized confidence anchors', async ({page})=>{
  const q=make('mcq');const scale=make('scale');const fixture=await author(page,[q,scale]); await inspect(page,q);
  await page.getByRole('checkbox',{name:'Allow multiple selections'}).check();
  await select(page,'Question Mode',/Knowledge Check/);
  await expect(page.getByRole('button',{name:'Feedback Timing'})).toContainText('Wait for');
  const correct=page.getByRole('checkbox',{name:'Mark as correct answer'}); await correct.first().check(); await correct.nth(1).check();
  await page.getByRole('textbox',{name:'Option-specific feedback (optional)'}).first().fill('This is one correct choice.');
  await inspect(page,scale); await select(page,'Quick Anchor Preset',/Confidence/);
  await expect.poll(()=>fixture.writes.at(-1)?.body.modules[0].steps[0].blocks[1].data.minLabel.de).toBe(Model.SCALE_ANCHOR_PRESETS.find(p=>p.id==='confidence').minLabel.de);
  await page.locator('[data-mode=preview]').click();
  const preview=page.locator('#el-preview-container');
  await expect(preview.getByRole('group', {name:'Explore the evidence', exact:true})).toBeVisible();
  await expect(preview.locator('.xped-block-mcq h3:empty')).toHaveCount(0);
  const check=preview.getByRole('button',{name:'Check answers'});
  const opts=preview.getByRole('checkbox');
  await opts.first().click(); await expect(preview.locator('.xped-feedback-lead')).toHaveCount(0); await check.click();
  await expect(preview.locator('.xped-feedback-lead')).toHaveText(Model.ui('en','partialCorrect'));
  await opts.nth(1).click(); await check.click();
  await expect(preview.locator('.xped-feedback-lead')).toHaveText(Model.ui('en','allCorrect'));
});

test('keyboard upload and retry feedback stay with the selected figure', async ({page}) => {
  const figure=make('image'); const other=make('richtext');
  await author(page,[figure,other]); await inspect(page,figure);
  const upload=page.getByRole('button',{name:/^Upload custom photo/});
  const choose=async(key) => {
    const event=page.waitForEvent('filechooser'); await upload.press(key);
    return event;
  };
  await choose('Enter');
  let rejectUpload;
  await page.route('**/api/elearning/expeditions/visual/assets', async r => {
    await new Promise(resolve=>{rejectUpload=resolve;});
    await r.fulfill({status:503,json:{error:'Try the photo again'}});
  });
  const file=await choose('Space');
  await file.setFiles({name:'stairs.png',mimeType:'image/png',buffer:Buffer.from('synthetic image')});
  await expect(page.locator('.el-upload-status')).toContainText('Uploading stairs.png');
  await inspect(page,other); await expect(page.locator('.el-upload-status')).toHaveCount(0);
  await inspect(page,figure); await expect(page.locator('.el-upload-status')).toContainText('Uploading stairs.png');
  rejectUpload();
  await expect(page.locator('.el-upload-status')).toContainText('Try the photo again');
  await expect(page.locator('.el-upload-status').getByRole('button',{name:'Retry'})).toBeVisible();
});
test('a selected mobile pin retains its identity through coordinate, color, ordering and undo', async ({page}) => {
  const hotspot=make('hotspot');const pin=hotspot.data.pins[1];pin.detail=local('Finished explanation');
  const fixture=await author(page,[hotspot]);
  const chip=inCanvas(page,hotspot).locator('[data-pin-id="'+pin.id+'"]');
  await chip.click(); await chip.press('ArrowRight'); await expect(chip).toBeFocused();
  await page.setViewportSize({width:390,height:844});
  await page.locator('.el-pane-btn[data-pane=inspector]').click();
  const card=page.locator('.el-insp-card[data-pin-id="'+pin.id+'"]');
  await expect(page.locator('.xped-inspector-pin')).toContainText('Explore the evidence');
  await expect(page.locator('.xped-inspector-pin text')).toHaveText('2');
  await expect(card.getByRole('spinbutton',{name:'X %'})).toHaveValue('66');
  await card.getByRole('button',{name:/color: Warm Amber/}).click();
  await card.getByTitle('Move pin earlier').click();
  await expect(page.locator('.xped-inspector-pin text')).toHaveText('1');
  await expect(page.locator('.xped-inspector-pin circle')).toHaveAttribute('fill','#C98A00');
  await expect(page.locator('.xped-inspector-pin text')).toHaveAttribute('fill','#000000');
  await card.getByRole('button',{name:'Remove',exact:true}).click();
  await page.locator('#el-toast').getByRole('button',{name:'Undo'}).click();
  await expect.poll(()=>fixture.writes.at(-1)?.body.modules[0].steps[0].blocks[0].data.pins[0].id).toBe(pin.id);
  await page.setViewportSize({width:768,height:880});
  await page.locator('.el-pane-btn[data-pane=canvas]').click();
  await expect(inCanvas(page,hotspot).locator('.xped-hotspot-pin').first()).toHaveAttribute('x','66%');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(768);
});
test('switching languages preserves a selected plan and a refused clipboard write still gives the full brief', async ({page})=>{
  const plan=make('mini_plan');plan.data.suggestions[0].label=Model.loc('Even wandelen','A short walk','Kurz spazieren');
  await enter(page,[plan]);
  await select(page,'Language','Nederlands');
  await page.getByRole('button',{name:'Even wandelen',exact:true}).click();
  await select(page,Model.ui('nl','language'),'Deutsch');
  await expect(page.getByRole('button',{name:'Kurz spazieren',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.xped-plan-chip[aria-pressed=true]')).toHaveCount(1);
  const custom=make('custom_visual',{agentBrief:'Animate the breathing rhythm'});
  await page.addInitScript(()=>Object.defineProperty(navigator,'clipboard',{value:{writeText:async()=>{throw new DOMException('Denied','NotAllowedError');}}}));
  await author(page,[custom]);
  await inCanvas(page,custom).getByRole('button',{name:'Copy Agent Brief'}).click();
  const fallback=page.getByRole('textbox',{name:'Agent brief text to copy'});
  await expect(fallback).toBeFocused();
  expect(await fallback.inputValue()).toContain('Animate the breathing rhythm');
  expect(await fallback.evaluate(el=>el.selectionEnd-el.selectionStart)).toBe((await fallback.inputValue()).length);
});

test('station, balance factors and semantic question styles are editable on the canvas and survive save', async ({ page }) => {
  const belief = make('myth_fact', {statement: local('An idea worth exploring')});
  const balance = make('balance_scale');
  const fixture = await author(page, [belief, balance]);
  const saved = () => fixture.writes.at(-1)?.body.modules[0];
  const title = page.getByRole('textbox', {name:'Station name', exact:true});
  await title.fill('At the kitchen table');
  await expect.poll(() => saved()?.title.en).toBe('At the kitchen table');
  const statement = inCanvas(page, belief).getByText('An idea worth exploring');
  await statement.focus();
  await page.getByRole('button', {name:'Heading 2',exact:true}).click();
  await expect(inCanvas(page, belief).getByRole('heading', {level:2,name:'An idea worth exploring'})).toBeFocused();
  await expect.poll(() => saved()?.steps[0].blocks[0].settings.textStyles?.statement).toBe('h2');
  const factor = inCanvas(page, balance).locator('.xped-balance-factor .el-inline-edit').first();
  await factor.fill('A night of interrupted sleep');
  await expect.poll(() => saved()?.steps[0].blocks[1].data.factors[0].label.en).toBe('A night of interrupted sleep');
  await page.locator('#el-undo-btn').click();
  await expect(factor).not.toHaveText('A night of interrupted sleep');
  const column = inCanvas(page, balance).locator('.xped-balance-col-head').first();
  await column.fill('What takes energy');
  await expect.poll(() => saved()?.steps[0].blocks[1].data.loadLabel.en).toBe('What takes energy');
  await page.locator('#el-notes-drawer summary').click();
  await expect(page.getByLabel('Editors and translators can read these notes.')).toBeVisible();
});

test('frame a real story illustration, reset framing and inspect it on a narrow screen', async ({ page }) => {
  const art = Model.XPED_ASSETS.find(asset => asset.id === 'esther');
  const story = make('story', {media:{kind:'xped',staticPath:art.path},speakerName:'Esther',
    quote: local('My daughter and I are playing on the rug.'),
    speakerRole: local('Mother of a preschooler')});
  const fixture = await author(page, [story]);
  await inspect(page, story);
  const zoom = page.getByRole('slider',{name:'Zoom',exact:true});
  const horizontal = page.getByRole('slider',{name:'Horizontal position'});
  await zoom.focus(); await zoom.press('End');
  await horizontal.focus(); await horizontal.press('Home');
  const image = inCanvas(page, story).locator('.xped-story-avatar img');
  await expect(image).toHaveCSS('object-fit','contain');
  await expect.poll(() => image.evaluate(node => new DOMMatrix(getComputedStyle(node).transform).a)).toBe(2.5);
  await expect.poll(() => fixture.writes.at(-1)?.body.modules[0].steps[0].blocks[0].data.portraitX).toBe(-75);
  await page.getByRole('button',{name:'Reset framing'}).click();
  await expect.poll(() => image.evaluate(node => new DOMMatrix(getComputedStyle(node).transform).a)).toBe(1);
  await page.locator('.el-asset-library summary').click();
  await expect(page.getByRole('button',{name:art.label,exact:true})).toHaveAccessibleDescription(art.alt.en);
  if (process.env.XPED_AUTHORING_EVIDENCE) {
    await page.screenshot({path:process.env.XPED_AUTHORING_EVIDENCE+'/scene-desktop.png',animations:'disabled'});
  }
  await page.setViewportSize({width:390,height:844});
  await page.locator('.el-pane-btn[data-pane=inspector]').click();
  const choice = page.getByRole('button',{name:art.label,exact:true});
  await choice.scrollIntoViewIfNeeded();
  await expect(choice).toBeInViewport();
  expect(await choice.locator('img').evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(64);
  if (process.env.XPED_AUTHORING_EVIDENCE) {
    await page.screenshot({path:process.env.XPED_AUTHORING_EVIDENCE+'/scene-phone.png',animations:'disabled'});
  }
});

test('the mini-plan picker lets an author leave custom steps out before insertion', async ({page}) => {
  const fixture = await author(page, []);
  await page.getByRole('button', {name:/Start building this step/}).click();
  await page.getByRole('searchbox',{name:'Search blocks'}).fill('mini-plan');
  const opt = page.getByRole('checkbox',{name:'Allow learners to add their own steps'});
  await expect(opt).toBeChecked();
  await opt.uncheck();
  await page.locator('#el-picker-insert').click();
  await expect.poll(() => fixture.writes.at(-1)?.body.modules[0].steps[0].blocks[0].data.allowCustom).toBe(false);
  const custom = page.locator('#el-canvas-card').getByRole('textbox',{name:Model.ui('en','customGoalPlaceholder')});
  await expect(custom).toHaveCount(0);
  await page.getByRole('checkbox',{name:'Allow learner custom step'}).check();
  await expect(custom).toBeVisible();
});

test('literal Markdown and formatted DOI labels survive editing, saving and learner rendering', async ({page}) => {
  const doi = 'https://doi.org/10.1000/study(2024)';
  const handout = 'https://example.org/handouts/session one.pdf';
  const rich = make('richtext', {body:local('[**Study** results](' + doi + '). [Handout](' + handout + ').')});
  const fixture = await author(page, [rich]);
  const area = page.getByRole('textbox', {name:'Paragraph text'});
  await expect(area.getByRole('link', {name:'Handout'})).toHaveAttribute('href', new URL(handout).href);
  const link = area.getByRole('link', {name:'Study results'});
  await expect(link).toHaveAttribute('href', doi);
  await expect(link.locator('strong')).toHaveText('Study');
  await area.evaluate(editor => {
    editor.focus();
    window.getSelection().collapse(editor.lastChild, editor.lastChild.childNodes.length);
  });
  const lines = ['- item', '1. first', '2) second', '## literal heading', '**literal** and [label](https://example.org)'];
  for (const line of lines) {
    await area.press('Enter');
    await page.keyboard.insertText(line);
  }
  await expect.poll(() => fixture.writes.at(-1)?.body.modules[0].steps[0].blocks[0].data.body.en).toContain('https://example.org');
  const savedBlock = fixture.writes.at(-1).body.modules[0].steps[0].blocks[0];
  await enter(page, [savedBlock]);
  const body = page.locator('.xped-richtext-body');
  await expect(body.locator('p')).toHaveText(['Study results. Handout.', ...lines]);
  await expect(body.getByRole('link')).toHaveCount(2);
  await expect(body.getByRole('link', {name:'Study results'})).toHaveAttribute('href', doi);
  await expect(body.getByRole('link', {name:'Handout'})).toHaveAttribute('href', new URL(handout).href);
  await expect(body.locator('a strong')).toHaveText('Study');
});

test('Dutch canvas text styles announce the paragraph option in Dutch', async ({page}) => {
  const belief = make('myth_fact', {statement:local('A statement')});
  await author(page, [belief]);
  await page.evaluate(() => window.LectureI18n.setLanguage('nl'));
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl');
  await inCanvas(page, belief).getByText('A statement').focus();
  await expect(page.getByRole('group', {name:'Tekststijl'}).getByRole('button',{name:'Alinea'})).toBeVisible();
});
