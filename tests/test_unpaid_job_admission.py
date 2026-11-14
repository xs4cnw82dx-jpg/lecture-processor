"""An unpaid job must have a durable admission before work is queued."""

from types import SimpleNamespace
from threading import Event

import pytest

from lecture_processor.domains.runtime_jobs import execution, store
from lecture_processor.runtime.job_dispatcher import BoundedJobDispatcher
from lecture_processor.services import account_data_service, media_admission, upload_quota_service
from tests.credit_test_support import make_credit_runtime
from tests.test_background_lecture_download import downloads as downloads


@pytest.fixture
def exports(client, core, monkeypatch, tmp_path):
    state = SimpleNamespace(core=core, queued=[], root=tmp_path)
    monkeypatch.setattr(core, 'UPLOAD_FOLDER', str(tmp_path))
    monkeypatch.setattr(core, 'db', None)
    monkeypatch.setattr(account_data_service, '_require_recent_account_user',
                        lambda *_args: ({'uid': 'owner', 'email': 'owner@example.test'}, None, None))
    monkeypatch.setattr(account_data_service, '_account_action_rate_limit', lambda *_args: None)
    monkeypatch.setattr(core, 'submit_background_job', lambda *args, **kwargs: state.queued.append((args, kwargs)))
    state.post = lambda: client.post('/api/account/export-bundle', json={
        'scope': 'account', 'include': {'account_json': True},
    })
    return state


@pytest.mark.parametrize('persisted_before_error', [False, True], ids=['write-failed', 'ack-lost'])
def test_download_admission_failure_returns_retry_and_releases_reserved_capacity(downloads, monkeypatch, persisted_before_error):
    state = downloads
    documents, attempted = {}, []

    def fail_write(_db, _collection, job_id, payload, merge=False):
        attempted.append(job_id)
        if persisted_before_error:
            documents[job_id] = dict(payload)
        raise OSError('Synthetic admission failure')

    monkeypatch.setattr(state.core, 'db', object())
    monkeypatch.setattr(state.core, 'runtime_jobs_repo', SimpleNamespace(
        set_doc=fail_write,
        delete_doc=lambda _db, _collection, job_id: documents.pop(job_id, None),
        get_doc=lambda *_args: SimpleNamespace(exists=False, to_dict=lambda: {}),
    ))

    response = state.post()

    assert response.status_code == 503
    assert 'job_id' not in response.get_json()
    assert state.queued == state.media == []
    assert state.released == state.reserved
    assert not documents
    assert attempted and all(job_id not in state.core.jobs for job_id in attempted)
    lease, busy = media_admission.try_acquire('owner')
    assert lease is not None and busy == 0
    lease.release()


@pytest.mark.parametrize('persisted_before_error', [False, True], ids=['write-failed', 'ack-lost'])
def test_export_admission_failure_returns_retry_before_dispatch(exports, monkeypatch, persisted_before_error):
    core = exports.core
    documents, attempted = {}, []

    def fail_write(_db, _collection, job_id, payload, merge=False):
        attempted.append(job_id)
        if persisted_before_error:
            documents[job_id] = dict(payload)
        raise OSError('Synthetic admission failure')

    monkeypatch.setattr(core, 'db', object())
    monkeypatch.setattr(core, 'runtime_jobs_repo', SimpleNamespace(
        set_doc=fail_write,
        delete_doc=lambda _db, _collection, job_id: documents.pop(job_id, None),
        get_doc=lambda *_args: SimpleNamespace(exists=False, to_dict=lambda: {}),
    ))
    response = exports.post()

    assert response.status_code == 503
    assert 'job_id' not in response.get_json()
    assert exports.queued == []
    assert not documents
    assert attempted and all(job_id not in core.jobs for job_id in attempted)
    assert not list(exports.root.rglob('*.zip'))


