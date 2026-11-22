"""Persisted audio cleanup with real files and isolated pipeline/storage adapters."""

import uuid
from copy import deepcopy

import pytest

from lecture_processor.domains.ai import batch_orchestrator as batch
from lecture_processor.domains.ai import instant_batch_orchestrator as instant
from lecture_processor.domains.study import audio as study_audio
from tests.support.failed_job_audio_cleanup import AudioPipeline


@pytest.mark.parametrize('mode', ['lecture-notes', 'interview', 'voice-note'])
def test_failed_pipeline_removes_unreferenced_persisted_audio(monkeypatch, tmp_path, mode):
    harness = AudioPipeline(monkeypatch, tmp_path, mode)
    harness.run()

    assert harness.provider_saw_persisted_audio, 'The failure must occur after the real audio copy exists'
    assert harness.job['status'] == 'error'
    assert harness.job['credit_refunded'] is True
    assert harness.refunds == [f'runtime-job:{harness.job_id}:primary']
    assert harness.database.packs() == []
    assert not harness.audio.exists(), 'Transient upload cleanup still runs'
    assert not harness.persisted.exists(), 'Failed jobs must not leak the persisted study-audio copy'


@pytest.mark.parametrize('mode', ['lecture-notes', 'interview', 'voice-note'])
def test_successful_pipeline_keeps_audio_referenced_by_saved_pack(monkeypatch, tmp_path, mode):
    harness = AudioPipeline(monkeypatch, tmp_path, mode, failure=None)
    original = harness.audio.read_bytes()
    harness.run()

    assert harness.job['status'] == 'complete'
    assert harness.refunds == []
    assert harness.persisted.read_bytes() == original
    assert len(harness.database.packs()) == 1
    assert harness.database.packs()[0]['audio_storage_key'] == f'study_audio/{harness.job_id}.mp3'


def fail_write(harness, phase):
    def before(collection):
        if collection == ('study_packs' if phase == 'pack_write' else 'study_pack_sources'):
            raise RuntimeError(f'Synthetic {phase} failure')

    def after(collection):
        if collection == 'study_packs':
            raise RuntimeError('Synthetic lost acknowledgement after pack commit')

    if phase == 'lost_ack':
        harness.database.after_write = after
    else:
        harness.database.before_write = before


@pytest.mark.parametrize('mode', ['lecture-notes', 'interview', 'voice-note'])
@pytest.mark.parametrize('phase', ['pack_write', 'source_write', 'lost_ack'])
def test_pipeline_save_failure_preserves_audio_only_when_pack_committed(monkeypatch, tmp_path, mode, phase):
    harness = AudioPipeline(monkeypatch, tmp_path, mode, failure=None)
    fail_write(harness, phase)
    harness.run()

    committed = phase != 'pack_write'
    assert harness.job['status'] == 'error'
    assert harness.job['failed_stage'] == 'study_pack_persistence'
    assert len(harness.database.packs()) == int(committed)
    assert harness.persisted.exists() is committed
    if committed:
        assert harness.database.packs()[0]['source_job_id'] == harness.job_id
        assert harness.database.packs()[0]['audio_storage_key'] == f'study_audio/{harness.job_id}.mp3'
        assert not harness.job.get('study_pack_id'), 'Simulate a commit before runtime metadata was updated'


