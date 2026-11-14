const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');

const endpoint = '/api/tools/lecture-download';
const sourceUrl = 'https://lecture.example.test/index.m3u8';
const completeJob = { status: 'complete', download_token: 'synthetic-file-token', file_name: 'Synthetic lecture.mp4', size_bytes: 21, expires_in_seconds: 1800 };

async function fixture(page, handlers = {}) {
  await page.route(/^https:\/\//, route => route.fulfill({ body: '' }));
  const account = await installAccountFixture(page);
  const state = { posts: [], polls: [], files: [], downloads: [], browserErrors: account.browserErrors };
  page.on('download', download => state.downloads.push(download));
  await page.route('**/api/tools/lecture-download**', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === endpoint) {
      state.posts.push({ body: request.postDataJSON(), headers: request.headers() });
      return handlers.post ? handlers.post(route, state) : route.fulfill({ status: 202, json: { ok: false, job_id: 'synthetic-job', status: 'queued', step_description: 'Queued synthetic download.' } });
    }
    if (url.pathname === `${endpoint}/synthetic-job/file`) {
      state.files.push({ token: url.searchParams.get('token'), headers: request.headers() });
      return handlers.file ? handlers.file(route, state) : route.fulfill({ contentType: 'video/mp4', headers: { 'content-disposition': 'attachment; filename="Synthetic lecture.mp4"' }, body: 'SYNTHETIC_MEDIA_BYTES' });
    }
    state.polls.push({ path: url.pathname, headers: request.headers() });
    return handlers.poll ? handlers.poll(route, state) : route.fulfill({ json: completeJob });
  });
  return state;
}

async function startDownload(page) {
  await page.goto('/lecture-downloader');
  await page.locator('#lecture-downloader-url').fill(sourceUrl);
  await page.locator('#lecture-downloader-run-btn').click();
}

