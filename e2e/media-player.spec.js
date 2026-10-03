const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');
const { expectProductControls } = require('./helpers/control-audit');
const evidence = '/tmp/redesign-creation-evidence';
require('node:fs').mkdirSync(evidence, { recursive: true });
function wav() {
  const sampleRate = 8000, dataSize = sampleRate * 8 * 2;
  const data = Buffer.alloc(44 + dataSize);
  data.write('RIFF', 0); data.writeUInt32LE(36 + dataSize, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(sampleRate * 2, 28); data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(dataSize, 40);
  return data;
}
test('shared player preserves source events and supports playback seek rate volume and resets', async ({page}) => {
  await installAccountFixture(page);
  await page.route('**/test-player.wav', route => {
    const data = wav();
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range || '');
    if (!range) return route.fulfill({ contentType:'audio/wav', headers:{'Accept-Ranges':'bytes'}, body:data });
    const start = Number(range[1]), end = range[2] ? Math.min(Number(range[2]), data.length - 1) : data.length - 1;
    return route.fulfill({ status:206, contentType:'audio/wav', headers:{'Accept-Ranges':'bytes','Content-Range':`bytes ${start}-${end}/${data.length}`}, body:data.subarray(start,end + 1) });
  });
  await page.goto('/voice-notes');
  await page.evaluate(() => {const audio=document.createElement('audio');audio.id='test-player';audio.controls=true;audio.src='/test-player.wav';document.querySelector('main').prepend(audio);window.playerEvents=0;audio.addEventListener('play',()=>window.playerEvents++);});
  const player=page.locator('.app-media-player').filter({has:page.locator('#test-player')});
  await expect(player.locator('.app-media-time')).toContainText('/ 0:08');
  expect(await page.locator('#test-player').evaluate(e=>e.controls)).toBe(false);
  await page.locator('#test-player').evaluate(e=>{e.dispatchEvent(new Event('loadstart'));e.dispatchEvent(new Event('loadedmetadata'));});
  await expect(player.getByRole('status')).toHaveText('');
  await player.getByRole('button',{name:'Play',exact:true}).click();
  await expect(player.getByRole('button',{name:'Pause',exact:true})).toBeVisible();
  await expect.poll(() => page.locator('#test-player').evaluate(e=>e.currentTime)).toBeGreaterThan(0);
  expect(await page.evaluate(()=>window.playerEvents)).toBe(1);
  await player.getByRole('button',{name:'Pause',exact:true}).click();
  await player.getByRole('slider',{name:'Playback position'}).fill('2');
  await expect.poll(() => page.locator('#test-player').evaluate(e=>e.currentTime)).toBeCloseTo(2,1);
  await player.getByRole('slider',{name:'Playback position'}).focus();
  await page.keyboard.press('End');
  await expect.poll(() => page.locator('#test-player').evaluate(e=>e.currentTime)).toBeGreaterThan(7.9);
  await player.getByRole('button',{name:'Playback speed: 1×',exact:true}).click();
  await player.getByRole('option',{name:'1.5×',exact:true}).click();
  expect(await page.locator('#test-player').evaluate(e=>e.playbackRate)).toBe(1.5);
  await player.getByRole('button',{name:'Mute',exact:true}).click();
  expect(await page.locator('#test-player').evaluate(e=>e.muted)).toBe(true);
  await player.getByRole('button',{name:'Unmute',exact:true}).click();
  await player.getByRole('slider',{name:'Volume',exact:true}).fill('0.5');
  expect(await page.locator('#test-player').evaluate(e=>e.volume)).toBe(0.5);
  await expectProductControls(page);
  for(const width of [1440,390]) {await page.setViewportSize({width,height:900});await page.screenshot({path:`${evidence}/custom-audio-${width}.png`,animations:'disabled'});}
  await page.locator('#test-player').evaluate(e=>{e.removeAttribute('src');e.load();e.hidden=true;});
  await expect(player).toBeHidden();
  await page.locator('#test-player').evaluate(e=>{e.hidden=false;});
  await expect(player.getByRole('button',{name:'Play',exact:true})).toBeDisabled();
  await expect(player.getByRole('status')).toHaveText('No audio or video available');
  await page.locator('#test-player').evaluate(e=>{e.src='/test-player.wav';});
  await expect(player.getByRole('button',{name:'Play',exact:true})).toBeEnabled();
  await expect(player.locator('.app-media-time')).toContainText('/ 0:08');
  await page.locator('#test-player').evaluate(e=>e.dispatchEvent(new Event('error')));
  await expect(player.getByRole('status')).toContainText('unavailable');
});
test('dynamic video player keeps its media element and routes fullscreen action', async({page})=>{
 await installAccountFixture(page);await page.goto('/voice-notes');
 await page.evaluate(()=>{const video=document.createElement('video');video.id='test-video';video.controls=true;document.querySelector('main').prepend(video);});
 const player=page.locator('.app-media-player').filter({has:page.locator('#test-video')});
 await expect(player).toBeVisible();expect(await page.locator('#test-video').evaluate(e=>e.controls)).toBe(false);
 await player.evaluate(e=>{e.requestFullscreen=()=>{window.requestedMediaFullscreen=true;return Promise.resolve();};});
 await player.getByRole('button',{name:'Enter fullscreen'}).click();expect(await page.evaluate(()=>window.requestedMediaFullscreen)).toBe(true);
 await expectProductControls(page);
});
