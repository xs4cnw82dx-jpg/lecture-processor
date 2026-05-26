import io
import json
import os
import zipfile

import pytest

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.domains.ai import instant_batch_orchestrator
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.rate_limit import quotas as rate_limit_quotas
from lecture_processor.domains.study import export as study_export
from lecture_processor.domains.upload import import_audio as upload_import_audio
from lecture_processor.runtime.job_dispatcher import JobQueueFullError
from tests.runtime_test_support import get_test_core

core = get_test_core()

pytestmark = pytest.mark.usefixtures('disable_sentry')


class _DummyThread:
    def __init__(self, target=None, args=None, kwargs=None):
        self.target = target
        self.args = args or ()
        self.kwargs = kwargs or {}
        self.started = False

    def start(self):
        self.started = True


class _Capture:
    def __init__(self):
        self.batch_payload = None
        self.rows = None


class _SimpleDocx:
    def __init__(self, content=''):
        self.content = content

    def save(self, target):
        target.write(str(self.content).encode('utf-8'))


class _FakeProviderFile:
    def __init__(self, label='provider-file'):
        self.label = label


def _patch_batch_auth(monkeypatch):
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': 'u-batch', 'email': 'batch@example.com'})
    monkeypatch.setattr(auth_policy, 'is_email_allowed', lambda _email, runtime=None: True)


def _clear_batch_memory():
    jobs = getattr(core, '_BATCH_JOBS_MEMORY', None)
    rows = getattr(core, '_BATCH_ROWS_MEMORY', None)
    fetch_targets = getattr(core, '_BATCH_AUDIO_FETCH_TARGETS', None)
    if isinstance(jobs, dict):
        jobs.clear()
    if isinstance(rows, dict):
        rows.clear()
    if isinstance(fetch_targets, dict):
        fetch_targets.clear()


def _patch_batch_refunds(monkeypatch):
    monkeypatch.setattr(core, 'db', None)
    monkeypatch.setattr(billing_credits, 'refund_credit', lambda *_args, **_kwargs: True)
    monkeypatch.setattr(billing_credits, 'refund_slides_credits', lambda *_args, **_kwargs: True)
    monkeypatch.setattr(billing_receipts, 'add_job_credit_refund', lambda *args, **kwargs: None)
    monkeypatch.setattr(core, 'save_job_log', lambda *args, **kwargs: None)
    monkeypatch.setattr(batch_orchestrator, 'send_batch_completion_email', lambda *args, **kwargs: ('skipped', 'disabled in test'))


def _patch_batch_quota_guards(monkeypatch, *, reserve_daily=(True, 0)):
    monkeypatch.setattr(account_lifecycle, 'count_active_jobs_for_user', lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, 'check_rate_limit', lambda **_kwargs: (True, 0))
    monkeypatch.setattr(rate_limit_quotas, 'has_sufficient_upload_disk_space', lambda _bytes=0, runtime=None: (True, 10_000_000_000, 0))
    monkeypatch.setattr(rate_limit_quotas, 'reserve_daily_upload_bytes', lambda _uid, _bytes, runtime=None: reserve_daily)
    monkeypatch.setattr(rate_limit_quotas, 'release_daily_upload_bytes', lambda _uid, _bytes, runtime=None: True)


def test_batch_create_requires_minimum_two_rows(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    monkeypatch.setattr(core, 'client', None)

    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'slides-only',
            'rows': json.dumps([{'row_id': 'row-1'}]),
        },
        content_type='multipart/form-data',
    )

    assert response.status_code == 400
    body = response.get_json()
    assert 'at least 2 rows' in str(body.get('error', '')).lower()


def test_batch_create_requires_batch_title(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    monkeypatch.setattr(core, 'client', None)
    monkeypatch.setattr(upload_import_audio, 'cleanup_expired_audio_import_tokens', lambda runtime=None: None)
    monkeypatch.setattr(core, 'threading', type('T', (), {'Thread': _DummyThread}))
    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
            'slides_credits': 2,
            'preferred_output_language': 'english',
            'preferred_output_language_custom': '',
        },
    )
    monkeypatch.setattr(core, 'resolve_uploaded_slides_to_pdf', lambda uploaded_file, _job_id: ('test-slides.pdf', None))
    monkeypatch.setattr(billing_credits, 'deduct_credit', lambda uid, credit_type, runtime=None: 'slides_credits')
    monkeypatch.setattr(batch_orchestrator, 'create_batch_job', lambda batch_payload, rows, runtime=None: None)
    monkeypatch.setattr(batch_orchestrator, 'process_batch_job', lambda _batch_id, runtime=None: None)

    rows = [
        {'row_id': 'row-1', 'slides_file_field': 'row_1_slides'},
        {'row_id': 'row-2', 'slides_file_field': 'row_2_slides'},
    ]
    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'slides-only',
            'batch_title': '   ',
            'rows': json.dumps(rows),
            'row_1_slides': (io.BytesIO(b'%PDF-1.4 row-1'), 'row-1.pdf'),
            'row_2_slides': (io.BytesIO(b'%PDF-1.4 row-2'), 'row-2.pdf'),
        },
        content_type='multipart/form-data',
    )

    assert response.status_code == 400
    body = response.get_json()
    assert str(body.get('error', '')).strip() == 'Batch title is required.'


def test_batch_create_deduplicates_client_submission_id(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    monkeypatch.setattr(core, 'client', None)
    monkeypatch.setattr(
        batch_orchestrator,
        'find_batch_by_submission_id',
        lambda uid, client_submission_id, runtime=None: {
            'batch_id': 'existing-batch-1',
            'status': 'processing',
        },
    )
    monkeypatch.setattr(
        billing_credits,
        'deduct_credit',
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('Should not deduct credits for deduplicated submit')),
    )

    rows = [
        {'row_id': 'row-1', 'slides_file_field': 'row_1_slides'},
        {'row_id': 'row-2', 'slides_file_field': 'row_2_slides'},
    ]
    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'slides-only',
            'batch_title': 'Batch dedupe test',
            'client_submission_id': 'submission-123',
            'rows': json.dumps(rows),
        },
        content_type='multipart/form-data',
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload.get('batch_id') == 'existing-batch-1'
    assert payload.get('deduplicated') is True
    assert payload.get('status') == 'processing'


def test_batch_create_slides_only_contract(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    _patch_batch_quota_guards(monkeypatch)
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(upload_import_audio, 'cleanup_expired_audio_import_tokens', lambda runtime=None: None)
    monkeypatch.setattr(core, 'threading', type('T', (), {'Thread': _DummyThread}))
    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
            'slides_credits': 2,
            'preferred_output_language': 'english',
            'preferred_output_language_custom': '',
        },
    )

    monkeypatch.setattr(core, 'resolve_uploaded_slides_to_pdf', lambda uploaded_file, _job_id: ('test-slides.pdf', None))
    monkeypatch.setattr(billing_credits, 'deduct_credit', lambda uid, credit_type, runtime=None: 'slides_credits')

    capture = _Capture()

    def _fake_create_batch(batch_payload, rows, runtime=None):
        capture.batch_payload = dict(batch_payload)
        capture.rows = list(rows)

    monkeypatch.setattr(batch_orchestrator, 'create_batch_job', _fake_create_batch)
    monkeypatch.setattr(batch_orchestrator, 'process_batch_job', lambda _batch_id, runtime=None: None)
    submitted = {}
    monkeypatch.setattr(
        core,
        'submit_batch_background_job',
        lambda func, *args, **kwargs: submitted.update({'func': func, 'args': args, 'kwargs': kwargs}),
    )

    rows = [
        {'row_id': 'row-1', 'slides_file_field': 'row_1_slides'},
        {'row_id': 'row-2', 'slides_file_field': 'row_2_slides'},
    ]
    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'slides-only',
            'batch_title': 'Batch test',
            'include_combined_docx': '1',
            'rows': json.dumps(rows),
            'row_1_slides': (io.BytesIO(b'%PDF-1.4 row-1'), 'row-1.pdf'),
            'row_2_slides': (io.BytesIO(b'%PDF-1.4 row-2'), 'row-2.pdf'),
        },
        content_type='multipart/form-data',
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload.get('batch_id')
    assert capture.batch_payload is not None
    assert capture.batch_payload.get('mode') == 'slides-only'
    assert capture.batch_payload.get('total_rows') == 2
    assert capture.batch_payload.get('completion_email_status') == 'pending'
    assert capture.batch_payload.get('completion_email_sent_at') == 0
    assert capture.batch_payload.get('completion_email_error') == ''
    assert capture.batch_payload.get('export_options') == {'include_combined_docx': True}
    assert isinstance(capture.rows, list)
    assert len(capture.rows) == 2
    assert capture.rows[0].get('billing_mode') == 'batch'
    assert submitted['func'] is batch_orchestrator.process_batch_job
    submitted_runtime = submitted['kwargs']['runtime']
    assert getattr(submitted_runtime, 'core', submitted_runtime) is core


