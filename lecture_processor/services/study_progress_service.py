"""Study progress routes extracted from study API service."""

from lecture_processor.domains.study import progress as study_progress

from lecture_processor.services import study_api_support
from lecture_processor.domains.account import lifecycle as account_lifecycle


UNSCHEDULED_DUE_DATE = '0001-01-01'
CARD_STATE_DUE_ROLLUP_KEY = 'card_state_due_by_date'
CARD_STATE_DUE_ROLLUP_UPDATED_AT_KEY = 'card_state_due_by_date_updated_at'
CARD_STATE_DUE_ROLLUP_VERSION_KEY = 'card_state_due_by_date_version'
CARD_STATE_DUE_ROLLUP_VERSION = 1


class ProgressPackUnavailable(ValueError):
    def __init__(self, message, status):
        super().__init__(message)
        self.status = status


def _read_doc(doc_ref, transaction=None):
    return doc_ref.get(transaction=transaction) if transaction is not None else doc_ref.get()


def _has_complete_due_rollup(progress_data):
    return (
        progress_data.get(CARD_STATE_DUE_ROLLUP_VERSION_KEY) == CARD_STATE_DUE_ROLLUP_VERSION
        and isinstance(progress_data.get(CARD_STATE_DUE_ROLLUP_KEY), dict)
    )


def _rollup_updates(uid, rollup, app_ctx):
    return {
        'uid': uid,
        CARD_STATE_DUE_ROLLUP_KEY: rollup,
        CARD_STATE_DUE_ROLLUP_UPDATED_AT_KEY: app_ctx.time.time(),
        CARD_STATE_DUE_ROLLUP_VERSION_KEY: CARD_STATE_DUE_ROLLUP_VERSION,
    }


def _assert_pack_owner(app_ctx, uid, pack_id, transaction):
    pack_ref = app_ctx.repositories.study.study_pack_doc_ref(app_ctx.db, pack_id)
    doc = _read_doc(pack_ref, transaction)
    if not doc.exists:
        raise ProgressPackUnavailable('Study pack not found', 404)
    if (doc.to_dict() or {}).get('uid') != uid:
        raise ProgressPackUnavailable('Forbidden', 403)


def _rebuild_due_rollup(app_ctx, uid, transaction=None):
    """Rebuild from authoritative state; old summary maps may retain stale dates."""
    docs = app_ctx.repositories.study.list_all_study_card_states_by_uid(app_ctx.db, uid, transaction=transaction)
    states = {}
    for doc in docs:
        data = doc.to_dict() or {}
        pack_id = _pack_id_from_summary_doc(uid, doc, data)
        if pack_id and data.get('uid') == uid:
            states[pack_id] = study_progress.sanitize_card_state_map(data.get('state', {}), runtime=app_ctx)
    owners = app_ctx.repositories.study.get_study_pack_owner_docs(app_ctx.db, states, transaction=transaction)
    owned_ids = {doc.id for doc in owners if doc.exists and (doc.to_dict() or {}).get('uid') == uid}
    rollup = {}
    for pack_id in owned_ids:
        due_by_date = _card_state_summary(states[pack_id], app_ctx)['due_by_date']
        rollup = _apply_due_by_date_delta(rollup, add=due_by_date)
    return rollup


def _due_rollup_for_progress(app_ctx, uid, progress_data, transaction=None):
    if _has_complete_due_rollup(progress_data):
        return _sanitize_due_by_date(progress_data[CARD_STATE_DUE_ROLLUP_KEY], app_ctx)
    return _rebuild_due_rollup(app_ctx, uid, transaction)


