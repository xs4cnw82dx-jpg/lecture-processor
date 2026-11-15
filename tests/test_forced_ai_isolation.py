"""Runner entrypoint guards, using only sentinel environment values."""
import json
import os
from pathlib import Path
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai.providers.contracts import PdfPart, TextPart
from lecture_processor.domains.ai.providers.fake import FakeGeminiClient, FakeProvider, FakeProviderError
from lecture_processor.domains.ai.providers.factory import open_provider_session
from lecture_processor.domains.ai.providers.routing import Route, RoutingSnapshot
from lecture_processor.runtime import bootstrap

PROJECT_ROOT = Path(__file__).resolve().parents[1]

PROBE = r'''
import builtins
import json
import os
import runpy
import sys

class ImportBoundaryReached(BaseException):
    pass

original_import = builtins.__import__

def guarded_import(name, *args, **kwargs):
    if name == 'lecture_processor' or name.startswith('lecture_processor.'):
        # Stop before any application import, real SDK or dotenv initialization.
        assert os.environ.get('LP_FORCE_FAKE_PROVIDER') == '1', 'runner did not force fake provider before application import'
        assert os.environ.get('APP_ENV') == 'test', 'runner did not force isolated test mode'
        assert os.environ.get('SENTRY_ENVIRONMENT') == 'test', 'runner did not force isolated monitoring mode'
        forbidden = ('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY', 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_DEPLOY_ID')
        assert all(not os.environ.get(key) for key in forbidden), 'runner retained provider credentials or production environment markers'
        print('ISOLATION_BOUNDARY=' + json.dumps({'forced': True, 'keys_removed': True}))
        raise ImportBoundaryReached()
    return original_import(name, *args, **kwargs)

builtins.__import__ = guarded_import
sys.argv = [sys.argv[1]]
try:
    runpy.run_path(sys.argv[0], run_name='__main__')
except ImportBoundaryReached:
    pass
else:
    raise AssertionError('runner never reached the guarded application import')
'''


@pytest.mark.parametrize('runner', [
    'run_pytest_isolated.py', 'run_ui_preview.py', 'run_physio_companion_e2e.py',
])
def test_actual_runner_forces_isolation_before_any_application_import(tmp_path, runner):
    environment = {
        'PATH': os.environ.get('PATH', ''),
        'PYTHONPATH': str(PROJECT_ROOT),
        'PYTHONDONTWRITEBYTECODE': '1',
        'LP_FORCE_FAKE_PROVIDER': '0',
        'APP_ENV': 'production',
        'SENTRY_ENVIRONMENT': 'production',
        'RENDER': '1',
        'RENDER_SERVICE_ID': 'synthetic-service',
        'RENDER_DEPLOY_ID': 'synthetic-deploy',
        'GEMINI_API_KEY': 'sentinel-gemini-not-a-real-key',
        'GOOGLE_API_KEY': 'sentinel-google-not-a-real-key',
        'OPENROUTER_API_KEY': 'sentinel-openrouter-not-a-real-key',
    }
    result = subprocess.run(
        [sys.executable, '-c', PROBE, str(PROJECT_ROOT / 'scripts' / runner)],
        cwd=tmp_path, env=environment, text=True, capture_output=True,
        timeout=30, check=False,
    )
    assert result.returncode == 0, result.stderr
    line = next(line for line in result.stdout.splitlines() if line.startswith('ISOLATION_BOUNDARY='))
    assert json.loads(line.split('=', 1)[1]) == {'forced': True, 'keys_removed': True}


def forbidden(*_args, **_kwargs):
    raise AssertionError('A forbidden external initialization was attempted')


class NoKeyReads(dict):
    def get(self, key, default=None):
        if key in {'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'}:
            forbidden()
        return super().get(key, default)


def test_forced_bootstrap_skips_dotenv_keys_and_sdk_constructor(monkeypatch):
    environment = NoKeyReads(LP_FORCE_FAKE_PROVIDER='1', APP_ENV='test',
                             GEMINI_API_KEY='synthetic-key', OPENROUTER_API_KEY='synthetic-key')
    monkeypatch.setattr(bootstrap, 'load_dotenv', forbidden)
    bootstrap.load_local_environment(environ=environment)
    options = {'genai_module': SimpleNamespace(Client=forbidden), 'logger': SimpleNamespace(warning=forbidden),
               'environ': environment}
    first = bootstrap.initialize_ai_client(**options)
    second = bootstrap.initialize_ai_client(**options)
    assert isinstance(first, FakeGeminiClient)
    assert isinstance(second, FakeGeminiClient)
    assert first is not second
    for client in (first, second):
        with pytest.raises(FakeProviderError, match='^Fake provider operation is unavailable\\.$'):
            client.models.generate_content(model='synthetic', contents=['synthetic'])
        with pytest.raises(FakeProviderError):
            client.batches.create(model='synthetic', src='synthetic')