def test_instant_batch_create_accepts_all_modes_with_instant_metadata(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    _patch_batch_quota_guards(monkeypatch)
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(core, 'INSTANT_BATCH_MAX_ROWS', 20)
    monkeypatch.setattr(upload_import_audio, 'cleanup_expired_audio_import_tokens', lambda runtime=None: None)
    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
            'lecture_credits_standard': 20,
            'lecture_credits_extended': 0,
            'slides_credits': 20,
            'interview_credits_short': 20,
            'interview_credits_medium': 0,
            'interview_credits_long': 0,
            'preferred_output_language': 'english',
            'preferred_output_language_custom': '',
        },
    )
    monkeypatch.setattr(core, 'resolve_uploaded_slides_to_pdf', lambda uploaded_file, job_id: (f'{job_id}.pdf', None))
    monkeypatch.setattr(core, 'get_saved_file_size', lambda _path: 128)
    monkeypatch.setattr(core, 'file_looks_like_audio', lambda _path: True)
    monkeypatch.setattr(billing_credits, 'deduct_credit', lambda uid, *credit_types, runtime=None: str(credit_types[0]))
    monkeypatch.setattr(billing_credits, 'deduct_interview_credit', lambda uid, runtime=None: 'interview_credits_short')
    monkeypatch.setattr(billing_credits, 'deduct_slides_credits', lambda uid, amount, runtime=None: True)

    created = []
    submitted = []

    def _fake_create_batch(batch_payload, rows, runtime=None):
        created.append((dict(batch_payload), list(rows)))

    monkeypatch.setattr(batch_orchestrator, 'create_batch_job', _fake_create_batch)
    monkeypatch.setattr(
        core,
        'submit_batch_background_job',
        lambda func, *args, **kwargs: submitted.append({'func': func, 'args': args, 'kwargs': kwargs}),
    )

    mode_payloads = {
        'lecture-notes': {
            'rows': [
                {'row_id': 'row-1', 'slides_file_field': 'row_1_slides', 'audio_file_field': 'row_1_audio'},
                {'row_id': 'row-2', 'slides_file_field': 'row_2_slides', 'audio_file_field': 'row_2_audio'},
            ],
            'files': {
                'row_1_slides': (io.BytesIO(b'%PDF row 1'), 'row-1.pdf'),
                'row_2_slides': (io.BytesIO(b'%PDF row 2'), 'row-2.pdf'),
                'row_1_audio': (io.BytesIO(b'audio row 1'), 'row-1.mp3'),
                'row_2_audio': (io.BytesIO(b'audio row 2'), 'row-2.mp3'),
            },
        },
        'slides-only': {
            'rows': [
                {'row_id': 'row-1', 'slides_file_field': 'row_1_slides'},
                {'row_id': 'row-2', 'slides_file_field': 'row_2_slides'},
            ],
            'files': {
                'row_1_slides': (io.BytesIO(b'%PDF row 1'), 'row-1.pdf'),
                'row_2_slides': (io.BytesIO(b'%PDF row 2'), 'row-2.pdf'),
            },
        },
        'interview': {
            'rows': [
                {'row_id': 'row-1', 'audio_file_field': 'row_1_audio'},
                {'row_id': 'row-2', 'audio_file_field': 'row_2_audio'},
            ],
            'files': {
                'row_1_audio': (io.BytesIO(b'audio row 1'), 'row-1.mp3'),
                'row_2_audio': (io.BytesIO(b'audio row 2'), 'row-2.mp3'),
            },
        },
        'audio-transcription': {
            'rows': [
                {'row_id': 'row-1', 'audio_file_field': 'row_1_audio'},
                {'row_id': 'row-2', 'audio_file_field': 'row_2_audio'},
            ],
            'files': {
                'row_1_audio': (io.BytesIO(b'audio row 1'), 'row-1.mp3'),
                'row_2_audio': (io.BytesIO(b'audio row 2'), 'row-2.mp3'),
            },
        },
        'text-combine': {
            'rows': [
                {'row_id': 'row-1', 'slide_text_file_field': 'row_1_slide_text'},
                {'row_id': 'row-2', 'transcript_text_file_field': 'row_2_transcript_text'},
            ],
            'files': {
                'row_1_slide_text': (io.BytesIO('Slide text'.encode('utf-8')), 'slides-1.txt'),
                'row_2_transcript_text': (io.BytesIO('Transcript'.encode('utf-8')), 'transcript-2.txt'),
            },
        },
    }

    for mode_name, config in mode_payloads.items():
        data = {
            'mode': mode_name,
            'batch_title': f'Instant {mode_name}',
            'rows': json.dumps(config['rows']),
        }
        data.update(config['files'])
        response = client.post('/api/instant-batch/jobs', data=data, content_type='multipart/form-data')
        assert response.status_code == 200

    assert len(created) == 5
    assert len(submitted) == 5
    for batch_payload, rows in created:
        assert batch_payload['processing_strategy'] == 'instant'
        assert batch_payload['billing_mode'] == 'instant_batch'
        assert batch_payload['billing_multiplier'] == 1.0
        assert batch_payload['instant_max_parallel_rows'] == 2
        assert batch_payload['instant_api_stagger_seconds'] == 5.0
        assert rows
        assert all(row.get('processing_strategy') == 'instant' for row in rows)
        assert all(row.get('billing_mode') == 'instant_batch' for row in rows)
    assert all(item['func'] is instant_batch_orchestrator.process_instant_batch_job for item in submitted)


def test_instant_batch_rejects_more_than_twenty_rows(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    rows = [{'row_id': f'row-{idx}'} for idx in range(21)]

    response = client.post(
        '/api/instant-batch/jobs',
        data={'mode': 'text-combine', 'rows': json.dumps(rows)},
        content_type='multipart/form-data',
    )

    assert response.status_code == 400
    assert 'up to 20 rows' in response.get_json().get('error', '')


def test_batch_create_lecture_notes_preserves_row_study_override_contract(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    _patch_batch_quota_guards(monkeypatch)
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(upload_import_audio, 'cleanup_expired_audio_import_tokens', lambda runtime=None: None)
    monkeypatch.setattr(core, 'threading', type('T', (), {'Thread': _DummyThread}))
    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
            'lecture_credits_standard': 2,
            'lecture_credits_extended': 0,
            'preferred_output_language': 'english',
            'preferred_output_language_custom': '',
        },
    )

    monkeypatch.setattr(core, 'resolve_uploaded_slides_to_pdf', lambda uploaded_file, _job_id: ('lecture-slides.pdf', None))
    monkeypatch.setattr(core, 'file_looks_like_audio', lambda _path: True)
    monkeypatch.setattr(billing_credits, 'deduct_credit', lambda *args, **kwargs: 'lecture_credits_standard')

    capture = _Capture()

    def _fake_create_batch(batch_payload, rows, runtime=None):
        capture.batch_payload = dict(batch_payload)
        capture.rows = list(rows)

    monkeypatch.setattr(batch_orchestrator, 'create_batch_job', _fake_create_batch)
    monkeypatch.setattr(batch_orchestrator, 'process_batch_job', lambda _batch_id, runtime=None: None)

    rows = [
        {
            'row_id': 'row-1',
            'slides_file_field': 'row_1_slides',
            'audio_file_field': 'row_1_audio',
            'study_override': {
                'study_features': 'flashcards',
                'flashcard_amount': '30',
                'question_amount': '15',
            },
        },
        {
            'row_id': 'row-2',
            'slides_file_field': 'row_2_slides',
            'audio_file_field': 'row_2_audio',
        },
    ]
    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'lecture-notes',
            'batch_title': 'Lecture override contract',
            'study_features': 'both',
            'flashcard_amount': '20',
            'question_amount': '10',
            'rows': json.dumps(rows),
            'row_1_slides': (io.BytesIO(b'%PDF-1.4 lecture-1'), 'lecture-1.pdf'),
            'row_1_audio': (io.BytesIO(b'RIFF0000WAVEfmt row-1'), 'lecture-1.wav', 'audio/wav'),
            'row_2_slides': (io.BytesIO(b'%PDF-1.4 lecture-2'), 'lecture-2.pdf'),
            'row_2_audio': (io.BytesIO(b'RIFF0000WAVEfmt row-2'), 'lecture-2.wav', 'audio/wav'),
        },
        content_type='multipart/form-data',
    )

    assert response.status_code == 200
    assert capture.batch_payload is not None
    assert capture.batch_payload.get('mode') == 'lecture-notes'
    assert isinstance(capture.rows, list)
    assert len(capture.rows) == 2
    assert capture.rows[0].get('study_features') == 'flashcards'
    assert capture.rows[0].get('flashcard_selection') == '30'
    assert capture.rows[0].get('question_selection') == '15'
    assert capture.rows[1].get('study_features') == 'both'
    assert capture.rows[1].get('flashcard_selection') == '20'
    assert capture.rows[1].get('question_selection') == '10'


def test_batch_create_interview_accepts_empty_extras_by_default(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    _patch_batch_quota_guards(monkeypatch)
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(upload_import_audio, 'cleanup_expired_audio_import_tokens', lambda runtime=None: None)
    monkeypatch.setattr(core, 'threading', type('T', (), {'Thread': _DummyThread}))
    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
            'interview_credits_short': 2,
            'interview_credits_medium': 0,
            'interview_credits_long': 0,
            'slides_credits': 0,
            'preferred_output_language': 'english',
            'preferred_output_language_custom': '',
        },
    )
    monkeypatch.setattr(billing_credits, 'deduct_interview_credit', lambda uid, runtime=None: 'interview_credits_short')
    monkeypatch.setattr(
        billing_credits,
        'deduct_slides_credits',
        lambda uid, amount, runtime=None: (_ for _ in ()).throw(AssertionError('No extra text credits should be charged for [] extras')),
    )

    capture = _Capture()

    def _fake_create_batch(batch_payload, rows, runtime=None):
        capture.batch_payload = dict(batch_payload)
        capture.rows = list(rows)

    monkeypatch.setattr(batch_orchestrator, 'create_batch_job', _fake_create_batch)
    monkeypatch.setattr(batch_orchestrator, 'process_batch_job', lambda _batch_id, runtime=None: None)

    rows = [
        {'row_id': 'row-1', 'audio_file_field': 'row_1_audio', 'interview_features': []},
        {'row_id': 'row-2', 'audio_file_field': 'row_2_audio', 'interview_features': []},
    ]
    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'interview',
            'batch_title': 'Interview extras off',
            'rows': json.dumps(rows),
            'row_1_audio': (io.BytesIO(b'RIFF0000WAVEfmt row-1'), 'interview-1.wav', 'audio/wav'),
            'row_2_audio': (io.BytesIO(b'RIFF0000WAVEfmt row-2'), 'interview-2.wav', 'audio/wav'),
        },
        content_type='multipart/form-data',
    )

    assert response.status_code == 200
    assert capture.batch_payload is not None
    assert capture.batch_payload.get('mode') == 'interview'
    assert isinstance(capture.rows, list)
    assert len(capture.rows) == 2
    assert capture.rows[0].get('interview_features') == []
    assert capture.rows[0].get('interview_features_cost') == 0
    assert capture.rows[1].get('interview_features') == []
    assert capture.rows[1].get('interview_features_cost') == 0


