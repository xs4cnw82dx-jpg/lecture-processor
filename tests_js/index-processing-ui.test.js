const test = require('node:test');
const assert = require('node:assert/strict');

const processingUi = require('../static/js/index-processing-ui.js');

test('getAdvancedSettingsSummary reflects lecture study tools and language', () => {
  assert.equal(
    processingUi.getAdvancedSettingsSummary({
      currentMode: 'lecture-notes',
      selectedStudyFeatures: 'flashcards',
      outputLanguageValue: 'english',
      getLanguageLabel: () => 'English',
    }),
    'Flashcards only · English'
  );
});

test('getAdvancedSettingsSummary reflects interview extras and language', () => {
  assert.equal(
    processingUi.getAdvancedSettingsSummary({
      currentMode: 'interview',
      selectedInterviewFeatures: ['summary', 'sections'],
      outputLanguageValue: 'dutch',
      getLanguageLabel: () => 'Dutch',
    }),
    '2 extras · Dutch'
  );
});

test('shouldAutoOpenOtherAudio reacts to import, recording, and status text', () => {
  assert.equal(
    processingUi.shouldAutoOpenOtherAudio({
      signedIn: true,
      needsAudio: true,
      importedAudioReady: true,
    }),
    true
  );

  assert.equal(
    processingUi.shouldAutoOpenOtherAudio({
      signedIn: true,
      needsAudio: true,
      recordingState: 'paused',
    }),
    true
  );

  assert.equal(
    processingUi.shouldAutoOpenOtherAudio({
      signedIn: true,
      needsAudio: true,
      audioStatusText: '',
    }),
    false
  );
});

test('getOtherAudioSummary returns the highest-priority active audio state', () => {
  assert.equal(
    processingUi.getOtherAudioSummary({
      recordingState: 'recording',
      audioImportInFlight: true,
    }),
    'Recording in progress'
  );

  assert.equal(
    processingUi.getOtherAudioSummary({
      importedAudioReady: true,
    }),
    'Imported LMS audio ready'
  );
});
