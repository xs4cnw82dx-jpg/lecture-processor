"""Persisted audio cleanup with real files and isolated pipeline/storage adapters."""

from copy import deepcopy
from datetime import timezone
import json
import logging
from pathlib import Path
from types import SimpleNamespace
import uuid

import pytest

from lecture_processor.domains.ai import pipelines
from lecture_processor.domains.ai import batch_orchestrator as batch
from lecture_processor.domains.ai import instant_batch_orchestrator as instant
from lecture_processor.domains.study import audio as study_audio
from lecture_processor.repositories import study_repo


class MemorySnapshot:
    def __init__(self, reference, payload):
        self.reference = reference
        self.id = reference.id
        self.exists = payload is not None
        self.payload = deepcopy(payload)

    def to_dict(self):
        return deepcopy(self.payload)


class MemoryReference:
    def __init__(self, database, collection, doc_id):
        self.database = database
        self.collection = collection
        self.id = doc_id

    def get(self, **_kwargs):
        self.database.before_read()
        return MemorySnapshot(self, self.database.documents.get((self.collection, self.id)))

    def set(self, payload, merge=False):
        self.database.before_write(self.collection)
        key = (self.collection, self.id)
        previous = self.database.documents.get(key, {}) if merge else {}
        self.database.documents[key] = {**previous, **deepcopy(payload)}
        self.database.after_write(self.collection)

    def update(self, payload):
        self.set(payload, merge=True)


class MemoryQuery:
    def __init__(self, database, collection, filters=(), maximum=None):
        self.database = database
        self.collection = collection
        self.filters = filters
        self.maximum = maximum

    def document(self, doc_id=None):
        return MemoryReference(self.database, self.collection, doc_id or str(uuid.uuid4()))

    def where(self, field=None, operator=None, value=None, *, filter=None):
        if filter is not None:
            field, operator, value = filter.field_path, filter.op_string, filter.value
        assert operator == '==', f'Unexpected synthetic query: {operator}'
        return MemoryQuery(self.database, self.collection, (*self.filters, (field, value)), self.maximum)

    def limit(self, maximum):
        return MemoryQuery(self.database, self.collection, self.filters, maximum)

    def select(self, _fields):
        return self

    def stream(self):
        self.database.before_read()
        matches = [MemorySnapshot(self.document(doc_id), payload)
                   for (collection, doc_id), payload in self.database.documents.items()
                   if collection == self.collection and all(payload.get(field) == value for field, value in self.filters)]
        return iter(matches[:self.maximum] if self.maximum is not None else matches)


class MemoryDatabase:
    def __init__(self):
        self.documents = {}
        self.before_read = lambda: None
        self.before_write = lambda _collection: None
        self.after_write = lambda _collection: None

    def collection(self, name):
        return MemoryQuery(self, name)

    def packs(self):
        return [payload for (collection, _doc_id), payload in self.documents.items() if collection == 'study_packs']


