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
    assert "href === '/batch_mode'" in app_shell_js
    assert "currentPath === '/batch_mode_slides_extraction'" in app_shell_js
    assert "currentPath === '/batch_mode_audio_transcription'" in app_shell_js
    assert "currentPath === '/batch_mode_text_combine'" in app_shell_js
    assert "href === '/instant_batch_mode'" in app_shell_js
    assert "currentPath === '/instant_batch_mode_audio_transcription'" in app_shell_js
    assert "link.setAttribute('aria-current', 'page');" in app_shell_js


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
    assert 'id="buy-credits-signin-link" href="/lecture-notes?auth=signin"' in buy_credits_template


def test_calendar_modal_stacks_above_shell_topbar():
    calendar_css = Path('static/css/calendar.css').read_text(encoding='utf-8')

    assert re.search(r'\.overlay\{[^}]*z-index:320', calendar_css)


def test_processing_template_defaults_optional_sections_to_collapsed_state():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')

    assert 'id="other-audio-toggle" aria-expanded="false"' in index_template
    assert 'id="other-audio-body" aria-hidden="true"' in index_template
    assert 'id="advanced-settings-toggle" aria-expanded="false"' in index_template
