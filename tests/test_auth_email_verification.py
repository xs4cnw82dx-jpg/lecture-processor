from lecture_processor.services import access_service, auth_service
from lecture_processor.domains.auth import policy as auth_policy


class _Request:
    headers = {'Authorization': 'Bearer token'}

    def __init__(self):
        self.environ = {}


class _AuthModule:
    def __init__(self, decoded_token):
        self.decoded_token = decoded_token

    def verify_id_token(self, _token):
        return dict(self.decoded_token)


class _Logger:
    def __init__(self):
        self.messages = []

    def info(self, message, *args):
        self.messages.append((message, args))


class _AccessApp:
    def __init__(self, token):
        self.token = token

    def verify_firebase_token(self, _request):
        return self.token

    def jsonify(self, payload):
        return payload


def test_verify_firebase_token_rejects_explicitly_unverified_email():
    request = _Request()
    logger = _Logger()
    decoded = {
        'uid': 'user-1',
        'email': 'user@example.com',
        'email_verified': False,
    }

    result = auth_service.verify_firebase_token(request, _AuthModule(decoded), logger)

    assert result is None
    assert request.environ['lecture_processor.auth_error'] == auth_service.EMAIL_NOT_VERIFIED_AUTH_ERROR


def test_verify_firebase_token_accepts_verified_email():
    request = _Request()
    decoded = {
        'uid': 'user-1',
        'email': 'user@example.com',
        'email_verified': True,
    }

    result = auth_service.verify_firebase_token(request, _AuthModule(decoded), _Logger())

    assert result == decoded
    assert 'lecture_processor.auth_error' not in request.environ


def test_verify_firebase_token_preserves_tokens_without_email_verification_claim():
    request = _Request()
    decoded = {
        'uid': 'custom-token-user',
        'email': 'user@example.com',
    }

    result = auth_service.verify_firebase_token(request, _AuthModule(decoded), _Logger())

    assert result == decoded
    assert 'lecture_processor.auth_error' not in request.environ


def test_allowed_user_guard_rejects_unverified_email_token_before_allowlist(monkeypatch):
    request = _Request()
    token = {
        'uid': 'user-1',
        'email': 'user@example.com',
        'email_verified': False,
    }
    monkeypatch.setattr(auth_policy, 'is_email_allowed', lambda _email, runtime=None: True)

    decoded, response, status = access_service.require_allowed_user(_AccessApp(token), request)

    assert decoded is None
    assert status == 403
    assert response['error_code'] == auth_service.EMAIL_NOT_VERIFIED_AUTH_ERROR


def test_allowed_user_guard_preserves_missing_email_verification_claim(monkeypatch):
    request = _Request()
    token = {
        'uid': 'custom-token-user',
        'email': 'user@example.com',
    }
    monkeypatch.setattr(auth_policy, 'is_email_allowed', lambda _email, runtime=None: True)

    decoded, response, status = access_service.require_allowed_user(_AccessApp(token), request)

    assert decoded == token
    assert response is None
    assert status is None


def test_admin_session_login_rejects_unverified_admin_email(client, core, monkeypatch):
    monkeypatch.setattr(core.auth, 'verify_id_token', lambda _token: {
        'uid': 'admin-1',
        'email': 'admin@example.com',
        'email_verified': False,
    })
    monkeypatch.setattr(core, 'ADMIN_EMAILS', {'admin@example.com'})
    monkeypatch.setattr(core, 'ADMIN_UIDS', {'admin-1'})

    response = client.post(
        '/api/session/login',
        json={},
        headers={'Authorization': 'Bearer token'},
    )

    assert response.status_code == 403
    assert response.get_json()['error_code'] == auth_service.EMAIL_NOT_VERIFIED_AUTH_ERROR
