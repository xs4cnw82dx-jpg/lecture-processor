"""Planned answers, SRS and run receipts commit or fail as one operation."""
from copy import deepcopy
from types import SimpleNamespace
import pytest

from lecture_processor.services import planned_review_service as reviews, study_run_service as runs
from lecture_processor.domains.study import progress
from lecture_processor.repositories import planner_repo, study_repo
from tests.test_study_progress_rollup import Database
from tests.test_study_runs import create_session, start
from tests.test_study_plan_api import study_plan_runtime, _headers  # noqa: F401


def test_checkpoint_lost_response_replay_keeps_one_review(client, study_plan_runtime):
    create_session(client, study_plan_runtime)
    run = start(client)
    body = {**run, 'checkpoint_revision': 1, 'answers': {'fc_0': {'correct': True}},
            'pending_reviews': [{'id': 'fc_0', 'action': 'easy', 'key': 'fc_0:first'}]}
    endpoint = '/api/study-plan/runs/' + run['activity_id']
    first = client.put(endpoint, headers=_headers(), json=body)
    assert first.status_code == 200, first.get_json()
    # The first reply was lost; reload/another device resends the same durable action.
    replay = client.put(endpoint, headers=_headers(), json=body)
    assert replay.status_code == 200, replay.get_json()
    for response in [first, replay]:
        data = response.get_json()
        card = data['card_states'][study_plan_runtime['pack_id']]['fc_0']
        assert (card['seen'], card['correct'], card['interval_days']) == (1, 1, 4)
        assert data['summary']['today_progress'] == 1
        assert len(data['run']['review_receipts']) == 1
    persisted = start(client)
    assert persisted['review_receipts'] == first.get_json()['run']['review_receipts']


def setup_atomic(monkeypatch):
    db = Database()
    from google.cloud import firestore
    monkeypatch.setattr(firestore, 'transactional', db.transactional)
    monkeypatch.setattr(runs.lifecycle, 'require_account_access', lambda *_args, **_kwargs: None)
    app = SimpleNamespace(db=db, repositories=SimpleNamespace(planner=planner_repo, study=study_repo),
        time=SimpleNamespace(time=lambda: 1700000000),
        get_study_progress_doc=lambda uid: study_repo.study_progress_doc_ref(db, uid),
        get_study_card_state_doc=lambda uid, pack: study_repo.study_card_state_doc_ref(db, uid, pack))
    db.data['study_progress/owner'] = {'uid': 'owner', 'card_state_due_by_date_version': 1, 'card_state_due_by_date': {}}
    return app, db


def commit(app, run_id='run_test', action='good', retry=False):
    item = {'id': 'fc_0', 'type': 'fc', 'content_key': 'fc:stable-content:0'}
    body = {'pending_reviews': [{'id': 'fc_0', 'action': action, 'key': 'fc_0:' + ('retry' if retry else 'first')}]}
    def change(_session, run):
        run = run or {'uid': 'owner', 'pack_id': 'pack', 'activity_id': run_id, 'queue': [item],
                      'answers': {'fc_0': {'type': 'fc', 'correct': action != 'retry'}}, 'retry_done': []}
        if retry:
            run['retry_done'] = ['fc_0']
        return None, run, {'run': run}
    return runs._atomic(app, 'owner', 'session', run_id, change, review_body=body)


def test_atomic_failure_retry_and_cross_device_merge(monkeypatch):
    app, db = setup_atomic(monkeypatch)
    before = deepcopy(db.data)
    db.fail_commit = True
    with pytest.raises(RuntimeError, match='commit failure'):
        commit(app)
    assert db.data == before
    db.fail_commit = False
    first = commit(app)
    assert first['card_states']['pack']['fc_0']['seen'] == 1
    old_state = deepcopy(first['card_states']['pack'])
    retry = commit(app)
    assert retry['card_states']['pack']['fc_0']['seen'] == 1
    assert retry['summary']['today_progress'] == 1
    # A stale free-mode sync must not erase acknowledged server counters/intervals.
    stale = {'fc_0': {'seen': 0, 'device_counters': {'browser': {'flip_count': 1}}, 'updated_at': 1}}
    merged = progress.merge_card_state_maps(old_state, stale, runtime=app)
    assert merged['fc_0']['seen'] == 1
    assert merged['fc_0']['interval_days'] == 2
    assert merged['fc_0']['flip_count'] == 1


