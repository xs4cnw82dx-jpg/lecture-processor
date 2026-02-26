# Data Retention and Backup Policy (Operational Baseline)

Last updated: 2026-02-26

This document defines the current operational policy for data retention, deletion, backup, and restore in Lecture Processor.  
It is a technical baseline for private beta operations and must be reviewed by qualified legal counsel before public/commercial launch.

## 1) Scope

This policy covers:
- User account records and credit balances
- Study packs, folders, planner entries, and study progress data
- Upload/job metadata and analytics/security logs
- Purchase records
- Temporary processing artifacts

## 2) Data Classes and Retention Targets

1. Account + credits (`users` collection)
- Retention: until user deletes account, or administrative deletion.
- Legal hold exception: may be retained longer if required by law or fraud/security investigations.

2. Study content (`study_packs`, `study_folders`, `study_progress`, `study_card_states`, planner/session data)
- Retention: until user deletes account or explicitly deletes content.
- Deletion propagation: delete endpoint removes these records and associated per-pack progress state.

3. Purchase records (`purchases`)
- Retention: retained for accounting, tax, fraud-prevention, and audit requirements.
- Deletion behavior: user-linked identifiers are anonymized during account deletion where supported.

4. Job/ops telemetry (`job_logs`, `analytics_events`, `rate_limit_logs`)
- Retention baseline: 90 days rolling target for operational logs.
- Extended retention permitted for security incidents and abuse investigations.

5. Temporary processing files (`uploads/` and transient processing artifacts)
- Retention target: deleted after job completes or fails.
- Failure fallback: periodic manual/automated cleanup required to remove orphaned artifacts.

## 3) Backup Policy

1. Firestore data
- Backup method: scheduled managed Firestore export (daily recommended) to a restricted backup bucket.
- Backup cadence target: once per day.
- Backup retention target: 30 daily backups + 12 monthly backups.

2. Application code/config
- Source of truth: GitHub repository + tagged releases.
- Recovery source: latest stable tag + Render environment variables + runbooks in `docs/`.

3. Secrets
- No secrets in Git.
- Secrets stored in Render/Firebase/Stripe dashboards and local `.env` (local only).

## 4) Restore Policy

1. Restore objective
- Priority: restore account access, credits integrity, and core processing first.
- RTO target (private beta): best effort, same day.
- RPO target (private beta): up to last successful daily backup.

2. Restore sequence
- Restore Firestore export into controlled recovery project/environment.
- Validate collections and schema integrity.
- Repoint app environment only after validation checks pass.
- Run smoke checks (`scripts/run_smoke.sh`) before reopening access.

3. Validation checks after restore
- Authentication works.
- Credits/purchase history consistency checks pass for test users.
- Study packs and progress summaries render correctly.
- Upload and processing endpoints return healthy responses.

## 5) Deletion and Export Guarantees

1. Export
- `GET /api/account/export` provides user-scoped JSON export.

2. Delete account and data
- `POST /api/account/delete` requires explicit confirmation phrase and email match.
- Active-job guard prevents deletion while processing is running.
- Deletes user data collections and attempts auth user removal.
- Purchase records are anonymized where deletion is not legally appropriate.

## 6) Operational Controls

1. Access controls
- Production Firestore access limited to service account and authorized operators only.

2. Monitoring
- Sentry enabled for backend/frontend errors.
- Admin dashboard tracks failures, refunds, and rate-limit trends.

3. Auditability
- Critical operational events logged in backend collections.
- Release tags and CI checks provide deployment traceability.

## 7) Pre-Public-Launch Required Upgrades

Before public launch, complete all:
1. Automate Firestore daily export job and document exact restore command sequence.
2. Enforce and automate log TTL for analytics/rate-limit/job logs.
3. Add monthly backup restore drill and sign-off checklist.
4. Add documented incident-response owner/contact and escalation timeline.
5. Legal review of retention windows and anonymization behavior per jurisdiction.
