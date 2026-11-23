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

async function chooseSharing(page, choice = 'share', lang = 'nl') {
  await page.getByRole('radio', { name: new RegExp(Model.ui(lang, choice === 'share' ? 'consentShare' : 'consentPrivate')) }).check();
  await page.getByRole('button', { name: Model.ui(lang, 'next'), exact: true }).click();
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
  course.shareOptions = { collectResponses: true, collectionVersion: 'one', collectPilotFeedback: true };
  const visual = Model.createBlock('custom_visual');
  visual.data.preset = 'custom-svg';
  visual.data.svgMarkup = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><circle r="9" cx="10" cy="10"/></svg>';
  visual.data.alt = { nl: 'Een cirkel' };
  course.modules[0].steps[0].blocks = [visual];
  await openCourse(page, course);
  await page.getByRole('button', { name: 'Start de xPEDitie' }).click();
  await chooseSharing(page);
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
  await expect(page.getByText(Model.ui('nl', 'authorAccess'), { exact: false })).toHaveCount(0);
  await expect(page.getByText(Model.ui('nl', 'sharedWords'), { exact: false })).toHaveCount(0);
  await page.getByRole('button', { name: 'Start de xPEDitie' }).click();
  await expect(page.getByRole('button', { name: 'Opmerking bij deze stap' })).toHaveCount(0);
  await expect(page.getByText('Voor het ontwerpteam')).toHaveCount(0);

  course.shareOptions = { collectResponses: true, collectionVersion: 'two', allowStepComments: true, showPeerResults: true };
  await openCourse(page, course);
  await page.getByRole('button', { name: 'Verder met je xPEDitie' }).click();
  await page.getByText(Model.ui('nl', 'consentDetails')).click();
  await expect(page.getByText(Model.ui('nl', 'sharedWords'), { exact: false })).toBeVisible();
  await chooseSharing(page);
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
  block.data.pins.forEach(pin => { pin.detail = { nl: 'Meer informatie over dit punt.' }; });
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

test('resuming a course preserves how each word cloud was disclosed when first answered', async ({ page }) => {
  const course = Model.createExpeditionPreset('blank', 'Op weg met pijn');
  course.shareOptions = { collectResponses: true, collectionVersion: 'one', showPeerResults: false };
  const earlier = Model.createBlock('wordcloud');
  const fresh = Model.createBlock('wordcloud');
  earlier.data.question.nl = 'Eerdere woorden';
  fresh.data.question.nl = 'Nieuwe woorden';
  course.modules[0].steps[0].blocks = [earlier, fresh];
  const submissions = [];
  page.on('request', request => {
    if (request.url().endsWith('/responses') && request.method() === 'POST') submissions.push(request.postDataJSON());
  });
  await openCourse(page, course);
  await page.getByRole('button', { name: 'Start de xPEDitie' }).click();
  await chooseSharing(page);
  const original = page.getByRole('textbox', { name: 'Eerdere woorden' });
  await original.fill('eerder');
  await original.press('Enter');
  await expect.poll(() => submissions.some(body => body.answers[earlier.id]?.includes('eerder'))).toBe(true);
  course.shareOptions.showPeerResults = true;
  course.shareOptions.collectionVersion = 'two';
  await openCourse(page, course);
  await page.getByRole('button', { name: 'Verder met je xPEDitie' }).click();
  await chooseSharing(page);
  await original.fill('later');
  await original.press('Enter');
  const later = page.getByRole('textbox', { name: 'Nieuwe woorden' });
  await later.fill('gedeeld');
  await later.press('Enter');
  await expect.poll(() => submissions.find(body => body.answers[fresh.id]?.includes('gedeeld'))?.peerDisclosureTypes)
    .toEqual({ [fresh.id]: 'wordcloud' });
  await expect(later).toHaveAccessibleDescription(Model.ui('nl', 'sharedWords'));
});

for (const [lang, oldNote, expected] of [
  ['nl', 'Alleen jij kunt dit zien; het verschijnt in je eigen samenvatting.', 'De makers van deze cursus kunnen je reflectie lezen.'],
  ['en', 'Only you see this; it is saved in your personal summary.', 'Course authors can read your reflection.'],
  ['de', 'Nur du kannst dies sehen.', 'Die Kursverantwortlichen können deine Reflexion lesen.'],
]) {
  test('an imported reflection identifies who can read it in ' + lang, async ({ page }) => {
    const course = Model.createExpeditionPreset('blank', 'Op weg met pijn');
    course.shareOptions = { collectResponses: true, collectionVersion: 'one' };
    const reflection = Model.createBlock('reflection');
    reflection.data.helperNote = { [lang]: oldNote };
    reflection.data.prompt = { [lang]: 'Reflection' };
    course.modules[0].steps[0].blocks = [reflection];
    await openCourse(page, course, '?lang=' + lang);
    await page.locator('.xped-hero-cta-row button').click();
    await chooseSharing(page, 'share', lang);
    await expect(page.getByText(oldNote)).toHaveCount(0);
    await expect(page.getByText(expected)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Reflection' })).toHaveAccessibleDescription(expected);
  });
}

test('a learner can decline at a station entrance and finish and resume privately', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const course = Model.createExpeditionPreset('blank', 'Op weg met pijn');
  course.shareOptions = { collectResponses: true, collectionVersion: 'pilot-one', collectPilotFeedback: true, allowStepComments: true };
  const reflection = Model.createBlock('reflection');
  reflection.data.prompt = { nl: 'Wat neem je mee?' };
  course.modules[0].steps[0].blocks = [reflection];
  const posts = [];
  page.on('request', req => { if (req.url().endsWith('/responses')) posts.push(req.postDataJSON()); });
  await openCourse(page, course);
  await page.locator('.xped-journey-card').first().click();
  await expect(page.getByRole('heading', { name: 'Maar eerst dit nog even…' })).toBeVisible();
  await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: Model.ui('nl', 'next'), exact: true })).toBeDisabled();
  await expect(page.getByRole('textbox', { name: 'Wat neem je mee?' })).toHaveCount(0);
  await testInfo.attach('pilot-choice-phone', { body: await page.screenshot(), contentType: 'image/png' });
  await chooseSharing(page, 'private');
  const field = page.getByRole('textbox', { name: 'Wat neem je mee?' });
  await expect(field).toHaveAccessibleDescription('');
  await field.fill('Privé antwoord');
  await expect(page.getByText(Model.ui('nl', 'reflectionAccess'))).toHaveCount(0);
  await expect(page.getByRole('button', { name: Model.ui('nl', 'stepCommentBtn') })).toHaveCount(0);
  await page.getByRole('button', { name: Model.ui('nl', 'finish') }).click();
  await expect(page.getByText(Model.ui('nl', 'pilotTitle'))).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Verder met je xPEDitie' }).click();
  await expect(field).toHaveValue('Privé antwoord');
  await page.waitForTimeout(450); // Retried or debounced progress would have reached the network by now.
  expect(posts).toEqual([]);
});

