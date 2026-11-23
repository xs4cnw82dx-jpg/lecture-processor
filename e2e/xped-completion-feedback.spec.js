const { test, expect } = require('@playwright/test');
const Model = require('../static/js/elearning-model');
const { editorFixture } = require('./helpers/xped-editor');

const text = value => Model.loc(value, value, value);
async function learner(page, blocks, settings = {}) {
  const course = Model.createExpeditionPreset('blank', 'Een dag onderweg', 'nl');
  Object.assign(course.startPage, settings);
  course.modules[0].steps[0].blocks = blocks;
  await page.route('https://**', route => route.abort());
  await page.route('**/api/elearning/public/feedback', route => route.fulfill({json: {expedition: course}}));
  await page.goto('/elearning/p/feedback?lang=nl');
  await page.locator('.xped-hero-cta-row button').click();
}

test('answer feedback shows the chosen outcome and the source closes without bouncing', async ({page}) => {
  const quiz = Model.createBlock('mcq');
  quiz.data.graded = true;
  quiz.data.options[0].isCorrect = true;
  quiz.data.explanation = text('De studie vergeleek twee groepen.');
  const source = Model.createBlock('sources');
  source.data.items = [{id:'research', citation:text('Onderzoek naar wandelen'), url:'https://example.org/study'}];
  const reflection = Model.createBlock('reflection');
  await learner(page, [quiz, reflection, source]);
  const choices = page.getByRole('radio');
  await choices.nth(1).click();
  await expect(page.locator('.xped-feedback-lead')).toHaveText('Toelichting');
  await expect(choices.first().locator('.xped-option-state')).toBeHidden();
  await expect(choices.first()).toContainText('Juist antwoord');
  const mark = await choices.nth(1).locator('.xped-option-state').innerHTML();
  await choices.first().click();
  await expect(choices.first().locator('.xped-option-state')).toBeVisible();
  expect(await choices.first().locator('.xped-option-state').innerHTML()).not.toBe(mark);
  const input = page.locator('.xped-block-reflection textarea');
  await input.focus();
  await expect(input).toHaveCSS('outline-offset','-2px');
  await expect(input).toHaveCSS('box-shadow','none');
  const disclosure = page.locator('.xped-sources-box');
  const toggle = disclosure.locator('summary');
  await toggle.press('Enter');
  await expect(disclosure.getByRole('link')).toBeVisible();
  await disclosure.evaluate(async el => { await Promise.allSettled(el.getAnimations({subtree:true}).map(a=>a.finished)); });
  const heights = await disclosure.evaluate(async el => {
    el.querySelector('summary').click();
    const start = performance.now();
    const samples = [];
    while (performance.now() - start < 600) {
      await new Promise(requestAnimationFrame);
      samples.push(el.getBoundingClientRect().height);
    }
    return samples;
  });
  expect(heights[0]).toBeGreaterThan(heights.at(-1));
  expect(heights.every((h,i) => i === 0 || h <= heights[i-1]+1)).toBe(true);
  await expect(disclosure.getByRole('link')).toBeHidden();
});

test('learners can copy a personal result and print only their completed work', async ({page, context}, info) => {
  await page.setViewportSize({width:390,height:844});
  const plan = Model.createBlock('mini_plan');
  plan.data.suggestions[0].label = text('Ik kies een uitje.');
  const skip = Model.createBlock('reflection');
  skip.settings.saveToSummary = false;
  const balance = Model.createBlock('balance_scale');
  await learner(page,[plan, skip, balance], {summaryTitle:text('Mee naar huis'), summaryPlanHeading:text('Mijn afspraak'), summaryClosing:text('Tot bij de muziektent.')});
  await page.getByRole('button',{name:'Ik kies een uitje.'}).click();
  await page.locator('.xped-block-reflection textarea').fill('Deze zin blijft buiten mijn resultaat.');
  await page.getByRole('button',{name:Model.ui('nl','finish')}).click();
  const card = page.locator('.xped-completion-card');
  await expect(card.getByRole('heading',{name:'Mijn afspraak'})).toBeVisible();
  await expect(card.getByRole('heading',{name:Model.ui('nl','myBalance')})).toHaveCount(0);
  await expect(card).not.toContainText('buiten mijn resultaat');
  await expect(card).not.toContainText('balans');
  await context.grantPermissions(['clipboard-read','clipboard-write']);
  await card.getByRole('button',{name:'Kopieer tekst'}).click();
  const result = await page.evaluate(()=>navigator.clipboard.readText());
  expect(result).toContain('Ik kies een uitje.');
  expect(result).toContain('Tot bij de muziektent.');
  expect(result).not.toContain('Kopieer tekst');
  await expect(card.locator('.xped-btn-sun')).toHaveText(Model.ui('nl','restart'));
  await card.screenshot({path:info.outputPath('personal-result-phone.png')});
  await page.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', {
    value: () => Promise.reject(new Error('Clipboard disabled')),
  }));
  await card.getByRole('button',{name:'Kopieer tekst'}).click();
  const manual = card.getByRole('textbox',{name:'Kopieer tekst'});
  await expect(manual).toBeFocused();
  await expect(manual).toHaveValue(result);
  await page.emulateMedia({media:'print'});
  await expect(card.getByRole('button')).toHaveCount(0);
  expect((await page.pdf({format:'A4',path:info.outputPath('personal-result.pdf')})).length).toBeGreaterThan(1000);
});

