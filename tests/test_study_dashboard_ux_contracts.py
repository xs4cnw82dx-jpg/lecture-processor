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
    ]
    for control_id in dialog_controls:
        assert f'for="{control_id}"' in dialog_template
        assert f'id="{control_id}"' in dialog_template


def test_study_feedback_regions_are_announced_to_assistive_tech():
    study_template = _read('templates/study.html')
    dialog_template = _read('templates/_study_dialogs.html')

    assert 'id="toast" role="status" aria-live="polite" aria-atomic="true"' in dialog_template
    assert 'id="share-modal-status" role="status" aria-live="polite" aria-atomic="true"' in dialog_template
    assert 'id="builder-import-summary" role="status" aria-live="polite" aria-atomic="true"' in study_template
    assert 'id="builder-import-errors" role="alert" aria-live="assertive" aria-atomic="true"' in study_template
    assert re.search(r'id="pack-save-status"[\s\S]*?role="status"[\s\S]*?aria-live="polite"[\s\S]*?aria-atomic="true"', study_template)


def test_study_csv_import_auto_applies_saves_and_uses_structured_preview():
    study_template = _read('templates/study.html')

    assert 'id="import-pack-csv-btn"' in study_template
    assert 'id="pack-empty-import-csv-btn"' in study_template
    assert 'CSV files apply and save automatically.' in study_template
    assert 'id="builder-csv-input"\n                  accept=".csv,text/csv" multiple hidden' in study_template
    assert 'id="builder-apply-import-btn" disabled hidden' in study_template
    assert 'id="builder-preview-list"' in study_template
    assert 'builder-preview-table' not in study_template


def test_study_tabs_expose_tab_roles_and_keyboard_support():
    study_template = _read('templates/study.html')

    assert 'class="editor-tabs" role="tablist" aria-label="Study pack sections"' in study_template
    assert 'id="editor-tab-notes" data-editor-pane="notes" role="tab"' in study_template
    assert 'id="editor-pane-notes" role="tabpanel" aria-labelledby="editor-tab-notes"' in study_template
    assert 'class="setup-tabs" id="setup-tabs" role="tablist" aria-label="Session setup sections"' in study_template
    assert 'class="builder-nav" role="tablist" aria-label="Builder sections"' in study_template


def test_new_builder_has_distinct_unsaved_status_and_compact_mobile_header():
    study_template = _read('templates/study.html')

    assert 'id="builder-stat-dirty" class="builder-status pending" role="status" aria-live="polite">Not saved yet<' in study_template


def test_study_initial_pack_load_preserves_pagination():
    study_template = _read('templates/study.html')

    assert 'id="pack-list-actions"' in study_template
    assert 'id="load-more-packs-btn"' in study_template
    assert 'id="pack-selection-bar"' in study_template
    assert 'id="clear-pack-selection-btn"' in study_template


def test_batch_downloads_use_authenticated_fetch_instead_of_new_tabs():
    batch_mode_template = _read('templates/batch_mode.html')
    batch_dashboard_template = _read('templates/batch_dashboard.html')

    for template, entry in ((batch_mode_template, 'batch_mode_js_asset'), (batch_dashboard_template, 'batch_dashboard_js_asset')):
        assert template.index("filename='js/download-utils.js'") < template.index('batch_status_js_asset')
        assert template.index('batch_status_js_asset') < template.index(entry)



def test_study_supports_voice_notes_folder_deep_link():
    voice_template = _read('templates/voice_notes.html')

    assert 'href="/study?folder=voice-notes"' in voice_template


def test_study_audio_playback_uses_short_lived_stream_url():
    study_template = _read('templates/study.html')
    dialog_template = _read('templates/_study_dialogs.html')

    assert "filename='js/study-audio-utils.js'" in study_template
    assert 'id="notes-audio-unavailable" role="status"' in study_template
    assert 'id="audio-download-btn"' in dialog_template
    assert 'id="audio-retention-note"' in dialog_template
    assert 'share-audio-note' in dialog_template


