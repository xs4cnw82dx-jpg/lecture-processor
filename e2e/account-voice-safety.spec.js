const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

test.use({ serviceWorkers: 'block' });

const { installAccountFixture } = require('./helpers/batch-fixture');

async function installVoiceFixture(page) {
  const fixture = await installAccountFixture(page);
  await page.addInitScript(() => {
    window.voiceOnline = true;
    Object.defineProperty(navigator, 'onLine', { get: () => window.voiceOnline });
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === window.failVoiceStore) throw new DOMException('Device storage is full', 'QuotaExceededError');
      return put.apply(this, args);
    };
    window.voiceTracksStopped = 0;
    window.testRecorders = [];
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: async () => ({
      getTracks: () => [{ stop: () => { window.voiceTracksStopped++; } }],
    }) } });
    window.MediaRecorder = class {
      static isTypeSupported() { return true; }
      constructor() { this.state = 'inactive'; this.mimeType = 'audio/webm'; window.testRecorders.push(this); }
      start() { this.state = 'recording'; }
      stop() {
        this.state = 'inactive';
        this.ondataavailable({ data: new Blob(['recorded audio'], { type: this.mimeType }) });
        queueMicrotask(() => this.onstop());
      }
    };
  });
  await page.route('**/api/voice-notes', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    fixture.requests.push({ path: '/api/voice-notes', method: 'POST', authorization: route.request().headers().authorization });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ job_id: 'test-voice-job' }) });
  });
  await page.route('**/api/voice-notes/jobs/test-voice-job', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    status: 'complete', study_pack_id: 'saved-voice', title: 'Recovered voice note', transcript: 'Recovered transcript',
  }) }));
  await page.route('**/api/study-packs/saved-voice', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({
    study_pack_id: 'saved-voice', title: 'Recovered voice note', source_transcript: 'Recovered transcript',
  }) }));
  return fixture;
}

async function savedVoiceData(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('lecture-processor-voice-notes', 2);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (name) => new Promise((resolve, reject) => {
      const tx = db.transaction(name, 'readonly');
      const request = tx.objectStore(name).getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const notes = await read('notes');
    const audio = await read('audio');
    db.close();
    return { notes, audio: await Promise.all(audio.map(async (row) => ({ id: row.id, owner_key: row.owner_key, size: row.blob.size, text: await row.blob.text() }))) };
  });
}

test('purchase history clears on account switch and delayed A responses cannot replace B history', async ({ page }) => {
  const fixture = await installAccountFixture(page);
  let releaseA;
  const delayed = new Promise((resolve) => { releaseA = resolve; });
  let requestedA = false;
  await page.route('**/api/purchase-history', async (route) => {
    const isA = route.request().headers().authorization === 'Bearer token-a';
    if (isA) { requestedA = true; await delayed; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ purchases: [{ bundle_name: isA ? 'Private A purchase' : 'B purchase', price_cents: 500 }] }) });
  });
  await page.goto('/buy_credits');
  await expect.poll(() => requestedA).toBe(true);
  await page.evaluate(() => window.testAccount.switchTo(null));
  await expect(page.locator('#purchase-history-list')).toContainText('Sign in');
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#purchase-history-list')).toContainText('B purchase');
  releaseA();
  await expect(page.locator('#purchase-history-list')).not.toContainText('Private A');
  await page.locator('#refresh-purchase-history-btn').click();
  await expect(page.locator('#purchase-history-list')).toContainText('B purchase');
  expect(fixture.browserErrors).toEqual([]);
});

test('checkout waiting for a token is abandoned when the account changes', async ({ page }) => {
  const fixture = await installAccountFixture(page);
  await page.goto('/buy_credits');
  await expect(page.locator('#purchase-history-list')).toContainText('No purchases');
  await page.evaluate(() => {
    window.testAccount.currentUser.getIdToken = () => new Promise((resolve) => { window.resolveCheckoutToken = resolve; });
  });
  await page.locator('.bundle-buy-btn').first().click();
  await expect.poll(() => page.evaluate(() => typeof window.resolveCheckoutToken)).toBe('function');
  await page.evaluate(() => { window.testAccount.switchTo('b'); window.resolveCheckoutToken('token-a'); });
  await expect(page.locator('.bundle-buy-btn').first()).toBeEnabled();
  expect(fixture.requests.filter((request) => request.path === '/api/create-checkout-session')).toEqual([]);
  expect(fixture.browserErrors).toEqual([]);
});

