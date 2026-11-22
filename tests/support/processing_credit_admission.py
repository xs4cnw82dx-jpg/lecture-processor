from threading import RLock
from types import SimpleNamespace

from lecture_processor.domains.runtime_jobs.schema import PERSISTED_RUNTIME_JOB_FIELDS
from lecture_processor.repositories import batch_repo, runtime_jobs_repo
from lecture_processor.services import job_state_service
from tests.credit_test_support import make_credit_runtime


def runtime_fixture(*, enabled=True, user=None):
    runtime, store = make_credit_runtime(
        users={'owner': user or {'uid': 'owner', 'credits_version': 2, 'credits': 100, 'total_processed': 0}},
        unified_enabled=enabled,
    )
    runtime.runtime_jobs_repo = runtime_jobs_repo
    runtime.batch_repo = batch_repo
    runtime.RUNTIME_JOBS_COLLECTION = 'runtime_jobs'
    runtime.RUNTIME_JOB_PERSISTED_FIELDS = PERSISTED_RUNTIME_JOB_FIELDS
    runtime.job_state_service = job_state_service
    runtime.jobs = {}
    runtime.JOBS_LOCK = RLock()
    runtime.RUNTIME_JOB_RECOVERY_ENABLED = True
    runtime.RUNTIME_JOB_RECOVERY_BATCH_LIMIT = 200
    runtime.os = SimpleNamespace(getenv=lambda *_: '', getpid=lambda: 7)
    runtime.save_job_log = lambda *_, **__: None
    return runtime, store


PRIMARY = {'primary': {'action': 'lecture_notes', 'units': 1}}


def stage_batch(runtime, batch_id, rows):
    runtime.batch_repo.batch_job_doc_ref(runtime.db, batch_id).set({
        'uid': 'owner', 'status': 'preparing', 'credit_admission_state': 'pending',
        'admitted_rows': 0, 'total_rows': rows, 'credits_charged': 0,
    })
    for index in range(rows):
        runtime.batch_repo.batch_row_doc_ref(runtime.db, batch_id, str(index)).set({
            'uid': 'owner', 'row_id': str(index), 'batch_id': batch_id, 'status': 'queued',
        })
