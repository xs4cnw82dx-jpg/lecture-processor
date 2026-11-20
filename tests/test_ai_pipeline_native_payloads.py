"""Lecture and slide workers send the established Gemini payloads through a real session."""
from pathlib import Path
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import pipelines
from lecture_processor.domains.ai.providers.fake import FakeGeminiClient


@pytest.fixture
def native(core, monkeypatch, tmp_path):
    state = SimpleNamespace(calls=[], deletes=[], fail_merge=False)
    client = FakeGeminiClient()
    native_delete = client.files.delete

    def generate(**kwargs):
        state.calls.append(kwargs)
        operation = kwargs['contents'][0].parts[-1].text
        if state.fail_merge and operation.startswith('MERGE'):
            raise RuntimeError('Synthetic merge failure')
        return SimpleNamespace(text='Synthetic output.', usage_metadata=SimpleNamespace(
            prompt_token_count=10, candidates_token_count=4, thoughts_token_count=2, total_token_count=16))

    def delete(**kwargs):
        state.deletes.append(kwargs['name'])
        return native_delete(**kwargs)

    client.models.generate_content = generate
    client.files.delete = delete
    monkeypatch.setattr(core, 'client', client)
    monkeypatch.setattr(core, 'FEATURE_AUDIO_SECTION_SYNC', False)
    monkeypatch.setattr(core, 'PROMPT_SLIDE_EXTRACTION', 'SLIDES synthetic prompt')
    monkeypatch.setattr(core, 'PROMPT_MERGE_TEMPLATE', 'MERGE {slide_text} {transcript} {output_language}')
    monkeypatch.setattr(core, 'convert_audio_to_mp3_with_ytdlp', lambda path: (str(path), False))
    monkeypatch.setattr(core, 'cleanup_files', lambda paths, _remote: [Path(p).unlink(missing_ok=True) for p in paths])
    monkeypatch.setattr(core, 'save_job_log', lambda *args: None)
    monkeypatch.setattr(pipelines.study_audio, 'persist_audio_for_study_pack', lambda *args, **kwargs: '')
    monkeypatch.setattr(pipelines, '_require_study_pack_saved', lambda *args, **kwargs: True)
    state.pdf = tmp_path / 'slides.pdf'
    state.pdf.write_bytes(b'%PDF-1.4 synthetic')
    state.audio = tmp_path / 'lecture.mp3'
    state.audio.write_bytes(b'synthetic audio')
    return state


def native_summary(call):
    config = call['config'].model_dump(mode='json', exclude_none=True)
    parts = call['contents'][0].parts
    return (call['model'], config.get('thinking_config'), config['max_output_tokens'],
            [part.file_data.mime_type if part.file_data else 'text' for part in parts])


def test_slides_worker_sends_pdf_then_prompt_and_deletes_upload_once(core, monkeypatch, native):
    job_id = 'native-slides'
    monkeypatch.setitem(core.jobs, job_id, {'mode': 'slides-only', 'status': 'starting', 'user_id': 'synthetic',
                                            'study_features': 'none', 'total_steps': 1})
    pipelines.process_slides_only(job_id, str(native.pdf), runtime=core)
    assert core.jobs[job_id]['status'] == 'complete'
    assert [native_summary(call) for call in native.calls] == [
        (core.MODEL_SLIDES, core.MODEL_THINKING_POLICY[core.MODEL_SLIDES] and
         {key: str(value).upper() for key, value in core.MODEL_THINKING_POLICY[core.MODEL_SLIDES].items()},
         65536, ['application/pdf', 'text'])]
    assert len(native.deletes) == 1


@pytest.mark.parametrize('fail_merge', [False, True])
def test_lecture_worker_payloads_and_upload_cleanup(core, monkeypatch, native, fail_merge):
    native.fail_merge = fail_merge
    job_id = 'native-lecture'
    monkeypatch.setitem(core.jobs, job_id, {'mode': 'lecture-notes', 'status': 'starting', 'user_id': 'synthetic',
                                            'study_features': 'none', 'output_language': 'English',
                                            'total_steps': 3})
    pipelines.process_lecture_notes(job_id, str(native.pdf), str(native.audio), runtime=core)
    assert core.jobs[job_id]['status'] == ('error' if fail_merge else 'complete')
    summaries = [native_summary(call) for call in native.calls]
    assert [summary[0] for summary in summaries] == [core.MODEL_SLIDES, core.MODEL_AUDIO, core.MODEL_INTEGRATION]
    assert [summary[3] for summary in summaries] == [['application/pdf', 'text'], ['audio/mpeg', 'text'], ['text']]
    assert all(summary[2] == 65536 for summary in summaries)
    # Both uploads are deleted exactly once, also when the merge fails afterwards.
    assert len(native.deletes) == 2 and len(set(native.deletes)) == 2
    if fail_merge:
        assert core.jobs[job_id]['failed_stage'] == 'notes_merge'
    else:
        usage = core.jobs[job_id]['token_usage_by_stage']
        assert {key: usage[key]['model'] for key in usage} == {
            'slide_extraction': core.MODEL_SLIDES, 'audio_transcription': core.MODEL_AUDIO,
            'merge': core.MODEL_INTEGRATION}
        assert all(usage[key]['output_tokens'] == 6 for key in usage)
