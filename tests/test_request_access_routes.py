"""Public HTTP contracts for authenticated service admission."""
import pytest


@pytest.mark.parametrize(('method', 'path'), [
    ('get', '/api/purchase-history'),
    ('post', '/api/create-checkout-session'),
    ('get', '/api/confirm-checkout-session'),
    ('get', '/api/study-packs'),
    ('get', '/status/synthetic-job'),
    ('post', '/upload'),
    ('post', '/api/import-audio-url'),
    ('get', '/api/import-audio-url/synthetic-job'),
    ('post', '/api/import-audio-url/download'),
    ('post', '/api/import-audio-url/release'),
    ('post', '/api/tools/lecture-download'),
    ('get', '/api/tools/lecture-download/synthetic-job'),
    ('get', '/api/tools/lecture-download/synthetic-job/file'),
    ('get', '/api/voice-notes/jobs/synthetic-job'),
    ('get', '/api/batch/jobs/synthetic-batch'),
])
def test_unverified_identity_receives_verification_guidance(client, core, monkeypatch, method, path):
    def unverified(req):
        req.environ['lecture_processor.auth_error'] = 'email_not_verified'
        return None

    monkeypatch.setattr(core, 'verify_firebase_token', unverified)
    response = getattr(client, method)(path)
    assert response.status_code == 403
    assert response.json['error_code'] == 'email_not_verified'


def test_write_checks_membership_before_account_state(client, core, monkeypatch):
    from lecture_processor.domains.account import lifecycle

    user = {'uid': 'study-owner', 'email': 'learner@example.test', 'email_verified': True}
    monkeypatch.setattr(core, 'verify_firebase_token', lambda req: user)
    monkeypatch.setattr(core, 'is_email_allowed', lambda email: False)
    checks = []
    def deletion_status(uid, *, runtime):
        checks.append(uid)
        return False, 'Account deletion in progress.'

    monkeypatch.setattr(lifecycle, 'ensure_account_allows_writes', deletion_status)
    assert client.post('/api/study-packs', json={}).status_code == 403
    assert checks == []
    monkeypatch.setattr(core, 'is_email_allowed', lambda email: True)
    blocked = client.post('/api/study-packs', json={})
    assert blocked.status_code == 409
    assert blocked.json['status'] == 'account_deletion_in_progress'
    assert checks == ['study-owner']


def test_existing_audio_import_remains_available_to_its_verified_owner(client, core, monkeypatch, tmp_path):
    from lecture_processor.domains.upload import import_audio
    from lecture_processor.services import upload_audio_import_service as imports

    uid = 'former-student'
    monkeypatch.setattr(core, 'verify_firebase_token', lambda req: {'uid': uid, 'email': 'owner@example.test'})
    monkeypatch.setattr(core, 'is_email_allowed', lambda email: False)
    monkeypatch.setattr(core, 'AUDIO_IMPORT_JOBS', {})
    monkeypatch.setattr(core, 'AUDIO_IMPORT_TOKENS', {})
    source = tmp_path / 'fixture.mp3'
    source.write_bytes(b'synthetic audio')
    token = import_audio.register_audio_import_token(uid, source, runtime=core)
    imports._set_audio_import_job(core, 'existing', uid=uid, status='complete')
    base = '/api/import-audio-url'
    payload = {'audio_import_token': token}
    assert client.get(base + '/existing').status_code == 200
    assert client.post(base + '/download', json=payload).data == b'synthetic audio'
    assert client.post(base + '/release', json=payload).json == {'ok': True}
    assert client.post(base + '/download', json=payload).status_code == 404
