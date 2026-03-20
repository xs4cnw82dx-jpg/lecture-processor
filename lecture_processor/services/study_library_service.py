"""Study library, folder, share, and public-share routes."""

from lecture_processor.domains.study import audio as study_audio
from lecture_processor.domains.study import export as study_export
from lecture_processor.domains.study import progress as study_progress

from lecture_processor.services import study_api_support


def get_study_packs(app_ctx, request):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    try:
        limit = study_api_support.parse_study_pack_limit(request.args.get('limit'))
        if limit is None:
            return app_ctx.jsonify({'error': 'limit must be an integer between 1 and 100'}), 400

        after_cursor = str(request.args.get('after', '') or '').strip()
        after_doc = None
        if after_cursor:
            after_doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, after_cursor)
            if not after_doc.exists:
                return app_ctx.jsonify({'error': 'Invalid study pack cursor'}), 400
            after_payload = after_doc.to_dict() or {}
            if str(after_payload.get('uid', '') or '') != uid:
                return app_ctx.jsonify({'error': 'Invalid study pack cursor'}), 400

        study_docs = app_ctx.study_repo.list_study_pack_summaries_by_uid(
            app_ctx.db,
            uid,
            limit + 1,
            after_doc=after_doc,
        )
        has_more = len(study_docs) > limit
        packs = []
        for doc in study_docs[:limit]:
            pack = doc.to_dict() or {}
            packs.append({
                'study_pack_id': doc.id,
                'title': pack.get('title', ''),
                'mode': pack.get('mode', ''),
                'flashcards_count': study_api_support.pack_item_count(pack, 'flashcards_count', 'flashcards'),
                'test_questions_count': study_api_support.pack_item_count(pack, 'test_questions_count', 'test_questions'),
                'daily_card_goal': study_progress.sanitize_daily_card_goal_value(pack.get('daily_card_goal'), runtime=app_ctx),
                'course': pack.get('course', ''),
                'subject': pack.get('subject', ''),
                'semester': pack.get('semester', ''),
                'block': pack.get('block', ''),
                'folder_id': pack.get('folder_id', ''),
                'folder_name': pack.get('folder_name', ''),
                'created_at': pack.get('created_at', 0),
            })
        next_cursor = packs[-1]['study_pack_id'] if has_more and packs else ''
        return app_ctx.jsonify({'study_packs': packs, 'has_more': has_more, 'next_cursor': next_cursor})
    except Exception as error:
        app_ctx.logger.error(f"Error fetching study packs: {error}")
        return app_ctx.jsonify({'error': 'Could not load study packs'}), 500


def create_study_pack(app_ctx, request):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return app_ctx.jsonify({'error': 'Invalid payload'}), 400

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
        goal_valid, daily_card_goal = study_api_support.parse_daily_card_goal_input(payload.get('daily_card_goal'), runtime=app_ctx)
        if not goal_valid:
            return app_ctx.jsonify({'error': 'daily_card_goal must be between 1 and 500'}), 400
        notes_highlights_action, notes_highlights = study_api_support.parse_notes_highlights_input(payload.get('notes_highlights'), runtime=app_ctx)
        if notes_highlights_action == 'invalid':
            return app_ctx.jsonify({'error': 'notes_highlights must contain valid ranges and allowed colors'}), 400
        notes_audio_map = (
            study_audio.parse_audio_markers_from_notes(notes_markdown, runtime=app_ctx)
            if app_ctx.FEATURE_AUDIO_SECTION_SYNC
            else []
        )

        doc_ref = app_ctx.study_repo.create_study_pack_doc_ref(app_ctx.db)
        doc_payload = {
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
            'flashcards_count': len(flashcards),
            'test_questions_count': len(test_questions),
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
        }
        if daily_card_goal is not None:
            doc_payload['daily_card_goal'] = daily_card_goal
        if notes_highlights_action == 'set':
            doc_payload['notes_highlights'] = notes_highlights
        doc_ref.set(doc_payload)

        return app_ctx.jsonify({'ok': True, 'study_pack_id': doc_ref.id})
    except Exception as error:
        app_ctx.logger.error(f"Error creating study pack: {error}")
        return app_ctx.jsonify({'error': 'Could not create study pack'}), 500