test('batch dashboard removes private rows immediately and ignores a pending old-account refresh', async ({ page }) => {
  const fixture = await installAccountFixture(page);
  let delayA = false;
  let pendingA = false;
  let releaseA;
  const delayed = new Promise((resolve) => { releaseA = resolve; });
  await page.route('**/api/batch/jobs?*', async (route) => {
    const isA = route.request().headers().authorization === 'Bearer token-a';
    if (isA && delayA) { pendingA = true; await delayed; }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ batches: [{ batch_id: isA ? 'batch-a' : 'batch-b', batch_title: isA ? 'Private A batch' : 'B batch', mode: 'lecture-notes', status: 'complete', total_rows: 2, completed_rows: 2 }] }) });
  });
  await page.goto('/batch_status');
  await expect(page.locator('#batch-dashboard-rows')).toContainText('Private A batch');
  delayA = true;
  await page.locator('#batch-dashboard-refresh-btn').click();
  await expect.poll(() => pendingA).toBe(true);
  await page.evaluate(() => window.testAccount.switchTo(null));
  await expect(page.locator('#batch-dashboard-rows')).not.toContainText('Private A');
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#batch-dashboard-rows')).toContainText('B batch');
  releaseA();
  await expect(page.locator('#batch-dashboard-rows')).not.toContainText('Private A');
  expect(fixture.browserErrors).toEqual([]);
});

test('batch details clear when a different user enters the open page', async ({ page }) => {
  const fixture = await installAccountFixture(page);
  await page.route('**/api/batch/jobs/private-batch?*', (route) => route.fulfill({
    status: route.request().headers().authorization === 'Bearer token-a' ? 200 : 403,
    contentType: 'application/json', body: JSON.stringify(route.request().headers().authorization === 'Bearer token-a' ? {
      batch_id: 'private-batch', batch_title: 'Private A batch', status: 'error', total_rows: 2,
      error_message: 'Private A result', rows: [],
    } : { error: 'Not authorized' })
  }));
  await page.goto('/batch_mode?batch_id=private-batch');
  await expect(page).toHaveURL(/batch_status\/private-batch/);
  await expect(page.locator('#batch-detail')).toContainText('Private A result');
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#batch-detail')).not.toContainText('Private A');
  await expect(page.locator('#batch-detail')).toContainText('Not authorized');
  expect(fixture.browserErrors).toEqual([]);
});

for (const failedStore of ['audio', 'notes']) {
  test(`import preserves downloadable audio when ${failedStore} storage fails, then retries without duplicates`, async ({ page }) => {
    const fixture = await installVoiceFixture(page);
    await page.goto('/voice-notes');
    await page.evaluate((store) => { window.failVoiceStore = store; }, failedStore);
    await page.locator('#voice-file-input').setInputFiles({ name: 'important.webm', mimeType: 'audio/webm', buffer: Buffer.from('important recording bytes') });
    await expect(page.locator('#voice-save-recovery')).toBeVisible();
    await expect(page.locator('#voice-save-message')).toContainText('could not be saved');
    await expect(page.locator('#voice-record-status')).not.toContainText('Saved locally');
    await expect(page.locator('#voice-record-btn')).toBeDisabled();
    await expect(page.locator('#voice-import-btn')).toBeDisabled();
    expect(await savedVoiceData(page)).toEqual({ notes: [], audio: [] });
    expect(fixture.requests.filter((request) => request.method === 'POST' && request.path === '/api/voice-notes')).toHaveLength(0);

    const downloadEvent = page.waitForEvent('download');
    await page.locator('#voice-download-unsaved-btn').click();
    const download = await downloadEvent;
    expect(fs.readFileSync(await download.path(), 'utf8')).toBe('important recording bytes');
    await page.evaluate(() => { window.failVoiceStore = ''; });
    await page.locator('#voice-retry-save-btn').click();
    await expect(page.locator('#voice-save-recovery')).toBeHidden();
    await expect(page.locator('#voice-record-status')).toContainText('Transcript ready');
    const saved = await savedVoiceData(page);
    expect(saved.notes).toHaveLength(1);
    expect(saved.notes[0].owner_key).toBe('user:a');
    expect(saved.audio).toHaveLength(1);
    expect(saved.audio[0].size).toBe(25);
    expect(fixture.requests.filter((request) => request.method === 'POST' && request.path === '/api/voice-notes')).toHaveLength(1);
    expect(fixture.browserErrors).toEqual([]);
  });
}

