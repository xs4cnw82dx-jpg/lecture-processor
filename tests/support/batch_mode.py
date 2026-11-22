from lecture_processor.domains.auth import policy as auth_policy
from tests.runtime_test_support import get_test_core


def _patch_batch_auth(monkeypatch):
    core = get_test_core()
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': 'u-batch', 'email': 'batch@example.com'})
    monkeypatch.setattr(auth_policy, 'is_email_allowed', lambda _email, runtime=None: True)
