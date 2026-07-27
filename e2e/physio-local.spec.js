const { test, expect } = require('@playwright/test');

const companionUrl = process.env.PHYSIO_COMPANION_URL || 'http://127.0.0.1:8765/physio';
const ownerToken = process.env.PHYSIO_COMPANION_OWNER_TOKEN || '';
const companionBaseUrl = new URL(companionUrl).origin;

function authorizedCompanionUrl() {
  return companionUrl + (ownerToken ? `#owner_token=${encodeURIComponent(ownerToken)}` : '');
}

async function authorizeRequest(request) {
  const response = await request.post(`${companionBaseUrl}/owner-session`, {
    data: { owner_token: ownerToken }
  });
  expect(response.ok()).toBeTruthy();
}

test('local Physio workspace supports shoulder lookup, graph, case workflow and source links', async ({ page }) => {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.goto(authorizedCompanionUrl());

  await expect(page.locator('#portal-hero h1')).toHaveText('Schouder');
  await expect(page.locator('#clinical-connection')).toHaveClass(/is-online/);
  await page.locator('#clinical-search-input').fill('scapula');
  const scapula = page.locator('#search-results [data-note-id="structure-scapula"]').first();
  await expect(scapula).toBeVisible();
  await scapula.click();
  await expect(page.locator('#note-reader .reader-head h2')).toContainText(/scapula/i);
  await expect(page.locator('#note-reader a[href^="obsidian://"]')).toBeVisible();

  await page.getByRole('tab', { name: 'Verbanden' }).click();
  await expect(page.locator('#clinical-graph [data-graph-id]')).not.toHaveCount(0);

  await page.getByRole('tab', { name: 'Casussen' }).click();
  page.once('dialog', (dialog) => dialog.accept('E2E schouder 01'));
  await page.locator('#create-case').click();
  await expect(page.locator('#case-form')).toBeVisible();
  await page.locator('[name="presenting_complaint"]').fill('Pijn bij heffen van de arm');
  await page.locator('[name="notes"]').fill('Actieve elevatie beperkt; hulpvraag is bovenhands reiken.');
  await page.getByRole('button', { name: 'Lokaal opslaan' }).click();

  await page.getByRole('tab', { name: 'Kennisbank' }).click();
  let deepPayload = null;
  await page.route('**/api/local/physio/jobs/deep-query', async (route) => {
    deepPayload = route.request().postDataJSON();
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ job_id: 'e2e-deep' }) });
  });
  await page.route('**/api/local/physio/jobs/e2e-deep', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      job_id: 'e2e-deep', status: 'completed', result: {
        direct_answer: 'Brongebonden antwoord', clinical_application: 'Pas toe in het onderzoek.', conditions_exceptions: [], citations: []
      }
    }) });
  });
  await page.getByRole('button', { name: 'Diep zoeken met Codex' }).click();
  await expect(page.locator('#deep-case-select')).not.toHaveValue('');
  await expect(page.locator('#deep-case-context')).toHaveValue(/Actieve elevatie beperkt/);
  await page.locator('#deep-query-input').fill('Welke hypothese past bij deze presentatie?');
  await page.locator('#run-deep-query').click();
  await expect(page.locator('#deep-answer')).toContainText('Brongebonden antwoord');
  expect(deepPayload.case_context).toContain('Actieve elevatie beperkt');
  expect(deepPayload.query).toBe('Welke hypothese past bij deze presentatie?');
  expect(deepPayload.region).toBe('schouder');
  await page.locator('#deep-dialog [value="cancel"]').click();

  await page.locator('#search-results [data-note-id="structure-scapula"]').first().click();
  await page.locator('#note-reader [data-action="pin"]').click();
  await expect(page.locator('#active-case-summary')).toContainText('1 kennisitem');

  await page.route('**/api/local/physio/jobs/documentation', async (route) => {
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ job_id: 'e2e-doc' }) });
  });
  await page.route('**/api/local/physio/jobs/e2e-doc', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      job_id: 'e2e-doc', status: 'completed', result: {
        document_type: 'soap', draft: { S: 'Pijn bij heffen', O: 'Actieve elevatie beperkt', A: '', P: '' }, citations: []
      }
    }) });
  });
  await page.getByRole('tab', { name: 'Casussen' }).click();
  await page.locator('[data-doc="soap"]').click();
  await expect(page.locator('#documentation-output')).toContainText('Pijn bij heffen');
  await page.locator('#save-document-session').click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Exporteer JSON' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^physio-case-.*\.json$/);

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-delete-case]').click();
  await expect(page.locator('#case-list')).toContainText('Nog geen casussen');
  expect(browserErrors).toEqual([]);
});

