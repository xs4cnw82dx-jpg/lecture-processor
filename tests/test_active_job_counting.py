from dataclasses import dataclass, replace
import logging
from threading import Lock
from types import SimpleNamespace

from lecture_processor.domains.account.lifecycle import count_active_jobs_for_user
from lecture_processor.repositories import batch_repo, runtime_jobs_repo


@dataclass(frozen=True)
class MemoryQuery:
    store: object
    collection_name: str
    rows: tuple
    row_limit: int | None = None

    def where(self, field, operator, value):
        def matches(row):
            actual = row[1].get(field)
            if operator == '==':
                return actual == value
            if operator == 'in':
                return actual in value
            raise AssertionError(f'Unexpected operator: {operator}')

        return replace(self, rows=tuple(row for row in self.rows if matches(row)))

    def order_by(self, field, direction=None):
        return replace(self, rows=tuple(sorted(
            self.rows,
            key=lambda row: row[1].get(field, 0),
            reverse=direction == 'DESCENDING',
        )))

    def limit(self, count):
        self.store.limits.append((self.collection_name, count))
        return replace(self, row_limit=count)

    def stream(self):
        return [SimpleNamespace(id=job_id) for job_id, _ in self.rows[:self.row_limit]]


class MemoryStore:
    def __init__(self, runtime_jobs=(), batch_jobs=()):
        self.rows = {'runtime_jobs': tuple(runtime_jobs), 'batch_jobs': tuple(batch_jobs)}
        self.limits = []

    def collection(self, name):
        return MemoryQuery(self, name, self.rows[name])


def runtime_with_jobs(*, memory=None, stored=(), batches=(), maximum=10):
    return SimpleNamespace(
        jobs=dict(memory or {}),
        JOBS_LOCK=Lock(),
        MAX_ACTIVE_JOBS_PER_USER=maximum,
        db=MemoryStore(stored, batches),
        RUNTIME_JOBS_COLLECTION='runtime_jobs',
        runtime_jobs_repo=runtime_jobs_repo,
        batch_repo=batch_repo,
        logger=logging.getLogger(__name__),
    )


def runtime_job(job_id, *, user_id='student', status='processing'):
    return job_id, {'user_id': user_id, 'status': status}


def batch_job(job_id, *, uid='student', status='processing'):
    return job_id, {'uid': uid, 'status': status}


def test_one_job_in_memory_and_storage_counts_once():
    job = runtime_job('same-job')
    runtime = runtime_with_jobs(memory=[job], stored=[job])

    assert count_active_jobs_for_user('student', runtime=runtime) == 1


def test_duplicate_documents_do_not_hide_other_active_jobs():
    jobs = [runtime_job(job_id) for job_id in ['a', 'b', 'c', 'd']]
    runtime = runtime_with_jobs(memory=jobs[:2], stored=jobs, maximum=4)

    assert count_active_jobs_for_user('student', runtime=runtime) == 4


def test_runtime_lookup_has_room_for_duplicates_and_stops_at_guard_threshold():
    jobs = [runtime_job(job_id) for job_id in ['a', 'b', 'c', 'd', 'e', 'f']]
    runtime = runtime_with_jobs(memory=jobs[:2], stored=jobs, maximum=4)

    assert count_active_jobs_for_user('student', runtime=runtime) == 5
    assert runtime.db.limits == [('runtime_jobs', 5)]


def test_batch_with_same_id_remains_a_separate_job():
    job = runtime_job('shared-id')
    runtime = runtime_with_jobs(memory=[job], stored=[job], batches=[batch_job('shared-id')])

    assert count_active_jobs_for_user('student', runtime=runtime) == 2


def test_other_accounts_and_terminal_jobs_are_excluded_from_all_sources():
    active = runtime_job('active')
    other_account = runtime_job('other-user', user_id='another-student')
    completed = runtime_job('complete', status='complete')
    failed = runtime_job('failed', status='error')
    runtime = runtime_with_jobs(
        memory=[active, other_account, completed, failed, ('invalid', None)],
        stored=[other_account, completed, failed, active],
        batches=[
            batch_job('other-user', uid='another-student'),
            batch_job('finished', status='completed'),
            batch_job('failed', status='error'),
            batch_job('active-batch', status='preparing'),
        ],
    )

    assert count_active_jobs_for_user('student', runtime=runtime) == 2


def test_all_active_states_are_counted():
    jobs = [runtime_job(status, status=status) for status in ['preparing', 'queued', 'starting', 'processing']]
    runtime = runtime_with_jobs(stored=jobs)

    assert count_active_jobs_for_user('student', runtime=runtime) == 4


def test_memory_only_count_works_without_database():
    runtime = runtime_with_jobs(memory=[runtime_job('active'), runtime_job('finished', status='error')])
    runtime.db = None

    assert count_active_jobs_for_user('student', runtime=runtime) == 1


def test_memory_at_guard_threshold_does_not_query_storage():
    runtime = runtime_with_jobs(memory=[runtime_job(str(index)) for index in range(5)], maximum=2)

    assert count_active_jobs_for_user('student', runtime=runtime) == 3
    assert runtime.db.limits == []


def test_empty_user_does_not_count_jobs_or_query_storage():
    runtime = runtime_with_jobs(memory=[runtime_job('active')])

    assert count_active_jobs_for_user('', runtime=runtime) == 0
    assert runtime.db.limits == []
