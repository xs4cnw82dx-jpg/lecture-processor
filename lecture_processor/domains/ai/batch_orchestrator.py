from __future__ import annotations

import json
import time
from datetime import datetime, timezone

from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.ai import study_generation
from lecture_processor.domains.ai import pipelines as ai_pipelines
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.study import audio as study_audio
from lecture_processor.runtime.container import get_runtime


TERMINAL_BATCH_STATES = {
    'JOB_STATE_SUCCEEDED',
    'JOB_STATE_FAILED',
    'JOB_STATE_CANCELLED',
    'JOB_STATE_EXPIRED',
}


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
            }
        )
        _upsert_row(batch_id, row_id, row_payload, runtime=resolved_runtime, merge=False)
    return batch_id


def _batch_state_name(batch_job):
    state = getattr(batch_job, 'state', '')
    if isinstance(state, str):
        return state
    return str(getattr(state, 'name', '') or '')


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


def _wait_for_batch(batch_name, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    poll_seconds = max(5, int(getattr(resolved_runtime, 'BATCH_POLL_SECONDS', 10) or 10))
    max_wait_seconds = max(300, int(getattr(resolved_runtime, 'BATCH_MAX_WAIT_SECONDS', 24 * 60 * 60) or (24 * 60 * 60)))
    started_at = resolved_runtime.time.time()
    batch_job = resolved_runtime.client.batches.get(name=batch_name)
    while _batch_state_name(batch_job) not in TERMINAL_BATCH_STATES:
        if resolved_runtime.time.time() - started_at >= max_wait_seconds:
            raise TimeoutError(f'Batch job {batch_name} timed out.')
        resolved_runtime.time.sleep(poll_seconds)
        batch_job = resolved_runtime.client.batches.get(name=batch_name)
    return batch_job


def _run_batch_stage(batch_id, stage_name, requests, request_keys=None, runtime=None, display_name=''):
    resolved_runtime = _resolve_runtime(runtime)
    if not requests:
        return []
    model = _batch_model(stage_name, resolved_runtime)
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

        input_file_handle = resolved_runtime.client.files.upload(
            file=local_input_path,
            config={'mime_type': 'jsonl'},
        )
        uploaded_input_file = input_file_handle
        batch_job = resolved_runtime.client.batches.create(
            model=model,
            src=getattr(input_file_handle, 'name', ''),
            config={'display_name': display_name or f'{batch_id}-{stage_name}'},
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
        _upsert_batch(batch_id, {'external_batch_refs': refs, 'updated_at': resolved_runtime.time.time()}, runtime=resolved_runtime, merge=True)
    try:
        final_job = _wait_for_batch(getattr(batch_job, 'name', ''), runtime=resolved_runtime)
        final_state = _batch_state_name(final_job)
        if final_state != 'JOB_STATE_SUCCEEDED':
            error_obj = getattr(final_job, 'error', None)
            raise RuntimeError(f'Batch stage {stage_name} failed with state {final_state}: {error_obj}')
        responses = []

        result_file_name = str(getattr(getattr(final_job, 'dest', None), 'file_name', '') or '')
        if result_file_name:
            content_bytes = resolved_runtime.client.files.download(file=result_file_name)
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
    requests, request_rows = _build_stage_requests(rows, builder)
    if not requests:
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
            continue
        response = response_entry.get('response')
        usage = _response_usage(response, runtime=resolved_runtime)
        _record_stage_tokens(row, stage_name, usage, runtime=resolved_runtime)
        handler(row, response)


def _upload_row_files(row, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    local_paths = row.setdefault('_local_paths', [])
    gemini_files = row.setdefault('_gemini_files', [])

    slides_path = str(row.get('slides_local_path', '') or '').strip()
    if slides_path and not row.get('slides_file_uri'):
        pdf_file = resolved_runtime.client.files.upload(file=slides_path, config={'mime_type': 'application/pdf'})
        gemini_files.append(pdf_file)
        resolved_runtime.wait_for_file_processing(pdf_file)
        row['slides_file_uri'] = str(getattr(pdf_file, 'uri', '') or '')

    audio_path = str(row.get('audio_local_path', '') or '').strip()
    if audio_path and not row.get('audio_file_uri'):
        converted_path, converted = resolved_runtime.convert_audio_to_mp3_with_ytdlp(audio_path)
        if converted and converted_path not in local_paths:
            local_paths.append(converted_path)
        upload_path = converted_path if converted else audio_path
        audio_mime = resolved_runtime.get_mime_type(upload_path)
        audio_file = resolved_runtime.client.files.upload(file=upload_path, config={'mime_type': audio_mime})
        gemini_files.append(audio_file)
        resolved_runtime.wait_for_file_processing(audio_file)
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
    if row.get('credit_refunded'):
        return
    uid = batch.get('uid', '')
    credit_type = str(row.get('credit_deducted', '') or '').strip()
    if uid and credit_type:
        billing_credits.refund_credit(uid, credit_type, runtime=resolved_runtime)
        row['credit_refunded'] = True
        billing_receipt = dict(row.get('billing_receipt', {}) or {})
        billing_receipt = billing_receipts.add_job_credit_refund(
            {'billing_receipt': billing_receipt},
            credit_type,
            1,
            runtime=resolved_runtime,
        )
        if isinstance(billing_receipt, dict):
            row['billing_receipt'] = billing_receipt


def process_batch_job(batch_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    batch = _get_batch(batch_id, runtime=resolved_runtime)
    if not batch:
        return
    rows = _list_rows(batch_id, runtime=resolved_runtime)
    if not rows:
        _upsert_batch(
            batch_id,
            {
                'status': 'error',
                'error_summary': 'Batch has no rows.',
                'updated_at': resolved_runtime.time.time(),
                'finished_at': resolved_runtime.time.time(),
            },
            runtime=resolved_runtime,
            merge=True,
        )
        return

    _upsert_batch(batch_id, {'status': 'processing', 'updated_at': resolved_runtime.time.time()}, runtime=resolved_runtime, merge=True)
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
            _upload_row_files(row, runtime=resolved_runtime)

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
        completed_rows = 0
        failed_rows = 0
        token_input_total = 0
        token_output_total = 0
        token_total = 0
        for row in _list_rows(batch_id, runtime=resolved_runtime):
            status = str(row.get('status', '') or '')
            if status == 'complete':
                completed_rows += 1
            elif status == 'error':
                failed_rows += 1
            token_input_total += int(row.get('token_input_total', 0) or 0)
            token_output_total += int(row.get('token_output_total', 0) or 0)
            token_total += int(row.get('token_total', 0) or 0)
            local_paths = row.get('_local_paths', []) or []
            gemini_files = row.get('_gemini_files', []) or []
            if local_paths or gemini_files:
                resolved_runtime.cleanup_files(local_paths, gemini_files)

        total_rows = int(batch.get('total_rows', len(rows)) or len(rows))
        finished_at = resolved_runtime.time.time()
        if completed_rows == total_rows and failed_rows == 0:
            status = 'complete'
        elif completed_rows > 0 and failed_rows > 0:
            status = 'partial'
        else:
            status = 'error'
        _upsert_batch(
            batch_id,
            {
                'status': status,
                'completed_rows': completed_rows,
                'failed_rows': failed_rows,
                'token_input_total': token_input_total,
                'token_output_total': token_output_total,
                'token_total': token_total,
                'updated_at': finished_at,
                'finished_at': finished_at,
                'error_summary': stage_error[:1500] if stage_error else '',
            },
            runtime=resolved_runtime,
            merge=True,
        )


def get_batch_status(batch_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    batch = _get_batch(batch_id, runtime=resolved_runtime)
    if not batch:
        return None
    rows = _list_rows(batch_id, runtime=resolved_runtime)
    response_rows = []
    for row in rows:
        response_rows.append(
            {
                'row_id': row.get('row_id', ''),
                'ordinal': int(row.get('ordinal', 0) or 0),
                'status': row.get('status', 'queued'),
                'failed_stage': row.get('failed_stage', ''),
                'error': row.get('error', ''),
                'study_pack_id': row.get('study_pack_id'),
                'job_log_id': row.get('job_log_id', ''),
                'token_input_total': int(row.get('token_input_total', 0) or 0),
                'token_output_total': int(row.get('token_output_total', 0) or 0),
                'token_total': int(row.get('token_total', 0) or 0),
                'billing_receipt': row.get('billing_receipt', {}),
            }
        )
    return {
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
        'rows': response_rows,
        'external_batch_refs': batch.get('external_batch_refs', {}),
        'error_summary': batch.get('error_summary', ''),
    }


def get_batch_row(batch_id, row_id, runtime=None):
    return _get_row(batch_id, row_id, runtime=runtime)


def list_batch_rows(batch_id, runtime=None):
    return _list_rows(batch_id, runtime=runtime)


def get_batch(batch_id, runtime=None):
    return _get_batch(batch_id, runtime=runtime)
