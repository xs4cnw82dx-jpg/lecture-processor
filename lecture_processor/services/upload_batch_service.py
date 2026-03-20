"""Batch upload routes extracted from upload API service."""

import json
import zipfile

from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.shared import sanitize_csv_row
from lecture_processor.domains.shared import parsing as shared_parsing
from lecture_processor.domains.study import export as study_export
from lecture_processor.domains.upload import import_audio as upload_import_audio
from lecture_processor.runtime.job_dispatcher import JobQueueFullError

from lecture_processor.services import upload_batch_support


def create_batch_job(app_ctx, request):
    uid, decoded_token, error_response, status = upload_batch_support.batch_user_guard(app_ctx, request)
    if error_response is not None:
        return error_response, status
    deletion_guard = upload_batch_support.account_write_guard_response(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard

    mode = str(request.form.get('mode', 'lecture-notes') or '').strip()
    if mode not in {'lecture-notes', 'slides-only', 'interview'}:
        return app_ctx.jsonify({'error': 'Invalid mode selected'}), 400

    rows = upload_batch_support.parse_batch_rows_payload(request)
    if rows is None:
        return app_ctx.jsonify({'error': 'Invalid rows payload'}), 400
    if len(rows) < 2:
        return app_ctx.jsonify({'error': 'Batch mode requires at least 2 rows.'}), 400
    client_submission_id = str(request.form.get('client_submission_id', '') or '').strip()[:120]
    if client_submission_id:
        existing = batch_orchestrator.find_batch_by_submission_id(
            uid,
            client_submission_id,
            runtime=app_ctx,
        )
        existing_batch_id = str((existing or {}).get('batch_id', '') or '').strip()
        if existing_batch_id:
            return app_ctx.jsonify(
                {
                    'batch_id': existing_batch_id,
                    'deduplicated': True,
                    'status': str((existing or {}).get('status', 'queued') or 'queued'),
                }
            )

    batch_title = upload_batch_support.sanitize_study_pack_title(request.form.get('batch_title', ''))
    if not batch_title:
        return app_ctx.jsonify({'error': 'Batch title is required.'}), 400

    ai_unavailable = upload_batch_support.require_ai_processing_ready(app_ctx)
    if ai_unavailable is not None:
        return ai_unavailable

    decoded_email = str((decoded_token or {}).get('email', '') or '').strip()
    user = app_ctx.get_or_create_user(uid, decoded_email)
    preferred_language_key = shared_parsing.sanitize_output_language_pref_key(
        user.get('preferred_output_language', app_ctx.DEFAULT_OUTPUT_LANGUAGE_KEY),
        runtime=app_ctx,
    )
    preferred_language_custom = shared_parsing.sanitize_output_language_pref_custom(
        user.get('preferred_output_language_custom', ''),
        runtime=app_ctx,
    )
    output_language = shared_parsing.parse_output_language(
        request.form.get('output_language', preferred_language_key),
        request.form.get('output_language_custom', preferred_language_custom),
        runtime=app_ctx,
    )
    default_study_features = shared_parsing.parse_study_features(request.form.get('study_features', 'none'), runtime=app_ctx)
    default_flashcards = shared_parsing.parse_requested_amount(
        request.form.get('flashcard_amount', '20'),
        {'10', '20', '30', 'auto'},
        '20',
        runtime=app_ctx,
    )
    default_questions = shared_parsing.parse_requested_amount(
        request.form.get('question_amount', '10'),
        {'5', '10', '15', 'auto'},
        '10',
        runtime=app_ctx,
    )
    include_combined_docx = upload_batch_support.parse_checkbox_value(request.form.get('include_combined_docx', '0'))

    batch_id = str(app_ctx.uuid.uuid4())
    prepared_rows = []
    cleanup_paths = []
    charged_rows = []
    created_folder_ref = None
    now_ts = app_ctx.time.time()

    try:
        for idx, row_cfg in enumerate(rows, start=1):
            row_id = str(row_cfg.get('row_id', '') or app_ctx.uuid.uuid4())
            slides_required = mode in {'lecture-notes', 'slides-only'}
            audio_required = mode in {'lecture-notes', 'interview'}

            slides_local_path = ''
            slides_field = str(row_cfg.get('slides_file_field', f'row_{idx}_slides') or '').strip()
            if slides_required:
                slides_file = request.files.get(slides_field)
                if not slides_file or slides_file.filename == '':
                    raise ValueError(f'Row {idx}: slides file is required.')
                slides_local_path, slides_error = app_ctx.resolve_uploaded_slides_to_pdf(slides_file, f'{batch_id}_{row_id}')
                if slides_error:
                    raise ValueError(f'Row {idx}: {slides_error}')
                cleanup_paths.append(slides_local_path)

            audio_local_path = ''
            audio_source_type = ''
            audio_source_url = ''
            audio_import_token = str(row_cfg.get('audio_import_token', '') or '').strip()
            audio_url = str(row_cfg.get('audio_m3u8_url', '') or '').strip()
            audio_field = str(row_cfg.get('audio_file_field', f'row_{idx}_audio') or '').strip()
            if audio_required:
                if audio_import_token:
                    audio_local_path, token_error = upload_import_audio.get_audio_import_token_path(
                        uid,
                        audio_import_token,
                        consume=False,
                        runtime=app_ctx,
                    )
                    if token_error:
                        raise ValueError(f'Row {idx}: {token_error}')
                    audio_source_type = 'import_token'
                elif audio_url:
                    safe_url, url_error = upload_import_audio.validate_video_import_url(audio_url, runtime=app_ctx)
                    if not safe_url:
                        raise ValueError(f'Row {idx}: {url_error}')
                    prefix = f'batch_{batch_id}_{row_id}'
                    audio_local_path, _output_name, _size_bytes = app_ctx.download_audio_from_video_url(safe_url, prefix)
                    cleanup_paths.append(audio_local_path)
                    audio_source_type = 'm3u8_url'
                    audio_source_url = safe_url
                else:
                    audio_file = request.files.get(audio_field)
                    if not audio_file or audio_file.filename == '':
                        raise ValueError(f'Row {idx}: audio file is required.')
                    if not app_ctx.allowed_file(audio_file.filename, app_ctx.ALLOWED_AUDIO_EXTENSIONS):
                        raise ValueError(f'Row {idx}: invalid audio file extension.')
                    if (audio_file.mimetype or '').lower() not in app_ctx.ALLOWED_AUDIO_MIME_TYPES:
                        raise ValueError(f'Row {idx}: invalid audio content type.')
                    audio_local_path = app_ctx.os.path.join(app_ctx.UPLOAD_FOLDER, f'{batch_id}_{row_id}_{app_ctx.secure_filename(audio_file.filename)}')
                    audio_file.save(audio_local_path)
                    cleanup_paths.append(audio_local_path)
                    audio_source_type = 'upload'

                audio_size = app_ctx.get_saved_file_size(audio_local_path)
                if audio_size <= 0 or audio_size > app_ctx.MAX_AUDIO_UPLOAD_BYTES:
                    raise ValueError(f'Row {idx}: audio exceeds server limit or is empty.')
                if not app_ctx.file_looks_like_audio(audio_local_path):
                    raise ValueError(f'Row {idx}: uploaded audio is invalid or unsupported.')

            row_study_features = default_study_features
            row_flashcards = default_flashcards
            row_questions = default_questions
            override = row_cfg.get('study_override', {})
            if isinstance(override, dict):
                if 'study_features' in override:
                    row_study_features = shared_parsing.parse_study_features(override.get('study_features', default_study_features), runtime=app_ctx)
                if 'flashcard_amount' in override:
                    row_flashcards = shared_parsing.parse_requested_amount(
                        override.get('flashcard_amount', default_flashcards),
                        {'10', '20', '30', 'auto'},
                        default_flashcards,
                        runtime=app_ctx,
                    )
                if 'question_amount' in override:
                    row_questions = shared_parsing.parse_requested_amount(
                        override.get('question_amount', default_questions),
                        {'5', '10', '15', 'auto'},
                        default_questions,
                        runtime=app_ctx,
                    )

            row_interview_features = []
            interview_features_cost = 0
            if mode == 'interview':
                raw_features = row_cfg.get('interview_features', [])
                if isinstance(raw_features, list):
                    raw_features_text = ','.join(str(item) for item in raw_features)
                else:
                    raw_features_text = str(raw_features or 'none')
                row_interview_features = shared_parsing.parse_interview_features(raw_features_text, runtime=app_ctx)
                interview_features_cost = len(row_interview_features)

            charged_credit = ''
            if mode == 'lecture-notes':
                charged_credit = billing_credits.deduct_credit(
                    uid,
                    'lecture_credits_standard',
                    'lecture_credits_extended',
                    runtime=app_ctx,
                )
                if not charged_credit:
                    raise ValueError('Not enough lecture credits to start this batch.')
            elif mode == 'slides-only':
                charged_credit = billing_credits.deduct_credit(uid, 'slides_credits', runtime=app_ctx)
                if not charged_credit:
                    raise ValueError('Not enough text extraction credits to start this batch.')
            elif mode == 'interview':
                charged_credit = billing_credits.deduct_interview_credit(uid, runtime=app_ctx)
                if not charged_credit:
                    raise ValueError('Not enough interview credits to start this batch.')
                if interview_features_cost > 0:
                    if not billing_credits.deduct_slides_credits(uid, interview_features_cost, runtime=app_ctx):
                        billing_credits.refund_credit(uid, charged_credit, runtime=app_ctx)
                        raise ValueError('Not enough text extraction credits for interview extras in this batch row.')

            charged_rows.append(
                {
                    'credit_type': charged_credit,
                    'interview_features_cost': interview_features_cost,
                }
            )

            if audio_import_token:
                _consumed_path, token_error = upload_import_audio.get_audio_import_token_path(
                    uid,
                    audio_import_token,
                    consume=True,
                    runtime=app_ctx,
                )
                if token_error:
                    raise ValueError(f'Row {idx}: {token_error}')

            billing_receipt = billing_receipts.initialize_billing_receipt(
                {charged_credit: 1, 'slides_credits': interview_features_cost},
                runtime=app_ctx,
            )
            prepared_rows.append(
                {
                    'row_id': row_id,
                    'ordinal': idx,
                    'status': 'queued',
                    'source_type': audio_source_type if audio_source_type else ('upload' if slides_required else 'audio'),
                    'source_url': audio_source_url,
                    'source_name': f'row-{idx}',
                    'slides_local_path': slides_local_path,
                    'audio_local_path': audio_local_path,
                    'output_language': output_language,
                    'study_features': row_study_features if mode != 'interview' else 'none',
                    'flashcard_selection': row_flashcards,
                    'question_selection': row_questions,
                    'interview_features': row_interview_features,
                    'interview_features_cost': interview_features_cost,
                    'credit_deducted': charged_credit,
                    'credit_refunded': False,
                    'billing_receipt': billing_receipt,
                    'billing_mode': 'batch',
                    'billing_multiplier': 0.5,
                    'token_usage_by_stage': {},
                    'token_input_total': 0,
                    'token_output_total': 0,
                    'token_total': 0,
                    'started_at': now_ts,
                    'created_at': now_ts,
                }
            )
        folder_name = batch_title
        folder_id = ''
        if app_ctx.db is not None:
            created_folder_ref = app_ctx.study_repo.create_study_folder_doc_ref(app_ctx.db)
            created_folder_ref.set({
                'folder_id': created_folder_ref.id,
                'uid': uid,
                'name': folder_name,
                'course': '',
                'subject': '',
                'semester': '',
                'block': '',
                'exam_date': '',
                'created_at': now_ts,
                'updated_at': now_ts,
            })
            folder_id = created_folder_ref.id

        batch_payload = {
            'batch_id': batch_id,
            'uid': uid,
            'email': decoded_email or str(user.get('email', '') or '').strip(),
            'mode': mode,
            'status': 'queued',
            'batch_title': batch_title,
            'output_language': output_language,
            'study_defaults': {
                'study_features': default_study_features,
                'flashcard_amount': default_flashcards,
                'question_amount': default_questions,
            },
            'export_options': {
                'include_combined_docx': include_combined_docx,
            },
            'folder_id': folder_id,
            'folder_name': folder_name,
            'total_rows': len(prepared_rows),
            'completed_rows': 0,
            'failed_rows': 0,
            'token_input_total': 0,
            'token_output_total': 0,
            'token_total': 0,
            'external_batch_refs': {},
            'error_summary': '',
            'created_at': now_ts,
            'updated_at': now_ts,
            'finished_at': 0,
            'billing_mode': 'batch',
            'billing_multiplier': 0.5,
            'completion_email_status': 'pending',
            'completion_email_sent_at': 0,
            'completion_email_error': '',
            'current_stage': 'queued',
            'current_stage_state': 'queued',
            'stage_started_at': 0,
            'provider_state': 'JOB_STATE_PENDING',
            'submission_locked': True,
            'client_submission_id': client_submission_id,
            'last_heartbeat_at': now_ts,
            'credits_charged': sum(1 + int(item.get('interview_features_cost', 0) or 0) for item in charged_rows),
            'credits_refunded': 0,
            'credits_refund_pending': 0,
        }
        batch_orchestrator.create_batch_job(batch_payload, prepared_rows, runtime=app_ctx)

        try:
            app_ctx.submit_background_job(
                batch_orchestrator.process_batch_job,
                batch_id,
                runtime=app_ctx,
            )
        except JobQueueFullError:
            batch_orchestrator.mark_batch_submission_error(
                batch_id,
                upload_batch_support.queue_full_message(),
                runtime=app_ctx,
            )
            for charged in charged_rows:
                credit_type = str(charged.get('credit_type', '') or '').strip()
                if credit_type:
                    billing_credits.refund_credit(uid, credit_type, runtime=app_ctx)
                extras = int(charged.get('interview_features_cost', 0) or 0)
                if extras > 0:
                    billing_credits.refund_slides_credits(uid, extras, runtime=app_ctx)
            app_ctx.cleanup_files(cleanup_paths, [])
            return upload_batch_support.queue_full_response(app_ctx, batch_id=batch_id)
        return app_ctx.jsonify({'batch_id': batch_id})
    except Exception as error:
        if created_folder_ref is not None:
            try:
                created_folder_ref.delete()
            except Exception:
                pass
        for charged in charged_rows:
            credit_type = str(charged.get('credit_type', '') or '').strip()
            if credit_type:
                billing_credits.refund_credit(uid, credit_type, runtime=app_ctx)
            extras = int(charged.get('interview_features_cost', 0) or 0)
            if extras > 0:
                billing_credits.refund_slides_credits(uid, extras, runtime=app_ctx)
        app_ctx.cleanup_files(cleanup_paths, [])
        return app_ctx.jsonify({'error': str(error)}), 400


def list_batch_jobs(app_ctx, request):
    uid, _decoded_token, error_response, status = upload_batch_support.batch_user_guard(app_ctx, request)
    if error_response is not None:
        return error_response, status

    mode = str(request.args.get('mode', '') or '').strip()
    status_filter = str(request.args.get('status', '') or '').strip()
    limit = 100
    try:
        limit = int(request.args.get('limit', 100) or 100)
    except Exception:
        limit = 100
    limit = max(1, min(200, limit))

    statuses = []
    if status_filter:
        statuses = [part.strip() for part in status_filter.split(',') if part.strip()]

    batches = batch_orchestrator.list_batches_for_uid(uid, statuses=statuses, limit=limit, runtime=app_ctx)
    if mode:
        batches = [item for item in batches if str(item.get('mode', '') or '') == mode]
    return app_ctx.jsonify({'batches': batches})


def get_batch_job_status(app_ctx, request, batch_id):
    batch, _decoded, error_response, status = upload_batch_support.get_batch_with_permission(
        app_ctx,
        request,
        batch_id,
        batch_orchestrator_module=batch_orchestrator,
    )
    if error_response is not None:
        return error_response, status
    status_payload = batch_orchestrator.get_batch_status(batch_id, runtime=app_ctx)
    if not status_payload:
        return app_ctx.jsonify({'error': 'Batch not found'}), 404
    return app_ctx.jsonify(status_payload)


def batch_row_docx_bytes(app_ctx, row, content_type='result'):
    if content_type == 'slides' and row.get('slide_text'):
        content, title = row.get('slide_text', ''), 'Slides Extracted'
    elif content_type == 'transcript' and row.get('transcript'):
        content, title = row.get('transcript', ''), 'Transcript'
    elif content_type == 'summary' and row.get('interview_summary'):
        content, title = row.get('interview_summary', ''), 'Interview Summary'
    elif content_type == 'sections' and row.get('interview_sections'):
        content, title = row.get('interview_sections', ''), 'Interview Sections'
    elif content_type == 'combined' and row.get('interview_combined'):
        content, title = row.get('interview_combined', ''), 'Interview Combined'
    else:
        content = row.get('result', '') or row.get('merged_notes', '') or row.get('transcript', '') or row.get('slide_text', '')
        title = 'Batch Output'
    doc = study_export.markdown_to_docx(content, title, runtime=app_ctx)
    docx_io = app_ctx.io.BytesIO()
    doc.save(docx_io)
    docx_io.seek(0)
    return docx_io.read()


def batch_row_csv_bytes(app_ctx, row, export_type='flashcards'):
    output = app_ctx.io.StringIO()
    writer = app_ctx.csv.writer(output)
    if export_type == 'test':
        writer.writerow(['Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct Answer', 'Explanation'])
        for question in row.get('test_questions', []):
            options = question.get('options', ['', '', '', ''])
            while len(options) < 4:
                options.append('')
            writer.writerow(sanitize_csv_row([
                question.get('question', ''),
                options[0],
                options[1],
                options[2],
                options[3],
                question.get('answer', ''),
                question.get('explanation', ''),
            ]))
    else:
        writer.writerow(['Front', 'Back'])
        for card in row.get('flashcards', []):
            writer.writerow(sanitize_csv_row([card.get('front', ''), card.get('back', '')]))
    return output.getvalue().encode('utf-8')


def append_combined_markdown_section(parts, title, content):
    text = str(content or '').strip()
    if not text:
        return
    parts.append(f'## {title}')
    parts.append('')
    parts.append(text)
    parts.append('')


def batch_row_flashcards_markdown(row):
    cards = row.get('flashcards', []) if isinstance(row.get('flashcards', []), list) else []
    if not cards:
        return ''
    lines = []
    for index, card in enumerate(cards, start=1):
        front = str((card or {}).get('front', '') or '').strip() or f'Flashcard {index}'
        back = str((card or {}).get('back', '') or '').strip()
        lines.append(f'{index}. **{front}**')
        if back:
            lines.append(f'   - {back}')
    return '\n'.join(lines).strip()


def batch_row_questions_markdown(row):
    questions = row.get('test_questions', []) if isinstance(row.get('test_questions', []), list) else []
    if not questions:
        return ''
    lines = []
    letters = ['A', 'B', 'C', 'D']
    for index, question in enumerate(questions, start=1):
        question_text = str((question or {}).get('question', '') or '').strip() or f'Question {index}'
        lines.append(f'{index}. **{question_text}**')
        options = (question or {}).get('options', []) if isinstance((question or {}).get('options', []), list) else []
        for option_index, option in enumerate(options[:4]):
            option_text = str(option or '').strip()
            if option_text:
                lines.append(f'   - {letters[option_index]}: {option_text}')
        answer = str((question or {}).get('answer', '') or '').strip()
        if answer:
            lines.append(f'   - Correct answer: {answer}')
        explanation = str((question or {}).get('explanation', '') or '').strip()
        if explanation:
            lines.append(f'   - Explanation: {explanation}')
    return '\n'.join(lines).strip()


def batch_row_combined_markdown(batch, row):
    mode = str((batch or {}).get('mode', '') or '').strip().lower()
    row_label = str(row.get('source_name', '') or '').strip() or f'Row {int(row.get("ordinal", 0) or 0)}'
    status = str(row.get('status', 'queued') or 'queued').strip().lower()
    parts = [f'# {row_label}', '']

    if status != 'complete':
        parts.append(f'Status: {status}')
        parts.append('')
        parts.append('Output was unavailable when this ZIP was created.')
        error_text = str(row.get('error', '') or '').strip()
        if error_text:
            parts.append('')
            parts.append(f'Reason: {error_text}')
        parts.append('')
        return '\n'.join(parts).strip()

    result_text = str(row.get('result', '') or row.get('merged_notes', '') or '').strip()
    slide_text = str(row.get('slide_text', '') or '').strip()
    transcript_text = str(row.get('transcript', '') or '').strip()
    interview_summary = str(row.get('interview_summary', '') or '').strip()
    interview_sections = str(row.get('interview_sections', '') or '').strip()
    interview_combined = str(row.get('interview_combined', '') or '').strip()

    if mode == 'lecture-notes':
        append_combined_markdown_section(parts, 'Lecture Notes', result_text)
        append_combined_markdown_section(parts, 'Slide Extract', slide_text)
        append_combined_markdown_section(parts, 'Transcript', transcript_text)
    elif mode == 'slides-only':
        append_combined_markdown_section(parts, 'Slide Extract', slide_text or result_text)
    elif mode == 'interview':
        append_combined_markdown_section(parts, 'Transcript', transcript_text or result_text)
        append_combined_markdown_section(parts, 'Interview Summary', interview_summary)
        append_combined_markdown_section(parts, 'Structured Transcript', interview_sections)
        if interview_combined and not interview_summary and not interview_sections:
            append_combined_markdown_section(parts, 'Combined Output', interview_combined)
    else:
        append_combined_markdown_section(parts, 'Output', result_text)

    flashcards_markdown = batch_row_flashcards_markdown(row)
    if flashcards_markdown:
        append_combined_markdown_section(parts, 'Flashcards', flashcards_markdown)

    questions_markdown = batch_row_questions_markdown(row)
    if questions_markdown:
        append_combined_markdown_section(parts, 'Practice Questions', questions_markdown)

    return '\n'.join(part for part in parts if part is not None).strip()


def batch_combined_docx_bytes(app_ctx, batch, rows):
    batch_title = str((batch or {}).get('batch_title', '') or (batch or {}).get('batch_id', '') or 'Batch Combined').strip()
    sections = []
    for row in rows:
        sections.append(batch_row_combined_markdown(batch, row))
    markdown_text = '\n\n'.join(section for section in sections if str(section or '').strip()).strip()
    if not markdown_text:
        markdown_text = '# Batch Output\n\nNo row output was available when this ZIP was created.'
    doc = study_export.markdown_to_docx(markdown_text, title=batch_title + ' Combined', runtime=app_ctx)
    output = app_ctx.io.BytesIO()
    doc.save(output)
    output.seek(0)
    return output.read()


def download_batch_row_docx(app_ctx, request, batch_id, row_id):
    _batch, _decoded, error_response, status = upload_batch_support.get_batch_with_permission(
        app_ctx,
        request,
        batch_id,
        batch_orchestrator_module=batch_orchestrator,
    )
    if error_response is not None:
        return error_response, status
    row = batch_orchestrator.get_batch_row(batch_id, row_id, runtime=app_ctx)
    if not row:
        return app_ctx.jsonify({'error': 'Row not found'}), 404
    if row.get('status') != 'complete':
        return app_ctx.jsonify({'error': 'Row is not complete'}), 400
    content_type = request.args.get('type', 'result')
    docx_bytes = batch_row_docx_bytes(app_ctx, row, content_type=content_type)
    return app_ctx.send_file(
        app_ctx.io.BytesIO(docx_bytes),
        mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        as_attachment=True,
        download_name=f'batch-{batch_id}-{row_id}-{content_type}.docx',
    )


def download_batch_row_flashcards_csv(app_ctx, request, batch_id, row_id):
    _batch, _decoded, error_response, status = upload_batch_support.get_batch_with_permission(
        app_ctx,
        request,
        batch_id,
        batch_orchestrator_module=batch_orchestrator,
    )
    if error_response is not None:
        return error_response, status
    row = batch_orchestrator.get_batch_row(batch_id, row_id, runtime=app_ctx)
    if not row:
        return app_ctx.jsonify({'error': 'Row not found'}), 404
    if row.get('status') != 'complete':
        return app_ctx.jsonify({'error': 'Row is not complete'}), 400
    export_type = request.args.get('type', 'flashcards').strip().lower()
    if export_type not in {'flashcards', 'test'}:
        export_type = 'flashcards'
    csv_bytes = batch_row_csv_bytes(app_ctx, row, export_type=export_type)
    return app_ctx.send_file(
        app_ctx.io.BytesIO(csv_bytes),
        mimetype='text/csv',
        as_attachment=True,
        download_name=f'batch-{batch_id}-{row_id}-{export_type}.csv',
    )


def download_batch_zip(app_ctx, request, batch_id):
    batch, _decoded, error_response, status = upload_batch_support.get_batch_with_permission(
        app_ctx,
        request,
        batch_id,
        batch_orchestrator_module=batch_orchestrator,
    )
    if error_response is not None:
        return error_response, status
    batch_status = batch_orchestrator.get_batch_status(batch_id, runtime=app_ctx) or {}
    if not bool(batch_status.get('can_download_zip', False)):
        return app_ctx.jsonify({'error': 'Batch ZIP is available after at least one row completes.'}), 400
    rows = batch_orchestrator.list_batch_rows(batch_id, runtime=app_ctx)
    export_options = batch.get('export_options', {}) if isinstance(batch.get('export_options', {}), dict) else {}
    include_combined_docx = bool(export_options.get('include_combined_docx', False))
    archive_bytes = app_ctx.io.BytesIO()
    with zipfile.ZipFile(archive_bytes, mode='w', compression=zipfile.ZIP_DEFLATED) as archive:
        summary = {
            'batch_id': batch.get('batch_id', batch_id),
            'mode': batch.get('mode', ''),
            'status': batch.get('status', ''),
            'total_rows': batch.get('total_rows', len(rows)),
            'completed_rows': batch.get('completed_rows', 0),
            'failed_rows': batch.get('failed_rows', 0),
            'token_input_total': batch.get('token_input_total', 0),
            'token_output_total': batch.get('token_output_total', 0),
            'token_total': batch.get('token_total', 0),
            'export_options': export_options,
        }
        archive.writestr('summary.json', json.dumps(summary, ensure_ascii=False, indent=2))
        if include_combined_docx:
            combined_name = study_export.sanitize_export_filename(
                batch.get('batch_title', '') or f'batch-{batch_id}',
                fallback=f'batch-{batch_id}',
            ) + '_Combined.docx'
            archive.writestr(combined_name, batch_combined_docx_bytes(app_ctx, batch, rows))
        for row in rows:
            row_id = str(row.get('row_id', '') or '')
            folder = f'rows/{row_id}'
            archive.writestr(f'{folder}/meta.json', json.dumps(row, ensure_ascii=False, indent=2, default=str))
            if row.get('status') != 'complete':
                continue
            try:
                archive.writestr(f'{folder}/result.docx', batch_row_docx_bytes(app_ctx, row, content_type='result'))
                if row.get('slide_text'):
                    archive.writestr(f'{folder}/slides.docx', batch_row_docx_bytes(app_ctx, row, content_type='slides'))
                if row.get('transcript'):
                    archive.writestr(f'{folder}/transcript.docx', batch_row_docx_bytes(app_ctx, row, content_type='transcript'))
                if row.get('interview_summary'):
                    archive.writestr(f'{folder}/summary.docx', batch_row_docx_bytes(app_ctx, row, content_type='summary'))
                if row.get('interview_sections'):
                    archive.writestr(f'{folder}/sections.docx', batch_row_docx_bytes(app_ctx, row, content_type='sections'))
                if row.get('flashcards'):
                    archive.writestr(f'{folder}/flashcards.csv', batch_row_csv_bytes(app_ctx, row, export_type='flashcards'))
                if row.get('test_questions'):
                    archive.writestr(f'{folder}/test_questions.csv', batch_row_csv_bytes(app_ctx, row, export_type='test'))
            except Exception as error:
                archive.writestr(f'{folder}/error.txt', str(error))
    archive_bytes.seek(0)
    filename = f'batch-{batch_id}.zip'
    return app_ctx.send_file(
        archive_bytes,
        mimetype='application/zip',
        as_attachment=True,
        download_name=filename,
    )
