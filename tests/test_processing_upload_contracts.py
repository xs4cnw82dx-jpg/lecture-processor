from pathlib import Path
import re


def test_main_processing_audio_ui_accepts_webm_uploads():
    index_template = Path("templates/index.html").read_text(encoding="utf-8")

    assert re.search(r'id="audio-input"[^>]*accept="[^"]*\.webm', index_template)
    assert "WEBM" in index_template


