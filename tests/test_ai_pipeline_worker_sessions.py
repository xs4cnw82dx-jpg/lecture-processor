"""Regular processing workers own one provider session and route each step to its stage."""
import json
import socket
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import pipelines, study_generation
from lecture_processor.domains.ai.providers import factory
from lecture_processor.domains.ai.providers.contracts import (
    AudioPart,
    GenerationResult,
    PdfPart,
    TextPart,
    Usage,
)
from lecture_processor.domains.billing import receipts
from lecture_processor.runtime import core
from tests.support.failed_job_audio_cleanup import AudioPipeline

MODES = ('lecture-notes', 'slides-only', 'interview', 'voice-note')
DIRECT_STAGES = {
    'lecture-notes': ('slides_extraction', 'audio_transcription', 'notes_merge'),
    'slides-only': ('slides_extraction',),
    'interview': ('interview_transcription',),
    'voice-note': ('voice_note_transcription',),
}
OPERATIONS = {
    'slides_extraction': 'slide_extraction', 'audio_transcription': 'audio_transcription',
    'notes_merge': 'notes_merge', 'interview_transcription': 'interview_transcription',
    'voice_note_transcription': 'voice_note_transcription', 'study_tools': 'study_materials_generation',
    'interview_summary': 'interview_summary_generation', 'interview_sections': 'interview_sections_generation',
}


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*_args, **_kwargs):
        pytest.fail('Pipeline stage candidates forbid network and DNS')
    for name in ('getaddrinfo', 'gethostbyname', 'gethostbyname_ex', 'create_connection'):
        monkeypatch.setattr(socket, name, blocked)
    monkeypatch.setattr(socket.socket, 'connect', blocked)
    monkeypatch.setattr(socket.socket, 'connect_ex', blocked)


def response_text(operation):
    return {
        'slide_extraction': '  Synthetic slide text.\n',
        'audio_transcription': '  Synthetic transcript.\n',
        'audio_transcription_timestamped': 'Synthetic malformed timestamp response.',
        'audio_transcription_fallback': 'Synthetic fallback transcript.',
        'notes_merge': '# Synthetic notes\nSynthetic merged notes.\n',
        'interview_transcription': 'Speaker A-00:01 Synthetic interview.\n',
        'voice_note_transcription': json.dumps({'title': 'Synthetic title', 'transcript': 'Synthetic voice.', 'tags': ['science']}),
        'study_materials_generation': json.dumps({'flashcards': [{'front': 'Synthetic question?', 'back': 'Synthetic answer.'}],
            'test_questions': [{'question': 'Synthetic choice?', 'options': ['A', 'B', 'C', 'D'],
                                'answer': 'A', 'explanation': 'Synthetic reason.'}]}),
        'interview_summary_generation': 'Synthetic summary.',
        'interview_sections_generation': '# Synthetic section\nSpeaker A-00:01 Synthetic interview.',
    }[operation]