def get_study_pack(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    try:
        pack_result, error_response, status = study_api_support.get_owned_study_pack(app_ctx, uid, pack_id)
        if error_response is not None:
            return error_response, status
        doc, pack = pack_result
        study_audio.ensure_pack_audio_storage_key(doc.reference, pack, runtime=app_ctx)
        has_audio_playback = bool(
            pack.get('has_audio_playback', False)
            or study_audio.get_audio_storage_key_from_pack(pack, runtime=app_ctx)
        )
        has_audio_sync = app_ctx.FEATURE_AUDIO_SECTION_SYNC and bool(pack.get('has_audio_sync', False))
        notes_audio_map = pack.get('notes_audio_map', []) if has_audio_sync else []
        daily_card_goal = study_progress.sanitize_daily_card_goal_value(pack.get('daily_card_goal'), runtime=app_ctx)
        notes_highlights = study_progress.sanitize_notes_highlights_payload(pack.get('notes_highlights'), runtime=app_ctx)
        source_payload = study_api_support.get_study_pack_source_payload(app_ctx, pack_id)
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
            'has_source_slides': bool(str(source_payload.get('slide_text', '') or '').strip()),
            'has_source_transcript': bool(str(source_payload.get('transcript', '') or '').strip()),
            'flashcards': pack.get('flashcards', []),
            'test_questions': pack.get('test_questions', []),
            'interview_summary': pack.get('interview_summary'),
            'interview_sections': pack.get('interview_sections'),
            'interview_combined': pack.get('interview_combined'),
            'study_features': pack.get('study_features', 'none'),
            'interview_features': pack.get('interview_features', []),
            'daily_card_goal': daily_card_goal,
            'notes_highlights': notes_highlights,
            'course': pack.get('course', ''),
            'subject': pack.get('subject', ''),
            'semester': pack.get('semester', ''),
            'block': pack.get('block', ''),
            'folder_id': pack.get('folder_id', ''),
            'folder_name': pack.get('folder_name', ''),
            'created_at': pack.get('created_at', 0),
        })
    except Exception as error:
        app_ctx.logger.error(f"Error fetching study pack {pack_id}: {error}")
        return app_ctx.jsonify({'error': 'Could not fetch study pack'}), 500


