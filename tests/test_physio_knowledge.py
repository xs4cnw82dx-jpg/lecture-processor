import importlib.util
import gzip
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
    physio_knowledge._INDEX_CACHE.update({"path": "", "mtime": 0.0, "signature": "", "payload": None})
    yield
    physio_knowledge._INDEX_CACHE.update({"path": "", "mtime": 0.0, "signature": "", "payload": None})


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
                        "source_kind": "guidelines",
                        "page_label": "pagina 4",
                        "embedding": [1.0, 0.0],
                    },
                    {
                        "id": "doc-2",
                        "text": "Casusdocument noemt klinisch redeneren.",
                        "source_name": "casus.pdf",
                        "source_title": "Casus 3",
                        "source_kind": "cases",
                        "page_label": "pagina 2",
                        "embedding": [0.0, 1.0],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    seen = {}

    def fake_embed_text(text, task_type="RETRIEVAL_QUERY", runtime=None, output_dimensionality=None):
        seen["dimension"] = output_dimensionality
        return [1.0, 0.0]

    monkeypatch.setattr(physio_knowledge, "PHYSIO_LIBRARY_INDEX_PATH", manifest_path)
    monkeypatch.setattr(
        physio_knowledge,
        "embed_text",
        fake_embed_text,
    )
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
    assert response["citations"][0]["source_kind"] == "guidelines"
    assert response["retrieved_sources"][0]["source_title"] == "KNGF Richtlijn"
    assert response["retrieved_sources"][0]["source_kind"] == "guidelines"
    assert "Oefentherapie" in response["answer_markdown"]
    assert seen["dimension"] == 2


def test_query_knowledge_index_reads_shards_incrementally(monkeypatch, tmp_path):
    manifest_path = tmp_path / "manifest.json"
    shard_name = "manifest.documents-001.json.gz"
    with gzip.open(tmp_path / shard_name, "wt", encoding="utf-8") as handle:
        json.dump(
            [
                {
                    "id": "doc-1",
                    "text": "Rechts hemisferisch CVA geeft vaak linkszijdige neglect.",
                    "source_name": "beroerte.pdf",
                    "source_title": "Beroerte Richtlijn",
                    "source_kind": "guidelines",
                    "page_label": "pagina 3",
                    "embedding": [1.0, 0.0],
                },
                {
                    "id": "doc-2",
                    "text": "Linker hemisferisch CVA gaat vaker samen met afasie.",
                    "source_name": "beroerte.pdf",
                    "source_title": "Beroerte Richtlijn",
                    "source_kind": "guidelines",
                    "page_label": "pagina 4",
                    "embedding": [0.0, 1.0],
                },
            ],
            handle,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    manifest_path.write_text(
        json.dumps(
            {
                "meta": {
                    "source_count": 1,
                    "document_count": 2,
                    "embedding_dimension": 2,
                    "format": physio_knowledge.SHARDED_INDEX_FORMAT,
                    "document_shards": [shard_name],
                },
                "documents": [],
                "errors": [],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(physio_knowledge, "PHYSIO_LIBRARY_INDEX_PATH", manifest_path)
    monkeypatch.setattr(
        physio_knowledge,
        "load_knowledge_index",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("full index load should not be used for sharded queries")),
    )
    monkeypatch.setattr(
        physio_knowledge,
        "embed_text",
        lambda text, task_type="RETRIEVAL_QUERY", runtime=None, output_dimensionality=None: [1.0, 0.0],
    )
    monkeypatch.setattr(
        ai_provider,
        "generate_with_optional_thinking",
        lambda model, prompt, max_output_tokens=4096, operation_name="", runtime=None: SimpleNamespace(text="## Antwoord\n- Rechts CVA geeft vaak linkszijdige uitval."),
    )

    response = physio_knowledge.query_knowledge_index(
        "Wat hoort bij een CVA rechts?",
        runtime=SimpleNamespace(MODEL_TOOLS="gemini-test"),
    )

    assert response["citations"][0]["label"] == "Beroerte Richtlijn (pagina 3)"
    assert response["citations"][0]["source_kind"] == "guidelines"
    assert response["retrieved_sources"][0]["source_name"] == "beroerte.pdf"
    assert response["retrieved_sources"][0]["source_kind"] == "guidelines"


def test_query_knowledge_index_boosts_matching_guidelines_from_body_region_and_case_context(monkeypatch, tmp_path):
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "meta": {"source_count": 3, "document_count": 3},
                "documents": [
                    {
                        "id": "guide-heup",
                        "text": "De heuprichtlijn adviseert actieve oefentherapie en educatie bij artrose.",
                        "source_name": "heup-richtlijn.pdf",
                        "source_title": "KNGF Richtlijn Heupartrose",
                        "source_kind": "guidelines",
                        "source_path": "physio_library/sources/guidelines/heup-richtlijn.pdf",
                        "page_label": "pagina 12",
                        "embedding": [1.0, 0.0],
                    },
                    {
                        "id": "form-heup",
                        "text": "Een intakeformulier noemt alleen dat er pijn is bij lopen.",
                        "source_name": "rps-heup.docx",
                        "source_title": "RPS intakeformulier",
                        "source_kind": "forms",
                        "source_path": "physio_library/sources/forms/rps-heup.docx",
                        "page_label": "pagina 1",
                        "embedding": [1.0, 0.0],
                    },
                    {
                        "id": "guide-schouder",
                        "text": "Deze schouderrichtlijn gaat over cuffproblematiek.",
                        "source_name": "schouder-richtlijn.pdf",
                        "source_title": "KNGF Richtlijn Schouder",
                        "source_kind": "guidelines",
                        "source_path": "physio_library/sources/guidelines/schouder-richtlijn.pdf",
                        "page_label": "pagina 7",
                        "embedding": [1.0, 0.0],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )
    seen = {}

    def fake_embed_text(text, task_type="RETRIEVAL_QUERY", runtime=None, output_dimensionality=None):
        seen["query_text"] = text
        return [1.0, 0.0]

    monkeypatch.setattr(physio_knowledge, "PHYSIO_LIBRARY_INDEX_PATH", manifest_path)
    monkeypatch.setattr(physio_knowledge, "embed_text", fake_embed_text)
    monkeypatch.setattr(
        ai_provider,
        "generate_with_optional_thinking",
        lambda model, prompt, max_output_tokens=4096, operation_name="", runtime=None: SimpleNamespace(text="## Advies\n- Start met educatie en oefentherapie."),
    )

    response = physio_knowledge.query_knowledge_index(
        "Welke oefentherapie adviseert de richtlijn?",
        body_region="heup",
        context_text="Conservatief beleid en belastingsopbouw.",
        case_context={
            "primary_complaint": "heupartrose met startpijn",
            "notes": "Traplopen en lang wandelen provoceren de klachten.",
        },
        runtime=SimpleNamespace(MODEL_TOOLS="gemini-test"),
    )

    assert "Lichaamsregio: heup" in seen["query_text"]
    assert "primary_complaint: heupartrose met startpijn" in seen["query_text"]
    assert response["retrieved_sources"][0]["source_title"] == "KNGF Richtlijn Heupartrose"
    assert response["retrieved_sources"][0]["source_kind"] == "guidelines"


def test_query_knowledge_index_diversifies_top_hits_across_sources(monkeypatch, tmp_path):
    manifest_path = tmp_path / "manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "meta": {"source_count": 2, "document_count": 4},
                "documents": [
                    {
                        "id": "a-1",
                        "text": "Knierichtlijn hoofdstuk 1 over educatie.",
                        "source_name": "knie-a.pdf",
                        "source_title": "Knierichtlijn A",
                        "source_kind": "guidelines",
                        "source_path": "physio_library/sources/guidelines/knie-a.pdf",
                        "page_label": "pagina 1",
                        "embedding": [1.0, 0.0],
                    },
                    {
                        "id": "a-2",
                        "text": "Knierichtlijn hoofdstuk 2 over dosering.",
                        "source_name": "knie-a.pdf",
                        "source_title": "Knierichtlijn A",
                        "source_kind": "guidelines",
                        "source_path": "physio_library/sources/guidelines/knie-a.pdf",
                        "page_label": "pagina 2",
                        "embedding": [1.0, 0.0],
                    },
                    {
                        "id": "a-3",
                        "text": "Knierichtlijn hoofdstuk 3 over follow-up.",
                        "source_name": "knie-a.pdf",
                        "source_title": "Knierichtlijn A",
                        "source_kind": "guidelines",
                        "source_path": "physio_library/sources/guidelines/knie-a.pdf",
                        "page_label": "pagina 3",
                        "embedding": [1.0, 0.0],
                    },
                    {
                        "id": "b-1",
                        "text": "Andere knierichtlijn noemt oefentherapie en educatie.",
                        "source_name": "knie-b.pdf",
                        "source_title": "Knierichtlijn B",
                        "source_kind": "guidelines",
                        "source_path": "physio_library/sources/guidelines/knie-b.pdf",
                        "page_label": "pagina 4",
                        "embedding": [1.0, 0.0],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(physio_knowledge, "PHYSIO_LIBRARY_INDEX_PATH", manifest_path)
    monkeypatch.setattr(
        physio_knowledge,
        "embed_text",
        lambda text, task_type="RETRIEVAL_QUERY", runtime=None, output_dimensionality=None: [1.0, 0.0],
    )
    monkeypatch.setattr(
        ai_provider,
        "generate_with_optional_thinking",
        lambda model, prompt, max_output_tokens=4096, operation_name="", runtime=None: SimpleNamespace(text="## Advies\n- Vergelijk meerdere richtlijnen."),
    )

    response = physio_knowledge.query_knowledge_index(
        "Wat adviseert de richtlijn bij knieklachten?",
        body_region="knie",
        runtime=SimpleNamespace(MODEL_TOOLS="gemini-test"),
        limit=3,
    )

    top_sources = [item["source_name"] for item in response["retrieved_sources"][:3]]
    assert len(set(top_sources)) >= 2
    assert top_sources.count("knie-a.pdf") <= 2


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
                "meta": {
                    "generated_at": 123.0,
                    "source_count": 1,
                    "document_count": 1,
                    "format": physio_knowledge.SHARDED_INDEX_FORMAT,
                    "document_shards": ["missing.documents-001.json.gz"],
                    "indexed_source_paths": [str(source_path)],
                },
                "documents": [],
                "errors": [],
            }
        ),
        encoding="utf-8",
    )

    status = physio_knowledge.knowledge_index_status(index_path=manifest_path, source_root=source_root)

    assert status["source_count_on_disk"] == 1
    assert status["indexed_source_count"] == 1
    assert status["document_count"] == 1
    assert status["error_count"] == 0
    assert status["stale"] is False


def test_load_knowledge_index_reads_gzip_shards(tmp_path):
    manifest_path = tmp_path / "manifest.json"
    shard_name = "manifest.documents-001.json.gz"
    with gzip.open(tmp_path / shard_name, "wt", encoding="utf-8") as handle:
        json.dump(
            [
                {
                    "id": "doc-1",
                    "text": "Lateralisatie bij CVA.",
                    "source_name": "beroerte.pdf",
                    "source_title": "Beroerte",
                    "embedding": [1.0],
                }
            ],
            handle,
            ensure_ascii=False,
            separators=(",", ":"),
        )
    manifest_path.write_text(
        json.dumps(
            {
                "meta": {
                    "source_count": 1,
                    "document_count": 1,
                    "embedding_dimension": 1,
                    "format": physio_knowledge.SHARDED_INDEX_FORMAT,
                    "document_shards": [shard_name],
                },
                "documents": [],
                "errors": [],
            }
        ),
        encoding="utf-8",
    )

    payload = physio_knowledge.load_knowledge_index(index_path=manifest_path)

    assert payload["meta"]["format"] == physio_knowledge.SHARDED_INDEX_FORMAT
    assert len(payload["documents"]) == 1
    assert payload["documents"][0]["source_title"] == "Beroerte"


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
                        "source_kind": "guidelines",
                        "page_label": "pagina 8",
                        "embedding": [1.0, 0.0],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(physio_knowledge, "PHYSIO_LIBRARY_INDEX_PATH", manifest_path)
    monkeypatch.setattr(
        physio_knowledge,
        "embed_text",
        lambda text, task_type="RETRIEVAL_QUERY", runtime=None, output_dimensionality=None: [1.0, 0.0],
    )
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
    assert body["citations"][0]["source_kind"] == "guidelines"
    assert body["retrieved_sources"][0]["source_name"] == "heup.pdf"
    assert body["retrieved_sources"][0]["source_kind"] == "guidelines"


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
    loaded = physio_knowledge.load_knowledge_index(index_path=index_path)
    assert written["meta"]["source_count"] == 1
    assert written["meta"]["document_count"] >= 1
    assert written["meta"]["embedding_dimension"] == 2
    assert written["meta"]["format"] == physio_knowledge.SHARDED_INDEX_FORMAT
    assert written["meta"]["indexed_source_paths"] == [str(forms_dir / "notes.md")]
    assert written["meta"]["document_shards"]
    assert manifest["documents"][0]["source_kind"] == "forms"
    assert loaded["documents"][0]["embedding"][1] == 1.0
