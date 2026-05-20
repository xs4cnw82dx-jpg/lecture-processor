from types import SimpleNamespace

from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.services import tools_extraction_service, upload_api_service


class _Time:
    def __init__(self):
        self._now = 1000.0

    def time(self):
        self._now += 1.0
        return self._now


class _Logger:
    def exception(self, *_args, **_kwargs):
        return None


class _Part:
    @staticmethod
    def from_text(text=''):
        return {'text': text}

    @staticmethod
    def from_uri(file_uri=None, mime_type=None):
        return {'uri': file_uri, 'mime_type': mime_type}


class _Content:
    def __init__(self, role=None, parts=None):
        self.role = role
        self.parts = parts or []


def test_tools_extract_job_redacts_url_and_prompt_from_persisted_metadata(monkeypatch):
    raw_url = 'https://Example.com/private/path?token=secret'
    custom_prompt = 'secret custom prompt'
    saved_logs = []
    analytics_calls = []
    progress_updates = []
    generated_text_parts = []

    app_ctx = SimpleNamespace(
        time=_Time(),
        logger=_Logger(),
        MODEL_TOOLS='gemini-test',
        types=SimpleNamespace(Part=_Part, Content=_Content),
        cleanup_files=lambda _local_paths, _remote_files: None,
        save_job_log=lambda job_id, payload, finished_at: saved_logs.append(
            {'job_id': job_id, 'payload': payload, 'finished_at': finished_at}
        ),
    )

    monkeypatch.setattr(
        upload_api_service,
        '_fetch_tools_url_text',
        lambda _source_url: ('Readable page text', None, 'text/plain'),
    )

    def _fake_generate(_model, contents, **_kwargs):
        for content in contents:
            for part in getattr(content, 'parts', []) or []:
                if 'text' in part:
                    generated_text_parts.append(part['text'])
        return SimpleNamespace(text='Extracted markdown')

    monkeypatch.setattr(ai_provider, 'generate_with_policy', _fake_generate)
    monkeypatch.setattr(
        ai_provider,
        'extract_token_usage',
        lambda *_args, **_kwargs: {'input_tokens': 11, 'output_tokens': 7, 'total_tokens': 18},
    )
    monkeypatch.setattr(
        analytics_events,
        'log_analytics_event',
        lambda event_name, **kwargs: analytics_calls.append((event_name, kwargs)) or True,
    )
    monkeypatch.setattr(
        runtime_jobs_store,
        'update_job_fields',
        lambda job_id, runtime=None, **fields: progress_updates.append((job_id, fields)),
    )

    staged_input = tools_extraction_service._StagedToolInput(
        source_type='url',
        source_url=raw_url,
        prompt_template_key='',
        prompt_source='custom',
        custom_prompt=custom_prompt,
        extension='',
        mime_type='text/html',
        staged_paths=(),
        normalized_input_name=raw_url,
        normalized_input_names=(),
        upload_mime_type='',
        source_size_mb=0.0,
    )

    tools_extraction_service._run_tools_extract_job(
        app_ctx,
        'job-1',
        'uid-1',
        'user@example.com',
        staged_input,
        'slides_credits',
        1,
    )

    assert saved_logs
    saved_payload = saved_logs[0]['payload']
    assert saved_payload['source_url'] == 'https://example.com'
    assert saved_payload['source_name'] == 'URL: example.com'
    assert saved_payload['custom_prompt_length'] == len(custom_prompt)
    assert 'custom_prompt' not in saved_payload
    assert 'effective_prompt_preview' not in saved_payload
    assert raw_url not in str(saved_payload)
    assert custom_prompt not in str(saved_payload)

    completed_event = analytics_calls[0]
    assert completed_event[0] == 'tools_extract_completed'
    properties = completed_event[1]['properties']
    assert properties['source_url'] == 'https://example.com'
    assert properties['source_host'] == 'example.com'
    assert properties['source_url_has_path'] is True
    assert properties['source_url_has_query'] is True
    assert properties['custom_prompt_length'] == len(custom_prompt)
    assert properties['has_custom_prompt'] is True
    assert 'custom_prompt' not in properties
    assert 'effective_prompt_preview' not in properties
    assert raw_url not in str(properties)
    assert custom_prompt not in str(properties)

    assert raw_url not in str(progress_updates)
    assert any(fields.get('tool_input_name') == 'URL: example.com' for _job_id, fields in progress_updates)
    assert raw_url not in '\n'.join(generated_text_parts)
