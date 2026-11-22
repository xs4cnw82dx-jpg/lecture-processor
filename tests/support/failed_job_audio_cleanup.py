import json
import logging
import uuid
from copy import deepcopy
from datetime import timezone
from pathlib import Path
from types import SimpleNamespace

from lecture_processor.domains.ai import pipelines
from lecture_processor.domains.ai.providers import factory
from lecture_processor.domains.ai.providers.contracts import GenerationResult, Usage
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


class _HarnessSession:
    """Workflow session double that routes worker calls to the harness's synthetic outcomes."""

    def __init__(self, harness):
        self.harness = harness

    def upload_file(self, _stage, part, **_kwargs):
        self.harness.upload(file=str(part.path), config={'mime_type': getattr(part, 'mime_type', 'application/pdf')})

    def wait_for_file(self, *_args, **_kwargs):
        return None

    def generate(self, stage, parts, *, operation_name=None, **_kwargs):
        response = self.harness.generate(None, parts, operation_name=operation_name)
        return GenerationResult(text=response.text, parsed=None, usage=Usage(), provider='gemini',
                                model=f'synthetic-{stage}')

    def close(self):
        return None


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
        monkeypatch.setattr(factory, 'open_provider_session', lambda _runtime, **_kwargs: _HarnessSession(self))
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
