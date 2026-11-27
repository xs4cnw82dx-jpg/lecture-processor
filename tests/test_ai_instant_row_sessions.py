"""Instant batch rows generate through one lazily opened session per row."""
import json
import socket
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import batch_orchestrator as batch
from lecture_processor.domains.ai import instant_batch_orchestrator as instant
from lecture_processor.domains.ai.providers import factory
from lecture_processor.domains.ai.providers.contracts import (
    GenerationResult, PdfPart, PreparedFilePart, TextPart, Usage,
)
from lecture_processor.domains.ai.providers.gemini import GeminiProvider
from lecture_processor.domains.ai.providers.routing import Route, RoutingSnapshot


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*_args, **_kwargs):
        pytest.fail('Instant row session tests forbid network and DNS')
    for name in ('getaddrinfo', 'gethostbyname', 'gethostbyname_ex', 'create_connection'):
        monkeypatch.setattr(socket, name, blocked)
    monkeypatch.setattr(socket.socket, 'connect', blocked)
    monkeypatch.setattr(socket.socket, 'connect_ex', blocked)


STUDY_JSON = json.dumps({'flashcards': [{'front': 'Q?', 'back': 'A.'}],
                         'test_questions': [{'question': 'C?', 'options': ['A', 'B', 'C', 'D'],
                                             'answer': 'A', 'explanation': 'R.'}]})


class Session:
    def __init__(self, events):
        self.events = events
        self.calls = []

    def generate(self, stage, parts, **options):
        self.calls.append((stage, tuple(parts), options))
        text = STUDY_JSON if stage == 'study_tools' else f'Synthetic {stage} output.'
        return GenerationResult(text, None, Usage(7, 5, 19, 2), 'gemini', f'routed-{stage}')

    def close(self):
        self.events.append('close')


@pytest.fixture
def row_env(core, monkeypatch):
    state = SimpleNamespace(events=[], sessions=[], upload_error=None, prepare=batch._upload_row_files,
                            cleanup=instant._cleanup_row_files)

    def open_session(runtime, **_kwargs):
        assert runtime is core
        state.events.append('open')
        session = Session(state.events)
        state.sessions.append(session)
        return session

    def upload(row, runtime=None, *, upload_slides=True):
        state.events.append('upload')
        if state.upload_error:
            raise state.upload_error
        row['slides_file_uri'] = 'fake://slides/1'
        row['audio_file_uri'] = 'fake://audio/1'
        row['audio_mime_type'] = 'audio/mpeg'

    monkeypatch.setattr(factory, 'open_provider_session', open_session)
    monkeypatch.setattr(batch, '_upload_row_files', upload)
    for name in ('_require_active_batch', '_heartbeat_batch', '_upsert_row'):
        monkeypatch.setattr(batch, name, lambda *_args, **_kwargs: None)
    monkeypatch.setattr(batch, '_batch_worker_may_continue', lambda *_args, **_kwargs: True)
    monkeypatch.setattr(batch, '_refund_failed_row', lambda *_args, **_kwargs: state.events.append('refund'))
    monkeypatch.setattr(instant, '_upsert_row_progress', lambda *_args, **_kwargs: None)
    def finalize(_batch_id, _batch, row, tokens, _retry_tracker, runtime=None):
        row.update(tokens.as_dict())
        state.events.append('finalize')

    monkeypatch.setattr(instant, '_finalize_row', finalize)
    monkeypatch.setattr(instant, '_refresh_batch_progress', lambda *_args, **_kwargs: None)
    monkeypatch.setattr(instant, '_cleanup_row_files', lambda *_args, **_kwargs: state.events.append('cleanup'))
    monkeypatch.setattr(core, 'FEATURE_AUDIO_SECTION_SYNC', False)
    state.throttler = SimpleNamespace(wait=lambda: None)
    return state


def run_row(core, state, mode, **row_fields):
    row = {'row_id': 'row-1', 'output_language': 'English', 'study_features': 'none', **row_fields}
    instant._process_row('synthetic-batch', {'mode': mode, 'created_at': 1.0}, row, state.throttler, runtime=core)
    return row


