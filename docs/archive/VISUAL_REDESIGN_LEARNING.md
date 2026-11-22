# Learning redesign — refreshed inspection and implementation record

Baseline: `8449def`, following functional PR #182 (`26077f9`). Read AGENTS.md, master plan, progress and PRODUCTION_READINESS.md on resumption. Earlier implementation was reverted; changes are rebuilt against this baseline.

## Fresh inspection and constraints

Live Chrome read-only inspection on 3 October confirms Today now has Log study done and Reopen session actions, with the strong existing feature-card composition. Dates still mix Dutch browser locale with English labels. Source inspection confirms richer schedule editing, proposal conflicts, excluded/retained sessions, direct calendar connection states and a new focused study overlay. Library now launches planned sessions separately from ordinary practice. Preserve those distinctions and checkpoint/review sequencing. Google synchronization remains disabled; no activation, OAuth, worker or billing changes.

## Updated implementation plan (master sections 4–17)

- Dashboard: compact heading; actionable continue card, balanced metrics with stable skeletons; readable upcoming dates, no duplicate titles, meaningful material metadata and helpful empty states.
- Plan Today/Schedule/Progress: retain feature composition; consistent English date formatting; compact sparse schedule; three-by-two metric grouping, unmeasured accuracy distinction; clarify status and wrap long titles/actions.
- Plan wizard/dialogs: scrolling body with persistent progress/footer; anchored date/time/pack menus and searchable pack choices; polished conflict, retained-session, log/reopen, calendar-provider and failure states. Keep all new actions and existing payload behavior.
- Focused planned study: readable centered work area, clear timer/progress hierarchy, accessible shared timer selector, distinct question feedback, polished pause/break/summary/checkpoint errors; retain server/local retry, leave, resume and completion guards.
- Library: visible heading; compact folder rows and contextual controls; deliberate folder/list/reader proportions; search and count next to list; metadata behind disclosure; stable Learn primary action; purposeful unselected state; mobile list/detail back navigation.
- Pack material: reading width and typography, coherent tabs and exports, lighter highlight tools, context-preserving fullscreen and audio spacing. Keep save and content availability feedback.
- Builder: unified header/rail, comfortable details form, persistent save/exit, collapsed item summaries, compact picture attachments, well-labeled question options and CSV behavior. Preserve lazy large-list rendering and all input IDs.
- Free-study setup and modes: strong mode hierarchy, responsive non-square option grid, calm algorithm presentation, accessible footer; unify flashcard/test/write/match card, grading, progress and results styling without removing supported modes.
- Pictures/audio/folders/sharing/coding: shared surfaces and controls; compact player and attachments; searchable code selector; transcript emphasis; quiet Reset overflow; distinguish saved and pending share state.
- Shared links: same reading language, navigation to material sections, revealable answers, compact shared-folder choices and deliberate loading/unavailable states.
- Legacy `/calendar` and `/stats`: retain v2 redirects. Retained fallback Plan/Calendar date inputs now use the shared calendar with ISO persistence; reminder time control retained and surrounding controls migrated.

## Verification strategy

No normal application server or real upload storage. Await parent isolated runner, then run relevant existing pytest/Playwright suites and fixture-based rendered desktop/mobile checks. Visual QA must include long titles, tall wizard, 165-card builder, picture attachments, focused-study pause/question/summary, shared folder and absent-content states. Source changes alone are not completion.

## Implementation / QA

In progress. No implementation or local visual verification yet at initial report creation.

## Implemented learning composition

Library now has a visible page header, compact folder tree/actions, separate list and reader, readable metadata behind disclosure, consistent pack actions and mobile return control. Builder and inline editors use expandable item summaries; new items open/focus automatically. Pictures use compact attachments and an animated accessible native viewer. Setup leads with accessible mode selection and preserves multiple selected modes, including the original Flashcards + Practice test default and Write/Match. Dashboard now prioritizes the next session and readable activity. Shared links include material navigation and answer disclosures. Plan has balanced progress metrics, explicit English date labels, scrolling wizard body/fixed actions, searchable long lists and top-layer anchored menus. Planned sessions retain all checkpoint/completion logic with clearer timer, content and answer feedback.

Verified so far: 24 source-only UX contract tests; ESLint all owned JS; 25 original browser flows initially, then fixed planner scroll/popover regression with a passing targeted test. Rendered Library, setup and 165-card Builder inspected at 1440 and390 pixels. Found and corrected animation-in-progress captures, hidden audio bar showing in full-page captures, and mobile builder minimum sizing. Final broader browser run is in progress (updated native-select tests now use visible shared control, picture close waits for closing motion).

## Added scope: Book Studio and Video Overlay Builder (30–31)

Fresh local read-only Chrome inspection: Book shelf uses separate serif/Nunito interface, ungrouped shelf filters/native sort and a generic setup grid. Preserve all expressive book content fonts and themes; harmonize only interface, improve shelf controls/setup cards, editor toolbar/inspector composition and dialog motion. The book editor already has advanced controls; avoid replacing its working color/path/selection logic.

