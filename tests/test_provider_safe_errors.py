"""Only bounded classification data crosses the provider retry boundary."""
import pytest

from lecture_processor.domains.ai.providers.errors import ProviderRequestError, numeric_status


@pytest.mark.parametrize('status', [408, 409, 425, 429, 500, 501, 502, 503, 504, 599])
def test_transient_http_and_body_statuses(status):
    for error in (ProviderRequestError('http_error', http_status=status),
                  ProviderRequestError('body_error', http_status=200, provider_code=str(status))):
        assert error.retryable is True
        assert error.error_code == f'HTTP_{status}'


@pytest.mark.parametrize('status', [200, 400, 401, 403, 404, 422])
def test_other_statuses_do_not_trigger_retries(status):
    assert ProviderRequestError('http_error', http_status=status).retryable is False


@pytest.mark.parametrize('reason', ['timeout', 'connection_error'])
def test_transport_failures_are_retryable(reason):
    error = ProviderRequestError(reason)
    assert error.retryable is True
    assert error.error_code == reason.upper()


@pytest.mark.parametrize('value', [None, True, False, -1, 0, 99, 600, 500.0,
                                  '500 secret body', ' 500', '0500', '１２３', {}, []])
def test_invalid_statuses_are_not_preserved(value):
    assert numeric_status(value) is None
    error = ProviderRequestError('invalid_response', http_status=value, provider_code=value)
    assert error.status_code is None and error.provider_code is None
    assert error.retryable is False
    assert str(error) == 'Generation provider request failed (INVALID_RESPONSE).'
    assert error.__cause__ is None and error.__context__ is None


def test_unrecognized_reason_is_rejected_without_echoing_it():
    with pytest.raises(ValueError, match='^Unknown provider failure reason\\.$'):
        ProviderRequestError('synthetic-sensitive-provider-message')