class AudioPipeline:
    def __init__(self, monkeypatch, tmp_path, mode, failure='provider'):
        self.mode = mode
        self.failure = failure
        self.job_id = f'synthetic-{uuid.uuid4()}'
        self.database = MemoryDatabase()
        self.audio = tmp_path / 'upload.mp3'
        self.audio.write_bytes(b'Synthetic audio bytes; no external decoder is used.')
        self.pdf = tmp_path / 'slides.pdf'
        self.pdf.write_bytes(b'%PDF-1.4 synthetic test input')
        self.persisted = tmp_path / 'study_audio' / f'{self.job_id}.mp3'
        self.refunds = []
        self.logs = []
        self.provider_saw_persisted_audio = False
        self.job = {
            'mode': mode, 'status': 'queued', 'user_id': 'synthetic-user',
            'study_features': 'none', 'credit_deducted': 'lecture_credits_standard',
        }
        self.runtime = SimpleNamespace(
            db=self.database, study_repo=study_repo, uuid=uuid,
            logger=logging.getLogger('synthetic-audio-cleanup'),
            time=SimpleNamespace(time=lambda: 1773000000.0),
            STUDY_AUDIO_ROOT=str(tmp_path / 'study_audio'), UPLOAD_FOLDER=str(tmp_path),
            FEATURE_AUDIO_SECTION_SYNC=False,
            PROCESSING_PUBLIC_ERROR_MESSAGE='Synthetic processing failed.',
            MODEL_SLIDES='synthetic-slides', MODEL_AUDIO='synthetic-audio',
            MODEL_INTEGRATION='synthetic-merge', MODEL_INTERVIEW='synthetic-interview',
            PROMPT_SLIDE_EXTRACTION='Extract synthetic slides.',
            PROMPT_MERGE_TEMPLATE='{slide_text}\n{transcript}\n{output_language}',
            PROMPT_INTERVIEW_TRANSCRIPTION='Transcribe in {output_language}.',
            PROMPT_VOICE_NOTE_TRANSCRIPTION='Transcribe in {output_language}. {custom_instruction}',
            PROMPT_AUDIO_TRANSCRIPTION='Transcribe in {output_language}.',
            types=SimpleNamespace(Content=lambda **fields: fields, Part=SimpleNamespace(
                from_uri=lambda **fields: fields, from_text=lambda **fields: fields)),
            client=SimpleNamespace(files=SimpleNamespace(upload=self.upload)),
            convert_audio_to_mp3_with_ytdlp=lambda path: (path, False),
            get_mime_type=lambda _path: 'audio/mpeg',
            extract_json_payload=json.loads,
            wait_for_file_processing=lambda _file: None,
            transcribe_audio_plain=lambda *_args, **_kwargs: ('Synthetic transcript.', {}),
            cleanup_files=self.cleanup_uploads,
            save_job_log=lambda *args: self.logs.append(deepcopy(args)),
            users_repo=SimpleNamespace(set_doc=lambda *_args, **_kwargs: None),
        )
        monkeypatch.setattr(pipelines.runtime_jobs_store, 'update_job_fields', self.update_job)
        monkeypatch.setattr(pipelines.runtime_jobs_store, 'get_job_snapshot', lambda *_args, **_kwargs: deepcopy(self.job))
        monkeypatch.setattr(pipelines.runtime_jobs_store, 'set_job', self.set_job)
        monkeypatch.setattr(pipelines.ai_provider, 'run_with_provider_retry', lambda _stage, callback, **_kwargs: callback())
        monkeypatch.setattr(pipelines.ai_provider, 'generate_with_policy', self.generate)
        monkeypatch.setattr(pipelines.job_charges.ledger, 'refund_legacy_credits', self.refund)
        monkeypatch.setattr(pipelines.account_lifecycle, 'ensure_account_allows_writes', lambda *_args, **_kwargs: (True, ''))
        monkeypatch.setattr(pipelines.study_progress, 'resolve_user_timezone', lambda *_args, **_kwargs: (timezone.utc, 'UTC'))

    def update_job(self, _job_id, runtime=None, **fields):
        self.job.update(deepcopy(fields))

    def set_job(self, _job_id, payload, runtime=None):
        self.job = deepcopy(payload)

    def refund(self, _uid, _credit_type, _target, refund_ref, **_kwargs):
        self.refunds.append(refund_ref)
        return True

    def upload(self, **_kwargs):
        if self.failure == 'provider' and self.mode != 'lecture-notes':
            self.provider_saw_persisted_audio = self.persisted.is_file()
            raise RuntimeError('Synthetic upload failure after persistence')
        return SimpleNamespace(uri='fake://synthetic-audio')

    def generate(self, _model, _contents, *, operation_name, **_kwargs):
        if self.failure == 'provider' and operation_name == 'notes_merge':
            self.provider_saw_persisted_audio = self.persisted.is_file()
            raise RuntimeError('Synthetic notes merge failure after persistence')
        text = json.dumps({'title': 'Synthetic note', 'transcript': 'Synthetic transcript.', 'tags': []}) if operation_name == 'voice_note_transcription' else 'Synthetic generated content.'
        return SimpleNamespace(text=text)

    @staticmethod
    def cleanup_uploads(paths, _provider_files):
        for path in paths:
            if path:
                Path(path).unlink(missing_ok=True)

    def run(self):
        if self.mode == 'lecture-notes':
            pipelines.process_lecture_notes(self.job_id, str(self.pdf), str(self.audio), runtime=self.runtime)
        elif self.mode == 'interview':
            pipelines.process_interview_transcription(self.job_id, str(self.audio), runtime=self.runtime)
        else:
            pipelines.process_voice_note(self.job_id, str(self.audio), runtime=self.runtime)


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
