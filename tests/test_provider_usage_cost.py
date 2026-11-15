"""Usage and cost accounting with synthetic provider records and tariffs."""
from copy import deepcopy
import csv
import io
from types import SimpleNamespace

import pytest
from openpyxl import load_workbook

from lecture_processor.domains.admin import metrics
from lecture_processor.domains.ai.provider import TokenAccumulator
from lecture_processor.domains.ai.providers.contracts import GenerationResult, Usage


MODEL = 'synthetic-cost-model'
LEGACY_JOB_FIELDS = [
    'job_id', 'uid', 'email', 'mode', 'status', 'finished_at', 'billing_mode', 'is_batch',
    'batch_parent_id', 'batch_row_id', 'token_input_total', 'token_output_total', 'token_total',
    'cost_usd', 'cost_eur', 'missing_stage_usage',
]
LEGACY_STAGE_FIELDS = [
    'job_id', 'stage', 'model', 'tier', 'billing_mode', 'input_modality', 'input_tokens',
    'output_tokens', 'total_tokens', 'input_rate_per_million', 'output_rate_per_million',
    'cost_input_usd', 'cost_output_usd', 'cost_usd', 'cost_eur', 'matched_pricing',
]
LEGACY_CSV_FIELDS = [
    'job_id', 'uid', 'email', 'mode', 'source_type', 'source_url', 'custom_prompt',
    'custom_prompt_length', 'prompt_template_key', 'prompt_source', 'status', 'credit_deducted',
    'credit_refund_method', 'credit_refunded', 'error_message', 'started_at', 'finished_at',
    'duration_seconds', 'token_input_total', 'token_output_total', 'token_total', 'cost_usd', 'cost_eur',
]


class _Doc:
    def __init__(self, doc_id, payload):
        self.id = doc_id
        self.payload = payload

    def to_dict(self):
        return dict(self.payload)


@pytest.fixture
def reporting(monkeypatch, core, runtime, tariffs):
    from lecture_processor.domains.ai import batch_orchestrator

    # Patch the runtime used by the routes, including any existing instance
    # overrides, and restore its exact dictionary when this fixture exits.
    monkeypatch.setitem(runtime.__dict__, 'verify_firebase_token',
                        lambda _request, **_kwargs: {'uid': 'cost-admin'})
    monkeypatch.setitem(runtime.__dict__, 'is_admin_user', lambda _decoded: True)
    monkeypatch.setattr(core, 'run_startup_recovery_once', lambda: None)
    monkeypatch.setattr(batch_orchestrator, 'run_startup_batch_recovery_once', lambda runtime=None: None)
    monkeypatch.setattr(core, 'db', None)
    monkeypatch.setattr(metrics, 'get_model_pricing_config', lambda runtime=None: tariffs)
    docs = []
    queries = []

    def query(**kwargs):
        queries.append(kwargs)
        return docs

    monkeypatch.setattr(metrics, 'safe_query_docs_in_window', query)

    def add(doc_id, stages, **extra):
        value = dict(job(stages), job_id=doc_id, email='cost@example.test',
                     status='complete', finished_at=core.time.time() - 1, **extra)
        docs.append(_Doc(doc_id, value))

    return SimpleNamespace(add=add, queries=queries)


@pytest.fixture
def tariffs():
    return {'version': 'synthetic', 'pricing_table': {MODEL: {'standard': {
        'input_text_per_M': 2.0, 'output_per_M': 3.0,
    }}}}


def stage(*, provider=None, cost='absent', model=MODEL):
    result = {'input_tokens': 1_000_000, 'output_tokens': 2_000_000, 'total_tokens': 9_000_000,
              'model': model, 'billing_mode': 'standard', 'input_modality': 'text'}
    if provider is not None:
        result.update(provider=provider, thinking_tokens=500_000)
    if cost != 'absent':
        result['cost_usd'] = cost
    return result


