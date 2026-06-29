from pathlib import Path


def _read(path):
    return Path(path).read_text(encoding='utf-8')


def test_admin_auth_observer_survives_cached_bootstrap_helper():
    admin_js = _read('static/js/admin.js')

    assert 'function onAdminAuthStateReady(callback)' in admin_js
    assert "typeof bootstrap.onAuthStateReady === 'function'" in admin_js
    assert 'auth.onAuthStateChanged(callback' in admin_js
    assert 'onAdminAuthStateReady(async (user) => {' in admin_js
    assert 'bootstrap.onAuthStateReady(auth, async (user) => {' not in admin_js


def test_service_worker_serves_cached_static_assets_while_refreshing():
    service_worker = _read('static/service-worker.js')

    assert "const VOICE_CACHE = 'lecture-processor-voice-v8';" in service_worker
    assert "caches.match(request).then((cached) => {" in service_worker
    assert "const refresh = fetch(request)" in service_worker
    assert ".catch(() => cached);" in service_worker
    assert "return cached || refresh;" in service_worker


def test_service_worker_precaches_one_voice_notes_script_variant():
    service_worker = _read('static/service-worker.js')

    assert "'/static/js/voice-notes.min.js'" in service_worker
    assert "'/static/js/voice-notes.js'" not in service_worker
    assert "'/static/js/voice-notes-utils.min.js'" in service_worker
    assert "'/static/js/voice-notes-utils.js'" not in service_worker
    assert "'/static/js/study-api-utils.min.js'" in service_worker


def test_voice_notes_template_uses_resolved_study_api_asset():
    voice_template = _read('templates/voice_notes.html')

    assert "filename=study_api_js_asset or 'js/study-api-utils.js'" in voice_template


def test_voice_notes_service_worker_is_limited_to_voice_notes_scope():
    voice_notes_js = _read('static/js/voice-notes.js')
    pages_py = _read('lecture_processor/web/pages.py')

    assert "navigator.serviceWorker.register('/service-worker.js', { scope: '/voice-notes' })" in voice_notes_js
    assert "response.headers['Service-Worker-Allowed'] = '/voice-notes'" in pages_py
