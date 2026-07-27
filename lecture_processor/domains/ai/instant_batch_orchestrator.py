"""Immediate multi-row batch processing without Gemini Batch API."""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from types import SimpleNamespace

from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.ai import study_generation
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.study import audio as study_audio
from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


class InstantApiStagger:
    def __init__(self, runtime=None):
        self.runtime = _resolve_runtime(runtime)
        self.delay_seconds = max(0.0, float(getattr(self.runtime, 'INSTANT_BATCH_API_STAGGER_SECONDS', 5.0) or 0.0))
        self._lock = threading.Lock()
        self._next_start_at = 0.0

    def wait(self):
        if self.delay_seconds <= 0:
            return
        with self._lock:
            now = float(self.runtime.time.time())
            sleep_for = max(0.0, self._next_start_at - now)
            self._next_start_at = max(now, self._next_start_at) + self.delay_seconds
        if sleep_for > 0:
            self.runtime.time.sleep(sleep_for)


def _content_from_text(runtime, text):
    return [
        runtime.types.Content(
            role='user',
            parts=[runtime.types.Part.from_text(text=text)],
        )
    ]


def _content_from_file_and_text(runtime, file_uri, mime_type, prompt_text):
    return [
        runtime.types.Content(
            role='user',
            parts=[
                runtime.types.Part.from_uri(file_uri=file_uri, mime_type=mime_type),
                runtime.types.Part.from_text(text=prompt_text),
            ],
        )
    ]


def _public_row_error(error, runtime):
    message = str(error or '').strip()
    public = str(getattr(runtime, 'PROCESSING_PUBLIC_ERROR_MESSAGE', '') or '').strip()
    if not message:
        return public or 'Processing failed.'
    if public and message == public:
        return public
    return message[:500]


def _stage_detail(row, detail):
    label = str(row.get('source_name', '') or '').strip()
    if not label:
        label = f"Row {int(row.get('ordinal', 0) or 0)}"
    return f'{label} · {detail}'


