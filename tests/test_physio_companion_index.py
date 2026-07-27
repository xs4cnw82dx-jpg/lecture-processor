import json
from pathlib import Path

from lecture_processor.physio_companion.index import KnowledgeIndex
from lecture_processor.physio_companion.markdown import parse_note


REVIEWED_NOTE = """---
id: schouder-subacromiaal
type: condition
regions: [Schouder]
aliases:
  - SSP
  - subacromial pain syndrome
clinical_use: [differentiaaldiagnostiek, behandeling]
curation_status: reviewed
trust_tier: current_guideline
---
# Subacromiaal pijnsyndroom

Klinisch beeld van pijn rond de schouder.

## Onderzoek

Combineer bevindingen uit anamnese en lichamelijk onderzoek. Zie [[Scapula]].
"""


DRAFT_NOTE = """---
id: experimentele-test
type: test
regions: [Schouder]
aliases: [Geheime test]
curation_status: draft
trust_tier: personal_note
---
# Experimentele test

Nog niet gereviewd.
"""


def test_obsidian_parser_extracts_atomic_properties_headings_and_links(tmp_path):
    vault = tmp_path / "vault"
    path = vault / "10 Aandoeningen" / "SSP.md"
    path.parent.mkdir(parents=True)
    path.write_text(REVIEWED_NOTE, encoding="utf-8")

    note = parse_note(path, vault)

    assert note.note_id == "schouder-subacromiaal"
    assert note.aliases == ["SSP", "subacromial pain syndrome"]
    assert note.regions == ["Schouder"]
    assert note.reviewed is True
    assert note.source_rank == 5
    assert [heading.anchor for heading in note.headings] == ["subacromiaal-pijnsyndroom", "onderzoek"]
    assert note.links == ["Scapula"]


def test_incremental_fts_defaults_to_reviewed_and_ranks_alias(tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "SSP.md").write_text(REVIEWED_NOTE, encoding="utf-8")
    (vault / "Draft.md").write_text(DRAFT_NOTE, encoding="utf-8")
    index = KnowledgeIndex(vault, tmp_path / "index.sqlite3")

    first = index.refresh()
    second = index.refresh()

    assert first == {"added": 2, "updated": 0, "unchanged": 0, "deleted": 0, "errors": 0, "total": 2}
    assert second["unchanged"] == 2
    results = index.search("SSP")
    assert results[0]["note_id"] == "schouder-subacromiaal"
    assert results[0]["reviewed"] is True
    assert index.search("Geheime test") == []
    assert index.search("Geheime test", include_unreviewed=True)[0]["note_id"] == "experimentele-test"
    assert index.list_regions() == [{"name": "Schouder", "slug": "schouder", "count": 1}]


def test_graph_resolves_aliases_but_excludes_drafts(tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "SSP.md").write_text(REVIEWED_NOTE, encoding="utf-8")
    (vault / "Scapula.md").write_text(
        """---
id: scapula
type: structure
regions: [Schouder]
aliases: [Schouderblad]
curation_status: reviewed
---
# Scapula
Botstructuur. [[Geheime test]]
""",
        encoding="utf-8",
    )
    (vault / "Draft.md").write_text(DRAFT_NOTE, encoding="utf-8")
    index = KnowledgeIndex(vault, tmp_path / "index.sqlite3")
    index.refresh()

    graph = index.graph(note_id="schouder-subacromiaal")

    assert {node["id"] for node in graph["nodes"]} == {"schouder-subacromiaal", "scapula"}
    assert graph["edges"] == [{"source": "schouder-subacromiaal", "target": "scapula"}]
    assert index.get_note("experimentele-test") is None
    assert index.get_note("experimentele-test", include_unreviewed=True)["reviewed"] is False


def test_region_navigation_uses_canonical_portals_instead_of_source_metadata(tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "Schouder.md").write_text(
        """---
id: region-shoulder
type: region
regions: [schouder]
aliases: [Shoulder]
curation_status: reviewed
---
# Schouder
Portaal.
""",
        encoding="utf-8",
    )
    (vault / "Brede bron.md").write_text(
        """---
id: broad-source
type: source
regions: [schouder, cervicaal, hand]
aliases: []
curation_status: reviewed
---
# Brede bron
Metadata.
""",
        encoding="utf-8",
    )
    index = KnowledgeIndex(vault, tmp_path / "index.sqlite3")
    index.refresh()

    assert index.list_regions() == [{"name": "Schouder", "slug": "schouder", "count": 2}]


def test_refresh_removes_deleted_note(tmp_path):
    vault = tmp_path / "vault"
    vault.mkdir()
    note_path = vault / "SSP.md"
    note_path.write_text(REVIEWED_NOTE, encoding="utf-8")
    index = KnowledgeIndex(vault, tmp_path / "index.sqlite3")
    index.refresh()
    note_path.unlink()

    result = index.refresh()

    assert result["deleted"] == 1
    assert index.stats()["notes"] == 0
