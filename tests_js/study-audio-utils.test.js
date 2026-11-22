const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load() {
  const window = {};
  vm.runInNewContext(fs.readFileSync('static/js/study-audio-utils.js', 'utf8'), { window, encodeURIComponent });
  return window.LectureProcessorStudyAudio;
}

test('audio playback asks for a short-lived stream link instead of fetching the file', async () => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, method: options && options.method }); return { ok: true, json: async () => ({ stream_url: 'https://signed.example/stream?t=1' }) }; };
  const url = await load().fetchAudioStreamUrl(fetcher, 'pack 1');
  assert.equal(url, 'https://signed.example/stream?t=1');
  assert.deepEqual(calls, [{ url: '/api/study-packs/pack%201/audio-token', method: 'POST' }]);
});

test('audio playback reports server errors and a missing stream link', async () => {
  const utils = load();
  await assert.rejects(utils.fetchAudioStreamUrl(async () => ({ ok: false, json: async () => ({ error: 'Audio expired' }) }), 'p'), /Audio expired/);
  await assert.rejects(utils.fetchAudioStreamUrl(async () => ({ ok: true, json: async () => ({}) }), 'p'), /Could not prepare audio playback/);
  await assert.rejects(utils.fetchAudioStreamUrl(null, 'p'), /unavailable/);
});