def test_batch_create_audio_transcription_uses_interview_credits_without_study_tools(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    _patch_batch_quota_guards(monkeypatch)
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(upload_import_audio, 'cleanup_expired_audio_import_tokens', lambda runtime=None: None)
    monkeypatch.setattr(core, 'threading', type('T', (), {'Thread': _DummyThread}))
    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
            'interview_credits_short': 2,
            'interview_credits_medium': 0,
            'interview_credits_long': 0,
            'slides_credits': 0,
            'preferred_output_language': 'english',
            'preferred_output_language_custom': '',
        },
    )
    monkeypatch.setattr(core, 'file_looks_like_audio', lambda _path: True)
    monkeypatch.setattr(billing_credits, 'deduct_interview_credit', lambda uid, runtime=None: 'interview_credits_short')
    monkeypatch.setattr(
        billing_credits,
        'deduct_credit',
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('Audio transcription batches should not charge lecture or slides credits')),
    )
    monkeypatch.setattr(
        billing_credits,
        'deduct_slides_credits',
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('Audio transcription batches should not charge study-tool credits')),
    )

    capture = _Capture()

    def _fake_create_batch(batch_payload, rows, runtime=None):
        capture.batch_payload = dict(batch_payload)
        capture.rows = list(rows)

    monkeypatch.setattr(batch_orchestrator, 'create_batch_job', _fake_create_batch)
    monkeypatch.setattr(batch_orchestrator, 'process_batch_job', lambda _batch_id, runtime=None: None)

    rows = [
        {
            'row_id': 'row-1',
            'audio_file_field': 'row_1_audio',
            'study_override': {'study_features': 'both'},
            'interview_features': ['summary'],
        },
        {'row_id': 'row-2', 'audio_file_field': 'row_2_audio'},
    ]
    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'audio-transcription',
            'batch_title': 'Audio transcription batch',
            'include_combined_docx': '1',
            'output_language': 'other',
            'output_language_custom': 'Italian',
            'study_features': 'both',
            'rows': json.dumps(rows),
            'row_1_audio': (io.BytesIO(b'RIFF0000WAVEfmt row-1'), 'audio-1.wav', 'audio/wav'),
            'row_2_audio': (io.BytesIO(b'RIFF0000WAVEfmt row-2'), 'audio-2.wav', 'audio/wav'),
        },
        content_type='multipart/form-data',
    )

    assert response.status_code == 200
    assert capture.batch_payload is not None
    assert capture.batch_payload.get('mode') == 'audio-transcription'
    assert capture.batch_payload.get('output_language') == 'Italian'
    assert capture.batch_payload.get('study_defaults', {}).get('study_features') == 'none'
    assert capture.batch_payload.get('export_options') == {'include_combined_docx': True}
    assert isinstance(capture.rows, list)
    assert len(capture.rows) == 2
    assert capture.rows[0].get('study_features') == 'none'
    assert capture.rows[0].get('interview_features') == []
    assert capture.rows[0].get('interview_features_cost') == 0
    assert capture.rows[0].get('credit_deducted') == 'interview_credits_short'
    assert capture.rows[0].get('source_type') == 'upload'
    assert capture.rows[1].get('study_features') == 'none'


def test_batch_create_text_combine_accepts_mixed_txt_inputs_with_lecture_credits(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    _patch_batch_quota_guards(monkeypatch)
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(upload_import_audio, 'cleanup_expired_audio_import_tokens', lambda runtime=None: None)
    monkeypatch.setattr(core, 'threading', type('T', (), {'Thread': _DummyThread}))
    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
            'lecture_credits_standard': 3,
            'lecture_credits_extended': 0,
            'preferred_output_language': 'english',
            'preferred_output_language_custom': '',
        },
    )
    deducted = []
    monkeypatch.setattr(
        billing_credits,
        'deduct_credit',
        lambda uid, primary, fallback=None, runtime=None: deducted.append((primary, fallback)) or 'lecture_credits_standard',
    )
    monkeypatch.setattr(
        billing_credits,
        'deduct_interview_credit',
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('Text combine should not charge interview credits')),
    )
    monkeypatch.setattr(
        billing_credits,
        'deduct_slides_credits',
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('Text combine should not charge text extraction credits')),
    )

    capture = _Capture()

    def _fake_create_batch(batch_payload, rows, runtime=None):
        capture.batch_payload = dict(batch_payload)
        capture.rows = list(rows)

    monkeypatch.setattr(batch_orchestrator, 'create_batch_job', _fake_create_batch)
    monkeypatch.setattr(batch_orchestrator, 'process_batch_job', lambda _batch_id, runtime=None: None)

    rows = [
        {'row_id': 'row-1', 'slide_text_file_field': 'row_1_slide_text', 'transcript_text_file_field': 'row_1_transcript_text'},
        {'row_id': 'row-2', 'transcript_text_file_field': 'row_2_transcript_text'},
        {'row_id': 'row-3', 'slide_text_file_field': 'row_3_slide_text'},
    ]
    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'text-combine',
            'batch_title': 'Prompt 3 combine',
            'include_combined_docx': '1',
            'output_language': 'dutch',
            'study_features': 'both',
            'rows': json.dumps(rows),
            'row_1_slide_text': (io.BytesIO('Slide één\n[Informatieve Afbeelding/Tabel: X]'.encode('utf-8')), 'slides-1.txt', 'text/plain'),
            'row_1_transcript_text': (io.BytesIO('Transcript één'.encode('utf-8')), 'transcript-1.txt', 'text/plain'),
            'row_2_transcript_text': (io.BytesIO('Transcript only'.encode('utf-8')), 'transcript-2.txt', 'text/plain'),
            'row_3_slide_text': (io.BytesIO('Slides only'.encode('utf-8')), 'slides-3.txt', 'text/plain'),
        },
        content_type='multipart/form-data',
    )

    assert response.status_code == 200
    assert capture.batch_payload.get('mode') == 'text-combine'
    assert capture.batch_payload.get('output_language') == 'Dutch'
    assert capture.batch_payload.get('study_defaults', {}).get('study_features') == 'none'
    assert capture.batch_payload.get('export_options') == {'include_combined_docx': True}
    assert deducted == [
        ('lecture_credits_standard', 'lecture_credits_extended'),
        ('lecture_credits_standard', 'lecture_credits_extended'),
        ('lecture_credits_standard', 'lecture_credits_extended'),
    ]
    assert [row.get('text_input_mode') for row in capture.rows] == ['both', 'transcript-only', 'slides-only']
    assert [row.get('source_type') for row in capture.rows] == ['text-upload', 'text-upload', 'text-upload']
    assert capture.rows[0].get('slide_text').startswith('Slide één')
    assert capture.rows[0].get('transcript') == 'Transcript één'
    assert capture.rows[0].get('study_features') == 'none'
    assert capture.rows[0].get('credit_deducted') == 'lecture_credits_standard'


def test_batch_create_text_combine_rejects_missing_txt_inputs(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    _patch_batch_quota_guards(monkeypatch)
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
            'lecture_credits_standard': 2,
            'lecture_credits_extended': 0,
            'preferred_output_language': 'english',
            'preferred_output_language_custom': '',
        },
    )
    monkeypatch.setattr(
        billing_credits,
        'deduct_credit',
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('Should reject before credit deduction')),
    )

    rows = [
        {'row_id': 'row-1'},
        {'row_id': 'row-2', 'slide_text_file_field': 'row_2_slide_text'},
    ]
    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'text-combine',
            'batch_title': 'Missing text',
            'rows': json.dumps(rows),
            'row_2_slide_text': (io.BytesIO(b'Slides only'), 'slides-2.txt', 'text/plain'),
        },
        content_type='multipart/form-data',
    )

    assert response.status_code == 400
    assert 'at least one .txt file' in response.get_json()['error']


@pytest.mark.parametrize(
    ('file_bytes', 'filename', 'expected_error'),
    [
        (b'Not txt', 'slides.md', 'must be a .txt file'),
        (b'', 'slides.txt', 'is empty'),
        (b'a' * (core.MAX_BATCH_TEXT_UPLOAD_BYTES + 1), 'slides.txt', 'exceeds the 2 MB limit'),
    ],
)
def test_batch_create_text_combine_rejects_invalid_txt_uploads(client, monkeypatch, file_bytes, filename, expected_error):
    _patch_batch_auth(monkeypatch)
    _patch_batch_quota_guards(monkeypatch)
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(upload_import_audio, 'cleanup_expired_audio_import_tokens', lambda runtime=None: None)
    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
            'lecture_credits_standard': 2,
            'lecture_credits_extended': 0,
            'preferred_output_language': 'english',
            'preferred_output_language_custom': '',
        },
    )

    rows = [
        {'row_id': 'row-1', 'slide_text_file_field': 'row_1_slide_text'},
        {'row_id': 'row-2', 'slide_text_file_field': 'row_2_slide_text'},
    ]
    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'text-combine',
            'batch_title': 'Invalid text',
            'rows': json.dumps(rows),
            'row_1_slide_text': (io.BytesIO(file_bytes), filename, 'text/plain'),
            'row_2_slide_text': (io.BytesIO(b'Valid slides'), 'slides-2.txt', 'text/plain'),
        },
        content_type='multipart/form-data',
    )

    assert response.status_code == 400
    assert expected_error in response.get_json()['error']


