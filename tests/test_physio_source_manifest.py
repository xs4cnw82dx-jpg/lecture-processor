from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts/build_physio_source_manifest.py"
SPEC = importlib.util.spec_from_file_location("build_physio_source_manifest", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


def test_manifest_uses_hashes_and_exact_duplicate_links(tmp_path):
    source = tmp_path / "KNGF"
    source.mkdir()
    (source / "a.pdf").write_bytes(b"same")
    (source / "b.pdf").write_bytes(b"same")
    output = tmp_path / "manifest.jsonl"

    summary = MODULE.write_manifest(MODULE.iter_records([MODULE.RootSpec("guideline", 500, source)]), output)
    rows = [json.loads(line) for line in output.read_text().splitlines()]

    assert summary == {"records": 2, "duplicates": 1, "review_required": 0}
    assert rows[0]["source_id"] == rows[1]["duplicate_of"]
    assert rows[0]["copyright_class"] == "publisher-restricted"


def test_manifest_marks_sensitive_text_for_review(tmp_path):
    source = tmp_path / "Craft"
    source.mkdir()
    (source / "stage feedback.md").write_text("Mail mij via iemand@example.nl", encoding="utf-8")

    rows = list(MODULE.iter_records([MODULE.RootSpec("craft-note", 200, source)]))

    assert rows[0].privacy_class == "review-required"
    assert rows[0].extraction_status == "review-required"


def test_json_manifest_is_directly_usable_by_local_media_registry(tmp_path):
    source = tmp_path / "Books"
    source.mkdir()
    (source / "atlas.pdf").write_bytes(b"pdf")
    output = tmp_path / "manifest.json"

    MODULE.write_manifest(MODULE.iter_records([MODULE.RootSpec("textbook", 400, source)]), output)
    payload = json.loads(output.read_text(encoding="utf-8"))

    assert payload["schema_version"] == 1
    assert payload["sources"][0]["id"].startswith("src-")
    assert payload["sources"][0]["local_path"].endswith("atlas.pdf")
