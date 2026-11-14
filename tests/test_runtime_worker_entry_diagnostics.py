"""Worker-entry diagnostics keep durable admission and Future semantics intact."""

from copy import deepcopy
import logging

import pytest

from lecture_processor.domains.runtime_jobs import execution
from tests.test_g1a_runtime_recovery import Dispatcher, admit, make_runtime


@pytest.mark.parametrize('scheme', [1, 2], ids=['legacy', 'unified'])
@pytest.mark.parametrize('failure', ['read', 'write'])
def test_entry_heartbeat_failure_warns_and_preserves_original_error_and_admission(caplog, scheme, failure):
    runtime, state = make_runtime(scheme)
    job_id = 'synthetic-entry-failure'
    admit(runtime, job_id)
    dispatcher, calls = Dispatcher(), []
    future = execution.submit_job(dispatcher, lambda job_id: calls.append(job_id), job_id, execution_runtime=runtime)
    before = deepcopy(state.documents)
    assert execution.is_job_active(job_id)
    getattr(state, f'fail_{failure}s').add(('runtime_jobs', job_id))

    with caplog.at_level(logging.WARNING):
        dispatcher.run()

    with pytest.raises(RuntimeError, match=f'Synthetic {failure} failure') as raised:
        future.result()
    assert calls == []
    assert not execution.is_job_active(job_id)
    assert state.documents == before
    assert state.docs('credit_refunds') == {}
    warnings = [record for record in caplog.records
                if record.levelno == logging.WARNING and job_id in record.getMessage()]
    assert len(warnings) == 1
    assert warnings[0].exc_info[1] is raised.value


@pytest.mark.parametrize('scheme', [1, 2], ids=['legacy', 'unified'])
@pytest.mark.parametrize('target_fails', [False, True], ids=['returned', 'raised'])
def test_successful_entry_keeps_target_outcome_and_releases_registry_without_warning(caplog, scheme, target_fails):
    runtime, state = make_runtime(scheme)
    job_id = 'synthetic-entry-control'
    admit(runtime, job_id)
    dispatcher, calls = Dispatcher(), []
    original_error = RuntimeError('Synthetic target failure')

    def target(job_id):
        calls.append(job_id)
        if target_fails:
            raise original_error
        return 'synthetic-result'

    future = execution.submit_job(dispatcher, target, job_id, execution_runtime=runtime)
    before = deepcopy(state.documents)
    with caplog.at_level(logging.WARNING):
        dispatcher.run()
    if target_fails:
        with pytest.raises(RuntimeError) as raised:
            future.result()
        assert raised.value is original_error
    else:
        assert future.result() == 'synthetic-result'
    assert calls == [job_id]
    assert not execution.is_job_active(job_id)
    assert state.documents == before
    assert state.docs('credit_refunds') == {}
    assert not [record for record in caplog.records
                if record.levelno >= logging.WARNING and job_id in record.getMessage()]