def test_batch_direct_url_does_not_download_when_credit_preflight_fails(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    _patch_batch_quota_guards(monkeypatch)
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
            'lecture_credits_standard': 0,
            'lecture_credits_extended': 0,
            'preferred_output_language': 'english',
            'preferred_output_language_custom': '',
        },
    )
    monkeypatch.setattr(
        core,
        'download_audio_from_video_url',
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('direct media URL should not download before credit preflight')),
    )
    monkeypatch.setattr(
        upload_import_audio,
        'validate_video_import_url',
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('direct media URL should not validate before credit preflight')),
    )

    rows = [
        {'row_id': 'row-1', 'slides_file_field': 'row_1_slides', 'audio_m3u8_url': 'https://ovp.kaltura.com/a/index.m3u8'},
        {'row_id': 'row-2', 'slides_file_field': 'row_2_slides', 'audio_m3u8_url': 'https://ovp.kaltura.com/b/index.m3u8'},
    ]
    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'lecture-notes',
            'batch_title': 'Credit preflight before URL import',
            'rows': json.dumps(rows),
            'row_1_slides': (io.BytesIO(b'%PDF-1.4 row-1'), 'row-1.pdf'),
            'row_2_slides': (io.BytesIO(b'%PDF-1.4 row-2'), 'row-2.pdf'),
        },
        content_type='multipart/form-data',
    )

    assert response.status_code == 402
    assert 'not enough lecture credits' in response.get_json()['error'].lower()


def test_batch_direct_url_does_not_download_when_daily_quota_fails(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    _patch_batch_quota_guards(monkeypatch, reserve_daily=(False, 123))
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
            'lecture_credits_standard': 2,
            'lecture_credits_extended': 0,
            'preferred_output_language': 'english',
            'preferred_output_language_custom': '',
        },
    )
    monkeypatch.setattr(
        core,
        'download_audio_from_video_url',
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('direct media URL should not download before quota preflight')),
    )
    monkeypatch.setattr(
        upload_import_audio,
        'validate_video_import_url',
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError('direct media URL should not validate before quota preflight')),
    )

    rows = [
        {'row_id': 'row-1', 'slides_file_field': 'row_1_slides', 'audio_m3u8_url': 'https://ovp.kaltura.com/a/index.m3u8'},
        {'row_id': 'row-2', 'slides_file_field': 'row_2_slides', 'audio_m3u8_url': 'https://ovp.kaltura.com/b/index.m3u8'},
    ]
    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'lecture-notes',
            'batch_title': 'Quota preflight before URL import',
            'rows': json.dumps(rows),
            'row_1_slides': (io.BytesIO(b'%PDF-1.4 row-1'), 'row-1.pdf'),
            'row_2_slides': (io.BytesIO(b'%PDF-1.4 row-2'), 'row-2.pdf'),
        },
        content_type='multipart/form-data',
    )

    assert response.status_code == 429
    assert response.headers.get('Retry-After') == '123'
    assert 'daily upload quota' in response.get_json()['error'].lower()


def test_batch_direct_url_redacts_source_url_and_defers_download(client, monkeypatch, tmp_path):
    _patch_batch_auth(monkeypatch)
    _patch_batch_quota_guards(monkeypatch)
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(core, 'db', None)
    capture = _Capture()
    reserved = []
    released = []
    downloads = []

    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
            'lecture_credits_standard': 2,
            'lecture_credits_extended': 0,
            'preferred_output_language': 'english',
            'preferred_output_language_custom': '',
        },
    )
    monkeypatch.setattr(
        upload_import_audio,
        'validate_video_import_fetch_target',
        lambda raw_url, runtime=None: (raw_url, ''),
    )

    def _resolve_slides(_uploaded_file, job_id):
        path = tmp_path / f'{job_id}.pdf'
        path.write_bytes(b'%PDF-1.4 row slides')
        return str(path), ''

    def _download_audio(_fetch_target, prefix):
        downloads.append((_fetch_target, prefix))
        path = tmp_path / f'{prefix}.mp3'
        path.write_bytes(b'ID3\x03\x00\x00downloaded audio')
        return str(path), path.name, path.stat().st_size

    monkeypatch.setattr(core, 'resolve_uploaded_slides_to_pdf', _resolve_slides)
    monkeypatch.setattr(core, 'download_audio_from_video_url', _download_audio)
    monkeypatch.setattr(core, 'get_saved_file_size', lambda path: os.path.getsize(path))
    monkeypatch.setattr(core, 'file_looks_like_audio', lambda _path: True)
    monkeypatch.setattr(rate_limit_quotas, 'reserve_daily_upload_bytes', lambda uid, byte_count, runtime=None: reserved.append((uid, byte_count)) or (True, 0))
    monkeypatch.setattr(rate_limit_quotas, 'release_daily_upload_bytes', lambda uid, byte_count, runtime=None: released.append((uid, byte_count)) or True)
    monkeypatch.setattr(billing_credits, 'deduct_credit', lambda *_args, **_kwargs: 'lecture_credits_standard')
    monkeypatch.setattr(batch_orchestrator, 'process_batch_job', lambda _batch_id, runtime=None: None)

    def _fake_create_batch(batch_payload, rows, runtime=None):
        capture.batch_payload = dict(batch_payload)
        capture.rows = [dict(row) for row in rows]

    monkeypatch.setattr(batch_orchestrator, 'create_batch_job', _fake_create_batch)
    monkeypatch.setattr(core, 'submit_batch_background_job', lambda target, *args, **kwargs: None)

    rows = [
        {'row_id': 'row-1', 'slides_file_field': 'row_1_slides', 'audio_m3u8_url': 'https://ovp.kaltura.com/a/index.m3u8?token=secret-a'},
        {'row_id': 'row-2', 'slides_file_field': 'row_2_slides', 'audio_m3u8_url': 'https://ovp.kaltura.com/b/index.m3u8?token=secret-b'},
    ]
    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'lecture-notes',
            'batch_title': 'Direct URL redaction',
            'rows': json.dumps(rows),
            'row_1_slides': (io.BytesIO(b'%PDF-1.4 row-1'), 'row-1.pdf'),
            'row_2_slides': (io.BytesIO(b'%PDF-1.4 row-2'), 'row-2.pdf'),
        },
        content_type='multipart/form-data',
    )

    assert response.status_code == 200
    assert capture.rows is not None
    assert capture.rows[0]['source_url'] == 'https://ovp.kaltura.com/[redacted]'
    assert capture.rows[1]['source_url'] == 'https://ovp.kaltura.com/[redacted]'
    assert capture.rows[0].get(batch_orchestrator.BATCH_AUDIO_FETCH_TARGET_FIELD)
    assert capture.rows[1].get(batch_orchestrator.BATCH_AUDIO_FETCH_TARGET_FIELD)
    assert 'token=' not in json.dumps(capture.rows)
    assert reserved and reserved[0][1] >= core.MAX_AUDIO_UPLOAD_BYTES * 2
    assert downloads == []


def test_batch_worker_downloads_direct_url_and_releases_unused_quota(monkeypatch, tmp_path):
    monkeypatch.setattr(core, 'db', None)
    released = []

    def _download_audio(_fetch_target, prefix):
        path = tmp_path / f'{prefix}.mp3'
        path.write_bytes(b'ID3\x03\x00\x00downloaded audio')
        return str(path), path.name, path.stat().st_size

    monkeypatch.setattr(core, 'download_audio_from_video_url', _download_audio)
    monkeypatch.setattr(rate_limit_quotas, 'release_daily_upload_bytes', lambda uid, byte_count, runtime=None: released.append((uid, byte_count)) or True)

    row = {
        'batch_id': 'batch-direct',
        'row_id': 'row-1',
        'row_job_id': 'row-job-1',
        'uid': 'u-batch',
        'source_type': 'm3u8_url',
        'audio_quota_reserved_bytes': core.MAX_AUDIO_UPLOAD_BYTES,
        'audio_quota_released': False,
    }
    batch_orchestrator.register_batch_audio_fetch_target(
        'batch-direct',
        'row-1',
        {
            'url': 'https://ovp.kaltura.com/a/index.m3u8?token=secret-a',
            'scheme': 'https',
            'host': 'ovp.kaltura.com',
            'port': 443,
            'resolved_ips': ['8.8.8.8'],
        },
        runtime=core,
    )
    local_paths = []

    batch_orchestrator._prepare_row_audio_source(row, local_paths, runtime=core)

    assert row['audio_local_path'].endswith('.mp3')
    assert row['audio_quota_released'] is True
    assert released and released[0][0] == 'u-batch'
    assert released[0][1] == core.MAX_AUDIO_UPLOAD_BYTES - row['audio_quota_actual_bytes']
    assert local_paths == [row['audio_local_path']]


def test_batch_worker_downloads_direct_url_from_encrypted_row_target(monkeypatch, tmp_path):
    _clear_batch_memory()
    monkeypatch.setattr(core, 'db', None)
    downloads = []

    fetch_target = {
        'url': 'https://ovp.kaltura.com/a/index.m3u8?token=secret-a',
        'scheme': 'https',
        'host': 'ovp.kaltura.com',
        'port': 443,
        'resolved_ips': ['8.8.8.8'],
    }

    def _download_audio(target, prefix):
        downloads.append((target, prefix))
        path = tmp_path / f'{prefix}.mp3'
        path.write_bytes(b'ID3\x03\x00\x00downloaded audio')
        return str(path), path.name, path.stat().st_size

    monkeypatch.setattr(core, 'download_audio_from_video_url', _download_audio)
    monkeypatch.setattr(rate_limit_quotas, 'release_daily_upload_bytes', lambda *_args, **_kwargs: True)

    row = {
        'batch_id': 'batch-direct',
        'row_id': 'row-1',
        'row_job_id': 'row-job-1',
        'uid': 'u-batch',
        'source_type': 'm3u8_url',
        'audio_quota_reserved_bytes': core.MAX_AUDIO_UPLOAD_BYTES,
        batch_orchestrator.BATCH_AUDIO_FETCH_TARGET_FIELD: batch_orchestrator.encrypt_batch_audio_fetch_target(fetch_target, runtime=core),
    }
    local_paths = []

    batch_orchestrator._prepare_row_audio_source(row, local_paths, runtime=core)

    assert downloads
    downloaded_target, download_prefix = downloads[0]
    assert getattr(downloaded_target, 'url', downloaded_target) == fetch_target['url']
    assert download_prefix == 'batch_row-job-1'
    assert row['audio_local_path'].endswith('.mp3')
    assert local_paths == [row['audio_local_path']]


