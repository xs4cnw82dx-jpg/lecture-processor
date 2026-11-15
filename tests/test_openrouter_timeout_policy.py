from lecture_processor.runtime.environment import get_openrouter_http_timeout_ms


def test_worker_and_request_timeout_defaults():
    assert get_openrouter_http_timeout_ms(environ={}) == 600_000
    assert get_openrouter_http_timeout_ms(environ={}, request_thread=True) == 60_000


def test_request_timeout_never_exceeds_worker_setting():
    environment = {'OPENROUTER_HTTP_TIMEOUT_MS': '12000',
                   'OPENROUTER_REQUEST_HTTP_TIMEOUT_MS': '30000'}
    assert get_openrouter_http_timeout_ms(environ=environment) == 12000
    assert get_openrouter_http_timeout_ms(environ=environment, request_thread=True) == 12000


def test_invalid_settings_recover_and_large_timeouts_are_bounded():
    environment = {'OPENROUTER_HTTP_TIMEOUT_MS': '-1',
                   'OPENROUTER_REQUEST_HTTP_TIMEOUT_MS': 'invalid'}
    assert get_openrouter_http_timeout_ms(environ=environment) == 600_000
    assert get_openrouter_http_timeout_ms(environ=environment, request_thread=True) == 60_000
    environment = {'OPENROUTER_HTTP_TIMEOUT_MS': '999999999999',
                   'OPENROUTER_REQUEST_HTTP_TIMEOUT_MS': '999999999999'}
    assert get_openrouter_http_timeout_ms(environ=environment) == 3_600_000
    assert get_openrouter_http_timeout_ms(environ=environment, request_thread=True) == 3_600_000
