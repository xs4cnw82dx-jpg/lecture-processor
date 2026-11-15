"""Provider behavior with injected clients and synthetic local content only."""
from collections import deque
from dataclasses import FrozenInstanceError
from types import SimpleNamespace

import pytest
from google.genai import types

from lecture_processor.domains.ai.providers.contracts import AudioPart, ImagePart, PdfPart, TextPart, Usage
from lecture_processor.domains.ai.providers.gemini import GeminiProvider


MODEL = 'synthetic-model'
OPERATION = 'existing-generation-label'


class Harness:
    def __init__(self, *, typed=True, outcomes=(), processing_error=None, cleanup_error=False):
        self.generations = []
        self.uploads = []
        self.polls = []
        self.deletes = []
        self.sleeps = []
        self.warnings = []
        self.handles = {}
        self.outcomes = deque(outcomes)
        self.parsed = {'answer': 'synthetic'}
        self.response = SimpleNamespace(
            text='  Exact synthetic response\n', parsed=self.parsed,
            usage_metadata=SimpleNamespace(prompt_token_count=11, candidates_token_count=7,
                                           thoughts_token_count=3, total_token_count=37),
        )

        def generate(**kwargs):
            self.generations.append(kwargs)
            outcome = self.outcomes.popleft() if self.outcomes else self.response
            if isinstance(outcome, BaseException):
                raise outcome
            return outcome

        def upload(**kwargs):
            self.uploads.append(kwargs)
            handle = SimpleNamespace(name=f'files/synthetic-{len(self.uploads)}',
                                     uri=f'https://example.test/files/{len(self.uploads)}',
                                     state=SimpleNamespace(name='ACTIVE'))
            self.handles[handle.name] = handle
            return handle

        def get(*, name):
            self.polls.append(name)
            if processing_error is not None:
                raise processing_error
            return self.handles[name]

        def delete(*, name):
            self.deletes.append(name)
            if cleanup_error:
                raise RuntimeError('Synthetic cleanup failure')

        self.client = SimpleNamespace(
            models=SimpleNamespace(generate_content=generate),
            files=SimpleNamespace(upload=upload, get=get, delete=delete),
        )
        self.runtime = SimpleNamespace(
            client=self.client, types=types if typed else SimpleNamespace(),
            MODEL_THINKING_POLICY={MODEL: {'thinking_level': 'high'}},
            PROVIDER_RETRY_MAX_ATTEMPTS=3, PROVIDER_RETRY_BASE_SECONDS=0.25,
            PROVIDER_RETRY_MAX_SECONDS=1.0, PROVIDER_TRANSIENT_STATUS_CODES={503},
            PROVIDER_TRANSIENT_MESSAGE_HINTS=('timeout',),
            random=SimpleNamespace(uniform=lambda _low, _high: 0.0),
            time=SimpleNamespace(sleep=self.sleeps.append),
            logger=SimpleNamespace(warning=lambda *args: self.warnings.append(args)),
        )


def local_parts(tmp_path):
    paths = [tmp_path / name for name in ('synthetic.pdf', 'synthetic.png', 'synthetic.wav')]
    for path in paths:
        path.write_bytes(b'Synthetic local fixture; never uploaded to a real service.')
    return [PdfPart(paths[0]), ImagePart(paths[1]), AudioPart(paths[2], 'audio/wav')]


def serialized_config(call):
    config = call['config']
    return config.model_dump(mode='json', exclude_none=True) if hasattr(config, 'model_dump') else config


def serialized_contents(call):
    return [item.model_dump(mode='json', exclude_none=True) if hasattr(item, 'model_dump') else item
            for item in call['contents']]


@pytest.mark.parametrize('typed', [True, False], ids=['typed', 'dict'])
def test_ordered_neutral_parts_schema_omission_and_normalized_result(tmp_path, typed):
    harness = Harness(typed=typed)
    files = local_parts(tmp_path)
    parts = [TextPart('  First\n'), files[0], TextPart('middle'), files[1], files[2], TextPart('last  ')]
    tracker = {}
    with GeminiProvider(harness.runtime) as adapter:
        result = adapter.generate(MODEL, parts, max_output_tokens=8192,
                                  retry_tracker=tracker, operation_name=OPERATION)
        assert harness.deletes == []
    assert len(harness.generations) == 1
    call = harness.generations[0]
    assert call['model'] == MODEL
    expected_config = {'max_output_tokens': 8192}
    if typed:
        expected_config['thinking_config'] = {'thinking_level': 'HIGH'}
    assert serialized_config(call) == expected_config
    assert serialized_contents(call) == [{'role': 'user', 'parts': [
        {'text': '  First\n'},
        {'file_data': {'file_uri': 'https://example.test/files/1', 'mime_type': 'application/pdf'}},
        {'text': 'middle'},
        {'file_data': {'file_uri': 'https://example.test/files/2', 'mime_type': 'image/png'}},
        {'file_data': {'file_uri': 'https://example.test/files/3', 'mime_type': 'audio/wav'}},
        {'text': 'last  '},
    ]}]
    assert result.text == '  Exact synthetic response\n'
    assert result.parsed is harness.parsed
    assert result.raw_response is harness.response
    assert (result.provider, result.model) == ('gemini', MODEL)
    assert result.usage == Usage(input_tokens=11, output_tokens=10, total_tokens=37, thinking_tokens=3)
    assert tracker == {OPERATION: 0, OPERATION + ':upload': 0, OPERATION + ':processing': 0}
    assert harness.deletes == list(harness.handles)
    assert all(part.path.read_bytes().startswith(b'Synthetic local fixture') for part in files)
    with pytest.raises(FrozenInstanceError):
        result.provider = 'different'


