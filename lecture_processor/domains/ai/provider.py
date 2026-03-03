import os
import random
import time

from lecture_processor.runtime.container import get_runtime

try:
    from google.genai import types as genai_types
except Exception:
    genai_types = None


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _get_types_module(runtime):
    return getattr(runtime, 'types', None) or genai_types


def _safe_int_env(runtime, name, default=0, minimum=1, maximum=100000):
    os_module = getattr(runtime, 'os', os)
    raw = str(os_module.getenv(name, str(default))).strip()
    try:
        value = int(raw)
    except Exception:
        value = int(default)
    return min(max(value, minimum), maximum)


def _build_thinking_config(model_name, runtime=None):
    """Build a ThinkingConfig for the given model based on MODEL_THINKING_POLICY."""
    resolved_runtime = _resolve_runtime(runtime)
    policy = getattr(resolved_runtime, 'MODEL_THINKING_POLICY', {}).get(model_name)
    types_module = _get_types_module(resolved_runtime)
    if not policy or not types_module or not hasattr(types_module, 'ThinkingConfig'):
        return None
    try:
        return types_module.ThinkingConfig(**policy)
    except Exception:
        return None


def get_provider_status_code(error, runtime=None):
    _ = runtime
    if error is None:
        return None
    for attr in ('status_code', 'code'):
        value = getattr(error, attr, None)
        if isinstance(value, int) and value > 0:
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
    response = getattr(error, 'response', None)
    if response is not None:
        value = getattr(response, 'status_code', None)
        if isinstance(value, int) and value > 0:
            return value
    return None


def classify_provider_error_code(error, runtime=None):
    status_code = get_provider_status_code(error, runtime=runtime)
    if status_code:
        return f'HTTP_{status_code}'
    text = str(error or '').lower()
    if 'timeout' in text or 'timed out' in text or 'deadline exceeded' in text:
        return 'TIMEOUT'
    if 'resource exhausted' in text or 'rate limit' in text or 'too many requests' in text:
        return 'RATE_LIMIT'
    if 'unavailable' in text or 'temporarily unavailable' in text:
        return 'UNAVAILABLE'
    if 'connection reset' in text:
        return 'CONNECTION_RESET'
    return 'GENERIC'


