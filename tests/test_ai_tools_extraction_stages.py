"""Extraction workflow ownership with actual sessions and isolated provider doubles."""
from copy import deepcopy
from pathlib import Path
import os
import socket
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai.providers import factory
from lecture_processor.domains.ai.providers.contracts import ImagePart, PdfPart, TextPart
from lecture_processor.domains.ai.providers.fake import FakeGeminiClient
from lecture_processor.domains.ai.providers.routing import Route, RoutingSnapshot
from lecture_processor.domains.billing import job_charges
from lecture_processor.domains.runtime_jobs import store
from lecture_processor.runtime import media_runtime
from lecture_processor.services import tools_extraction_service as extraction
from lecture_processor.services import tools_extraction_support as support
from lecture_processor.services import upload_api_service


MODEL = 'gemini-synthetic-tools-route'
SOURCE = 'Synthetic source one.\nSynthetic source two.'
OUTPUT = '  Synthetic extraction output.  '


class PermanentFailure(Exception):
    """A non-retryable synthetic failure (the fake client's error text counts as transient)."""

    status_code = 400

    def __init__(self):
        super().__init__('Synthetic permanent failure.')


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail('Extraction workflow tests cannot use network or DNS')
    for name in ('getaddrinfo', 'gethostbyname', 'gethostbyname_ex', 'create_connection'):
        monkeypatch.setattr(socket, name, forbidden)
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    monkeypatch.setattr(socket.socket, 'connect_ex', forbidden)


@pytest.fixture
def workflow(core, monkeypatch, tmp_path):
    state = SimpleNamespace(events=[], calls=[], job={'status': 'queued', 'user_id': 'synthetic-user'},
                            logs=[], refunds=[], admitted=True, failure='', uploads=0, polls=0)
    response = SimpleNamespace(text=OUTPUT, usage_metadata=SimpleNamespace(
        prompt_token_count=11, candidates_token_count=7, thoughts_token_count=3, total_token_count=21))
    fake = FakeGeminiClient({'models.generate_content': [response]})
    native_upload, native_poll, native_delete = fake.files.upload, fake.files.get, fake.files.delete
    native_generate = fake.models.generate_content

    def upload(**kwargs):
        state.uploads += 1
        if state.failure == 'partial_upload' and state.uploads == 2:
            raise PermanentFailure()
        return native_upload(**kwargs)

    def poll(**kwargs):
        state.polls += 1
        if state.failure == 'partial_processing' and state.polls == 2:
            raise PermanentFailure()
        return native_poll(**kwargs)

    def delete(**kwargs):
        state.events.append(('remote_delete', kwargs['name']))
        return native_delete(**kwargs)

    def generate(**kwargs):
        state.calls.append(kwargs)
        if state.failure == 'generation':
            raise PermanentFailure()
        result = native_generate(**kwargs)
        if state.failure == 'empty':
            result.text = ' \n'
        return result

    fake.files.upload, fake.files.get, fake.files.delete = upload, poll, delete
    fake.models.generate_content = generate
    monkeypatch.setattr(core, 'client', fake)
    routes = dict(core.AI_ROUTING_SNAPSHOT.routes)
    routes['tools_extraction'] = Route('gemini', MODEL)
    monkeypatch.setattr(core, 'AI_ROUTING_SNAPSHOT', RoutingSnapshot(routes))
    original_session = factory.ProviderSession

    class SessionSpy(original_session):
        def __init__(self, *args, **kwargs):
            state.events.append(('open', None))
            super().__init__(*args, **kwargs)

        def upload_file(self, stage, part, **kwargs):
            state.events.append(('upload', (stage, part, kwargs)))
            return super().upload_file(stage, part, **kwargs)

        def wait_for_file(self, stage, part, **kwargs):
            state.events.append(('wait', (stage, part, kwargs)))
            return super().wait_for_file(stage, part, **kwargs)

        def generate(self, stage, parts, **kwargs):
            state.events.append(('generate', (stage, tuple(parts), kwargs)))
            return super().generate(stage, parts, **kwargs)

        def close(self):
            state.events.append(('close', None))
            return super().close()

    monkeypatch.setattr(factory, 'ProviderSession', SessionSpy)

    def admit(*_args, **_kwargs):
        state.events.append(('admit', state.admitted))
        return state.admitted

    def update(_job_id, runtime=None, **fields):
        state.job.update(deepcopy(fields))

    def remove(path):
        state.events.append(('local_delete', str(path)))
        os.remove(path)

    def cleanup(paths, remote):
        state.events.append(('cleanup', len(remote)))
        media_runtime.cleanup_files(paths, remote, client=fake, logger=core.logger,
                                    os_module=SimpleNamespace(path=os.path, remove=remove))

    def refund(_runtime, uid, credit, **kwargs):
        state.refunds.append((uid, credit, kwargs))
        return True, 'synthetic_refund'

    def convert(_upload, _prefix):
        pdf = tmp_path / 'converted.pdf'
        pdf.write_bytes(b'synthetic PDF fixture')
        return str(pdf), None

    monkeypatch.setattr(job_charges, 'begin_runtime_job', admit)
    monkeypatch.setattr(job_charges, 'runtime_receipt_fields', lambda *_args, **_kwargs: {})
    monkeypatch.setattr(store, 'update_job_fields', update)
    monkeypatch.setattr(store, 'get_job_snapshot', lambda *_args, **_kwargs: deepcopy(state.job))
    monkeypatch.setattr(core, 'save_job_log', lambda _id, payload, _now: state.logs.append(deepcopy(payload)))
    monkeypatch.setattr(core, 'cleanup_files', cleanup)
    monkeypatch.setattr(core, 'resolve_uploaded_slides_to_pdf', convert)
    monkeypatch.setattr(core, 'get_saved_file_size', lambda path: Path(path).stat().st_size)
    monkeypatch.setattr(core, 'get_mime_type', lambda path: 'image/png' if str(path).endswith('.png') else 'image/jpeg')
    monkeypatch.setattr(support, 'fetch_tools_url_text', lambda _url: (SOURCE, None, 'text/plain'))
    monkeypatch.setattr(support, 'extract_docx_text', lambda *_args: (SOURCE, None))
    monkeypatch.setattr(extraction.analytics_events, 'log_analytics_event', lambda *_args, **_kwargs: None)
    monkeypatch.setattr(upload_api_service, '_attempt_credit_refund', refund)
    state.core, state.root = core, tmp_path
    return state


