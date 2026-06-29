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


def test_service_worker_fetches_fresh_static_assets_before_cache_fallback():
    service_worker = _read('static/service-worker.js')

    assert "const VOICE_CACHE = 'lecture-processor-voice-v9';" in service_worker
    assert "fetch(new Request(request, { cache: 'no-cache' }))" in service_worker
    assert "caches.open(VOICE_CACHE).then((cache) => cache.put(request, copy));" in service_worker
    assert ".catch(() => caches.match(request))" in service_worker


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


def test_voice_notes_local_storage_is_user_scoped_and_cleared_on_signout():
    voice_notes_js = _read('static/js/voice-notes.js')
    app_shell_js = _read('static/js/app-shell.js')
    index_js = _read('static/js/index-app.js')

    assert 'var DB_VERSION = 2;' in voice_notes_js
    assert "notesStore.createIndex('owner_key', 'owner_key', { unique: false })" in voice_notes_js
    assert "return state.user && state.user.uid ? ('user:' + String(state.user.uid)) : 'anon';" in voice_notes_js
    assert "filter(noteBelongsToCurrentOwner)" in voice_notes_js
    assert "store.put({ id: id, owner_key: currentOwnerKey()" in voice_notes_js
    assert "indexedDB.deleteDatabase('lecture-processor-voice-notes')" in app_shell_js
    assert "indexedDB.deleteDatabase('lecture-processor-voice-notes')" in index_js
