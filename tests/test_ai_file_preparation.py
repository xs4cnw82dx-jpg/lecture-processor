"""Explicit provider file phases with synthetic clients and local files only."""

import socket
from pathlib import Path
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai.providers import factory
from lecture_processor.domains.ai.providers.contracts import AudioPart, ImagePart, PdfPart, TextPart
from lecture_processor.domains.ai.providers.fake import FakeGeminiClient
from lecture_processor.domains.ai.providers.gemini import GeminiProvider
from lecture_processor.domains.ai.providers.routing import Route, RoutingSnapshot
from tests.support.ai_provider_contract import MODEL, Harness, local_parts, serialized_contents

STAGE = 'slides_extraction'
UPLOAD = 'existing_slide_upload'
PROCESSING = 'existing_slide_file_processing'
GENERATE = 'existing_slide_extraction'


@pytest.fixture(autouse=True)
def block_network(monkeypatch):
    def forbidden(*_args, **_kwargs):
        pytest.fail('Provider preparation tests cannot use network or DNS')

    for name in ('getaddrinfo', 'gethostbyname', 'gethostbyname_ex', 'create_connection'):
        monkeypatch.setattr(socket, name, forbidden)
    monkeypatch.setattr(socket.socket, 'connect', forbidden)
    monkeypatch.setattr(socket.socket, 'connect_ex', forbidden)


def session_for(runtime, monkeypatch, *, route=None, stage=STAGE, forced=False):
    monkeypatch.setenv('APP_ENV', 'test')
    monkeypatch.setenv('SENTRY_ENVIRONMENT', 'test')
    monkeypatch.setenv('LP_FORCE_FAKE_PROVIDER', '1' if forced else '0')
    return factory.ProviderSession(runtime, routes=RoutingSnapshot({stage: route or Route('gemini', MODEL)}))


@pytest.mark.parametrize('kind', range(3), ids=['pdf', 'image', 'audio'])
def test_explicit_phases_preserve_labels_build_no_config_and_reuse_ready_file(tmp_path, monkeypatch, kind):
    harness = Harness()
    part = local_parts(tmp_path)[kind]
    real_types = harness.runtime.types
    harness.runtime.types = SimpleNamespace(GenerateContentConfig=lambda **_kwargs: pytest.fail('Preparation built a config'))
    tracker = {}
    with session_for(harness.runtime, monkeypatch) as session:
        assert session.upload_file(STAGE, part, operation_name=UPLOAD, retry_tracker=tracker) is None
        assert len(harness.uploads) == 1
        assert harness.polls == harness.generations == harness.deletes == []
        assert tracker == {UPLOAD: 0}
        assert session.wait_for_file(STAGE, part, operation_name=PROCESSING, retry_tracker=tracker) is None
        assert len(harness.polls) == 1
        assert harness.generations == harness.deletes == []
        assert tracker == {UPLOAD: 0, PROCESSING: 0}
        harness.runtime.types = real_types
        for _ in range(2):
            session.upload_file(STAGE, part, operation_name=UPLOAD, retry_tracker=tracker)
            session.wait_for_file(STAGE, part, operation_name=PROCESSING, retry_tracker=tracker)
            result = session.generate(STAGE, [part, TextPart('  Synthetic exact text\n'), part],
                                      operation_name=GENERATE, retry_tracker=tracker)
            assert result.raw_response is harness.response
        assert len(harness.uploads) == len(harness.polls) == 1
        assert len(harness.generations) == 2
        parts = serialized_contents(harness.generations[0])[0]['parts']
        assert parts[0] == parts[2]
        assert parts[1] == {'text': '  Synthetic exact text\n'}
        assert tracker == {UPLOAD: 0, PROCESSING: 0, GENERATE: 0}
    session.close()
    assert harness.deletes == ['files/synthetic-1']
    assert part.path.is_file()


def test_wait_without_upload_fails_without_uploading_or_touching_tracker(tmp_path, monkeypatch):
    harness = Harness()
    tracker = {'unrelated': 2}
    with session_for(harness.runtime, monkeypatch) as session:
        with pytest.raises(RuntimeError, match='uploaded'):
            session.wait_for_file(STAGE, local_parts(tmp_path)[0], operation_name=PROCESSING, retry_tracker=tracker)
    assert harness.uploads == harness.polls == harness.generations == harness.deletes == []
    assert tracker == {'unrelated': 2}