def _complete_progress_data(app_ctx, uid):
    progress_ref = app_ctx.get_study_progress_doc(uid)
    initial_doc = progress_ref.get()
    initial_data = (initial_doc.to_dict() or {}) if initial_doc.exists else {}
    if _has_complete_due_rollup(initial_data):
        return initial_data

    def load(transaction=None):
        doc = _read_doc(progress_ref, transaction)
        data = (doc.to_dict() or {}) if doc.exists else {}
        if _has_complete_due_rollup(data):
            return data
        account_lifecycle.require_account_access(uid, runtime=app_ctx, transaction=transaction)
        updates = _rollup_updates(uid, _rebuild_due_rollup(app_ctx, uid, transaction), app_ctx)
        # A top-level merge mask replaces the entire date map. merge=True
        # preserves absent nested date keys and can leave obsolete due counts.
        if transaction is not None:
            transaction.set(progress_ref, updates, merge=list(updates))
        else:
            progress_ref.set(updates, merge=list(updates))
        return {**data, **updates}

    transactional = getattr(getattr(app_ctx, 'firestore', None), 'transactional', None)
    transaction_factory = getattr(app_ctx.db, 'transaction', None)
    if callable(transactional) and callable(transaction_factory):
        return transactional(load)(transaction_factory())
    return load()


def delete_pack_and_progress(app_ctx, uid, pack_id, delete_refs):
    """Delete a pack and its due contribution together; leave media until commit."""
    progress_ref = app_ctx.get_study_progress_doc(uid)
    state_ref = app_ctx.get_study_card_state_doc(uid, pack_id)

    def prepare(transaction=None):
        account_lifecycle.require_account_access(uid, runtime=app_ctx, transaction=transaction)
        if transaction is not None:
            _assert_pack_owner(app_ctx, uid, pack_id, transaction)
        progress_doc = _read_doc(progress_ref, transaction)
        progress_data = (progress_doc.to_dict() or {}) if progress_doc.exists else {}
        state_doc = _read_doc(state_ref, transaction)
        state_data = (state_doc.to_dict() or {}) if state_doc.exists else {}
        state = study_progress.sanitize_card_state_map(state_data.get('state', {}), runtime=app_ctx)
        rollup = _due_rollup_for_progress(app_ctx, uid, progress_data, transaction)
        rollup = _apply_due_by_date_delta(rollup, subtract=_card_state_summary(state, app_ctx)['due_by_date'])
        return _rollup_updates(uid, rollup, app_ctx)

    transactional = getattr(getattr(app_ctx, 'firestore', None), 'transactional', None)
    transaction_factory = getattr(app_ctx.db, 'transaction', None)
    if callable(transactional) and callable(transaction_factory):
        @transactional
        def remove(transaction):
            updates = prepare(transaction)
            transaction.set(progress_ref, updates, merge=list(updates))
            for ref in delete_refs:
                transaction.delete(ref)
        remove(transaction_factory())
        return
    updates = prepare()
    batch_factory = getattr(app_ctx.db, 'batch', None)
    if callable(batch_factory):
        batch = batch_factory()
        batch.set(progress_ref, updates, merge=list(updates))
        for ref in delete_refs:
            batch.delete(ref)
        batch.commit()
        return
    progress_ref.set(updates, merge=list(updates))
    for ref in delete_refs:
        ref.delete()


def _local_today(progress_data, app_ctx):
    tzinfo, _timezone_name = study_progress.resolve_progress_timezone(progress_data, runtime=app_ctx)
    return study_progress.to_timezone_now(None, tzinfo, runtime=app_ctx).strftime('%Y-%m-%d')


def _pack_id_from_summary_doc(uid, doc, data):
    pack_id = study_progress.sanitize_pack_id(data.get('pack_id', ''), runtime=None)
    if pack_id:
        return pack_id
    doc_id = str(getattr(doc, 'id', '') or '')
    prefix = f'{uid}__'
    if doc_id.startswith(prefix):
        return study_progress.sanitize_pack_id(doc_id[len(prefix):], runtime=None)
    return ''


