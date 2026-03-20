"""Background tools extraction flow and reader-specific job handling."""

from __future__ import annotations

from dataclasses import dataclass

from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.runtime.job_dispatcher import JobQueueFullError
from lecture_processor.services import upload_api_service


@dataclass(frozen=True)
class _StagedToolInput:
    source_type: str
    source_url: str
    prompt_template_key: str
    prompt_source: str
    custom_prompt: str
    extension: str
    mime_type: str
    staged_paths: tuple[str, ...]
    normalized_input_name: str
    normalized_input_names: tuple[str, ...]
    upload_mime_type: str
    source_size_mb: float


class _SavedUploadFile:
    def __init__(self, app_ctx, source_path: str, filename: str, mime_type: str):
        self._app_ctx = app_ctx
        self._source_path = str(source_path or '')
        self.filename = str(filename or '')
        self.mimetype = str(mime_type or '')

    def save(self, destination_path):
        self._app_ctx.shutil.copyfile(self._source_path, destination_path)


def _is_email_allowed(app_ctx, email: str) -> bool:
    checker = getattr(app_ctx, 'is_email_allowed', None)
    if callable(checker):
        try:
            return bool(checker(email))
        except TypeError:
            return bool(checker(email, runtime=app_ctx))
    return auth_policy.is_email_allowed(email, runtime=app_ctx)


def _stage_uploaded_file(app_ctx, uploaded_file, *, job_id: str, label: str, index: int | None = None) -> tuple[str, int]:
    safe_name = app_ctx.secure_filename(str(getattr(uploaded_file, 'filename', '') or ''))
    suffix = f'_{index}' if index is not None else ''
    staged_path = app_ctx.os.path.join(app_ctx.UPLOAD_FOLDER, f'tools_input_{job_id}_{label}{suffix}_{safe_name}')
    uploaded_file.save(staged_path)
    return staged_path, int(app_ctx.get_saved_file_size(staged_path) or 0)


