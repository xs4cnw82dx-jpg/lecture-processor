from __future__ import annotations

import json
import time
from datetime import datetime, timezone

from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.ai import study_generation
from lecture_processor.domains.ai import pipelines as ai_pipelines
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.notifications import send_batch_completion_email
from lecture_processor.domains.study import audio as study_audio
from lecture_processor.runtime.container import get_runtime


TERMINAL_BATCH_STATES = {
    'JOB_STATE_SUCCEEDED',
    'JOB_STATE_FAILED',
    'JOB_STATE_CANCELLED',
    'JOB_STATE_EXPIRED',
}

ACTIVE_BATCH_STATUSES = {'queued', 'processing'}
ACTIVE_ROW_STATUSES = {'queued', 'processing'}

STAGE_LABELS = {
    'queued': 'Queued',
    'validation': 'Validating batch',
    'file_upload': 'Uploading source files',
    'slide_extraction': 'Extracting slide text',
    'audio_transcription': 'Transcribing audio',
    'notes_merge': 'Merging notes',
    'study_materials_generation': 'Generating study tools',
    'interview_transcription': 'Transcribing interview',
    'interview_summary_generation': 'Generating summary',
    'interview_sections_generation': 'Generating sectioned transcript',
    'batch_pipeline': 'Finalizing batch',
}

PROVIDER_STATE_LABELS = {
    'FILE_UPLOAD': 'Uploading files',
    'NO_ROWS': 'No rows to process',
    'FAILED': 'Failed',
    'PARTIAL': 'Partial result',
    'COMPLETED': 'Completed',
    'INTERRUPTED': 'Interrupted by deploy or restart',
    'JOB_STATE_PENDING': 'Queued at Gemini',
    'JOB_STATE_RUNNING': 'Running at Gemini',
    'JOB_STATE_SUCCEEDED': 'Completed at Gemini',
    'JOB_STATE_FAILED': 'Failed at Gemini',
    'JOB_STATE_CANCELLED': 'Cancelled at Gemini',
    'JOB_STATE_EXPIRED': 'Expired at Gemini',
}

BATCH_INTERRUPTED_PUBLIC_MESSAGE = (
    'Processing was interrupted by a deploy or server restart before the batch finished. '
    'Unfinished rows were marked as failed and refunded when possible.'
)


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _memory_store(runtime):
    if not hasattr(runtime, '_BATCH_JOBS_MEMORY'):
        runtime._BATCH_JOBS_MEMORY = {}
    if not hasattr(runtime, '_BATCH_ROWS_MEMORY'):
        runtime._BATCH_ROWS_MEMORY = {}
    return runtime._BATCH_JOBS_MEMORY, runtime._BATCH_ROWS_MEMORY


def _batch_model(stage_name, runtime):
    if stage_name == 'slide_extraction':
        return runtime.MODEL_SLIDES
    if stage_name in {'audio_transcription', 'interview_transcription'}:
        return runtime.MODEL_AUDIO if stage_name == 'audio_transcription' else runtime.MODEL_INTERVIEW
    if stage_name == 'notes_merge':
        return runtime.MODEL_INTEGRATION
    return runtime.MODEL_STUDY


def _batch_page_path(mode_name):
    mode_value = str(mode_name or '').strip().lower()
    if mode_value == 'slides-only':
        return '/batch_mode_slides_extraction'
    if mode_value == 'interview':
        return '/batch_mode_interview_transcription'
    return '/batch_mode'


def _completion_email_subject(status, batch_title):
    safe_title = str(batch_title or 'Batch job').strip() or 'Batch job'
    if status == 'complete':
        return f'Batch finished: {safe_title}'
    if status == 'partial':
        return f'Batch finished with partial results: {safe_title}'
    return f'Batch finished with errors: {safe_title}'