@pytest.mark.parametrize('route_fixture', ['downloads', 'exports'])
def test_successful_durable_admission_is_persisted_before_local_publication_and_dispatch(request, monkeypatch, route_fixture):
    state = request.getfixturevalue(route_fixture)
    documents, local_during_write, dispatched = {}, [], []

    def persist(_db, _collection, job_id, payload, merge=False):
        local_during_write.append(state.core.jobs.get(job_id))
        documents[job_id] = dict(payload)

    def dispatch(*args, **kwargs):
        dispatched.append({job_id: dict(value) for job_id, value in documents.items()})
        # Keep the existing fixture's lease cleanup when work is deliberately held.
        state.queued.append((args[0], args[1:], kwargs) if route_fixture == 'downloads' else (args, kwargs))

    monkeypatch.setattr(state.core, 'db', object())
    monkeypatch.setattr(state.core, 'runtime_jobs_repo', SimpleNamespace(set_doc=persist))
    monkeypatch.setattr(state.core, 'submit_background_job', dispatch)

    response = state.post()

    assert response.status_code == 202
    job_id = response.get_json()['job_id']
    assert local_during_write == [None]
    assert len(dispatched) == 1
    assert dispatched[0][job_id]['status'] == 'queued'
    assert dispatched[0][job_id]['user_id'] == 'owner'
    assert state.core.jobs[job_id]['status'] == 'queued'


@pytest.mark.parametrize('route_fixture', ['downloads', 'exports'])
def test_memory_only_admission_still_queues_without_a_storage_write(request, monkeypatch, route_fixture):
    state = request.getfixturevalue(route_fixture)
    writes = []
    monkeypatch.setattr(state.core, 'runtime_jobs_repo', SimpleNamespace(set_doc=lambda *args, **kwargs: writes.append((args, kwargs))))

    response = state.post()

    assert response.status_code == 202
    job_id = response.get_json()['job_id']
    assert state.core.jobs[job_id]['status'] == 'queued'
    assert len(state.queued) == 1
    assert writes == []


@pytest.mark.parametrize('route_fixture', ['downloads', 'exports'])
def test_lost_ack_and_failed_cleanup_still_release_resources_and_never_dispatch(request, monkeypatch, route_fixture):
    state = request.getfixturevalue(route_fixture)
    documents, deletion_attempts = {}, []

    def lost_ack(_db, _collection, job_id, payload, merge=False):
        documents[job_id] = dict(payload)
        raise OSError('Synthetic private admission detail')

    def failed_cleanup(_db, _collection, job_id):
        deletion_attempts.append(job_id)
        raise OSError('Synthetic private cleanup detail')

    monkeypatch.setattr(state.core, 'db', object())
    monkeypatch.setattr(state.core, 'runtime_jobs_repo', SimpleNamespace(set_doc=lost_ack, delete_doc=failed_cleanup))

    response = state.post()

    assert response.status_code == 503
    assert response.get_json() == {'error': (
        'Could not start lecture download right now. Please try again.' if route_fixture == 'downloads'
        else 'Could not start export right now. Please try again.'
    )}
    assert len(documents) == 1
    assert deletion_attempts == list(documents)
    assert state.queued == []
    assert all(job_id not in state.core.jobs for job_id in documents)
    if route_fixture == 'downloads':
        assert state.media == []
        assert state.released == state.reserved
        lease, busy = media_admission.try_acquire('owner')
        assert lease is not None and busy == 0
        lease.release()
    else:
        assert not list(state.root.rglob('*.zip'))


def test_ordinary_partial_snapshot_failure_keeps_existing_best_effort_behavior(monkeypatch):
    runtime = SimpleNamespace(
        db=object(), time=SimpleNamespace(time=lambda: 1000), RUNTIME_JOBS_COLLECTION='runtime_jobs',
        RUNTIME_JOB_PERSISTED_FIELDS={'status', 'step_description'},
        runtime_jobs_repo=SimpleNamespace(set_doc=lambda *_args, **_kwargs: (_ for _ in ()).throw(OSError('Synthetic failure'))),
        logger=SimpleNamespace(warning=lambda *_args, **_kwargs: None),
    )
    # Progress snapshots are not a new admission and must not interrupt work.
    store.persist_runtime_job_snapshot('job', {'status': 'processing', 'step_description': 'Working'},
                                       runtime=runtime, changed_fields={'step_description'})


