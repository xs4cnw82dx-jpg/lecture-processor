const {test, expect} = require('@playwright/test');
const fs = require('node:fs');
const {installAccountFixture} = require('./helpers/batch-fixture');

test('Physio launcher explains offline state and preserves signed-in shell', async ({page}) => {
  await installAccountFixture(page);
  await page.route('**/healthz', route => route.abort('connectionrefused'));
  await page.goto('/physio');
  await expect(page.locator('#physio-launcher-status')).toHaveClass(/is-offline/);
  await expect(page.locator('#physio-retry-companion')).toBeEnabled();
  for (const width of [1440, 1024, 768, 390]) {
    await page.setViewportSize({width, height:900});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:`/tmp/redesign-secondary-evidence/physio-launcher-${width}.png`,fullPage:true,animations:'disabled'});
  }
  await page.getByText('Help getting started', {exact:true}).click();
  await expect(page.locator('.physio-launcher-help')).toBeVisible();
  await page.screenshot({path:'/tmp/redesign-secondary-evidence/physio-launcher-help-open.png',fullPage:true,animations:'disabled'});
  await page.getByText('Help getting started', {exact:true}).click();
  await expect(page.locator('.physio-launcher-help')).toBeHidden();
  await page.locator('#physio-retry-companion').click();
  await expect(page.locator('#physio-launcher-status')).toHaveClass(/is-offline/);
});

test('shared workouts render readable routines, completed sets and unavailable recovery', async ({page}) => {
  const template = fs.readFileSync('templates/workout_share.html','utf8')
    .replace(/\{\{ url_for\('static', filename='([^']+)'\) \}\}/g, '/static/$1')
    .replace("{{ url_for('static', filename=workout_share_js_asset or 'js/workout-share.js') }}", '/static/js/workout-share.js')
    .replace('{{ share_token|e }}','design-fixture');
  await page.route('**/workout-shares/design-fixture', route => route.fulfill({contentType:'text/html',body:template}));
  let unavailable = false;
  let share = {kind:'routine',name:'Strength & mobility',focus:'A full-body routine with controlled, comfortable movement.', exercises:[{name:'Goblet squat',muscle_group:'Quadriceps',sets:3,rep_min:8,rep_max:12,rest_seconds:90,technique:'Controlled tempo',cues:'Keep the weight close to your chest. Use a comfortable range.'}]};
  await page.route('**/api/workout-shares/design-fixture', route => route.fulfill({status:unavailable?404:200,json:{share}}));
  for (const width of [1440,390]) {
    await page.setViewportSize({width,height:900});
    await page.goto('/workout-shares/design-fixture');
    await expect(page.locator('#share-workout-card')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path:`/tmp/redesign-secondary-evidence/workout-share-routine-${width}.png`,fullPage:true,animations:'disabled'});
  }
  share={kind:'workout',name:'Full body',date:'2026-10-03',duration_seconds:2400,volume_kg:3200,completed_sets:3,exercises:[{name:'Goblet squat',sets:[{kg:16,reps:12,rpe:7},{kg:16,reps:10,rpe:8}]}]};
  await page.reload();
  await expect(page.locator('#share-workout-metrics')).toBeVisible();
  await page.screenshot({path:'/tmp/redesign-secondary-evidence/workout-share-complete-mobile.png',fullPage:true,animations:'disabled'});
  unavailable=true;
  await page.reload();
  await expect(page.getByRole('heading',{name:'This share is unavailable'})).toBeVisible();
  await expect(page.getByRole('link',{name:'Return to Lecture Processor'})).toHaveAttribute('href','/');
});
