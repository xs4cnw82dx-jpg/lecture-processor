from types import SimpleNamespace

from lecture_processor.domains.rate_limit import quotas
from lecture_processor.runtime.container import get_runtime


def test_has_sufficient_upload_disk_space_uses_threshold(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime, "UPLOAD_FOLDER", "/tmp")
    monkeypatch.setattr(runtime, "UPLOAD_MIN_FREE_DISK_BYTES", 100)
    monkeypatch.setattr(quotas.os.path, "exists", lambda _path: True)
    monkeypatch.setattr(quotas.shutil, "disk_usage", lambda _path: SimpleNamespace(free=250))

    assert quotas.has_sufficient_upload_disk_space(50, runtime=runtime) == (True, 250, 150)


def test_reserve_daily_upload_bytes_short_circuits_without_db():
    class _Runtime:
        db = None

    assert quotas.reserve_daily_upload_bytes("u1", 123, runtime=_Runtime()) == (True, 0)
