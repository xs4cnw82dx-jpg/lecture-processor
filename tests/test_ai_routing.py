import json
from dataclasses import FrozenInstanceError
from pathlib import Path
from types import SimpleNamespace

import pytest

from lecture_processor.domains.admin.metrics import build_admin_runtime_checks
from lecture_processor.domains.ai.providers.routing import (
    AUDIO_STAGES,
    STAGES,
    Diagnostic,
    Route,
    RoutingSnapshot,
    default_models,
    load_routing,
    parse_routing,
    validate_routing,
)
from lecture_processor.runtime.container import get_runtime


@pytest.fixture
def defaults():
    return default_models(SimpleNamespace(
        MODEL_SLIDES='gemini-slides', MODEL_INTEGRATION='gemini-integration',
        MODEL_STUDY='gemini-study', MODEL_INTERVIEW_CODING='gemini-coding',
        MODEL_TOOLS='gemini-tools', MODEL_AUDIO='gemini-audio', MODEL_INTERVIEW='gemini-interview',
    ))


@pytest.fixture
def payload(defaults):
    return {stage: {'provider': 'gemini', 'model': model, 'options': {}}
            for stage, model in defaults.items()}


def test_checked_in_routes_preserve_all_current_runtime_models(app):
    defaults = default_models(get_runtime(app))
    path = Path(__file__).resolve().parents[1] / 'config' / 'ai_routing.json'
    snapshot = validate_routing(json.loads(path.read_text()), defaults)
    assert set(snapshot.routes) == STAGES
    assert len(snapshot.routes) == 14
    assert all(route.provider == 'gemini' and not route.options for route in snapshot.routes.values())
    assert {stage: route.model for stage, route in snapshot.routes.items()} == defaults
    assert snapshot.diagnostics == ()


def test_defaults_read_only_passed_runtime_constants(defaults):
    assert defaults['interview_summary'] == defaults['interview_sections'] == 'gemini-study'
    assert defaults['interview_coding'] == 'gemini-coding'
    assert defaults['interview_transcription'] == 'gemini-interview'
    assert defaults['tools_extraction'] == 'gemini-tools'
    assert defaults['notes_merge'] == defaults['text_combine'] == 'gemini-integration'
    with pytest.raises(TypeError):
        defaults['notes_merge'] = 'gemini-other'


def test_healthy_override_is_independent_of_bad_sibling(payload, defaults):
    payload['notes_merge']['model'] = 'gemini-reviewed-alternative'
    payload['slides_extraction']['provider'] = 'not-yet-registered'
    snapshot = parse_routing(payload, defaults)
    assert snapshot.routes['notes_merge'].model == 'gemini-reviewed-alternative'
    assert snapshot.routes['slides_extraction'] == Route('gemini', defaults['slides_extraction'])
    assert snapshot.diagnostics == (Diagnostic('slides_extraction', 'unsupported_provider'),)


@pytest.mark.parametrize('stage', sorted(STAGES))
def test_missing_stage_falls_back_only_that_stage(stage, payload, defaults):
    del payload[stage]
    snapshot = parse_routing(payload, defaults)
    assert snapshot.diagnostics == (Diagnostic(stage, 'missing_stage'),)
    assert {key: route.model for key, route in snapshot.routes.items()} == defaults
    with pytest.raises(ValueError, match=r'^Invalid AI routing configuration\.$'):
        validate_routing(payload, defaults)


@pytest.mark.parametrize('stage', sorted(AUDIO_STAGES))
def test_every_audio_stage_is_locked_even_with_a_valid_model(stage, payload, defaults):
    payload[stage]['provider'] = 'openrouter'
    snapshot = parse_routing(payload, defaults)
    assert snapshot.routes[stage] == Route('gemini', defaults[stage])
    assert snapshot.diagnostics == (Diagnostic(stage, 'audio_lock'),)
    with pytest.raises(ValueError, match=r'^Invalid AI routing configuration\.$'):
        validate_routing(payload, defaults)


@pytest.mark.parametrize('model', ['', ' gemini-test', 'gemini-test\n', 'https://example.invalid',
                                   'gemini-' + 'x' * 121, None, ['gemini-test'], 'other-model'])
def test_invalid_model_falls_back_without_exposing_value(model, payload, defaults):
    payload['notes_merge']['model'] = model
    snapshot = parse_routing(payload, defaults)
    assert snapshot.routes['notes_merge'].model == defaults['notes_merge']
    assert snapshot.diagnostics == (Diagnostic('notes_merge', 'invalid_model'),)


@pytest.mark.parametrize('options', [None, [], False, {'api_key': 'synthetic-secret'}, {'thinking': 'high'}])
def test_no_options_can_override_current_policy(options, payload, defaults):
    payload['study_tools']['options'] = options
    snapshot = parse_routing(payload, defaults)
    assert snapshot.routes['study_tools'].options == {}
    assert snapshot.diagnostics == (Diagnostic('study_tools', 'unsupported_options'),)


@pytest.mark.parametrize('entry', [None, [], False, 'synthetic-secret',
                                   {'provider': 'gemini', 'model': 'gemini-test'},
                                   {'provider': 'gemini', 'model': 'gemini-test', 'options': {}, 'url': 'secret'}])
