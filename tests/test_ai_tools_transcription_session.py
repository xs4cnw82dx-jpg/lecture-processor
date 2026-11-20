"""General transcription owns one workflow session with isolated provider doubles."""
from copy import deepcopy
import os
import socket
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai.providers import factory
from lecture_processor.domains.ai.providers.contracts import AudioPart
from lecture_processor.domains.ai.providers.fake import FakeGeminiClient
from lecture_processor.domains.billing import job_charges
from lecture_processor.domains.runtime_jobs import store
from lecture_processor.runtime import media_runtime
from lecture_processor.services import tools_transcription_service as transcription


class PermanentFailure(Exception):
    """Non-retryable synthetic failure (the fake client's own error text counts as transient)."""

    status_code = 400

    def __init__(self):
        super().__init__('Synthetic permanent failure.')


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail('Transcription workflow tests cannot use network or DNS')
    for name in ('getaddrinfo', 'gethostbyname', 'gethostbyname_ex', 'create_connection'):
        monkeypatch.setattr(socket, name, forbidden)
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    monkeypatch.setattr(socket.socket, 'connect_ex', forbidden)


@pytest.fixture
def workflow(core, monkeypatch, tmp_path):
    state = SimpleNamespace(events=[], calls=[], job={'status': 'queued', 'user_id': 'synthetic-user',
                                                      'output_language': 'English'},
                            admitted=True, failure='', root=tmp_path, core=core, refunds=[])
    response = SimpleNamespace(text='  Synthetic transcript.  ', usage_metadata=SimpleNamespace(
        prompt_token_count=11, candidates_token_count=7, thoughts_token_count=3, total_token_count=21))
    fake = FakeGeminiClient({'models.generate_content': [response]})
    native_upload, native_poll, native_delete = fake.files.upload, fake.files.get, fake.files.delete
    native_generate = fake.models.generate_content

    def upload(**kwargs):
        state.events.append(('remote_upload', kwargs['config']['mime_type']))
        return native_upload(**kwargs)

    def poll(**kwargs):
        if state.failure == 'processing':
            raise PermanentFailure()
        return native_poll(**kwargs)

    def delete(**kwargs):
        state.events.append(('remote_delete', kwargs['name']))
        return native_delete(**kwargs)

    def generate(**kwargs):
        state.calls.append(kwargs)
        if state.failure == 'generation':
            raise PermanentFailure()
        return native_generate(**kwargs)

    fake.files.upload, fake.files.get, fake.files.delete = upload, poll, delete
    fake.models.generate_content = generate
    monkeypatch.setattr(core, 'client', fake)
    original_session = factory.ProviderSession

    class SessionSpy(original_session):
        def __init__(self, *args, **kwargs):
            state.events.append(('open', None))
            super().__init__(*args, **kwargs)

        def upload_file(self, stage, part, **kwargs):
            state.events.append(('upload', (stage, part, kwargs['operation_name'])))
            return super().upload_file(stage, part, **kwargs)

        def wait_for_file(self, stage, part, **kwargs):
            state.events.append(('wait', (stage, part, kwargs['operation_name'])))
            return super().wait_for_file(stage, part, **kwargs)

        def generate(self, stage, parts, **kwargs):
            state.events.append(('generate', (stage, tuple(parts), kwargs['operation_name'])))
            return super().generate(stage, parts, **kwargs)

        def close(self):
            state.events.append(('close', None))
            return super().close()

    monkeypatch.setattr(factory, 'ProviderSession', SessionSpy)

    def admit(*_args, **_kwargs):
        state.events.append(('admit', state.admitted))
        return state.admitted

    def remove(path):
        state.events.append(('local_delete', os.path.basename(path)))
        os.remove(path)

    def cleanup(paths, remote):
        state.events.append(('cleanup', len(remote)))
        media_runtime.cleanup_files(paths, remote, client=fake, logger=core.logger,
                                    os_module=SimpleNamespace(path=os.path, remove=remove))

    def refund(job, *_args, **_kwargs):
        state.refunds.append(job.get('credit_deducted'))
        return True

    monkeypatch.setattr(job_charges, 'begin_runtime_job', admit)
    monkeypatch.setattr(job_charges, 'refund_component', refund)
    monkeypatch.setattr(job_charges, 'set_admitted_job', lambda *_args, **_kwargs: None)
    monkeypatch.setattr(store, 'update_job_fields', lambda _id, runtime=None, **fields: state.job.update(deepcopy(fields)))
    monkeypatch.setattr(store, 'get_job_snapshot', lambda *_args, **_kwargs: deepcopy(state.job))
    monkeypatch.setattr(core, 'cleanup_files', cleanup)
    monkeypatch.setattr(core, 'get_mime_type', lambda _path: 'audio/mpeg')
    monkeypatch.setattr(core, 'convert_audio_to_mp3_with_ytdlp', lambda path: (path, False))
    return state


