from pathlib import Path
import re


def _read(path):
    return Path(path).read_text(encoding='utf-8')


def test_study_static_form_labels_have_programmatic_targets():
    study_template = _read('templates/study.html')
    dialog_template = _read('templates/_study_dialogs.html')

    study_controls = [
        'pack-title',
        'pack-folder-button',
        'pack-course',
        'pack-subject',
        'pack-semester',
        'pack-block',
        'builder-title-input',
        'builder-folder-select',
        'builder-course-input',
        'builder-subject-input',
        'builder-semester-input',
        'builder-block-input',
        'builder-notes-input',
        'builder-import-type',
        'builder-import-mode',
    ]
    for control_id in study_controls:
        assert f'for="{control_id}"' in study_template
        assert f'id="{control_id}"' in study_template

    dialog_controls = [
        'folder-name-input',
        'folder-course-input',
        'folder-subject-input',
        'folder-semester-input',
        'folder-block-input',
        'folder-exam-date-input',
    ]
    for control_id in dialog_controls:
        assert f'for="{control_id}"' in dialog_template
        assert f'id="{control_id}"' in dialog_template


def test_study_generated_editor_labels_target_generated_controls():
    study_js = _read('static/js/study.js')

    expected_snippets = [
        'label for="\' + frontId + \'">Front</label><textarea id="\' + frontId',
        'label for="\' + backId + \'">Back</label><textarea id="\' + backId',
        'label for="\' + questionId + \'">Question</label><textarea id="\' + questionId',
        'label for="\' + optionPrefix + \'0">Option A</label><input id="\' + optionPrefix + \'0"',
        'label for="\' + answerId + \'">Correct Answer</label><select id="\' + answerId',
        'label for="\' + answerButtonId + \'">Correct Answer</label>',
        'id="\' + answerButtonId + \'" data-answer-button',
        'label for="\' + explanationId + \'">Explanation</label><textarea id="\' + explanationId',
    ]
    for snippet in expected_snippets:
        assert snippet in study_js


def test_study_feedback_regions_are_announced_to_assistive_tech():
    study_template = _read('templates/study.html')
    dialog_template = _read('templates/_study_dialogs.html')
    study_js = _read('static/js/study.js')

    assert 'id="toast" role="status" aria-live="polite" aria-atomic="true"' in dialog_template
    assert 'id="share-modal-status" role="status" aria-live="polite" aria-atomic="true"' in dialog_template
    assert 'id="builder-import-summary" role="status" aria-live="polite" aria-atomic="true"' in study_template
    assert 'id="builder-import-errors" role="alert" aria-live="assertive" aria-atomic="true"' in study_template
    assert re.search(r'id="pack-save-status"[\s\S]*?role="status"[\s\S]*?aria-live="polite"[\s\S]*?aria-atomic="true"', study_template)
    assert "toastEl.setAttribute('role', isError ? 'alert' : 'status');" in study_js
    assert "toastEl.setAttribute('aria-live', isError ? 'assertive' : 'polite');" in study_js


def test_study_csv_import_auto_applies_saves_and_uses_structured_preview():
    study_template = _read('templates/study.html')
    study_js = _read('static/js/study.js')
    study_css = _read('static/css/study.css')

    assert 'id="import-pack-csv-btn"' in study_template
    assert 'id="pack-empty-import-csv-btn"' in study_template
    assert 'CSV files apply and save automatically.' in study_template
    assert 'id="builder-csv-input"\n                  accept=".csv,text/csv" multiple hidden' in study_template
    assert 'id="builder-apply-import-btn" disabled hidden' in study_template
    assert 'id="builder-preview-list"' in study_template
    assert 'builder-preview-table' not in study_template
    assert "applyBuilderImport({ autoSave: true });" in study_js
    assert 'function csvHeadersLookLikePracticeTest(headers)' in study_js
    assert 'function csvHeadersLookLikeFlashcards(headers)' in study_js
    assert 'function handleBuilderCsvFiles(fileList)' in study_js
    assert 'function importBuilderCsvFilesAsStudyPacks(files, initialErrors)' in study_js
    assert 'getCsvImportFileTitle(file)' in study_js
    assert "saveBuilderPack(false, {" in study_js
    assert "refreshAfterSave: wasCreateMode" in study_js
    assert "builderImportType.value = 'test';" in study_js
    assert 'builder-import-preview-card' in study_js
    assert '.builder-preview-options' in study_css