def test_batch_upload_row_files_converts_audio_for_audio_transcription_rows(monkeypatch, tmp_path):
    source = tmp_path / 'recording.wav'
    converted = tmp_path / 'recording.mp3'
    source.write_bytes(b'RIFF0000WAVEfmt source')
    converted.write_bytes(b'ID3\x03\x00\x00converted')
    uploads = []

    class _FakeFiles:
        def upload(self, file=None, config=None):
            uploads.append((file, dict(config or {})))
            return type('UploadedFile', (), {'uri': 'files/audio-transcription'})()

    monkeypatch.setattr(core, 'client', type('FakeClient', (), {'files': _FakeFiles()})())
    monkeypatch.setattr(core, 'convert_audio_to_mp3_with_ytdlp', lambda path: (str(converted), True))
    monkeypatch.setattr(core, 'get_mime_type', lambda path: 'audio/mpeg')
    monkeypatch.setattr(core, 'wait_for_file_processing', lambda _file: None)
    monkeypatch.setattr(batch_orchestrator.study_audio, 'persist_audio_for_study_pack', lambda *_args, **_kwargs: 'audio/storage/key.mp3')

    row = {
        'row_id': 'row-audio',
        'row_job_id': 'row-job-audio',
        'source_type': 'upload',
        'audio_local_path': str(source),
    }

    batch_orchestrator._upload_row_files(row, runtime=core)

    assert uploads == [(str(converted), {'mime_type': 'audio/mpeg'})]
    assert str(converted) in row.get('_local_paths', [])
    assert row.get('audio_file_uri') == 'files/audio-transcription'
    assert row.get('audio_mime_type') == 'audio/mpeg'
    assert row.get('audio_storage_key') == 'audio/storage/key.mp3'


def test_process_batch_audio_transcription_runs_clean_transcript_prompt(monkeypatch):
    _clear_batch_memory()
    _patch_batch_refunds(monkeypatch)
    monkeypatch.setattr(core, 'db', None)
    monkeypatch.setattr(batch_orchestrator.ai_pipelines, 'save_study_pack', lambda *_args, **_kwargs: True)

    captured_stages = []

    def _fake_upload_row_files(row, runtime=None):
        row['audio_file_uri'] = 'files/' + row['row_id']
        row['audio_mime_type'] = 'audio/mpeg'

    def _fake_run_batch_stage(batch_id, stage_name, requests, request_keys=None, runtime=None, display_name=''):
        captured_stages.append(
            {
                'stage_name': stage_name,
                'requests': requests,
                'request_keys': list(request_keys or []),
                'display_name': display_name,
            }
        )
        return [
            {
                'response': {
                    'text': 'Clean transcript row one.',
                    'usage_metadata': {
                        'prompt_token_count': 10,
                        'candidates_token_count': 5,
                        'total_token_count': 15,
                    },
                }
            },
            {
                'response': {
                    'text': 'Clean transcript row two.',
                    'usage_metadata': {
                        'prompt_token_count': 12,
                        'candidates_token_count': 6,
                        'total_token_count': 18,
                    },
                }
            },
        ]

    monkeypatch.setattr(batch_orchestrator, '_upload_row_files', _fake_upload_row_files)
    monkeypatch.setattr(batch_orchestrator, '_run_batch_stage', _fake_run_batch_stage)

    batch_id = batch_orchestrator.create_batch_job(
        {
            'batch_id': 'batch-audio-prompt',
            'uid': 'u-batch',
            'email': 'batch@example.com',
            'mode': 'audio-transcription',
            'status': 'queued',
            'batch_title': 'Audio prompt',
            'total_rows': 2,
            'completion_email_status': 'pending',
        },
        [
            {
                'row_id': 'row-1',
                'ordinal': 1,
                'status': 'queued',
                'output_language': 'Dutch',
                'study_features': 'none',
                'credit_deducted': 'interview_credits_short',
            },
            {
                'row_id': 'row-2',
                'ordinal': 2,
                'status': 'queued',
                'output_language': 'Dutch',
                'study_features': 'none',
                'credit_deducted': 'interview_credits_short',
            },
        ],
        runtime=core,
    )

    batch_orchestrator.process_batch_job(batch_id, runtime=core)

    assert [stage['stage_name'] for stage in captured_stages] == ['audio_transcription']
    assert captured_stages[0]['request_keys'] == ['row-1', 'row-2']
    first_request = captured_stages[0]['requests'][0]
    parts = first_request['contents'][0]['parts']
    assert parts[0]['file_data'] == {'file_uri': 'files/row-1', 'mime_type': 'audio/mpeg'}
    prompt_text = parts[1]['text']
    assert 'Do not include timestamps.' in prompt_text
    assert 'Write the final output fully in this language: Dutch.' in prompt_text

    row_one = batch_orchestrator.get_batch_row(batch_id, 'row-1', runtime=core)
    row_two = batch_orchestrator.get_batch_row(batch_id, 'row-2', runtime=core)
    assert row_one.get('status') == 'complete'
    assert row_one.get('result') == 'Clean transcript row one.'
    assert row_one.get('transcript') == 'Clean transcript row one.'
    assert row_one.get('transcript_segments') == []
    assert row_one.get('study_features') == 'none'
    assert row_two.get('result') == 'Clean transcript row two.'


def test_batch_notes_merge_requests_include_max_thinking_config():
    request = {'contents': [{'role': 'user', 'parts': [{'text': 'merge'}]}]}

    payload = batch_orchestrator._request_with_stage_config(request, 'notes_merge', core)

    assert payload['generationConfig']['maxOutputTokens'] == 65536
    assert payload['generationConfig']['thinkingConfig']['thinkingBudget'] == 32768
    assert 'generationConfig' not in request


def test_instant_api_stagger_spaces_calls(monkeypatch):
    monkeypatch.setattr(core, 'INSTANT_BATCH_API_STAGGER_SECONDS', 5.0)
    monkeypatch.setattr(core.time, 'time', lambda: 100.0)
    sleeps = []
    monkeypatch.setattr(core.time, 'sleep', lambda seconds: sleeps.append(seconds))

    throttler = instant_batch_orchestrator.InstantApiStagger(runtime=core)
    throttler.wait()
    throttler.wait()
    throttler.wait()

    assert sleeps == [5.0, 10.0]


def test_instant_text_combine_uses_direct_generate_without_gemini_batch(monkeypatch):
    _clear_batch_memory()
    _patch_batch_refunds(monkeypatch)
    monkeypatch.setattr(core, 'db', None)
    monkeypatch.setattr(core, 'INSTANT_BATCH_API_STAGGER_SECONDS', 0)
    monkeypatch.setattr(core, 'INSTANT_BATCH_MAX_PARALLEL_ROWS', 2)
    monkeypatch.setattr(batch_orchestrator.ai_pipelines, 'save_study_pack', lambda *_args, **_kwargs: True)

    class _ForbiddenBatches:
        def create(self, *args, **kwargs):
            raise AssertionError('Gemini Batch API must not be used for instant batch.')

    class _InstantClient:
        batches = _ForbiddenBatches()

    class _Usage:
        prompt_token_count = 10
        candidates_token_count = 5
        total_token_count = 15

    class _Response:
        usage_metadata = _Usage()

        def __init__(self, text):
            self.text = text

    generate_calls = []

    def _fake_generate(model, contents, **kwargs):
        generate_calls.append({'model': model, 'contents': contents, 'kwargs': kwargs})
        return _Response(f'# Instant result {len(generate_calls)}')

    monkeypatch.setattr(core, 'client', _InstantClient())
    monkeypatch.setattr(instant_batch_orchestrator.ai_provider, 'generate_with_policy', _fake_generate)

    batch_id = batch_orchestrator.create_batch_job(
        {
            'batch_id': 'instant-text-combine',
            'uid': 'u-batch',
            'email': 'batch@example.com',
            'mode': 'text-combine',
            'status': 'queued',
            'processing_strategy': 'instant',
            'billing_mode': 'instant_batch',
            'billing_multiplier': 1.0,
            'batch_title': 'Instant Combine',
            'total_rows': 2,
            'completion_email_status': 'pending',
        },
        [
            {
                'row_id': 'row-1',
                'ordinal': 1,
                'status': 'queued',
                'source_name': 'Lecture 1',
                'slide_text': 'Slide text',
                'transcript': 'Transcript text',
                'text_input_mode': 'both',
                'output_language': 'Dutch',
                'study_features': 'none',
                'credit_deducted': 'lecture_credits_standard',
                'processing_strategy': 'instant',
                'billing_mode': 'instant_batch',
                'billing_multiplier': 1.0,
            },
            {
                'row_id': 'row-2',
                'ordinal': 2,
                'status': 'queued',
                'source_name': 'Lecture 2',
                'slide_text': '',
                'transcript': 'Transcript only',
                'text_input_mode': 'transcript-only',
                'output_language': 'Dutch',
                'study_features': 'none',
                'credit_deducted': 'lecture_credits_standard',
                'processing_strategy': 'instant',
                'billing_mode': 'instant_batch',
                'billing_multiplier': 1.0,
            },
        ],
        runtime=core,
    )

    instant_batch_orchestrator.process_instant_batch_job(batch_id, runtime=core)

    assert len(generate_calls) == 2
    assert all(call['model'] == core.MODEL_INTEGRATION for call in generate_calls)
    row_one = batch_orchestrator.get_batch_row(batch_id, 'row-1', runtime=core)
    row_two = batch_orchestrator.get_batch_row(batch_id, 'row-2', runtime=core)
    summary = batch_orchestrator.get_batch_status(batch_id, runtime=core)
    assert row_one['status'] == 'complete'
    assert row_one['result'].startswith('# Instant result')
    assert row_one['current_stage_detail'] == 'Lecture 1 · complete'
    assert row_one['billing_mode'] == 'instant_batch'
    assert row_two['status'] == 'complete'
    assert summary['status'] == 'complete'
    assert summary['processing_strategy'] == 'instant'
    assert summary['next_action_href'] == '/study'


