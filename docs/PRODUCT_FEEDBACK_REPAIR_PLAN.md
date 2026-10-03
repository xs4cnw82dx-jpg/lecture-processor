# Product feedback repair plan — 3 October 2026

Read this file after compaction and before every phase, alongside AGENTS.md and the earlier visual redesign records. This is the active follow-up to merged PR #184, starting from clean main 538ceb4. User authorizes implementation and the full PR/checks/merge/local-sync/deployment workflow. Branch: codex/product-feedback-repairs.

## Working rules

- Address functional failures and visual quality together. Do not mark a requirement complete from source edits alone.
- Screenshots are mapped by their content/time because the user's prose numbers differ from the 24 attached images. All prose requirements below remain in scope, including references numbered 25–26.
- Confirm marketing claims against implementation, prompts, accepted inputs, exports and billing rules. Do not invent supported providers, smart semantic answer checking, beta status, origin stories, or guarantees.
- Use isolated preview/test runners and synthetic accounts. Never change the user's real plans, study progress, purchases or uploads for QA. Keep deferred Google Calendar activation off.
- Use visible website controls and opening/closing motion; preserve keyboard focus, reduced motion, authentication, accessibility and data ownership.
- All agents share the checkout. Ownership below is exclusive; parent integrates generated assets and delivery.

## Requirements and acceptance checks

### A. Landing and truthful product presentation

- [x] Remove “A calmer way to study” and the requested notes/flashcards/next-step sentence from the landing hero (22.00.48).
- [x] Explain the core process explicitly: transcribe lecture recording, extract PDF/PowerPoint slide text, combine both into comprehensive structured study notes (22.01.29).
- [x] Reimagine Features around actual benefits and workflows: supported LMS lecture-page/playlist import, slides-plus-audio synthesis, speaker-formatted interview transcription with a visual example, batch processing, useful reader/transcriber tools, study modes and available exports (Word/Markdown/annotated PDF where supported).
- [x] Remove misleading universal-video/YouTube implications, unsupported smart answer detection and obsolete Tools Beta labels. Explain the practical reason for the product without fabricating its historical founding story.
- [x] Remove decorative Recall/Understanding/Practice pills and other unhelpful marketing pills (22.11.12). A Write answer mismatch (22.10.12) demonstrates why semantic grading must not be advertised.
- [x] Center the three credit-category headings above their columns. Explain precisely what extraction/add-on credits buy, and label bundles as slides extraction / add-ons below prices; verify costs against billing implementation (22.53.54).

### B. Study Plan functionality and calendar

- [x] Remove “Goal health” and “Needs attention” from the goal summary (22.27.33).
- [x] Diagnose creation/acceptance failures (22.29.30, 22.35.05) through frontend and backend, including multiple goals, exact times, conflicts, partial saves and retries. Show actionable failure/conflict explanations beside the action, never only a disabled button or generic retry.
- [x] Provide discoverable editing of goal title, selected study packs, deadline/exam date and scheduling, plus a clear plan/goal deletion flow. Preserve study progress; explain what deletion removes. Replanning must not duplicate goals or lose completed work.
- [x] Fix date-picker previous/next-month clicks closing the calendar (22.33.46), including use inside the goal dialog and shared uses elsewhere.
- [x] Use stable, distinct colors for sessions belonging to different study packs, with text labels/status cues retained (22.38.37).
- [x] Verify successful create → accept → reload → edit deadline → replan → multiple goals → delete, and failure/retry/conflict handling with meaningful stateful fixtures/backend tests.

### C. Study Library, due cards and learning navigation

