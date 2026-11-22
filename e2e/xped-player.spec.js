const { test, expect } = require('@playwright/test');
const Model = require('../static/js/elearning-model.js');

const coursePath = '/elearning/p/synthetic-route';
const apiPath = '**/api/elearning/public/synthetic-route';

async function openCourse(page, course = Model.createExpeditionPreset('showcase', 'Op weg met pijn'), query = '?lang=nl') {
  await page.route(apiPath, route => route.fulfill({ json: { expedition: course } }));
  await page.route(apiPath + '/responses', route => route.fulfill({ json: { ok: true } }));
  await page.goto(coursePath + query);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Op weg met pijn');
}

test('phone route fits below the course introduction and reading controls work with a keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openCourse(page);
  await expect(page.locator('.xped-journey-card').first()).toBeInViewport();
  await page.locator('.xped-hero-cta-row button').click();
  await expect(page.getByRole('main')).toBeFocused();
  const title = page.getByRole('heading', { level: 1 });
  const getSize = () => title.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  const defaultSize = await getSize();
  const comfort = page.getByRole('button', { name: 'Leescomfort' });
  await comfort.click();
  await page.getByRole('button', { name: 'Grotere tekst' }).click();
  expect(await getSize()).toBeGreaterThan(defaultSize);
  await page.keyboard.press('Escape');
  await expect(comfort).toBeFocused();
  await expect(comfort).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Route', exact: true }).click();
  const heading = await title.innerText();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(title).toHaveText(heading);
  await page.getByRole('dialog').getByRole('button', { name: /Jouw balans/ }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(title).toHaveText('Draagkracht & draaglast');
  await expect(page.getByRole('main')).toBeFocused();
  await page.reload();
  await page.getByRole('button', { name: 'Verder met je xPEDitie' }).click();
  await expect(title).toHaveText('Draagkracht & draaglast');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});

test('a reader can enter a course when browser storage is unavailable', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'localStorage', {
    get() { throw new DOMException('Storage is unavailable', 'SecurityError'); },
  }));
  const course = Model.createExpeditionPreset('showcase', 'Op weg met pijn');
  course.enabledLanguages = ['nl'];
  await openCourse(page, course, '');
  await page.getByRole('button', { name: 'Start de xPEDitie' }).click();
  await expect(page.getByRole('button', { name: 'Fabel', exact: true })).toBeVisible();
});

test('custom artwork renders as an image and feedback stays editable after an interrupted submission', async ({ page }) => {
  const course = Model.createExpeditionPreset('blank', 'Op weg met pijn');
  course.shareOptions = { collectPilotFeedback: true };
  const visual = Model.createBlock('custom_visual');
  visual.data.preset = 'custom-svg';
  visual.data.svgMarkup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle r="9" cx="10" cy="10"/></svg>';
  visual.data.alt = { nl: 'Een cirkel' };
  course.modules[0].steps[0].blocks = [visual];
  await openCourse(page, course);
  await page.getByRole('button', { name: 'Start de xPEDitie' }).click();
  const image = page.getByRole('img', { name: 'Een cirkel' });
  await expect(image).toBeVisible();
  expect(await image.evaluate(img => img.decode().then(() => img.naturalWidth > 0))).toBe(true);
  await page.getByRole('button', { name: 'Afronden & samenvatting' }).click();
  const submit = page.getByRole('button', { name: 'Verstuur feedback' });
  const comment = page.getByRole('textbox', { name: 'Wat viel op of kan nog beter?' });
  await comment.fill('Heldere uitleg.');
  await page.route(apiPath + '/responses', route => route.fulfill({ status: 503, json: {} }));
  await submit.click();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(comment).toHaveValue('Heldere uitleg.');
  await page.route(apiPath + '/responses', route => route.fulfill({ json: { ok: true } }));
  await submit.click();
  await expect(page.getByText(Model.ui('nl', 'pilotThanks'))).toBeVisible();
});

test('course sharing preferences control the learner notice and review comments', async ({ page }) => {
  const course = Model.createExpeditionPreset('blank', 'Op weg met pijn');
  const cloud = Model.createBlock('wordcloud');
  cloud.settings.showPeerResults = true;
  const draft = Model.createBlock('custom_visual');
  draft.data.agentBrief = { nl: 'Voor het ontwerpteam' };
  course.modules[0].steps[0].blocks = [cloud, draft];
  course.shareOptions = { allowStepComments: false, showPeerResults: false };
  await openCourse(page, course, '?lang=nl&review=1');
  await expect(page.getByText(Model.ui('nl', 'authorAccess'), { exact: false })).toBeVisible();
  await expect(page.getByText(Model.ui('nl', 'sharedWords'), { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start de xPEDitie' }).click();
  await expect(page.getByRole('button', { name: 'Opmerking bij deze stap' })).toHaveCount(0);
  await expect(page.getByText('Voor het ontwerpteam')).toHaveCount(0);

  course.shareOptions = { allowStepComments: true, showPeerResults: true };
  await openCourse(page, course);
  await expect(page.getByText(Model.ui('nl', 'sharedWords'), { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Verder met je xPEDitie' }).click();
  await page.getByRole('button', { name: 'Opmerking bij deze stap' }).click();
  const note = page.getByRole('textbox', { name: Model.ui('nl', 'stepCommentTitle') });
  await note.fill('De kop is duidelijk.');
  await page.route(apiPath + '/responses', route => route.fulfill({ status: 503, json: {} }));
  const save = page.getByRole('button', { name: Model.ui('nl', 'stepCommentSend') });
  await save.click();
  await expect(page.getByText(Model.ui('nl', 'feedbackFailed'))).toBeVisible();
  await expect(note).toHaveValue('De kop is duidelijk.');
  await page.route(apiPath + '/responses', route => route.fulfill({ json: { ok: true } }));
  await save.click();
  await expect(page.getByText(Model.ui('nl', 'stepCommentSent'))).toBeVisible();
});

test('a hotspot and its keyboard button select the same point', async ({ page }) => {
  const course = Model.createExpeditionPreset('blank', 'Op weg met pijn');
  const block = Model.createBlock('hotspot');
  block.data.pins[0].x = 0;
  course.modules[0].steps[0].blocks = [block];
  await openCourse(page, course);
  await page.getByRole('button', { name: 'Start de xPEDitie' }).click();
  const stage = page.locator('.xped-hotspot-stage');
  const pins = stage.locator('circle');
  await expect(pins).toHaveCount(2);
  const offset = await stage.evaluate(el => {
    const pin = el.querySelector('circle').getBoundingClientRect();
    return pin.x + pin.width / 2 - el.getBoundingClientRect().x;
  });
  expect(Math.abs(offset)).toBeLessThan(2);
  await pins.nth(1).click();
  await expect(page.getByRole('button', { name: '2. Punt 2' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: '1. Punt 1' }).press('Enter');
  await expect(stage.locator('.xped-hotspot-pin').first()).toHaveClass(/is-active/);
});

test('a temporarily unavailable link can recover without losing the chosen language', async ({ page }) => {
  await page.route(apiPath, route => route.fulfill({ status: 503, json: {} }));
  await page.goto(coursePath + '?lang=de');
  const retry = page.getByRole('button', { name: Model.ui('de', 'retry') });
  await expect(retry).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'de');
  await expect(page.getByText(Model.ui('de', 'notFound'))).toHaveCount(0);
  const course = Model.createExpeditionPreset('blank', 'Op weg met pijn');
  await page.route(apiPath, route => route.fulfill({ json: { expedition: course } }));
  await retry.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Op weg met pijn');
});
