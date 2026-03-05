from datetime import timezone
from types import SimpleNamespace

from lecture_processor.domains.ai import pipelines


def test_save_study_pack_marks_user_created_flag(monkeypatch):
    class _DocRef:
        def __init__(self):
            self.id = "pack-123"
            self.payload = None

        def set(self, payload):
            self.payload = dict(payload)

    class _StudyRepo:
        def __init__(self, ref):
            self.ref = ref

        def create_study_pack_doc_ref(self, _db):
            return self.ref

    writes = []
    doc_ref = _DocRef()
    runtime = SimpleNamespace(
        study_repo=_StudyRepo(doc_ref),
        db=object(),
        time=SimpleNamespace(time=lambda: 1773000000.0),
        users_repo=SimpleNamespace(set_doc=lambda _db, uid, payload, merge=False: writes.append((uid, payload, merge))),
        logger=SimpleNamespace(warning=lambda *args, **kwargs: None, error=lambda *args, **kwargs: None),
        FEATURE_AUDIO_SECTION_SYNC=False,
    )

    monkeypatch.setattr(
        pipelines.study_progress,
        "resolve_user_timezone",
        lambda _uid, runtime=None: (timezone.utc, "UTC"),
    )
    monkeypatch.setattr(
        pipelines.study_audio,
        "normalize_audio_storage_key",
        lambda value, runtime=None: str(value or ""),
    )

    job_data = {
        "user_id": "u-test",
        "mode": "lecture-notes",
        "study_pack_title": "Biology Week 1",
        "result": "# Notes",
        "audio_storage_key": "",
    }

    pipelines.save_study_pack("job-123", job_data, runtime=runtime)

    assert doc_ref.payload is not None
    assert doc_ref.payload["title"] == "Biology Week 1"
    assert job_data["study_pack_id"] == "pack-123"
    assert writes
    uid, payload, merge = writes[-1]
    assert uid == "u-test"
    assert merge is True
    assert payload["has_created_study_pack"] is True
