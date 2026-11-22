// Study Library Pack Builder: the full-screen create/edit overlay, autosave,
// CSV import (single pack and bulk), the demo pack and the CSV template.
// Loaded as a classic script just BEFORE study.js, so these functions exist
// even for study.js code that runs during page load (the auth callback can run
// between scripts). Keep this file to function declarations only: their bodies
// use study.js's top-level names (state, DOM refs, helpers) when called.
// Shared with study.js.
/* global BUILDER_AUTOSAVE_DELAY_MS, MAX_BUILDER_IMPORT_FILES, activeEditorPane, apiCall,
   audioHiddenForBuilder:writable, auth, builderAddCardBtn, builderAddQuestionBtn,
   builderAdvancedMetadataOpen:writable, builderApplyImportBtn, builderAutoSaveQueued:writable,
   builderAutoSaveTimer:writable, builderAutoSaving:writable, builderBlockInput, builderBrandSub,
   builderBulkImporting:writable, builderCourseInput, builderCsvInput, builderDirty:writable,
   builderDraft:writable, builderExitOverlay, builderExitResolver:writable, builderFlashcardList,
   builderFolderSelect, builderImportErrors, builderImportMode, builderImportParsed:writable,
   builderImportSummary, builderImportType, builderMode:writable, builderNotesInput, builderOverlay,
   builderPackId:writable, builderPaneButtons, builderPreview, builderPreviewList, builderQuestionList,
   builderSemesterInput, builderStatCards, builderStatDirty, builderStatQuestions, builderSubEl,
   builderSubjectInput, builderSummary, builderTemplateBtn, builderTitleEl, builderTitleInput,
   closeModal, creatingDemoPack:writable, discardPackEditDrafts, downloadUtils, editText,
   ensureCsvParser, escapeHtml, flushInlineAutosave, folders, formatPackCountSummary,
   hasBlockedPackEdits, isBuiltInFolderId, isCurrentPackEdit, loadData, normalizeQuestion, openModal,
   openPackSeq, packEditController, packEditPending, packEmptyDemoBtn, packs, queuePackEditDraft,
   refreshLibraryAfterWorkspace, renderLoadedPack, renderNotesForSelectedPackBase,
   renderPackEditNotice, renderPacks, resetInlineEditorViews, resetStudyBuilderEntryState,
   revealDeferredStudyLibraryShell, selectedFolderId, selectedPack, selectedPackId:writable,
   setBodyScrollLocked, setEditorPane, setHidden, setSafeInnerHtml, showToast, studyCacheEpoch,
   studyLibraryUtils, syncBuilderAdvancedMetadataState, syncInlineMetadataInputs, syncTabSelection,
   updateAudioBarVisibility, updatePackEditStatus, updateShareActionAvailability */
// Set here, read by study.js.
/* exported audioHiddenForBuilder, builderAdvancedMetadataOpen */
// Defined here and used by study.js.
/* exported closeBuilderExitModal, createDefaultQuestion, createDemoPack, downloadBuilderTemplate,
   handleBuilderCsvFiles, handleBuilderExitRequest, openCsvImportBuilder,
   syncBuilderQuestionAnswerSelect */
