"""Explicit repository capability exposed by the application runtime."""

from __future__ import annotations


class RuntimeRepositories:
    """Narrow, named access to persistence adapters.

    Properties resolve lazily from the compatibility core so test overrides and
    initialization order remain safe while services stop depending on arbitrary
    attributes forwarded by ``AppRuntime.__getattr__``.
    """

    def __init__(self, core_module):
        self._core = core_module

    @property
    def admin(self):
        return self._core.admin_repo

    @property
    def admin_credit_grants(self):
        return self._core.admin_credit_grants_repo

    @property
    def batches(self):
        return self._core.batch_repo

    @property
    def planner(self):
        return self._core.planner_repo

    @property
    def purchases(self):
        return self._core.purchases_repo

    @property
    def runtime_jobs(self):
        return self._core.runtime_jobs_repo

    @property
    def study(self):
        return self._core.study_repo

    @property
    def users(self):
        return self._core.users_repo