test('private work stays on the device after switching to sharing', async ({ page }) => {
  const course = Model.createExpeditionPreset('blank', 'Op weg met pijn');
  course.shareOptions = { collectResponses: true, collectionVersion: 'current' };
  const earlier = Model.createBlock('reflection');
  const later = Model.createBlock('reflection');
  earlier.data.prompt = { nl: 'Eerste gedachte' };
  later.data.prompt = { nl: 'Volgende gedachte' };
  course.modules[0].steps[0].blocks = [earlier, later];
  const posts = [];
  page.on('request', req => { if (req.url().endsWith('/responses')) posts.push(req.postDataJSON()); });
  await openCourse(page, course);
  await page.locator('.xped-hero-cta-row button').click();
  await chooseSharing(page, 'private');
  const earlierInput = page.getByRole('textbox', { name: 'Eerste gedachte' });
  await earlierInput.fill('Mijn eerdere privétekst');
  await page.getByRole('button', { name: Model.ui('nl', 'returnHome') }).click();
  await page.getByRole('button', { name: Model.ui('nl', 'changeConsent') }).click();
  await chooseSharing(page);
  await expect(earlierInput).toHaveAccessibleDescription('');
  await earlierInput.fill('Mijn eerdere privétekst aangevuld');
  const laterInput = page.getByRole('textbox', { name: 'Volgende gedachte' });
  await expect(laterInput).toHaveAccessibleDescription(Model.ui('nl', 'reflectionAccess'));
  await laterInput.fill('Dit deel ik graag');
  await expect.poll(() => posts.some(body => body.answers[later.id] === 'Dit deel ik graag')).toBe(true);
  expect(posts.every(body => body.consent === true && body.collectionVersion === 'current' && !(earlier.id in body.answers))).toBe(true);
});