def _stage_tools_request_inputs(app_ctx, request, *, job_id: str) -> tuple[_StagedToolInput | None, tuple[str, ...], tuple[object, ...], tuple[object, ...], tuple[object, ...]]:
    custom_prompt = upload_api_service._sanitize_tools_custom_prompt(request.form.get('custom_prompt', ''))
    prompt_template_key = upload_api_service._sanitize_tools_template_key(request.form.get('prompt_template_key', ''))
    prompt_source = 'default'
    if prompt_template_key:
        prompt_source = 'template'
    elif custom_prompt:
        prompt_source = 'custom'

    requested_source = request.form.get('source_type', request.form.get('source', 'auto'))
    staged_paths = []
    uploaded_image_files = []
    normalized_input_names = []
    source_size_mb = 0.0
    source_url = ''
    source_type = ''
    extension = ''
    mime_type = ''
    upload_mime_type = ''
    normalized_input_name = ''

    if str(requested_source or '').strip().lower() == 'url':
        source_url, url_error = upload_api_service._sanitize_tools_source_url(request.form.get('source_url', ''))
        if url_error:
            return None, tuple(staged_paths), (source_url, url_error), (), ()
        source_type = 'url'
        mime_type = 'text/html'
    else:
        requested_source_key = str(requested_source or '').strip().lower()
        if requested_source_key == 'image':
            uploaded_image_files = [f for f in (request.files.getlist('files') or []) if f and str(f.filename or '').strip()]
            if not uploaded_image_files:
                single_image = request.files.get('file')
                if single_image and str(single_image.filename or '').strip():
                    uploaded_image_files = [single_image]
            if not uploaded_image_files:
                return None, tuple(staged_paths), (), ('Please choose at least one image before running extraction.',), ()
            if len(uploaded_image_files) > 5:
                return None, tuple(staged_paths), (), ('You can upload up to 5 images per run.',), ()
            uploaded_file = uploaded_image_files[0]
            source_type, extension, mime_type, detect_error = upload_api_service._detect_tools_source_type(
                app_ctx,
                uploaded_file,
                'image',
            )
        else:
            uploaded_file = request.files.get('file')
            if not uploaded_file or not str(uploaded_file.filename or '').strip():
                return None, tuple(staged_paths), (), ('Please choose a file before running extraction.',), ()
            source_type, extension, mime_type, detect_error = upload_api_service._detect_tools_source_type(
                app_ctx,
                uploaded_file,
                requested_source,
            )
        if detect_error:
            return None, tuple(staged_paths), (), (detect_error,), ()

        if source_type == 'image':
            total_image_bytes = 0
            for index, image_file in enumerate(uploaded_image_files):
                image_mime_type = str(getattr(image_file, 'mimetype', '') or '').strip().lower()
                if image_mime_type and image_mime_type not in app_ctx.ALLOWED_TOOLS_IMAGE_MIME_TYPES:
                    return None, tuple(staged_paths), (), ('Unsupported image content type for tools extraction.',), ()
                if not app_ctx.allowed_file(image_file.filename, app_ctx.ALLOWED_TOOLS_IMAGE_EXTENSIONS):
                    return None, tuple(staged_paths), (), ('Unsupported image file extension.',), ()
                staged_path, saved_size = _stage_uploaded_file(app_ctx, image_file, job_id=job_id, label='image', index=index + 1)
                staged_paths.append(staged_path)
                normalized_input_names.append(app_ctx.os.path.basename(staged_path))
                if saved_size <= 0 or saved_size > app_ctx.MAX_TOOLS_IMAGE_BYTES:
                    return None, tuple(staged_paths), (), (
                        f'Image exceeds size limit ({int(app_ctx.MAX_TOOLS_IMAGE_BYTES / (1024 * 1024))} MB max) or is empty.',
                    ), ()
                total_image_bytes += saved_size
            normalized_input_name = ', '.join(normalized_input_names)
            source_size_mb = round(total_image_bytes / (1024 * 1024), 4)
        else:
            staged_path, saved_size = _stage_uploaded_file(app_ctx, uploaded_file, job_id=job_id, label='document')
            staged_paths.append(staged_path)
            normalized_input_name = app_ctx.os.path.basename(staged_path)
            if saved_size <= 0 or saved_size > app_ctx.MAX_TOOLS_DOCUMENT_BYTES:
                return None, tuple(staged_paths), (), (
                    f'Document exceeds size limit ({int(app_ctx.MAX_TOOLS_DOCUMENT_BYTES / (1024 * 1024))} MB max) or is empty.',
                ), ()
            source_size_mb = round(saved_size / (1024 * 1024), 4)
            if extension == 'pdf':
                upload_mime_type = 'application/pdf'

    staged_input = _StagedToolInput(
        source_type=source_type,
        source_url=source_url,
        prompt_template_key=prompt_template_key,
        prompt_source=prompt_source,
        custom_prompt=custom_prompt,
        extension=extension,
        mime_type=mime_type,
        staged_paths=tuple(staged_paths),
        normalized_input_name=normalized_input_name or source_url,
        normalized_input_names=tuple(normalized_input_names),
        upload_mime_type=upload_mime_type,
        source_size_mb=source_size_mb,
    )
    return staged_input, tuple(staged_paths), (), (), ()


def _tools_job_payload(app_ctx, *, uid: str, email: str, staged_input: _StagedToolInput, deducted_credit: str) -> dict:
    return {
        'status': 'queued',
        'step': 0,
        'step_description': 'Queued…',
        'total_steps': 4,
        'mode': f'tools-{staged_input.source_type}',
        'job_scope': 'tools',
        'tool_source_type': staged_input.source_type,
        'tool_input_name': staged_input.normalized_input_name,
        'user_id': uid,
        'user_email': email,
        'credit_deducted': deducted_credit,
        'credit_refunded': False,
        'started_at': app_ctx.time.time(),
        'finished_at': 0,
        'result': None,
        'error': '',
        'failed_stage': '',
        'provider_error_code': '',
        'retry_attempts': 0,
        'billing_receipt': billing_receipts.initialize_billing_receipt({deducted_credit: 1}, runtime=app_ctx) if deducted_credit else {},
    }


