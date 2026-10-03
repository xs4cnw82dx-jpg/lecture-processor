const { test, expect } = require('@playwright/test');
const { installAccountFixture } = require('./helpers/batch-fixture');
const { expectProductControls } = require('./helpers/control-audit');
const fs = require('node:fs');
test.use({ serviceWorkers:'block' });

test('Voice detail plays stored audio with the shared controls', async ({page}) => {
  await installAccountFixture(page);
  const wav = Buffer.alloc(44 + 128000);
  wav.write('RIFF',0); wav.writeUInt32LE(wav.length-8,4); wav.write('WAVEfmt ',8);
  wav.writeUInt32LE(16,16); wav.writeUInt16LE(1,20); wav.writeUInt16LE(1,22);
  wav.writeUInt32LE(8000,24); wav.writeUInt32LE(16000,28); wav.writeUInt16LE(2,32);
  wav.writeUInt16LE(16,34); wav.write('data',36); wav.writeUInt32LE(128000,40);
  await page.goto('/voice-notes');
  await expect(page.locator('#voice-record-btn')).toBeVisible();
  await page.evaluate(async bytes => {
    const db = await new Promise(resolve => {const request=indexedDB.open('lecture-processor-voice-notes',2);request.onsuccess=()=>resolve(request.result);});
    await new Promise(resolve => {
      const tx=db.transaction(['notes','audio'],'readwrite');
      tx.objectStore('notes').put({id:'playback-note',owner_key:'user:a',local_audio_id:'playback-note',title:'A clearer way to review anatomy',status:'synced',transcript:'Start with the main idea. Explain it in your own words, then check what you missed.',notes_markdown:'# Study reflection\n\nStart with the main idea. Explain it in your own words, then check what you missed.',created_at:Date.now()/1000});
      tx.objectStore('audio').put({id:'playback-note',owner_key:'user:a',blob:new Blob([new Uint8Array(bytes)],{type:'audio/wav'}),name:'reflection.wav'});
      tx.oncomplete=resolve;
    });
    db.close();
  },Array.from(wav));
  await page.reload();
  await page.locator('[data-voice-view="library"]').click();
  await page.locator('[data-note-open]').click();
  const player=page.locator('#voice-detail .app-media-player');
  await expect(player.locator('.app-media-time')).toContainText('/ 0:08');
  await expect(player.getByRole('status')).toHaveText('');
  await player.getByRole('button',{name:'Play',exact:true}).click();
  await expect.poll(()=>page.locator('#voice-audio').evaluate(node=>node.currentTime)).toBeGreaterThan(0);
  await player.getByRole('button',{name:'Pause',exact:true}).click();
  fs.mkdirSync('/tmp/redesign-creation-evidence',{recursive:true});
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:950});
    await expectProductControls(page);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({path:`/tmp/redesign-creation-evidence/voice-player-detail-${width}.png`,fullPage:true,animations:'disabled'});
  }
  await page.locator('#voice-back-btn').click();
  await expect(page.locator('#voice-detail')).toBeHidden();
  await expect(page.locator('#voice-audio')).toHaveJSProperty('paused',true);
});