def _completion_email_body(batch, status, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    mode_name = str(batch.get('mode', '') or '').strip()
    batch_id = str(batch.get('batch_id', '') or '').strip()
    batch_title = str(batch.get('batch_title', '') or batch_id or 'Batch job').strip()
    total_rows = int(batch.get('total_rows', 0) or 0)
    completed_rows = int(batch.get('completed_rows', 0) or 0)
    failed_rows = int(batch.get('failed_rows', 0) or 0)
    finished_at = batch.get('finished_at', 0)
    finished_at_label = ''
    try:
        safe_finished = float(finished_at or 0)
        if safe_finished > 0:
            finished_at_label = datetime.fromtimestamp(safe_finished, tz=timezone.utc).strftime('%Y-%m-%d %H:%M UTC')
    except Exception:
        finished_at_label = ''

    path = _batch_page_path(mode_name)
    deep_link = f'{path}?batch_id={batch_id}' if batch_id else path
    public_base = str(getattr(resolved_runtime, 'PUBLIC_BASE_URL', '') or '').rstrip('/')
    if public_base:
        full_link = f'{public_base}{deep_link}'
    else:
        full_link = deep_link

    status_line = {
        'complete': 'Your batch completed successfully.',
        'partial': 'Your batch finished with partial results.',
        'error': 'Your batch finished with errors.',
    }.get(status, 'Your batch reached a final status.')

    finished_line = f'Finished at: {finished_at_label}' if finished_at_label else ''
    return '\n'.join(
        line for line in [
            f'Hi,',
            '',
            status_line,
            f'Batch title: {batch_title}',
            f'Batch ID: {batch_id}',
            f'Rows: {completed_rows}/{total_rows} completed, {failed_rows} failed',
            finished_line,
            '',
            f'Open batch status: {full_link}',
            '',
            'This is an automated message from Lecture Processor.',
        ] if line
    )


def _stage_label(stage_name):
    safe_stage = str(stage_name or '').strip()
    if not safe_stage:
        return ''
    return STAGE_LABELS.get(safe_stage, safe_stage.replace('_', ' ').strip().title())


def _provider_state_label(provider_state):
    safe_state = str(provider_state or '').strip()
    if not safe_state:
        return ''
    return PROVIDER_STATE_LABELS.get(safe_state, safe_state.replace('_', ' ').strip().title())


def _active_heartbeat_timestamp(batch):
    if not isinstance(batch, dict):
        return 0.0
    for field in ('last_heartbeat_at', 'updated_at', 'created_at'):
        try:
            value = float(batch.get(field, 0) or 0)
        except Exception:
            value = 0.0
        if value > 0:
            return value
    return 0.0


def _batch_recovery_stale_seconds(runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    configured = getattr(resolved_runtime, 'BATCH_JOB_RECOVERY_STALE_SECONDS', 0)
    try:
        safe_configured = int(configured or 0)
    except Exception:
        safe_configured = 0
    if safe_configured > 0:
        return max(120, safe_configured)

    pending_poll = max(5, int(getattr(resolved_runtime, 'BATCH_PENDING_POLL_SECONDS', 20) or 20))
    running_poll = max(5, int(getattr(resolved_runtime, 'BATCH_RUNNING_POLL_SECONDS', pending_poll) or pending_poll))
    return max(180, (max(pending_poll, running_poll) * 3) + 60)


def _batch_is_stale(batch, runtime=None, now_ts=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not isinstance(batch, dict):
        return False
    status = str(batch.get('status', '') or '').strip().lower()
    if status not in ACTIVE_BATCH_STATUSES:
        return False
    now_ts = float(now_ts if isinstance(now_ts, (int, float)) else resolved_runtime.time.time())
    last_heartbeat_at = _active_heartbeat_timestamp(batch)
    if last_heartbeat_at <= 0:
        return False
    return (now_ts - last_heartbeat_at) >= float(_batch_recovery_stale_seconds(runtime=resolved_runtime))


def _first_row_error(rows):
    for row in rows or []:
        message = str((row or {}).get('error', '') or '').strip()
        if message:
            return message
    return ''


def _public_error_message(batch, rows, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    batch_summary = str((batch or {}).get('error_summary', '') or '').strip()
    row_error = _first_row_error(rows)
    combined = batch_summary or row_error
    lowered = combined.lower()

    if 'server restart' in lowered or 'deploy' in lowered or 'interrupted' in lowered:
        return BATCH_INTERRUPTED_PUBLIC_MESSAGE
    if '503' in lowered or 'service unavailable' in lowered or 'temporarily unavailable' in lowered or 'unavailable' in lowered:
        return 'Google Gemini was temporarily unavailable while this batch was running. Please start the batch again.'
    if 'timeout' in lowered or 'timed out' in lowered:
        return 'The batch timed out before it finished. Please start the batch again.'
    if combined:
        if combined == str(getattr(resolved_runtime, 'PROCESSING_PUBLIC_ERROR_MESSAGE', '') or '').strip():
            return combined
        return combined[:320]

    status = str((batch or {}).get('status', '') or '').strip().lower()
    if status == 'partial':
        return 'Some rows finished, but one or more rows failed.'
    if status == 'error':
        return 'This batch did not finish. Unfinished rows were refunded when possible.'
    return ''


def _status_message(batch, rows, can_download_zip=False, runtime=None):
    status = str((batch or {}).get('status', 'queued') or 'queued').strip().lower()
    if status == 'complete':
        return 'All rows finished successfully. Your outputs are ready in the Study Library and batch downloads.'
    if status == 'partial':
        if can_download_zip:
            return 'Some rows finished and can be downloaded now. Review the failed rows before starting a replacement batch.'
        return 'Some rows finished, but one or more rows failed.'
    if status == 'error':
        return _public_error_message(batch, rows, runtime=runtime) or 'This batch did not finish.'
    if status == 'processing':
        return 'This batch is still processing. You can safely leave this page and come back later.'
    return 'This batch has been accepted and is waiting to continue.'


def _next_action(batch_id, batch, can_download_zip=False):
    status = str((batch or {}).get('status', 'queued') or 'queued').strip().lower()
    mode_name = str((batch or {}).get('mode', '') or '').strip()
    if status == 'complete':
        return {
            'label': 'Open Study Library',
            'href': '/study',
        }
    if status == 'partial':
        if can_download_zip:
            return {
                'label': 'Download finished rows',
                'href': f'/api/batch/jobs/{batch_id}/download.zip',
            }
        return {
            'label': 'Open batch status',
            'href': f'{_batch_page_path(mode_name)}?batch_id={batch_id}',
        }
    if status == 'error':
        return {
            'label': 'Start a new batch',
            'href': _batch_page_path(mode_name),
        }
    return {
        'label': 'Open Batch Dashboard',
        'href': '/batch_dashboard',
    }


def _build_batch_view(batch_id, batch, rows, can_download_zip=False, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    stage_label = _stage_label((batch or {}).get('current_stage', ''))
    provider_label = _provider_state_label((batch or {}).get('provider_state', ''))
    action = _next_action(batch_id, batch, can_download_zip=can_download_zip)
    now_ts = resolved_runtime.time.time()
    heartbeat_age_seconds = 0
    heartbeat_at = _active_heartbeat_timestamp(batch)
    if heartbeat_at > 0:
        heartbeat_age_seconds = max(0, int(now_ts - heartbeat_at))
    error_message = _public_error_message(batch, rows, runtime=resolved_runtime)
    return {
        'stage_label': stage_label,
        'provider_label': provider_label,
        'status_message': _status_message(batch, rows, can_download_zip=can_download_zip, runtime=resolved_runtime),
        'error_message': error_message,
        'next_action_label': action.get('label', ''),
        'next_action_href': action.get('href', ''),
        'heartbeat_age_seconds': heartbeat_age_seconds,
        'stale_processing_detected': bool(_batch_is_stale(batch, runtime=resolved_runtime, now_ts=now_ts)),
        'email_status_label': str((batch or {}).get('completion_email_status', 'pending') or 'pending').replace('_', ' ').strip(),
    }


def _send_batch_completion_email_if_needed(batch_id, status, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    terminal_status = str(status or '').strip()
    if terminal_status not in {'complete', 'partial', 'error'}:
        return

    batch = _get_batch(batch_id, runtime=resolved_runtime)
    if not batch:
        return

    current_notification_status = str(batch.get('completion_email_status', 'pending') or 'pending').strip().lower()
    if current_notification_status in {'sent', 'skipped', 'failed'}:
        return

    recipient = str(batch.get('email', '') or '').strip()
    subject = _completion_email_subject(terminal_status, batch.get('batch_title', ''))
    body = _completion_email_body(batch, terminal_status, runtime=resolved_runtime)
    email_status, error_message = send_batch_completion_email(
        recipient,
        subject,
        body,
        runtime=resolved_runtime,
    )
    now_ts = resolved_runtime.time.time()
    payload = {
        'completion_email_status': str(email_status or 'failed'),
        'completion_email_sent_at': now_ts if email_status == 'sent' else 0,
        'completion_email_error': str(error_message or '')[:600],
        'updated_at': now_ts,
    }
    _upsert_batch(batch_id, payload, runtime=resolved_runtime, merge=True)


def _upsert_batch(batch_id, payload, runtime=None, merge=True):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is not None:
        if merge:
            resolved_runtime.batch_repo.set_batch_job(db, batch_id, payload, merge=True)
        else:
            resolved_runtime.batch_repo.set_batch_job(db, batch_id, payload, merge=False)
        return
    batch_jobs, _rows = _memory_store(resolved_runtime)
    existing = dict(batch_jobs.get(batch_id, {}))
    if merge:
        existing.update(payload)
        batch_jobs[batch_id] = existing
    else:
        batch_jobs[batch_id] = dict(payload)


def _get_batch(batch_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is not None:
        doc = resolved_runtime.batch_repo.get_batch_job_doc(db, batch_id)
        if not doc.exists:
            return None
        data = doc.to_dict() or {}
        data.setdefault('batch_id', batch_id)
        return data
    batch_jobs, _rows = _memory_store(resolved_runtime)
    data = batch_jobs.get(batch_id)
    if not isinstance(data, dict):
        return None
    return dict(data)


def _list_rows(batch_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is not None:
        docs = resolved_runtime.batch_repo.list_batch_rows(db, batch_id)
        rows = []
        for doc in docs:
            row = doc.to_dict() or {}
            row.setdefault('row_id', doc.id)
            rows.append(row)
        return rows
    _jobs, rows_store = _memory_store(resolved_runtime)
    rows = rows_store.get(batch_id, {})
    if not isinstance(rows, dict):
        return []
    values = [dict(v) for v in rows.values() if isinstance(v, dict)]
    return sorted(values, key=lambda item: int(item.get('ordinal', 0) or 0))


def _upsert_row(batch_id, row_id, payload, runtime=None, merge=True):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is not None:
        resolved_runtime.batch_repo.set_batch_row(db, batch_id, row_id, payload, merge=merge)
        return
    _jobs, rows_store = _memory_store(resolved_runtime)
    rows_store.setdefault(batch_id, {})
    existing = dict(rows_store[batch_id].get(row_id, {}))
    if merge:
        existing.update(payload)
        rows_store[batch_id][row_id] = existing
    else:
        rows_store[batch_id][row_id] = dict(payload)


def _get_row(batch_id, row_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is not None:
        doc = resolved_runtime.batch_repo.get_batch_row_doc(db, batch_id, row_id)
        if not doc.exists:
            return None
        data = doc.to_dict() or {}
        data.setdefault('row_id', row_id)
        return data
    _jobs, rows_store = _memory_store(resolved_runtime)
    data = rows_store.get(batch_id, {}).get(row_id)
    if not isinstance(data, dict):
        return None
    return dict(data)


def create_batch_job(batch_payload, row_payloads, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    now_ts = resolved_runtime.time.time()
    batch_id = str(batch_payload.get('batch_id', '') or resolved_runtime.uuid.uuid4())
    payload = dict(batch_payload)
    payload.update(
        {
            'batch_id': batch_id,
            'status': payload.get('status', 'queued'),
            'created_at': payload.get('created_at', now_ts),
            'updated_at': now_ts,
            'finished_at': payload.get('finished_at', 0),
            'completed_rows': int(payload.get('completed_rows', 0) or 0),
            'failed_rows': int(payload.get('failed_rows', 0) or 0),
            'token_input_total': int(payload.get('token_input_total', 0) or 0),
            'token_output_total': int(payload.get('token_output_total', 0) or 0),
            'token_total': int(payload.get('token_total', 0) or 0),
            'billing_mode': 'batch',
            'billing_multiplier': float(payload.get('billing_multiplier', 0.5) or 0.5),
            'completion_email_status': str(payload.get('completion_email_status', 'pending') or 'pending'),
            'completion_email_sent_at': float(payload.get('completion_email_sent_at', 0) or 0),
            'completion_email_error': str(payload.get('completion_email_error', '') or ''),
            'current_stage': str(payload.get('current_stage', '') or ''),
            'current_stage_state': str(payload.get('current_stage_state', 'queued') or 'queued'),
            'stage_started_at': float(payload.get('stage_started_at', 0) or 0),
            'provider_state': str(payload.get('provider_state', 'JOB_STATE_PENDING') or 'JOB_STATE_PENDING'),
            'submission_locked': bool(payload.get('submission_locked', True)),
            'credits_charged': int(payload.get('credits_charged', 0) or 0),
            'credits_refunded': int(payload.get('credits_refunded', 0) or 0),
            'credits_refund_pending': int(payload.get('credits_refund_pending', 0) or 0),
            'last_heartbeat_at': float(payload.get('last_heartbeat_at', now_ts) or now_ts),
            'client_submission_id': str(payload.get('client_submission_id', '') or ''),
        }
    )
    _upsert_batch(batch_id, payload, runtime=resolved_runtime, merge=False)
    for row in row_payloads:
        row_id = str(row.get('row_id', '') or resolved_runtime.uuid.uuid4())
        row_payload = dict(row)
        row_payload.update(
            {
                'row_id': row_id,
                'batch_id': batch_id,
                'status': row_payload.get('status', 'queued'),
                'created_at': row_payload.get('created_at', now_ts),
                'updated_at': now_ts,
                'token_usage_by_stage': row_payload.get('token_usage_by_stage', {}),
                'token_input_total': int(row_payload.get('token_input_total', 0) or 0),
                'token_output_total': int(row_payload.get('token_output_total', 0) or 0),
                'token_total': int(row_payload.get('token_total', 0) or 0),
                'billing_mode': 'batch',
                'billing_multiplier': float(row_payload.get('billing_multiplier', 0.5) or 0.5),
                'current_stage': str(row_payload.get('current_stage', 'queued') or 'queued'),
                'last_stage_update_at': float(row_payload.get('last_stage_update_at', now_ts) or now_ts),
                'interview_features_refunded_count': int(row_payload.get('interview_features_refunded_count', 0) or 0),
                'credits_charged': int(
                    row_payload.get(
                        'credits_charged',
                        1 + int(row_payload.get('interview_features_cost', 0) or 0),
                    ) or 0
                ),
            }
        )
        _upsert_row(batch_id, row_id, row_payload, runtime=resolved_runtime, merge=False)
    return batch_id


def _batch_state_name(batch_job):
    state = getattr(batch_job, 'state', '')
    if isinstance(state, str):
        return state
    return str(getattr(state, 'name', '') or '')


def _is_terminal_status(status):
    return str(status or '').strip().lower() in {'complete', 'partial', 'error'}


def _coerce_int(value, fallback=0):
    try:
        return int(value)
    except Exception:
        return int(fallback)


def _response_usage(response, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if isinstance(response, dict):
        usage_obj = response.get('usage_metadata')
        if not isinstance(usage_obj, dict):
            usage_obj = response.get('usageMetadata')
        if isinstance(usage_obj, dict):
            return {
                'input_tokens': int(
                    usage_obj.get('prompt_token_count', usage_obj.get('promptTokenCount', 0)) or 0
                ),
                'output_tokens': int(
                    usage_obj.get('candidates_token_count', usage_obj.get('candidatesTokenCount', 0)) or 0
                ),
                'total_tokens': int(
                    usage_obj.get('total_token_count', usage_obj.get('totalTokenCount', 0)) or 0
                ),
            }
        return {'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0}
    usage = ai_provider.extract_token_usage(response, runtime=resolved_runtime)
    return {
        'input_tokens': int(usage.get('input_tokens', 0) or 0),
        'output_tokens': int(usage.get('output_tokens', 0) or 0),
        'total_tokens': int(usage.get('total_tokens', 0) or 0),
    }


def _response_text(response, runtime=None):
    _ = runtime
    if isinstance(response, dict):
        text = str(response.get('text', '') or '').strip()
        if text:
            return text
        candidates = response.get('candidates')
        if isinstance(candidates, list) and candidates:
            first = candidates[0] if isinstance(candidates[0], dict) else {}
            content = first.get('content') if isinstance(first, dict) else {}
            parts = content.get('parts', []) if isinstance(content, dict) else []
            fragments = []
            for part in parts:
                if not isinstance(part, dict):
                    continue
                part_text = str(part.get('text', '') or '').strip()
                if part_text:
                    fragments.append(part_text)
            if fragments:
                return '\n'.join(fragments).strip()
        return ''
    text = str(getattr(response, 'text', '') or '').strip()
    if text:
        return text
    candidates = getattr(response, 'candidates', None)
    if isinstance(candidates, list) and candidates:
        try:
            parts = getattr(candidates[0], 'content', None).parts
            fragments = []
            for part in parts or []:
                part_text = str(getattr(part, 'text', '') or '').strip()
                if part_text:
                    fragments.append(part_text)
            if fragments:
                return '\n'.join(fragments).strip()
        except Exception:
            pass
    return ''


def _wait_for_batch(batch_name, runtime=None, on_poll=None):
    resolved_runtime = _resolve_runtime(runtime)
    poll_seconds = max(5, int(getattr(resolved_runtime, 'BATCH_POLL_SECONDS', 20) or 20))
    pending_poll_seconds = max(5, int(getattr(resolved_runtime, 'BATCH_PENDING_POLL_SECONDS', poll_seconds) or poll_seconds))
    running_poll_seconds = max(5, int(getattr(resolved_runtime, 'BATCH_RUNNING_POLL_SECONDS', poll_seconds) or poll_seconds))
    max_wait_seconds = max(300, int(getattr(resolved_runtime, 'BATCH_MAX_WAIT_SECONDS', 24 * 60 * 60) or (24 * 60 * 60)))
    started_at = resolved_runtime.time.time()
    batch_job = ai_provider.run_with_provider_retry(
        f'batch_poll:{batch_name}:initial',
        lambda: resolved_runtime.client.batches.get(name=batch_name),
        runtime=resolved_runtime,
    )
    if callable(on_poll):
        try:
            on_poll(_batch_state_name(batch_job))
        except Exception:
            pass
    while _batch_state_name(batch_job) not in TERMINAL_BATCH_STATES:
        if resolved_runtime.time.time() - started_at >= max_wait_seconds:
            raise TimeoutError(f'Batch job {batch_name} timed out.')
        current_state = _batch_state_name(batch_job)
        sleep_seconds = running_poll_seconds if current_state == 'JOB_STATE_RUNNING' else pending_poll_seconds
        resolved_runtime.time.sleep(max(5, sleep_seconds if sleep_seconds > 0 else poll_seconds))
        batch_job = ai_provider.run_with_provider_retry(
            f'batch_poll:{batch_name}',
            lambda: resolved_runtime.client.batches.get(name=batch_name),
            runtime=resolved_runtime,
        )
        if callable(on_poll):
            try:
                on_poll(_batch_state_name(batch_job))
            except Exception:
                pass
    return batch_job


def _run_batch_stage(batch_id, stage_name, requests, request_keys=None, runtime=None, display_name=''):
    resolved_runtime = _resolve_runtime(runtime)
    if not requests:
        return []
    model = _batch_model(stage_name, resolved_runtime)
    now_ts = resolved_runtime.time.time()
    _upsert_batch(
        batch_id,
        {
            'current_stage': str(stage_name or ''),
            'current_stage_state': 'queued',
            'stage_started_at': now_ts,
            'provider_state': 'JOB_STATE_PENDING',
            'last_heartbeat_at': now_ts,
            'updated_at': now_ts,
        },
        runtime=resolved_runtime,
        merge=True,
    )
    local_input_path = resolved_runtime.os.path.join(
        resolved_runtime.UPLOAD_FOLDER,
        f'{batch_id}_{stage_name}_{resolved_runtime.uuid.uuid4().hex}.jsonl',
    )
    batch_job = None
    input_file_handle = None
    uploaded_input_file = None
    request_keys = list(request_keys or [])
    if len(request_keys) != len(requests):
        request_keys = [f'request-{idx + 1}' for idx in range(len(requests))]
    try:
        with open(local_input_path, 'w', encoding='utf-8') as handle:
            for idx, request in enumerate(requests):
                line = {'key': request_keys[idx], 'request': request}
                handle.write(json.dumps(line, ensure_ascii=False) + '\n')

        input_file_handle = ai_provider.run_with_provider_retry(
            f'{stage_name}:batch_input_upload',
            lambda: resolved_runtime.client.files.upload(
                file=local_input_path,
                config={'mime_type': 'jsonl'},
            ),
            runtime=resolved_runtime,
        )
        uploaded_input_file = input_file_handle
        batch_job = ai_provider.run_with_provider_retry(
            f'{stage_name}:batch_create',
            lambda: resolved_runtime.client.batches.create(
                model=model,
                src=getattr(input_file_handle, 'name', ''),
                config={'display_name': display_name or f'{batch_id}-{stage_name}'},
            ),
            runtime=resolved_runtime,
        )
        _upsert_batch(
            batch_id,
            {
                'current_stage': str(stage_name or ''),
                'current_stage_state': 'running',
                'provider_state': _batch_state_name(batch_job) or 'JOB_STATE_PENDING',
                'last_heartbeat_at': resolved_runtime.time.time(),
                'updated_at': resolved_runtime.time.time(),
            },
            runtime=resolved_runtime,
            merge=True,
        )
    finally:
        try:
            resolved_runtime.os.remove(local_input_path)
        except Exception:
            pass

    external_ref = str(getattr(batch_job, 'name', '') or '')
    if external_ref:
        parent = _get_batch(batch_id, runtime=resolved_runtime) or {}
        refs = dict(parent.get('external_batch_refs', {}))
        refs[stage_name] = external_ref
        _upsert_batch(
            batch_id,
            {
                'external_batch_refs': refs,
                'updated_at': resolved_runtime.time.time(),
            },
            runtime=resolved_runtime,
            merge=True,
        )
    try:
        def _on_poll(state_name):
            now = resolved_runtime.time.time()
            _upsert_batch(
                batch_id,
                {
                    'current_stage': str(stage_name or ''),
                    'current_stage_state': 'running',
                    'provider_state': str(state_name or ''),
                    'last_heartbeat_at': now,
                    'updated_at': now,
                },
                runtime=resolved_runtime,
                merge=True,
            )

        final_job = _wait_for_batch(getattr(batch_job, 'name', ''), runtime=resolved_runtime, on_poll=_on_poll)
        final_state = _batch_state_name(final_job)
        _upsert_batch(
            batch_id,
            {
                'current_stage': str(stage_name or ''),
                'current_stage_state': 'finished' if final_state == 'JOB_STATE_SUCCEEDED' else 'failed',
                'provider_state': final_state,
                'last_heartbeat_at': resolved_runtime.time.time(),
                'updated_at': resolved_runtime.time.time(),
            },
            runtime=resolved_runtime,
            merge=True,
        )
        if final_state != 'JOB_STATE_SUCCEEDED':
            error_obj = getattr(final_job, 'error', None)
            raise RuntimeError(f'Batch stage {stage_name} failed with state {final_state}: {error_obj}')
        responses = []

        result_file_name = str(getattr(getattr(final_job, 'dest', None), 'file_name', '') or '')
        if result_file_name:
            content_bytes = ai_provider.run_with_provider_retry(
                f'{stage_name}:batch_result_download',
                lambda: resolved_runtime.client.files.download(file=result_file_name),
                runtime=resolved_runtime,
            )
            key_map = {}
            for idx, key in enumerate(request_keys):
                key_map[str(key)] = idx
            parsed_by_index = {}
            decoded = content_bytes.decode('utf-8') if isinstance(content_bytes, (bytes, bytearray)) else str(content_bytes or '')
            for line in decoded.splitlines():
                line_text = str(line or '').strip()
                if not line_text:
                    continue
                try:
                    record = json.loads(line_text)
                except Exception:
                    continue
                if not isinstance(record, dict):
                    continue
                key = str(record.get('key', '') or '')
                if key not in key_map:
                    continue
                parsed_by_index[key_map[key]] = {
                    'response': record.get('response'),
                    'error': record.get('error'),
                }
            for idx in range(len(requests)):
                responses.append(parsed_by_index.get(idx, {'response': None, 'error': 'Missing response line'}))
            return responses

        inline_responses = getattr(getattr(final_job, 'dest', None), 'inlined_responses', None) or []
        for inline in inline_responses:
            response = getattr(inline, 'response', None)
            error = getattr(inline, 'error', None)
            responses.append({'response': response, 'error': error})
        return responses
    finally:
        cleanup_files = []
        cleanup_gemini_files = []
        if uploaded_input_file is not None:
            cleanup_gemini_files.append(uploaded_input_file)
        resolved_runtime.cleanup_files(cleanup_files, cleanup_gemini_files)


def _merge_prompt_for_row(row, runtime):
    slide_text = str(row.get('slide_text', '') or '')
    transcript = str(row.get('transcript', '') or '')
    output_language = str(row.get('output_language', 'English') or 'English')
    transcript_segments = row.get('transcript_segments', []) or []
    merge_transcript = (
        study_audio.format_transcript_with_timestamps(transcript_segments, runtime=runtime)
        if transcript_segments
        else transcript
    )
    if runtime.FEATURE_AUDIO_SECTION_SYNC and transcript_segments:
        return runtime.PROMPT_MERGE_WITH_AUDIO_MARKERS.format(
            slide_text=slide_text,
            transcript=merge_transcript,
            output_language=output_language,
        )
    return runtime.PROMPT_MERGE_TEMPLATE.format(
        slide_text=slide_text,
        transcript=transcript,
        output_language=output_language,
    )


def _record_stage_tokens(row, stage_name, usage, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    stage_usage = dict(row.get('token_usage_by_stage', {}) or {})
    stage_usage[stage_name] = {
        'input_tokens': int(usage.get('input_tokens', 0) or 0),
        'output_tokens': int(usage.get('output_tokens', 0) or 0),
        'total_tokens': int(usage.get('total_tokens', 0) or 0),
        'model': _batch_model(stage_name, resolved_runtime),
        'billing_mode': 'batch',
        'input_modality': 'audio' if stage_name in {'audio_transcription', 'interview_transcription'} else 'text',
    }
    row['token_usage_by_stage'] = stage_usage
    row['token_input_total'] = sum(int(((entry or {}).get('input_tokens', 0) or 0)) for entry in stage_usage.values())
    row['token_output_total'] = sum(int(((entry or {}).get('output_tokens', 0) or 0)) for entry in stage_usage.values())
    row['token_total'] = sum(int(((entry or {}).get('total_tokens', 0) or 0)) for entry in stage_usage.values())


def _build_stage_requests(rows, builder):
    requests = []
    request_rows = []
    for row in rows:
        request_payload = builder(row)
        if request_payload is None:
            continue
        requests.append(request_payload)
        request_rows.append(row)
    return requests, request_rows


def _run_stage_with_builder(batch_id, rows, stage_name, builder, handler, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    now_ts = resolved_runtime.time.time()
    _upsert_batch(
        batch_id,
        {
            'current_stage': str(stage_name or ''),
            'current_stage_state': 'running',
            'stage_started_at': now_ts,
            'updated_at': now_ts,
        },
        runtime=resolved_runtime,
        merge=True,
    )
    for row in rows:
        if str(row.get('status', '') or '') == 'error':
            continue
        row['status'] = 'processing'
        row['current_stage'] = str(stage_name or '')
        row['last_stage_update_at'] = now_ts
        row['updated_at'] = now_ts
        _upsert_row(
            batch_id,
            row.get('row_id', ''),
            {
                'status': row['status'],
                'current_stage': row['current_stage'],
                'last_stage_update_at': row['last_stage_update_at'],
                'updated_at': row['updated_at'],
            },
            runtime=resolved_runtime,
            merge=True,
        )

    requests, request_rows = _build_stage_requests(rows, builder)
    for row in rows:
        if row in request_rows:
            continue
        _upsert_row(
            batch_id,
            row.get('row_id', ''),
            {
                'status': row.get('status', 'queued'),
                'failed_stage': row.get('failed_stage', ''),
                'error': row.get('error', ''),
                'current_stage': row.get('current_stage', ''),
                'last_stage_update_at': row.get('last_stage_update_at', now_ts),
                'updated_at': resolved_runtime.time.time(),
            },
            runtime=resolved_runtime,
            merge=True,
        )
    if not requests:
        _upsert_batch(
            batch_id,
            {
                'current_stage': str(stage_name or ''),
                'current_stage_state': 'skipped',
                'updated_at': resolved_runtime.time.time(),
            },
            runtime=resolved_runtime,
            merge=True,
        )
        return
    request_keys = []
    for idx, row in enumerate(request_rows):
        row_id = str(row.get('row_id', '') or '')
        if row_id:
            request_keys.append(row_id)
        else:
            request_keys.append(f'{stage_name}-{idx + 1}')
    responses = _run_batch_stage(
        batch_id,
        stage_name,
        requests,
        request_keys=request_keys,
        runtime=resolved_runtime,
        display_name=f'{batch_id}-{stage_name}-{datetime.now(timezone.utc).strftime("%Y%m%d%H%M%S")}',
    )
    for idx, row in enumerate(request_rows):
        response_entry = responses[idx] if idx < len(responses) else {'error': 'Missing response'}
        error = response_entry.get('error')
        if error:
            row['status'] = 'error'
            row['failed_stage'] = stage_name
            row['error'] = str(error)
            row['last_stage_update_at'] = resolved_runtime.time.time()
            _upsert_row(
                batch_id,
                row.get('row_id', ''),
                {
                    'status': row.get('status', 'error'),
                    'failed_stage': row.get('failed_stage', ''),
                    'error': row.get('error', ''),
                    'current_stage': str(stage_name or ''),
                    'last_stage_update_at': row.get('last_stage_update_at', 0),
                    'updated_at': resolved_runtime.time.time(),
                },
                runtime=resolved_runtime,
                merge=True,
            )
            continue
        response = response_entry.get('response')
        usage = _response_usage(response, runtime=resolved_runtime)
        _record_stage_tokens(row, stage_name, usage, runtime=resolved_runtime)
        handler(row, response)
        row['current_stage'] = str(stage_name or '')
        row['last_stage_update_at'] = resolved_runtime.time.time()
        _upsert_row(
            batch_id,
            row.get('row_id', ''),
            {
                'status': row.get('status', 'processing'),
                'failed_stage': row.get('failed_stage', ''),
                'error': row.get('error', ''),
                'current_stage': row.get('current_stage', ''),
                'last_stage_update_at': row.get('last_stage_update_at', 0),
                'token_usage_by_stage': row.get('token_usage_by_stage', {}),
                'token_input_total': int(row.get('token_input_total', 0) or 0),
                'token_output_total': int(row.get('token_output_total', 0) or 0),
                'token_total': int(row.get('token_total', 0) or 0),
                'updated_at': resolved_runtime.time.time(),
            },
            runtime=resolved_runtime,
            merge=True,
        )


def _upload_row_files(row, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    local_paths = row.setdefault('_local_paths', [])
    gemini_files = row.setdefault('_gemini_files', [])

    slides_path = str(row.get('slides_local_path', '') or '').strip()
    if slides_path and not row.get('slides_file_uri'):
        pdf_file = ai_provider.run_with_provider_retry(
            'batch_slide_upload',
            lambda: resolved_runtime.client.files.upload(file=slides_path, config={'mime_type': 'application/pdf'}),
            runtime=resolved_runtime,
        )
        gemini_files.append(pdf_file)
        ai_provider.run_with_provider_retry(
            'batch_slide_file_processing',
            lambda: resolved_runtime.wait_for_file_processing(pdf_file),
            runtime=resolved_runtime,
        )
        row['slides_file_uri'] = str(getattr(pdf_file, 'uri', '') or '')

    audio_path = str(row.get('audio_local_path', '') or '').strip()
    if audio_path and not row.get('audio_file_uri'):
        converted_path, converted = resolved_runtime.convert_audio_to_mp3_with_ytdlp(audio_path)
        if converted and converted_path not in local_paths:
            local_paths.append(converted_path)
        upload_path = converted_path if converted else audio_path
        audio_mime = resolved_runtime.get_mime_type(upload_path)
        audio_file = ai_provider.run_with_provider_retry(
            'batch_audio_upload',
            lambda: resolved_runtime.client.files.upload(file=upload_path, config={'mime_type': audio_mime}),
            runtime=resolved_runtime,
        )
        gemini_files.append(audio_file)
        ai_provider.run_with_provider_retry(
            'batch_audio_file_processing',
            lambda: resolved_runtime.wait_for_file_processing(audio_file),
            runtime=resolved_runtime,
        )
        row['audio_file_uri'] = str(getattr(audio_file, 'uri', '') or '')
        row['audio_mime_type'] = audio_mime
        row['audio_storage_key'] = study_audio.persist_audio_for_study_pack(row.get('row_job_id', ''), upload_path, runtime=resolved_runtime)


def _finalize_row_job_log(batch, row, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    row_job_id = str(row.get('row_job_id', '') or resolved_runtime.uuid.uuid4())
    row['row_job_id'] = row_job_id
    finished_at = resolved_runtime.time.time()
    status = str(row.get('status', '') or '')
    if status != 'error':
        row['status'] = 'complete'
        row['error'] = ''
    result_text = str(row.get('result', '') or row.get('merged_notes', '') or row.get('transcript', '') or row.get('slide_text', ''))
    job_data = {
        'user_id': batch.get('uid', ''),
        'user_email': batch.get('email', ''),
        'mode': batch.get('mode', ''),
        'status': row.get('status', ''),
        'started_at': row.get('started_at', batch.get('created_at', finished_at)),
        'result': result_text,
        'slide_text': row.get('slide_text', ''),
        'transcript': row.get('transcript', ''),
        'flashcards': row.get('flashcards', []),
        'test_questions': row.get('test_questions', []),
        'study_features': row.get('study_features', 'none'),
        'output_language': row.get('output_language', 'English'),
        'interview_features': row.get('interview_features', []),
        'interview_summary': row.get('interview_summary'),
        'interview_sections': row.get('interview_sections'),
        'interview_combined': row.get('interview_combined'),
        'study_generation_error': row.get('study_generation_error'),
        'credit_deducted': row.get('credit_deducted', ''),
        'credit_refunded': row.get('credit_refunded', False),
        'billing_receipt': row.get('billing_receipt', {}),
        'failed_stage': row.get('failed_stage', ''),
        'provider_error_code': row.get('provider_error_code', ''),
        'retry_attempts': int(row.get('retry_attempts', 0) or 0),
        'token_usage_by_stage': row.get('token_usage_by_stage', {}),
        'token_input_total': int(row.get('token_input_total', 0) or 0),
        'token_output_total': int(row.get('token_output_total', 0) or 0),
        'token_total': int(row.get('token_total', 0) or 0),
        'is_batch': True,
        'batch_parent_id': batch.get('batch_id', ''),
        'batch_row_id': row.get('row_id', ''),
        'billing_mode': 'batch',
        'billing_multiplier': 0.5,
        'source_type': row.get('source_type', ''),
        'source_url': row.get('source_url', ''),
        'source_name': row.get('source_name', ''),
    }
    if row.get('status') == 'complete':
        ai_pipelines.save_study_pack(row_job_id, job_data, runtime=resolved_runtime)
        if job_data.get('study_pack_id'):
            row['study_pack_id'] = job_data.get('study_pack_id')
            folder_id = str(batch.get('folder_id', '') or '')
            folder_name = str(batch.get('folder_name', '') or '')
            if folder_id and getattr(resolved_runtime, 'db', None) is not None:
                try:
                    resolved_runtime.study_repo.study_pack_doc_ref(
                        resolved_runtime.db,
                        job_data['study_pack_id'],
                    ).update(
                        {
                            'folder_id': folder_id,
                            'folder_name': folder_name,
                            'updated_at': resolved_runtime.time.time(),
                        }
                    )
                except Exception:
                    resolved_runtime.logger.warning('Could not assign batch folder to study pack %s', job_data['study_pack_id'], exc_info=True)
    resolved_runtime.save_job_log(row_job_id, job_data, finished_at)
    row['job_log_id'] = row_job_id
    row['updated_at'] = resolved_runtime.time.time()
    row['finished_at'] = finished_at


def _refund_failed_row(batch, row, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    uid = batch.get('uid', '')
    if not uid:
        return

    credit_type = str(row.get('credit_deducted', '') or '').strip()
    billing_receipt = dict(row.get('billing_receipt', {}) or {})
    receipt_holder = {'billing_receipt': billing_receipt}
    if credit_type and not bool(row.get('credit_refunded', False)):
        refunded_primary = bool(billing_credits.refund_credit(uid, credit_type, runtime=resolved_runtime))
        if refunded_primary:
            row['credit_refunded'] = True
            billing_receipts.add_job_credit_refund(
                receipt_holder,
                credit_type,
                1,
                runtime=resolved_runtime,
            )

    interview_feature_cost = int(row.get('interview_features_cost', 0) or 0)
    already_refunded = int(row.get('interview_features_refunded_count', 0) or 0)
    pending_refund = max(0, interview_feature_cost - already_refunded)
    if pending_refund > 0:
        refunded_extras = bool(billing_credits.refund_slides_credits(uid, pending_refund, runtime=resolved_runtime))
        if refunded_extras:
            row['interview_features_refunded_count'] = already_refunded + pending_refund
            billing_receipts.add_job_credit_refund(
                receipt_holder,
                'slides_credits',
                pending_refund,
                runtime=resolved_runtime,
            )

    row['billing_receipt'] = receipt_holder.get('billing_receipt', billing_receipt)


def _cleanup_empty_batch_folder(batch, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is None or not isinstance(batch, dict):
        return False

    batch_id = str(batch.get('batch_id', '') or '').strip()
    uid = str(batch.get('uid', '') or '').strip()
    folder_id = str(batch.get('folder_id', '') or '').strip()
    if not batch_id or not uid or not folder_id:
        return False

    try:
        existing_packs = resolved_runtime.study_repo.list_study_packs_by_uid_and_folder(db, uid, folder_id)
        if existing_packs:
            return False
        folder_ref = resolved_runtime.study_repo.study_folder_doc_ref(db, folder_id)
        folder_doc = folder_ref.get()
        if not folder_doc.exists:
            return False
        folder_payload = folder_doc.to_dict() or {}
        if str(folder_payload.get('uid', '') or '').strip() != uid:
            return False
        folder_ref.delete()
        _upsert_batch(
            batch_id,
            {
                'folder_id': '',
                'updated_at': resolved_runtime.time.time(),
            },
            runtime=resolved_runtime,
            merge=True,
        )
        return True
    except Exception:
        resolved_runtime.logger.warning('Could not clean up empty batch folder for %s', batch_id, exc_info=True)
        return False


def _finalize_batch_record(
    batch_id,
    batch,
    stage_error='',
    status_override='',
    provider_state_override='',
    current_stage_state_override='',
    current_stage_override=None,
    runtime=None,
):
    resolved_runtime = _resolve_runtime(runtime)
    completed_rows = 0
    failed_rows = 0
    token_input_total = 0
    token_output_total = 0
    token_total = 0
    credits_charged_total = 0
    credits_refunded_total = 0
    expected_refund_total = 0

    current_rows = _list_rows(batch_id, runtime=resolved_runtime)
    for row in current_rows:
        status = str(row.get('status', '') or '')
        if status == 'complete':
            completed_rows += 1
        elif status == 'error':
            failed_rows += 1
        token_input_total += int(row.get('token_input_total', 0) or 0)
        token_output_total += int(row.get('token_output_total', 0) or 0)
        token_total += int(row.get('token_total', 0) or 0)
        row_credits_charged = int(
            row.get(
                'credits_charged',
                1 + int(row.get('interview_features_cost', 0) or 0),
            ) or 0
        )
        credits_charged_total += max(0, row_credits_charged)
        row_refunded = (1 if bool(row.get('credit_refunded', False)) else 0) + int(row.get('interview_features_refunded_count', 0) or 0)
        credits_refunded_total += max(0, row_refunded)
        if status == 'error':
            expected_refund_total += max(0, row_credits_charged)
        local_paths = row.get('_local_paths', []) or []
        gemini_files = row.get('_gemini_files', []) or []
        if local_paths or gemini_files:
            resolved_runtime.cleanup_files(local_paths, gemini_files)

    total_rows = int((batch or {}).get('total_rows', len(current_rows)) or len(current_rows))
    computed_status = 'error'
    if completed_rows == total_rows and failed_rows == 0:
        computed_status = 'complete'
    elif completed_rows > 0 and failed_rows > 0:
        computed_status = 'partial'

    final_status = str(status_override or computed_status).strip().lower() or computed_status
    credits_refund_pending = max(0, expected_refund_total - credits_refunded_total)
    finished_at = resolved_runtime.time.time()
    latest_batch_snapshot = _get_batch(batch_id, runtime=resolved_runtime) or {}

    next_current_stage = latest_batch_snapshot.get('current_stage', '') or ''
    if current_stage_override is not None:
        next_current_stage = str(current_stage_override or '')

    next_current_stage_state = 'finished' if _is_terminal_status(final_status) else 'running'
    if current_stage_state_override:
        next_current_stage_state = str(current_stage_state_override or next_current_stage_state)

    next_provider_state = 'COMPLETED' if final_status == 'complete' else ('PARTIAL' if final_status == 'partial' else 'FAILED')
    if provider_state_override:
        next_provider_state = str(provider_state_override or next_provider_state)

    error_summary = str(stage_error or latest_batch_snapshot.get('error_summary', '') or '').strip()[:1500]

    _upsert_batch(
        batch_id,
        {
            'status': final_status,
            'completed_rows': completed_rows,
            'failed_rows': failed_rows,
            'token_input_total': token_input_total,
            'token_output_total': token_output_total,
            'token_total': token_total,
            'credits_charged': credits_charged_total,
            'credits_refunded': credits_refunded_total,
            'credits_refund_pending': credits_refund_pending,
            'updated_at': finished_at,
            'finished_at': finished_at,
            'error_summary': error_summary,
            'current_stage': next_current_stage,
            'current_stage_state': next_current_stage_state,
            'provider_state': next_provider_state,
            'last_heartbeat_at': finished_at,
            'submission_locked': False,
        },
        runtime=resolved_runtime,
        merge=True,
    )
    finalized_batch = _get_batch(batch_id, runtime=resolved_runtime) or latest_batch_snapshot or dict(batch or {})
    if final_status == 'error' and completed_rows == 0:
        _cleanup_empty_batch_folder(finalized_batch, runtime=resolved_runtime)
        finalized_batch = _get_batch(batch_id, runtime=resolved_runtime) or finalized_batch
    _send_batch_completion_email_if_needed(batch_id, final_status, runtime=resolved_runtime)
    return finalized_batch


def _mark_incomplete_rows_failed(batch_id, batch, rows, error_message, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    for row in rows:
        status = str(row.get('status', '') or '').strip().lower() or 'queued'
        if status not in ACTIVE_ROW_STATUSES:
            continue
        row['status'] = 'error'
        row['error'] = str(row.get('error', '') or error_message or BATCH_INTERRUPTED_PUBLIC_MESSAGE).strip()[:1500]
        if not row.get('failed_stage'):
            row['failed_stage'] = row.get('current_stage', '') or batch.get('current_stage', '') or 'batch_pipeline'
        row['current_stage'] = row.get('current_stage', '') or batch.get('current_stage', '') or ''
        row['last_stage_update_at'] = resolved_runtime.time.time()
        _refund_failed_row(batch, row, runtime=resolved_runtime)
        _finalize_row_job_log(batch, row, runtime=resolved_runtime)
        _upsert_row(
            batch_id,
            row.get('row_id', ''),
            row,
            runtime=resolved_runtime,
            merge=False,
        )


def _repair_batch_state_if_needed(batch_id, batch=None, rows=None, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    safe_batch_id = str(batch_id or '').strip()
    if not safe_batch_id:
        return batch, rows

    current_batch = batch or _get_batch(safe_batch_id, runtime=resolved_runtime)
    if not current_batch:
        return None, []
    current_rows = rows if isinstance(rows, list) else _list_rows(safe_batch_id, runtime=resolved_runtime)
    now_ts = resolved_runtime.time.time()
    current_status = str(current_batch.get('status', '') or '').strip().lower()

    if _batch_is_stale(current_batch, runtime=resolved_runtime, now_ts=now_ts):
        _mark_incomplete_rows_failed(
            safe_batch_id,
            current_batch,
            current_rows,
            BATCH_INTERRUPTED_PUBLIC_MESSAGE,
            runtime=resolved_runtime,
        )
        current_batch = _finalize_batch_record(
            safe_batch_id,
            current_batch,
            stage_error=BATCH_INTERRUPTED_PUBLIC_MESSAGE,
            status_override='error',
            provider_state_override='INTERRUPTED',
            current_stage_state_override='failed',
            runtime=resolved_runtime,
        )
        current_rows = _list_rows(safe_batch_id, runtime=resolved_runtime)
        return current_batch, current_rows

    if _is_terminal_status(current_status):
        if current_status == 'error' and int(current_batch.get('completed_rows', 0) or 0) == 0:
            _cleanup_empty_batch_folder(current_batch, runtime=resolved_runtime)
            current_batch = _get_batch(safe_batch_id, runtime=resolved_runtime) or current_batch
        has_incomplete_rows = any(
            (str((row or {}).get('status', '') or '').strip().lower() or 'queued') in ACTIVE_ROW_STATUSES
            for row in current_rows
        )
        if has_incomplete_rows:
            repair_message = str(current_batch.get('error_summary', '') or '').strip() or BATCH_INTERRUPTED_PUBLIC_MESSAGE
            _mark_incomplete_rows_failed(
                safe_batch_id,
                current_batch,
                current_rows,
                repair_message,
                runtime=resolved_runtime,
            )
            current_batch = _finalize_batch_record(
                safe_batch_id,
                current_batch,
                stage_error=repair_message,
                provider_state_override='INTERRUPTED' if 'interrupted' in repair_message.lower() or 'restart' in repair_message.lower() else '',
                current_stage_state_override='failed',
                runtime=resolved_runtime,
            )
            current_rows = _list_rows(safe_batch_id, runtime=resolved_runtime)
    return current_batch, current_rows


def recover_stale_batches(runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is None:
        return 0

    try:
        limit = max(1, int(getattr(resolved_runtime, 'BATCH_JOB_RECOVERY_BATCH_LIMIT', 100) or 100))
    except Exception:
        limit = 100

    recovered = 0
    try:
        docs = resolved_runtime.batch_repo.list_active_batch_jobs(
            db,
            ACTIVE_BATCH_STATUSES,
            limit=limit,
        )
    except Exception:
        resolved_runtime.logger.warning('Batch recovery query failed', exc_info=True)
        return 0

    now_ts = resolved_runtime.time.time()
    for doc in docs:
        payload = doc.to_dict() or {}
        payload.setdefault('batch_id', doc.id)
        if not _batch_is_stale(payload, runtime=resolved_runtime, now_ts=now_ts):
            continue
        repaired_batch, _repaired_rows = _repair_batch_state_if_needed(
            doc.id,
            batch=payload,
            rows=None,
            runtime=resolved_runtime,
        )
        if repaired_batch:
            recovered += 1

    if recovered:
        resolved_runtime.logger.warning('Recovered %s stale batch job(s) after startup.', recovered)
    return recovered


def acquire_batch_recovery_lease(now_ts=None, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is None:
        return True

    lease_collection = str(getattr(resolved_runtime, 'BATCH_JOB_RECOVERY_LEASE_COLLECTION', 'batch_job_recovery_leases') or '').strip()
    lease_id = str(getattr(resolved_runtime, 'BATCH_JOB_RECOVERY_LEASE_ID', 'startup') or '').strip()
    if not lease_collection or not lease_id:
        return True

    now_ts = float(now_ts if isinstance(now_ts, (int, float)) else resolved_runtime.time.time())
    lease_seconds = max(30, min(int(getattr(resolved_runtime, 'BATCH_JOB_RECOVERY_LEASE_SECONDS', 300) or 300), 3600))
    holder_id = (
        str(resolved_runtime.os.getenv('RENDER_INSTANCE_ID', '') or '').strip()
        or str(resolved_runtime.os.getenv('HOSTNAME', '') or '').strip()
        or f'pid-{resolved_runtime.os.getpid()}'
    )
    lease_ref = db.collection(lease_collection).document(lease_id)
    transaction = db.transaction()

    @resolved_runtime.firestore.transactional
    def _txn(txn):
        snapshot = lease_ref.get(transaction=txn)
        existing = snapshot.to_dict() or {}
        existing_expires_at = resolved_runtime.get_timestamp(existing.get('expires_at'))
        if snapshot.exists and existing_expires_at > now_ts:
            return False
        txn.set(
            lease_ref,
            {
                'lease_id': lease_id,
                'holder_id': holder_id,
                'acquired_at': now_ts,
                'expires_at': now_ts + lease_seconds,
            },
            merge=True,
        )
        return True

    try:
        return bool(_txn(transaction))
    except Exception:
        resolved_runtime.logger.warning(
            'Could not acquire batch recovery lease; continuing without distributed lock.',
            exc_info=True,
        )
        return True


def run_startup_batch_recovery_once(runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    core_obj = getattr(resolved_runtime, 'core', resolved_runtime)
    with core_obj.BATCH_JOB_RECOVERY_LOCK:
        if core_obj.BATCH_JOB_RECOVERY_DONE:
            return
        core_obj.BATCH_JOB_RECOVERY_DONE = True
    if not bool(getattr(resolved_runtime, 'BATCH_JOB_RECOVERY_ENABLED', True)):
        resolved_runtime.logger.info('Batch recovery disabled via ENABLE_BATCH_JOB_RECOVERY.')
        return
    if not acquire_batch_recovery_lease(runtime=resolved_runtime):
        resolved_runtime.logger.info('Skipping startup batch recovery; lease already held by another instance.')
        return
    recover_stale_batches(runtime=resolved_runtime)


def process_batch_job(batch_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    batch = _get_batch(batch_id, runtime=resolved_runtime)
    if not batch:
        return
    if _is_terminal_status(batch.get('status', '')):
        return
    rows = _list_rows(batch_id, runtime=resolved_runtime)
    if not rows:
        batch = {
            **batch,
            'current_stage': 'validation',
        }
        _finalize_batch_record(
            batch_id,
            batch,
            stage_error='Batch has no rows.',
            status_override='error',
            provider_state_override='NO_ROWS',
            current_stage_state_override='failed',
            current_stage_override='validation',
            runtime=resolved_runtime,
        )
        return

    _upsert_batch(
        batch_id,
        {
            'status': 'processing',
            'current_stage': 'file_upload',
            'current_stage_state': 'running',
            'stage_started_at': resolved_runtime.time.time(),
            'provider_state': 'FILE_UPLOAD',
            'last_heartbeat_at': resolved_runtime.time.time(),
            'updated_at': resolved_runtime.time.time(),
            'submission_locked': True,
        },
        runtime=resolved_runtime,
        merge=True,
    )
    stage_error = ''
    try:
        for row in rows:
            row.setdefault('status', 'processing')
            row.setdefault('started_at', batch.get('created_at', resolved_runtime.time.time()))
            row.setdefault('token_usage_by_stage', {})
            row.setdefault('token_input_total', 0)
            row.setdefault('token_output_total', 0)
            row.setdefault('token_total', 0)
            row.setdefault('row_job_id', str(resolved_runtime.uuid.uuid4()))
            row.setdefault('current_stage', 'file_upload')
            row.setdefault('last_stage_update_at', resolved_runtime.time.time())
            row['status'] = 'processing'
            row['current_stage'] = 'file_upload'
            row['last_stage_update_at'] = resolved_runtime.time.time()
            _upsert_row(
                batch_id,
                row.get('row_id', ''),
                {
                    'status': row['status'],
                    'current_stage': row['current_stage'],
                    'last_stage_update_at': row['last_stage_update_at'],
                    'updated_at': resolved_runtime.time.time(),
                },
                runtime=resolved_runtime,
                merge=True,
            )
            _upload_row_files(row, runtime=resolved_runtime)
            row['last_stage_update_at'] = resolved_runtime.time.time()
            _upsert_row(
                batch_id,
                row.get('row_id', ''),
                {
                    'status': row.get('status', 'processing'),
                    'current_stage': row.get('current_stage', 'file_upload'),
                    'last_stage_update_at': row.get('last_stage_update_at', 0),
                    'updated_at': resolved_runtime.time.time(),
                },
                runtime=resolved_runtime,
                merge=True,
            )

        mode = str(batch.get('mode', '') or '')
        if mode in {'lecture-notes', 'slides-only'}:
            def _slide_builder(row):
                if row.get('status') == 'error' or not row.get('slides_file_uri'):
                    return None
                return {
                    'contents': [
                        {
                            'role': 'user',
                            'parts': [
                                {
                                    'file_data': {
                                        'file_uri': row.get('slides_file_uri', ''),
                                        'mime_type': 'application/pdf',
                                    }
                                },
                                {'text': resolved_runtime.PROMPT_SLIDE_EXTRACTION},
                            ],
                        }
                    ]
                }

            def _slide_handler(row, response):
                row['slide_text'] = _response_text(response, runtime=resolved_runtime)

            _run_stage_with_builder(batch_id, rows, 'slide_extraction', _slide_builder, _slide_handler, runtime=resolved_runtime)

        if mode == 'lecture-notes':
            def _audio_builder(row):
                if row.get('status') == 'error' or not row.get('audio_file_uri'):
                    return None
                output_language = str(row.get('output_language', 'English') or 'English')
                if resolved_runtime.FEATURE_AUDIO_SECTION_SYNC:
                    prompt = resolved_runtime.PROMPT_AUDIO_TRANSCRIPTION_TIMESTAMPED.format(output_language=output_language)
                else:
                    prompt = resolved_runtime.PROMPT_AUDIO_TRANSCRIPTION.format(output_language=output_language)
                return {
                    'contents': [
                        {
                            'role': 'user',
                            'parts': [
                                {
                                    'file_data': {
                                        'file_uri': row.get('audio_file_uri', ''),
                                        'mime_type': row.get('audio_mime_type', 'audio/mpeg'),
                                    }
                                },
                                {'text': prompt},
                            ],
                        }
                    ]
                }

            def _audio_handler(row, response):
                raw_text = _response_text(response, runtime=resolved_runtime)
                if resolved_runtime.FEATURE_AUDIO_SECTION_SYNC:
                    parsed = resolved_runtime.extract_json_payload(raw_text)
                    if isinstance(parsed, dict):
                        segments = parsed.get('transcript_segments', [])
                        transcript = str(parsed.get('full_transcript', '') or '').strip()
                        clean_segments = []
                        if isinstance(segments, list):
                            for segment in segments:
                                if not isinstance(segment, dict):
                                    continue
                                text = str(segment.get('text', '') or '').strip()
                                if not text:
                                    continue
                                try:
                                    start_ms = int(segment.get('start_ms', 0) or 0)
                                    end_ms = int(segment.get('end_ms', start_ms) or start_ms)
                                except Exception:
                                    continue
                                clean_segments.append(
                                    {
                                        'start_ms': max(0, start_ms),
                                        'end_ms': max(start_ms, end_ms),
                                        'text': text,
                                    }
                                )
                        if not transcript:
                            transcript = '\n'.join(seg['text'] for seg in clean_segments).strip()
                        row['transcript'] = transcript
                        row['transcript_segments'] = clean_segments
                        return
                row['transcript'] = raw_text
                row['transcript_segments'] = []

            _run_stage_with_builder(batch_id, rows, 'audio_transcription', _audio_builder, _audio_handler, runtime=resolved_runtime)

            def _merge_builder(row):
                if row.get('status') == 'error':
                    return None
                if not row.get('slide_text') or not row.get('transcript'):
                    row['status'] = 'error'
                    row['failed_stage'] = 'notes_merge'
                    row['error'] = 'Missing slide extraction or transcript output.'
                    return None
                return {
                    'contents': [
                        {
                            'role': 'user',
                            'parts': [
                                {'text': _merge_prompt_for_row(row, resolved_runtime)},
                            ],
                        }
                    ]
                }

            def _merge_handler(row, response):
                merged = _response_text(response, runtime=resolved_runtime)
                row['merged_notes'] = merged
                row['result'] = merged
                row['notes_audio_map'] = (
                    study_audio.parse_audio_markers_from_notes(merged, runtime=resolved_runtime)
                    if resolved_runtime.FEATURE_AUDIO_SECTION_SYNC
                    else []
                )

            _run_stage_with_builder(batch_id, rows, 'notes_merge', _merge_builder, _merge_handler, runtime=resolved_runtime)

            def _study_builder(row):
                if row.get('status') == 'error':
                    return None
                study_features = str(row.get('study_features', 'none') or 'none')
                if study_features == 'none':
                    return None
                source_text = str(row.get('merged_notes', '') or '')
                if not source_text.strip():
                    row['status'] = 'error'
                    row['failed_stage'] = 'study_materials_generation'
                    row['error'] = 'Missing merged notes for study generation.'
                    return None
                flashcard_amount, question_amount = study_generation.resolve_study_amounts(
                    row.get('flashcard_selection', '20'),
                    row.get('question_selection', '10'),
                    source_text,
                    runtime=resolved_runtime,
                )
                if study_features == 'flashcards':
                    question_amount = 0
                elif study_features == 'test':
                    flashcard_amount = 0
                prompt = resolved_runtime.PROMPT_STUDY_TEMPLATE.format(
                    flashcard_amount=flashcard_amount,
                    question_amount=question_amount,
                    output_language=row.get('output_language', 'English'),
                    source_text=source_text[:120000],
                )
                return {
                    'contents': [{'role': 'user', 'parts': [{'text': prompt}]}]
                }

            def _study_handler(row, response):
                parsed = study_generation.extract_json_payload(_response_text(response, runtime=resolved_runtime), runtime=resolved_runtime)
                source_text = str(row.get('merged_notes', '') or '')
                flashcard_amount, question_amount = study_generation.resolve_study_amounts(
                    row.get('flashcard_selection', '20'),
                    row.get('question_selection', '10'),
                    source_text,
                    runtime=resolved_runtime,
                )
                study_features = str(row.get('study_features', 'none') or 'none')
                if study_features == 'flashcards':
                    question_amount = 0
                elif study_features == 'test':
                    flashcard_amount = 0
                if not isinstance(parsed, dict):
                    row['flashcards'] = []
                    row['test_questions'] = []
                    row['study_generation_error'] = 'Study materials JSON parsing failed.'
                    return
                row['flashcards'] = study_generation.sanitize_flashcards(
                    parsed.get('flashcards', []),
                    flashcard_amount,
                    runtime=resolved_runtime,
                )
                row['test_questions'] = study_generation.sanitize_questions(
                    parsed.get('test_questions', []),
                    question_amount,
                    runtime=resolved_runtime,
                )
                row['study_generation_error'] = None

            _run_stage_with_builder(batch_id, rows, 'study_materials_generation', _study_builder, _study_handler, runtime=resolved_runtime)

        if mode == 'slides-only':
            for row in rows:
                if row.get('status') != 'error':
                    row['result'] = str(row.get('slide_text', '') or '')
            def _slides_study_builder(row):
                if row.get('status') == 'error':
                    return None
                study_features = str(row.get('study_features', 'none') or 'none')
                if study_features == 'none':
                    return None
                source_text = str(row.get('slide_text', '') or '')
                flashcard_amount, question_amount = study_generation.resolve_study_amounts(
                    row.get('flashcard_selection', '20'),
                    row.get('question_selection', '10'),
                    source_text,
                    runtime=resolved_runtime,
                )
                if study_features == 'flashcards':
                    question_amount = 0
                elif study_features == 'test':
                    flashcard_amount = 0
                prompt = resolved_runtime.PROMPT_STUDY_TEMPLATE.format(
                    flashcard_amount=flashcard_amount,
                    question_amount=question_amount,
                    output_language=row.get('output_language', 'English'),
                    source_text=source_text[:120000],
                )
                return {'contents': [{'role': 'user', 'parts': [{'text': prompt}]}]}

            def _slides_study_handler(row, response):
                parsed = study_generation.extract_json_payload(_response_text(response, runtime=resolved_runtime), runtime=resolved_runtime)
                source_text = str(row.get('slide_text', '') or '')
                flashcard_amount, question_amount = study_generation.resolve_study_amounts(
                    row.get('flashcard_selection', '20'),
                    row.get('question_selection', '10'),
                    source_text,
                    runtime=resolved_runtime,
                )
                study_features = str(row.get('study_features', 'none') or 'none')
                if study_features == 'flashcards':
                    question_amount = 0
                elif study_features == 'test':
                    flashcard_amount = 0
                if not isinstance(parsed, dict):
                    row['flashcards'] = []
                    row['test_questions'] = []
                    row['study_generation_error'] = 'Study materials JSON parsing failed.'
                    return
                row['flashcards'] = study_generation.sanitize_flashcards(
                    parsed.get('flashcards', []),
                    flashcard_amount,
                    runtime=resolved_runtime,
                )
                row['test_questions'] = study_generation.sanitize_questions(
                    parsed.get('test_questions', []),
                    question_amount,
                    runtime=resolved_runtime,
                )
                row['study_generation_error'] = None

            _run_stage_with_builder(
                batch_id,
                rows,
                'study_materials_generation',
                _slides_study_builder,
                _slides_study_handler,
                runtime=resolved_runtime,
            )

        if mode == 'interview':
            def _interview_builder(row):
                if row.get('status') == 'error' or not row.get('audio_file_uri'):
                    return None
                interview_prompt = resolved_runtime.PROMPT_INTERVIEW_TRANSCRIPTION.format(
                    output_language=row.get('output_language', 'English'),
                )
                return {
                    'contents': [
                        {
                            'role': 'user',
                            'parts': [
                                {
                                    'file_data': {
                                        'file_uri': row.get('audio_file_uri', ''),
                                        'mime_type': row.get('audio_mime_type', 'audio/mpeg'),
                                    }
                                },
                                {'text': interview_prompt},
                            ],
                        }
                    ]
                }

            def _interview_handler(row, response):
                transcript = _response_text(response, runtime=resolved_runtime)
                row['transcript'] = transcript
                row['result'] = transcript

            _run_stage_with_builder(batch_id, rows, 'interview_transcription', _interview_builder, _interview_handler, runtime=resolved_runtime)

            def _summary_builder(row):
                if row.get('status') == 'error':
                    return None
                selected = row.get('interview_features', []) or []
                if 'summary' not in selected:
                    return None
                prompt = resolved_runtime.PROMPT_INTERVIEW_SUMMARY.format(
                    transcript=str(row.get('transcript', '') or '')[:120000],
                    output_language=row.get('output_language', 'English'),
                )
                return {'contents': [{'role': 'user', 'parts': [{'text': prompt}]}]}

            def _summary_handler(row, response):
                row['interview_summary'] = _response_text(response, runtime=resolved_runtime)

            _run_stage_with_builder(batch_id, rows, 'interview_summary_generation', _summary_builder, _summary_handler, runtime=resolved_runtime)

            def _sections_builder(row):
                if row.get('status') == 'error':
                    return None
                selected = row.get('interview_features', []) or []
                if 'sections' not in selected:
                    return None
                prompt = resolved_runtime.PROMPT_INTERVIEW_SECTIONED.format(
                    transcript=str(row.get('transcript', '') or '')[:120000],
                    output_language=row.get('output_language', 'English'),
                )
                return {'contents': [{'role': 'user', 'parts': [{'text': prompt}]}]}

            def _sections_handler(row, response):
                row['interview_sections'] = _response_text(response, runtime=resolved_runtime)

            _run_stage_with_builder(batch_id, rows, 'interview_sections_generation', _sections_builder, _sections_handler, runtime=resolved_runtime)

            for row in rows:
                if row.get('status') == 'error':
                    continue
                summary = str(row.get('interview_summary', '') or '').strip()
                sections = str(row.get('interview_sections', '') or '').strip()
                if summary and sections:
                    row['interview_combined'] = f'# Interview Summary\n\n{summary}\n\n# Structured Interview Transcript\n\n{sections}'
                    row['result'] = row['interview_combined']
                elif summary:
                    row['result'] = summary
                elif sections:
                    row['result'] = sections

        for row in rows:
            if row.get('status') == 'error':
                _refund_failed_row(batch, row, runtime=resolved_runtime)
            _finalize_row_job_log(batch, row, runtime=resolved_runtime)
            _upsert_row(
                batch_id,
                row.get('row_id', ''),
                {
                    **row,
                    'updated_at': resolved_runtime.time.time(),
                },
                runtime=resolved_runtime,
                merge=False,
            )
    except Exception as error:
        stage_error = str(error)
        resolved_runtime.logger.exception('Batch processing failed for batch_id=%s', batch_id)
        for row in rows:
            if row.get('status') == 'complete':
                continue
            row['status'] = 'error'
            row['error'] = row.get('error', '') or stage_error
            if not row.get('failed_stage'):
                row['failed_stage'] = 'batch_pipeline'
            _refund_failed_row(batch, row, runtime=resolved_runtime)
            _finalize_row_job_log(batch, row, runtime=resolved_runtime)
            _upsert_row(batch_id, row.get('row_id', ''), row, runtime=resolved_runtime, merge=False)
    finally:
        _finalize_batch_record(
            batch_id,
            batch,
            stage_error=stage_error,
            runtime=resolved_runtime,
        )


def get_batch_status(batch_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    batch = _get_batch(batch_id, runtime=resolved_runtime)
    if not batch:
        return None
    batch, rows = _repair_batch_state_if_needed(batch_id, batch=batch, rows=None, runtime=resolved_runtime)
    if not batch:
        return None
    response_rows = []
    for row in rows:
        row_stage = str(row.get('current_stage', '') or '')
        row_error = str(row.get('error', '') or '').strip()
        response_rows.append(
            {
                'row_id': row.get('row_id', ''),
                'ordinal': int(row.get('ordinal', 0) or 0),
                'status': row.get('status', 'queued'),
                'failed_stage': row.get('failed_stage', ''),
                'error': row_error,
                'study_pack_id': row.get('study_pack_id'),
                'job_log_id': row.get('job_log_id', ''),
                'current_stage': row_stage,
                'current_stage_label': _stage_label(row_stage),
                'last_stage_update_at': row.get('last_stage_update_at', 0),
                'token_input_total': int(row.get('token_input_total', 0) or 0),
                'token_output_total': int(row.get('token_output_total', 0) or 0),
                'token_total': int(row.get('token_total', 0) or 0),
                'credits_charged': int(
                    row.get(
                        'credits_charged',
                        1 + int(row.get('interview_features_cost', 0) or 0),
                    ) or 0
                ),
                'interview_features_refunded_count': int(row.get('interview_features_refunded_count', 0) or 0),
                'credits_refunded_total': (1 if bool(row.get('credit_refunded', False)) else 0) + int(row.get('interview_features_refunded_count', 0) or 0),
                'billing_receipt': row.get('billing_receipt', {}),
                'status_message': row_error or _stage_label(row_stage),
            }
        )
    can_download_zip = any(str(row.get('status', '') or '') == 'complete' for row in response_rows)
    response = {
        'batch_id': batch.get('batch_id', batch_id),
        'status': batch.get('status', 'queued'),
        'mode': batch.get('mode', ''),
        'batch_title': batch.get('batch_title', ''),
        'total_rows': int(batch.get('total_rows', len(rows)) or len(rows)),
        'completed_rows': int(batch.get('completed_rows', 0) or 0),
        'failed_rows': int(batch.get('failed_rows', 0) or 0),
        'created_at': batch.get('created_at', 0),
        'updated_at': batch.get('updated_at', 0),
        'finished_at': batch.get('finished_at', 0),
        'token_input_total': int(batch.get('token_input_total', 0) or 0),
        'token_output_total': int(batch.get('token_output_total', 0) or 0),
        'token_total': int(batch.get('token_total', 0) or 0),
        'current_stage': batch.get('current_stage', ''),
        'current_stage_state': batch.get('current_stage_state', ''),
        'stage_started_at': batch.get('stage_started_at', 0),
        'provider_state': batch.get('provider_state', ''),
        'submission_locked': bool(batch.get('submission_locked', False)),
        'credits_charged': int(batch.get('credits_charged', 0) or 0),
        'credits_refunded': int(batch.get('credits_refunded', 0) or 0),
        'credits_refund_pending': int(batch.get('credits_refund_pending', 0) or 0),
        'can_download_zip': bool(can_download_zip),
        'last_heartbeat_at': batch.get('last_heartbeat_at', 0),
        'rows': response_rows,
        'external_batch_refs': batch.get('external_batch_refs', {}),
        'error_summary': batch.get('error_summary', ''),
        'completion_email_status': batch.get('completion_email_status', 'pending'),
        'completion_email_sent_at': batch.get('completion_email_sent_at', 0),
        'completion_email_error': batch.get('completion_email_error', ''),
    }
    response.update(_build_batch_view(batch_id, batch, response_rows, can_download_zip=can_download_zip, runtime=resolved_runtime))
    return response


def get_batch_row(batch_id, row_id, runtime=None):
    return _get_row(batch_id, row_id, runtime=runtime)


def list_batch_rows(batch_id, runtime=None):
    return _list_rows(batch_id, runtime=runtime)


def get_batch(batch_id, runtime=None):
    return _get_batch(batch_id, runtime=runtime)


def find_batch_by_submission_id(uid, client_submission_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    safe_uid = str(uid or '').strip()
    safe_submission_id = str(client_submission_id or '').strip()
    if not safe_uid or not safe_submission_id:
        return None

    db = getattr(resolved_runtime, 'db', None)
    candidates = []
    if db is not None:
        docs = resolved_runtime.batch_repo.list_batch_jobs_by_uid_and_submission_id(
            db,
            safe_uid,
            safe_submission_id,
            limit=5,
        )
        for doc in docs:
            item = doc.to_dict() or {}
            item.setdefault('batch_id', doc.id)
            candidates.append(item)
    else:
        batch_jobs, _rows = _memory_store(resolved_runtime)
        for batch_id, item in batch_jobs.items():
            if not isinstance(item, dict):
                continue
            if str(item.get('uid', '') or '') != safe_uid:
                continue
            if str(item.get('client_submission_id', '') or '') != safe_submission_id:
                continue
            payload = dict(item)
            payload.setdefault('batch_id', batch_id)
            candidates.append(payload)

    if not candidates:
        return None
    candidates.sort(key=lambda entry: float(entry.get('created_at', 0) or 0), reverse=True)
    return candidates[0]


def list_batches_for_uid(uid, statuses=None, limit=100, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    safe_uid = str(uid or '').strip()
    if not safe_uid:
        return []
    safe_limit = max(1, int(limit or 100))
    safe_statuses = [str(status or '').strip() for status in (statuses or []) if str(status or '').strip()]

    db = getattr(resolved_runtime, 'db', None)
    rows = []
    if db is not None:
        if safe_statuses:
            docs = resolved_runtime.batch_repo.list_batch_jobs_by_uid_and_statuses(
                db,
                safe_uid,
                safe_statuses,
                limit=safe_limit,
            )
        else:
            docs = resolved_runtime.batch_repo.list_batch_jobs_by_uid(db, safe_uid, limit=safe_limit)
        for doc in docs:
            item = doc.to_dict() or {}
            item.setdefault('batch_id', doc.id)
            rows.append(item)
    else:
        batch_jobs, _rows = _memory_store(resolved_runtime)
        for batch_id, item in batch_jobs.items():
            if not isinstance(item, dict):
                continue
            if str(item.get('uid', '') or '') != safe_uid:
                continue
            if safe_statuses and str(item.get('status', '') or '') not in safe_statuses:
                continue
            payload = dict(item)
            payload.setdefault('batch_id', batch_id)
            rows.append(payload)
        rows.sort(key=lambda entry: float(entry.get('created_at', 0) or 0), reverse=True)
        rows = rows[:safe_limit]

    results = []
    for batch in rows:
        batch_id = str(batch.get('batch_id', '') or '').strip()
        if batch_id:
            batch, batch_rows = _repair_batch_state_if_needed(batch_id, batch=batch, rows=None, runtime=resolved_runtime)
        else:
            batch_rows = []
        if not isinstance(batch, dict):
            continue
        can_download_zip = any(str(row.get('status', '') or '') == 'complete' for row in batch_rows)
        payload = {
            'batch_id': batch_id,
            'mode': str(batch.get('mode', '') or ''),
            'batch_title': str(batch.get('batch_title', '') or ''),
            'status': str(batch.get('status', 'queued') or 'queued'),
            'total_rows': int(batch.get('total_rows', len(batch_rows)) or len(batch_rows)),
            'completed_rows': int(batch.get('completed_rows', 0) or 0),
            'failed_rows': int(batch.get('failed_rows', 0) or 0),
            'created_at': float(batch.get('created_at', 0) or 0),
            'updated_at': float(batch.get('updated_at', 0) or 0),
            'finished_at': float(batch.get('finished_at', 0) or 0),
            'current_stage': str(batch.get('current_stage', '') or ''),
            'current_stage_state': str(batch.get('current_stage_state', '') or ''),
            'provider_state': str(batch.get('provider_state', '') or ''),
            'stage_started_at': float(batch.get('stage_started_at', 0) or 0),
            'last_heartbeat_at': float(batch.get('last_heartbeat_at', 0) or 0),
            'can_download_zip': bool(can_download_zip),
            'completion_email_status': str(batch.get('completion_email_status', 'pending') or 'pending'),
            'completion_email_sent_at': float(batch.get('completion_email_sent_at', 0) or 0),
            'credits_charged': int(batch.get('credits_charged', 0) or 0),
            'credits_refunded': int(batch.get('credits_refunded', 0) or 0),
            'credits_refund_pending': int(batch.get('credits_refund_pending', 0) or 0),
            'submission_locked': bool(batch.get('submission_locked', False)),
            'folder_id': str(batch.get('folder_id', '') or ''),
            'folder_name': str(batch.get('folder_name', '') or ''),
        }
        payload.update(_build_batch_view(batch_id, batch, batch_rows, can_download_zip=can_download_zip, runtime=resolved_runtime))
        results.append(payload)
    results.sort(key=lambda entry: float(entry.get('created_at', 0) or 0), reverse=True)
    return results


def list_batches_for_admin(statuses=None, limit=200, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    safe_limit = max(1, int(limit or 200))
    safe_statuses = [str(status or '').strip() for status in (statuses or []) if str(status or '').strip()]
    db = getattr(resolved_runtime, 'db', None)
    rows = []

    if db is not None:
        docs = resolved_runtime.batch_repo.list_batch_jobs(db, limit=safe_limit)
        for doc in docs:
            item = doc.to_dict() or {}
            item.setdefault('batch_id', doc.id)
            rows.append(item)
    else:
        batch_jobs, _rows = _memory_store(resolved_runtime)
        for batch_id, item in batch_jobs.items():
            if not isinstance(item, dict):
                continue
            payload = dict(item)
            payload.setdefault('batch_id', batch_id)
            rows.append(payload)

    if safe_statuses:
        rows = [row for row in rows if str(row.get('status', '') or '') in safe_statuses]
    rows.sort(key=lambda entry: float(entry.get('created_at', 0) or 0), reverse=True)
    rows = rows[:safe_limit]

    results = []
    for batch in rows:
        batch_id = str(batch.get('batch_id', '') or '').strip()
        if batch_id:
            batch, batch_rows = _repair_batch_state_if_needed(batch_id, batch=batch, rows=None, runtime=resolved_runtime)
        else:
            batch_rows = []
        if not isinstance(batch, dict):
            continue
        can_download_zip = any(str(row.get('status', '') or '') == 'complete' for row in batch_rows)
        payload = {
            'batch_id': batch_id,
            'uid': str(batch.get('uid', '') or ''),
            'email': str(batch.get('email', '') or ''),
            'mode': str(batch.get('mode', '') or ''),
            'batch_title': str(batch.get('batch_title', '') or ''),
            'status': str(batch.get('status', 'queued') or 'queued'),
            'total_rows': int(batch.get('total_rows', len(batch_rows)) or len(batch_rows)),
            'completed_rows': int(batch.get('completed_rows', 0) or 0),
            'failed_rows': int(batch.get('failed_rows', 0) or 0),
            'created_at': float(batch.get('created_at', 0) or 0),
            'updated_at': float(batch.get('updated_at', 0) or 0),
            'finished_at': float(batch.get('finished_at', 0) or 0),
            'current_stage': str(batch.get('current_stage', '') or ''),
            'current_stage_state': str(batch.get('current_stage_state', '') or ''),
            'provider_state': str(batch.get('provider_state', '') or ''),
            'stage_started_at': float(batch.get('stage_started_at', 0) or 0),
            'last_heartbeat_at': float(batch.get('last_heartbeat_at', 0) or 0),
            'can_download_zip': bool(can_download_zip),
            'completion_email_status': str(batch.get('completion_email_status', 'pending') or 'pending'),
            'completion_email_sent_at': float(batch.get('completion_email_sent_at', 0) or 0),
            'credits_charged': int(batch.get('credits_charged', 0) or 0),
            'credits_refunded': int(batch.get('credits_refunded', 0) or 0),
            'credits_refund_pending': int(batch.get('credits_refund_pending', 0) or 0),
            'submission_locked': bool(batch.get('submission_locked', False)),
            'folder_id': str(batch.get('folder_id', '') or ''),
            'folder_name': str(batch.get('folder_name', '') or ''),
        }
        payload.update(_build_batch_view(batch_id, batch, batch_rows, can_download_zip=can_download_zip, runtime=resolved_runtime))
        results.append(payload)
    return results
