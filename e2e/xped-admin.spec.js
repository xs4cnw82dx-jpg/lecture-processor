const { test, expect } = require('@playwright/test');
const { signedIn } = require('./helpers/xped-library');
const { editorFixture } = require('./helpers/xped-editor');

test('an admin manages verified-email access, learner settings and aggregate reports from the library', async ({ page, context }, testInfo) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signedIn(page);
  const courses = [
    { id: 'song', title: 'Het eerste lied', role: 'owner' },
    { id: 'scan', title: 'Esther leest haar rugscan', role: 'owner' },
    { id: 'guest', title: 'Invited expedition', role: 'edit' },
  ];
  let lastShareUpdate;
  const data = { share: { enabled: true, token: 'local-test', collectResponses: false }, members: [], grants: [] };
  await page.route('**/api/elearning/expeditions', route => route.fulfill({ json: {
    studioAdmin: route.request().headers().authorization === 'Bearer author', expeditions: courses,
  } }));
  await page.route('**/api/elearning/admin/expeditions/*/sharing', route => {
    const req = route.request();
    const body = req.postDataJSON() || {};
    if (body.action === 'add_member') data.members = [{ email: body.email.toLowerCase(), role: body.role }];
    if (body.action === 'remove_member') data.members = [];
    if (body.action === 'create_grant') data.grants = [{ ...body, id: 'g1', urlPath: '/elearning/translate/local-test' }];
    if (body.action === 'revoke_grant') data.grants = [];
    if (body.action === 'update_public') { lastShareUpdate = body; Object.assign(data.share, body); }
    return route.fulfill({ json: data });
  });
  await page.route('**/api/elearning/admin/statistics', route => route.fulfill({ json: {
    sessions: 4, completed: 3, courses: [{ ...courses[0], sessions: 4, completed: 3 }, { ...courses[1], sessions: 0, completed: 0 }],
  } }));
  await page.goto('/physio/elearning');
  await page.getByRole('button', { name: 'Admin', exact: true }).click();
  const admin = page.getByRole('dialog', { name: 'Studio admin' });
  await expect(admin.locator('#el-admin-course option')).toHaveCount(2);
  await admin.getByLabel('Email address').fill('Future@example.com');
  await admin.getByRole('combobox', { name: 'Role', exact: true }).selectOption('translate');
  await admin.getByRole('button', { name: 'Save access' }).click();
  const member = admin.getByRole('listitem').filter({ hasText: 'future@example.com' });
  await expect(member).toContainText('Translator');
  await member.getByRole('button', { name: 'Change role' }).click();
  await admin.getByRole('combobox', { name: 'Role', exact: true }).selectOption('edit');
  await admin.getByRole('button', { name: 'Save access' }).click();
  await expect(member).toContainText('Co-Editor');
  await page.screenshot({ path: testInfo.outputPath('admin-access-desktop.png'), animations: 'disabled' });
  await admin.getByRole('button', { name: 'Copy collaborator link' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('/song/edit');
  await member.getByRole('button', { name: 'Remove' }).click();
  await member.getByRole('button', { name: 'Confirm removal' }).click();
  await expect(member).toHaveCount(0);
  await admin.getByText('External translator links', { exact: true }).click();
  await admin.getByLabel('Recipient name').fill('Sam');
  await admin.getByRole('button', { name: 'Create Link' }).click();
  const grant = admin.getByRole('listitem').filter({ hasText: 'Sam' });
  await grant.getByRole('button', { name: 'Copy link' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('/elearning/translate/local-test');
  await grant.getByRole('button', { name: 'Revoke' }).click();
  await grant.getByRole('button', { name: 'Confirm removal' }).click();
  await expect(grant).toHaveCount(0);
  await admin.getByText('Learner link & data collection', { exact: true }).click();
  await expect(admin.getByLabel('Collect pilot feedback')).toBeDisabled();
  await admin.getByLabel('Offer learners the choice to share responses').check();
  await admin.getByLabel('Collect pilot feedback').check();
  await admin.getByRole('button', { name: 'Save learner settings' }).click();
  await expect.poll(() => data.share.collectPilotFeedback).toBe(true);
  expect(lastShareUpdate).toEqual({ action: 'update_public', collectResponses: true, collectPilotFeedback: true });
  await admin.getByRole('button', { name: 'Statistics' }).click();
  await expect(admin.locator('#el-admin-totals')).toContainText('75%');
  await expect(admin.getByRole('listitem').filter({ hasText: 'Het eerste lied' }).getByRole('link')).toHaveAttribute('href', '/physio/elearning/song/responses');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('admin-statistics-phone.png'), animations: 'disabled' });
  expect(await admin.evaluate(d => d.scrollWidth <= d.clientWidth)).toBe(true);
  await page.evaluate(() => window.switchAccount('other'));
  await expect(admin).toBeHidden();
  await expect(page.getByRole('button', { name: 'Admin', exact: true })).toBeHidden();
  await expect(page.locator('#el-admin-breakdown')).toBeEmpty();
});

test('the builder role selector works on a phone and the content download reimports as course JSON', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { exp } = await editorFixture(page);
  await page.route('**/api/elearning/expeditions/visual/sharing', route => route.fulfill({ json: { share: { enabled: false }, members: [], grants: [] } }));
  await page.route('**/api/elearning/expeditions/visual/content-export', route => route.fulfill({
    json: { course: { title: { nl: 'Onderweg' }, modules: [] }, excludedUploads: 1 },
  }));
  await page.goto('/physio/elearning/visual/edit?panel=sharing');
  await page.getByRole('tab', { name: 'Collaborators' }).click();
  const roles = page.getByRole('combobox', { name: 'Collaborator role' });
  await expect(roles.locator('option')).toHaveText(['Co-Editor', 'Translator']);
  await roles.selectOption({ label: 'Translator' });
  await expect(roles).toHaveValue('translate');
  await page.getByRole('tab', { name: 'Translators' }).click();
  const row = page.locator('#el-panel-translators .el-share-inline-row');
  expect(await row.evaluate(r => r.getBoundingClientRect().top - r.previousElementSibling.getBoundingClientRect().bottom)).toBeGreaterThanOrEqual(6);
  await page.screenshot({ path: testInfo.outputPath('builder-translator-phone.png'), animations: 'disabled' });
  await page.locator('#el-share-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByRole('button', { name: 'More expedition actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export course content' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Export without uploaded files?' });
  await expect(confirmation).toContainText('Reattach');
  const download = page.waitForEvent('download');
  await confirmation.getByRole('button', { name: 'Export course content' }).click();
  expect((await download).suggestedFilename()).toBe(exp.title.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-content.json');
});
