const { test, expect } = require('@playwright/test');
const model = require('../static/js/elearning-model');
const { editorFixture } = require('./helpers/xped-editor');

const editURL = '/physio/elearning/visual/edit';
const lastSave = fixture => fixture.writes.at(-1)?.body;
const stepRow = (page, step) => page.locator('[data-step-id="' + step.id + '"]');
const blockNode = (page, block) => page.locator('#el-canvas-card [data-block-id="' + block.id + '"]');
const properties = page => page.locator('#el-inspector');
async function choice(page, field, item) {
  await page.getByRole('button', { name: field, exact: true }).click();
  await page.getByRole('menuitem', { name: item, exact: typeof item === 'string' }).click();
}
async function author(page, arrange, options = {}) {
  const fixture = await editorFixture(page, { saveStructure: async (route, body, exp) => {
    Object.assign(exp, body);
    return route.fulfill({ json: { expedition: { ...exp, revision: ++exp.revision } } });
  }, ...options });
  fixture.exp.modules = [model.createModule('ask-teach-reflect', 0), model.createModule('blank', 1)];
  if (arrange) arrange(fixture.exp);
  await page.goto(editURL);
  await expect(page.locator('#el-save-state')).toHaveText('Saved');
  return fixture;
}
async function screenshot(page, name) {
  if (process.env.XPED_AUTHORING_EVIDENCE) {
    await page.screenshot({ path: process.env.XPED_AUTHORING_EVIDENCE + '/' + name + '.png', animations: 'disabled' });
  }
}

test('outline moves retain identity, ordinals, focus and station disclosures', async ({ page }) => {
  const { exp } = await author(page);
  const [station, other] = exp.modules;
  const [first, second] = station.steps;
  const toggle = page.getByRole('button', { name: /Collapse Station 1 \(3 steps\)/ });
  await toggle.focus();
  await toggle.press('Space');
  const collapsed = page.getByRole('button', { name: /Expand Station 1 \(3 steps\)/ });
  await expect(collapsed).toBeFocused();
  await expect(collapsed).toHaveAttribute('aria-expanded', 'false');
  expect(await collapsed.getAttribute('aria-controls')).toBe('steps-' + station.id);
  await collapsed.press('Space');
  await expect(toggle).toBeFocused();
  await expect(stepRow(page, first)).toContainText('1. Opening question');
  await expect(stepRow(page, first).getByRole('img', { name: 'Status: draft' })).toBeVisible();
  await expect(stepRow(page, other.steps[0]).getByRole('img', { name: 'Status: empty' })).toBeVisible();

  const down = page.getByRole('button', { name: 'Move step Opening question down' });
  await down.focus();
  await down.press('Enter');
  await expect(down).toBeFocused();
  await expect(stepRow(page, first)).toContainText('2. Opening question');
  await down.press('Enter');
  await expect(stepRow(page, first)).toContainText('3. Opening question');
  await expect(page.getByRole('button', { name: 'Move step Opening question up' })).toBeFocused();
  await expect(stepRow(page, second)).toContainText('1. Explanation & video');
});

test('dragging above or below an outline row matches the line and a sole step stays in its station', async ({ page }) => {
  const { exp } = await author(page);
  const [first, second, third] = exp.modules[0].steps;
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  async function drop(from, to, after) {
    const src = stepRow(page, from);
    const dest = stepRow(page, to);
    await dest.scrollIntoViewIfNeeded();
    const rect = await dest.boundingBox();
    const point = { dataTransfer: transfer, clientY: Math.round(rect.y + rect.height * (after ? 0.8 : 0.2)) };
    await src.dispatchEvent('dragstart', point);
    await dest.dispatchEvent('dragover', point);
    await expect(dest).toHaveClass(new RegExp('is-dragover-' + (after ? 'after' : 'before')));
    await dest.dispatchEvent('drop', point);
  }
  await drop(first, third, true);
  await expect(stepRow(page, first)).toContainText('3. Opening question');
  await drop(first, second, false);
  await expect(stepRow(page, first)).toContainText('1. Opening question');
  await drop(exp.modules[1].steps[0], first, true);
  await expect(page.locator('#el-toast')).toContainText(/keep at least one step/);
  expect(await page.locator('.el-module-group').nth(1).locator('.el-step-row').count()).toBe(1);
});

