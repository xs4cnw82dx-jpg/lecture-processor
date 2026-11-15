"""Provider errors cannot masquerade as successful choices or usage."""
import pytest

from lecture_processor.domains.ai.providers.contracts import Usage
from lecture_processor.domains.ai.providers.errors import ProviderRequestError
from lecture_processor.domains.ai.providers.openrouter_response import parse_response

MODEL = 'anthropic/claude-sonnet-5.5'


def payload(text='  synthetic output  ', finish='stop'):
    return {'choices': [{'finish_reason': finish, 'message': {'role': 'assistant', 'content': text}}]}


@pytest.mark.parametrize('code', [429, '500', 599])
def test_top_level_error_wins_over_otherwise_valid_choices(code):
    body = payload()
    body['error'] = {'code': code, 'message': 'synthetic-private-error'}
    with pytest.raises(ProviderRequestError) as caught:
        parse_response(body, model=MODEL)
    assert caught.value.retryable is True
    assert 'synthetic-private-error' not in str(caught.value)
    assert not hasattr(caught.value, 'body') and not hasattr(caught.value, 'response')


@pytest.mark.parametrize('body', [None, [], {}, {'choices': []}, {'choices': [None]},
                                 payload('', 'stop'), payload(' ', 'length'),
                                 payload('synthetic', 'content_filter'), payload('synthetic', 'tool_calls')])
def test_invalid_success_envelopes_do_not_become_retryable(body):
    with pytest.raises(ProviderRequestError) as caught:
        parse_response(body, model=MODEL)
    assert caught.value.retryable is False


def test_finish_error_and_refusal_are_rejected():
    body = payload('partial', 'error')
    body['choices'][0]['error'] = {'code': 503, 'message': 'synthetic-private-error'}
    with pytest.raises(ProviderRequestError) as caught:
        parse_response(body, model=MODEL)
    assert caught.value.retryable is True
    body = payload()
    body['choices'][0]['message']['refusal'] = 'synthetic refusal'
    with pytest.raises(ProviderRequestError):
        parse_response(body, model=MODEL)


def test_usage_counts_thinking_once_preserves_total_and_accepts_zero_cost():
    body = payload()
    body['usage'] = {'prompt_tokens': 10, 'completion_tokens': 12, 'total_tokens': 99,
                     'completion_tokens_details': {'reasoning_tokens': 7}, 'cost': 0}
    result = parse_response(body, model=MODEL)
    assert result.text == '  synthetic output  '
    assert result.provider == 'openrouter' and result.model == MODEL
    assert result.usage == Usage(10, 12, 99, 7, 0.0)
    assert result.raw_response is None and result.parsed is None


def test_missing_usage_stays_unknown_cost_and_zero_counts():
    assert parse_response(payload(), model=MODEL).usage == Usage()


def test_schema_parsing_is_optional_and_partial_length_text_is_preserved():
    assert parse_response(payload('{"answer": 2}'), model=MODEL).parsed is None
    assert parse_response(payload('{"answer": 2}'), model=MODEL, schema={}).parsed == {'answer': 2}
    partial = parse_response(payload('{"answer": ', 'length'), model=MODEL, schema={})
    assert partial.text == '{"answer": ' and partial.parsed is None


def test_invalid_usage_values_cannot_add_counts_or_invent_reported_cost():
    body = payload()
    body['usage'] = {'prompt_tokens': True, 'completion_tokens': 3, 'total_tokens': -1,
                     'completion_tokens_details': {'reasoning_tokens': 100}, 'cost': float('nan')}
    assert parse_response(body, model=MODEL).usage == Usage(0, 3, 0, 3, None)
