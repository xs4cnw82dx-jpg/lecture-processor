from lecture_processor.domains.study import audio
from lecture_processor.domains.study import export
from lecture_processor.domains.study import progress
from lecture_processor.runtime.container import get_runtime


def test_study_helpers_dispatch_uses_explicit_runtime():
    class _Runtime:
        def normalize_audio_storage_key(self, value):
            return f"audio:{value}"

        def markdown_to_docx(self, markdown, title):
            return {"markdown": markdown, "title": title}

        def sanitize_daily_goal_value(self, value):
            return int(value)

    runtime = _Runtime()
    assert audio.normalize_audio_storage_key("pack/1.mp3", runtime=runtime) == "audio:pack/1.mp3"
    assert export.markdown_to_docx("# Title", "Doc", runtime=runtime) == {"markdown": "# Title", "title": "Doc"}
    assert progress.sanitize_daily_goal_value("7", runtime=runtime) == 7


def test_study_helpers_dispatch_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.core, "normalize_audio_storage_key", lambda value: f"core_audio:{value}")
    monkeypatch.setattr(runtime.core, "sanitize_daily_goal_value", lambda value: f"goal:{value}")

    with app.app_context():
        assert audio.normalize_audio_storage_key("x") == "core_audio:x"
        assert progress.sanitize_daily_goal_value("9") == "goal:9"