@pytest.mark.parametrize('mode,stages', [
    ('lecture-notes', ['slides_extraction', 'audio_transcription', 'notes_merge', 'study_tools']),
    ('slides-only', ['slides_extraction', 'study_tools']),
    ('audio-transcription', ['audio_transcription']),
    ('interview', ['interview_transcription', 'interview_summary']),
    ('text-combine', ['text_combine']),
])
def test_each_row_uses_one_session_and_named_stages(core, row_env, mode, stages):
    fields = {'study_features': 'both'} if mode in {'lecture-notes', 'slides-only'} else {}
    if mode == 'interview':
        fields['interview_features'] = ['summary']
    if mode == 'text-combine':
        fields.update(slide_text='Synthetic slides.', transcript='Synthetic transcript.')
    row = run_row(core, row_env, mode, **fields)
    assert row.get('status') != 'error'
    assert len(row_env.sessions) == 1
    session = row_env.sessions[0]
    assert [call[0] for call in session.calls] == stages
    # One close, after the row's own file cleanup (which still owns batch uploads).
    assert row_env.events.count('close') == 1
    assert row_env.events.index('cleanup') < row_env.events.index('close')
    for stage, parts, options in session.calls:
        assert options['retry_tracker'] is session.calls[0][2]['retry_tracker']
        if stage == 'slides_extraction':
            assert parts[0] == PreparedFilePart('fake://slides/1', 'application/pdf')
            assert options['operation_name'] == 'instant_slide_extraction' and options['max_output_tokens'] == 65536
        elif stage in {'audio_transcription', 'interview_transcription'}:
            assert parts[0] == PreparedFilePart('fake://audio/1', 'audio/mpeg')
            assert isinstance(parts[1], TextPart)
        elif stage in {'notes_merge', 'text_combine'}:
            assert options['operation_name'] == 'instant_notes_merge' and parts == (parts[0],)
    usage = row['token_usage_by_stage']
    assert all(entry['billing_mode'] == 'instant_batch' for entry in usage.values())
    if 'notes_merge' in stages or 'text_combine' in stages:
        assert usage['notes_merge']['model'] == f"routed-{'text_combine' if mode == 'text-combine' else 'notes_merge'}"
    if 'slides_extraction' in stages:
        assert usage['slide_extraction']['model'] == 'routed-slides_extraction'
    if 'audio_transcription' in stages:
        assert usage['audio_transcription']['model'] == 'routed-audio_transcription'


def test_openrouter_instant_slides_read_row_owned_pdf_then_clean_up(core, row_env, monkeypatch, tmp_path):
    pdf = tmp_path / 'slides.pdf'
    pdf.write_bytes(b'%PDF-synthetic')
    route = dict(core.AI_ROUTING_SNAPSHOT.routes)
    route['slides_extraction'] = Route('openrouter', 'anthropic/claude-haiku-5.5',
                                       {'reasoning_effort': 'medium', 'max_output_tokens': 32768})
    monkeypatch.setattr(core, 'AI_ROUTING_SNAPSHOT', RoutingSnapshot(route))
    monkeypatch.setattr(batch, '_upload_row_files', row_env.prepare)
    monkeypatch.setattr(instant, '_cleanup_row_files', row_env.cleanup)
    monkeypatch.setattr(core.client.files, 'upload', lambda **kw: pytest.fail('Unexpected Gemini upload'))
    original = Session.generate

    def generate(session, stage, parts, **options):
        assert stage == 'slides_extraction'
        assert parts[0] == PdfPart(str(pdf))
        assert pdf.read_bytes() == b'%PDF-synthetic'
        return original(session, stage, parts, **options)

    monkeypatch.setattr(Session, 'generate', generate)
    row = run_row(core, row_env, 'slides-only', slides_local_path=str(pdf))
    assert row.get('status') != 'error' and row['slide_text'] == 'Synthetic slides_extraction output.'
    assert not pdf.exists()
    assert not row.get('slides_file_uri')


def test_timestamped_rows_fall_back_through_the_same_session(core, row_env, monkeypatch):
    monkeypatch.setattr(core, 'FEATURE_AUDIO_SECTION_SYNC', True)
    row = run_row(core, row_env, 'lecture-notes')
    stages = [call[0] for call in row_env.sessions[0].calls]
    assert stages == ['slides_extraction', 'audio_transcription_timestamped', 'audio_transcription', 'notes_merge']
    primary, fallback = row_env.sessions[0].calls[1:3]
    assert primary[1][0] is fallback[1][0]
    assert fallback[2]['operation_name'] == 'audio_transcription_fallback'
    usage = row['token_usage_by_stage']
    assert usage['audio_transcription']['model'] == 'routed-audio_transcription_timestamped'
    assert usage['audio_transcription_fallback']['model'] == 'routed-audio_transcription'
    assert usage['audio_transcription_fallback']['billing_mode'] == 'instant_batch'
    assert row['token_total'] == 19 * len(stages)


