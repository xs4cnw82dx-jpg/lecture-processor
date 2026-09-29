import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

from lecture_processor.domains.admin import metrics
from lecture_processor.domains.ai import batch_orchestrator, provider


@pytest.fixture
def pricing():
    return json.loads((Path(__file__).resolve().parents[1] / 'config/model_pricing.json').read_text())


def timestamp(day):
    return datetime.fromisoformat(day).replace(tzinfo=timezone.utc).timestamp()


@pytest.mark.parametrize('model,mode,tokens,input_rate,output_rate', [
    ('gemini-3.5-flash-lite', 'standard', 500000, 0.30, 2.50),
    ('gemini-3.5-flash-lite', 'batch', 500000, 0.15, 1.25),
    ('gemini-3.8-flash', 'standard', 500000, 0.75, 3.75),
    ('gemini-3.8-flash', 'batch', 500000, 0.375, 1.875),
    ('gemini-3.1-pro-preview', 'standard', 200000, 2.00, 12.00),
    ('gemini-3.1-pro-preview', 'standard', 200001, 4.00, 18.00),
    ('gemini-3.1-pro-preview', 'batch', 200000, 1.00, 6.00),
    ('gemini-3.1-pro-preview', 'batch', 200001, 2.00, 9.00),
])
@pytest.mark.parametrize('modality', ['text', 'audio'])
def test_current_rates_and_long_context_boundary(pricing, model, mode, tokens, input_rate, output_rate, modality):
    rate = metrics.resolve_stage_pricing(
        pricing, model, mode, modality, tokens, as_of=timestamp('2026-09-29'),
    )
    assert rate['matched'] is True
    assert rate['input_rate_per_million'] == input_rate
    assert rate['output_rate_per_million'] == output_rate


@pytest.mark.parametrize('mode,input_rate,output_rate', [
    ('standard', 1.50, 7.50), ('batch', 0.75, 3.75),
])
def test_flash_introductory_rates_expire_on_january_first(pricing, mode, input_rate, output_rate):
    before = metrics.resolve_stage_pricing(pricing, 'gemini-3.8-flash', mode, as_of=timestamp('2026-12-31T23:59:59'))
    after = metrics.resolve_stage_pricing(pricing, 'gemini-3.8-flash', mode, as_of=timestamp('2027-01-01'))
    assert before['input_rate_per_million'] == input_rate / 2
    assert before['output_rate_per_million'] == output_rate / 2
    assert after['input_rate_per_million'] == input_rate
    assert after['output_rate_per_million'] == output_rate


def test_cached_calculator_rates_roll_over_without_repricing_old_jobs(pricing, tmp_path):
    path = tmp_path / 'pricing.json'
    path.write_text(json.dumps(pricing))
    clock = {'now': timestamp('2026-12-31T23:59:59')}
    runtime = SimpleNamespace(
        MODEL_PRICING_CONFIG_PATH=str(path),
        MODEL_PRICING_CACHE={'payload': None, 'loaded_at': 0},
        MODEL_PRICING_CACHE_TTL_SECONDS=300,
        time=SimpleNamespace(time=lambda: clock['now']),
    )
    before = metrics.get_model_pricing_config(runtime=runtime)
    clock['now'] += 1
    after = metrics.get_model_pricing_config(runtime=runtime)
    assert before['models']['gemini-3.8-flash']['output_per_M'] == 3.75
    assert after['models']['gemini-3.8-flash']['output_per_M'] == 7.50
    assert after['models']['gemini-3.8-flash-batch']['output_per_M'] == 3.75
    assert after['pricing_as_of'] == '2027-01-01'
    job = {
        'finished_at': timestamp('2026-12-31'),
        'token_usage_by_stage': {'coding': {
            'model': 'gemini-3.8-flash', 'input_tokens': 1000000, 'output_tokens': 1000000,
        }},
    }
    assert metrics.compute_job_stage_costs(job, after)['cost_usd'] == 4.50
    job['finished_at'] = timestamp('2027-01-01')
    assert metrics.compute_job_stage_costs(job, after)['cost_usd'] == 9.00
    # Caller changes cannot corrupt the cached source.
    after['models']['gemini-3.8-flash']['output_per_M'] = 999
    assert metrics.get_model_pricing_config(runtime=runtime)['models']['gemini-3.8-flash']['output_per_M'] == 7.50


