"""Business logic handlers for payment APIs."""


from urllib.parse import urlparse

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.billing import purchases as billing_purchases
from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.rate_limit import limiter as rate_limiter


def get_config(app_ctx):
    return app_ctx.jsonify({
        'stripe_publishable_key': app_ctx.STRIPE_PUBLISHABLE_KEY,
        'bundles': {
            bundle_id: {
                'name': bundle['name'],
                'description': bundle['description'],
                'price_cents': bundle['price_cents'],
                'currency': bundle['currency'],
                'credits': bundle['credits'],
            }
            for bundle_id, bundle in app_ctx.CREDIT_BUNDLES.items()
        }
    })


def _require_allowed_email(app_ctx, email):
    if auth_policy.is_email_allowed(email, runtime=app_ctx):
        return None
    return app_ctx.jsonify({'error': 'Email not allowed', 'message': 'Please use your university email.'}), 403


def _require_account_write_access(app_ctx, uid):
    allowed, message = account_lifecycle.ensure_account_allows_writes(uid, runtime=app_ctx)
    if allowed:
        return None
    return app_ctx.jsonify({'error': message, 'status': 'account_deletion_in_progress'}), 409


def _checkout_failure_response(app_ctx, status):
    if status == 'pending_payment':
        return app_ctx.jsonify({'error': 'Payment is still pending.', 'status': status}), 409
    if status == 'account_deletion_in_progress':
        return app_ctx.jsonify({'error': account_lifecycle.account_write_block_message(runtime=app_ctx), 'status': status}), 409
    if status == 'missing_checkout_metadata':
        return app_ctx.jsonify({'error': 'Missing checkout metadata.'}), 400
    if status == 'missing_session_id':
        return app_ctx.jsonify({'error': 'Missing session id on Stripe checkout session.'}), 400
    if status == 'unknown_credit_bundle':
        return app_ctx.jsonify({'error': 'Unknown credit bundle.'}), 400
    return app_ctx.jsonify({'error': 'Could not grant credits.'}), 500