@pytest.mark.parametrize('changes', [
    {'APP_ENV': 'production'}, {'APP_ENV': ''}, {'SENTRY_ENVIRONMENT': 'production'}, {'RENDER': '1'},
    {'RENDER_SERVICE_ID': 'synthetic'}, {'RENDER_DEPLOY_ID': 'synthetic'},
])
def test_forced_bootstrap_rejects_production_before_keys_or_dotenv(monkeypatch, changes):
    environment = NoKeyReads(LP_FORCE_FAKE_PROVIDER='1', APP_ENV='test')
    environment.update(changes)
    monkeypatch.setattr(bootstrap, 'load_dotenv', forbidden)
    with pytest.raises(RuntimeError, match='^Fake providers require an isolated test environment\\.$'):
        bootstrap.load_local_environment(environ=environment)
    with pytest.raises(RuntimeError, match='^Fake providers require an isolated test environment\\.$'):
        bootstrap.initialize_ai_client(genai_module=SimpleNamespace(Client=forbidden),
                                       logger=SimpleNamespace(warning=forbidden), environ=environment)


def test_unforced_application_factory_preserves_injected_gemini_constructor():
    calls = []
    expected = object()
    def construct(**kwargs):
        calls.append(kwargs)
        return expected
    sdk = SimpleNamespace(Client=construct, types=SimpleNamespace(HttpOptions=lambda **kwargs: kwargs))
    result = bootstrap.initialize_ai_client(genai_module=sdk, logger=SimpleNamespace(warning=forbidden),
                                          environ={'LP_FORCE_FAKE_PROVIDER': '0', 'GEMINI_API_KEY': 'synthetic-key'})
    assert result is expected
    assert len(calls) == 1
    assert calls[0]['api_key'] == 'synthetic-key'
    assert calls[0]['http_options']['timeout'] > 0


def response(text):
    return SimpleNamespace(text=text, parsed=None, usage_metadata=SimpleNamespace(
        prompt_token_count=2, candidates_token_count=3, thoughts_token_count=1, total_token_count=6))


def synthetic_runtime(client):
    return SimpleNamespace(client=client, types=SimpleNamespace(), MODEL_THINKING_POLICY={},
                           PROVIDER_RETRY_MAX_ATTEMPTS=1, os=SimpleNamespace(getenv=lambda _key, default: default),
                           logger=SimpleNamespace(warning=lambda *_args: None))


def test_scripted_clients_and_neutral_providers_do_not_share_scenarios(tmp_path):
    scenarios = {'models.generate_content': [response('first'), response('second')]}
    first, second = FakeGeminiClient(scenarios), FakeGeminiClient(scenarios)
    scenarios['models.generate_content'].clear()
    local_pdf = tmp_path / 'synthetic.pdf'
    local_pdf.write_bytes(b'%PDF-1.4 synthetic only')
    with FakeProvider(synthetic_runtime(first)) as provider:
        result = provider.generate('synthetic-model', [TextPart('synthetic'), PdfPart(local_pdf)])
        assert (result.provider, result.text, result.usage.output_tokens, result.usage.thinking_tokens) == ('fake', 'first', 4, 1)
        assert second.models.generate_content(model='synthetic-model', contents=[]).text == 'first'
        assert provider.generate('synthetic-model', [PdfPart(local_pdf)]).text == 'second'
        assert first.calls.count('files.upload') == 1
    provider.close()
    assert first.calls.count('files.delete') == 1
    assert local_pdf.read_bytes() == b'%PDF-1.4 synthetic only'
    assert second.models.generate_content(model='synthetic-model', contents=[]).text == 'second'
    with pytest.raises(FakeProviderError):
        first.models.generate_content(model='synthetic-model', contents=[])
    with pytest.raises(ValueError, match='^Fake provider requires a local fake client\\.$'):
        FakeProvider(synthetic_runtime(SimpleNamespace()))


