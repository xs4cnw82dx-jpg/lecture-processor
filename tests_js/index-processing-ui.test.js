const test = require('node:test');
const assert = require('node:assert/strict');

const processingUi = require('../static/js/index-processing-ui.js');

function createMockElement() {
  const classes = new Set();
  return {
    hidden: false,
    textContent: '',
    attributes: {},
    classList: {
      toggle(name, force) {
        if (force) classes.add(name);
        else classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
  };
}

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

test('syncProcessingLayout hides an empty secondary panel on signed-out single-upload pages', () => {
  const dom = {
    uploadSection: createMockElement(),
    pdfZone: createMockElement(),
    audioZone: createMockElement(),
    uploadEstimate: createMockElement(),
    processingSecondaryGrid: createMockElement(),
    otherAudioDisclosure: createMockElement(),
    otherAudioToggle: createMockElement(),
    otherAudioBody: createMockElement(),
    otherAudioSummary: createMockElement(),
    generationControls: createMockElement(),
    interviewControls: createMockElement(),
    advancedSettingsSummary: createMockElement(),
  };

  processingUi.syncProcessingLayout(dom, {
    signedIn: false,
    currentMode: 'slides-only',
    modeConfig: {
      'slides-only': {
        needsPdf: true,
        needsAudio: false,
      },
    },
    selectedStudyFeatures: 'both',
    selectedInterviewFeatures: [],
    outputLanguageValue: 'english',
    getLanguageLabel: () => 'English',
  });

  assert.equal(dom.uploadSection.classList.contains('single-upload'), true);
  assert.equal(dom.uploadSection.classList.contains('has-secondary-panel'), false);
  assert.equal(dom.processingSecondaryGrid.hidden, true);
  assert.equal(dom.pdfZone.hidden, false);
  assert.equal(dom.audioZone.hidden, true);
});

test('syncProcessingLayout keeps the secondary panel when interview audio options are available', () => {
  const dom = {
    uploadSection: createMockElement(),
    pdfZone: createMockElement(),
    audioZone: createMockElement(),
    uploadEstimate: createMockElement(),
    processingSecondaryGrid: createMockElement(),
    otherAudioDisclosure: createMockElement(),
    otherAudioToggle: createMockElement(),
    otherAudioBody: createMockElement(),
    otherAudioSummary: createMockElement(),
    generationControls: createMockElement(),
    interviewControls: createMockElement(),
    advancedSettingsSummary: createMockElement(),
  };

  processingUi.syncProcessingLayout(dom, {
    signedIn: true,
    currentMode: 'interview',
    modeConfig: {
      interview: {
        needsPdf: false,
        needsAudio: true,
      },
    },
    selectedStudyFeatures: 'both',
    selectedInterviewFeatures: [],
    outputLanguageValue: 'english',
    getLanguageLabel: () => 'English',
  });

  assert.equal(dom.uploadSection.classList.contains('single-upload'), true);
  assert.equal(dom.uploadSection.classList.contains('has-secondary-panel'), true);
  assert.equal(dom.processingSecondaryGrid.hidden, false);
  assert.equal(dom.pdfZone.hidden, true);
  assert.equal(dom.audioZone.hidden, false);
  assert.equal(dom.otherAudioDisclosure.hidden, false);
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
