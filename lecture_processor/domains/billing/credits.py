import hashlib

from lecture_processor.runtime.container import get_runtime

CREDIT_CATEGORIES = ('lecture', 'slides', 'interview')

CATEGORY_CREDIT_FIELDS = {
    'lecture': ('lecture_credits_standard', 'lecture_credits_extended'),
    'slides': ('slides_credits',),
    'interview': ('interview_credits_short', 'interview_credits_medium', 'interview_credits_long'),
}

PRIMARY_CATEGORY_CREDIT_FIELD = {
    'lecture': 'lecture_credits_standard',
    'slides': 'slides_credits',
    'interview': 'interview_credits_short',
}

CREDIT_FIELD_CATEGORY = {
    credit_field: category
    for category, credit_fields in CATEGORY_CREDIT_FIELDS.items()
    for credit_field in credit_fields
}


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def normalize_email(email):
    return str(email or '').strip().lower()


def default_unlimited_credits():
    return {category: False for category in CREDIT_CATEGORIES}


def normalize_unlimited_credits(value):
    payload = value if isinstance(value, dict) else {}
    return {category: bool(payload.get(category, False)) for category in CREDIT_CATEGORIES}


def credit_category_for_field(credit_type):
    return CREDIT_FIELD_CATEGORY.get(str(credit_type or '').strip(), '')


