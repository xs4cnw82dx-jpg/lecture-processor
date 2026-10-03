# Study Plan calendars: deployment and verification

Study Plan supports direct, one-way Google synchronization and private ICS subscriptions for Google, Apple and other calendar clients. Subscriptions work independently of Google OAuth configuration. The UI reports unavailable direct connection instead of offering a broken authorization button.

## Configure Google access

1. In the project's Google Cloud console, enable Google Calendar API and configure OAuth branding/audience. Create a **Web application** OAuth client. Use the actual public site domain, not a guessed Render hostname.
2. Register the exact callback `https://YOUR-DOMAIN/api/study-plan/calendar/google/callback`. A localhost HTTP callback may be registered separately for local acceptance testing.
3. Declare `https://www.googleapis.com/auth/calendar.app.created`, `openid`, and `email`. The first scope allows a dedicated app-created calendar; this integration does not request primary calendar access or calendar listing. Publish the consent configuration when ready; while in testing, add the intended test Google account and expect test-mode token-lifetime limitations.
4. Set the following environment variables on the Python application. Do not commit credentials or paste them into chat:

| Variable | Value |
| --- | --- |
| `GOOGLE_CALENDAR_ENABLED` | `1` after configuration and worker deployment |
| `GOOGLE_CALENDAR_CLIENT_ID` | Web client ID |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | Web client secret, server only |
| `GOOGLE_CALENDAR_REDIRECT_URI` | Exact registered callback |
| `CALENDAR_TOKEN_ENCRYPTION_KEYS` | Comma-separated dedicated Fernet keys; first encrypts, all can decrypt |
| `CALENDAR_WORKER_SERVICE_ACCOUNT_EMAIL` | Dedicated Firebase worker service account email |
| `CALENDAR_WORKER_AUDIENCE` | `https://YOUR-DOMAIN/internal/study-plan/calendar-sync/drain` |

Generate encryption keys through your secret-management workflow using `Fernet.generate_key()`. Never derive this key from the public URL or reuse the legacy batch-fetch encryption fallback. Retain an old key during rotation until credentials have been re-encrypted/reconnected. Losing all decryption keys requires reconnecting Google accounts.

`PUBLIC_BASE_URL` must match the real public HTTPS origin. Credentials stay encrypted in the server-only `study_google_calendars` collection. Firestore's existing deny-all client rules also cover calendar state and queue documents.

## Durable worker on existing Firebase infrastructure

`functions/calendar-sync.js` adds:

- A generation-change trigger on `study_calendar_outbox/{uid}`.
- Source-document triggers on planner sessions, goals, and preferences, so older write paths and process interruption cannot silently lose calendar updates.
- A connection-change trigger also recovers interruption between saving OAuth credentials, calendar settings or a disconnect request and enqueueing work. Worker-only status updates do not enqueue another sync.
- A five-minute recovery sweep for due work and expired leases. Successful users reconcile every six hours, including the rolling event horizon and any external modifications to managed events.

The recovery sweep wakes up to four accounts concurrently. Failed wake requests persist a bounded backoff without advancing the completed generation, so unreachable accounts cannot repeatedly block everyone behind them. An active worker lease remains untouched.

These functions only send a user ID to the Python endpoint using a service-account OIDC ID token. They do not receive user OAuth tokens or encryption keys. Configure Firebase parameters:

- `CALENDAR_WORKER_URL`: exactly the same URL as `CALENDAR_WORKER_AUDIENCE`.
- `CALENDAR_WORKER_SERVICE_ACCOUNT`: dedicated worker service account email, matching the Python allowlist.

The service account needs Firestore document access and permission to run the functions and mint its own audience-bound ID token; deployment needs the corresponding service-account impersonation/actAs permissions. Use the normal Firebase deployment project/region settings. Confirm that Cloud Scheduler, Eventarc and Functions APIs/billing are available before deploying. This reuses Firebase; it does not provision an always-on Render worker. Function/scheduler requests may incur usage charges: **do not enable billing or provision a new paid resource without the owner's approval**.