test('insertion focuses the name and editing one title does not invalidate a scoped deletion undo', async ({ page }) => {
  const fixture = await author(page);
  await page.locator('#el-add-module-btn').click();
  await page.locator('#el-new-station-name').fill('Forest station');
  await page.locator('[data-recipe=pain-science]').click();
  await expect(page.getByRole('button', { name: 'Forest station', exact: true })).toBeVisible();
  const station = page.locator('.el-module-group').last();
  await station.getByText('Add step', { exact: true }).click();
  const title = page.locator('#el-canvas-card .xped-step-title');
  await expect(title).toBeFocused();
  await page.keyboard.type('Walking goal');
  await expect(station.locator('.el-step-row').last()).toContainText('Walking goal');
  await page.locator('[data-insp=step]').click();
  await page.getByRole('button', { name: 'Delete Step', exact: true }).click();
  await title.fill('A later edit');
  await page.locator('#el-toast button').click();
  await expect(station).toContainText('A later edit');
  await expect(station).toContainText('Walking goal');
  await expect.poll(() => lastSave(fixture)?.modules.at(-1).steps.length).toBe(3);
  await stepRow(page, fixture.exp.modules[1].steps[0]).click();
  await expect(page.getByRole('button', { name: 'Delete Step', exact: true })).toBeDisabled();
  await expect(page.getByText(/Every station keeps at least one step/)).toBeVisible();
});

test('field edits retain their own toolbar undo and redo after save and reload', async ({ page }) => {
  const fixture = await author(page);
  const step = fixture.exp.modules[0].steps[0];
  await stepRow(page, step).click();
  const title = page.locator('#el-canvas-card .xped-step-title');
  await title.fill('Check-in question');
  await expect.poll(() => lastSave(fixture)?.modules[0].steps[0].title.en).toBe('Check-in question');
  await page.locator('#el-undo-btn').click();
  await expect(title).toHaveText('Opening question');
  await page.locator('#el-redo-btn').click();
  await expect(title).toHaveText('Check-in question');
  await page.locator('[data-insp=step]').click();
  const name = page.getByLabel('Station Name (EN)');
  await name.fill('Morning workshop');
  await page.locator('#el-undo-btn').click();
  await expect(name).toHaveValue('Station 1');
  await page.locator('#el-redo-btn').click();
  await expect.poll(() => lastSave(fixture)?.modules[0].title.en).toBe('Morning workshop');
  await page.reload();
  await expect(page.locator('.el-module-group').first()).toContainText('Morning workshop');
  await expect(page.locator('.el-module-group').first()).toContainText('Check-in question');
});

test('picker previews a teaching activity before adding it and focuses the inserted block', async ({ page }) => {
  const { exp } = await author(page);
  await stepRow(page, exp.modules[1].steps[0]).click();
  const empty = page.getByRole('button', { name: /Start building this step/ });
  await empty.focus();
  await empty.press('Enter');
  const search = page.getByRole('searchbox', { name: 'Search blocks' });
  await expect(search).toBeFocused();
  await search.press('Tab');
  await expect(page.locator('[data-picker-key=richtext]')).toBeFocused();
  for (const [term, type] of [['stelling', 'myth_fact'], ['bronnen', 'sources'], ['peiling', 'mcq'], ['atemkreis', 'breathing-circle']]) {
    await search.fill(term);
    await expect(page.locator('[data-picker-key=' + type + ']')).toBeVisible();
    await expect(page.locator('#el-picker-preview')).not.toBeEmpty();
  }
  await search.press('Escape');
  await expect(page.locator('#el-block-picker-dialog')).toBeHidden();
  await empty.click();
  await page.locator('[data-picker-key=richtext]').click();
  await page.locator('#el-picker-insert').click();
  await expect(page.locator('#el-canvas-card [contenteditable]:focus')).toBeVisible();
  await page.keyboard.type('Immediately editable');
  await expect(page.locator('#el-canvas-card .xped-question-text')).toContainText('Immediately editable');
});

