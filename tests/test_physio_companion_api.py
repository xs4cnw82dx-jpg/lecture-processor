import json

import pytest

from lecture_processor.physio_companion import CompanionConfig, create_companion_app


NOTE = """---
id: shoulder
type: region
regions: [Schouder]
aliases: [Shoulder]
curation_status: reviewed
trust_tier: guideline
---
# Schouder
Gereviewde klinische inhoud.
"""


@pytest.fixture()
def companion(tmp_path):
    vault = tmp_path / "vault"
    support = tmp_path / "support"
    vault.mkdir()
    support.mkdir()
    (vault / "Schouder.md").write_text(NOTE, encoding="utf-8")
    media = tmp_path / "atlas.pdf"
    media.write_bytes(b"0123456789")
    (support / "source-manifest.json").write_text(
        json.dumps({"sources": [
            {"id": "atlas-page", "local_path": str(media), "mime_type": "application/pdf"},
            {"id": "blocked-private", "local_path": str(media), "mime_type": "application/pdf", "privacy_class": "review-required"},
            {"id": "rejected-source", "local_path": str(media), "mime_type": "application/pdf", "review_status": "rejected"},
        ]}),
        encoding="utf-8",
    )
    config = CompanionConfig(vault_path=vault, app_support_path=support, secret_key="test-secret")
    app = create_companion_app(config)
    app.config.update(TESTING=True)
    with app.test_client() as client:
        authorized = client.post(
            "/owner-session",
            json={"owner_token": config.owner_token},
        )
        assert authorized.status_code == 200
        yield client, app.extensions["physio_companion"]
    app.extensions["physio_companion"].close()


def csrf(client):
    return client.get("/api/local/physio/csrf").get_json()["csrf_token"]


def test_loopback_host_origin_and_csrf_are_enforced(companion):
    client, _service = companion
    assert client.get("/api/local/physio/health", headers={"Host": "attacker.example"}).status_code == 403
    assert client.get(
        "/api/local/physio/health",
        headers={"Origin": "https://attacker.example", "Sec-Fetch-Site": "cross-site"},
    ).status_code == 403
    assert client.post("/api/local/physio/cases", json={}).status_code == 403
    token = csrf(client)
    assert client.post(
        "/api/local/physio/cases", json={"title": "Casus A"}, headers={"X-CSRF-Token": token}
    ).status_code == 201


def test_companion_data_requires_stable_owner_authorization(tmp_path):
    config = CompanionConfig(vault_path=tmp_path / "vault", app_support_path=tmp_path / "support")
    app = create_companion_app(config)
    app.config.update(TESTING=True)
    try:
        with app.test_client() as client:
            assert client.get("/healthz").status_code == 200
            assert client.get("/api/local/physio/health").status_code == 401
            assert client.post("/owner-session", json={"owner_token": "wrong"}).status_code == 403
            assert client.post(
                "/owner-session", json={"owner_token": config.owner_token}
            ).status_code == 200
            assert client.get("/api/local/physio/health").status_code == 200
    finally:
        app.extensions["physio_companion"].close()


def test_search_and_note_routes_are_reviewed_local_data(companion):
    client, _service = companion
    response = client.get("/api/local/physio/search?q=Shoulder")

    assert response.status_code == 200
    result = response.get_json()["results"][0]
    assert result["note_id"] == "shoulder"
    note = client.get("/api/local/physio/notes/shoulder").get_json()
    assert note["obsidian_uri"].startswith("obsidian://open?")
    assert note["reviewed"] is True


def test_deep_query_supplements_open_notes_with_retrieval_and_passes_region(companion, monkeypatch):
    client, service = companion
    captured = {}

    def submit(query, note_ids, **kwargs):
        captured.update(query=query, note_ids=note_ids, **kwargs)
        return {"job_id": "captured", "status": "queued"}

    monkeypatch.setattr(service.jobs, "submit_deep_query", submit)
    response = client.post(
        "/api/local/physio/jobs/deep-query",
        json={"query": "Shoulder", "note_ids": ["already-open"], "region": "schouder"},
        headers={"X-CSRF-Token": csrf(client)},
    )

    assert response.status_code == 202
    assert captured["note_ids"] == ["already-open", "shoulder"]
    assert captured["region"] == "schouder"


def test_standalone_workspace_is_served_locally_with_strict_headers(companion):
    client, _service = companion
    response = client.get("/physio")

    assert response.status_code == 200
    assert b"Physio Clinical Workspace" in response.data
    assert "connect-src 'self'" in response.headers["Content-Security-Policy"]
    assert "Access-Control-Allow-Origin" not in response.headers
    assert client.get("/healthz").get_json() == {"status": "ok", "local_only": True}


def test_manifest_ids_prevent_traversal_and_media_supports_ranges(companion):
    client, _service = companion
    full = client.get("/api/local/physio/media/atlas-page")
    partial = client.get("/api/local/physio/media/atlas-page", headers={"Range": "bytes=2-5"})
    suffix = client.get("/api/local/physio/media/atlas-page", headers={"Range": "bytes=-3"})

    assert full.data == b"0123456789"
    assert partial.status_code == 206
    assert partial.data == b"2345"
    assert partial.headers["Content-Range"] == "bytes 2-5/10"
    assert suffix.data == b"789"
    assert client.get("/api/local/physio/media/..%2F..%2Fetc%2Fpasswd").status_code == 404
    assert client.get("/api/local/physio/media/blocked-private").status_code == 404
    assert client.get("/api/local/physio/media/rejected-source").status_code == 404
    assert all(item["id"] != "blocked-private" for item in client.get("/api/local/physio/media").get_json()["media"])
    invalid = client.get("/api/local/physio/media/atlas-page", headers={"Range": "bytes=99-100"})
    assert invalid.status_code == 416
    assert invalid.headers["Content-Range"] == "bytes */10"


def test_cases_sessions_export_and_permanent_delete(companion):
    client, _service = companion
    token = csrf(client)
    headers = {"X-CSRF-Token": token}
    created = client.post(
        "/api/local/physio/cases",
        json={"title": "Schouder casus 01", "presenting_complaint": "Pijn bij heffen", "pinned_note_ids": ["shoulder"]},
        headers=headers,
    ).get_json()
    case_id = created["case_id"]
    session = client.post(
        f"/api/local/physio/cases/{case_id}/sessions",
        json={"kind": "soap", "content": {"S": "Pijn bij heffen", "O": "Actieve elevatie beperkt"}},
        headers=headers,
    )
    assert session.status_code == 201
    exported = client.get(f"/api/local/physio/cases/{case_id}/export")
    assert exported.get_json()["sessions"][0]["kind"] == "soap"
    assert "attachment" in exported.headers["Content-Disposition"]
    assert client.delete(f"/api/local/physio/cases/{case_id}", headers=headers).status_code == 204
    assert client.get(f"/api/local/physio/cases/{case_id}").status_code == 404


def test_case_context_is_stored_on_professional_judgement_without_local_identifier_scanner(companion):
    client, _service = companion
    response = client.post(
        "/api/local/physio/cases",
        json={"title": "Casus", "notes": "naam: Test Persoon; test@example.invalid; 1234 AB"},
        headers={"X-CSRF-Token": csrf(client)},
    )

    assert response.status_code == 201
    assert "test@example.invalid" in response.get_json()["notes"]


def test_transcription_endpoint_is_removed_with_simulation_mode(companion):
    client, _service = companion
    assert client.post(
        "/api/local/physio/transcriptions", headers={"X-CSRF-Token": csrf(client)}
    ).status_code == 404