def test_forced_sessions_never_use_an_injected_nonfake_client(monkeypatch):
    monkeypatch.setenv('LP_FORCE_FAKE_PROVIDER', '1')
    monkeypatch.setenv('APP_ENV', 'test')
    monkeypatch.setenv('GEMINI_API_KEY', 'synthetic-key')
    monkeypatch.setenv('OPENROUTER_API_KEY', 'synthetic-key')
    routes = RoutingSnapshot({'study_tools': Route('gemini', 'gemini-synthetic')})
    runtime = synthetic_runtime(SimpleNamespace(models=SimpleNamespace(generate_content=forbidden)))
    for _ in range(2):
        with open_provider_session(runtime, routes=routes) as session:
            with pytest.raises(FakeProviderError):
                session.generate('study_tools', [TextPart('synthetic')])
    scripted = synthetic_runtime(FakeGeminiClient({'models.generate_content': [response('explicit scenario')]}))
    with open_provider_session(scripted, routes=routes) as session:
        assert session.generate('study_tools', [TextPart('synthetic')]).text == 'explicit scenario'


def test_local_file_handles_are_isolated_and_deletion_is_idempotent():
    first, second = FakeGeminiClient(), FakeGeminiClient()
    uploaded = first.files.upload(file='a path that is never opened', config={'mime_type': 'application/pdf'})
    other = second.files.upload(file='a path that is never opened')
    assert uploaded.name != other.name
    assert uploaded.uri.startswith('fake://')
    assert uploaded.state.name == 'ACTIVE'
    uploaded.state.name = 'changed by caller'
    assert first.files.get(name=uploaded.name).state.name == 'ACTIVE'
    with pytest.raises(FakeProviderError) as missing:
        second.files.get(name=uploaded.name)
    assert missing.value.status_code == 404
    first.files.delete(name=uploaded.name)
    first.files.delete(name=uploaded.name)
    with pytest.raises(FakeProviderError):
        first.files.get(name=uploaded.name)
    assert second.files.get(name=other.name).name == other.name


def test_scripted_batch_poll_download_cancel_and_errors_are_local():
    pending = SimpleNamespace(name='batches/synthetic', state=SimpleNamespace(name='JOB_STATE_PENDING'))
    complete = SimpleNamespace(name=pending.name, state=SimpleNamespace(name='JOB_STATE_SUCCEEDED'),
                               dest=SimpleNamespace(file_name='files/synthetic-output'))
    client = FakeGeminiClient({
        'batches.create': [pending], 'batches.get': [FakeProviderError(503), complete],
        'files.download': [b'{"key":"synthetic","response":{"text":"local result"}}\n'],
    })
    assert client.batches.create(model='synthetic', src='files/local-input').state.name == 'JOB_STATE_PENDING'
    with pytest.raises(FakeProviderError) as transient:
        client.batches.get(name=pending.name)
    assert transient.value.status_code == 503
    assert str(transient.value) == 'Fake provider operation is unavailable.'
    result = client.batches.get(name=pending.name)
    assert result.state.name == 'JOB_STATE_SUCCEEDED'
    assert json.loads(client.files.download(file=result.dest.file_name))['key'] == 'synthetic'
    assert client.batches.cancel(name=pending.name).state.name == 'JOB_STATE_CANCELLED'
    assert client.batches.get(name=pending.name).state.name == 'JOB_STATE_CANCELLED'
    for operation in (lambda: client.batches.create(model='synthetic', src='files/local-input'),
                      lambda: client.files.download(file=result.dest.file_name)):
        with pytest.raises(FakeProviderError):
            operation()


@pytest.mark.parametrize('scenarios', [
    {'unknown-sensitive-operation': []}, {'models.generate_content': 'not a sequence'},
    {'models.generate_content': [RuntimeError('sensitive synthetic detail')]},
    {'models.generate_content': [None] * (FakeGeminiClient.MAX_SCENARIO_STEPS + 1)},
])
def test_invalid_or_unbounded_scenarios_fail_with_fixed_errors(scenarios):
    with pytest.raises(ValueError, match='^Invalid fake provider scenario\\.$'):
        FakeGeminiClient(scenarios)


def test_scenario_consumption_is_atomic_and_resources_are_bounded():
    client = FakeGeminiClient({'models.generate_content': [response(str(index)) for index in range(16)]})
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: client.models.generate_content(model='synthetic', contents=[]).text, range(16)))
    assert sorted(map(int, results)) == list(range(16))
    handles = [client.files.upload(file='synthetic') for _ in range(client.MAX_RESOURCES)]
    with pytest.raises(FakeProviderError) as full:
        client.files.upload(file='synthetic')
    assert full.value.status_code == 429
    client.files.delete(name=handles[0].name)
    assert client.files.upload(file='synthetic').name
    assert len(client.calls) <= client.MAX_SCENARIO_STEPS


