from pathlib import Path

from lecture_processor.domains.upload import import_audio
from lecture_processor.runtime.container import get_runtime


def test_validate_video_import_url_enforces_allowed_host_suffixes(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime, "VIDEO_IMPORT_ALLOWED_HOST_SUFFIXES", ("example.com",))
    monkeypatch.setattr(runtime, "VIDEO_IMPORT_MAX_URL_LENGTH", 4096)
    monkeypatch.setattr(
        runtime.url_security,
        "validate_external_url_for_fetch",
        lambda *_args, **_kwargs: ("https://video.example.com/watch", ""),
    )
    assert import_audio.validate_video_import_url("https://video.example.com/watch", runtime=runtime) == (
        "https://video.example.com/watch",
        "",
    )


def test_audio_import_token_lifecycle(app, tmp_path, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime, "VIDEO_IMPORT_MAX_URL_LENGTH", 4096)
    monkeypatch.setattr(runtime, "AUDIO_IMPORT_TOKEN_TTL_SECONDS", 600)

    audio_file = Path(tmp_path / "audio.mp3")
    audio_file.write_bytes(b"abc")

    token = import_audio.register_audio_import_token("u1", str(audio_file), runtime=runtime)
    assert token

    path, error = import_audio.get_audio_import_token_path("u1", token, runtime=runtime)
    assert error == ""
    assert path == str(audio_file)

    assert import_audio.release_audio_import_token("u1", token, runtime=runtime) is True
    assert not audio_file.exists()
