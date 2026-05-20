from pathlib import Path

from lecture_processor.domains.upload import import_audio
from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import upload_quota_service


def test_import_token_chargeable_bytes_skips_already_charged_import_bytes(app, tmp_path, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime, "AUDIO_IMPORT_TOKEN_TTL_SECONDS", 600)
    runtime.AUDIO_IMPORT_TOKENS.clear()

    audio_file = Path(tmp_path / "imported.mp3")
    audio_file.write_bytes(b"ID3\x03\x00\x00imported")
    token = import_audio.register_audio_import_token("u1", str(audio_file), runtime=runtime)

    assert upload_quota_service.chargeable_import_token_bytes(runtime, "u1", token, 4096) == 4096

    assert upload_quota_service.mark_audio_import_token_quota("u1", token, 4096, runtime=runtime) is True
    assert upload_quota_service.chargeable_import_token_bytes(runtime, "u1", token, 4096) == 0
    assert upload_quota_service.chargeable_import_token_bytes(runtime, "u1", token, 6000) == 1904

    import_audio.release_audio_import_token("u1", token, runtime=runtime)