test('a stopped recording retains its audio after failure and cannot be overwritten', async ({ page }) => {
  const fixture = await installVoiceFixture(page);
  await page.goto('/voice-notes');
  await page.evaluate(() => { window.failVoiceStore = 'notes'; });
  await page.locator('#voice-record-btn').click();
  await expect(page.locator('#voice-stop-btn')).toBeEnabled();
  await page.locator('#voice-stop-btn').click();
  await expect(page.locator('#voice-save-message')).toContainText('could not be saved');
  await expect(page.locator('#voice-record-btn')).toBeDisabled();
  expect(await page.evaluate(() => window.voiceTracksStopped)).toBe(1);
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#voice-download-unsaved-btn').click();
  expect(fs.readFileSync(await (await downloadEvent).path(), 'utf8')).toBe('recorded audio');
  expect(fixture.browserErrors).toEqual([]);
});

test('unsaved audio recovery stays private and remains available after switching back', async ({ page }) => {
  const fixture = await installVoiceFixture(page);
  await page.goto('/voice-notes');
  await page.evaluate(() => { window.failVoiceStore = 'audio'; });
  await page.locator('#voice-file-input').setInputFiles({ name: 'private-a.webm', mimeType: 'audio/webm', buffer: Buffer.from('private a bytes') });
  await expect(page.locator('#voice-save-message')).toContainText('could not be saved');
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await expect(page.locator('#voice-save-recovery')).toBeHidden();
  await expect(page.locator('#voice-record-btn')).toBeEnabled();
  await page.evaluate(() => window.testAccount.switchTo('a'));
  await expect(page.locator('#voice-save-recovery')).toBeVisible();
  await expect(page.locator('#voice-record-btn')).toBeDisabled();
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#voice-download-unsaved-btn').click();
  expect(fs.readFileSync(await (await downloadEvent).path(), 'utf8')).toBe('private a bytes');
  expect(fixture.browserErrors).toEqual([]);
});

test('a previous recorder finishing its save cannot clear or append to the next account recording', async ({ page }) => {
  const fixture = await installVoiceFixture(page);
  await page.goto('/voice-notes');
  await page.evaluate(() => {
    window.voiceOnline = false;
    const transaction = IDBDatabase.prototype.transaction;
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    let holdNextSave = true;
    IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
      const tx = transaction.call(this, stores, mode, ...rest);
      if (holdNextSave && mode === 'readwrite' && Array.isArray(stores) && stores.includes('audio') && stores.includes('notes')) {
        holdNextSave = false;
        Object.defineProperty(tx, 'oncomplete', { set(callback) {
          complete.set.call(tx, (event) => { window.releaseVoiceSaveCompletion = () => callback.call(tx, event); });
        } });
      }
      return tx;
    };
  });
  await page.locator('#voice-record-btn').click();
  await page.locator('#voice-stop-btn').click();
  await expect.poll(() => page.evaluate(() => typeof window.releaseVoiceSaveCompletion)).toBe('function');
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await page.locator('#voice-record-btn').click();
  await page.evaluate(() => {
    window.testRecorders[1].ondataavailable({ data: new Blob(['b first chunk;']) });
    window.releaseVoiceSaveCompletion();
    window.testRecorders[0].ondataavailable({ data: new Blob(['late a chunk;']) });
  });
  await expect(page.locator('#voice-stop-btn')).toBeEnabled();
  await page.locator('#voice-stop-btn').click();
  await expect(page.locator('#voice-record-status')).toContainText('Saved offline');
  const saved = await savedVoiceData(page);
  expect(saved.audio.find((row) => row.owner_key === 'user:a').text).toBe('recorded audio');
  expect(saved.audio.find((row) => row.owner_key === 'user:b').text).toBe('b first chunk;recorded audio');
  expect(fixture.browserErrors).toEqual([]);
});

