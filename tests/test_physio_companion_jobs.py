import json
import threading
import time
from pathlib import Path

from lecture_processor.physio_companion.config import CompanionConfig
from lecture_processor.physio_companion.jobs import ANSWER_SCHEMA, CodexJobManager


class MockProcess:
    def __init__(self, argv, **kwargs):
        self.argv = argv
        self.kwargs = kwargs
        self.returncode = 0
        self.input = None
        self.terminated = False

    def communicate(self, input=None, timeout=None):
        self.input = input
        output_path = Path(self.argv[self.argv.index("--output-last-message") + 1])
        output_path.write_text(
            json.dumps(
                {
                    "direct_answer": "Antwoord uit de bron",
                    "clinical_application": "Pas toe tijdens onderzoek.",
                    "conditions_exceptions": [],
                    "citations": [{"note_id": "shoulder", "anchor": "onderzoek"}],
                }
            ),
            encoding="utf-8",
        )
        return "", ""

    def terminate(self):
        self.terminated = True

    def kill(self):
        self.terminated = True


def wait_for_job(manager, job_id):
    deadline = time.monotonic() + 3
    while time.monotonic() < deadline:
        job = manager.get(job_id)
        if job["status"] in {"completed", "failed", "cancelled"}:
            return job
        time.sleep(0.01)
    raise AssertionError("job did not finish")


def test_codex_job_uses_safe_argv_stdin_schema_and_reviewed_context(tmp_path):
    processes = []

    def factory(argv, **kwargs):
        process = MockProcess(argv, **kwargs)
        processes.append(process)
        return process

    config = CompanionConfig(
        vault_path=tmp_path / "vault",
        app_support_path=tmp_path / "support",
        codex_binary="codex-test",
    )
    config.ensure_directories()
    manager = CodexJobManager(
        config,
        context_provider=lambda ids, limit: [{"note_id": "shoulder", "body": "gereviewd", "allowed_anchors": ["onderzoek"]}],
        case_provider=lambda case_id: {"case": {"title": "K01", "notes": "Traplopen provoceert"}} if case_id == "case-1" else None,
        popen_factory=factory,
    )
    submitted = manager.submit_deep_query(
        "Wat zegt de bron?",
        ["shoulder", "draft"],
        case_context="Kniepijn bij traplopen",
        case_id="case-1",
    )
    completed = wait_for_job(manager, submitted["job_id"])

    assert completed["status"] == "completed"
    assert completed["result"]["direct_answer"] == "Antwoord uit de bron"
    process = processes[0]
    assert process.argv[:5] == ["codex-test", "exec", "--sandbox", "read-only", "--ephemeral"]
    assert "--output-schema" in process.argv
    assert process.argv[-1] == "-"
    assert "Wat zegt de bron?" not in process.argv
    assert "Wat zegt de bron?" in process.input
    assert "Kniepijn bij traplopen" in process.input
    assert "door de gebruiker beoordeeld" in process.input
    assert process.kwargs["cwd"] != config.vault_path
    assert process.kwargs["cwd"].parent == config.runtime_path
    assert "--ignore-user-config" in process.argv
    assert "--ignore-rules" in process.argv
    disabled_features = {
        process.argv[index + 1]
        for index, value in enumerate(process.argv[:-1])
        if value == "--disable"
    }
    assert {"shell_tool", "unified_exec", "apps", "multi_agent", "hooks", "memories", "remote_plugin"} <= disabled_features
    assert 'approval_policy="never"' in process.argv
    assert 'web_search="disabled"' in process.argv
    assert 'shell_environment_policy.inherit="none"' in process.argv
    assert not process.kwargs["cwd"].exists()
    assert not list(config.runtime_path.iterdir())
    manager.shutdown()


def test_deep_query_uses_selected_local_case_when_no_pasted_context(tmp_path):
    processes = []

    def factory(argv, **kwargs):
        process = MockProcess(argv, **kwargs)
        processes.append(process)
        return process

    config = CompanionConfig(vault_path=tmp_path / "vault", app_support_path=tmp_path / "support")
    config.ensure_directories()
    manager = CodexJobManager(
        config,
        context_provider=lambda ids, limit: [{"note_id": "shoulder", "body": "bron", "allowed_anchors": ["onderzoek"]}],
        case_provider=lambda case_id: {"case": {"title": "S01", "notes": "Pijn bij reiken"}} if case_id == "case-1" else None,
        popen_factory=factory,
    )

    submitted = manager.submit_deep_query("Welke hypothese past?", ["shoulder"], case_id="case-1")
    completed = wait_for_job(manager, submitted["job_id"])

    assert completed["status"] == "completed"
    assert "Pijn bij reiken" in processes[0].input
    manager.shutdown()


