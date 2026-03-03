from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _build_default_user_data(uid, email, runtime):
    return {
        'uid': uid,
        'email': email,
        'lecture_credits_standard': runtime.FREE_LECTURE_CREDITS,
        'lecture_credits_extended': 0,
        'slides_credits': runtime.FREE_SLIDES_CREDITS,
        'interview_credits_short': runtime.FREE_INTERVIEW_CREDITS,
        'interview_credits_medium': 0,
        'interview_credits_long': 0,
        'total_processed': 0,
        'created_at': runtime.time.time(),
        'preferred_output_language': runtime.DEFAULT_OUTPUT_LANGUAGE_KEY,
        'preferred_output_language_custom': '',
        'onboarding_completed': False,
    }


def grant_credits_to_user(uid, bundle_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    bundle = resolved_runtime.CREDIT_BUNDLES.get(bundle_id)
    if not bundle:
        resolved_runtime.logger.warning("Warning: Unknown bundle_id '%s' in grant_credits_to_user", bundle_id)
        return False

    user_ref = resolved_runtime.users_repo.doc_ref(resolved_runtime.db, uid)
    user_doc = user_ref.get()
    if not user_doc.exists:
        user_ref.set(_build_default_user_data(uid, '', resolved_runtime))

    for credit_key, credit_amount in bundle['credits'].items():
        user_ref.update({credit_key: resolved_runtime.firestore.Increment(credit_amount)})
        resolved_runtime.logger.info("Granted %s '%s' credits to user %s.", credit_amount, credit_key, uid)
    return True


def deduct_credit(uid, credit_type_primary, credit_type_fallback=None, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)

    @resolved_runtime.firestore.transactional
    def _deduct_in_transaction(transaction, user_ref):
        snapshot = user_ref.get(transaction=transaction)
        if not snapshot.exists:
            return None
        data = snapshot.to_dict()
        if data.get(credit_type_primary, 0) > 0:
            transaction.update(user_ref, {
                credit_type_primary: resolved_runtime.firestore.Increment(-1),
                'total_processed': resolved_runtime.firestore.Increment(1),
            })
            return credit_type_primary
        if credit_type_fallback and data.get(credit_type_fallback, 0) > 0:
            transaction.update(user_ref, {
                credit_type_fallback: resolved_runtime.firestore.Increment(-1),
                'total_processed': resolved_runtime.firestore.Increment(1),
            })
            return credit_type_fallback
        return None

    user_ref = resolved_runtime.users_repo.doc_ref(resolved_runtime.db, uid)
    transaction = resolved_runtime.db.transaction()
    return _deduct_in_transaction(transaction, user_ref)


def deduct_interview_credit(uid, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)

    @resolved_runtime.firestore.transactional
    def _deduct_in_transaction(transaction, user_ref):
        snapshot = user_ref.get(transaction=transaction)
        if not snapshot.exists:
            return None
        data = snapshot.to_dict()
        for credit_type in ('interview_credits_short', 'interview_credits_medium', 'interview_credits_long'):
            if data.get(credit_type, 0) > 0:
                transaction.update(user_ref, {
                    credit_type: resolved_runtime.firestore.Increment(-1),
                    'total_processed': resolved_runtime.firestore.Increment(1),
                })
                return credit_type
        return None

    user_ref = resolved_runtime.users_repo.doc_ref(resolved_runtime.db, uid)
    transaction = resolved_runtime.db.transaction()
    return _deduct_in_transaction(transaction, user_ref)


def refund_credit(uid, credit_type, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not uid or not credit_type:
        return False

    try:
        user_doc = resolved_runtime.users_repo.get_doc(resolved_runtime.db, uid)
    except Exception:
        user_doc = None
    if user_doc is not None and not getattr(user_doc, 'exists', False):
        resolved_runtime.logger.warning("Skipping refund for credit '%s' on missing user document: %s", credit_type, uid)
        return False

    try:
        resolved_runtime.users_repo.update_doc(
            resolved_runtime.db,
            uid,
            {
                credit_type: resolved_runtime.firestore.Increment(1),
                'total_processed': resolved_runtime.firestore.Increment(-1),
            },
        )
        resolved_runtime.logger.info("✅ Refunded 1 '%s' credit to user %s due to processing failure.", credit_type, uid)
        return True
    except Exception as error:
        if 'No document to update' in str(error or ''):
            resolved_runtime.logger.warning("Skipping refund for credit '%s' on missing user document: %s", credit_type, uid)
            return False
        resolved_runtime.logger.error("❌ Failed to refund credit '%s' to user %s: %s", credit_type, uid, error)
        return False


def deduct_slides_credits(uid, amount, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if amount <= 0:
        return True

    @resolved_runtime.firestore.transactional
    def _deduct_in_transaction(transaction, user_ref):
        snapshot = user_ref.get(transaction=transaction)
        if not snapshot.exists:
            return False
        data = snapshot.to_dict()
        current = data.get('slides_credits', 0)
        if current < amount:
            return False
        transaction.update(user_ref, {'slides_credits': resolved_runtime.firestore.Increment(-amount)})
        return True

    user_ref = resolved_runtime.users_repo.doc_ref(resolved_runtime.db, uid)
    transaction = resolved_runtime.db.transaction()
    return _deduct_in_transaction(transaction, user_ref)


def refund_slides_credits(uid, amount, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not uid or amount <= 0:
        return False
    try:
        user_doc = resolved_runtime.users_repo.get_doc(resolved_runtime.db, uid)
    except Exception:
        user_doc = None
    if user_doc is not None and (not getattr(user_doc, 'exists', False)):
        resolved_runtime.logger.warning(
            'Skipping slides credit refund for missing user document: %s (amount=%s)',
            uid,
            amount,
        )
        return False
    try:
        resolved_runtime.users_repo.update_doc(
            resolved_runtime.db,
            uid,
            {'slides_credits': resolved_runtime.firestore.Increment(amount)},
        )
        resolved_runtime.logger.info("✅ Refunded %s slides credits to user %s.", amount, uid)
        return True
    except Exception as error:
        if 'No document to update' in str(error or ''):
            resolved_runtime.logger.warning(
                'Skipping slides credit refund for missing user document: %s (amount=%s)',
                uid,
                amount,
            )
            return False
        resolved_runtime.logger.error("❌ Failed to refund %s slides credits to user %s: %s", amount, uid, error)
        return False