def _card_state_summary(state, app_ctx):
    due_by_date = {}
    for card_id, entry in (state or {}).items():
        if not str(card_id).startswith('fc_'):
            continue
        if not study_progress.card_entry_has_interaction(entry, runtime=app_ctx):
            continue
        due_date = study_progress.sanitize_progress_date(
            (entry or {}).get('next_review_date', ''),
            runtime=app_ctx,
        ) or UNSCHEDULED_DUE_DATE
        due_by_date[due_date] = due_by_date.get(due_date, 0) + 1
    return {'due_by_date': due_by_date}


def _sanitize_due_by_date(raw_value, app_ctx):
    if not isinstance(raw_value, dict):
        return {}
    due_by_date = {}
    for raw_due_date, raw_count in raw_value.items():
        due_date = study_progress.sanitize_progress_date(raw_due_date, runtime=app_ctx)
        if not due_date:
            continue
        count = study_progress.sanitize_int(
            raw_count,
            default=0,
            min_value=0,
            max_value=100000,
            runtime=app_ctx,
        )
        if count > 0:
            due_by_date[due_date] = due_by_date.get(due_date, 0) + count
    return due_by_date


def _due_by_date_from_summary(summary_payload, app_ctx):
    if not isinstance(summary_payload, dict):
        return {}
    return _sanitize_due_by_date(summary_payload.get('due_by_date'), app_ctx)


def _apply_due_by_date_delta(base, *, subtract=None, add=None):
    next_rollup = dict(base or {})
    for due_date, count in (subtract or {}).items():
        next_count = max(0, int(next_rollup.get(due_date, 0) or 0) - int(count or 0))
        if next_count:
            next_rollup[due_date] = next_count
        else:
            next_rollup.pop(due_date, None)
    for due_date, count in (add or {}).items():
        next_count = int(count or 0)
        if next_count > 0:
            next_rollup[due_date] = int(next_rollup.get(due_date, 0) or 0) + next_count
    return next_rollup


def _due_count_from_due_by_date(due_by_date, today_local, app_ctx):
    due_today = 0
    for raw_due_date, raw_count in (due_by_date or {}).items():
        due_date = study_progress.sanitize_progress_date(raw_due_date, runtime=app_ctx)
        if not due_date or due_date > today_local:
            continue
        due_today += study_progress.sanitize_int(
            raw_count,
            default=0,
            min_value=0,
            max_value=100000,
            runtime=app_ctx,
        )
    return due_today


def _summary_with_due_count(progress_data, due_today, app_ctx):
    summary = study_progress.compute_study_progress_summary(progress_data, [], runtime=app_ctx)
    summary['due_today'] = max(0, int(due_today or 0))
    return summary


def _get_owned_pack_or_response(app_ctx, uid, pack_id):
    pack_result, error_response, status = study_api_support.get_owned_study_pack(app_ctx, uid, pack_id)
    if error_response is not None:
        return None, error_response, status
    return pack_result, None, None


def _pack_is_owned(app_ctx, uid, pack_id):
    pack_result, _error_response, _status = _get_owned_pack_or_response(app_ctx, uid, pack_id)
    return pack_result is not None


