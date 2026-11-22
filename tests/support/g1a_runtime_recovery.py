import os
from concurrent.futures import Future
from copy import deepcopy
from datetime import datetime
from threading import RLock
from types import SimpleNamespace

from lecture_processor.domains.billing import job_charges
from lecture_processor.domains.runtime_jobs.schema import PERSISTED_RUNTIME_JOB_FIELDS
from lecture_processor.repositories import batch_repo, runtime_jobs_repo, study_repo
from lecture_processor.services import job_state_service
from tests.credit_test_support import make_credit_runtime


def make_runtime(scheme=2):
    user = {'uid': 'owner', 'account_status': 'active', 'total_processed': 0,
            'lecture_credits_standard': 5, 'slides_credits': 5, 'interview_credits_short': 5}
    if scheme == 2:
        user.update(credits_version=2, credits=100)
    runtime, state = make_credit_runtime(users={'owner': user}, unified_enabled=False)
    runtime.jobs, runtime.JOBS_LOCK = {}, RLock()
    runtime.job_state_service = job_state_service
    runtime.runtime_jobs_repo, runtime.batch_repo = runtime_jobs_repo, batch_repo
    runtime.repositories = SimpleNamespace(study=study_repo, users=runtime.users_repo)
    runtime.RUNTIME_JOBS_COLLECTION = 'runtime_jobs'
    runtime.RUNTIME_JOB_PERSISTED_FIELDS = PERSISTED_RUNTIME_JOB_FIELDS
    runtime.JOB_TTL_SECONDS = 1800
    runtime.RUNTIME_JOB_RECOVERY_ENABLED = True
    runtime.RUNTIME_JOB_RECOVERY_BATCH_LIMIT = 100
    runtime.RUNTIME_JOB_RECOVERY_LEASE_COLLECTION = 'recovery_leases'
    runtime.RUNTIME_JOB_RECOVERY_LEASE_ID = 'runtime'
    runtime.RUNTIME_JOB_RECOVERY_LEASE_SECONDS = 300
    runtime.RUNTIME_JOB_RECOVERY_LOCK = RLock()
    runtime.RUNTIME_JOB_RECOVERY_DONE = False
    runtime.get_timestamp = lambda value: value.timestamp() if isinstance(value, datetime) else float(value or 0)
    runtime.os = os
    runtime.client, runtime.MAX_ACTIVE_JOBS_PER_USER = object(), 10
    runtime.logs = []
    runtime.save_job_log = lambda *args, **kwargs: runtime.logs.append((deepcopy(args), kwargs))
    return runtime, state


def admit(runtime, job_id='job'):
    return job_charges.admit_runtime_job(
        'owner', job_id, 'lecture-notes', {'primary': {'action': 'lecture_notes', 'units': 1}}, runtime=runtime,
    )


class Dispatcher:
    def __init__(self):
        self.entries = []

    def submit(self, target, *args, **kwargs):
        future = Future()
        self.entries.append((future, target, args, kwargs))
        return future

    def run(self):
        future, target, args, kwargs = self.entries.pop(0)
        if future.set_running_or_notify_cancel():
            try:
                future.set_result(target(*args, **kwargs))
            except BaseException as error:
                future.set_exception(error)
