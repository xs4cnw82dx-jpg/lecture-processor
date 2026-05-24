from pathlib import Path


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
    assert "toastEl.setAttribute('role', isError ? 'alert' : 'status');" in study_js
    assert "toastEl.setAttribute('aria-live', isError ? 'assertive' : 'polite');" in study_js


def test_study_initial_pack_load_preserves_pagination():
    study_template = _read('templates/study.html')
    study_js = _read('static/js/study.js')

    assert 'fetchAllStudyPacks' not in study_js
    assert "fetchStudyPackPage('')" in study_js
    assert 'packsHasMore = !!packPage.has_more;' in study_js
    assert "packsNextCursor = String(packPage.next_cursor || '');" in study_js
    assert 'id="pack-list-actions"' in study_template
    assert 'id="load-more-packs-btn"' in study_template
    assert 'loadMorePacksBtn.textContent = packsLoadingMore ?' in study_js
    assert 'if (packsHasMore) { return; }' in study_js


def test_dashboard_auth_unavailable_reaches_ready_signed_out_state():
    dashboard_js = _read('static/js/dashboard.js')

    assert 'if (!auth) return;' not in dashboard_js
    assert "if (!auth || typeof auth.onAuthStateChanged !== 'function')" in dashboard_js
    assert 'loadDashboard(null);' in dashboard_js


def test_dashboard_uses_progress_summary_endpoint():
    dashboard_js = _read('static/js/dashboard.js')

    assert "fetch('/api/study-progress/summary', { headers: headers })" in dashboard_js
    assert "fetch('/api/study-progress', { headers: headers })" not in dashboard_js
    assert 'progressPayload && progressPayload.summary ? progressPayload.summary : progressPayload' in dashboard_js


def test_dashboard_hides_voice_note_packs_from_recent_list():
    dashboard_js = _read('static/js/dashboard.js')

    assert 'function dashboardVisiblePacks(packs)' in dashboard_js
    assert "!== 'voice-note'" in dashboard_js
    assert 'renderRecentPacks(dashboardVisiblePacks(' in dashboard_js


def test_study_supports_voice_notes_folder_deep_link():
    study_js = _read('static/js/study.js')
    voice_template = _read('templates/voice_notes.html')

    assert 'folderFromUrl' in study_js
    assert "safe === 'voice-notes'" in study_js
    assert 'selectedFolderId = initialFolderFromUrl(folderFromUrl);' in study_js
    assert 'href="/study?folder=voice-notes"' in voice_template


def test_study_inline_autosave_sends_dirty_fields_only():
    study_js = _read('static/js/study.js')

    assert 'let inlineAutosaveBaseline = null;' in study_js
    assert 'function setInlineAutosaveBaseline(pack)' in study_js
    assert 'function buildInlineAutosavePayload()' in study_js
    assert 'Object.keys(snapshot).forEach(function (field)' in study_js
    assert 'return Object.keys(payload).length ? payload : null;' in study_js
    assert "if (Object.prototype.hasOwnProperty.call(payload, 'flashcards'))" in study_js
