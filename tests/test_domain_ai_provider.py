from types import SimpleNamespace

from lecture_processor.domains.ai import provider


class _ErrorWithStatus:
    def __init__(self, status_code):
        self.status_code = status_code


def test_classify_and_transient_provider_errors():
    runtime = SimpleNamespace(
        PROVIDER_TRANSIENT_STATUS_CODES={429, 500, 503},
        PROVIDER_TRANSIENT_MESSAGE_HINTS=('timeout', 'temporarily unavailable'),
    )

    assert provider.classify_provider_error_code(_ErrorWithStatus(503), runtime=runtime) == 'HTTP_503'
    assert provider.classify_provider_error_code(RuntimeError('request timed out'), runtime=runtime) == 'TIMEOUT'
    assert provider.is_transient_provider_error(_ErrorWithStatus(429), runtime=runtime) is True
    assert provider.is_transient_provider_error(RuntimeError('temporarily unavailable'), runtime=runtime) is True


def test_run_with_provider_retry_retries_transient_failures_once():
    sleep_calls = []
    runtime = SimpleNamespace(
        PROVIDER_RETRY_MAX_ATTEMPTS=3,
        PROVIDER_RETRY_BASE_SECONDS=0.1,
        PROVIDER_RETRY_MAX_SECONDS=0.1,
        PROVIDER_TRANSIENT_STATUS_CODES={503},
        PROVIDER_TRANSIENT_MESSAGE_HINTS=('timeout',),
        logger=SimpleNamespace(warning=lambda *args, **kwargs: None),
        random=SimpleNamespace(uniform=lambda _a, _b: 0.0),
        time=SimpleNamespace(sleep=lambda delay: sleep_calls.append(delay)),
    )

    attempts = {'count': 0}
    retry_tracker = {}

    def _flaky_call():
        attempts['count'] += 1
        if attempts['count'] == 1:
            raise TimeoutError('timeout')
        return 'ok'

    result = provider.run_with_provider_retry('upload', _flaky_call, retry_tracker=retry_tracker, runtime=runtime)

    assert result == 'ok'
    assert attempts['count'] == 2
    assert retry_tracker['upload'] == 1
    assert sleep_calls == [0.1]


def test_token_accumulator_aggregates_usage():
    usage = SimpleNamespace(prompt_token_count=12, candidates_token_count=8, total_token_count=20)
    response = SimpleNamespace(usage_metadata=usage)

    acc = provider.TokenAccumulator(runtime=SimpleNamespace())
    acc.record('stage-1', response)
    acc.record('stage-2', response)

    assert acc.as_dict() == {
        'token_usage_by_stage': {
            'stage-1': {'input_tokens': 12, 'output_tokens': 8, 'total_tokens': 20},
            'stage-2': {'input_tokens': 12, 'output_tokens': 8, 'total_tokens': 20},
        },
        'token_input_total': 24,
        'token_output_total': 16,
        'token_total': 40,
    }


def test_generate_with_policy_and_optional_thinking_builds_expected_payloads():
    class _ThinkingConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class _GenerateContentConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class _Part:
        @staticmethod
        def from_text(text):
            return {'text': text}

    class _Content:
        def __init__(self, role, parts):
            self.role = role
            self.parts = parts

    class _Types:
        ThinkingConfig = _ThinkingConfig
        GenerateContentConfig = _GenerateContentConfig
        Part = _Part
        Content = _Content

    calls = []

    class _Models:
        def generate_content(self, **kwargs):
            calls.append(kwargs)
            return SimpleNamespace(text='ok')

    runtime = SimpleNamespace(
        client=SimpleNamespace(models=_Models()),
        types=_Types,
        MODEL_THINKING_POLICY={'model-a': {'thinking_budget': 123}},
        PROVIDER_RETRY_MAX_ATTEMPTS=1,
        PROVIDER_RETRY_BASE_SECONDS=0.0,
        PROVIDER_RETRY_MAX_SECONDS=0.0,
        PROVIDER_TRANSIENT_STATUS_CODES=set(),
        PROVIDER_TRANSIENT_MESSAGE_HINTS=(),
    )

    response = provider.generate_with_policy('model-a', ['payload'], runtime=runtime)
    assert response.text == 'ok'
    assert calls[0]['model'] == 'model-a'
    assert calls[0]['contents'] == ['payload']
    assert calls[0]['config'].kwargs['max_output_tokens'] == 65536
    assert isinstance(calls[0]['config'].kwargs['thinking_config'], _ThinkingConfig)

    provider.generate_with_optional_thinking('model-a', 'hello world', runtime=runtime)
    assert calls[1]['model'] == 'model-a'
    assert len(calls[1]['contents']) == 1
    assert calls[1]['contents'][0].role == 'user'
    assert calls[1]['contents'][0].parts == [{'text': 'hello world'}]
