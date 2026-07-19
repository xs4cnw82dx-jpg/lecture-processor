# Study Plan v2 operations

Study Plan v2 replaces the separate Planning & Progress and Calendar pages with one server-authoritative workspace at `/plan`.

## Rollout and rollback

- `STUDY_PLAN_V2=1` enables the redesign and is the production default.
- Set `STUDY_PLAN_V2=0` and redeploy to restore the legacy planner pages and APIs for the rollback window.
- `/calendar` redirects to `/plan?view=schedule` and `/stats` redirects to `/plan?view=progress` while v2 is enabled.
- Legacy `planner_sessions` records are read additively as manual, locked sessions. No destructive session migration is required.

The first authenticated bootstrap runs an idempotent compatibility migration. Each folder that has an exam date and current packs receives a deterministic study goal. Existing folder dates, account-level daily goals, pack goals, and old reminder data remain stored for export and rollback, but the v2 UI does not use them.

## Server authority and consistency

- `/api/study-plan` returns preferences, goals, a bounded date range of sessions, progress, calendar connections, and selectable pack summaries in one response.
- Preview generation happens on the server. Applying a preview requires its short-lived proposal ID, matching goal and preference revisions, and an idempotency key.
- Accepted automatic sessions remain stable. Rebalancing creates another preview and requires explicit acceptance.
- Past, completed, skipped, manual, and locked sessions are not moved automatically.
- The browser cache is last-known display data only. Planning edits are disabled offline.
- Instants are UTC and calendar slot generation uses the saved IANA timezone for DST-safe local dates.

Deploy `firestore.indexes.json` with the release. It includes the `study_activity_sessions` index used for recent pace and progress reads.

## Private device calendars

Users may create five active named calendar subscriptions. The raw secret appears only in the create or rotate response; Firestore stores its SHA-256 hash. Revocation immediately makes the capability URL return `410 Gone`, and rotation invalidates the old URL.

The `.ics` feed includes study sessions, cancellations, stable event IDs, exam deadlines, study deep links, and the chosen reminder. This is deliberately one-way: edits made in Google Calendar, Apple Calendar, or Outlook never change Lecture Processor.

Anyone who has a private feed URL can read that calendar. Users should revoke a URL if it is shared accidentally.

## Release verification

Run these checks before and after deployment:

```bash
.venv/bin/pytest -q
npm run test:client-goals
npm run check:assets
npx playwright test
.venv/bin/python scripts/smoke_test.py --base-url https://lecture-processor-1.onrender.com
```

For signed-in production verification, open `/plan`, confirm Today/Schedule/Progress load, open and close the setup wizard without accepting it, and confirm an unfiled pack offers **Add to Study Plan** in the Study Library.
