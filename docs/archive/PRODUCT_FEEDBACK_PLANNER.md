# Study Plan feedback repair — 4 October 2026

Scope B from PRODUCT_FEEDBACK_REPAIR_PLAN.md is implemented and verified with isolated synthetic data. No real account plans, progress or uploads were changed.

## Changes

- Replaced Goal health / Needs attention with a useful list of goals, deadlines and quiet days-left text. Each goal exposes Edit goal & schedule and Delete; Schedule also provides Edit goals.
- Editing reuses the goal ID and exposes title, pack selection, exam date and availability. Accepted changes preserve completed work and active runs. Deleting atomically archives the goal and cancels only its upcoming automatic sessions; completed, active and manual sessions remain.
- Conflict explanations stay beside the final action, with Change study times. Save failures remain visible with retry; stale previews provide Refresh preview rather than an unexplained disabled button.
- Planner and shared calendar month buttons keep the calendar open and retain keyboard focus. The shared picker also handles a month with no selectable dates.
- Each pack receives a persistent account-scoped color with a legend and text/status cues in the calendar.
- Full proposal IDs avoid session-ID collisions. Per-proposal receipts make retries idempotent after a newer preview or expiry. Transactions check revisions and active runs; deletion and replacement enforce write limits before making changes. In-memory behavior matches Firestore's current-preview pointer semantics.
- Missing-index failures return actionable temporary-unavailability feedback. Unconfirmed transport failures honestly explain that saving may have succeeded and allow a safe retry.

## Confirmed production cause and release requirement

Read-only Render logs identified the actual failed acceptance: Firestore requires a planner_sessions composite index with uid ASC and date ASC. The existing uid/date/time index does not satisfy the transaction query. firestore.indexes.json now includes the exact required index. Firebase CLI dry-run passed; parent must deploy the additive index after PR merge and confirm READY plus the real read-only transaction query. No rules or credentials change.

## Verification

- Three browser-to-Flask-to-domain-to-repository lifecycle checks passed with minified assets. The opt-in isolated fixture has synthetic owned packs and in-memory persistence; planner API calls are not mocked. Tests cover create, accept, reload, edit packs/title/deadline, completed-work preservation, multiple goals, conflicts/recovery, deletion, missing-index failure, committed-but-lost response/retry, and month navigation/focus.
- Five added backend regressions cover missing-index retry, lost-response replay after expiry/new preview, current-preview pointer preservation, safe deletion and oversized atomic rejection. Together with daily scheduling tests: 31 passed. Full final backend suite: 986 passed.
- All 15 existing planner browser checks passed after correcting a pre-existing fixture that generated local dates while declaring its account timezone as UTC. Two failures surfaced only because local midnight preceded UTC midnight. Production timezone behavior was unchanged.
- Independent backend review found no blocking issues in ownership, revision checks, transaction ordering, write bounds, preserved work, receipts or account deletion/export.
- Parent inspected mobile goal controls/deadlines and desktop two-pack calendar captures, plus conflict/error evidence. Final screenshots: /tmp/product-feedback-real-planner-final. Preview fixture is opt-in only and refuses a real database runtime. CI explicitly runs the real API lifecycle checks.

## Ownership handoff

Implementation agent completed planner UI/domain/repository work and initial real API fixtures. Parent finished final backend regression tests, fixture parity, small countdown restoration, report and integration. Parent owns PR/index deployment/Render verification.
