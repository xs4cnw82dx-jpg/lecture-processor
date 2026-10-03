const { expectProductControls } = require('./helpers/control-audit');
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
  await page.route('**/api/local/physio/notes/structure-scapula', async route => {
    const response = await route.fetch();
    const note = await response.json();
    (note.note || note).embeds = [{id:'atlas-of-anatomy',title:'Anatomie atlas',page:1}];
    await route.fulfill({response,json:note});
  });
  const content = 'BT /F1 22 Tf 60 760 Td (Anatomy reference) Tj 0 -36 Td /F1 12 Tf (Local document preview - test fixture) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10,'0') + ' 00000 n ').join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await page.route('**/api/local/physio/media/atlas-of-anatomy', route => route.fulfill({contentType:'application/pdf',body:pdf}));
  await page.goto(authorizedCompanionUrl());

  await expect(page.locator('#portal-hero h1')).toHaveText('Schouder');
  await expect(page.locator('#clinical-connection')).toHaveClass(/is-online/);
  await page.locator('#clinical-search-input').fill('scapula');
  const scapula = page.locator('#search-results [data-note-id="structure-scapula"]').first();
  await expect(scapula).toBeVisible();
  await scapula.click();
  await expect(page.locator('#note-reader .reader-head h2')).toContainText(/scapula/i);
  await expect(page.locator('#note-reader a[href^="obsidian://"]')).toBeVisible();
  await page.locator('#note-reader [data-media-id]').first().click();
  await expect(page.locator('#media-dialog .physio-document-toolbar')).toBeVisible();
  await expect(page.locator('#media-dialog .physio-document-toolbar > strong')).toContainText('Anatomie atlas');
  await expect(page.locator('#media-dialog iframe')).toHaveAttribute('src', /toolbar=0&navpanes=0/);
  await expect(page.locator('#media-dialog a[download]')).toHaveText('Download origineel');
  await expect(page.locator('#media-dialog a[target="_blank"]')).toHaveText('Open volledig document');
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    await expectProductControls(page);
    await page.screenshot({path:`/tmp/redesign-secondary-evidence/physio-pdf-preview-${width}.png`,animations:'disabled'});
  }
  await page.locator('#media-dialog [value="close"]').click();
  await page.setViewportSize({width:1280,height:900});

  await page.getByRole('tab', { name: 'Verbanden' }).click();
  await expect(page.locator('#clinical-graph [data-graph-id]')).not.toHaveCount(0);

  await page.getByRole('tab', { name: 'Casussen' }).click();
  await page.locator('#create-case').click();
  await page.getByLabel('Casuslabel (bijv. S01 schouder)').fill('E2E schouder 01');
  await page.getByRole('button', {name:'Casus aanmaken', exact:true}).click();
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

  await page.locator('[data-delete-case]').click();
  await page.getByRole('dialog').getByRole('button', {name:'Permanent verwijderen', exact:true}).click();
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
  const categoryTrigger = page.locator('#source-upload-category-button');
  await expect(categoryTrigger).toBeVisible();
  await categoryTrigger.click();
  await expect(page.locator('#source-upload-category-menu')).toBeVisible();
  await expect(page.locator('#source-upload-category-menu')).toContainText('Richtlijnen');
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

test('local source audio preview uses website playback controls', async ({ page }) => {
  const wav = Buffer.alloc(44 + 64000);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(64000, 40);
  await page.route('**/api/local/physio/sources-manager?*', route => route.fulfill({json:{sources:[{
    id:'audio-preview', title:'Anatomie toelichting', original_filename:'anatomie.wav', suffix:'.wav', review_status:'active', source_type:'audio', category:'college', regions:['schouder'],
  }], total:1, categories:['college']}}));
  await page.route('**/api/local/physio/sources-manager/audio-preview/preview', route => route.fulfill({contentType:'audio/wav', body:wav}));
  await page.goto(authorizedCompanionUrl());
  await page.getByRole('tab', {name:'Bronnen beheren'}).click();
  await page.locator('[data-source-id="audio-preview"]').click();
  const preview = page.locator('#source-preview-body');
  await expect(preview.locator('audio')).toHaveJSProperty('controls', false);
  await expect(preview.locator('audio')).toHaveJSProperty('duration', 4);
  await expect(preview.getByRole('button', {name:'Play', exact:true})).toBeVisible();
  await expectProductControls(page);
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    await preview.scrollIntoViewIfNeeded();
    await page.screenshot({path:`/tmp/redesign-secondary-evidence/physio-audio-${width}.png`,animations:'disabled'});
  }
  await preview.getByRole('button', {name:'Play', exact:true}).click();
  await expect(preview.locator('audio')).toHaveJSProperty('paused', false);
  await preview.getByRole('button', {name:'Pause', exact:true}).click();
  await expect(preview.locator('audio')).toHaveJSProperty('paused', true);
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
  await page.locator('[data-delete-source]').click();
  await page.getByRole('dialog').getByRole('button', {name:'Permanent verwijderen', exact:true}).click();
  await expect(page.locator('#source-manager-list')).toContainText('Geen bronnen voor dit filter');
});

test('Physio layouts reflow and cases use a cancellable website dialog', async ({page}) => {
  await page.goto(authorizedCompanionUrl());
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({width, height:900});
    await expectProductControls(page);
    for (const name of ['Kennisbank', 'Bronnen beheren', 'Verbanden', 'Casussen']) {
      await page.getByRole('tab', {name, exact:true}).click();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({path: `/tmp/redesign-secondary-evidence/physio-${name.replace(/ /g,'-')}-${width}.png`, fullPage:true, animations:'disabled'});
    }
  }
  await page.locator('#create-case').click();
  await expect(page.getByRole('dialog')).toContainText('Nieuwe lokale casus');
  await page.getByRole('button', {name:'Annuleren', exact:true}).click();
  await expect(page.locator('#create-case')).toBeFocused();
});
