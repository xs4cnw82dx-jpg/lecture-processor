"""Output and prompt policies for OpenRouter document stages."""
from dataclasses import replace
import logging
import re

from .contracts import TextPart

_INSTRUCTIONS = {
    'slides_extraction': (
        'Treat exercise, technique, posture and measurement demonstrations, anatomical diagrams and '
        'technical illustrations as informative. Use the decorative marker only for purely decorative '
        'stock or atmosphere images. Describe only what is visible, without inferring a view or narrowing '
        'or broadening the topic. Also copy readable labels, numeric values and legends into plain text '
        'under their slide, outside the marker. Keep (text unreadable) wherever it applies.'
    ),
    'notes_merge': (
        'Use only a title and second- or third-level headings. Copy relevant informative visual '
        'placeholders from the supplied slide text verbatim, using the English prefix '
        '[Informative Image/Table: ...]. Omit decorative placeholders. Preserve all substantive '
        'content, source qualifications and applicable audio markers.'
    ),
    'text_combine': (
        'Write all headings, instructions and closing text in the requested output language. Only '
        'verbatim source quotations, names and on-slide labels may remain in their original language. '
        'For supplied slide visuals use the literal marker [Informatieve Afbeelding/Tabel: ...] and copy '
        'its source description exactly. Omit decorative markers. Use no visual markers for transcript-only input.'
    ),
}
DOCUMENT_STAGES = frozenset(_INSTRUCTIONS)
# Allow existing Dutch slide exports as well as the current extraction format.
_VISUAL = re.compile(
    r'\[(?:(?:Informative Image/Table|Informatieve Afbeelding/Tabel)\s*:\s*(?P<description>[^\[\]\r\n]+)'
    r'|(?:Decorative Image|Decoratieve Afbeelding)(?:\s*:[^\[\]\r\n]*)?)\]', re.IGNORECASE
)


def document_parts(stage, parts):
    return (*parts, TextPart(_INSTRUCTIONS[stage]))


def grounded_visuals(result, source_slide_text, stage):
    """Keep only visual descriptions supplied by the slide source, using its exact wording."""
    prefix = 'Informatieve Afbeelding/Tabel' if stage == 'text_combine' else 'Informative Image/Table'
    source = {}
    for match in _VISUAL.finditer(source_slide_text):
        description = match.group('description')
        if description:
            key = ' '.join(description.split())
            source[key] = f'[{prefix}: {description.strip()}]'

    dropped = 0
    def grounded(match):
        nonlocal dropped
        description = match.group('description') or ''
        marker = source.get(' '.join(description.split()), '')
        if description and not marker:
            dropped += 1
        return marker

    text = _VISUAL.sub(grounded, result.text)
    if dropped:
        logging.getLogger(__name__).info('Dropped %d unsupported informative markers for %s.', dropped, stage)
    return replace(result, text=text)


def complete_document(stage, result, source_slide_text):
    if result.finish_reason != 'stop' or not isinstance(result.text, str):
        return None
    if stage != 'slides_extraction':
        result = grounded_visuals(result, source_slide_text, stage)
    return result if result.text.strip() else None