class SessionSpy:
    """Explicit per-workflow outcomes; records neutral calls, never native handles."""
    def __init__(self, harness):
        self.harness = harness
        self.calls, self.owned, self.close_observations = [], [], []
        self.closed = False

    def _call(self, phase, stage, part=None, *, operation_name, retry_tracker):
        assert not self.closed, 'A borrowed helper closed its owner session'
        assert stage in self.harness.runtime.AI_ROUTING_SNAPSHOT.routes
        self.calls.append(dict(phase=phase, stage=stage, part=part, operation=operation_name, tracker=retry_tracker))
        self.harness.events.append([phase, stage, operation_name])
        if self.harness.failure == (phase, operation_name):
            raise RuntimeError('Synthetic terminal provider failure')

    def upload_file(self, stage, part, *, operation_name, retry_tracker=None):
        assert isinstance(part, (PdfPart, AudioPart))
        assert Path(part.path).is_file()
        self._call('upload', stage, part, operation_name=operation_name, retry_tracker=retry_tracker)
        self.owned.append(part)

    def wait_for_file(self, stage, part, *, operation_name, retry_tracker=None):
        assert any(owned is part for owned in self.owned)
        self._call('wait', stage, part, operation_name=operation_name, retry_tracker=retry_tracker)

    def generate(self, stage, parts, *, schema=None, max_output_tokens=65536,
                 retry_tracker=None, operation_name=None):
        parts = tuple(parts)
        assert parts and all(isinstance(part, (TextPart, PdfPart, AudioPart)) for part in parts)
        for part in parts:
            if isinstance(part, (PdfPart, AudioPart)):
                assert any(owned is part for owned in self.owned), 'Caller skipped explicit file preparation'
        self._call('generate', stage, operation_name=operation_name, retry_tracker=retry_tracker)
        self.calls[-1].update(parts=parts, cap=max_output_tokens, schema=schema)
        return GenerationResult(
            text=response_text(operation_name), parsed=None,
            usage=Usage(input_tokens=7, output_tokens=5, thinking_tokens=2, total_tokens=19),
            provider='gemini', model='gemini-selected-' + stage.replace('_', '-'), raw_response=None,
        )

    def close(self):
        self.close_observations.append({str(path): Path(path).exists() for path in self.harness.local_inputs})
        self.harness.events.append(['close'])
        self.closed = True

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


class PipelineStages(AudioPipeline):
    def __init__(self, monkeypatch, tmp_path, mode, *, failure=None, features=False, timestamped=False):
        self.events, self.native_calls, self.sessions, self.borrowed = [], [], [], []
        self.session_attempts = 0
        self.cleanup_remote_lists = []
        super().__init__(monkeypatch, tmp_path, mode, failure=None)
        self.failure = failure
        self.local_inputs = [self.pdf] if mode == 'slides-only' else ([self.pdf, self.audio] if mode == 'lecture-notes' else [self.audio])
        # Unused inputs are fixture scaffolding, not owned by this worker.
        for path in (self.pdf, self.audio):
            if path not in self.local_inputs:
                path.unlink()
        constants = {name: deepcopy(value) for name, value in vars(core).items()
                     if name.startswith(('MODEL_', 'PROMPT_')) and not callable(value)}
        self.runtime.__dict__.update(constants)
        self.runtime.AI_ROUTING_SNAPSHOT = core.AI_ROUTING_SNAPSHOT
        self.runtime.FEATURE_AUDIO_SECTION_SYNC = timestamped
        self.runtime.wait_for_file_processing = lambda handle: self.native_calls.append(('wait', handle))
        self.runtime.transcribe_audio_plain = self.plain_audio
        self.runtime.transcribe_audio_with_timestamps = self.timestamp_audio
        self.runtime.extract_json_payload = core.extract_json_payload
        self.runtime.cleanup_files = self.cleanup_uploads
        self.runtime.save_job_log = self.log_job
        self.runtime.time.sleep = lambda _seconds: pytest.fail('No retry sleep expected in stage candidates')
        credit = {'slides-only': 'slides_credits', 'lecture-notes': 'lecture_credits_standard',
                  'interview': 'interview_credits_short', 'voice-note': 'interview_credits_short'}[mode]
        self.job.update(output_language='Dutch', credit_deducted=credit, interview_features=[],
                        flashcard_selection='10', question_selection='5')
        charge = {credit: 1}
        if features and mode in {'lecture-notes', 'slides-only'}:
            self.job['study_features'] = 'both'
        elif features and mode == 'interview':
            self.job.update(interview_features=['summary', 'sections'], interview_features_cost=2)
            charge['slides_credits'] = 2
        self.job['billing_receipt'] = receipts.initialize_billing_receipt(charge, runtime=self.runtime)
        monkeypatch.setattr(core, '_self_runtime', lambda: self.runtime)
        monkeypatch.setattr(factory, 'open_provider_session', self.open_session)
        real_study = study_generation.generate_study_materials
        real_extras = study_generation.generate_interview_enhancements

        def study(*args, **kwargs):
            self.borrowed.append(('study', kwargs.get('provider_session')))
            return real_study(*args, **kwargs)

        def extras(*args, **kwargs):
            self.borrowed.append(('extras', kwargs.get('provider_session')))
            return real_extras(*args, **kwargs)

        monkeypatch.setattr(study_generation, 'generate_study_materials', study)
        monkeypatch.setattr(study_generation, 'generate_interview_enhancements', extras)
        real_begin = pipelines.job_charges.begin_runtime_job

        def begin(job_id, *, runtime):
            accepted = real_begin(job_id, runtime=runtime)
            self.events.append(['admission', accepted])
            return accepted

        monkeypatch.setattr(pipelines.job_charges, 'begin_runtime_job', begin)

    def open_session(self, runtime, **_kwargs):
        assert runtime is self.runtime
        assert self.events[0] == ['admission', True]
        self.session_attempts += 1
        self.events.append(['open'])
        if self.failure == ('open', ''):
            raise RuntimeError('Synthetic session initialization failure')
        session = SessionSpy(self)
        self.sessions.append(session)
        return session

    def upload(self, **kwargs):
        self.native_calls.append(('upload', kwargs))
        return SimpleNamespace(name='files/native-synthetic', uri='fake://native-synthetic')

    def generate(self, _model, _contents, *, operation_name, **_kwargs):
        self.native_calls.append(('generate', operation_name))
        return SimpleNamespace(text=response_text(operation_name), usage_metadata=SimpleNamespace(
            prompt_token_count=7, candidates_token_count=3, thoughts_token_count=2, total_token_count=19))

    def plain_audio(self, *args, **kwargs):
        self.borrowed.append(('audio', kwargs.get('provider_session')))
        return core.transcribe_audio_plain(*args, **kwargs)

    def timestamp_audio(self, *args, **kwargs):
        self.borrowed.append(('timestamp_audio', kwargs.get('provider_session')))
        return core.transcribe_audio_with_timestamps(*args, **kwargs)

    def cleanup_uploads(self, paths, provider_files):
        self.cleanup_remote_lists.append(list(provider_files))
        for path in paths:
            if path:
                self.events.append(['local_cleanup', str(path)])
                Path(path).unlink(missing_ok=True)

    def log_job(self, *args):
        self.events.append(['log'])
        self.logs.append(deepcopy(args))

    def run(self):
        if self.mode == 'slides-only':
            pipelines.process_slides_only(self.job_id, str(self.pdf), runtime=self.runtime)
        else:
            super().run()