def _upsert_row_progress(batch_id, row, stage, detail, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    now_ts = resolved_runtime.time.time()
    row['status'] = 'processing'
    row['current_stage'] = str(stage or '')
    row['current_stage_detail'] = _stage_detail(row, detail)
    row['last_stage_update_at'] = now_ts
    row['updated_at'] = now_ts
    batch_orchestrator._upsert_row(
        batch_id,
        row.get('row_id', ''),
        {
            'status': row['status'],
            'current_stage': row['current_stage'],
            'current_stage_detail': row['current_stage_detail'],
            'last_stage_update_at': row['last_stage_update_at'],
            'updated_at': row['updated_at'],
        },
        runtime=resolved_runtime,
        merge=True,
    )
    batch_orchestrator._upsert_batch(
        batch_id,
        {
            'status': 'processing',
            'current_stage': str(stage or ''),
            'current_stage_state': 'running',
            'provider_state': 'INSTANT_RUNNING',
            'last_heartbeat_at': now_ts,
            'updated_at': now_ts,
        },
        runtime=resolved_runtime,
        merge=True,
    )


def _refresh_batch_progress(batch_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    rows = batch_orchestrator._list_rows(batch_id, runtime=resolved_runtime)
    completed = sum(1 for row in rows if str(row.get('status', '') or '') == 'complete')
    failed = sum(1 for row in rows if str(row.get('status', '') or '') == 'error')
    token_input = sum(int(row.get('token_input_total', 0) or 0) for row in rows)
    token_output = sum(int(row.get('token_output_total', 0) or 0) for row in rows)
    token_total = sum(int(row.get('token_total', 0) or 0) for row in rows)
    now_ts = resolved_runtime.time.time()
    batch_orchestrator._upsert_batch(
        batch_id,
        {
            'status': 'processing',
            'completed_rows': completed,
            'failed_rows': failed,
            'token_input_total': token_input,
            'token_output_total': token_output,
            'token_total': token_total,
            'last_heartbeat_at': now_ts,
            'updated_at': now_ts,
        },
        runtime=resolved_runtime,
        merge=True,
    )


def _record_usage_dict(tokens, usage_payload, default_model, billing_mode='instant_batch'):
    for stage_name, stage_usage in (usage_payload.get('token_usage_by_stage', {}) or {}).items():
        tokens.record_usage(
            stage_name,
            stage_usage,
            model=stage_usage.get('model') or default_model,
            billing_mode=billing_mode,
            input_modality=stage_usage.get('input_modality') or 'text',
        )


def _refund_interview_feature_failures(batch, row, failed_count, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    amount = max(0, int(failed_count or 0))
    if amount <= 0:
        return
    already = int(row.get('interview_features_refunded_count', 0) or 0)
    max_extra = int(row.get('interview_features_cost', 0) or 0)
    pending = max(0, min(amount, max_extra - already))
    if pending <= 0:
        return
    uid = str((batch or {}).get('uid', '') or row.get('uid', '') or '')
    batch_id = str((batch or {}).get('batch_id', '') or row.get('batch_id', '') or '').strip()
    row_id = str(row.get('row_id', '') or '').strip()
    receipt_holder = {'billing_receipt': dict(row.get('billing_receipt', {}) or {})}
    if billing_credits.refund_slides_credits(
        uid,
        pending,
        runtime=resolved_runtime,
        idempotency_key=f'batch-row:{batch_id}:{row_id}:interview-extras',
        idempotency_total=already + pending,
    ):
        row['interview_features_refunded_count'] = already + pending
        billing_receipts.add_job_credit_refund(
            receipt_holder,
            'slides_credits',
            pending,
            runtime=resolved_runtime,
        )
        row['billing_receipt'] = receipt_holder.get('billing_receipt', row.get('billing_receipt', {}))


def _cleanup_row_files(row, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    local_paths = []
    for key in ('slides_local_path', 'audio_local_path'):
        value = str(row.get(key, '') or '').strip()
        if value:
            local_paths.append(value)
    local_paths.extend(row.get('_local_paths', []) or [])
    gemini_files = row.get('_gemini_files', []) or []
    resolved_runtime.cleanup_files(local_paths, gemini_files)


def _finalize_row(batch_id, batch, row, tokens, retry_tracker, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    row.update(tokens.as_dict())
    row['retry_attempts'] = sum(int(value or 0) for value in retry_tracker.values())
    if row.get('status') != 'error':
        row['status'] = 'complete'
        row['current_stage'] = 'complete'
        row['current_stage_detail'] = _stage_detail(row, 'complete')
        row['error'] = ''
    batch_orchestrator._finalize_row_job_log(batch, row, runtime=resolved_runtime)
    batch_orchestrator._upsert_row(
        batch_id,
        row.get('row_id', ''),
        {**row, 'updated_at': resolved_runtime.time.time()},
        runtime=resolved_runtime,
        merge=False,
    )


def _run_slide_extraction(batch_id, row, throttler, tokens, retry_tracker, runtime):
    _upsert_row_progress(batch_id, row, 'slide_extraction', 'extracting slide text', runtime=runtime)
    throttler.wait()
    response = ai_provider.generate_with_policy(
        runtime.MODEL_SLIDES,
        _content_from_file_and_text(
            runtime,
            row.get('slides_file_uri', ''),
            'application/pdf',
            runtime.PROMPT_SLIDE_EXTRACTION,
        ),
        retry_tracker=retry_tracker,
        operation_name='instant_slide_extraction',
        runtime=runtime,
    )
    tokens.record(
        'slide_extraction',
        response,
        model=runtime.MODEL_SLIDES,
        billing_mode='instant_batch',
        input_modality='text',
    )
    row['slide_text'] = str(getattr(response, 'text', '') or '')
    batch_orchestrator._upsert_row(
        batch_id,
        row.get('row_id', ''),
        {'slide_text': row['slide_text'], **tokens.as_dict(), 'updated_at': runtime.time.time()},
        runtime=runtime,
        merge=True,
    )


def _run_audio_transcription(batch_id, row, throttler, tokens, retry_tracker, runtime, *, timestamped=False):
    _upsert_row_progress(batch_id, row, 'audio_transcription', 'transcribing audio', runtime=runtime)
    throttler.wait()
    audio_file = SimpleNamespace(uri=row.get('audio_file_uri', ''))
    audio_mime = row.get('audio_mime_type', 'audio/mpeg')
    output_language = row.get('output_language', 'English')
    if timestamped:
        transcript, segments, usage = runtime.transcribe_audio_with_timestamps(
            audio_file,
            audio_mime,
            output_language,
            retry_tracker=retry_tracker,
            include_usage=True,
        )
    else:
        transcript, usage = runtime.transcribe_audio_plain(
            audio_file,
            audio_mime,
            output_language,
            retry_tracker=retry_tracker,
            include_usage=True,
        )
        segments = []
    tokens.record_usage(
        'audio_transcription',
        usage,
        model=runtime.MODEL_AUDIO,
        billing_mode='instant_batch',
        input_modality='audio',
    )
    row['transcript'] = transcript
    row['transcript_segments'] = segments
    row['result'] = transcript
    batch_orchestrator._upsert_row(
        batch_id,
        row.get('row_id', ''),
        {
            'transcript': transcript,
            'transcript_segments': segments,
            'result': row.get('result', ''),
            **tokens.as_dict(),
            'updated_at': runtime.time.time(),
        },
        runtime=runtime,
        merge=True,
    )


def _run_notes_merge(batch_id, row, throttler, tokens, retry_tracker, runtime, *, text_combine=False):
    _upsert_row_progress(batch_id, row, 'notes_merge', 'merging notes', runtime=runtime)
    prompt = (
        batch_orchestrator._text_combine_prompt_for_row(row, runtime)
        if text_combine
        else batch_orchestrator._merge_prompt_for_row(row, runtime)
    )
    throttler.wait()
    response = ai_provider.generate_with_policy(
        runtime.MODEL_INTEGRATION,
        _content_from_text(runtime, prompt),
        retry_tracker=retry_tracker,
        operation_name='instant_notes_merge',
        runtime=runtime,
    )
    tokens.record(
        'notes_merge',
        response,
        model=runtime.MODEL_INTEGRATION,
        billing_mode='instant_batch',
        input_modality='text',
    )
    merged = str(getattr(response, 'text', '') or '')
    row['merged_notes'] = merged
    row['result'] = merged
    row['notes_audio_map'] = (
        study_audio.parse_audio_markers_from_notes(merged, runtime=runtime)
        if (not text_combine and runtime.FEATURE_AUDIO_SECTION_SYNC)
        else []
    )
    batch_orchestrator._upsert_row(
        batch_id,
        row.get('row_id', ''),
        {
            'merged_notes': merged,
            'result': merged,
            'notes_audio_map': row.get('notes_audio_map', []),
            **tokens.as_dict(),
            'updated_at': runtime.time.time(),
        },
        runtime=runtime,
        merge=True,
    )


def _run_study_tools(batch_id, row, throttler, tokens, retry_tracker, runtime):
    study_features = str(row.get('study_features', 'none') or 'none')
    if study_features == 'none':
        row['flashcards'] = []
        row['test_questions'] = []
        row['study_generation_error'] = None
        return
    source_text = str(row.get('merged_notes', '') or row.get('slide_text', '') or row.get('result', '') or '')
    if not source_text.strip():
        raise ValueError('Missing source text for study tools.')
    _upsert_row_progress(batch_id, row, 'study_materials_generation', 'generating study tools', runtime=runtime)
    throttler.wait()
    flashcards, test_questions, study_error, usage = study_generation.generate_study_materials(
        source_text,
        row.get('flashcard_selection', '20'),
        row.get('question_selection', '10'),
        study_features,
        row.get('output_language', 'English'),
        retry_tracker=retry_tracker,
        runtime=runtime,
        include_usage=True,
    )
    _record_usage_dict(tokens, usage, runtime.MODEL_STUDY)
    row['flashcards'] = flashcards
    row['test_questions'] = test_questions
    row['study_generation_error'] = study_error
    batch_orchestrator._upsert_row(
        batch_id,
        row.get('row_id', ''),
        {
            'flashcards': flashcards,
            'test_questions': test_questions,
            'study_generation_error': study_error,
            **tokens.as_dict(),
            'updated_at': runtime.time.time(),
        },
        runtime=runtime,
        merge=True,
    )


def _run_interview_transcription(batch_id, row, throttler, tokens, retry_tracker, runtime):
    _upsert_row_progress(batch_id, row, 'interview_transcription', 'transcribing interview', runtime=runtime)
    prompt = runtime.PROMPT_INTERVIEW_TRANSCRIPTION.format(output_language=row.get('output_language', 'English'))
    throttler.wait()
    response = ai_provider.generate_with_policy(
        runtime.MODEL_INTERVIEW,
        _content_from_file_and_text(
            runtime,
            row.get('audio_file_uri', ''),
            row.get('audio_mime_type', 'audio/mpeg'),
            prompt,
        ),
        retry_tracker=retry_tracker,
        operation_name='instant_interview_transcription',
        runtime=runtime,
    )
    tokens.record(
        'interview_transcription',
        response,
        model=runtime.MODEL_INTERVIEW,
        billing_mode='instant_batch',
        input_modality='audio',
    )
    transcript = str(getattr(response, 'text', '') or '')
    row['transcript'] = transcript
    row['result'] = transcript
    batch_orchestrator._upsert_row(
        batch_id,
        row.get('row_id', ''),
        {'transcript': transcript, 'result': transcript, **tokens.as_dict(), 'updated_at': runtime.time.time()},
        runtime=runtime,
        merge=True,
    )


def _run_interview_extras(batch_id, batch, row, throttler, tokens, retry_tracker, runtime):
    selected = row.get('interview_features', []) or []
    if not selected:
        return
    _upsert_row_progress(batch_id, row, 'interview_summary_generation', 'creating interview extras', runtime=runtime)
    throttler.wait()
    enhancement = study_generation.generate_interview_enhancements(
        str(row.get('transcript', '') or ''),
        selected,
        row.get('output_language', 'English'),
        retry_tracker=retry_tracker,
        runtime=runtime,
        include_usage=True,
    )
    _record_usage_dict(tokens, enhancement, runtime.MODEL_STUDY)
    row['interview_summary'] = enhancement.get('summary')
    row['interview_sections'] = enhancement.get('sections')
    row['interview_combined'] = enhancement.get('combined')
    row['interview_features_successful'] = enhancement.get('successful_features', [])
    row['study_generation_error'] = enhancement.get('error')
    failed_count = int(enhancement.get('failed_count', 0) or 0)
    if failed_count > 0:
        _refund_interview_feature_failures(batch, row, failed_count, runtime=runtime)
    if row.get('interview_summary') and row.get('interview_sections'):
        row['result'] = row.get('interview_combined') or row.get('result', '')
    elif row.get('interview_summary'):
        row['result'] = row.get('interview_summary')
    elif row.get('interview_sections'):
        row['result'] = row.get('interview_sections')
    batch_orchestrator._upsert_row(
        batch_id,
        row.get('row_id', ''),
        {
            'interview_summary': row.get('interview_summary'),
            'interview_sections': row.get('interview_sections'),
            'interview_combined': row.get('interview_combined'),
            'interview_features_successful': row.get('interview_features_successful', []),
            'study_generation_error': row.get('study_generation_error'),
            'result': row.get('result', ''),
            'interview_features_refunded_count': int(row.get('interview_features_refunded_count', 0) or 0),
            'billing_receipt': row.get('billing_receipt', {}),
            **tokens.as_dict(),
            'updated_at': runtime.time.time(),
        },
        runtime=runtime,
        merge=True,
    )


def _process_row(batch_id, batch, row, throttler, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    tokens = ai_provider.TokenAccumulator(runtime=resolved_runtime)
    retry_tracker = {}
    mode = str((batch or {}).get('mode', '') or '').strip()
    row.setdefault('row_job_id', str(resolved_runtime.uuid.uuid4()))
    row.setdefault('started_at', (batch or {}).get('created_at', resolved_runtime.time.time()))
    row['processing_strategy'] = 'instant'
    row['billing_mode'] = 'instant_batch'
    row['billing_multiplier'] = 1.0

    try:
        if mode in {'lecture-notes', 'slides-only', 'interview', 'audio-transcription'}:
            _upsert_row_progress(batch_id, row, 'file_upload', 'preparing files', runtime=resolved_runtime)
            throttler.wait()
            batch_orchestrator._upload_row_files(row, runtime=resolved_runtime)
            batch_orchestrator._upsert_row(
                batch_id,
                row.get('row_id', ''),
                {
                    'slides_file_uri': row.get('slides_file_uri', ''),
                    'audio_file_uri': row.get('audio_file_uri', ''),
                    'audio_mime_type': row.get('audio_mime_type', ''),
                    'audio_storage_key': row.get('audio_storage_key', ''),
                    'audio_local_path': row.get('audio_local_path', ''),
                    'audio_quota_actual_bytes': int(row.get('audio_quota_actual_bytes', 0) or 0),
                    'audio_quota_released': bool(row.get('audio_quota_released', False)),
                    'updated_at': resolved_runtime.time.time(),
                },
                runtime=resolved_runtime,
                merge=True,
            )

        if mode in {'lecture-notes', 'slides-only'}:
            _run_slide_extraction(batch_id, row, throttler, tokens, retry_tracker, resolved_runtime)

        if mode == 'lecture-notes':
            _run_audio_transcription(
                batch_id,
                row,
                throttler,
                tokens,
                retry_tracker,
                resolved_runtime,
                timestamped=bool(resolved_runtime.FEATURE_AUDIO_SECTION_SYNC),
            )
            _run_notes_merge(batch_id, row, throttler, tokens, retry_tracker, resolved_runtime)
            _run_study_tools(batch_id, row, throttler, tokens, retry_tracker, resolved_runtime)

        elif mode == 'slides-only':
            row['result'] = str(row.get('slide_text', '') or '')
            _run_study_tools(batch_id, row, throttler, tokens, retry_tracker, resolved_runtime)

        elif mode == 'audio-transcription':
            _run_audio_transcription(batch_id, row, throttler, tokens, retry_tracker, resolved_runtime, timestamped=False)

        elif mode == 'interview':
            _run_interview_transcription(batch_id, row, throttler, tokens, retry_tracker, resolved_runtime)
            _run_interview_extras(batch_id, batch, row, throttler, tokens, retry_tracker, resolved_runtime)

        elif mode == 'text-combine':
            _run_notes_merge(batch_id, row, throttler, tokens, retry_tracker, resolved_runtime, text_combine=True)

        else:
            raise ValueError('Unsupported instant batch mode.')

    except Exception as error:
        resolved_runtime.logger.exception('Instant batch row failed for batch_id=%s row_id=%s', batch_id, row.get('row_id', ''))
        row['status'] = 'error'
        row['error'] = _public_row_error(error, resolved_runtime)
        row['failed_stage'] = row.get('current_stage', '') or 'instant_pipeline'
        row['provider_error_code'] = ai_provider.classify_provider_error_code(error, runtime=resolved_runtime)
        row['current_stage_detail'] = _stage_detail(row, 'failed')
        row.update(tokens.as_dict())
        batch_orchestrator._refund_failed_row(batch, row, runtime=resolved_runtime)
    finally:
        _finalize_row(batch_id, batch, row, tokens, retry_tracker, runtime=resolved_runtime)
        _cleanup_row_files(row, runtime=resolved_runtime)
        _refresh_batch_progress(batch_id, runtime=resolved_runtime)


def process_instant_batch_job(batch_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    batch = batch_orchestrator._get_batch(batch_id, runtime=resolved_runtime)
    if not batch:
        return
    if batch_orchestrator._is_terminal_status(batch.get('status', '')):
        return
    rows = batch_orchestrator._list_rows(batch_id, runtime=resolved_runtime)
    if not rows:
        batch_orchestrator._finalize_batch_record(
            batch_id,
            batch,
            stage_error='Instant batch has no rows.',
            status_override='error',
            provider_state_override='NO_ROWS',
            current_stage_state_override='failed',
            current_stage_override='validation',
            runtime=resolved_runtime,
        )
        return

    now_ts = resolved_runtime.time.time()
    batch_orchestrator._upsert_batch(
        batch_id,
        {
            'status': 'processing',
            'processing_strategy': 'instant',
            'billing_mode': 'instant_batch',
            'billing_multiplier': 1.0,
            'current_stage': 'batch_pipeline',
            'current_stage_state': 'running',
            'provider_state': 'INSTANT_RUNNING',
            'stage_started_at': now_ts,
            'last_heartbeat_at': now_ts,
            'updated_at': now_ts,
            'submission_locked': True,
        },
        runtime=resolved_runtime,
        merge=True,
    )

    max_workers = max(1, min(2, int(getattr(resolved_runtime, 'INSTANT_BATCH_MAX_PARALLEL_ROWS', 2) or 2), len(rows)))
    throttler = InstantApiStagger(runtime=resolved_runtime)
    stage_error = ''
    try:
        with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix='lp-instant-row') as executor:
            futures = [
                executor.submit(_process_row, batch_id, batch, row, throttler, resolved_runtime)
                for row in rows
            ]
            for future in as_completed(futures):
                try:
                    future.result()
                except Exception as error:
                    stage_error = str(error)
                    resolved_runtime.logger.exception('Instant batch worker failed for batch_id=%s', batch_id)
    finally:
        latest = batch_orchestrator._get_batch(batch_id, runtime=resolved_runtime) or batch
        batch_orchestrator._finalize_batch_record(
            batch_id,
            latest,
            stage_error=stage_error,
            provider_state_override='',
            current_stage_state_override='finished',
            current_stage_override='batch_pipeline',
            runtime=resolved_runtime,
        )
