"""Processing routes exercise real credit admission against synthetic storage."""

from copy import deepcopy
import io
import json
from types import SimpleNamespace

import pytest

from lecture_processor.domains.auth import policy as auth_policy
from tests.credit_test_support import make_credit_runtime


UID = 'unified-route-user'
HEADERS = {'Authorization': 'Bearer synthetic-route-token'}
CASES = [
    ('lecture', 8, {'primary': ('lecture_notes', 1, 8)}),
    ('slides', 2, {'primary': ('slides_extraction', 1, 2)}),
    ('interview', 10, {'primary': ('interview_transcription', 1, 10)}),
    ('interview-extras', 14, {'primary': ('interview_transcription', 1, 10), 'extras': ('interview_extra', 2, 4)}),
    ('extract', 2, {'primary': ('tools_extraction', 1, 2)}),
    ('transcribe', 10, {'primary': ('tools_transcription', 1, 10)}),
    ('voice', 10, {'primary': ('voice_note', 1, 10)}),
    ('regenerate', 2, {'extras': ('regenerate_study_tools', 1, 2)}),
]
BATCH_CASES = [
    ('lecture-notes', 'lecture_notes', 8, 0),
    ('slides-only', 'slides_extraction', 2, 0),
    ('interview', 'interview_transcription', 10, 2),
    ('audio-transcription', 'audio_transcription', 10, 0),
    ('text-combine', 'text_combine', 8, 0),
]


@pytest.fixture
def processing(client, core, monkeypatch, tmp_path):
    user = {
        'uid': UID, 'email': 'student@example.test', 'account_status': 'active',
        'credits_version': 2, 'credits': 100, 'total_processed': 0,
        'lecture_credits_standard': 0, 'lecture_credits_extended': 0, 'slides_credits': 0,
        'interview_credits_short': 0, 'interview_credits_medium': 0, 'interview_credits_long': 0,
        'unlimited_credits': {'lecture': False, 'slides': False, 'interview': False},
    }
    billing_runtime, store = make_credit_runtime(
        users={UID: user},
        documents={('study_packs', 'owned-pack'): {'uid': UID, 'mode': 'voice-note', 'title': 'Synthetic notes', 'notes_markdown': 'Synthetic source'}},
    )
    monkeypatch.setattr(core, 'db', billing_runtime.db)
    monkeypatch.setattr(core.firestore, 'transactional', billing_runtime.firestore.transactional)
    monkeypatch.setattr(core.firestore, 'Increment', billing_runtime.firestore.Increment)
    monkeypatch.setattr(core, 'UNIFIED_CREDITS_ENABLED', True)
    monkeypatch.setattr(core, 'ADMIN_UIDS', set())
    monkeypatch.setattr(core, 'ADMIN_EMAILS', set())
    monkeypatch.setattr(core, 'UPLOAD_FOLDER', str(tmp_path))
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': UID, 'email': user['email'], 'email_verified': True})
    monkeypatch.setattr(auth_policy, 'is_email_allowed', lambda *_args, **_kwargs: True)
    # Audio codecs are outside these admission tests; bytes are confined to tmp_path.
    monkeypatch.setattr(core, 'file_looks_like_audio', lambda _path: True)
    queued = []
    monkeypatch.setattr(core, 'submit_background_job', lambda target, *args, **kwargs: queued.append((target, args, kwargs)))
    monkeypatch.setattr(core, 'submit_batch_background_job', lambda target, *args, **kwargs: queued.append((target, args, kwargs)))
    return SimpleNamespace(client=client, core=core, store=store, queued=queued, tmp_path=tmp_path)


def pdf():
    return io.BytesIO(b'%PDF-1.4\nSynthetic isolated slides'), 'slides.pdf', 'application/pdf'


def audio():
    return io.BytesIO(b'ID3\x03\x00\x00Synthetic isolated audio'), 'audio.mp3', 'audio/mpeg'


def post_action(processing, action):
    if action == 'regenerate':
        return processing.client.post('/api/voice-notes/owned-pack/study-tools', json={'study_features': 'both'}, headers=HEADERS)
    data = {}
    if action in {'lecture', 'slides', 'interview', 'interview-extras'}:
        path = '/upload'
        data = {'mode': {'lecture': 'lecture-notes', 'slides': 'slides-only'}.get(action, 'interview'), 'study_pack_title': 'Synthetic route test'}
        if action in {'lecture', 'slides'}:
            data['pdf'] = pdf()
        if action != 'slides':
            data['audio'] = audio()
        if action == 'interview-extras':
            data['interview_features'] = 'both'
    elif action == 'extract':
        path, data = '/api/tools/extract', {'source_type': 'pdf', 'file': pdf()}
    elif action == 'transcribe':
        path, data = '/api/tools/transcribe', {'audio': audio()}
    elif action == 'voice':
        path, data = '/api/voice-notes', {'audio': audio(), 'title': 'Synthetic voice note'}
    else:
        raise AssertionError(action)
    return processing.client.post(path, data=data, content_type='multipart/form-data', headers=HEADERS)


