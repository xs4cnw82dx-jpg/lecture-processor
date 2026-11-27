"""Build explicit, ordered text/document requests without constructing a client."""
import base64
import json
from pathlib import Path

from .contracts import AudioPart, ImagePart, PdfPart, TextPart
from .routing import validate_openrouter_options

# Only these plugin schemas accept a per-request enabled flag.
SWITCHABLE_PLUGIN_IDS = (
    'armor', 'auto-beta-router', 'auto-router', 'context-compression',
    'file-parser', 'fusion', 'pareto-router',
    'response-healing', 'web',
)
_IMAGE_TYPES = frozenset({'image/png', 'image/jpeg', 'image/webp', 'image/gif'})
_MAX_FILE_BYTES = 50 * 1024 * 1024
_INVALID_INPUT = 'Invalid generation input.'


def _read_file(path):
    data = None
    try:
        path = Path(path)
        if path.is_file() and path.stat().st_size <= _MAX_FILE_BYTES:
            with path.open('rb') as source:
                data = source.read(_MAX_FILE_BYTES + 1)
    except (OSError, TypeError, ValueError):
        pass
    if data is None or not data or len(data) > _MAX_FILE_BYTES:
        # Do not attach filesystem exceptions, which can contain private paths.
        raise ValueError(_INVALID_INPUT)
    return data


def prepare_request(model, parts, *, options, max_output_tokens, schema=None):
    options = validate_openrouter_options(model, options)
    if type(max_output_tokens) is not int or max_output_tokens <= 0:
        raise ValueError('Invalid generation output limit.')
    parts = tuple(parts)
    if not parts:
        raise ValueError(_INVALID_INPUT)
    # Validate the entire list before any file is opened.
    for part in parts:
        if isinstance(part, AudioPart):
            raise ValueError('Audio generation requires Gemini.')
        if isinstance(part, TextPart):
            valid = isinstance(part.text, str)
        elif isinstance(part, PdfPart):
            valid = isinstance(part.path, (str, Path))
        elif isinstance(part, ImagePart):
            valid = (isinstance(part.path, (str, Path))
                     and isinstance(part.mime_type, str) and part.mime_type in _IMAGE_TYPES)
        else:
            valid = False
        if not valid:
            raise ValueError(_INVALID_INPUT)

    response_format = None
    if schema is not None:
        serialized_schema = None
        try:
            if isinstance(schema, dict):
                serialized_schema = json.dumps(schema, allow_nan=False)
        except (TypeError, ValueError, RecursionError):
            pass
        if serialized_schema is None:
            raise ValueError('Invalid generation schema.')
        response_format = {'type': 'json_schema', 'json_schema': {
            'name': 'generated_output', 'strict': True, 'schema': json.loads(serialized_schema),
        }}

    content = []
    has_pdf = False
    for index, part in enumerate(parts):
        if isinstance(part, TextPart):
            content.append({'type': 'text', 'text': part.text})
            continue
        encoded = base64.b64encode(_read_file(part.path)).decode('ascii')
        if isinstance(part, PdfPart):
            has_pdf = True
            content.append({'type': 'file', 'file': {
                'filename': f'document-{index + 1}.pdf',
                'file_data': f'data:application/pdf;base64,{encoded}',
            }})
        else:
            content.append({'type': 'image_url', 'image_url': {
                'url': f'data:{part.mime_type};base64,{encoded}',
            }})
    plugins = [{'id': plugin, 'enabled': False} for plugin in SWITCHABLE_PLUGIN_IDS]
    if has_pdf:
        plugins[SWITCHABLE_PLUGIN_IDS.index('file-parser')] = {
            'id': 'file-parser', 'enabled': True, 'pdf': {'engine': 'native'},
        }
    request = {
        'model': model,
        'messages': [{'role': 'user', 'content': content}],
        'max_tokens': min(max_output_tokens, options['max_output_tokens']),
        'stream': False,
        'service_tier': 'default',
        'extra_body': {
            'provider': {'only': ['google-vertex/global'], 'allow_fallbacks': False,
                         'require_parameters': True, 'data_collection': 'deny', 'zdr': True},
            'reasoning': {'effort': options['reasoning_effort'], 'exclude': True},
            'plugins': plugins,
        },
    }
    if response_format is not None:
        request['response_format'] = response_format
    return request