def run_worker(state, kind):
    source_type = 'image' if kind == 'images' else 'url' if kind == 'url' else 'document'
    names = [] if kind == 'url' else ['first.png', 'second.jpg'] if kind == 'images' else ['source.' + kind]
    paths = []
    for name in names:
        path = state.root / name
        path.write_bytes(b'synthetic fixture bytes')
        paths.append(str(path))
    mime = {'pdf': 'application/pdf', 'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'}.get(kind, '')
    staged = extraction._StagedToolInput(source_type=source_type, source_url='https://example.invalid/fixture',
        prompt_template_key='reader', prompt_source='template', custom_prompt='', extension=kind, mime_type=mime,
        staged_paths=tuple(paths), normalized_input_name='synthetic-source', normalized_input_names=tuple(names),
        upload_mime_type='', source_size_mb=0.0)
    extraction._run_tools_extract_job(state.core, 'synthetic-job', 'synthetic-user', 'fixture@example.invalid', staged, 'slides_credits', 2)
    return source_type, paths


def assert_owned_session(state):
    names = [event[0] for event in state.events]
    assert names.count('open') == 1
    assert names.count('close') == 1
    assert names.index('admit') < names.index('open')
    assert names.index('cleanup') < names.index('close')
    assert [event[1] for event in state.events if event[0] == 'cleanup'] == [0]
    local = [i for i, name in enumerate(names) if name == 'local_delete']
    if local:
        assert max(local) < names.index('close')
    assert all(names.index('close') < i for i, name in enumerate(names) if name == 'remote_delete')