def test_first_retry_receipts_are_distinct_and_replay_safe(monkeypatch):
    app, db = setup_atomic(monkeypatch)
    first = commit(app, action='retry')
    second = commit(app, action='good', retry=True)
    replay = commit(app, action='good', retry=True)
    assert first['card_states']['pack']['fc_0']['wrong'] == 1
    card = second['card_states']['pack']['fc_0']
    assert (card['seen'], card['wrong'], card['correct']) == (2, 1, 1)
    assert replay['card_states'] == second['card_states']
    assert replay['summary']['today_progress'] == 2
    assert len(replay['run']['review_receipts']) == 2


def test_many_runs_use_one_counter_bucket_and_transaction_retries_once(monkeypatch):
    app, db = setup_atomic(monkeypatch)
    # A concurrent free-mode exposure wins the first commit; the retry must keep it.
    db.before_commit = lambda: app.get_study_card_state_doc('owner', 'pack').set({
        'state': {'fc_0': {'device_counters': {'browser': {'flip_count': 1}}}}})
    for index in range(40):
        result = commit(app, run_id='run_' + str(index))
    card = result['card_states']['pack']['fc_0']
    assert db.retries == 1
    assert card['seen'] == 40
    assert set(card['device_counters']) == {reviews.DEVICE, 'browser'}
    assert card['flip_count'] == 1
    assert result['summary']['today_progress'] == 40


def test_invalid_action_rolls_back_run_and_progress(monkeypatch):
    app, db = setup_atomic(monkeypatch)
    before = deepcopy(db.data)
    with pytest.raises(runs.RunError, match='does not belong'):
        commit(app, action='bogus')
    assert db.data == before


def test_notes_activity_records_streak_once_without_answer_credit(monkeypatch):
    app, db = setup_atomic(monkeypatch)
    def change(_session, run):
        run = run or {'uid': 'owner', 'pack_id': 'pack', 'activity_id': 'notes_run',
                      'queue': [], 'notes_seconds': 60}
        return None, run, {'run': run}
    first = runs._atomic(app, 'owner', 'session', 'notes_run', change, review_body={})
    before = deepcopy(db.data)
    replay = runs._atomic(app, 'owner', 'session', 'notes_run', change, review_body={})
    assert first['summary']['current_streak'] == 1
    assert first['summary']['today_progress'] == 0
    assert replay['run']['notes_activity_recorded'] is True
    assert db.data == before


def test_receipt_survives_same_content_moving_to_another_index(monkeypatch):
    app, db = setup_atomic(monkeypatch)
    commit(app)
    def change(_session, run):
        run['queue'][0]['id'] = 'fc_1'
        run['answers'] = {'fc_1': run['answers']['fc_0']}
        return None, run, {'run': run}
    body = {'pending_reviews': [{'id': 'fc_1', 'action': 'good', 'key': 'fc_1:first'}]}
    response = runs._atomic(app, 'owner', 'session', 'run_test', change, review_body=body)
    assert response['summary']['today_progress'] == 1
    assert len(response['run']['review_receipts']) == 1
    assert 'fc_1' not in response['card_states']['pack']


def test_full_existing_device_map_fails_without_losing_progress(monkeypatch):
    app, db = setup_atomic(monkeypatch)
    db.data['study_card_states/owner__pack'] = {'state': {'fc_0': {
        'device_counters': {'device_' + str(index): {'seen': 1} for index in range(32)}}}}
    before = deepcopy(db.data)
    with pytest.raises(runs.RunError, match='device limit'):
        commit(app)
    assert db.data == before


@pytest.mark.parametrize('field', ['id', 'action', 'key'])
def test_malformed_action_fields_are_rejected(field, monkeypatch):
    app, db = setup_atomic(monkeypatch)
    run = {'queue': [{'id': 'fc_0', 'type': 'fc'}]}
    action = {'id': 'fc_0', 'action': 'good', 'key': 'fc_0:first', field: []}
    with pytest.raises(ValueError, match='invalid'):
        reviews.prepare(app, 'owner', run, {'pending_reviews': [action]})