def create_checkout_session(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Please sign in to continue'}), 401

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    disallowed_response = _require_allowed_email(app_ctx, email)
    if disallowed_response is not None:
        return disallowed_response
    deletion_guard = _require_account_write_access(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    allowed_checkout, retry_after = rate_limiter.check_rate_limit(
        key=f"checkout:{rate_limiter.normalize_rate_limit_key_part(uid, fallback='anon_uid', runtime=app_ctx)}",
        limit=app_ctx.CHECKOUT_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.CHECKOUT_RATE_LIMIT_WINDOW_SECONDS,
        runtime=app_ctx,
    )
    if not allowed_checkout:
        analytics_events.log_rate_limit_hit('checkout', retry_after, runtime=app_ctx)
        return rate_limiter.build_rate_limited_response(
            'Too many checkout attempts. Please wait before starting another checkout.',
            retry_after,
            runtime=app_ctx,
        )

    data = request.get_json(silent=True) or {}
    bundle_id = data.get('bundle_id', '')

    if bundle_id not in app_ctx.CREDIT_BUNDLES:
        return app_ctx.jsonify({'error': 'Invalid bundle selected'}), 400

    bundle = app_ctx.CREDIT_BUNDLES[bundle_id]
    public_base_url = str(getattr(app_ctx, 'PUBLIC_BASE_URL', '') or '').strip().rstrip('/')
    if not public_base_url:
        app_ctx.logger.error("Stripe checkout blocked: PUBLIC_BASE_URL is not configured.")
        return app_ctx.jsonify({'error': 'Checkout is temporarily unavailable. Please try again later.'}), 500
    expected_host = (urlparse(public_base_url).hostname or '').strip().lower()
    request_host = str(request.host or '').split(':', 1)[0].strip().lower()
    if expected_host and request_host and expected_host != request_host:
        app_ctx.logger.warning(
            "Checkout host mismatch: request_host=%s expected_host=%s",
            request_host,
            expected_host,
        )

    try:
        checkout_session = app_ctx.stripe.checkout.Session.create(
            payment_method_types=['card', 'ideal'],
            line_items=[{
                'price_data': {
                    'currency': bundle['currency'],
                    'product_data': {
                        'name': bundle['name'],
                        'description': bundle['description'],
                    },
                    'unit_amount': bundle['price_cents'],
                },
                'quantity': 1,
            }],
            mode='payment',
            success_url=public_base_url + '/buy_credits?payment=success&session_id={CHECKOUT_SESSION_ID}',
            cancel_url=public_base_url + '/buy_credits?payment=cancelled',
            customer_email=email,
            metadata={
                'uid': uid,
                'bundle_id': bundle_id,
            },
        )
        return app_ctx.jsonify({'checkout_url': checkout_session.url})
    except Exception as e:
        app_ctx.logger.error(f"Stripe checkout error: {e}")
        return app_ctx.jsonify({'error': 'Could not create checkout session. Please try again.'}), 500


def confirm_checkout_session(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token.get('uid', '')
    email = decoded_token.get('email', '')
    disallowed_response = _require_allowed_email(app_ctx, email)
    if disallowed_response is not None:
        return disallowed_response
    session_id = str(request.args.get('session_id', '') or '').strip()
    if not session_id:
        return app_ctx.jsonify({'error': 'Missing session_id'}), 400

    try:
        session = app_ctx.stripe.checkout.Session.retrieve(session_id)
        metadata = session.get('metadata', {}) or {}
        if metadata.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403

        ok, status = billing_purchases.process_checkout_session_credits(session, runtime=app_ctx)
        if not ok:
            return _checkout_failure_response(app_ctx, status)
        return app_ctx.jsonify({'ok': True, 'status': status})
    except app_ctx.stripe.error.StripeError as e:
        app_ctx.logger.error(f"Stripe confirm session error: {e}")
        return app_ctx.jsonify({'error': 'Could not verify checkout session.'}), 400
    except Exception as e:
        app_ctx.logger.error(f"Confirm checkout session error: {e}")
        return app_ctx.jsonify({'error': 'Could not confirm checkout session.'}), 500


def stripe_webhook(app_ctx, request):
    payload = request.data
    sig_header = request.headers.get('Stripe-Signature', '')

    if app_ctx.STRIPE_WEBHOOK_SECRET:
        try:
            event = app_ctx.stripe.Webhook.construct_event(
                payload, sig_header, app_ctx.STRIPE_WEBHOOK_SECRET
            )
        except ValueError:
            app_ctx.logger.warning("Stripe webhook: Invalid payload")
            return 'Invalid payload', 400
        except app_ctx.stripe.error.SignatureVerificationError as e:
            app_ctx.logger.warning(f"Stripe webhook signature verification failed: {e}")
            return 'Invalid signature', 400
        except Exception as e:
            app_ctx.logger.error(f"Stripe webhook unexpected error: {e}")
            return 'Webhook processing error', 500
    else:
        app_ctx.logger.warning("⚠️ Stripe webhook rejected: STRIPE_WEBHOOK_SECRET is not configured")
        return app_ctx.jsonify({'error': 'Webhook not configured'}), 500

    event_type = str(event.get('type', '') or '').strip()
    if event_type in {'checkout.session.completed', 'checkout.session.async_payment_succeeded'}:
        session = event['data']['object']
        ok, status = billing_purchases.process_checkout_session_credits(session, runtime=app_ctx)
        if ok and status == 'granted':
            metadata = session.get('metadata', {}) or {}
            app_ctx.logger.info(f"✅ Payment successful! Granted bundle '{metadata.get('bundle_id', '')}' to user '{metadata.get('uid', '')}'")
        elif ok and status == 'already_processed':
            app_ctx.logger.info(f"ℹ️ Checkout session {session.get('id', '')} already processed.")
        elif not ok and status == 'pending_payment':
            app_ctx.logger.info("ℹ️ Checkout session %s is complete but payment has not settled yet.", session.get('id', ''))
        elif not ok and status == 'account_deletion_in_progress':
            app_ctx.logger.warning("⚠️ Checkout session %s could not be fulfilled because account deletion is in progress.", session.get('id', ''))
        else:
            app_ctx.logger.warning(f"⚠️ Webhook checkout session {session.get('id', '')} not processed: {status}")
    elif event_type == 'checkout.session.async_payment_failed':
        session = event['data']['object']
        app_ctx.logger.warning("⚠️ Stripe async payment failed for checkout session %s", session.get('id', ''))

    return '', 200


def get_purchase_history(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    disallowed_response = _require_allowed_email(app_ctx, email)
    if disallowed_response is not None:
        return disallowed_response
    try:
        purchases_docs = app_ctx.purchases_repo.list_by_uid_recent(app_ctx.db, uid, 50, app_ctx.firestore)
        purchases = []
        for doc in purchases_docs:
            p = doc.to_dict()
            purchases.append({
                'id': doc.id,
                'bundle_name': p.get('bundle_name', 'Unknown'),
                'price_cents': p.get('price_cents', 0),
                'currency': p.get('currency', 'eur'),
                'credits': p.get('credits', {}),
                'payment_status': p.get('payment_status', ''),
                'fulfilled_at': p.get('fulfilled_at', 0),
                'created_at': p.get('created_at', 0),
            })
        return app_ctx.jsonify({'purchases': purchases})
    except Exception as e:
        app_ctx.logger.error(f"Error fetching purchase history: {e}")
        return app_ctx.jsonify({'purchases': []})
