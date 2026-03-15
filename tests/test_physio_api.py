import io
import os
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.physio import access as physio_access
from lecture_processor.repositories import physio_repo


pytestmark = pytest.mark.usefixtures("disable_sentry")


class _FixedUuid(str):
    @property
    def hex(self):
        return str(self).replace("-", "")


@pytest.fixture(autouse=True)
def clear_physio_state():
    physio_repo.clear_memory_state()
    yield
    physio_repo.clear_memory_state()


def _allow_physio(monkeypatch, core, *, uid="physio-u1", email="owner@example.com"):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": uid, "email": email})
    monkeypatch.setattr(
        physio_access,
        "build_physio_access_payload",
        lambda _decoded_token, runtime=None: {"allowed": True, "reason": "test"},
    )


def test_physio_api_rejects_non_allowed_user(client, monkeypatch, core):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "blocked", "email": "blocked@example.com"})
    monkeypatch.setattr(
        physio_access,
        "build_physio_access_payload",
        lambda _decoded_token, runtime=None: {"allowed": False, "reason": "owner_only"},
    )

    response = client.get("/api/physio/cases", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 403
    assert response.get_json()["reason"] == "owner_only"


def test_physio_transcription_accepts_webm_and_starts_job(client, monkeypatch, core):
    _allow_physio(monkeypatch, core)
    monkeypatch.setattr(core, "client", object())
    monkeypatch.setattr(core, "file_looks_like_audio", lambda _path: True)
    monkeypatch.setattr(core.uuid, "uuid4", lambda: _FixedUuid("job-webm"))
    captured = {}

    def _submit_background_job(func, *args, **kwargs):
        captured["func"] = func
        captured["args"] = args
        captured["kwargs"] = kwargs
        return None

    monkeypatch.setattr(core, "submit_background_job", _submit_background_job)

    response = client.post(
        "/api/physio/transcriptions",
        data={"audio": (io.BytesIO(b"fake-webm-audio"), "consult.webm", "audio/webm")},
        content_type="multipart/form-data",
        headers={"Authorization": "Bearer dev", "X-Request-ID": "test-physio-webm"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["job_id"] == "job-webm"
    assert captured["args"][0] == "job-webm"
    audio_path = captured["args"][1]
    assert os.path.exists(audio_path)
    assert core.jobs["job-webm"]["mode"] == "physio-transcription"
    core.cleanup_files([audio_path], [])


def test_physio_transcription_invalid_audio_cleans_up_temp_file(client, monkeypatch, core):
    _allow_physio(monkeypatch, core)
    monkeypatch.setattr(core, "client", object())
    monkeypatch.setattr(core.uuid, "uuid4", lambda: _FixedUuid("job-invalid"))

    expected_path = os.path.join(core.UPLOAD_FOLDER, "job-invalid_consult.webm")
    if os.path.exists(expected_path):
        os.remove(expected_path)

    response = client.post(
        "/api/physio/transcriptions",
        data={"audio": (io.BytesIO(b"not-a-real-audio-file"), "consult.webm", "audio/webm")},
        content_type="multipart/form-data",
        headers={"Authorization": "Bearer dev", "X-Request-ID": "test-physio-invalid"},
    )

    assert response.status_code == 400
    assert "invalid" in response.get_json()["error"].lower()
    assert not os.path.exists(expected_path)


def test_physio_case_and_session_crud_roundtrip(client, monkeypatch, core):
    _allow_physio(monkeypatch, core)

    create_case = client.post(
        "/api/physio/cases",
        json={"display_label": "Casus 1 - Knie", "patient_name": "P. Voorbeeld", "body_region": "knie"},
        headers={"Authorization": "Bearer dev"},
    )
    assert create_case.status_code == 200
    case_payload = create_case.get_json()["case"]
    case_id = case_payload["case_id"]

    list_cases = client.get("/api/physio/cases", headers={"Authorization": "Bearer dev"})
    assert list_cases.status_code == 200
    assert list_cases.get_json()["cases"][0]["case_id"] == case_id

    update_case = client.patch(
        f"/api/physio/cases/{case_id}",
        json={"notes": "Verwijzing huisarts", "tags": "artrose, knie"},
        headers={"Authorization": "Bearer dev"},
    )
    assert update_case.status_code == 200
    assert update_case.get_json()["case"]["notes"] == "Verwijzing huisarts"

    create_session = client.post(
        f"/api/physio/cases/{case_id}/sessions",
        json={
            "session_date": "2026-03-15",
            "session_type": "intake",
            "body_region": "knie",
            "transcript": "[Patiënt] Traplopen doet pijn.",
            "soap": {"subjective": {"hulpvraag": "Traplopen zonder pijn"}},
            "metrics": {"nprs_before": "7", "nprs_after": "5", "notes": "Eerste intake"},
        },
        headers={"Authorization": "Bearer dev"},
    )
    assert create_session.status_code == 200
    session_payload = create_session.get_json()["session"]
    session_id = session_payload["session_id"]
    assert session_payload["session_date_ts"] > 0

    list_sessions = client.get(
        f"/api/physio/cases/{case_id}/sessions",
        headers={"Authorization": "Bearer dev"},
    )
    assert list_sessions.status_code == 200
    assert list_sessions.get_json()["sessions"][0]["session_id"] == session_id

    update_session = client.patch(
        f"/api/physio/cases/{case_id}/sessions",
        json={
            "session_id": session_id,
            "transcript": "[Patiënt] Traplopen gaat al iets beter.",
            "rps": {"header": {"datum": "2026-03-15"}},
            "metrics": {"nprs_before": "6", "nprs_after": "4", "notes": "Bijgesteld"},
        },
        headers={"Authorization": "Bearer dev"},
    )
    assert update_session.status_code == 200
    updated_session = update_session.get_json()["session"]
    assert updated_session["rps"]["header"]["datum"] == "2026-03-15"
    assert updated_session["metrics"]["nprs_after"] == "4"


def test_physio_soap_endpoint_normalizes_partial_json(client, monkeypatch, core):
    _allow_physio(monkeypatch, core)
    monkeypatch.setattr(core, "client", object())
    monkeypatch.setattr(
        ai_provider,
        "run_with_provider_retry",
        lambda operation_name, fn, runtime=None: SimpleNamespace(text='{"subjective":{"hulpvraag":"Traplopen zonder pijn"}}'),
    )

    response = client.post(
        "/api/physio/soap",
        json={"transcript": "[Patiënt] Ik wil weer normaal traplopen."},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    soap = response.get_json()["soap"]
    assert soap["subjective"]["hulpvraag"] == "Traplopen zonder pijn"
    assert soap["objective"]["inspectie"] is None
    assert soap["assessment"]["prognose"] is None


def test_physio_reasoning_endpoint_handles_malformed_model_output(client, monkeypatch, core):
    _allow_physio(monkeypatch, core)
    monkeypatch.setattr(core, "client", object())

    def _fake_provider(operation_name, fn, runtime=None):
        if operation_name == "physio_generate_reasoning":
            return SimpleNamespace(text="geen geldige json")
        if operation_name == "physio_generate_differential":
            return SimpleNamespace(text='{"hypothesen":[{"titel":"Artrose","onderbouwing":"Belastingsafhankelijke pijn"}]}')
        if operation_name == "physio_generate_red_flags":
            return SimpleNamespace(text="dit is geen array")
        raise AssertionError(f"Unexpected operation: {operation_name}")

    monkeypatch.setattr(ai_provider, "run_with_provider_retry", _fake_provider)

    response = client.post(
        "/api/physio/reasoning",
        json={"transcript": "[Patiënt] Traplopen en lang lopen doen pijn.", "body_region": "knie", "session_type": "intake"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["seven_step"]["stap_5_diagnostisch_proces"]["screening"]["rode_vlaggen"] is None
    assert body["differential_diagnosis"]["hypothesen"][0]["titel"] == "Artrose"
    assert body["red_flags"] == []


@pytest.mark.parametrize(
    ("export_format", "expected_mimetype", "expected_suffix"),
    (
        ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx"),
        ("pdf", "application/pdf", ".pdf"),
    ),
)
def test_physio_export_endpoint_returns_files(client, monkeypatch, core, export_format, expected_mimetype, expected_suffix):
    _allow_physio(monkeypatch, core)

    response = client.post(
        "/api/physio/export",
        json={
            "kind": "SOAP",
            "title": "Casus 1 Knie",
            "format": export_format,
            "data": {"subjective": {"hulpvraag": "Traplopen zonder pijn"}},
        },
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    assert response.mimetype == expected_mimetype
    assert response.headers["Content-Disposition"].endswith(expected_suffix)
    assert len(response.data) > 50
