import io
import json

import pytest

from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.billing import credits as billing_credits
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


def _patch_batch_auth(monkeypatch):
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': 'u-batch', 'email': 'batch@example.com'})
    monkeypatch.setattr(auth_policy, 'is_email_allowed', lambda _email, runtime=None: True)


def test_batch_create_requires_minimum_two_rows(client, monkeypatch):
    _patch_batch_auth(monkeypatch)

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


def test_batch_create_slides_only_contract(client, monkeypatch):
    _patch_batch_auth(monkeypatch)
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
    assert isinstance(capture.rows, list)
    assert len(capture.rows) == 2
    assert capture.rows[0].get('billing_mode') == 'batch'


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
