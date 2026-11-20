"""Text generation prompts, stage routing, usage, and session ownership."""
from copy import deepcopy
import logging
import socket
from types import SimpleNamespace

from google.genai import types
import pytest

from lecture_processor.domains.ai import study_generation
from lecture_processor.domains.ai.providers import factory
from lecture_processor.domains.ai.providers.contracts import GenerationResult, TextPart, Usage
from lecture_processor.domains.ai.providers.fake import FakeGeminiClient, FakeProviderError
from lecture_processor.domains.ai.providers.routing import Route, RoutingSnapshot
from lecture_processor.services import interview_coding_service as service
from tests.test_interview_coding_background import coding, start  # noqa: F401
from tests.test_study_tools_regeneration import regeneration  # noqa: F401


OPEN_SESSION = factory.open_provider_session
MODEL = 'gemini-synthetic-configured-study'
STUDY_TEXT = 'Result:\n```json\n{"flashcards":[{"front":"Osmosis","back":"Water"}]}\n``` trailing'
STUDY_TEMPLATE = '  cards={flashcard_amount};questions={question_amount};lang={output_language}\n{source_text}\nEND  '
STUDY_PROMPT = '  cards=2;questions=0;lang=Dutch\n  exact source\nline two  \nEND  '
SOURCE = '  exact source\nline two  '
CODING_TEXTS = [
    '{"codes":[{"temp_id":"c1","name":"Guidance"}],"quotations":[]}',
    '{"codes":[{"temp_id":"c2","name":"Evidence"}],"quotations":[]}',
]


def native_result(text):
    return SimpleNamespace(text=text, usage_metadata=SimpleNamespace(
        prompt_token_count=11, candidates_token_count=7, thoughts_token_count=3, total_token_count=37))


class CapturingClient(FakeGeminiClient):
    def __init__(self, outcomes):
        self.requests = []
        super().__init__({'models.generate_content': outcomes})

    def _generate_content(self, **kwargs):
        self.requests.append(kwargs)
        return super()._generate_content(**kwargs)


def runtime_for(outcomes):
    return SimpleNamespace(
        client=CapturingClient(outcomes), types=types, MODEL_STUDY=MODEL,
        AI_ROUTING_SNAPSHOT=RoutingSnapshot({stage: Route('gemini', MODEL) for stage in (
            'study_tools', 'regenerate_study_tools', 'interview_summary', 'interview_sections')}),
        MODEL_THINKING_POLICY={MODEL: {'thinking_level': 'high'}},
        PROMPT_STUDY_TEMPLATE=STUDY_TEMPLATE,
        PROMPT_INTERVIEW_SUMMARY='  SUMMARY {output_language}\n{transcript}\n  ',
        PROMPT_INTERVIEW_SECTIONED='  SECTIONS {output_language}\n{transcript}\n  ',
        PROVIDER_RETRY_MAX_ATTEMPTS=3, PROVIDER_RETRY_BASE_SECONDS=0.01,
        PROVIDER_RETRY_MAX_SECONDS=0.02, random=SimpleNamespace(uniform=lambda *_args: 0),
        time=SimpleNamespace(sleep=lambda _delay: None), logger=logging.getLogger('synthetic-text-migration'),
    )


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def blocked(*_args, **_kwargs):
        pytest.fail('Text migration tests must never use DNS or real sockets.')

    monkeypatch.setattr(socket, 'getaddrinfo', blocked)
    monkeypatch.setattr(socket.socket, 'connect', blocked)
    monkeypatch.setattr(socket.socket, 'connect_ex', blocked)


def prompt_from(call):
    contents = call['contents']
    assert len(contents) == 1
    if isinstance(contents[0], str):
        return contents[0]
    assert contents[0].role == 'user' and len(contents[0].parts) == 1
    return contents[0].parts[0].text


def assert_native_config(call, cap, model=MODEL):
    assert call['model'] == model
    assert call['config'].max_output_tokens == cap
    assert call['config'].response_schema is None and call['config'].response_mime_type is None


def assert_stage_usage(stage, model):
    assert stage == {'input_tokens': 11, 'output_tokens': 10, 'total_tokens': 37,
                     'model': model, 'billing_mode': 'standard', 'input_modality': 'text'}


