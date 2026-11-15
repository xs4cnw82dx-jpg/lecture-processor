"""External, synthetic controls for the current Gemini compatibility boundary."""

from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import provider


MODEL = 'synthetic-model'
OPERATION = 'existing-operation-label'
PROMPT = '  Synthetic prompt\nwith exact whitespace.\n'


def make_runtime(*, typed=True, config_error=None):
    seen = SimpleNamespace(config_inputs=[], configs=[], thinking=[], parts=[], contents=[],
                           sdk=[], replacement_sdk=[], sleeps=[], warnings=[], env_reads=[])

    def thinking_config(**kwargs):
        value = SimpleNamespace(**kwargs)
        seen.thinking.append(value)
        return value

    def generation_config(**kwargs):
        seen.config_inputs.append(dict(kwargs))
        if config_error is not None:
            raise config_error
        value = SimpleNamespace(**kwargs)
        seen.configs.append(value)
        return value

    def part_from_text(*, text):
        value = SimpleNamespace(text=text)
        seen.parts.append(value)
        return value

    def content(*, role, parts):
        value = SimpleNamespace(role=role, parts=parts)
        seen.contents.append(value)
        return value

    def getenv(name, default=None):
        seen.env_reads.append(name)
        return default

    types = SimpleNamespace()
    if typed:
        types = SimpleNamespace(ThinkingConfig=thinking_config, GenerateContentConfig=generation_config,
                                Part=SimpleNamespace(from_text=part_from_text), Content=content)
    runtime = SimpleNamespace(
        types=types,
        MODEL_THINKING_POLICY={MODEL: {'thinking_level': 'high'}},
        PROVIDER_RETRY_MAX_ATTEMPTS=3,
        PROVIDER_RETRY_BASE_SECONDS=0.25,
        PROVIDER_RETRY_MAX_SECONDS=1.0,
        PROVIDER_TRANSIENT_STATUS_CODES={503},
        PROVIDER_TRANSIENT_MESSAGE_HINTS=('temporarily unavailable',),
        os=SimpleNamespace(getenv=getenv),
        random=SimpleNamespace(uniform=lambda _low, _high: 0.0),
        time=SimpleNamespace(sleep=seen.sleeps.append),
        logger=SimpleNamespace(warning=lambda *args: seen.warnings.append(args)),
    )
    runtime.client = SimpleNamespace(models=SimpleNamespace(generate_content=lambda **kwargs: seen.sdk.append(kwargs)))
    return runtime, seen


def invoke(wrapper, runtime, tracker, contents):
    if wrapper == 'policy':
        return provider.generate_with_policy(MODEL, contents, max_output_tokens=8192,
                                             retry_tracker=tracker, operation_name=OPERATION, runtime=runtime)
    return provider.generate_with_optional_thinking(MODEL, PROMPT, max_output_tokens=8192,
                                                   retry_tracker=tracker, operation_name=OPERATION, runtime=runtime)


@pytest.mark.parametrize('wrapper', ['policy', 'optional'])
@pytest.mark.parametrize('typed', [True, False], ids=['typed-config', 'dict-config'])
def test_prepared_client_config_contents_and_raw_response_survive_retry(wrapper, typed):
    runtime, seen = make_runtime(typed=typed)
    original_client = runtime.client
    first_part, last_part = object(), object()
    contents = [first_part, PROMPT, last_part, first_part]
    parsed = {'synthetic': ['unchanged']}
    response = SimpleNamespace(text='  Exact response\n', parsed=parsed, usage_metadata=None)
    tracker = {'unrelated-operation': 7}

    def generate_content(**kwargs):
        seen.sdk.append(kwargs)
        if len(seen.sdk) == 1:
            # Replacing mutable runtime dependencies must not re-prepare an attempt.
            runtime.client = SimpleNamespace(models=SimpleNamespace(
                generate_content=lambda **payload: seen.replacement_sdk.append(payload)))
            runtime.types = SimpleNamespace(GenerateContentConfig=lambda **_kwargs: pytest.fail('Config rebuilt during retry'))
            raise TimeoutError('synthetic temporarily unavailable')
        return response

    original_client.models.generate_content = generate_content
    result = invoke(wrapper, runtime, tracker, contents)

    assert result is response
    assert result.parsed is parsed
    assert result.text == '  Exact response\n'
    assert len(seen.sdk) == 2
    assert seen.replacement_sdk == []
    assert seen.sdk[0]['config'] is seen.sdk[1]['config']
    assert seen.sdk[0]['contents'] is seen.sdk[1]['contents']
    assert [call['model'] for call in seen.sdk] == [MODEL, MODEL]
    if typed:
        assert len(seen.configs) == len(seen.thinking) == 1
        assert seen.sdk[0]['config'] is seen.configs[0]
        assert seen.configs[0].max_output_tokens == 8192
        assert seen.configs[0].thinking_config is seen.thinking[0]
        assert seen.thinking[0].thinking_level == 'high'
    else:
        assert seen.sdk[0]['config'] == {'max_output_tokens': 8192}
        assert seen.config_inputs == seen.thinking == []
    if wrapper == 'policy':
        assert seen.sdk[0]['contents'] is contents
        assert contents == [first_part, PROMPT, last_part, first_part]
        assert seen.parts == seen.contents == []
    elif typed:
        assert len(seen.parts) == len(seen.contents) == 1
        assert seen.sdk[0]['contents'][0] is seen.contents[0]
        assert seen.contents[0].role == 'user'
        assert seen.contents[0].parts == seen.parts
        assert seen.parts[0].text == PROMPT
    else:
        assert seen.sdk[0]['contents'] == [PROMPT]
    assert seen.sleeps == [0.25]
    assert len(seen.warnings) == 1
    assert tracker == {'unrelated-operation': 7, OPERATION: 1}


