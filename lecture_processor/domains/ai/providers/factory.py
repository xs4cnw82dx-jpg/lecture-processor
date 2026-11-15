"""Workflow-local generation selected from an immutable routing snapshot."""
from pathlib import Path

from .gemini import GeminiProvider
from .routing import STAGES, default_models, load_routing


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
        self._adapter = None
        self._closed = False

    def generate(self, stage, parts, *, schema=None, max_output_tokens=65536,
                 retry_tracker=None, operation_name=None):
        if self._closed:
            raise RuntimeError('The provider workflow is closed.')
        if not isinstance(stage, str) or stage not in STAGES or stage not in self.routes.routes:
            raise ValueError('Unknown generation stage.')
        route = self.routes.routes[stage]
        # This release deliberately registers Gemini only. A key cannot enable a route.
        if route.provider != 'gemini':
            raise ValueError('Unsupported generation provider.')
        if self._adapter is None:
            if self._forced:
                from .fake import FakeGeminiClient, FakeProvider
                client = getattr(self.runtime, 'client', None)
                if not isinstance(client, FakeGeminiClient):
                    client = FakeGeminiClient()
                self._adapter = FakeProvider(_ClientRuntime(self.runtime, client))
            else:
                self._adapter = GeminiProvider(self.runtime)
        return self._adapter.generate(
            route.model, parts, schema=schema, max_output_tokens=max_output_tokens,
            retry_tracker=retry_tracker, operation_name=operation_name or stage,
        )

    def close(self):
        if not self._closed:
            self._closed = True
            if self._adapter is not None:
                self._adapter.close()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


def open_provider_session(runtime, *, routes=None):
    return ProviderSession(runtime, routes=routes)
