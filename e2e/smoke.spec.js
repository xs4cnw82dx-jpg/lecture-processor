const { test, expect } = require('@playwright/test');

async function assertAppHealth(request) {
  const healthResponse = await request.get('/healthz');
  expect(healthResponse.ok()).toBeTruthy();
  const payload = await healthResponse.json();
  expect(payload).toMatchObject({ status: 'ok' });
}

test.beforeEach(async ({ page, request }, testInfo) => {
  const browserFailures = [];
  testInfo.browserFailures = browserFailures;
  page.on('pageerror', (error) => {
    browserFailures.push(`pageerror: ${error.message}`);
  });
  page.on('console', (message) => {
    if (message.type() === 'error') {
      browserFailures.push(`console.error: ${message.text()}`);
    }
  });
  await assertAppHealth(request);
});

test.afterEach(async ({}, testInfo) => {
  expect(testInfo.browserFailures || []).toEqual([]);
});

test('landing and config endpoints are healthy', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.locator('body')).toContainText(/Lecture Processor|Transform Lectures/i);

  const configResponse = await request.get('/api/config');
  expect(configResponse.ok()).toBeTruthy();
  const config = await configResponse.json();
  expect(config).toHaveProperty('bundles');
});

test('privacy and terms pages load', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.locator('body')).toContainText(/Privacy Policy|Privacy/i);

  await page.goto('/terms');
  await expect(page.locator('body')).toContainText(/Terms|Conditions/i);
});

test('public pages share header branding and primary CTA copy', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.public-header')).toContainText('Lecture Processor');
  await expect(page.getByRole('link', { name: /Start Studying/i })).toBeVisible();

  await page.goto('/features');
  await expect(page.locator('.public-header')).toContainText('Lecture Processor');
  await expect(page.getByRole('link', { name: /Start Studying/i })).toBeVisible();
});

test('lecture and batch pages show updated labels', async ({ page }) => {
  await page.goto('/lecture-notes');
  await expect(page.locator('body')).toContainText(/Lecture Notes/i);
  await expect(page.locator('body')).not.toContainText(/New Lecture/i);

  await page.goto('/batch_mode');
  await expect(page.locator('body')).toContainText(/Batch Processing/i);
  await expect(page.locator('body')).not.toContainText(/Batch Mode Lectures/i);
});

test('batch output language listbox supports keyboard selection', async ({ page }) => {
  await page.goto('/batch_mode');
  const trigger = page.locator('#output-language-button');
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#output-language-menu [data-value="english"]')).toBeFocused();

  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#output-language-menu [data-value="dutch"]')).toBeFocused();
  await page.keyboard.press('Enter');

  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
  await expect(page.locator('#output-language')).toHaveValue('dutch');
  await expect(page.locator('#output-language-label')).toContainText('Dutch');
});

test('mobile pack builder keeps actions visible and option typing focused', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/study-pack-builder');
  await page.evaluate(() => window.openBuilderOverlay('create', null));

  await expect(page.locator('#builder-stat-dirty')).toHaveText('Not saved yet');
  await expect(page.locator('#builder-save-btn')).toBeInViewport();
  const mainTop = await page.locator('.builder-main').evaluate((element) => element.getBoundingClientRect().top);
  expect(mainTop).toBeLessThan(180);

  await page.locator('#builder-tab-test').click();
  await page.locator('#builder-add-question-btn').click();
  const answer = page.locator('[data-q-answer="0"]');
  await answer.selectOption({ label: 'C: Option C' });
  const option = page.locator('#builder-q-option-0-2');
  await option.focus();
  await option.selectText();
  await option.pressSequentially('Pulmonary artery');

  await expect(option).toBeFocused();
  await expect(option).toHaveValue('Pulmonary artery');
  await expect(answer).toHaveValue('Pulmonary artery');
  await page.locator('.builder-main').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator('#builder-save-btn')).toBeInViewport();
});

