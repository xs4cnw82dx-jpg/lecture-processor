"""Gemini generation with the existing configuration and retry boundaries."""
from dataclasses import dataclass
from pathlib import Path
import time

from flask import has_request_context

from lecture_processor.runtime.environment import get_gemini_http_timeout_ms
from .contracts import AudioPart, GenerationResult, ImagePart, PdfPart, PreparedFilePart, TextPart, Usage

try:
    from google.genai import types as genai_types
except Exception:
    genai_types = None


def types_module(runtime):
    return getattr(runtime, 'types', None) or genai_types


def build_thinking_config(model, runtime):
    policy = getattr(runtime, 'MODEL_THINKING_POLICY', {}).get(model)
    module = types_module(runtime)
    if not policy or not hasattr(module, 'ThinkingConfig'):
        return None
    try:
        return module.ThinkingConfig(**policy)
    except Exception:
        return None


@dataclass(frozen=True)
class NativeCall:
    client: object
    config: object


def prepare_native_call(runtime, model, max_output_tokens, *, schema=None):
    """Resolve client and config once, before the application retry loop."""
    client = getattr(runtime, 'client', None)
    if client is None:
        raise RuntimeError('Gemini client is not configured.')
    base_config = {'max_output_tokens': max_output_tokens}
    if has_request_context():
        base_config['http_options'] = {'timeout': get_gemini_http_timeout_ms(request_thread=True)}
    thinking = build_thinking_config(model, runtime)
    if thinking is not None:
        base_config['thinking_config'] = thinking
    if schema is not None:
        base_config.update(response_mime_type='application/json', response_schema=schema)
    module = types_module(runtime)
    if hasattr(module, 'GenerateContentConfig'):
        try:
            config = module.GenerateContentConfig(**base_config)
        except Exception:
            base_config.pop('thinking_config', None)
            config = module.GenerateContentConfig(**base_config)
    else:
        config = base_config
    return NativeCall(client, config)


def generate_native_once(prepared, model, contents):
    return prepared.client.models.generate_content(model=model, contents=contents, config=prepared.config)


def normalize_response(response, model):
    meta = getattr(response, 'usage_metadata', None)
    thinking = getattr(meta, 'thoughts_token_count', 0) or 0
    usage = Usage(
        input_tokens=getattr(meta, 'prompt_token_count', 0) or 0,
        output_tokens=(getattr(meta, 'candidates_token_count', 0) or 0) + thinking,
        total_tokens=getattr(meta, 'total_token_count', 0) or 0,
        thinking_tokens=thinking,
    )
    candidates = getattr(response, 'candidates', None)
    reason = getattr(candidates[0], 'finish_reason', None) if candidates else None
    reason = getattr(reason, 'value', reason)
    return GenerationResult(
        text=getattr(response, 'text', ''), parsed=getattr(response, 'parsed', None),
        usage=usage, provider='gemini', model=model, raw_response=response,
        finish_reason=reason.lower() if isinstance(reason, str) else None,
    )


def validate_file_part(part):
    """Validate file-part shape without reading or resolving its local path."""
    if not isinstance(part, (PdfPart, ImagePart, AudioPart)):
        raise ValueError('Unsupported file content part.')
    if not isinstance(part.path, (str, Path)) or not str(part.path):
        raise ValueError('A file part requires a local path.')
    mime = 'application/pdf' if isinstance(part, PdfPart) else part.mime_type
    if not isinstance(mime, str) or not mime:
        raise ValueError('A content part requires a MIME type.')
    return mime