Overlay Builder inspection confirms crowded project actions, always-visible irrelevant new-table fields, recording controls above a small blank canvas, and a single overloaded sidebar containing both navigation and settings. Recompose into compact project header, navigation rail, central canvas with insertion tools, separate contextual inspector, recording disclosure, and purposeful empty stage. Preserve16:9 geometry, project storage and recorder/export behavior. Tests use isolated temporary preview storage and synthetic fixtures.


## Final handoff / source freeze — 3 October

Learning implementation complete within assigned scope. Follow-up review restored multi-mode selection without discarding preferences; regression covers enabling Write alongside Flashcards/Test. Searchable planner menus preserve Home/End text editing and use Enter to choose a sole result or focus the first result. Planner popover geometry uses parent CSSOM helpers and removes rules on close. Four calendar native confirmations now use asynchronous shared dialogs. Google activation remains deferred.

Book Studio now uses the shared interface typography, compact shelf filters/counts and template choices, shared searchable font/inspector selectors, neutral canvas chrome, wrapping toolbar, improved dialog opening/closing and accessible sticky close/export controls. Expressive document fonts, themes, geometry, storage and export logic preserved. Decorative template glyphs have explicit accessible button names. Overlay Builder now separates compact navigation, canvas/insertion tools and contextual inspector; project utilities and table sizing are disclosed, recording sits below canvas in a disclosure, and canvas resizes when recording expands. Presentation mode hides the new interface areas. Retained legacy Plan/Calendar have shared date controls, ISO saves, consistent controls/surfaces and usable mobile session dialogs.

### Verification

- Learning final15 Playwright tests passed (Library/navigation/large165-card Builder, picture upload/edit/viewer, focused study/countdown/Pomodoro/checkpoint/reopen, Dashboard/shared folder). All run on isolated temporary preview storage and synthetic fixtures.
- Editor/planner46-test run45 passed; one test still expected a replaced native select to be visible. Corrected to assert the actual visible control; targeted mobile layer/settings regression passed. This run included local book text/fonts/shapes/tables/path controls/images/exports/mobile, planning availability/conflict/log/reopen/calendar actions, creative layout screenshots, Overlay table/animation and recording/presenter checks.
- Legacy-flag browser test passed: selects an exam date and verifies the exact ISO PATCH, opens calendar session editor, checks nested-picker Escape and mobile width.
-24 earlier learning source-only contracts passed; owned JS/test ESLint and git diff --check passed. No unisolated application pytest or normal app server used.
- Rendered evidence inspected: Library/setup/Builder1440+390; Plan progress/schedule/tall wizard390; focused study desktop/mobile; Dashboard/shared folder desktop/mobile; Book shelf/template/editor/mobile and640×480 export with reduced motion; Overlay desktop/mobile plus presenter regression; legacy exam-date table/mobile session dialog. Evidence preserved in `/tmp/redesign-learning-evidence` with learning/plan/creative/legacy subfolders.
- Iterations fixed observed mobile builder sizing, fullpage hidden audio leakage, tall wizard viewport/actions, popover scroll/focus, picture close timing, template accessible labels, and recorder disclosure canvas sizing.

### Limits and integration needs

Parent owns full integration, builds/minified assets, broad suites and deployed verification. No commits or builds performed here. Real external Google sync, cloud sharing/auth, microphone permission and screen capture were not exercised; fixture tests cover UI/recording transitions without sending user data. Legacy fallback retains its existing Flatpickr time-only widget while dates use the shared component. Actual200% browser zoom not separately exercised;640×480 and390px checks cover constrained viewport layout, and Book export checked with reduced motion. Long-content/empty/error cases covered where fixtures exist; not every coding/AI suggestion and audio-network failure state has a separate new screenshot. Source changes preserve their existing behavior.

Final visual-density iteration: removed the Library's generic introduction, compacted header/summary/plan row/details/action/tab spacing while retaining hierarchy. The first notes surface now passes a <640px-top assertion at1440×1000. Overlay geometry fields use a2×2 layout, eliminating clipped W/H values. Final focused3-test run passed: Library density/multiple-mode regression +165-card Builder/mobile, planner searchable-menu Home/End/Enter, creative editor/rendered desktop/mobile/reduced-motion small dialog. Re-inspected final Library and Overlay screenshots and refreshed preserved evidence. Source freeze ready for parent integration.


## Final scope-gap closure

Added `e2e/learning-final-flows.spec.js` synthetic fixtures for free-study Write incorrect/correct/revealed feedback and completion; Match incorrect pairs, completion, score history and Play Again; interview-coding draft review, accept, reject preserving manual codes, and explicit code-merge confirmation/payload. New screenshots exposed and drove actual fixes: coding's earlier responsive rule was overridden, squeezing away the transcript on mobile; transcript grid stretching created excessive gaps; focus scrolled the desktop toolbar away. Corrected responsive rule placement, viewport-bounded scroll, top-aligned transcript and preventScroll focus. Narrow Write controls now stack the input above Check/Reveal so neither action is clipped. Coding review actions appear once in the draft panel.