async function seedVoiceNote(page, synced) {
  await page.evaluate(async (isSynced) => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open('lecture-processor-voice-notes', 2);
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['notes', 'audio'], 'readwrite');
      tx.objectStore('notes').put({ id: 'local-seeded', owner_key: 'user:a', local_audio_id: 'local-seeded', study_pack_id: isSynced ? 'seeded-pack' : '', title: 'Important seeded note', transcript: 'Keep this transcript', notes_markdown: 'Keep this transcript', status: 'synced', audio_size: 10, created_at: Date.now() / 1000 });
      tx.objectStore('audio').put({ id: 'local-seeded', owner_key: 'user:a', blob: new Blob(['saved audio'], { type: 'audio/webm' }) });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, synced);
  await page.reload();
  await page.locator('[data-voice-view="library"]').click();
  await page.getByText('Important seeded note', { exact: true }).click();
}

test('offline deletion of a synced note preserves its row and audio across reload', async ({ page }) => {
  const fixture = await installVoiceFixture(page);
  await page.goto('/voice-notes');
  await seedVoiceNote(page, true);
  await page.evaluate(() => { window.voiceOnline = false; window.dispatchEvent(new Event('offline')); });
  await page.locator('#voice-detail .voice-more-actions > summary').click();
  await page.locator('#voice-delete-btn').click();
  await expect(page.locator('#voice-toast')).toContainText('Connect to the internet');
  const beforeReload = await savedVoiceData(page);
  expect(beforeReload.notes).toHaveLength(1);
  expect(beforeReload.audio).toHaveLength(1);
  await page.reload();
  await page.locator('[data-voice-view="library"]').click();
  await expect(page.locator('#voice-note-list')).toContainText('Important seeded note');
  expect((await savedVoiceData(page)).audio).toHaveLength(1);
  expect(fixture.requests.filter((request) => request.method === 'DELETE')).toHaveLength(0);
  expect(fixture.browserErrors).toEqual([]);
});

test('offline deletion of a local-only note removes both records after confirmation', async ({ page }) => {
  const fixture = await installVoiceFixture(page);
  await page.goto('/voice-notes');
  await seedVoiceNote(page, false);
  await page.evaluate(() => { window.voiceOnline = false; window.dispatchEvent(new Event('offline')); });
  await page.locator('#voice-detail .voice-more-actions > summary').click();
  await page.locator('#voice-delete-btn').click();
  await page.locator('#voice-confirm-confirm').click();
  await expect(page.locator('#voice-toast')).toContainText('Voice note deleted');
  expect(await savedVoiceData(page)).toEqual({ notes: [], audio: [] });
  expect(fixture.requests.filter((request) => request.method === 'DELETE')).toHaveLength(0);
  expect(fixture.browserErrors).toEqual([]);
});

test('failed remote deletion keeps the saved note and audio intact', async ({ page }) => {
  const fixture = await installVoiceFixture(page);
  await page.route('**/api/study-packs/seeded-pack', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Please retry when connected"}' }));
  await page.goto('/voice-notes');
  await seedVoiceNote(page, true);
  await page.locator('#voice-detail .voice-more-actions > summary').click();
  await page.locator('#voice-delete-btn').click();
  await page.locator('#voice-confirm-confirm').click();
  await expect(page.locator('#voice-toast')).toContainText('Please retry when connected');
  const saved = await savedVoiceData(page);
  expect(saved.notes).toHaveLength(1);
  expect(saved.audio).toHaveLength(1);
  expect(fixture.browserErrors).toEqual([]);
});