def test_failed_processing_can_be_retried_without_a_second_upload(tmp_path, monkeypatch):
    harness = Harness()
    part = local_parts(tmp_path)[0]
    failure = ValueError('Synthetic processing interruption')
    calls = []

    def wait(_uploaded, **_kwargs):
        calls.append('wait')
        if len(calls) == 1:
            raise failure

    monkeypatch.setattr('lecture_processor.runtime.media_runtime.wait_for_file_processing', wait)
    tracker = {}
    with session_for(harness.runtime, monkeypatch) as session:
        session.upload_file(STAGE, part, operation_name=UPLOAD, retry_tracker=tracker)
        with pytest.raises(ValueError) as raised:
            session.wait_for_file(STAGE, part, operation_name=PROCESSING, retry_tracker=tracker)
        assert raised.value is failure
        session.upload_file(STAGE, part, operation_name=UPLOAD, retry_tracker=tracker)
        session.wait_for_file(STAGE, part, operation_name=PROCESSING, retry_tracker=tracker)
        session.generate(STAGE, [part], operation_name=GENERATE, retry_tracker=tracker)
    assert calls == ['wait', 'wait']
    assert len(harness.uploads) == len(harness.generations) == 1
    assert harness.deletes == ['files/synthetic-1']
    assert tracker == {UPLOAD: 0, PROCESSING: 1, GENERATE: 0}


@pytest.mark.parametrize('phase', ['upload', 'processing'])
def test_each_phase_retries_under_its_original_label(tmp_path, monkeypatch, phase):
    harness = Harness()
    part = local_parts(tmp_path)[0]
    attempts = []
    original_upload = harness.client.files.upload

    def retry_once(*args, **kwargs):
        attempts.append(phase)
        if len(attempts) == 1:
            raise TimeoutError('Synthetic timeout')
        return original_upload(**kwargs) if phase == 'upload' else None

    if phase == 'upload':
        harness.client.files.upload = retry_once
    else:
        monkeypatch.setattr('lecture_processor.runtime.media_runtime.wait_for_file_processing', retry_once)
    tracker = {}
    with session_for(harness.runtime, monkeypatch) as session:
        session.upload_file(STAGE, part, operation_name=UPLOAD, retry_tracker=tracker)
        session.wait_for_file(STAGE, part, operation_name=PROCESSING, retry_tracker=tracker)
    assert attempts == [phase, phase]
    assert tracker == {UPLOAD: int(phase == 'upload'), PROCESSING: int(phase == 'processing')}
    assert harness.sleeps == [0.25]
    assert len(harness.uploads) == 1
    assert harness.deletes == ['files/synthetic-1']


@pytest.mark.parametrize('failure', [ValueError('Synthetic failure'), KeyboardInterrupt('Synthetic cancellation')])
def test_upload_ownership_is_immediate_even_when_processing_never_succeeds(tmp_path, monkeypatch, failure):
    harness = Harness(cleanup_error=True)
    part = local_parts(tmp_path)[0]

    def wait(*_args, **_kwargs):
        raise failure

    monkeypatch.setattr('lecture_processor.runtime.media_runtime.wait_for_file_processing', wait)
    session = session_for(harness.runtime, monkeypatch)
    with pytest.raises(type(failure)) as raised:
        with session:
            session.upload_file(STAGE, part, operation_name=UPLOAD)
            session.wait_for_file(STAGE, part, operation_name=PROCESSING)
    assert raised.value is failure
    session.close()
    assert len(harness.uploads) == 1
    assert harness.deletes == ['files/synthetic-1']
    assert harness.generations == []
    assert part.path.is_file()


def test_exit_after_upload_cleans_up_before_any_processing_phase(tmp_path, monkeypatch):
    harness = Harness()
    part = local_parts(tmp_path)[0]
    failure = ValueError('Synthetic caller failure between phases')
    with pytest.raises(ValueError) as raised:
        with session_for(harness.runtime, monkeypatch) as session:
            session.upload_file(STAGE, part, operation_name=UPLOAD)
            raise failure
    assert raised.value is failure
    assert harness.polls == harness.generations == []
    assert harness.deletes == ['files/synthetic-1']
    assert part.path.is_file()


