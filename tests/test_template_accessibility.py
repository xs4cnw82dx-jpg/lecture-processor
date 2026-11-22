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


def test_processing_disabled_button_state_is_described(client):
    index_template = client.get('/lecture-notes').get_data(as_text=True)

    assert 'id="process-disabled-reason" aria-live="polite"' in index_template
    parser = _TemplateButtonParser()
    parser.feed(index_template)
    attrs = next(button['attrs'] for button in parser.buttons if button['attrs'].get('id') == 'process-button')
    assert 'disabled' in attrs
    assert attrs['aria-disabled'] == 'true'
    assert set(attrs['aria-describedby'].split()) == {
        'mobile-process-summary', 'process-disabled-reason', 'no-credits-warning', 'mode-cost-summary', 'mode-credit-cost',
    }
    assert 'id="no-credits-warning" aria-live="polite"' in index_template


def test_lecture_topic_required_state_is_programmatic():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')

    assert re.search(r'id="study-pack-title-input"[\s\S]*?required[\s\S]*?aria-required="true"[\s\S]*?aria-describedby="study-pack-title-error"', index_template)
    assert re.search(r'id="study-pack-title-error"[\s\S]*?role="alert"[\s\S]*?hidden', index_template)


def test_app_shell_mobile_navigation_has_a_stateful_accessible_name():
    shell_template = Path('templates/_app_shell.html').read_text(encoding='utf-8')

    assert 'aria-label="Open main navigation"' in shell_template


def test_study_tools_picker_exposes_expanded_and_selected_state():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')

    assert 'id="study-tools-toggle" aria-haspopup="listbox" aria-expanded="false" aria-controls="study-tools-panel"' in index_template
    assert re.search(r'class="study-tools-panel"[\s\S]*?id="study-tools-panel"[\s\S]*?role="listbox"[\s\S]*?aria-hidden="true"', index_template)
    assert 'role="option" aria-selected="true"' in index_template


def test_processing_template_has_single_main_landmark():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')

    assert len(re.findall(r'<main\b', index_template)) == 1
    assert '<section class="focus-main" aria-label="Generated study output">' in index_template


def test_batch_submit_feedback_is_live_region():
    batch_template = Path('templates/batch_mode.html').read_text(encoding='utf-8')

    assert 'id="batch-submit-feedback" role="status" aria-live="polite" aria-atomic="true" hidden' in batch_template


def test_batch_output_language_listbox_is_labelled():
    batch_template = Path('templates/batch_mode.html').read_text(encoding='utf-8')

    assert 'id="output-language-field-label"' in batch_template
    assert 'role="listbox" aria-labelledby="output-language-field-label"' in batch_template
    assert 'aria-labelledby="output-language-field-label output-language-label"' in batch_template


def test_study_csv_dropzone_is_a_keyboard_button():
    study_template = Path('templates/study.html').read_text(encoding='utf-8')

    assert 'id="builder-csv-drop" role="button" tabindex="0"' in study_template


def test_batch_dashboard_native_filter_keeps_its_label():
    dashboard = Path('templates/batch_dashboard.html').read_text(encoding='utf-8')
    assert '<label for="batch-dashboard-mode-filter">Mode</label>' in dashboard


def test_audio_retention_notes_and_download_controls_are_in_templates():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')
    batch_template = Path('templates/batch_mode.html').read_text(encoding='utf-8')
    batch_dashboard_template = Path('templates/batch_dashboard.html').read_text(encoding='utf-8')
    transcriber_template = Path('templates/general_transcriber.html').read_text(encoding='utf-8')
    voice_template = Path('templates/voice_notes.html').read_text(encoding='utf-8')
    study_dialogs = Path('templates/_study_dialogs.html').read_text(encoding='utf-8')
    shared_study_template = Path('templates/shared_study.html').read_text(encoding='utf-8')
    app_shell_template = Path('templates/_app_shell.html').read_text(encoding='utf-8')
    lecture_downloader_template = Path('templates/lecture_downloader.html').read_text(encoding='utf-8')
    video_overlay_template = Path('templates/video_overlay_builder.html').read_text(encoding='utf-8')

    assert 'id="audio-storage-note"' in index_template
    assert 'Generated playback audio is temporary and can be deleted.' in index_template
    assert 'Render' not in index_template
    assert 'id="audio-download"' in index_template

    assert 'batch-audio-retention-note' in batch_template
    assert 'Clearing browser site data' in batch_template
    assert 'Server uploads and generated playback audio also expire' in batch_template
    assert 'Render' not in batch_template
    assert 'free-plan' not in batch_dashboard_template

    assert 'id="transcriber-audio-retention-note"' in transcriber_template
    assert 'id="transcriber-file-download"' in transcriber_template

    assert 'id="voice-download-audio-btn"' in voice_template
    assert 'voice-audio-retention-note' in voice_template
    assert 'id="voice-audio-status" role="status" aria-live="polite" hidden' in voice_template
    assert 'server playback copies are temporary and can be deleted' in voice_template
    assert 'Render' not in voice_template

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
    assert 'Prepared files are available for up to 30 minutes. Keep your downloaded copy.' in lecture_downloader_template
    assert 'Screen and microphone recordings are created in your browser and are not stored on the server.' in video_overlay_template