test('dashboard shell loads for unauthenticated user', async ({ page }) => {
  await page.goto('/dashboard');
  await expect(page.locator('#dash-streak')).toContainText('Sign in to track');
  await expect(page.locator('#dash-due')).toContainText('Sign in to review');
  await expect(page.locator('#dash-goal')).toContainText('Sign in to set goals');
  await expect(page.locator('#dash-goal-fill')).toBeHidden();
});

test('legacy calendar redirects to the signed-out Study Plan schedule', async ({ page }) => {
  await page.goto('/calendar');
  await page.waitForURL(/\/plan\?view=schedule$/);
  await expect(page.locator('#study-plan-auth')).toBeVisible();
  await expect(page.locator('#study-plan-auth')).toContainText('Sign in to plan your studying');
});

test('reader actions stay disabled until output exists', async ({ page }) => {
  await page.goto('/document-reader');
  await expect(page.locator('#reader-copy-btn')).toBeDisabled();
  await expect(page.locator('#reader-download-docx-btn')).toBeDisabled();
});

test('video overlay builder creates tables and previews animations', async ({ page }) => {
  await page.goto('/video-overlay-builder');
  await expect(page.getByRole('heading', { name: 'Video Overlay Builder' })).toBeVisible();
  await expect(page.locator('#overlay-stage')).toBeVisible();

  const recordButtonStyle = await page.locator('#overlay-record-screen').evaluate((button) => {
    const styles = window.getComputedStyle(button);
    return {
      backgroundImage: styles.backgroundImage,
      borderRadius: styles.borderRadius,
      alignItems: styles.alignItems,
      justifyContent: styles.justifyContent
    };
  });
  expect(recordButtonStyle.backgroundImage).toContain('linear-gradient');
  expect(recordButtonStyle.borderRadius).toBe('8px');
  expect(recordButtonStyle.alignItems).toBe('center');
  expect(recordButtonStyle.justifyContent).toBe('center');

  await page.evaluate(() => {
    let micCalls = 0;
    let stoppedTracks = 0;
    window.__overlayMicProbe = {
      calls: () => micCalls,
      stopped: () => stoppedTracks
    };
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: async () => {
          micCalls += 1;
          return {
            getTracks: () => [{ stop: () => { stoppedTracks += 1; } }]
          };
        }
      }
    });
    class FakeAudioContext {
      constructor() {
        this.state = 'running';
      }

      createAnalyser() {
        return {
          fftSize: 512,
          getByteTimeDomainData(data) {
            for (let index = 0; index < data.length; index += 1) {
              data[index] = index % 8 === 0 ? 174 : 128;
            }
          }
        };
      }

      createMediaStreamSource() {
        return {
          connect() {},
          disconnect() {}
        };
      }

      close() {
        return Promise.resolve();
      }

      resume() {
        return Promise.resolve();
      }
    }
    window.AudioContext = FakeAudioContext;
    window.webkitAudioContext = FakeAudioContext;
  });
  await page.locator('#overlay-record-voice').check();
  await expect(page.locator('.overlay-recorder-visual')).toHaveClass(/is-live/);
  await expect(page.locator('#overlay-recording-status')).toContainText('Microphone test active.');
  await expect.poll(async () => page.evaluate(() => window.__overlayMicProbe.calls())).toBe(1);
  await page.locator('#overlay-record-voice').uncheck();
  await expect(page.locator('.overlay-recorder-visual')).not.toHaveClass(/is-live/);
  await expect.poll(async () => page.evaluate(() => window.__overlayMicProbe.stopped())).toBe(1);

  const defaultStageMetrics = await page.evaluate(() => {
    const frame = document.querySelector('.overlay-stage-frame');
    const stage = document.getElementById('overlay-stage');
    const frameRect = frame.getBoundingClientRect();
    const stageRect = stage.getBoundingClientRect();
    return {
      fitsVertically: stageRect.top >= frameRect.top - 1 && stageRect.bottom <= frameRect.bottom + 1,
      hasVerticalScroll: frame.scrollHeight > frame.clientHeight + 2,
      stageWidth: stageRect.width
    };
  });
  expect(defaultStageMetrics.fitsVertically).toBeTruthy();
  expect(defaultStageMetrics.hasVerticalScroll).toBeFalsy();
  await expect(page.locator('.overlay-preview-meter')).toBeHidden();

  await page.locator('#overlay-zoom-input').fill('150');
  await expect(page.locator('#overlay-zoom-input')).toHaveValue('150');
  const zoomedStageWidth = await page.locator('#overlay-stage').evaluate((stage) => stage.getBoundingClientRect().width);
  expect(zoomedStageWidth).toBeGreaterThan(defaultStageMetrics.stageWidth * 1.4);
  await page.locator('#overlay-zoom-input').fill('100');

  await page.locator('#overlay-add-slide').click();
  await page.locator('#overlay-inspector [data-slide-field="title"]').fill('Second slide');
  await page.locator('#overlay-add-slide').click();
  await page.locator('#overlay-inspector [data-slide-field="title"]').fill('Third slide');
  const slideRows = page.locator('#overlay-slide-list [data-slide-row-id]');
  await expect(slideRows).toHaveCount(3);
  const firstSlideBox = await slideRows.nth(0).boundingBox();
  const thirdSlideBox = await slideRows.nth(2).boundingBox();
  await page.mouse.move(thirdSlideBox.x + thirdSlideBox.width / 2, thirdSlideBox.y + thirdSlideBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(firstSlideBox.x + firstSlideBox.width / 2, firstSlideBox.y + firstSlideBox.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(slideRows.nth(0).locator('strong')).toHaveText('Third slide');

  await page.locator('#overlay-add-text').click();
  const textBody = page.locator('.overlay-stage-item.is-selected [data-edit-field="body"]');
  await expect(textBody).toHaveAttribute('data-placeholder', 'Type overlay text...');
  await expect(textBody).toHaveText('');
  await textBody.fill('Clean typing starts here');
  await expect(textBody).toHaveText('Clean typing starts here');

  await page.locator('#overlay-table-rows').fill('0');
  await page.locator('#overlay-table-cols').fill('-2');
  await page.locator('#overlay-add-table').click();

  await expect(page.locator('#overlay-inspector')).toContainText('1 x 1');
  await page.locator('#overlay-inspector [data-table-rows]').fill('5');
  await page.locator('#overlay-inspector [data-table-cols]').fill('3');
  await expect(page.locator('#overlay-inspector')).toContainText('5 x 3');
  await expect(page.locator('.overlay-stage-item.is-selected .overlay-table tr')).toHaveCount(5);
  await expect(page.locator('.overlay-stage-item.is-selected .overlay-table tr:first-child th')).toHaveCount(3);
  await expect.poll(async () => page.locator('.overlay-stage-item.is-selected').evaluate((node) => {
    const table = node.querySelector('.overlay-table');
    const body = node.querySelector('.overlay-stage-item-body');
    const tableRect = table.getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    return tableRect.right <= bodyRect.right + 1
      && tableRect.bottom <= bodyRect.bottom + 1
      && node.scrollWidth <= node.clientWidth + 2
      && node.scrollHeight <= node.clientHeight + 2;
  })).toBeTruthy();

  await page.locator('#overlay-add-shape').click();
  const selectedShape = page.locator('.overlay-stage-item.is-selected');
  await expect(selectedShape.locator('.overlay-shape')).toBeVisible();
  await expect(selectedShape.locator('.overlay-stage-item-meta')).toContainText(/Scale/);
  await expect(page.locator('#overlay-inspector')).not.toContainText('Fit to content');
  await page.getByRole('button', { name: 'Circle' }).click();
  await expect(selectedShape.locator('.overlay-shape-circle')).toBeVisible();
  const circleMetrics = await selectedShape.locator('.overlay-shape').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(Math.abs(circleMetrics.width - circleMetrics.height)).toBeLessThan(2);
  await page.locator('#overlay-inspector [data-item-field="w"]').fill('50');
  await page.locator('#overlay-inspector [data-item-field="h"]').fill('14');
  const stretchedCircle = await selectedShape.locator('.overlay-shape').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height, area: rect.width * rect.height };
  });
  expect(stretchedCircle.width).toBeGreaterThan(stretchedCircle.height * 2);
  await page.getByRole('button', { name: 'Restore proportions' }).click();
  const restoredCircle = await selectedShape.locator('.overlay-shape').evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { width: rect.width, height: rect.height, area: rect.width * rect.height };
  });
  expect(Math.abs(restoredCircle.width - restoredCircle.height)).toBeLessThan(2);
  expect(Math.abs(restoredCircle.area - stretchedCircle.area) / stretchedCircle.area).toBeLessThan(0.08);
  await page.locator('#overlay-inspector [data-item-field="rotation"]').fill('35');
  await expect(page.locator('#overlay-inspector [data-item-field="rotation"]')).toHaveValue('35');
  const shapeChrome = await selectedShape.evaluate((node) => {
    const styles = window.getComputedStyle(node);
    const bodyStyles = window.getComputedStyle(node.querySelector('.overlay-stage-item-body'));
    return {
      background: styles.backgroundColor,
      borderColor: styles.borderColor,
      boxShadow: styles.boxShadow,
      rotation: styles.getPropertyValue('--overlay-rotation').trim(),
      transform: bodyStyles.transform
    };
  });
  expect(shapeChrome.background).toBe('rgba(0, 0, 0, 0)');
  expect(shapeChrome.borderColor).toBe('rgba(0, 0, 0, 0)');
  expect(shapeChrome.boxShadow).toBe('none');
  expect(shapeChrome.rotation).toBe('35deg');
  expect(shapeChrome.transform).not.toBe('none');

  const stageBox = await page.locator('#overlay-stage').boundingBox();
  const shapeBox = await selectedShape.boundingBox();
  await page.mouse.move(shapeBox.x + shapeBox.width / 2, shapeBox.y + shapeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(stageBox.x - 240, stageBox.y - 240, { steps: 6 });
  await page.mouse.up();
  const clampedShapeRect = await selectedShape.evaluate((node) => {
    const stage = document.getElementById('overlay-stage').getBoundingClientRect();
    const rect = node.getBoundingClientRect();
    return {
      insideLeft: rect.left >= stage.left - 1,
      insideTop: rect.top >= stage.top - 1
    };
  });
  expect(clampedShapeRect.insideLeft).toBeTruthy();
  expect(clampedShapeRect.insideTop).toBeTruthy();

  await page.locator('#overlay-add-arrow').click();
  await expect(page.locator('.overlay-stage-item.is-selected .overlay-arrow-svg')).toBeVisible();
  await page.locator('#overlay-inspector [data-item-field="rotation"]').fill('-24');
  const arrowPaint = await page.locator('.overlay-stage-item.is-selected .overlay-arrow-head').evaluate((node) => {
    const styles = window.getComputedStyle(node);
    return {
      fill: styles.fill,
      stroke: styles.stroke,
      rotation: window.getComputedStyle(node.closest('.overlay-stage-item')).getPropertyValue('--overlay-rotation').trim()
    };
  });
  expect(arrowPaint.fill).toBe('none');
  expect(arrowPaint.stroke).not.toBe('none');
  expect(arrowPaint.rotation).toBe('-24deg');

  await page.locator('#overlay-image-input').setInputFiles({
    name: 'tiny.png',
    mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=', 'base64')
  });
  const selectedImage = page.locator('.overlay-stage-item.is-selected');
  await expect(selectedImage.locator('img')).toBeVisible();
  const edgeSelect = page.locator('#overlay-inspector .overlay-field').filter({ hasText: /^Edge/ });
  await edgeSelect.locator('.app-select-button').click();
  await edgeSelect.locator('.app-select-item', { hasText: 'Glass edge' }).click();
  await expect(selectedImage).toHaveClass(/overlay-image-edge-glass/);
  await expect(page.locator('#overlay-inspector')).not.toContainText('Fit to content');
  await expect(page.locator('#overlay-inspector')).toContainText('Disabled for glass edge');
  const glassChrome = await selectedImage.evaluate((node) => {
    const styles = window.getComputedStyle(node);
    const beforeStyles = window.getComputedStyle(node, '::before');
    return {
      accent: styles.getPropertyValue('--overlay-accent').trim(),
      borderColor: styles.borderColor,
      beforeDisplay: beforeStyles.display
    };
  });
  expect(glassChrome.beforeDisplay).toBe('none');
  expect(glassChrome.accent).toContain('148, 163, 184');
  expect(glassChrome.borderColor).not.toContain('249, 115, 22');

  await page.locator('#overlay-stage').click({ position: { x: stageBox.width - 8, y: stageBox.height - 8 } });
  await page.locator('#overlay-inspector [data-slide-field="duration"]').fill('1');

  await page.getByRole('button', { name: 'Preview Slide' }).click();
  await expect(page.locator('#overlay-stage')).toHaveClass(/is-previewing/);
  await expect(page.locator('.overlay-stage-item-meta').first()).toBeHidden();
  await expect(page.locator('.overlay-resize-handle').first()).toBeHidden();
  await expect(page.locator('.overlay-preview-meter')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop Preview' })).toBeEnabled();
  await expect(page.locator('#overlay-builder-status')).toContainText('Preview complete.', { timeout: 2500 });
  await expect(page.locator('#overlay-builder-status')).toHaveText('', { timeout: 3500 });
});