Deploy the source triggers, outbox trigger and recovery function together. Redeploying authentication-only functions is unnecessary. No public scheduler secret or unprotected drain URL is supported. The receiver verifies Google issuer/signature, audience, verified email and exact service-account identity.

The worker processes bounded batches under a persisted two-minute lease. Writes during a running sync advance the generation and remain due. Event IDs are deterministic, so replay after a timeout updates the same Google event. A lost calendar-creation response is treated separately: setup pauses and asks the user to check for an empty calendar before explicitly recreating it.

Use `CALENDAR_WORKER_AUDIENCE` equal to the deployment's HTTPS endpoint when testing through Firebase. Local backend tests call `drain_user` directly with mocks; the production route never accepts a test bypass. For a local real-account trial, the signed-in user may connect using the registered localhost callback and the developer can invoke the same drain service through a controlled local application context. Automatic synchronization acceptance still requires the deployed worker.

## User behavior and cleanup

Google connection creates a separate “Lecture Processor Study Plan” calendar. Upcoming sessions and optional all-day exam deadlines appear there; the window includes the previous 30 days and next 365 days. Google events use persisted session instants and exact session lengths. Edits, cancellation, skipped sessions and deadline changes synchronize outward. App-owned events may be restored from the source during periodic reconciliation; outside edits do not change Study Plan.

Disconnect defaults to stopping synchronization while keeping events. The explicit removal checkbox deletes only app-managed event IDs. The dedicated calendar and any events manually added by the user are preserved. Account deletion revokes credentials best-effort and erases local connection/queue state, leaving external calendar removal to the user. Private subscription links have their own independent revoke/replace lifecycle.

Do not label an ICS link as “connected” merely because it was generated. The app shows “Link ready” or the last fetch time. Google URL subscription setup requires a computer browser; Apple supports a `webcal:` handoff and a manual fallback. Calendar clients decide refresh timing and whether to honor ICS alarms.

## Verification

Run the targeted Python calendar tests, planner tests and route contract, plus calendar Playwright cases. Rebuild minified assets in the normal release build. Automated tests verify OAuth replay/browser binding, encrypted-token redaction, authorization, lease recovery, retry/deduplication, edits/removal, correct duration/DST, and feeds with more than 400 events.

For authorized live acceptance:

1. Connect the chosen Google account and confirm the consent scope and dedicated calendar.
2. Create a clearly labelled test study session; verify its exact date/time/duration.
3. Move the session and remove it; verify Google updates without duplicates.
4. Test a private Apple subscription on Mac. Verify initial appearance and subsequent refresh independently from direct Google synchronization.
5. Remove test sessions/subscriptions. Do not modify unrelated calendar events. Do not claim client acceptance based only on a mocked browser test.

Operational signals are sanitized connection status, last success, pending generation and retry time. Investigate `reconnect_required`, `needs_attention`, repeated retries, or overdue outbox documents. No OAuth credentials, authorization codes or private ICS URLs should enter operational logs.

### Local acceptance status (3 October 2026)

The existing Google Cloud project was inspected without changing configuration. It had the Firebase sign-in OAuth client, but no dedicated calendar client; Calendar API and Cloud Scheduler were not shown among enabled services. Direct Google synchronization remains disabled until the configuration above and deployment are approved and completed.

Apple Calendar's actual Mac setup path was verified as **File → New Calendar Subscription** (Dutch: **Archief → Nieuw agenda-abonnement…**). An isolated synthetic feed from the implemented service reached Apple's insecure-connection warning because its localhost URL used HTTP. The test was cancelled without bypassing that warning or adding a subscription. Actual Apple event creation, refresh, and cancellation still require acceptance against the public HTTPS feed. No user calendar events were changed.

Primary references: [Google OAuth](https://developers.google.com/identity/protocols/oauth2/web-server), [calendar scopes](https://developers.google.com/workspace/calendar/api/auth), [Google error handling](https://developers.google.com/workspace/calendar/api/guides/errors), [Firebase scheduling](https://firebase.google.com/docs/functions/schedule-functions), [Apple subscriptions](https://support.apple.com/guide/calendar/subscribe-to-calendars-icl1022/mac).