@pytest.mark.parametrize('ready', [False, True], ids=['pending', 'ready'])
@pytest.mark.parametrize('operation', ['upload', 'wait', 'generate'])
def test_prepared_resource_cannot_move_to_another_client(tmp_path, monkeypatch, ready, operation):
    original, replacement = Harness(), Harness()
    part = local_parts(tmp_path)[0]
    with session_for(original.runtime, monkeypatch) as session:
        session.upload_file(STAGE, part, operation_name=UPLOAD)
        if ready:
            session.wait_for_file(STAGE, part, operation_name=PROCESSING)
        original.runtime.client = replacement.client
        with pytest.raises(RuntimeError, match='client changed'):
            if operation == 'generate':
                session.generate(STAGE, [part])
            else:
                method = session.upload_file if operation == 'upload' else session.wait_for_file
                method(STAGE, part, operation_name=UPLOAD)
    assert replacement.uploads == replacement.polls == replacement.generations == replacement.deletes == []
    assert original.deletes == ['files/synthetic-1']


def test_same_path_with_different_mime_is_not_a_shared_resource(tmp_path, monkeypatch):
    harness = Harness()
    path = local_parts(tmp_path)[0].path
    with session_for(harness.runtime, monkeypatch) as session:
        for part in (PdfPart(path), ImagePart(path, 'image/png')):
            session.upload_file(STAGE, part, operation_name=UPLOAD)
            session.wait_for_file(STAGE, part, operation_name=PROCESSING)
    assert [call['config']['mime_type'] for call in harness.uploads] == ['application/pdf', 'image/png']
    assert harness.deletes == ['files/synthetic-1', 'files/synthetic-2']


@pytest.mark.parametrize('method', ['upload_file', 'wait_for_file'])
@pytest.mark.parametrize('part', [TextPart('text'), object(), PdfPart(''), PdfPart(None),
                                  ImagePart('synthetic', ''), AudioPart('synthetic', None)])
def test_invalid_preparation_part_is_rejected_before_resolving_client(monkeypatch, method, part):
    class GuardedRuntime:
        @property
        def client(self):
            pytest.fail('Invalid preparation must not resolve a client')

    with session_for(GuardedRuntime(), monkeypatch) as session:
        with pytest.raises(ValueError):
            getattr(session, method)(STAGE, part, operation_name=UPLOAD)


@pytest.mark.parametrize('method', ['upload_file', 'wait_for_file'])
def test_unknown_stage_and_closed_session_reject_before_resource_access(monkeypatch, method):
    harness = Harness()
    session = session_for(harness.runtime, monkeypatch)
    with pytest.raises(ValueError, match='Unknown generation stage'):
        getattr(session, method)('not-a-stage', PdfPart('not-opened'), operation_name=UPLOAD)
    session.close()
    with pytest.raises(RuntimeError, match='closed'):
        getattr(session, method)(STAGE, PdfPart('not-opened'), operation_name=UPLOAD)
    assert harness.uploads == harness.polls == harness.generations == harness.deletes == []


def openrouter_route():
    return Route('openrouter', 'anthropic/claude-sonnet-5.5',
                 {'reasoning_effort': 'low', 'max_output_tokens': 32768})


@pytest.mark.parametrize('forced', [False, True], ids=['normal', 'forced-fake'])
@pytest.mark.parametrize('part', [PdfPart('missing-synthetic.pdf'), ImagePart(Path('missing-synthetic.png'))])
def test_openrouter_preparation_validates_shape_but_does_not_claim_file_readiness(monkeypatch, forced, part):
    def forbidden(*_args, **_kwargs):
        pytest.fail('OpenRouter preparation must not construct adapters or inspect local files')

    class GuardedRuntime:
        @property
        def client(self):
            forbidden()

    monkeypatch.setattr(factory, 'GeminiProvider', forbidden)
    monkeypatch.setattr('lecture_processor.domains.ai.providers.fake.FakeProvider', forbidden)
    monkeypatch.setattr('lecture_processor.domains.ai.providers.openrouter.OpenRouterProvider', forbidden)
    with session_for(GuardedRuntime(), monkeypatch, route=openrouter_route(), forced=forced) as session:
        # Even path resolution/stat is deferred. No-op success does not assert
        # existence, readability, content validity or remote readiness.
        with monkeypatch.context() as files:
            for name in ('resolve', 'stat', 'open', 'read_bytes'):
                files.setattr(Path, name, forbidden)
            tracker = {'existing': 2}
            assert session.upload_file(STAGE, part, operation_name=UPLOAD, retry_tracker=tracker) is None
            assert session.wait_for_file(STAGE, part, operation_name=PROCESSING, retry_tracker=tracker) is None
            assert tracker == {'existing': 2}


