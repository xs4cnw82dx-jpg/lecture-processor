from lecture_processor.domains.auth import session
from lecture_processor.runtime.container import get_runtime


def test_extract_bearer_token_prefers_auth_header():
    class _Req:
        headers = {'Authorization': 'Bearer header-token'}

        @staticmethod
        def get_json(silent=True):
            return {'id_token': 'body-token'}

    assert session._extract_bearer_token(_Req()) == 'header-token'


def test_extract_bearer_token_falls_back_to_json_payload():
    class _Req:
        headers = {}

        @staticmethod
        def get_json(silent=True):
            return {'idToken': 'payload-token'}

    assert session._extract_bearer_token(_Req()) == 'payload-token'


def test_verify_admin_session_cookie_uses_runtime_auth_and_policy(app, monkeypatch):
    runtime = get_runtime(app)

    with app.app_context():
        class _Req:
            cookies = {'lp_admin_session': 'cookie-token'}

        monkeypatch.setattr(runtime, 'ADMIN_SESSION_COOKIE_NAME', 'lp_admin_session')
        monkeypatch.setattr(runtime.auth, 'verify_session_cookie', lambda token, check_revoked=True: {'uid': token})
        monkeypatch.setattr(runtime, 'is_admin_user', lambda decoded: decoded.get('uid') == 'cookie-token')
        assert session.verify_admin_session_cookie(_Req(), runtime=runtime) == {'uid': 'cookie-token'}