def get_study_progress(app_ctx, request):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    try:
        progress_data = _complete_progress_data(app_ctx, uid)
        daily_goal = study_progress.sanitize_daily_goal_value(progress_data.get('daily_goal'), runtime=app_ctx)
        if daily_goal is None:
            daily_goal = 20
        streak_data = study_progress.sanitize_streak_data(progress_data.get('streak_data', {}), runtime=app_ctx)
        timezone = str(progress_data.get('timezone', '') or '').strip()[:80]

        card_states = {}
        docs = app_ctx.repositories.study.list_study_card_states_by_uid(app_ctx.db, uid, app_ctx.MAX_PROGRESS_PACKS_PER_SYNC)
        for doc in docs:
            data = doc.to_dict() or {}
            pack_id = study_progress.sanitize_pack_id(data.get('pack_id', ''), runtime=app_ctx)
            if not pack_id:
                continue
            state_map = study_progress.sanitize_card_state_map(data.get('state', {}), runtime=app_ctx)
            card_states[pack_id] = state_map

        return app_ctx.jsonify({
            'daily_goal': daily_goal,
            'streak_data': streak_data,
            'timezone': study_progress.sanitize_timezone_name(timezone, runtime=app_ctx),
            'card_states': card_states,
            'summary': _summary_with_due_count(progress_data, _due_count_from_due_by_date(
                progress_data[CARD_STATE_DUE_ROLLUP_KEY], _local_today(progress_data, app_ctx), app_ctx,
            ), app_ctx),
        })
    except account_lifecycle.AccountUnavailableError:
        return study_api_support.account_unavailable_response(app_ctx)
    except Exception as error:
        app_ctx.logger.error(f"Error fetching study progress for user {uid}: {error}")
        return app_ctx.jsonify({'error': 'Could not load study progress'}), 500