async function downloadedText(download) {
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

test('a queued download polls before fetching and saving authenticated media bytes', async ({ page }) => {
  let heldStatus;
  const state = await fixture(page, { poll: route => { heldStatus = route; } });
  await startDownload(page);
  await expect.poll(() => state.polls.length).toBe(1);
  expect(state.downloads).toHaveLength(0);
  expect(state.files).toHaveLength(0);
  expect(state.posts[0].headers.accept).toBe('application/json');
  expect(state.posts[0].body).toEqual({ url: sourceUrl, format: 'video' });
  await heldStatus.fulfill({ json: completeJob });
  await expect.poll(() => state.downloads.length).toBe(1);
  expect(state.files[0].token).toBe('synthetic-file-token');
  for (const request of [...state.posts, ...state.polls, ...state.files]) expect(request.headers.authorization).toBe('Bearer token-a');
  expect(state.downloads[0].suggestedFilename()).toBe('Synthetic lecture.mp4');
  expect(await downloadedText(state.downloads[0])).toBe('SYNTHETIC_MEDIA_BYTES');
  await expect(page.locator('#lecture-downloader-status')).toHaveText('Download started.');
  expect(state.browserErrors).toEqual([]);
});

test('a failed worker reports its error without saving the queued response', async ({ page }) => {
  const state = await fixture(page, { poll: route => route.fulfill({ json: { status: 'error', error: 'Synthetic lecture conversion failed.' } }) });
  await startDownload(page);
  await expect(page.locator('#lecture-downloader-status')).toContainText('Synthetic lecture conversion failed.');
  expect(state.downloads).toHaveLength(0);
  expect(state.files).toHaveLength(0);
  await expect(page.locator('#lecture-downloader-run-btn')).toHaveText('Download');
  await expect(page.locator('#lecture-downloader-run-btn')).toBeEnabled();
});

test('the source URL and output format are frozen while a request is running', async ({ page }) => {
  let heldPost;
  const state = await fixture(page, { post: route => { heldPost = route; } });
  await startDownload(page);
  await expect.poll(() => state.posts.length).toBe(1);
  await expect(page.locator('#lecture-downloader-url')).toBeDisabled();
  for (const format of ['video', 'audio', 'both']) await expect(page.locator(`[data-format="${format}"]`)).toBeDisabled();
  await page.locator('[data-format="audio"]').dispatchEvent('click');
  await page.locator('#lecture-downloader-run-btn').dispatchEvent('click');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
  expect(state.posts).toHaveLength(1);
  await heldPost.fulfill({ status: 200, contentType: 'video/mp4', body: 'LEGACY_VIDEO_BYTES' });
  await expect.poll(() => state.downloads.length).toBe(1);
  expect(state.posts[0].body.format).toBe('video');
  expect(state.downloads[0].suggestedFilename()).toBe('lecture-video.mp4');
  await expect(page.locator('[data-format="video"]')).toHaveAttribute('aria-pressed', 'true');
});

test('queued and processing jobs keep polling at a bounded interval until completion', async ({ page }) => {
  const polledAt = [];
  const state = await fixture(page, { poll: (route, state) => {
    polledAt.push(Date.now());
    return route.fulfill({ json: state.polls.length < 3
      ? { status: state.polls.length === 1 ? 'queued' : 'processing', step_description: state.polls.length === 1 ? 'Waiting for a worker.' : 'Preparing the lecture file.' }
      : completeJob });
  } });
  await startDownload(page);
  await expect(page.locator('#lecture-downloader-status')).toHaveText('Waiting for a worker.');
  expect(state.downloads).toHaveLength(0);
  await expect(page.locator('#lecture-downloader-status')).toHaveText('Preparing the lecture file.');
  expect(state.downloads).toHaveLength(0);
  await expect.poll(() => state.downloads.length).toBe(1);
  expect(state.posts).toHaveLength(1);
  expect(state.polls).toHaveLength(3);
  expect(polledAt[1] - polledAt[0]).toBeGreaterThanOrEqual(1200);
  expect(polledAt[2] - polledAt[1]).toBeGreaterThanOrEqual(1200);
});

for (const phase of ['post', 'status', 'file', 'blob']) {
  test(`an account change fences a held ${phase} without changing the next account's download`, async ({ page }) => {
    let heldA;
    let heldBStatus;
    if (phase === 'blob') {
      await page.addInitScript(() => {
        const readBlob = Response.prototype.blob;
        let held = false;
        Response.prototype.blob = function () {
          const reading = readBlob.call(this);
          if (!held && this.url.includes('/api/tools/lecture-download/') && this.url.includes('/file?')) {
            held = true;
            return reading.then(blob => new Promise(resolve => { window.releaseLectureBlob = () => resolve(blob); }));
          }
          return reading;
        };
      });
    }
    const isA = route => route.request().headers().authorization === 'Bearer token-a';
    const state = await fixture(page, {
      post: route => {
        if (phase === 'post' && isA(route)) { heldA = route; return; }
        return route.fulfill({ status: 202, json: { job_id: 'synthetic-job', status: 'queued', step_description: isA(route) ? 'A download queued.' : 'B download queued.' } });
      },
      poll: route => {
        if (!isA(route)) { heldBStatus = route; return; }
        if (phase === 'status') { heldA = route; return; }
        return route.fulfill({ json: completeJob });
      },
      file: route => {
        if (phase === 'file' && isA(route)) { heldA = route; return; }
        return route.fulfill({ contentType: 'video/mp4', headers: { 'content-disposition': `attachment; filename="${isA(route) ? 'A' : 'B'} lecture.mp4"` }, body: isA(route) ? 'A_PRIVATE_BYTES' : 'B_MEDIA_BYTES' });
      },
    });
    await startDownload(page);
    if (phase === 'blob') await expect.poll(() => page.evaluate(() => typeof window.releaseLectureBlob)).toBe('function');
    else await expect.poll(() => Boolean(heldA)).toBe(true);
    expect(state.downloads).toHaveLength(0);
    await page.evaluate(() => window.testAccount.switchTo('b'));
    await expect(page.locator('#lecture-downloader-url')).toHaveValue('');
    await expect(page.locator('#lecture-downloader-summary')).toContainText('none yet.');
    await page.locator('#lecture-downloader-url').fill(sourceUrl);
    await page.locator('#lecture-downloader-run-btn').click();
    await expect.poll(() => Boolean(heldBStatus)).toBe(true);
    if (phase === 'blob') await page.evaluate(() => window.releaseLectureBlob());
    else {
      const finished = page.waitForEvent('requestfinished', request => request === heldA.request());
      await heldA.fulfill(phase === 'file' ? { contentType: 'video/mp4', body: 'A_PRIVATE_BYTES' }
        : { status: phase === 'post' ? 202 : 200, json: phase === 'post' ? { job_id: 'synthetic-job', status: 'queued' } : completeJob });
      await finished;
    }
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(state.downloads).toHaveLength(0);
    await expect(page.locator('#lecture-downloader-status')).toHaveText('B download queued.');
    await expect(page.locator('#lecture-downloader-run-btn')).toBeDisabled();
    await expect(page.locator('#lecture-downloader-url')).toBeDisabled();
    await heldBStatus.fulfill({ json: completeJob });
    await expect.poll(() => state.downloads.length).toBe(1);
    expect(state.downloads[0].suggestedFilename()).toBe('B lecture.mp4');
    expect(await downloadedText(state.downloads[0])).toBe('B_MEDIA_BYTES');
    expect(state.posts).toHaveLength(2);
    expect(state.browserErrors).toEqual([]);
  });
}

for (const failure of ['network', 'server', 'file']) {
  test(`a temporary ${failure} failure can check the same job without another POST`, async ({ page }) => {
    const state = await fixture(page, {
      poll: (route, state) => {
        if (state.polls.length === 1 && failure !== 'file') return failure === 'network' ? route.abort('failed') : route.fulfill({ status: 503, json: { error: 'Synthetic temporary outage.' } });
        return route.fulfill({ json: completeJob });
      },
      file: (route, state) => {
        if (state.files.length === 1 && failure === 'file') return route.abort('failed');
        return route.fulfill({ contentType: 'video/mp4', body: 'RETRIED_MEDIA_BYTES' });
      },
    });
    await startDownload(page);
    await expect(page.locator('#lecture-downloader-run-btn')).toHaveText('Check download');
    await expect(page.locator('#lecture-downloader-run-btn')).toBeEnabled();
    expect(state.downloads).toHaveLength(0);
    await page.locator('#lecture-downloader-run-btn').click();
    await expect.poll(() => state.downloads.length).toBe(1);
    expect(state.posts).toHaveLength(1);
    expect(state.polls).toHaveLength(2);
    expect(await downloadedText(state.downloads[0])).toBe('RETRIED_MEDIA_BYTES');
    await expect(page.locator('#lecture-downloader-run-btn')).toHaveText('Download');
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('synthetic-job');
    expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain('synthetic-file-token');
  });
}

for (const change of ['url', 'format', 'account']) {
  test(`changing ${change} discards a retryable job and starts a new request`, async ({ page }) => {
    const state = await fixture(page, {
      poll: (route, state) => state.polls.length === 1 ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: completeJob }),
    });
    await startDownload(page);
    await expect(page.locator('#lecture-downloader-run-btn')).toHaveText('Check download');
    if (change === 'url') await page.locator('#lecture-downloader-url').fill(sourceUrl + '?new=1');
    else if (change === 'format') await page.locator('[data-format="audio"]').click();
    else {
      await page.evaluate(() => window.testAccount.switchTo('b'));
      await page.locator('#lecture-downloader-url').fill(sourceUrl);
    }
    await expect(page.locator('#lecture-downloader-run-btn')).toHaveText('Download');
    await page.locator('#lecture-downloader-run-btn').click();
    await expect.poll(() => state.downloads.length).toBe(1);
    expect(state.posts).toHaveLength(2);
    expect(state.posts[1].body).toEqual({ url: sourceUrl + (change === 'url' ? '?new=1' : ''), format: change === 'format' ? 'audio' : 'video' });
    expect(state.posts[1].headers.authorization).toBe(change === 'account' ? 'Bearer token-b' : 'Bearer token-a');
  });
}

