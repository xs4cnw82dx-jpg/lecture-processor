from pathlib import Path


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