test('portal shortcuts, search results and styled controls stay usable in a compact desktop window', async ({ page }) => {
  const browserErrors = [];
  page.on('pageerror', (error) => browserErrors.push(error.message));
  await page.setViewportSize({ width: 885, height: 850 });
  await page.goto(authorizedCompanionUrl());

  await page.locator('#clinical-search-input').fill('scapula');
  const result = page.locator('#search-results [data-note-id="structure-scapula"]').first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.locator('#clinical-context')).toHaveClass(/is-open/);
  await expect(page.locator('#note-reader .reader-head h2')).toContainText(/scapula/i);
  await page.locator('#close-context').click();
  await expect(page.locator('#clinical-context')).not.toHaveClass(/is-open/);

  await page.locator('#region-list [data-region="nek"]').click();
  await expect(page.locator('#portal-hero h1')).toHaveText('Nek');
  await page.locator('#portal-shortcuts [data-section="screening"]').click();
  await expect(page.locator('#clinical-context')).toHaveClass(/is-open/);
  await expect(page.locator('#note-reader .reader-head h2')).toHaveText('Nek');
  await expect(page.locator('#note-reader .reader-body h2').filter({ hasText: /screening/i })).toBeVisible();
  await page.locator('#close-context').click();

  await page.locator('#open-portal-note').click();
  await expect(page.locator('#clinical-context')).toHaveClass(/is-open/);
  await expect(page.locator('#note-reader .reader-head h2')).toHaveText('Nek');
  await page.locator('#close-context').click();

  await expect(page.locator('#include-unreviewed')).toHaveCSS('appearance', 'none');
  await page.getByRole('tab', { name: 'Bronnen beheren' }).click();
  const categoryTrigger = page.locator('#source-upload-category + .pretty-select-trigger');
  await expect(categoryTrigger).toBeVisible();
  await categoryTrigger.click();
  await expect(page.locator('#source-upload-category ~ .pretty-select-menu')).toBeVisible();
  await expect(page.locator('#source-upload-category ~ .pretty-select-menu')).toContainText('Richtlijnen');
  await page.locator('body').click({ position: { x: 10, y: 10 } });
  await page.locator('[data-source-view-mode="region"]').click();
  await expect(page.locator('#source-region-filter-wrap')).toBeVisible();
  await expect(page.locator('#source-view-help')).toContainText('gekozen regio');
  await page.locator('[data-source-view-mode="all"]').click();

  expect(browserErrors).toEqual([]);
});

test('local source endpoint supports browser range requests', async ({ request }) => {
  await authorizeRequest(request);
  const media = await request.get(`${companionBaseUrl}/api/local/physio/media`);
  expect(media.ok()).toBeTruthy();
  const entries = (await media.json()).media;
  const atlas = entries.find((entry) => /atlas-of-anatomy/i.test(entry.title));
  expect(atlas).toBeTruthy();
  const partial = await request.get(`${companionBaseUrl}/api/local/physio/media/${atlas.id}`, {
    headers: { Range: 'bytes=0-1023' }
  });
  expect(partial.status()).toBe(206);
  expect(partial.headers()['content-range']).toMatch(/^bytes 0-1023\//);
});

test('source manager imports, edits, activates and removes a managed source copy', async ({ page }) => {
  await page.goto(authorizedCompanionUrl());
  await page.getByRole('tab', { name: 'Bronnen beheren' }).click();
  await expect(page.locator('#source-dropzone')).toBeVisible();

  await page.locator('#source-file-input').setInputFiles({
    name: 'e2e-physio-source.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('E2E broninhoud voor de lokale bronnenmanager.\n')
  });
  await page.locator('#source-upload-form button[type="submit"]').click();
  await expect(page.locator('#source-upload-progress')).toContainText('lokaal geïmporteerd');

  await page.locator('#source-manager-search').fill('e2e-physio-source');
  const sourceRow = page.locator('#source-manager-list [data-source-id]').first();
  await expect(sourceRow).toBeVisible();
  await sourceRow.click();
  await expect(page.locator('#source-preview-body')).toContainText('E2E broninhoud voor de lokale bronnenmanager.');
  await page.locator('#source-editor-form .source-region-editor input[value="schouder"]').check();
  await page.locator('#source-editor-form [name="title"]').fill('E2E bron aangepast');
  await page.locator('#source-editor-form button[type="submit"]').click();
  await expect(page.locator('#source-editor-form > h2')).toContainText('E2E bron aangepast');
  await expect(page.locator('#source-editor-form .source-region-editor input[value="schouder"]')).toBeChecked();

  await page.locator('[data-source-action="activate"]').click();
  await expect(page.locator('#source-manager-editor .source-status')).toContainText('Actief');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-delete-source]').click();
  await expect(page.locator('#source-manager-list')).toContainText('Geen bronnen voor dit filter');
});
