"""Owner responses project usage without changing stored records."""
from copy import deepcopy
import json
import socket
from types import SimpleNamespace

from flask import Flask, jsonify, request
import pytest

from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.services import interview_coding_service, upload_runtime_service


LEGACY = {
    'input_tokens': 11, 'output_tokens': 10, 'total_tokens': 37,
    'model': 'synthetic-model', 'billing_mode': 'standard', 'input_modality': 'text',
}
ENRICHED = dict(LEGACY, provider='openrouter', thinking_tokens=3, cost_usd=0.125,
                future_private_metadata={'synthetic': 'private-marker'})
MISSING = object()


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*_args, **_kwargs):
        pytest.fail('Owner status tests must never use DNS or real sockets.')

    monkeypatch.setattr(socket, 'getaddrinfo', blocked)
    monkeypatch.setattr(socket.socket, 'connect', blocked)
    monkeypatch.setattr(socket.socket, 'connect_ex', blocked)


def response_for(boundary, usage, monkeypatch, *, administrator=False):
    original = {
        'status': 'complete', 'step': 3, 'step_description': 'Complete', 'result': 'Synthetic result',
        'user_id': 'synthetic-owner', 'uid': 'synthetic-owner', 'pack_id': 'synthetic-pack',
        'token_input_total': 11, 'token_output_total': 10, 'token_total': 37,
    }
    if usage is not MISSING:
        original['token_usage_by_stage'] = deepcopy(usage)
    before = deepcopy(original)
    captured = []

    def capture(payload):
        captured.append(payload)
        return jsonify(payload)

    app = Flask(__name__)
    runtime = SimpleNamespace(
        jsonify=capture, RUNTIME_JOB_RECOVERY_ENABLED=False,
        verify_firebase_token=lambda _request, **_kw: {
            'uid': 'synthetic-admin' if administrator else 'synthetic-owner'},
        is_admin_user=lambda _decoded: administrator,
    )
    with app.test_request_context('/api/status/synthetic-job'):
        if boundary == 'upload':
            monkeypatch.setattr(upload_runtime_service.runtime_jobs_store, 'get_job_snapshot',
                                lambda _id, runtime=None: original)
            response = upload_runtime_service.get_status(runtime, request, 'synthetic-job')
        else:
            doc = SimpleNamespace(id='synthetic-run', exists=True, to_dict=lambda: original)
            response = capture(interview_coding_service._serialize_run_doc(doc))
        assert response.status_code == 200
        body = response.get_json()
    assert original == before, 'Serializing an owner response must not alter internal records.'
    return body['token_usage_by_stage'], captured[0]['token_usage_by_stage'], original


@pytest.mark.parametrize('boundary', ['upload', 'coding'])
def test_enriched_usage_exposes_exactly_six_legacy_fields(boundary, monkeypatch):
    public, _serialized, original = response_for(boundary, {'merge': ENRICHED}, monkeypatch)
    assert public == {'merge': LEGACY}
    assert original['token_usage_by_stage']['merge'] == ENRICHED
    assert 'private-marker' not in json.dumps(public)


def test_administrator_bypass_still_returns_owner_safe_usage(monkeypatch):
    public, _serialized, original = response_for('upload', {'merge': ENRICHED}, monkeypatch, administrator=True)
    assert public == {'merge': LEGACY}
    assert original['token_usage_by_stage']['merge']['cost_usd'] == 0.125


@pytest.mark.parametrize('boundary', ['upload', 'coding'])
def test_mixed_and_partial_historical_fields_are_preserved_without_defaults_or_coercion(boundary, monkeypatch):
    historical = {'input_tokens': '7', 'model': None, 'billing_mode': '', 'arbitrary_future_field': 123}
    public, _serialized, _original = response_for(
        boundary, {'legacy': LEGACY, 'new': ENRICHED, 'partial': historical}, monkeypatch)
    assert public == {'legacy': LEGACY, 'new': LEGACY,
                      'partial': {'input_tokens': '7', 'model': None, 'billing_mode': ''}}


@pytest.mark.parametrize('boundary', ['upload', 'coding'])
def test_response_usage_has_fresh_outer_and_stage_dictionaries(boundary, monkeypatch):
    _public, serialized, original = response_for(boundary, {'merge': LEGACY}, monkeypatch)
    assert serialized is not original['token_usage_by_stage']
    assert serialized['merge'] is not original['token_usage_by_stage']['merge']
    serialized['merge']['model'] = 'consumer-modified'
    serialized['consumer-added'] = {}
    assert original['token_usage_by_stage'] == {'merge': LEGACY}


@pytest.mark.parametrize('boundary', ['upload', 'coding'])
@pytest.mark.parametrize('malformed', [None, 'synthetic malformed value', [], 17])
def test_malformed_top_level_usage_becomes_empty(boundary, malformed, monkeypatch):
    public, _serialized, _original = response_for(boundary, malformed, monkeypatch)
    assert public == {}


@pytest.mark.parametrize('boundary', ['upload', 'coding'])
def test_malformed_stage_records_are_skipped_and_valid_empty_records_retained(boundary, monkeypatch):
    usage = {'valid': LEGACY, 'none': None, 'text': 'synthetic malformed value', 'list': [1],
             'empty': {}, 'extra_only': {'provider': 'openrouter', 'cost_usd': 0}}
    public, _serialized, _original = response_for(boundary, usage, monkeypatch)
    assert public == {'valid': LEGACY, 'empty': {}, 'extra_only': {}}


@pytest.mark.parametrize('boundary', ['upload', 'coding'])
def test_legacy_shape_control(boundary, monkeypatch):
    public, _serialized, _original = response_for(boundary, {'merge': LEGACY}, monkeypatch)
    assert json.dumps(public, sort_keys=True) == json.dumps({'merge': LEGACY}, sort_keys=True)


@pytest.mark.parametrize('boundary', ['upload', 'coding'])
def test_missing_usage_control(boundary, monkeypatch):
    public, _serialized, _original = response_for(boundary, MISSING, monkeypatch)
    assert public == {}


@pytest.mark.parametrize('boundary', ['upload', 'coding'])
def test_internal_enrichment_retention_control(boundary, monkeypatch):
    _public, _serialized, original = response_for(boundary, {'merge': ENRICHED}, monkeypatch)
    assert original['token_usage_by_stage'] == {'merge': ENRICHED}


def test_batch_status_already_omits_stage_metadata_control(monkeypatch):
    batch = {'batch_id': 'synthetic-batch', 'status': 'complete', 'completed_rows': 1,
             'token_input_total': 11, 'token_output_total': 10, 'token_total': 37,
             'token_usage_by_stage': {'merge': ENRICHED}, 'cost_usd': 0.125}
    row = dict(batch, row_id='synthetic-row')
    before = deepcopy((batch, row))
    monkeypatch.setattr(batch_orchestrator, '_get_batch', lambda _id, runtime=None: batch)
    monkeypatch.setattr(batch_orchestrator, '_repair_batch_state_if_needed',
                        lambda *args, **kwargs: (batch, [row]))
    runtime = SimpleNamespace(time=SimpleNamespace(time=lambda: 1000))
    body = batch_orchestrator.get_batch_status('synthetic-batch', runtime=runtime)
    assert body['token_input_total'] == body['rows'][0]['token_input_total'] == 11
    assert body['token_output_total'] == body['rows'][0]['token_output_total'] == 10
    assert body['token_total'] == body['rows'][0]['token_total'] == 37
    for public in (body, body['rows'][0]):
        assert 'token_usage_by_stage' not in public and 'cost_usd' not in public
        assert 'thinking_tokens' not in public
    assert (batch, row) == before