def tools_extract(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Please sign in to continue'}), 401

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not _is_email_allowed(app_ctx, email):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403
    deletion_guard = upload_api_service._account_write_guard_response(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard

    allowed, retry_after = rate_limiter.check_rate_limit(
        key=f"tools_extract:{rate_limiter.normalize_rate_limit_key_part(uid, fallback='anon_uid', runtime=app_ctx)}",
        limit=app_ctx.TOOLS_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.TOOLS_RATE_LIMIT_WINDOW_SECONDS,
        runtime=app_ctx,
    )
    if not allowed:
        analytics_events.log_rate_limit_hit('tools', retry_after, runtime=app_ctx)
        return rate_limiter.build_rate_limited_response(
            'Too many tools extraction attempts right now. Please wait and try again.',
            retry_after,
            runtime=app_ctx,
        )

    user = app_ctx.get_or_create_user(uid, email)
    if int(user.get('slides_credits', 0) or 0) <= 0:
        return app_ctx.jsonify({'error': 'No text extraction credits remaining. Please purchase more credits.'}), 402

    job_id = str(app_ctx.uuid.uuid4())
    staged_input, cleanup_paths, url_error, detect_error, _unused = _stage_tools_request_inputs(app_ctx, request, job_id=job_id)
    if url_error:
        return app_ctx.jsonify({'error': url_error[1]}), 400
    if detect_error:
        app_ctx.cleanup_files(list(cleanup_paths or []), [])
        return app_ctx.jsonify({'error': detect_error[0]}), 400
    if staged_input is None:
        app_ctx.cleanup_files(list(cleanup_paths or []), [])
        return app_ctx.jsonify({'error': 'Could not prepare tools extraction input.'}), 400

    deducted_credit = billing_credits.deduct_credit(uid, 'slides_credits', runtime=app_ctx)
    if not deducted_credit:
        app_ctx.cleanup_files(list(cleanup_paths or []), [])
        return app_ctx.jsonify({'error': 'No text extraction credits remaining.'}), 402

    runtime_jobs_store.set_job(
        job_id,
        _tools_job_payload(
            app_ctx,
            uid=uid,
            email=email,
            staged_input=staged_input,
            deducted_credit=deducted_credit,
        ),
        runtime=app_ctx,
    )

    try:
        app_ctx.submit_background_job(
            _run_tools_extract_job,
            app_ctx,
            job_id,
            uid,
            email,
            staged_input,
            deducted_credit,
            int(user.get('slides_credits', 0) or 0),
        )
    except JobQueueFullError:
        return upload_api_service._handle_runtime_job_queue_full(
            app_ctx,
            job_id=job_id,
            uid=uid,
            cleanup_paths=list(cleanup_paths or []),
            credit_type=deducted_credit,
            expected_credit_floor=int(user.get('slides_credits', 0) or 0),
        )

    return app_ctx.jsonify({
        'ok': True,
        'job_id': job_id,
        'status': 'queued',
        'source_type': staged_input.source_type,
    }), 202


def _set_tools_job_progress(app_ctx, job_id: str, *, step: int, description: str, status: str = 'processing', **extra_fields):
    runtime_jobs_store.update_job_fields(
        job_id,
        runtime=app_ctx,
        status=status,
        step=int(step),
        step_description=str(description or '').strip(),
        **extra_fields,
    )


def _run_tools_extract_job(app_ctx, job_id: str, uid: str, email: str, staged_input: _StagedToolInput, deducted_credit: str, user_text_credits_before: int):
    retry_tracker = {}
    gemini_files = []
    local_paths = list(staged_input.staged_paths or [])
    refunded_credit = False
    provider_error_code = ''
    credit_refund_method = ''
    effective_prompt_preview = ''
    extracted_markdown = ''
    started_at_ts = app_ctx.time.time()
    source_size_mb = float(staged_input.source_size_mb or 0.0)
    normalized_input_name = staged_input.normalized_input_name

    try:
        _set_tools_job_progress(
            app_ctx,
            job_id,
            step=1,
            description='Preparing source…',
            started_at=started_at_ts,
            tool_source_type=staged_input.source_type,
            tool_input_name=normalized_input_name,
        )
        source_type = staged_input.source_type
        source_url = staged_input.source_url
        custom_prompt = staged_input.custom_prompt
        prompt_template_key = staged_input.prompt_template_key
        prompt_source = staged_input.prompt_source
        docx_text = ''
        upload_path = ''
        upload_mime_type = staged_input.upload_mime_type

        if source_type == 'url':
            _set_tools_job_progress(app_ctx, job_id, step=1, description='Reading webpage…')
            docx_text, source_error, upload_mime_type = upload_api_service._fetch_tools_url_text(source_url)
            if source_error:
                raise ValueError(source_error)
            source_size_mb = round(len(docx_text.encode('utf-8')) / (1024 * 1024), 4)
            normalized_input_name = source_url
        elif source_type == 'document':
            staged_path = local_paths[0] if local_paths else ''
            if staged_input.mime_type and staged_input.mime_type not in app_ctx.ALLOWED_TOOLS_DOC_MIME_TYPES:
                raise ValueError('Unsupported document content type for tools extraction.')
            if staged_input.extension == 'docx':
                _set_tools_job_progress(app_ctx, job_id, step=1, description='Reading document…')
                docx_text, docx_error = upload_api_service._extract_docx_text(app_ctx, staged_path)
                if docx_error:
                    raise ValueError(docx_error)
            else:
                _set_tools_job_progress(app_ctx, job_id, step=1, description='Converting slides…')
                upload_proxy = _SavedUploadFile(
                    app_ctx,
                    staged_path,
                    app_ctx.os.path.basename(staged_path),
                    staged_input.mime_type,
                )
                pdf_path, slides_error = app_ctx.resolve_uploaded_slides_to_pdf(upload_proxy, f'tools_{job_id}')
                if slides_error:
                    raise ValueError(slides_error)
                local_paths.append(pdf_path)
                upload_path = pdf_path
                upload_mime_type = 'application/pdf'
                normalized_input_name = app_ctx.os.path.basename(pdf_path)
                saved_size = int(app_ctx.get_saved_file_size(pdf_path) or 0)
                if saved_size <= 0 or saved_size > app_ctx.MAX_TOOLS_DOCUMENT_BYTES:
                    raise ValueError(
                        f'Document exceeds size limit ({int(app_ctx.MAX_TOOLS_DOCUMENT_BYTES / (1024 * 1024))} MB max) or is empty.'
                    )
                source_size_mb = round(saved_size / (1024 * 1024), 4)
        else:
            _set_tools_job_progress(app_ctx, job_id, step=1, description='Validating images…')
            total_image_bytes = 0
            for image_path in local_paths:
                saved_size = int(app_ctx.get_saved_file_size(image_path) or 0)
                if saved_size <= 0 or saved_size > app_ctx.MAX_TOOLS_IMAGE_BYTES:
                    raise ValueError(
                        f'Image exceeds size limit ({int(app_ctx.MAX_TOOLS_IMAGE_BYTES / (1024 * 1024))} MB max) or is empty.'
                    )
                total_image_bytes += saved_size
            source_size_mb = round(total_image_bytes / (1024 * 1024), 4)

        prompt = upload_api_service._build_tools_prompt(source_type, custom_prompt)
        effective_prompt_preview = prompt[:1400]

        if docx_text:
            _set_tools_job_progress(app_ctx, job_id, step=2, description='Preparing prompt…')
            if source_type == 'url':
                source_block_title = f"Source content extracted from URL ({source_url}):"
                operation_name = 'tools_extract_url'
            else:
                source_block_title = 'Source content extracted from DOCX:'
                operation_name = 'tools_extract_document_docx'
            _set_tools_job_progress(app_ctx, job_id, step=3, description='Generating output…')
            response = ai_provider.generate_with_policy(
                app_ctx.MODEL_TOOLS,
                [app_ctx.types.Content(role='user', parts=[
                    app_ctx.types.Part.from_text(text=prompt),
                    app_ctx.types.Part.from_text(text=f"{source_block_title}\n\n{docx_text}"),
                ])],
                max_output_tokens=32768,
                retry_tracker=retry_tracker,
                operation_name=operation_name,
                runtime=app_ctx,
            )
        else:
            if source_type == 'image':
                image_parts = []
                _set_tools_job_progress(app_ctx, job_id, step=2, description='Uploading images…')
                for index, image_path in enumerate(local_paths):
                    image_mime_type = app_ctx.get_mime_type(image_path) or 'image/jpeg'
                    uploaded_provider_file = ai_provider.run_with_provider_retry(
                        f'tools_image_upload_{index + 1}',
                        lambda p=image_path, m=image_mime_type: app_ctx.client.files.upload(file=p, config={'mime_type': m}),
                        retry_tracker=retry_tracker,
                        runtime=app_ctx,
                    )
                    gemini_files.append(uploaded_provider_file)
                    ai_provider.run_with_provider_retry(
                        f'tools_image_processing_{index + 1}',
                        lambda uploaded=uploaded_provider_file: app_ctx.wait_for_file_processing(uploaded),
                        retry_tracker=retry_tracker,
                        runtime=app_ctx,
                    )
                    image_parts.append(app_ctx.types.Part.from_uri(file_uri=uploaded_provider_file.uri, mime_type=image_mime_type))
                image_parts.append(app_ctx.types.Part.from_text(text=prompt))
                _set_tools_job_progress(app_ctx, job_id, step=3, description='Generating output…')
                response = ai_provider.generate_with_policy(
                    app_ctx.MODEL_TOOLS,
                    [app_ctx.types.Content(role='user', parts=image_parts)],
                    max_output_tokens=32768,
                    retry_tracker=retry_tracker,
                    operation_name='tools_extract_image',
                    runtime=app_ctx,
                )
            else:
                _set_tools_job_progress(app_ctx, job_id, step=2, description='Uploading document…')
                uploaded_provider_file = ai_provider.run_with_provider_retry(
                    'tools_file_upload',
                    lambda: app_ctx.client.files.upload(file=upload_path, config={'mime_type': upload_mime_type}),
                    retry_tracker=retry_tracker,
                    runtime=app_ctx,
                )
                gemini_files.append(uploaded_provider_file)
                ai_provider.run_with_provider_retry(
                    'tools_file_processing',
                    lambda: app_ctx.wait_for_file_processing(uploaded_provider_file),
                    retry_tracker=retry_tracker,
                    runtime=app_ctx,
                )
                _set_tools_job_progress(app_ctx, job_id, step=3, description='Generating output…')
                response = ai_provider.generate_with_policy(
                    app_ctx.MODEL_TOOLS,
                    [app_ctx.types.Content(role='user', parts=[
                        app_ctx.types.Part.from_uri(file_uri=uploaded_provider_file.uri, mime_type=upload_mime_type),
                        app_ctx.types.Part.from_text(text=prompt),
                    ])],
                    max_output_tokens=32768,
                    retry_tracker=retry_tracker,
                    operation_name=f'tools_extract_{source_type}',
                    runtime=app_ctx,
                )

        extracted_markdown = str(getattr(response, 'text', '') or '').strip()
        if not extracted_markdown:
            raise ValueError('Extraction returned empty output')

        usage = ai_provider.extract_token_usage(response, runtime=app_ctx)
        stage_usage = {
            **usage,
            'model': app_ctx.MODEL_TOOLS,
            'billing_mode': 'standard',
            'input_modality': 'text' if source_type in {'document', 'url'} else 'image',
        }
        retry_attempts_total = upload_api_service._sum_retry_attempts(retry_tracker)
        analytics_events.log_analytics_event(
            'tools_extract_completed',
            source='backend',
            uid=uid,
            email=email,
            session_id=job_id,
            properties={
                'source_type': source_type,
                'file_name': normalized_input_name,
                'custom_prompt': custom_prompt,
                'prompt_template_key': prompt_template_key,
                'prompt_source': prompt_source,
                'custom_prompt_length': len(custom_prompt),
                'source_url': source_url,
                'retry_attempts': retry_attempts_total,
                'input_tokens': int(usage.get('input_tokens', 0) or 0),
                'output_tokens': int(usage.get('output_tokens', 0) or 0),
            },
            runtime=app_ctx,
        )
        app_ctx.save_job_log(
            job_id,
            {
                'user_id': uid,
                'user_email': email,
                'mode': 'tools',
                'source_type': source_type,
                'source_url': source_url,
                'source_name': normalized_input_name,
                'status': 'complete',
                'credit_deducted': deducted_credit,
                'credit_refunded': False,
                'error': '',
                'failed_stage': '',
                'provider_error_code': '',
                'retry_attempts': retry_attempts_total,
                'token_usage_by_stage': {f'tools_extract_{source_type}': stage_usage},
                'billing_mode': 'standard',
                'token_input_total': int(usage.get('input_tokens', 0) or 0),
                'token_output_total': int(usage.get('output_tokens', 0) or 0),
                'token_total': int(usage.get('total_tokens', 0) or 0),
                'file_size_mb': source_size_mb,
                'custom_prompt': custom_prompt,
                'prompt_template_key': prompt_template_key,
                'prompt_source': prompt_source,
                'custom_prompt_length': len(custom_prompt),
                'effective_prompt_preview': effective_prompt_preview,
                'started_at': started_at_ts,
            },
            app_ctx.time.time(),
        )
        _set_tools_job_progress(
            app_ctx,
            job_id,
            step=4,
            description='Extraction complete.',
            status='complete',
            finished_at=app_ctx.time.time(),
            result=extracted_markdown,
            retry_attempts=retry_attempts_total,
            provider_error_code='',
            error='',
            failed_stage='',
            tool_source_type=source_type,
            tool_input_name=normalized_input_name,
            token_usage_by_stage={f'tools_extract_{source_type}': stage_usage},
            token_input_total=int(usage.get('input_tokens', 0) or 0),
            token_output_total=int(usage.get('output_tokens', 0) or 0),
            token_total=int(usage.get('total_tokens', 0) or 0),
            billing_receipt={
                'charged': {deducted_credit: 1},
                'refunded': {},
            },
        )
    except Exception as error:
        source_type = staged_input.source_type or 'unknown'
        provider_error_code = ai_provider.classify_provider_error_code(error, runtime=app_ctx)
        app_ctx.logger.exception("Tools extraction failed for user %s source=%s", uid, source_type)
        if deducted_credit and not refunded_credit:
            refunded_credit, credit_refund_method = upload_api_service._attempt_credit_refund(
                app_ctx,
                uid,
                deducted_credit,
                expected_floor=user_text_credits_before if deducted_credit == 'slides_credits' else None,
            )
        retry_attempts_total = upload_api_service._sum_retry_attempts(retry_tracker)
        analytics_events.log_analytics_event(
            'tools_extract_failed',
            source='backend',
            uid=uid,
            email=email,
            session_id=job_id,
            properties={
                'source_type': source_type,
                'provider_error_code': provider_error_code,
                'custom_prompt': staged_input.custom_prompt,
                'prompt_template_key': staged_input.prompt_template_key,
                'prompt_source': staged_input.prompt_source,
                'custom_prompt_length': len(staged_input.custom_prompt),
                'source_url': staged_input.source_url,
                'retry_attempts': retry_attempts_total,
                'credit_refund_method': credit_refund_method,
            },
            runtime=app_ctx,
        )
        app_ctx.save_job_log(
            job_id,
            {
                'user_id': uid,
                'user_email': email,
                'mode': 'tools',
                'source_type': source_type,
                'source_url': staged_input.source_url,
                'source_name': normalized_input_name,
                'status': 'error',
                'credit_deducted': deducted_credit,
                'credit_refunded': bool(refunded_credit),
                'error': str(error)[:1200],
                'failed_stage': 'tools_extract',
                'provider_error_code': provider_error_code,
                'retry_attempts': retry_attempts_total,
                'token_usage_by_stage': {},
                'billing_mode': 'standard',
                'token_input_total': 0,
                'token_output_total': 0,
                'token_total': 0,
                'file_size_mb': source_size_mb,
                'custom_prompt': staged_input.custom_prompt,
                'prompt_template_key': staged_input.prompt_template_key,
                'prompt_source': staged_input.prompt_source,
                'custom_prompt_length': len(staged_input.custom_prompt),
                'effective_prompt_preview': effective_prompt_preview,
                'credit_refund_method': credit_refund_method,
                'started_at': started_at_ts,
            },
            app_ctx.time.time(),
        )
        error_message = str(error or '').strip() or 'Tools extraction failed.'
        if refunded_credit:
            error_message = f'{error_message} Your text extraction credit has been refunded.'
        _set_tools_job_progress(
            app_ctx,
            job_id,
            step=4,
            description=error_message,
            status='error',
            finished_at=app_ctx.time.time(),
            error=error_message,
            failed_stage='tools_extract',
            provider_error_code=provider_error_code,
            retry_attempts=retry_attempts_total,
            credit_refunded=bool(refunded_credit),
            billing_receipt={
                'charged': {deducted_credit: 1} if deducted_credit else {},
                'refunded': {deducted_credit: 1} if (deducted_credit and refunded_credit) else {},
            },
        )
    finally:
        if local_paths or gemini_files:
            app_ctx.cleanup_files(local_paths, gemini_files)
