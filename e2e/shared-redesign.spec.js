const { test, expect } = require('@playwright/test');
const path = require('node:path');
const fs = require('node:fs');
const { installAccountFixture } = require('./helpers/batch-fixture');
const { expectProductControls } = require('./helpers/control-audit');
test.use({ serviceWorkers: 'block' });
const evidence = '/tmp/redesign-public-evidence';
fs.mkdirSync(evidence, { recursive: true });

async function controls(page) {
  await page.goto('/FAQ');
  await page.evaluate(() => {
    const host = document.createElement('section');
    host.id = 'control-fixture';
    host.innerHTML = '<button id="launch">Open dialog</button><label>Subject<select id="subject" data-app-select><option>All subjects</option><option>Biology</option></select></label><label for="lesson-date">Lesson date</label><input id="lesson-date" type="date" data-app-date min="2026-10-03" max="2026-11-10" value="2026-10-10"><label for="long-select">Long list</label><select data-app-select id="long-select">' + Array.from({length:10},(_,i)=>'<option>Option '+i+'</option>').join('') + '</select>';
    document.querySelector('main').prepend(host);
    document.getElementById('launch').onclick = async () => {
      window.dialogResult = await window.LectureProcessorUx.requestDialog({ title: 'Name this folder', message: 'Use a name you can recognize.', inputLabel: 'Folder name', inputValue: 'My notes', confirmLabel: 'Create folder' });
    };
  });
}