def job(stages):
    return {'token_usage_by_stage': stages, 'finished_at': 1_800_000_000,
            'billing_multiplier': 0.5}


@pytest.mark.parametrize('reported', [0, 0.0, 2.5])
def test_reported_cost_including_zero_takes_precedence_over_tariff(tariffs, reported):
    source = stage(provider='openrouter', cost=reported)
    result = metrics.compute_job_stage_costs(job({'merge': source}), tariffs)
    cost = result['stages'][0]
    assert cost['cost_usd'] == result['cost_usd'] == reported
    assert cost['estimated_cost_usd'] == result['estimated_cost_usd'] == 8.0
    assert cost['cost_input_usd'] == 2.0
    assert cost['cost_output_usd'] == 6.0
    assert cost['cost_components_source'] == 'tariff_estimate'
    assert cost['cost_source'] == result['cost_source'] == 'provider_reported'
    assert cost['thinking_tokens'] == 500_000
    assert result['output_tokens'] == 2_000_000
    assert result['total_tokens'] == 9_000_000
    assert source == stage(provider='openrouter', cost=reported)


@pytest.mark.parametrize('reported', [None, -1, True, False, float('nan'), float('inf'), -float('inf'), 'bad', '0.1'])
def test_invalid_reported_cost_uses_estimate_without_contaminating_totals(tariffs, reported):
    result = metrics.compute_job_stage_costs(job({'merge': stage(provider='openrouter', cost=reported)}), tariffs)
    assert result['cost_usd'] == result['estimated_cost_usd'] == 8.0
    assert result['cost_source'] == result['stages'][0]['cost_source'] == 'tariff_estimate'


def test_reported_cost_does_not_require_a_known_tariff():
    result = metrics.compute_job_stage_costs(job({'merge': stage(provider='openrouter', cost=2.5)}), {})
    assert result['cost_usd'] == 2.5
    assert result['estimated_cost_usd'] == 0.0
    assert result['stages'][0]['matched_pricing'] is False
    assert result['cost_source'] == 'provider_reported'


def test_mixed_actual_zero_and_estimated_stages_have_one_consistent_total(tariffs):
    result = metrics.compute_job_stage_costs(job({
        'audio': stage(), 'merge': stage(provider='openrouter', cost=2.5),
        'slides': stage(provider='openrouter', cost=0), 'combine': stage(provider='openrouter'),
    }), tariffs)
    assert result['cost_usd'] == sum(item['cost_usd'] for item in result['stages']) == 18.5
    assert result['estimated_cost_usd'] == 32.0
    assert result['cost_source'] == 'mixed'
    assert result['input_tokens'] == 4_000_000
    assert result['output_tokens'] == 8_000_000
    assert result['total_tokens'] == 36_000_000
    assert 'provider' not in result['stages'][0]
    assert 'cost_source' not in result['stages'][0]


def test_legacy_calculation_shape_is_exact_even_with_unrecognized_cost_metadata(tariffs):
    original = stage(provider='fake', cost=0)
    result = metrics.compute_job_stage_costs(job({'audio': original}), tariffs)
    assert result == {'stages': [{
        'stage': 'audio', 'model': MODEL, 'billing_mode': 'standard', 'input_modality': 'text',
        'input_tokens': 1_000_000, 'output_tokens': 2_000_000, 'total_tokens': 9_000_000,
        'input_rate_per_million': 2.0, 'output_rate_per_million': 3.0, 'tier': '',
        'cost_input_usd': 2.0, 'cost_output_usd': 6.0, 'cost_usd': 8.0, 'matched_pricing': True,
    }], 'input_tokens': 1_000_000, 'output_tokens': 2_000_000, 'total_tokens': 9_000_000,
       'cost_usd': 8.0, 'missing_stage_usage': False}