def get_study_progress_pack(app_ctx, request, pack_id):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    safe_pack_id = study_progress.sanitize_pack_id(pack_id, runtime=app_ctx)
    if not safe_pack_id:
        return app_ctx.jsonify({'error': 'Invalid pack id'}), 400
    try:
        _pack_result, error_response, status = _get_owned_pack_or_response(app_ctx, uid, safe_pack_id)
        if error_response is not None:
            return error_response, status
        progress_doc = app_ctx.get_study_progress_doc(uid).get()
        progress_data = progress_doc.to_dict() if progress_doc.exists else {}
        card_doc = app_ctx.get_study_card_state_doc(uid, safe_pack_id).get()
        state_map = {}
        if card_doc.exists:
            data = card_doc.to_dict() or {}
            state_map = study_progress.sanitize_card_state_map(data.get('state', {}), runtime=app_ctx)
        return app_ctx.jsonify({
            'daily_goal': study_progress.sanitize_daily_goal_value(progress_data.get('daily_goal'), runtime=app_ctx) or 20,
            'streak_data': study_progress.sanitize_streak_data(progress_data.get('streak_data', {}), runtime=app_ctx),
            'timezone': study_progress.sanitize_timezone_name(str(progress_data.get('timezone', '') or '').strip()[:80], runtime=app_ctx),
            'card_states': {safe_pack_id: state_map},
            'summary': study_progress.compute_study_progress_summary(progress_data, [state_map], runtime=app_ctx),
        })
    except Exception as error:
        app_ctx.logger.error(f"Error fetching study progress for user {uid} pack {safe_pack_id}: {error}")
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
        daily_goal = None
        if 'daily_goal' in payload:
            daily_goal = study_progress.sanitize_daily_goal_value(payload.get('daily_goal'), runtime=app_ctx)
            if daily_goal is None:
                return app_ctx.jsonify({'error': 'daily_goal must be between 1 and 500'}), 400

        remove_pack_ids = payload.get('remove_pack_ids')
        sanitized_remove_pack_ids = []
        if remove_pack_ids is not None:
            if not isinstance(remove_pack_ids, list):
                return app_ctx.jsonify({'error': 'remove_pack_ids must be a list'}), 400
            for raw_pack_id in remove_pack_ids[:app_ctx.MAX_PROGRESS_PACKS_PER_SYNC]:
                pack_id = study_progress.sanitize_pack_id(raw_pack_id, runtime=app_ctx)
                if pack_id and pack_id not in sanitized_remove_pack_ids:
                    sanitized_remove_pack_ids.append(pack_id)
        remove_pack_id_set = set(sanitized_remove_pack_ids)

        card_states = payload.get('card_states')
        if card_states is not None and not isinstance(card_states, dict):
            return app_ctx.jsonify({'error': 'card_states must be an object'}), 400

        validated_states = []
        requested_pack_ids = set(remove_pack_id_set)
        for raw_pack_id, raw_state in (card_states or {}).items():
            if len(validated_states) >= app_ctx.MAX_PROGRESS_PACKS_PER_SYNC:
                break
            pack_id = study_progress.sanitize_pack_id(raw_pack_id, runtime=app_ctx)
            if not pack_id:
                continue
            requested_pack_ids.add(pack_id)
            cleaned_state = study_progress.sanitize_card_state_map(raw_state, runtime=app_ctx)
            if cleaned_state and pack_id not in remove_pack_id_set:
                validated_states.append((pack_id, cleaned_state))

        for pack_id in sorted(requested_pack_ids):
            _pack_result, ownership_error, ownership_status = _get_owned_pack_or_response(app_ctx, uid, pack_id)
            if ownership_error is not None:
                return ownership_error, ownership_status

        progress_ref = app_ctx.get_study_progress_doc(uid)
        now_ts = app_ctx.time.time()

        def _build_mutations(transaction=None):
            account_lifecycle.require_account_access(uid, runtime=app_ctx, transaction=transaction)
            # Ownership must be checked in the same transaction as progress:
            # otherwise a concurrent pack deletion can resurrect its state.
            if transaction is not None:
                for pack_id in sorted(requested_pack_ids):
                    _assert_pack_owner(app_ctx, uid, pack_id, transaction)
            existing_progress_doc = _read_doc(progress_ref, transaction)
            existing_progress_data = existing_progress_doc.to_dict() if existing_progress_doc.exists else {}
            updates = {'uid': uid, 'updated_at': now_ts}
            if daily_goal is not None:
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

            due_rollup_changed = bool(remove_pack_id_set) or not _has_complete_due_rollup(existing_progress_data)
            due_rollup = _due_rollup_for_progress(app_ctx, uid, existing_progress_data, transaction)
            card_state_writes = []
            state_docs = {}
            for pack_id, _cleaned_state in validated_states:
                doc_ref = app_ctx.get_study_card_state_doc(uid, pack_id)
                state_docs[pack_id] = (doc_ref, _read_doc(doc_ref, transaction))
            for pack_id in remove_pack_id_set:
                if pack_id in state_docs:
                    continue
                doc_ref = app_ctx.get_study_card_state_doc(uid, pack_id)
                state_docs[pack_id] = (doc_ref, _read_doc(doc_ref, transaction))

            for pack_id, cleaned_state in validated_states:
                doc_ref, existing_pack_doc = state_docs[pack_id]
                existing_pack_state = {}
                existing_due_by_date = {}
                if existing_pack_doc.exists:
                    existing_pack_data = existing_pack_doc.to_dict() or {}
                    existing_pack_state = study_progress.sanitize_card_state_map(
                        existing_pack_data.get('state', {}),
                        runtime=app_ctx,
                    )
                    existing_due_by_date = _card_state_summary(existing_pack_state, app_ctx)['due_by_date']
                merged_state = study_progress.merge_card_state_maps(
                    existing_pack_state,
                    cleaned_state,
                    runtime=app_ctx,
                )
                next_summary = _card_state_summary(merged_state, app_ctx)
                next_due_by_date = _due_by_date_from_summary(next_summary, app_ctx)
                due_rollup = _apply_due_by_date_delta(
                    due_rollup,
                    subtract=existing_due_by_date,
                    add=next_due_by_date,
                )
                due_rollup_changed = True
                card_state_writes.append((doc_ref, {
                    'uid': uid,
                    'pack_id': pack_id,
                    'state': merged_state,
                    'summary': next_summary,
                    'updated_at': now_ts,
                }))

            for pack_id in remove_pack_id_set:
                _doc_ref, existing_pack_doc = state_docs[pack_id]
                if not existing_pack_doc.exists:
                    continue
                existing_pack_data = existing_pack_doc.to_dict() or {}
                existing_pack_state = study_progress.sanitize_card_state_map(
                    existing_pack_data.get('state', {}), runtime=app_ctx,
                )
                existing_due_by_date = _card_state_summary(existing_pack_state, app_ctx)['due_by_date']
                due_rollup = _apply_due_by_date_delta(due_rollup, subtract=existing_due_by_date)

            if due_rollup_changed:
                updates.update(_rollup_updates(uid, due_rollup, app_ctx))
            return updates, card_state_writes

        transactional = getattr(getattr(app_ctx, 'firestore', None), 'transactional', None)
        transaction_factory = getattr(app_ctx.db, 'transaction', None)
        if callable(transactional) and callable(transaction_factory):
            @transactional
            def _write_in_transaction(transaction):
                updates, card_state_writes = _build_mutations(transaction)
                transaction.set(progress_ref, updates, merge=list(updates))
                for doc_ref, doc_payload in card_state_writes:
                    transaction.set(doc_ref, doc_payload, merge=list(doc_payload))
                for pack_id in sanitized_remove_pack_ids:
                    transaction.delete(app_ctx.get_study_card_state_doc(uid, pack_id))

            _write_in_transaction(transaction_factory())
        else:
            updates, card_state_writes = _build_mutations()
            if callable(getattr(app_ctx.db, 'batch', None)):
                batch = app_ctx.db.batch()
                batch.set(progress_ref, updates, merge=list(updates))
                for doc_ref, doc_payload in card_state_writes:
                    batch.set(doc_ref, doc_payload, merge=list(doc_payload))
                for pack_id in sanitized_remove_pack_ids:
                    batch.delete(app_ctx.get_study_card_state_doc(uid, pack_id))
                batch.commit()
            else:
                progress_ref.set(updates, merge=list(updates))
                for doc_ref, doc_payload in card_state_writes:
                    doc_ref.set(doc_payload, merge=list(doc_payload))
                for pack_id in sanitized_remove_pack_ids:
                    app_ctx.get_study_card_state_doc(uid, pack_id).delete()

        return app_ctx.jsonify({'ok': True})
    except ProgressPackUnavailable as error:
        return app_ctx.jsonify({'error': str(error)}), error.status
    except account_lifecycle.AccountUnavailableError:
        return study_api_support.account_unavailable_response(app_ctx)
    except Exception as error:
        app_ctx.logger.error(f"Error updating study progress for user {uid}: {error}")
        return app_ctx.jsonify({'error': 'Could not save study progress'}), 500