test('shared selectors preserve field labels, search and native changes', async ({ page }) => {
  await controls(page);
  await expect(page.getByRole('button', { name: 'Subject All subjects', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Subject All subjects', exact: true }).click();
  await page.getByRole('option', { name: 'Biology' }).click();
  await expect(page.locator('#subject')).toHaveValue('Biology');
  await page.locator('#long-select-button').click();
  const originalMenuHeight = await page.locator('#long-select-menu').evaluate(menu => parseFloat(getComputedStyle(menu).maxHeight));
  await page.getByRole('searchbox', { name: 'Search options' }).fill('no matching subject');
  await expect(page.getByText('No options found. Try another search.')).toBeVisible();
  await page.getByRole('searchbox', { name: 'Search options' }).press('Escape');
  await expect(page.locator('#long-select-menu')).toBeHidden();
  await page.locator('#long-select-button').click();
  expect(await page.locator('#long-select-menu').evaluate(menu => parseFloat(getComputedStyle(menu).maxHeight))).toBeGreaterThanOrEqual(originalMenuHeight);
  await page.getByRole('searchbox', { name: 'Search options' }).fill('Option 8');
  await expect(page.getByRole('option', { name: 'Option 8' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Option 2' })).toBeHidden();
  await page.getByRole('searchbox').press('ArrowDown');
  await page.getByRole('option', { name: 'Option 8' }).press('Enter');
  await expect(page.locator('#long-select')).toHaveValue('Option 8');
  await expect(page.locator('#long-select-button')).toBeFocused();
});

test('calendar has boundaries, keyboard week movement, native events and focus return', async ({ page }) => {
  await controls(page);
  await page.evaluate(() => { window.dateChanges = 0; document.getElementById('lesson-date').addEventListener('change', () => window.dateChanges++); });
  const trigger = page.getByRole('button', { name: 'Lesson date: 10 Oct 2026', exact: true });
  await trigger.click();
  await expect(page.getByRole('button', { name: 'Friday, 2 October 2026', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Saturday, 10 October 2026', exact: true }).press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Saturday, 17 October 2026', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Saturday, 17 October 2026', exact: true }).press('Enter');
  await expect(page.locator('#lesson-date')).toHaveValue('2026-10-17');
  expect(await page.evaluate(() => window.dateChanges)).toBe(1);
  await expect(page.getByRole('button', { name: 'Lesson date: 17 Oct 2026', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Lesson date: 17 Oct 2026', exact: true }).click();
  await page.getByRole('button', { name: 'Saturday, 17 October 2026', exact: true }).press('Escape');
  await expect(page.getByRole('dialog', { name: 'Choose a date' })).toBeHidden();
});

test('calendar month buttons stay open after replacing the clicked button', async ({ page }) => {
  await controls(page);
  await page.getByRole('button', { name: 'Lesson date: 10 Oct 2026', exact: true }).click();
  const panel = page.getByRole('dialog', { name: 'Choose a date' });
  await panel.getByRole('button', { name: 'Next month', exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('strong')).toHaveText('November 2026');
  await panel.getByRole('button', { name: 'Previous month', exact: true }).click();
  await expect(panel).toBeVisible();
  await expect(panel.locator('strong')).toHaveText('October 2026');
  await panel.getByRole('button', { name: 'Previous month', exact: true }).click();
  await expect(panel.locator('strong')).toHaveText('September 2026');
  await expect(panel.locator('[data-date]:not(:disabled)')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Previous month', exact: true })).toBeFocused();
  await panel.getByRole('button', { name: 'Next month', exact: true }).press('Enter');
  await expect(panel.locator('strong')).toHaveText('October 2026');
  await expect(panel.getByRole('button', { name: 'Next month', exact: true })).toBeFocused();
  await panel.getByRole('button', { name: 'Sunday, 18 October 2026', exact: true }).click();
  await expect(page.locator('#lesson-date')).toHaveValue('2026-10-18');
  await expect(panel).toBeHidden();
});

test('shared prompt traps focus, restores it and resolves cancel or trimmed value', async ({ page }) => {
  await controls(page);
  await page.locator('#launch').click();
  await expect(page.getByRole('textbox', { name: 'Folder name' })).toBeFocused();
  await page.getByRole('textbox', { name: 'Folder name' }).fill('  Review  ');
  await page.getByRole('textbox', { name: 'Folder name' }).press('Enter');
  await expect(page.getByRole('dialog', { name: 'Name this folder' })).toBeHidden();
  expect(await page.evaluate(() => window.dialogResult)).toBe('Review');
  await expect(page.locator('#launch')).toBeFocused();
  await page.locator('#launch').click();
  await page.getByRole('textbox', { name: 'Folder name' }).press('Escape');
  await expect(page.getByRole('dialog', { name: 'Name this folder' })).toBeHidden();
  expect(await page.evaluate(() => window.dialogResult)).toBeNull();
});

test('FAQ opens and closes and feature sample and calculator work', async ({ page }) => {
  await page.goto('/FAQ');
  await expect(page.getByRole('navigation', { name: 'Question topics' })).toHaveCSS('display', 'flex');
  const question = page.locator('.faq-item').first();
  await question.locator('summary').click();
  await expect(question).toHaveAttribute('open', '');
  await expect(question.locator('p')).toBeVisible();
  await question.locator('summary').click();
  await expect(question).not.toHaveAttribute('open', '');
  await page.goto('/features');
  await page.locator('#feature-sample-card').click();
  await expect(page.locator('#feature-card-text')).toContainText('Retrieving information');
  await page.locator('#calculator > summary').click();
  await page.locator('#calc-lectures').fill('10');
  await expect(page.locator('#calc-manual')).toHaveText('100h');
});

for (const width of [1440, 1024, 768, 390]) {
  test(`public and credit compositions at ${width}px`, async ({ page }) => {
    await installAccountFixture(page);
    await page.setViewportSize({ width, height: 1000 });
    for (const route of ['/', '/features', '/helpcenter', '/FAQ', '/privacy', '/terms', '/buy_credits']) {
      await page.goto(route);
      await expect(page.locator('h1')).toBeVisible();
      await expectProductControls(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), route).toBe(true);
      await page.screenshot({ path: path.join(evidence, `${route.replaceAll('/','') || 'landing'}-${width}.png`), fullPage: true });
    }
  });
}

test('payment pending stays visible and check-again confirms without another checkout', async ({ page }) => {
  const fixture = await installAccountFixture(page);
  let confirmations = 0;
  await page.route('**/api/confirm-checkout-session?*', route => {
    confirmations++;
    return route.fulfill({ contentType:'application/json', body: JSON.stringify(confirmations === 1 ? {status:'pending_payment'} : {status:'granted'}), status: confirmations === 1 ? 409 : 200 });
  });
  await page.goto('/buy_credits?payment=success&session_id=test-session');
  await expect(page.locator('#payment-result')).toContainText('Waiting for confirmation');
  await page.getByRole('button', { name: 'Check again' }).click();
  await expect(page.locator('#payment-result')).toContainText('Payment confirmed');
  expect(confirmations).toBe(2);
  expect(fixture.requests.some(r => r.path === '/api/create-checkout-session')).toBe(false);
  expect(fixture.browserErrors).toEqual([]);
});

test('checkout return resumes confirmation after signing in', async ({ page }) => {
  await installAccountFixture(page);
  await page.addInitScript(() => { window.testAccount.switchTo(null); });
  let confirmations = 0;
  await page.route('**/api/confirm-checkout-session?*', route => { confirmations++; return route.fulfill({contentType:'application/json',body:'{"status":"granted"}'}); });
  await page.goto('/buy_credits?payment=success&session_id=return-after-signin');
  await expect(page.locator('#payment-result')).toContainText('Sign in to apply');
  expect(confirmations).toBe(0);
  await page.evaluate(() => window.testAccount.switchTo('a'));
  await expect(page.locator('#payment-result')).toContainText('Payment confirmed');
  expect(confirmations).toBe(1);
});

test('nested picker Escape closes the menu before its dialog', async ({ page }) => {
  await controls(page);
  await page.locator('#launch').click();
  await page.evaluate(() => {
    const form = document.querySelector('.app-request-dialog');
    const label = document.createElement('label');
    label.textContent = 'Destination';
    const select = document.createElement('select');
    select.id = 'dialog-select'; select.dataset.appSelect = '';
    select.innerHTML = '<option>First folder</option><option>Second folder</option>';
    label.appendChild(select); form.insertBefore(label, form.lastChild);
  });
  await page.locator('#dialog-select-button').click();
  await page.getByRole('option', {name:'First folder',exact:true}).press('Escape');
  await expect(page.getByRole('dialog', {name:'Name this folder'})).toBeVisible();
  await expect(page.locator('#dialog-select-button')).toBeFocused();
  await page.locator('#dialog-select-button').press('Escape');
  await expect(page.getByRole('dialog', {name:'Name this folder'})).toBeHidden();
});

test('reduced motion and narrow layouts keep dialogs and error recovery usable', async ({ page }) => {
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.setViewportSize({width:640,height:450});
  await controls(page);
  await page.locator('#launch').click();
  await expect(page.getByRole('button',{name:'Create folder',exact:true})).toBeInViewport();
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.goto('/page-that-does-not-exist');
  await expect(page.getByRole('heading',{name:'We could not find this page'})).toBeVisible();
  await page.getByRole('link',{name:'Go to your workspace'}).scrollIntoViewIfNeeded();
  await expect(page.getByRole('link',{name:'Go to your workspace'})).toBeInViewport();
  await page.screenshot({path:path.join(evidence,'error-640.png'),fullPage:true});
});

test('rapid modal reopen cancels the prior closing animation', async ({page}) => {
  await page.goto('/FAQ');
  await page.evaluate(async () => {
    const overlay = document.createElement('div'); overlay.className = 'app-request-overlay'; overlay.id = 'race-overlay';
    overlay.innerHTML = '<div class="app-request-dialog" role="dialog" aria-label="Race"><button>Action</button></div>';
    document.body.appendChild(overlay);
    const ux = window.LectureProcessorUx;
    ux.openModalOverlay(overlay, {openClass:'visible'});
    ux.closeModalOverlay(overlay, {openClass:'visible'});
    ux.openModalOverlay(overlay, {openClass:'visible'});
    if (overlay._surfaceAnimation) await overlay._surfaceAnimation.finished;
  });
  await expect(page.locator('#race-overlay')).toBeVisible();
  await expect(page.locator('#race-overlay')).toHaveClass(/visible/);
  await expect(page.getByRole('button',{name:'Action',exact:true})).toBeFocused();
});

test('searchable selector Enter cannot submit its form and Home keeps text focus', async ({page}) => {
  await controls(page);
  await page.evaluate(() => {
    const host = document.querySelector('#long-select').parentElement;
    const form = document.createElement('form');
    host.before(form); form.appendChild(host);
    window.unexpectedSubmissions = 0;
    form.addEventListener('submit',event => {event.preventDefault(); window.unexpectedSubmissions++;});
  });
  await page.locator('#long-select-button').click();
  await page.getByRole('searchbox').fill('Option 8');
  await page.getByRole('searchbox').press('Home');
  await expect(page.getByRole('searchbox')).toBeFocused();
  await page.getByRole('searchbox').press('Enter');
  await expect(page.locator('#long-select')).toHaveValue('Option 8');
  expect(await page.evaluate(()=>window.unexpectedSubmissions)).toBe(0);
});

test('shared action menus have custom triggers, anchored panels and reversible closing motion', async ({ page }) => {
  await controls(page);
  await page.evaluate(() => {
    const host = document.getElementById('control-fixture');
    host.insertAdjacentHTML('beforeend', '<details id="actions-fixture" data-app-menu><summary>More actions</summary><div class="app-menu-panel"><button type="button">Rename item</button><button type="button">Duplicate item</button><button type="button" class="danger">Remove item</button></div></details><details id="accordion-fixture"><summary>Advanced options</summary><p>Choose the settings for this project.</p><label>Include notes<input type="checkbox" id="notes-checkbox"></label></details>');
  });
  const menu = page.locator('#actions-fixture');
  const trigger = menu.locator('summary');
  const panel = menu.locator('.app-menu-panel');
  await expect(trigger.locator('.app-disclosure-chevron')).toHaveCount(1);
  expect(await trigger.evaluate(node => getComputedStyle(node).listStyleType)).toBe('none');
  await trigger.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name:'Rename item' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name:'Duplicate item' })).toBeFocused();
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  expect(box.width).toBeGreaterThan(200);
  expect(box.x).toBeGreaterThanOrEqual(0);
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(menu).not.toHaveAttribute('open');
  await expect(panel).toBeHidden();
  await trigger.press('ArrowDown');
  await page.getByRole('menuitem', { name:'Rename item' }).press('Enter');
  await expect(trigger).toBeFocused();
  await expect(panel).toBeHidden();
  await trigger.click();
  await trigger.click();
  await trigger.click();
  await expect(panel).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-expanded','true');
  await page.locator('#subject-button').click();
  await expect(menu).not.toHaveAttribute('open');
  const accordion = page.locator('#accordion-fixture');
  await accordion.locator('summary').click();
  await expect(accordion.locator('p')).toBeVisible();
  await accordion.locator('summary').click();
  await expect(accordion).not.toHaveAttribute('open');
  await accordion.locator('summary').click();
  await expect(page.locator('#notes-checkbox')).toHaveClass(/app-checkbox-field/);
  await page.locator('#notes-checkbox').check();
  await expect(page.locator('#notes-checkbox')).toBeChecked();
});

test('shared action menus respect reduced motion and nested modal Escape', async ({ page }) => {
  await page.emulateMedia({ reducedMotion:'reduce' });
  await controls(page);
  await page.locator('#launch').click();
  await page.evaluate(() => {
    document.querySelector('.app-request-dialog').insertAdjacentHTML('beforeend','<details data-app-menu id="nested-actions"><summary>More actions</summary><div class="app-menu-panel"><button type="button">Copy name</button></div></details>');
  });
  const trigger=page.locator('#nested-actions > summary');
  await trigger.click();
  await page.getByRole('menuitem',{name:'Copy name'}).focus();
  await page.keyboard.press('Escape');
  await expect(page.locator('#nested-actions')).not.toHaveAttribute('open');
  await expect(page.getByRole('dialog',{name:'Name this folder'})).toBeVisible();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog',{name:'Name this folder'})).toBeHidden();
});

test('constraint validation blocks invalid submission with inline feedback and accessible focus', async ({page}) => {
  await controls(page);
  await page.evaluate(() => {
    const form=document.createElement('form'); form.id='validation-fixture';
    form.innerHTML='<label for="required-name">Name</label><input id="required-name" required aria-describedby="name-help"><span id="name-help">Use your first name.</span><label for="minimum-count">Count</label><input id="minimum-count" type="number" min="2" value="1"><button>Save form</button>';
    form.addEventListener('submit', event=>{event.preventDefault();window.validSubmissions=(window.validSubmissions||0)+1;});
    form.addEventListener('invalid', event=>{window.invalidDefaultPrevented=event.defaultPrevented;},true);
    document.querySelector('main').prepend(form);
  });
  await page.getByRole('button',{name:'Save form',exact:true}).click();
  await expect(page.locator('#required-name')).toBeFocused();
  await expect(page.locator('.app-validation-error')).toHaveCount(2);
  await expect(page.locator('#required-name')).toHaveAttribute('aria-invalid','true');
  expect(await page.evaluate(()=>window.invalidDefaultPrevented)).toBe(true);
  expect(await page.evaluate(()=>window.validSubmissions||0)).toBe(0);
  await page.locator('#required-name').fill('Sam');
  await expect(page.locator('#required-name')).not.toHaveAttribute('aria-invalid');
  await expect(page.locator('#required-name')).toHaveAttribute('aria-describedby','name-help');
  await page.getByRole('button',{name:'Save form',exact:true}).click();
  await expect(page.locator('#minimum-count')).toBeFocused();
  expect(await page.evaluate(()=>window.validSubmissions||0)).toBe(0);
  await page.locator('#minimum-count').fill('2');
  await expect(page.locator('.app-validation-error')).toHaveCount(0);
  await page.getByRole('button',{name:'Save form',exact:true}).click();
  expect(await page.evaluate(()=>window.validSubmissions)).toBe(1);
});

test('constraint feedback focuses enhanced select and date controls', async ({page}) => {
  await controls(page);
  await page.evaluate(() => {
    const form=document.createElement('form'); form.id='enhanced-validation';
    form.innerHTML='<label for="required-subject">Required subject</label><select id="required-subject" data-app-select required><option value="">Choose subject</option><option value="biology">Biology</option></select><label for="required-date">Required date</label><input id="required-date" type="date" data-app-date required><button>Save choices</button>';
    form.addEventListener('submit',event=>event.preventDefault()); document.querySelector('main').prepend(form);
  });
  await expect(page.locator('#required-subject-button')).toBeVisible();
  await page.getByRole('button',{name:'Save choices',exact:true}).click();
  await expect(page.locator('#required-subject-button')).toBeFocused();
  await expect(page.locator('#required-subject-button')).toHaveAttribute('aria-invalid','true');
  await page.locator('#required-subject-button').click();
  await page.getByRole('option',{name:'Biology',exact:true}).click();
  await expect(page.locator('#required-subject-button')).not.toHaveAttribute('aria-invalid');
  await page.getByRole('button',{name:'Save choices',exact:true}).click();
  const trigger=page.locator('#required-date + .app-date .app-date-trigger');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-invalid','true');
});