FACTORY_PROBE = r'''
import json
import os
import runpy
import sys
from unittest.mock import patch

import dotenv
from google import genai

def forbidden(*args, **kwargs):
    raise AssertionError('external SDK or dotenv initialization attempted')

def inspect_factory(*args, **kwargs):
    from lecture_processor import create_app
    from lecture_processor.runtime import core
    from lecture_processor.runtime.container import get_runtime
    from lecture_processor.domains.ai.providers.fake import FakeGeminiClient, FakeProviderError
    with patch('lecture_processor.runtime.container._start_cleanup_thread_once'):
        first, second = create_app(), create_app()
    assert isinstance(core.client, FakeGeminiClient)
    assert get_runtime(first).client is get_runtime(second).client is core.client
    assert core.db is None
    assert not core.RUNTIME_JOB_RECOVERY_ENABLED and not core.BATCH_JOB_RECOVERY_ENABLED
    for client in (core.client, get_runtime(second).clients.gemini_client):
        try:
            client.models.generate_content(model='synthetic', contents=['synthetic'])
        except FakeProviderError:
            pass
        else:
            raise AssertionError('unscripted bootstrap generation did not fail closed')
    assert all(not os.environ.get(key) for key in ('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY'))
    print('FACTORY_ISOLATION=' + json.dumps({'fake': True, 'shared_unscripted': True}))
    return 0

runner = sys.argv[1]
sys.argv = [runner]
with patch.object(genai, 'Client', forbidden), patch.object(dotenv, 'load_dotenv', forbidden):
    if runner.endswith('run_pytest_isolated.py'):
        import pytest
        with patch.object(pytest, 'main', inspect_factory):
            runpy.run_path(runner, run_name='__main__')
    else:
        import flask
        with patch.object(flask.Flask, 'run', inspect_factory):
            runpy.run_path(runner, run_name='__main__')
'''


@pytest.mark.parametrize('runner', ['run_pytest_isolated.py', 'run_ui_preview.py'])
def test_actual_runner_repeated_app_factory_uses_unscripted_fake_without_sdk_or_dotenv(tmp_path, runner):
    (tmp_path / '.env').write_text('GEMINI_API_KEY=synthetic-dotenv-key\n')
    environment = {'PATH': os.environ.get('PATH', ''), 'PYTHONPATH': str(PROJECT_ROOT),
                   'PYTHONDONTWRITEBYTECODE': '1', 'APP_ENV': 'production', 'LP_FORCE_FAKE_PROVIDER': '0',
                   'GEMINI_API_KEY': 'synthetic-key', 'GOOGLE_API_KEY': 'synthetic-key',
                   'OPENROUTER_API_KEY': 'synthetic-key', 'RENDER_SERVICE_ID': 'synthetic-service'}
    result = subprocess.run([sys.executable, '-c', FACTORY_PROBE, str(PROJECT_ROOT / 'scripts' / runner)],
                            cwd=tmp_path, env=environment, capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stderr
    line = next(line for line in result.stdout.splitlines() if line.startswith('FACTORY_ISOLATION='))
    assert json.loads(line.split('=', 1)[1]) == {'fake': True, 'shared_unscripted': True}


def test_contract_routing_and_fake_imports_do_not_boot_runtime_or_clients(tmp_path):
    probe = r'''
import importlib
import sys
from unittest.mock import patch
import dotenv
from google import genai

def forbidden(*args, **kwargs):
    raise AssertionError('pure import attempted client or dotenv initialization')

with patch.object(genai, 'Client', forbidden), patch.object(dotenv, 'load_dotenv', forbidden):
    for name in ('contracts', 'routing', 'fake'):
        importlib.import_module('lecture_processor.domains.ai.providers.' + name)
    assert 'lecture_processor.runtime.core' not in sys.modules
print('PURE_IMPORTS_OK')
'''
    (tmp_path / '.env').write_text('GEMINI_API_KEY=synthetic-dotenv-key\n')
    environment = {'PATH': os.environ.get('PATH', ''), 'PYTHONPATH': str(PROJECT_ROOT),
                   'PYTHONDONTWRITEBYTECODE': '1', 'APP_ENV': 'production', 'SENTRY_ENVIRONMENT': 'production',
                   'LP_FORCE_FAKE_PROVIDER': '0', 'GEMINI_API_KEY': 'synthetic-key',
                   'OPENROUTER_API_KEY': 'synthetic-key'}
    result = subprocess.run([sys.executable, '-c', probe], cwd=tmp_path, env=environment,
                            capture_output=True, text=True, timeout=30, check=False)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == 'PURE_IMPORTS_OK'