@pytest.mark.parametrize('kind', ['url', 'docx', 'pdf', 'pptx', 'images'])
def test_extraction_owns_one_session_and_preserves_ordered_parts_labels_and_usage(workflow, kind):
    state = workflow
    source_type, paths = run_worker(state, kind)
    assert_owned_session(state)
    calls = [event[1] for event in state.events if event[0] == 'generate']
    assert len(calls) == 1
    stage, parts, kwargs = calls[0]
    assert stage == 'tools_extraction'
    operation = 'tools_extract_url' if kind == 'url' else 'tools_extract_document_docx' if kind == 'docx' else 'tools_extract_' + source_type
    assert kwargs['operation_name'] == operation
    assert kwargs['max_output_tokens'] == 32768
    assert kwargs.get('schema') is None
    prompt = TextPart(support.build_tools_prompt(source_type))
    if kind in {'url', 'docx'}:
        assert parts == (prompt, TextPart(f'Source content extracted from {kind.upper()}:\n\n{SOURCE}'))
        expected_phases = []
    elif kind == 'images':
        assert parts == (ImagePart(paths[0], 'image/png'), ImagePart(paths[1], 'image/jpeg'), prompt)
        expected_phases = [('upload', 'tools_image_upload_1'), ('wait', 'tools_image_processing_1'),
                           ('upload', 'tools_image_upload_2'), ('wait', 'tools_image_processing_2')]
    else:
        assert parts == (PdfPart(str(state.root / 'converted.pdf')), prompt)
        expected_phases = [('upload', 'tools_file_upload'), ('wait', 'tools_file_processing')]
    phases = [(event[0], event[1][2]['operation_name']) for event in state.events if event[0] in {'upload', 'wait'}]
    assert phases == expected_phases
    for event in state.events:
        if event[0] in {'upload', 'wait'}:
            assert event[1][0] == 'tools_extraction'
            assert event[1][2]['retry_tracker'] is kwargs['retry_tracker']
    assert state.job['status'] == 'complete' and state.job['result'] == OUTPUT.strip()
    usage = {'input_tokens': 11, 'output_tokens': 10, 'total_tokens': 21, 'model': MODEL,
             'billing_mode': 'standard', 'input_modality': 'image' if kind == 'images' else 'text'}
    assert state.job['token_usage_by_stage'] == {'tools_extract_' + source_type: usage}
    assert state.logs[0]['token_usage_by_stage'] == state.job['token_usage_by_stage']
    assert not state.refunds
    assert len(state.calls) == 1 and state.calls[0]['model'] == MODEL
    assert state.calls[0]['config'].model_dump(exclude_none=True) == {'max_output_tokens': 32768}
    # Native wire: each file uploaded, polled and deleted exactly once, in staged order before the prompt.
    file_count = {'url': 0, 'docx': 0, 'images': 2}.get(kind, 1)
    assert state.uploads == file_count and state.polls == file_count
    assert len([event for event in state.events if event[0] == 'remote_delete']) == file_count
    native_parts = state.calls[0]['contents'][0].parts
    assert state.calls[0]['contents'][0].role == 'user'
    assert [getattr(part.file_data, 'mime_type', None) for part in native_parts[:file_count]] == (
        ['image/png', 'image/jpeg'] if kind == 'images' else ['application/pdf'] * file_count)
    assert [part.text for part in native_parts[file_count:]] == [part.text for part in parts[file_count:]]


@pytest.mark.parametrize('failure', ['partial_upload', 'partial_processing', 'generation', 'empty'])
def test_extraction_closes_partial_resources_after_local_cleanup_and_keeps_failure_receipt(workflow, failure):
    state = workflow
    state.failure = failure
    run_worker(state, 'images')
    assert_owned_session(state)
    assert state.job['status'] == 'error' and state.job['failed_stage'] == 'tools_extract'
    expected_error = 'Extraction returned empty output' if failure == 'empty' else 'Synthetic permanent failure.'
    assert state.job['error'] == f'{expected_error} Your text extraction credit has been refunded.'
    assert state.job['provider_error_code'] == ('GENERIC' if failure == 'empty' else 'HTTP_400')
    assert state.job['credit_refunded'] is True and state.job['credit_refund_pending'] is False
    assert state.job['billing_receipt'] == {'charged': {'slides_credits': 1}, 'refunded': {'slides_credits': 1}}
    assert len(state.refunds) == 1
    assert state.refunds[0][2]['idempotency_key'] == 'runtime-job:synthetic-job:primary'
    assert state.logs[-1]['token_usage_by_stage'] == {}
    deletes = [event for event in state.events if event[0] == 'remote_delete']
    assert len(deletes) == (1 if failure == 'partial_upload' else 2)
    assert len(state.calls) == (0 if failure in {'partial_upload', 'partial_processing'} else 1)


def test_denied_extraction_admission_cleans_local_input_without_opening_session(workflow):
    state = workflow
    state.admitted = False
    _, paths = run_worker(state, 'pdf')
    assert [event[0] for event in state.events] == ['admit', 'cleanup', 'local_delete']
    assert not state.logs and not state.refunds and not state.calls
    assert not Path(paths[0]).exists()
