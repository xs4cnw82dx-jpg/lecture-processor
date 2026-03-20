(function (root) {
  'use strict';

  function buildDownloadOptions(options) {
    var settings = options && typeof options === 'object' ? options : {};
    var currentMode = String(settings.currentMode || '').trim();
    var currentStudyPackId = String(settings.currentStudyPackId || '').trim();
    var transcript = String(settings.transcript || '').trim();
    var interviewSummaryText = String(settings.interviewSummaryText || '').trim();
    var interviewSectionsText = String(settings.interviewSectionsText || '').trim();
    var interviewCombinedText = String(settings.interviewCombinedText || '').trim();
    var labels = settings.downloadLabels || {};
    var optionsList = [];

    function addPair(type, label) {
      optionsList.push({ type: type, format: 'md', label: label, detail: 'Markdown (.md)' });
      optionsList.push({ type: type, format: 'docx', label: label, detail: 'Word Document (.docx)' });
    }

    if (currentMode === 'lecture-notes') {
      addPair('result', labels.lectureNotes || 'Lecture Notes');
      optionsList.push({ divider: true });
      addPair('slides', labels.slideExtract || 'Slide Extract');
      optionsList.push({ divider: true });
      addPair('transcript', labels.lectureTranscript || 'Lecture Transcript');
    } else if (currentMode === 'slides-only') {
      addPair('result', labels.slideExtract || 'Slide Extract');
    } else {
      addPair('result', labels.interviewTranscript || 'Interview Transcription');
      if (interviewSummaryText && interviewSectionsText && interviewCombinedText) {
        optionsList.push({ divider: true });
        addPair('combined', 'Summary + Structured Transcript');
      } else {
        if (interviewSummaryText) {
          optionsList.push({ divider: true });
          addPair('summary', 'Interview Summary');
        }
        if (interviewSectionsText) {
          optionsList.push({ divider: true });
          addPair('sections', 'Structured Transcript');
        }
      }
      if (transcript) {
        optionsList.push({ divider: true });
        addPair('transcript', 'Raw Transcript');
      }
    }

    if (currentStudyPackId) {
      optionsList.push({ divider: true });
      optionsList.push({ type: 'pdf-answers', format: 'pdf', label: 'PDF (with answers)', detail: 'Portable Document (.pdf)' });
      optionsList.push({ type: 'pdf-no-answers', format: 'pdf', label: 'PDF (without answers)', detail: 'Portable Document (.pdf)' });
    }

    return optionsList;
  }

  function resolveTextDownload(options) {
    var settings = options && typeof options === 'object' ? options : {};
    var type = String(settings.type || 'result').trim();
    var format = String(settings.format || 'md').trim();
    var currentMode = String(settings.currentMode || '').trim();
    var content = settings.resultMarkdown || '';
    var filename = 'output.md';

    if (type === 'slides') {
      content = settings.slideText || '';
      filename = format === 'md' ? 'slide-extract.md' : 'slide-extract.docx';
    } else if (type === 'transcript') {
      content = settings.transcript || '';
      filename = format === 'md' ? 'lecture-transcript.md' : 'lecture-transcript.docx';
    } else if (type === 'summary') {
      content = settings.interviewSummaryText || settings.resultMarkdown || '';
      filename = format === 'md' ? 'interview-summary.md' : 'interview-summary.docx';
    } else if (type === 'sections') {
      content = settings.interviewSectionsText || settings.resultMarkdown || '';
      filename = format === 'md' ? 'interview-structured.md' : 'interview-structured.docx';
    } else if (type === 'combined') {
      content = settings.interviewCombinedText || settings.resultMarkdown || '';
      filename = format === 'md' ? 'interview-summary-structured.md' : 'interview-summary-structured.docx';
    } else if (currentMode === 'lecture-notes') {
      filename = format === 'md' ? 'lecture-notes.md' : 'lecture-notes.docx';
    } else if (currentMode === 'slides-only') {
      filename = format === 'md' ? 'slide-extract.md' : 'slide-extract.docx';
    } else {
      filename = format === 'md' ? 'interview-transcript.md' : 'interview-transcript.docx';
    }

    return {
      content: content,
      filename: filename,
    };
  }

  function getExportCsvState(options) {
    var settings = options && typeof options === 'object' ? options : {};
    var currentMode = String(settings.currentMode || '').trim();
    var activeResultsTab = String(settings.activeResultsTab || '').trim();
    var flashcards = Array.isArray(settings.flashcards) ? settings.flashcards : [];
    var testQuestions = Array.isArray(settings.testQuestions) ? settings.testQuestions : [];

    if (currentMode === 'interview') {
      return { visible: false, type: '', text: '' };
    }
    if (activeResultsTab === 'test' && testQuestions.length) {
      return { visible: true, type: 'test', text: 'Export Practice Test CSV' };
    }
    if (flashcards.length) {
      return { visible: true, type: 'flashcards', text: 'Export Flashcards CSV' };
    }
    if (testQuestions.length) {
      return { visible: true, type: 'test', text: 'Export Practice Test CSV' };
    }
    return { visible: false, type: '', text: '' };
  }

  function buildFlashcardViewModel(flashcards, flashcardIndex, flashcardFlipped) {
    var items = Array.isArray(flashcards) ? flashcards : [];
    if (!items.length) {
      return {
        hasCards: false,
        progressText: 'Card 0 of 0',
        canGoPrev: false,
        canGoNext: false,
      };
    }
    var safeIndex = Math.max(0, Math.min(items.length - 1, Number(flashcardIndex || 0)));
    var card = items[safeIndex] || {};
    return {
      hasCards: true,
      front: card.front || '',
      back: card.back || '',
      flipped: Boolean(flashcardFlipped),
      progressText: 'Card ' + (safeIndex + 1) + ' of ' + items.length,
      canGoPrev: safeIndex > 0,
      canGoNext: safeIndex < items.length - 1,
    };
  }

  function buildQuizViewModel(testQuestions, quizIndex, quizScore) {
    var items = Array.isArray(testQuestions) ? testQuestions : [];
    if (!items.length) {
      return {
        hasQuestions: false,
        progressText: 'Question 0 of 0',
        scoreText: 'Score: 0/0',
        options: [],
      };
    }
    var safeIndex = Math.max(0, Math.min(items.length - 1, Number(quizIndex || 0)));
    var question = items[safeIndex] || {};
    return {
      hasQuestions: true,
      progressText: 'Question ' + (safeIndex + 1) + ' of ' + items.length,
      scoreText: 'Score: ' + Math.max(0, Number(quizScore || 0)) + '/' + items.length,
      questionText: question.question || '',
      explanation: question.explanation || '',
      answer: question.answer || '',
      options: Array.isArray(question.options) ? question.options.slice() : [],
      hasNext: safeIndex < items.length - 1,
    };
  }

  function evaluateQuizAnswer(testQuestions, quizIndex, quizScore, selectedOption) {
    var viewModel = buildQuizViewModel(testQuestions, quizIndex, quizScore);
    if (!viewModel.hasQuestions) {
      return {
        correctAnswer: '',
        explanation: '',
        hasNext: false,
        nextScore: 0,
        selectedCorrect: false,
      };
    }
    var selectedCorrect = String(selectedOption || '') === String(viewModel.answer || '');
    return {
      correctAnswer: viewModel.answer,
      explanation: viewModel.explanation,
      hasNext: viewModel.hasNext,
      nextScore: Math.max(0, Number(quizScore || 0)) + (selectedCorrect ? 1 : 0),
      selectedCorrect: selectedCorrect,
    };
  }

  function buildStudyWarning(options) {
    var settings = options && typeof options === 'object' ? options : {};
    var currentMode = String(settings.currentMode || '').trim();
    var studyGenerationError = String(settings.studyGenerationError || '').trim();
    var studyFeatures = String(settings.studyFeatures || '').trim();
    var selectedInterviewFeatures = Array.isArray(settings.selectedInterviewFeatures) ? settings.selectedInterviewFeatures : [];
    var successfulInterviewFeatures = Array.isArray(settings.successfulInterviewFeatures) ? settings.successfulInterviewFeatures : [];

    if (currentMode === 'interview') {
      if (studyGenerationError) {
        return studyGenerationError;
      }
      if (!selectedInterviewFeatures.length) {
        return 'No interview extras selected. Showing the transcript only.';
      }
      if (successfulInterviewFeatures.length < selectedInterviewFeatures.length) {
        var failed = selectedInterviewFeatures.length - successfulInterviewFeatures.length;
        return 'Some interview extras could not be generated (' + failed + ' failed). Failed extras were refunded as text extraction credits.';
      }
      return '';
    }
    if (studyGenerationError) {
      return studyGenerationError;
    }
    if (studyFeatures === 'none') {
      return 'Study tools were disabled for this generation (Notes-only mode).';
    }
    return '';
  }

  var exported = {
    buildDownloadOptions: buildDownloadOptions,
    buildFlashcardViewModel: buildFlashcardViewModel,
    buildQuizViewModel: buildQuizViewModel,
    buildStudyWarning: buildStudyWarning,
    evaluateQuizAnswer: evaluateQuizAnswer,
    getExportCsvState: getExportCsvState,
    resolveTextDownload: resolveTextDownload,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exported;
  }

  root.LectureProcessorIndexResults = Object.assign({}, root.LectureProcessorIndexResults || {}, exported);
})(typeof window !== 'undefined' ? window : globalThis);