def test_feature_calculator_sliders_have_labels():
    features_template = Path('templates/features.html').read_text(encoding='utf-8')

    assert '<label class="calc-slider-label" for="calc-lectures">Lectures per week</label>' in features_template
    assert '<label class="calc-slider-label" for="calc-weeks">Weeks per semester</label>' in features_template
    assert '<label class="calc-slider-label" for="calc-minutes">Minutes per lecture (manual notes)</label>' in features_template
    assert '<label class="calc-slider-label" for="calc-review">Minutes per lecture (upload, review & correction)</label>' in features_template


def test_features_heading_preserves_readable_text_boundary():
    features_template = Path('templates/features.html').read_text(encoding='utf-8')

    heading = re.search(r"<h1>(.*?)</h1>", features_template, re.S).group(1)
    assert re.search(r"[.!?]\s*<br>\s*<span", heading)
    assert "The recording explains why." in heading


def test_voice_notes_and_study_pages_have_single_page_heading_contract():
    voice_template = Path('templates/voice_notes.html').read_text(encoding='utf-8')
    study_template = Path('templates/study.html').read_text(encoding='utf-8')

    assert '<h2>Sign in to transcribe</h2>' in voice_template
    assert '<h1>Sign in to transcribe</h1>' not in voice_template
    headings = re.findall(r'<h1\b[^>]*>', study_template)
    assert len(headings) == 1
    assert 'class="sr-only"' not in headings[0]
    assert 'id="study-page-heading"' in headings[0]


def test_shell_export_modal_validation_is_inside_modal_live_region():
    shell_template = Path('templates/_app_shell.html').read_text(encoding='utf-8')

    assert 'id="shell-export-error" role="alert" aria-live="assertive" aria-atomic="true" hidden' in shell_template


def test_shell_account_delete_is_reachable_and_announced():
    shell_template = Path('templates/_app_shell.html').read_text(encoding='utf-8')

    assert 'id="shell-delete-account-btn" role="menuitem">Delete account</button>' in shell_template
    assert 'id="shell-delete-account-overlay" hidden aria-hidden="true"' in shell_template
    assert 'id="shell-delete-account-error" role="alert" aria-live="assertive" aria-atomic="true" hidden' in shell_template


def test_admin_navigation_names_its_menus_and_pages():
    admin_template = Path('templates/admin.html').read_text(encoding='utf-8')

    # Behaviour (menus, keyboard, routing, layouts) is covered by e2e/admin-navigation.spec.js.
    assert '<nav class="admin-nav" id="admin-nav" aria-label="Admin sections">' in admin_template
    for key in ('activity', 'costs', 'users', 'system', 'tools'):
        assert f'aria-controls="admin-menu-{key}" data-admin-menu="{key}"' in admin_template
    for route in ('overview', 'activity/trends', 'costs/calculator', 'users/credits', 'batches', 'system/health'):
        assert f'data-admin-view="{route}"' in admin_template

def test_admin_stale_audio_cleanup_control_is_accessible():
    admin_template = Path('templates/admin.html').read_text(encoding='utf-8')

    assert 'id="admin-clean-stale-audio-btn" type="button"' in admin_template
    assert 'id="admin-clean-stale-audio-status" role="status"' in admin_template
    assert 'aria-live="polite" aria-atomic="true"' in admin_template


def test_voice_note_filters_and_actions_have_programmatic_names():
    voice_template = Path('templates/voice_notes.html').read_text(encoding='utf-8')

    assert 'data-filter="all" aria-pressed="true"' in voice_template
    assert 'data-filter="pending" aria-pressed="false"' in voice_template


def test_reader_dropzone_is_keyboard_accessible_and_announced():
    reader_template = Path('templates/reader.html').read_text(encoding='utf-8')

    assert 'id="reader-dropzone"' in reader_template
    assert re.search(r'id="reader-dropzone"[\s\S]*?role="button"[\s\S]*?tabindex="0"', reader_template)
    assert 'aria-describedby="reader-dropzone-sub reader-dropzone-sub-extra reader-dropzone-state"' in reader_template
    assert 'id="reader-dropzone-state" role="status" aria-live="polite" aria-atomic="true"' in reader_template


def test_shared_shell_hidden_and_live_region_contracts():
    shell_template = Path('templates/_app_shell.html').read_text(encoding='utf-8')

    assert 'id="app-shell-overlay" aria-label="Close navigation" aria-hidden="true" tabindex="-1"' in shell_template
    assert 'id="shell-toast" role="status" aria-live="polite" aria-atomic="true"' in shell_template
    assert 'id="shell-account-menu-wrap" aria-hidden="true" inert' in shell_template