def test_process_batch_text_combine_runs_prompt3_variants(monkeypatch):
    _clear_batch_memory()
    _patch_batch_refunds(monkeypatch)
    monkeypatch.setattr(core, 'db', None)
    monkeypatch.setattr(batch_orchestrator.ai_pipelines, 'save_study_pack', lambda *_args, **_kwargs: True)
    monkeypatch.setattr(batch_orchestrator, '_upload_row_files', lambda row, runtime=None: None)

    captured_stages = []

    def _fake_run_batch_stage(batch_id, stage_name, requests, request_keys=None, runtime=None, display_name=''):
        captured_stages.append(
            {
                'stage_name': stage_name,
                'requests': requests,
                'request_keys': list(request_keys or []),
            }
        )
        return [
            {'response': {'text': '# Combined row 1', 'usage_metadata': {'prompt_token_count': 10, 'candidates_token_count': 5, 'total_token_count': 15}}},
            {'response': {'text': '# Combined row 2', 'usage_metadata': {'prompt_token_count': 11, 'candidates_token_count': 6, 'total_token_count': 17}}},
            {'response': {'text': '# Combined row 3', 'usage_metadata': {'prompt_token_count': 12, 'candidates_token_count': 7, 'total_token_count': 19}}},
        ]

    monkeypatch.setattr(batch_orchestrator, '_run_batch_stage', _fake_run_batch_stage)

    batch_id = batch_orchestrator.create_batch_job(
        {
            'batch_id': 'batch-text-combine',
            'uid': 'u-batch',
            'email': 'batch@example.com',
            'mode': 'text-combine',
            'status': 'queued',
            'batch_title': 'Text combine',
            'total_rows': 3,
            'completion_email_status': 'pending',
        },
        [
            {
                'row_id': 'row-1',
                'ordinal': 1,
                'status': 'queued',
                'output_language': 'Dutch',
                'source_type': 'text-upload',
                'text_input_mode': 'both',
                'slide_text': 'Slide titel\nSlide detail',
                'transcript': 'Gesproken uitleg',
                'study_features': 'none',
                'credit_deducted': 'lecture_credits_standard',
            },
            {
                'row_id': 'row-2',
                'ordinal': 2,
                'status': 'queued',
                'output_language': 'Dutch',
                'source_type': 'text-upload',
                'text_input_mode': 'transcript-only',
                'slide_text': '',
                'transcript': 'Alleen transcript',
                'study_features': 'none',
                'credit_deducted': 'lecture_credits_standard',
            },
            {
                'row_id': 'row-3',
                'ordinal': 3,
                'status': 'queued',
                'output_language': 'Dutch',
                'source_type': 'text-upload',
                'text_input_mode': 'slides-only',
                'slide_text': 'Alleen slides',
                'transcript': '',
                'study_features': 'none',
                'credit_deducted': 'lecture_credits_standard',
            },
        ],
        runtime=core,
    )

    batch_orchestrator.process_batch_job(batch_id, runtime=core)

    assert [stage['stage_name'] for stage in captured_stages] == ['notes_merge']
    assert captured_stages[0]['request_keys'] == ['row-1', 'row-2', 'row-3']
    prompts = [request['contents'][0]['parts'][0]['text'] for request in captured_stages[0]['requests']]
    assert 'Slide-tekst:' in prompts[0]
    assert 'Audio-transcript:' in prompts[0]
    assert 'Er is geen slide-tekst beschikbaar' in prompts[1]
    assert 'Er is geen audio-transcript beschikbaar' in prompts[2]
    assert 'Schrijf de volledige output in: Dutch.' in prompts[0]

    row_one = batch_orchestrator.get_batch_row(batch_id, 'row-1', runtime=core)
    row_two = batch_orchestrator.get_batch_row(batch_id, 'row-2', runtime=core)
    row_three = batch_orchestrator.get_batch_row(batch_id, 'row-3', runtime=core)
    assert row_one.get('status') == 'complete'
    assert row_one.get('result') == '# Combined row 1'
    assert row_one.get('merged_notes') == '# Combined row 1'
    assert row_two.get('result') == '# Combined row 2'
    assert row_three.get('result') == '# Combined row 3'
    assert row_one.get('study_features') == 'none'


def test_batch_queue_full_cleans_consumed_import_token_files(client, monkeypatch, tmp_path):
    _clear_batch_memory()
    _patch_batch_auth(monkeypatch)
    _patch_batch_quota_guards(monkeypatch)
    monkeypatch.setattr(core, 'client', object())
    core.AUDIO_IMPORT_TOKENS.clear()
    audio_one = tmp_path / 'imported-one.mp3'
    audio_two = tmp_path / 'imported-two.mp3'
    audio_one.write_bytes(b'ID3\x03\x00\x00one')
    audio_two.write_bytes(b'ID3\x03\x00\x00two')
    token_one = upload_import_audio.register_audio_import_token('u-batch', str(audio_one), runtime=core)
    token_two = upload_import_audio.register_audio_import_token('u-batch', str(audio_two), runtime=core)
    cleanup_calls = []
    released_daily = []

    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
            'interview_credits_short': 2,
            'interview_credits_medium': 0,
            'interview_credits_long': 0,
            'slides_credits': 0,
            'preferred_output_language': 'english',
            'preferred_output_language_custom': '',
        },
    )
    monkeypatch.setattr(core, 'get_saved_file_size', lambda path: 1024 if path else 0)
    monkeypatch.setattr(core, 'file_looks_like_audio', lambda _path: True)
    monkeypatch.setattr(core, 'cleanup_files', lambda local_paths, remote_files: cleanup_calls.append((list(local_paths), list(remote_files))))
    monkeypatch.setattr(rate_limit_quotas, 'release_daily_upload_bytes', lambda uid, requested, runtime=None: released_daily.append((uid, requested)) or True)
    monkeypatch.setattr(billing_credits, 'deduct_interview_credit', lambda uid, runtime=None: 'interview_credits_short')
    monkeypatch.setattr(billing_credits, 'refund_credit', lambda *_args, **_kwargs: True)
    monkeypatch.setattr(batch_orchestrator, 'process_batch_job', lambda _batch_id, runtime=None: None)
    monkeypatch.setattr(
        core,
        'submit_batch_background_job',
        lambda *_args, **_kwargs: (_ for _ in ()).throw(JobQueueFullError('full')),
    )

    rows = [
        {'row_id': 'row-1', 'audio_import_token': token_one},
        {'row_id': 'row-2', 'audio_import_token': token_two},
    ]
    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'interview',
            'batch_title': 'Queue full import cleanup',
            'rows': json.dumps(rows),
        },
        content_type='multipart/form-data',
    )

    assert response.status_code == 503
    cleaned_paths = [path for paths, _remote in cleanup_calls for path in paths]
    assert str(audio_one) in cleaned_paths
    assert str(audio_two) in cleaned_paths
    assert token_one not in core.AUDIO_IMPORT_TOKENS
    assert token_two not in core.AUDIO_IMPORT_TOKENS
    assert released_daily and released_daily[0][0] == 'u-batch'