test('mobile tool and signed-in shell controls never widen the page', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/video-overlay-builder');

  const overlayLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    recordingWrap: getComputedStyle(document.querySelector('.overlay-recording-bar')).flexWrap,
    recordingNoteBasis: getComputedStyle(document.querySelector('.overlay-recording-note')).flexBasis,
  }));
  expect(overlayLayout.scrollWidth).toBeLessThanOrEqual(overlayLayout.viewportWidth);
  expect(overlayLayout.recordingWrap).toBe('nowrap');
  expect(overlayLayout.recordingNoteBasis).toBe('auto');

  await page.goto('/batch_status');
  await page.evaluate(() => {
    const shell = document.querySelector('#app-shell');
    const account = document.querySelector('#shell-account');
    const signin = document.querySelector('#shell-sign-in-btn');
    const credits = document.querySelector('#shell-credits-link');
    shell.dataset.authState = 'signed-in';
    account.hidden = false;
    signin.hidden = true;
    credits.hidden = false;
    document.querySelector('#shell-account-name').textContent = 'ijacco2004';
    document.querySelector('#shell-credits-total').textContent = 'Unlimited credits';
  });

  const shellLayout = await page.evaluate(() => ({
    viewportWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    topbarRight: document.querySelector('.app-shell-topbar-right').getBoundingClientRect().right,
    topbarPaddingLeft: getComputedStyle(document.querySelector('.app-shell-topbar')).paddingLeft,
    topbarPaddingRight: getComputedStyle(document.querySelector('.app-shell-topbar')).paddingRight,
  }));
  expect(shellLayout.scrollWidth).toBeLessThanOrEqual(shellLayout.viewportWidth);
  expect(shellLayout.topbarRight).toBeLessThanOrEqual(shellLayout.viewportWidth);
  expect(shellLayout.topbarPaddingLeft).toBe('12px');
  expect(shellLayout.topbarPaddingRight).toBe('12px');
});

