from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import csv
from io import StringIO
import json
from threading import Barrier
from types import SimpleNamespace
import uuid

from flask import Flask, Response, jsonify, request, stream_with_context
import pytest

from lecture_processor.repositories import admin_credit_grants_repo, users_repo
from lecture_processor.services import admin_api_service, admin_dashboard_service
from tests.credit_test_support import make_credit_runtime


def legacy_user():
    return {
        'uid': 'u1', 'email': 'target@example.test', 'email_normalized': 'target@example.test',
        'lecture_credits_standard': 1, 'lecture_credits_extended': 0, 'slides_credits': 2,
        'interview_credits_short': 3, 'interview_credits_medium': 0, 'interview_credits_long': 0,
        'unlimited_credits': {'lecture': False, 'slides': True, 'interview': False},
        'account_status': 'active',
    }


def admin_runtime(*, user=None, enabled=True, documents=None):
    runtime, store = make_credit_runtime(users={'u1': user or legacy_user()}, documents=documents, unified_enabled=enabled)
    runtime.repositories = SimpleNamespace(users=users_repo, admin_credit_grants=admin_credit_grants_repo)
    runtime.firestore.Query = SimpleNamespace(DESCENDING='DESCENDING')
    runtime.uuid = uuid
    runtime.jsonify = jsonify
    runtime.verify_firebase_token = lambda _request, **_kwargs: {'uid': 'admin-u', 'email': 'admin@example.test'}
    runtime.is_admin_user = lambda token: token.get('uid') == 'admin-u'
    return runtime, store


def call(runtime, handler, *, payload=None, path='/', uid=True, headers=None):
    app = Flask(__name__)
    with app.test_request_context(path, method='POST' if payload is not None else 'GET', json=payload, headers=headers):
        result = handler(runtime, request, 'u1') if uid else handler(runtime, request)
        response, status = result if isinstance(result, tuple) else (result, 200)
        return status, response.get_json()


@pytest.mark.parametrize('enabled', [False, True])
def test_stored_unified_balance_grant_is_scalar_even_when_activation_is_off(enabled):
    user = dict(legacy_user(), credits_version=2, credits=30, legacy_credits_snapshot={'slides_credits': 2})
    runtime, store = admin_runtime(user=user, enabled=enabled)

    status, body = call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': 5, 'ref': 'support-1', 'note': 'Synthetic support'})

    assert status == 200
    assert body['user']['credits'] == 35
    assert body['user']['credits_version'] == 2
    assert body['grant']['credits'] == 5
    assert body['grant']['credit_scheme'] == 2
    assert store.docs('users')['u1']['legacy_credits_snapshot'] == {'slides_credits': 2}
    assert body['user']['effective_unlimited'] == {'lecture': False, 'slides': True, 'interview': False}


def test_activated_admin_grant_converts_existing_balance_once_in_the_grant_transaction():
    runtime, store = admin_runtime()
    before = deepcopy(store.docs('users')['u1'])

    status, body = call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': 5, 'ref': 'support-1'})

    assert status == 200
    assert body['user']['credits'] == 47
    saved = store.docs('users')['u1']
    assert saved['legacy_credits_snapshot'] == {key: before[key] for key in before if key.endswith('_credits_standard') or key.endswith('_credits_extended') or key == 'slides_credits' or key.startswith('interview_credits_')}
    assert all(saved[key] == 0 for key in saved['legacy_credits_snapshot'])
    assert len(store.commits) == 1
    assert {operation[1].path[0] for operation in store.commits[0]} == {'users', 'admin_credit_grants'}


