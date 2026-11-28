const { test, expect } = require('./helpers/academy-service');

const headers = { Authorization: 'Bearer academy-preview-token' };

async function publishCourse(request, origin, title) {
  const response = await request.post(origin + '/api/elearning/expeditions', {
    headers,
    data: {
      title, defaultLanguage: 'nl', enabledLanguages: ['nl', 'de'],
      startPage: { title: { nl: title, de: title } },
      modules: [{ id: 'station', title: { nl: 'Station' }, steps: [{ id: 'intro', title: { nl: 'Welkom' }, blocks: [] }] }],
    },
  });
  expect(response.status()).toBe(201);
  const { expedition } = await response.json();
  const courseApi = origin + '/api/elearning/expeditions/' + expedition.id;
  const shared = await request.post(courseApi + '/sharing', {
    headers, data: { action: 'update_public', enabled: true, collectResponses: true },
  });
  expect(shared.ok()).toBe(true);
  const { share } = await shared.json();
  return { courseApi, publicApi: origin + '/api/elearning/public/' + share.token, id: expedition.id, title };
}

async function submitSession(request, course, sessionId, language) {
  const published = await request.get(course.publicApi);
  expect(published.ok()).toBe(true);
  const { expedition } = await published.json();
  const saved = await request.post(course.publicApi + '/responses', {
    data: {
      sessionId, language, consent: true, collectionVersion: expedition.shareOptions.collectionVersion,
      completed: true, visitedStepIds: ['intro'],
    },
  });
  expect(saved.ok()).toBe(true);
}

async function allSessions(request, course) {
  const response = await request.get(course.courseApi + '/responses', { headers });
  expect(response.ok()).toBe(true);
  return (await response.json()).summary.totalSessions;
}

test('a course owner can cancel or clear every language and collect new results on the same learner link', async ({ academyPage: page, academyOrigin, request }, testInfo) => {
  const target = await publishCourse(request, academyOrigin, 'Expeditie opnieuw starten');
  const other = await publishCourse(request, academyOrigin, 'Andere expeditie');
  await submitSession(request, target, 'eerste-sessie', 'nl');
  await submitSession(request, target, 'tweede-sessie', 'de');
  await submitSession(request, other, 'eerste-sessie', 'nl');
  await page.goto(academyOrigin + '/expedities/' + target.id + '/resultaten?language=nl');
  const participants = page.locator('.el-split-figure').filter({ has: page.getByRole('button', { name: 'Uitleg bij Deelnemers' }) }).getByRole('definition');
  await expect(participants).toHaveText('1');

  const openReset = page.getByRole('button', { name: 'Statistieken wissen', exact: true });
  await openReset.click();
  const confirmation = page.getByRole('dialog', { name: 'Statistieken wissen?' });
  await expect(confirmation).toContainText(target.title);
  const cancel = confirmation.getByRole('button', { name: 'Annuleren' });
  await expect(cancel).toBeFocused();
  await page.screenshot({ animations: 'disabled', path: testInfo.outputPath('reset-confirmation.png') });
  await cancel.click();
  await expect(confirmation).toBeHidden();
  expect(await allSessions(request, target)).toBe(2);

  await openReset.click();
  await confirmation.getByRole('button', { name: 'Definitief wissen' }).click();
  await expect(confirmation).toBeHidden();
  await expect(participants).toHaveText('0');
  expect(await allSessions(request, target)).toBe(0);
  expect(await allSessions(request, other)).toBe(1);

  await submitSession(request, target, 'nieuwe-sessie', 'nl');
  await page.reload();
  await expect(participants).toHaveText('1');
});
