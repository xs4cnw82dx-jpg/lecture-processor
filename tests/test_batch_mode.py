import io
import json

import pytest

from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.upload import import_audio as upload_import_audio
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
    pass


class _FakeProviderFile:
    def __init__(self, label='provider-file'):
        self.label = label


def _patch_batch_auth(monkeypatch):
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': 'u-batch', 'email': 'batch@example.com'})
    monkeypatch.setattr(auth_policy, 'is_email_allowed', lambda _email, runtime=None: True)


def _clear_batch_memory():
    jobs = getattr(core, '_BATCH_JOBS_MEMORY', None)
    rows = getattr(core, '_BATCH_ROWS_MEMORY', None)
    if isinstance(jobs, dict):
        jobs.clear()
    if isinstance(rows, dict):
        rows.clear()


def _patch_batch_refunds(monkeypatch):
    monkeypatch.setattr(core, 'db', None)
    monkeypatch.setattr(billing_credits, 'refund_credit', lambda *_args, **_kwargs: True)
    monkeypatch.setattr(billing_credits, 'refund_slides_credits', lambda *_args, **_kwargs: True)
    monkeypatch.setattr(billing_receipts, 'add_job_credit_refund', lambda *args, **kwargs: None)
    monkeypatch.setattr(core, 'save_job_log', lambda *args, **kwargs: None)
    monkeypatch.setattr(batch_orchestrator, 'send_batch_completion_email', lambda *args, **kwargs: ('skipped', 'disabled in test'))


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
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(upload_import_audio, 'cleanup_expired_audio_import_tokens', lambda runtime=None: None)
    monkeypatch.setattr(core, 'threading', type('T', (), {'Thread': _DummyThread}))
    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
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

    rows = [
        {'row_id': 'row-1', 'slides_file_field': 'row_1_slides'},
        {'row_id': 'row-2', 'slides_file_field': 'row_2_slides'},
    ]
    response = client.post(
        '/api/batch/jobs',
        data={
            'mode': 'slides-only',
            'batch_title': 'Batch test',
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
    assert isinstance(capture.rows, list)
    assert len(capture.rows) == 2
    assert capture.rows[0].get('billing_mode') == 'batch'


def test_batch_create_lecture_notes_preserves_row_study_override_contract(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(upload_import_audio, 'cleanup_expired_audio_import_tokens', lambda runtime=None: None)
    monkeypatch.setattr(core, 'threading', type('T', (), {'Thread': _DummyThread}))
    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
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
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(upload_import_audio, 'cleanup_expired_audio_import_tokens', lambda runtime=None: None)
    monkeypatch.setattr(core, 'threading', type('T', (), {'Thread': _DummyThread}))
    monkeypatch.setattr(
        core,
        'get_or_create_user',
        lambda uid, email: {
            'uid': uid,
            'email': email,
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
            }
        ],
    )

    response = client.get('/api/batch/jobs?status=queued&mode=lecture-notes')

    assert response.status_code == 200
    body = response.get_json()
    assert isinstance(body.get('batches'), list)
    assert body['batches'][0]['batch_id'] == 'batch-1'
    assert body['batches'][0]['status'] == 'queued'


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
    assert body.get('completion_email_status') == 'pending'


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
