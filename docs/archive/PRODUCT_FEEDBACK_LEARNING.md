# Product feedback repair — Library, Dashboard and learning

Scope C from PRODUCT_FEEDBACK_REPAIR_PLAN.md. Owned by the learning implementation agent; planner lifecycle and shared UI remain with their respective owners. No production user data was changed. All browser fixtures use the isolated preview runner and synthetic accounts.

## Implementation

- Folder navigation has full folder SVGs, white rounded surfaces, clearer selected states, readable titles, a small accessible pin icon, and contained shared action menus. Expand/collapse appears only for actual children, uses chevrons and 200 ms height/opacity motion, returns keyboard focus, and skips motion when reduced motion is requested. Mobile retains the existing All packs navigation and larger touch targets.
- Card/question numbering uses 1, 2, 3 rather than padded numbers in the Library editor and Builder. The Saved status is small, quiet text.
- Dashboard Due today opens a tinted disclosure containing actual owned packs and card prompts, each with a due-review action. Empty, loading and retry states are explicit. The authenticated due endpoint scans all card states, filters due candidates first and bulk-fetches only relevant packs; it excludes unstudied, future, archived, deleted, foreign and removed cards. Existing due totals count flashcards only, matching this queue. Account changes invalidate pending response rendering and clear prior details.
- Due-review deep links load the selected pack's authoritative progress before presenting Flashcards/Write choices. New and future cards are excluded, original card indices remain intact for progress writes, and an empty due queue never falls back to all cards.
- Dashboard Continue studying points directly to `/study?pack_id=…&mode=learn&plan_item_id=…` for a planned session, or the latest pack's mode picker otherwise. The planner owner retains the same link contract.
- Direct learning links immediately show a mode picker in the existing modal, without exposing the intermediate settings pane. Planned choices are Review, Flashcards, Practice test and Notes when content supports them; Resume preserves an existing mode. A separate clearly labelled free-practice entry retains Write/Match and explains that it does not complete the scheduled slot. Compact mobile choices fit in two columns. Closing no longer switches back to setup during the closing animation.
- Tracked-run queues honor the selected supported mode while preserving timer, checkpoint, ownership and completion semantics. Omitting timer/mode preserves existing values. A started session cannot silently change mode; server and local unsynced-progress guards explain how to resume. Notes-only sessions survive pack-content rebuilds.
- Algorithm priority presets already fall back across available categories; all five presets now have coverage with new cards and missing categories. Inline copy explains the actual behavior. Opening settings for a different pack restores an available default when saved mode preferences would otherwise leave no applicable selection.
- Dashboard list hover/focus surfaces are rounded and softly tinted.

## Verification

- 36 targeted backend/route/accessibility checks passed, including due completeness beyond the progress-sync cap, ownership/deleted/archived/new/future exclusions, tracked mode filtering, preserved Pomodoro preference, saved-answer resume, unsupported mode rejection and notes-only content updates.
- 10 session utility tests passed; priority matrix checks every real preset on all-new and missing-category states for complete unique queues.
- 17 browser regressions passed across new feedback routes, planned-session lifecycle, existing Library navigation and Dashboard/shared surfaces. An additional focused six-test feedback run passed, including every preset through actual UI controls, due-only entry and empty-due behavior.
- Desktop and mobile captures were inspected. Evidence: `/tmp/product-feedback-learning-evidence` (`folders-1440.png`, `folders-390.png`, Dashboard due at both sizes, free picker desktop and planned picker mobile). Folder menu bounds, functional collapse/expand, page overflow and product controls are asserted in fixtures. Mobile folder QA uses the real All packs control before navigating folders.
- ESLint passed for modified JavaScript and browser tests. New endpoint and folder accessibility source-contract assertions were updated. The final planned local-progress regression passed: switching mode cannot discard unsynced device progress. The updated Dashboard/Study UX contract suite passed all 24 checks. A question-only browser regression also passed: the direct picker offers Test without unavailable flashcard modes. Sources are frozen; parent owns generated assets and full integration.

## Limits and integration notes

- Browser tests use synthetic data and mocked API responses; backend tests independently verify new service behavior. No real account plan or progress was altered.
- Write and Match remain free practice, rather than being represented as tracked modes without a corresponding focused-run engine.
- The all-packs due list intentionally fetches complete actionable work on demand, not on every Dashboard load.
- Parent must regenerate bundled assets and perform complete integration checks before delivery. No commit, asset build or deployment was performed by this agent.
