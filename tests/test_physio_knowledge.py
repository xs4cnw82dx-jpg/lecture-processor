import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.physio import access as physio_access
from lecture_processor.domains.physio import knowledge as physio_knowledge


pytestmark = pytest.mark.usefixtures("disable_sentry")


def _allow_physio(monkeypatch, core, *, uid="physio-u1", email="owner@example.com"):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": uid, "email": email})
    monkeypatch.setattr(
        physio_access,
        "build_physio_access_payload",
        lambda _decoded_token, runtime=None: {"allowed": True, "reason": "test"},
    )


@pytest.fixture(autouse=True)
def clear_knowledge_cache():
    physio_knowledge._INDEX_CACHE.update({"path": "", "mtime": 0.0, "payload": None})
    yield
    physio_knowledge._INDEX_CACHE.update({"path": "", "mtime": 0.0, "payload": None})


def test_rank_index_documents_orders_by_similarity():
    ranked = physio_knowledge.rank_index_documents(
        [1.0, 0.0],
        [
            {"source_title": "Lagere score", "embedding": [0.2, 0.8]},
            {"source_title": "Beste match", "embedding": [1.0, 0.0]},
        ],
        limit=2,
    )

    assert ranked[0]["source_title"] == "Beste match"
    assert ranked[0]["score"] > ranked[1]["score"]


def test_query_knowledge_index_returns_ranked_citations(monkeypatch, tmp_path):
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "meta": {"source_count": 2, "document_count": 2},
                "documents": [
                    {
                        "id": "doc-1",
                        "text": "Richtlijn adviseert oefentherapie bij knieartrose.",
                        "source_name": "kngf.pdf",
                        "source_title": "KNGF Richtlijn",
                        "page_label": "pagina 4",
                        "embedding": [1.0, 0.0],
                    },
                    {
                        "id": "doc-2",
                        "text": "Casusdocument noemt klinisch redeneren.",
                        "source_name": "casus.pdf",
                        "source_title": "Casus 3",
                        "page_label": "pagina 2",
                        "embedding": [0.0, 1.0],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(physio_knowledge, "PHYSIO_LIBRARY_INDEX_PATH", manifest_path)
    monkeypatch.setattr(physio_knowledge, "embed_text", lambda text, task_type="RETRIEVAL_QUERY", runtime=None: [1.0, 0.0])
    monkeypatch.setattr(
        ai_provider,
        "generate_with_optional_thinking",
        lambda model, prompt, max_output_tokens=4096, operation_name="", runtime=None: SimpleNamespace(text="## Advies\n- Oefentherapie heeft prioriteit."),
    )

    response = physio_knowledge.query_knowledge_index(
        "Wat adviseert de richtlijn bij knieartrose?",
        runtime=SimpleNamespace(MODEL_TOOLS="gemini-test"),
    )

    assert response["citations"][0]["label"] == "KNGF Richtlijn (pagina 4)"
    assert response["retrieved_sources"][0]["source_title"] == "KNGF Richtlijn"
    assert "Oefentherapie" in response["answer_markdown"]


def test_knowledge_index_status_reports_counts_and_staleness(tmp_path):
    source_root = tmp_path / "sources"
    guides_dir = source_root / "guidelines"
    guides_dir.mkdir(parents=True)
    source_path = guides_dir / "beroerte.pdf"
    source_path.write_text("dummy", encoding="utf-8")
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "meta": {"generated_at": 123.0, "source_count": 1, "document_count": 1},
                "documents": [
                    {
                        "source_path": str(source_path.relative_to(tmp_path)),
                        "source_name": "beroerte.pdf",
                        "text": "lateralisatie",
                        "embedding": [1.0],
                    }
                ],
                "errors": [],
            }
        ),
        encoding="utf-8",
    )

    status = physio_knowledge.knowledge_index_status(index_path=manifest_path, source_root=source_root)

    assert status["source_count_on_disk"] == 1
    assert status["indexed_source_count"] == 1
    assert status["document_count"] == 1
    assert status["stale"] is False


def test_knowledge_query_endpoint_uses_manifest(client, monkeypatch, core, tmp_path):
    _allow_physio(monkeypatch, core)
    monkeypatch.setattr(core, "client", object())
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "meta": {"source_count": 1, "document_count": 1},
                "documents": [
                    {
                        "id": "doc-1",
                        "text": "Gebruik actieve oefentherapie bij heupartrose.",
                        "source_name": "heup.pdf",
                        "source_title": "Heupartrose Richtlijn",
                        "page_label": "pagina 8",
                        "embedding": [1.0, 0.0],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(physio_knowledge, "PHYSIO_LIBRARY_INDEX_PATH", manifest_path)
    monkeypatch.setattr(physio_knowledge, "embed_text", lambda text, task_type="RETRIEVAL_QUERY", runtime=None: [1.0, 0.0])
    monkeypatch.setattr(
        ai_provider,
        "generate_with_optional_thinking",
        lambda model, prompt, max_output_tokens=4096, operation_name="", runtime=None: SimpleNamespace(text="## Bronantwoord\n- Start met educatie en oefentherapie."),
    )

    response = client.post(
        "/api/physio/knowledge/query",
        json={"question": "Wat is de eerste stap bij heupartrose?"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["citations"][0]["label"] == "Heupartrose Richtlijn (pagina 8)"
    assert body["retrieved_sources"][0]["source_name"] == "heup.pdf"


def test_knowledge_status_endpoint_returns_index_metadata(client, monkeypatch, core):
    _allow_physio(monkeypatch, core)
    monkeypatch.setattr(
        physio_knowledge,
        "knowledge_index_status",
        lambda: {"source_count_on_disk": 171, "indexed_source_count": 162, "document_count": 23321, "stale": False},
    )

    response = client.get("/api/physio/knowledge/status", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    body = response.get_json()
    assert body["source_count_on_disk"] == 171
    assert body["document_count"] == 23321


def test_build_physio_library_script_writes_manifest_from_text_source(tmp_path):
    script_path = Path(__file__).resolve().parents[1] / "scripts" / "build_physio_library.py"
    spec = importlib.util.spec_from_file_location("build_physio_library", script_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)

    source_root = tmp_path / "sources"
    forms_dir = source_root / "forms"
    forms_dir.mkdir(parents=True)
    (forms_dir / "notes.md").write_text("# SOAP\n\nKnieartrose vraagt om oefentherapie.", encoding="utf-8")
    index_path = tmp_path / "manifest.json"

    manifest = module.build_manifest(
        source_root,
        index_path=index_path,
        embed_text_fn=lambda text, task_type="RETRIEVAL_DOCUMENT": [float(len(text)), 1.0],
    )

    assert index_path.exists()
    written = json.loads(index_path.read_text(encoding="utf-8"))
    assert written["meta"]["source_count"] == 1
    assert written["meta"]["document_count"] >= 1
    assert manifest["documents"][0]["source_kind"] == "forms"
    assert manifest["documents"][0]["embedding"][1] == 1.0