def test_batch_jobs_list_contract(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    monkeypatch.setattr(
        batch_orchestrator,
        'list_batches_for_uid',
        lambda uid, statuses=None, limit=100, runtime=None: [
            {
                'batch_id': 'batch-1',
                'mode': 'lecture-notes',
                'status': 'queued',
                'batch_title': 'Batch contract',
                'export_options': {'include_combined_docx': True},
            }
        ],
    )

    response = client.get('/api/batch/jobs?status=queued&mode=lecture-notes')

    assert response.status_code == 200
    body = response.get_json()
    assert isinstance(body.get('batches'), list)
    assert body['batches'][0]['batch_id'] == 'batch-1'
    assert body['batches'][0]['status'] == 'queued'
    assert body['batches'][0]['export_options'] == {'include_combined_docx': True}


def test_batch_status_contract(client, monkeypatch):
    _patch_batch_auth(monkeypatch)

    monkeypatch.setattr(
        batch_orchestrator,
        'get_batch',
        lambda batch_id, runtime=None: {
            'batch_id': batch_id,
            'uid': 'u-batch',
            'mode': 'lecture-notes',
            'status': 'processing',
        },
    )
    monkeypatch.setattr(
        batch_orchestrator,
        'get_batch_status',
        lambda batch_id, runtime=None: {
            'batch_id': batch_id,
            'status': 'processing',
            'mode': 'lecture-notes',
            'total_rows': 3,
            'completed_rows': 1,
            'failed_rows': 0,
            'token_input_total': 123,
            'token_output_total': 45,
            'token_total': 168,
            'export_options': {'include_combined_docx': True},
            'completion_email_status': 'pending',
            'completion_email_sent_at': 0,
            'completion_email_error': '',
            'rows': [
                {
                    'row_id': 'row-1',
                    'ordinal': 1,
                    'status': 'complete',
                    'token_input_total': 100,
                    'token_output_total': 20,
                    'token_total': 120,
                }
            ],
        },
    )

    response = client.get('/api/batch/jobs/batch-123')

    assert response.status_code == 200
    body = response.get_json()
    assert body.get('batch_id') == 'batch-123'
    assert body.get('mode') == 'lecture-notes'
    assert isinstance(body.get('rows'), list)
    assert body.get('export_options') == {'include_combined_docx': True}
    assert body.get('completion_email_status') == 'pending'


def test_finalize_row_job_log_marks_row_error_when_study_pack_save_fails(monkeypatch):
    _patch_batch_refunds(monkeypatch)
    saved_logs = []
    monkeypatch.setattr(batch_orchestrator.ai_pipelines, 'save_study_pack', lambda *_args, **_kwargs: False)
    monkeypatch.setattr(core, 'save_job_log', lambda job_id, job_data, finished_at: saved_logs.append((job_id, dict(job_data), finished_at)))

    batch = {
        'batch_id': 'batch-save-fail',
        'uid': 'u-batch',
        'email': 'batch@example.com',
        'mode': 'slides-only',
        'created_at': 100.0,
    }
    row = {
        'row_id': 'row-save-fail',
        'row_job_id': 'row-job-save-fail',
        'ordinal': 1,
        'status': 'processing',
        'slide_text': 'Slides text',
        'study_features': 'none',
        'credit_deducted': 'slides_credits',
        'billing_receipt': {'charged': {'slides_credits': 1}},
    }

    batch_orchestrator._finalize_row_job_log(batch, row, runtime=core)

    assert row['status'] == 'error'
    assert row['failed_stage'] == 'study_pack_persistence'
    assert row['error'] == 'Study pack could not be saved.'
    assert row['study_pack_id'] == ''
    assert row['credit_refunded'] is True
    assert saved_logs[-1][1]['status'] == 'error'
    assert saved_logs[-1][1]['failed_stage'] == 'study_pack_persistence'


def test_batch_download_zip_includes_combined_docx_when_enabled(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    monkeypatch.setattr(
        batch_orchestrator,
        'get_batch',
        lambda batch_id, runtime=None: {
            'batch_id': batch_id,
            'uid': 'u-batch',
            'mode': 'lecture-notes',
            'status': 'partial',
            'batch_title': 'Exam Batch',
            'total_rows': 2,
            'completed_rows': 1,
            'failed_rows': 1,
            'token_input_total': 100,
            'token_output_total': 40,
            'token_total': 140,
            'export_options': {'include_combined_docx': True},
        },
    )
    monkeypatch.setattr(
        batch_orchestrator,
        'get_batch_status',
        lambda batch_id, runtime=None: {
            'batch_id': batch_id,
            'can_download_zip': True,
        },
    )
    monkeypatch.setattr(
        batch_orchestrator,
        'list_batch_rows',
        lambda batch_id, runtime=None: [
            {
                'row_id': 'row-1',
                'ordinal': 1,
                'status': 'complete',
                'source_name': 'Lecture 1',
                'result': 'Merged lecture notes',
                'slide_text': 'Slides text',
                'transcript': 'Transcript text',
                'flashcards': [{'front': 'What is ATP?', 'back': 'Energy currency'}],
                'test_questions': [{'question': 'What is ATP?', 'options': ['A', 'B'], 'answer': 'A', 'explanation': 'It stores energy'}],
                'slides_local_path': '/tmp/private-slides.pdf',
                'audio_local_path': '/tmp/private-audio.mp3',
                'slides_file_uri': 'files/provider-slides',
                'audio_file_uri': 'files/provider-audio',
                'audio_storage_key': 'private/storage/key.mp3',
                'source_url': 'https://video.example.com/watch?token=secret',
                'billing_receipt': {'charged': {'lecture_credits_standard': 1}},
                'credit_deducted': 'lecture_credits_standard',
                'token_usage_by_stage': {'merge': {'input': 10}},
                'row_job_id': 'job-internal',
                '_local_paths': ['/tmp/internal'],
                '_gemini_files': ['provider-object'],
            },
            {
                'row_id': 'row-2',
                'ordinal': 2,
                'status': 'processing',
                'source_name': 'Lecture 2',
                'error': 'Still running',
            },
        ],
    )
    monkeypatch.setattr(
        study_export,
        'markdown_to_docx',
        lambda markdown_text, title='Document', runtime=None: _SimpleDocx(f'{title}\n{markdown_text}'),
    )

    response = client.get('/api/batch/jobs/batch-123/download.zip')

    assert response.status_code == 200
    archive = zipfile.ZipFile(io.BytesIO(response.data), 'r')
    names = archive.namelist()
    assert 'summary.json' in names
    assert 'rows/row-1/result.docx' in names
    assert 'rows/row-1/slides.docx' in names
    assert 'rows/row-1/transcript.docx' in names
    assert 'rows/row-1/flashcards.csv' in names
    assert 'rows/row-1/test_questions.csv' in names
    assert any(name.endswith('_Combined.docx') for name in names)

    summary = json.loads(archive.read('summary.json').decode('utf-8'))
    assert summary['export_options'] == {'include_combined_docx': True}

    combined_name = next(name for name in names if name.endswith('_Combined.docx'))
    combined_text = archive.read(combined_name).decode('utf-8')
    assert 'Lecture 1' in combined_text
    assert 'Lecture Notes' in combined_text
    assert 'Flashcards' in combined_text
    assert 'Practice Questions' in combined_text
    assert 'Lecture 2' in combined_text
    assert 'Status: processing' in combined_text
    assert 'Output was unavailable when this ZIP was created.' in combined_text

    row_meta = json.loads(archive.read('rows/row-1/meta.json').decode('utf-8'))
    assert row_meta['row_id'] == 'row-1'
    assert row_meta['source_name'] == 'Lecture 1'
    for sensitive_key in (
        'slides_local_path',
        'audio_local_path',
        'slides_file_uri',
        'audio_file_uri',
        'audio_storage_key',
        'source_url',
        'billing_receipt',
        'credit_deducted',
        'token_usage_by_stage',
        'row_job_id',
        '_local_paths',
        '_gemini_files',
    ):
        assert sensitive_key not in row_meta
    assert b'token=secret' not in archive.read('rows/row-1/meta.json')


def test_batch_download_zip_omits_combined_docx_when_disabled(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    monkeypatch.setattr(
        batch_orchestrator,
        'get_batch',
        lambda batch_id, runtime=None: {
            'batch_id': batch_id,
            'uid': 'u-batch',
            'mode': 'slides-only',
            'status': 'complete',
            'batch_title': 'Slides Batch',
            'total_rows': 1,
            'completed_rows': 1,
            'failed_rows': 0,
            'token_input_total': 10,
            'token_output_total': 5,
            'token_total': 15,
            'export_options': {'include_combined_docx': False},
        },
    )
    monkeypatch.setattr(
        batch_orchestrator,
        'get_batch_status',
        lambda batch_id, runtime=None: {
            'batch_id': batch_id,
            'can_download_zip': True,
        },
    )
    monkeypatch.setattr(
        batch_orchestrator,
        'list_batch_rows',
        lambda batch_id, runtime=None: [
            {
                'row_id': 'row-1',
                'ordinal': 1,
                'status': 'complete',
                'source_name': 'Slides 1',
                'slide_text': 'Only slides',
            }
        ],
    )
    monkeypatch.setattr(
        study_export,
        'markdown_to_docx',
        lambda markdown_text, title='Document', runtime=None: _SimpleDocx(f'{title}\n{markdown_text}'),
    )

    response = client.get('/api/batch/jobs/batch-456/download.zip')

    assert response.status_code == 200
    archive = zipfile.ZipFile(io.BytesIO(response.data), 'r')
    names = archive.namelist()
    assert 'summary.json' in names
    assert 'rows/row-1/result.docx' in names
    assert not any(name.endswith('_Combined.docx') for name in names)

    summary = json.loads(archive.read('summary.json').decode('utf-8'))
    assert summary['export_options'] == {'include_combined_docx': False}


def test_batch_download_zip_audio_transcription_includes_transcripts_and_combined_docx(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    monkeypatch.setattr(
        batch_orchestrator,
        'get_batch',
        lambda batch_id, runtime=None: {
            'batch_id': batch_id,
            'uid': 'u-batch',
            'mode': 'audio-transcription',
            'status': 'complete',
            'batch_title': 'Audio Batch',
            'total_rows': 1,
            'completed_rows': 1,
            'failed_rows': 0,
            'export_options': {'include_combined_docx': True},
        },
    )
    monkeypatch.setattr(
        batch_orchestrator,
        'get_batch_status',
        lambda batch_id, runtime=None: {
            'batch_id': batch_id,
            'can_download_zip': True,
        },
    )
    monkeypatch.setattr(
        batch_orchestrator,
        'list_batch_rows',
        lambda batch_id, runtime=None: [
            {
                'row_id': 'row-1',
                'ordinal': 1,
                'status': 'complete',
                'source_name': 'Audio 1',
                'result': 'Transcript text',
                'transcript': 'Transcript text',
            }
        ],
    )
    monkeypatch.setattr(
        study_export,
        'markdown_to_docx',
        lambda markdown_text, title='Document', runtime=None: _SimpleDocx(f'{title}\n{markdown_text}'),
    )

    response = client.get('/api/batch/jobs/batch-audio/download.zip')

    assert response.status_code == 200
    archive = zipfile.ZipFile(io.BytesIO(response.data), 'r')
    names = archive.namelist()
    assert 'rows/row-1/result.docx' in names
    assert 'rows/row-1/transcript.docx' in names
    assert 'rows/row-1/flashcards.csv' not in names
    assert 'rows/row-1/test_questions.csv' not in names
    combined_name = next(name for name in names if name.endswith('_Combined.docx'))
    combined_text = archive.read(combined_name).decode('utf-8')
    assert 'Audio 1' in combined_text
    assert 'Transcript' in combined_text
    assert 'Transcript text' in combined_text
    summary = json.loads(archive.read('summary.json').decode('utf-8'))
    assert summary['mode'] == 'audio-transcription'


def test_batch_download_zip_text_combine_includes_sources_and_combined_docx(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    monkeypatch.setattr(
        batch_orchestrator,
        'get_batch',
        lambda batch_id, runtime=None: {
            'batch_id': batch_id,
            'uid': 'u-batch',
            'mode': 'text-combine',
            'status': 'complete',
            'batch_title': 'Combine Batch',
            'total_rows': 2,
            'completed_rows': 2,
            'failed_rows': 0,
            'export_options': {'include_combined_docx': True},
        },
    )
    monkeypatch.setattr(
        batch_orchestrator,
        'get_batch_status',
        lambda batch_id, runtime=None: {
            'batch_id': batch_id,
            'can_download_zip': True,
        },
    )
    monkeypatch.setattr(
        batch_orchestrator,
        'list_batch_rows',
        lambda batch_id, runtime=None: [
            {
                'row_id': 'row-1',
                'ordinal': 1,
                'status': 'complete',
                'source_name': 'Combine 1',
                'source_type': 'text-upload',
                'text_input_mode': 'both',
                'result': 'Merged notes',
                'merged_notes': 'Merged notes',
                'slide_text': 'Slide source',
                'transcript': 'Transcript source',
            },
            {
                'row_id': 'row-2',
                'ordinal': 2,
                'status': 'complete',
                'source_name': 'Combine 2',
                'source_type': 'text-upload',
                'text_input_mode': 'transcript-only',
                'result': 'Transcript-only notes',
                'transcript': 'Transcript source only',
            },
        ],
    )
    monkeypatch.setattr(
        study_export,
        'markdown_to_docx',
        lambda markdown_text, title='Document', runtime=None: _SimpleDocx(f'{title}\n{markdown_text}'),
    )

    response = client.get('/api/batch/jobs/batch-combine/download.zip')

    assert response.status_code == 200
    archive = zipfile.ZipFile(io.BytesIO(response.data), 'r')
    names = archive.namelist()
    assert 'rows/row-1/result.docx' in names
    assert 'rows/row-1/slides.docx' in names
    assert 'rows/row-1/transcript.docx' in names
    assert 'rows/row-2/result.docx' in names
    assert 'rows/row-2/slides.docx' not in names
    assert 'rows/row-2/transcript.docx' in names
    combined_name = next(name for name in names if name.endswith('_Combined.docx'))
    combined_text = archive.read(combined_name).decode('utf-8')
    assert 'Combined Lecture Notes' in combined_text
    assert 'Slide Text' in combined_text
    assert 'Transcript source only' in combined_text
    row_meta = json.loads(archive.read('rows/row-1/meta.json').decode('utf-8'))
    assert row_meta['text_input_mode'] == 'both'


def test_batch_status_repairs_terminal_batch_with_incomplete_rows(monkeypatch):
    _clear_batch_memory()
    _patch_batch_refunds(monkeypatch)
    batch_id = 'batch-terminal-repair'
    batch_orchestrator.create_batch_job(
        {
            'batch_id': batch_id,
            'uid': 'u-batch',
            'email': 'batch@example.com',
            'mode': 'lecture-notes',
            'status': 'error',
            'batch_title': 'Broken batch',
            'total_rows': 2,
            'current_stage': 'slide_extraction',
            'current_stage_state': 'failed',
            'provider_state': 'FAILED',
            'completed_rows': 0,
            'failed_rows': 0,
            'completion_email_status': 'pending',
        },
        [
            {'row_id': 'row-1', 'ordinal': 1, 'status': 'queued', 'credit_deducted': 'lecture_credits_standard'},
            {'row_id': 'row-2', 'ordinal': 2, 'status': 'queued', 'credit_deducted': 'lecture_credits_standard'},
        ],
        runtime=core,
    )

    payload = batch_orchestrator.get_batch_status(batch_id, runtime=core)

    assert payload.get('status') == 'error'
    assert payload.get('failed_rows') == 2
    assert 'interrupted' in str(payload.get('error_message', '')).lower()
    assert all(str(row.get('status', '')) == 'error' for row in payload.get('rows', []))


def test_list_batches_repairs_stale_processing_batch(monkeypatch):
    _clear_batch_memory()
    _patch_batch_refunds(monkeypatch)
    now_holder = {'value': 100.0}
    monkeypatch.setattr(core.time, 'time', lambda: now_holder['value'])
    monkeypatch.setattr(batch_orchestrator, '_batch_recovery_stale_seconds', lambda runtime=None: 30)

    batch_id = batch_orchestrator.create_batch_job(
        {
            'batch_id': 'batch-stale-processing',
            'uid': 'u-batch',
            'email': 'batch@example.com',
            'mode': 'slides-only',
            'status': 'processing',
            'batch_title': 'Stale batch',
            'total_rows': 1,
            'current_stage': 'file_upload',
            'current_stage_state': 'running',
            'provider_state': 'FILE_UPLOAD',
            'completion_email_status': 'pending',
        },
        [
            {'row_id': 'row-1', 'ordinal': 1, 'status': 'processing', 'current_stage': 'file_upload', 'credit_deducted': 'slides_credits'},
        ],
        runtime=core,
    )

    now_holder['value'] = 1000.0
    rows = batch_orchestrator.list_batches_for_uid('u-batch', runtime=core)

    assert rows
    assert rows[0].get('batch_id') == batch_id


def test_batch_row_persistence_sanitizes_transient_provider_objects(monkeypatch):
    _clear_batch_memory()
    _patch_batch_refunds(monkeypatch)

    fake_file = _FakeProviderFile()
    batch_id = batch_orchestrator.create_batch_job(
        {
            'batch_id': 'batch-sanitized-row',
            'uid': 'u-batch',
            'email': 'batch@example.com',
            'mode': 'lecture-notes',
            'status': 'queued',
            'batch_title': 'Sanitized batch',
            'total_rows': 1,
        },
        [
            {
                'row_id': 'row-1',
                'ordinal': 1,
                'status': 'queued',
                'billing_receipt': {'charged': {'lecture_credits_standard': 1}, 'provider_file': fake_file},
                '_gemini_files': [fake_file],
                '_local_paths': ['uploads/tmp-a.mp3'],
                'provider_file': fake_file,
            },
        ],
        runtime=core,
    )

    stored_row = batch_orchestrator.get_batch_row(batch_id, 'row-1', runtime=core)

    assert stored_row is not None
    assert '_gemini_files' not in stored_row
    assert '_local_paths' not in stored_row
    assert 'provider_file' not in stored_row
    assert stored_row.get('billing_receipt', {}).get('provider_file') is None
    repaired = batch_orchestrator.get_batch(batch_id, runtime=core)
    assert repaired is not None
    assert repaired.get('batch_id') == batch_id
    assert repaired.get('status') == 'queued'


def test_batch_job_persistence_sanitizes_nonserializable_batch_objects(monkeypatch):
    _clear_batch_memory()
    _patch_batch_refunds(monkeypatch)

    fake_file = _FakeProviderFile()
    batch_id = batch_orchestrator.create_batch_job(
        {
            'batch_id': 'batch-sanitized-job',
            'uid': 'u-batch',
            'email': 'batch@example.com',
            'mode': 'lecture-notes',
            'status': 'queued',
            'batch_title': 'Sanitized batch job',
            'total_rows': 1,
            'external_batch_refs': {'provider_file': fake_file},
            'provider_file': fake_file,
        },
        [],
        runtime=core,
    )

    stored_batch = batch_orchestrator.get_batch(batch_id, runtime=core)

    assert stored_batch is not None
    assert stored_batch.get('provider_file') is None
    assert stored_batch.get('external_batch_refs', {}).get('provider_file') is None


def test_batch_completion_email_status_sent_is_persisted(monkeypatch):
    _clear_batch_memory()
    batch_id = 'batch-notify-sent'
    batch_orchestrator.create_batch_job(
        {
            'batch_id': batch_id,
            'uid': 'u-batch',
            'email': 'batch@example.com',
            'mode': 'lecture-notes',
            'status': 'processing',
            'batch_title': 'Batch Notify',
            'total_rows': 1,
            'completion_email_status': 'pending',
            'completion_email_sent_at': 0,
            'completion_email_error': '',
        },
        [],
        runtime=core,
    )
    sent = {'count': 0}

    def _fake_send(recipient_email, subject, body_text, runtime=None):
        _ = subject, body_text, runtime
        assert recipient_email == 'batch@example.com'
        sent['count'] += 1
        return 'sent', ''

    monkeypatch.setattr(batch_orchestrator, 'send_batch_completion_email', _fake_send)
    batch_orchestrator._send_batch_completion_email_if_needed(batch_id, 'complete', runtime=core)
    batch = batch_orchestrator.get_batch(batch_id, runtime=core)
    assert sent['count'] == 1
    assert batch.get('completion_email_status') == 'sent'
    assert float(batch.get('completion_email_sent_at', 0) or 0) > 0
    assert batch.get('completion_email_error', '') == ''


def test_batch_completion_email_status_skipped_when_missing_email(monkeypatch):
    _clear_batch_memory()
    batch_id = 'batch-notify-missing-email'
    batch_orchestrator.create_batch_job(
        {
            'batch_id': batch_id,
            'uid': 'u-batch',
            'email': '',
            'mode': 'slides-only',
            'status': 'processing',
            'batch_title': 'Batch Missing Email',
            'total_rows': 1,
            'completion_email_status': 'pending',
            'completion_email_sent_at': 0,
            'completion_email_error': '',
        },
        [],
        runtime=core,
    )

    batch_orchestrator._send_batch_completion_email_if_needed(batch_id, 'error', runtime=core)
    batch = batch_orchestrator.get_batch(batch_id, runtime=core)
    assert batch.get('completion_email_status') == 'skipped'
    assert 'missing recipient email' in str(batch.get('completion_email_error', '')).lower()


def test_batch_completion_email_status_skipped_when_disabled(monkeypatch):
    _clear_batch_memory()
    batch_id = 'batch-notify-disabled'
    batch_orchestrator.create_batch_job(
        {
            'batch_id': batch_id,
            'uid': 'u-batch',
            'email': 'batch@example.com',
            'mode': 'interview',
            'status': 'processing',
            'batch_title': 'Batch Disabled',
            'total_rows': 1,
            'completion_email_status': 'pending',
            'completion_email_sent_at': 0,
            'completion_email_error': '',
        },
        [],
        runtime=core,
    )

    monkeypatch.setattr(core, 'BATCH_EMAIL_NOTIFICATIONS_ENABLED', False)
    batch_orchestrator._send_batch_completion_email_if_needed(batch_id, 'partial', runtime=core)
    batch = batch_orchestrator.get_batch(batch_id, runtime=core)
    assert batch.get('completion_email_status') == 'skipped'
    assert 'disabled' in str(batch.get('completion_email_error', '')).lower()