def assert_owned_lifecycle(harness):
    assert harness.session_attempts == 1, 'The admitted worker did not open exactly one provider session'
    assert len(harness.sessions) == 1
    session = harness.sessions[0]
    assert len(session.close_observations) == 1
    assert not any(session.close_observations[0].values()), 'Session closed before local cleanup'
    assert harness.cleanup_remote_lists and not any(harness.cleanup_remote_lists)
    assert harness.native_calls == [], 'Migrated workers must not bypass the session via native provider methods'
    assert harness.events[-1] == ['log']
    assert harness.events.index(['close']) < len(harness.events) - 1
    assert len(harness.logs) == 1
    return session


@pytest.mark.parametrize('mode', MODES)
def test_admitted_worker_owns_session_routes_parts_and_records_result_model(monkeypatch, tmp_path, mode):
    harness = PipelineStages(monkeypatch, tmp_path, mode)
    harness.run()
    session = assert_owned_lifecycle(harness)
    assert harness.job['status'] == 'complete'
    assert len(harness.database.packs()) == 1 and harness.refunds == []
    generated = [call for call in session.calls if call['phase'] == 'generate']
    assert [call['stage'] for call in generated] == list(DIRECT_STAGES[mode])
    assert all(call['operation'] == OPERATIONS[call['stage']] for call in generated)
    assert all(call['cap'] == 65536 and call['schema'] is None for call in generated)
    assert all(call['tracker'] is generated[0]['tracker'] for call in session.calls)
    assert generated[0]['tracker'] is not None
    assert len(session.owned) == (2 if mode == 'lecture-notes' else 1)
    for part in session.owned:
        uploads = [call for call in session.calls if call['phase'] == 'upload' and call['part'] is part]
        waits = [call for call in session.calls if call['phase'] == 'wait' and call['part'] is part]
        assert len(uploads) == len(waits) == 1
        assert uploads[0]['stage'] == waits[0]['stage']
        prefix = 'slide' if isinstance(part, PdfPart) else ('voice_note_audio' if mode == 'voice-note' else 'audio')
        assert uploads[0]['operation'] == prefix + '_upload'
        assert waits[0]['operation'] == prefix + '_file_processing'
        file_calls = [call for call in generated if any(item is part for item in call['parts'])]
        assert file_calls and uploads[0]['stage'] == file_calls[0]['stage']
        assert file_calls[0]['parts'][0] is part
        assert isinstance(file_calls[0]['parts'][1], TextPart)
    for call in generated:
        key = {'slides_extraction': 'slide_extraction', 'notes_merge': 'merge'}.get(call['stage'], call['stage'])
        usage = harness.job['token_usage_by_stage'][key]
        assert (usage['input_tokens'], usage['output_tokens'], usage['total_tokens']) == (7, 5, 19)
        assert usage['model'] == 'gemini-selected-' + call['stage'].replace('_', '-')
    if mode == 'voice-note':
        assert len(generated) == 1 and harness.job['study_pack_title'] == 'Synthetic title'
        assert harness.job['voice_note_tags'] == ['science']