def test_row_that_fails_before_generation_never_opens_a_session(core, row_env):
    row_env.upload_error = RuntimeError('Synthetic upload failure')
    row = run_row(core, row_env, 'slides-only')
    assert row['status'] == 'error'
    assert row_env.sessions == [] and 'open' not in row_env.events
    assert row_env.events[-2:] == ['finalize', 'cleanup']


def test_prepared_parts_are_referenced_without_upload_or_ownership(core, monkeypatch):
    calls = []
    uploads = []
    client = SimpleNamespace(
        models=SimpleNamespace(generate_content=lambda **kwargs: calls.append(kwargs) or SimpleNamespace(
            text='ok', usage_metadata=None)),
        files=SimpleNamespace(upload=lambda **kwargs: uploads.append(kwargs), delete=lambda **kwargs: uploads.append(kwargs)),
    )
    runtime = SimpleNamespace(client=client, types=core.types, MODEL_THINKING_POLICY={}, logger=core.logger,
                              PROVIDER_RETRY_MAX_ATTEMPTS=1, time=core.time)
    provider = GeminiProvider(runtime)
    result = provider.generate('gemini-synthetic', [PreparedFilePart('fake://prepared', 'audio/mpeg'), TextPart('Prompt')],
                               max_output_tokens=65536)
    provider.close()
    assert result.text == 'ok' and uploads == []
    parts = calls[0]['contents'][0].parts
    assert parts[0].file_data.file_uri == 'fake://prepared' and parts[0].file_data.mime_type == 'audio/mpeg'
    assert parts[1].text == 'Prompt'


def test_openrouter_route_rejects_prepared_gemini_files_before_any_client(core, monkeypatch):
    monkeypatch.setenv('LP_FORCE_FAKE_PROVIDER', '0')
    route = Route('openrouter', 'anthropic/claude-sonnet-5.5',
                  {'reasoning_effort': 'medium', 'max_output_tokens': 32768})
    session = factory.ProviderSession(core, routes=RoutingSnapshot({'slides_extraction': route}))
    with pytest.raises(ValueError, match='require Gemini'):
        session.generate('slides_extraction', [PreparedFilePart('fake://slides', 'application/pdf'), TextPart('Prompt')])
    assert session._adapters == {}
    session.close()


def test_audio_helpers_accept_prepared_parts_only_with_a_session(core):
    part = PreparedFilePart('fake://audio', 'audio/mpeg')
    with pytest.raises(ValueError):
        core.transcribe_audio_plain(part, 'audio/mpeg')
    session = Session([])
    text, usage = core.transcribe_audio_plain(part, 'audio/mpeg', include_usage=True, provider_session=session)
    assert text == 'Synthetic audio_transcription output.'
    assert usage == {'input_tokens': 7, 'output_tokens': 5, 'total_tokens': 19}
    assert session.calls[0][1][0] is part


def test_session_start_failure_fails_the_row_and_refunds(core, row_env, monkeypatch):
    def broken(_runtime, **_kwargs):
        row_env.events.append('open')
        raise RuntimeError('Synthetic session start failure')

    monkeypatch.setattr(factory, 'open_provider_session', broken)
    row = run_row(core, row_env, 'slides-only')
    assert row['status'] == 'error' and row['failed_stage'] == 'instant_pipeline'
    assert row_env.events == ['upload', 'open', 'refund', 'finalize', 'cleanup']


def test_stopped_batch_during_generation_closes_without_refund(core, row_env, monkeypatch):
    def stop(*_args, **_kwargs):
        raise batch._BatchStopped('synthetic-batch')

    monkeypatch.setattr(Session, 'generate', stop)
    row = run_row(core, row_env, 'text-combine', slide_text='Synthetic slides.')
    assert row.get('status') != 'error' and 'refund' not in row_env.events
    assert row_env.events[-3:] == ['finalize', 'cleanup', 'close']