def test_malformed_entry_recovers(entry, payload, defaults):
    payload['study_tools'] = entry
    snapshot = parse_routing(payload, defaults)
    assert snapshot.routes['study_tools'].model == defaults['study_tools']
    assert snapshot.diagnostics == (Diagnostic('study_tools', 'invalid_entry'),)


@pytest.mark.parametrize('payload', [None, [], 'secret', 4, False])
def test_invalid_root_recovers_all_stages(payload, defaults):
    snapshot = parse_routing(payload, defaults)
    assert {stage: route.model for stage, route in snapshot.routes.items()} == defaults
    assert snapshot.diagnostics == (Diagnostic('configuration', 'invalid_config'),)


def test_unknown_keys_never_become_routes_or_diagnostic_text(payload, defaults):
    payload.update({f'synthetic-secret-{index}': {} for index in range(100)})
    snapshot = parse_routing(payload, defaults)
    assert set(snapshot.routes) == STAGES
    assert snapshot.diagnostics == (Diagnostic('configuration', 'unknown_stage'),)
    assert 'synthetic-secret' not in repr(snapshot)
    with pytest.raises(KeyError):
        _ = snapshot.routes['typo_stage']


@pytest.mark.parametrize(('kind', 'reason'), [('missing', 'file_missing'), ('directory', 'file_unreadable'),
                                             ('encoding', 'file_unreadable'), ('json', 'invalid_json')])
def test_file_failures_are_safe_and_content_free(tmp_path, kind, reason, defaults):
    path = tmp_path / 'synthetic-secret-path'
    if kind == 'directory':
        path.mkdir()
    elif kind == 'encoding':
        path.write_bytes(b'\xff')
    elif kind == 'json':
        path.write_text('{"synthetic-secret":')
    snapshot = load_routing(path, defaults)
    assert snapshot.diagnostics == (Diagnostic('configuration', reason),)
    assert {stage: route.model for stage, route in snapshot.routes.items()} == defaults
    assert 'synthetic-secret' not in repr(snapshot)


def test_snapshot_copies_inputs_and_does_not_reload_changed_file(tmp_path, payload, defaults):
    path = tmp_path / 'routing.json'
    path.write_text(json.dumps(payload))
    first = load_routing(path, defaults)
    parsed = parse_routing(payload, defaults)
    payload['notes_merge']['model'] = 'gemini-next'
    payload['slides_extraction']['options']['unexpected'] = True
    path.write_text(json.dumps(payload))
    assert first.routes['notes_merge'].model == parsed.routes['notes_merge'].model == defaults['notes_merge']
    assert not first.routes['slides_extraction'].options and not parsed.routes['slides_extraction'].options
    assert load_routing(path, defaults).routes['notes_merge'].model == 'gemini-next'
    with pytest.raises(TypeError):
        first.routes['notes_merge'] = Route('gemini', 'gemini-next')
    with pytest.raises(TypeError):
        first.routes['notes_merge'].options['thinking'] = 'high'
    with pytest.raises(FrozenInstanceError):
        first.routes['notes_merge'].model = 'gemini-next'
    with pytest.raises(FrozenInstanceError):
        first.diagnostics = ()
    routes, diagnostics = dict(first.routes), [Diagnostic('configuration', 'invalid_json')]
    copied = RoutingSnapshot(routes, diagnostics)
    routes.clear()
    diagnostics.clear()
    assert len(copied.routes) == 14 and len(copied.diagnostics) == 1


def test_rejected_diagnostic_and_defaults_use_fixed_errors(defaults):
    with pytest.raises(ValueError, match=r'^Invalid AI routing configuration\.$'):
        Diagnostic('synthetic-secret', 'invalid_json')
    with pytest.raises(ValueError, match=r'^Invalid AI routing defaults\.$'):
        parse_routing({}, {**defaults, 'synthetic-secret': 'secret'})


def test_admin_uses_snapshot_without_rereading_config(tmp_path, payload, defaults):
    path = tmp_path / 'routing.json'
    payload['audio_transcription']['provider'] = 'openrouter'
    path.write_text(json.dumps(payload))
    runtime = SimpleNamespace(
        AI_ROUTING_SNAPSHOT=load_routing(path, defaults), db=None, client=None,
        stripe=SimpleNamespace(api_key=''), STRIPE_PUBLISHABLE_KEY='', STRIPE_WEBHOOK_SECRET='',
        get_soffice_binary=lambda: None, get_ffmpeg_binary=lambda: None,
        shutil=SimpleNamespace(which=lambda name: None),
    )
    path.unlink()
    checks = build_admin_runtime_checks(runtime)
    assert checks['ai_routing_valid'] is False
    assert checks['ai_routing_warnings'] == [{'stage': 'audio_transcription', 'reason': 'audio_lock'}]
    assert checks['gemini_ready'] is False
    runtime.AI_ROUTING_SNAPSHOT = validate_routing({stage: {'provider': 'gemini', 'model': model, 'options': {}}
                                                 for stage, model in defaults.items()}, defaults)
    assert build_admin_runtime_checks(runtime)['ai_routing_warnings'] == []
    del runtime.AI_ROUTING_SNAPSHOT
    assert build_admin_runtime_checks(runtime)['ai_routing_valid'] is True
    assert build_admin_runtime_checks(runtime)['ai_routing_warnings'] == []