def test_deep_query_combines_ranked_source_passages_with_selected_notes(tmp_path):
    processes = []

    def factory(argv, **kwargs):
        process = MockProcess(argv, **kwargs)
        processes.append(process)
        return process

    config = CompanionConfig(vault_path=tmp_path / "vault", app_support_path=tmp_path / "support")
    config.ensure_directories()
    manager = CodexJobManager(
        config,
        context_provider=lambda ids, limit: [{"note_id": "shoulder", "body": "notitie", "allowed_anchors": ["onderzoek"]}],
        source_context_provider=lambda query, region, limit: [{
            "note_id": "source--pain", "title": "Pijncolleges", "body": "Na transductie volgt conductie.",
            "allowed_anchors": ["conductie"],
        }],
        case_provider=lambda case_id: None,
        popen_factory=factory,
    )

    submitted = manager.submit_deep_query("Wat volgt na transductie?", ["shoulder"], region="pijn")
    wait_for_job(manager, submitted["job_id"])

    assert "Na transductie volgt conductie" in processes[0].input
    assert '"note_id": "shoulder"' in processes[0].input
    manager.shutdown()


def test_citations_are_normalized_and_must_resolve_to_selected_context():
    result = {
        "direct_answer": "Antwoord",
        "clinical_application": "Toepassing",
        "conditions_exceptions": [],
        "citations": [{"note_id": "shoulder", "anchor": "#onderzoek"}],
    }
    CodexJobManager._validate_result(
        result,
        ANSWER_SCHEMA,
        allowed_citations={"shoulder": {"onderzoek"}},
    )
    assert result["citations"][0]["anchor"] == "onderzoek"


def test_citations_reject_unknown_notes_empty_anchors_and_empty_context():
    invalid_cases = [
        ({"other": {"onderzoek"}}, {"note_id": "shoulder", "anchor": "onderzoek"}),
        ({"shoulder": {"onderzoek"}}, {"note_id": "shoulder", "anchor": ""}),
        ({}, {"note_id": "shoulder", "anchor": "onderzoek"}),
    ]
    for allowed, citation in invalid_cases:
        result = {
            "direct_answer": "Antwoord",
            "clinical_application": "Toepassing",
            "conditions_exceptions": [],
            "citations": [citation],
        }
        try:
            CodexJobManager._validate_result(result, ANSWER_SCHEMA, allowed_citations=allowed)
        except ValueError as error:
            assert "allowed note heading" in str(error)
        else:
            raise AssertionError("invalid citation was accepted")


def test_supported_clinical_answer_requires_a_citation():
    result = {
        "direct_answer": "Antwoord",
        "clinical_application": "Toepassing",
        "conditions_exceptions": [],
        "citations": [],
    }

    try:
        CodexJobManager._validate_result(result, ANSWER_SCHEMA, allowed_citations={})
    except ValueError as error:
        assert "require at least one citation" in str(error)
    else:
        raise AssertionError("uncited clinical answer was accepted")


class MalformedProcess(MockProcess):
    def communicate(self, input=None, timeout=None):
        output_path = Path(self.argv[self.argv.index("--output-last-message") + 1])
        output_path.write_text('{"direct_answer":"zonder contract"}', encoding="utf-8")
        return "", ""


def test_malformed_codex_output_fails_closed(tmp_path):
    config = CompanionConfig(vault_path=tmp_path / "v", app_support_path=tmp_path / "s")
    config.ensure_directories()
    manager = CodexJobManager(
        config,
        context_provider=lambda ids, limit: [],
        case_provider=lambda case_id: None,
        popen_factory=lambda argv, **kwargs: MalformedProcess(argv, **kwargs),
    )

    submitted = manager.submit_deep_query("Testvraag", [])
    completed = wait_for_job(manager, submitted["job_id"])

    assert completed["status"] == "failed"
    assert "required fields" in completed["error"]
    manager.shutdown()


class BlockingProcess(MockProcess):
    def communicate(self, input=None, timeout=None):
        self.input = input
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline and not self.terminated:
            time.sleep(0.01)
        return "", ""


def test_running_codex_job_can_be_cancelled(tmp_path):
    started = threading.Event()

    def factory(argv, **kwargs):
        started.set()
        return BlockingProcess(argv, **kwargs)

    config = CompanionConfig(vault_path=tmp_path / "vault", app_support_path=tmp_path / "support")
    config.ensure_directories()
    manager = CodexJobManager(
        config,
        context_provider=lambda ids, limit: [],
        case_provider=lambda case_id: None,
        popen_factory=factory,
    )
    submitted = manager.submit_deep_query("Stop deze taak", [])
    assert started.wait(1)

    cancelling = manager.cancel(submitted["job_id"])
    completed = wait_for_job(manager, submitted["job_id"])

    assert cancelling["status"] in {"running", "cancelling", "cancelled"}
    assert completed["status"] == "cancelled"
    manager.shutdown()