@pytest.mark.parametrize('provider', ['gemini', 'fake'])
def test_normalized_legacy_result_preserves_old_accumulator_shape(provider):
    recorder = TokenAccumulator(runtime=SimpleNamespace())
    result = GenerationResult('Synthetic', {'answer': 'value'}, Usage(11, 10, 37, 3, 0.125), provider, MODEL)
    recorder.record_result('merge', result)
    assert recorder.as_dict() == {
        'token_usage_by_stage': {'merge': {'input_tokens': 11, 'output_tokens': 10, 'total_tokens': 37,
                                          'model': MODEL, 'billing_mode': 'standard', 'input_modality': 'text'}},
        'token_input_total': 11, 'token_output_total': 10, 'token_total': 37,
    }


@pytest.mark.parametrize('cost', [0.0, 0.125, None, -1, float('nan'), float('inf'), True, '0.1'])
def test_new_result_and_dict_reingestion_preserve_only_valid_provider_metadata(cost):
    from lecture_processor.domains.ai.providers.usage import finite_cost_usd
    recorder = TokenAccumulator(runtime=SimpleNamespace())
    result = GenerationResult('Private fixture text', {'private': 'fixture'}, Usage(11, 10, 37, 3, cost), 'openrouter', MODEL)
    value = recorder.record_result('merge', result, billing_mode='instant_batch')
    expected = {'input_tokens': 11, 'output_tokens': 10, 'total_tokens': 37, 'model': MODEL,
                'billing_mode': 'instant_batch', 'input_modality': 'text', 'provider': 'openrouter', 'thinking_tokens': 3}
    if finite_cost_usd(cost) is not None:
        expected['cost_usd'] = finite_cost_usd(cost)
    assert value == expected
    merged = TokenAccumulator(runtime=SimpleNamespace())
    merged.record_usage('merge', value, model=value['model'], billing_mode=value['billing_mode'])
    assert merged.as_dict() == recorder.as_dict()
    assert 'Private fixture' not in repr(recorder.as_dict())
    assert merged.output_total == 10


def test_new_result_duplicate_rejection_does_not_mutate_usage():
    recorder = TokenAccumulator(runtime=SimpleNamespace())
    result = GenerationResult('Synthetic', None, Usage(11, 10, 37, 3, 0.125), 'openrouter', MODEL)
    recorder.record_result('merge', result)
    original = deepcopy(recorder.as_dict())
    with pytest.raises(ValueError, match='already recorded'):
        recorder.record_result('merge', result)
    assert recorder.as_dict() == original


def test_unsupported_result_provider_does_not_mutate_usage():
    recorder = TokenAccumulator(runtime=SimpleNamespace())
    result = GenerationResult('Synthetic', None, Usage(11, 10, 37, 3, 0.125), 'unknown', MODEL)
    with pytest.raises(ValueError, match='provider'):
        recorder.record_result('merge', result)
    assert recorder.as_dict() == {'token_usage_by_stage': {}, 'token_input_total': 0,
                                  'token_output_total': 0, 'token_total': 0}


def test_cost_helper_rejects_overflow_without_losing_zero():
    from lecture_processor.domains.ai.providers.usage import finite_cost_usd

    assert finite_cost_usd(10 ** 1000) is None
    assert finite_cost_usd(-0.0) == 0.0


