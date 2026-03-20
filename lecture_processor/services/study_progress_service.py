"""Study progress routes extracted from study API service."""

from lecture_processor.domains.study import progress as study_progress

from lecture_processor.services import study_api_support


def get_study_progress(app_ctx, request):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    try:
        progress_doc = app_ctx.get_study_progress_doc(uid).get()
        progress_data = progress_doc.to_dict() if progress_doc.exists else {}
        daily_goal = study_progress.sanitize_daily_goal_value(progress_data.get('daily_goal'), runtime=app_ctx)
        if daily_goal is None:
            daily_goal = 20
        streak_data = study_progress.sanitize_streak_data(progress_data.get('streak_data', {}), runtime=app_ctx)
        timezone = str(progress_data.get('timezone', '') or '').strip()[:80]

        card_states = {}
        card_state_maps = []
        docs = app_ctx.study_repo.list_study_card_states_by_uid(app_ctx.db, uid, app_ctx.MAX_PROGRESS_PACKS_PER_SYNC)
        for doc in docs:
            data = doc.to_dict() or {}
            pack_id = study_progress.sanitize_pack_id(data.get('pack_id', ''), runtime=app_ctx)
            if not pack_id:
                continue
            state_map = study_progress.sanitize_card_state_map(data.get('state', {}), runtime=app_ctx)
            card_states[pack_id] = state_map
            card_state_maps.append(state_map)

        return app_ctx.jsonify({
            'daily_goal': daily_goal,
            'streak_data': streak_data,
            'timezone': study_progress.sanitize_timezone_name(timezone, runtime=app_ctx),
            'card_states': card_states,
            'summary': study_progress.compute_study_progress_summary(progress_data, card_state_maps, runtime=app_ctx),
        })
    except Exception as error:
        app_ctx.logger.error(f"Error fetching study progress for user {uid}: {error}")
        return app_ctx.jsonify({'error': 'Could not load study progress'}), 500


def update_study_progress(app_ctx, request):
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
        progress_ref = app_ctx.get_study_progress_doc(uid)
        existing_progress_doc = progress_ref.get()
        existing_progress_data = existing_progress_doc.to_dict() if existing_progress_doc.exists else {}
        now_ts = app_ctx.time.time()
        updates = {
            'uid': uid,
            'updated_at': now_ts,
        }

        if 'daily_goal' in payload:
            daily_goal = study_progress.sanitize_daily_goal_value(payload.get('daily_goal'), runtime=app_ctx)
            if daily_goal is None:
                return app_ctx.jsonify({'error': 'daily_goal must be between 1 and 500'}), 400
            updates['daily_goal'] = daily_goal

        if 'streak_data' in payload:
            updates['streak_data'] = study_progress.merge_streak_data(
                existing_progress_data.get('streak_data', {}),
                payload.get('streak_data'),
                runtime=app_ctx,
            )

        if 'timezone' in payload:
            updates['timezone'] = study_progress.merge_timezone_value(
                existing_progress_data.get('timezone', ''),
                payload.get('timezone', ''),
                runtime=app_ctx,
            )

        remove_pack_ids = payload.get('remove_pack_ids')
        sanitized_remove_pack_ids = []
        if remove_pack_ids is not None:
            if not isinstance(remove_pack_ids, list):
                return app_ctx.jsonify({'error': 'remove_pack_ids must be a list'}), 400
            for raw_pack_id in remove_pack_ids[:app_ctx.MAX_PROGRESS_PACKS_PER_SYNC]:
                pack_id = study_progress.sanitize_pack_id(raw_pack_id, runtime=app_ctx)
                if pack_id:
                    sanitized_remove_pack_ids.append(pack_id)
        remove_pack_id_set = set(sanitized_remove_pack_ids)

        card_states = payload.get('card_states')
        validated_card_state_writes = []
        if card_states is not None:
            if not isinstance(card_states, dict):
                return app_ctx.jsonify({'error': 'card_states must be an object'}), 400
            processed = 0
            for raw_pack_id, raw_state in card_states.items():
                if processed >= app_ctx.MAX_PROGRESS_PACKS_PER_SYNC:
                    break
                pack_id = study_progress.sanitize_pack_id(raw_pack_id, runtime=app_ctx)
                if not pack_id:
                    continue
                cleaned_state = study_progress.sanitize_card_state_map(raw_state, runtime=app_ctx)
                processed += 1
                if not cleaned_state or pack_id in remove_pack_id_set:
                    continue
                doc_ref = app_ctx.get_study_card_state_doc(uid, pack_id)
                existing_pack_doc = doc_ref.get()
                existing_pack_state = {}
                if existing_pack_doc.exists:
                    existing_pack_data = existing_pack_doc.to_dict() or {}
                    existing_pack_state = study_progress.sanitize_card_state_map(
                        existing_pack_data.get('state', {}),
                        runtime=app_ctx,
                    )
                merged_state = study_progress.merge_card_state_maps(
                    existing_pack_state,
                    cleaned_state,
                    runtime=app_ctx,
                )
                validated_card_state_writes.append(
                    (
                        doc_ref,
                        {
                            'uid': uid,
                            'pack_id': pack_id,
                            'state': merged_state,
                            'updated_at': now_ts,
                        },
                    )
                )

        if getattr(app_ctx.db, 'batch', None):
            batch = app_ctx.db.batch()
            batch.set(progress_ref, updates, merge=True)
            for doc_ref, doc_payload in validated_card_state_writes:
                batch.set(doc_ref, doc_payload, merge=True)
            for pack_id in sanitized_remove_pack_ids:
                batch.delete(app_ctx.get_study_card_state_doc(uid, pack_id))
            batch.commit()
        else:
            progress_ref.set(updates, merge=True)
            for doc_ref, doc_payload in validated_card_state_writes:
                doc_ref.set(doc_payload, merge=True)
            for pack_id in sanitized_remove_pack_ids:
                app_ctx.get_study_card_state_doc(uid, pack_id).delete()

        return app_ctx.jsonify({'ok': True})
    except Exception as error:
        app_ctx.logger.error(f"Error updating study progress for user {uid}: {error}")
        return app_ctx.jsonify({'error': 'Could not save study progress'}), 500


def get_study_progress_summary(app_ctx, request):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    try:
        progress_doc = app_ctx.get_study_progress_doc(uid).get()
        progress_data = progress_doc.to_dict() if progress_doc.exists else {}
        card_state_maps = []
        docs = app_ctx.study_repo.list_study_card_states_by_uid(app_ctx.db, uid, app_ctx.MAX_PROGRESS_PACKS_PER_SYNC)
        for doc in docs:
            data = doc.to_dict() or {}
            card_state_maps.append(study_progress.sanitize_card_state_map(data.get('state', {}), runtime=app_ctx))

        return app_ctx.jsonify(
            study_progress.compute_study_progress_summary(progress_data, card_state_maps, runtime=app_ctx)
        )
    except Exception as error:
        app_ctx.logger.error(f"Error fetching study progress summary for user {uid}: {error}")
        return app_ctx.jsonify({'error': 'Could not load study progress summary'}), 500
