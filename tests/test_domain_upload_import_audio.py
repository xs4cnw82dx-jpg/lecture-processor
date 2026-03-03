from lecture_processor.domains.upload import import_audio
from lecture_processor.runtime.container import get_runtime


def test_upload_import_audio_dispatch_uses_explicit_runtime():
    class _Runtime:
        def validate_video_import_url(self, url):
            return (url, "")

        def cleanup_expired_audio_import_tokens(self):
            return "cleaned"

        def register_audio_import_token(self, uid, path, source_url, output_name):
            return f"tok:{uid}:{output_name}"

        def get_audio_import_token_path(self, uid, token, consume=False):
            return (f"/tmp/{uid}/{token}", "" if not consume else "consumed")

        def release_audio_import_token(self, uid, token):
            return f"released:{uid}:{token}"

    runtime = _Runtime()
    assert import_audio.validate_video_import_url("https://video.example", runtime=runtime) == ("https://video.example", "")
    assert import_audio.cleanup_expired_audio_import_tokens(runtime=runtime) == "cleaned"
    assert import_audio.register_audio_import_token("u1", "/tmp/a.mp3", "https://video.example", "a.mp3", runtime=runtime) == "tok:u1:a.mp3"
    assert import_audio.get_audio_import_token_path("u1", "tok1", runtime=runtime) == ("/tmp/u1/tok1", "")
    assert import_audio.release_audio_import_token("u1", "tok1", runtime=runtime) == "released:u1:tok1"


def test_upload_import_audio_dispatch_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.core, "validate_video_import_url", lambda url: (f"safe:{url}", ""))
    monkeypatch.setattr(runtime.core, "cleanup_expired_audio_import_tokens", lambda: "ok")

    with app.app_context():
        assert import_audio.validate_video_import_url("https://x") == ("safe:https://x", "")
        assert import_audio.cleanup_expired_audio_import_tokens() == "ok"