class AudioBatch(AudioPipeline):
    def __init__(self, monkeypatch, tmp_path, strategy, failure='provider'):
        super().__init__(monkeypatch, tmp_path, 'audio-transcription', failure=None)
        self.batch_id = f'synthetic-batch-{uuid.uuid4()}'
        self.batch = {
            'batch_id': self.batch_id, 'uid': 'synthetic-user', 'mode': 'audio-transcription',
            'status': 'queued', 'batch_title': 'Synthetic batch', 'total_rows': 1,
            'created_at': self.runtime.time.time(), 'completion_email_status': 'skipped',
        }
        self.row = {
            'batch_id': self.batch_id, 'row_id': 'row-1', 'row_job_id': self.job_id,
            'ordinal': 1, 'status': 'queued', 'audio_local_path': str(self.audio),
            'source_type': 'file', 'study_features': 'none',
            'credit_deducted': 'interview_credits_short',
        }
        self.runtime.BATCH_JOB_RECOVERY_STALE_SECONDS = 120
        self.runtime.INSTANT_BATCH_MAX_PARALLEL_ROWS = 1
        self.runtime.INSTANT_BATCH_API_STAGGER_SECONDS = 0
        self.worker = batch.process_batch_job if strategy == 'deferred' else instant.process_instant_batch_job
        monkeypatch.setattr(batch, '_get_batch', lambda *_args, **_kwargs: deepcopy(self.batch))
        monkeypatch.setattr(batch, '_list_rows', lambda *_args, **_kwargs: [deepcopy(self.row)])
        monkeypatch.setattr(batch, '_get_row', lambda *_args, **_kwargs: deepcopy(self.row))
        monkeypatch.setattr(batch, '_upsert_batch', self.upsert_batch)
        monkeypatch.setattr(batch, '_upsert_row', self.upsert_row)
        monkeypatch.setattr(batch, 'send_batch_completion_email', lambda *_args, **_kwargs: ('skipped', 'Synthetic test'))

        def provider():
            self.provider_saw_persisted_audio = self.persisted.is_file()
            if failure == 'provider':
                raise RuntimeError('Synthetic provider failure after audio persistence')

        def deferred_provider(_batch_id, _stage, requests, **_kwargs):
            provider()
            return [{'response': {'text': 'Synthetic transcript.'}} for _ in requests]

        def instant_provider(*_args, **_kwargs):
            provider()
            return 'Synthetic transcript.', {}

        monkeypatch.setattr(batch, '_run_batch_stage', deferred_provider)
        self.runtime.transcribe_audio_plain = instant_provider
        if failure in {'pack_write', 'source_write', 'lost_ack'}:
            fail_write(self, failure)
        if failure == 'external_stop':
            upload = batch._upload_row_files

            def stop_after_upload(row, runtime=None):
                upload(row, runtime=runtime)
                assert self.persisted.is_file()
                self.batch.update(status='error', error='Synthetic external stop', provider_state='EXTERNAL_STOP')

            monkeypatch.setattr(batch, '_upload_row_files', stop_after_upload)

    def upsert_batch(self, _batch_id, payload, runtime=None, merge=True):
        self.batch = {**(self.batch if merge else {}), **deepcopy(payload)}

    def upsert_row(self, _batch_id, _row_id, payload, runtime=None, merge=True):
        self.row = {**(self.row if merge else {}), **deepcopy(payload)}

    def run(self):
        self.worker(self.batch_id, runtime=self.runtime)


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
@pytest.mark.parametrize('failure', ['provider', 'pack_write'])
def test_failed_batch_row_refunds_and_removes_persisted_audio(monkeypatch, tmp_path, strategy, failure):
    harness = AudioBatch(monkeypatch, tmp_path, strategy, failure)
    harness.run()

    assert harness.provider_saw_persisted_audio
    assert harness.row['status'] == 'error'
    assert harness.row['credit_refunded'] is True
    assert harness.refunds == [f'batch-row:{harness.batch_id}:row-1:primary']
    assert harness.database.packs() == []
    assert not harness.audio.exists()
    assert not harness.persisted.exists()


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
@pytest.mark.parametrize('failure', [None, 'source_write'])
def test_batch_pack_commit_keeps_audio_even_if_later_source_write_fails(monkeypatch, tmp_path, strategy, failure):
    harness = AudioBatch(monkeypatch, tmp_path, strategy, failure)
    harness.run()

    assert harness.provider_saw_persisted_audio
    assert harness.row['status'] == ('error' if failure else 'complete')
    assert len(harness.database.packs()) == 1
    assert harness.database.packs()[0]['audio_storage_key'] == f'study_audio/{harness.job_id}.mp3'
    assert harness.persisted.is_file()


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_batch_external_stop_after_upload_removes_orphan_without_extra_refund(monkeypatch, tmp_path, strategy):
    harness = AudioBatch(monkeypatch, tmp_path, strategy, 'external_stop')
    harness.run()

    assert harness.batch['provider_state'] == 'EXTERNAL_STOP'
    assert harness.refunds == []
    assert harness.database.packs() == []
    assert not harness.audio.exists()
    assert not harness.persisted.exists()


