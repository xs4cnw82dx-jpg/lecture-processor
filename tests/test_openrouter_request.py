"""Request policy and local content preparation, without an SDK or network."""
import base64
from pathlib import Path

import pytest

from lecture_processor.domains.ai.providers.contracts import AudioPart, ImagePart, PdfPart, TextPart
from lecture_processor.domains.ai.providers.openrouter_request import prepare_request

MODEL = 'anthropic/claude-sonnet-5.5'
OPTIONS = {'reasoning_effort': 'medium', 'max_output_tokens': 32768}
EXPECTED_PLUGINS = (
    'alignment', 'armor', 'auto-beta-router', 'auto-router', 'context-compression',
    'file-parser', 'fusion', 'jev-router', 'moderation', 'pareto-router',
    'response-healing', 'switchyard-router', 'web-fetch', 'web',
)


def prepare(parts, **kwargs):
    return prepare_request(MODEL, parts, options=OPTIONS, max_output_tokens=65536, **kwargs)


def test_explicit_policy_and_text_only_plugin_disables():
    request = prepare([TextPart('  keep whitespace  ')])
    assert request['messages'] == [{'role': 'user', 'content': [{'type': 'text', 'text': '  keep whitespace  '}]}]
    assert request['max_tokens'] == 32768 and request['stream'] is False
    assert request['service_tier'] == 'default'
    assert request['extra_body'] == {
        'provider': {'only': ['google-vertex/global'], 'allow_fallbacks': False,
                     'require_parameters': True, 'data_collection': 'deny', 'zdr': True},
        'reasoning': {'effort': 'medium', 'exclude': True},
        'plugins': [{'id': plugin, 'enabled': False} for plugin in EXPECTED_PLUGINS],
    }
    assert 'response_format' not in request


def test_pdf_and_image_keep_order_native_parser_and_local_files(tmp_path):
    pdf, image = tmp_path / 'private-name.pdf', tmp_path / 'private-name.png'
    pdf.write_bytes(b'%PDF-synthetic')
    image.write_bytes(b'synthetic-image')
    request = prepare([TextPart('before'), PdfPart(pdf), ImagePart(image), TextPart('after')])
    content = request['messages'][0]['content']
    assert [part['type'] for part in content] == ['text', 'file', 'image_url', 'text']
    assert content[1]['file']['filename'] == 'document-2.pdf'
    assert base64.b64decode(content[1]['file']['file_data'].split(',', 1)[1]) == pdf.read_bytes()
    assert base64.b64decode(content[2]['image_url']['url'].split(',', 1)[1]) == image.read_bytes()
    assert content[2]['image_url']['url'].startswith('data:image/png;base64,')
    plugins = {plugin['id']: plugin for plugin in request['extra_body']['plugins']}
    assert plugins.pop('file-parser') == {'id': 'file-parser', 'enabled': True, 'pdf': {'engine': 'native'}}
    assert all(plugin['enabled'] is False for plugin in plugins.values())
    assert 'private-name' not in str(request)


@pytest.mark.parametrize('invalid', [AudioPart('not-read.wav', 'audio/wav'),
                                     ImagePart('not-read.png', 'text/html'), TextPart(None), object()])
def test_all_parts_validated_before_file_reads(monkeypatch, invalid):
    monkeypatch.setattr(Path, 'open', lambda *_a, **_kw: pytest.fail('Invalid input opened a file.'))
    with pytest.raises(ValueError):
        prepare([PdfPart('not-read.pdf'), invalid])


def test_schema_is_copied_and_invalid_schema_precedes_file_reads(monkeypatch):
    schema = {'type': 'object', 'properties': {'answer': {'type': 'string'}}}
    request = prepare([TextPart('synthetic')], schema=schema)
    schema['properties'].clear()
    assert request['response_format']['json_schema'] == {
        'name': 'generated_output', 'strict': True,
        'schema': {'type': 'object', 'properties': {'answer': {'type': 'string'}}},
    }
    monkeypatch.setattr(Path, 'open', lambda *_a, **_kw: pytest.fail('Invalid schema opened a file.'))
    with pytest.raises(ValueError, match='^Invalid generation schema\\.$'):
        prepare([PdfPart('not-read.pdf')], schema={'invalid': float('nan')})


def test_file_failure_has_no_path_or_original_exception(tmp_path):
    with pytest.raises(ValueError, match='^Invalid generation input\\.$') as caught:
        prepare([PdfPart(tmp_path / 'synthetic-sensitive-path.pdf')])
    assert caught.value.__context__ is None
    assert caught.value.__cause__ is None


def test_file_permission_error_does_not_escape_in_exception_context(tmp_path, monkeypatch):
    path = tmp_path / 'synthetic-sensitive-path.pdf'
    path.write_bytes(b'%PDF-synthetic')

    def fail_open(*_args, **_kwargs):
        raise PermissionError(f'Synthetic private path: {path}')

    monkeypatch.setattr(Path, 'open', fail_open)
    with pytest.raises(ValueError, match='^Invalid generation input\\.$') as caught:
        prepare([PdfPart(path)])
    assert caught.value.__context__ is None
    assert caught.value.__cause__ is None