def test_study_pack_modes_and_question_only_packs_have_user_friendly_defaults():
    dashboard_js = _read('static/js/dashboard.js')
    study_js = _read('static/js/study.js')

    assert 'formatPackMode(pack.mode || \'\')' in dashboard_js
    assert 'function formatStudyPackMode(mode)' in study_js
    assert "formatStudyPackMode(p.mode || '')" in study_js
    assert 'function getContentPreferredEditorPane(pack, currentPane)' in study_js
    assert "setEditorPane(getContentPreferredEditorPane(selectedPack, activeEditorPane));" in study_js
    assert "openLearnStageWithMode('test', fullscreenFromUrl);" in study_js


def test_study_tabs_expose_tab_roles_and_keyboard_support():
    study_template = _read('templates/study.html')
    study_js = _read('static/js/study.js')

    assert 'class="editor-tabs" role="tablist" aria-label="Study pack sections"' in study_template
    assert 'id="editor-tab-notes" data-editor-pane="notes" role="tab"' in study_template
    assert 'id="editor-pane-notes" role="tabpanel" aria-labelledby="editor-tab-notes"' in study_template
    assert 'class="setup-tabs" id="setup-tabs" role="tablist" aria-label="Session setup sections"' in study_template
    assert 'class="builder-nav" role="tablist" aria-label="Builder sections"' in study_template
    assert "bindTabKeyboard(editorTabs, 'editorPane', setEditorPane);" in study_js
    assert "button.setAttribute('aria-selected', isActive ? 'true' : 'false');" in study_js


def test_study_question_option_typing_updates_in_place_without_rerendering_editor():
    study_js = _read('static/js/study.js')

    inline_handler = re.search(
        r"questionEditorList\.querySelectorAll\('input\[data-option-index\]'\)[\s\S]*?\n  \}\);\n  questionEditorList\.querySelectorAll\('\[data-answer-button\]'\)",
        study_js,
    )
    assert inline_handler
    assert 'updateQuestionOptionValue' in inline_handler.group(0)
    assert 'syncQuestionAnswerPicker' in inline_handler.group(0)
    assert 'renderQuestionEditor' not in inline_handler.group(0)

    builder_handler = re.search(
        r"builderQuestionList\.addEventListener\('input'[\s\S]*?\n\}\);\nbuilderQuestionList\.addEventListener\('change'",
        study_js,
    )
    assert builder_handler
    assert 'updateQuestionOptionValue' in builder_handler.group(0)
    assert 'syncBuilderQuestionAnswerSelect' in builder_handler.group(0)
    assert 'renderBuilderQuestions' not in builder_handler.group(0)


def test_new_builder_has_distinct_unsaved_status_and_compact_mobile_header():
    study_template = _read('templates/study.html')
    study_js = _read('static/js/study.js')
    study_css = _read('static/css/study.css')

    assert 'id="builder-stat-dirty" class="builder-status pending" role="status" aria-live="polite">Not saved yet<' in study_template
    assert "if (builderMode === 'create' && !builderPackId)" in study_js
    assert "builderStatDirty.textContent = 'Not saved yet';" in study_js
    assert 'grid-template-rows: auto minmax(0, 1fr)' in study_css
    assert 'overscroll-behavior-inline: contain' in study_css
    assert '.builder-mini-stats .builder-stat:last-child' in study_css


def test_batch_mode_loads_saved_language_without_overriding_user_interaction():
    batch_mode_js = _read('static/js/batch-mode.js')

    assert "authFetch('/api/user-preferences')" in batch_mode_js
    assert 'if (outputLanguageUserTouched) return false;' in batch_mode_js
    assert "setOutputLanguage(preferences.output_language || 'english', preferences.output_language_custom || '')" in batch_mode_js
    assert 'if (user) loadOutputLanguagePreference();' in batch_mode_js


def test_study_initial_pack_load_preserves_pagination():
    study_template = _read('templates/study.html')
    study_js = _read('static/js/study.js')

    assert 'fetchAllStudyPacks' not in study_js
    assert "fetchStudyPackPage('')" in study_js
    assert 'packsHasMore = !!packPage.has_more;' in study_js
    assert "packsNextCursor = String(packPage.next_cursor || '');" in study_js
    assert 'id="pack-list-actions"' in study_template
    assert 'id="load-more-packs-btn"' in study_template
    assert 'id="pack-selection-bar"' in study_template
    assert 'id="clear-pack-selection-btn"' in study_template
    assert 'data-pack-select' in study_js
    assert 'buildStudyPackSelection(currentSelection, id, filteredPacks()' in study_js
    assert 'loadMorePacksBtn.textContent = packsLoadingMore ?' in study_js
    assert 'if (packsHasMore) { return; }' in study_js


def test_dashboard_auth_unavailable_reaches_ready_signed_out_state():
    dashboard_js = _read('static/js/dashboard.js')

    assert 'if (!auth) return;' not in dashboard_js
    assert "if (!auth || typeof bootstrap.onAuthStateReady !== 'function')" in dashboard_js
    assert 'bootstrap.onAuthStateReady(auth, function (user)' in dashboard_js
    assert 'loadDashboard(null);' in dashboard_js