for (const failure of ['missing', 'expired', 'file-expired']) {
  test(`a ${failure} job clears the pending download`, async ({ page }) => {
    const state = await fixture(page, {
      poll: (route, state) => {
        if (state.polls.length !== 1 || failure === 'file-expired') return route.fulfill({ json: completeJob });
        return route.fulfill(failure === 'missing' ? { status: 404, json: { error: 'Synthetic download not found.' } }
          : { json: { status: 'error', error: 'This download has expired. Please prepare it again.' } });
      },
      file: (route, state) => state.files.length === 1 && failure === 'file-expired'
        ? route.fulfill({ status: 410, json: { error: 'This download has expired. Please prepare it again.' } })
        : route.fulfill({ contentType: 'video/mp4', body: 'NEW_MEDIA_BYTES' }),
    });
    await startDownload(page);
    await expect(page.locator('#lecture-downloader-status')).toContainText(failure === 'missing' ? 'not found' : 'expired');
    await expect(page.locator('#lecture-downloader-run-btn')).toHaveText('Download');
    expect(state.downloads).toHaveLength(0);
    await page.locator('#lecture-downloader-run-btn').click();
    await expect.poll(() => state.downloads.length).toBe(1);
    expect(state.posts).toHaveLength(2);
  });
}

test('legacy binary responses remain downloadable during a rolling deployment', async ({ page }) => {
  const state = await fixture(page, { post: route => route.fulfill({ contentType: 'audio/mpeg', headers: { 'content-disposition': 'attachment; filename="Legacy lecture.mp3"' }, body: 'LEGACY_AUDIO_BYTES' }) });
  await page.goto('/lecture-downloader');
  await page.locator('#lecture-downloader-url').fill(sourceUrl);
  await page.locator('[data-format="audio"]').click();
  await page.locator('#lecture-downloader-run-btn').click();
  await expect.poll(() => state.downloads.length).toBe(1);
  expect(state.posts[0].body.format).toBe('audio');
  expect(state.polls).toHaveLength(0);
  expect(state.downloads[0].suggestedFilename()).toBe('Legacy lecture.mp3');
  expect(await downloadedText(state.downloads[0])).toBe('LEGACY_AUDIO_BYTES');
});

