"""Output and prompt policies for OpenRouter document stages."""
from dataclasses import replace
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
        'Copy informative slide placeholders exactly, with the English prefix [Informative Image/Table: ...].'
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


def grounded_visuals(result, source_slide_text):
    """Keep only visual descriptions supplied by the slide source, using its exact wording."""
    source = {}
    for match in _VISUAL.finditer(source_slide_text):
        description = match.group('description')
        if description:
            key = ' '.join(description.split())
            source[key] = f'[Informative Image/Table: {description.strip()}]'

    def grounded(match):
        description = match.group('description') or ''
        return source.get(' '.join(description.split()), '')

    return replace(result, text=_VISUAL.sub(grounded, result.text))


def complete_document(stage, result, source_slide_text):
    if result.finish_reason != 'stop' or not isinstance(result.text, str):
        return None
    if stage != 'slides_extraction':
        result = grounded_visuals(result, source_slide_text)
    return result if result.text.strip() else None