@pytest.mark.parametrize('retry', [False, True])
def test_study_native_prompt_cap_usage_and_retry_control(retry):
    outcomes = ([FakeProviderError(503)] if retry else []) + [native_result(STUDY_TEXT)]
    runtime = runtime_for(outcomes)
    tracker = {}
    cards, questions, error, usage = study_generation.generate_study_materials(
        SOURCE, '2', '5', study_features='flashcards', output_language='Dutch',
        retry_tracker=tracker, runtime=runtime, include_usage=True)
    assert cards == [{'front': 'What is Osmosis?', 'back': 'Water'}]
    assert questions == [] and error is None
    assert len(runtime.client.requests) == 1 + int(retry)
    for call in runtime.client.requests:
        assert prompt_from(call) == STUDY_PROMPT
        assert_native_config(call, 32768)
        assert call['config'].thinking_config is not None
    if retry:
        assert runtime.client.requests[0]['config'] is runtime.client.requests[1]['config']
    assert tracker == {'study_materials_generation': int(retry)}
    assert_stage_usage(usage['token_usage_by_stage']['study_materials_generation'], MODEL)
    assert usage['token_output_total'] == 10 and usage['token_total'] == 37


def test_study_truncation_and_noop_control():
    runtime = runtime_for([native_result(STUDY_TEXT)])
    source = 'A' * 120000 + 'excluded-suffix'
    result = study_generation.generate_study_materials(source, '2', '5', study_features='flashcards',
                                                        runtime=runtime, include_usage=True)
    assert prompt_from(runtime.client.requests[0]) == '  cards=2;questions=0;lang=English\n' + 'A' * 120000 + '\nEND  '
    assert result[2] == 'Note: source text was very long and was truncated before study material generation.'
    assert study_generation.generate_study_materials('', '2', '5', study_features='none', runtime=runtime) == ([], [], None)
    assert len(runtime.client.requests) == 1


def test_interview_order_repeated_features_caps_and_totals_control():
    runtime = runtime_for([native_result('  sections  '), native_result('  first summary  '),
                           native_result('  last summary  ')])
    tracker = {}
    result = study_generation.generate_interview_enhancements(
        SOURCE, ['sections', 'summary', 'summary'], output_language='Dutch', retry_tracker=tracker, runtime=runtime)
    assert [prompt_from(call) for call in runtime.client.requests] == [
        f'  SECTIONS Dutch\n{SOURCE}\n  ', f'  SUMMARY Dutch\n{SOURCE}\n  ', f'  SUMMARY Dutch\n{SOURCE}\n  ']
    for call, cap in zip(runtime.client.requests, (32768, 8192, 8192)):
        assert_native_config(call, cap)
    assert result['summary'] == 'last summary' and result['sections'] == 'sections'
    assert result['successful_features'] == ['summary', 'sections']
    assert result['failed_count'] == 1 and result['error'] is None
    assert result['token_input_total'] == 33 and result['token_output_total'] == 30 and result['token_total'] == 111
    assert set(result['token_usage_by_stage']) == {'interview_summary_generation', 'interview_sections_generation'}
    assert_stage_usage(result['token_usage_by_stage']['interview_summary_generation'], MODEL)
    assert tracker == {'interview_sections_generation': 0, 'interview_summary_generation': 0}


@pytest.mark.parametrize('feature,cap', [('summary', 8192), ('sections', 32768)])
def test_interview_independent_feature_control(feature, cap):
    runtime = runtime_for([native_result('  independent output  ')])
    result = study_generation.generate_interview_enhancements(SOURCE, [feature], runtime=runtime)
    assert len(runtime.client.requests) == 1
    assert_native_config(runtime.client.requests[0], cap)
    assert result[feature] == 'independent output' and result['successful_features'] == [feature]
    assert result['combined'] is None and result['failed_count'] == 0


def setup_native_coding(coding, monkeypatch, outcomes):
    coding.runtime.MODEL_INTERVIEW_CODING = 'gemini-synthetic-configured-coding'
    coding.runtime.AI_ROUTING_SNAPSHOT = RoutingSnapshot({
        'interview_coding': Route('gemini', coding.runtime.MODEL_INTERVIEW_CODING)})
    coding.runtime.PROMPT_INTERVIEW_CODING = '  CODES\n{existing_codes_json}\nSEGMENTS\n{segments_json}\n  '
    coding.runtime.client = CapturingClient(outcomes)
    coding.runtime.types = types
    monkeypatch.setattr(factory, 'open_provider_session', OPEN_SESSION)
    monkeypatch.setattr(service.interview_coding, 'split_segments_for_ai', lambda segments: [segments, segments])