@pytest.fixture
def real_download_execution(downloads, monkeypatch):
    state = downloads
    runtime, durable = make_credit_runtime()
    monkeypatch.setattr(state.core, 'db', runtime.db)
    monkeypatch.setattr(state.core, 'firestore', runtime.firestore)
    monkeypatch.setattr(state.core, 'time', runtime.time)
    dispatcher = BoundedJobDispatcher(max_workers=1, max_pending=1)
    started, release = Event(), Event()
    futures, admitted = [], []

    def hold_worker():
        started.set()
        assert release.wait(5), 'The synthetic queue gate must be released'

    dispatcher.submit(hold_worker)
    assert started.wait(5)

    def submit(target, *args, **kwargs):
        # Keep the resources even if the executor rejects entry before target.
        admitted.append(kwargs)
        future = execution.submit_job(dispatcher, target, *args, execution_runtime=state.core, **kwargs)
        futures.append(future)
        return future

    monkeypatch.setattr(state.core, 'submit_background_job', submit)
    state.durable, state.release_worker, state.futures, state.admitted = durable, release, futures, admitted
    try:
        yield state
    finally:
        release.set()
        dispatcher._executor.shutdown(wait=True, cancel_futures=True)
        for kwargs in admitted:
            try:
                upload_quota_service.release_uncommitted_upload_quota(state.core, kwargs['quota_reservation'])
            finally:
                kwargs['media_lease'].release()


@pytest.mark.parametrize('remote_state', ['missing', 'error', 'claimed', 'read-failed'])
def test_completed_executor_future_releases_download_resources_when_worker_entry_is_rejected(real_download_execution, remote_state):
    state = real_download_execution
    response = state.post()
    assert response.status_code == 202
    job_id = response.get_json()['job_id']
    key = (state.core.RUNTIME_JOBS_COLLECTION, job_id)
    assert state.durable.documents[key]['status'] == 'queued'
    assert state.media == []
    assert execution.is_job_active(job_id)
    if remote_state == 'missing':
        state.durable.documents.pop(key)
    elif remote_state == 'error':
        state.durable.documents[key].update(status='error', error='Already settled elsewhere')
    elif remote_state == 'claimed':
        state.durable.documents[key]['recovery_claimed_at'] = state.durable.now
    else:
        state.durable.fail_reads.add(key)
    completed = Event()
    future = state.futures[0]
    future.add_done_callback(lambda _done: completed.set())

    state.release_worker.set()
    assert completed.wait(5), 'Executor completion callbacks must finish'

    assert not future.cancelled()
    assert (future.exception() is not None) is (remote_state == 'read-failed')
    assert not execution.is_job_active(job_id)
    assert state.media == state.paths == []
    lease, busy = media_admission.try_acquire('owner')
    try:
        assert (state.released, lease is not None, busy) == (state.reserved, True, 0)
    finally:
        if lease is not None:
            lease.release()
    if remote_state == 'missing':
        assert key not in state.durable.documents
    elif remote_state == 'error':
        assert state.durable.documents[key]['error'] == 'Already settled elsewhere'
    elif remote_state == 'claimed':
        assert state.durable.documents[key]['recovery_claimed_at'] == state.durable.now


def test_successful_real_download_future_keeps_committed_quota_and_file(real_download_execution):
    state = real_download_execution
    response = state.post()
    assert response.status_code == 202
    job_id = response.get_json()['job_id']
    completed = Event()
    future = state.futures[0]
    future.add_done_callback(lambda _done: completed.set())

    state.release_worker.set()
    assert completed.wait(5), 'Executor completion callbacks must finish'

    assert future.exception() is None
    assert len(state.media) == len(state.paths) == 1
    path = state.paths[0]
    assert path.read_bytes() == b'ID3 synthetic lecture'
    assert state.durable.documents[(state.core.RUNTIME_JOBS_COLLECTION, job_id)]['status'] == 'complete'
    reservation = state.admitted[0]['quota_reservation']
    assert reservation.committed is True
    assert reservation.reserved_bytes == path.stat().st_size
    assert sum(size for _uid, size in state.reserved) - sum(size for _uid, size in state.released) == path.stat().st_size
    lease, busy = media_admission.try_acquire('owner')
    try:
        assert lease is not None and busy == 0
    finally:
        if lease is not None:
            lease.release()
