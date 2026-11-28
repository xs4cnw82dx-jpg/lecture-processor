"""Actual SDK wire contracts with synthetic inputs and no network access."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import nullcontext
import json
import logging
import os
from pathlib import Path
import socket
import subprocess
import sys
from threading import Barrier
from types import SimpleNamespace

from flask import Flask
import httpx
import pytest

from lecture_processor.domains.ai.providers.contracts import ImagePart, PdfPart, TextPart, Usage
from lecture_processor.domains.ai.providers.errors import ProviderRequestError
from lecture_processor.domains.ai.providers.openrouter import OpenRouterProvider

MODEL = 'anthropic/claude-sonnet-5.5'
OPTIONS = {'reasoning_effort': 'medium', 'max_output_tokens': 32768}
PRIVATE = 'synthetic-private-body-marker'
KEY = 'synthetic-private-key-marker'
PLUGINS = {
    'armor', 'auto-beta-router', 'auto-router', 'context-compression',
    'file-parser', 'fusion', 'pareto-router',
    'response-healing', 'web',
}


def success():
    return {'choices': [{'finish_reason': 'stop', 'message': {'content': '{"answer": 2}'}}],
            'usage': {'prompt_tokens': 11, 'completion_tokens': 10, 'total_tokens': 37,
                      'completion_tokens_details': {'reasoning_tokens': 3}, 'cost': 0}}


class _Stream(httpx.SyncByteStream):
    def __init__(self, body):
        self.body = body
        self.closes = 0

    def __iter__(self):
        yield self.body

    def close(self):
        self.closes += 1


class _Transport(httpx.MockTransport):
    def __init__(self, outcome=None):
        self.requests = []
        self.streams = []
        self.closes = 0
        self.outcome = outcome or (lambda _request: (200, success()))
        super().__init__(self.respond)

    def respond(self, request):
        self.requests.append(request)
        status, payload = self.outcome(request)
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        stream = _Stream(body)
        self.streams.append(stream)
        return httpx.Response(status, headers={'Content-Type': 'application/json'}, stream=stream)

    def close(self):
        self.closes += 1


@pytest.fixture(autouse=True)
def isolated_adapter_environment(monkeypatch):
    def blocked(*_args, **_kwargs):
        pytest.fail('Adapter contract tests must never use DNS or a real socket.')

    monkeypatch.setattr(socket, 'getaddrinfo', blocked)
    monkeypatch.setattr(socket.socket, 'connect', blocked)
    monkeypatch.setattr(socket.socket, 'connect_ex', blocked)
    for name in ('OPENROUTER_HTTP_TIMEOUT_MS', 'OPENROUTER_REQUEST_HTTP_TIMEOUT_MS',
                 'OPENAI_CUSTOM_HEADERS'):
        monkeypatch.delenv(name, raising=False)
    # SDK logger state belongs to the application, so restore it after each test.
    loggers = [logging.getLogger('openai')]
    for logger in loggers:
        loggers.extend(logger.getChildren())
    disabled = {logger: logger.disabled for logger in loggers}
    yield
    loggers = [logging.getLogger('openai')]
    for logger in loggers:
        loggers.extend(logger.getChildren())
        logger.disabled = disabled.get(logger, False)


@pytest.fixture
def adapter_runtime():
    delays = []
    return SimpleNamespace(
        PROVIDER_RETRY_MAX_ATTEMPTS=3, PROVIDER_RETRY_BASE_SECONDS=0.01,
        PROVIDER_RETRY_MAX_SECONDS=0.1, time=SimpleNamespace(sleep=delays.append),
        random=SimpleNamespace(uniform=lambda *_args: 0), delays=delays,
        logger=logging.getLogger('application.adapter-contract'),
    )


def generate(adapter, **kwargs):
    return adapter.generate(MODEL, [TextPart(PRIVATE)], options=OPTIONS, **kwargs)


def assert_safe(error):
    assert error.__cause__ is None and error.__context__ is None
    assert not hasattr(error, 'body') and not hasattr(error, 'response') and not hasattr(error, 'request')
    public = repr(vars(error)) + repr(error.args) + str(error)
    assert PRIVATE not in public and KEY not in public


@pytest.mark.parametrize('schema', [None, {'type': 'object', 'properties': {'answer': {'type': 'integer'}}}])
def test_sdk_wire_policy_order_native_pdf_schema_and_environment(adapter_runtime, monkeypatch, tmp_path, schema):
    for name in ('OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_ADMIN_KEY', 'OPENAI_WEBHOOK_SECRET',
                 'OPENAI_ORG_ID', 'OPENAI_PROJECT_ID'):
        monkeypatch.setenv(name, 'ambient-must-not-escape')
    pdf, picture = tmp_path / 'private-document.pdf', tmp_path / 'private-image.png'
    pdf.write_bytes(b'%PDF synthetic')
    picture.write_bytes(b'synthetic png')
    transport = _Transport()
    with OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY) as adapter:
        result = adapter.generate(MODEL, [TextPart('before'), PdfPart(pdf), ImagePart(picture), TextPart('after')],
                                  options=OPTIONS, schema=schema)
        assert adapter._sdk.max_retries == 0
    request = transport.requests[0]
    body = json.loads(request.content)
    assert request.url == 'https://openrouter.ai/api/v1/chat/completions'
    assert request.headers['authorization'] == f'Bearer {KEY}'
    assert 'ambient-must-not-escape' not in str(request.headers) + request.content.decode()
    assert body['model'] == MODEL and body['max_tokens'] == 32768
    assert body['stream'] is False and body['service_tier'] == 'default'
    assert body['provider'] == {'only': ['google-vertex/global'], 'allow_fallbacks': False,
                                'require_parameters': True, 'data_collection': 'deny', 'zdr': True}
    assert body['reasoning'] == {'effort': 'medium', 'exclude': True}
    plugins = {item['id']: item for item in body['plugins']}
    assert set(plugins) == PLUGINS and len(body['plugins']) == len(PLUGINS)
    assert plugins.pop('file-parser') == {'id': 'file-parser', 'enabled': True, 'pdf': {'engine': 'native'}}
    assert all(item['enabled'] is False for item in plugins.values())
    content = body['messages'][0]['content']
    assert [part['type'] for part in content] == ['text', 'file', 'image_url', 'text']
    assert content[0]['text'] == 'before' and content[-1]['text'] == 'after'
    assert content[1]['file']['filename'] == 'document-2.pdf'
    assert content[1]['file']['file_data'] == 'data:application/pdf;base64,JVBERiBzeW50aGV0aWM='
    assert content[2]['image_url']['url'] == 'data:image/png;base64,c3ludGhldGljIHBuZw=='
    assert 'private-document' not in request.content.decode()
    if schema is None:
        assert 'response_format' not in body and result.parsed is None
    else:
        assert body['response_format'] == {'type': 'json_schema', 'json_schema': {
            'name': 'generated_output', 'strict': True, 'schema': schema}}
        assert result.parsed == {'answer': 2}
    assert result.usage == Usage(11, 10, 37, 3, 0.0)
    assert result.raw_response is None
    assert transport.closes == 1 and [stream.closes for stream in transport.streams] == [1]
    assert pdf.exists() and picture.exists()


@pytest.mark.parametrize('status', [408, 409, 425, 429, *range(500, 600)])
def test_sdk_http_failures_have_only_application_retries(adapter_runtime, caplog, status):
    transport = _Transport(lambda _request: (status, {'error': {'code': status, 'message': PRIVATE}}))
    tracker = {}
    with OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY) as adapter:
        with pytest.raises(ProviderRequestError) as caught:
            generate(adapter, retry_tracker=tracker, operation_name='merge')
    assert caught.value.retryable is True and caught.value.error_code == f'HTTP_{status}'
    assert len(transport.requests) == 3 and len(adapter_runtime.delays) == 2
    assert tracker == {'merge': 3}
    assert transport.closes == 1 and all(stream.closes == 1 for stream in transport.streams)
    assert PRIVATE not in caplog.text and KEY not in caplog.text
    assert_safe(caught.value)


@pytest.mark.parametrize('kind', ['body', 'body_with_choices', 'finish'])
def test_sdk_200_error_envelopes_retry_and_close_responses(adapter_runtime, kind):
    payload = success() if kind != 'body' else {}
    error = {'code': 429, 'message': PRIVATE}
    if kind == 'finish':
        payload['choices'][0].update(finish_reason='error', error=error)
    else:
        payload['error'] = error
    transport = _Transport(lambda _request: (200, payload))
    with OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY) as adapter:
        with pytest.raises(ProviderRequestError) as caught:
            generate(adapter)
    assert len(transport.requests) == 3 and caught.value.retryable is True
    assert [stream.closes for stream in transport.streams] == [1, 1, 1]
    assert_safe(caught.value)


@pytest.mark.parametrize('status,payload', [(400, {'error': {'message': PRIVATE}}),
                                           (200, b'not json ' + PRIVATE.encode()),
                                           (200, {'choices': []}), (200, {'choices': [{'message': PRIVATE}]})])
def test_nonretryable_http_or_malformed_success_is_one_attempt(adapter_runtime, status, payload):
    transport = _Transport(lambda _request: (status, payload))
    tracker = {}
    with OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY) as adapter:
        with pytest.raises(ProviderRequestError) as caught:
            generate(adapter, retry_tracker=tracker)
    assert caught.value.retryable is False
    assert len(transport.requests) == 1 and adapter_runtime.delays == []
    assert tracker == {'generate_content': 1}
    assert transport.closes == 1 and transport.streams[0].closes == 1
    assert_safe(caught.value)


@pytest.mark.parametrize('timeout', [httpx.ConnectTimeout, httpx.ReadTimeout, httpx.WriteTimeout, httpx.PoolTimeout])
def test_all_sdk_timeout_phases_normalize_and_retry(adapter_runtime, timeout):
    def fail(request):
        raise timeout(PRIVATE, request=request)

    transport = _Transport(fail)
    with OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY) as adapter:
        with pytest.raises(ProviderRequestError) as caught:
            generate(adapter)
    assert len(transport.requests) == 3 and len(adapter_runtime.delays) == 2
    assert caught.value.error_code == 'TIMEOUT' and caught.value.retryable is True
    assert transport.closes == 1
    assert_safe(caught.value)


def test_sdk_connection_error_retries_without_exposing_request(adapter_runtime):
    def fail(request):
        raise httpx.ConnectError(PRIVATE, request=request)

    transport = _Transport(fail)
    with OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY) as adapter:
        with pytest.raises(ProviderRequestError) as caught:
            generate(adapter)
    assert len(transport.requests) == 3 and len(adapter_runtime.delays) == 2
    assert caught.value.reason == 'connection_error' and caught.value.retryable is True
    assert transport.closes == 1
    assert_safe(caught.value)


def test_redirect_cannot_send_key_to_another_host(adapter_runtime):
    transport = _Transport(lambda _request: (307, {'error': {'message': PRIVATE}}))

    def redirect(request):
        response = transport.respond(request)
        response.headers['location'] = 'https://synthetic-other-host.invalid/private'
        return response

    transport.handler = redirect
    with OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY) as adapter:
        with pytest.raises(ProviderRequestError) as caught:
            generate(adapter)
    assert len(transport.requests) == 1
    assert transport.requests[0].url.host == 'openrouter.ai'
    assert caught.value.retryable is False and adapter_runtime.delays == []
    assert transport.streams[0].closes == transport.closes == 1
    assert_safe(caught.value)


@pytest.mark.parametrize('request_thread,read_timeout', [(False, 600.0), (True, 60.0)])
def test_sdk_wire_timeout_phases(adapter_runtime, request_thread, read_timeout):
    transport = _Transport()
    context = Flask(__name__).test_request_context() if request_thread else nullcontext()
    with context, OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY) as adapter:
        generate(adapter)
    assert transport.requests[0].extensions['timeout'] == {
        'connect': 10.0, 'read': read_timeout, 'write': 30.0, 'pool': 5.0}
    assert all(plugin['enabled'] is False for plugin in json.loads(transport.requests[0].content)['plugins'])


def test_file_prepared_once_for_retries_and_client_closed_once(adapter_runtime, tmp_path, monkeypatch):
    from lecture_processor.domains.ai.providers import openrouter_request

    pdf = tmp_path / 'private-file.pdf'
    pdf.write_bytes(b'%PDF synthetic')
    reads = []
    read = openrouter_request._read_file

    def counted(path, max_bytes):
        reads.append(path)
        return read(path, max_bytes)

    monkeypatch.setattr(openrouter_request, '_read_file', counted)
    outcomes = iter([(503, {'error': {'message': PRIVATE}}), (200, success())])
    transport = _Transport(lambda _request: next(outcomes))
    tracker = {}
    adapter = OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY)
    with adapter:
        result = adapter.generate(MODEL, [PdfPart(pdf)], options=OPTIONS,
                                  retry_tracker=tracker, operation_name='extract')
    adapter.close()
    assert reads == [pdf] and pdf.exists()
    assert len(transport.requests) == 2 and tracker == {'extract': 1}
    assert transport.requests[0].content == transport.requests[1].content
    assert result.text == '{"answer": 2}'
    assert transport.closes == 1 and all(stream.closes == 1 for stream in transport.streams)
    with pytest.raises(RuntimeError, match='workflow is closed'):
        generate(adapter)


def test_parallel_workflows_own_distinct_clients_and_cleanup(adapter_runtime):
    barrier = Barrier(2)

    def workflow(index):
        def respond(_request):
            barrier.wait(timeout=10)
            return 200, success()

        transport = _Transport(respond)
        adapter = OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY)
        with adapter:
            result = adapter.generate(MODEL, [TextPart(f'workflow-{index}')], options=OPTIONS)
            client = adapter._http
        return transport, client, result

    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = list(pool.map(workflow, [1, 2]))
    assert first[1] is not second[1] and first[1].is_closed and second[1].is_closed
    for index, (transport, _client, result) in enumerate((first, second), 1):
        assert transport.closes == 1 and result.usage.cost_usd == 0
        assert json.loads(transport.requests[0].content)['messages'][0]['content'][0]['text'] == f'workflow-{index}'


def test_cancellation_during_response_read_closes_response_and_workflow(adapter_runtime):
    class InterruptedResponse(_Stream):
        def __iter__(self):
            raise KeyboardInterrupt('synthetic cancellation')
            yield  # Make interruption occur during response consumption.

    stream = InterruptedResponse(b'')
    transport = _Transport()
    transport.outcome = lambda _request: (200, success())
    transport.handler = lambda request: httpx.Response(
        200, headers={'Content-Type': 'application/json'}, stream=stream)
    adapter = OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY)
    with pytest.raises(KeyboardInterrupt, match='synthetic cancellation'):
        with adapter:
            generate(adapter)
    adapter.close()
    assert stream.closes == transport.closes == 1
    assert adapter_runtime.delays == []


def test_repeated_generations_reuse_only_their_workflow_client(adapter_runtime):
    transport = _Transport()
    with OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY) as adapter:
        first = generate(adapter)
        client = adapter._http
        second = generate(adapter)
        assert adapter._http is client and client.is_closed is False
    assert first == second and len(transport.requests) == 2
    assert client.is_closed and transport.closes == 1
    assert all(stream.closes == 1 for stream in transport.streams)


def test_custom_headers_fail_closed_without_sending_or_leaking(adapter_runtime, monkeypatch):
    monkeypatch.setenv('OPENAI_CUSTOM_HEADERS', json.dumps({
        'Authorization': PRIVATE, 'Host': PRIVATE, 'X-arbitrary-leak': PRIVATE}))
    transport = _Transport()
    with OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY) as adapter:
        with pytest.raises(RuntimeError) as caught:
            generate(adapter)
    assert transport.requests == []
    assert_safe(caught.value)


def test_debug_sdk_logs_are_muted_in_fresh_process_with_application_log_control():
    script = r'''
import json, logging, socket
from types import SimpleNamespace
def blocked(*args, **kwargs):
    raise AssertionError('Network disabled')
socket.getaddrinfo = blocked
socket.socket.connect = blocked
socket.socket.connect_ex = blocked
import httpx
from lecture_processor.domains.ai.providers.openrouter import OpenRouterProvider
from lecture_processor.domains.ai.providers.contracts import TextPart
from lecture_processor.domains.ai.providers.errors import ProviderRequestError
logging.basicConfig(level=logging.DEBUG, force=True)
logger = logging.getLogger('application.synthetic')
logger.warning('application-control-before')
runtime = SimpleNamespace(PROVIDER_RETRY_MAX_ATTEMPTS=2, time=SimpleNamespace(sleep=lambda value: None),
                          random=SimpleNamespace(uniform=lambda *args: 0), logger=logger)
def respond(request):
    return httpx.Response(503, json={'error': {'message': 'synthetic-private-body-marker'}})
with OpenRouterProvider(runtime, transport=httpx.MockTransport(respond),
                        api_key='synthetic-private-key-marker') as adapter:
    try:
        adapter.generate('anthropic/claude-sonnet-5.5', [TextPart('synthetic-private-body-marker')],
                         options={'reasoning_effort': 'medium', 'max_output_tokens': 32768})
    except ProviderRequestError as error:
        assert error.__cause__ is None and error.__context__ is None
        print(str(error), repr(vars(error)), repr(error.args))
    else:
        raise AssertionError('Expected a safe provider failure')
logger.warning('application-control-after')
'''
    environment = {
        'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
        'PYTHONPATH': str(Path(__file__).resolve().parents[1]),
        'APP_ENV': 'test', 'SENTRY_ENVIRONMENT': 'test',
        'LP_FORCE_FAKE_PROVIDER': '1', 'OPENAI_LOG': 'debug',
    }
    process = subprocess.run([sys.executable, '-c', script], env=environment,
                             capture_output=True, text=True, timeout=30, check=False)
    combined = process.stdout + process.stderr
    assert process.returncode == 0, combined
    assert 'application-control-before' in combined and 'application-control-after' in combined
    assert 'Transient provider error' in combined and 'HTTP_503' in combined
    assert PRIVATE not in combined and KEY not in combined
    assert 'Request options:' not in combined


def test_notes_retry_sends_larger_reviewed_cap_and_accounts_for_both_responses(adapter_runtime):
    from lecture_processor.domains.ai.provider import TokenAccumulator
    from lecture_processor.domains.ai.providers.factory import ProviderSession
    from lecture_processor.domains.ai.providers.routing import Route, RoutingSnapshot

    options = {**OPTIONS, 'retry_max_output_tokens': 65536}
    snapshot = RoutingSnapshot({'notes_merge': Route('openrouter', MODEL, options)})

    def respond(request):
        body = json.loads(request.content)
        assert body['provider']['only'] == ['google-vertex/global'] and body['provider']['zdr']
        result = success()
        if body['max_tokens'] == 32768:
            result['choices'][0] = {'finish_reason': 'length', 'message': {'content': None}}
        result['usage']['cost'] = 0.125
        return 200, result

    transport = _Transport(respond)
    tokens = TokenAccumulator(runtime=adapter_runtime)
    with ProviderSession(adapter_runtime, routes=snapshot) as session:
        session._adapters['openrouter'] = OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY)
        # The adapter already has an isolated transport and the fixture blocks all sockets.
        session._forced = False
        result = session.generate('notes_merge', [TextPart('synthetic')], record_discarded=tokens.record_result)
        tokens.record_result('merge', result)

    assert [json.loads(req.content)['max_tokens'] for req in transport.requests] == [32768, 65536]
    usage = tokens.as_dict()
    assert usage['token_total'] == 74
    assert {key: val['cost_usd'] for key, val in usage['token_usage_by_stage'].items()} == {
        'notes_merge_incomplete_1': 0.125, 'merge': 0.125,
    }


def test_truncated_non_document_schema_records_partial_usage_before_failure(adapter_runtime):
    from lecture_processor.domains.ai.provider import TokenAccumulator
    from lecture_processor.domains.ai.providers.factory import ProviderSession
    from lecture_processor.domains.ai.providers.routing import Route, RoutingSnapshot

    partial = success()
    partial['choices'][0].update(finish_reason='length', message={'content': '{"answer":'})
    partial['usage']['cost'] = 0.004
    transport = _Transport(lambda _: (200, partial))
    snapshot = RoutingSnapshot({'interview_coding': Route('openrouter', MODEL, OPTIONS)})
    tokens = TokenAccumulator(runtime=adapter_runtime)
    with ProviderSession(adapter_runtime, routes=snapshot) as session:
        session._forced = False
        session._adapters['openrouter'] = OpenRouterProvider(adapter_runtime, transport=transport, api_key=KEY)
        with pytest.raises(ProviderRequestError, match='INCOMPLETE'):
            session.generate('interview_coding', [TextPart('fixture')], schema={'type': 'object'},
                             record_discarded=tokens.record_result)
    assert len(transport.requests) == 1
    usage = tokens.as_dict()
    assert usage['token_total'] == 37
    assert usage['token_usage_by_stage']['interview_coding_incomplete']['cost_usd'] == 0.004
