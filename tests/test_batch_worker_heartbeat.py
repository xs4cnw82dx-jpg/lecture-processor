"""Batch liveness checks with real workers and synthetic external services."""

from contextlib import contextmanager
from copy import deepcopy
import logging
import json
import os
import threading
from types import SimpleNamespace
import uuid

import pytest

from lecture_processor.domains.ai import batch_orchestrator as batch
from lecture_processor.domains.ai import instant_batch_orchestrator as instant


class BatchHarness:
    def __init__(self, monkeypatch, strategy, *, rows=1):
        self.now = 1000.0
        self.batch_id = f'synthetic-{strategy}-{uuid.uuid4()}'
        self.refunds = []
        self.persisted = []
        self.providers = []
        self.uploads = []
        self.writes = []
        self.batch_writes = []
        self.job_logs = []
        self.changed = threading.Condition()
        self.upload_hook = lambda row: None
        self.provider_hook = lambda: None
        self.persistence_hook = lambda: None
        self.persistence_result = True
        self.runtime = SimpleNamespace(
            db=None, uuid=uuid, logger=logging.getLogger('synthetic-batch-test'),
            time=SimpleNamespace(time=lambda: self.now),
            MODEL_AUDIO='synthetic-audio-model',
            PROMPT_AUDIO_TRANSCRIPTION='Synthetic transcription in {output_language}',
            BATCH_JOB_RECOVERY_STALE_SECONDS=120,
            INSTANT_BATCH_MAX_PARALLEL_ROWS=1, INSTANT_BATCH_API_STAGGER_SECONDS=0,
            cleanup_files=lambda *_args: None,
            save_job_log=lambda *args: self.job_logs.append(deepcopy(args)),
            transcribe_audio_plain=self.transcribe,
        )
        self.worker = batch.process_batch_job if strategy == 'deferred' else instant.process_instant_batch_job
        monkeypatch.setattr(batch, '_upload_row_files', self.upload)
        monkeypatch.setattr(batch, '_run_batch_stage', self.run_provider_batch)
        monkeypatch.setattr(batch.ai_pipelines, 'save_study_pack', self.save_pack)
        monkeypatch.setattr(batch.job_charges, 'refund_component', self.refund)
        monkeypatch.setattr(batch.billing_receipts, 'add_job_credit_refund', lambda *_args, **_kwargs: None)
        monkeypatch.setattr(batch, 'send_batch_completion_email', lambda *_args, **_kwargs: ('skipped', 'synthetic test'))
        original_upsert_row = batch._upsert_row
        original_upsert_batch = batch._upsert_batch

        def record_row(batch_id, row_id, payload, runtime=None, merge=True):
            self.writes.append((row_id, deepcopy(payload)))
            return original_upsert_row(batch_id, row_id, payload, runtime=runtime, merge=merge)

        def record_batch(batch_id, payload, runtime=None, merge=True):
            self.batch_writes.append(deepcopy(payload))
            result = original_upsert_batch(batch_id, payload, runtime=runtime, merge=merge)
            with self.changed:
                self.changed.notify_all()
            return result

        monkeypatch.setattr(batch, '_upsert_row', record_row)
        monkeypatch.setattr(batch, '_upsert_batch', record_batch)
        batch.create_batch_job({
            'batch_id': self.batch_id, 'uid': 'synthetic-user', 'mode': 'audio-transcription',
            'status': 'queued', 'batch_title': 'Synthetic batch', 'total_rows': rows,
            'completion_email_status': 'skipped',
        }, [{
            'row_id': f'row-{index + 1}', 'ordinal': index + 1, 'status': 'queued',
            'credit_deducted': 'interview_credits_short', 'study_features': 'none',
        } for index in range(rows)], runtime=self.runtime)
        self.writes.clear()
        self.batch_writes.clear()

    def upload(self, row, runtime=None):
        self.uploads.append(row['row_id'])
        self.upload_hook(row)
        row['audio_file_uri'] = f'fake://{row["row_id"]}'
        row['audio_mime_type'] = 'audio/mpeg'

    def transcribe(self, *_args, **_kwargs):
        self.providers.append('audio_transcription')
        self.provider_hook()
        return 'Synthetic transcript.', {}

    def run_provider_batch(self, _batch_id, stage_name, requests, **_kwargs):
        self.providers.append(stage_name)
        self.provider_hook()
        return [{'response': {'text': 'Synthetic transcript.'}} for _ in requests]

    def save_pack(self, _job_id, payload, **_kwargs):
        self.persisted.append(deepcopy(payload))
        self.persistence_hook()
        return self.persistence_result

    def refund(self, row, component, target, refund_ref, **kwargs):
        assert row['uid'] == 'synthetic-user'
        assert component == 'primary' and target == 1
        assert kwargs['legacy_credit_type'] == 'interview_credits_short'
        assert kwargs['legacy_charged_units'] == 1 and kwargs['processed_count'] == 1
        self.refunds.append(((row['uid'], kwargs['legacy_credit_type']), refund_ref))
        return True

    @contextmanager
    def blocked(self, phase='upload', *, fail_after_release=False):
        entered = threading.Event()
        release = threading.Event()
        failures = []

        def pause(*_args):
            if entered.is_set():
                return
            entered.set()
            assert release.wait(5), 'Synthetic upload was not released'
            if fail_after_release:
                raise RuntimeError(f'Synthetic late {phase} failure')

        def run():
            try:
                self.worker(self.batch_id, runtime=self.runtime)
            except BaseException as error:
                failures.append(error)

        if phase == 'upload':
            self.upload_hook = pause
        elif phase == 'persistence':
            self.persistence_hook = pause
        else:
            self.provider_hook = pause
        thread = threading.Thread(target=run, daemon=True)
        thread.start()
        try:
            assert entered.wait(3), f'Worker did not enter {phase}: {failures}'
            yield
        finally:
            release.set()
            thread.join(3)
            assert not thread.is_alive(), 'Synthetic worker did not stop'
            assert not failures, failures

    def status(self):
        return batch.get_batch_status(self.batch_id, runtime=self.runtime)

    def stored_batch(self):
        return batch._get_batch(self.batch_id, runtime=self.runtime)

    def stop_externally(self):
        batch._upsert_batch(self.batch_id, {
            'status': 'error', 'provider_state': 'EXTERNAL_STOP',
            'current_stage_state': 'failed', 'finished_at': self.now,
            'error_summary': 'Stopped by another process.',
        }, runtime=self.runtime)
        return deepcopy(self.stored_batch())

    def requeue(self):
        batch._upsert_batch(self.batch_id, {
            'batch_id': self.batch_id, 'uid': 'synthetic-user', 'mode': 'audio-transcription',
            'status': 'queued', 'total_rows': 1, 'created_at': self.now,
            'completion_email_status': 'skipped',
        }, runtime=self.runtime, merge=False)
        batch._upsert_row(self.batch_id, 'row-1', {
            'row_id': 'row-1', 'ordinal': 1, 'status': 'queued',
            'credit_deducted': 'interview_credits_short', 'study_features': 'none',
        }, runtime=self.runtime, merge=False)


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_status_read_during_a_slow_upload_does_not_interrupt_or_refund(monkeypatch, strategy):
    harness = BatchHarness(monkeypatch, strategy)
    monkeypatch.setattr(batch, '_batch_heartbeat_interval_seconds', lambda runtime=None: 3600, raising=False)
    with harness.blocked():
        harness.now += 1000
        assert harness.now - harness.stored_batch()['last_heartbeat_at'] > 120
        observed = harness.status()
        refunds_while_uploading = list(harness.refunds)
    assert (observed['status'], observed['rows'][0]['status'], len(refunds_while_uploading)) == (
        'processing', 'processing', 0,
    )
    assert harness.status()['status'] == 'complete'
    assert harness.refunds == []
    assert len(harness.persisted) == 1


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
@pytest.mark.parametrize('phase', ['upload', 'provider'])
@pytest.mark.parametrize('fail_after_release', [False, True], ids=['success', 'failure'])
def test_external_terminal_transition_prevents_later_writes_and_refunds(monkeypatch, strategy, phase, fail_after_release):
    harness = BatchHarness(monkeypatch, strategy)
    with harness.blocked(phase, fail_after_release=fail_after_release):
        terminal = harness.stop_externally()
        rows_before_release = deepcopy(batch._list_rows(harness.batch_id, runtime=harness.runtime))
        writes_before_release = len(harness.writes)
        providers_before_release = len(harness.providers)
    assert harness.stored_batch() == terminal
    assert batch._list_rows(harness.batch_id, runtime=harness.runtime) == rows_before_release
    assert len(harness.writes) == writes_before_release
    assert len(harness.providers) == providers_before_release
    assert harness.persisted == []
    assert harness.refunds == []
    assert harness.job_logs == []


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_periodic_heartbeats_continue_during_upload_then_stop_for_terminal_state(monkeypatch, strategy):
    harness = BatchHarness(monkeypatch, strategy)
    monkeypatch.setattr(batch, '_batch_heartbeat_interval_seconds', lambda runtime=None: 0.01, raising=False)
    heartbeat = getattr(batch, '_heartbeat_batch', None)
    attempts = []

    def record_heartbeat(batch_id, runtime=None):
        try:
            return heartbeat(batch_id, runtime=runtime)
        finally:
            with harness.changed:
                attempts.append(batch_id)
                harness.changed.notify_all()

    if heartbeat is not None:
        monkeypatch.setattr(batch, '_heartbeat_batch', record_heartbeat)
    with harness.blocked():
        for _ in range(3):
            with harness.changed:
                harness.now += 60
                assert harness.changed.wait_for(
                    lambda: harness.stored_batch()['last_heartbeat_at'] == harness.now,
                    timeout=1,
                ), 'Heartbeat stopped while the upload was still running'
        terminal = harness.stop_externally()
        with harness.changed:
            previous_attempts = len(attempts)
            harness.now += 1000
            assert harness.changed.wait_for(lambda: len(attempts) > previous_attempts, timeout=1)
        assert harness.stored_batch() == terminal
    assert harness.stored_batch() == terminal
    assert harness.refunds == []
    assert harness.persisted == []


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_duplicate_execution_does_not_start_a_second_upload(monkeypatch, strategy):
    harness = BatchHarness(monkeypatch, strategy)
    with harness.blocked():
        harness.worker(harness.batch_id, runtime=harness.runtime)
        uploads_while_first_running = list(harness.uploads)
    assert uploads_while_first_running == ['row-1']
    assert harness.providers == ['audio_transcription']
    assert len(harness.persisted) == 1
    assert harness.refunds == []


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_worker_waits_for_an_active_status_reader_then_runs_once(monkeypatch, strategy):
    harness = BatchHarness(monkeypatch, strategy)
    reader_entered = threading.Event()
    reader_release = threading.Event()
    worker_started = threading.Event()
    worker_finished = threading.Event()
    failures = []
    repair = batch._repair_inactive_batch_state

    def blocked_repair(*args, **kwargs):
        reader_entered.set()
        assert reader_release.wait(5), 'Synthetic status reader was not released'
        return repair(*args, **kwargs)

    def read_status():
        try:
            harness.status()
        except BaseException as error:
            failures.append(error)

    def run_worker():
        worker_started.set()
        try:
            harness.worker(harness.batch_id, runtime=harness.runtime)
        except BaseException as error:
            failures.append(error)
        finally:
            worker_finished.set()

    monkeypatch.setattr(batch, '_repair_inactive_batch_state', blocked_repair)
    reader = threading.Thread(target=read_status, daemon=True)
    worker = threading.Thread(target=run_worker, daemon=True)
    reader.start()
    try:
        assert reader_entered.wait(3)
        worker.start()
        assert worker_started.wait(3)
        returned_before_reader = worker_finished.wait(0.1)
    finally:
        reader_release.set()
        reader.join(3)
        if worker.ident is not None:
            worker.join(3)
    assert not reader.is_alive() and not worker.is_alive()
    assert failures == []
    assert not returned_before_reader
    assert harness.uploads == ['row-1']
    assert len(harness.persisted) == 1
    assert harness.stored_batch()['status'] == 'complete'
    assert harness.refunds == []


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
@pytest.mark.parametrize('saved', [True, False], ids=['successful_save', 'failed_save'])
def test_external_stop_during_pack_persistence_prevents_followup_writes(monkeypatch, strategy, saved):
    harness = BatchHarness(monkeypatch, strategy)
    harness.persistence_result = saved
    with harness.blocked('persistence'):
        terminal = harness.stop_externally()
        rows_before_release = deepcopy(batch._list_rows(harness.batch_id, runtime=harness.runtime))
        writes_before_release = len(harness.writes)
        assert len(harness.persisted) == 1
    assert harness.stored_batch() == terminal
    assert batch._list_rows(harness.batch_id, runtime=harness.runtime) == rows_before_release
    assert len(harness.writes) == writes_before_release
    assert len(harness.persisted) == 1
    assert harness.refunds == []
    assert harness.job_logs == []


