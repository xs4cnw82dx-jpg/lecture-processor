"""Document completion checks exercised with synthetic provider responses."""
import logging
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai.providers.contracts import TextPart
from lecture_processor.domains.ai.providers.errors import ProviderRequestError
from lecture_processor.domains.ai.providers.factory import ProviderSession
from lecture_processor.domains.ai.providers.gemini import normalize_response
from lecture_processor.domains.ai.providers.openrouter_response import parse_response
from lecture_processor.domains.ai.providers.routing import Route, RoutingSnapshot


MODEL = 'anthropic/claude-sonnet-5.5'


def response(text, reason='stop', *, input_tokens=10):
    return parse_response({'choices': [{'finish_reason': reason, 'message': {'content': text}}],
                           'usage': {'prompt_tokens': input_tokens, 'completion_tokens': 5,
                                     'total_tokens': input_tokens + 5, 'cost': 0.001}}, model=MODEL)


def native(text, finish):
    return normalize_response(SimpleNamespace(text=text, candidates=[SimpleNamespace(finish_reason=finish)]),
                              'gemini-synthetic')


def setup_session(monkeypatch, stage, responses, *, retry_limit=None):
    options = {'reasoning_effort': 'medium', 'max_output_tokens': 64}
    if retry_limit is not None:
        options['retry_max_output_tokens'] = retry_limit
    runtime = SimpleNamespace(MODEL_INTEGRATION='gemini-synthetic', MODEL_SLIDES='gemini-synthetic',
                              logger=logging.getLogger('synthetic.docs'))
    route = Route('openrouter', MODEL, options)
    session = ProviderSession(runtime, routes=RoutingSnapshot({stage: route}))
    calls = []

    def generate(model, parts, **kwargs):
        calls.append((model, parts, kwargs))
        result = responses[len(calls) - 1]
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(session, '_adapter', lambda _: SimpleNamespace(generate=generate))
    return session, calls


def test_partial_notes_retry_once_at_the_configured_ceiling(monkeypatch):
    first = response('unfinished', 'length')
    session, calls = setup_session(monkeypatch, 'notes_merge', [first, response('complete')], retry_limit=128)
    discarded = {}
    result = session.generate('notes_merge', [TextPart('source')], max_output_tokens=96,
                              record_discarded=discarded.__setitem__)
    assert result.text == 'complete'
    assert [call[2]['max_output_tokens'] for call in calls] == [64, 96]
    assert list(discarded.values()) == [first]


def test_second_truncation_uses_native_model_and_original_request(monkeypatch):
    session, calls = setup_session(monkeypatch, 'notes_merge',
                                   [response('cut', 'length'), response('cut again', 'length'),
                                    native('complete', 'STOP')], retry_limit=128)
    discarded = {}
    parts = [TextPart('original prompt')]
    result = session.generate('notes_merge', parts, record_discarded=discarded.__setitem__)
    assert result.text == 'complete'
    assert [call[0] for call in calls] == [MODEL, MODEL, 'gemini-synthetic']
    assert list(calls[-1][1]) == parts
    assert len(discarded) == 2


@pytest.mark.parametrize('stage', ['slides_extraction', 'text_combine', 'notes_merge'])
def test_exhausted_provider_failure_falls_back_once_and_rejects_incomplete_native_result(monkeypatch, stage):
    session, calls = setup_session(monkeypatch, stage,
                                   [ProviderRequestError('http_error', http_status=503),
                                    native('also cut', 'MAX_TOKENS')])
    discarded = {}
    with pytest.raises(ProviderRequestError, match='INCOMPLETE'):
        session.generate(stage, [TextPart('source')], record_discarded=discarded.__setitem__)
    assert len(calls) == 2
    assert len(discarded) == 1


@pytest.mark.parametrize('code', [400, 401, 403])
def test_configuration_and_policy_denials_do_not_send_content_to_another_provider(monkeypatch, code):
    err = ProviderRequestError('http_error', http_status=code)
    session, calls = setup_session(monkeypatch, 'slides_extraction', [err])
    with pytest.raises(ProviderRequestError) as exc:
        session.generate('slides_extraction', [TextPart('source')])
    assert exc.value is err and len(calls) == 1


def test_only_grounded_markers_survive_and_source_language_is_preserved(monkeypatch):
    slides = '[Informatieve Afbeelding/Tabel: Afstand 15 mm]\n[Decorative Image]'
    result_text = ('A [Informatieve Afbeelding/Tabel: Afstand 15 mm] B [Informative Image/Table: 20 mm] '
                   'C [Decorative Image] D [Note 2]\n<!-- audio:0-200 -->')
    session, _ = setup_session(monkeypatch, 'notes_merge', [response(result_text)])
    result = session.generate('notes_merge', [TextPart('transcript mentions 20 mm')], source_slide_text=slides)
    assert result.text == 'A [Informative Image/Table: Afstand 15 mm] B  C  D [Note 2]\n<!-- audio:0-200 -->'


def test_large_prompt_logs_actual_token_count_without_source_content(monkeypatch, caplog):
    session, _ = setup_session(monkeypatch, 'text_combine', [response('complete', input_tokens=100001)])
    with caplog.at_level(logging.INFO):
        session.generate('text_combine', [TextPart('private synthetic text')])
    assert '100001' in caplog.text and 'text_combine' in caplog.text
    assert 'private synthetic text' not in caplog.text


@pytest.mark.parametrize('http_status,provider_code', [(403, 503), (503, 403), (404, 429), (429, 404)])
def test_conflicting_status_never_bypasses_definitive_denial(monkeypatch, http_status, provider_code):
    error = ProviderRequestError('http_error', http_status=http_status, provider_code=provider_code)
    session, calls = setup_session(monkeypatch, 'notes_merge', [error])
    with pytest.raises(ProviderRequestError) as exc:
        session.generate('notes_merge', [TextPart('source')])
    assert exc.value is error and not error.retryable and len(calls) == 1


def test_caller_without_headroom_goes_straight_to_fallback_after_truncation(monkeypatch):
    session, calls = setup_session(monkeypatch, 'notes_merge', [response('cut', 'length'), native('all', 'STOP')],
                                   retry_limit=128)
    result = session.generate('notes_merge', [TextPart('source')], max_output_tokens=32)
    assert result.text == 'all'
    assert [(call[0], call[2]['max_output_tokens']) for call in calls] == [(MODEL, 32), ('gemini-synthetic', 32)]


@pytest.mark.parametrize(('stage', 'prefix'), [
    ('notes_merge', 'Informative Image/Table'), ('text_combine', 'Informatieve Afbeelding/Tabel'),
])
def test_document_marker_syntax_follows_stage_contract_and_preserves_source_description(monkeypatch, stage, prefix):
    slides = '[Informatieve Afbeelding/Tabel: Meetlat 15 mm]'
    reply = 'Measure carefully. [Informative Image/Table: Meetlat 15 mm] [Informative Image/Table: 15 mM]'
    session, _ = setup_session(monkeypatch, stage, [response(reply)])
    result = session.generate(stage, [TextPart('Write the surrounding text in English.')], source_slide_text=slides)
    assert result.text == f'Measure carefully. [{prefix}: Meetlat 15 mm] '


def test_transcript_only_cannot_introduce_a_slide_marker(monkeypatch):
    session, _ = setup_session(monkeypatch, 'text_combine',
                               [response('Tekst. [Informatieve Afbeelding/Tabel: Spier]')])
    result = session.generate('text_combine', [TextPart('Transcript only.')])
    assert result.text == 'Tekst. '
