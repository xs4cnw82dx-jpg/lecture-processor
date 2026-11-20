"""Private controls for native and neutral audio helper compatibility."""
import json
import logging
import socket
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai.providers import factory
from lecture_processor.domains.ai.providers.contracts import AudioPart, GenerationResult, TextPart, Usage
from lecture_processor.runtime.container import get_runtime
from tests.runtime_test_support import get_test_core


COUNTS = {'input_tokens': 11, 'output_tokens': 10, 'total_tokens': 37}
FALLBACK_COUNTS = {'input_tokens': 5, 'output_tokens': 4, 'total_tokens': 21}
TIMESTAMP_TEXT = json.dumps({'full_transcript': '', 'transcript_segments': [
    None, {'start_ms': -4, 'end_ms': 9, 'text': '  First  '},
    {'start_ms': 10, 'end_ms': 8, 'text': '  Second  '},
    {'start_ms': 'bad', 'text': 'ignored'}, {'text': '  '},
]})
SEGMENTS = [{'start_ms': 0, 'end_ms': 9, 'text': 'First'}, {'start_ms': 10, 'end_ms': 10, 'text': 'Second'}]


def native_result(text, counts=COUNTS):
    return SimpleNamespace(text=text, usage_metadata=SimpleNamespace(
        prompt_token_count=counts['input_tokens'], candidates_token_count=counts['output_tokens'] - 3,
        thoughts_token_count=3, total_token_count=counts['total_tokens']))


@pytest.fixture
def audio(monkeypatch):
    core = get_test_core()
    runtime = get_runtime(core.app)
    calls, outcomes = [], []

    def forbidden(*_args, **_kwargs):
        pytest.fail('Audio helper must not construct sessions, access files, or use the network.')

    def generate(**kwargs):
        calls.append(kwargs)
        result = outcomes.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result

    values = {
        'client': SimpleNamespace(models=SimpleNamespace(generate_content=generate),
                                  files=SimpleNamespace(upload=forbidden, get=forbidden, delete=forbidden)),
        'MODEL_AUDIO': 'gemini-synthetic-audio',
        'MODEL_THINKING_POLICY': {'gemini-synthetic-audio': {'thinking_level': 'high'}},
        'PROMPT_AUDIO_TRANSCRIPTION': '  PLAIN {output_language}\n  ',
        'PROMPT_AUDIO_TRANSCRIPTION_TIMESTAMPED': '  TIMED {output_language}\n  ',
        'OUTPUT_LANGUAGE_MAP': {'nl': 'Dutch'},
        'logger': logging.getLogger('synthetic-audio-helper'),
    }
    for name, value in values.items():
        monkeypatch.setattr(core, name, value)
        monkeypatch.setitem(runtime.__dict__, name, value)
    monkeypatch.setattr(factory, 'open_provider_session', forbidden)
    monkeypatch.setattr(socket, 'getaddrinfo', forbidden)
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    monkeypatch.setattr(socket.socket, 'connect_ex', forbidden)
    return SimpleNamespace(core=core, calls=calls, outcomes=outcomes,
                           handle=SimpleNamespace(uri='https://synthetic.invalid/borrowed-audio', name='files/synthetic'))


def assert_native_call(call, prompt):
    assert call['model'] == 'gemini-synthetic-audio'
    assert call['config'].model_dump(mode='json', exclude_none=True) == {
        'max_output_tokens': 65536, 'thinking_config': {'thinking_level': 'HIGH'}}
    assert len(call['contents']) == 1
    content = call['contents'][0]
    assert content.role == 'user' and len(content.parts) == 2
    assert content.parts[0].file_data.file_uri == 'https://synthetic.invalid/borrowed-audio'
    assert content.parts[0].file_data.mime_type == 'audio/mpeg'
    assert content.parts[1].text == prompt


@pytest.mark.parametrize('include_usage', [False, True])
def test_native_plain_borrowed_handle_return_and_payload_control(audio, include_usage):
    audio.outcomes.append(native_result('  Plain transcript  '))
    tracker = {}
    result = audio.core.transcribe_audio_plain(audio.handle, 'audio/mpeg', 'NL',
                                               retry_tracker=tracker, include_usage=include_usage)
    assert result == (('Plain transcript', COUNTS) if include_usage else 'Plain transcript')
    assert len(audio.calls) == 1 and tracker == {'audio_transcription': 0}
    assert_native_call(audio.calls[0], '  PLAIN Dutch\n  ')


@pytest.mark.parametrize('primary', ['success', 'malformed', 'exception'])
@pytest.mark.parametrize('include_usage', [False, True])
def test_native_timestamp_return_fallback_and_usage_control(audio, primary, include_usage):
    audio.outcomes.append(RuntimeError('synthetic permanent failure') if primary == 'exception'
                          else native_result(TIMESTAMP_TEXT if primary == 'success' else 'malformed'))
    if primary != 'success':
        audio.outcomes.append(native_result('  Fallback transcript  ', FALLBACK_COUNTS))
    tracker = {}
    result = audio.core.transcribe_audio_with_timestamps(audio.handle, 'audio/mpeg', 'NL',
                                                        retry_tracker=tracker, include_usage=include_usage)
    expected = ('First\nSecond', SEGMENTS) if primary == 'success' else ('Fallback transcript', [])
    counts = COUNTS if primary == 'success' else FALLBACK_COUNTS if primary == 'exception' else {
        key: COUNTS[key] + FALLBACK_COUNTS[key] for key in COUNTS}
    assert result == (expected + (counts,) if include_usage else expected)
    assert len(audio.calls) == (1 if primary == 'success' else 2)
    assert_native_call(audio.calls[0], '  TIMED Dutch\n  ')
    if primary != 'success':
        assert_native_call(audio.calls[1], '  PLAIN Dutch\n  ')
    assert tracker == ({'audio_transcription_timestamped': 0} if primary == 'success' else {
        'audio_transcription_timestamped': int(primary == 'exception'), 'audio_transcription_fallback': 0})