def test_admin_search_and_history_preserve_scalar_and_historical_credit_shapes():
    user = dict(legacy_user(), credits_version=2, credits=30)
    historical = {'uid': 'u1', 'credits': {'slides_credits': 2}, 'credit_categories': {'slides': 2}, 'created_at': 1}
    unified = {'uid': 'u1', 'credits': 8, 'credit_scheme': 2, 'created_at': 2}
    runtime, _store = admin_runtime(user=user, enabled=False, documents={('admin_credit_grants', 'old'): historical, ('admin_credit_grants', 'new'): unified})

    status, body = call(runtime, admin_api_service.admin_user_search, path='/?email=target@example.test', uid=False)
    assert status == 200
    assert body['user']['credits'] == 30
    assert body['user']['credits_version'] == 2
    status, body = call(runtime, admin_api_service.admin_credit_grants, uid=False)
    assert status == 200
    assert [record['credits'] for record in body['grants']] == [8, {'slides_credits': 2}]
    assert 'credit_scheme' not in body['grants'][1]


def test_disabled_unconverted_grant_keeps_existing_response_shape():
    runtime, store = admin_runtime(enabled=False)
    status, body = call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': {'lecture': 2, 'slides': 4, 'interview': 1}, 'note': 'Legacy support'})
    assert status == 200
    assert body['user']['credits'] == {'lecture': 3, 'slides': 6, 'interview': 4}
    assert body['grant']['credits'] == {'lecture_credits_standard': 2, 'slides_credits': 4, 'interview_credits_short': 1}
    assert 'credits_version' not in body['user']
    assert 'credit_scheme' not in body['grant']
    assert 'credits' not in store.docs('users')['u1']


@pytest.mark.parametrize('value', [-1, 0, 1.5, True, '5', 10001, None])
def test_unified_grant_rejects_invalid_quantities_without_writes(value):
    runtime, store = admin_runtime()
    before = deepcopy(store.documents)
    status, _body = call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': value})
    assert status == 400
    assert store.documents == before


@pytest.mark.parametrize('user,enabled,amount', [(legacy_user(), False, 5), (dict(legacy_user(), credits_version=2, credits=8), False, {'slides': 1})])
def test_grants_require_the_transaction_selected_credit_shape(user, enabled, amount):
    runtime, store = admin_runtime(user=user, enabled=enabled)
    before = deepcopy(store.documents)
    status, _body = call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': amount})
    assert status == 400
    assert store.documents == before


def test_stable_grant_replay_does_not_repeat_conversion_or_credit():
    runtime, store = admin_runtime()
    payload = {'credits': 7, 'ref': 'same-request', 'note': 'One adjustment'}
    first = call(runtime, admin_api_service.admin_grant_user_credits, payload=payload)
    runtime.UNIFIED_CREDITS_ENABLED = False
    second = call(runtime, admin_api_service.admin_grant_user_credits, payload=payload)
    assert first == second
    assert first[0] == 200
    assert store.docs('users')['u1']['credits'] == 49
    assert len(store.docs('admin_credit_grants')) == 1


@pytest.mark.parametrize('change', [{'credits': 8}, {'note': 'Different purpose'}, {'actor': 'other-admin'}])
def test_reused_reference_cannot_authorize_a_different_grant(change):
    runtime, store = admin_runtime()
    payload = {'credits': 7, 'ref': 'bound-request', 'note': 'One adjustment'}
    assert call(runtime, admin_api_service.admin_grant_user_credits, payload=payload)[0] == 200
    if 'actor' in change:
        runtime.verify_firebase_token = lambda _request, **_kwargs: {'uid': 'other-admin', 'email': 'other@example.test'}
        runtime.is_admin_user = lambda _token: True
    else:
        payload.update(change)
    status, _body = call(runtime, admin_api_service.admin_grant_user_credits, payload=payload)
    assert status == 409
    assert store.docs('users')['u1']['credits'] == 49
    assert len(store.docs('admin_credit_grants')) == 1


def test_failed_grant_record_write_rolls_back_conversion_and_balance():
    runtime, store = admin_runtime()
    before = deepcopy(store.documents)
    def reject_grant(operations):
        store.fail_writes.update(ref.path for _operation, ref, _payload, _merge in operations if ref.path[0] == 'admin_credit_grants')
    store.before_commit = reject_grant
    status, _body = call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': 7, 'ref': 'failure'})
    assert status == 500
    assert store.documents == before