def test_coding_native_chunk_prompts_unique_usage_and_completion_control(coding, monkeypatch):
    setup_native_coding(coding, monkeypatch, [native_result(text) for text in CODING_TEXTS])
    run_id = start(coding)
    coding.work()
    calls = coding.runtime.client.requests
    assert len(calls) == 2
    segments = '[{"segment_id": "seg-1", "timestamp": "", "speaker": "", "text": "Hello world"}]'
    assert prompt_from(calls[0]) == '  CODES\n[]\nSEGMENTS\n' + segments + '\n  '
    assert prompt_from(calls[1]) == (
        '  CODES\n[{"code_id": "", "name": "Guidance", "description": "", "parent_code_id": ""}]\nSEGMENTS\n'
        + segments + '\n  ')
    for call in calls:
        assert_native_config(call, 32768, coding.runtime.MODEL_INTERVIEW_CODING)
    run = coding.docs('interview_ai_coding_runs')[run_id]
    assert run['status'] == 'draft' and [item['name'] for item in run['proposed_codes']] == ['Guidance', 'Evidence']
    assert set(run['token_usage_by_stage']) == {'interview_ai_coding_1', 'interview_ai_coding_2'}
    for usage in run['token_usage_by_stage'].values():
        assert_stage_usage(usage, coding.runtime.MODEL_INTERVIEW_CODING)


@pytest.mark.parametrize('admitted', [False, True])
def test_coding_start_and_between_chunk_terminal_guards_control(coding, monkeypatch, admitted):
    setup_native_coding(coding, monkeypatch, [native_result(CODING_TEXTS[0])])
    if not admitted:
        monkeypatch.setattr(service.coding_runs, 'start_processing', lambda *_args: False)
    monkeypatch.setattr(service.coding_runs, 'can_continue', lambda *_args: False)
    run_id = start(coding)
    coding.work()
    assert len(coding.runtime.client.requests) == int(admitted)
    assert coding.docs('interview_ai_coding_runs')[run_id]['status'] != 'draft'


class SessionSpy:
    def __init__(self, outputs):
        self.outputs = iter(outputs)
        self.calls = []
        self.closes = 0

    def generate(self, stage, parts, **kwargs):
        self.calls.append((stage, tuple(parts), kwargs))
        output = next(self.outputs)
        if isinstance(output, BaseException):
            raise output
        if isinstance(output, GenerationResult):
            return output
        # A conflicting parsed value catches accidental changes to tolerant text parsing.
        return GenerationResult(output, {'flashcards': []}, Usage(11, 10, 37, 3),
                                'gemini', 'gemini-configured-' + stage)

    def close(self):
        self.closes += 1

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()


def install_session(monkeypatch, session):
    opened = []

    def open_session(runtime, **_kwargs):
        opened.append(runtime)
        return session

    monkeypatch.setattr(factory, 'open_provider_session', open_session)
    return opened


def assert_call(call, stage, operation, cap, prompt, tracker=None):
    actual_stage, parts, options = call
    assert actual_stage == stage and parts == (TextPart(prompt),)
    assert options['operation_name'] == operation and options['max_output_tokens'] == cap
    assert options.get('schema') is None
    if tracker is not None:
        assert options['retry_tracker'] is tracker


@pytest.mark.parametrize('stage', ['study_tools', 'regenerate_study_tools'])
def test_study_stage_session_and_usage_boundary(stage):
    runtime = runtime_for([])
    session = SessionSpy([STUDY_TEXT])
    tracker = {}
    result = study_generation.generate_study_materials(
        SOURCE, '2', '5', study_features='flashcards', output_language='Dutch', retry_tracker=tracker,
        runtime=runtime, include_usage=True, provider_session=session, stage=stage)
    assert_call(session.calls[0], stage, 'study_materials_generation', 32768, STUDY_PROMPT, tracker)
    assert result[0] == [{'front': 'What is Osmosis?', 'back': 'Water'}]
    assert_stage_usage(result[3]['token_usage_by_stage']['study_materials_generation'], 'gemini-configured-' + stage)
    assert session.closes == 0 and runtime.client.requests == []


@pytest.mark.parametrize('output', [STUDY_TEXT, 'malformed synthetic output', RuntimeError('synthetic failure')])
def test_standalone_study_session_closes_once_on_all_outcomes(monkeypatch, output):
    runtime = runtime_for([])
    session = SessionSpy([output])
    opened = install_session(monkeypatch, session)
    study_generation.generate_study_materials(SOURCE, '2', '5', runtime=runtime)
    assert opened == [runtime] and len(session.calls) == 1 and session.closes == 1
    assert runtime.client.requests == []