@pytest.mark.parametrize('stop_on_sleep', [1, 2], ids=['before_provider', 'before_next_upload'])
def test_instant_worker_rechecks_terminal_state_after_throttling(monkeypatch, stop_on_sleep):
    harness = BatchHarness(monkeypatch, 'instant', rows=2)
    harness.runtime.INSTANT_BATCH_API_STAGGER_SECONDS = 5
    stopped = {}
    sleeps = 0

    def sleep(seconds):
        nonlocal sleeps
        sleeps += 1
        harness.now += seconds
        if sleeps == stop_on_sleep:
            stopped['batch'] = harness.stop_externally()
            stopped['rows'] = deepcopy(batch._list_rows(harness.batch_id, runtime=harness.runtime))
            stopped['counts'] = (len(harness.uploads), len(harness.providers), len(harness.writes),
                                 len(harness.persisted), len(harness.job_logs))

    harness.runtime.time.sleep = sleep
    harness.worker(harness.batch_id, runtime=harness.runtime)
    assert sleeps == stop_on_sleep
    assert harness.stored_batch() == stopped['batch']
    assert batch._list_rows(harness.batch_id, runtime=harness.runtime) == stopped['rows']
    assert (len(harness.uploads), len(harness.providers), len(harness.writes),
            len(harness.persisted), len(harness.job_logs)) == stopped['counts']
    assert harness.refunds == []


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_final_batch_write_preserves_a_stop_during_completed_row_lookup(monkeypatch, strategy):
    harness = BatchHarness(monkeypatch, strategy)
    finalize = batch._finalize_batch_record
    list_rows = batch._list_rows
    finalizing = False
    stopped = {}

    def track_finalization(*args, **kwargs):
        nonlocal finalizing
        finalizing = True
        try:
            return finalize(*args, **kwargs)
        finally:
            finalizing = False

    def lookup(*args, **kwargs):
        rows = list_rows(*args, **kwargs)
        if finalizing and rows and all(row['status'] == 'complete' for row in rows) and not stopped:
            stopped['batch'] = harness.stop_externally()
            stopped['rows'] = deepcopy(rows)
            stopped['writes'] = len(harness.writes)
        return rows

    monkeypatch.setattr(batch, '_finalize_batch_record', track_finalization)
    monkeypatch.setattr(batch, '_list_rows', lookup)
    harness.worker(harness.batch_id, runtime=harness.runtime)
    assert stopped, 'Worker did not reach finalization with completed rows'
    assert harness.stored_batch() == stopped['batch']
    assert list_rows(harness.batch_id, runtime=harness.runtime) == stopped['rows']
    assert len(harness.writes) == stopped['writes']
    assert len(harness.persisted) == len(harness.job_logs) == 1
    assert harness.refunds == []


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_worker_rechecks_a_stop_after_initial_row_lookup(monkeypatch, strategy):
    harness = BatchHarness(monkeypatch, strategy)
    list_rows = batch._list_rows
    stopped = {}

    def lookup(*args, **kwargs):
        rows = list_rows(*args, **kwargs)
        if not stopped:
            stopped['batch'] = harness.stop_externally()
            stopped['rows'] = deepcopy(rows)
        return rows

    monkeypatch.setattr(batch, '_list_rows', lookup)
    harness.worker(harness.batch_id, runtime=harness.runtime)
    assert harness.stored_batch() == stopped['batch']
    assert list_rows(harness.batch_id, runtime=harness.runtime) == stopped['rows']
    assert harness.writes == []
    assert harness.uploads == harness.providers == harness.persisted == harness.job_logs == harness.refunds == []


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
@pytest.mark.parametrize('first_exit', ['normal', 'upload_error', 'no_rows', 'terminal', 'missing', 'lookup_error'])
def test_worker_registration_is_released_after_every_exit(monkeypatch, strategy, first_exit):
    harness = BatchHarness(monkeypatch, strategy, rows=0 if first_exit == 'no_rows' else 1)
    if first_exit == 'upload_error':
        def fail_upload(_row):
            raise RuntimeError('Synthetic upload failure')
        harness.upload_hook = fail_upload
    elif first_exit == 'terminal':
        harness.stop_externally()
    elif first_exit == 'missing':
        harness.runtime._BATCH_JOBS_MEMORY.pop(harness.batch_id)
    if first_exit == 'lookup_error':
        original_get = batch._get_batch

        def fail_lookup(batch_id, runtime=None):
            if threading.current_thread() is threading.main_thread():
                raise RuntimeError('Synthetic lookup failure')
            return original_get(batch_id, runtime=runtime)

        with monkeypatch.context() as patch:
            patch.setattr(batch, '_get_batch', fail_lookup)
            with pytest.raises(RuntimeError, match='Synthetic lookup failure'):
                harness.worker(harness.batch_id, runtime=harness.runtime)
    else:
        harness.worker(harness.batch_id, runtime=harness.runtime)
    harness.upload_hook = lambda _row: None
    persisted_before_retry = len(harness.persisted)
    refunds_before_retry = len(harness.refunds)
    harness.requeue()
    harness.worker(harness.batch_id, runtime=harness.runtime)
    assert harness.stored_batch()['status'] == 'complete'
    assert len(harness.persisted) == persisted_before_retry + 1
    assert len(harness.refunds) == refunds_before_retry