def test_openrouter_noop_defers_missing_file_validation_until_generation(tmp_path, monkeypatch):
    from lecture_processor.domains.ai.providers import openrouter_request

    attempted_reads = []
    original = openrouter_request._read_file

    def read_file(path, max_bytes):
        attempted_reads.append(path)
        return original(path, max_bytes)

    def no_client(_self):
        pytest.fail('Missing file validation must precede SDK creation or key access')

    monkeypatch.setattr(openrouter_request, '_read_file', read_file)
    monkeypatch.setattr('lecture_processor.domains.ai.providers.openrouter.OpenRouterProvider._ensure_client', no_client)
    part = PdfPart(tmp_path / 'missing.pdf')
    tracker = {'unrelated': 1}
    with session_for(SimpleNamespace(), monkeypatch, route=openrouter_route()) as session:
        session.upload_file(STAGE, part, operation_name=UPLOAD, retry_tracker=tracker)
        session.wait_for_file(STAGE, part, operation_name=PROCESSING, retry_tracker=tracker)
        assert attempted_reads == []
        with pytest.raises(ValueError, match='Invalid generation input'):
            session.generate(STAGE, [part], operation_name=GENERATE, retry_tracker=tracker)
    assert attempted_reads == [part.path]
    assert tracker == {'unrelated': 1}


@pytest.mark.parametrize('stage,part', [(STAGE, AudioPart('not-opened', 'audio/wav')),
                                       ('audio_transcription', PdfPart('not-opened'))])
@pytest.mark.parametrize('method', ['upload_file', 'wait_for_file'])
def test_openrouter_audio_lock_precedes_client_and_file_access(monkeypatch, stage, part, method):
    class GuardedRuntime:
        @property
        def client(self):
            pytest.fail('Audio lock must precede resource access')

    with session_for(GuardedRuntime(), monkeypatch, route=openrouter_route(), stage=stage) as session:
        with pytest.raises(ValueError, match='Audio generation requires Gemini'):
            getattr(session, method)(stage, part, operation_name=UPLOAD)


@pytest.mark.parametrize('route', [Route('unsupported', MODEL), SimpleNamespace(
    provider='openrouter', model='not-an-approved-model', options={})])
def test_invalid_route_cannot_be_a_successful_preparation_noop(monkeypatch, route):
    with session_for(SimpleNamespace(), monkeypatch, route=route) as session:
        with pytest.raises(ValueError):
            session.upload_file(STAGE, PdfPart('not-opened'), operation_name=UPLOAD)


def test_forced_fake_preparation_shares_generation_cache_and_isolates_sessions(monkeypatch):
    response = SimpleNamespace(text='Synthetic response', usage_metadata=None)
    client = FakeGeminiClient({'models.generate_content': [response, response]})
    runtime = SimpleNamespace(client=client, types=SimpleNamespace(), MODEL_THINKING_POLICY={})
    first = session_for(runtime, monkeypatch, forced=True)
    second = session_for(runtime, monkeypatch, forced=True)
    try:
        for session in (first, second):
            part = PdfPart('this-synthetic-file-is-never-read.pdf')
            session.upload_file(STAGE, part, operation_name=UPLOAD)
            session.wait_for_file(STAGE, part, operation_name=PROCESSING)
            result = session.generate(STAGE, [part])
            assert result.provider == 'fake'
            assert result.text == 'Synthetic response'
        assert client.calls.count('files.upload') == 2
        assert client.calls.count('files.get') == 2
        assert client.calls.count('models.generate_content') == 2
        assert client.calls.count('files.delete') == 0
    finally:
        first.close()
        second.close()
    assert client.calls.count('files.delete') == 2


def test_existing_lazy_generation_still_builds_config_before_upload(tmp_path):
    harness = Harness()
    failure = ValueError('Synthetic config failure')

    def config(**_kwargs):
        raise failure

    harness.runtime.types = SimpleNamespace(GenerateContentConfig=config)
    with GeminiProvider(harness.runtime) as adapter:
        with pytest.raises(ValueError) as raised:
            adapter.generate(MODEL, [local_parts(tmp_path)[0]])
    assert raised.value is failure
    assert harness.uploads == harness.polls == harness.generations == harness.deletes == []
