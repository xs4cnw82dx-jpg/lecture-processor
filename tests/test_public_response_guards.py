"""Public exports, canonical routing, and archived planner edits."""

from copy import deepcopy
import io
import json
from types import SimpleNamespace
import zipfile

import pytest

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.planner import study_plan
from lecture_processor.repositories import planner_repo
from lecture_processor.services import upload_batch_service


@pytest.fixture
def render_origin(monkeypatch, core):
    monkeypatch.setenv('RENDER_EXTERNAL_HOSTNAME', 'preview.onrender.com')
    monkeypatch.setattr(core, 'PUBLIC_BASE_URL', 'https://lectureprocessor.com')
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: None)


@pytest.mark.parametrize('method', ['GET', 'HEAD'])
@pytest.mark.parametrize('path', [
    '/missing-page',
    '/missing/nested-page?pack_id=pack%2Fone&label=why?',
])
def test_unknown_render_page_redirects_to_the_same_public_path(client, render_origin, method, path):
    response = client.open(path, method=method, base_url='https://preview.onrender.com')

    assert response.status_code == 301
    assert response.headers['Location'] == 'https://lectureprocessor.com' + path
    if method == 'HEAD':
        assert response.data == b''


@pytest.mark.parametrize('method,path,status', [
    ('GET', '/api/missing-route', 404),
    ('HEAD', '/api/missing-route', 404),
    ('GET', '/api', 404),
    ('GET', '/api/stripe-webhook/missing-route', 404),
    ('GET', '/api/stripe-webhook', 405),
    ('GET', '/healthz', 200),
    ('HEAD', '/healthz', 200),
    ('GET', '/healthz/missing-route', 404),
    ('GET', '/static/missing-file.js', 404),
    ('GET', '/static', 404),
    ('POST', '/missing-page', 404),
    ('OPTIONS', '/missing-page', 404),
    ('POST', '/study', 405),
])
def test_non_page_errors_stay_on_the_requested_origin(client, render_origin, method, path, status):
    response = client.open(path, method=method, base_url='https://preview.onrender.com')

    assert response.status_code == status
    assert 'Location' not in response.headers


@pytest.mark.parametrize('origin', [
    'https://lectureprocessor.com', 'http://localhost',
    'https://preview.onrender.com.unrelated.test',
])
def test_unknown_pages_on_other_hosts_keep_their_404(client, render_origin, origin):
    response = client.get('/missing-page', base_url=origin)

    assert response.status_code == 404
    assert 'Location' not in response.headers


@pytest.mark.parametrize('route_prefix', ['batch', 'instant-batch'])
@pytest.mark.parametrize('failure_kind', ['docx', 'csv'])
def test_batch_archive_keeps_diagnostics_in_logs_and_other_rows_downloadable(
    client, core, monkeypatch, caplog, route_prefix, failure_kind,
):
    diagnostic = 'Synthetic export failure at /internal/private.json?token=example-secret'
    batch = {
        'batch_id': 'export-safe', 'uid': 'owner', 'mode': 'lecture-notes',
        'status': 'complete', 'total_rows': 2, 'completed_rows': 2,
        'export_options': {'include_combined_docx': False},
    }
    rows = [
        {'row_id': 'failed-export', 'status': 'complete', 'flashcards': [{'front': 'Q', 'back': 'A'}]},
        {'row_id': 'good-export', 'status': 'complete', 'result': 'Synthetic result'},
    ]
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': 'owner'})
    monkeypatch.setattr(upload_batch_service.batch_orchestrator, 'get_batch', lambda *_args, **_kwargs: batch)
    monkeypatch.setattr(upload_batch_service.batch_orchestrator, 'get_batch_status', lambda *_args, **_kwargs: {'can_download_zip': True})
    monkeypatch.setattr(upload_batch_service.batch_orchestrator, 'list_batch_rows', lambda *_args, **_kwargs: deepcopy(rows))

    def export_docx(_runtime, row, **_kwargs):
        if row['row_id'] == 'failed-export' and failure_kind == 'docx':
            raise RuntimeError(diagnostic)
        return b'Synthetic document bytes'

    def export_csv(_runtime, _row, **_kwargs):
        raise ValueError(diagnostic)

    monkeypatch.setattr(upload_batch_service, 'batch_row_docx_bytes', export_docx)
    monkeypatch.setattr(upload_batch_service, 'batch_row_csv_bytes', export_csv)
    response = client.get(f'/api/{route_prefix}/jobs/export-safe/download.zip', buffered=False)
    try:
        assert response.status_code == 200
        assert response.mimetype == 'application/zip'
        payload = response.get_data()
        assert response.content_length == len(payload)
        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            assert archive.read('rows/failed-export/error.txt').decode() == 'Could not export this row. Please try again.'
            assert archive.read('rows/good-export/result.docx') == b'Synthetic document bytes'
            assert json.loads(archive.read('summary.json'))['completed_rows'] == 2
            for name in archive.namelist():
                assert diagnostic.encode() not in archive.read(name)
        assert diagnostic in caplog.text
        assert 'export-safe' in caplog.text
        assert 'failed-export' in caplog.text
    finally:
        response.close()