def load_study_progress_summary(app_ctx, uid):
    """Use the same complete due total for Dashboard and Study Plan."""
    progress_data = _complete_progress_data(app_ctx, uid)
    due_today = _due_count_from_due_by_date(
        progress_data[CARD_STATE_DUE_ROLLUP_KEY], _local_today(progress_data, app_ctx), app_ctx,
    )
    return _summary_with_due_count(progress_data, due_today, app_ctx)


def get_study_progress_summary(app_ctx, request):
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    try:
        if request is not None and request.args.get('scope') == 'active_plan':
            account_lifecycle.require_account_access(uid, runtime=app_ctx)
            doc = app_ctx.get_study_progress_doc(uid).get()
            progress = doc.to_dict() or {} if doc.exists else {}
            due = load_due_study_cards(app_ctx, uid, active_plan=True)
            summary = _summary_with_due_count(progress, due['due_count'], app_ctx)
            summary['active_plan_pack_ids'] = sorted(active_plan_pack_ids(app_ctx, uid))
            return app_ctx.jsonify(summary)
        return app_ctx.jsonify(load_study_progress_summary(app_ctx, uid))
    except account_lifecycle.AccountUnavailableError:
        return study_api_support.account_unavailable_response(app_ctx)
    except Exception as error:
        app_ctx.logger.error(f"Error fetching study progress summary for user {uid}: {error}")
        return app_ctx.jsonify({'error': 'Could not load study progress summary'}), 500


