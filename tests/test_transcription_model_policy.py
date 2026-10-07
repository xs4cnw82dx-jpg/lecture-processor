"""Exercise real transcription entry points with a fake provider and temporary jobs."""
import json
from copy import deepcopy
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import batch_orchestrator, instant_batch_orchestrator, pipelines, provider
from lecture_processor.services import tools_transcription_service


@pytest.fixture
def fake_provider(core, monkeypatch):
    calls = []
    responses = []

    def generate(**kwargs):
        calls.append(kwargs)
        text = responses.pop(0) if responses else 'A synthetic audio transcript.'
        return SimpleNamespace(text=text, usage_metadata=SimpleNamespace(
            prompt_token_count=100, candidates_token_count=20, thoughts_token_count=80, total_token_count=200,
        ))

    uploaded = SimpleNamespace(uri='https://example.test/audio', name='files/test-audio')
    monkeypatch.setattr(core, 'client', SimpleNamespace(
        models=SimpleNamespace(generate_content=generate),
        files=SimpleNamespace(upload=lambda **kwargs: uploaded, delete=lambda **kwargs: None),
    ))
    return calls, responses, uploaded


def assert_audio_payload(call):
    assert call['model'] == 'gemini-3.8-flash'
    config = call['config'].model_dump(mode='json', exclude_none=True)
    assert config == {'max_output_tokens': 65536, 'thinking_config': {'thinking_level': 'HIGH'}}
    assert call['contents'][0].parts[0].file_data.mime_type == 'audio/mpeg'


@pytest.mark.parametrize('timestamped,fallback', [(False, False), (True, False), (True, True)])
def test_plain_timestamped_and_fallback_transcription(core, fake_provider, timestamped, fallback):
    calls, responses, uploaded = fake_provider
    if timestamped:
        responses.append('invalid json' if fallback else json.dumps({
            'full_transcript': 'Transcript.',
            'transcript_segments': [{'start_ms': 0, 'end_ms': 1000, 'text': 'Transcript.'}],
        }))
        result = core.transcribe_audio_with_timestamps(uploaded, 'audio/mpeg', include_usage=True)
    else:
        result = core.transcribe_audio_plain(uploaded, 'audio/mpeg', include_usage=True)
    expected_count = 2 if fallback else 1
    assert len(calls) == expected_count
    for call in calls:
        assert_audio_payload(call)
    # Both paid attempts, including thinking, must be counted after JSON failure.
    assert result[-1] == {'input_tokens': 100 * expected_count, 'output_tokens': 100 * expected_count,
                          'total_tokens': 200 * expected_count}


@pytest.mark.parametrize('mode', ['interview', 'voice-note', 'general'])
def test_single_transcription_pipelines_use_flash_high(core, monkeypatch, tmp_path, fake_provider, mode):
    calls, _, _ = fake_provider
    job_id = 'model-policy-' + mode
    audio = tmp_path / 'synthetic.wav'
    audio.write_bytes(b'synthetic audio')
    job = {'mode': mode, 'status': 'starting', 'user_id': 'synthetic', 'output_language': 'English',
           'interview_features': [], 'total_steps': 1}
    monkeypatch.setattr(core, 'convert_audio_to_mp3_with_ytdlp', lambda path: (str(path), False))
    monkeypatch.setattr(core, 'get_mime_type', lambda path: 'audio/mpeg')
    monkeypatch.setattr(core, 'wait_for_file_processing', lambda uploaded: None)
    monkeypatch.setattr(core, 'cleanup_files', lambda *args: None)
    monkeypatch.setattr(core, 'save_job_log', lambda *args: None)
    monkeypatch.setattr(pipelines.study_audio, 'persist_audio_for_study_pack', lambda *args, **kwargs: '')
    monkeypatch.setattr(pipelines, '_require_study_pack_saved', lambda *args, **kwargs: True)
    monkeypatch.setitem(core.jobs, job_id, job)
    if mode == 'interview':
        pipelines.process_interview_transcription(job_id, str(audio), runtime=core)
    elif mode == 'voice-note':
        pipelines.process_voice_note(job_id, str(audio), runtime=core)
    else:
        tools_transcription_service._run_general_transcription_job(core, job_id, str(audio), runtime=core)
    snapshot = core.jobs[job_id]
    assert snapshot['status'] == 'complete'
    assert len(calls) == 1
    assert_audio_payload(calls[0])
    usage = next(iter(snapshot['token_usage_by_stage'].values()))
    assert usage['model'] == 'gemini-3.8-flash'
    assert usage['input_modality'] == 'audio'
    assert usage['output_tokens'] == 100


@pytest.mark.parametrize('mode', ['interview', 'audio'])
def test_instant_batch_transcription_payload_and_billing(core, monkeypatch, fake_provider, mode):
    calls, _, _ = fake_provider
    monkeypatch.setattr(instant_batch_orchestrator, '_upsert_row_progress', lambda *args, **kwargs: None)
    monkeypatch.setattr(batch_orchestrator, '_upsert_row', lambda *args, **kwargs: None)
    row = {'row_id': 'synthetic', 'audio_file_uri': 'https://example.test/audio', 'audio_mime_type': 'audio/mpeg'}
    tokens = provider.TokenAccumulator(runtime=core)
    function = (instant_batch_orchestrator._run_interview_transcription if mode == 'interview'
                else instant_batch_orchestrator._run_audio_transcription)
    function('test-batch', row, SimpleNamespace(wait=lambda: None), tokens, {}, core)
    assert len(calls) == 1
    assert_audio_payload(calls[0])
    usage = next(iter(tokens.stages.values()))
    assert usage['model'] == 'gemini-3.8-flash'
    assert usage['billing_mode'] == 'instant_batch'
    assert usage['output_tokens'] == 100


@pytest.mark.parametrize('stage', ['audio_transcription', 'interview_transcription'])
def test_deferred_transcription_removes_obsolete_parameters(core, stage):
    original = {'contents': [{'role': 'user', 'parts': [{'text': 'transcribe'}]}], 'generationConfig': {
        'temperature': 0.2, 'topP': 0.5, 'topK': 10, 'top_p': 0.5, 'top_k': 10,
        'responseMimeType': 'application/json',
        'thinkingConfig': {'thinkingBudget': 300, 'thinking_budget': 300, 'includeThoughts': False},
    }}
    preserved = deepcopy(original)
    payload = batch_orchestrator._request_with_stage_config(original, stage, core)
    assert batch_orchestrator._batch_model(stage, core) == 'gemini-3.8-flash'
    assert payload['generationConfig'] == {
        'responseMimeType': 'application/json', 'maxOutputTokens': 65536,
        'thinkingConfig': {'includeThoughts': False, 'thinkingLevel': 'high'},
    }
    assert original == preserved