@pytest.mark.parametrize('stop_at', ['input_upload', 'create', 'poll', 'poll_wait', 'download', None], ids=[
    'input_upload', 'create', 'poll', 'poll_wait', 'download', 'normal_completion',
])
def test_deferred_provider_boundaries_preserve_external_terminal_decisions(monkeypatch, tmp_path, stop_at):
    run_batch_stage = batch._run_batch_stage
    harness = BatchHarness(monkeypatch, 'deferred')
    monkeypatch.setattr(batch, '_run_batch_stage', run_batch_stage)
    monkeypatch.setattr(batch.ai_provider, 'run_with_provider_retry', lambda _name, callback, **_kwargs: callback())
    harness.runtime.os = os
    harness.runtime.UPLOAD_FOLDER = str(tmp_path)
    calls = []
    stopped = {}

    def boundary(name):
        calls.append(name)
        if stop_at == name:
            stopped['batch'] = harness.stop_externally()
            stopped['rows'] = deepcopy(batch._list_rows(harness.batch_id, runtime=harness.runtime))
            stopped['writes'] = len(harness.writes)

    def upload(**_kwargs):
        boundary('input_upload')
        return SimpleNamespace(name='synthetic-provider-input')

    def create(**_kwargs):
        boundary('create')
        return SimpleNamespace(name='synthetic-provider-job', state=SimpleNamespace(name='JOB_STATE_PENDING'))

    def get(**_kwargs):
        boundary('poll')
        state = 'JOB_STATE_RUNNING' if stop_at == 'poll_wait' and calls.count('poll') == 1 else 'JOB_STATE_SUCCEEDED'
        return SimpleNamespace(name='synthetic-provider-job', state=SimpleNamespace(name=state),
                               dest=SimpleNamespace(file_name='synthetic-provider-result'))

    def sleep(seconds):
        harness.now += seconds
        boundary('poll_wait')

    def download(**_kwargs):
        boundary('download')
        return json.dumps({'key': 'row-1', 'response': {'text': 'Synthetic provider result.'}}).encode()

    harness.runtime.time.sleep = sleep
    harness.runtime.client = SimpleNamespace(
        files=SimpleNamespace(upload=upload, download=download),
        batches=SimpleNamespace(create=create, get=get),
    )
    harness.worker(harness.batch_id, runtime=harness.runtime)
    if stop_at is None:
        assert calls == ['input_upload', 'create', 'poll', 'download']
        assert harness.stored_batch()['status'] == 'complete'
        assert len(harness.persisted) == 1
        assert harness.persisted[0]['result'] == 'Synthetic provider result.'
    else:
        assert calls[-1] == stop_at
        assert calls.count(stop_at) == 1
        assert harness.stored_batch() == stopped['batch']
        assert batch._list_rows(harness.batch_id, runtime=harness.runtime) == stopped['rows']
        assert len(harness.writes) == stopped['writes']
        assert harness.persisted == []
        assert harness.job_logs == []
    assert harness.refunds == []
    assert list(tmp_path.iterdir()) == []
