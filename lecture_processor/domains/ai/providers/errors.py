"""Content-free failures passed from the HTTP adapter to application retries."""

_REASONS = frozenset({
    'timeout', 'connection_error', 'http_error', 'body_error',
    'invalid_response', 'finish_error',
})
_TRANSIENT_CODES = frozenset({408, 409, 425, 429})


def numeric_status(value):
    """Keep only a bounded numeric HTTP/provider status, never response text."""
    if isinstance(value, bool):
        return None
    if isinstance(value, str):
        if len(value) != 3 or not value.isascii() or not value.isdigit():
            return None
        value = int(value)
    if isinstance(value, int) and 100 <= value <= 599:
        return value
    return None


class ProviderRequestError(RuntimeError):
    """Carries fixed reason codes and numeric statuses without request objects."""

    def __init__(self, reason, *, http_status=None, provider_code=None):
        if reason not in _REASONS:
            raise ValueError('Unknown provider failure reason.')
        self.reason = reason
        self.status_code = numeric_status(http_status)
        self.provider_code = numeric_status(provider_code)
        statuses = (self.provider_code, self.status_code)
        self.retryable = reason in {'timeout', 'connection_error'} or any(
            code is not None and (code in _TRANSIENT_CODES or 500 <= code <= 599)
            for code in statuses
        )
        failure_status = next((code for code in statuses if code is not None and code >= 400), None)
        self.error_code = (
            'TIMEOUT' if reason == 'timeout'
            else f'HTTP_{failure_status}' if failure_status is not None
            else reason.upper()
        )
        super().__init__(f'Generation provider request failed ({self.error_code}).')
