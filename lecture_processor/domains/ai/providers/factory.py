"""Workflow-local generation selected from an immutable routing snapshot."""
from pathlib import Path

from .contracts import AudioPart
from .gemini import GeminiProvider
from .routing import AUDIO_STAGES, STAGES, default_models, load_routing, validate_openrouter_options


class _ClientRuntime:
    def __init__(self, runtime, client):
        self._runtime = runtime
        self.client = client

    def __getattr__(self, name):
        return getattr(self._runtime, name)


class ProviderSession:
    def __init__(self, runtime, *, routes=None):
        from lecture_processor.runtime.bootstrap import is_forced_fake_provider

        self.runtime = runtime
        self.routes = routes if routes is not None else getattr(runtime, 'AI_ROUTING_SNAPSHOT', None)
        if self.routes is None:
            root = Path(getattr(runtime, 'PROJECT_ROOT_DIR', Path(__file__).resolve().parents[4]))
            self.routes = load_routing(root / 'config' / 'ai_routing.json', default_models(runtime))
        self._forced = is_forced_fake_provider()
        self._adapters = {}
        self._closed = False

    def generate(self, stage, parts, *, schema=None, max_output_tokens=65536,
                 retry_tracker=None, operation_name=None):
        if self._closed:
            raise RuntimeError('The provider workflow is closed.')
        if not isinstance(stage, str) or stage not in STAGES or stage not in self.routes.routes:
            raise ValueError('Unknown generation stage.')
        route = self.routes.routes[stage]
        if stage in AUDIO_STAGES and route.provider != 'gemini':
            raise ValueError('Audio generation requires Gemini.')
        if route.provider not in {'gemini', 'openrouter'}:
            raise ValueError('Unsupported generation provider.')
        options = None
        if route.provider == 'openrouter':
            options = validate_openrouter_options(route.model, route.options)
            if type(max_output_tokens) is not int or max_output_tokens <= 0:
                raise ValueError('Invalid generation output limit.')
            max_output_tokens = min(max_output_tokens, options['max_output_tokens'])
            parts = tuple(parts)
            if any(isinstance(part, AudioPart) for part in parts):
                raise ValueError('Audio generation requires Gemini.')
        if route.provider not in self._adapters:
            if self._forced:
                from .fake import FakeGeminiClient, FakeProvider
                client = getattr(self.runtime, 'client', None)
                if not isinstance(client, FakeGeminiClient):
                    client = FakeGeminiClient()
                adapter = FakeProvider(_ClientRuntime(self.runtime, client))
            elif route.provider == 'openrouter':
                from .openrouter import OpenRouterProvider
                adapter = OpenRouterProvider(self.runtime)
            else:
                adapter = GeminiProvider(self.runtime)
            self._adapters[route.provider] = adapter
        extra = {'options': options} if route.provider == 'openrouter' and not self._forced else {}
        return self._adapters[route.provider].generate(
            route.model, parts, schema=schema, max_output_tokens=max_output_tokens,
            retry_tracker=retry_tracker, operation_name=operation_name or stage,
            **extra,
        )

    def close(self):
        if not self._closed:
            self._closed = True
            for adapter in self._adapters.values():
                adapter.close()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


def open_provider_session(runtime, *, routes=None):
    return ProviderSession(runtime, routes=routes)
