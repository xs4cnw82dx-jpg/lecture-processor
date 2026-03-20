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


def test_processing_template_defaults_optional_sections_to_collapsed_state():
    index_template = Path('templates/index.html').read_text(encoding='utf-8')

    assert 'id="other-audio-toggle" aria-expanded="false"' in index_template
    assert 'id="other-audio-body" aria-hidden="true"' in index_template
    assert 'id="advanced-settings-toggle" aria-expanded="false"' in index_template
