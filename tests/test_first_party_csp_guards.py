from pathlib import Path
import re


FORBIDDEN_JS_PATTERNS = (
    re.compile(r"\.style\."),
    re.compile(r"setAttribute\s*\(\s*['\"]style['\"]"),
)
FORBIDDEN_TEMPLATE_PATTERNS = (
    re.compile(r"\sstyle="),
)


def _iter_first_party_js_files():
    return sorted(Path("static/js").glob("*.js"))


def _iter_template_files():
    return sorted(Path("templates").glob("*.html"))


def test_first_party_templates_do_not_use_inline_style_attributes():
    offenders = []
    for path in _iter_template_files():
        text = path.read_text(encoding="utf-8")
        for pattern in FORBIDDEN_TEMPLATE_PATTERNS:
            if pattern.search(text):
                offenders.append(str(path))
                break
    assert offenders == []


def test_first_party_non_minified_js_does_not_mutate_inline_styles():
    offenders = []
    for path in _iter_first_party_js_files():
        if path.name.endswith(".min.js"):
            continue
        text = path.read_text(encoding="utf-8")
        for pattern in FORBIDDEN_JS_PATTERNS:
            if pattern.search(text):
                offenders.append(str(path))
                break
    assert offenders == []