/* ── Fullscreen Pack Builder ── */
function createDefaultQuestion() {
  return normalizeQuestion({
    question: 'New question',
    options: ['Option A', 'Option B', 'Option C', 'Option D'],
    answer: 'Option A',
    explanation: ''
  });
}
function buildDraftFromPack(pack) {
  var source = pack || {};
  return {
    title: source.title || '',
    folder_id: source.folder_id || '',
    course: source.course || '',
    subject: source.subject || '',
    semester: source.semester || '',
    block: source.block || '',
    notes_markdown: source.notes_markdown || '',
    flashcards: (source.flashcards || []).map(function (card) {
      return { front: card.front || '', back: card.back || '', image_ids: (card.image_ids || []).slice() };
    }),
    test_questions: (source.test_questions || []).map(function (q) {
      return normalizeQuestion(q);
    })
  };
}
function clearBuilderAutoSaveTimer() {
  if (builderAutoSaveTimer) {
    window.clearTimeout(builderAutoSaveTimer);
    builderAutoSaveTimer = null;
  }
}
function updateBuilderDirtyIndicator() {
  if (!builderStatDirty) return;
  if (builderMode === 'edit' && hasBlockedPackEdits()) {
    builderStatDirty.textContent = editText('Changes need review');
    builderStatDirty.className = 'builder-status error';
    return;
  }
  if (builderAutoSaving) {
    builderStatDirty.textContent = editText('Saving...');
    builderStatDirty.className = 'builder-status saving';
    return;
  }
  if (builderMode === 'create' && !builderPackId) {
    builderStatDirty.textContent = editText('Not saved yet');
    builderStatDirty.className = 'builder-status pending';
    return;
  }
  if (builderDirty) {
    builderStatDirty.textContent = editText('Auto-save pending');
    builderStatDirty.className = 'builder-status pending';
    return;
  }
  builderStatDirty.textContent = editText('Saved');
  builderStatDirty.className = 'builder-status saved';
}
function scheduleBuilderAutoSave() {
  if (builderMode !== 'edit' || !builderDraft) { return; }
  if (!builderOverlay.classList.contains('visible')) { return; }
  if (builderAutoSaving) {
    builderAutoSaveQueued = true;
    return;
  }
  clearBuilderAutoSaveTimer();
  builderAutoSaveTimer = window.setTimeout(function () {
    builderAutoSaveTimer = null;
    if (!builderDirty || builderMode !== 'edit' || !builderDraft) { return; }
    if (!builderOverlay.classList.contains('visible')) { return; }
    builderAutoSaving = true;
    var controller = packEditController, draft = builderDraft;
    updateBuilderDirtyIndicator();
    saveBuilderPack(false, { silent: true, refreshAfterSave: false, skipAutoSave: true, autoSavedToast: true })
      .finally(function () {
        if (!isCurrentPackEdit(controller) || builderDraft !== draft) return;
        builderAutoSaving = false;
        updateBuilderDirtyIndicator();
        if (builderAutoSaveQueued) {
          builderAutoSaveQueued = false;
          scheduleBuilderAutoSave();
        }
      });
  }, BUILDER_AUTOSAVE_DELAY_MS);
}
function markBuilderDirty(value, options) {
  var opts = options || {};
  builderDirty = (value !== false);
  if (builderDirty && builderMode === 'edit') queuePackEditDraft();
  if (!builderDirty) {
    builderAutoSaveQueued = false;
    clearBuilderAutoSaveTimer();
  }
  updateBuilderDirtyIndicator();
  if (builderDirty && !opts.skipAutoSave) {
    scheduleBuilderAutoSave();
  }
}
function updateBuilderStats() {
  if (!builderDraft) { return; }
  builderStatCards.textContent = String((builderDraft.flashcards || []).length);
  builderStatQuestions.textContent = String((builderDraft.test_questions || []).length);
  builderSummary.textContent = formatPackCountSummary(
    (builderDraft.flashcards || []).length,
    (builderDraft.test_questions || []).length
  );
}
function renderBuilderFolderSelect() {
  var options = [{ folder_id: '', name: 'No folder' }].concat(folders.map(function (folder) {
    return { folder_id: folder.folder_id, name: folder.name };
  }));
  setSafeInnerHtml(builderFolderSelect, options.map(function (item) {
    return '<option value="' + escapeHtml(item.folder_id) + '">' + escapeHtml(item.name) + '</option>';
  }).join(''));
  builderFolderSelect.value = builderDraft && builderDraft.folder_id ? builderDraft.folder_id : '';
}
function renderBuilderInfoPane() {
  if (!builderDraft) { return; }
  builderTitleInput.value = builderDraft.title || '';
  builderCourseInput.value = builderDraft.course || '';
  builderSubjectInput.value = builderDraft.subject || '';
  builderSemesterInput.value = builderDraft.semester || '';
  builderBlockInput.value = builderDraft.block || '';
  builderNotesInput.value = builderDraft.notes_markdown || '';
  renderBuilderFolderSelect();
  syncBuilderAdvancedMetadataState();
}
function renderBuilderFlashcards() {
  if (!builderDraft) { return; }
  var cards = builderDraft.flashcards || [];
  if (!cards.length) {
    setSafeInnerHtml(builderFlashcardList, '<div class="builder-list-empty">No flashcards yet. Add one to start building your deck.<div class="builder-list-empty-actions"><button type="button" class="btn" id="builder-empty-add-card-btn">Add flashcard</button><button type="button" class="btn" id="builder-empty-import-card-btn">Import CSV</button></div></div>');
    var addCardBtn = document.getElementById('builder-empty-add-card-btn');
    var importCardBtn = document.getElementById('builder-empty-import-card-btn');
    if (addCardBtn) { addCardBtn.addEventListener('click', function () { builderAddCardBtn.click(); }); }
    if (importCardBtn) { importCardBtn.addEventListener('click', function () { setBuilderPane('import'); builderImportType.value = 'flashcards'; clearBuilderImportState(); }); }
    updateBuilderStats();
    return;
  }
  setSafeInnerHtml(builderFlashcardList, cards.map(function (card, index) {
    var frontId = 'builder-fc-front-' + index;
    var backId = 'builder-fc-back-' + index;
    return '<details class="builder-row builder-expandable" data-fc-row="' + index + '"' + (index === 0 ? ' open' : '') + '><summary><span class="builder-row-number">' + String(index + 1) + '</span><span>' + escapeHtml(card.front || 'New flashcard') + '</span><span class="builder-row-expand-label">Edit</span></summary><div class="builder-row-content">'
      + '<div class="builder-row-head"><span class="builder-row-title">Flashcard ' + (index + 1) + '</span><button class="btn danger u-btn-compact" data-delete-fc="' + index + '">Delete</button></div>'
      + '<div class="builder-split"><div class="field"><label for="' + frontId + '">Front</label><textarea id="' + frontId + '" class="u-min-h-92" data-fc-field="front" data-fc-index="' + index + '">' + escapeHtml(card.front || '') + '</textarea></div>'
      + '<div class="field"><label for="' + backId + '">Back</label><textarea id="' + backId + '" class="u-min-h-92" data-fc-field="back" data-fc-index="' + index + '">' + escapeHtml(card.back || '') + '</textarea></div></div></div></details>';
  }).join(''));
  if (window.StudyPictures && selectedPack && builderPackId) {
    builderFlashcardList.querySelectorAll('[data-fc-row]').forEach(function (row) {
      window.StudyPictures.editor(row.querySelector('.builder-row-content') || row, cards[Number(row.dataset.fcRow)], selectedPack, markBuilderDirty, renderBuilderFlashcards);
    });
  }
  updateBuilderStats();
}
function renderBuilderQuestions() {
  if (!builderDraft) { return; }
  var questions = (builderDraft.test_questions || []).map(normalizeQuestion);
  builderDraft.test_questions = questions;
  if (!questions.length) {
    setSafeInnerHtml(builderQuestionList, '<div class="builder-list-empty">No practice questions yet. Add one to begin.<div class="builder-list-empty-actions"><button type="button" class="btn" id="builder-empty-add-question-btn">Add question</button><button type="button" class="btn" id="builder-empty-import-question-btn">Import CSV</button></div></div>');
    var addQuestionBtn = document.getElementById('builder-empty-add-question-btn');
    var importQuestionBtn = document.getElementById('builder-empty-import-question-btn');
    if (addQuestionBtn) { addQuestionBtn.addEventListener('click', function () { builderAddQuestionBtn.click(); }); }
    if (importQuestionBtn) { importQuestionBtn.addEventListener('click', function () { setBuilderPane('import'); builderImportType.value = 'test'; clearBuilderImportState(); }); }
    updateBuilderStats();
    return;
  }
  setSafeInnerHtml(builderQuestionList, questions.map(function (question, index) {
    var questionId = 'builder-q-question-' + index;
    var optionPrefix = 'builder-q-option-' + index + '-';
    var answerId = 'builder-q-answer-' + index;
    var explanationId = 'builder-q-explanation-' + index;
    var answerOptions = (question.options || []).map(function (option, optionIndex) {
      var letter = ['A', 'B', 'C', 'D'][optionIndex] || '';
      return '<option value="' + escapeHtml(option) + '" ' + (question.answer === option ? 'selected' : '') + '>' + letter + ': ' + escapeHtml(option || '(empty)') + '</option>';
    }).join('');
    return '<details class="builder-row builder-expandable" data-q-row="' + index + '"' + (index === 0 ? ' open' : '') + '><summary><span class="builder-row-number">' + String(index + 1) + '</span><span>' + escapeHtml(question.question || 'New question') + '</span><span class="builder-row-expand-label">Edit</span></summary><div class="builder-row-content">'
      + '<div class="builder-row-head"><span class="builder-row-title">Question ' + (index + 1) + '</span><button class="btn danger u-btn-compact" data-delete-q="' + index + '">Delete</button></div>'
      + '<div class="field"><label for="' + questionId + '">Question</label><textarea id="' + questionId + '" class="u-min-h-86" data-q-field="question" data-q-index="' + index + '">' + escapeHtml(question.question || '') + '</textarea></div>'
      + '<div class="builder-grid-3 u-mt-8">'
      + '<div class="field"><label for="' + optionPrefix + '0">Option A</label><input id="' + optionPrefix + '0" data-q-option="0" data-q-index="' + index + '" value="' + escapeHtml(question.options[0] || '') + '"></div>'
      + '<div class="field"><label for="' + optionPrefix + '1">Option B</label><input id="' + optionPrefix + '1" data-q-option="1" data-q-index="' + index + '" value="' + escapeHtml(question.options[1] || '') + '"></div>'
      + '<div class="field"><label for="' + optionPrefix + '2">Option C</label><input id="' + optionPrefix + '2" data-q-option="2" data-q-index="' + index + '" value="' + escapeHtml(question.options[2] || '') + '"></div>'
      + '</div><div class="builder-grid u-mt-8">'
      + '<div class="field"><label for="' + optionPrefix + '3">Option D</label><input id="' + optionPrefix + '3" data-q-option="3" data-q-index="' + index + '" value="' + escapeHtml(question.options[3] || '') + '"></div>'
      + '<div class="field"><label for="' + answerId + '">Correct Answer</label><select id="' + answerId + '" class="builder-select" data-app-select data-q-answer="' + index + '">' + answerOptions + '</select></div>'
      + '</div><div class="field u-mt-8"><label for="' + explanationId + '">Explanation (optional)</label><textarea id="' + explanationId + '" class="u-min-h-72" data-q-field="explanation" data-q-index="' + index + '">' + escapeHtml(question.explanation || '') + '</textarea></div></div></details>';
  }).join(''));
  updateBuilderStats();
}
function syncBuilderQuestionAnswerSelect(row, question) {
  if (!row || !question) return;
  var select = row.querySelector('[data-q-answer]');
  if (!select) return;
  Array.prototype.slice.call(select.options || []).forEach(function (option, optionIndex) {
    var optionValue = question.options[optionIndex] || '';
    option.value = optionValue;
    option.textContent = (['A', 'B', 'C', 'D'][optionIndex] || 'A') + ': ' + (optionValue || '(empty)');
    option.selected = question.answer === optionValue;
  });
}
function setBuilderPane(nextPane) {
  syncTabSelection(builderPaneButtons, 'builderPane', nextPane);
}
function clearBuilderImportState() {
  builderImportParsed = null;
  setBuilderBulkImportBusy(false);
  setBuilderImportButtonState('Apply Import', true);
  setHidden(builderPreview, true);
  if (builderPreviewList) builderPreviewList.innerHTML = '';
  setHidden(builderImportErrors, true);
  builderImportErrors.textContent = '';
  builderImportSummary.textContent = 'No file loaded.';
}
function getDefaultManualPackFolderId() {
  return selectedFolderId && !isBuiltInFolderId(selectedFolderId) ? selectedFolderId : '';
}
function openBuilderOverlay(mode, pack) {
  var controller = packEditController;
  var uid = auth.currentUser && auth.currentUser.uid, epoch = studyCacheEpoch, seq = openPackSeq;
  return flushInlineAutosave().then(function (saved) {
    if (!saved || !auth.currentUser || auth.currentUser.uid !== uid || studyCacheEpoch !== epoch || seq !== openPackSeq ||
      (controller && !isCurrentPackEdit(controller))) return false;
    openBuilderOverlayReady(mode, mode === 'create' ? pack : selectedPack);
    return true;
  });
}
function openBuilderOverlayReady(mode, pack) {
  var openingCreate = (mode === 'create');
  revealDeferredStudyLibraryShell();
  builderMode = openingCreate ? 'create' : 'edit';
  builderAutoSaving = false;
  builderAutoSaveQueued = false;
  clearBuilderAutoSaveTimer();
  builderPackId = openingCreate ? '' : (pack && pack.study_pack_id ? pack.study_pack_id : selectedPackId);
  builderDraft = openingCreate ? buildDraftFromPack({
    title: '',
    folder_id: getDefaultManualPackFolderId(),
    notes_markdown: '',
    flashcards: [],
    test_questions: []
  }) : buildDraftFromPack(pack || selectedPack || {});
  builderAdvancedMetadataOpen = !openingCreate && (
    !!String(builderDraft.semester || '').trim() ||
    !!String(builderDraft.block || '').trim()
  );
  builderTitleEl.textContent = openingCreate ? 'Create Study Pack' : 'Edit Study Pack';
  builderSubEl.textContent = openingCreate ? 'Start from scratch in a focused fullscreen workspace' : 'Refine cards, metadata, and imports in one place';
  builderBrandSub.textContent = openingCreate ? 'Manual creation flow' : 'Editing ' + (builderDraft.title || 'Untitled pack');
  renderBuilderInfoPane();
  renderBuilderFlashcards();
  renderBuilderQuestions();
  clearBuilderImportState();
  setBuilderPane('info');
  markBuilderDirty(false);
  updateBuilderStats();
  updateShareActionAvailability();
  audioHiddenForBuilder = true;
  updateAudioBarVisibility();
  openModal(builderOverlay, builderTitleInput);
  setBodyScrollLocked(true);
  renderPackEditNotice();
}
function closeBuilderOverlay() {
  builderAutoSaving = false;
  builderAutoSaveQueued = false;
  clearBuilderAutoSaveTimer();
  closeModal(builderOverlay);
  setBodyScrollLocked(false);
  builderDraft = null;
  builderPackId = '';
  builderImportParsed = null;
  audioHiddenForBuilder = false;
  updateAudioBarVisibility();
  updateShareActionAvailability();
  resetStudyBuilderEntryState();
  refreshLibraryAfterWorkspace();
}
function openBuilderExitModal() {
  openModal(builderExitOverlay);
  return new Promise(function (resolve) { builderExitResolver = resolve; });
}
function closeBuilderExitModal(choice) {
  closeModal(builderExitOverlay);
  if (builderExitResolver) {
    builderExitResolver(choice);
    builderExitResolver = null;
  }
}
function handleBuilderExitRequest() {
  if (!builderDirty) {
    closeBuilderOverlay();
    return;
  }
  openBuilderExitModal().then(function (choice) {
    if (choice === 'save') {
      saveBuilderPack(true);
      return;
    }
    if (choice === 'discard') {
      if (builderMode === 'edit') discardPackEditDrafts().then(function (discarded) { if (discarded) closeBuilderOverlay(); });
      else { markBuilderDirty(false); closeBuilderOverlay(); }
    }
  });
}
function getBuilderPayload() {
  return {
    title: (builderDraft.title || '').trim(),
    folder_id: builderDraft.folder_id || '',
    course: (builderDraft.course || '').trim(),
    subject: (builderDraft.subject || '').trim(),
    semester: (builderDraft.semester || '').trim(),
    block: (builderDraft.block || '').trim(),
    notes_markdown: builderDraft.notes_markdown || '',
    flashcards: builderDraft.flashcards || [],
    test_questions: (builderDraft.test_questions || []).map(normalizeQuestion)
  };
}
function getDemoPackPayload() {
  return {
    title: 'Demo Pack: Active Recall Basics',
    course: 'Study Skills',
    subject: 'Active Recall',
    semester: 'Demo',
    block: 'Starter',
    notes_markdown: '# Active Recall Starter Notes\n\n## What active recall means\n\nActive recall is studying by forcing yourself to retrieve information from memory instead of rereading notes.\n\n## Quick method\n\n1. Read a short section.\n2. Hide the notes.\n3. Write or say what you remember.\n4. Check gaps and repeat.\n\n## Spaced repetition link\n\nUse increasing review intervals to revisit material before you forget it. Keep difficult cards in shorter intervals.',
    flashcards: [
      { front: 'What is active recall?', back: 'A study method where you retrieve information from memory instead of passively rereading.' },
      { front: 'What should you do immediately after reading a short section?', back: 'Hide the notes and try to recall the key points from memory.' },
      { front: 'Why combine active recall with spaced repetition?', back: 'It improves long-term retention by reviewing just before forgetting.' },
      { front: 'What should you do after checking recall mistakes?', back: 'Correct the gaps and test yourself again.' }
    ],
    test_questions: [
      { question: 'Which action best matches active recall?', options: ['Highlighting without testing', 'Rereading the same paragraph', 'Explaining the topic from memory', 'Copying slides word-for-word'], answer: 'Explaining the topic from memory', explanation: 'Active recall focuses on retrieval practice.' },
      { question: 'What is the main goal of spaced repetition?', options: ['Study once for a long time', 'Review right before forgetting', 'Memorize only definitions', 'Avoid testing'], answer: 'Review right before forgetting', explanation: 'Spacing review sessions strengthens memory efficiently.' },
      { question: 'After a failed recall attempt, what should you do next?', options: ['Skip the topic', 'Check notes and retry', 'Only read summaries', 'Delete the card'], answer: 'Check notes and retry', explanation: 'Feedback plus another recall attempt closes the memory gap.' }
    ]
  };
}
function createDemoPack() {
  if (!auth.currentUser) { showToast('Please sign in first.', 'error'); return; }
  if (creatingDemoPack) { return; }
  creatingDemoPack = true;
  var originalText = packEmptyDemoBtn ? packEmptyDemoBtn.textContent : 'Create demo pack';
  if (packEmptyDemoBtn) {
    packEmptyDemoBtn.disabled = true;
    packEmptyDemoBtn.textContent = 'Creating demo pack...';
  }
  apiCall('/api/study-packs', { method: 'POST', body: JSON.stringify(getDemoPackPayload()) })
    .then(function (response) {
      var createdId = response && response.study_pack_id ? response.study_pack_id : '';
      if (!createdId) { throw new Error('Could not create demo pack'); }
      showToast('Demo pack created.');
      return loadData(createdId);
    })
    .catch(function (e) {
      showToast(e.message || 'Could not create demo pack.', 'error');
    })
    .finally(function () {
      creatingDemoPack = false;
      if (packEmptyDemoBtn) {
        packEmptyDemoBtn.disabled = false;
        packEmptyDemoBtn.textContent = originalText;
      }
    });
}
function openCsvImportBuilder() {
  if (!auth.currentUser) {
    showToast('Please sign in first.', 'error');
    return;
  }
  openBuilderOverlay('create', null).then(function (opened) {
  if (!opened) return;
  setBuilderPane('import');
  if (builderImportType) {
    builderImportType.value = 'flashcards';
  }
  clearBuilderImportState();
  if (builderCsvInput) {
    window.setTimeout(function () {
      if (builderOverlay && builderOverlay.classList.contains('visible') && !builderBulkImporting) {
        builderCsvInput.click();
      }
    }, 0);
  }
  });
}
function saveBuilderPack(closeAfter, options) {
  if (!builderDraft) { return Promise.resolve(); }
  var opts = options || {};
  var controller = packEditController, draft = builderDraft;
  if (builderMode === 'edit') {
    clearBuilderAutoSaveTimer(); builderAutoSaveQueued = false;
    return flushInlineAutosave({ showNoChangesToast: !opts.silent }).then(function (saved) {
      if (!isCurrentPackEdit(controller) || builderDraft !== draft) return false;
      updatePackEditStatus();
      if (saved && !packEditPending()) {
        syncInlineMetadataInputs(); resetInlineEditorViews(); renderNotesForSelectedPackBase(); setEditorPane(activeEditorPane);
        if (closeAfter) closeBuilderOverlay();
      }
      return saved;
    });
  }
  var payload = getBuilderPayload();
  if (!payload.title) {
    payload.title = 'Untitled pack';
  }
  clearBuilderAutoSaveTimer();
  builderAutoSaveQueued = false;
  var uid = auth.currentUser && auth.currentUser.uid, epoch = studyCacheEpoch;
  function current() { return auth.currentUser && auth.currentUser.uid === uid && studyCacheEpoch === epoch && builderDraft === draft; }
  var request = apiCall('/api/study-packs', { method: 'POST', body: JSON.stringify(payload) });
  return request.then(function (response) {
    if (!current() || !response || !response.study_pack_id) return false;
    builderPackId = response.study_pack_id; builderMode = 'edit'; selectedPackId = builderPackId;
    renderLoadedPack(Object.assign({}, payload, response, { mode: 'manual' }));
    packs.push(Object.assign({}, selectedPack)); renderPacks();
    updatePackEditStatus();
    updateShareActionAvailability();
    if (!opts.silent) {
      showToast('Study pack saved.');
    } else if (opts.autoSavedToast) {
      showToast(window.LectureI18n ? window.LectureI18n.t('Saved.') : 'Saved.', 'success');
    }
    if (closeAfter && !packEditPending()) {
      closeBuilderOverlay();
    } else {
      builderBrandSub.textContent = 'Editing ' + ((builderDraft && builderDraft.title) || 'Untitled pack');
    }
    return true;
  }).catch(function (e) {
    if (!current()) return false;
    if (!opts.silent) {
      showToast(e.message || 'Could not save builder changes.', 'error');
    }
    return false;
  });
}
function parseCsvRows(text) {
  if (!(window.Papa && typeof window.Papa.parse === 'function')) {
    return { rows: [], errors: ['CSV parser is unavailable. Reload this page and try again.'] };
  }
  var parsed = window.Papa.parse(String(text || ''), {
    delimiter: '',
    newline: '',
    quoteChar: '"',
    escapeChar: '"',
    skipEmptyLines: 'greedy',
    dynamicTyping: false
  });
  var rows = (parsed && Array.isArray(parsed.data)) ? parsed.data : [];
  var errors = (parsed && Array.isArray(parsed.errors) ? parsed.errors : []).map(function (err) {
    var rowNumber = (typeof err.row === 'number' && err.row >= 0) ? (' row ' + (err.row + 1)) : '';
    var message = String(err.message || 'Invalid CSV format');
    return 'CSV parse error' + rowNumber + ': ' + message;
  });
  return { rows: rows, errors: errors };
}
function normalizeHeader(name) {
  return String(name || '').trim().toLowerCase().replace(/[\s\-]+/g, '_');
}
function csvHeadersLookLikePracticeTest(headers) {
  return ['question', 'option_a', 'option_b', 'option_c', 'option_d', 'answer'].every(function (name) {
    return headers.indexOf(name) >= 0;
  });
}
function csvHeadersLookLikeFlashcards(headers) {
  return (headers.indexOf('front') >= 0 && headers.indexOf('back') >= 0)
    || (headers.indexOf('question') >= 0 && headers.indexOf('answer') >= 0 && !csvHeadersLookLikePracticeTest(headers));
}
function parseBuilderCsvContent(rawText, type) {
  var parsedCsv = parseCsvRows(rawText || '');
  var rows = parsedCsv.rows || [];
  var parserErrors = (parsedCsv.errors || []).slice();
  if (parserErrors.length) {
    return { type: type, items: [], errors: parserErrors, preview: [] };
  }
  if (!rows.length || rows.every(function (r) { return !r.join('').trim(); })) {
    return { type: type, items: [], errors: ['The file appears to be empty.'], preview: [] };
  }
  if (rows.length > 5001) {
    return { type: type, items: [], errors: ['CSV has too many rows. Please keep imports to 5,000 data rows or fewer.'], preview: [] };
  }
  var headers = (rows[0] || []).map(function (header) { return normalizeHeader(header.replace(/^\uFEFF/, '')); });
  if (csvHeadersLookLikePracticeTest(headers)) {
    type = 'test';
  } else if (csvHeadersLookLikeFlashcards(headers)) {
    type = 'flashcards';
  }
  var errors = [];
  var items = [];
  function idx(name) { return headers.indexOf(name); }
  if (type === 'flashcards') {
    var frontIndex = idx('front');
    var backIndex = idx('back');
    if (frontIndex < 0 || backIndex < 0) {
      // Backward compatibility
      frontIndex = idx('question');
      backIndex = idx('answer');
    }
    if (frontIndex < 0 || backIndex < 0) {
      return { type: type, items: [], errors: ['Missing required headers. Use: front, back'], preview: [] };
    }
    for (var rowIndex = 1; rowIndex < rows.length; rowIndex++) {
      var row = rows[rowIndex] || [];
      if (!row.join('').trim()) { continue; }
      if (row.length < headers.length) {
        errors.push('Row ' + (rowIndex + 1) + ': has fewer columns than the header row.');
        continue;
      }
      var front = String(row[frontIndex] || '').trim();
      var back = String(row[backIndex] || '').trim();
      if (!front || !back) {
        errors.push('Row ' + (rowIndex + 1) + ': front and back are required.');
        continue;
      }
      items.push({ front: front, back: back });
    }
  } else {
    var qIndex = idx('question'), aIndex = idx('option_a'), bIndex = idx('option_b'), cIndex = idx('option_c'), dIndex = idx('option_d'), answerIndex = idx('answer'), expIndex = idx('explanation');
    if (qIndex < 0 || aIndex < 0 || bIndex < 0 || cIndex < 0 || dIndex < 0 || answerIndex < 0) {
      return { type: type, items: [], errors: ['Missing required headers. Use: question, option_a, option_b, option_c, option_d, answer (optional explanation)'], preview: [] };
    }
    for (var qRowIndex = 1; qRowIndex < rows.length; qRowIndex++) {
      var qRow = rows[qRowIndex] || [];
      if (!qRow.join('').trim()) { continue; }
      if (qRow.length < headers.length) {
        errors.push('Row ' + (qRowIndex + 1) + ': has fewer columns than the header row.');
        continue;
      }
      var question = String(qRow[qIndex] || '').trim();
      var options = [String(qRow[aIndex] || '').trim(), String(qRow[bIndex] || '').trim(), String(qRow[cIndex] || '').trim(), String(qRow[dIndex] || '').trim()];
      var answerRaw = String(qRow[answerIndex] || '').trim();
      var explanation = expIndex >= 0 ? String(qRow[expIndex] || '').trim() : '';
      if (!question || options.some(function (opt) { return !opt; })) {
        errors.push('Row ' + (qRowIndex + 1) + ': question and all options are required.');
        continue;
      }
      if (new Set(options).size !== 4) {
        errors.push('Row ' + (qRowIndex + 1) + ': options must be unique.');
        continue;
      }
      var answer = answerRaw;
      if (/^[ABCD]$/i.test(answerRaw)) {
        answer = options['ABCD'.indexOf(answerRaw.toUpperCase())];
      }
      if (options.indexOf(answer) < 0) {
        errors.push('Row ' + (qRowIndex + 1) + ': answer must match one option or use A-D.');
        continue;
      }
      items.push({ question: question, options: options, answer: answer, explanation: explanation });
    }
  }
  return { type: type, items: items, errors: errors, preview: items.slice(0, 10) };
}
function formatBuilderImportCount(count) {
  var safeCount = Math.max(0, parseInt(count, 10) || 0);
  return safeCount + ' valid row' + (safeCount === 1 ? '' : 's');
}
function setBuilderImportButtonState(label, disabled) {
  if (!builderApplyImportBtn) return;
  builderApplyImportBtn.textContent = label || 'Apply Import';
  builderApplyImportBtn.disabled = disabled !== false;
}
function renderBuilderQuestionPreviewCard(item, index) {
  var options = Array.isArray(item.options) ? item.options.slice(0, 4) : [];
  while (options.length < 4) options.push('');
  var optionHtml = options.map(function (option, optionIndex) {
    return '<div class="builder-preview-field"><div class="builder-preview-label">Option ' + escapeHtml(['A', 'B', 'C', 'D'][optionIndex]) + '</div><div class="builder-preview-value">' + escapeHtml(option) + '</div></div>';
  }).join('');
  var answerIndex = options.indexOf(item.answer);
  var answerLabel = answerIndex >= 0 ? (['A', 'B', 'C', 'D'][answerIndex] + ': ' + item.answer) : item.answer;
  return '<article class="builder-import-preview-card">'
    + '<div class="builder-preview-card-head">Question ' + (index + 1) + '</div>'
    + '<div class="builder-preview-field builder-preview-field-wide"><div class="builder-preview-label">Question</div><div class="builder-preview-value builder-preview-question">' + escapeHtml(item.question || '') + '</div></div>'
    + '<div class="builder-preview-options">' + optionHtml + '</div>'
    + '<div class="builder-preview-field builder-preview-field-wide"><div class="builder-preview-label">Correct Answer</div><div class="builder-preview-value">' + escapeHtml(answerLabel || '') + '</div></div>'
    + '<div class="builder-preview-field builder-preview-field-wide"><div class="builder-preview-label">Explanation</div><div class="builder-preview-value builder-preview-explanation">' + escapeHtml(item.explanation || 'No explanation provided.') + '</div></div>'
    + '</article>';
}
function renderBuilderFlashcardPreviewCard(item, index) {
  return '<article class="builder-import-preview-card">'
    + '<div class="builder-preview-card-head">Flashcard ' + (index + 1) + '</div>'
    + '<div class="builder-preview-field builder-preview-field-wide"><div class="builder-preview-label">Front</div><div class="builder-preview-value">' + escapeHtml(item.front || '') + '</div></div>'
    + '<div class="builder-preview-field builder-preview-field-wide"><div class="builder-preview-label">Back</div><div class="builder-preview-value builder-preview-explanation">' + escapeHtml(item.back || '') + '</div></div>'
    + '</article>';
}
function renderBuilderImportPreview() {
  if (!builderImportParsed || !builderImportParsed.items.length) {
    setHidden(builderPreview, true);
    if (builderPreviewList) builderPreviewList.innerHTML = '';
    return;
  }
  var parsed = builderImportParsed;
  var rowsHtml = parsed.preview.map(function (item, index) {
    return parsed.type === 'flashcards'
      ? renderBuilderFlashcardPreviewCard(item, index)
      : renderBuilderQuestionPreviewCard(item, index);
  }).join('');
  setSafeInnerHtml(builderPreviewList, rowsHtml);
  setHidden(builderPreview, false);
}
function getCsvImportFileTitle(file) {
  var filename = file && file.name ? file.name : '';
  if (studyLibraryUtils && typeof studyLibraryUtils.buildStudyPackTitleFromCsvFilename === 'function') {
    return studyLibraryUtils.buildStudyPackTitleFromCsvFilename(filename, 'Untitled pack');
  }
  return String(filename || '').replace(/\.csv$/i, '').trim() || 'Untitled pack';
}
function readBuilderCsvFileAsText(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result || '')); };
    reader.onerror = function () { reject(new Error('Could not read CSV file.')); };
    reader.readAsText(file, 'utf-8');
  });
}
function fileLooksLikeCsv(file) {
  var filename = String(file && file.name || '').trim();
  var mime = String(file && file.type || '').toLowerCase();
  return /\.csv$/i.test(filename) || mime === 'text/csv' || mime === 'application/csv' || mime === 'application/vnd.ms-excel';
}
function renderBuilderImportErrorMessages(messages) {
  var safeMessages = (Array.isArray(messages) ? messages : []).filter(Boolean);
  if (!safeMessages.length) {
    setHidden(builderImportErrors, true);
    builderImportErrors.textContent = '';
    return;
  }
  var visibleMessages = safeMessages.slice(0, 25);
  if (safeMessages.length > visibleMessages.length) {
    visibleMessages.push('Showing the first 25 issues. Fix those and import again if more remain.');
  }
  setHidden(builderImportErrors, false);
  setSafeInnerHtml(builderImportErrors, visibleMessages.map(function (err) { return '<div>' + escapeHtml(err) + '</div>'; }).join(''));
}
function setBuilderBulkImportBusy(isBusy) {
  builderBulkImporting = !!isBusy;
  if (builderCsvInput) builderCsvInput.disabled = builderBulkImporting;
  if (builderImportType) builderImportType.disabled = builderBulkImporting;
  if (builderImportMode) builderImportMode.disabled = builderBulkImporting;
  if (builderTemplateBtn) builderTemplateBtn.disabled = builderBulkImporting;
}
function getBulkImportBasePayload() {
  return {
    folder_id: builderDraft && builderDraft.folder_id ? builderDraft.folder_id : '',
    course: builderDraft ? (builderDraft.course || '') : '',
    subject: builderDraft ? (builderDraft.subject || '') : '',
    semester: builderDraft ? (builderDraft.semester || '') : '',
    block: builderDraft ? (builderDraft.block || '') : '',
    notes_markdown: builderDraft ? (builderDraft.notes_markdown || '') : ''
  };
}
function createStudyPackFromImportedCsv(file, parsed) {
  var payload = Object.assign({}, getBulkImportBasePayload(), {
    title: getCsvImportFileTitle(file),
    flashcards: [],
    test_questions: []
  });
  if (parsed.type === 'flashcards') {
    payload.flashcards = parsed.items.slice();
  } else {
    payload.test_questions = parsed.items.map(normalizeQuestion);
  }
  return apiCall('/api/study-packs', { method: 'POST', body: JSON.stringify(payload) }).then(function (response) {
    var packId = response && response.study_pack_id ? response.study_pack_id : '';
    if (!packId) {
      throw new Error('Could not create study pack.');
    }
    return packId;
  });
}
function handleBuilderCsvFile(file) {
  if (!file) { return; }
  var reader = new FileReader();
  reader.onload = function () {
    builderImportSummary.textContent = 'Loading CSV parser...';
    ensureCsvParser().then(function () {
      var parsed = parseBuilderCsvContent(String(reader.result || ''), builderImportType.value);
      parsed.applied = false;
      builderImportParsed = parsed;
      if (builderImportType.value !== parsed.type) {
        builderImportType.value = parsed.type;
      }
      setBuilderImportButtonState('Apply Import', !parsed.items.length);
      builderImportSummary.textContent = parsed.items.length
        ? 'Loaded ' + formatBuilderImportCount(parsed.items.length) + '. Importing automatically...'
        : 'No valid rows found.';
      if (parsed.errors.length) {
        setHidden(builderImportErrors, false);
        setSafeInnerHtml(builderImportErrors, parsed.errors.map(function (err) { return '<div>' + escapeHtml(err) + '</div>'; }).join(''));
      } else {
        setHidden(builderImportErrors, true);
        builderImportErrors.textContent = '';
      }
      renderBuilderImportPreview();
      if (parsed.items.length) {
        applyBuilderImport({ autoSave: true });
      }
    }).catch(function () {
      builderImportParsed = null;
      setBuilderImportButtonState('Apply Import', true);
      builderImportSummary.textContent = 'CSV parser could not load.';
      setHidden(builderImportErrors, false);
      builderImportErrors.textContent = 'CSV parser could not load. Check your connection and try again.';
    });
  };
  reader.onerror = function () {
    showToast('Could not read CSV file.', 'error');
  };
  reader.readAsText(file, 'utf-8');
}
function handleBuilderCsvFiles(fileList) {
  if (builderBulkImporting) { return Promise.resolve(false); }
  var files = Array.prototype.slice.call(fileList || []).filter(Boolean);
  if (!files.length) { return Promise.resolve(false); }
  if (files.length > MAX_BUILDER_IMPORT_FILES) {
    builderImportSummary.textContent = 'Too many files selected.';
    renderBuilderImportErrorMessages(['Please import ' + MAX_BUILDER_IMPORT_FILES + ' CSV files or fewer at once.']);
    return Promise.resolve(false);
  }
  var fileErrors = [];
  var csvFiles = files.filter(function (file) {
    if (fileLooksLikeCsv(file)) return true;
    fileErrors.push((file && file.name ? file.name : 'Selected file') + ': only CSV files can be imported.');
    return false;
  });
  if (!csvFiles.length) {
    builderImportSummary.textContent = 'No CSV files selected.';
    renderBuilderImportErrorMessages(fileErrors);
    return Promise.resolve(false);
  }
  if (builderMode === 'edit' && csvFiles.length === 1 && !fileErrors.length) {
    handleBuilderCsvFile(csvFiles[0]);
    return Promise.resolve(true);
  }
  return importBuilderCsvFilesAsStudyPacks(csvFiles, fileErrors);
}
function importBuilderCsvFilesAsStudyPacks(files, initialErrors) {
  var importErrors = (initialErrors || []).slice();
  builderImportParsed = null;
  setHidden(builderPreview, true);
  if (builderPreviewList) builderPreviewList.innerHTML = '';
  setBuilderBulkImportBusy(true);
  setBuilderImportButtonState('Importing...', true);
  builderImportSummary.textContent = files.length === 1 ? 'Reading CSV file...' : 'Reading ' + files.length + ' CSV files...';
  renderBuilderImportErrorMessages(importErrors);
  return ensureCsvParser().then(function () {
    return Promise.all(files.map(function (file) {
      return readBuilderCsvFileAsText(file).then(function (text) {
        var parsed = parseBuilderCsvContent(text, builderImportType.value);
        return { file: file, parsed: parsed };
      }).catch(function (error) {
        return { file: file, read_error: error };
      });
    }));
  }).then(function (results) {
    var importable = [];
    results.forEach(function (result) {
      var file = result.file || {};
      var title = getCsvImportFileTitle(file);
      if (result.read_error) {
        importErrors.push(title + ': could not read the file.');
        return;
      }
      var parsed = result.parsed || { items: [], errors: [], type: builderImportType.value };
      (parsed.errors || []).forEach(function (error) {
        importErrors.push(title + ': ' + error);
      });
      if (!parsed.items || !parsed.items.length) {
        if (!(parsed.errors || []).length) {
          importErrors.push(title + ': no valid rows found.');
        }
        return;
      }
      importable.push({ file: file, parsed: parsed });
    });
    if (!importable.length) {
      builderImportSummary.textContent = 'No valid rows found.';
      setBuilderImportButtonState('Apply Import', true);
      renderBuilderImportErrorMessages(importErrors);
      return { createdIds: [], errors: importErrors };
    }
    var createdIds = [];
    var createErrors = [];
    return importable.reduce(function (chain, entry, index) {
      return chain.then(function () {
        builderImportSummary.textContent = 'Creating study pack ' + (index + 1) + ' of ' + importable.length + '...';
        return createStudyPackFromImportedCsv(entry.file, entry.parsed).then(function (packId) {
          createdIds.push(packId);
        }).catch(function (error) {
          createErrors.push(getCsvImportFileTitle(entry.file) + ': ' + (error.message || 'Could not create study pack.'));
        });
      });
    }, Promise.resolve()).then(function () {
      return { createdIds: createdIds, errors: importErrors.concat(createErrors) };
    });
  }).then(function (result) {
    var createdIds = result && Array.isArray(result.createdIds) ? result.createdIds : [];
    var errors = result && Array.isArray(result.errors) ? result.errors : importErrors;
    renderBuilderImportErrorMessages(errors);
    if (!createdIds.length) {
      builderImportSummary.textContent = 'No study packs were imported.';
      setBuilderImportButtonState('Apply Import', true);
      return false;
    }
    var packText = createdIds.length + ' study pack' + (createdIds.length === 1 ? '' : 's');
    builderImportSummary.textContent = errors.length
      ? 'Imported ' + packText + '. Some files or rows need attention.'
      : 'Imported ' + packText + ' from CSV.';
    setBuilderImportButtonState('Imported', true);
    showToast('Imported ' + packText + ' from CSV.', 'success');
    var preferredPackId = createdIds[createdIds.length - 1];
    if (!errors.length) {
      closeBuilderOverlay();
    }
    return loadData(preferredPackId).then(function () { return true; }).catch(function (error) {
      showToast(error.message || 'Imported CSV, but could not refresh the library.', 'error');
      return true;
    });
  }).catch(function (error) {
    builderImportParsed = null;
    setBuilderImportButtonState('Apply Import', true);
    builderImportSummary.textContent = 'CSV import failed.';
    renderBuilderImportErrorMessages([error && error.message ? error.message : 'CSV import failed. Check your connection and try again.']);
    return false;
  }).finally(function () {
    setBuilderBulkImportBusy(false);
    if (builderCsvInput) builderCsvInput.value = '';
  });
}
function saveImportedBuilderDraft(importedCount) {
  var wasCreateMode = builderMode === 'create';
  builderAutoSaving = true;
  updateBuilderDirtyIndicator();
  setBuilderImportButtonState('Saving...', true);
  return saveBuilderPack(false, {
    silent: true,
    refreshAfterSave: wasCreateMode,
    skipAutoSave: true,
    autoSavedToast: true
  }).then(function (saved) {
    if (saved) {
      builderImportSummary.textContent = 'Imported ' + formatBuilderImportCount(importedCount) + ' and saved automatically.';
      setBuilderImportButtonState('Imported', true);
      return true;
    }
    builderImportSummary.textContent = 'Imported ' + formatBuilderImportCount(importedCount) + ', but automatic save failed. Use Save Pack before exiting.';
    setBuilderImportButtonState('Imported', true);
    return false;
  }).finally(function () {
    builderAutoSaving = false;
    updateBuilderDirtyIndicator();
  });
}
function applyBuilderImport(options) {
  if (!builderDraft || !builderImportParsed || !builderImportParsed.items.length) {
    return Promise.resolve(false);
  }
  var opts = options || {};
  if (builderImportParsed.applied) {
    if (!opts.autoSave) {
      showToast('This CSV has already been imported.', 'info');
    }
    return Promise.resolve(false);
  }
  var replaceMode = builderImportMode.value === 'replace';
  if (builderImportParsed.type === 'flashcards') {
    builderDraft.flashcards = replaceMode ? builderImportParsed.items.slice() : (builderDraft.flashcards || []).concat(builderImportParsed.items);
    renderBuilderFlashcards();
  } else {
    var incoming = builderImportParsed.items.map(normalizeQuestion);
    builderDraft.test_questions = replaceMode ? incoming : (builderDraft.test_questions || []).concat(incoming);
    renderBuilderQuestions();
  }
  builderImportParsed.applied = true;
  markBuilderDirty(true, opts.autoSave ? { skipAutoSave: true } : {});
  updateBuilderStats();
  setBuilderImportButtonState('Imported', true);
  if (opts.autoSave) {
    return saveImportedBuilderDraft(builderImportParsed.items.length);
  }
  showToast('Imported ' + formatBuilderImportCount(builderImportParsed.items.length) + '.');
  return Promise.resolve(true);
}
function downloadBuilderTemplate() {
  var csvText = '';
  var filename = '';
  if (builderImportType.value === 'flashcards') {
    csvText = 'front,back\nCell membrane,Selective barrier surrounding the cell\nMitochondria,Organelle that produces ATP';
    filename = 'flashcards-template.csv';
  } else {
    csvText = 'question,option_a,option_b,option_c,option_d,answer,explanation\nWhich organelle produces ATP?,Nucleus,Mitochondria,Golgi apparatus,Ribosome,B,Mitochondria are the powerhouse of the cell.';
    filename = 'practice-test-template.csv';
  }
  var blob = new Blob([csvText], { type: 'text/csv;charset=utf-8;' });
  if (downloadUtils.saveBlobAsFile) {
    downloadUtils.saveBlobAsFile(blob, filename);
  } else {
    var link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
  }
}