@pytest.mark.parametrize('wrapper', ['policy', 'optional'])
def test_transient_looking_config_failure_stays_outside_provider_retry(wrapper):
    failure = TimeoutError('synthetic temporarily unavailable while constructing config')
    runtime, seen = make_runtime(config_error=failure)
    tracker = {OPERATION: 2, 'unrelated-operation': 7}
    with pytest.raises(TimeoutError) as raised:
        invoke(wrapper, runtime, tracker, [object(), PROMPT])
    assert raised.value is failure
    # Existing typed-config compatibility tries once without thinking, pre-retry.
    assert len(seen.config_inputs) == 2
    assert seen.config_inputs[0] == {'max_output_tokens': 8192, 'thinking_config': seen.thinking[0]}
    assert seen.config_inputs[1] == {'max_output_tokens': 8192}
    assert seen.sdk == seen.sleeps == seen.warnings == seen.env_reads == []
    assert tracker == {OPERATION: 2, 'unrelated-operation': 7}


@pytest.mark.parametrize('wrapper', ['policy', 'optional'])
def test_missing_client_fails_before_config_and_retry(wrapper):
    runtime, seen = make_runtime()
    runtime.client = None
    tracker = {'unrelated-operation': 7}
    with pytest.raises(RuntimeError, match=r'^Gemini client is not configured\.$'):
        invoke(wrapper, runtime, tracker, [object(), PROMPT])
    assert seen.sdk == seen.config_inputs == seen.thinking == []
    assert seen.sleeps == seen.warnings == seen.env_reads == []
    assert tracker == {'unrelated-operation': 7}


def test_thoughts_count_once_and_legacy_accumulator_shape_is_exact():
    runtime, _seen = make_runtime()
    response = SimpleNamespace(usage_metadata=SimpleNamespace(
        prompt_token_count=11, candidates_token_count=7, thoughts_token_count=3, total_token_count=37))
    assert provider.extract_token_usage(response, runtime=runtime) == {
        'input_tokens': 11, 'output_tokens': 10, 'total_tokens': 37,
    }
    accumulator = provider.TokenAccumulator(runtime=runtime)
    accumulator.record('native', response, model=MODEL, billing_mode='batch', input_modality='pdf')
    accumulator.record_usage('normalized', {
        'input_tokens': 2, 'output_tokens': 6, 'thinking_tokens': 2, 'total_tokens': 8,
    })
    assert accumulator.as_dict() == {
        'token_usage_by_stage': {
            'native': {'input_tokens': 11, 'output_tokens': 10, 'total_tokens': 37,
                       'model': MODEL, 'billing_mode': 'batch', 'input_modality': 'pdf'},
            'normalized': {'input_tokens': 2, 'output_tokens': 6, 'total_tokens': 8,
                           'model': '', 'billing_mode': 'standard', 'input_modality': 'text'},
        },
        'token_input_total': 13,
        'token_output_total': 16,
        'token_total': 45,
    }