test('a signed-out visitor must sign in before submitting', async ({ page }) => {
  const state = await fixture(page);
  await page.addInitScript(() => window.testAccount.switchTo(null));
  await page.goto('/lecture-downloader');
  await page.locator('#lecture-downloader-url').fill(sourceUrl);
  await expect(page.locator('#lecture-downloader-run-btn')).toBeDisabled();
  await expect(page.locator('#lecture-downloader-auth-panel')).toBeVisible();
  expect(state.posts).toHaveLength(0);
  await page.evaluate(() => window.testAccount.switchTo('b'));
  await page.locator('#lecture-downloader-url').fill(sourceUrl);
  await page.locator('#lecture-downloader-run-btn').click();
  await expect.poll(() => state.downloads.length).toBe(1);
  expect(state.posts[0].headers.authorization).toBe('Bearer token-b');
});

for (const theme of ['light', 'dark']) {
  for (const width of [1440, 375]) {
    test(`queued and failed downloads fit ${width}px in ${theme} mode`, async ({ page }, testInfo) => {
      let heldStatus;
      const state = await fixture(page, { poll: route => { heldStatus = route; } });
      await page.setViewportSize({ width, height: 900 });
      await startDownload(page);
      await expect.poll(() => Boolean(heldStatus)).toBe(true);
      await page.evaluate(value => window.LPTheme.apply({ theme: value }), theme);
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      for (const mode of ['queued', 'error']) {
        if (mode === 'error') {
          await heldStatus.fulfill({ json: { status: 'error', error: 'The lecture could not be downloaded. Please try again.' } });
          await expect(page.locator('#lecture-downloader-status')).toContainText('The lecture could not be downloaded.');
        }
        await page.locator('#lecture-downloader-status').scrollIntoViewIfNeeded();
        await expect(page.locator('#lecture-downloader-status')).toBeInViewport();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        await page.screenshot({ animations: 'disabled', fullPage: true, path: testInfo.outputPath(`download-${mode}-${theme}-${width}.png`) });
      }
      expect(state.downloads).toHaveLength(0);
    });
  }
}