- [x] Redesign folder navigation as tangible, attractive folder rows/tiles, with real folder icons, a clear pinned distinction using a small icon, readable scale at normal zoom, deliberate surfaces and well-contained action menus (22.21.11). Replace ambiguous minus controls with understandable expand/collapse controls only where functional.
- [x] Remove leading zero padding from flashcard/card numbers and corresponding landing/demo numbers (22.25.36).
- [x] Make the Saved indicator much smaller and quieter (22.32.19).
- [x] Dashboard “Due today” must reveal which packs/cards are due and lead into a due-card review, rather than an unexplained generic Library link (22.30.27).
- [x] Dashboard Continue studying and Study Plan Start studying must open the Learn Mode picker directly for the intended pack/session, retaining choice of study mode without visibly stepping through intermediate pages (22.40.47).
- [x] Verify algorithm presets on entirely new packs and packs with missing categories (22.50.02). Avoid empty/broken sessions; show truthful availability/fallback behavior while preserving intended selection semantics.
- [x] Round and tint dashboard upcoming-session/recent-pack hover and focus states (22.58.17).

### D. Batch flow, shared contrast and Voice Notes

- [x] Give disclosure headers their blue/lilac tinted, high-contrast treatment at rest across the site, not only on hover. Keep focus indication distinct (22.17.36, 22.44.42).
- [x] Restore useful LMS import instructions and Brightspace walkthrough guidance on relevant batch variants, matching the single-lecture flow (22.15.59).
- [x] Consolidate sidebar into one Batch Processing link plus Batch Status. Add a clear, animated, accessible switch between instant and deferred batch variants. Preserve the selected processing type and entered files/settings when switching.
- [ ] Implement the requested deferred half-credit discount and matching explanation after the pending customer billing choice (exact half-credit balances versus odd-count rounding). Current timing and credit copy remains truthful.
- [x] Audit the “live progress” claim against actual polling/status updates and correct or complete it as needed (23.00.48).
- [x] Explain local browser audio loss on clearing cache/site data where applicable, without falsely describing server retention as browser-cache-dependent (22.45.59).
- [x] Reduce Voice Notes timer font weight to fit the design (22.52.23).

## Ownership and order

1. Parent saves this plan first, then coordinates implementation and integration.
2. Planner agent: B, except shared date-picker primitive; owns study-plan JS/CSS/template, planner service/domain/routes as needed and its tests. Coordinate navigation contract with learning agent.
3. Learning agent: C; owns Study Library/session and Dashboard JS/CSS/templates and tests. Coordinates planner deep-link contract; no study-plan file edits.
4. Product presentation agent: A; owns landing/Features/credit catalog and relevant presentation assets/tests. Verify facts in source; do not modify billing.
5. Parent: D and shared date-picker/controls, batch/sidebar/Voice changes, integration/review/test suites/PR/release.

## Verification and delivery

- [x] Inspect screenshots at desktop, laptop and mobile; exercise actual user-facing controls at normal zoom.
- [x] Use stateful integration tests for planner lifecycle and due/learn entry. Tests must detect the reported failures, not only assert new markup exists.
- [x] Verify pricing/provider/export claims against source and record conclusions.
- [x] Run scoped checks during work; freeze sources, generate assets, run full relevant backend/client/browser/lint/security checks.
- [ ] Commit, push, PR, attach, monitor checks, merge without bypass, sync main, verify Render exact commit and live assets/pages.
- [ ] Deploy the additive Firestore index with `firebase deploy --only firestore:indexes --project lecture-processor-cdff6 --non-interactive`; confirm the exact planner `uid,date` index is READY and run its read-only transaction query with a synthetic UID. Do not change rules or credentials.

## Progress

Plan saved before implementation. Initial evidence: screenshot of disabled acceptance does contain a conflict sentence, but it is distant from the disabled action and fails to offer usable resolution; repair discoverability and workflow rather than merely adding generic error copy. Initial sidebar currently exposes separate batch routes, and batch headers claim live row progress; verify those paths before changing the wording.

### Parent control/batch checkpoint