def test_non_study_toasts_and_auth_messages_are_live_regions():
    for template_name in (
        'reader.html',
        'buy_credits.html',
        'study_plan.html',
        'lecture_downloader.html',
        'general_transcriber.html',
        'video_overlay_builder.html',
        'physio_local.html',
        '_index_footer_modals.html',
    ):
        template = Path('templates', template_name).read_text(encoding='utf-8')
        assert 'role="status" aria-live="polite" aria-atomic="true"' in template

    auth_overlay = Path('templates/_index_auth_overlay.html').read_text(encoding='utf-8')
    index_footer_modals = Path('templates/_index_footer_modals.html').read_text(encoding='utf-8')
    app_shell = Path('templates/_app_shell.html').read_text(encoding='utf-8')

    assert 'id="auth-overlay" hidden aria-hidden="true"' in auth_overlay
    assert 'id="signin-form" aria-busy="false"' in auth_overlay
    assert 'id="signup-form" aria-busy="false"' in auth_overlay
    assert 'id="reset-form" aria-busy="false"' in auth_overlay
    assert 'id="signin-error" role="alert" aria-live="assertive" aria-atomic="true"' in auth_overlay
    assert 'id="signup-error" role="alert" aria-live="assertive" aria-atomic="true"' in auth_overlay
    assert 'id="reset-error" role="alert" aria-live="assertive" aria-atomic="true"' in auth_overlay
    assert 'id="reset-success" role="status" aria-live="polite" aria-atomic="true"' in auth_overlay
    assert 'id="goal-modal-error" role="alert" aria-live="assertive" aria-atomic="true"' in index_footer_modals
    assert 'id="shell-delete-account-error" role="alert" aria-live="assertive" aria-atomic="true"' in app_shell
    assert 'id="language-onboarding-error" role="alert" aria-live="assertive" aria-atomic="true"' in index_footer_modals


def test_buy_credits_signed_out_has_sign_in_path():
    buy_credits_template = Path('templates/buy_credits.html').read_text(encoding='utf-8')

    assert 'id="buy-credits-auth-panel" hidden' in buy_credits_template
    assert 'id="buy-credits-signin-link" href="/lecture-notes?auth=signin&amp;next={{ request.path }}"' in buy_credits_template


def test_processing_template_defaults_optional_sections_to_collapsed_state():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')

    assert 'id="other-audio-toggle" aria-expanded="false"' in index_template
    assert 'id="other-audio-body" aria-hidden="true"' in index_template
    assert 'id="advanced-settings-toggle" aria-expanded="false"' in index_template


def test_page_titles_share_one_format_and_pages_have_one_h1():
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[1] / "templates"
    brand_first = {"landing.html", "admin.html"}
    for path in sorted(root.glob("*.html")):
        source = path.read_text(encoding="utf-8")
        head = source.split("<body", 1)[0]
        for title in re.findall(r"<title>(.*?)</title>", head, flags=re.S):
            if path.name in brand_first:
                continue
            assert title.strip().endswith("· Lecture Processor"), (path.name, title)
            assert " | " not in title and " - Lecture Processor" not in title, (path.name, title)
        # These pages swap between two exclusive states (signed out / error),
        # each with its own H1; only one is ever visible.
        if path.name.startswith("_") or path.name in {"batch_dashboard.html", "workout_share.html"}:
            continue
        assert len(re.findall(r"<h1\b", source)) <= 1, path.name


def test_app_pages_use_the_shared_page_header():
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    pages = ["dashboard", "study_plan", "study", "batch_mode", "batch_dashboard", "buy_credits", "voice_notes",
             "tools", "settings", "reader", "general_transcriber", "lecture_downloader", "index"]
    for name in pages:
        source = (root / "templates" / f"{name}.html").read_text(encoding="utf-8")
        assert "page-title" in source and "page-eyebrow" in source, name
    shared = (root / "static" / "css" / "shared-ui.css").read_text(encoding="utf-8")
    for token in ("--fs-display", ".app-shell-page .page-title", ".app-shell-page .page-eyebrow", ".app-shell-page .page-lead"):
        assert token in shared, token


def test_study_plan_dialogs_stack_above_shell_topbar():
    plan_css = Path('static/css/study-plan.css').read_text(encoding='utf-8')
    overlay = re.search(r'\.plan-overlay \{[^}]*z-index:\s*([^;}]+)', plan_css).group(1)
    shell_css = Path('static/css/app-shell.css').read_text(encoding='utf-8')
    topbar = re.search(r'\.app-shell-topbar \{[^}]*z-index:\s*([^;}]+)', shell_css).group(1)
    assert _layer_value(overlay) > _layer_value(topbar)


def _layer_value(expression):
    theme = Path('static/css/theme.css').read_text(encoding='utf-8')
    layers = {name: int(value) for name, value in re.findall(r'--z-([a-z]+):\s*(\d+);', theme)}
    expression = expression.strip()
    match = re.fullmatch(r'(?:calc\()?var\(--z-([a-z]+)\)(?:\s*\+\s*(\d+)\))?', expression)
    if match:
        return layers[match.group(1)] + int(match.group(2) or 0)
    return int(expression)


def test_global_stacking_uses_named_layers():
    offenders = []
    for path in sorted(Path('static/css').glob('*.css')):
        for value in re.findall(r'z-index\s*:\s*(\d+)', path.read_text(encoding='utf-8')):
            if int(value) >= 40:
                offenders.append(f'{path.name}: {value}')
    assert offenders == [], offenders