@pytest.mark.parametrize('typed', [True, False], ids=['typed', 'dict'])
def test_explicit_schema_is_sent_without_changing_the_result(typed):
    harness = Harness(typed=typed)
    schema = {'type': 'object', 'properties': {'answer': {'type': 'string'}}, 'required': ['answer']}
    with GeminiProvider(harness.runtime) as adapter:
        result = adapter.generate(MODEL, [TextPart('Synthetic schema request')], schema=schema)
    config = serialized_config(harness.generations[0])
    assert config['response_mime_type'] == 'application/json'
    assert config['response_schema']['properties']['answer']['type'].lower() == 'string'
    assert config['response_schema']['required'] == ['answer']
    assert result.parsed is harness.parsed
    assert result.raw_response is harness.response
    assert schema == {'type': 'object', 'properties': {'answer': {'type': 'string'}}, 'required': ['answer']}


@pytest.mark.parametrize('file_kind', ['pdf', 'image', 'audio'])
def test_file_preparation_is_shared_across_generation_retry_and_workflow_calls(tmp_path, file_kind):
    files = dict(zip(('pdf', 'image', 'audio'), local_parts(tmp_path)))
    harness = Harness(outcomes=[TimeoutError('synthetic timeout')])
    tracker = {}
    adapter = GeminiProvider(harness.runtime)
    with adapter:
        for _ in range(2):
            result = adapter.generate(MODEL, [files[file_kind], TextPart('Synthetic request')],
                                      retry_tracker=tracker, operation_name=OPERATION)
            assert result.raw_response is harness.response
        assert harness.deletes == []
    adapter.close()
    assert len(harness.uploads) == len(harness.polls) == 1
    assert len(harness.generations) == 3
    assert harness.generations[0]['contents'] is harness.generations[1]['contents']
    assert harness.generations[0]['config'] is harness.generations[1]['config']
    assert harness.sleeps == [0.25]
    assert tracker == {OPERATION: 1, OPERATION + ':upload': 0, OPERATION + ':processing': 0}
    assert harness.deletes == ['files/synthetic-1']
    assert files[file_kind].path.is_file()
    with pytest.raises(RuntimeError, match='closed'):
        adapter.generate(MODEL, [TextPart('No later generation')])
    assert len(harness.generations) == 3


@pytest.mark.parametrize('failure_kind', ['nonretryable', 'exhausted', 'cancellation'])
@pytest.mark.parametrize('cleanup_error', [False, True], ids=['cleanup-success', 'cleanup-failure'])
def test_generation_failure_or_cancellation_closes_files_without_replacing_error(tmp_path, failure_kind, cleanup_error):
    failure = {'nonretryable': ValueError('Synthetic rejected request'),
               'exhausted': TimeoutError('Synthetic timeout'),
               'cancellation': KeyboardInterrupt('Synthetic cancellation')}[failure_kind]
    expected_attempts = 3 if failure_kind == 'exhausted' else 1
    harness = Harness(outcomes=[failure] * expected_attempts, cleanup_error=cleanup_error)
    files = local_parts(tmp_path)
    adapter = GeminiProvider(harness.runtime)
    with pytest.raises(type(failure)) as raised:
        with adapter:
            adapter.generate(MODEL, files, operation_name=OPERATION)
    adapter.close()
    assert raised.value is failure
    assert len(harness.generations) == expected_attempts
    assert len(harness.uploads) == len(harness.polls) == 3
    assert harness.deletes == ['files/synthetic-1', 'files/synthetic-2', 'files/synthetic-3']
    assert all(part.path.is_file() for part in files)
    cleanup_warnings = [message for message in harness.warnings if message == ('Could not clean up a provider workflow file.',)]
    assert len(cleanup_warnings) == (3 if cleanup_error else 0)


def test_cleanup_failure_does_not_replace_a_successful_result(tmp_path):
    harness = Harness(cleanup_error=True)
    with GeminiProvider(harness.runtime) as adapter:
        result = adapter.generate(MODEL, local_parts(tmp_path))
    assert result.raw_response is harness.response
    assert harness.deletes == ['files/synthetic-1', 'files/synthetic-2', 'files/synthetic-3']
    assert len(harness.warnings) == 3