@pytest.mark.parametrize('enabled', [True, False], ids=['activated', 'stored-v2-flag-off'])
@pytest.mark.parametrize('action,cost,components', CASES, ids=[case[0] for case in CASES])
def test_processing_post_debits_exact_unified_cost_and_persists_receipt(processing, monkeypatch, enabled, action, cost, components):
    monkeypatch.setattr(processing.core, 'UNIFIED_CREDITS_ENABLED', enabled)

    response = post_action(processing, action)

    assert response.status_code in {200, 202}, response.get_json()
    job_id = response.get_json()['job_id']
    job = processing.store.docs(processing.core.RUNTIME_JOBS_COLLECTION)[job_id]
    assert processing.store.docs('users')[UID]['credits'] == 100 - cost
    assert processing.store.docs('users')[UID]['total_processed'] == (0 if action == 'regenerate' else 1)
    assert job['credit_scheme'] == 2 and job['charged_credits'] == cost
    receipt = job['billing_receipt']
    assert receipt['charge_ref'] == job['charge_ref']
    assert receipt['charged_credits'] == cost and receipt['refunded_credits'] == 0
    nonzero_components = {key: item for key, item in receipt['components'].items() if item['units']}
    assert {key: (item['action'], item['units'], item['charged_credits']) for key, item in nonzero_components.items()} == components
    journal = list(processing.store.docs('credit_charges').values())
    assert len(journal) == 1 and journal[0]['charged_credits'] == cost
    assert len(processing.queued) == 1


@pytest.mark.parametrize('action,cost,_components', CASES, ids=[case[0] for case in CASES])
def test_processing_post_reports_scalar_insufficiency_without_admission(processing, action, cost, _components):
    processing.store.documents[('users', UID)]['credits'] = cost - 1
    original = deepcopy(processing.store.documents[('users', UID)])

    response = post_action(processing, action)

    assert response.status_code == 402, response.get_json()
    body = response.get_json()
    assert body['error_code'] == 'insufficient_credits'
    assert body['needed'] == cost and body['available'] == cost - 1
    assert processing.store.docs('users')[UID]['credits'] == original['credits']
    assert processing.store.docs('credit_charges') == {}
    assert processing.store.docs(processing.core.RUNTIME_JOBS_COLLECTION) == {}
    assert processing.queued == []


def post_batch(processing, mode, *, instant, extras=0):
    data = {'mode': mode, 'batch_title': 'Synthetic three-row batch'}
    rows = []
    for index in range(1, 4):
        row = {'row_id': f'row-{index}'}
        if mode in {'lecture-notes', 'slides-only'}:
            data[f'row_{index}_slides'] = pdf()
        if mode in {'lecture-notes', 'interview', 'audio-transcription'}:
            data[f'row_{index}_audio'] = audio()
        if mode == 'text-combine':
            data[f'row_{index}_slide_text'] = (io.BytesIO(b'Synthetic slide text'), f'slides-{index}.txt', 'text/plain')
        if mode == 'interview':
            row['interview_features'] = ['summary', 'sections'][:extras]
        rows.append(row)
    data['rows'] = json.dumps(rows)
    path = '/api/instant-batch/jobs' if instant else '/api/batch/jobs'
    return processing.client.post(path, data=data, content_type='multipart/form-data', headers=HEADERS)


@pytest.mark.parametrize('enabled', [True, False], ids=['activated', 'stored-v2-flag-off'])
@pytest.mark.parametrize('instant', [True, False], ids=['instant', 'overnight'])
@pytest.mark.parametrize('mode,action,primary_cost,extras', BATCH_CASES, ids=[case[0] for case in BATCH_CASES])
def test_batch_posts_debit_each_row_at_its_frozen_strategy_cost(processing, monkeypatch, enabled, instant, mode, action, primary_cost, extras):
    monkeypatch.setattr(processing.core, 'UNIFIED_CREDITS_ENABLED', enabled)
    divisor = 1 if instant else 2
    row_cost = (primary_cost + 2 * extras) // divisor

    response = post_batch(processing, mode, instant=instant, extras=extras)

    assert response.status_code == 200, response.get_json()
    batch_id = response.get_json()['batch_id']
    batch = processing.store.docs('batch_jobs')[batch_id]
    rows = processing.store.docs(f'batch_jobs/{batch_id}/rows')
    assert batch['status'] == 'queued' and batch['credit_admission_state'] == 'admitted'
    assert batch['processing_strategy'] == ('instant' if instant else 'batch')
    assert len(rows) == 3
    assert processing.store.docs('users')[UID]['credits'] == 100 - 3 * row_cost
    assert processing.store.docs('users')[UID]['total_processed'] == 3
    charges = processing.store.docs('credit_charges')
    assert len(charges) == 3
    assert sum(charge['charged_credits'] for charge in charges.values()) == 3 * row_cost
    for row in rows.values():
        assert row['credit_scheme'] == 2 and row['charged_credits'] == row_cost
        receipt = row['billing_receipt']
        assert receipt['charged_credits'] == row_cost and receipt['refunded_credits'] == 0
        assert receipt['components']['primary']['action'] == action
        assert receipt['components']['primary']['charged_credits'] == primary_cost // divisor
        if extras:
            assert receipt['components']['extras']['units'] == extras
            assert receipt['components']['extras']['charged_credits'] == 2 * extras // divisor
    assert len(processing.queued) == 1


@pytest.mark.parametrize('instant,needed', [(True, 42), (False, 21)], ids=['instant', 'overnight'])
def test_batch_preflight_includes_all_rows_and_extras_without_partial_debit(processing, instant, needed):
    processing.store.documents[('users', UID)]['credits'] = needed - 1

    response = post_batch(processing, 'interview', instant=instant, extras=2)

    assert response.status_code == 402, response.get_json()
    body = response.get_json()
    assert body['needed'] == needed and body['available'] == needed - 1
    assert body['error_code'] == 'insufficient_credits'
    assert processing.store.docs('users')[UID]['credits'] == needed - 1
    assert processing.store.docs('credit_charges') == {}
    assert processing.store.docs('batch_jobs') == {}
    assert processing.queued == []
