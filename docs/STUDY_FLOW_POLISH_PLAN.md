# Study flow polish — 4 October 2026

Active follow-up to PR #185, deployed at bee9b699. Read with AGENTS.md and the visual redesign master/progress records after compaction and at phase boundaries. Branch: codex/study-flow-polish. Full implementation, isolated verification, PR, checks, merge, main sync and deployment verification remain authorized.

## Requested outcomes

- [x] 1. Clear/reset the entire Study Plan, including orphaned commitments, while preserving study packs and learning history. Explain the scope in a confirmation.
- [x] 2, 6. Tighten credit-category/card spacing; restore checkout controls after browser Back, including bfcache.
- [x] 3–5, 14. Permanently distinguish pack rows; repair All Study Packs collapse; delete folders from their own menu while retaining packs; filter unorganized packs.
- [x] 7–8. Give URL guidance and recorder controls breathing room. Everywhere, lead with playing the recording then copying its index.m3u8 Network request using DevTools (Mac/Windows/right-click instructions), without failed-page-URL detours.
- [x] 9. Annotation undo/redo keyboard shortcuts, respecting text-editing focus.
- [x] 10. Distinguish Dashboard rows at rest; animate Recent study packs collapse, default open and persist per account across navigation.
- [x] 11–13. One Library-style learning setup/viewer from all entry points. Selected modes work, planned sessions start without an extra Resume, timer controls align and explain restrictions, and saving/resuming works across modes.
- [x] 15. Builder info callout explaining how to use an existing AI subscription with materials and the CSV template, review the output and import it.
- [x] 16. Dashboard due counts and recommendations include only packs in the active Study Plan, retaining global learning history.

## Ownership

- Learning owner: study.js, study.css, study.html, session utilities and planned-study files, study-run backend/tests. Owns Library folders/annotations/Builder guidance as these share the same files.
- Planner/Dashboard owner: planner service/repository/blueprint, Study Plan files, study-progress service, Dashboard files and relevant tests. Coordinate shared route files before editing.
- Creation owner: credit catalog/checkout, LMS guidance across all creation/public flows, recorder spacing and their tests.
- Parent: integration, independent review, generated assets, full verification and delivery. No overlapping source edits without coordination.

## Verification and boundaries

Use scripts/run_ui_preview.py and scripts/run_pytest_isolated.py only, synthetic accounts and temporary storage. Never delete real plans, mutate real learning progress, buy credits or upload materials to an AI for QA. Preserve deferred external-service configuration. Inspect desktop/mobile rendering and exercise behavior, not only source contracts. Run meaningful lifecycle, navigation/back, saved-session and ownership regressions; then asset/lint/backend/client/browser checks.

Deferred half-credit customer pricing from the previous round remains pending the user's exact-half versus odd-count rounding preference. It is separate from this task; do not change balances or advertise that discount.

## Progress

Plan saved before implementation. PR #185 was merged, its Firestore index verified READY, local main synced and Render exact commit/assets verified. The new screenshots identify remaining workflow friction and new requested capabilities; earlier completed checklists do not establish these new outcomes.

### Implementation checkpoint

Creation/credits scope frozen: 17 scoped browser checks, final 6-check refinement rerun, 52 Python checks passed. Parent inspected credit desktop and creation/batch mobile captures. See STUDY_FLOW_POLISH_CREATION.md.

Planner reset and Dashboard implementation undergoing independent ownership/account-switch/filtering review. Learning adapter uses the Library viewer with embedded planned tracking; independent real-API browser flow passed answer persistence exactly once, mode changes and question resume. Three independent backend mode/target/timing invariants pass after fixing stale-tab mode overwrites. Full mode-specific saved-state, account invalidation, responsive refinements and full integrated checks still pending. Parent extended only the isolated fixture with persistent synthetic SRS storage; no production data used.

### Integrated verification checkpoint

All requested implementation scopes are complete and frozen. See the creation, planner and learning owner reports. Parent independently reviewed reset/ownership boundaries and atomic review receipts, and inspected desktop/mobile folder menus, shared setup, Match and planned-viewer captures. Final mobile icon gutter and two-option question fixes are included.

Full isolated backend: **1,007 passed**. Client suite: **196 passed**. Generated assets rebuilt and checked; JavaScript/Python lint, repository hygiene, tracked-secret and whitespace checks passed. Real API browser suite: **7 passed**, covering planner lifecycle/reset and shared-viewer saved progress including lost-response replay. Retained legacy planner browser check passed with STUDY_PLAN_V2=0. Full production-asset browser coverage: **228 standard scenarios passed** across the integrated run and the six-test planned lifecycle rerun. The initial run exposed a test assumption about the one-second tick offset; the corrected test still rejects completion before 60 seconds and verifies completion after the full reading interval. Eight environment-specific scenarios were skipped there and passed separately (seven real-API, one legacy).

- [x] Complete full browser suite and final visual inspection.
- [ ] Commit/push, create and attach PR, monitor required checks and merge without bypass.
- [ ] Sync main and verify Render exact commit plus public pages/assets.

Exact viewer position is stored on the current device; planned answers and learning progress are server-backed. No real study data, payments or external AI/calendar services were used for QA.

### Review checkpoint

PR [#186](https://github.com/xs4cnw82dx-jpg/lecture-processor/pull/186) is open and attached to the task. GitHub backend/frontend/Functions/smoke checks passed on the first commit; browser check remains in progress. Final screenshot comparison added the requested information icon and explicit upload-template steps directly to the Builder import panel, in addition to its introductory shortcut. Focused Notes/Builder regression passed and parent inspected the final mobile callout. No runtime logic changed in that last refinement.