def test_mixed_api_csv_and_workbook_agree_on_chosen_costs(client, reporting):
    reporting.add('legacy', {'audio': stage()})
    reporting.add('new', {
        'merge': stage(provider='openrouter', cost=2.5),
        'slides': stage(provider='openrouter', cost=0),
        'combine': stage(provider='openrouter'),
    })
    filters = {'period': 'monthly', 'usd_to_eur': 0.9}
    response = client.post('/api/admin/cost-analysis', json=filters)
    assert response.status_code == 200
    body = response.get_json()
    summary = body['summary']
    assert summary['cost_usd_total'] == 18.5
    assert summary['cost_eur_total'] == 16.65
    assert summary['estimated_cost_usd_total'] == 32.0
    assert summary['cost_source'] == 'mixed'
    assert summary['token_output_total'] == 8_000_000
    assert summary['token_total'] == 36_000_000
    assert sum(row['cost_usd'] for row in body['jobs']) == sum(row['cost_usd'] for row in body['stages']) == 18.5
    legacy = next(row for row in body['jobs'] if row['job_id'] == 'legacy')
    assert set(legacy) == set(LEGACY_JOB_FIELDS)
    assert set(next(row for row in body['stages'] if row['job_id'] == 'legacy')) == set(LEGACY_STAGE_FIELDS)
    zero = next(row for row in body['stages'] if row['stage'] == 'slides')
    assert zero['cost_usd'] == 0
    assert zero['cost_source'] == 'provider_reported'
    assert zero['cost_input_usd'] + zero['cost_output_usd'] == zero['estimated_cost_usd'] == 8

    exported = client.get('/api/admin/export?type=jobs&window=7d&usd_to_eur=0.9')
    assert exported.status_code == 200
    reader = csv.DictReader(io.StringIO(exported.get_data(as_text=True)))
    csv_rows = list(reader)
    assert reader.fieldnames == LEGACY_CSV_FIELDS + ['cost_source', 'estimated_cost_usd']
    assert sum(float(row['cost_usd']) for row in csv_rows) == summary['cost_usd_total']
    assert sum(float(row['estimated_cost_usd']) for row in csv_rows) == summary['estimated_cost_usd_total']
    assert sum(float(row['cost_eur']) for row in csv_rows) == pytest.approx(summary['cost_eur_total'])
    assert {row['job_id']: row['cost_source'] for row in csv_rows} == {'legacy': 'tariff_estimate', 'new': 'mixed'}

    exported = client.post('/api/admin/cost-analysis/export', json=filters)
    assert exported.status_code == 200
    workbook = load_workbook(io.BytesIO(exported.data), data_only=True)
    summary_cells = dict(workbook['Summary'].values)
    assert summary_cells['Cost total (USD)'] == 18.5
    assert summary_cells['Cost total (EUR)'] == 16.65
    assert summary_cells['Estimated cost total (USD)'] == 32
    assert summary_cells['Cost source'] == 'mixed'
    jobs_values = list(workbook['Jobs'].values)
    assert list(jobs_values[0]) == LEGACY_JOB_FIELDS + ['cost_source', 'estimated_cost_usd']
    workbook_jobs = [dict(zip(jobs_values[0], row)) for row in jobs_values[1:]]
    assert sum(row['cost_usd'] for row in workbook_jobs) == summary['cost_usd_total']
    stages_values = list(workbook['Stage Breakdown'].values)
    headers = stages_values[0]
    assert 'cost_input_usd' not in headers and 'cost_output_usd' not in headers
    assert 'estimated_input_cost_usd' in headers and 'estimated_output_cost_usd' in headers
    workbook_stages = [dict(zip(headers, row)) for row in stages_values[1:]]
    assert sum(row['cost_usd'] for row in workbook_stages) == summary['cost_usd_total']
    assert sum(row['estimated_cost_usd'] for row in workbook_stages) == 32
    zero = next(row for row in workbook_stages if row['stage'] == 'slides')
    assert zero['provider'] == 'openrouter'
    assert zero['cost_usd'] == 0
    assert zero['estimated_input_cost_usd'] + zero['estimated_output_cost_usd'] == 8
    assert zero['cost_source'] == 'provider_reported'
    assert zero['thinking_tokens'] == 500_000
    assert all(row['cost_components_source'] == 'tariff_estimate' for row in workbook_stages)