def test_retry_after_lost_commit_acknowledgement_does_not_grant_twice():
    runtime, store = admin_runtime()
    def lose_ack(_operations):
        store.after_commit = None
        raise RuntimeError('Synthetic lost commit acknowledgement')
    store.after_commit = lose_ack
    payload = {'credits': 7, 'ref': 'retry-after-ack-loss'}
    assert call(runtime, admin_api_service.admin_grant_user_credits, payload=payload)[0] == 500
    assert call(runtime, admin_api_service.admin_grant_user_credits, payload=payload)[0] == 200
    assert store.docs('users')['u1']['credits'] == 49
    assert len(store.docs('admin_credit_grants')) == 1


@pytest.mark.parametrize('same_ref', [False, True])
def test_concurrent_grants_serialize_conversion_and_replay(same_ref):
    runtime, store = admin_runtime()
    barrier = Barrier(2)
    def grant(index):
        barrier.wait(timeout=3)
        return call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': 7, 'ref': 'same' if same_ref else f'grant-{index}'})
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(grant, range(2)))
    assert [result[0] for result in results] == [200, 200]
    assert store.docs('users')['u1']['credits'] == 42 + (7 if same_ref else 14)
    assert len(store.docs('admin_credit_grants')) == (1 if same_ref else 2)
    assert store.docs('users')['u1']['legacy_credits_snapshot']['lecture_credits_standard'] == 1


@pytest.mark.parametrize('marker', ['requested', 'purging', 'deleted'])
def test_account_deletion_tombstones_block_grants_before_any_mutation(marker):
    runtime, store = admin_runtime(documents={('account_deletions', 'u1'): {'status': marker}})
    before = deepcopy(store.documents)
    status, _body = call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': 7})
    assert status == 409
    assert store.documents == before


def test_account_state_read_failure_fails_closed():
    runtime, store = admin_runtime()
    store.fail_reads.add(('account_deletions', 'u1'))
    before = deepcopy(store.documents)
    status, _body = call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': 7})
    assert status == 503
    assert store.documents == before


def test_unlimited_update_preserves_other_actions_and_normalizes_atomically():
    runtime, store = admin_runtime()
    status, body = call(runtime, admin_api_service.admin_update_user_unlimited, payload={'unlimited': {'lecture': True}, 'ref': 'entitlement'})
    assert status == 200
    assert body['user']['credits'] == 42
    assert body['user']['unlimited'] == {'lecture': True, 'slides': True, 'interview': False}
    assert body['grant']['credits'] == 0
    assert len(store.commits) == 1
    assert store.docs('users')['u1']['credits_version'] == 2


@pytest.mark.parametrize('value', [-1, True, '8', None])
def test_invalid_stored_unified_balance_does_not_change_money(value):
    runtime, store = admin_runtime(user=dict(legacy_user(), credits_version=2, credits=value))
    before = deepcopy(store.documents)
    status, _body = call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': 7})
    assert status == 503
    assert store.documents == before


def test_account_deletion_started_after_authentication_blocks_transaction():
    runtime, store = admin_runtime()
    original = deepcopy(store.docs('users')['u1'])
    def authenticate(_request, **_kwargs):
        store.documents[('account_deletions', 'u1')] = {'status': 'requested'}
        return {'uid': 'admin-u', 'email': 'admin@example.test'}
    runtime.verify_firebase_token = authenticate
    status, _body = call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': 7})
    assert status == 409
    assert store.docs('users')['u1'] == original
    assert store.docs('admin_credit_grants') == {}


def test_transaction_callback_retry_commits_one_conversion_and_grant():
    runtime, store = admin_runtime()
    def retry_once(callback):
        def execute(transaction):
            with store.lock:
                callback(transaction)
                # Firestore discards writes from an aborted attempt before retrying.
                retried = runtime.db.transaction()
                result = callback(retried)
                retried.commit()
                return result
        return execute
    runtime.firestore.transactional = retry_once
    status, body = call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': 7, 'request_id': 'retry'})
    assert status == 200
    assert body['user']['credits'] == 49
    assert len(store.commits) == 1
    assert len(store.docs('admin_credit_grants')) == 1


