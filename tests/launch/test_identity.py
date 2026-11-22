import pytest

from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from tests.runtime_test_support import get_test_core

core = get_test_core()

pytestmark = pytest.mark.usefixtures("disable_sentry")


def test_verify_email_allows_student_domain(client):
    response = client.post("/api/verify-email", json={"email": "student@st.hanze.nl"})
    assert response.status_code == 200
    body = response.get_json()
    assert body["allowed"] is True


def test_verify_email_blocks_unknown_domain(client):
    response = client.post("/api/verify-email", json={"email": "x@unknown-domain.invalid"})
    assert response.status_code == 200
    body = response.get_json()
    assert body["allowed"] is False
    assert "university email" in body["message"].lower()


def test_verify_email_rate_limited_returns_retry_after(client, monkeypatch):
    captured = []
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (False, 9))
    monkeypatch.setattr(analytics_events, "log_rate_limit_hit", lambda name, retry, runtime=None: captured.append((name, retry)) or True)

    response = client.post("/api/verify-email", json={"email": "student@st.hanze.nl"})

    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "9"
    assert response.get_json()["retry_after_seconds"] == 9
    assert captured == [("verify_email", 9)]


def test_auth_user_includes_preferences(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "pref-u1", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(
        core,
        "get_or_create_user",
        lambda _uid, _email: {
            "uid": "pref-u1",
            "email": "user@gmail.com",
            "lecture_credits_standard": 1,
            "lecture_credits_extended": 0,
            "slides_credits": 2,
            "interview_credits_short": 3,
            "interview_credits_medium": 0,
            "interview_credits_long": 0,
            "total_processed": 4,
            "has_created_study_pack": True,
            "preferred_output_language": "dutch",
            "preferred_output_language_custom": "",
            "onboarding_completed": False,
        },
    )

    response = client.get("/api/auth/user", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    body = response.get_json()
    assert body["has_created_study_pack"] is True
    assert body["preferences"]["output_language"] == "dutch"
    assert body["preferences"]["output_language_label"] == "Dutch"
    assert body["preferences"]["onboarding_completed"] is False


def test_user_preferences_put_persists_language_and_onboarding(client, monkeypatch):
    writes = []
    monkeypatch.setattr(core, "db", object())
    monkeypatch.setattr(
        core.users_repo,
        "set_doc",
        lambda _db, _uid, payload, merge=False: writes.append((payload, merge)),
    )
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "pref-u2", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(
        core,
        "get_or_create_user",
        lambda _uid, _email: {
            "uid": "pref-u2",
            "email": "user@gmail.com",
            "preferred_output_language": "english",
            "preferred_output_language_custom": "",
            "onboarding_completed": False,
        },
    )

    response = client.put(
        "/api/user-preferences",
        json={"output_language": "dutch", "onboarding_completed": True},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert body["preferences"]["output_language"] == "dutch"
    assert body["preferences"]["output_language_label"] == "Dutch"
    assert body["preferences"]["onboarding_completed"] is True
    assert writes, "Firestore set should be called"
    last_payload, merge = writes[-1]
    assert merge is True
    assert last_payload["preferred_output_language"] == "dutch"
    assert last_payload["onboarding_completed"] is True


def test_user_preferences_put_requires_custom_language_for_other(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "pref-u3", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(
        core,
        "get_or_create_user",
        lambda _uid, _email: {
            "uid": "pref-u3",
            "email": "user@gmail.com",
            "preferred_output_language": "english",
            "preferred_output_language_custom": "",
            "onboarding_completed": False,
        },
    )

    response = client.put(
        "/api/user-preferences",
        json={"output_language": "other", "output_language_custom": ""},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert "custom language is required" in response.get_json()["error"].lower()


def test_analytics_rate_limited_returns_retry_after(client, monkeypatch):
    captured = []
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u1", "email": "user@example.com"})
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (False, 12))
    monkeypatch.setattr(analytics_events, "log_rate_limit_hit", lambda name, retry, runtime=None: captured.append((name, retry)) or True)

    response = client.post("/api/lp-event", json={"event": "auth_success", "session_id": "manualtest123"})

    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "12"
    body = response.get_json()
    assert body["retry_after_seconds"] == 12
    assert "too many analytics events" in body["error"].lower()
    assert captured == [("analytics", 12)]


def test_anonymous_analytics_always_enforces_ip_limit_before_session_id(client, monkeypatch):
    keys = []
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request, **_kwargs: None)
    monkeypatch.setattr(core, "get_client_ip", lambda _request: "203.0.113.7")

    def _limit(**kwargs):
        keys.append(kwargs['key'])
        return (True, 0)

    monkeypatch.setattr(rate_limiter, "check_rate_limit", _limit)
    monkeypatch.setattr(analytics_events, "log_analytics_event", lambda *_args, **_kwargs: True)

    first = client.post('/api/lp-event', json={'event': 'auth_success', 'session_id': 'caller-one'})
    second = client.post('/api/lp-event', json={'event': 'auth_success', 'session_id': 'caller-two'})

    assert first.status_code == 200
    assert second.status_code == 200
    assert keys[0] == keys[2]
    assert keys[0].startswith('analytics:ip:')
    assert keys[1] != keys[3]


def test_runtime_token_verification_avoids_live_revocation_lookup_by_default(monkeypatch):
    captured = []
    monkeypatch.setattr(
        core.auth_service,
        'verify_firebase_token',
        lambda _request, auth_module, logger, check_revoked=False, **_kwargs: captured.append(check_revoked) or {'uid': 'u1'},
    )

    assert core.verify_firebase_token(object()) == {'uid': 'u1'}
    assert captured == [False]
