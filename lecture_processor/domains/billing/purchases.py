from lecture_processor.runtime.container import get_runtime
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.admin import rollups as admin_rollups
from lecture_processor.domains.analytics import events as analytics_events


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _session_created_at(stripe_session, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    created_at = stripe_session.get('created')
    try:
        return float(created_at)
    except Exception:
        return float(resolved_runtime.time.time())


def _customer_email_from_session(stripe_session):
    customer_details = stripe_session.get('customer_details', {}) or {}
    email = customer_details.get('email') or stripe_session.get('customer_email') or ''
    return str(email or '').strip()


def _build_purchase_record(uid, bundle_id, stripe_session_id, *, payment_status, fulfilled_at, created_at, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    bundle = resolved_runtime.CREDIT_BUNDLES.get(bundle_id)
    if not bundle:
        return None
    return {
        'uid': uid,
        'bundle_id': bundle_id,
        'bundle_name': bundle['name'],
        'price_cents': bundle['price_cents'],
        'currency': bundle['currency'],
        'credits': bundle['credits'],
        'stripe_session_id': stripe_session_id,
        'payment_status': str(payment_status or '').strip().lower(),
        'created_at': float(created_at),
        'fulfilled_at': float(fulfilled_at),
    }


def save_purchase_record(uid, bundle_id, stripe_session_id, runtime=None, *, payment_status='paid', fulfilled_at=None, created_at=None):
    resolved_runtime = _resolve_runtime(runtime)
    now_ts = float(resolved_runtime.time.time())
    record = _build_purchase_record(
        uid,
        bundle_id,
        stripe_session_id,
        payment_status=payment_status,
        fulfilled_at=now_ts if fulfilled_at is None else fulfilled_at,
        created_at=now_ts if created_at is None else created_at,
        runtime=resolved_runtime,
    )
    if not record:
        return
    try:
        if stripe_session_id:
            resolved_runtime.purchases_repo.set_doc(resolved_runtime.db, stripe_session_id, record, merge=True)
        else:
            resolved_runtime.purchases_repo.add_doc(resolved_runtime.db, record)
        admin_rollups.increment_purchase_rollups(record, runtime=resolved_runtime)
        resolved_runtime.logger.info("📝 Saved purchase record for user %s: %s", uid, record.get('bundle_name', bundle_id))
    except Exception as error:
        resolved_runtime.logger.error("❌ Failed to save purchase record for user %s: %s", uid, error)


def purchase_record_exists_for_session(stripe_session_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not stripe_session_id:
        return False
    try:
        doc = resolved_runtime.purchases_repo.get_doc(resolved_runtime.db, stripe_session_id)
        if doc.exists:
            return True
        for _ in resolved_runtime.purchases_repo.query_by_session_id(resolved_runtime.db, stripe_session_id, limit=1):
            return True
        return False
    except Exception as error:
        resolved_runtime.logger.warning("⚠️ Could not check purchase record for session %s: %s", stripe_session_id, error)
        return False


def _grant_credits_and_record_purchase_fallback(stripe_session, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    metadata = stripe_session.get('metadata', {}) or {}
    uid = metadata.get('uid', '')
    bundle_id = metadata.get('bundle_id', '')
    stripe_session_id = stripe_session.get('id', '')
    customer_email = _customer_email_from_session(stripe_session)

    try:
        user_doc = resolved_runtime.users_repo.get_doc(resolved_runtime.db, uid)
    except Exception:
        user_doc = None
    if getattr(user_doc, 'exists', False):
        user_data = user_doc.to_dict() or {}
        if str(user_data.get('account_status', '') or '').strip().lower() == 'deleting':
            return (False, 'account_deletion_in_progress')
    elif resolved_runtime.db is not None:
        resolved_runtime.users_repo.set_doc(
            resolved_runtime.db,
            uid,
            billing_credits.build_default_user_data(uid, customer_email, runtime=resolved_runtime),
            merge=True,
        )

    if purchase_record_exists_for_session(stripe_session_id, runtime=resolved_runtime):
        return (True, 'already_processed')

    success = billing_credits.grant_credits_to_user(uid, bundle_id, runtime=resolved_runtime)
    if not success:
        return (False, 'could_not_grant_credits')
    save_purchase_record(
        uid,
        bundle_id,
        stripe_session_id,
        runtime=resolved_runtime,
        payment_status='paid',
        fulfilled_at=resolved_runtime.time.time(),
        created_at=_session_created_at(stripe_session, runtime=resolved_runtime),
    )
    return (True, 'granted')


def _grant_credits_and_record_purchase_atomic(stripe_session, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is None or not hasattr(db, 'transaction'):
        return _grant_credits_and_record_purchase_fallback(stripe_session, runtime=resolved_runtime)

    metadata = stripe_session.get('metadata', {}) or {}
    uid = metadata.get('uid', '')
    bundle_id = metadata.get('bundle_id', '')
    stripe_session_id = stripe_session.get('id', '')
    customer_email = _customer_email_from_session(stripe_session)
    created_at = _session_created_at(stripe_session, runtime=resolved_runtime)
    fulfilled_at = float(resolved_runtime.time.time())
    bundle = resolved_runtime.CREDIT_BUNDLES.get(bundle_id)
    if not bundle:
        return (False, 'unknown_credit_bundle')

    purchase_ref = resolved_runtime.purchases_repo.doc_ref(db, stripe_session_id)
    user_ref = resolved_runtime.users_repo.doc_ref(db, uid)

    @resolved_runtime.firestore.transactional
    def _run_transaction(transaction, purchase_ref_arg, user_ref_arg):
        purchase_snapshot = purchase_ref_arg.get(transaction=transaction)
        if getattr(purchase_snapshot, 'exists', False):
            return 'already_processed'

        user_snapshot = user_ref_arg.get(transaction=transaction)
        if getattr(user_snapshot, 'exists', False):
            user_data = user_snapshot.to_dict() or {}
            if str(user_data.get('account_status', '') or '').strip().lower() == 'deleting':
                return 'account_deletion_in_progress'
            user_payload = {}
            if customer_email and customer_email != str(user_data.get('email', '') or '').strip():
                user_payload['email'] = customer_email
        else:
            user_data = billing_credits.build_default_user_data(uid, customer_email, runtime=resolved_runtime)
            user_payload = dict(user_data)

        for credit_key, credit_amount in bundle.get('credits', {}).items():
            current_value = int(user_data.get(credit_key, 0) or 0)
            user_payload[credit_key] = current_value + int(credit_amount or 0)

        user_payload['updated_at'] = fulfilled_at
        transaction.set(user_ref_arg, user_payload, merge=True)
        transaction.set(
            purchase_ref_arg,
            _build_purchase_record(
                uid,
                bundle_id,
                stripe_session_id,
                payment_status='paid',
                fulfilled_at=fulfilled_at,
                created_at=created_at,
                runtime=resolved_runtime,
            ),
            merge=True,
        )
        return 'granted'

    try:
        transaction = db.transaction()
        status = _run_transaction(transaction, purchase_ref, user_ref)
        return (status in {'granted', 'already_processed'}, status)
    except Exception as error:
        resolved_runtime.logger.error("❌ Atomic purchase fulfillment failed for session %s: %s", stripe_session_id, error)
        return (False, 'could_not_grant_credits')


def process_checkout_session_credits(stripe_session, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    metadata = stripe_session.get('metadata', {}) or {}
    uid = metadata.get('uid', '')
    bundle_id = metadata.get('bundle_id', '')
    stripe_session_id = stripe_session.get('id', '')
    payment_status = (stripe_session.get('payment_status') or '').lower()

    if not uid or not bundle_id:
        return (False, 'missing_checkout_metadata')
    if not stripe_session_id:
        return (False, 'missing_session_id')
    if bundle_id not in resolved_runtime.CREDIT_BUNDLES:
        return (False, 'unknown_credit_bundle')
    if payment_status != 'paid':
        return (False, 'pending_payment')

    ok, status = _grant_credits_and_record_purchase_atomic(stripe_session, runtime=resolved_runtime)
    if not ok:
        return (False, status)

    bundle = resolved_runtime.CREDIT_BUNDLES.get(bundle_id, {})
    if status == 'granted':
        analytics_events.log_analytics_event(
            'payment_confirmed_backend',
            source='backend',
            uid=uid,
            session_id=stripe_session_id,
            properties={
                'bundle_id': bundle_id,
                'price_cents': int(bundle.get('price_cents', 0) or 0),
            },
            runtime=resolved_runtime,
        )
    return (True, status)
