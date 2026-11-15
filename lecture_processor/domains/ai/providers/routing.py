"""Immutable, side-effect-free stage routing with safe Gemini defaults."""

import json
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType


STAGE_MODEL_ATTRIBUTES = MappingProxyType({
    'slides_extraction': 'MODEL_SLIDES',
    'notes_merge': 'MODEL_INTEGRATION',
    'text_combine': 'MODEL_INTEGRATION',
    'study_tools': 'MODEL_STUDY',
    'regenerate_study_tools': 'MODEL_STUDY',
    'interview_summary': 'MODEL_STUDY',
    'interview_sections': 'MODEL_STUDY',
    'interview_coding': 'MODEL_INTERVIEW_CODING',
    'tools_extraction': 'MODEL_TOOLS',
    'audio_transcription': 'MODEL_AUDIO',
    'audio_transcription_timestamped': 'MODEL_AUDIO',
    'interview_transcription': 'MODEL_INTERVIEW',
    'voice_note_transcription': 'MODEL_AUDIO',
    'tools_transcription': 'MODEL_AUDIO',
})
STAGES = frozenset(STAGE_MODEL_ATTRIBUTES)
AUDIO_STAGES = frozenset({
    'audio_transcription', 'audio_transcription_timestamped',
    'interview_transcription', 'voice_note_transcription', 'tools_transcription',
})
DIAGNOSTIC_STAGES = STAGES | {'configuration'}
DIAGNOSTIC_REASONS = frozenset({
    'file_missing', 'file_unreadable', 'invalid_json', 'invalid_config',
    'unknown_stage', 'missing_stage', 'invalid_entry', 'unsupported_provider',
    'audio_lock', 'invalid_model', 'unsupported_options',
})
_MODEL = re.compile(r'gemini-[A-Za-z0-9][A-Za-z0-9._-]{0,119}\Z')
_INVALID_CONFIG = 'Invalid AI routing configuration.'


@dataclass(frozen=True)
class Route:
    provider: str
    model: str
    options: Mapping = field(default_factory=dict)

    def __post_init__(self):
        # Route options cannot override the model's native thinking policy.
        if not isinstance(self.options, Mapping) or self.options:
            raise ValueError(_INVALID_CONFIG)
        object.__setattr__(self, 'options', MappingProxyType({}))


@dataclass(frozen=True)
class Diagnostic:
    stage: str
    reason: str

    def __post_init__(self):
        if self.stage not in DIAGNOSTIC_STAGES or self.reason not in DIAGNOSTIC_REASONS:
            raise ValueError(_INVALID_CONFIG)


@dataclass(frozen=True)
class RoutingSnapshot:
    routes: Mapping
    diagnostics: tuple = ()

    def __post_init__(self):
        object.__setattr__(self, 'routes', MappingProxyType(dict(self.routes)))
        object.__setattr__(self, 'diagnostics', tuple(self.diagnostics))


def default_models(runtime):
    """Read only the supplied runtime's established model constants."""
    return MappingProxyType({stage: getattr(runtime, attribute)
                             for stage, attribute in STAGE_MODEL_ATTRIBUTES.items()})


def _default_routes(defaults):
    if not isinstance(defaults, Mapping) or set(defaults) != STAGES:
        raise ValueError('Invalid AI routing defaults.')
    if any(not isinstance(model, str) or not _MODEL.fullmatch(model)
           for model in defaults.values()):
        raise ValueError('Invalid AI routing defaults.')
    return {stage: Route('gemini', defaults[stage]) for stage in STAGE_MODEL_ATTRIBUTES}


def _fallback(defaults, reason):
    return RoutingSnapshot(_default_routes(defaults), (Diagnostic('configuration', reason),))


def parse_routing(payload, defaults):
    """Validate entries independently, preserving healthy stages on bad input."""
    routes = _default_routes(defaults)
    if not isinstance(payload, dict):
        return _fallback(defaults, 'invalid_config')
    diagnostics = []
    if any(stage not in STAGES for stage in payload):
        diagnostics.append(Diagnostic('configuration', 'unknown_stage'))
    for stage in STAGE_MODEL_ATTRIBUTES:
        entry = payload.get(stage)
        if stage not in payload:
            reason = 'missing_stage'
        elif not isinstance(entry, dict):
            reason = 'invalid_entry'
        elif stage in AUDIO_STAGES and entry.get('provider') != 'gemini':
            reason = 'audio_lock'
        elif entry.get('provider') != 'gemini':
            reason = 'unsupported_provider'
        elif set(entry) != {'provider', 'model', 'options'}:
            reason = 'invalid_entry'
        elif not isinstance(entry['model'], str) or not _MODEL.fullmatch(entry['model']):
            reason = 'invalid_model'
        elif not isinstance(entry['options'], dict) or entry['options']:
            reason = 'unsupported_options'
        else:
            routes[stage] = Route('gemini', entry['model'])
            continue
        diagnostics.append(Diagnostic(stage, reason))
    return RoutingSnapshot(routes, diagnostics)


def load_routing(path, defaults):
    """Load once; only a new explicit load can change the returned snapshot."""
    try:
        payload = json.loads(Path(path).read_text(encoding='utf-8'))
    except FileNotFoundError:
        return _fallback(defaults, 'file_missing')
    except (OSError, UnicodeError):
        return _fallback(defaults, 'file_unreadable')
    except (ValueError, RecursionError):
        return _fallback(defaults, 'invalid_json')
    return parse_routing(payload, defaults)


def validate_routing(payload, defaults):
    """Strict validation for a reviewed configuration, with content-free errors."""
    snapshot = parse_routing(payload, defaults)
    if snapshot.diagnostics:
        raise ValueError(_INVALID_CONFIG)
    return snapshot