test('declining in another tab cancels a queued submission from the same pilot', async ({ page, context }) => {
  const course = Model.createExpeditionPreset('blank', 'Op weg met pijn');
  course.shareOptions = { collectResponses: true, collectionVersion: 'same' };
  const reflection = Model.createBlock('reflection');
  reflection.data.prompt = { nl: 'Reflectie' };
  course.modules[0].steps[0].blocks = [reflection];
  await openCourse(page, course);
  let release;
  const posts = [];
  await page.route(apiPath + '/responses', async route => {
    posts.push(route.request().postDataJSON());
    if (posts.length === 1) await new Promise(resolve => { release = resolve; });
    await route.fulfill({ json: { saved: true } });
  });
  await page.locator('.xped-hero-cta-row button').click();
  await chooseSharing(page);
  await expect.poll(() => posts.length).toBe(1);
  await page.clock.install();
  await page.getByRole('textbox', { name: 'Reflectie' }).fill('Queued answer');
  await page.clock.runFor(500);

  const other = await context.newPage();
  await openCourse(other, course);
  await other.getByRole('button', { name: Model.ui('nl', 'changeConsent') }).click();
  await chooseSharing(other, 'private');
  await expect(page.getByRole('textbox', { name: 'Reflectie' })).toHaveAccessibleDescription('');
  release();
  await page.clock.runFor(1000);
  expect(posts.map(post => post.answers)).toEqual([{}]);
});

test('a new pilot group asks again and keeps earlier answers and visits out of its response', async ({ page }) => {
  const course = Model.createExpeditionPreset('blank', 'Op weg met pijn');
  course.shareOptions = { collectResponses: true, collectionVersion: 'pilot' };
  const firstStep = course.modules[0].steps[0];
  const secondStep = Model.createStep('Tweede stap', 'Second step');
  course.modules[0].steps.push(secondStep);
  const first = Model.createBlock('reflection');
  const old = Model.createBlock('reflection');
  const fresh = Model.createBlock('reflection');
  first.data.prompt.nl = 'Eerste vraag';
  old.data.prompt.nl = 'Tweede vraag';
  fresh.data.prompt.nl = 'Derde vraag';
  firstStep.blocks = [first];
  secondStep.blocks = [old, fresh];
  const posts = [];
  page.on('request', req => { if (req.url().endsWith('/responses')) posts.push(req.postDataJSON()); });
  await openCourse(page, course, '?lang=nl&cohort=group-a');
  await page.locator('.xped-hero-cta-row button').click();
  await chooseSharing(page);
  await page.getByRole('textbox', { name: 'Eerste vraag' }).fill('Eerste antwoord voor A');
  await page.getByRole('button', { name: Model.ui('nl', 'next'), exact: true }).click();
  const previous = page.getByRole('textbox', { name: 'Tweede vraag' });
  await previous.fill('Tweede antwoord voor A');
  await expect.poll(() => posts.find(post => post.answers[old.id])?.visitedStepIds).toEqual([firstStep.id, secondStep.id]);

  await openCourse(page, course, '?lang=nl&cohort=%20group-b%20');
  await page.getByRole('button', { name: 'Verder met je xPEDitie' }).click();
  await expect(page.getByText(/group-b/)).toBeVisible();
  await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
  expect(posts.filter(post => post.cohort === 'group-b')).toHaveLength(0);
  await chooseSharing(page);
  await expect(previous).toHaveValue('Tweede antwoord voor A');
  await expect(previous).toHaveAccessibleDescription('');
  await page.getByRole('textbox', { name: 'Derde vraag' }).fill('Alleen voor B');
  await expect.poll(() => posts.find(post => post.cohort === 'group-b' && post.answers[fresh.id])?.answers).toEqual({ [fresh.id]: 'Alleen voor B' });
  const fromA = posts.find(post => post.cohort === 'group-a');
  for (const post of posts.filter(item => item.cohort === 'group-b')) {
    expect(post.sessionId).not.toBe(fromA.sessionId);
    expect(post.visitedStepIds).toEqual([secondStep.id]);
    expect(Object.keys(post.answers)).not.toContain(first.id);
    expect(Object.keys(post.answers)).not.toContain(old.id);
  }
});