def persisted_fixture(monkeypatch, tmp_path):
    harness = AudioPipeline(monkeypatch, tmp_path, 'voice-note', failure=None)
    key = study_audio.persist_audio_for_study_pack(harness.job_id, str(harness.audio), runtime=harness.runtime)
    assert harness.persisted.is_file()
    return harness, {'audio_storage_key': key, 'user_id': 'synthetic-user'}


def test_orphan_cleanup_can_be_retried_without_deleting_another_jobs_audio(monkeypatch, tmp_path):
    harness, job_data = persisted_fixture(monkeypatch, tmp_path)
    other = harness.persisted.with_name('another-job.mp3')
    other.write_bytes(b'Another job owns these bytes.')

    study_audio.cleanup_failed_job_audio(harness.job_id, job_data, runtime=harness.runtime)
    study_audio.cleanup_failed_job_audio(harness.job_id, job_data, runtime=harness.runtime)

    assert not harness.persisted.exists()
    assert other.read_bytes() == b'Another job owns these bytes.'


@pytest.mark.parametrize('reference', ['source_job', 'top_level_key', 'append_session_key', 'append_session_id', 'legacy_path'])
def test_audio_cleanup_keeps_saved_pack_and_voice_append_references(monkeypatch, tmp_path, reference):
    harness, job_data = persisted_fixture(monkeypatch, tmp_path)
    pack = {'uid': 'synthetic-user'}
    if reference == 'source_job':
        pack['source_job_id'] = harness.job_id
    elif reference == 'top_level_key':
        pack['audio_storage_key'] = job_data['audio_storage_key']
    elif reference == 'append_session_key':
        pack['audio_sessions'] = [{'audio_storage_key': job_data['audio_storage_key']}]
    elif reference == 'append_session_id':
        pack['audio_sessions'] = [{'session_id': harness.job_id}]
    else:
        pack['audio_storage_path'] = str(harness.persisted)
    harness.database.collection('study_packs').document('saved-target').set(pack)
    job_data['voice_note_append_to_pack_id'] = 'saved-target'

    study_audio.cleanup_failed_job_audio(harness.job_id, job_data, runtime=harness.runtime)

    assert harness.persisted.is_file()


@pytest.mark.parametrize('unavailable', ['database', 'lookup'])
def test_audio_cleanup_keeps_file_when_storage_cannot_prove_it_unreferenced(monkeypatch, tmp_path, unavailable):
    harness, job_data = persisted_fixture(monkeypatch, tmp_path)
    if unavailable == 'database':
        harness.runtime.db = None
    else:
        def fail_read():
            raise RuntimeError('Synthetic database lookup failed')
        harness.database.before_read = fail_read

    study_audio.cleanup_failed_job_audio(harness.job_id, job_data, runtime=harness.runtime)

    assert harness.persisted.is_file()


@pytest.mark.parametrize('key_kind', ['other_job', 'traversal', 'absolute', 'nested', 'legacy_only'])
def test_audio_cleanup_cannot_delete_outside_the_job_owned_key(monkeypatch, tmp_path, key_kind):
    harness, job_data = persisted_fixture(monkeypatch, tmp_path)
    outside = tmp_path / 'outside.mp3'
    outside.write_bytes(b'Unrelated audio must survive.')
    other = harness.persisted.with_name('another-job.mp3')
    other.write_bytes(b'Another job must survive.')
    nested = harness.persisted.parent / 'nested' / harness.persisted.name
    nested.parent.mkdir()
    nested.write_bytes(b'Nested paths are not generated by audio persistence.')
    job_data['audio_storage_key'] = {
        'other_job': 'study_audio/another-job.mp3',
        'traversal': 'study_audio/../../outside.mp3',
        'absolute': str(outside),
        'nested': f'study_audio/nested/{harness.job_id}.mp3',
        'legacy_only': '',
    }[key_kind]
    job_data['audio_storage_path'] = str(outside)

    study_audio.cleanup_failed_job_audio(harness.job_id, job_data, runtime=harness.runtime)

    assert harness.persisted.is_file()
    assert outside.read_bytes() == b'Unrelated audio must survive.'
    assert other.read_bytes() == b'Another job must survive.'
    assert nested.is_file()
