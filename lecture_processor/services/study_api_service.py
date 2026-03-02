"""Business logic handlers for study APIs."""


def get_study_progress(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        progress_doc = app_ctx.get_study_progress_doc(uid).get()
        progress_data = progress_doc.to_dict() if progress_doc.exists else {}
        daily_goal = app_ctx.sanitize_daily_goal_value(progress_data.get('daily_goal'))
        if daily_goal is None:
            daily_goal = 20
        streak_data = app_ctx.sanitize_streak_data(progress_data.get('streak_data', {}))
        timezone = str(progress_data.get('timezone', '') or '').strip()[:80]

        card_states = {}
        card_state_maps = []
        docs = app_ctx.study_repo.list_study_card_states_by_uid(app_ctx.db, uid, app_ctx.MAX_PROGRESS_PACKS_PER_SYNC)
        for doc in docs:
            data = doc.to_dict() or {}
            pack_id = app_ctx.sanitize_pack_id(data.get('pack_id', ''))
            if not pack_id:
                continue
            state_map = app_ctx.sanitize_card_state_map(data.get('state', {}))
            card_states[pack_id] = state_map
            card_state_maps.append(state_map)

        return app_ctx.jsonify({
            'daily_goal': daily_goal,
            'streak_data': streak_data,
            'timezone': app_ctx.sanitize_timezone_name(timezone),
            'card_states': card_states,
            'summary': app_ctx.compute_study_progress_summary(progress_data, card_state_maps),
        })
    except Exception as e:
        app_ctx.logger.error(f"Error fetching study progress for user {uid}: {e}")
        return app_ctx.jsonify({'error': 'Could not load study progress'}), 500


def update_study_progress(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return app_ctx.jsonify({'error': 'Invalid payload'}), 400

    try:
        existing_progress_doc = app_ctx.get_study_progress_doc(uid).get()
        existing_progress_data = existing_progress_doc.to_dict() if existing_progress_doc.exists else {}
        updates = {
            'uid': uid,
            'updated_at': app_ctx.time.time(),
        }

        if 'daily_goal' in payload:
            daily_goal = app_ctx.sanitize_daily_goal_value(payload.get('daily_goal'))
            if daily_goal is None:
                return app_ctx.jsonify({'error': 'daily_goal must be between 1 and 500'}), 400
            updates['daily_goal'] = daily_goal

        if 'streak_data' in payload:
            updates['streak_data'] = app_ctx.merge_streak_data(existing_progress_data.get('streak_data', {}), payload.get('streak_data'))

        if 'timezone' in payload:
            updates['timezone'] = app_ctx.merge_timezone_value(existing_progress_data.get('timezone', ''), payload.get('timezone', ''))

        app_ctx.get_study_progress_doc(uid).set(updates, merge=True)

        card_states = payload.get('card_states')
        if card_states is not None:
            if not isinstance(card_states, dict):
                return app_ctx.jsonify({'error': 'card_states must be an object'}), 400
            processed = 0
            for raw_pack_id, raw_state in card_states.items():
                if processed >= app_ctx.MAX_PROGRESS_PACKS_PER_SYNC:
                    break
                pack_id = app_ctx.sanitize_pack_id(raw_pack_id)
                if not pack_id:
                    continue
                cleaned_state = app_ctx.sanitize_card_state_map(raw_state)
                doc_ref = app_ctx.get_study_card_state_doc(uid, pack_id)
                if cleaned_state:
                    existing_pack_doc = doc_ref.get()
                    existing_pack_state = {}
                    if existing_pack_doc.exists:
                        existing_pack_data = existing_pack_doc.to_dict() or {}
                        existing_pack_state = app_ctx.sanitize_card_state_map(existing_pack_data.get('state', {}))
                    merged_state = app_ctx.merge_card_state_maps(existing_pack_state, cleaned_state)
                    doc_ref.set({
                        'uid': uid,
                        'pack_id': pack_id,
                        'state': merged_state,
                        'updated_at': app_ctx.time.time(),
                    }, merge=True)
                processed += 1

        remove_pack_ids = payload.get('remove_pack_ids')
        if remove_pack_ids is not None:
            if not isinstance(remove_pack_ids, list):
                return app_ctx.jsonify({'error': 'remove_pack_ids must be a list'}), 400
            for raw_pack_id in remove_pack_ids[:app_ctx.MAX_PROGRESS_PACKS_PER_SYNC]:
                pack_id = app_ctx.sanitize_pack_id(raw_pack_id)
                if not pack_id:
                    continue
                try:
                    app_ctx.get_study_card_state_doc(uid, pack_id).delete()
                except Exception as delete_error:
                    app_ctx.logger.warning(f"Warning: failed deleting study progress state for {uid}/{pack_id}: {delete_error}")

        return app_ctx.jsonify({'ok': True})
    except Exception as e:
        app_ctx.logger.error(f"Error updating study progress for user {uid}: {e}")
        return app_ctx.jsonify({'error': 'Could not save study progress'}), 500


def get_study_progress_summary(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        progress_doc = app_ctx.get_study_progress_doc(uid).get()
        progress_data = progress_doc.to_dict() if progress_doc.exists else {}
        card_state_maps = []
        docs = app_ctx.study_repo.list_study_card_states_by_uid(app_ctx.db, uid, app_ctx.MAX_PROGRESS_PACKS_PER_SYNC)
        for doc in docs:
            data = doc.to_dict() or {}
            card_state_maps.append(app_ctx.sanitize_card_state_map(data.get('state', {})))

        return app_ctx.jsonify(app_ctx.compute_study_progress_summary(progress_data, card_state_maps))
    except Exception as e:
        app_ctx.logger.error(f"Error fetching study progress summary for user {uid}: {e}")
        return app_ctx.jsonify({'error': 'Could not load study progress summary'}), 500


def get_study_packs(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    try:
        study_docs = app_ctx.study_repo.list_study_packs_by_uid(app_ctx.db, uid, 200)
        packs = []
        for doc in study_docs:
            pack = doc.to_dict()
            packs.append({
                'study_pack_id': doc.id,
                'title': pack.get('title', ''),
                'mode': pack.get('mode', ''),
                'flashcards_count': len(pack.get('flashcards', [])),
                'test_questions_count': len(pack.get('test_questions', [])),
                'course': pack.get('course', ''),
                'subject': pack.get('subject', ''),
                'semester': pack.get('semester', ''),
                'block': pack.get('block', ''),
                'folder_id': pack.get('folder_id', ''),
                'folder_name': pack.get('folder_name', ''),
                'created_at': pack.get('created_at', 0),
            })
        packs.sort(key=lambda p: p.get('created_at', 0), reverse=True)
        return app_ctx.jsonify({'study_packs': packs[:50]})
    except Exception as e:
        app_ctx.logger.error(f"Error fetching study packs: {e}")
        return app_ctx.jsonify({'error': 'Could not load study packs'}), 500


def create_study_pack(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    payload = request.get_json() or {}

    title = str(payload.get('title', '')).strip()[:120]
    if not title:
        title = f"Untitled pack {app_ctx.datetime.now(app_ctx.timezone.utc).strftime('%Y-%m-%d %H:%M')}"

    try:
        now_ts = app_ctx.time.time()
        folder_id = str(payload.get('folder_id', '')).strip()
        folder_name = ''
        if folder_id:
            folder_doc = app_ctx.study_repo.get_study_folder_doc(app_ctx.db, folder_id)
            if not folder_doc.exists:
                return app_ctx.jsonify({'error': 'Folder not found'}), 404
            folder_data = folder_doc.to_dict()
            if folder_data.get('uid', '') != uid:
                return app_ctx.jsonify({'error': 'Forbidden'}), 403
            folder_name = folder_data.get('name', '')
        else:
            folder_id = ''

        flashcards = app_ctx.sanitize_flashcards(payload.get('flashcards', []), 500)
        test_questions = app_ctx.sanitize_questions(payload.get('test_questions', []), 500)
        notes_markdown = str(payload.get('notes_markdown', '')).strip()[:180000]
        notes_audio_map = app_ctx.parse_audio_markers_from_notes(notes_markdown) if app_ctx.FEATURE_AUDIO_SECTION_SYNC else []

        doc_ref = app_ctx.study_repo.create_study_pack_doc_ref(app_ctx.db)
        doc_ref.set({
            'study_pack_id': doc_ref.id,
            'source_job_id': '',
            'uid': uid,
            'mode': 'manual',
            'title': title,
            'output_language': str(payload.get('output_language', 'English')).strip()[:64] or 'English',
            'notes_markdown': notes_markdown,
            'notes_truncated': False,
            'transcript_segments': [],
            'notes_audio_map': notes_audio_map,
            'audio_storage_key': '',
            'has_audio_sync': False,
            'has_audio_playback': False,
            'flashcards': flashcards,
            'test_questions': test_questions,
            'flashcard_selection': 'manual',
            'question_selection': 'manual',
            'study_features': 'both',
            'interview_features': [],
            'interview_summary': None,
            'interview_sections': None,
            'interview_combined': None,
            'study_generation_error': None,
            'course': str(payload.get('course', '')).strip()[:120],
            'subject': str(payload.get('subject', '')).strip()[:120],
            'semester': str(payload.get('semester', '')).strip()[:120],
            'block': str(payload.get('block', '')).strip()[:120],
            'folder_id': folder_id,
            'folder_name': folder_name,
            'created_at': now_ts,
            'updated_at': now_ts,
        })

        return app_ctx.jsonify({'ok': True, 'study_pack_id': doc_ref.id})
    except Exception as e:
        app_ctx.logger.error(f"Error creating study pack: {e}")
        return app_ctx.jsonify({'error': 'Could not create study pack'}), 500


def get_study_pack(app_ctx, request, pack_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    try:
        doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict() or {}
        if pack.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403
        app_ctx.ensure_pack_audio_storage_key(doc.reference, pack)
        has_audio_playback = bool(pack.get('has_audio_playback', False) or app_ctx.get_audio_storage_key_from_pack(pack))
        has_audio_sync = app_ctx.FEATURE_AUDIO_SECTION_SYNC and bool(pack.get('has_audio_sync', False))
        notes_audio_map = pack.get('notes_audio_map', []) if has_audio_sync else []
        return app_ctx.jsonify({
            'study_pack_id': pack_id,
            'title': pack.get('title', ''),
            'mode': pack.get('mode', ''),
            'output_language': pack.get('output_language', 'English'),
            'notes_markdown': pack.get('notes_markdown', ''),
            'transcript_segments': pack.get('transcript_segments', []),
            'notes_audio_map': notes_audio_map,
            'has_audio_sync': has_audio_sync,
            'has_audio_playback': has_audio_playback,
            'flashcards': pack.get('flashcards', []),
            'test_questions': pack.get('test_questions', []),
            'interview_summary': pack.get('interview_summary'),
            'interview_sections': pack.get('interview_sections'),
            'interview_combined': pack.get('interview_combined'),
            'study_features': pack.get('study_features', 'none'),
            'interview_features': pack.get('interview_features', []),
            'course': pack.get('course', ''),
            'subject': pack.get('subject', ''),
            'semester': pack.get('semester', ''),
            'block': pack.get('block', ''),
            'folder_id': pack.get('folder_id', ''),
            'folder_name': pack.get('folder_name', ''),
            'created_at': pack.get('created_at', 0),
        })
    except Exception as e:
        app_ctx.logger.error(f"Error fetching study pack {pack_id}: {e}")
        return app_ctx.jsonify({'error': 'Could not fetch study pack'}), 500


def update_study_pack(app_ctx, request, pack_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    payload = request.get_json() or {}

    try:
        pack_ref = app_ctx.study_repo.study_pack_doc_ref(app_ctx.db, pack_id)
        doc = pack_ref.get()
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403
        app_ctx.ensure_pack_audio_storage_key(pack_ref, pack)

        updates = {'updated_at': app_ctx.time.time()}
        if 'title' in payload:
            updates['title'] = str(payload.get('title', '')).strip()[:120]
        if 'course' in payload:
            updates['course'] = str(payload.get('course', '')).strip()[:120]
        if 'subject' in payload:
            updates['subject'] = str(payload.get('subject', '')).strip()[:120]
        if 'semester' in payload:
            updates['semester'] = str(payload.get('semester', '')).strip()[:120]
        if 'block' in payload:
            updates['block'] = str(payload.get('block', '')).strip()[:120]
        if 'folder_id' in payload:
            folder_id = str(payload.get('folder_id', '')).strip()
            updates['folder_id'] = ''
            updates['folder_name'] = ''
            if folder_id:
                folder_doc = app_ctx.study_repo.get_study_folder_doc(app_ctx.db, folder_id)
                if not folder_doc.exists:
                    return app_ctx.jsonify({'error': 'Folder not found'}), 404
                folder_data = folder_doc.to_dict()
                if folder_data.get('uid', '') != uid:
                    return app_ctx.jsonify({'error': 'Forbidden'}), 403
                updates['folder_id'] = folder_id
                updates['folder_name'] = folder_data.get('name', '')

        if 'flashcards' in payload:
            updates['flashcards'] = app_ctx.sanitize_flashcards(payload.get('flashcards', []), 500)
        if 'test_questions' in payload:
            updates['test_questions'] = app_ctx.sanitize_questions(payload.get('test_questions', []), 500)
        if 'notes_markdown' in payload:
            updates['notes_markdown'] = str(payload.get('notes_markdown', ''))[:180000]
            notes_audio_map = app_ctx.parse_audio_markers_from_notes(updates['notes_markdown']) if app_ctx.FEATURE_AUDIO_SECTION_SYNC else []
            updates['notes_audio_map'] = notes_audio_map
            updates['has_audio_sync'] = app_ctx.FEATURE_AUDIO_SECTION_SYNC and bool(app_ctx.get_audio_storage_key_from_pack(pack)) and bool(notes_audio_map)
        updates['has_audio_playback'] = bool(app_ctx.get_audio_storage_key_from_pack(pack))

        pack_ref.update(updates)
        return app_ctx.jsonify({'ok': True})
    except Exception as e:
        app_ctx.logger.error(f"Error updating study pack {pack_id}: {e}")
        return app_ctx.jsonify({'error': 'Could not update study pack'}), 500


def delete_study_pack(app_ctx, request, pack_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        pack_ref = app_ctx.study_repo.study_pack_doc_ref(app_ctx.db, pack_id)
        doc = pack_ref.get()
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403
        app_ctx.remove_pack_audio_file(pack)
        pack_ref.delete()
        try:
            app_ctx.get_study_card_state_doc(uid, pack_id).delete()
        except Exception as e:
            app_ctx.logger.warning(f"Warning: could not delete study progress state for pack {pack_id}: {e}")
        return app_ctx.jsonify({'ok': True})
    except Exception as e:
        app_ctx.logger.error(f"Error deleting study pack {pack_id}: {e}")
        return app_ctx.jsonify({'error': 'Could not delete study pack'}), 500


def get_study_folders(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        docs = app_ctx.study_repo.list_study_folders_by_uid(app_ctx.db, uid)
        folders = []
        for doc in docs:
            folder = doc.to_dict()
            folders.append({
                'folder_id': doc.id,
                'name': folder.get('name', ''),
                'course': folder.get('course', ''),
                'subject': folder.get('subject', ''),
                'semester': folder.get('semester', ''),
                'block': folder.get('block', ''),
                'exam_date': folder.get('exam_date', ''),
                'created_at': folder.get('created_at', 0),
            })
        folders.sort(key=lambda f: f.get('created_at', 0), reverse=True)
        return app_ctx.jsonify({'folders': folders})
    except Exception as e:
        app_ctx.logger.error(f"Error fetching study folders: {e}")
        return app_ctx.jsonify({'error': 'Could not load study folders'}), 500


def get_study_pack_audio_url(app_ctx, request, pack_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict() or {}
        if pack.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403
        audio_storage_key = app_ctx.ensure_pack_audio_storage_key(doc.reference, pack)
        audio_storage_path = app_ctx.resolve_audio_storage_path_from_key(audio_storage_key)
        if not audio_storage_path:
            return app_ctx.jsonify({'error': 'No audio file for this study pack'}), 404
        if not app_ctx.os.path.exists(audio_storage_path):
            return app_ctx.jsonify({'error': 'Audio file not found'}), 404
        if not app_ctx.ALLOW_LEGACY_AUDIO_STREAM_TOKENS:
            return app_ctx.jsonify({'error': 'Legacy token audio endpoint is disabled on this server'}), 410
        stream_token = str(app_ctx.uuid.uuid4())
        app_ctx.AUDIO_STREAM_TOKENS[stream_token] = {
            'path': audio_storage_path,
            'expires_at': app_ctx.time.time() + app_ctx.AUDIO_STREAM_TOKEN_TTL_SECONDS
        }
        return app_ctx.jsonify({'audio_url': f"/api/audio-stream/{stream_token}"})
    except Exception as e:
        app_ctx.logger.error(f"Error generating study-pack audio URL {pack_id}: {e}")
        return app_ctx.jsonify({'error': 'Could not generate audio URL'}), 500


def stream_study_pack_audio(app_ctx, request, pack_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict() or {}
        if pack.get('uid', '') != uid and not app_ctx.is_admin_user(decoded_token):
            return app_ctx.jsonify({'error': 'Forbidden'}), 403
        audio_storage_key = app_ctx.ensure_pack_audio_storage_key(doc.reference, pack)
        audio_storage_path = app_ctx.resolve_audio_storage_path_from_key(audio_storage_key)
        if not audio_storage_path:
            return app_ctx.jsonify({'error': 'No audio file for this study pack'}), 404
        if not app_ctx.os.path.exists(audio_storage_path):
            return app_ctx.jsonify({'error': 'Audio file not found'}), 404
        return app_ctx.send_file(audio_storage_path, mimetype=app_ctx.get_mime_type(audio_storage_path), conditional=True)
    except Exception as e:
        app_ctx.logger.error(f"Error streaming study-pack audio {pack_id}: {e}")
        return app_ctx.jsonify({'error': 'Could not stream audio'}), 500


def stream_audio_token(app_ctx, token):
    if not app_ctx.ALLOW_LEGACY_AUDIO_STREAM_TOKENS:
        return app_ctx.jsonify({'error': 'Not found'}), 404
    token_data = app_ctx.AUDIO_STREAM_TOKENS.get(token)
    if not token_data:
        return app_ctx.jsonify({'error': 'Invalid token'}), 404
    if app_ctx.time.time() > token_data.get('expires_at', 0):
        app_ctx.AUDIO_STREAM_TOKENS.pop(token, None)
        return app_ctx.jsonify({'error': 'Token expired'}), 410
    file_path = token_data.get('path', '')
    if not file_path or not app_ctx.os.path.exists(file_path):
        return app_ctx.jsonify({'error': 'Audio file not found'}), 404
    mime_type = app_ctx.get_mime_type(file_path)
    return app_ctx.send_file(file_path, mimetype=mime_type, conditional=True)


def create_study_folder(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    payload = request.get_json() or {}
    name = str(payload.get('name', '')).strip()[:120]
    if not name:
        return app_ctx.jsonify({'error': 'Folder name is required'}), 400
    try:
        now_ts = app_ctx.time.time()
        try:
            exam_date = app_ctx.normalize_exam_date(payload.get('exam_date', ''))
        except ValueError as ve:
            return app_ctx.jsonify({'error': str(ve)}), 400
        doc_ref = app_ctx.study_repo.create_study_folder_doc_ref(app_ctx.db)
        doc_ref.set({
            'folder_id': doc_ref.id,
            'uid': uid,
            'name': name,
            'course': str(payload.get('course', '')).strip()[:120],
            'subject': str(payload.get('subject', '')).strip()[:120],
            'semester': str(payload.get('semester', '')).strip()[:120],
            'block': str(payload.get('block', '')).strip()[:120],
            'exam_date': exam_date,
            'created_at': now_ts,
            'updated_at': now_ts,
        })
        return app_ctx.jsonify({'ok': True, 'folder_id': doc_ref.id})
    except Exception as e:
        app_ctx.logger.error(f"Error creating study folder: {e}")
        return app_ctx.jsonify({'error': 'Could not create folder'}), 500


def update_study_folder(app_ctx, request, folder_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    payload = request.get_json() or {}
    try:
        folder_ref = app_ctx.study_repo.study_folder_doc_ref(app_ctx.db, folder_id)
        doc = folder_ref.get()
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Folder not found'}), 404
        folder = doc.to_dict()
        if folder.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403
        updates = {'updated_at': app_ctx.time.time()}
        if 'name' in payload:
            name = str(payload.get('name', '')).strip()[:120]
            if not name:
                return app_ctx.jsonify({'error': 'Folder name is required'}), 400
            updates['name'] = name
        for field in ['course', 'subject', 'semester', 'block']:
            if field in payload:
                updates[field] = str(payload.get(field, '')).strip()[:120]
        if 'exam_date' in payload:
            try:
                updates['exam_date'] = app_ctx.normalize_exam_date(payload.get('exam_date', ''))
            except ValueError as ve:
                return app_ctx.jsonify({'error': str(ve)}), 400
        folder_ref.update(updates)
        if 'name' in updates:
            packs = app_ctx.study_repo.list_study_packs_by_uid_and_folder(app_ctx.db, uid, folder_id)
            for pack_doc in packs:
                pack_doc.reference.update({'folder_name': updates['name'], 'updated_at': app_ctx.time.time()})
        return app_ctx.jsonify({'ok': True})
    except Exception as e:
        app_ctx.logger.error(f"Error updating folder {folder_id}: {e}")
        return app_ctx.jsonify({'error': 'Could not update folder'}), 500


def delete_study_folder(app_ctx, request, folder_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        folder_ref = app_ctx.study_repo.study_folder_doc_ref(app_ctx.db, folder_id)
        doc = folder_ref.get()
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Folder not found'}), 404
        folder = doc.to_dict()
        if folder.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403
        folder_ref.delete()
        packs = app_ctx.study_repo.list_study_packs_by_uid_and_folder(app_ctx.db, uid, folder_id)
        for pack_doc in packs:
            pack_doc.reference.update({'folder_id': '', 'folder_name': '', 'updated_at': app_ctx.time.time()})
        return app_ctx.jsonify({'ok': True})
    except Exception as e:
        app_ctx.logger.error(f"Error deleting folder {folder_id}: {e}")
        return app_ctx.jsonify({'error': 'Could not delete folder'}), 500


def export_study_pack_flashcards_csv(app_ctx, request, pack_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403
        export_type = request.args.get('type', 'flashcards').strip().lower()
        output = app_ctx.io.StringIO()
        writer = app_ctx.csv.writer(output)
        if export_type == 'test':
            test_questions = pack.get('test_questions', [])
            if not test_questions:
                return app_ctx.jsonify({'error': 'No practice questions available'}), 400
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
            filename = f'study-pack-{pack_id}-practice-test.csv'
        else:
            flashcards = pack.get('flashcards', [])
            if not flashcards:
                return app_ctx.jsonify({'error': 'No flashcards available'}), 400
            writer.writerow(['question', 'answer'])
            for card in flashcards:
                writer.writerow([card.get('front', ''), card.get('back', '')])
            filename = f'study-pack-{pack_id}-flashcards.csv'
        csv_bytes = app_ctx.io.BytesIO(output.getvalue().encode('utf-8'))
        csv_bytes.seek(0)
        return app_ctx.send_file(csv_bytes, mimetype='text/csv', as_attachment=True, download_name=filename)
    except Exception as e:
        app_ctx.logger.error(f"Error exporting study pack flashcards CSV {pack_id}: {e}")
        return app_ctx.jsonify({'error': 'Could not export CSV'}), 500


def export_study_pack_notes(app_ctx, request, pack_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    try:
        doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403

        notes_markdown = str(pack.get('notes_markdown', '') or '').strip()
        if not notes_markdown:
            return app_ctx.jsonify({'error': 'No integrated notes available'}), 400

        export_format = request.args.get('format', 'docx').strip().lower()
        base_name = f"study-pack-{pack_id}-notes"
        pack_title = str(pack.get('title', 'Lecture Notes') or 'Lecture Notes').strip()

        if export_format == 'md':
            md_bytes = app_ctx.io.BytesIO(notes_markdown.encode('utf-8'))
            md_bytes.seek(0)
            return app_ctx.send_file(
                md_bytes,
                mimetype='text/markdown',
                as_attachment=True,
                download_name=f"{base_name}.md"
            )

        if export_format == 'docx':
            docx = app_ctx.markdown_to_docx(notes_markdown, pack_title)
            docx_bytes = app_ctx.io.BytesIO()
            docx.save(docx_bytes)
            docx_bytes.seek(0)
            return app_ctx.send_file(
                docx_bytes,
                mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                as_attachment=True,
                download_name=f"{base_name}.docx"
            )

        return app_ctx.jsonify({'error': 'Invalid format'}), 400
    except Exception as e:
        app_ctx.logger.error(f"Error exporting study pack notes {pack_id}: {e}")
        return app_ctx.jsonify({'error': 'Could not export notes'}), 500


def export_study_pack_pdf(app_ctx, request, pack_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401

    if not app_ctx.REPORTLAB_AVAILABLE:
        return app_ctx.jsonify({
            'error': "PDF export is currently unavailable on this server. Install dependency: pip install reportlab==4.2.5"
        }), 503

    uid = decoded_token['uid']
    try:
        doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Study pack not found'}), 404

        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403

        include_answers_raw = str(request.args.get('include_answers', '1')).strip().lower()
        include_answers = include_answers_raw in {'1', 'true', 'yes', 'on'}
        pdf_io = app_ctx.build_study_pack_pdf(pack, include_answers=include_answers)
        filename_suffix = '' if include_answers else '-no-answers'
        return app_ctx.send_file(
            pdf_io,
            mimetype='application/pdf',
            as_attachment=True,
            download_name=f"study-pack-{pack_id}{filename_suffix}.pdf"
        )
    except Exception as e:
        app_ctx.logger.error(f"Error exporting study pack PDF {pack_id}: {e}")
        return app_ctx.jsonify({'error': 'Could not export PDF'}), 500