def test_selected_legacy_jobs_keep_exact_api_and_workbook_fields(client, reporting):
    reporting.add('legacy', {'audio': stage()})
    reporting.add('new', {'merge': stage(provider='openrouter', cost=0)})
    filters = {'period': 'monthly', 'job_ids': ['legacy']}
    response = client.post('/api/admin/cost-analysis', json=filters)
    assert response.status_code == 200
    body = response.get_json()
    assert set(body['summary']) == {'jobs_filtered', 'jobs_selected', 'token_input_total',
                                    'token_output_total', 'token_total', 'cost_usd_total', 'cost_eur_total'}
    assert set(body['jobs'][0]) == set(LEGACY_JOB_FIELDS)
    assert set(body['stages'][0]) == set(LEGACY_STAGE_FIELDS)
    assert body['summary']['cost_usd_total'] == 8
    response = client.post('/api/admin/cost-analysis/export', json=filters)
    assert response.status_code == 200
    workbook = load_workbook(io.BytesIO(response.data), data_only=True)
    assert list(next(workbook['Jobs'].values)) == LEGACY_JOB_FIELDS
    stage_headers = list(next(workbook['Stage Breakdown'].values))
    assert stage_headers == [key + '_usd' if key.endswith('per_million') else key for key in LEGACY_STAGE_FIELDS]
    assert 'Cost source' not in dict(workbook['Summary'].values)
    assert 'Estimated cost total (USD)' not in dict(workbook['Summary'].values)


@pytest.mark.parametrize('visible_provider', [False, True])
def test_csv_prices_each_visible_job_once_and_ignores_hidden_metadata_for_headers(
    client, reporting, monkeypatch, visible_provider,
):
    reporting.add('visible', {'audio': stage(provider='openrouter' if visible_provider else None, cost=0)})
    reporting.add('hidden', {'merge': stage(provider='openrouter', cost=2.5)}, exclude_from_admin=True)
    computed = []
    calculate = metrics.compute_job_stage_costs

    def compute(payload, *args, **kwargs):
        computed.append(payload['job_id'])
        return calculate(payload, *args, **kwargs)

    monkeypatch.setattr(metrics, 'compute_job_stage_costs', compute)
    response = client.get('/api/admin/export?type=jobs&window=7d')
    assert response.status_code == 200
    reader = csv.DictReader(io.StringIO(response.get_data(as_text=True)))
    rows = list(reader)
    expected_headers = LEGACY_CSV_FIELDS + (['cost_source', 'estimated_cost_usd'] if visible_provider else [])
    assert reader.fieldnames == expected_headers
    assert [row['job_id'] for row in rows] == computed == ['visible']
    assert len(reporting.queries) == 1


def test_provider_metadata_survives_runtime_and_history_without_content_or_recount(monkeypatch, core):
    from lecture_processor.domains.admin import rollups
    from lecture_processor.domains.runtime_jobs.store import _build_runtime_job_payload

    recorder = TokenAccumulator(runtime=core)
    result = GenerationResult('Private result fixture', {'private': 'fixture'}, Usage(11, 10, 37, 3, 0.0),
                              'openrouter', MODEL, raw_response=object())
    recorder.record_result('merge', result)
    original = dict(recorder.as_dict(), status='complete', finished_at=core.time.time(),
                    custom_prompt='Private prompt fixture')
    snapshot = _build_runtime_job_payload('synthetic-cost-job', original, runtime=core)
    assert snapshot['token_usage_by_stage'] == recorder.as_dict()['token_usage_by_stage']
    saved = []
    counted = []
    monkeypatch.setattr(core.job_logs_repo, 'set_job_log', lambda _db, _id, payload: saved.append(payload))
    monkeypatch.setattr(rollups, 'increment_job_rollups', lambda *args, **kwargs: counted.append('rollup'))
    monkeypatch.setattr(core, 'log_analytics_event', lambda *args, **kwargs: counted.append('analytics'))
    core.save_job_log('synthetic-cost-job', snapshot, original['finished_at'], record_metrics=False)
    assert len(saved) == 1
    assert saved[0]['token_usage_by_stage'] == recorder.as_dict()['token_usage_by_stage']
    assert saved[0]['token_output_total'] == 10
    assert saved[0]['token_total'] == 37
    assert saved[0]['token_usage_by_stage']['merge']['cost_usd'] == 0.0
    assert counted == []
    assert 'Private' not in repr(saved)
