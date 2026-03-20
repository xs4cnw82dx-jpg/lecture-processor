from lecture_processor.runtime.container import get_runtime
from lecture_processor.domains.billing import credits as billing_credits


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def build_default_user_data(uid, email, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    return billing_credits.build_default_user_data(uid, email, runtime=resolved_runtime)


def get_or_create_user(uid, email, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    user_ref = resolved_runtime.users_repo.doc_ref(resolved_runtime.db, uid)
    user_doc = user_ref.get()
    if user_doc.exists:
        user_data = user_doc.to_dict()
        updates = {}
        if user_data.get('email') != email and email:
            updates['email'] = email

        preferred_key = resolved_runtime.sanitize_output_language_pref_key(
            user_data.get('preferred_output_language', resolved_runtime.DEFAULT_OUTPUT_LANGUAGE_KEY),
        )
        preferred_custom = resolved_runtime.sanitize_output_language_pref_custom(
            user_data.get('preferred_output_language_custom', ''),
        )
        if preferred_key != str(user_data.get('preferred_output_language', '') or '').strip().lower():
            updates['preferred_output_language'] = preferred_key
        if preferred_key != 'other':
            preferred_custom = ''
        if preferred_custom != str(user_data.get('preferred_output_language_custom', '') or '').strip():
            updates['preferred_output_language_custom'] = preferred_custom
        if not isinstance(user_data.get('onboarding_completed'), bool):
            updates['onboarding_completed'] = False
        if not isinstance(user_data.get('has_created_study_pack'), bool):
            updates['has_created_study_pack'] = bool(user_data.get('total_processed', 0))
        if str(user_data.get('account_status', '') or '').strip().lower() not in {'active', 'deleting'}:
            updates['account_status'] = 'active'
        if 'delete_requested_at' not in user_data:
            updates['delete_requested_at'] = 0
        if 'delete_started_at' not in user_data:
            updates['delete_started_at'] = 0
        if 'last_delete_failure_at' not in user_data:
            updates['last_delete_failure_at'] = 0
        if 'last_delete_failure_reason' not in user_data:
            updates['last_delete_failure_reason'] = ''
        if updates:
            user_ref.update(updates)
            user_data.update(updates)
        return user_data

    user_data = build_default_user_data(uid, email, runtime=resolved_runtime)
    user_ref.set(user_data)
    resolved_runtime.logger.info('New user created: %s (%s)', uid, email)
    return user_data
