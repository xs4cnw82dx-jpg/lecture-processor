from lecture_processor.runtime.container import get_runtime
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.analytics import events as analytics_events


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def save_purchase_record(uid, bundle_id, stripe_session_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    bundle = resolved_runtime.CREDIT_BUNDLES.get(bundle_id)
    if not bundle:
        return
    try:
        record = {
            'uid': uid,
            'bundle_id': bundle_id,
            'bundle_name': bundle['name'],
            'price_cents': bundle['price_cents'],
            'currency': bundle['currency'],
            'credits': bundle['credits'],
            'stripe_session_id': stripe_session_id,
            'created_at': resolved_runtime.time.time(),
        }
        if stripe_session_id:
            resolved_runtime.purchases_repo.set_doc(resolved_runtime.db, stripe_session_id, record, merge=True)
        else:
            resolved_runtime.purchases_repo.add_doc(resolved_runtime.db, record)
        resolved_runtime.logger.info("📝 Saved purchase record for user %s: %s", uid, bundle['name'])
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


def process_checkout_session_credits(stripe_session, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    metadata = stripe_session.get('metadata', {}) or {}
    uid = metadata.get('uid', '')
    bundle_id = metadata.get('bundle_id', '')
    stripe_session_id = stripe_session.get('id', '')
    payment_status = (stripe_session.get('payment_status') or '').lower()
    session_status = (stripe_session.get('status') or '').lower()

    if not uid or not bundle_id:
        return (False, 'Missing checkout metadata.')
    if bundle_id not in resolved_runtime.CREDIT_BUNDLES:
        return (False, 'Unknown credit bundle.')
    if payment_status != 'paid' and session_status != 'complete':
        return (False, 'Checkout session is not paid yet.')
    if purchase_record_exists_for_session(stripe_session_id, runtime=resolved_runtime):
        return (True, 'already_processed')

    success = billing_credits.grant_credits_to_user(uid, bundle_id, runtime=resolved_runtime)
    if not success:
        return (False, 'Could not grant credits.')
    save_purchase_record(uid, bundle_id, stripe_session_id, runtime=resolved_runtime)

    bundle = resolved_runtime.CREDIT_BUNDLES.get(bundle_id, {})
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
    return (True, 'granted')