def test_header_reference_matches_body_reference_without_duplicate_credit():
    runtime, store = admin_runtime()
    first = call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': 7}, headers={'Idempotency-Key': 'header-ref'})
    second = call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': 7, 'ref': 'header-ref'})
    assert first == second
    assert first[0] == 200
    assert store.docs('users')['u1']['credits'] == 49


@pytest.mark.parametrize('enabled', [False, True])
def test_stored_v2_ignores_obsolete_legacy_balance_fields(enabled):
    user = dict(legacy_user(), credits_version=2, credits=8, slides_credits='obsolete')
    runtime, store = admin_runtime(user=user, enabled=enabled)
    status, body = call(runtime, admin_api_service.admin_grant_user_credits, payload={'credits': 7})
    assert status == 200
    assert body['user']['credits'] == 15
    assert store.docs('users')['u1']['credits'] == 15


def test_admin_search_reports_invalid_unified_balance_without_changing_it():
    runtime, store = admin_runtime(user=dict(legacy_user(), credits_version=2, credits='invalid'))
    before = deepcopy(store.documents)
    status, body = call(runtime, admin_api_service.admin_user_search, path='/?email=target@example.test', uid=False)
    assert status == 503
    assert body['error']
    assert store.documents == before


def dashboard_runtime(monkeypatch, *, include_unified=True):
    records = {
        ('purchases', 'old'): {'uid': 'u1', 'bundle_name': 'Old', 'price_cents': 999, 'credits': {'slides_credits': 2}, 'created_at': 1},
        ('job_logs', 'old'): {'job_id': 'old', 'uid': 'u1', 'status': 'complete', 'credit_deducted': 'slides_credits', 'credit_refunded': False, 'finished_at': 1},
    }
    if include_unified:
        records.update({
            ('purchases', 'new'): {'uid': 'u1', 'bundle_name': 'New', 'price_cents': 1999, 'credits': 24, 'legacy_credits': {'slides_credits': 12}, 'credit_scheme': 2, 'created_at': 2},
            ('job_logs', 'new'): {'job_id': 'new', 'uid': 'u1', 'status': 'error', 'credit_scheme': 2, 'charge_ref': 'job:new', 'charged_credits': 8, 'refunded_credits': 8, 'finished_at': 2},
        })
    runtime, store = admin_runtime(enabled=False, documents=records)
    runtime.csv, runtime.json = csv, json
    runtime.Response, runtime.stream_with_context = Response, stream_with_context
    runtime.ANALYTICS_FUNNEL_STAGES = []
    metrics = admin_dashboard_service.admin_metrics
    monkeypatch.setattr(metrics, 'get_admin_window', lambda *_args, **_kwargs: ('7d', 604800))
    monkeypatch.setattr(metrics, 'get_model_pricing_config', lambda **_kwargs: {})
    monkeypatch.setattr(metrics, 'admin_job_filters', lambda **_kwargs: [])
    monkeypatch.setattr(metrics, 'is_admin_visible_job', lambda *_args, **_kwargs: True)
    monkeypatch.setattr(metrics, 'compute_job_stage_costs', lambda *_args, **_kwargs: {})
    monkeypatch.setattr(metrics, 'safe_query_docs_in_window', lambda collection_name, **_kwargs: list(runtime.db.collection(collection_name).stream()))
    return runtime, store


def export_rows(runtime, kind):
    app = Flask(__name__)
    with app.test_request_context(f'/?type={kind}'):
        response = admin_dashboard_service.admin_export(runtime, request)
        assert response.status_code == 200
        return list(csv.reader(StringIO(response.get_data(as_text=True))))


