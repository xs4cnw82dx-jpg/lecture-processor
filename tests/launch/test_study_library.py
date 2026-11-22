import pytest

from lecture_processor.domains.study import audio as study_audio
from tests.runtime_test_support import get_test_core

core = get_test_core()

pytestmark = pytest.mark.usefixtures("disable_sentry")


def test_study_pack_crud_requires_auth(client):
    assert client.get("/api/study-packs").status_code == 401
    assert client.post("/api/study-packs", json={}).status_code == 401
    assert client.get("/api/study-packs/pack-1").status_code == 401
    assert client.patch("/api/study-packs/pack-1", json={}).status_code == 401
    assert client.delete("/api/study-packs/pack-1").status_code == 401


def test_study_folder_crud_requires_auth(client):
    assert client.get("/api/study-folders").status_code == 401
    assert client.post("/api/study-folders", json={"name": "A"}).status_code == 401
    assert client.patch("/api/study-folders/f-1", json={"name": "B"}).status_code == 401
    assert client.delete("/api/study-folders/f-1").status_code == 401


def test_study_pack_audio_requires_auth(client):
    assert client.get("/api/study-packs/pack-audio/audio").status_code == 401
    assert client.post("/api/study-packs/pack-audio/audio-token").status_code == 401
    assert client.get("/api/study-packs/pack-audio/audio-stream").status_code == 401


def test_study_pack_audio_forbidden_for_other_user(client, monkeypatch, tmp_path):
    audio_file = tmp_path / "sample.mp3"
    audio_file.write_bytes(b"ID3\x03\x00\x00\x00")

    class _FakeDoc:
        exists = True

        def __init__(self):
            self.reference = self

        def to_dict(self):
            return {
                "uid": "owner-uid",
                "audio_storage_key": "study_audio/sample.mp3",
            }

        def set(self, *_args, **_kwargs):
            return None

    revocation_checks = []

    def _verify_token(_request, check_revoked=False):
        revocation_checks.append(check_revoked)
        return {"uid": "other-uid", "email": "user@gmail.com"}

    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _FakeDoc())
    monkeypatch.setattr(core, "verify_firebase_token", _verify_token)
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: False)
    monkeypatch.setattr(study_audio, "resolve_audio_storage_path_from_key", lambda _key, runtime=None: str(audio_file))

    response = client.get("/api/study-packs/pack-audio/audio", headers={"Authorization": "Bearer dev"})
    assert response.status_code == 403
    assert revocation_checks == [False, True]


def test_study_pack_audio_token_streams_file_without_auth_header(client, monkeypatch, tmp_path):
    core.AUDIO_STREAM_TOKENS.clear()
    audio_file = tmp_path / "sample.mp3"
    audio_file.write_bytes(b"ID3\x03\x00\x00\x00audio-bytes")

    class _FakeDoc:
        exists = True

        def __init__(self):
            self.reference = self

        def to_dict(self):
            return {
                "uid": "owner-uid",
                "audio_storage_key": "study_audio/sample.mp3",
            }

        def set(self, *_args, **_kwargs):
            return None

    monkeypatch.setattr(core, "STUDY_AUDIO_ROOT", str(tmp_path), raising=False)
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _FakeDoc())
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "owner-uid", "email": "user@gmail.com"})

    token_response = client.post(
        "/api/study-packs/pack-audio/audio-token",
        headers={"Authorization": "Bearer dev"},
    )

    assert token_response.status_code == 200
    token_payload = token_response.get_json()
    assert token_payload["token"] in core.AUDIO_STREAM_TOKENS
    assert token_payload["stream_url"].startswith("/api/study-packs/pack-audio/audio-stream?token=")

    stream_response = client.get(token_payload["stream_url"])
    assert stream_response.status_code == 200
    assert stream_response.data == audio_file.read_bytes()


def test_study_pack_audio_download_uses_attachment_filename(client, monkeypatch, tmp_path):
    audio_file = tmp_path / "sample.mp3"
    audio_file.write_bytes(b"ID3\x03\x00\x00download-audio-bytes")

    class _FakeDoc:
        exists = True

        def __init__(self):
            self.reference = self

        def to_dict(self):
            return {
                "uid": "owner-uid",
                "title": "My Lecture: Week 1",
                "audio_storage_key": "study_audio/sample.mp3",
            }

        def set(self, *_args, **_kwargs):
            return None

    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _FakeDoc())
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "owner-uid", "email": "user@gmail.com"})
    monkeypatch.setattr(study_audio, "resolve_audio_storage_path_from_key", lambda _key, runtime=None: str(audio_file))

    response = client.get(
        "/api/study-packs/pack-audio/audio?download=1",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    assert response.data == audio_file.read_bytes()
    content_disposition = response.headers.get("Content-Disposition", "")
    assert "attachment" in content_disposition
    assert "My_Lecture_Week_1.mp3" in content_disposition
