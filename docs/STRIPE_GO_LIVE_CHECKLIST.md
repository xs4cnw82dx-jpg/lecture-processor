# Stripe Go-Live Checklist (Test -> Live)

Last updated: 2026-03-01

Use this checklist only when you are ready to accept real payments.

## 1) Pre-switch safety snapshot (2 minutes)

1. Open GitHub Actions and confirm both required checks are green on `main`:
   - `Guardrail Tests (pytest)`
   - `Smoke Tests`
2. Create a rollback tag before changing production payment settings:

```bash
cd /Users/jaccovandermeulen/Desktop/lecture-processor
git checkout main
git pull --ff-only origin main
git tag -a pre-stripe-live-$(date +%Y%m%d-%H%M) -m "Pre Stripe live switch checkpoint"
git push --tags
```

3. In Render, open service `lecture-processor-1` and copy current Stripe env vars into a private note:
   - `STRIPE_SECRET_KEY`
   - `STRIPE_PUBLISHABLE_KEY`
   - `STRIPE_WEBHOOK_SECRET`

## 2) Stripe dashboard setup (live mode)

1. Open Stripe dashboard.
2. Switch from **Test mode** to **Live mode**.
3. Go to Developers -> API keys.
4. Copy:
   - Live Secret key (`sk_live_...`)
   - Live Publishable key (`pk_live_...`)

## 3) Create live webhook endpoint

1. In Stripe dashboard (Live mode), go to Developers -> Webhooks.
2. Click **Add endpoint**.
3. Endpoint URL:
   - `https://lecture-processor-1.onrender.com/api/stripe-webhook`
4. Events to send:
   - `checkout.session.completed` only
5. Save.
6. Copy signing secret (`whsec_...`) for this live endpoint.

## 4) Update Render production env vars

1. Open Render -> `lecture-processor-1` -> Environment.
2. Replace:
   - `STRIPE_SECRET_KEY` with `sk_live_...`
   - `STRIPE_PUBLISHABLE_KEY` with `pk_live_...`
   - `STRIPE_WEBHOOK_SECRET` with live `whsec_...`
3. Click **Save changes**.
4. Trigger deploy (if Render does not auto-redeploy after env update).
5. Wait for deploy status to become **Live**.

## 5) Verify go-live with automated checks

Run from terminal (admin token recommended):

```bash
cd /Users/jaccovandermeulen/Desktop/lecture-processor
source venv/bin/activate
python scripts/stripe_go_live_check.py \
  --base-url https://lecture-processor-1.onrender.com \
  --expect-mode live \
  --bearer-token "$FIREBASE_TEST_BEARER"
```

Expected result:
- `Publishable key mode matches expected` -> PASS
- `Admin runtime secret key mode matches expected` -> PASS
- `Admin runtime publishable mode matches expected` -> PASS
- `Secret/publishable mode match each other` -> PASS
- `Webhook secret configured` -> PASS

## 6) Real payment verification (smallest amount)

1. Open production app.
2. Buy the smallest real credit bundle.
3. Confirm:
   - Stripe checkout completes successfully.
   - Credits appear in app.
   - Purchase appears in `/api/purchase-history` UI.
   - Admin dashboard shows purchase/job metrics normally.

## 7) If anything fails (rollback in under 2 minutes)

1. In Render, restore previous test Stripe env values.
2. Save changes and redeploy.
3. Re-run:

```bash
cd /Users/jaccovandermeulen/Desktop/lecture-processor
source venv/bin/activate
python scripts/stripe_go_live_check.py \
  --base-url https://lecture-processor-1.onrender.com \
  --expect-mode test \
  --bearer-token "$FIREBASE_TEST_BEARER"
```

4. Follow [ROLLBACK_RUNBOOK.md](/Users/jaccovandermeulen/Desktop/lecture-processor/docs/ROLLBACK_RUNBOOK.md) if broader incident symptoms appear.