test('an answer waits for a sharing decision and is sent when the learner keeps sharing', async ({ page }) => {
  const course = Model.createExpeditionPreset('blank', 'Op weg met pijn');
  course.shareOptions = { collectResponses: true, collectionVersion: 'pilot' };
  const reflection = Model.createBlock('reflection');
  reflection.data.prompt.nl = 'Mijn notitie';
  course.modules[0].steps[0].blocks = [reflection];
  const posts = [];
  await openCourse(page, course);
  page.on('request', req => { if (req.url().endsWith('/responses')) posts.push(req.postDataJSON()); });
  await page.locator('.xped-hero-cta-row button').click();
  await chooseSharing(page);
  await expect.poll(() => posts.length).toBe(1);
  await page.clock.install();
  await page.getByRole('textbox', { name: 'Mijn notitie' }).fill('Verstuur na mijn keuze');
  await page.getByRole('button', { name: Model.ui('nl', 'returnHome') }).click();
  await page.getByRole('button', { name: Model.ui('nl', 'changeConsent') }).click();
  await expect(page.getByText(/De makers houden de antwoorden die je al hebt gedeeld/)).toBeVisible();
  await page.clock.runFor(800);
  expect(posts).toHaveLength(1);
  await chooseSharing(page);
  await page.clock.runFor(800);
  await expect.poll(() => posts.map(body => body.answers[reflection.id])).toContain('Verstuur na mijn keuze');
  expect(new Set(posts.map(body => body.sessionId)).size).toBe(1);
});

test('two open groups resume their own drafts and sharing choices independently', async ({ page, context }) => {
  const course = Model.createExpeditionPreset('blank', 'Op weg met pijn');
  course.shareOptions = { collectResponses: true, collectionVersion: 'pilot' };
  const answer = Model.createBlock('reflection');
  answer.data.prompt.nl = 'Mijn notitie';
  course.modules[0].steps[0].blocks = [answer];
  const postsA = [];
  const postsB = [];
  const other = await context.newPage();
  page.on('request', req => { if (req.url().endsWith('/responses')) postsA.push(req.postDataJSON()); });
  other.on('request', req => { if (req.url().endsWith('/responses')) postsB.push(req.postDataJSON()); });
  await openCourse(page, course, '?lang=nl&cohort=A');
  await page.locator('.xped-hero-cta-row button').click();
  await chooseSharing(page);
  const first = page.getByRole('textbox', { name: 'Mijn notitie' });
  const second = other.getByRole('textbox', { name: 'Mijn notitie' });
  await first.fill('Notitie van A');
  await expect.poll(() => postsA.at(-1)?.answers[answer.id]).toBe('Notitie van A');
  await openCourse(other, course, '?lang=nl&cohort=B');
  await other.locator('.xped-hero-cta-row button').click();
  await chooseSharing(other, 'private');
  await second.fill('Privé in groep B');
  await expect(first).toBeVisible();
  await expect(first).toHaveAccessibleDescription(Model.ui('nl', 'reflectionAccess'));
  await page.reload();
  await page.locator('.xped-hero-cta-row button').click();
  await expect(first).toHaveValue('Notitie van A');
  await first.fill('Nieuwe notitie van A');
  await expect.poll(() => postsA.at(-1)?.answers[answer.id]).toBe('Nieuwe notitie van A');
  await other.reload();
  await other.locator('.xped-hero-cta-row button').click();
  await expect(second).toHaveValue('Privé in groep B');
  await expect(second).toHaveAccessibleDescription('');
  expect(postsB).toEqual([]);
  expect(new Set(postsA.map(post => post.sessionId)).size).toBe(1);
  expect(postsA.every(post => post.cohort === 'A' && post.answers[answer.id] !== 'Privé in groep B')).toBe(true);
});

