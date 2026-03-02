"""Business logic handlers for upload/status/download APIs."""


def import_audio_from_url(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Please sign in to continue'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not app_ctx.is_email_allowed(email):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403

    allowed_import, retry_after = app_ctx.check_rate_limit(
        key=f"audio_import:{app_ctx.normalize_rate_limit_key_part(uid, fallback='anon_uid')}",
        limit=app_ctx.VIDEO_IMPORT_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.VIDEO_IMPORT_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allowed_import:
        return app_ctx.build_rate_limited_response(
            'Too many video import attempts right now. Please wait and try again.',
            retry_after,
        )

    data = request.get_json(silent=True) or {}
    safe_url, error_message = app_ctx.validate_video_import_url(data.get('url', ''))
    if not safe_url:
        return app_ctx.jsonify({'error': error_message}), 400

    app_ctx.cleanup_expired_audio_import_tokens()
    prefix = f"urlimport_{app_ctx.uuid.uuid4().hex}"
    try:
        audio_path, output_name, size_bytes = app_ctx.download_audio_from_video_url(safe_url, prefix)
        token = app_ctx.register_audio_import_token(uid, audio_path, safe_url, output_name)
        return app_ctx.jsonify({
            'ok': True,
            'audio_import_token': token,
            'file_name': output_name,
            'size_bytes': int(size_bytes),
            'expires_in_seconds': app_ctx.AUDIO_IMPORT_TOKEN_TTL_SECONDS,
        })
    except Exception as e:
        app_ctx.logger.error(f"Error importing audio from URL for user {uid}: {e}")
        return app_ctx.jsonify({'error': 'Could not import audio from URL. Please check that the URL is accessible and try again.'}), 400


def release_imported_audio(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    payload = request.get_json(silent=True) or {}
    token = str(payload.get('audio_import_token', '') or '').strip()
    if token:
        app_ctx.release_audio_import_token(uid, token)
    return app_ctx.jsonify({'ok': True})


def upload_files(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Please sign in to continue'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not app_ctx.is_email_allowed(email):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403
    active_jobs = app_ctx.count_active_jobs_for_user(uid)
    if active_jobs >= app_ctx.MAX_ACTIVE_JOBS_PER_USER:
        app_ctx.log_rate_limit_hit('upload', 10)
        return app_ctx.jsonify({
            'error': f'You already have {active_jobs} active processing job(s). Please wait for one to finish before starting another.'
        }), 429
    allowed_upload, retry_after = app_ctx.check_rate_limit(
        key=f"upload:{uid}",
        limit=app_ctx.UPLOAD_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.UPLOAD_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allowed_upload:
        app_ctx.log_rate_limit_hit('upload', retry_after)
        return app_ctx.build_rate_limited_response(
            'Too many upload attempts right now. Please wait and try again.',
            retry_after,
        )
    requested_bytes = int(request.content_length or 0)
    disk_ok, free_bytes, needed_bytes = app_ctx.has_sufficient_upload_disk_space(requested_bytes)
    if not disk_ok:
        app_ctx.logger.warning(
            "Upload rejected due to low disk space: free=%s needed=%s uid=%s",
            free_bytes,
            needed_bytes,
            uid,
        )
        return app_ctx.jsonify({
            'error': 'Upload temporarily unavailable due to low server storage. Please try again later.'
        }), 503
    reserved_daily, daily_retry_after = app_ctx.reserve_daily_upload_bytes(uid, requested_bytes)
    if not reserved_daily:
        app_ctx.log_rate_limit_hit('upload', daily_retry_after)
        return app_ctx.build_rate_limited_response(
            'Daily upload quota reached for your account. Please try again tomorrow.',
            daily_retry_after,
        )
    user = app_ctx.get_or_create_user(uid, email)
    mode = request.form.get('mode', 'lecture-notes')
    flashcard_selection = app_ctx.parse_requested_amount(request.form.get('flashcard_amount', '20'), {'10', '20', '30', 'auto'}, '20')
    question_selection = app_ctx.parse_requested_amount(request.form.get('question_amount', '10'), {'5', '10', '15', 'auto'}, '10')
    preferred_language_key = app_ctx.sanitize_output_language_pref_key(user.get('preferred_output_language', app_ctx.DEFAULT_OUTPUT_LANGUAGE_KEY))
    preferred_language_custom = app_ctx.sanitize_output_language_pref_custom(user.get('preferred_output_language_custom', ''))
    output_language = app_ctx.parse_output_language(
        request.form.get('output_language', preferred_language_key),
        request.form.get('output_language_custom', preferred_language_custom),
    )
    study_features = app_ctx.parse_study_features(request.form.get('study_features', 'none'))
    interview_features = app_ctx.parse_interview_features(request.form.get('interview_features', 'none'))
    audio_import_token = str(request.form.get('audio_import_token', '') or '').strip()
    app_ctx.cleanup_expired_audio_import_tokens()
    if request.content_length and request.content_length > app_ctx.MAX_CONTENT_LENGTH:
        return app_ctx.jsonify({'error': 'Upload too large. Maximum total upload size is 560MB (up to 50MB slides file (PDF/PPTX) and 500MB audio).'}), 413

    if mode == 'lecture-notes':
        total_lecture = user.get('lecture_credits_standard', 0) + user.get('lecture_credits_extended', 0)
        if total_lecture <= 0:
            return app_ctx.jsonify({'error': 'No lecture credits remaining. Please purchase more credits.'}), 402
        if 'pdf' not in request.files:
            return app_ctx.jsonify({'error': 'Both slides (PDF/PPTX) and audio files are required'}), 400
        slides_file = request.files['pdf']
        uploaded_audio_file = request.files.get('audio')
        has_uploaded_audio = bool(uploaded_audio_file and uploaded_audio_file.filename)
        has_imported_audio = bool(audio_import_token)
        if not has_uploaded_audio and not has_imported_audio:
            return app_ctx.jsonify({'error': 'Both slides (PDF/PPTX) and audio files are required'}), 400
        if slides_file.filename == '':
            return app_ctx.jsonify({'error': 'Both files must be selected'}), 400
        job_id = str(app_ctx.uuid.uuid4())
        pdf_path, slides_error = app_ctx.resolve_uploaded_slides_to_pdf(slides_file, job_id)
        if slides_error:
            return app_ctx.jsonify({'error': slides_error}), 400

        imported_audio_used = False
        audio_path = ''
        if has_uploaded_audio:
            if not app_ctx.allowed_file(uploaded_audio_file.filename, app_ctx.ALLOWED_AUDIO_EXTENSIONS):
                app_ctx.cleanup_files([pdf_path], [])
                return app_ctx.jsonify({'error': 'Invalid audio file'}), 400
            if (uploaded_audio_file.mimetype or '').lower() not in app_ctx.ALLOWED_AUDIO_MIME_TYPES:
                app_ctx.cleanup_files([pdf_path], [])
                return app_ctx.jsonify({'error': 'Invalid audio content type'}), 400
            audio_path = app_ctx.os.path.join(app_ctx.UPLOAD_FOLDER, f"{job_id}_{app_ctx.secure_filename(uploaded_audio_file.filename)}")
            uploaded_audio_file.save(audio_path)
            if has_imported_audio:
                app_ctx.release_audio_import_token(uid, audio_import_token)
        else:
            audio_path, token_error = app_ctx.get_audio_import_token_path(uid, audio_import_token, consume=False)
            if token_error:
                app_ctx.cleanup_files([pdf_path], [])
                return app_ctx.jsonify({'error': token_error}), 400
            imported_audio_used = True

        audio_size = app_ctx.get_saved_file_size(audio_path)
        if audio_size <= 0 or audio_size > app_ctx.MAX_AUDIO_UPLOAD_BYTES:
            app_ctx.cleanup_files([pdf_path, audio_path], [])
            return app_ctx.jsonify({'error': 'Audio exceeds server limit (max 500MB) or is empty.'}), 400
        if not app_ctx.file_looks_like_audio(audio_path):
            app_ctx.cleanup_files([pdf_path, audio_path], [])
            return app_ctx.jsonify({'error': 'Uploaded audio file is invalid or unsupported.'}), 400
        deducted = app_ctx.deduct_credit(uid, 'lecture_credits_standard', 'lecture_credits_extended')
        if not deducted:
            app_ctx.cleanup_files([pdf_path, audio_path], [])
            return app_ctx.jsonify({'error': 'No lecture credits remaining.'}), 402
        if imported_audio_used:
            _consumed_path, token_error = app_ctx.get_audio_import_token_path(uid, audio_import_token, consume=True)
            if token_error:
                app_ctx.cleanup_files([pdf_path, audio_path], [])
                app_ctx.refund_credit(uid, deducted)
                return app_ctx.jsonify({'error': token_error}), 400
        total_steps = 4 if study_features != 'none' else 3
        app_ctx.set_job(job_id, {'status': 'starting', 'step': 0, 'step_description': 'Starting...', 'total_steps': total_steps, 'mode': 'lecture-notes', 'user_id': uid, 'user_email': email, 'credit_deducted': deducted, 'credit_refunded': False, 'started_at': app_ctx.time.time(), 'result': None, 'slide_text': None, 'transcript': None, 'flashcard_selection': flashcard_selection, 'question_selection': question_selection, 'study_features': study_features, 'output_language': output_language, 'flashcards': [], 'test_questions': [], 'study_generation_error': None, 'study_pack_id': None, 'error': None, 'billing_receipt': app_ctx.initialize_billing_receipt({deducted: 1})})
        thread = app_ctx.threading.Thread(target=app_ctx.process_lecture_notes, args=(job_id, pdf_path, audio_path))
        thread.start()

    elif mode == 'slides-only':
        if user.get('slides_credits', 0) <= 0:
            return app_ctx.jsonify({'error': 'No slides credits remaining. Please purchase more credits.'}), 402
        if 'pdf' not in request.files:
            return app_ctx.jsonify({'error': 'Slide file (PDF or PPTX) is required'}), 400
        slides_file = request.files['pdf']
        if slides_file.filename == '':
            return app_ctx.jsonify({'error': 'Slide file must be selected'}), 400
        job_id = str(app_ctx.uuid.uuid4())
        pdf_path, slides_error = app_ctx.resolve_uploaded_slides_to_pdf(slides_file, job_id)
        if slides_error:
            return app_ctx.jsonify({'error': slides_error}), 400
        deducted = app_ctx.deduct_credit(uid, 'slides_credits')
        if not deducted:
            app_ctx.cleanup_files([pdf_path], [])
            return app_ctx.jsonify({'error': 'No slides credits remaining.'}), 402
        total_steps = 2 if study_features != 'none' else 1
        app_ctx.set_job(job_id, {'status': 'starting', 'step': 0, 'step_description': 'Starting...', 'total_steps': total_steps, 'mode': 'slides-only', 'user_id': uid, 'user_email': email, 'credit_deducted': deducted, 'credit_refunded': False, 'started_at': app_ctx.time.time(), 'result': None, 'flashcard_selection': flashcard_selection, 'question_selection': question_selection, 'study_features': study_features, 'output_language': output_language, 'flashcards': [], 'test_questions': [], 'study_generation_error': None, 'study_pack_id': None, 'error': None, 'billing_receipt': app_ctx.initialize_billing_receipt({deducted: 1})})
        thread = app_ctx.threading.Thread(target=app_ctx.process_slides_only, args=(job_id, pdf_path))
        thread.start()

    elif mode == 'interview':
        total_interview = user.get('interview_credits_short', 0) + user.get('interview_credits_medium', 0) + user.get('interview_credits_long', 0)
        if total_interview <= 0:
            return app_ctx.jsonify({'error': 'No interview credits remaining. Please purchase more credits.'}), 402
        uploaded_audio_file = request.files.get('audio')
        has_uploaded_audio = bool(uploaded_audio_file and uploaded_audio_file.filename)
        has_imported_audio = bool(audio_import_token)
        if not has_uploaded_audio and not has_imported_audio:
            return app_ctx.jsonify({'error': 'Audio file is required'}), 400
        job_id = str(app_ctx.uuid.uuid4())
        imported_audio_used = False
        if has_uploaded_audio:
            if not app_ctx.allowed_file(uploaded_audio_file.filename, app_ctx.ALLOWED_AUDIO_EXTENSIONS):
                return app_ctx.jsonify({'error': 'Invalid audio file'}), 400
            if (uploaded_audio_file.mimetype or '').lower() not in app_ctx.ALLOWED_AUDIO_MIME_TYPES:
                return app_ctx.jsonify({'error': 'Invalid audio content type'}), 400
            audio_path = app_ctx.os.path.join(app_ctx.UPLOAD_FOLDER, f"{job_id}_{app_ctx.secure_filename(uploaded_audio_file.filename)}")
            uploaded_audio_file.save(audio_path)
            if has_imported_audio:
                app_ctx.release_audio_import_token(uid, audio_import_token)
        else:
            audio_path, token_error = app_ctx.get_audio_import_token_path(uid, audio_import_token, consume=False)
            if token_error:
                return app_ctx.jsonify({'error': token_error}), 400
            imported_audio_used = True

        audio_size = app_ctx.get_saved_file_size(audio_path)
        if audio_size <= 0 or audio_size > app_ctx.MAX_AUDIO_UPLOAD_BYTES:
            app_ctx.cleanup_files([audio_path], [])
            return app_ctx.jsonify({'error': 'Audio exceeds server limit (max 500MB) or is empty.'}), 400
        if not app_ctx.file_looks_like_audio(audio_path):
            app_ctx.cleanup_files([audio_path], [])
            return app_ctx.jsonify({'error': 'Uploaded audio file is invalid or unsupported.'}), 400
        deducted = app_ctx.deduct_interview_credit(uid)
        if not deducted:
            app_ctx.cleanup_files([audio_path], [])
            return app_ctx.jsonify({'error': 'No interview credits remaining.'}), 402
        interview_features_cost = len(interview_features)
        if interview_features_cost > 0:
            if user.get('slides_credits', 0) < interview_features_cost:
                app_ctx.refund_credit(uid, deducted)
                app_ctx.cleanup_files([audio_path], [])
                return app_ctx.jsonify({'error': f'Not enough slides credits for interview extras. You selected {interview_features_cost} option(s) and need {interview_features_cost} slides credits.'}), 402
            if not app_ctx.deduct_slides_credits(uid, interview_features_cost):
                app_ctx.refund_credit(uid, deducted)
                app_ctx.cleanup_files([audio_path], [])
                return app_ctx.jsonify({'error': 'Could not reserve slides credits for interview extras. Please try again.'}), 402
        if imported_audio_used:
            _consumed_path, token_error = app_ctx.get_audio_import_token_path(uid, audio_import_token, consume=True)
            if token_error:
                app_ctx.cleanup_files([audio_path], [])
                app_ctx.refund_credit(uid, deducted)
                if interview_features_cost > 0:
                    app_ctx.refund_slides_credits(uid, interview_features_cost)
                return app_ctx.jsonify({'error': token_error}), 400
        total_steps = 2 if interview_features_cost > 0 else 1
        app_ctx.set_job(job_id, {
            'status': 'starting',
            'step': 0,
            'step_description': 'Starting...',
            'total_steps': total_steps,
            'mode': 'interview',
            'user_id': uid,
            'user_email': email,
            'credit_deducted': deducted,
            'credit_refunded': False,
            'started_at': app_ctx.time.time(),
            'result': None,
            'transcript': None,
            'flashcards': [],
            'test_questions': [],
            'study_features': 'none',
            'output_language': output_language,
            'interview_features': interview_features,
            'interview_features_cost': interview_features_cost,
            'interview_features_successful': [],
            'interview_summary': None,
            'interview_sections': None,
            'interview_combined': None,
            'extra_slides_refunded': 0,
            'study_generation_error': None,
            'error': None,
            'billing_receipt': app_ctx.initialize_billing_receipt({deducted: 1, 'slides_credits': interview_features_cost}),
        })
        thread = app_ctx.threading.Thread(target=app_ctx.process_interview_transcription, args=(job_id, audio_path))
        thread.start()
    else:
        return app_ctx.jsonify({'error': 'Invalid mode selected'}), 400

    created_job = app_ctx.get_job_snapshot(job_id) or {}
    app_ctx.log_analytics_event(
        'processing_started_backend',
        source='backend',
        uid=uid,
        email=email,
        session_id=job_id,
        properties={
            'job_id': job_id,
            'mode': created_job.get('mode', mode),
            'study_features': created_job.get('study_features', 'none'),
            'interview_features_count': len(created_job.get('interview_features', [])) if isinstance(created_job.get('interview_features'), list) else 0,
        },
        created_at=created_job.get('started_at', app_ctx.time.time()),
    )

    return app_ctx.jsonify({'job_id': job_id})


def get_status(app_ctx, request, job_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    job = app_ctx.get_job_snapshot(job_id)
    if not job:
        app_ctx.cleanup_old_jobs()
        job = app_ctx.get_job_snapshot(job_id)
        if not job:
            return app_ctx.jsonify({
                'error': 'Job not found. It may have expired after a server update. Please re-upload your file to try again.',
                'job_lost': True,
            }), 404
    if job.get('user_id', '') != uid and not app_ctx.is_admin_user(decoded_token):
        return app_ctx.jsonify({'error': 'Forbidden'}), 403
    response = {'status': job['status'], 'step': job['step'], 'step_description': job['step_description'], 'total_steps': job.get('total_steps', 3), 'mode': job.get('mode', 'lecture-notes')}
    billing_receipt = app_ctx.get_billing_receipt_snapshot(job)
    if billing_receipt.get('charged') or billing_receipt.get('refunded'):
        response['billing_receipt'] = billing_receipt
    if job['status'] == 'complete':
        response['result'] = job['result']
        response['flashcards'] = job.get('flashcards', [])
        response['test_questions'] = job.get('test_questions', [])
        response['study_generation_error'] = job.get('study_generation_error')
        response['study_pack_id'] = job.get('study_pack_id')
        response['study_features'] = job.get('study_features', 'none')
        response['output_language'] = job.get('output_language', 'English')
        response['interview_features'] = job.get('interview_features', [])
        response['interview_features_successful'] = job.get('interview_features_successful', [])
        response['interview_summary'] = job.get('interview_summary')
        response['interview_sections'] = job.get('interview_sections')
        response['interview_combined'] = job.get('interview_combined')
        if job.get('mode') == 'lecture-notes':
            response['slide_text'] = job.get('slide_text')
            response['transcript'] = job.get('transcript')
        if job.get('mode') == 'interview':
            response['transcript'] = job.get('transcript')
    elif job['status'] == 'error':
        response['error'] = job['error']
        response['credit_refunded'] = job.get('credit_refunded', False)
    return app_ctx.jsonify(response)


def download_docx(app_ctx, request, job_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    job = app_ctx.get_job_snapshot(job_id)
    if not job:
        return app_ctx.jsonify({'error': 'Job not found'}), 404
    if job.get('user_id', '') != uid and not app_ctx.is_admin_user(decoded_token):
        return app_ctx.jsonify({'error': 'Forbidden'}), 403
    if job['status'] != 'complete':
        return app_ctx.jsonify({'error': 'Job not complete'}), 400
    content_type = request.args.get('type', 'result')
    allowed_content_types = {'result', 'slides', 'transcript', 'summary', 'sections', 'combined'}
    if content_type not in allowed_content_types:
        content_type = 'result'

    if content_type == 'slides' and job.get('slide_text'):
        content, filename, title = job['slide_text'], 'slide-extract.docx', 'Slide Extract'
    elif content_type == 'transcript' and job.get('transcript'):
        content, filename, title = job['transcript'], 'lecture-transcript.docx', 'Lecture Transcript'
    elif content_type == 'summary' and job.get('interview_summary'):
        content, filename, title = job['interview_summary'], 'interview-summary.docx', 'Interview Summary'
    elif content_type == 'sections' and job.get('interview_sections'):
        content, filename, title = job['interview_sections'], 'interview-structured.docx', 'Structured Interview Transcript'
    elif content_type == 'combined' and job.get('interview_combined'):
        content, filename, title = job['interview_combined'], 'interview-summary-structured.docx', 'Interview Summary + Structured Transcript'
    else:
        content = job['result']
        mode = job.get('mode', 'lecture-notes')
        if mode == 'lecture-notes':
            filename, title = 'lecture-notes.docx', 'Lecture Notes'
        elif mode == 'slides-only':
            filename, title = 'slide-extract.docx', 'Slide Extract'
        else:
            filename, title = 'interview-transcript.docx', 'Interview Transcript'

    doc = app_ctx.markdown_to_docx(content, title)
    docx_io = app_ctx.io.BytesIO()
    doc.save(docx_io)
    docx_io.seek(0)
    return app_ctx.send_file(
        docx_io,
        mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        as_attachment=True,
        download_name=filename,
    )


def download_flashcards_csv(app_ctx, request, job_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    job = app_ctx.get_job_snapshot(job_id)
    if not job:
        return app_ctx.jsonify({'error': 'Job not found'}), 404
    if job.get('user_id', '') != uid and not app_ctx.is_admin_user(decoded_token):
        return app_ctx.jsonify({'error': 'Forbidden'}), 403
    if job.get('status') != 'complete':
        return app_ctx.jsonify({'error': 'Job not complete'}), 400
    export_type = request.args.get('type', 'flashcards').strip().lower()

    output = app_ctx.io.StringIO()
    writer = app_ctx.csv.writer(output)
    if export_type == 'test':
        test_questions = job.get('test_questions', [])
        if not test_questions:
            return app_ctx.jsonify({'error': 'No practice questions available for this job'}), 400
        writer.writerow(['question', 'option_a', 'option_b', 'option_c', 'option_d', 'answer', 'explanation'])
        for q in test_questions:
            options = q.get('options', [])
            padded = (options + ['', '', '', ''])[:4]
            writer.writerow([
                q.get('question', ''),
                padded[0],
                padded[1],
                padded[2],
                padded[3],
                q.get('answer', ''),
                q.get('explanation', ''),
            ])
        filename = f'practice-test-{job_id}.csv'
    else:
        flashcards = job.get('flashcards', [])
        if not flashcards:
            return app_ctx.jsonify({'error': 'No flashcards available for this job'}), 400
        writer.writerow(['question', 'answer'])
        for card in flashcards:
            writer.writerow([card.get('front', ''), card.get('back', '')])
        filename = f'flashcards-{job_id}.csv'

    csv_bytes = app_ctx.io.BytesIO(output.getvalue().encode('utf-8'))
    csv_bytes.seek(0)
    return app_ctx.send_file(csv_bytes, mimetype='text/csv', as_attachment=True, download_name=filename)