test('video overlay recording switches into clean presenter mode', async ({ page }) => {
  await page.goto('/video-overlay-builder');
  await page.evaluate(() => {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia: async () => new MediaStream(),
        getUserMedia: async () => new MediaStream()
      }
    });
    window.MediaRecorder = class FakeMediaRecorder extends EventTarget {
      constructor(stream, options = {}) {
        super();
        this.stream = stream;
        this.mimeType = options.mimeType || 'video/webm';
      }

      start() {}

      stop() {
        const dataEvent = new Event('dataavailable');
        Object.defineProperty(dataEvent, 'data', {
          value: new Blob(['recorded'], { type: this.mimeType })
        });
        this.dispatchEvent(dataEvent);
        this.dispatchEvent(new Event('stop'));
      }

      static isTypeSupported() {
        return true;
      }
    };
    window.__overlayFullscreenElement = null;
    Object.defineProperty(document, 'fullscreenElement', {
      configurable: true,
      get() {
        return window.__overlayFullscreenElement;
      }
    });
    Element.prototype.requestFullscreen = async function requestFullscreen() {
      window.__overlayFullscreenElement = this;
    };
    document.exitFullscreen = async () => {
      window.__overlayFullscreenElement = null;
    };
  });

  await page.locator('#overlay-add-text').click();
  const editorTitleRatio = await page.evaluate(() => {
    const stage = document.getElementById('overlay-stage').getBoundingClientRect();
    const title = document.querySelector('.overlay-card-title');
    return parseFloat(window.getComputedStyle(title).fontSize) / stage.width;
  });
  await page.locator('#overlay-record-screen').click();

  await expect(page.locator('body')).toHaveClass(/overlay-recording-presenter/);
  await expect(page.locator('.overlay-builder-topbar')).toBeHidden();
  await expect(page.locator('.overlay-builder-sidebar')).toBeHidden();
  await expect(page.locator('.overlay-resize-handle').first()).toBeHidden();
  await expect(page.locator('.overlay-preview-meter')).toBeHidden();
  const presenterMetrics = await page.evaluate(() => {
    const stage = document.getElementById('overlay-stage').getBoundingClientRect();
    const title = document.querySelector('.overlay-card-title');
    return {
      stageIsLarge: stage.width > window.innerWidth * 0.82,
      stageFitsViewport: stage.bottom <= window.innerHeight + 1,
      titleRatio: parseFloat(window.getComputedStyle(title).fontSize) / stage.width
    };
  });
  expect(presenterMetrics.stageIsLarge).toBeTruthy();
  expect(presenterMetrics.stageFitsViewport).toBeTruthy();
  expect(Math.abs(presenterMetrics.titleRatio - editorTitleRatio)).toBeLessThan(0.004);

  await page.keyboard.press('Escape');

  await expect(page.locator('body')).not.toHaveClass(/overlay-recording-presenter/);
  await expect(page.locator('#overlay-recording-status')).toContainText('Recording ready. Download started.');
});