def test_processing_failure_still_cleans_up_uploaded_handle_once(tmp_path):
    failure = ValueError('Synthetic processing rejection')
    harness = Harness(processing_error=failure)
    files = local_parts(tmp_path)
    adapter = GeminiProvider(harness.runtime)
    with pytest.raises(ValueError) as raised:
        with adapter:
            adapter.generate(MODEL, files)
    adapter.close()
    assert raised.value is failure
    assert len(harness.uploads) == len(harness.polls) == 1
    assert harness.generations == []
    assert harness.deletes == ['files/synthetic-1']
    assert all(part.path.is_file() for part in files)


@pytest.mark.parametrize('bad_part', [object(), TextPart(None), ImagePart('unused', ''), AudioPart('unused', None)],
                         ids=['unknown-type', 'invalid-text', 'empty-image-mime', 'invalid-audio-mime'])
def test_invalid_part_list_is_rejected_before_any_file_or_generation_io(tmp_path, bad_part):
    harness = Harness()
    files = local_parts(tmp_path)
    with GeminiProvider(harness.runtime) as adapter:
        with pytest.raises(ValueError):
            adapter.generate(MODEL, [files[0], bad_part])
    assert harness.uploads == harness.polls == harness.generations == harness.deletes == []


def test_cached_file_cannot_move_to_a_replacement_client(tmp_path):
    harness = Harness()
    replacement = Harness()
    files = local_parts(tmp_path)
    with GeminiProvider(harness.runtime) as adapter:
        adapter.generate(MODEL, [files[0]])
        harness.runtime.client = replacement.client
        with pytest.raises(RuntimeError, match='client changed'):
            adapter.generate(MODEL, [files[0]])
    assert replacement.generations == replacement.uploads == replacement.polls == replacement.deletes == []
    assert harness.deletes == ['files/synthetic-1']
    assert files[0].path.is_file()


@pytest.mark.parametrize('metadata', [None, SimpleNamespace(), SimpleNamespace(
    prompt_token_count=None, candidates_token_count=None, thoughts_token_count=None, total_token_count=None)])
def test_absent_usage_fields_stay_zero_and_absent_parsed_stays_optional(metadata):
    response = SimpleNamespace(text='  unchanged  ', usage_metadata=metadata)
    harness = Harness(outcomes=[response])
    with GeminiProvider(harness.runtime) as adapter:
        result = adapter.generate(MODEL, [TextPart('Synthetic request')])
    assert result.usage == Usage()
    assert result.parsed is None
    assert result.raw_response is response
    assert result.text == '  unchanged  '


def route_snapshot(model='gemini-synthetic-original'):
    from lecture_processor.domains.ai.providers.routing import STAGES, parse_routing
    defaults = {stage: model for stage in STAGES}
    payload = {stage: {'provider': 'gemini', 'model': model, 'options': {}} for stage in STAGES}
    return parse_routing(payload, defaults)


@pytest.mark.parametrize('stage', ['slides_extractoin', MODEL, OPERATION, None, []])
def test_session_rejects_unknown_stage_before_resolving_a_client(stage):
    from lecture_processor.domains.ai.providers.factory import open_provider_session

    class UnavailableClientRuntime:
        @property
        def client(self):
            pytest.fail('An unknown stage must not resolve a generation client')

    with open_provider_session(UnavailableClientRuntime(), routes=route_snapshot()) as session:
        with pytest.raises(ValueError, match=r'^Unknown generation stage\.$'):
            session.generate(stage, [TextPart('Synthetic content')])


def test_open_session_keeps_its_route_when_runtime_snapshot_changes(monkeypatch):
    from lecture_processor.domains.ai.providers.factory import open_provider_session
    from lecture_processor.domains.ai.providers.fake import FakeGeminiClient

    # Keep forced isolation enabled; explicit scripts supply each synthetic result.
    monkeypatch.setenv('LP_FORCE_FAKE_PROVIDER', '1')
    monkeypatch.setenv('APP_ENV', 'test')
    harness = Harness()
    harness.runtime.client = FakeGeminiClient({'models.generate_content': [harness.response] * 3})
    harness.runtime.AI_ROUTING_SNAPSHOT = route_snapshot()
    with open_provider_session(harness.runtime) as original:
        first = original.generate('slides_extraction', [TextPart('First request')])
        harness.runtime.AI_ROUTING_SNAPSHOT = route_snapshot('gemini-synthetic-replacement')
        second = original.generate('slides_extraction', [TextPart('Second request')])
        with open_provider_session(harness.runtime) as replacement:
            third = replacement.generate('slides_extraction', [TextPart('New workflow')])
    assert first.model == second.model == 'gemini-synthetic-original'
    assert third.model == 'gemini-synthetic-replacement'
    assert first.provider == second.provider == third.provider == 'fake'
    assert harness.runtime.client.calls == ('models.generate_content',) * 3
    with pytest.raises(RuntimeError, match='closed'):
        original.generate('slides_extraction', [TextPart('Closed workflow')])
    assert harness.runtime.client.calls == ('models.generate_content',) * 3
