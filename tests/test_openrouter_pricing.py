import json
from pathlib import Path

import pytest

from lecture_processor.domains.admin import metrics


@pytest.fixture
def pricing():
    return json.loads((Path(__file__).resolve().parents[1] / 'config/model_pricing.json').read_text())


@pytest.mark.parametrize('mode', ['standard', 'batch'])
@pytest.mark.parametrize('model,tokens,input_rate,output_rate,tier', [
    ('anthropic/claude-haiku-5.5', 100000, 0.10, 0.50, '<=100k'),
    ('anthropic/claude-haiku-5.5', 100001, 0.50, 2.50, '>100k'),
    ('anthropic/claude-sonnet-5.5', 100000, 2.00, 10.00, ''),
    ('anthropic/claude-sonnet-5.5', 100001, 2.00, 10.00, ''),
    ('anthropic/claude-sonnet-5.5', 1000000, 2.00, 10.00, ''),
])
def test_normal_provider_rates_do_not_gain_an_overnight_discount(
        pricing, mode, model, tokens, input_rate, output_rate, tier):
    resolved = metrics.resolve_stage_pricing(pricing, model, mode, 'text', tokens)
    assert resolved['matched'] is True
    assert resolved['tier'] == tier
    assert resolved['input_rate_per_million'] == input_rate
    assert resolved['output_rate_per_million'] == output_rate
    assert set(pricing['pricing_table'][model]) == {'standard'}
    flat_model = pricing['models'][model]
    if tokens > flat_model.get('max_input_tokens', tokens):
        flat_model = pricing['models'][flat_model['long_context_model']]
    assert flat_model['input_text_per_M'] == input_rate
    assert flat_model['output_per_M'] == output_rate
    assert flat_model['input_audio_per_M'] is None


@pytest.mark.parametrize('model,input_rate,output_rate', [
    ('claude-haiku-5.5', 0.05, 0.25),
    ('claude-haiku-5.5-over-100k', 0.25, 1.25),
    ('claude-sonnet-5.5', 1.00, 5.00),
])
def test_vendor_batch_reference_is_separate_from_provider_job_resolution(pricing, model, input_rate, output_rate):
    key = 'anthropic-batch-reference/' + model
    reference = pricing['models'][key]
    assert 'Anthropic Batch reference' in reference['label']
    assert 'not OpenRouter' in reference['label']
    assert reference['source'] == 'https://platform.claude.com/docs/en/about-claude/pricing'
    assert reference['input_text_per_M'] == input_rate
    assert reference['output_per_M'] == output_rate
    assert key not in pricing['pricing_table']
    assert 'anthropic/' + model + '-batch' not in pricing['models']
    assert metrics.resolve_stage_pricing(pricing, key, 'batch')['matched'] is False


def test_vendor_reference_has_its_own_long_context_target(pricing):
    short = pricing['models']['anthropic-batch-reference/claude-haiku-5.5']
    assert short['max_input_tokens'] == 100000
    long = pricing['models'][short['long_context_model']]
    assert long['min_input_tokens'] == 100001
    assert long['input_text_per_M'] == short['input_text_per_M'] * 5
    assert long['output_per_M'] == short['output_per_M'] * 5
