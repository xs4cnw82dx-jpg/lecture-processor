"""Business logic handlers for payment APIs."""


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


def create_checkout_session(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Please sign in to continue'}), 401

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    allowed_checkout, retry_after = app_ctx.check_rate_limit(
        key=f"checkout:{app_ctx.normalize_rate_limit_key_part(uid, fallback='anon_uid')}",
        limit=app_ctx.CHECKOUT_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.CHECKOUT_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allowed_checkout:
        app_ctx.log_rate_limit_hit('checkout', retry_after)
        return app_ctx.build_rate_limited_response(
            'Too many checkout attempts. Please wait before starting another checkout.',
            retry_after,
        )

    data = request.get_json(silent=True) or {}
    bundle_id = data.get('bundle_id', '')

    if bundle_id not in app_ctx.CREDIT_BUNDLES:
        return app_ctx.jsonify({'error': 'Invalid bundle selected'}), 400

    bundle = app_ctx.CREDIT_BUNDLES[bundle_id]

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
            success_url=request.host_url.rstrip('/') + '/dashboard?payment=success&session_id={CHECKOUT_SESSION_ID}',
            cancel_url=request.host_url.rstrip('/') + '/dashboard?payment=cancelled',
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
    session_id = str(request.args.get('session_id', '') or '').strip()
    if not session_id:
        return app_ctx.jsonify({'error': 'Missing session_id'}), 400

    try:
        session = app_ctx.stripe.checkout.Session.retrieve(session_id)
        metadata = session.get('metadata', {}) or {}
        if metadata.get('uid', '') != uid:
            return app_ctx.jsonify({'error': 'Forbidden'}), 403

        ok, status = app_ctx.process_checkout_session_credits(session)
        if not ok:
            return app_ctx.jsonify({'error': status}), 400
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

    if event.get('type') == 'checkout.session.completed':
        session = event['data']['object']
        ok, status = app_ctx.process_checkout_session_credits(session)
        if ok and status == 'granted':
            metadata = session.get('metadata', {}) or {}
            app_ctx.logger.info(f"✅ Payment successful! Granted bundle '{metadata.get('bundle_id', '')}' to user '{metadata.get('uid', '')}'")
        elif ok and status == 'already_processed':
            app_ctx.logger.info(f"ℹ️ Checkout session {session.get('id', '')} already processed.")
        else:
            app_ctx.logger.warning(f"⚠️ Webhook checkout session {session.get('id', '')} not processed: {status}")

    return '', 200


def get_purchase_history(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
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
                'created_at': p.get('created_at', 0),
            })
        return app_ctx.jsonify({'purchases': purchases})
    except Exception as e:
        app_ctx.logger.error(f"Error fetching purchase history: {e}")
        return app_ctx.jsonify({'purchases': []})
