from html.parser import HTMLParser
from pathlib import Path
import re


class _TemplateButtonParser(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self._stack = []
        self._current = None
        self.buttons = []

    def handle_starttag(self, tag, attrs):
        attr_map = dict(attrs)
        if self._current is not None:
            self._current['child_tags'].append(tag)
        if tag == 'button':
            self._current = {
                'attrs': attr_map,
                'text_parts': [],
                'child_tags': [],
                'line': self.getpos()[0],
            }
            self._stack.append(tag)
            return
        if self._current is not None:
            self._stack.append(tag)

    def handle_endtag(self, tag):
        if self._current is None:
            return
        if self._stack:
            self._stack.pop()
        if tag == 'button':
            text = ' '.join(' '.join(self._current['text_parts']).split())
            self._current['text'] = text
            self.buttons.append(self._current)
            self._current = None

    def handle_data(self, data):
        if self._current is not None:
            self._current['text_parts'].append(data)


def _iter_template_files():
    return sorted(Path('templates').glob('*.html'))


def test_icon_only_buttons_have_accessible_labels():
    issues = []
    for template_path in _iter_template_files():
        parser = _TemplateButtonParser()
        parser.feed(template_path.read_text(encoding='utf-8'))
        for button in parser.buttons:
            attrs = button['attrs']
            text = str(button.get('text', '') or '').strip()
            has_accessible_label = bool(attrs.get('aria-label') or attrs.get('title'))
            is_icon_only = not text
            if is_icon_only and not has_accessible_label:
                issues.append(
                    f'{template_path}:{button["line"]} button id="{attrs.get("id", "")}" class="{attrs.get("class", "")}"'
                )
    assert issues == []


def test_study_template_no_longer_renders_top_fullscreen_button():
    study_template = Path('templates/study.html').read_text(encoding='utf-8')

    assert 'id="fullscreen-btn"' not in study_template


def test_processing_upload_zones_are_keyboard_accessible():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')

    assert re.search(r'<div class="upload-zone" id="pdf-zone"[^>]*role="button"[^>]*tabindex="0"', index_template)
    assert re.search(r'<div class="upload-zone" id="audio-zone"[^>]*role="button"[^>]*tabindex="0"', index_template)


def test_processing_disabled_button_state_is_described():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')

    assert 'id="process-disabled-reason" aria-live="polite"' in index_template
    assert 'id="process-button" disabled aria-describedby="mobile-process-summary process-disabled-reason no-credits-warning" aria-disabled="true"' in index_template
    assert 'id="no-credits-warning" aria-live="polite"' in index_template


def test_lecture_topic_required_state_is_programmatic():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')
    index_js = Path('static/js/index-app.js').read_text(encoding='utf-8')

    assert re.search(r'id="study-pack-title-input"[\s\S]*?required[\s\S]*?aria-required="true"[\s\S]*?aria-describedby="study-pack-title-error"', index_template)
    assert re.search(r'id="study-pack-title-error"[\s\S]*?role="alert"[\s\S]*?hidden', index_template)
    assert "setStudyPackTitleInvalid(true);" in index_js


def test_study_tools_picker_exposes_expanded_and_selected_state():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')
    index_js = Path('static/js/index-app.js').read_text(encoding='utf-8')

    assert 'id="study-tools-toggle" aria-haspopup="listbox" aria-expanded="false" aria-controls="study-tools-panel"' in index_template
    assert re.search(r'class="study-tools-panel"[\s\S]*?id="study-tools-panel"[\s\S]*?role="listbox"[\s\S]*?aria-hidden="true"', index_template)
    assert 'role="option" aria-selected="true"' in index_template
    assert "studyToolsToggle.setAttribute('aria-expanded', isVisible ? 'true' : 'false');" in index_js


def test_processing_template_has_single_main_landmark():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')

    assert len(re.findall(r'<main\b', index_template)) == 1
    assert '<section class="focus-main" aria-label="Generated study output">' in index_template


def test_batch_submit_feedback_is_live_region():
    batch_template = Path('templates/batch_mode.html').read_text(encoding='utf-8')

    assert 'id="batch-submit-feedback" role="status" aria-live="polite" aria-atomic="true" hidden' in batch_template


def test_batch_and_study_generated_dropzones_are_keyboard_accessible():
    batch_js = Path('static/js/batch-mode.js').read_text(encoding='utf-8')
    study_template = Path('templates/study.html').read_text(encoding='utf-8')
    study_js = Path('static/js/study.js').read_text(encoding='utf-8')

    assert 'data-upload-zone="slides" role="button" tabindex="0"' in batch_js
    assert 'data-upload-zone="audio" role="button" tabindex="0"' in batch_js
    assert 'data-upload-zone="slideText" role="button" tabindex="0"' in batch_js
    assert 'data-upload-zone="transcriptText" role="button" tabindex="0"' in batch_js
    assert 'id="builder-csv-drop" role="button" tabindex="0"' in study_template
    assert "builderCsvDrop.addEventListener('keydown'" in study_js


def test_batch_audio_transcription_mode_disables_study_tools_and_allows_audio_import():
    batch_js = Path('static/js/batch-mode.js').read_text(encoding='utf-8')

    assert "'audio-transcription': {" in batch_js
    assert 'supportsStudyTools: false' in batch_js
    assert 'allowsAudioUrlImport: true' in batch_js
    assert "'text-combine': {" in batch_js
    assert 'requiresTextInputs: true' in batch_js
    assert 'if (modeSupportsStudyTools()) wireRowOverride(card);' in batch_js


def test_batch_override_panel_removes_hidden_controls_from_tab_order():
    batch_js = Path('static/js/batch-mode.js').read_text(encoding='utf-8')

    assert 'panel.inert = !enabled;' in batch_js
    assert "control.setAttribute('tabindex', '-1');" in batch_js
    assert "control.disabled = true;" in batch_js


def test_custom_select_upgrades_remove_native_controls_from_tab_order():
    batch_dashboard_js = Path('static/js/batch-dashboard.js').read_text(encoding='utf-8')
    admin_js = Path('static/js/admin.js').read_text(encoding='utf-8')
    ux_js = Path('static/js/ux-utils.js').read_text(encoding='utf-8')

    assert "selectEl.hidden = true;" in batch_dashboard_js
    assert "selectEl.tabIndex = -1;" in batch_dashboard_js
    assert "selectEl.setAttribute('aria-hidden', 'true');" in batch_dashboard_js
    assert "selectEl.hidden = true;" in admin_js
    assert "selectEl.tabIndex = -1;" in admin_js
    assert "selectEl.setAttribute('aria-hidden', 'true');" in admin_js
    assert "button.setAttribute('aria-labelledby', (fieldLabelId ? fieldLabelId + ' ' : '') + label.id);" in ux_js


def test_physio_audio_upload_input_is_not_sequentially_focusable():
    physio_template = Path('templates/physio.html').read_text(encoding='utf-8')

    assert 'id="physio-audio-input"' in physio_template
    assert 'tabindex="-1" aria-hidden="true"' in physio_template


def test_audio_retention_warnings_and_download_controls_are_present():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')
    batch_template = Path('templates/batch_mode.html').read_text(encoding='utf-8')
    batch_dashboard_template = Path('templates/batch_dashboard.html').read_text(encoding='utf-8')
    transcriber_template = Path('templates/general_transcriber.html').read_text(encoding='utf-8')
    physio_template = Path('templates/physio.html').read_text(encoding='utf-8')
    voice_template = Path('templates/voice_notes.html').read_text(encoding='utf-8')
    study_dialogs = Path('templates/_study_dialogs.html').read_text(encoding='utf-8')
    shared_study_template = Path('templates/shared_study.html').read_text(encoding='utf-8')
    app_shell_template = Path('templates/_app_shell.html').read_text(encoding='utf-8')
    lecture_downloader_template = Path('templates/lecture_downloader.html').read_text(encoding='utf-8')
    video_overlay_template = Path('templates/video_overlay_builder.html').read_text(encoding='utf-8')
    index_js = Path('static/js/index-app.js').read_text(encoding='utf-8')
    batch_js = Path('static/js/batch-mode.js').read_text(encoding='utf-8')
    transcriber_js = Path('static/js/general-transcriber.js').read_text(encoding='utf-8')
    physio_js = Path('static/js/physio.js').read_text(encoding='utf-8')
    voice_js = Path('static/js/voice-notes.js').read_text(encoding='utf-8')

    assert 'id="audio-storage-note"' in index_template
    assert 'Generated playback audio is temporary and can be deleted.' in index_template
    assert 'Render' not in index_template
    assert '/api/import-audio-url/download' in index_js
    assert 'id="audio-download"' in index_template

    assert 'batch-audio-retention-note' in batch_template
    assert 'generated playback audio are temporary and can be deleted' in batch_template
    assert 'Render' not in batch_template
    assert 'batch-dashboard-retention-note' in batch_dashboard_template
    assert 'temporary audio is deleted' in batch_dashboard_template
    assert 'free-plan' not in batch_dashboard_template
    assert 'data-download-file="audio"' in batch_js
    assert '/api/import-audio-url/download' in batch_js

    assert 'id="transcriber-audio-retention-note"' in transcriber_template
    assert 'id="transcriber-file-download"' in transcriber_template
    assert 'saveBlobAsFile(selectedFile' in transcriber_js

    assert 'id="physio-audio-download-btn"' in physio_template
    assert 'raw audio is removed after transcription' in physio_template
    assert 'downloadSelectedAudio' in physio_js

    assert 'id="voice-download-audio-btn"' in voice_template
    assert 'voice-audio-retention-note' in voice_template
    assert 'id="voice-audio-status" role="status" aria-live="polite" hidden' in voice_template
    assert 'server playback copies are temporary and can be deleted' in voice_template
    assert 'Render' not in voice_template
    assert 'setAudioDownloadReady(false);' in voice_js
    assert 'No downloadable audio copy is available for this note.' in voice_js
    assert '/api/study-packs/\' + encodeURIComponent(note.study_pack_id) + \'/audio?download=1' in voice_js

    assert 'id="audio-download-btn"' in study_dialogs
    assert 'audio-retention-note' in study_dialogs
    assert 'Temporary audio. Download a copy.' in study_dialogs
    assert 'Render' not in study_dialogs
    assert 'share-audio-note' in study_dialogs
    assert 'Generated audio is not included' in shared_study_template
    assert shared_study_template.count('shared_audio_note') >= 2
    assert 'id="shared-folder-empty" role="status" aria-live="polite"' in shared_study_template

    assert 'Audio files are not included in this export.' in app_shell_template
    assert 'Download any audio you need first.' in app_shell_template
    assert 'does not preserve lecture media on the server' in lecture_downloader_template
    assert 'Screen and microphone recordings are created in your browser and are not stored on the server.' in video_overlay_template


def test_feature_calculator_sliders_have_labels_and_focus_style():
    features_template = Path('templates/features.html').read_text(encoding='utf-8')
    features_css = Path('static/css/features.css').read_text(encoding='utf-8')

    assert '<label class="calc-slider-label" for="calc-lectures">Lectures per week</label>' in features_template
    assert '<label class="calc-slider-label" for="calc-weeks">Weeks per semester</label>' in features_template
    assert '<label class="calc-slider-label" for="calc-minutes">Minutes per lecture (manual notes)</label>' in features_template
    assert '.calc-slider:focus-visible{outline:2px solid var(--primary);outline-offset:4px}' in features_css


def test_features_heading_preserves_readable_text_boundary():
    features_template = Path('templates/features.html').read_text(encoding='utf-8')

    assert '<span class="gradient">Mastery</span> <br>' in features_template


def test_calendar_validation_errors_are_field_owned():
    calendar_template = Path('templates/calendar.html').read_text(encoding='utf-8')
    calendar_js = Path('static/js/calendar.js').read_text(encoding='utf-8')

    assert 'placeholder="yyyy-mm-dd"' in calendar_template
    assert 'id="session-date-error" role="alert" hidden' in calendar_template
    assert "input.setAttribute('aria-invalid', 'true');" in calendar_js
    assert 'function isValidIsoDateValue(value)' in calendar_js
    assert 'function isValidTimeValue(value)' in calendar_js
    assert "Choose a valid session date in yyyy-mm-dd format." in calendar_js


def test_voice_notes_and_study_pages_have_single_page_heading_contract():
    voice_template = Path('templates/voice_notes.html').read_text(encoding='utf-8')
    study_template = Path('templates/study.html').read_text(encoding='utf-8')

    assert '<h2>Sign in to transcribe</h2>' in voice_template
    assert '<h1>Sign in to transcribe</h1>' not in voice_template
    assert '<h1 class="sr-only">{{ study_shell_title or ' in study_template


def test_study_folder_rows_do_not_nest_actions_inside_button_role():
    study_js = Path('static/js/study.js').read_text(encoding='utf-8')

    assert '<div class="item-head folder-row-head"><button type="button" class="folder-row-main" data-folder-activate="1"' in study_js
    assert '<span class="folder-head-actions"><button type="button" class="btn folder-mini-btn" data-toggle-pin="1">' in study_js


def test_study_pack_rows_use_real_buttons_for_main_actions():
    study_js = Path('static/js/study.js').read_text(encoding='utf-8')
    study_css = Path('static/css/study.css').read_text(encoding='utf-8')

    assert "div.setAttribute('role', 'button')" not in study_js
    assert "div.setAttribute('tabindex', '0')" not in study_js
    assert '<button type="button" class="pack-row-open" data-pack-open>' in study_js
    assert '<button type="button" class="pack-row-open" data-video-project-main>' in study_js
    assert '.pack-row-open:focus-visible' in study_css


def test_study_collapsed_metadata_panel_is_removed_from_focus_order():
    study_js = Path('static/js/study.js').read_text(encoding='utf-8')
    study_css = Path('static/css/study.css').read_text(encoding='utf-8')

    assert 'shell.inert = !isOpen;' in study_js
    assert 'panel.inert = !isOpen;' in study_js
    assert re.search(r'\.meta-advanced-shell\s*\{[\s\S]*?visibility:\s*hidden;', study_css)
    assert re.search(r'\.meta-advanced-shell\s*\{[\s\S]*?pointer-events:\s*none;', study_css)


def test_physio_audio_upload_control_is_keyboard_accessible():
    physio_template = Path('templates/physio.html').read_text(encoding='utf-8')
    physio_js = Path('static/js/physio.js').read_text(encoding='utf-8')
    physio_css = Path('static/css/physio.css').read_text(encoding='utf-8')

    assert 'id="physio-audio-upload-btn">Upload audio</button>' in physio_template
    assert 'class="physio-file-input" type="file" id="physio-audio-input"' in physio_template
    assert 'var audioUploadBtn = document.getElementById(\'physio-audio-upload-btn\');' in physio_js
    assert 'audioUploadBtn.addEventListener(\'click\'' in physio_js
    assert '.physio-file-input' in physio_css
    assert '.physio-upload-btn input' not in physio_css


def test_shell_export_modal_validation_is_inside_modal_live_region():
    shell_template = Path('templates/_app_shell.html').read_text(encoding='utf-8')
    app_shell_js = Path('static/js/app-shell.js').read_text(encoding='utf-8')

    assert 'id="shell-export-error" role="alert" aria-live="assertive" aria-atomic="true" hidden' in shell_template
    assert "setExportError('Choose at least one export option.');" in app_shell_js
    assert "exportError.hidden = !text;" in app_shell_js


def test_shell_account_delete_is_reachable_and_announced():
    shell_template = Path('templates/_app_shell.html').read_text(encoding='utf-8')
    app_shell_js = Path('static/js/app-shell.js').read_text(encoding='utf-8')
    app_shell_css = Path('static/css/app-shell.css').read_text(encoding='utf-8')

    assert 'id="shell-delete-account-btn" role="menuitem">Delete account</button>' in shell_template
    assert 'id="shell-delete-account-overlay" hidden aria-hidden="true"' in shell_template
    assert 'id="shell-delete-account-error" role="alert" aria-live="assertive" aria-atomic="true" hidden' in shell_template
    assert "setDeleteAccountModalOpen(true);" in app_shell_js
    assert "authFetch('/api/account/delete'" in app_shell_js
    assert "setDeleteAccountError('Type DELETE MY ACCOUNT exactly to continue.');" in app_shell_js
    assert "await clearVoiceNotesLocalData();" in app_shell_js
    assert ".shell-modal-primary.danger" in app_shell_css


def test_admin_tabs_expose_tab_semantics_and_keyboard_navigation():
    admin_template = Path('templates/admin.html').read_text(encoding='utf-8')
    admin_js = Path('static/js/admin.js').read_text(encoding='utf-8')

    assert 'class="admin-tabs" role="tablist" aria-label="Admin sections"' in admin_template
    assert 'id="admin-tab-overview" data-admin-tab="overview" type="button" role="tab" aria-selected="true"' in admin_template
    assert 'id="admin-tab-batch-jobs" data-admin-tab="batch-jobs" type="button" role="tab" aria-selected="false"' in admin_template
    assert 'id="admin-tab-overview-content" role="tabpanel" aria-labelledby="admin-tab-overview" aria-hidden="false"' in admin_template
    assert 'id="admin-tab-batch-content" role="tabpanel" aria-labelledby="admin-tab-batch-jobs" aria-hidden="true" hidden' in admin_template
    assert "btn.setAttribute('aria-selected', isActive ? 'true' : 'false');" in admin_js
    assert 'btn.tabIndex = isActive ? 0 : -1;' in admin_js
    assert "panel.setAttribute('aria-hidden', isActive ? 'false' : 'true');" in admin_js
    assert "event.key === 'ArrowRight' || event.key === 'ArrowDown'" in admin_js
    assert "event.key === 'Home'" in admin_js
    assert "event.key === 'End'" in admin_js


def test_admin_stale_audio_cleanup_control_is_accessible():
    admin_template = Path('templates/admin.html').read_text(encoding='utf-8')
    admin_js = Path('static/js/admin.js').read_text(encoding='utf-8')

    assert 'id="admin-clean-stale-audio-btn" type="button"' in admin_template
    assert 'id="admin-clean-stale-audio-status" role="status"' in admin_template
    assert 'aria-live="polite" aria-atomic="true"' in admin_template
    assert "'/api/admin/maintenance/study-audio/cleanup-stale'" in admin_js
    assert 'setAdminMaintenanceStatus(message, failed > 0 ?' in admin_js


def test_admin_tables_use_clear_empty_states():
    admin_js = Path('static/js/admin.js').read_text(encoding='utf-8')
    admin_css = Path('static/css/admin.css').read_text(encoding='utf-8')

    assert 'function appendAdminEmptyTableRow(tbody, colspan, title, copy)' in admin_js
    assert "wrapper.setAttribute('role', 'status');" in admin_js
    assert 'No batch jobs match these filters' in admin_js
    assert 'No admin grants found' in admin_js
    assert 'No jobs match these filters' in admin_js
    assert '.admin-table-empty-state' in admin_css
    assert '.admin-credit-grants-table td.admin-table-empty-cell::before' in admin_css


def test_voice_note_filters_and_actions_have_programmatic_names():
    voice_template = Path('templates/voice_notes.html').read_text(encoding='utf-8')
    voice_js = Path('static/js/voice-notes.js').read_text(encoding='utf-8')

    assert 'data-filter="all" aria-pressed="true"' in voice_template
    assert 'data-filter="pending" aria-pressed="false"' in voice_template
    assert "btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');" in voice_js
    assert 'Open voice note "' in voice_js
    assert 'Archive voice note "' in voice_js
    assert 'Restore voice note "' in voice_js
    assert 'Delete voice note "' in voice_js


def test_physio_case_and_session_selection_exposes_current_state():
    physio_js = Path('static/js/physio.js').read_text(encoding='utf-8')

    assert physio_js.count("button.setAttribute('aria-current', 'true');") >= 2


def test_reader_dropzone_is_keyboard_accessible_and_announced():
    reader_template = Path('templates/reader.html').read_text(encoding='utf-8')

    assert 'id="reader-dropzone"' in reader_template
    assert re.search(r'id="reader-dropzone"[\s\S]*?role="button"[\s\S]*?tabindex="0"', reader_template)
    assert 'aria-describedby="reader-dropzone-sub reader-dropzone-sub-extra reader-dropzone-state"' in reader_template
    assert 'id="reader-dropzone-state" role="status" aria-live="polite" aria-atomic="true"' in reader_template


def test_shared_shell_hidden_and_live_region_contracts():
    shell_template = Path('templates/_app_shell.html').read_text(encoding='utf-8')
    app_shell_css = Path('static/css/app-shell.css').read_text(encoding='utf-8')
    app_shell_js = Path('static/js/app-shell.js').read_text(encoding='utf-8')

    assert re.search(r'\[hidden\]\s*\{\s*display:\s*none\s*!important;', app_shell_css)
    assert 'id="app-shell-overlay" aria-label="Close navigation" aria-hidden="true" tabindex="-1"' in shell_template
    assert 'id="shell-toast" role="status" aria-live="polite" aria-atomic="true"' in shell_template
    assert 'id="shell-account-menu-wrap" aria-hidden="true" inert' in shell_template
    assert "accountMenuWrap.setAttribute('inert', '');" in app_shell_js
    assert "accountMenuWrap.removeAttribute('inert');" in app_shell_js
    assert "href === '/batch_mode'" in app_shell_js
    assert "currentPath === '/batch_mode_slides_extraction'" in app_shell_js
    assert "currentPath === '/batch_mode_audio_transcription'" in app_shell_js
    assert "currentPath === '/batch_mode_text_combine'" in app_shell_js
    assert "href === '/instant_batch_mode'" in app_shell_js
    assert "currentPath === '/instant_batch_mode_audio_transcription'" in app_shell_js
    assert "link.setAttribute('aria-current', 'page');" in app_shell_js
    assert "creditsLink.setAttribute('aria-label', 'Buy credits, ' + creditsTotalLabel.textContent);" in app_shell_js


def test_non_study_toasts_and_auth_messages_are_live_regions():
    for template_name in (
        'reader.html',
        'buy_credits.html',
        'calendar.html',
        'plan.html',
        'lecture_downloader.html',
        'general_transcriber.html',
        'video_overlay_builder.html',
        'physio.html',
        '_index_footer_modals.html',
    ):
        template = Path('templates', template_name).read_text(encoding='utf-8')
        assert 'role="status" aria-live="polite" aria-atomic="true"' in template

    auth_overlay = Path('templates/_index_auth_overlay.html').read_text(encoding='utf-8')
    index_footer_modals = Path('templates/_index_footer_modals.html').read_text(encoding='utf-8')
    index_js = Path('static/js/index-app.js').read_text(encoding='utf-8')

    assert 'id="auth-overlay" hidden aria-hidden="true"' in auth_overlay
    assert 'id="signin-form" aria-busy="false"' in auth_overlay
    assert 'id="signup-form" aria-busy="false"' in auth_overlay
    assert 'id="reset-form" aria-busy="false"' in auth_overlay
    assert "uxUtils.openModalOverlay(overlay" in index_js
    assert 'let authSubmitBusyKind' in index_js
    assert "if (!beginAuthSubmit('signin')) return;" in index_js
    assert 'id="signin-error" role="alert" aria-live="assertive" aria-atomic="true"' in auth_overlay
    assert 'id="signup-error" role="alert" aria-live="assertive" aria-atomic="true"' in auth_overlay
    assert 'id="reset-error" role="alert" aria-live="assertive" aria-atomic="true"' in auth_overlay
    assert 'id="reset-success" role="status" aria-live="polite" aria-atomic="true"' in auth_overlay
    assert 'id="goal-modal-error" role="alert" aria-live="assertive" aria-atomic="true"' in index_footer_modals
    assert 'id="delete-account-error" role="alert" aria-live="assertive" aria-atomic="true"' in index_footer_modals
    assert 'id="language-onboarding-error" role="alert" aria-live="assertive" aria-atomic="true"' in index_footer_modals


def test_buy_credits_signed_out_has_sign_in_path():
    buy_credits_template = Path('templates/buy_credits.html').read_text(encoding='utf-8')

    assert 'id="buy-credits-auth-panel" hidden' in buy_credits_template
    assert 'id="buy-credits-signin-link" href="/lecture-notes?auth=signin&amp;next={{ request.path }}"' in buy_credits_template


def test_calendar_modal_stacks_above_shell_topbar():
    calendar_css = Path('static/css/calendar.css').read_text(encoding='utf-8')

    assert re.search(r'\.overlay\{[^}]*z-index:320', calendar_css)


def test_processing_template_defaults_optional_sections_to_collapsed_state():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')

    assert 'id="other-audio-toggle" aria-expanded="false"' in index_template
    assert 'id="other-audio-body" aria-hidden="true"' in index_template
    assert 'id="advanced-settings-toggle" aria-expanded="false"' in index_template
