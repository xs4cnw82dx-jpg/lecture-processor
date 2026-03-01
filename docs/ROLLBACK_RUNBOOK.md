# Rollback and Incident Runbook

Last updated: 2026-03-01
Owner: Lecture Processor (engineering)

## Purpose

Use this runbook when production behavior degrades after a deploy. It defines when to rollback, how to rollback safely, and what to verify after rollback.

## Severity Levels

- `SEV-1` (critical): login broken, checkout broken, uploads failing for most users, app down.
- `SEV-2` (major): elevated failures but core product still partially usable.
- `SEV-3` (minor): non-critical feature degradation.

## Rollback Triggers

Rollback immediately if any condition is true:

1. `SEV-1` symptom is confirmed for more than 5 minutes.
2. Processing success rate drops below `70%` over a 15-minute window.
3. Payment/checkout failures exceed `10%` over a 15-minute window.
4. Smoke tests against production fail on core routes (`/`, `/dashboard`, `/api/config`, `/upload auth guard`).
5. Sentry shows repeated unhandled backend exceptions after deploy with no quick fix in <15 minutes.

Prefer fix-forward (no rollback) if all are true:

1. User impact is `SEV-3`.
2. A safe patch is ready and can be deployed in <15 minutes.
3. No payment or auth regressions are present.

## Immediate Triage (First 10 Minutes)

1. Freeze further deploys.
2. Identify current deploy version:
   - GitHub tag/commit currently live.
   - Render deploy ID currently live.
3. Confirm only one production web service is active:
   - Keep exactly one service as canonical production.
   - If a second service exists (old/duplicate), set it to manual deploy + zero traffic or delete it after verification.
   - Ensure Firebase Authorized Domains includes the canonical host only (and localhost/dev domains as needed).
4. Check these dashboards in order:
   - Sentry (new errors, release, route tags).
   - Admin dashboard (`/admin`): success rate, failed jobs, rate-limit spikes, deployment sanity panel.
   - Render logs: startup/runtime exceptions.
5. Run production smoke check from terminal:

```bash
cd /Users/jaccovandermeulen/Desktop/lecture-processor
./venv/bin/python scripts/smoke_test.py --base-url https://lecture-processor-1.onrender.com
```

6. Decide: `rollback now` or `fix-forward now` using trigger rules above.

## Render Rollback (UI Steps)

1. Open Render dashboard.
2. Click service: `lecture-processor-1`.
3. Go to `Deploys` tab.
4. Find the latest known good deploy (usually previous green deploy).
5. Click `Rollback` on that deploy.
6. Confirm rollback.
7. Wait for deploy status = `Live`.

If rollback button is unavailable:

1. Copy the known-good commit SHA (or tag such as `v0.1.0`).
2. Re-deploy that commit from Render (manual deploy from commit).

## Post-Rollback Verification (Required)

After rollback is live, complete all checks:

1. Production smoke test returns pass:

```bash
cd /Users/jaccovandermeulen/Desktop/lecture-processor
./venv/bin/python scripts/smoke_test.py --base-url https://lecture-processor-1.onrender.com
```

2. Manual core flow spot-check:
   - Sign in works.
   - Pricing modal opens.
   - Checkout session endpoint responds.
   - Upload validation responds correctly.
3. Admin dashboard trend stabilizes (failures flatten, success recovers).
4. Sentry new critical errors stop increasing.

## Communication Template

Use this internal status update format:

- `Incident:` <short title>
- `Start time:` <UTC/local>
- `Impact:` <who/what is affected>
- `Decision:` <rollback or fix-forward>
- `Action taken:` <render rollback to deploy X / commit Y>
- `Current status:` <monitoring / recovered>
- `Next update:` <time>

## Evidence to Capture

Store in incident notes:

1. Failing CI/run links (if release-related).
2. Sentry issue links.
3. Admin metrics screenshot before/after rollback.
4. Render deploy IDs (bad + good).
5. Smoke test output before/after rollback.

## Recovery Exit Criteria

Mark incident as recovered only when all are true for at least 30 minutes:

1. Success rate is back to normal range (target `>= 90%`).
2. No new critical Sentry errors tied to the incident.
3. Checkout and upload endpoints are healthy.
4. Production smoke checks pass.

## Follow-Up (Within 24 Hours)

1. Create root-cause summary.
2. Add/adjust tests to prevent recurrence.
3. If needed, tighten branch protection or release checklist.
4. Update this runbook if any step was unclear.

## Quick Reference Commands

### 1) Run production smoke checks

```bash
cd /Users/jaccovandermeulen/Desktop/lecture-processor
./venv/bin/python scripts/smoke_test.py --base-url https://lecture-processor-1.onrender.com
```

### 2) Confirm latest CI runs (GitHub UI)

- Open: `https://github.com/xs4cnw82dx-jpg/lecture-processor/actions`
- Confirm both checks are green:
  - `Guardrail Tests (pytest)`
  - `Smoke Tests`

### 3) Show current tag/commit locally

```bash
cd /Users/jaccovandermeulen/Desktop/lecture-processor
git show --no-patch --decorate HEAD
```