test('voice notes ships a native delete confirmation dialog', async ({ page }) => {
  await page.goto('/voice-notes');

  const confirmDialog = page.locator('#voice-confirm-modal');
  await expect(confirmDialog).toBeHidden();
  await expect(page.locator('#voice-confirm-title')).toHaveText('Delete Voice Note');
  await expect(page.locator('#voice-confirm-confirm')).toHaveText('Delete Voice Note');
  await expect(page.locator('#voice-confirm-cancel')).toHaveText('Cancel');
});

test('lecture notes audio disclosures toggle open and closed', async ({ page }) => {
  await page.goto('/lecture-notes');

  const otherAudioDisclosure = page.locator('#other-audio-disclosure');
  const advancedToggle = page.getByRole('button', { name: /Advanced settings/i });
  const advancedBody = page.locator('#advanced-settings-body');
  await expect(otherAudioDisclosure).toBeHidden();
  await expect(advancedToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(advancedBody).toHaveAttribute('aria-hidden', 'true');

  await advancedToggle.click();

  await expect(advancedToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(advancedBody).toHaveAttribute('aria-hidden', 'false');
  await expect(advancedToggle).toHaveClass(/open/);

  await advancedToggle.click();

  await expect(advancedToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(advancedBody).toHaveAttribute('aria-hidden', 'true');
  await expect(advancedToggle).not.toHaveClass(/open/);
});

test('lecture notes keeps a stable layout on desktop and stacks cleanly on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 1200 });
  await page.goto('/lecture-notes');

  const desktopLayout = await page.evaluate(() => {
    const uploadSection = document.getElementById('upload-section');
    const buttonSection = document.getElementById('button-section');
    const advancedSettings = document.getElementById('advanced-settings');
    const secondaryGrid = document.querySelector('.processing-secondary-grid');
    const processSummary = document.getElementById('mobile-process-summary');
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

    return {
      templateAreas: normalize(getComputedStyle(uploadSection).gridTemplateAreas),
      buttonPosition: getComputedStyle(buttonSection).position,
      advancedArea: normalize(getComputedStyle(advancedSettings).gridArea),
      secondaryArea: normalize(getComputedStyle(secondaryGrid).gridArea),
      processSummary: normalize(processSummary.textContent),
    };
  });

  expect(desktopLayout.templateAreas).toContain('"topic topic"');
  expect(desktopLayout.templateAreas).toContain('"slides audio"');
  expect(desktopLayout.templateAreas).toContain('"advanced secondary"');
  expect(desktopLayout.templateAreas).toContain('"action action"');
  expect(desktopLayout.buttonPosition).toBe('static');
  expect(desktopLayout.advancedArea).toContain('advanced');
  expect(desktopLayout.secondaryArea).toContain('secondary');
  expect(desktopLayout.processSummary).toMatch(/Sign in to check your credits and start processing\./);
  expect(desktopLayout.processSummary).not.toContain('•');

  await page.setViewportSize({ width: 390, height: 1100 });

  const mobileLayout = await page.evaluate(() => {
    const uploadSection = document.getElementById('upload-section');
    return String(getComputedStyle(uploadSection).gridTemplateAreas).replace(/\s+/g, ' ').trim();
  });

  expect(mobileLayout).toContain('"topic"');
  expect(mobileLayout).toContain('"slides"');
  expect(mobileLayout).toContain('"audio"');
  expect(mobileLayout).toContain('"secondary"');
  expect(mobileLayout).toContain('"advanced"');
  expect(mobileLayout).toContain('"action"');
});

test('singular processing pages use the desktop width instead of a narrow mobile column', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 1050 });

  for (const path of ['/slides-extraction', '/interview-transcription']) {
    await page.goto(path);
    await expect(page.locator('#upload-section.single-upload')).toBeVisible();

    const layout = await page.evaluate(() => {
      const uploadSection = document.getElementById('upload-section');
      const sourceZone = document.querySelector('#pdf-zone:not([hidden]), #audio-zone:not([hidden])');
      const secondaryGrid = document.querySelector('.processing-secondary-grid');
      const buttonSection = document.getElementById('button-section');
      const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();

      return {
        templateAreas: normalize(getComputedStyle(uploadSection).gridTemplateAreas),
        maxWidth: getComputedStyle(uploadSection).maxWidth,
        sourceWidth: sourceZone.getBoundingClientRect().width,
        uploadSectionWidth: uploadSection.getBoundingClientRect().width,
        secondaryHidden: secondaryGrid.hidden,
        buttonColumns: normalize(getComputedStyle(buttonSection).gridTemplateColumns),
      };
    });

    expect(layout.templateAreas).toContain('"source advanced"');
    expect(layout.maxWidth).toBe('none');
    expect(layout.sourceWidth).toBeGreaterThan(500);
    expect(layout.uploadSectionWidth).toBeGreaterThan(900);
    expect(layout.secondaryHidden).toBeTruthy();
    expect(layout.buttonColumns).not.toBe('none');
  }
});
