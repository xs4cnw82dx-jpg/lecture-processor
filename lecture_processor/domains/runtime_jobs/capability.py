"""Explicit runtime-jobs capability adapter for the application container."""

from typing import Any

from .schema import RuntimeJobRecord


class RuntimeJobsCapabilityAdapter:
    def __init__(self, runtime):
        self._runtime = runtime

    def get_job_snapshot(self, job_id: str) -> RuntimeJobRecord | None:
        from . import store
        return store.get_job_snapshot(job_id, runtime=self._runtime)

    def update_job_fields(self, job_id: str, **fields: Any) -> RuntimeJobRecord | None:
        from . import store
        return store.update_job_fields(job_id, runtime=self._runtime, **fields)

    def set_job(self, job_id: str, value: RuntimeJobRecord) -> RuntimeJobRecord | None:
        from . import store
        return store.set_job(job_id, value, runtime=self._runtime)

    def delete_job(self, job_id: str) -> bool:
        from . import store
        return bool(store.delete_job(job_id, runtime=self._runtime))