test('selected toolbar tracks editing focus, compatible insert positions and moving a translated image', async ({ page }) => {
  const fixture = await author(page, exp => {
    exp.modules[0].steps[0].blocks = ['richtext', 'image', 'richtext'].map(model.createBlock);
    Object.assign(exp.modules[0].steps[0].blocks[1].data, {
      caption: model.loc('Een pad', 'A path', 'Ein Pfad'),
      media: { kind: 'xped', staticPath: model.XPED_ASSETS[1].path },
      focalX: 27, focalY: 76,
    });
  });
  const [src, dst] = fixture.exp.modules[0].steps;
  const [a, image, b] = src.blocks;
  await stepRow(page, src).click();
  await expect(page.getByRole('button', { name: /^Add block before/ })).toHaveCount(3);
  await expect(page.getByRole('button', { name: 'Add block at end' })).toHaveCount(1);
  await blockNode(page, b).locator('textarea').fill('Last block');
  await expect(page.locator('.el-block-toolbar')).toHaveCount(1);
  await expect(blockNode(page, a).locator('..')).not.toHaveClass(/is-selected/);
  await page.getByRole('button', { name: 'Duplicate block' }).click();
  await expect(page.locator('#el-canvas-card .xped-richtext-editor')).toHaveCount(3);
  await expect(page.locator('#el-canvas-card .xped-richtext-editor').last()).toHaveValue('Last block');
  await blockNode(page, image).click();
  await choice(page, 'Move block to another step…', /Explanation & video/);
  await page.getByLabel('Insert position').selectOption('0');
  await page.getByRole('button', { name: 'Move block here' }).click();
  await expect(page.locator('#el-canvas-card [data-block-id]').first()).toHaveAttribute('data-block-id', image.id);
  await expect.poll(() => lastSave(fixture)?.modules[0].steps[1].blocks[0].data.caption.de).toBe('Ein Pfad');
  await page.locator('#el-undo-btn').click();
  await expect(stepRow(page, src)).toHaveAttribute('aria-current', 'step');
  await expect(page.locator('#el-canvas-card [data-block-id]').nth(1)).toHaveAttribute('data-block-id', image.id);
  await expect(stepRow(page, dst)).not.toHaveAttribute('aria-current', 'step');
  await expect.poll(() => lastSave(fixture)?.modules[0].steps[0].blocks[1].data).toEqual(image.data);
});

