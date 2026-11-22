# Study Plan and Dashboard — 4 October polish

Scope: requested outcomes 1, 10 and 16 in `STUDY_FLOW_POLISH_PLAN.md`. Source work is ready for parent integration; no generated assets or commits were produced by this owner.

## Entire-plan reset

- Added a discoverable **Clear entire plan** control, available even when no goal remains but orphaned sessions exist. A styled confirmation explicitly covers every goal and unfinished manual, automatic, overdue or unlinked commitment. Packs, completed/skipped history, study logs, SRS state, saved learning runs, availability and calendar settings are preserved.
- `POST /api/study-plan/reset` requires authentication, write access, explicit scope confirmation and a request idempotency key. Account lifecycle is checked inside the Firestore transaction. Ownership is checked defensively on every candidate record.
- All reads precede writes. Archiving goals, cancelling commitments, incrementing preference revision, marking the calendar dirty and recording the reset receipt are atomic. Pre-reset proposals cannot later recreate the cleared plan. Legacy folder migration is marked complete so reloading cannot re-import a deleted plan.
- Repeating an uncertain request with the same key returns its durable receipt without touching a newly created plan. Transient failures describe an uncertain outcome accurately. UI confirmation is bound to the initiating account; signing out or changing accounts cannot authorize another account's reset. Successful resets update cached commitments before refreshing, and account changes discard the previous account's displayed plan.
- Safety bounds: read at most 5,001 goals and sessions, rejecting above 5,000; reject before any writes when affected goals + sessions + three supporting documents exceed Firestore's 500-write bound. Large plans receive an explicit support message with no partial reset. Active-run documents are retained; cancellation-aware save/completion is coordinated with the learning owner.

## Dashboard

- Upcoming and Recent rows now have a persistent soft background, border and separation before hover.
- Recent study packs uses the shared animated, accessible disclosure. It opens by default and persists open/closed state per account across navigation; another account gets its own preference.
- Dashboard due cards and count request `scope=active_plan`. Both resolve the same actionable owned cards from active-goal packs, excluding archived/missing/foreign packs and removed/future/unseen cards. The scope is named visibly: **in your Study Plan**.
- Scoped reads load only active-pack card-state documents; no active packs returns immediately. Existing global SRS state, rollups and unscoped API behavior are unchanged.
- Recommendations only use active-plan packs. Recent packs still provide library navigation without becoming out-of-plan recommendations. Upcoming API filters membership before pagination, so preceding orphan sessions cannot hide an eligible session.
- Active membership is resolved before limiting to active results, preventing archived goal history from crowding active goals out of a first page. Library membership and planner bootstrap use the same bounded resolver. Incoming global progress events trigger a scoped refresh rather than replacing the Dashboard count with a global total.

## Verification

- Inspected user's screenshots 1 (orphan commitment), 10 (resting rows) and 16 (due list).
- **61 isolated Python tests passed** across planner transactions, repository pagination, planner API lifecycle, due/progress rollups and batch reads. Covers ownership, reset receipts/replay after a newer plan, stale preview rejection, malformed confirmation, authentication, preserved completed work, account guard and write-limit rejection. Due summary/list agree; global history remains byte-for-byte unchanged; no active plan causes no card reads. Archived-goal and pre-limit session filtering have regressions.
- **8 focused browser tests passed**: real API planner lifecycle/save retry, picker navigation, reset confirmation/cancellation/reload, account-switch rejection, Dashboard desktop/mobile composition, persistent disclosure across two accounts and no out-of-plan recommendation fallback.
- **2 final reset browser regressions passed** after account/cache refinements (including safe-replay presentation). Safe isolated runners only; no real account, external calendar activation or production data changes.
- Scoped Ruff/ESLint and `git diff --check` passed.
- Captures inspected: `/tmp/study-polish-planner-final/learning-surfaces-dashboar-f57d0-esktop-and-mobile-hierarchy/dashboard-desktop.png`, `dashboard-mobile.png`; `/tmp/study-polish-planner-final/planner-stateful-clear-ent-28bda-tory-and-packs-after-reload/clear-plan-desktop.png`, `clear-plan-mobile.png`; collapsed Recent capture in the sibling disclosure test directory. Mobile confirmation fits its viewport, actions remain visible, rows are distinct, and no horizontal overflow was observed.

Parent owns full integration, generated assets, broad verification, delivery and the independent real-API learning/SRS test. This report does not claim those later checks have run.
