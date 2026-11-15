"""Workflow-local, synchronous OpenRouter requests through the OpenAI client."""
import logging
import os

import httpx
from flask import has_request_context

from lecture_processor.runtime.environment import get_openrouter_http_timeout_ms

from .errors import ProviderRequestError
from .openrouter_request import prepare_request
from .openrouter_response import parse_response

_BASE_URL = 'https://openrouter.ai/api/v1'


def _silence_sdk_logging():
    # SDK debug logs include request bodies. Keep application retry logs separate.
    pending = [logging.getLogger('openai')]
    while pending:
        logger = pending.pop()
        logger.disabled = True
        pending.extend(logger.getChildren())


def _timeout():
    return httpx.Timeout(connect=10.0, read=get_openrouter_http_timeout_ms(
        request_thread=has_request_context()) / 1000.0, write=30.0, pool=5.0)


class OpenRouterProvider:
    """Owns its HTTP client; injected transports require an explicit test key."""

    def __init__(self, runtime, *, transport=None, api_key=None):
        self.runtime = runtime
        self._transport = transport
        self._api_key = api_key
        self._http = None
        self._sdk = None
        self._send = None
        self._closed = False

    def _ensure_client(self):
        if self._sdk is not None:
            return
        from lecture_processor.runtime.bootstrap import is_forced_fake_provider

        if self._transport is None and is_forced_fake_provider():
            raise RuntimeError('Real provider clients are unavailable in isolated mode.')
        # The pinned SDK merges this environment value into its headers even
        # with an explicit key/base URL. This adapter supports no custom headers.
        if os.environ.get('OPENAI_CUSTOM_HEADERS'):
            raise RuntimeError('Custom SDK headers are not supported.')
        key = self._api_key
        if key is None and self._transport is None:
            key = os.getenv('OPENROUTER_API_KEY', '')
        if not isinstance(key, str) or not key.strip():
            raise RuntimeError('OpenRouter client is not configured.')

        failed = False
        try:
            from openai import OpenAI

            self._http = httpx.Client(transport=self._transport, timeout=_timeout(),
                                      trust_env=False, follow_redirects=False)
            self._sdk = OpenAI(api_key=key.strip(), base_url=_BASE_URL, max_retries=0,
                               timeout=_timeout(), http_client=self._http,
                               organization='', project='', admin_api_key='', webhook_secret='')
            self._send = self._sdk.chat.completions.with_streaming_response.create
            _silence_sdk_logging()
        except Exception:
            failed = True
        self._api_key = None
        if failed:
            self.close()
            raise RuntimeError('Generation provider client could not be configured.')

    def _generate_once(self, request, *, model, schema):
        import openai

        failure = None
        try:
            # HTTP response streaming provides a closing context; the model request
            # itself remains nonstreaming. Inspect JSON before any SDK model parsing.
            with self._send(**request, timeout=_timeout()) as response:
                payload = response.json()
                return parse_response(payload, model=model, schema=schema)
        except ProviderRequestError as error:
            failure = ProviderRequestError(error.reason, http_status=error.status_code,
                                           provider_code=error.provider_code)
        except (openai.APITimeoutError, httpx.TimeoutException):
            failure = ProviderRequestError('timeout')
        except (openai.APIConnectionError, httpx.NetworkError):
            failure = ProviderRequestError('connection_error')
        except openai.APIStatusError as error:
            body = error.body
            data = body.get('error', body) if isinstance(body, dict) else None
            code = data.get('code') if isinstance(data, dict) else None
            failure = ProviderRequestError('http_error', http_status=error.status_code, provider_code=code)
        except Exception:
            failure = ProviderRequestError('invalid_response')
        # Raise after leaving the raw SDK exception context; it contains response data.
        raise failure

    def generate(self, model, parts, *, options, schema=None, max_output_tokens=65536,
                 retry_tracker=None, operation_name=None):
        if self._closed:
            raise RuntimeError('The provider workflow is closed.')
        request = prepare_request(model, parts, options=options, schema=schema,
                                  max_output_tokens=max_output_tokens)
        self._ensure_client()
        from lecture_processor.domains.ai.provider import run_with_provider_retry

        return run_with_provider_retry(
            operation_name or 'generate_content',
            lambda: self._generate_once(request, model=model, schema=schema),
            retry_tracker=retry_tracker, runtime=self.runtime,
        )

    def close(self):
        if self._closed:
            return
        self._closed = True
        try:
            client = self._sdk if self._sdk is not None else self._http
            if client is not None:
                client.close()
        except Exception:
            logger = getattr(self.runtime, 'logger', None)
            if logger is not None:
                logger.warning('Generation provider client cleanup failed.')
        finally:
            self._send = None
            self._sdk = None
            self._api_key = None

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()
