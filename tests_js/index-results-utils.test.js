const test = require('node:test');
const assert = require('node:assert/strict');

const indexResultsUtils = require('../static/js/index-results-utils.js');

test('buildDownloadOptions includes combined interview exports and PDF items when a pack exists', () => {
  const options = indexResultsUtils.buildDownloadOptions({
    currentMode: 'interview',
    currentStudyPackId: 'pack-1',
    interviewCombinedText: 'combined',
    interviewSectionsText: 'sections',
    interviewSummaryText: 'summary',
    transcript: 'raw transcript',
    downloadLabels: {
      interviewTranscript: 'Interview Transcription',
    },
  });

  const types = options.filter((entry) => !entry.divider).map((entry) => entry.type);
  assert.deepEqual(
    types,
    ['result', 'result', 'combined', 'combined', 'transcript', 'transcript', 'pdf-answers', 'pdf-no-answers']
  );
});

test('getExportCsvState prefers the visible test tab before flashcards', () => {
  const exportState = indexResultsUtils.getExportCsvState({
    currentMode: 'lecture-notes',
    activeResultsTab: 'test',
    flashcards: [{ front: 'A', back: 'B' }],
    testQuestions: [{ question: 'Q1' }],
  });

  assert.deepEqual(exportState, {
    visible: true,
    type: 'test',
    text: 'Export Practice Test CSV',
  });
});

test('buildStudyWarning explains failed interview extras clearly', () => {
  assert.equal(
    indexResultsUtils.buildStudyWarning({
      currentMode: 'interview',
      selectedInterviewFeatures: ['summary', 'sections'],
      successfulInterviewFeatures: ['summary'],
      studyGenerationError: '',
    }),
    'Some interview extras could not be generated (1 failed). Failed extras were refunded as text extraction credits.'
  );
});

test('buildFlashcardViewModel returns a safe empty state when no cards exist', () => {
  assert.deepEqual(
    indexResultsUtils.buildFlashcardViewModel([], 0, false),
    {
      hasCards: false,
      progressText: 'Card 0 of 0',
      canGoPrev: false,
      canGoNext: false,
    }
  );
});
