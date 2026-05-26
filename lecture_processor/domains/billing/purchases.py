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


def _firebase_email_from_session(stripe_session):
    metadata = stripe_session.get('metadata', {}) or {}
    return str(metadata.get('firebase_email', '') or metadata.get('email', '') or '').strip()


def _session_line_items(stripe_session):
    line_items = stripe_session.get('line_items', {}) or {}
    if isinstance(line_items, dict):
        data = line_items.get('data', [])
    else:
        data = getattr(line_items, 'data', []) or []
    return [item for item in data if isinstance(item, dict) or hasattr(item, 'get')]


def _session_amount_total(stripe_session):
    try:
        return int(stripe_session.get('amount_total', -1))
    except Exception:
        return -1


def _line_item_amount_total(line_item):
    try:
        return int(line_item.get('amount_total', -1))
    except Exception:
        return -1


def _line_item_quantity(line_item):
    try:
        return int(line_item.get('quantity', 0))
    except Exception:
        return 0


def _stripe_key_is_live(runtime):
    api_key = str(getattr(getattr(runtime, 'stripe', None), 'api_key', '') or '').strip()
    return api_key.startswith('sk_live_')


def _validate_checkout_session(stripe_session, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    metadata = stripe_session.get('metadata', {}) or {}
    uid = metadata.get('uid', '')
    bundle_id = metadata.get('bundle_id', '')
    stripe_session_id = stripe_session.get('id', '')
    payment_status = str(stripe_session.get('payment_status', '') or '').strip().lower()

    if not uid or not bundle_id:
        return (False, 'missing_checkout_metadata')
    if not stripe_session_id:
        return (False, 'missing_session_id')
    bundle = resolved_runtime.CREDIT_BUNDLES.get(bundle_id)
    if not bundle:
        return (False, 'unknown_credit_bundle')
    if str(stripe_session.get('mode', '') or '').strip().lower() != 'payment':
        return (False, 'invalid_checkout_session')
    if str(stripe_session.get('status', '') or '').strip().lower() != 'complete':
        return (False, 'checkout_incomplete')
    if payment_status != 'paid':
        return (False, 'pending_payment')

    expected_amount = int(bundle.get('price_cents', 0) or 0)
    expected_currency = str(bundle.get('currency', '') or '').strip().lower()
    if _session_amount_total(stripe_session) != expected_amount:
        return (False, 'checkout_amount_mismatch')
    if str(stripe_session.get('currency', '') or '').strip().lower() != expected_currency:
        return (False, 'checkout_currency_mismatch')

    if 'livemode' in stripe_session:
        livemode = bool(stripe_session.get('livemode'))
        if livemode != _stripe_key_is_live(resolved_runtime):
            return (False, 'checkout_livemode_mismatch')

    line_items = _session_line_items(stripe_session)
    if len(line_items) != 1:
        return (False, 'missing_checkout_line_items')
    line_item = line_items[0]
    if _line_item_quantity(line_item) != 1:
        return (False, 'checkout_quantity_mismatch')
    if _line_item_amount_total(line_item) != expected_amount:
        return (False, 'checkout_line_amount_mismatch')
    if str(line_item.get('currency', '') or '').strip().lower() != expected_currency:
        return (False, 'checkout_line_currency_mismatch')
    return (True, 'valid')


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
    firebase_email = _firebase_email_from_session(stripe_session)

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
            billing_credits.build_default_user_data(uid, firebase_email, runtime=resolved_runtime),
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
    if db is None:
        return _grant_credits_and_record_purchase_fallback(stripe_session, runtime=resolved_runtime)
    if not hasattr(db, 'transaction'):
        resolved_runtime.logger.error(
            "❌ Refusing non-transactional checkout fulfillment for session %s",
            stripe_session.get('id', ''),
        )
        return (False, 'transaction_unavailable')

    metadata = stripe_session.get('metadata', {}) or {}
    uid = metadata.get('uid', '')
    bundle_id = metadata.get('bundle_id', '')
    stripe_session_id = stripe_session.get('id', '')
    firebase_email = _firebase_email_from_session(stripe_session)
    created_at = _session_created_at(stripe_session, runtime=resolved_runtime)
    fulfilled_at = float(resolved_runtime.time.time())
    bundle = resolved_runtime.CREDIT_BUNDLES.get(bundle_id)
    if not bundle:
        return (False, 'unknown_credit_bundle')
    purchase_record = _build_purchase_record(
        uid,
        bundle_id,
        stripe_session_id,
        payment_status='paid',
        fulfilled_at=fulfilled_at,
        created_at=created_at,
        runtime=resolved_runtime,
    )

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
        else:
            user_data = billing_credits.build_default_user_data(uid, firebase_email, runtime=resolved_runtime)
            user_payload = dict(user_data)

        for credit_key, credit_amount in bundle.get('credits', {}).items():
            current_value = int(user_data.get(credit_key, 0) or 0)
            user_payload[credit_key] = current_value + int(credit_amount or 0)

        user_payload['updated_at'] = fulfilled_at
        transaction.set(user_ref_arg, user_payload, merge=True)
        transaction.set(purchase_ref_arg, purchase_record, merge=True)
        return 'granted'

    try:
        transaction = db.transaction()
        status = _run_transaction(transaction, purchase_ref, user_ref)
        if status == 'granted':
            try:
                admin_rollups.increment_purchase_rollups(purchase_record, runtime=resolved_runtime)
            except Exception as error:
                resolved_runtime.logger.error("❌ Failed to update purchase rollups for session %s: %s", stripe_session_id, error)
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

    valid, validation_status = _validate_checkout_session(stripe_session, runtime=resolved_runtime)
    if not valid:
        return (False, validation_status)

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
