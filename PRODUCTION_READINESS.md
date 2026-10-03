# Production readiness: optional features and extra costs

**Current decision: keep automatic Google Calendar synchronization disabled.**
The owner does not want additional charges yet. Do not activate the worker, deploy
calendar functions, enable a scheduler, or change this decision merely because
the implementation exists. Last checked: 3 October 2026.

## One message to enable it later

When the website is ready, send an AI coding agent this message:

> Enable Google Calendar sync for production using PRODUCTION_READINESS.md. Verify the current costs and configuration, explain any additional charges before activating them, then finish setup, deployment, testing, and any GitHub PRs for me. Ask only for required cost, access, or account-consent approvals. Keep the feature off until it is ready.

This is a **request to the agent**, not a terminal command. The backend and UI are
implemented, but switching one environment variable alone is not sufficient yet.
The agent should perform the remaining steps below and request only approvals or
credentials it genuinely cannot handle itself. This file is not standing approval
for future charges or broader access.

## Features that may add costs beyond current spending

| Feature | Current state | Additional costs when enabled |
| --- | --- | --- |
| Automatic Google Calendar sync | Implemented; OFF in production | Six Firebase functions, one Cloud Scheduler job, and their Firestore/Eventarc/network/build usage. Costs depend on usage and remaining free allowances; no fixed total monthly amount is guaranteed. |

This is the only feature currently tracked in this list. Add other optional paid
features here when they are introduced; this is not a full audit of existing bills.

At the last pricing check, Cloud Scheduler included three free jobs per billing
account, then charged **US$0.10 per job per month**. That is only the scheduler
price, not the total cost of synchronization. Function/database usage can add
charges. Concurrency limits are not a hard spending cap. Recheck
[Google's scheduler pricing](https://cloud.google.com/scheduler/pricing) and
[Firebase pricing](https://firebase.google.com/pricing) before activation.

Private Google/Apple calendar subscription links are separate from automatic
Google sync. They use the existing website service and do not require these new
background jobs; normal existing hosting/database usage still applies.

## Already completed — reuse, do not recreate

- Website code shipped in [PR #182](https://github.com/xs4cnw82dx-jpg/lecture-processor/pull/182), merged and deployed. Local `main` was synced.
- Google Cloud/Firebase project: `lecture-processor-cdff6`.
- Google Calendar API enabled. Google Auth audience was already **External / In production**.
- Dedicated OAuth web client created: **Lecture Processor Study Calendar**.
- Its redirect URI is `https://lectureprocessor.com/api/study-plan/calendar/google/callback`.
- Render service: **lecture-processor-1**, ID `srv-d6g7spngi27c738mm4d0`.
- Render has the client ID, client secret, token-encryption key, redirect URI,
  worker identity and worker audience saved privately. **Never copy secrets into
  this file, GitHub, screenshots, or chat. Do not replace the encryption key casually.**
- Render's `GOOGLE_CALENDAR_ENABLED` is **`0`**. The live website's Google connect
  button was verified disabled.
- Keyless service account created: `study-calendar-worker@lecture-processor-cdff6.iam.gserviceaccount.com`.
  Setup stopped before granting its new roles. No calendar functions or scheduler
  job were deployed; only the two existing sign-in functions were present.
- The Google Data Access scope selection was cancelled without saving. Check and
  configure the required scopes below during activation.

## Agent activation checklist

Use [the detailed deployment guide](docs/google-calendar-setup.md) for implementation
details. Reinspect current state first: settings may have changed since this note.

1. Confirm the owner wants to activate the feature now. Explain current additional
   costs and obtain any required billing/access approvals before provisioning.
2. Reuse the existing OAuth client. Configure `calendar.app.created`, `openid`, and
   email consent scopes; verify branding/domain and Google's current verification
   requirements. Preserve existing sign-in configuration.
3. Finish the dedicated worker's permissions: Firestore access, Eventarc event
   receiving, and invocation of its own functions as required. Prefer narrowly
   scoped permissions; do not create downloadable service-account keys.
4. Verify existing billing and required APIs. Configure Firebase parameters
   `CALENDAR_WORKER_URL=https://lectureprocessor.com/internal/study-plan/calendar-sync/drain`
   and `CALENDAR_WORKER_SERVICE_ACCOUNT` using the account above. Keep credentials
   out of source control.
5. Deploy only these calendar functions: `studyCalendarOutbox`,
   `studyCalendarSessionChanged`, `studyCalendarGoalChanged`,
   `studyCalendarPreferencesChanged`, `studyCalendarConnectionChanged`, and
   `studyCalendarRecovery`. Verify the authenticated worker and five-minute job;
   do not unnecessarily redeploy the sign-in functions.
6. Verify all Render settings in the detailed guide, then change
   `GOOGLE_CALENDAR_ENABLED` to `1` and deploy. Connect the owner's authorized test
   Google account, pausing for any required consent confirmation.
7. Test one clearly labelled synthetic session in the dedicated calendar:
   creation, exact duration/timezone, moving, removal, retries, and disconnect.
   Verify the real Apple HTTPS subscription and refresh separately. Clean up only
   test data. If verification fails, return the switch to `0` and investigate.
8. Put any code/documentation changes through a PR; run checks, merge when allowed,
   sync local `main`, and verify Render's deployment. Update this checklist with
   the actual activation date, validation result, and remaining limitations.

If activation is abandoned after jobs were deployed, switching the website off
does not stop already-deployed workers. Stop their triggers/scheduler explicitly;
Google counts a merely paused scheduler job for billing. Review cleanup before
removing resources, and preserve unrelated infrastructure and user calendar data.
