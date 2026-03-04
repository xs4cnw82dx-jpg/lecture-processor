from datetime import datetime, timezone

from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.ai import study_generation
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.domains.study import audio as study_audio
from lecture_processor.domains.study import progress as study_progress
from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def save_study_pack(job_id, job_data, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    try:
        notes_markdown = str(job_data.get('result', '') or '')
        max_notes_chars = 180000
        notes_truncated = len(notes_markdown) > max_notes_chars
        if notes_truncated:
            notes_markdown = notes_markdown[:max_notes_chars]

        doc_ref = resolved_runtime.study_repo.create_study_pack_doc_ref(resolved_runtime.db)
        now_ts = resolved_runtime.time.time()
        tzinfo, timezone_name = study_progress.resolve_user_timezone(job_data.get('user_id', ''), runtime=resolved_runtime)
        local_title_time = datetime.fromtimestamp(now_ts, tz=timezone.utc).astimezone(tzinfo)

        doc_ref.set(
            {
                'study_pack_id': doc_ref.id,
                'source_job_id': job_id,
                'uid': job_data.get('user_id', ''),
                'mode': job_data.get('mode', ''),
                'title': f"{job_data.get('mode', 'study-pack')} {local_title_time.strftime('%Y-%m-%d %H:%M')}",
                'title_timezone': timezone_name,
                'output_language': job_data.get('output_language', 'English'),
                'notes_markdown': notes_markdown,
                'notes_truncated': notes_truncated,
                'transcript_segments': job_data.get('transcript_segments', []),
                'notes_audio_map': job_data.get('notes_audio_map', []),
                'audio_storage_key': study_audio.normalize_audio_storage_key(
                    job_data.get('audio_storage_key', ''),
                    runtime=resolved_runtime,
                ),
                'has_audio_sync': (
                    resolved_runtime.FEATURE_AUDIO_SECTION_SYNC
                    and bool(job_data.get('audio_storage_key'))
                    and bool(job_data.get('notes_audio_map', []))
                ),
                'has_audio_playback': bool(job_data.get('audio_storage_key')),
                'flashcards': job_data.get('flashcards', []),
                'test_questions': job_data.get('test_questions', []),
                'flashcard_selection': job_data.get('flashcard_selection', '20'),
                'question_selection': job_data.get('question_selection', '10'),
                'study_features': job_data.get('study_features', 'none'),
                'interview_features': job_data.get('interview_features', []),
                'interview_summary': job_data.get('interview_summary'),
                'interview_sections': job_data.get('interview_sections'),
                'interview_combined': job_data.get('interview_combined'),
                'study_generation_error': job_data.get('study_generation_error'),
                'course': '',
                'subject': '',
                'semester': '',
                'block': '',
                'folder_id': '',
                'folder_name': '',
                'created_at': now_ts,
                'updated_at': now_ts,
            }
        )
        job_data['study_pack_id'] = doc_ref.id
    except Exception as error:
        resolved_runtime.logger.error('❌ Failed to save study pack for job %s: %s', job_id, error)


def process_lecture_notes(job_id, pdf_path, audio_path, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    gemini_files = []
    local_paths = [pdf_path, audio_path]
    set_fields = lambda **fields: runtime_jobs_store.update_job_fields(job_id, runtime=resolved_runtime, **fields)
    get_fields = lambda: runtime_jobs_store.get_job_snapshot(job_id, runtime=resolved_runtime) or {}
    tokens = ai_provider.TokenAccumulator(runtime=resolved_runtime)
    retry_tracker = {}
    failed_stage = 'initialization'

    try:
        set_fields(status='processing', step=1, step_description='Extracting text from slides...')
        failed_stage = 'slide_upload'
        pdf_file = ai_provider.run_with_provider_retry(
            'slide_upload',
            lambda: resolved_runtime.client.files.upload(file=pdf_path, config={'mime_type': 'application/pdf'}),
            retry_tracker=retry_tracker,
            runtime=resolved_runtime,
        )
        gemini_files.append(pdf_file)

        failed_stage = 'slide_file_processing'
        ai_provider.run_with_provider_retry(
            'slide_file_processing',
            lambda: resolved_runtime.wait_for_file_processing(pdf_file),
            retry_tracker=retry_tracker,
            runtime=resolved_runtime,
        )

        failed_stage = 'slide_extraction'
        response = ai_provider.generate_with_policy(
            resolved_runtime.MODEL_SLIDES,
            [
                resolved_runtime.types.Content(
                    role='user',
                    parts=[
                        resolved_runtime.types.Part.from_uri(file_uri=pdf_file.uri, mime_type='application/pdf'),
                        resolved_runtime.types.Part.from_text(text=resolved_runtime.PROMPT_SLIDE_EXTRACTION),
                    ],
                )
            ],
            retry_tracker=retry_tracker,
            operation_name='slide_extraction',
            runtime=resolved_runtime,
        )
        tokens.record('slide_extraction', response)
        slide_text = response.text
        set_fields(slide_text=slide_text, step=2, step_description='Transcribing audio...')

        output_language = get_fields().get('output_language', 'English')
        converted_audio_path, converted = resolved_runtime.convert_audio_to_mp3_with_ytdlp(audio_path)
        if converted and converted_audio_path not in local_paths:
            local_paths.append(converted_audio_path)

        set_fields(step_description='Optimizing audio for faster processing...')
        audio_mime_type = resolved_runtime.get_mime_type(converted_audio_path)

        failed_stage = 'audio_upload'
        audio_file = ai_provider.run_with_provider_retry(
            'audio_upload',
            lambda: resolved_runtime.client.files.upload(file=converted_audio_path, config={'mime_type': audio_mime_type}),
            retry_tracker=retry_tracker,
            runtime=resolved_runtime,
        )
        gemini_files.append(audio_file)

        set_fields(step_description='Processing audio file (this may take a few minutes)...')
        failed_stage = 'audio_file_processing'
        ai_provider.run_with_provider_retry(
            'audio_file_processing',
            lambda: resolved_runtime.wait_for_file_processing(audio_file),
            retry_tracker=retry_tracker,
            runtime=resolved_runtime,
        )

        set_fields(step_description='Generating transcript...')
        failed_stage = 'audio_transcription'
        if resolved_runtime.FEATURE_AUDIO_SECTION_SYNC:
            transcript, transcript_segments = resolved_runtime.transcribe_audio_with_timestamps(
                audio_file,
                audio_mime_type,
                output_language,
                retry_tracker=retry_tracker,
            )
        else:
            transcript = resolved_runtime.transcribe_audio_plain(
                audio_file,
                audio_mime_type,
                output_language,
                retry_tracker=retry_tracker,
            )
            transcript_segments = []

        set_fields(
            transcript=transcript,
            transcript_segments=transcript_segments,
            audio_storage_key=study_audio.persist_audio_for_study_pack(job_id, converted_audio_path, runtime=resolved_runtime),
            step=3,
            step_description='Creating complete lecture notes...',
        )

        merge_transcript = (
            study_audio.format_transcript_with_timestamps(transcript_segments, runtime=resolved_runtime)
            if transcript_segments
            else transcript
        )
        if resolved_runtime.FEATURE_AUDIO_SECTION_SYNC and transcript_segments:
            merge_prompt = resolved_runtime.PROMPT_MERGE_WITH_AUDIO_MARKERS.format(
                slide_text=slide_text,
                transcript=merge_transcript,
                output_language=output_language,
            )
        else:
            merge_prompt = resolved_runtime.PROMPT_MERGE_TEMPLATE.format(
                slide_text=slide_text,
                transcript=transcript,
                output_language=output_language,
            )

        failed_stage = 'notes_merge'
        response = ai_provider.generate_with_policy(
            resolved_runtime.MODEL_INTEGRATION,
            [resolved_runtime.types.Content(role='user', parts=[resolved_runtime.types.Part.from_text(text=merge_prompt)])],
            retry_tracker=retry_tracker,
            operation_name='notes_merge',
            runtime=resolved_runtime,
        )
        tokens.record('merge', response)
        merged_notes = response.text

        set_fields(
            result=merged_notes,
            notes_audio_map=(
                study_audio.parse_audio_markers_from_notes(merged_notes, runtime=resolved_runtime)
                if resolved_runtime.FEATURE_AUDIO_SECTION_SYNC
                else []
            ),
        )

        job_data = get_fields()
        if job_data.get('study_features', 'none') != 'none':
            set_fields(step=4, step_description='Generating flashcards and practice test...')
            failed_stage = 'study_tools_generation'
            flashcards, test_questions, study_error = study_generation.generate_study_materials(
                merged_notes,
                job_data.get('flashcard_selection', '20'),
                job_data.get('question_selection', '10'),
                job_data.get('study_features', 'none'),
                output_language,
                retry_tracker=retry_tracker,
                runtime=resolved_runtime,
            )
            set_fields(
                flashcards=flashcards,
                test_questions=test_questions,
                study_generation_error=study_error,
            )
        else:
            set_fields(flashcards=[], test_questions=[], study_generation_error=None)

        job_data = get_fields()
        save_study_pack(job_id, job_data, runtime=resolved_runtime)
        final_snapshot = get_fields()
        set_fields(status='complete', step=final_snapshot.get('total_steps', 3), step_description='Complete!')
    except Exception as error:
        resolved_runtime.logger.exception('Lecture-notes processing failed for job %s', job_id)
        set_fields(
            status='error',
            error=resolved_runtime.PROCESSING_PUBLIC_ERROR_MESSAGE,
            failed_stage=failed_stage,
            retry_attempts=sum((int(v or 0) for v in retry_tracker.values())),
            provider_error_code=ai_provider.classify_provider_error_code(error, runtime=resolved_runtime),
        )
        failed_job = get_fields()
        uid = failed_job.get('user_id')
        credit_type = failed_job.get('credit_deducted')
        billing_credits.refund_credit(uid, credit_type, runtime=resolved_runtime)
        failed_job = get_fields()
        billing_receipts.add_job_credit_refund(failed_job, credit_type, 1, runtime=resolved_runtime)
        runtime_jobs_store.set_job(job_id, failed_job, runtime=resolved_runtime)
        set_fields(credit_refunded=True)
    finally:
        resolved_runtime.cleanup_files(local_paths, gemini_files)
        finished_at = resolved_runtime.time.time()
        set_fields(
            finished_at=finished_at,
            retry_attempts=sum((int(v or 0) for v in retry_tracker.values())),
            **tokens.as_dict(),
        )
        final_job = get_fields()
        resolved_runtime.save_job_log(job_id, final_job, finished_at)


def process_slides_only(job_id, pdf_path, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    gemini_files = []
    local_paths = [pdf_path]
    set_fields = lambda **fields: runtime_jobs_store.update_job_fields(job_id, runtime=resolved_runtime, **fields)
    get_fields = lambda: runtime_jobs_store.get_job_snapshot(job_id, runtime=resolved_runtime) or {}
    tokens = ai_provider.TokenAccumulator(runtime=resolved_runtime)
    retry_tracker = {}
    failed_stage = 'initialization'

    try:
        set_fields(status='processing', step=1, step_description='Extracting text from slides...')

        failed_stage = 'slide_upload'
        pdf_file = ai_provider.run_with_provider_retry(
            'slide_upload',
            lambda: resolved_runtime.client.files.upload(file=pdf_path, config={'mime_type': 'application/pdf'}),
            retry_tracker=retry_tracker,
            runtime=resolved_runtime,
        )
        gemini_files.append(pdf_file)

        failed_stage = 'slide_file_processing'
        ai_provider.run_with_provider_retry(
            'slide_file_processing',
            lambda: resolved_runtime.wait_for_file_processing(pdf_file),
            retry_tracker=retry_tracker,
            runtime=resolved_runtime,
        )

        failed_stage = 'slide_extraction'
        response = ai_provider.generate_with_policy(
            resolved_runtime.MODEL_SLIDES,
            [
                resolved_runtime.types.Content(
                    role='user',
                    parts=[
                        resolved_runtime.types.Part.from_uri(file_uri=pdf_file.uri, mime_type='application/pdf'),
                        resolved_runtime.types.Part.from_text(text=resolved_runtime.PROMPT_SLIDE_EXTRACTION),
                    ],
                )
            ],
            retry_tracker=retry_tracker,
            operation_name='slide_extraction',
            runtime=resolved_runtime,
        )
        tokens.record('slide_extraction', response)

        extracted_text = response.text
        set_fields(result=extracted_text)

        job_data = get_fields()
        if job_data.get('study_features', 'none') != 'none':
            set_fields(step=2, step_description='Generating flashcards and practice test...')
            failed_stage = 'study_tools_generation'
            flashcards, test_questions, study_error = study_generation.generate_study_materials(
                extracted_text,
                job_data.get('flashcard_selection', '20'),
                job_data.get('question_selection', '10'),
                job_data.get('study_features', 'none'),
                job_data.get('output_language', 'English'),
                retry_tracker=retry_tracker,
                runtime=resolved_runtime,
            )
            set_fields(
                flashcards=flashcards,
                test_questions=test_questions,
                study_generation_error=study_error,
            )
        else:
            set_fields(flashcards=[], test_questions=[], study_generation_error=None)

        job_data = get_fields()
        save_study_pack(job_id, job_data, runtime=resolved_runtime)
        final_snapshot = get_fields()
        set_fields(status='complete', step=final_snapshot.get('total_steps', 1), step_description='Complete!')
    except Exception as error:
        resolved_runtime.logger.exception('Slides-only processing failed for job %s', job_id)
        set_fields(
            status='error',
            error=resolved_runtime.PROCESSING_PUBLIC_ERROR_MESSAGE,
            failed_stage=failed_stage,
            retry_attempts=sum((int(v or 0) for v in retry_tracker.values())),
            provider_error_code=ai_provider.classify_provider_error_code(error, runtime=resolved_runtime),
        )
        failed_job = get_fields()
        uid = failed_job.get('user_id')
        credit_type = failed_job.get('credit_deducted')
        billing_credits.refund_credit(uid, credit_type, runtime=resolved_runtime)
        failed_job = get_fields()
        billing_receipts.add_job_credit_refund(failed_job, credit_type, 1, runtime=resolved_runtime)
        runtime_jobs_store.set_job(job_id, failed_job, runtime=resolved_runtime)
        set_fields(credit_refunded=True)
    finally:
        resolved_runtime.cleanup_files(local_paths, gemini_files)
        finished_at = resolved_runtime.time.time()
        set_fields(
            finished_at=finished_at,
            retry_attempts=sum((int(v or 0) for v in retry_tracker.values())),
            **tokens.as_dict(),
        )
        final_job = get_fields()
        resolved_runtime.save_job_log(job_id, final_job, finished_at)


def process_interview_transcription(job_id, audio_path, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    gemini_files = []
    local_paths = [audio_path]
    set_fields = lambda **fields: runtime_jobs_store.update_job_fields(job_id, runtime=resolved_runtime, **fields)
    get_fields = lambda: runtime_jobs_store.get_job_snapshot(job_id, runtime=resolved_runtime) or {}
    tokens = ai_provider.TokenAccumulator(runtime=resolved_runtime)
    retry_tracker = {}
    failed_stage = 'initialization'

    try:
        set_fields(status='processing', step=1, step_description='Optimizing audio for faster processing...')

        output_language = get_fields().get('output_language', 'English')
        converted_audio_path, converted = resolved_runtime.convert_audio_to_mp3_with_ytdlp(audio_path)
        if converted and converted_audio_path not in local_paths:
            local_paths.append(converted_audio_path)

        set_fields(audio_storage_key=study_audio.persist_audio_for_study_pack(job_id, converted_audio_path, runtime=resolved_runtime))
        audio_mime_type = resolved_runtime.get_mime_type(converted_audio_path)

        failed_stage = 'audio_upload'
        audio_file = ai_provider.run_with_provider_retry(
            'audio_upload',
            lambda: resolved_runtime.client.files.upload(file=converted_audio_path, config={'mime_type': audio_mime_type}),
            retry_tracker=retry_tracker,
            runtime=resolved_runtime,
        )
        gemini_files.append(audio_file)

        set_fields(step_description='Processing audio file (this may take a few minutes)...')
        failed_stage = 'audio_file_processing'
        ai_provider.run_with_provider_retry(
            'audio_file_processing',
            lambda: resolved_runtime.wait_for_file_processing(audio_file),
            retry_tracker=retry_tracker,
            runtime=resolved_runtime,
        )

        set_fields(step_description='Generating transcript with timestamps...')
        interview_prompt = resolved_runtime.PROMPT_INTERVIEW_TRANSCRIPTION.format(output_language=output_language)
        failed_stage = 'interview_transcription'
        response = ai_provider.generate_with_policy(
            resolved_runtime.MODEL_INTERVIEW,
            [
                resolved_runtime.types.Content(
                    role='user',
                    parts=[
                        resolved_runtime.types.Part.from_uri(file_uri=audio_file.uri, mime_type=audio_mime_type),
                        resolved_runtime.types.Part.from_text(text=interview_prompt),
                    ],
                )
            ],
            retry_tracker=retry_tracker,
            operation_name='interview_transcription',
            runtime=resolved_runtime,
        )
        tokens.record('interview_transcription', response)

        transcript_text = response.text or ''
        set_fields(transcript=transcript_text, result=transcript_text)

        job_data = get_fields()
        selected_features = job_data.get('interview_features', [])
        if selected_features:
            set_fields(step=2, step_description='Creating interview summary and sections...')
            failed_stage = 'interview_enhancements'
            enhancement = study_generation.generate_interview_enhancements(
                transcript_text,
                selected_features,
                output_language,
                retry_tracker=retry_tracker,
                runtime=resolved_runtime,
            )
            set_fields(
                interview_summary=enhancement.get('summary'),
                interview_sections=enhancement.get('sections'),
                interview_combined=enhancement.get('combined'),
                interview_features_successful=enhancement.get('successful_features', []),
                study_generation_error=enhancement.get('error'),
            )

            failed_count = enhancement.get('failed_count', 0)
            if failed_count > 0:
                current_job = get_fields()
                uid = current_job.get('user_id')
                billing_credits.refund_slides_credits(uid, failed_count, runtime=resolved_runtime)
                current_job = get_fields()
                current_job['extra_slides_refunded'] = current_job.get('extra_slides_refunded', 0) + failed_count
                billing_receipts.add_job_credit_refund(current_job, 'slides_credits', failed_count, runtime=resolved_runtime)
                runtime_jobs_store.set_job(job_id, current_job, runtime=resolved_runtime)

            if enhancement.get('summary') and enhancement.get('sections'):
                set_fields(result=enhancement.get('combined', transcript_text))
            elif enhancement.get('summary'):
                set_fields(result=enhancement.get('summary'))
            elif enhancement.get('sections'):
                set_fields(result=enhancement.get('sections'))

        job_data = get_fields()
        save_study_pack(job_id, job_data, runtime=resolved_runtime)
        final_snapshot = get_fields()
        set_fields(status='complete', step=final_snapshot.get('total_steps', 1), step_description='Complete!')
    except Exception as error:
        resolved_runtime.logger.exception('Interview processing failed for job %s', job_id)
        set_fields(
            status='error',
            error=resolved_runtime.PROCESSING_PUBLIC_ERROR_MESSAGE,
            failed_stage=failed_stage,
            retry_attempts=sum((int(v or 0) for v in retry_tracker.values())),
            provider_error_code=ai_provider.classify_provider_error_code(error, runtime=resolved_runtime),
        )

        failed_job = get_fields()
        uid = failed_job.get('user_id')
        credit_type = failed_job.get('credit_deducted')
        billing_credits.refund_credit(uid, credit_type, runtime=resolved_runtime)

        failed_job = get_fields()
        billing_receipts.add_job_credit_refund(failed_job, credit_type, 1, runtime=resolved_runtime)

        extra_spent = failed_job.get('interview_features_cost', 0)
        already_refunded = failed_job.get('extra_slides_refunded', 0)
        to_refund = max(0, extra_spent - already_refunded)
        if to_refund > 0:
            billing_credits.refund_slides_credits(uid, to_refund, runtime=resolved_runtime)
            failed_job['extra_slides_refunded'] = already_refunded + to_refund
            billing_receipts.add_job_credit_refund(failed_job, 'slides_credits', to_refund, runtime=resolved_runtime)
        failed_job['credit_refunded'] = True
        runtime_jobs_store.set_job(job_id, failed_job, runtime=resolved_runtime)
    finally:
        resolved_runtime.cleanup_files(local_paths, gemini_files)
        finished_at = resolved_runtime.time.time()
        set_fields(
            finished_at=finished_at,
            retry_attempts=sum((int(v or 0) for v in retry_tracker.values())),
            **tokens.as_dict(),
        )
        final_job = get_fields()
        resolved_runtime.save_job_log(job_id, final_job, finished_at)
