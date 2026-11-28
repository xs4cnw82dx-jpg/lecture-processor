"""Validate response envelopes before exposing normalized generation results."""
import json

from .contracts import GenerationResult, Usage
from .errors import ProviderRequestError
from .usage import finite_cost_usd


def _tokens(value):
    return value if type(value) is int and value >= 0 else 0


def parse_response(payload, *, model, schema=None):
    if not isinstance(payload, dict):
        raise ProviderRequestError('invalid_response', http_status=200)
    if payload.get('error') is not None:
        error = payload['error']
        code = error.get('code') if isinstance(error, dict) else None
        raise ProviderRequestError('body_error', http_status=200, provider_code=code)
    choices = payload.get('choices')
    if not isinstance(choices, list) or not choices or not isinstance(choices[0], dict):
        raise ProviderRequestError('invalid_response', http_status=200)
    choice = choices[0]
    if choice.get('finish_reason') == 'error':
        error = choice.get('error')
        code = error.get('code') if isinstance(error, dict) else None
        raise ProviderRequestError('finish_error', http_status=200, provider_code=code)
    message = choice.get('message')
    reason = choice.get('finish_reason')
    if reason not in {'stop', 'length'} or not isinstance(message, dict) or message.get('refusal'):
        raise ProviderRequestError('invalid_response', http_status=200)
    text = message.get('content')
    # A small cap can be exhausted entirely by reasoning. Keep its usage for the retry.
    if text is None and reason == 'length':
        text = ''
    if not isinstance(text, str) or (reason == 'stop' and not text.strip()):
        raise ProviderRequestError('invalid_response', http_status=200)
    parsed = None
    if schema is not None:
        try:
            parsed = json.loads(text)
        except (ValueError, RecursionError):
            pass
    usage = payload.get('usage')
    usage = usage if isinstance(usage, dict) else {}
    output_tokens = _tokens(usage.get('completion_tokens'))
    details = usage.get('completion_tokens_details')
    thinking_tokens = _tokens(details.get('reasoning_tokens')) if isinstance(details, dict) else 0
    normalized = Usage(
        input_tokens=_tokens(usage.get('prompt_tokens')),
        output_tokens=output_tokens,
        total_tokens=_tokens(usage.get('total_tokens')),
        thinking_tokens=min(thinking_tokens, output_tokens),
        cost_usd=finite_cost_usd(usage.get('cost')),
    )
    return GenerationResult(text=text, parsed=parsed, usage=normalized,
                            provider='openrouter', model=model, finish_reason=reason)
