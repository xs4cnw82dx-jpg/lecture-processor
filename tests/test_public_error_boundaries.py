import logging
from threading import Lock
from types import SimpleNamespace

from flask import jsonify
import pytest

from lecture_processor.domains.ai import study_generation
from lecture_processor.services import account_data_service


DETAIL = 'synthetic diagnostic at /internal/example.json?token=private-example'
STUDY_MESSAGE = 'Could not generate study materials. Please try again.'


@pytest.fixture
def generation_runtime():
    return SimpleNamespace(
        PROMPT_STUDY_TEMPLATE='{source_text} {flashcard_amount} {question_amount} {output_language}',
        PROMPT_INTERVIEW_SUMMARY='{transcript} {output_language}',
        PROMPT_INTERVIEW_SECTIONED='{transcript} {output_language}',
        MODEL_STUDY='synthetic-model', types=None,
        logger=logging.getLogger('public-error-test'),
    )


@pytest.mark.parametrize('error_type', [RuntimeError, ValueError, KeyError])
@pytest.mark.parametrize('include_usage', [False, True])
def test_generation_exceptions_keep_tuple_contract_and_log_details(generation_runtime, monkeypatch, caplog, error_type, include_usage):
    def fail(*_args, **_kwargs):
        raise error_type(DETAIL)

    monkeypatch.setattr(study_generation.ai_provider, 'generate_with_policy', fail)
    result = study_generation.generate_study_materials('Synthetic notes', '10', '5',
                                                     runtime=generation_runtime, include_usage=include_usage)
    assert result[:3] == ([], [], STUDY_MESSAGE)
    assert len(result) == (4 if include_usage else 3)
    if include_usage:
        assert result[3]['token_total'] == 0
    assert DETAIL in caplog.text


def test_interview_partial_failure_retains_success_counts_and_usage(generation_runtime, monkeypatch, caplog):
    def generate(*_args, **kwargs):
        if kwargs['operation_name'] == 'interview_summary_generation':
            raise RuntimeError(DETAIL)
        return SimpleNamespace(text='Structured transcript')

    monkeypatch.setattr(study_generation.ai_provider, 'generate_with_optional_thinking', generate)
    monkeypatch.setattr(study_generation.ai_provider, 'extract_token_usage', lambda *_args, **_kwargs: {
        'input_tokens': 7, 'output_tokens': 4, 'total_tokens': 11,
    })
    result = study_generation.generate_interview_enhancements('Synthetic transcript', ['summary', 'sections'], runtime=generation_runtime)
    assert result['error'] == 'Could not generate the interview summary. Please try again.'
    assert result['error_code'] == 'interview_enhancement_failed'
    assert result['successful_features'] == ['sections']
    assert result['failed_count'] == 1
    assert result['summary'] is None
    assert result['sections'] == 'Structured transcript'
    assert result['token_total'] == 11
    assert DETAIL in caplog.text


