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


def test_local_workspace_uses_visible_detail_drawer_and_styled_controls():
    javascript = (ROOT / "static/js/physio-local.js").read_text(encoding="utf-8")
    css = (ROOT / "static/css/physio-local.css").read_text(encoding="utf-8")

    assert "function enhanceSelect" in javascript
    assert "q: state.region" in javascript
    assert "openContextPanel();" in javascript
    assert "function applySearchHighlights" in javascript
    assert "function renderSourcePreview" in javascript
    assert "reader-table-wrap" in javascript
    assert '.pretty-select-menu' in css
    assert 'input[type="checkbox"]' in css
    assert '.source-preview' in css
    assert '.search-highlight' in css
    assert '.reader-body table' in css
    assert '.clinical-context.is-open' in css
    assert '.clinical-context { display: none;' not in css
