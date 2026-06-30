from pathlib import Path


def test_markdown_fallback_sanitizer_fails_closed_without_dompurify():
    markdown_js = Path('static/js/markdown-utils.js').read_text(encoding='utf-8')

    assert "return escapeHtml(html);" in markdown_js
    assert "global.DOMPurify.sanitize(html, sanitizeOptions || {})" in markdown_js
    assert "return html;" not in markdown_js


def test_shared_study_loads_html_utils_before_markdown_utils():
    template = Path('templates/shared_study.html').read_text(encoding='utf-8')

    html_index = template.index("filename='js/html-utils.js'")
    marked_lite_index = template.index("filename='js/marked-lite.js'")
    markdown_index = template.index("filename='js/markdown-utils.js'")
    assert html_index < markdown_index
    assert marked_lite_index < markdown_index


def test_processing_pages_use_local_marked_parser():
    for template_path in [Path('templates/index.html'), Path('templates/shared_study.html'), Path('templates/study.html')]:
        template = template_path.read_text(encoding='utf-8')
        assert "marked@17.0.4/lib/marked.umd.js" not in template
        assert "filename='js/marked-lite.js'" in template

    study_js = Path('static/js/study.js').read_text(encoding='utf-8')
    assert "marked@17.0.4/lib/marked.umd.js" not in study_js
    assert "src: '/static/js/marked-lite.js'" in study_js


def test_study_legacy_highlight_html_uses_shared_sanitizer():
    study_js = Path('static/js/study.js').read_text(encoding='utf-8')

    assert "function setNotesHtml(html)" in study_js
    assert "setSafeInnerHtml(notesView, html);" in study_js
    assert "notesView.innerHTML = String(html || '');" not in study_js


def test_shared_study_has_clear_empty_states():
    shared_js = Path('static/js/shared-study.js').read_text(encoding='utf-8')
    shared_css = Path('static/css/shared-study.css').read_text(encoding='utf-8')

    assert 'function emptyStateHtml(title, copy)' in shared_js
    assert 'No packs in this shared folder' in shared_js
    assert 'Nothing to preview yet' in shared_js
    assert 'No flashcards shared' in shared_js
    assert '.shared-empty-card' in shared_css
    assert '.shared-empty-title' in shared_css