def is_configured_admin_identity(uid='', email='', decoded_token=None, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if decoded_token and resolved_runtime.is_admin_user(decoded_token):
        return True
    safe_uid = str(uid or '').strip()
    safe_email = normalize_email(email)
    admin_uids = getattr(resolved_runtime, 'ADMIN_UIDS', set()) or set()
    admin_emails = getattr(resolved_runtime, 'ADMIN_EMAILS', set()) or set()
    if safe_uid and safe_uid in admin_uids:
        return True
    return bool(safe_email and safe_email in admin_emails)


def effective_unlimited_credits(user_data, decoded_token=None, runtime=None):
    user = user_data if isinstance(user_data, dict) else {}
    uid = str(user.get('uid', '') or (decoded_token or {}).get('uid', '') or '').strip()
    email = normalize_email((decoded_token or {}).get('email', '') or user.get('email', ''))
    if is_configured_admin_identity(uid=uid, email=email, decoded_token=decoded_token, runtime=runtime):
        return {category: True for category in CREDIT_CATEGORIES}
    return normalize_unlimited_credits(user.get('unlimited_credits'))


def is_unlimited_for_category(user_data, category, decoded_token=None, runtime=None):
    normalized_category = str(category or '').strip()
    if normalized_category not in CREDIT_CATEGORIES:
        return False
    return bool(effective_unlimited_credits(user_data, decoded_token=decoded_token, runtime=runtime).get(normalized_category))


def is_unlimited_for_credit_type(user_data, credit_type, decoded_token=None, runtime=None):
    category = credit_category_for_field(credit_type)
    return bool(category and is_unlimited_for_category(user_data, category, decoded_token=decoded_token, runtime=runtime))


def category_credit_total(user_data, category):
    user = user_data if isinstance(user_data, dict) else {}
    return sum(int(user.get(field, 0) or 0) for field in CATEGORY_CREDIT_FIELDS.get(category, ()))


def has_category_credit(user_data, category, amount=1, decoded_token=None, runtime=None):
    try:
        needed = max(0, int(amount or 0))
    except Exception:
        needed = 1
    if needed <= 0:
        return True
    if is_unlimited_for_category(user_data, category, decoded_token=decoded_token, runtime=runtime):
        return True
    return category_credit_total(user_data, category) >= needed


def build_credit_payload(user_data, decoded_token=None, runtime=None):
    user = user_data if isinstance(user_data, dict) else {}
    unlimited = effective_unlimited_credits(user, decoded_token=decoded_token, runtime=runtime)
    return {
        'lecture_standard': int(user.get('lecture_credits_standard', 0) or 0),
        'lecture_extended': int(user.get('lecture_credits_extended', 0) or 0),
        'slides': int(user.get('slides_credits', 0) or 0),
        'interview_short': int(user.get('interview_credits_short', 0) or 0),
        'interview_medium': int(user.get('interview_credits_medium', 0) or 0),
        'interview_long': int(user.get('interview_credits_long', 0) or 0),
        'unlimited': unlimited,
    }


def build_category_summary(user_data, decoded_token=None, runtime=None):
    user = user_data if isinstance(user_data, dict) else {}
    unlimited = effective_unlimited_credits(user, decoded_token=decoded_token, runtime=runtime)
    return {
        'lecture': category_credit_total(user, 'lecture'),
        'slides': category_credit_total(user, 'slides'),
        'interview': category_credit_total(user, 'interview'),
        'total': (
            category_credit_total(user, 'lecture')
            + category_credit_total(user, 'slides')
            + category_credit_total(user, 'interview')
        ),
        'unlimited': unlimited,
    }


def build_default_user_data(uid, email, runtime=None):
    runtime = _resolve_runtime(runtime)
    normalized_email = normalize_email(email)
    return {
        'uid': uid,
        'email': email,
        'email_normalized': normalized_email,
        'lecture_credits_standard': runtime.FREE_LECTURE_CREDITS,
        'lecture_credits_extended': 0,
        'slides_credits': runtime.FREE_SLIDES_CREDITS,
        'interview_credits_short': runtime.FREE_INTERVIEW_CREDITS,
        'interview_credits_medium': 0,
        'interview_credits_long': 0,
        'unlimited_credits': default_unlimited_credits(),
        'total_processed': 0,
        'has_created_study_pack': False,
        'created_at': runtime.time.time(),
        'preferred_output_language': runtime.DEFAULT_OUTPUT_LANGUAGE_KEY,
        'preferred_output_language_custom': '',
        'onboarding_completed': False,
        'account_status': 'active',
        'delete_requested_at': 0,
        'delete_started_at': 0,
        'last_delete_failure_at': 0,
        'last_delete_failure_reason': '',
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
        user_ref.set(build_default_user_data(uid, '', runtime=resolved_runtime))

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
        if str(data.get('account_status', '') or '').strip().lower() == 'deleting':
            return None
        if is_unlimited_for_credit_type(data, credit_type_primary, runtime=resolved_runtime):
            transaction.update(user_ref, {
                'total_processed': resolved_runtime.firestore.Increment(1),
                'last_unlimited_credit_used_at': resolved_runtime.time.time(),
            })
            return credit_type_primary
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
        if str(data.get('account_status', '') or '').strip().lower() == 'deleting':
            return None
        if is_unlimited_for_category(data, 'interview', runtime=resolved_runtime):
            transaction.update(user_ref, {
                'total_processed': resolved_runtime.firestore.Increment(1),
                'last_unlimited_credit_used_at': resolved_runtime.time.time(),
            })
            return PRIMARY_CATEGORY_CREDIT_FIELD['interview']
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


def _refund_ledger_ref(db, uid, idempotency_key):
    digest = hashlib.sha256(f'{uid}:{idempotency_key}'.encode('utf-8')).hexdigest()
    return db.collection('credit_refunds').document(digest)


def _apply_idempotent_refund(
    uid,
    credit_type,
    target_amount,
    idempotency_key,
    *,
    adjust_total_processed,
    runtime=None,
):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is None or not hasattr(db, 'transaction'):
        resolved_runtime.logger.error('Cannot apply idempotent credit refund without a Firestore transaction.')
        return False
    try:
        target_amount = max(0, int(target_amount or 0))
    except Exception:
        return False
    if not uid or not credit_type or target_amount <= 0 or not idempotency_key:
        return False

    user_ref = resolved_runtime.users_repo.doc_ref(db, uid)
    ledger_ref = _refund_ledger_ref(db, uid, idempotency_key)
    now_ts = float(resolved_runtime.time.time())

    @resolved_runtime.firestore.transactional
    def _refund(txn):
        ledger_snapshot = ledger_ref.get(transaction=txn)
        ledger_data = ledger_snapshot.to_dict() or {} if getattr(ledger_snapshot, 'exists', False) else {}
        previous_amount = max(0, int(ledger_data.get('amount', 0) or 0))
        if previous_amount >= target_amount:
            return True

        user_snapshot = user_ref.get(transaction=txn)
        if not getattr(user_snapshot, 'exists', False):
            return False
        user_data = user_snapshot.to_dict() or {}
        delta = target_amount - previous_amount
        updates = {}
        if not is_unlimited_for_credit_type(user_data, credit_type, runtime=resolved_runtime):
            updates[credit_type] = resolved_runtime.firestore.Increment(delta)
        if adjust_total_processed:
            updates['total_processed'] = resolved_runtime.firestore.Increment(-delta)
        if updates:
            txn.update(user_ref, updates)
        txn.set(
            ledger_ref,
            {
                'key_hash': hashlib.sha256(str(idempotency_key).encode('utf-8')).hexdigest(),
                'uid_hash': hashlib.sha256(str(uid).encode('utf-8')).hexdigest(),
                'credit_type': str(credit_type),
                'amount': target_amount,
                'updated_at': now_ts,
            },
            merge=True,
        )
        return True

    try:
        return bool(_refund(db.transaction()))
    except Exception:
        resolved_runtime.logger.error(
            "Failed idempotent refund for user %s and credit '%s'",
            uid,
            credit_type,
            exc_info=True,
        )
        return False


def refund_credit(uid, credit_type, runtime=None, *, idempotency_key=''):
    resolved_runtime = _resolve_runtime(runtime)
    if not uid or not credit_type:
        return False

    if idempotency_key:
        refunded = _apply_idempotent_refund(
            uid,
            credit_type,
            1,
            idempotency_key,
            adjust_total_processed=True,
            runtime=resolved_runtime,
        )
        if refunded:
            resolved_runtime.logger.info("Refunded '%s' idempotently for user %s.", credit_type, uid)
        return refunded

    try:
        user_doc = resolved_runtime.users_repo.get_doc(resolved_runtime.db, uid)
    except Exception:
        user_doc = None
    if user_doc is not None and not getattr(user_doc, 'exists', False):
        resolved_runtime.logger.warning("Skipping refund for credit '%s' on missing user document: %s", credit_type, uid)
        return False

    try:
        data = user_doc.to_dict() if user_doc is not None and getattr(user_doc, 'exists', False) else {}
        if is_unlimited_for_credit_type(data, credit_type, runtime=resolved_runtime):
            updates = {'total_processed': resolved_runtime.firestore.Increment(-1)}
        else:
            updates = {
                credit_type: resolved_runtime.firestore.Increment(1),
                'total_processed': resolved_runtime.firestore.Increment(-1),
            }
        resolved_runtime.users_repo.update_doc(resolved_runtime.db, uid, updates)
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
        if str(data.get('account_status', '') or '').strip().lower() == 'deleting':
            return False
        if is_unlimited_for_category(data, 'slides', runtime=resolved_runtime):
            transaction.update(user_ref, {'last_unlimited_credit_used_at': resolved_runtime.time.time()})
            return True
        current = data.get('slides_credits', 0)
        if current < amount:
            return False
        transaction.update(user_ref, {'slides_credits': resolved_runtime.firestore.Increment(-amount)})
        return True

    user_ref = resolved_runtime.users_repo.doc_ref(resolved_runtime.db, uid)
    transaction = resolved_runtime.db.transaction()
    return _deduct_in_transaction(transaction, user_ref)


def refund_slides_credits(uid, amount, runtime=None, *, idempotency_key='', idempotency_total=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not uid or amount <= 0:
        return False
    if idempotency_key:
        target_amount = amount if idempotency_total is None else idempotency_total
        refunded = _apply_idempotent_refund(
            uid,
            'slides_credits',
            target_amount,
            idempotency_key,
            adjust_total_processed=False,
            runtime=resolved_runtime,
        )
        if refunded:
            resolved_runtime.logger.info('Refunded slides credits idempotently for user %s.', uid)
        return refunded
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
        data = user_doc.to_dict() if user_doc is not None and getattr(user_doc, 'exists', False) else {}
        if is_unlimited_for_category(data, 'slides', runtime=resolved_runtime):
            resolved_runtime.logger.info("✅ Recorded no-op refund for %s unlimited slides credits to user %s.", amount, uid)
            return True
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