test('the chart, custom completion copy and same-tab editing position survive normal authoring', async ({page,context}) => {
  const fixture = await editorFixture(page);
  const sessions = [];
  page.on('request', r => { if(r.url().endsWith('/lease')) sessions.push(r.headers()['x-elearning-session']); });
  const first = fixture.exp.modules[0].steps[0];
  first.blocks = [];
  await page.goto('/physio/elearning/visual/edit');
  await page.getByText('Completion page',{exact:true}).click();
  await page.getByRole('textbox',{name:'Summary title (EN)'}).fill('What I take with me');
  await expect.poll(()=>fixture.writes.at(-1)?.body.startPage.summaryTitle.en).toBe('What I take with me');
  await page.locator('.el-step-row').first().click();
  await page.getByRole('button',{name:/Start building this step/}).click();
  await page.getByRole('searchbox',{name:'Search blocks'}).fill('Percentage');
  await page.locator('#el-picker-insert').click();
  const value = page.getByRole('spinbutton',{name:'Percentage (0–100)'});
  await value.fill('52');
  await expect(page.locator('#el-canvas-card progress')).toHaveAttribute('value','52');
  await page.getByRole('textbox',{name:'Source citation'}).fill('Study group');
  await expect.poll(()=>fixture.writes.at(-1)?.body.modules[0].steps[0].blocks[0]?.data.citation?.en).toBe('Study group');
  Object.assign(fixture.exp, fixture.writes.at(-1).body);
  await page.reload();
  await expect(page.locator('#el-canvas-card progress')).toHaveAttribute('value','52');
  await expect(value).toHaveValue('52');
  expect(sessions.at(-1)).toBe(sessions[0]);
  const other = await context.newPage();
  await editorFixture(other);
  const lease = other.waitForRequest(req=>req.url().endsWith('/lease'));
  await other.goto('/physio/elearning/visual/edit');
  expect((await lease).headers()['x-elearning-session']).not.toBe(sessions[0]);
});


test('the balance export preserves the visual totals and the readable numbers on paper', async ({page}, info) => {
  const balance = Model.createBlock('balance_scale');
  await learner(page, [balance]);
  const slider = page.getByRole('slider').first();
  await slider.focus();
  await slider.press('End');
  await page.getByRole('button',{name:Model.ui('nl','finish')}).click();
  const card = page.locator('.xped-completion-card');
  await expect(card.getByRole('heading',{name:Model.ui('nl','myBalance')})).toBeVisible();
  await expect(card.getByRole('progressbar')).toHaveCount(2);
  await page.emulateMedia({media:'print'});
  await expect(card.getByRole('progressbar').first()).toBeVisible();
  await page.pdf({format:'A4', printBackground:true, path:info.outputPath('visual-balance.pdf')});
});

test('an author can enlarge an SVG at phone width and return to the same editor', async ({page},info) => {
  const fixture = await editorFixture(page);
  const figure = Model.createBlock('custom_visual');
  Object.assign(figure.data,{ preset:'custom-svg', alt:text('Two paths on a map'),
    svgMarkup:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 360 130"><path d="M10 90 Q80 14 160 60 T350 50" fill="none" stroke="#3279a8" stroke-width="5"/></svg>' });
  fixture.exp.modules[0].steps[0].blocks=[figure];
  await page.goto('/physio/elearning/visual/edit');
  await page.locator('.el-step-row').first().click();
  await page.locator('#el-canvas-card [data-block-id]').first().click({position:{x:4,y:4}});
  await page.locator('.el-svg-phone-preview summary').click();
  const zoom = page.getByRole('button',{name:'Enlarge phone preview'});
  await zoom.click();
  const art = page.getByRole('dialog').getByRole('img',{name:'Two paths on a map'});
  await expect(art).toBeVisible();
  expect(await art.evaluate(async img=>{await img.decode();return img.clientWidth;})).toBeGreaterThan(330);
  await page.getByRole('dialog').screenshot({path:info.outputPath('enlarged-phone-map.png')});
  await page.keyboard.press('Escape');
  await expect(zoom).toBeFocused();
});
