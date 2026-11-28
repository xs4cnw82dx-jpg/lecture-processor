"""Local-only provider doubles with explicit, bounded per-instance scenarios."""

from collections import deque
from copy import deepcopy
from dataclasses import replace
from threading import RLock
from types import SimpleNamespace
from uuid import uuid4


class FakeProviderError(RuntimeError):
    def __init__(self, status_code=400):
        super().__init__('Fake provider operation is unavailable.')
        self.status_code = status_code if type(status_code) is int and 400 <= status_code <= 599 else 400


class FakeGeminiClient:
    MAX_SCENARIO_STEPS = 128
    MAX_RESOURCES = 128
    OPERATIONS = frozenset({
        'models.generate_content', 'files.upload', 'files.get', 'files.delete', 'files.download',
        'batches.create', 'batches.get', 'batches.cancel',
    })

    def __init__(self, scenarios=None):
        if scenarios is None:
            scenarios = {}
        if (not isinstance(scenarios, dict)
                or any(key not in self.OPERATIONS or not isinstance(values, (list, tuple))
                       for key, values in scenarios.items())
                or sum(len(values) for values in scenarios.values()) > self.MAX_SCENARIO_STEPS
                or any(isinstance(value, BaseException) and not isinstance(value, FakeProviderError)
                       for values in scenarios.values() for value in values)):
            raise ValueError('Invalid fake provider scenario.')
        self._scenarios = {
            key: deque(FakeProviderError(value.status_code) if isinstance(value, FakeProviderError) else deepcopy(value)
                       for value in values)
            for key, values in scenarios.items()
        }
        self._lock = RLock()
        self._calls = deque(maxlen=self.MAX_SCENARIO_STEPS)
        self._files = {}
        self._batches = {}
        self._prefix = uuid4().hex
        self._sequence = 0
        self.models = SimpleNamespace(generate_content=self._generate_content)
        self.files = SimpleNamespace(upload=self._upload, get=self._get_file,
                                     delete=self._delete_file, download=self._download)
        self.batches = SimpleNamespace(create=self._create_batch, get=self._get_batch, cancel=self._cancel_batch)

    @property
    def calls(self):
        with self._lock:
            return tuple(self._calls)

    def _next(self, operation):
        self._calls.append(operation)
        queue = self._scenarios.get(operation)
        if not queue:
            return False, None
        outcome = queue.popleft()
        if isinstance(outcome, FakeProviderError):
            raise outcome
        return True, outcome

    def _store(self, records, result):
        name = getattr(result, 'name', None)
        if not isinstance(name, str) or not name or len(name) > 256:
            raise FakeProviderError()
        if name not in records and len(records) >= self.MAX_RESOURCES:
            raise FakeProviderError(429)
        records[name] = deepcopy(result)
        return result

    def _generate_content(self, *, model, contents, config=None):
        with self._lock:
            scripted, result = self._next('models.generate_content')
            if not scripted or not hasattr(result, 'text'):
                raise FakeProviderError()
            return result

    def _upload(self, *, file, config=None):
        with self._lock:
            scripted, result = self._next('files.upload')
            if not scripted:
                self._sequence += 1
                name = f'files/fake-{self._prefix}-{self._sequence}'
                mime = config.get('mime_type', '') if isinstance(config, dict) else getattr(config, 'mime_type', '')
                result = SimpleNamespace(name=name, uri=f'fake://{name}', mime_type=mime,
                                         state=SimpleNamespace(name='ACTIVE'))
            return self._store(self._files, result)

    def _get_file(self, *, name):
        with self._lock:
            scripted, result = self._next('files.get')
            if scripted:
                if getattr(result, 'name', None) != name:
                    raise FakeProviderError()
                return self._store(self._files, result)
            if name not in self._files:
                raise FakeProviderError(404)
            return deepcopy(self._files[name])

    def _delete_file(self, *, name):
        with self._lock:
            self._next('files.delete')
            self._files.pop(name, None)

    def _download(self, *, file):
        with self._lock:
            scripted, result = self._next('files.download')
            if not scripted or not isinstance(result, bytes):
                raise FakeProviderError()
            return result

    def _create_batch(self, *, model, src, config=None):
        with self._lock:
            scripted, result = self._next('batches.create')
            if not scripted:
                raise FakeProviderError()
            return self._store(self._batches, result)

    def _get_batch(self, *, name):
        with self._lock:
            scripted, result = self._next('batches.get')
            if scripted:
                if getattr(result, 'name', None) != name:
                    raise FakeProviderError()
                return self._store(self._batches, result)
            if name not in self._batches:
                raise FakeProviderError(404)
            return deepcopy(self._batches[name])

    def _cancel_batch(self, *, name):
        with self._lock:
            scripted, result = self._next('batches.cancel')
            if scripted:
                if getattr(result, 'name', None) != name:
                    raise FakeProviderError()
                return self._store(self._batches, result)
            if name not in self._batches:
                raise FakeProviderError(404)
            result = deepcopy(self._batches[name])
            result.state = SimpleNamespace(name='JOB_STATE_CANCELLED')
            return self._store(self._batches, result)


class FakeProvider:
    def __init__(self, runtime):
        if not isinstance(getattr(runtime, 'client', None), FakeGeminiClient):
            raise ValueError('Fake provider requires a local fake client.')
        from .gemini import GeminiProvider
        self._delegate = GeminiProvider(runtime)

    def upload_file(self, part, *, operation_name, retry_tracker=None):
        return self._delegate.upload_file(part, operation_name=operation_name, retry_tracker=retry_tracker)

    def wait_for_file(self, part, *, operation_name, retry_tracker=None):
        return self._delegate.wait_for_file(part, operation_name=operation_name, retry_tracker=retry_tracker)

    def generate(self, model, parts, *, schema=None, max_output_tokens=65536,
                 retry_tracker=None, operation_name=None):
        result = self._delegate.generate(
            model, parts, schema=schema, max_output_tokens=max_output_tokens,
            retry_tracker=retry_tracker, operation_name=operation_name,
        )
        return replace(result, provider='fake', finish_reason=result.finish_reason or 'stop')

    def close(self):
        self._delegate.close()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()