test('branch destinations remain repairable and reveal restrictions are explained', async ({ page }) => {
  const { exp } = await author(page, draft => {
    const [from, dest] = draft.modules[0].steps;
    const scale = model.createBlock('scale');
    scale.data.question = model.loc('', 'Confidence to move', '');
    from.blocks.push(scale);
    from.branching = [{ blockId: from.blocks[0].id, operator: 'equals', value: 'myth', targetStepId: dest.id }];
  });
  const [from, dest] = exp.modules[0].steps;
  await stepRow(page, from).click();
  await page.locator('[data-insp=step]').click();
  await choice(page, 'Source question', 'Confidence to move');
  await page.getByLabel(/Threshold/).fill('3');
  await expect(page.getByRole('button', { name: 'Condition' })).toContainText(/at most/);
  await stepRow(page, dest).click();
  await page.getByRole('button', { name: 'Delete Step', exact: true }).click();
  await expect(page.locator('#el-toast')).toContainText('Opening question');
  await expect(stepRow(page, from).getByRole('img', { name: 'Jump destination missing' })).toBeVisible();
  await stepRow(page, from).click();
  await expect(page.getByRole('button', { name: 'Clear broken rule' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear broken rule' }).click();
  await expect(stepRow(page, from).getByRole('img', { name: 'Jump destination missing' })).toHaveCount(0);
});

test('duration, missing alt and writing disclosures identify the exact published estimate and field', async ({ page }) => {
  const fixture = await author(page, exp => {
    const figures = Array.from({ length: 3 }, () => model.createBlock('image'));
    for (const [index, block] of figures.entries()) {
      block.data.media = { kind: 'xped', staticPath: model.XPED_ASSETS[1].path };
      block.data.alt = model.loc('', index === 1 ? '' : 'Walking map', '');
    }
    exp.modules[0].steps[0].blocks = figures;
  });
  await stepRow(page, fixture.exp.modules[0].steps[0]).click();
  await page.locator('[data-insp=step]').click();
  const minutes = page.getByLabel(/Estimated Minutes/);
  await minutes.fill('121');
  await expect(minutes).toHaveAttribute('aria-invalid', 'true');
  await minutes.fill('8x');
  await expect(minutes).toHaveAttribute('aria-invalid', 'true');
  expect(fixture.writes).toHaveLength(0);
  await minutes.fill('8');
  await expect.poll(() => lastSave(fixture)?.modules[0].estimatedMinutes).toBe(8);
  const checks = page.getByRole('button', { name: /Writing & Accessibility/ });
  await checks.focus();
  await checks.press('Space');
  await expect(checks).toHaveAttribute('aria-expanded', 'true');
  await checks.press('Space');
  await expect(page.locator('#el-b1-coach-panel')).toBeHidden();
  await checks.click();
  await page.getByRole('button', { name: /needs an image description/ }).click();
  await expect(properties(page).locator('[data-field-key=alt]')).toBeFocused();
  await expect(blockNode(page, fixture.exp.modules[0].steps[0].blocks[1]).locator('..')).toHaveClass(/is-selected/);
});

test('palette is a private specimen until Apply, including on the live canvas', async ({ page }) => {
  const fixture = await author(page);
  await page.locator('[data-insp=theme]').click();
  const current = fixture.exp.theme.preset;
  const clean = page.locator('[data-palette=xped-clean]');
  await clean.click();
  await expect(page.locator('.el-palette-specimen')).toHaveAttribute('data-xped-theme', 'xped-clean');
  await expect(page.locator('#el-canvas-frame')).toHaveAttribute('data-xped-theme', current);
  expect(fixture.writes).toHaveLength(0);
  await page.getByRole('button', { name: 'Apply palette to expedition' }).click();
  await expect(page.locator('#el-canvas-frame')).toHaveAttribute('data-xped-theme', 'xped-clean');
  await expect.poll(() => lastSave(fixture)?.theme.preset).toBe('xped-clean');
});

test('during a slow save the last workspace selection wins and focus follows it', async ({ page }) => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const fixture = await author(page, null, { saveStructure: async (route, body) => {
    await wait;
    return route.fulfill({ json: { expedition: { ...body, revision: 2 } } });
  } });
  await page.locator('#el-exp-title').fill('Edited before preview');
  await page.locator('[data-mode=translate]').click();
  await expect.poll(() => fixture.writes.length).toBe(1);
  await page.locator('[data-mode=preview]').click();
  await expect(page.locator('[data-mode=preview]')).toHaveClass(/is-pending/);
  release();
  await expect(page.locator('#el-mode-preview')).toBeVisible();
  await expect(page.locator('[data-mode=preview]')).toBeFocused();
  await expect(page.locator('#el-mode-translate')).toBeHidden();
  await expect(page.locator('#el-mode-edit')).toBeHidden();
});

test.describe('touch authoring', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test('phone offers readable titles, a usable preview chooser and well-separated block controls', async ({ page }) => {
    const { exp } = await author(page);
    await page.setViewportSize({ width: 320, height: 720 });
    const title = page.locator('#el-exp-title');
    await title.fill('Workshop for people moving with persistent pain — independent afternoon route');
    expect(await title.evaluate(el => el.clientHeight >= el.scrollHeight)).toBeTruthy();
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    const tools = page.locator('#el-utilities-toggle');
    await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
    await tools.click();
    const menu = await page.locator('#el-editor-utilities').boundingBox();
    const trigger = await tools.boundingBox();
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(320);
    expect(menu.y).toBeGreaterThanOrEqual(trigger.y + trigger.height);
    await tools.press('Escape');
    await page.evaluate(() => { document.documentElement.style.fontSize = ''; });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-pane=outline].el-pane-btn').click();
    await stepRow(page, exp.modules[0].steps[0]).click();
    for (const name of ['Move block up', 'Duplicate block', 'Delete block']) {
      const box = await page.getByRole('button', { name, exact: true }).boundingBox();
      expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(44);
    }
    await screenshot(page, 'author-390');
    await page.getByRole('button', { name: /Add block before/ }).first().tap();
    const picker = page.locator('#el-block-picker-dialog');
    await page.locator('[data-picker-key=mcq]').tap();
    await expect(page.locator('#el-picker-preview-heading')).toContainText('Poll');
    await expect(page.locator('#el-picker-preview')).toBeVisible();
    await screenshot(page, 'picker-390');
    await page.getByRole('button', { name: /All blocks/ }).tap();
    await page.locator('[data-picker-key=scale]').tap();
    await expect(page.locator('#el-picker-preview-heading')).toContainText('Slider');
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(page.locator('#el-canvas-card [data-block-id]')).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  });
});