def test_study_uses_configured_route_model_in_native_call_and_usage():
    runtime = runtime_for([native_result(STUDY_TEXT)])
    routed_model = 'gemini-explicit-stage-route'
    runtime.AI_ROUTING_SNAPSHOT = RoutingSnapshot({'study_tools': Route('gemini', routed_model)})
    result = study_generation.generate_study_materials(
        SOURCE, '2', '5', study_features='flashcards', runtime=runtime, include_usage=True)
    assert len(runtime.client.requests) == 1
    assert runtime.client.requests[0]['model'] == routed_model
    assert_stage_usage(result[3]['token_usage_by_stage']['study_materials_generation'], routed_model)


def test_regeneration_caller_supplies_its_explicit_stage(regeneration, monkeypatch):
    state, run = regeneration
    called = []

    def generated(*_args, **kwargs):
        called.append(kwargs)
        return ([{'front': 'What is movement?', 'back': 'Synthetic result'}], [], None, {
            'token_usage_by_stage': {'study_materials_generation': {
                'input_tokens': 11, 'output_tokens': 10, 'total_tokens': 37,
                'model': MODEL, 'billing_mode': 'standard', 'input_modality': 'text'}},
            'token_input_total': 11, 'token_output_total': 10, 'token_total': 37})

    monkeypatch.setattr(study_generation, 'generate_study_materials', generated)
    run('unused synthetic response', features='flashcards')
    assert len(called) == 1 and called[0].get('stage') == 'regenerate_study_tools'
    assert state['job']['status'] == 'complete' and state['refunds'] == []
    assert list(state['job']['token_usage_by_stage']) == ['study_materials_generation']


def test_no_generation_keeps_session_lazy_control(monkeypatch):
    runtime = runtime_for([])
    session = SessionSpy([])
    opened = install_session(monkeypatch, session)
    assert study_generation.generate_study_materials(SOURCE, '2', '5', study_features='none', runtime=runtime) == ([], [], None)
    study_generation.generate_interview_enhancements(SOURCE, [], runtime=runtime)
    study_generation.generate_interview_enhancements(SOURCE, ['unrecognized'], runtime=runtime)
    assert opened == [] and session.calls == [] and session.closes == 0


@pytest.mark.parametrize('summary_failure', [False, True])
def test_interview_sessions_keep_independent_results_and_operation_names(summary_failure):
    runtime = runtime_for([])
    outputs = [RuntimeError('synthetic summary failure') if summary_failure else '  summary  ', '  sections  ']
    session = SessionSpy(outputs)
    result = study_generation.generate_interview_enhancements(
        SOURCE, ['summary', 'sections'], output_language='Dutch', runtime=runtime, provider_session=session)
    for call, feature, cap in zip(session.calls, ['summary', 'sections'], [8192, 32768]):
        assert_call(call, 'interview_' + feature, 'interview_' + feature + '_generation', cap,
                    f'  {feature.upper()} Dutch\n{SOURCE}\n  ')
    assert len(session.calls) == 2 and session.closes == 0 and runtime.client.requests == []
    assert result['successful_features'] == (['sections'] if summary_failure else ['summary', 'sections'])
    assert result['failed_count'] == int(summary_failure)
    assert result['token_output_total'] == (10 if summary_failure else 20)


def test_repeated_interview_feature_preserves_last_map_entry_and_all_totals():
    runtime = runtime_for([])
    session = SessionSpy([' first ', ' last '])
    result = study_generation.generate_interview_enhancements(
        SOURCE, ['summary', 'summary'], runtime=runtime, provider_session=session)
    assert len(session.calls) == 2 and result['summary'] == 'last'
    assert result['token_input_total'] == 22 and result['token_output_total'] == 20 and result['token_total'] == 74
    assert list(result['token_usage_by_stage']) == ['interview_summary_generation']
    assert result['error'] is None and result['failed_count'] == 1 and session.closes == 0


@pytest.mark.parametrize('failed_summary', [False, True])
def test_standalone_interview_shares_one_owned_session(monkeypatch, failed_summary):
    runtime = runtime_for([])
    session = SessionSpy([RuntimeError('synthetic failure') if failed_summary else 'summary', 'sections'])
    opened = install_session(monkeypatch, session)
    result = study_generation.generate_interview_enhancements(SOURCE, ['summary', 'sections'], runtime=runtime)
    assert opened == [runtime] and len(session.calls) == 2 and session.closes == 1
    assert result['successful_features'] == (['sections'] if failed_summary else ['summary', 'sections'])
    assert runtime.client.requests == []


