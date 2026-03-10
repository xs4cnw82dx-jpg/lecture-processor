from lecture_processor.runtime.http_security import build_content_security_policy


def test_build_content_security_policy_includes_firebase_auth_sources():
    policy = build_content_security_policy()

    assert "https://apis.google.com" in policy
    assert "https://identitytoolkit.googleapis.com" in policy
    assert "https://securetoken.googleapis.com" in policy
    assert "https://lecture-processor-cdff6.firebaseapp.com" in policy
    assert "https://accounts.google.com" in policy


def test_build_content_security_policy_adds_frontend_sentry_ingest_host():
    policy = build_content_security_policy(
        sentry_frontend_dsn='https://public@example.ingest.sentry.io/123456',
    )

    assert "https://example.ingest.sentry.io" in policy