test('inspector edits update an open citation and warn about a locked passage without a question', async ({ page }) => {
  const { exp } = await author(page, draft => {
    const src = model.createBlock('sources');
    src.data.items = [{ id: 'src_paper', citation: model.loc('', 'Research on pain', ''), url: '' }];
    src.settings = { revealAfterAnswer: true };
    draft.modules[0].steps[0].blocks = [src];
  });
  await stepRow(page, exp.modules[0].steps[0]).click();
  const disclosure = page.locator('#el-canvas-card .xped-sources-box');
  await disclosure.locator('summary').click();
  const doi = properties(page).getByLabel(/DOI or URL/);
  await doi.fill('10.3174/ajnr.A4173');
  await expect(disclosure).toHaveAttribute('open', '');
  await expect(disclosure.getByRole('link')).toHaveAttribute('href', 'https://doi.org/10.3174/ajnr.A4173');
  await expect(doi).toBeFocused();
  await expect(properties(page)).toContainText(/would never be able to unlock/);
  const guard = page.getByRole('checkbox', { name: /Reveal only after learner answers/ });
  await guard.uncheck();
  await expect(guard).toBeDisabled();
  await expect(guard).not.toBeChecked();
});

for (const variant of [
  { width: 1366, theme: 'light', palette: 'xped-warm-sand' },
  { width: 1366, theme: 'dark', palette: 'high-contrast' },
  { width: 375, theme: 'dark', palette: 'xped-clean' },
  { width: 768, theme: 'light', palette: 'xped-warm-sand' },
]) {
  test('visible editing focus and learner context at ' + variant.width + ' in ' + variant.theme, async ({ page }) => {
    await page.setViewportSize({ width: variant.width, height: 850 });
    await page.addInitScript(theme => {
      for (const key of ['lp-preferences', 'lp-preferences:author']) localStorage.setItem(key, JSON.stringify({ theme }));
    }, variant.theme);
    await page.emulateMedia({ colorScheme: variant.theme, reducedMotion: 'reduce' });
    const { exp } = await author(page, draft => {
      draft.theme.preset = variant.palette;
      const copy = model.createBlock('richtext');
      copy.data.heading = model.loc('', 'Notice what changes', '');
      copy.data.body = model.loc('', 'Observe your breathing before you take the next small step.', '');
      draft.modules[0].steps[0].blocks.push(copy);
    });
    await expect(page.locator('html')).toHaveAttribute('data-theme', variant.theme);
    if (variant.width <= 920) await page.locator('.el-pane-btn[data-pane=outline]').click();
    const step = exp.modules[0].steps[0];
    await stepRow(page, step).click();
    await page.locator('.xped-richtext-editor').focus();
    await expect(page.locator('.xped-richtext-editor')).toBeFocused();
    await expect(page.locator('.el-canvas-block-wrap.is-selected')).toHaveCount(1);
    const editor = page.locator('.xped-richtext-editor');
    await editor.scrollIntoViewIfNeeded();
    const text = await editor.inputValue();
    const box = await editor.boundingBox();
    await page.mouse.move(box.x + 16, box.y + 23);
    await page.mouse.down();
    await page.mouse.move(box.x + Math.min(110, box.width - 4), box.y + 23, { steps: 6 });
    await page.mouse.up();
    const selection = await editor.evaluate(el => el.selectionEnd - el.selectionStart);
    expect(selection).toBeGreaterThan(1);
    expect(await editor.inputValue()).toBe(text);
    await expect(page.locator('#el-canvas-crumb')).toHaveText(/Station 1 · Step 1 of 3 · EN/);
    await expect(page.locator('#el-canvas-card .xped-step-crumb')).toHaveText('Station 1');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(variant.width);
    await screenshot(page, 'author-' + variant.width + '-' + variant.theme + '-' + variant.palette);
    await page.getByRole('tab', { name: 'Preview', exact: true }).click();
    const mode = page.locator('#el-mode-preview');
    await expect(mode).toBeVisible();
    expect(await mode.evaluate(el => getComputedStyle(el).animationName)).toBe('none');
  });
}

test('course languages is reachable from Translate and each new generic station stays neutral', async ({ page }) => {
  const fixture = await author(page, exp => {
    exp.enabledLanguages = ['en', 'nl'];
    exp.modules[0].domain = 'bio';
  });
  await page.getByRole('tab', { name: 'Translate', exact: true }).click();
  await page.getByRole('button', { name: 'Course languages', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Languages', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#el-course-languages')).toBeFocused();
  await page.getByRole('checkbox', { name: /Enable Deutsch/ }).check();
  await choice(page, 'Default Fallback Language', 'Deutsch (DE)');
  await expect.poll(() => lastSave(fixture)?.defaultLanguage).toBe('de');
  for (let i = 0; i < 3; i++) {
    await page.locator('#el-add-module-btn').click();
    await page.locator('[data-recipe=blank]').click();
  }
  await expect.poll(() => lastSave(fixture)?.modules.length).toBe(5);
  expect(lastSave(fixture).modules.map(station => station.domain)).toEqual(['bio', 'general', 'general', 'general', 'general']);
});