def test_dashboard_uses_progress_summary_endpoint():
    dashboard_js = _read('static/js/dashboard.js')

    assert 'function fetchProgressSummary(headers)' in dashboard_js
    assert "fetch('/api/study-progress/summary', { headers: headers })" in dashboard_js
    assert "fetch('/api/study-progress', { headers: headers })" not in dashboard_js
    assert 'progressPayload && progressPayload.summary ? progressPayload.summary : progressPayload' in dashboard_js


def test_dashboard_limits_recent_pack_fetch():
    dashboard_js = _read('static/js/dashboard.js')

    assert 'function fetchRecentStudyPacks(headers)' in dashboard_js
    assert "fetch('/api/study-packs?limit=10', { headers: headers })" in dashboard_js
    assert "fetch('/api/study-packs', { headers: headers })" not in dashboard_js


def test_upload_header_uses_progress_summary_endpoint():
    index_js = _read('static/js/index-app.js')

    assert "authenticatedFetch('/api/study-progress/summary')" in index_js
    assert "const summary = (payload && payload.summary && typeof payload.summary === 'object')" in index_js


def test_dashboard_hides_voice_note_packs_from_recent_list():
    dashboard_js = _read('static/js/dashboard.js')

    assert 'function dashboardVisiblePacks(packs)' in dashboard_js
    assert "!== 'voice-note'" in dashboard_js
    assert 'renderRecentPacks(dashboardVisiblePacks(' in dashboard_js


def test_dashboard_distinguishes_load_failures_from_empty_state():
    dashboard_js = _read('static/js/dashboard.js')

    assert 'function renderUpcomingSessionsError()' in dashboard_js
    assert 'function renderRecentPacksError()' in dashboard_js
    assert 'data-dashboard-retry' in dashboard_js
    assert 'return { __dashboardLoadFailed: true };' in dashboard_js
    assert 'if (sessionsFailed) renderUpcomingSessionsError();' in dashboard_js
    assert 'if (packsFailed) {' in dashboard_js
    assert 'renderRecentPacksError();' in dashboard_js


def test_batch_dashboard_has_clear_empty_and_error_states():
    batch_dashboard_js = _read('static/js/batch-dashboard.js')
    batch_dashboard_css = _read('static/css/batch-dashboard.css')

    assert 'function emptyStateCopy(isActiveTable)' in batch_dashboard_js
    assert 'Running batches will appear here while they process.' in batch_dashboard_js
    assert 'Completed and failed batches will appear here after you run one.' in batch_dashboard_js
    assert 'function renderLoadError(message)' in batch_dashboard_js
    assert 'data-action="retry-load"' in batch_dashboard_js
    assert 'renderLoadError(message);' in batch_dashboard_js
    assert '.batch-empty-state.error' in batch_dashboard_css


def test_batch_downloads_use_authenticated_fetch_instead_of_new_tabs():
    batch_mode_template = _read('templates/batch_mode.html')
    batch_dashboard_template = _read('templates/batch_dashboard.html')
    batch_mode_js = _read('static/js/batch-mode.js')
    batch_dashboard_js = _read('static/js/batch-dashboard.js')

    assert batch_mode_template.index("filename='js/download-utils.js'") < batch_mode_template.index("batch_mode_js_asset")
    assert batch_dashboard_template.index("filename='js/download-utils.js'") < batch_dashboard_template.index("batch_dashboard_js_asset")

    for source in (batch_mode_js, batch_dashboard_js):
        assert 'var downloadUtils = window.LectureProcessorDownload || {};' in source
        assert 'function downloadAuthenticatedFile(path, fallbackName, button)' in source
        assert 'return authClient.authFetch(path, options, { retryOn401: true });' in source
        assert 'downloadUtils.downloadResponseBlob(response, fallbackName)' in source
        assert 'function isProtectedBatchDownload(href)' in source

    assert re.search(r"downloadAuthenticatedFile\(\s*apiBase \+ '/' \+ encodeURIComponent\(batchId\) \+ '/download\.zip'", batch_dashboard_js)
    assert re.search(r"downloadAuthenticatedFile\(\s*batchApiBase \+ '/' \+ encodeURIComponent\(currentBatchId\) \+ '/download\.zip'", batch_mode_js)
    assert re.search(r"downloadAuthenticatedFile\(\s*batchApiBase \+ '/' \+ encodeURIComponent\(currentBatchId\) \+ '/rows/' \+ encodeURIComponent\(rowId\) \+ '/download-docx'", batch_mode_js)
    assert re.search(r"downloadAuthenticatedFile\(\s*batchApiBase \+ '/' \+ encodeURIComponent\(currentBatchId\) \+ '/rows/' \+ encodeURIComponent\(rowId\) \+ '/download-flashcards-csv\?type=flashcards'", batch_mode_js)
    assert re.search(r"downloadAuthenticatedFile\(\s*batchApiBase \+ '/' \+ encodeURIComponent\(currentBatchId\) \+ '/rows/' \+ encodeURIComponent\(rowId\) \+ '/download-flashcards-csv\?type=test'", batch_mode_js)

    forbidden_download_openers = [
        "window.open(batchApiBase + '/' + encodeURIComponent(currentBatchId) + '/download.zip'",
        "window.open(batchApiBase + '/' + encodeURIComponent(currentBatchId) + '/rows/'",
        "window.open(apiBase + '/' + encodeURIComponent(batchId) + '/download.zip'",
    ]
    for snippet in forbidden_download_openers:
        assert snippet not in batch_mode_js
        assert snippet not in batch_dashboard_js