@pytest.fixture
def owned_goal(monkeypatch, core):
    planner_repo.clear_memory_state()
    monkeypatch.setattr(core, 'db', None)
    monkeypatch.setattr(core, 'is_email_allowed', lambda _email: True)
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': 'owner', 'email': 'owner@example.test'})
    monkeypatch.setattr(account_lifecycle, 'ensure_account_allows_writes', lambda _uid, runtime=None: (True, ''))
    pack = {'uid': 'owner', 'study_pack_id': 'pack', 'title': 'Synthetic pack', 'flashcards': [{'front': 'Q', 'back': 'A'}]}
    monkeypatch.setattr(core.study_repo, 'get_study_pack_doc', lambda _db, _pack: SimpleNamespace(exists=True, to_dict=lambda: deepcopy(pack)))
    goal, error = study_plan.sanitize_goal(
        {'title': 'Original goal', 'exam_date': '2030-11-20', 'pack_ids': ['pack']},
        goal_id='goal', now_ts=1000,
    )
    assert not error
    goal.update(uid='owner', revision=2, status='archived')
    planner_repo.set_study_goal(None, 'owner', 'goal', goal, merge=False)
    session = {
        'id': 'cancelled-session', 'goal_id': 'goal', 'date': '2030-11-19',
        'status': 'cancelled', 'cancellation_reason': 'goal_deleted', 'revision': 2,
    }
    planner_repo.set_planner_session(None, 'owner', 'cancelled-session', session)
    yield goal
    planner_repo.clear_memory_state()


@pytest.mark.parametrize('body', [
    {'status': 'active', 'revision': 2},
    {'status': 'active'},
    {'title': 'Changed title', 'revision': 2},
    {'status': 'invalid', 'revision': 2},
])
def test_archived_goal_patch_is_rejected_without_changing_goal_or_sessions(client, owned_goal, body):
    before_goal = planner_repo.get_study_goal(None, 'owner', 'goal').to_dict()
    before_session = planner_repo.get_planner_session(None, 'owner', 'cancelled-session').to_dict()

    response = client.patch('/api/study-plan/goals/goal', json=body)

    assert response.status_code == 409
    assert response.get_json() == {
        'error': 'This goal was deleted. Create a new goal to schedule these packs again.',
        'code': 'goal_archived',
    }
    assert planner_repo.get_study_goal(None, 'owner', 'goal').to_dict() == before_goal
    assert planner_repo.get_planner_session(None, 'owner', 'cancelled-session').to_dict() == before_session


@pytest.mark.parametrize('include_revision', [False, True])
def test_active_goal_patch_keeps_optional_revision_compatibility(client, owned_goal, include_revision):
    planner_repo.set_study_goal(None, 'owner', 'goal', {**owned_goal, 'status': 'active'}, merge=False)
    body = {'title': 'Saved title', 'status': 'active'}
    if include_revision:
        body['revision'] = 2

    response = client.patch('/api/study-plan/goals/goal', json=body)

    assert response.status_code == 200
    assert response.get_json()['goal']['title'] == 'Saved title'
    assert response.get_json()['goal']['revision'] == 3
    assert planner_repo.get_study_goal(None, 'owner', 'goal').to_dict()['status'] == 'active'


def test_archived_goal_guard_does_not_expose_another_owners_goal(client, core, owned_goal, monkeypatch):
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': 'other', 'email': 'other@example.test'})

    response = client.patch('/api/study-plan/goals/goal', json={'status': 'active'})

    assert response.status_code == 404
    assert response.get_json() == {'error': 'Study goal not found.'}
    assert planner_repo.get_study_goal(None, 'owner', 'goal').to_dict() == owned_goal