def test_mixed_purchase_export_preserves_legacy_breakdown_and_scalar_units(monkeypatch):
    runtime, _store = dashboard_runtime(monkeypatch)
    rows = export_rows(runtime, 'purchases')
    records = [dict(zip(rows[0], row)) for row in rows[1:]]
    assert json.loads(records[0]['credits']) == {'slides_credits': 2}
    assert records[0]['credit_scheme'] == ''
    assert json.loads(records[1]['credits']) == 24
    assert records[1]['credit_scheme'] == '2'
    assert json.loads(records[1]['legacy_credits']) == {'slides_credits': 12}


def test_mixed_job_export_identifies_scalar_charge_and_refund_units(monkeypatch):
    runtime, _store = dashboard_runtime(monkeypatch)
    rows = export_rows(runtime, 'jobs')
    records = [dict(zip(rows[0], row)) for row in rows[1:]]
    assert records[0]['credit_deducted'] == 'slides_credits'
    assert records[0]['charged_credits'] == ''
    assert records[1]['credit_scheme'] == '2'
    assert records[1]['charge_ref'] == 'job:new'
    assert records[1]['charged_credits'] == records[1]['refunded_credits'] == '8'


@pytest.mark.parametrize('kind,expected', [
    ('purchases', ['uid', 'bundle_id', 'bundle_name', 'price_cents', 'currency', 'credits', 'stripe_session_id', 'created_at']),
    ('jobs', ['job_id', 'uid', 'email', 'mode', 'source_type', 'source_url', 'custom_prompt', 'custom_prompt_length', 'prompt_template_key', 'prompt_source', 'status', 'credit_deducted', 'credit_refund_method', 'credit_refunded', 'error_message', 'started_at', 'finished_at', 'duration_seconds', 'token_input_total', 'token_output_total', 'token_total', 'cost_usd', 'cost_eur']),
])
def test_legacy_only_exports_keep_the_original_header(monkeypatch, kind, expected):
    runtime, _store = dashboard_runtime(monkeypatch, include_unified=False)
    rows = export_rows(runtime, kind)
    assert rows[0] == expected
    assert len(rows) == 2


def test_dashboard_and_rollups_keep_counts_and_revenue_separate_from_credit_units(monkeypatch):
    runtime, _store = dashboard_runtime(monkeypatch)
    metrics = admin_dashboard_service.admin_metrics
    rollups = admin_dashboard_service.admin_rollups
    aggregate = rollups._aggregate_bucket_from_source('1970-01-01', 'daily', runtime=runtime)
    assert aggregate['purchases'] == {'count': 2, 'total_revenue_cents': 2998}
    assert aggregate['jobs']['total'] == 2
    assert aggregate['jobs']['refunded'] == 1
    monkeypatch.setattr(rollups, 'load_window_rollups', lambda *_args, **_kwargs: [aggregate])
    monkeypatch.setattr(metrics, 'safe_count_collection', lambda *_args, **_kwargs: 2)
    monkeypatch.setattr(metrics, 'safe_count_window', lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(metrics, 'build_time_buckets', lambda *_args, **_kwargs: (['Day 1'], ['1970-01-01'], 'daily'))
    monkeypatch.setattr(metrics, 'get_admin_data_warnings', lambda **_kwargs: [])
    monkeypatch.setattr(metrics, 'build_admin_deployment_info', lambda *_args, **_kwargs: {})
    monkeypatch.setattr(metrics, 'build_admin_runtime_checks', lambda **_kwargs: {})

    status, body = call(runtime, admin_dashboard_service.admin_overview, uid=False)

    assert status == 200
    assert body['metrics']['purchase_count'] == 2
    assert body['metrics']['total_revenue_cents'] == 2998
    assert body['metrics']['refunded_jobs'] == 1
    old_job, new_job = body['recent_jobs']
    assert 'credit_scheme' not in old_job
    assert new_job['credit_scheme'] == 2
    assert new_job['charged_credits'] == new_job['refunded_credits'] == 8
    old_purchase, new_purchase = body['recent_purchases']
    assert 'credits' not in old_purchase
    assert new_purchase['credits'] == 24
    assert new_purchase['legacy_credits'] == {'slides_credits': 12}