def test_study_supports_voice_notes_folder_deep_link():
    study_js = _read('static/js/study.js')
    voice_template = _read('templates/voice_notes.html')

    assert 'folderFromUrl' in study_js
    assert "safe === 'voice-notes'" in study_js
    assert 'selectedFolderId = initialFolderFromUrl(folderFromUrl);' in study_js
    assert 'href="/study?folder=voice-notes"' in voice_template


def test_study_audio_playback_uses_short_lived_stream_url():
    study_template = _read('templates/study.html')
    dialog_template = _read('templates/_study_dialogs.html')
    study_js = _read('static/js/study.js')
    study_audio_utils = _read('static/js/study-audio-utils.js')

    assert "filename='js/study-audio-utils.js'" in study_template
    assert 'id="notes-audio-unavailable" role="status"' in study_template
    assert 'id="audio-download-btn"' in dialog_template
    assert 'id="audio-retention-note"' in dialog_template
    assert 'share-audio-note' in dialog_template
    assert 'studyAudioUtils.fetchAudioStreamUrl(authenticatedFetch, selectedPack.study_pack_id)' in study_js
    assert 'selectedPack.audio_unavailable_message = fallbackAudioUnavailableMessage();' in study_js
    assert 'syncAudioUnavailableNotice();' in study_js
    assert '/audio?download=1' in study_js
    assert "'/audio').then(function (response)" not in study_js
    assert "'/audio-token'" in study_audio_utils
    assert 'payload && payload.stream_url' in study_audio_utils


def test_study_initial_load_uses_lightweight_progress_and_folder_requests():
    study_js = _read('static/js/study.js')

    assert "apiCall('/api/study-progress/summary')" in study_js
    assert "apiCall('/api/study-folders?include_pending=0')" in study_js
    assert "      queueProgressSync(false);\n      return refreshActiveRuntimeJobs(true);" not in study_js
    assert "queueProgressSync(false, { markDirty: false });" in study_js
    assert "if (hasProgressDirty())" in study_js


def test_planner_loads_bounded_data_and_has_safe_error_states():
    plan_template = _read('templates/plan.html')
    plan_js = _read('static/js/plan.js')

    assert 'id="folders-empty" hidden role="status" aria-live="polite" aria-atomic="true"' in plan_template
    assert 'id="pack-goals-empty" hidden role="status" aria-live="polite" aria-atomic="true"' in plan_template
    assert "authFetch('/api/study-folders?include_pending=0')" in plan_js
    assert "authFetch('/api/study-packs?limit=50')" in plan_js
    assert "authFetch('/api/study-progress')" in plan_js
    assert 'function requireOkResponse(response, fallbackMessage)' in plan_js
    assert 'function renderPlannerEmptyState(container, title, message, actions)' in plan_js
    assert 'messageEl.textContent = String(message || \'\');' in plan_js
    assert 'data-plan-retry-load' in plan_js
    assert 'foldersEmptyEl.innerHTML' not in plan_js
    assert 'packGoalsEmptyEl.innerHTML' not in plan_js
    assert 'var plannerLoadPromise = null;' in plan_js
    assert 'function schedulePlannerRefresh()' in plan_js


def test_study_inline_autosave_sends_dirty_fields_only():
    study_js = _read('static/js/study.js')

    assert 'let inlineAutosaveBaseline = null;' in study_js
    assert 'function setInlineAutosaveBaseline(pack)' in study_js
    assert 'function buildInlineAutosavePayload()' in study_js
    assert 'Object.keys(snapshot).forEach(function (field)' in study_js
    assert 'return Object.keys(payload).length ? payload : null;' in study_js
    assert "if (Object.prototype.hasOwnProperty.call(payload, 'flashcards'))" in study_js
