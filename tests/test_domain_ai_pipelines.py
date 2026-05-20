from datetime import timezone
from types import SimpleNamespace

import pytest

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


def test_primary_credit_refund_marks_pending_when_refund_call_fails(monkeypatch):
    persisted = []
    runtime = SimpleNamespace(logger=SimpleNamespace(warning=lambda *args, **kwargs: None))
    job_data = {"billing_receipt": {"charged": {"lecture_credits_standard": 1}}}

    monkeypatch.setattr(pipelines.billing_credits, "refund_credit", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(
        pipelines.billing_receipts,
        "add_job_credit_refund",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("receipt should not be marked refunded")),
    )
    monkeypatch.setattr(pipelines.runtime_jobs_store, "set_job", lambda job_id, payload, runtime=None: persisted.append((job_id, dict(payload))))

    refunded = pipelines._refund_primary_job_credit("job-refund-fail", job_data, "u1", "lecture_credits_standard", runtime=runtime)

    assert refunded is False
    assert job_data["credit_refunded"] is False
    assert job_data["credit_refund_pending"] is True
    assert job_data["credit_refund_error"] == "credit_refund_failed"
    assert persisted[-1][0] == "job-refund-fail"


def test_primary_credit_refund_records_receipt_only_after_success(monkeypatch):
    persisted = []
    runtime = SimpleNamespace(
        logger=SimpleNamespace(warning=lambda *args, **kwargs: None),
        time=SimpleNamespace(time=lambda: 100.0),
    )
    job_data = {"billing_receipt": {"charged": {"slides_credits": 1}}}

    monkeypatch.setattr(pipelines.billing_credits, "refund_credit", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(pipelines.runtime_jobs_store, "set_job", lambda job_id, payload, runtime=None: persisted.append((job_id, dict(payload))))

    refunded = pipelines._refund_primary_job_credit("job-refund-ok", job_data, "u1", "slides_credits", runtime=runtime)

    assert refunded is True
    assert job_data["credit_refunded"] is True
    assert job_data["billing_receipt"]["refunded"]["slides_credits"] == 1
    assert persisted[-1][0] == "job-refund-ok"


def test_extra_slides_refund_does_not_increment_when_refund_fails(monkeypatch):
    persisted = []
    runtime = SimpleNamespace(logger=SimpleNamespace(warning=lambda *args, **kwargs: None))
    job_data = {"extra_slides_refunded": 1, "billing_receipt": {"charged": {"slides_credits": 3}}}

    monkeypatch.setattr(pipelines.billing_credits, "refund_slides_credits", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(
        pipelines.billing_receipts,
        "add_job_credit_refund",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("receipt should not be marked refunded")),
    )
    monkeypatch.setattr(pipelines.runtime_jobs_store, "set_job", lambda job_id, payload, runtime=None: persisted.append((job_id, dict(payload))))

    refunded = pipelines._refund_extra_slides("job-extra-fail", job_data, "u1", 2, runtime=runtime)

    assert refunded is False
    assert job_data["extra_slides_refunded"] == 1
    assert job_data["extra_slides_refund_pending"] == 2
    assert persisted[-1][0] == "job-extra-fail"


@pytest.mark.parametrize(
    ("mode", "job_data", "expected_source"),
    [
        (
            "lecture-notes",
            {
                "result": "# Notes",
                "slide_text": "Slide text",
                "transcript": "Transcript text",
            },
            {
                "mode": "lecture-notes",
                "slide_text": "Slide text",
                "transcript": "Transcript text",
            },
        ),
        (
            "slides-only",
            {
                "result": "Extracted slide text",
            },
            {
                "mode": "slides-only",
                "slide_text": "Extracted slide text",
            },
        ),
        (
            "interview",
            {
                "result": "Transcript output",
                "transcript": "Interview transcript",
            },
            {
                "mode": "interview",
                "transcript": "Interview transcript",
            },
        ),
    ],
)
def test_save_study_pack_writes_source_outputs(monkeypatch, mode, job_data, expected_source):
    class _DocRef:
        def __init__(self):
            self.id = f"pack-{mode}"
            self.payload = None

        def set(self, payload):
            self.payload = dict(payload)

    class _SourceRef:
        def __init__(self):
            self.payload = None

        def set(self, payload):
            self.payload = dict(payload)

    class _StudyRepo:
        def __init__(self, pack_ref, source_ref):
            self.pack_ref = pack_ref
            self.source_ref = source_ref

        def create_study_pack_doc_ref(self, _db):
            return self.pack_ref

        def study_pack_source_doc_ref(self, _db, _pack_id):
            return self.source_ref

    pack_ref = _DocRef()
    source_ref = _SourceRef()
    runtime = SimpleNamespace(
        study_repo=_StudyRepo(pack_ref, source_ref),
        db=object(),
        time=SimpleNamespace(time=lambda: 1773001234.0),
        users_repo=SimpleNamespace(set_doc=lambda *_args, **_kwargs: None),
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

    payload = {
        "user_id": "u-test",
        "mode": mode,
        "study_pack_title": f"{mode} title",
        "audio_storage_key": "",
    }
    payload.update(job_data)

    pipelines.save_study_pack(f"job-{mode}", payload, runtime=runtime)

    assert source_ref.payload is not None
    assert source_ref.payload["study_pack_id"] == pack_ref.id
    assert source_ref.payload["uid"] == "u-test"
    assert source_ref.payload["source_job_id"] == f"job-{mode}"
    for key, value in expected_source.items():
        assert source_ref.payload[key] == value
