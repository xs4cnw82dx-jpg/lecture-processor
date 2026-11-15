const { test, expect } = require('@playwright/test');

test.use({ serviceWorkers: 'block' });
test.describe.configure({ mode: 'parallel' });

const copy = {
  en: {
    date: 'November 15, 2026', updated: 'Last updated:',
    footer: 'AI-assisted study tools · Made for students',
    routing: 'Audio is always processed by Google Gemini. The Claude route applies only to text and document features for which it has been enabled.',
    developer: 'using models developed by Anthropic. Google operates this model-processing service.',
    paid: 'Google Gemini API: under Google’s paid-service terms, submitted content is not used to improve Google’s products.',
    days: '55-day retention', files: 'automatically deletes Files API uploads after 48 hours',
    distinction: 'Deleting an uploaded file does not remove separate abuse-monitoring records',
    zdr: 'with its Safety Retention category excluded',
    qualification: 'Operational metadata, permitted temporary caches and legally required preservation can still apply',
    global: 'including outside the European Union',
    terms: 'The AI service providers and processing routes used for your content are described in our Privacy Policy.',
  },
  nl: {
    date: '15 november 2026', updated: 'Laatst bijgewerkt:',
    footer: 'Studiehulpmiddelen met AI · Gemaakt voor studenten',
    routing: 'Audio wordt altijd door Google Gemini verwerkt. De Claude-route geldt alleen voor tekst- en documentfuncties waarvoor die is ingeschakeld.',
    developer: 'met modellen die door Anthropic zijn ontwikkeld. Google beheert deze dienst voor modelverwerking.',
    paid: 'Google Gemini API: volgens de voorwaarden voor de betaalde dienst gebruikt Google aangeleverde inhoud niet om zijn producten te verbeteren.',
    days: 'bewaartermijn van 55 dagen', files: 'verwijdert uploads naar de Files API automatisch na 48 uur',
    distinction: 'Het verwijderen van een geüpload bestand verwijdert geen afzonderlijke gegevens voor misbruikcontrole',
    zdr: 'met uitsluiting van de categorie Safety Retention',
    qualification: 'Operationele metadata, toegestane tijdelijke caches en wettelijk verplichte bewaring kunnen blijven bestaan',
    global: 'ook buiten de Europese Unie',
    terms: 'De AI-dienstverleners en verwerkingsroutes die voor je inhoud worden gebruikt, staan in ons privacybeleid.',
  },
};
const providerLinks = [
  'https://aistudio.google.com/docs/terms#data-use-paid',
  'https://aistudio.google.com/docs/usage-policies',
  'https://aistudio.google.com/docs/files#delete-uploaded',
  'https://openrouter.ai/docs/guides/features/zdr',
];

async function prepare(page, language, theme) {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(preferences => {
    if (!localStorage.getItem('lp-preferences')) localStorage.setItem('lp-preferences', JSON.stringify(preferences));
  }, { language, theme });
  await page.route('https://**', route => route.abort());
  return errors;
}

async function expectDate(page, language) {
  await expect(page.locator('.meta')).toContainText(copy[language].updated);
  await expect(page.locator('.meta time')).toHaveText(copy[language].date);
  await expect(page.locator('.meta time')).toHaveAttribute('datetime', '2026-11-15');
}

async function expectFooter(page, language) {
  const footer = page.locator('.footer');
  await expect(footer).toContainText(copy[language].footer);
  await expect(footer).not.toContainText('Powered by Gemini');
  for (const href of ['/helpcenter', '/FAQ', '/privacy', '/terms', 'mailto:email@lectureprocessor.com']) {
    await expect(footer.locator(`a[href="${href}"]`)).toHaveCount(1);
  }
}

async function captureAt(page, locator, testInfo, filename, width) {
  await locator.evaluate(node => window.scrollTo({
    top: Math.max(0, node.getBoundingClientRect().top + window.scrollY - 100),
    behavior: 'instant',
  }));
  await expect(locator).toBeInViewport();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
  await page.screenshot({ path: testInfo.outputPath(filename), animations: 'disabled' });
}

for (const language of ['en', 'nl']) for (const width of [1440, 375]) for (const theme of ['light', 'dark']) {
  test(`provider policies in ${language} at ${width}px ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: width === 375 ? 812 : 1000 });
    const errors = await prepare(page, language, theme);
    await page.goto('/privacy');
    await expectDate(page, language);
    await expectFooter(page, language);
    const processors = page.locator('[id="6-third-party-processors"] + p + ul');
    await expect(processors.locator('li')).toHaveCount(6);
    await expect(processors).toContainText('Google Gemini API');
    await expect(processors).toContainText('OpenRouter');
    await expect(processors).toContainText('Google Cloud Vertex AI');
    await expect(processors).toContainText(copy[language].developer);
    await expect(page.getByText(copy[language].routing, { exact: true })).toBeVisible();
    await captureAt(page, page.locator('[id="6-third-party-processors"]'), testInfo, `processors-${language}-${width}-${theme}.png`, width);
    const retention = page.locator('p').filter({ hasText: copy[language].paid });
    await expect(retention).toContainText(copy[language].days);
    await expect(page.locator('p').filter({ hasText: copy[language].files })).toContainText(copy[language].distinction);
    const routedRetention = page.locator('p').filter({ hasText: copy[language].zdr });
    await expect(routedRetention).toContainText(copy[language].qualification);
    for (const href of providerLinks) await expect(page.locator(`a[href="${href}"]`)).toHaveCount(1);
    await expect(page.locator('p').filter({ hasText: copy[language].global })).toBeVisible();
    await captureAt(page, retention, testInfo, `retention-${language}-${width}-${theme}.png`, width);
    await page.goto('/terms');
    await expectDate(page, language);
    await expectFooter(page, language);
    const reference = page.locator('p').filter({ has: page.locator('a[href="/privacy#6-third-party-processors"]') });
    await expect(reference).toHaveText(copy[language].terms);
    await captureAt(page, page.locator('[id="6-your-content-and-license"]'), testInfo, `terms-${language}-${width}-${theme}.png`, width);
    await page.goto('/features');
    await expectFooter(page, language);
    await captureAt(page, page.locator('.footer'), testInfo, `footer-${language}-${width}-${theme}.png`, width);
    expect(errors).toEqual([]);
  });
}

test('policy language switching keeps translated dates, content and working internal links', async ({ page }) => {
  const errors = await prepare(page, 'en', 'light');
  await page.goto('/privacy');
  for (const language of ['nl', 'en', 'nl']) {
    await page.evaluate(language => {
      const preferences = JSON.parse(localStorage.getItem('lp-preferences'));
      localStorage.setItem('lp-preferences', JSON.stringify({ ...preferences, language }));
      window.LectureI18n.setLanguage(language);
    }, language);
    await expectDate(page, language);
    await expectFooter(page, language);
    await expect(page.getByText(copy[language].routing, { exact: true })).toBeVisible();
  }
  await page.locator('.footer a[href="/terms"]').click();
  await expect(page).toHaveURL(/\/terms$/);
  await expectDate(page, 'nl');
  await page.locator('a[href="/privacy#6-third-party-processors"]').click();
  await expect(page).toHaveURL(/\/privacy#6-third-party-processors$/);
  await expect(page.locator('[id="6-third-party-processors"]')).toBeInViewport();
  expect(errors).toEqual([]);
});
