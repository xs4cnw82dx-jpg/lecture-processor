from pathlib import Path


def _read(path):
    return Path(path).read_text(encoding='utf-8')


def test_voice_notes_template_uses_resolved_study_api_asset():
    voice_template = _read('templates/voice_notes.html')

    assert "filename=study_api_js_asset or 'js/study-api-utils.js'" in voice_template


def test_voice_notes_service_worker_scope_is_limited_to_voice_notes(client):
    response = client.get('/service-worker.js')

    assert response.status_code == 200
    assert response.headers['Service-Worker-Allowed'] == '/voice-notes'