- Implemented one sidebar batch entry and an accessible animated speed switch. Strategy changes in place, retaining files, titles and settings; preserves processing type and updates route/history/API target. Submitted jobs lock the speed choice with an explanation.
- Restored numbered LMS import steps and Brightspace walkthrough on lecture/audio batch rows. Shared disclosure headers are tinted at rest; Voice Notes timer now uses a calmer font weight.
- Fixed shared calendar outside-click detection after a month navigation button is replaced (original composed event path). Planner owner is addressing its separate picker.
- Four focused browser regressions passed: all five batch variants retain files on speed switch/back/keyboard navigation, actual submission hits the chosen API and locks until failure/recovery, responsive import guidance and contrast, and next/previous calendar months followed by date selection. Desktop/mobile rendered captures inspected at /tmp/product-feedback-batch-visual (the first capture run was mid-animation; replacement waits for completion).
- Source audit confirms instant jobs persist actual row stage updates; the browser polls about every 20 seconds when visible. Wording now says this explicitly, rather than implying continuously streamed progress.
- **Customer billing decision pending:** existing billing_multiplier 0.5 is AI-provider cost only. Both strategies currently deduct one user credit per item. Asked user whether the requested discount should use exact half-credit balances or two items per credit with odd counts rounded up. No customer billing change or half-credit marketing claim until answered. All independent repair work continues.

### Confirmed production planner failure

Read-only Render logs show the actual failed acceptance at 22:34:59 on 3 October: Firestore rejected the transaction's `planner_sessions` query because its `uid ASC, date ASC` composite index is missing. The live project has `uid, date, time`, which does not satisfy this query. The exact missing index has been added to `firestore.indexes.json`; authenticated Firebase CLI dry-run succeeded. Deploy the additive index after the PR is merged, then verify readiness. No security rules or external calendar services need changing. Planner agent is also adding persistent error/retry feedback and coverage for this backend failure.

Final parent mobile batch capture (390px) was inspected after animation settled: switch, source upload cards, tinted disclosures and numbered import guidance fit without horizontal overflow. Separate custom disclosure controls on Lecture Notes and reader pages now share the stronger baseline tint too.

Parent follow-up QA: creation routes passed at 1440px and 390px (two browser checks across ten routes); Voice Notes timer captures inspected at both sizes in `/tmp/product-feedback-creation-visual`. Added a running-batch history/reload regression, which passes: Back retains the submitted job's strategy and URL; reload lands on its existing Batch Status detail. Test fixture was corrected to use the actual unified status API and server redirect.

### Integration checkpoint — 4 October

Presentation and learning sources are frozen; detailed source audits and test evidence are in `PRODUCT_FEEDBACK_PRESENTATION.md` and `PRODUCT_FEEDBACK_LEARNING.md`. Parent inspected the folder, due-card and mobile planned-picker captures. Planner real-API lifecycle checks passed three scenarios, with desktop/mobile evidence inspected; final backend regression additions are finishing. Shared calendar focus now also survives months containing only disabled dates (both calendar regressions passed).

Initial full backend run: 978 passed, three failures. Two were outdated source/revision test expectations being corrected by their owners. One pre-existing test used local wall time while the service correctly defaults to UTC; midnight exposed it, so the test now uses an explicit fixed UTC clock (four boundary checks passed). Full current client suite: 193 passed. Python/JavaScript lint, repository hygiene and tracked-secret checks passed. Final generated-asset and full browser integration remain pending.

### Release-ready verification

All independent requested repairs are complete; the only pending product decision is the deferred customer-credit discount. See `PRODUCT_FEEDBACK_PLANNER.md`, `PRODUCT_FEEDBACK_LEARNING.md`, and `PRODUCT_FEEDBACK_PRESENTATION.md`. Final isolated backend suite: **986 passed**. Client suite: **193 passed**. Browser coverage: **214 standard scenarios passed** across the integrated run and corrected planner rerun, plus **3 real planner API lifecycle checks** and **1 retained legacy planner check**. The standard run initially had two old UTC/local-midnight fixture failures; all 15 planner checks passed after correcting their clock basis. Final assets rebuilt and checked; JavaScript/Python lint, diff check, tracked-secret and repository-hygiene checks passed. Desktop/mobile captures inspected. CI now also runs the real planner API lifecycle suite.

Next: commit/push/PR, required checks, merge/sync, deploy the additive Firestore index, verify its real query and Render exact commit/assets. No half-credit customer billing claim is included while the decision is pending.
