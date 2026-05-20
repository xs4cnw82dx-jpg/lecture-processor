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


def test_processing_template_has_single_main_landmark():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')

    assert len(re.findall(r'<main\b', index_template)) == 1
    assert '<section class="focus-main" aria-label="Generated study output">' in index_template


def test_batch_submit_feedback_is_live_region():
    batch_template = Path('templates/batch_mode.html').read_text(encoding='utf-8')

    assert 'id="batch-submit-feedback" role="status" aria-live="polite" aria-atomic="true" hidden' in batch_template


def test_reader_dropzone_is_keyboard_accessible_and_announced():
    reader_template = Path('templates/reader.html').read_text(encoding='utf-8')

    assert 'id="reader-dropzone"' in reader_template
    assert re.search(r'id="reader-dropzone"[\s\S]*?role="button"[\s\S]*?tabindex="0"', reader_template)
    assert 'aria-describedby="reader-dropzone-sub reader-dropzone-sub-extra reader-dropzone-state"' in reader_template
    assert 'id="reader-dropzone-state" role="status" aria-live="polite" aria-atomic="true"' in reader_template


def test_shared_shell_hidden_and_live_region_contracts():
    shell_template = Path('templates/_app_shell.html').read_text(encoding='utf-8')
    app_shell_css = Path('static/css/app-shell.css').read_text(encoding='utf-8')

    assert re.search(r'\[hidden\]\s*\{\s*display:\s*none\s*!important;', app_shell_css)
    assert 'id="app-shell-overlay" aria-label="Close navigation" aria-hidden="true" tabindex="-1"' in shell_template
    assert 'id="shell-toast" role="status" aria-live="polite" aria-atomic="true"' in shell_template


def test_non_study_toasts_and_auth_messages_are_live_regions():
    for template_name in (
        'reader.html',
        'buy_credits.html',
        'calendar.html',
        'plan.html',
        'lecture_downloader.html',
        'general_transcriber.html',
        'physio.html',
        '_index_footer_modals.html',
    ):
        template = Path('templates', template_name).read_text(encoding='utf-8')
        assert 'role="status" aria-live="polite" aria-atomic="true"' in template

    auth_overlay = Path('templates/_index_auth_overlay.html').read_text(encoding='utf-8')
    index_footer_modals = Path('templates/_index_footer_modals.html').read_text(encoding='utf-8')

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