@pytest.mark.parametrize('stop', ['complete', 'not_admitted', 'between_chunks', 'parser_failure', 'provider_failure'])
def test_coding_owned_session_preserves_chunk_and_terminal_boundaries(coding, monkeypatch, stop):
    session = SessionSpy(CODING_TEXTS if stop != 'parser_failure' else ['malformed', 'malformed'])
    if stop == 'provider_failure':
        session = SessionSpy([RuntimeError('synthetic provider failure')])
    opened = install_session(monkeypatch, session)
    monkeypatch.setattr(service.interview_coding, 'split_segments_for_ai', lambda segments: [segments, segments])
    if stop == 'not_admitted':
        monkeypatch.setattr(service.coding_runs, 'start_processing', lambda *_args: False)
    if stop == 'between_chunks':
        monkeypatch.setattr(service.coding_runs, 'can_continue', lambda *_args: False)
    run_id = start(coding)
    before = deepcopy(coding.documents[('users', 'owner')])
    coding.work()
    count = {'not_admitted': 0, 'between_chunks': 1, 'provider_failure': 1}.get(stop, 2)
    assert len(session.calls) == count
    assert opened == ([] if stop == 'not_admitted' else [coding.runtime])
    assert session.closes == int(stop != 'not_admitted') and coding.provider_calls == 0
    for index, (stage, parts, options) in enumerate(session.calls, 1):
        assert stage == 'interview_coding' and len(parts) == 1 and isinstance(parts[0], TextPart)
        assert options['operation_name'] == f'interview_ai_coding_{index}'
        assert options['max_output_tokens'] == 32768 and options.get('schema') is None
    run = coding.docs('interview_ai_coding_runs')[run_id]
    if stop == 'complete':
        assert run['status'] == 'draft'
        assert set(run['token_usage_by_stage']) == {'interview_ai_coding_1', 'interview_ai_coding_2'}
        for usage in run['token_usage_by_stage'].values():
            assert_stage_usage(usage, 'gemini-configured-interview_coding')
        assert coding.documents[('users', 'owner')] == before
    elif stop in {'parser_failure', 'provider_failure'}:
        assert run['status'] == 'failed' and run['credit_refunded'] is True


@pytest.mark.parametrize('boundary', ['study', 'coding'])
def test_internal_usage_retains_provider_cost_and_counts_output_once(coding, monkeypatch, boundary):
    result = GenerationResult(
        STUDY_TEXT if boundary == 'study' else CODING_TEXTS[0], None,
        Usage(11, 10, 37, 3, 0.125), 'openrouter', 'synthetic-provider-model')
    session = SessionSpy([result])
    if boundary == 'study':
        generated = study_generation.generate_study_materials(
            SOURCE, '2', '5', study_features='flashcards', runtime=runtime_for([]),
            include_usage=True, provider_session=session)
        usage = generated[3]
        stages = usage['token_usage_by_stage']
        assert usage['token_output_total'] == 10 and usage['token_total'] == 37
    else:
        install_session(monkeypatch, session)
        run_id = start(coding)
        coding.work()
        run = coding.docs('interview_ai_coding_runs')[run_id]
        assert run['status'] == 'draft'
        stages = run['token_usage_by_stage']
    assert len(stages) == 1
    assert next(iter(stages.values())) == {
        'input_tokens': 11, 'output_tokens': 10, 'total_tokens': 37,
        'model': 'synthetic-provider-model', 'billing_mode': 'standard', 'input_modality': 'text',
        'provider': 'openrouter', 'thinking_tokens': 3, 'cost_usd': 0.125,
    }


def test_owned_helper_closes_once_without_swallowing_cancellation(monkeypatch):
    cancellation = KeyboardInterrupt('synthetic cancellation')
    session = SessionSpy([cancellation])
    runtime = runtime_for([])
    opened = install_session(monkeypatch, session)
    with pytest.raises(KeyboardInterrupt) as caught:
        study_generation.generate_study_materials(SOURCE, '2', '5', runtime=runtime)
    assert caught.value is cancellation
    assert opened == [runtime] and len(session.calls) == 1 and session.closes == 1