def is_transient_provider_error(error, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    status_code = get_provider_status_code(error, runtime=resolved_runtime)
    transient_codes = getattr(resolved_runtime, 'PROVIDER_TRANSIENT_STATUS_CODES', {408, 409, 425, 429, 500, 502, 503, 504})
    if status_code in transient_codes:
        return True
    if isinstance(error, (TimeoutError, ConnectionError)):
        return True
    hints = getattr(
        resolved_runtime,
        'PROVIDER_TRANSIENT_MESSAGE_HINTS',
        (
            'timeout',
            'timed out',
            'temporarily unavailable',
            'try again',
            'resource exhausted',
            'unavailable',
            'internal error',
            'connection reset',
            'deadline exceeded',
        ),
    )
    text = str(error or '').lower()
    return any((fragment in text for fragment in hints))


def run_with_provider_retry(operation_name, func, retry_tracker=None, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    attempts = max(
        1,
        int(
            getattr(
                resolved_runtime,
                'PROVIDER_RETRY_MAX_ATTEMPTS',
                _safe_int_env(resolved_runtime, 'PROVIDER_RETRY_MAX_ATTEMPTS', 3, minimum=1, maximum=6),
            )
            or 1
        ),
    )
    base_seconds = float(getattr(resolved_runtime, 'PROVIDER_RETRY_BASE_SECONDS', 1.2) or 1.2)
    max_seconds = float(getattr(resolved_runtime, 'PROVIDER_RETRY_MAX_SECONDS', 10.0) or 10.0)
    rng = getattr(resolved_runtime, 'random', random)
    logger = getattr(resolved_runtime, 'logger', None)
    time_module = getattr(resolved_runtime, 'time', time)

    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            result = func()
            if retry_tracker is not None:
                retry_tracker[operation_name] = max(retry_tracker.get(operation_name, 0), attempt - 1)
            return result
        except Exception as error:
            last_error = error
            transient = is_transient_provider_error(error, runtime=resolved_runtime)
            if retry_tracker is not None:
                retry_tracker[operation_name] = max(retry_tracker.get(operation_name, 0), attempt)
            if (not transient) or attempt >= attempts:
                raise
            delay = min(max_seconds, base_seconds * 2 ** (attempt - 1))
            delay += rng.uniform(0.0, 0.4)
            if logger is not None:
                logger.warning(
                    'Transient provider error during %s (attempt %s/%s, code=%s): %s. Retrying in %.1fs',
                    operation_name,
                    attempt,
                    attempts,
                    classify_provider_error_code(error, runtime=resolved_runtime),
                    error,
                    delay,
                )
            time_module.sleep(delay)
    if last_error is not None:
        raise last_error


def extract_token_usage(response, runtime=None):
    _ = runtime
    """Extract token counts from a Gemini response's usage_metadata."""
    meta = getattr(response, 'usage_metadata', None)
    if not meta:
        return {'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0}
    return {
        'input_tokens': getattr(meta, 'prompt_token_count', 0) or 0,
        'output_tokens': getattr(meta, 'candidates_token_count', 0) or 0,
        'total_tokens': getattr(meta, 'total_token_count', 0) or 0,
    }


class TokenAccumulator:
    """Accumulates token usage across multiple AI calls in a processing job."""

    def __init__(self, runtime=None):
        self._runtime = _resolve_runtime(runtime)
        self.stages = {}
        self.input_total = 0
        self.output_total = 0
        self.total = 0

    def record(self, stage_name, response):
        usage = extract_token_usage(response, runtime=self._runtime)
        self.stages[stage_name] = usage
        self.input_total += usage['input_tokens']
        self.output_total += usage['output_tokens']
        self.total += usage['total_tokens']

    def as_dict(self):
        return {
            'token_usage_by_stage': self.stages,
            'token_input_total': self.input_total,
            'token_output_total': self.output_total,
            'token_total': self.total,
        }


def generate_with_policy(model, contents, max_output_tokens=65536, retry_tracker=None, operation_name=None, runtime=None):
    """Unified generation wrapper that applies model-specific thinking config."""
    resolved_runtime = _resolve_runtime(runtime)
    client = getattr(resolved_runtime, 'client', None)
    if client is None:
        raise RuntimeError('Gemini client is not configured.')

    base_config = {'max_output_tokens': max_output_tokens}
    thinking = _build_thinking_config(model, runtime=resolved_runtime)
    if thinking is not None:
        base_config['thinking_config'] = thinking

    types_module = _get_types_module(resolved_runtime)
    if types_module and hasattr(types_module, 'GenerateContentConfig'):
        try:
            config = types_module.GenerateContentConfig(**base_config)
        except Exception:
            config = types_module.GenerateContentConfig(max_output_tokens=max_output_tokens)
    else:
        config = base_config

    return run_with_provider_retry(
        operation_name or f'generate_content:{model}',
        lambda: client.models.generate_content(model=model, contents=contents, config=config),
        retry_tracker=retry_tracker,
        runtime=resolved_runtime,
    )


def generate_with_optional_thinking(
    model,
    prompt_text,
    max_output_tokens=65536,
    thinking_budget=None,
    retry_tracker=None,
    operation_name=None,
    runtime=None,
):
    """Convenience wrapper for text-only prompts. Uses model policy for thinking config."""
    resolved_runtime = _resolve_runtime(runtime)
    _ = thinking_budget
    types_module = _get_types_module(resolved_runtime)
    if types_module and hasattr(types_module, 'Content') and hasattr(types_module, 'Part'):
        contents = [
            types_module.Content(
                role='user',
                parts=[types_module.Part.from_text(text=prompt_text)],
            )
        ]
    else:
        contents = [prompt_text]

    return generate_with_policy(
        model,
        contents,
        max_output_tokens=max_output_tokens,
        retry_tracker=retry_tracker,
        operation_name=operation_name,
        runtime=resolved_runtime,
    )
