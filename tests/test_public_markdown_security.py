from pathlib import Path


def test_markdown_fallback_sanitizer_fails_closed_without_dompurify():
    markdown_js = Path('static/js/markdown-utils.js').read_text(encoding='utf-8')

    assert "return escapeHtml(html);" in markdown_js
    assert "global.DOMPurify.sanitize(html, sanitizeOptions || {})" in markdown_js
    assert "return html;" not in markdown_js


def test_shared_study_loads_html_utils_before_markdown_utils():
    template = Path('templates/shared_study.html').read_text(encoding='utf-8')

    html_index = template.index("filename='js/html-utils.js'")
    markdown_index = template.index("filename='js/markdown-utils.js'")
    assert html_index < markdown_index


def test_study_legacy_highlight_html_uses_shared_sanitizer():
    study_js = Path('static/js/study.js').read_text(encoding='utf-8')

    assert "function setNotesHtml(html)" in study_js
    assert "setSafeInnerHtml(notesView, html);" in study_js
    assert "notesView.innerHTML = String(html || '');" not in study_js
