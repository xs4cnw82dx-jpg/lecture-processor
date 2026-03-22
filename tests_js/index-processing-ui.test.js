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

test('getProcessReadinessSummary explains missing lecture-note requirements in plain language', () => {
  assert.equal(
    processingUi.getProcessReadinessSummary({
      signedIn: true,
      currentMode: 'lecture-notes',
      modeConfig: {
        'lecture-notes': {
          needsPdf: true,
          needsAudio: true,
        },
      },
      pdfReady: false,
      audioReady: false,
      hasCredits: true,
    }),
    'To continue, add your slides and add your audio.'
  );
});

test('getProcessReadinessSummary reports the ready state for imported lecture audio', () => {
  assert.equal(
    processingUi.getProcessReadinessSummary({
      signedIn: true,
      currentMode: 'lecture-notes',
      modeConfig: {
        'lecture-notes': {
          needsPdf: true,
          needsAudio: true,
        },
      },
      pdfReady: true,
      audioReady: true,
      hasCredits: true,
      importedAudioReady: true,
      hasLocalAudioFile: false,
    }),
    'Slides, imported audio, and credits ready. You can start processing.'
  );
});