def run_job(state):
    path = state.root / 'synthetic.mp3'
    path.write_bytes(b'synthetic audio fixture')
    transcription._run_general_transcription_job(state.core, 'synthetic-job', str(path), runtime=state.core)
    return str(path)


def assert_owned_session(state):
    names = [event[0] for event in state.events]
    assert names.count('open') == names.count('close') == 1
    assert names.index('admit') < names.index('open')
    assert [event[1] for event in state.events if event[0] == 'cleanup'] == [0]
    assert names.index('local_delete') < names.index('close')
    assert all(names.index('close') < i for i, name in enumerate(names) if name == 'remote_delete')


def test_general_transcription_uses_one_session_on_the_tools_stage(workflow):
    state = workflow
    path = run_job(state)
    assert_owned_session(state)
    part = AudioPart(path, 'audio/mpeg')
    steps = [(name, detail) for name, detail in state.events if name in {'upload', 'wait', 'generate'}]
    assert steps[0] == ('upload', ('tools_transcription', part, 'general_audio_upload'))
    assert steps[1] == ('wait', ('tools_transcription', part, 'general_audio_file_processing'))
    stage, parts, operation = steps[2][1]
    assert (stage, operation) == ('tools_transcription', 'audio_transcription') and parts[0] == part
    assert [name for name, _ in state.events].count('remote_upload') == 1
    assert [name for name, _ in state.events].count('remote_delete') == 1
    assert len(state.calls) == 1 and state.calls[0]['model'] == state.core.MODEL_AUDIO
    assert state.job['status'] == 'complete' and state.job['transcript'] == 'Synthetic transcript.'
    assert state.job['token_usage_by_stage'] == {'audio_transcription': {
        'input_tokens': 11, 'output_tokens': 10, 'total_tokens': 21, 'model': state.core.MODEL_AUDIO,
        'billing_mode': 'standard', 'input_modality': 'audio'}}


@pytest.mark.parametrize('failure', ['processing', 'generation'])
def test_general_transcription_failure_deletes_the_upload_once_and_refunds(workflow, failure):
    state = workflow
    state.failure = failure
    state.job['credit_deducted'] = 'interview_credits_short'
    run_job(state)
    assert_owned_session(state)
    assert [name for name, _ in state.events].count('remote_delete') == 1
    assert state.job['status'] == 'error'
    assert state.job['failed_stage'] == ('audio_file_processing' if failure == 'processing' else 'audio_transcription')
    assert state.job['provider_error_code'] == 'HTTP_400'
    assert state.refunds == ['interview_credits_short']
    assert len(state.calls) == (0 if failure == 'processing' else 1)


def test_denied_admission_cleans_local_audio_without_a_session(workflow):
    state = workflow
    state.admitted = False
    path = run_job(state)
    assert [event[0] for event in state.events] == ['admit', 'cleanup', 'local_delete']
    assert not os.path.exists(path) and not state.calls
