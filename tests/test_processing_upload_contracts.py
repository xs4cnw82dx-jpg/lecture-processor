from pathlib import Path
import re


def test_main_processing_audio_ui_accepts_webm_uploads():
    index_template = Path("templates/index.html").read_text(encoding="utf-8")
    index_js = Path("static/js/index-app.js").read_text(encoding="utf-8")

    assert re.search(r'id="audio-input"[^>]*accept="[^"]*\.webm', index_template)
    assert "WEBM" in index_template
    assert "'.webm'" in index_js
    assert "'audio/webm'" in index_js


def test_slide_ui_accepts_backend_safe_slide_mime_values():
    index_js = Path("static/js/index-app.js").read_text(encoding="utf-8")

    for mime_type in (
        "application/pdf",
        "application/x-pdf",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "application/vnd.ms-powerpoint",
        "application/octet-stream",
    ):
        assert f"'{mime_type}'" in index_js