test('nested learner text and optional references have distinct reading counts', async ({ page }) => {
  const { exp } = await author(page, draft => {
    const pin = model.createBlock('hotspot');
    const source = model.createBlock('sources');
    pin.data.pins = [{ id: 'pin_abc', x: 50, y: 50, label: model.loc('', 'Rest', ''), detail: model.loc('', '', '') }];
    source.data.items = [{ id: 'src_abc', citation: model.loc('', 'Read this optional reference', ''), url: '' }];
    draft.modules[0].steps[0].blocks = [pin, source];
  });
  await stepRow(page, exp.modules[0].steps[0]).click();
  const reading = page.locator('#el-readability-bar');
  const before = Number((await reading.innerText()).match(/(\d+) words/)[1]);
  await properties(page).getByLabel('Pin Explanation', { exact: true }).fill(Array(50).fill('walk').join(' '));
  await expect(reading).toContainText((before + 50) + ' words');
  await expect(reading).toContainText('+4 optional');
});

test.describe('compact outline and insertion', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test('move two steps with the keyboard and use an intermediate insertion lane three times', async ({ page }) => {
    const { exp } = await author(page, draft => {
      draft.modules[0].steps[0].title.en = 'Morning exercise with extra context for the clinical team';
      draft.modules[0].steps[0].blocks = [model.createBlock('mcq'), model.createBlock('scale')];
    });
    const first = exp.modules[0].steps[0];
    const outline = page.locator('button[data-pane=outline]');
    await outline.click();
    await stepRow(page, first).click();
    await outline.click();
    const move = page.getByRole('button', { name: 'Move step ' + first.title.en + ' down', exact: true });
    await move.focus();
    await move.press('Enter');
    await expect(move).toBeFocused();
    await move.press('Enter');
    await expect(stepRow(page, first)).toContainText('3.');
    await expect(page.locator('.el-step-line:not(.is-active) [data-move-step]').first()).toBeHidden();
    await stepRow(page, first).click();
    for (let i = 0; i < 3; i++) {
      await page.getByRole('button', { name: /Add block before Confidence Slider/ }).tap();
      await page.locator('[data-picker-key=richtext]').tap();
      await page.locator('#el-picker-insert').tap();
      await expect(page.locator('.xped-richtext-editor')).toHaveCount(i + 1);
    }
    await expect(page.locator('#el-canvas-card [data-block-id]').first()).toHaveAttribute('data-block-id', first.blocks[0].id);
    await expect(page.locator('#el-canvas-card [data-block-id]').last()).toHaveAttribute('data-block-id', first.blocks[1].id);
  });
});

test('the second question drives its configured route on the threshold only', async ({ page }) => {
  const { exp } = await author(page, draft => {
    const first = draft.modules[0].steps[0];
    const confidence = model.createBlock('scale');
    confidence.data.question = model.loc('', 'How confident are you?', '');
    first.blocks = [model.createBlock('myth_fact'), confidence];
  });
  const [source, ordinary, target] = exp.modules[0].steps;
  await stepRow(page, source).click();
  await page.locator('[data-insp=step]').click();
  await choice(page, 'When answered…', /Short reflection/);
  await choice(page, 'Source question', 'How confident are you?');
  await page.getByLabel(/Threshold/).fill('3');
  await page.locator('[data-mode=preview]').click();
  const stage = page.locator('#el-preview-container');
  const next = stage.getByRole('button', { name: /^Next/ });
  const back = stage.getByRole('button', { name: /^Back/ });
  await stage.getByRole('button', { name: 'Myth', exact: true }).click();
  await next.click();
  await expect(stage.locator('.xped-step-title')).toHaveText(ordinary.title.en);
  await back.click();
  const slider = stage.getByRole('slider', { name: 'How confident are you?' });
  await slider.focus();
  await slider.press('Home');
  for (let score = 0; score < 3; score++) await slider.press('ArrowRight');
  await next.click();
  await expect(stage.locator('.xped-step-title')).toHaveText(target.title.en);
  await back.click();
  await expect(stage.locator('.xped-step-title')).toHaveText(source.title.en);
  await slider.focus();
  await slider.press('ArrowRight');
  await next.click();
  await expect(stage.locator('.xped-step-title')).toHaveText(ordinary.title.en);
});

