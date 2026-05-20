from pathlib import Path
from lecture_processor.domains.upload import import_audio
from lecture_processor.runtime.container import get_runtime
from lecture_processor.services.url_security import ValidatedFetchTarget


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


def test_validate_video_import_fetch_target_returns_pinned_target(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime, "VIDEO_IMPORT_ALLOWED_HOST_SUFFIXES", ("example.com",))
    monkeypatch.setattr(runtime, "VIDEO_IMPORT_MAX_URL_LENGTH", 4096)
    target = ValidatedFetchTarget(
        url="https://video.example.com/watch",
        scheme="https",
        host="video.example.com",
        port=443,
        resolved_ips=("93.184.216.34",),
    )
    captured = {}

    def _validate(url, **kwargs):
        captured["url"] = url
        captured["kwargs"] = kwargs
        return target, ""

    monkeypatch.setattr(runtime.url_security, "validate_external_url_for_fetch", _validate)

    fetch_target, error = import_audio.validate_video_import_fetch_target("https://video.example.com/watch", runtime=runtime)

    assert error == ""
    assert fetch_target == target
    assert captured["kwargs"]["return_fetch_target"] is True
    assert captured["kwargs"]["resolve_dns"] is True


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


def test_release_audio_import_tokens_for_uid_removes_only_matching_user_files(app, tmp_path, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime, "VIDEO_IMPORT_MAX_URL_LENGTH", 4096)
    monkeypatch.setattr(runtime, "AUDIO_IMPORT_TOKEN_TTL_SECONDS", 600)
    runtime.AUDIO_IMPORT_TOKENS.clear()

    u1_file = Path(tmp_path / "u1.mp3")
    u2_file = Path(tmp_path / "u2.mp3")
    u1_file.write_bytes(b"ID3\x03\x00\x00u1")
    u2_file.write_bytes(b"ID3\x03\x00\x00u2")
    token_u1 = import_audio.register_audio_import_token("u1", str(u1_file), runtime=runtime)
    token_u2 = import_audio.register_audio_import_token("u2", str(u2_file), runtime=runtime)

    result = import_audio.release_audio_import_tokens_for_uid("u1", runtime=runtime)

    assert result == {"tokens": 1, "files": 1}
    assert token_u1 not in runtime.AUDIO_IMPORT_TOKENS
    assert token_u2 in runtime.AUDIO_IMPORT_TOKENS
    assert not u1_file.exists()
    assert u2_file.exists()
    import_audio.release_audio_import_tokens_for_uid("u2", runtime=runtime)