@pytest.mark.parametrize('mode', ('lecture-notes', 'slides-only', 'interview'))
def test_optional_text_helpers_borrow_worker_session(monkeypatch, tmp_path, mode):
    harness = PipelineStages(monkeypatch, tmp_path, mode, features=True)
    harness.run()
    session = assert_owned_lifecycle(harness)
    assert harness.job['status'] == 'complete'
    assert harness.borrowed and all(value is session for _name, value in harness.borrowed)
    extra = [('interview_summary', 8192), ('interview_sections', 32768)] if mode == 'interview' else [('study_tools', 32768)]
    calls = [call for call in session.calls if call['phase'] == 'generate']
    assert [call['stage'] for call in calls] == list(DIRECT_STAGES[mode]) + [stage for stage, _cap in extra]
    for stage, cap in extra:
        call = next(call for call in calls if call['stage'] == stage)
        assert call['cap'] == cap and call['operation'] == OPERATIONS[stage]
        usage = harness.job['token_usage_by_stage'][OPERATIONS[stage]]
        assert usage['model'] == 'gemini-selected-' + stage.replace('_', '-')
        assert (usage['output_tokens'], usage['total_tokens']) == (5, 19)


def test_timestamp_fallback_reuses_prepared_audio_and_owner_session(monkeypatch, tmp_path):
    harness = PipelineStages(monkeypatch, tmp_path, 'lecture-notes', timestamped=True)
    harness.run()
    session = assert_owned_lifecycle(harness)
    assert harness.job['status'] == 'complete'
    calls = [call for call in session.calls if call['phase'] == 'generate']
    assert [call['stage'] for call in calls] == [
        'slides_extraction', 'audio_transcription_timestamped', 'audio_transcription', 'notes_merge']
    primary, fallback = calls[1:3]
    assert primary['operation'] == 'audio_transcription_timestamped'
    assert fallback['operation'] == 'audio_transcription_fallback'
    assert primary['parts'][0] is fallback['parts'][0]
    audio = primary['parts'][0]
    assert isinstance(audio, AudioPart)
    uploads = [call for call in session.calls if call['phase'] == 'upload' and call['part'] is audio]
    assert len(uploads) == 1 and uploads[0]['stage'] == 'audio_transcription_timestamped'
    assert all(value is session for _name, value in harness.borrowed)
    entries = harness.job['token_usage_by_stage']
    for key, model in [('audio_transcription', 'gemini-selected-audio-transcription-timestamped'),
                       ('audio_transcription_fallback', 'gemini-selected-audio-transcription')]:
        usage = entries[key]
        assert usage['model'] == model
        assert (usage['input_tokens'], usage['output_tokens'], usage['total_tokens']) == (7, 5, 19)
    assert harness.job['token_total'] == 19 * len(calls)