@pytest.mark.parametrize('day', ['2026-09-29', '2027-01-01'])
def test_calculator_and_report_rates_agree_for_every_scenario(pricing, day):
    effective = metrics._calculator_pricing_config(pricing, timestamp(day))
    for scenario in pricing['scenarios'].values():
        for stage in scenario['stages']:
            model = stage['model']
            for mode in ('standard', 'batch'):
                flat_model = model if mode == 'standard' else model + '-batch'
                flat_rates = effective['models'][flat_model]
                if stage['input_tokens'] > flat_rates.get('max_input_tokens', float('inf')):
                    flat_rates = effective['models'][flat_rates['long_context_model']]
                modality = 'audio' if stage.get('audio') else 'text'
                report_rates = metrics.resolve_stage_pricing(
                    effective, model, mode, modality, stage['input_tokens'], as_of=timestamp(day),
                )
                assert report_rates['input_rate_per_million'] == flat_rates[f'input_{modality}_per_M']
                assert report_rates['output_rate_per_million'] == flat_rates['output_per_M']


def test_legacy_jobs_still_have_their_original_prices(pricing):
    for model, mode, modality, tokens, expected_input, expected_output in [
        ('gemini-3.1-flash-lite', 'standard', 'audio', 500000, 0.50, 1.50),
        ('gemini-3-flash-preview', 'batch', 'text', 500000, 0.25, 1.50),
        ('gemini-2.5-pro', 'standard', 'audio', 200001, 2.50, 15.00),
    ]:
        rate = metrics.resolve_stage_pricing(pricing, model, mode, modality, tokens, as_of=timestamp('2026-05-20'))
        assert rate['matched'] is True
        assert rate['input_rate_per_million'] == expected_input
        assert rate['output_rate_per_million'] == expected_output


def test_admin_pricing_endpoint_serves_current_catalog(client, core, runtime, monkeypatch):
    # Set dictionary entries so undo removes overrides of __getattr__ values.
    monkeypatch.setitem(runtime.__dict__, 'verify_firebase_token', lambda _request: {'uid': 'admin', 'email': 'admin@example.com'})
    monkeypatch.setitem(runtime.__dict__, 'is_admin_user', lambda _decoded: True)
    monkeypatch.setattr(core, 'run_startup_recovery_once', lambda: None)
    monkeypatch.setattr(batch_orchestrator, 'run_startup_batch_recovery_once', lambda runtime=None: None)
    monkeypatch.setattr(core.time, 'time', lambda: timestamp('2026-09-29'))
    response = client.get('/api/admin/model-pricing')
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['version'] == '2026-09-29'
    assert payload['models']['gemini-3.5-flash-lite']['input_audio_per_M'] == 0.30
    active_models = {core.MODEL_SLIDES, core.MODEL_AUDIO, core.MODEL_INTEGRATION, core.MODEL_INTERVIEW,
                     core.MODEL_STUDY, core.MODEL_TOOLS, core.MODEL_INTERVIEW_CODING}
    assert active_models == {'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview', 'gemini-3.8-flash'}
    assert active_models <= payload['pricing_table'].keys()
    assert {stage['model'] for scenario in payload['scenarios'].values() for stage in scenario['stages']} == active_models


def test_billed_output_includes_thinking_tokens():
    response = SimpleNamespace(usage_metadata=SimpleNamespace(
        prompt_token_count=100, candidates_token_count=20, thoughts_token_count=80, total_token_count=200,
    ))
    assert provider.extract_token_usage(response) == {'input_tokens': 100, 'output_tokens': 100, 'total_tokens': 200}


@pytest.mark.parametrize('metadata_key,counts', [
    ('usageMetadata', {'promptTokenCount': 100, 'candidatesTokenCount': 20, 'thoughtsTokenCount': 80, 'totalTokenCount': 200}),
    ('usage_metadata', {'prompt_token_count': 100, 'candidates_token_count': 20, 'thoughts_token_count': 80, 'total_token_count': 200}),
])
def test_batch_billed_output_includes_thinking_tokens(core, metadata_key, counts):
    response = {metadata_key: counts}
    assert batch_orchestrator._response_usage(response, runtime=core) == {
        'input_tokens': 100, 'output_tokens': 100, 'total_tokens': 200,
    }


def test_new_model_thinking_configs_serialize_in_sdk_and_batch(core):
    for model, level in ((core.MODEL_SLIDES, 'minimal'), (core.MODEL_INTEGRATION, 'high'),
                         (core.MODEL_INTERVIEW_CODING, 'high')):
        config = provider._build_thinking_config(model, runtime=core)
        assert config.model_dump(mode='json', exclude_none=True) == {'thinking_level': level.upper()}
    config = batch_orchestrator._batch_stage_generation_config('notes_merge', core)
    assert config == {'maxOutputTokens': 65536, 'thinkingConfig': {'thinkingLevel': 'high'}}
