from lecture_processor.services import admin_support


class _FakeApp:
    def __init__(self, token=None, is_admin=False):
        self._token = token
        self._is_admin = is_admin

    def verify_firebase_token(self, _request):
        return self._token

    def is_admin_user(self, _decoded_token):
        return self._is_admin

    def jsonify(self, payload):
        return payload


def test_require_admin_rejects_missing_token():
    app = _FakeApp(token=None, is_admin=False)

    decoded_token, response, status = admin_support.require_admin(app, object())

    assert decoded_token is None
    assert response == {'error': 'Unauthorized'}
    assert status == 401


def test_require_admin_rejects_non_admin_user():
    app = _FakeApp(token={'uid': 'user-1'}, is_admin=False)

    decoded_token, response, status = admin_support.require_admin(app, object())

    assert decoded_token is None
    assert response == {'error': 'Forbidden'}
    assert status == 403


def test_require_admin_accepts_admin_user():
    token = {'uid': 'admin-1', 'email': 'admin@example.com'}
    app = _FakeApp(token=token, is_admin=True)

    decoded_token, response, status = admin_support.require_admin(app, object())

    assert decoded_token == token
    assert response is None
    assert status is None


def test_numeric_parsers_clamp_negative_and_invalid_values():
    assert admin_support.to_non_negative_float('4.5') == 4.5
    assert admin_support.to_non_negative_float('-3') == 0.0
    assert admin_support.to_non_negative_float('not-a-number', default=1.25) == 1.25

    assert admin_support.to_non_negative_int('7') == 7
    assert admin_support.to_non_negative_int('-2') == 0
    assert admin_support.to_non_negative_int('bad', default=3) == 3
