from types import SimpleNamespace

import pytest
from flask import Flask
from google.genai import types

from lecture_processor.domains.ai import provider
from lecture_processor.runtime import bootstrap


@pytest.fixture(autouse=True)
def clear_timeout_settings(monkeypatch):
    monkeypatch.delenv('GEMINI_HTTP_TIMEOUT_MS', raising=False)
    monkeypatch.delenv('GEMINI_REQUEST_HTTP_TIMEOUT_MS', raising=False)


@pytest.mark.parametrize(('configured', 'expected'), [
    (None, 600_000),
    (' 240000 ', 240_000),
    ('', 600_000),
    ('not-an-integer', 600_000),
    ('0', 600_000),
    ('-5', 600_000),
    ('1.5', 600_000),
])
def test_client_receives_a_positive_http_timeout(monkeypatch, configured, expected):
    if configured is not None:
        monkeypatch.setenv('GEMINI_HTTP_TIMEOUT_MS', configured)
    calls = []
    client = object()
    module = SimpleNamespace(types=types, Client=lambda **kwargs: calls.append(kwargs) or client)
    logger = SimpleNamespace(warning=lambda *args: None)

    result = bootstrap.initialize_gemini_client('synthetic-provider-token', genai_module=module, logger=logger)

    assert result is client
    assert len(calls) == 1
    assert isinstance(calls[0].get('http_options'), types.HttpOptions)
    assert calls[0]['http_options'].timeout == expected


def generation_runtime(calls, types_module=types):
    return SimpleNamespace(
        client=SimpleNamespace(models=SimpleNamespace(
            generate_content=lambda **kwargs: calls.append(kwargs) or SimpleNamespace(text='synthetic result'),
        )),
        types=types_module,
        MODEL_THINKING_POLICY={},
        PROVIDER_RETRY_MAX_ATTEMPTS=1,
    )


@pytest.mark.parametrize(('global_timeout', 'request_timeout', 'expected'), [
    (None, None, 60_000),
    ('240000', '15000', 15_000),
    ('30000', '120000', 30_000),
    ('30000', None, 30_000),
    (None, 'invalid', 60_000),
    (None, '0', 60_000),
    (None, '-1', 60_000),
])
def test_request_generation_uses_shorter_bounded_timeout(monkeypatch, global_timeout, request_timeout, expected):
    if global_timeout is not None:
        monkeypatch.setenv('GEMINI_HTTP_TIMEOUT_MS', global_timeout)
    if request_timeout is not None:
        monkeypatch.setenv('GEMINI_REQUEST_HTTP_TIMEOUT_MS', request_timeout)
    calls = []
    runtime = generation_runtime(calls)

    with Flask(__name__).test_request_context('/synthetic-generation'):
        response = provider.generate_with_policy('synthetic-model', ['synthetic prompt'], runtime=runtime)

    assert response.text == 'synthetic result'
    assert calls[0]['config'].http_options is not None
    assert calls[0]['config'].http_options.timeout == expected


def test_worker_generation_keeps_the_client_timeout():
    calls = []
    provider.generate_with_policy('synthetic-model', ['synthetic prompt'], runtime=generation_runtime(calls))

    assert calls[0]['config'].http_options is None


def test_request_timeout_survives_optional_thinking_fallback():
    class ConfigWithoutThinking:
        def __init__(self, **kwargs):
            if 'thinking_config' in kwargs:
                raise ValueError('optional thinking configuration is unsupported')
            self.kwargs = kwargs

    fake_types = SimpleNamespace(
        ThinkingConfig=lambda **kwargs: kwargs,
        GenerateContentConfig=ConfigWithoutThinking,
    )
    calls = []
    runtime = generation_runtime(calls, fake_types)
    runtime.MODEL_THINKING_POLICY = {'synthetic-model': {'thinking_level': 'high'}}

    with Flask(__name__).test_request_context('/synthetic-generation'):
        provider.generate_with_policy('synthetic-model', ['synthetic prompt'], runtime=runtime)

    config = calls[0]['config'].kwargs
    assert config['max_output_tokens'] == 65536
    assert config.get('http_options', {}).get('timeout') == 60_000


def test_existing_timeout_message_recognition_remains_transient():
    assert provider.is_transient_provider_error(RuntimeError('The read timed out'), runtime=SimpleNamespace()) is True


def test_missing_provider_key_does_not_construct_a_client():
    calls = []
    module = SimpleNamespace(types=types, Client=lambda **kwargs: calls.append(kwargs))
    logger = SimpleNamespace(warning=lambda *args: None)

    assert bootstrap.initialize_gemini_client('', genai_module=module, logger=logger) is None
    assert calls == []