test('a rejected response version asks again and creates a fresh shared session', async ({ page }) => {
  const course = Model.createExpeditionPreset('blank', 'Op weg met pijn');
  course.shareOptions = { collectResponses: true, collectionVersion: 'first' };
  const old = Model.createBlock('reflection');
  const fresh = Model.createBlock('reflection');
  old.data.prompt.nl = 'Eerste vraag';
  fresh.data.prompt.nl = 'Nieuwe vraag';
  course.modules[0].steps[0].blocks = [old, fresh];
  await openCourse(page, course);
  const posts = [];
  await page.route(apiPath + '/responses', async route => {
    const body = route.request().postDataJSON();
    posts.push(body);
    if (body.collectionVersion === 'first' && body.answers[old.id]) {
      course.shareOptions.collectionVersion = 'second';
      await route.fulfill({ status: 409, json: { error: 'The response collection settings have changed.' } });
    } else await route.fulfill({ json: { ok: true } });
  });
  await page.locator('.xped-hero-cta-row button').click();
  await chooseSharing(page);
  await page.getByRole('textbox', { name: 'Eerste vraag' }).fill('Onder oude voorwaarden');
  await expect(page.getByRole('radio', { checked: true })).toHaveCount(0);
  await chooseSharing(page);
  await expect(page.getByRole('textbox', { name: 'Eerste vraag' })).toHaveValue('Onder oude voorwaarden');
  await page.getByRole('textbox', { name: 'Nieuwe vraag' }).fill('Onder nieuwe voorwaarden');
  await expect.poll(() => posts.find(post => post.collectionVersion === 'second' && post.answers[fresh.id])?.answers)
    .toEqual({ [fresh.id]: 'Onder nieuwe voorwaarden' });
  expect(posts.find(post => post.collectionVersion === 'second').sessionId).not.toBe(posts[0].sessionId);
});

test('a learner resumes their older course-wide draft as private work', async ({ page }) => {
  const course = Model.createExpeditionPreset('blank', 'Op weg met pijn');
  course.shareOptions = { collectResponses: true, collectionVersion: 'new-pilot' };
  const old = Model.createBlock('reflection');
  const fresh = Model.createBlock('reflection');
  old.data.prompt.nl = 'Eerdere reflectie';
  fresh.data.prompt.nl = 'Nieuwe reflectie';
  const step = course.modules[0].steps[0];
  step.blocks = [old, fresh];
  await page.addInitScript(({stepId,blockId}) => {
    const key = 'xped_el_progress_synthetic-route';
    if (localStorage.getItem(key)) return;
    localStorage.setItem(key, JSON.stringify({sessionId: 'old-session', visitedStepIds: [stepId],
      answers: {[blockId]: 'Mijn bewaarde tekst'}, sharedAnswers: {[blockId]: 'Mijn bewaarde tekst'},
      stepComments: [{comment: 'Oude opmerking'}]}));
  }, {stepId:step.id, blockId:old.id});
  const posts = [];
  page.on('request', req => { if (req.url().endsWith('/responses')) posts.push(req.postDataJSON()); });
  await openCourse(page, course, '?cohort=campus&lang=nl');
  await page.getByRole('button', { name: 'Verder met je xPEDitie' }).click();
  await chooseSharing(page);
  const draft = page.getByRole('textbox', { name: 'Eerdere reflectie' });
  await expect(draft).toHaveValue('Mijn bewaarde tekst');
  await expect(draft).toHaveAccessibleDescription('');
  await page.getByRole('textbox', { name: 'Nieuwe reflectie' }).fill('Deze deel ik');
  await expect.poll(() => posts.at(-1)?.answers).toEqual({ [fresh.id]: 'Deze deel ik' });
  expect(posts.every(post => post.sessionId !== 'old-session' && !post.stepComments)).toBe(true);
});