class GeminiProvider:
    """One workflow's native resources; callers retain ownership of local files."""

    def __init__(self, runtime):
        self.runtime = runtime
        self._files = {}
        self._pending_files = {}
        self._owned_files = []
        self._closed = False

    def _retry(self, operation, callback, tracker):
        # Call-time import avoids the legacy provider/adapter import cycle.
        from lecture_processor.domains.ai.provider import run_with_provider_retry
        return run_with_provider_retry(operation, callback, retry_tracker=tracker, runtime=self.runtime)

    def _preparation_client(self, part):
        if self._closed:
            raise RuntimeError('The provider workflow is closed.')
        validate_file_part(part)
        client = getattr(self.runtime, 'client', None)
        if client is None:
            raise RuntimeError('Gemini client is not configured.')
        return client

    def _cached_file(self, key, client):
        cached = self._files.get(key) or self._pending_files.get(key)
        if cached is not None:
            cached_client, uploaded = cached
            if cached_client is not client:
                raise RuntimeError('The generation client changed during this workflow.')
            return uploaded
        return None

    def _upload_file(self, part, client, operation, tracker):
        mime = validate_file_part(part)
        key = (str(Path(part.path).resolve()), mime)
        uploaded = self._cached_file(key, client)
        if uploaded is not None:
            return uploaded
        uploaded = self._retry(
            operation, lambda: client.files.upload(file=str(part.path), config={'mime_type': mime}), tracker,
        )
        # Keep ownership even if processing fails, so context exit still cleans up.
        self._owned_files.append((client, uploaded))
        self._pending_files[key] = (client, uploaded)
        return uploaded

    def _wait_for_file(self, part, client, operation, tracker):
        from lecture_processor.domains.ai import provider
        from lecture_processor.runtime.media_runtime import wait_for_file_processing

        mime = validate_file_part(part)
        key = (str(Path(part.path).resolve()), mime)
        uploaded = self._cached_file(key, client)
        if uploaded is None:
            raise RuntimeError('The file has not been uploaded in this workflow.')
        if key in self._files:
            return uploaded
        logger = getattr(self.runtime, 'logger', None)
        self._retry(operation, lambda: wait_for_file_processing(
            uploaded, client=client, logger=logger, time_module=getattr(self.runtime, 'time', time),
            is_transient_provider_error_fn=lambda error: provider.is_transient_provider_error(error, runtime=self.runtime),
            classify_provider_error_code_fn=lambda error: provider.classify_provider_error_code(error, runtime=self.runtime),
        ), tracker)
        self._files[key] = (client, uploaded)
        self._pending_files.pop(key, None)
        return uploaded

    def upload_file(self, part, *, operation_name, retry_tracker=None):
        """Own one upload immediately; leave processing and local cleanup to their phases."""
        self._upload_file(part, self._preparation_client(part), operation_name, retry_tracker)

    def wait_for_file(self, part, *, operation_name, retry_tracker=None):
        """Wait for an existing upload without rebuilding generation configuration."""
        self._wait_for_file(part, self._preparation_client(part), operation_name, retry_tracker)

    def _prepare_file(self, part, client, operation, tracker):
        self._upload_file(part, client, operation + ':upload', tracker)
        return self._wait_for_file(part, client, operation + ':processing', tracker)

    def generate(self, model, parts, *, schema=None, max_output_tokens=65536,
                 retry_tracker=None, operation_name=None):
        if self._closed:
            raise RuntimeError('The provider workflow is closed.')
        ordered = tuple(parts)
        if not all(isinstance(part, (TextPart, PdfPart, ImagePart, AudioPart, PreparedFilePart)) for part in ordered):
            raise ValueError('Unsupported generation content part.')
        for part in ordered:
            if isinstance(part, TextPart):
                if not isinstance(part.text, str):
                    raise ValueError('A text part requires text.')
            elif isinstance(part, PreparedFilePart):
                if (not isinstance(part.uri, str) or not part.uri
                        or not isinstance(part.mime_type, str) or not part.mime_type):
                    raise ValueError('A prepared file part requires a URI and MIME type.')
            elif not isinstance(part.path, (str, Path)) or not str(part.path):
                raise ValueError('A file part requires a local path.')
            elif not isinstance(part, PdfPart) and (not isinstance(part.mime_type, str) or not part.mime_type):
                raise ValueError('A content part requires a MIME type.')
        prepared = prepare_native_call(self.runtime, model, max_output_tokens, schema=schema)
        module = types_module(self.runtime)
        operation = operation_name or f'generate_content:{model}'
        native_parts = []
        for part in ordered:
            if isinstance(part, TextPart):
                native_parts.append(module.Part.from_text(text=part.text) if hasattr(module, 'Part') else {'text': part.text})
            elif isinstance(part, PreparedFilePart):
                # Already uploaded and processed by the caller; reference it without new ownership.
                native_parts.append(module.Part.from_uri(file_uri=part.uri, mime_type=part.mime_type) if hasattr(module, 'Part')
                                    else {'file_data': {'file_uri': part.uri, 'mime_type': part.mime_type}})
            else:
                uploaded = self._prepare_file(part, prepared.client, operation, retry_tracker)
                mime = 'application/pdf' if isinstance(part, PdfPart) else part.mime_type
                native_parts.append(module.Part.from_uri(file_uri=uploaded.uri, mime_type=mime) if hasattr(module, 'Part')
                                    else {'file_data': {'file_uri': uploaded.uri, 'mime_type': mime}})
        contents = [module.Content(role='user', parts=native_parts)] if hasattr(module, 'Content') else [
            {'role': 'user', 'parts': native_parts},
        ]
        response = self._retry(operation, lambda: generate_native_once(prepared, model, contents), retry_tracker)
        return normalize_response(response, model)

    def close(self):
        if self._closed:
            return
        self._closed = True
        for client, uploaded in self._owned_files:
            try:
                client.files.delete(name=uploaded.name)
            except Exception:
                logger = getattr(self.runtime, 'logger', None)
                if logger is not None:
                    logger.warning('Could not clean up provider file %s.', getattr(uploaded, 'name', None))
        self._owned_files.clear()
        self._files.clear()
        self._pending_files.clear()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()
