const test = require('node:test');
const assert = require('node:assert/strict');

const audioImportUtils = require('../static/js/lecture-audio-import-utils.js');

test('describeAudioImportRequest imports a pasted LMS URL when no audio is selected', () => {
  const result = audioImportUtils.describeAudioImportRequest({
    mode: 'lecture-notes',
    url: ' https://example.com/index.m3u8?token=1 ',
    hasLocalAudioFile: false,
    importedAudioToken: '',
    importedAudioSourceUrl: '',
  });

  assert.deepEqual(result, { shouldImport: true, reason: 'import' });
});

test('describeAudioImportRequest skips re-import when the same URL is already imported', () => {
  const result = audioImportUtils.describeAudioImportRequest({
    mode: 'lecture-notes',
    url: 'https://example.com/index.m3u8?token=1',
    hasLocalAudioFile: false,
    importedAudioToken: 'tok-1',
    importedAudioSourceUrl: 'https://example.com/index.m3u8?token=1',
  });

  assert.deepEqual(result, { shouldImport: false, reason: 'already-imported' });
});

test('describeAudioImportRequest requests a replacement import when pasted URL changes', () => {
  const result = audioImportUtils.describeAudioImportRequest({
    mode: 'lecture-notes',
    url: 'https://example.com/new/index.m3u8?token=2',
    hasLocalAudioFile: false,
    importedAudioToken: 'tok-1',
    importedAudioSourceUrl: 'https://example.com/old/index.m3u8?token=1',
  });

  assert.deepEqual(result, { shouldImport: true, reason: 'replace-imported-audio' });
});

test('describeAudioImportRequest suppresses LMS import when a local audio file is selected', () => {
  const result = audioImportUtils.describeAudioImportRequest({
    mode: 'lecture-notes',
    url: 'https://example.com/index.m3u8?token=1',
    hasLocalAudioFile: true,
    importedAudioToken: '',
    importedAudioSourceUrl: '',
  });

  assert.deepEqual(result, { shouldImport: false, reason: 'local-audio-selected' });
});

test('hasReadyImportedAudioToken requires the current URL to match the imported source URL', () => {
  assert.equal(audioImportUtils.hasReadyImportedAudioToken({
    url: 'https://example.com/index.m3u8?token=1',
    importedAudioToken: 'tok-1',
    importedAudioSourceUrl: 'https://example.com/index.m3u8?token=1',
  }), true);

  assert.equal(audioImportUtils.hasReadyImportedAudioToken({
    url: 'https://example.com/other/index.m3u8?token=2',
    importedAudioToken: 'tok-1',
    importedAudioSourceUrl: 'https://example.com/index.m3u8?token=1',
  }), false);
});
