from lecture_processor.domains.admin import metrics
from lecture_processor.runtime.container import get_runtime


def test_admin_metrics_dispatch_uses_explicit_runtime():
    class _Runtime:
        def get_admin_window(self, key):
            return (key, 7)

        def safe_count_collection(self, name):
            return len(name)

        def build_admin_deployment_info(self, host):
            return {"host": host}

    runtime = _Runtime()
    assert metrics.get_admin_window("7d", runtime=runtime) == ("7d", 7)
    assert metrics.safe_count_collection("users", runtime=runtime) == 5
    assert metrics.build_admin_deployment_info("example.com", runtime=runtime) == {"host": "example.com"}


def test_admin_metrics_dispatch_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.core, "get_admin_window", lambda key: (f"core:{key}", 1))
    monkeypatch.setattr(runtime.core, "safe_count_collection", lambda name: 99)

    with app.app_context():
        assert metrics.get_admin_window("30d") == ("core:30d", 1)
        assert metrics.safe_count_collection("job_logs") == 99
