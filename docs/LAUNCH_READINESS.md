# Launch Readiness Checklist

Last updated: 2026-03-01

This checklist tracks launch-critical items and current status with evidence.

## 1) Observability + Launch Safety

- [x] Frontend error monitoring (Sentry)
  - Evidence:
    - `templates/index.html` initializes Sentry browser SDK and captures client exceptions.
    - Verified in manual testing: frontend events appear in Sentry.

- [x] Backend error monitoring (Sentry)
  - Evidence:
    - `lecture_processor/legacy_app.py` initializes Sentry SDK when `SENTRY_DSN_BACKEND` is set.
    - `lecture_processor/legacy_app.py` includes route context tags (`route.path`, `route.method`, `route.status_code`, etc.).
    - `/api/dev/sentry-test` exists for development verification.

- [x] Basic analytics funnel events
  - Evidence:
    - Frontend emits: auth modal open/success/fail, checkout started, payment confirmed/cancelled, process clicked, processing started/completed/failed/timeout, study mode opened.
    - Backend stores events in `analytics_events`.

- [x] Admin/ops view for processing health
  - Evidence:
    - `/admin` dashboard shows job counts, success/fail, duration, revenue, funnel, mode breakdown.
    - CSV exports include jobs/purchases/funnel/funnel-daily.

## 2) Abuse and Rate-Limit Hardening

- [x] Per-user active job limit
  - Evidence:
    - `/upload` returns `429` when active jobs exceed `MAX_ACTIVE_JOBS_PER_USER`.

- [x] Endpoint throttling on expensive routes
  - Evidence:
    - `/upload` throttled.
    - `/api/create-checkout-session` throttled.
    - `/api/lp-event` and `/api/analytics/event` throttled.
    - `429` responses include `Retry-After` and `retry_after_seconds`.

- [x] Frontend cooldown UX for throttling
  - Evidence:
    - Checkout buttons disabled with countdown after `429`.
    - Process button disabled with countdown after upload `429`.

- [x] Better stuck-job UX + recovery
  - Evidence:
    - Timeout copy shown after max poll runtime.
    - "Retry status check now" action in progress panel triggers immediate poll retry.

- [x] 429 observability for tuning
  - Evidence:
    - Backend logs `rate_limit_logs` on throttle hits (upload/checkout/analytics).
    - Admin shows total 429 count and per-limiter split.
    - Admin shows "Recent Rate-limit Hits" table.

## 3) Trust/Compliance Minimum

- [x] Privacy Policy page
  - Evidence:
    - Route: `/privacy`
    - Template: `templates/privacy.html`

- [x] Terms page
  - Evidence:
    - Route: `/terms`
    - Template: `templates/terms.html`

- [x] Export my data flow
  - Evidence:
    - Endpoint: `GET /api/account/export`
    - User menu action downloads JSON export.

- [x] Delete account + data flow
  - Evidence:
    - Endpoint: `POST /api/account/delete`
    - Guardrails: confirmation phrase + email match + active-job block.
    - Deletes/anonymizes user data and removes auth user where possible.

- [x] Formal retention + backup policy baseline
  - Evidence:
    - Operational document: `docs/DATA_RETENTION_BACKUP_POLICY.md`
    - Covers retention classes, backup cadence targets, restore order, and pre-public-launch upgrade checklist.

## 4) Automated Verification

- [x] Launch guardrail test suite added
  - File: `tests/test_launch_guardrails.py`
  - Covers:
    - Email allow/block logic.
    - 429 + Retry-After behavior for upload/checkout/analytics.
    - Upload validation (invalid audio content type).
    - Account export/delete auth + guardrails.

- [x] Test run (latest)
  - Command:
    - `./venv/bin/python -m pytest -q tests/test_launch_guardrails.py tests/test_api_contracts.py`
  - Result:
    - `47 passed`

- [x] One-command smoke script added
  - Script: `scripts/run_smoke.sh`
  - Main runner: `scripts/smoke_test.py`
  - Default command:
    - `./scripts/run_smoke.sh`
  - Optional:
    - `./scripts/run_smoke.sh --base-url https://your-domain.com`
    - `FIREBASE_TEST_BEARER='<token>' ./scripts/run_smoke.sh` (adds authenticated checks)

- [x] CI automation on push + pull request
  - Workflow: `.github/workflows/ci.yml`
  - Jobs:
    - `Guardrail Tests (pytest)`
    - `Smoke Tests` (boots app and runs `scripts/run_smoke.sh`)

## 5) Still Recommended Before Public Launch

- [ ] Legal review by qualified counsel for Privacy/Terms text (important).
- [x] CI automation to run pytest on every commit/PR.
- [x] Optional E2E browser tests are available (Playwright smoke suite, manual trigger).
  - Evidence:
    - Local config: `playwright.config.js`
    - E2E tests: `e2e/smoke.spec.js`
    - GitHub workflow: `.github/workflows/e2e-playwright.yml` (`workflow_dispatch`)
