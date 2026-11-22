from copy import deepcopy
from threading import RLock
from types import SimpleNamespace

from lecture_processor.domains.runtime_jobs import store
from lecture_processor.domains.runtime_jobs.schema import PERSISTED_RUNTIME_JOB_FIELDS
from lecture_processor.services import job_state_service


def make_retention_state():
    state = SimpleNamespace(now=10000.0, documents={}, writes=[], deleted=[])

    def set_doc(_db, _collection, job_id, payload, merge=False):
        if not merge:
            state.documents[job_id] = {}
        state.documents.setdefault(job_id, {}).update(deepcopy(payload))
        state.writes.append(deepcopy(payload))

    def get_doc(_db, _collection, job_id):
        payload = deepcopy(state.documents.get(job_id))
        return SimpleNamespace(exists=payload is not None, to_dict=lambda: deepcopy(payload))

    def delete_doc(_db, _collection, job_id):
        state.deleted.append(job_id)
        state.documents.pop(job_id, None)

    state.runtime = SimpleNamespace(
        db=object(), jobs={}, JOBS_LOCK=RLock(), JOB_TTL_SECONDS=1800,
        time=SimpleNamespace(time=lambda: state.now),
        RUNTIME_JOBS_COLLECTION='runtime_jobs',
        RUNTIME_JOB_PERSISTED_FIELDS=PERSISTED_RUNTIME_JOB_FIELDS,
        job_state_service=job_state_service,
        runtime_jobs_repo=SimpleNamespace(set_doc=set_doc, get_doc=get_doc, delete_doc=delete_doc),
        logger=SimpleNamespace(warning=lambda *_args, **_kwargs: None),
    )
    return state


def bind_cleanup(monkeypatch, state):
    from lecture_processor.runtime import core

    monkeypatch.setattr(core, 'jobs', state.runtime.jobs)
    monkeypatch.setattr(core, 'JOBS_LOCK', state.runtime.JOBS_LOCK)
    monkeypatch.setattr(core, 'JOB_TTL_SECONDS', state.runtime.JOB_TTL_SECONDS)
    monkeypatch.setattr(core, 'time', state.runtime.time)
    monkeypatch.setattr(core, 'delete_runtime_job_snapshot', lambda job_id: store.delete_runtime_job_snapshot(job_id, runtime=state.runtime))
