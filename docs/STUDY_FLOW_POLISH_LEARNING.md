# Study flow polish — Library and learning

Implemented requirements 3–5, 9 and 11–15 in the active 4 October plan. Source ownership: Library template/CSS/JS, library/session utilities, planned-study adapter and study-run lifecycle. Parent owns integration; creation owner implemented atomic planned-review persistence after independent review identified the earlier client acknowledgement gap.

## Result

- Every entry point opens the same Library session setup and uses the same Flashcards, Test, Write, Match or Notes viewer. Planned tracking is an embedded toolbar instead of a second viewer. All eligible modes contribute to the same run; changing mode preserves existing planned targets, answers, retries and timing. Selected planned mode starts immediately.
- Countdown/Pomodoro remain fixed after timing starts. The toolbar explains pausing, displays saved answers and remaining slot, pauses at the deadline, and provides explicit Continue/Finish controls. Inactive/break study controls are inert; visibility and account changes stop the clock safely.
- Exact viewer state is saved per account, pack, content version and optional plan item: card order/position/reveal, question order/answer feedback, checked Write answer, Match order/partial pairs/current selection/time, notes scroll and current mode. Device-only position is labelled honestly. Server saved planned answers provide the first unfinished target when no local viewer checkpoint exists.
- Stale mode generations cannot overwrite newer modes through checkpoint merging or API writes. A conflicting unsynced local checkpoint is retained separately with an explicit message rather than silently applied to another mode.
- Planned review acknowledgements merge canonical server progress and never increment client SRS a second time. The backend now commits review receipts and progress atomically; free practice retains its existing sync semantics.
- Pack rows have a persistent tinted surface and border. All Study Packs now actually collapses custom root folders; per-folder menus delete only the folder while preserving packs and moving them to Unorganized. Subfolders move up as the existing service specifies. The Unorganized filter is available independently.
- Annotation Cmd/Ctrl+Z, Shift+Cmd/Ctrl+Z and Ctrl+Y operate while notes are visible, with text inputs/editors and dialogs retaining their own keyboard behavior. Builder explains using an existing AI subscription with materials and the CSV template, reviewing output and importing it.
- Fixed a real viewer layout defect found by browser testing: flex shrinking let the grading toolbar overlap Next. Long viewer content now scrolls without collapsing controls. The progress fill sits inside its track, and empty question explanations stay hidden.

## Verification

All testing uses isolated temporary-storage runners and synthetic users. No real plans/progress were changed.

- 29 scoped client utility tests passed, including root collapse, Unorganized filtering, every algorithm preset with missing categories and stale mode-generation fencing.
- Earlier 17 study-run/backend invariant tests passed before creation's durable receipt layer; creation reports 67 focused backend checks plus 11 strengthened durability cases passed afterwards.
- Nine browser checks passed after viewer/layout repairs, covering desktop/mobile folder composition, contained menus, Dashboard due-only entry, common setup, priority presets, empty due queues, question-only content, exact checked Write and partial Match restore, root collapse and Unorganized.
- Final 11-case rerun adds per-folder deletion preserving packs and annotation keyboard undo/redo. Results recorded below after completion.
- Parent owns the rewritten planned lifecycle/browser tests and independent real-API tests. Parent reported real-API success including a committed checkpoint with an intentionally lost HTTP response followed by reload without lost/double SRS credit.

## Limits

Exact view position is local-device state; committed planned answers and progress are server-backed. Physical mobile keyboards and real Safari were not exercised. Real payment, AI, Calendar and production study data were not used. Generated assets and full integration/release verification belong to the parent.

Final scoped result: **11 browser checks passed** (`/tmp/study-flow-ui-final.log`), plus **one Notes reading-position + Builder import guidance check passed** (`/tmp/study-flow-reading2.log`). The latter confirmed the nested notes scroller, so all relevant scroll levels are now saved/restored. **29 client checks**, scoped ESLint and `git diff --check` passed. Desktop/mobile folder-menu and restored Match captures were inspected and preserved in `/tmp/study-flow-learning-evidence`. Parent's independent planned/stateful suites cover the latest adapter and server receipt integration. Sources frozen for full integration.

Independent parent visual review caught a legacy mobile mode-card padding override that removed the icon gutter. Corrected the existing mobile rule and verified measured icon/title separation plus a settled 390px screenshot. Test mode now omits blank padded options, with a two-option question regression. Both final browser checks passed (`/tmp/study-flow-layout.log`); current scope has **13 distinct passing browser scenarios**. Settled setup screenshot was visually inspected and added to `/tmp/study-flow-learning-evidence`. Scoped lint and whitespace checks remain clean.
