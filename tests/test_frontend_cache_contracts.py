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


def test_service_worker_refreshes_static_assets_before_cache_fallback():
    service_worker = _read('static/service-worker.js')

    assert "const VOICE_CACHE = 'lecture-processor-voice-v7';" in service_worker
    assert "fetch(new Request(request, { cache: 'no-cache' }))" in service_worker
    assert ".catch(() => caches.match(request))" in service_worker
    assert 'cached || fetch(request)' not in service_worker


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