@pytest.fixture
def deletion_runtime(monkeypatch):
    lifecycle = account_data_service.account_lifecycle
    state = SimpleNamespace(reasons=[], auth_deleted=[])
    for name in ('mark_account_deletion_requested', 'mark_account_data_purge_started',
                 'mark_account_auth_delete_pending', 'mark_account_auth_deleted', 'mark_account_deletion_complete'):
        monkeypatch.setattr(lifecycle, name, lambda *_args, **_kwargs: True)
    monkeypatch.setattr(lifecycle, 'count_active_jobs_for_user', lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(lifecycle, 'get_user_account_state', lambda *_args, **_kwargs: {})
    monkeypatch.setattr(lifecycle, 'remove_pending_audio_imports_for_uid', lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(lifecycle, 'query_docs_by_field', lambda *_args, **_kwargs: [])
    monkeypatch.setattr(lifecycle, 'has_docs_by_field', lambda *_args, **_kwargs: False)
    monkeypatch.setattr(lifecycle, 'remove_upload_artifacts_for_job_ids', lambda *_args, **_kwargs: 0)
    for name in ('restore_account_after_failed_deletion', 'mark_account_deletion_retry_required'):
        monkeypatch.setattr(lifecycle, name, lambda *_args, **kwargs: state.reasons.append(kwargs['reason']) or True)
    monkeypatch.setattr(account_data_service.access_service, 'require_recent_allowed_user',
                        lambda *_args, **_kwargs: ({'uid': 'owner', 'email': 'owner@example.test'}, None, None))
    monkeypatch.setattr(account_data_service.rate_limiter, 'check_rate_limit', lambda **_kwargs: (True, 0))
    monkeypatch.setattr('lecture_processor.services.book_account_service.delete_owned', lambda *_args: 0)
    monkeypatch.setattr('lecture_processor.services.study_picture_service.delete_owned', lambda *_args: 0)
    monkeypatch.setattr('lecture_processor.services.calendar_sync_service.delete_account_connection', lambda *_args: None)
    runtime = SimpleNamespace(
        ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION=100, RUNTIME_JOBS_COLLECTION='runtime_jobs',
        logger=logging.getLogger('public-error-test'), jsonify=jsonify, db=None,
        JOBS_LOCK=Lock(), jobs={}, time=SimpleNamespace(time=lambda: 1000),
        repositories=SimpleNamespace(
            batches=SimpleNamespace(list_batch_jobs_by_uid=lambda *_args: []),
            users=SimpleNamespace(delete_doc=lambda *_args: None),
        ),
        auth=SimpleNamespace(delete_user=lambda uid: state.auth_deleted.append(uid)),
        get_study_progress_doc=lambda _uid: SimpleNamespace(get=lambda: SimpleNamespace(exists=False)),
    )
    state.runtime = runtime
    state.request = SimpleNamespace(get_json=lambda **_kwargs: {
        'confirm_text': 'DELETE MY ACCOUNT', 'confirm_email': 'owner@example.test',
    })
    return state


@pytest.mark.parametrize('after_purge', [False, True])
def test_deletion_error_is_public_safe_and_keeps_retry_state(app, deletion_runtime, monkeypatch, caplog, after_purge):
    state = deletion_runtime
    def fail(*_args, **_kwargs):
        raise RuntimeError(DETAIL)

    method = 'remove_pending_audio_imports_for_uid' if after_purge else 'mark_account_data_purge_started'
    monkeypatch.setattr(account_data_service.account_lifecycle, method, fail)
    with app.app_context():
        response, status = account_data_service.delete_account_data(state.runtime, state.request)
    assert status == 500
    payload = response.get_json()
    assert payload['error'] == 'Could not completely delete account data'
    assert payload['error_code'] == 'account_deletion_failed'
    assert payload['status'] == ('deletion_retry_required' if after_purge else 'deletion_failed')
    assert 'details' not in payload
    assert DETAIL not in str(state.reasons)
    assert len(state.reasons) == 1
    assert state.auth_deleted == []
    assert DETAIL in caplog.text


def test_deletion_warning_preserves_success_without_raw_diagnostics(app, deletion_runtime, monkeypatch, caplog):
    state = deletion_runtime
    def fail():
        raise RuntimeError(DETAIL)

    doc = SimpleNamespace(id='synthetic-job', to_dict=lambda: {}, reference=SimpleNamespace(delete=fail))
    monkeypatch.setattr(account_data_service.account_lifecycle, 'query_docs_by_field',
                        lambda collection, *_args, **_kwargs: [doc] if collection == 'job_logs' else [])
    with app.app_context():
        response = account_data_service.delete_account_data(state.runtime, state.request)
    assert response.status_code == 200
    payload = response.get_json()
    assert payload['ok'] is True
    assert payload['warnings'] == ['Some account data could not be removed. Please try again.']
    assert state.auth_deleted == ['owner']
    assert DETAIL in caplog.text


def test_export_status_does_not_return_legacy_diagnostics(app, monkeypatch):
    monkeypatch.setattr(account_data_service, '_get_owned_export_job', lambda *_args, **_kwargs: ({
        'status': 'error', 'error': DETAIL, 'step_description': DETAIL,
    }, None, None))
    runtime = SimpleNamespace(jsonify=jsonify)
    with app.app_context():
        response = account_data_service.get_account_export_status(runtime, object(), 'synthetic-export')
    payload = response.get_json()
    assert payload['status'] == 'error'
    assert payload['error'] == 'Could not build export bundle'
    assert payload['error_code'] == 'account_export_failed'
    assert payload['message'] == 'The export could not be created.'
    assert DETAIL not in response.get_data(as_text=True)
