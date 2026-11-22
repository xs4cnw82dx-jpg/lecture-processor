import logging
import threading
import uuid
from contextlib import contextmanager
from copy import deepcopy
from types import SimpleNamespace

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
