"""Post-admission failures through real routes and the synthetic credit ledger."""

from copy import deepcopy
import io
from types import SimpleNamespace

import pytest

from lecture_processor.domains.account import lifecycle
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.billing import ledger
from lecture_processor.domains.runtime_jobs import recovery
from lecture_processor.domains.upload import import_audio
from tests.credit_test_support import make_credit_runtime


@pytest.fixture(params=[1, 2], ids=['legacy', 'unified'])
def admitted_route(request, client, core, monkeypatch, tmp_path):
    user = {'uid': 'owner', 'email': 'owner@example.test', 'account_status': 'active', 'total_processed': 0,
            'lecture_credits_standard': 5, 'lecture_credits_extended': 0, 'slides_credits': 5,
            'interview_credits_short': 5, 'interview_credits_medium': 0, 'interview_credits_long': 0}
    if request.param == 2:
        user.update(credits_version=2, credits=100)
    runtime, state = make_credit_runtime(users={'owner': user}, unified_enabled=False)
    monkeypatch.setattr(core, 'db', runtime.db)
    monkeypatch.setattr(core.firestore, 'transactional', runtime.firestore.transactional)
    monkeypatch.setattr(core.firestore, 'Increment', runtime.firestore.Increment)
    monkeypatch.setattr(core, 'UNIFIED_CREDITS_ENABLED', False)
    monkeypatch.setattr(core, 'UPLOAD_FOLDER', str(tmp_path))
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(core, 'ADMIN_UIDS', set())
    monkeypatch.setattr(core, 'ADMIN_EMAILS', set())
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': 'owner', 'email': user['email'], 'email_verified': True})
    monkeypatch.setattr(auth_policy, 'is_email_allowed', lambda *_args, **_kwargs: True)
    monkeypatch.setattr(core, 'file_looks_like_audio', lambda _path: True)
    queued = []
    monkeypatch.setattr(core, 'submit_background_job', lambda *args, **kwargs: queued.append((args, kwargs)))
    monkeypatch.setattr(core, 'save_job_log', lambda *_args, **_kwargs: None)
    return SimpleNamespace(client=client, runtime=core, state=state, user=user, scheme=request.param,
                           queued=queued, tmp_path=tmp_path)


@pytest.mark.parametrize('mode', ['lecture-notes', 'interview'])
@pytest.mark.parametrize('refund_fails', ['none', 'both', 'primary', 'extras'])
def test_import_token_failure_closes_paid_admission_and_preserves_refund_retry(admitted_route, monkeypatch, mode, refund_fails):
    fixture = admitted_route
    audio = fixture.tmp_path / 'synthetic-import.mp3'
    audio.write_bytes(b'ID3 synthetic import')
    token = import_audio.register_audio_import_token('owner', str(audio), runtime=fixture.runtime)
    original_lookup = import_audio.get_audio_import_token_path

    def lookup(uid, value, *, consume=False, runtime=None):
        if consume:
            return None, 'Imported audio is no longer available. Please import it again.'
        return original_lookup(uid, value, consume=consume, runtime=runtime)

    def fail_refund(operations):
        if any(ref.path[0] == 'credit_refunds' and (
            refund_fails == 'both' or refund_fails in payload.get('component_targets', {})
        ) for _operation, ref, payload, _merge in operations):
            raise RuntimeError('Synthetic refund persistence failure')

    monkeypatch.setattr(import_audio, 'get_audio_import_token_path', lookup)
    if refund_fails != 'none':
        fixture.state.before_commit = fail_refund
    data = {'mode': mode, 'audio_import_token': token, 'study_pack_title': 'Synthetic admission'}
    if mode == 'lecture-notes':
        data['pdf'] = (io.BytesIO(b'%PDF-1.7 synthetic slides'), 'slides.pdf', 'application/pdf')
    else:
        data['interview_features'] = 'both'
    try:
        response = fixture.client.post('/upload', data=data, content_type='multipart/form-data',
                                       headers={'Authorization': 'Bearer synthetic-token'})
        assert response.status_code == 400, response.get_json()
        jobs = fixture.state.docs(fixture.runtime.RUNTIME_JOBS_COLLECTION)
        assert len(jobs) == 1
        job_id, job = next(iter(jobs.items()))
        assert job['status'] == 'error'
        assert job['finished_at'] > 0
        primary_pending = refund_fails in {'both', 'primary'}
        extras_pending = mode == 'interview' and refund_fails in {'both', 'extras'}
        assert job['credit_refunded'] is (not primary_pending or (mode == 'interview' and not extras_pending))
        assert bool(job.get('credit_refund_pending')) is primary_pending
        assert int(job.get('extra_slides_refund_pending', 0)) == (2 if extras_pending else 0)
        assert lifecycle.count_active_jobs_for_user('owner', runtime=fixture.runtime) == 0
        assert fixture.queued == []
        fixture.state.before_commit = None
        if primary_pending or extras_pending:
            current = fixture.state.documents[(fixture.runtime.RUNTIME_JOBS_COLLECTION, job_id)]
            current.update(last_heartbeat_at=1, updated_at=1)
            assert recovery.recover_stale_runtime_jobs(runtime=fixture.runtime) == 1
        settled = deepcopy(fixture.state.docs('users')['owner'])
        balance = 'credits' if fixture.scheme == 2 else 'lecture_credits_standard'
        assert settled[balance] == fixture.user[balance]
        assert settled['slides_credits'] == fixture.user['slides_credits']
        assert settled['interview_credits_short'] == fixture.user['interview_credits_short']
        assert recovery.recover_stale_runtime_jobs(runtime=fixture.runtime) == 0
        assert fixture.state.docs('users')['owner'] == settled
    finally:
        import_audio.release_audio_import_token('owner', token, runtime=fixture.runtime)


def test_account_unavailable_during_coding_charge_uses_account_response(admitted_route, monkeypatch):
    fixture = admitted_route
    fixture.state.documents[('study_packs', 'pack')] = {
        'uid': 'owner', 'mode': 'interview', 'title': 'Synthetic interview', 'transcript': 'Synthetic transcript',
    }
    original = ledger.read_charge_context

    def read_after_account_change(*args, **kwargs):
        fixture.state.documents[('users', 'owner')]['account_status'] = 'deleting'
        return original(*args, **kwargs)

    monkeypatch.setattr(ledger, 'read_charge_context', read_after_account_change)
    response = fixture.client.post('/api/interview-coding/packs/pack/ai-runs', json={},
                                   headers={'Authorization': 'Bearer synthetic-token'})
    assert response.status_code == 409, response.get_json()
    assert response.get_json() == {'error': 'This account is unavailable.', 'error_code': 'account_unavailable'}
    assert fixture.state.docs('credit_charges') == {}
    assert fixture.state.docs('interview_ai_coding_runs') == {}
    assert fixture.state.docs(fixture.runtime.RUNTIME_JOBS_COLLECTION) == {}
    assert fixture.queued == []
