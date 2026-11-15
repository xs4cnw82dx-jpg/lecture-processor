"""Stage routing preserves forced isolation before resolving provider clients."""
import builtins
import os
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai.providers.contracts import AudioPart, TextPart
from lecture_processor.domains.ai.providers.factory import open_provider_session
from lecture_processor.domains.ai.providers.fake import FakeGeminiClient
from lecture_processor.domains.ai.providers.routing import AUDIO_STAGES, Route, RoutingSnapshot

MODEL = 'anthropic/claude-haiku-5.5'
OPTIONS = {'reasoning_effort': 'medium', 'max_output_tokens': 32768}


class UnavailableClientRuntime:
    @property
    def client(self):
        pytest.fail('Invalid routing must fail before client resolution.')


def test_forced_openrouter_route_never_reads_keys_or_imports_sdk(monkeypatch):
    monkeypatch.setenv('LP_FORCE_FAKE_PROVIDER', '1')
    monkeypatch.setenv('APP_ENV', 'test')
    monkeypatch.setenv('OPENROUTER_API_KEY', 'synthetic-unused')
    original_getenv, original_import = os.getenv, builtins.__import__

    def guarded_getenv(name, default=None):
        if name in {'OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'}:
            pytest.fail('Forced routing must not read provider credentials.')
        return original_getenv(name, default)

    def guarded_import(name, *args, **kwargs):
        if name == 'openai' or name.startswith('openai.') or name == 'openrouter' or name.startswith('openrouter.'):
            pytest.fail('Forced routing must not import a real provider SDK.')
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(os, 'getenv', guarded_getenv)
    monkeypatch.setattr(builtins, '__import__', guarded_import)
    captured = []

    class RecordingFake(FakeGeminiClient):
        def _generate_content(self, **kwargs):
            captured.append(kwargs)
            return super()._generate_content(**kwargs)

    client = RecordingFake({'models.generate_content': [SimpleNamespace(text=' synthetic ', parsed=None)]})
    runtime = SimpleNamespace(client=client, types=SimpleNamespace(), MODEL_THINKING_POLICY={},
                              PROVIDER_RETRY_MAX_ATTEMPTS=1)
    routes = RoutingSnapshot({'notes_merge': Route('openrouter', MODEL, OPTIONS)})
    with open_provider_session(runtime, routes=routes) as session:
        result = session.generate('notes_merge', [TextPart('synthetic request')], max_output_tokens=65536)
    assert result.provider == 'fake' and result.model == MODEL and result.text == ' synthetic '
    assert captured[0]['config']['max_output_tokens'] == 32768
    assert client.calls == ('models.generate_content',)


@pytest.mark.parametrize('stage', sorted(AUDIO_STAGES))
def test_manual_openrouter_audio_routes_are_rejected_before_client_resolution(stage):
    routes = RoutingSnapshot({stage: Route('openrouter', MODEL, OPTIONS)})
    with open_provider_session(UnavailableClientRuntime(), routes=routes) as session:
        with pytest.raises(ValueError, match='^Audio generation requires Gemini\\.$'):
            session.generate(stage, [TextPart('synthetic')])


def test_audio_disguised_as_text_stage_is_rejected_before_client_resolution():
    routes = RoutingSnapshot({'notes_merge': Route('openrouter', MODEL, OPTIONS)})
    with open_provider_session(UnavailableClientRuntime(), routes=routes) as session:
        with pytest.raises(ValueError, match='^Audio generation requires Gemini\\.$'):
            session.generate('notes_merge', [AudioPart('not-opened.wav', 'audio/wav')])


@pytest.mark.parametrize('options', [
    {}, {'reasoning_effort': 'medium', 'max_output_tokens': True},
    {'reasoning_effort': 'unsupported', 'max_output_tokens': 32768},
    {**OPTIONS, 'provider': {'zdr': False}},
])
def test_manual_unvalidated_options_do_not_bypass_loader_validation(options):
    route = SimpleNamespace(provider='openrouter', model=MODEL, options=options)
    with open_provider_session(UnavailableClientRuntime(), routes=RoutingSnapshot({'notes_merge': route})) as session:
        with pytest.raises(ValueError, match='^Invalid AI routing configuration\\.$'):
            session.generate('notes_merge', [TextPart('synthetic')])
