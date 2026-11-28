"""Workflow-local generation selected from an immutable routing snapshot."""
import logging
from pathlib import Path

from .contracts import AudioPart, PreparedFilePart
from .document_stages import DOCUMENT_STAGES, complete_document, document_parts
from .errors import ProviderRequestError
from .gemini import GeminiProvider, validate_file_part
from .openrouter_request import exceeds_pdf_request_limit
from .routing import (AUDIO_STAGES, STAGES, STAGE_MODEL_ATTRIBUTES, Route, default_models,
                      load_routing, validate_openrouter_options)


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

    def _route(self, stage):
        if self._closed:
            raise RuntimeError('The provider workflow is closed.')
        if not isinstance(stage, str) or stage not in STAGES or stage not in self.routes.routes:
            raise ValueError('Unknown generation stage.')
        route = self.routes.routes[stage]
        if stage in AUDIO_STAGES and route.provider != 'gemini':
            raise ValueError('Audio generation requires Gemini.')
        if route.provider not in {'gemini', 'openrouter'}:
            raise ValueError('Unsupported generation provider.')
        return route

    def _adapter(self, route):
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
        return self._adapters[route.provider]

    def _prepare_file(self, stage, part, method, operation_name, retry_tracker):
        route = self._route(stage)
        if route.provider == 'openrouter' and isinstance(part, AudioPart):
            raise ValueError('Audio generation requires Gemini.')
        validate_file_part(part)
        if route.provider == 'openrouter':
            validate_openrouter_options(route.model, route.options)
            # Its local file bytes are read by generate, never by preparation.
            return
        getattr(self._adapter(route), method)(part, operation_name=operation_name, retry_tracker=retry_tracker)

    def upload_file(self, stage, part, *, operation_name, retry_tracker=None):
        """Upload to Gemini; OpenRouter only validates route/part shape, not file readiness."""
        self._prepare_file(stage, part, 'upload_file', operation_name, retry_tracker)

    def wait_for_file(self, stage, part, *, operation_name, retry_tracker=None):
        """Wait for Gemini; OpenRouter defers file content validation/reads to generation."""
        self._prepare_file(stage, part, 'wait_for_file', operation_name, retry_tracker)

    def generate(self, stage, parts, *, schema=None, max_output_tokens=65536,
                 retry_tracker=None, operation_name=None, source_slide_text='', record_discarded=None):
        route = self._route(stage)
        call = dict(schema=schema, retry_tracker=retry_tracker, operation_name=operation_name or stage)
        if route.provider == 'gemini':
            return self._adapter(route).generate(route.model, parts, max_output_tokens=max_output_tokens, **call)

        options = validate_openrouter_options(route.model, route.options)
        if type(max_output_tokens) is not int or max_output_tokens <= 0:
            raise ValueError('Invalid generation output limit.')
        parts = tuple(parts)
        if any(isinstance(part, AudioPart) for part in parts):
            raise ValueError('Audio generation requires Gemini.')
        if any(isinstance(part, PreparedFilePart) for part in parts):
            raise ValueError('Prepared provider files require Gemini.')
        if exceeds_pdf_request_limit(parts):
            logger = getattr(self.runtime, 'logger', None) or logging.getLogger(__name__)
            logger.warning('PDF input exceeds the OpenRouter request limit; using Gemini for %s.', stage)
            return self._gemini_fallback(stage, parts, max_output_tokens, call, source_slide_text, record_discarded)
        initial_cap = min(max_output_tokens, options['max_output_tokens'])
        if stage in DOCUMENT_STAGES:
            return self._generate_document(stage, route, parts, initial_cap, max_output_tokens, call,
                                           source_slide_text, record_discarded)
        result = self._generate_openrouter(route, parts, initial_cap, call)
        if result.finish_reason == 'length':
            if record_discarded:
                record_discarded(f'{stage}_incomplete', result)
            raise ProviderRequestError('incomplete')
        return result

    def _generate_document(self, stage, route, parts, initial_cap, max_output_tokens, call,
                           source_slide_text, record_discarded):
        logger = getattr(self.runtime, 'logger', None) or logging.getLogger(__name__)
        caps = [initial_cap]
        if stage == 'notes_merge':
            retry_cap = min(max_output_tokens, route.options.get('retry_max_output_tokens', initial_cap))
            if retry_cap > initial_cap:
                caps.append(retry_cap)
        adapted_parts = document_parts(stage, parts)
        for index, cap in enumerate(caps, start=1):
            try:
                attempt_call = call if index == 1 else {**call, 'operation_name': call['operation_name'] + ':higher_cap'}
                result = self._generate_openrouter(route, adapted_parts, cap, attempt_call)
            except ProviderRequestError as error:
                # Never bypass refusals, authentication, endpoint constraints or input validation.
                if not error.retryable:
                    raise
                logger.warning('OpenRouter %s ended with %s after retries.', stage, error.error_code)
                break
            if result.usage.input_tokens > 100_000:
                logger.info('OpenRouter %s exceeded the 100K input tier (%d tokens).', stage, result.usage.input_tokens)
            complete = complete_document(stage, result, source_slide_text)
            if complete is not None:
                return complete
            if record_discarded:
                record_discarded(f'{stage}_incomplete_{index}', result)
            logger.warning('Discarded incomplete OpenRouter %s attempt %d (cap %d).', stage, index, cap)
            if result.finish_reason != 'length':
                break

        logger.warning('Using the configured Gemini fallback for %s.', stage)
        return self._gemini_fallback(stage, parts, max_output_tokens, call, source_slide_text, record_discarded)

    def _gemini_fallback(self, stage, parts, max_output_tokens, call, source_slide_text, record_discarded):
        fallback = Route('gemini', getattr(self.runtime, STAGE_MODEL_ATTRIBUTES[stage]))
        fallback_call = {**call, 'operation_name': call['operation_name'] + ':gemini_fallback'}
        result = self._adapter(fallback).generate(
            fallback.model, parts, max_output_tokens=max_output_tokens, **fallback_call,
        )
        if stage not in DOCUMENT_STAGES:
            return result
        complete = complete_document(stage, result, source_slide_text)
        if complete is not None:
            return complete
        if record_discarded:
            record_discarded(f'{stage}_incomplete_fallback', result)
        raise ProviderRequestError('incomplete')

    def _generate_openrouter(self, route, parts, cap, call):
        options = {'reasoning_effort': route.options['reasoning_effort'], 'max_output_tokens': cap}
        extra = {} if self._forced else {'options': options}
        return self._adapter(route).generate(route.model, parts, max_output_tokens=cap, **extra, **call)

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