def active_plan_pack_ids(app_ctx, uid):
    goals = app_ctx.repositories.planner.list_active_study_goals_by_uid(app_ctx.db, uid)
    return {str(pack_id) for goal in goals if goal.get('uid') == uid and goal.get('status', 'active') == 'active'
            for pack_id in goal.get('pack_ids', []) if isinstance(pack_id, str)}


def load_due_study_cards(app_ctx, uid, *, active_plan=False):
    progress_doc = app_ctx.get_study_progress_doc(uid).get()
    today = _local_today(progress_doc.to_dict() or {} if progress_doc.exists else {}, app_ctx)
    active_ids = active_plan_pack_ids(app_ctx, uid) if active_plan else None
    if active_ids == set():
        return {'date': today, 'due_count': 0, 'packs': []}
    packs = []
    candidates = {}
    if active_ids is not None:
        docs = (app_ctx.repositories.study.get_study_card_state_docs(app_ctx.db, uid, active_ids) if app_ctx.db is not None
                else [app_ctx.get_study_card_state_doc(uid, pack_id).get() for pack_id in active_ids]) if active_ids else []
    else:
        docs = app_ctx.repositories.study.list_all_study_card_states_by_uid(app_ctx.db, uid)
    for doc in docs:
        data = doc.to_dict() or {}
        pack_id = _pack_id_from_summary_doc(uid, doc, data)
        if data.get('uid') != uid or not pack_id or (active_ids is not None and pack_id not in active_ids):
            continue
        state = study_progress.sanitize_card_state_map(data.get('state', {}), runtime=app_ctx)
        if any(card_id.startswith('fc_') and study_progress.card_entry_has_interaction(entry, runtime=app_ctx)
               and str(entry.get('next_review_date') or UNSCHEDULED_DUE_DATE) <= today
               for card_id, entry in state.items()):
            candidates[pack_id] = state
    for pack_doc in app_ctx.repositories.study.get_study_pack_docs(app_ctx.db, candidates):
        pack_id = pack_doc.id
        pack = (pack_doc.to_dict() or {}) if pack_doc.exists else {}
        if pack.get('uid') != uid or pack.get('archived'):
            continue
        state = candidates[pack_id]
        cards = []
        for index, card in enumerate(pack.get('flashcards') or []):
            entry = state.get(f'fc_{index}') or {}
            if not study_progress.card_entry_has_interaction(entry, runtime=app_ctx):
                continue
            due = str(entry.get('next_review_date') or UNSCHEDULED_DUE_DATE)
            if due > today:
                continue
            cards.append({'id': f'fc_{index}', 'index': index,
                          'front': str(card.get('front') or f'Card {index + 1}')[:300],
                          'due_date': due})
        if cards:
            cards.sort(key=lambda card: (card['due_date'], card['index']))
            packs.append({'study_pack_id': pack_id, 'title': pack.get('title') or 'Untitled pack',
                          'due_count': len(cards), 'cards': cards})
    packs.sort(key=lambda pack: (pack['cards'][0]['due_date'], pack['title'].casefold()))
    return {'date': today, 'due_count': sum(pack['due_count'] for pack in packs), 'packs': packs}

def get_due_study_cards(app_ctx, request):
    """Resolve the complete owned due queue to real, currently available cards."""
    decoded_token, error_response, status = study_api_support.require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    try:
        account_lifecycle.require_account_access(uid, runtime=app_ctx)
        return app_ctx.jsonify(load_due_study_cards(app_ctx, uid, active_plan=request is not None and request.args.get('scope') == 'active_plan'))
    except account_lifecycle.AccountUnavailableError:
        return study_api_support.account_unavailable_response(app_ctx)
    except Exception as error:
        app_ctx.logger.error(f"Error fetching due cards for user {uid}: {error}")
        return app_ctx.jsonify({'error': 'Could not load due cards. Please try again.'}), 500