class Session:
    def __init__(self, outputs):
        self.outputs = iter(outputs)
        self.calls = []
        self.closes = 0

    def generate(self, stage, parts, **options):
        self.calls.append((stage, tuple(parts), options))
        output = next(self.outputs)
        if isinstance(output, BaseException):
            raise output
        return output

    def close(self):
        self.closes += 1


def normalized(text, counts=COUNTS):
    return GenerationResult(text, {'do_not_use': 'parsed data'},
                            Usage(counts['input_tokens'], counts['output_tokens'], counts['total_tokens'], 3),
                            'gemini', 'gemini-synthetic-audio')


def assert_session_call(call, part, stage, operation, prompt, tracker):
    actual_stage, parts, options = call
    assert actual_stage == stage
    assert parts[0] is part and parts == (part, TextPart(prompt))
    assert options['operation_name'] == operation and options['max_output_tokens'] == 65536
    assert options.get('schema') is None and options['retry_tracker'] is tracker


@pytest.mark.parametrize('stage', ['audio_transcription', 'tools_transcription'])
@pytest.mark.parametrize('include_usage', [False, True])
def test_proposed_plain_neutral_stage_and_borrowed_session(audio, stage, include_usage):
    part = AudioPart('/synthetic/not-read.mp3', 'audio/mpeg')
    session = Session([normalized('  Plain transcript  ')])
    tracker = {}
    result = audio.core.transcribe_audio_plain(part, 'audio/mpeg', 'NL', retry_tracker=tracker,
                                               include_usage=include_usage, provider_session=session, stage=stage)
    assert result == (('Plain transcript', COUNTS) if include_usage else 'Plain transcript')
    assert_session_call(session.calls[0], part, stage, 'audio_transcription', '  PLAIN Dutch\n  ', tracker)
    assert len(session.calls) == 1 and session.closes == 0 and audio.calls == []


@pytest.mark.parametrize('primary,include_usage', [('success', True), ('success', False),
                                                  ('malformed', True), ('exception', True)])
def test_proposed_timestamp_fallback_reuses_resource_and_three_count_usage(audio, primary, include_usage):
    part = AudioPart('/synthetic/not-read.mp3', 'audio/mpeg')
    first = RuntimeError('synthetic failure') if primary == 'exception' else normalized(
        TIMESTAMP_TEXT if primary == 'success' else 'malformed')
    session = Session([first, normalized('  Fallback transcript  ', FALLBACK_COUNTS)])
    tracker = {}
    result = audio.core.transcribe_audio_with_timestamps(part, 'audio/mpeg', 'NL', retry_tracker=tracker,
                                                        include_usage=include_usage, provider_session=session)
    expected = ('First\nSecond', SEGMENTS) if primary == 'success' else ('Fallback transcript', [])
    counts = COUNTS if primary == 'success' else FALLBACK_COUNTS if primary == 'exception' else {
        key: COUNTS[key] + FALLBACK_COUNTS[key] for key in COUNTS}
    assert result == (expected + (counts,) if include_usage else expected)
    assert_session_call(session.calls[0], part, 'audio_transcription_timestamped',
                        'audio_transcription_timestamped', '  TIMED Dutch\n  ', tracker)
    if primary != 'success':
        assert_session_call(session.calls[1], part, 'audio_transcription',
                            'audio_transcription_fallback', '  PLAIN Dutch\n  ', tracker)
    assert len(session.calls) == (1 if primary == 'success' else 2)
    assert session.closes == 0 and audio.calls == []


def test_proposed_fallback_failure_propagates_without_closing_borrowed_session(audio):
    part = AudioPart('/synthetic/not-read.mp3', 'audio/mpeg')
    failure = RuntimeError('synthetic fallback failure')
    session = Session([normalized('malformed'), failure])
    with pytest.raises(RuntimeError) as caught:
        audio.core.transcribe_audio_with_timestamps(part, 'audio/mpeg', provider_session=session)
    assert caught.value is failure and len(session.calls) == 2
    assert session.calls[0][1][0] is session.calls[1][1][0] is part
    assert session.closes == 0 and audio.calls == []


@pytest.mark.parametrize('helper', ['transcribe_audio_plain', 'transcribe_audio_with_timestamps'])
@pytest.mark.parametrize('mismatch', ['neutral_without_session', 'native_with_session'])
def test_proposed_mismatched_resource_session_pairs_reject_before_fallback(audio, caplog, helper, mismatch):
    session = Session([])
    part = AudioPart('/synthetic/not-read.mp3', 'audio/mpeg')
    value, options = (part, {}) if mismatch == 'neutral_without_session' else (audio.handle, {'provider_session': session})
    with pytest.raises(ValueError):
        getattr(audio.core, helper)(value, 'audio/mpeg', **options)
    assert audio.calls == session.calls == [] and session.closes == 0
    assert 'falling back' not in caplog.text