def update_study_pack(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return app_ctx.jsonify({'error': 'Invalid payload'}), 400

    try:
        pack_ref = app_ctx.study_repo.study_pack_doc_ref(app_ctx.db, pack_id)
        doc = pack_ref.get()
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403
        study_audio.ensure_pack_audio_storage_key(pack_ref, pack, runtime=app_ctx)

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
        if 'daily_card_goal' in payload:
            goal_valid, daily_card_goal = study_api_support.parse_daily_card_goal_input(payload.get('daily_card_goal'), runtime=app_ctx)
            if not goal_valid:
                return app_ctx.jsonify({'error': 'daily_card_goal must be between 1 and 500'}), 400
            updates['daily_card_goal'] = daily_card_goal

        if 'flashcards' in payload:
            updates['flashcards'] = app_ctx.sanitize_flashcards(payload.get('flashcards', []), 500)
            updates['flashcards_count'] = len(updates['flashcards'])
        if 'test_questions' in payload:
            updates['test_questions'] = app_ctx.sanitize_questions(payload.get('test_questions', []), 500)
            updates['test_questions_count'] = len(updates['test_questions'])
        if 'notes_markdown' in payload:
            updates['notes_markdown'] = str(payload.get('notes_markdown', ''))[:180000]
            notes_audio_map = (
                study_audio.parse_audio_markers_from_notes(updates['notes_markdown'], runtime=app_ctx)
                if app_ctx.FEATURE_AUDIO_SECTION_SYNC
                else []
            )
            updates['notes_audio_map'] = notes_audio_map
            updates['has_audio_sync'] = (
                app_ctx.FEATURE_AUDIO_SECTION_SYNC
                and bool(study_audio.get_audio_storage_key_from_pack(pack, runtime=app_ctx))
                and bool(notes_audio_map)
            )
        if 'notes_highlights' in payload:
            notes_highlights_action, notes_highlights = study_api_support.parse_notes_highlights_input(payload.get('notes_highlights'), runtime=app_ctx)
            if notes_highlights_action == 'invalid':
                return app_ctx.jsonify({'error': 'notes_highlights must contain valid ranges and allowed colors'}), 400
            updates['notes_highlights'] = notes_highlights if notes_highlights_action == 'set' else None
        updates['has_audio_playback'] = bool(study_audio.get_audio_storage_key_from_pack(pack, runtime=app_ctx))

        pack_ref.update(updates)
        return app_ctx.jsonify({'ok': True})
    except Exception as error:
        app_ctx.logger.error(f"Error updating study pack {pack_id}: {error}")
        return app_ctx.jsonify({'error': 'Could not update study pack'}), 500


def delete_study_pack(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    try:
        pack_result, error_response, status = study_api_support.get_owned_study_pack(app_ctx, uid, pack_id)
        if error_response is not None:
            return error_response, status
        doc, pack = pack_result
        pack_ref = doc.reference
        study_audio.remove_pack_audio_file(pack, runtime=app_ctx)
        try:
            app_ctx.study_repo.study_pack_source_doc_ref(app_ctx.db, pack_id).delete()
        except Exception as error:
            app_ctx.logger.warning('Warning: could not delete study pack source outputs for %s: %s', pack_id, error)
        study_api_support.delete_share_for_entity(app_ctx, uid, 'pack', pack_id)
        pack_ref.delete()
        try:
            app_ctx.get_study_card_state_doc(uid, pack_id).delete()
        except Exception as error:
            app_ctx.logger.warning(f"Warning: could not delete study progress state for pack {pack_id}: {error}")
        return app_ctx.jsonify({'ok': True})
    except Exception as error:
        app_ctx.logger.error(f"Error deleting study pack {pack_id}: {error}")
        return app_ctx.jsonify({'error': 'Could not delete study pack'}), 500


def get_study_folders(app_ctx, request):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    try:
        pending_by_folder = study_api_support.list_pending_batches_by_folder(app_ctx, uid)
        docs = app_ctx.study_repo.list_study_folders_by_uid(app_ctx.db, uid)
        folders = []
        for doc in docs:
            folder = doc.to_dict()
            folder_id = doc.id
            pending_count = int(pending_by_folder.get(folder_id, 0) or 0)
            folders.append({
                'folder_id': folder_id,
                'name': folder.get('name', ''),
                'course': folder.get('course', ''),
                'subject': folder.get('subject', ''),
                'semester': folder.get('semester', ''),
                'block': folder.get('block', ''),
                'exam_date': folder.get('exam_date', ''),
                'created_at': folder.get('created_at', 0),
                'pending_batch_count': pending_count,
                'pending_batch_hint': (
                    'This folder will fill once the batch completes.'
                    if pending_count > 0
                    else ''
                ),
            })
        folders.sort(key=lambda item: item.get('created_at', 0), reverse=True)
        return app_ctx.jsonify({'folders': folders})
    except Exception as error:
        app_ctx.logger.error(f"Error fetching study folders: {error}")
        return app_ctx.jsonify({'error': 'Could not load study folders'}), 500


def stream_study_pack_audio(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    try:
        doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict() or {}
        if pack.get('uid', '') != uid and not app_ctx.is_admin_user(decoded_token):
            return app_ctx.jsonify({'error': 'Forbidden'}), 403
        audio_storage_key = study_audio.ensure_pack_audio_storage_key(doc.reference, pack, runtime=app_ctx)
        audio_storage_path = study_audio.resolve_audio_storage_path_from_key(audio_storage_key, runtime=app_ctx)
        if not audio_storage_path:
            return app_ctx.jsonify({'error': 'No audio file for this study pack'}), 404
        if not app_ctx.os.path.exists(audio_storage_path):
            return app_ctx.jsonify({'error': 'Audio file not found'}), 404
        return app_ctx.send_file(audio_storage_path, mimetype=app_ctx.get_mime_type(audio_storage_path), conditional=True)
    except Exception as error:
        app_ctx.logger.error(f"Error streaming study-pack audio {pack_id}: {error}")
        return app_ctx.jsonify({'error': 'Could not stream audio'}), 500


def create_study_folder(app_ctx, request):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    payload = request.get_json() or {}
    name = str(payload.get('name', '')).strip()[:120]
    if not name:
        return app_ctx.jsonify({'error': 'Folder name is required'}), 400
    try:
        now_ts = app_ctx.time.time()
        try:
            exam_date = study_export.normalize_exam_date(payload.get('exam_date', ''), runtime=app_ctx)
        except ValueError as error:
            return app_ctx.jsonify({'error': str(error)}), 400
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
    except Exception as error:
        app_ctx.logger.error(f"Error creating study folder: {error}")
        return app_ctx.jsonify({'error': 'Could not create folder'}), 500


def update_study_folder(app_ctx, request, folder_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
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
                updates['exam_date'] = study_export.normalize_exam_date(
                    payload.get('exam_date', ''),
                    runtime=app_ctx,
                )
            except ValueError as error:
                return app_ctx.jsonify({'error': str(error)}), 400
        folder_ref.update(updates)
        if 'name' in updates:
            packs = app_ctx.study_repo.list_study_packs_by_uid_and_folder(app_ctx.db, uid, folder_id)
            for pack_doc in packs:
                pack_doc.reference.update({'folder_name': updates['name'], 'updated_at': app_ctx.time.time()})
        return app_ctx.jsonify({'ok': True})
    except Exception as error:
        app_ctx.logger.error(f"Error updating folder {folder_id}: {error}")
        return app_ctx.jsonify({'error': 'Could not update folder'}), 500


def delete_study_folder(app_ctx, request, folder_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    try:
        folder_ref = app_ctx.study_repo.study_folder_doc_ref(app_ctx.db, folder_id)
        doc = folder_ref.get()
        if not doc.exists:
            return app_ctx.jsonify({'error': 'Folder not found'}), 404
        folder = doc.to_dict()
        if folder.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403
        study_api_support.delete_share_for_entity(app_ctx, uid, 'folder', folder_id)
        folder_ref.delete()
        packs = app_ctx.study_repo.list_study_packs_by_uid_and_folder(app_ctx.db, uid, folder_id)
        for pack_doc in packs:
            pack_doc.reference.update({'folder_id': '', 'folder_name': '', 'updated_at': app_ctx.time.time()})
        return app_ctx.jsonify({'ok': True})
    except Exception as error:
        app_ctx.logger.error(f"Error deleting folder {folder_id}: {error}")
        return app_ctx.jsonify({'error': 'Could not delete folder'}), 500


def get_study_pack_share(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    if app_ctx.db is None:
        return app_ctx.jsonify({'error': 'Sharing is unavailable'}), 503
    try:
        pack_result, error_response, status = study_api_support.get_owned_study_pack(app_ctx, uid, pack_id)
        if error_response is not None:
            return error_response, status
        _doc, _pack = pack_result
        share_doc = app_ctx.study_repo.find_study_share_by_owner_and_entity(app_ctx.db, uid, 'pack', pack_id)
        return app_ctx.jsonify(study_api_support.serialize_share_state(app_ctx, request, 'pack', pack_id, share_doc=share_doc))
    except Exception as error:
        app_ctx.logger.error('Error loading share state for pack %s: %s', pack_id, error)
        return app_ctx.jsonify({'error': 'Could not load sharing settings'}), 500


def update_study_pack_share(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    if app_ctx.db is None:
        return app_ctx.jsonify({'error': 'Sharing is unavailable'}), 503
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return app_ctx.jsonify({'error': 'Invalid payload'}), 400
    access_scope = str(payload.get('access_scope', 'private') or 'private').strip().lower()
    if access_scope not in {'public', 'private'}:
        return app_ctx.jsonify({'error': 'access_scope must be public or private'}), 400
    try:
        pack_result, error_response, status = study_api_support.get_owned_study_pack(app_ctx, uid, pack_id)
        if error_response is not None:
            return error_response, status
        _doc, _pack = pack_result
        share_ref, share_token, now_ts, created_at = study_api_support.ensure_share_record(app_ctx, uid, 'pack', pack_id)
        share_ref.set(
            {
                'share_token': share_token,
                'entity_type': 'pack',
                'entity_id': pack_id,
                'owner_uid': uid,
                'access_scope': access_scope,
                'allowed_uids': [],
                'updated_at': now_ts,
                'created_at': created_at,
            },
            merge=True,
        )
        share_doc = share_ref.get()
        return app_ctx.jsonify(study_api_support.serialize_share_state(app_ctx, request, 'pack', pack_id, share_doc=share_doc))
    except Exception as error:
        app_ctx.logger.error('Error updating share state for pack %s: %s', pack_id, error)
        return app_ctx.jsonify({'error': 'Could not save sharing settings'}), 500


def get_study_folder_share(app_ctx, request, folder_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    if app_ctx.db is None:
        return app_ctx.jsonify({'error': 'Sharing is unavailable'}), 503
    try:
        folder_result, error_response, status = study_api_support.get_owned_study_folder(app_ctx, uid, folder_id)
        if error_response is not None:
            return error_response, status
        _doc, _folder = folder_result
        share_doc = app_ctx.study_repo.find_study_share_by_owner_and_entity(app_ctx.db, uid, 'folder', folder_id)
        return app_ctx.jsonify(study_api_support.serialize_share_state(app_ctx, request, 'folder', folder_id, share_doc=share_doc))
    except Exception as error:
        app_ctx.logger.error('Error loading share state for folder %s: %s', folder_id, error)
        return app_ctx.jsonify({'error': 'Could not load sharing settings'}), 500


def update_study_folder_share(app_ctx, request, folder_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = study_api_support.account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    if app_ctx.db is None:
        return app_ctx.jsonify({'error': 'Sharing is unavailable'}), 503
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return app_ctx.jsonify({'error': 'Invalid payload'}), 400
    access_scope = str(payload.get('access_scope', 'private') or 'private').strip().lower()
    if access_scope not in {'public', 'private'}:
        return app_ctx.jsonify({'error': 'access_scope must be public or private'}), 400
    try:
        folder_result, error_response, status = study_api_support.get_owned_study_folder(app_ctx, uid, folder_id)
        if error_response is not None:
            return error_response, status
        _doc, _folder = folder_result
        share_ref, share_token, now_ts, created_at = study_api_support.ensure_share_record(app_ctx, uid, 'folder', folder_id)
        share_ref.set(
            {
                'share_token': share_token,
                'entity_type': 'folder',
                'entity_id': folder_id,
                'owner_uid': uid,
                'access_scope': access_scope,
                'allowed_uids': [],
                'updated_at': now_ts,
                'created_at': created_at,
            },
            merge=True,
        )
        share_doc = share_ref.get()
        return app_ctx.jsonify(study_api_support.serialize_share_state(app_ctx, request, 'folder', folder_id, share_doc=share_doc))
    except Exception as error:
        app_ctx.logger.error('Error updating share state for folder %s: %s', folder_id, error)
        return app_ctx.jsonify({'error': 'Could not save sharing settings'}), 500


def get_public_study_share(app_ctx, request, share_token):
    try:
        share_result, error_response, status = study_api_support.get_public_share(app_ctx, share_token)
        if error_response is not None:
            return error_response, status
        _share_doc, share = share_result
        entity_type = str(share.get('entity_type', '') or '').strip().lower()
        entity_id = str(share.get('entity_id', '') or '').strip()
        owner_uid = str(share.get('owner_uid', '') or '').strip()
        if entity_type == 'pack':
            pack_doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, entity_id)
            if not pack_doc.exists:
                return app_ctx.jsonify({'error': 'Shared content not found'}), 404
            pack = pack_doc.to_dict() or {}
            if str(pack.get('uid', '') or '').strip() != owner_uid:
                return app_ctx.jsonify({'error': 'Shared content not found'}), 404
            return app_ctx.jsonify(
                {
                    'entity_type': 'pack',
                    'share_token': share_token,
                    'access_scope': 'public',
                    'study_pack': study_api_support.serialize_public_pack(app_ctx, entity_id, pack),
                }
            )
        if entity_type == 'folder':
            folder_doc = app_ctx.study_repo.get_study_folder_doc(app_ctx.db, entity_id)
            if not folder_doc.exists:
                return app_ctx.jsonify({'error': 'Shared content not found'}), 404
            folder = folder_doc.to_dict() or {}
            if str(folder.get('uid', '') or '').strip() != owner_uid:
                return app_ctx.jsonify({'error': 'Shared content not found'}), 404
            packs = app_ctx.study_repo.list_study_packs_by_uid_and_folder(app_ctx.db, owner_uid, entity_id)
            pack_summaries = []
            for pack_doc in packs:
                pack = pack_doc.to_dict() or {}
                pack_summaries.append(study_api_support.serialize_public_pack_summary(pack_doc.id, pack))
            pack_summaries.sort(key=lambda item: item.get('created_at', 0), reverse=True)
            return app_ctx.jsonify(
                {
                    'entity_type': 'folder',
                    'share_token': share_token,
                    'access_scope': 'public',
                    'folder': study_api_support.serialize_public_folder(entity_id, folder),
                    'study_packs': pack_summaries,
                }
            )
        return app_ctx.jsonify({'error': 'Shared content not found'}), 404
    except Exception as error:
        app_ctx.logger.error('Error loading public share %s: %s', share_token, error)
        return app_ctx.jsonify({'error': 'Could not load shared content'}), 500


def get_public_shared_folder_pack(app_ctx, request, share_token, pack_id):
    try:
        share_result, error_response, status = study_api_support.get_public_share(app_ctx, share_token)
        if error_response is not None:
            return error_response, status
        _share_doc, share = share_result
        if str(share.get('entity_type', '') or '').strip().lower() != 'folder':
            return app_ctx.jsonify({'error': 'Shared content not found'}), 404
        folder_id = str(share.get('entity_id', '') or '').strip()
        owner_uid = str(share.get('owner_uid', '') or '').strip()
        pack_doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
        if not pack_doc.exists:
            return app_ctx.jsonify({'error': 'Shared content not found'}), 404
        pack = pack_doc.to_dict() or {}
        if str(pack.get('uid', '') or '').strip() != owner_uid or str(pack.get('folder_id', '') or '').strip() != folder_id:
            return app_ctx.jsonify({'error': 'Shared content not found'}), 404
        return app_ctx.jsonify(study_api_support.serialize_public_pack(app_ctx, pack_id, pack))
    except Exception as error:
        app_ctx.logger.error('Error loading shared pack %s from share %s: %s', pack_id, share_token, error)
        return app_ctx.jsonify({'error': 'Could not load shared content'}), 500