Library notes export is consolidated under Export: original Word notes and annotated PDF are available. The redundant highlight-toolbar download button is hidden in normal Library, but remains available in fullscreen reading where the Library export control is outside the fullscreen surface. Optional annotated export binding is guarded against absent template controls. Updated durable Library screenshot reflects this consolidation.

Existing navigation/pictures plus new flows:14 browser tests passed after the coding fixes and optional-element guard, on a fresh isolated runner. Final5 focused browser tests passed, including narrow Write control bounds and both real UI export requests/downloads. Final mobile Write and coding draft captures re-inspected; controls and transcript now readable. Source frozen again for parent integration. Captures live under `/tmp/redesign-learning-flows-verified`; selected images copied into `/tmp/redesign-learning-evidence/final-flows`. No real AI runs, uploads, generation credits, or user-data writes occurred: all coding mutations and exports were handled by in-test fixtures.

### Browser-default control sweep (user follow-up)

Migrated library folder/pack tools, every dynamic folder action menu, Coding More actions, and Overlay More actions to the shared animated `data-app-menu` component. These now use anchored top-layer panels, purpose-built SVG triggers, shared keyboard navigation, outside/Escape dismissal and focus handling. Removed local absolute menu positioning and duplicate close handlers. Genuine Book inspector/export/history groups, pack metadata, Builder rows, Overlay Table size and recording controls use the shared animated disclosure component; removed Book's second CSS chevron and competing animation. Table size expands inline instead of floating a form over its canvas.

A fresh control inventory found all Study/Builder/Book visible selects already enhanced, Overlay selectors already custom animated controls, date fields already custom, and file inputs hidden behind styled upload controls. Book's established custom color picker remains. No native `window.alert`, `confirm` or `prompt` calls remain in the owned Study/Book/Overlay files. Found and corrected the Overlay custom selector SVG rendering as a solid triangle: it now has explicit stroke/no-fill chevrons. System file chooser and browser permission prompts remain browser-owned by necessity, with styled in-product triggers.

Rendered captures inspected: Coding More actions open, Overlay More actions open, Book text-spacing disclosure expanded, Overlay table-size/recording expanded. Menus fit their anchors and Book has one chevron per section. Test updates explicitly reopen a folder menu after choosing an action and wait for opening motion before checking touch-target bounds.

Verification: final navigation suite **7 passed**, creative editor suite **1 passed**, and final-flow suite **5 passed** with Coding menu keyboard open/Escape close. ESLint and `git diff --check` clean. Final custom-chevron Overlay capture re-inspected. No remaining native disclosure markers or conflicting local action-menu positioning found in owned surfaces. Source frozen for integration.

### Closing motion and computed control verification

Study Export and its PDF submenu now animate opacity/translation/visibility in both directions and become inert immediately on close. Menus are anchored within the viewport; the narrow hidden Export geometry no longer adds horizontal document overflow. Book path context menus and the established color picker now animate entry/exit with reduced-motion support. Color picker close-to-reopen cancels the previous animation without losing keyboard focus or hiding the newly reopened panel.

Added the shared `expectProductControls` computed-style audit at screenshot states for learning/navigation, coding/Write/Match, Dashboard/shared material, Study Plan (including narrow wizard), Book and Overlay, plus the open Book color picker. It excludes hidden/inert/backing inputs and checks actually rendered native defaults. The final learning-flow/picker regression run passed **10 tests** including both notes downloads, responsive coding, invalid color input, keyboard boundaries, mobile visual viewport, pointer ownership, and same-event picker close/reopen. Earlier matrix passed the Dashboard/shared/Plan control assertions and all navigation/creative screenshots. Updated motion-bound tests to wait for settled bounds; no fixed sleeps.

### Native form-validation bubbles

Study log form now uses `novalidate` so its existing numeric custom validation runs. Other forms retain native constraint blocking; shared `invalid` capture suppresses only the browser bubble and displays `validationMessage` in a styled inline alert. Original fields and enhanced select/date triggers receive error descriptions and invalid state, preserving existing description IDs. A single deferred focus per validation batch selects the first invalid rendered control. Corrected fields remove only this helper's feedback. Removed older enhanced-control invalid handlers that could move focus to the last invalid field.

Two focused browser tests passed: required/min values block submission, show inline messages, prevent the default bubble, focus the first field, retain existing help text, and clear on correction; enhanced select/date errors focus their visible replacement controls. ESLint and diff check clean. Source frozen.

### Final Overlay fit regression

Full-suite testing exposed stale canvas dimensions while the recording disclosure animated open. Added a coalesced ResizeObserver to the stage frame, using actual available bounds instead of the old 160px height floor. Retained a 260px canvas row and allowed the stage panel to scroll when Table size and recording controls both expand, preventing the canvas from collapsing to a tiny thumbnail. Explicit zoom can still exceed the frame. The smoke assertion now waits for disclosure motion and the real fit condition, retaining its existing fit/no-scroll/zoom/table-content checks.

Targeted Overlay smoke passed, and creative desktop/mobile regression passed; expanded-disclosure capture inspected. ESLint/diff check clean. Source frozen.
