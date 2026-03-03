from lecture_processor.domains.rate_limit import quotas
from lecture_processor.runtime.container import get_runtime


def test_rate_limit_quotas_dispatch_uses_explicit_runtime():
    class _Runtime:
        def has_sufficient_upload_disk_space(self, requested_bytes=0):
            return (requested_bytes < 10, 1000, requested_bytes)

        def reserve_daily_upload_bytes(self, uid, requested_bytes):
            return (True, f"{uid}:{requested_bytes}")

    runtime = _Runtime()
    assert quotas.has_sufficient_upload_disk_space(5, runtime=runtime) == (True, 1000, 5)
    assert quotas.has_sufficient_upload_disk_space(20, runtime=runtime) == (False, 1000, 20)
    assert quotas.reserve_daily_upload_bytes("u1", 300, runtime=runtime) == (True, "u1:300")


def test_rate_limit_quotas_dispatch_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.core, "has_sufficient_upload_disk_space", lambda requested_bytes=0: (True, 42, requested_bytes))
    monkeypatch.setattr(runtime.core, "reserve_daily_upload_bytes", lambda uid, requested_bytes: (False, requested_bytes))

    with app.app_context():
        assert quotas.has_sufficient_upload_disk_space(123) == (True, 42, 123)
        assert quotas.reserve_daily_upload_bytes("u2", 456) == (False, 456)
