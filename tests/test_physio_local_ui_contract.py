from pathlib import Path


ROOT = Path(__file__).parents[1]


def test_local_workspace_contains_clinical_lookup_and_case_flow():
    html = (ROOT / "templates/physio_local.html").read_text(encoding="utf-8")

    assert 'data-api-base="/api/local/physio"' in html
    assert 'Zoek klacht, test, structuur, afkorting of Latijnse naam' in html
    assert 'data-region="schouder"' in html
    assert 'data-region="bekken-heup"' in html
    assert 'Diep zoeken met Codex' in html
    assert 'Open in Obsidian' not in html  # generated only after a local note is opened
    assert 'Nieuwe casus' in html
    assert 'id="deep-case-select"' in html
    assert 'id="deep-case-context"' in html
    assert 'data-section="screening"' in html
    assert 'data-query="rode vlaggen screening"' not in html
    assert 'id="clinical-context"' in html
    assert 'id="context-backdrop"' in html


def test_source_manager_replaces_simulation_and_recording_ui():
    html = (ROOT / "templates/physio_local.html").read_text(encoding="utf-8")

    assert 'data-view="sources"' in html
    assert 'id="source-dropzone"' in html
    assert 'id="source-manager-editor"' in html
    assert 'data-view="simulation"' not in html
    assert 'audio/*' not in html
    assert 'identificatiecontrole' not in html
    assert '<option value="active" selected>Actief gebruikt</option>' in html
    assert 'data-source-view-mode="all"' in html
    assert 'data-source-view-mode="region"' in html
    assert 'id="source-region-filter"' in html
    assert 'id="auto-triage-sources"' in html


def test_local_workspace_has_no_remote_frontend_dependencies():
    html = (ROOT / "templates/physio_local.html").read_text(encoding="utf-8")

    assert "https://" not in html
    assert "http://" not in html
    assert "/static/js/physio-local.js" in html