def test_failed_fallback_retains_reported_usage_for_the_invalid_timestamp_response(monkeypatch, tmp_path):
    harness = PipelineStages(monkeypatch, tmp_path, 'lecture-notes', timestamped=True,
                             failure=('generate', 'audio_transcription_fallback'))
    harness.run()
    assert harness.job['status'] == 'error'
    usage = harness.job['token_usage_by_stage']
    assert usage['audio_transcription']['model'] == 'gemini-selected-audio-transcription-timestamped'
    assert 'audio_transcription_fallback' not in usage
    assert harness.job['token_total'] == 38  # One slides response plus the timestamp response.


@pytest.mark.parametrize('mode,phase,operation,failed_stage', [
    ('slides-only', 'upload', 'slide_upload', 'slide_upload'),
    ('slides-only', 'wait', 'slide_file_processing', 'slide_file_processing'),
    ('slides-only', 'generate', 'slide_extraction', 'slide_extraction'),
    ('lecture-notes', 'upload', 'audio_upload', 'audio_upload'),
    ('lecture-notes', 'wait', 'audio_file_processing', 'audio_file_processing'),
    ('interview', 'generate', 'interview_transcription', 'interview_transcription'),
    ('voice-note', 'wait', 'voice_note_audio_file_processing', 'audio_file_processing'),
])
def test_provider_failure_preserves_phase_refund_and_cleanup(monkeypatch, tmp_path, mode, phase, operation, failed_stage):
    harness = PipelineStages(monkeypatch, tmp_path, mode, failure=(phase, operation))
    harness.run()
    session = assert_owned_lifecycle(harness)
    assert harness.job['status'] == 'error' and harness.job['failed_stage'] == failed_stage
    assert harness.database.packs() == [] and len(harness.refunds) == 1
    assert harness.job['credit_refunded'] is True
    assert session.calls[-1]['phase'] == phase and session.calls[-1]['operation'] == operation
    assert len([call for call in session.calls if call['phase'] == phase and call['operation'] == operation]) == 1
    assert not harness.persisted.exists()


def test_publication_failure_keeps_existing_refund_boundary_and_closes_session(monkeypatch, tmp_path):
    harness = PipelineStages(monkeypatch, tmp_path, 'slides-only')

    def fail_publish(collection):
        if collection == 'study_packs':
            raise RuntimeError('Synthetic publication failure')

    harness.database.before_write = fail_publish
    harness.run()
    assert_owned_lifecycle(harness)
    assert harness.job['status'] == 'error' and harness.job['failed_stage'] == 'study_pack_persistence'
    assert harness.database.packs() == [] and len(harness.refunds) == 1


def test_session_initialization_failure_still_cleans_local_files_and_logs(monkeypatch, tmp_path):
    harness = PipelineStages(monkeypatch, tmp_path, 'slides-only', failure=('open', ''))
    harness.run()
    assert harness.session_attempts == 1 and harness.sessions == []
    assert harness.job['status'] == 'error' and harness.job['failed_stage'] == 'initialization'
    assert harness.native_calls == [] and not harness.pdf.exists()
    assert len(harness.refunds) == len(harness.logs) == 1


@pytest.mark.parametrize('mode', MODES)
def test_denied_job_does_not_open_session_or_use_provider(monkeypatch, tmp_path, mode):
    harness = PipelineStages(monkeypatch, tmp_path, mode)
    monkeypatch.setattr(pipelines.job_charges, 'begin_runtime_job', lambda *_args, **_kwargs: False)
    harness.run()
    assert harness.sessions == [] and harness.session_attempts == 0
    assert harness.native_calls == [] and harness.refunds == [] and harness.database.packs() == []
    assert not any(path.exists() for path in harness.local_inputs)
    assert len(harness.logs) == 1