test('moving the pointer across another activity cannot change the chosen insertion', async ({ page }) => {
  const { exp } = await author(page);
  await stepRow(page, exp.modules[1].steps[0]).click();
  await page.getByRole('button', { name: /Start building this step/ }).click();
  await page.locator('[data-picker-key=reflection]').click();
  const add = page.locator('#el-picker-insert');
  const picked = await add.innerText();
  await page.locator('[data-picker-key=bps_triad]').hover();
  await expect(add).toHaveText(picked);
  await add.click();
  await expect(properties(page)).toContainText('Reflection');
  await expect(page.locator('#el-canvas-card [data-block-id]')).toHaveCount(1);
});

for (const width of [320, 390, 1280]) {
  test.describe('inspector at ' + width, () => {
    test.use({ viewport: { width, height: 844 }, hasTouch: width <= 390 });
    test('keyboard tabs and selected-toolbar clearance', async ({ page }) => {
      const { exp } = await author(page);
      if (width <= 390) await page.locator('.el-pane-btn[data-pane=outline]').click();
      await stepRow(page, exp.modules[0].steps[0]).click();
      const toolbar = await page.locator('.el-block-toolbar').boundingBox();
      const question = await page.locator('#el-canvas-card .xped-question-text').boundingBox();
      expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(question.y);
      if (width <= 390) await page.getByRole('button', { name: 'Block properties', exact: true }).tap();
      const tabs = page.getByRole('tablist', { name: 'Inspector sections' });
      const settings = tabs.getByRole('tab', { name: 'Settings' });
      await settings.focus();
      await settings.press('ArrowRight');
      const station = tabs.getByRole('tab', { name: 'Station' });
      await expect(station).toBeFocused();
      await expect(page.getByRole('tabpanel', { name: 'Station', exact: true })).toContainText('Station Settings');
      await station.press('End');
      const languages = tabs.getByRole('tab', { name: 'Languages' });
      await expect(languages).toBeFocused();
      await languages.press('ArrowLeft');
      const design = tabs.getByRole('tab', { name: 'Design' });
      await expect(design).toHaveAttribute('aria-selected', 'true');
      await design.press('Home');
      await expect(settings).toBeFocused();
      await expect(tabs.locator('[tabindex="0"]')).toHaveCount(1);
    });
  });
}

test.describe('figure organization on a touch display', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('move a photo using taps and undo the exact image using a keyboard', async ({ page }) => {
    const fixture = await author(page, draft => {
      const photo = model.createBlock('image');
      photo.data.media = { kind: 'xped', staticPath: model.XPED_ASSETS[1].path };
      photo.data.caption = model.loc('Pauze bij het pad', 'Pause by the path', 'Pause am Weg');
      photo.data.align = 'right';
      photo.data.focalX = 27;
      photo.data.focalY = 71;
      draft.modules[0].steps[0].blocks = [model.createBlock('richtext'), photo];
    });
    const [src, dst] = fixture.exp.modules[0].steps;
    const photo = src.blocks[1];
    await page.locator('.el-pane-btn[data-pane=outline]').tap();
    await stepRow(page, src).tap();
    await blockNode(page, photo).locator('img').tap();
    await page.getByRole('button', { name: 'Block properties' }).tap();
    await page.getByRole('button', { name: 'Move block to another step…' }).tap();
    await page.getByRole('menuitem', { name: /Explanation & video/ }).tap();
    const position = page.getByLabel('Insert position');
    await position.focus();
    await position.press('Home');
    await page.getByRole('button', { name: 'Move block here' }).tap();
    await expect.poll(() => lastSave(fixture)?.modules[0].steps[1].blocks[0].id).toBe(photo.id);
    await page.locator('button[data-pane=canvas]').focus();
    await page.keyboard.press('Control+z');
    await expect.poll(() => lastSave(fixture)?.modules[0].steps[0].blocks[1]).toEqual(photo);
    expect(lastSave(fixture).modules[0].steps[1].blocks.map(b => b.id)).toEqual(dst.blocks.map(b => b.id));
  });
});
