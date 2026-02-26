# AI Feedback Batched Plan (Working Checklist)

Use this file as the source of truth for implementation order from the two AI feedback lists.
Status values:
- `DONE`: implemented and validated in app/tests
- `N/A`: intentionally deferred or merged into another item

## 0) Current snapshot

- P0 core blockers from first feedback list: resolved.
- P1 reliability hardening: resolved.
- Trust/compliance minimum (privacy/terms/export/delete): implemented.
- Public paid launch: still blocked by Stripe live switch + legal review.

## 1) Batched roadmap (implemented)

### Batch 4 (DONE): Study-data integrity + SRM correctness
Goal: fix the highest remaining product correctness risks around study progress.

Items:
- `#4` Server-sync study state as source of truth (streak/goal/card state consistency)
- `#24` Unify streak/goal/due logic across dashboard/study/planner (single module/logic path)
- `#25` localStorage cleanup/indexing for old pack keys
- `#30` Timezone handling consistency for due/streak boundaries
- Second AI: LocalStorage conflicts/syncing (same issue), interval rigidity improvements

Acceptance checks:
1. Same user sees same due/streak/goal across two browsers.
2. Deleting a pack removes local cache/index references and due counts do not include deleted packs.
3. Timezone change test does not reset streak incorrectly.
4. Regression tests pass: `tests/test_launch_guardrails.py`.

### Batch 5 (DONE): Study UX and onboarding
Goal: reduce friction for first-time users and improve conversion clarity.

Items:
- `#12` Progressive disclosure polish (continue)
- `#14` Results CTA simplification polish (continue)
- `#16` Onboarding tour/demo pack
- `#26` Better empty states (remaining surfaces)
- `#29` Study-tools default/recommended path experiment
- Second AI: empty state onboarding + default study tools behavior

Acceptance checks:
1. First-time user can complete first run with one obvious path.
2. Library empty state gives direct “start here” action.
3. Results sidebar has clear primary action with reduced clutter.

### Batch 6 (DONE): Accessibility and UI quality
Goal: close remaining a11y and consistency gaps.

Items:
- `#18` Contrast/focus-state audit and fixes (Lighthouse/axe)
- `#19` Keyboard nav remaining custom controls (if any residual)
- Second AI: semantic buttons/aria leftovers

Progress update:
- `DONE`: global `:focus-visible` treatment added across primary templates (`index`, `study`, `plan`, `admin`)
- `DONE`: dashboard mode tabs + results tabs now include ARIA tab semantics and arrow/home/end keyboard navigation
- `DONE`: manual Lighthouse accessibility pass completed on dashboard (score: 100)

Acceptance checks:
1. Keyboard-only nav works for primary flows.
2. Lighthouse accessibility score target agreed and reached.

### Batch 7: Product trust/policy clarity (DONE)
Goal: clarify data handling and user expectations in UI copy.

Items:
- `#21` Audio/transcript storage privacy/deletion clarity in UI
- `#22` Calendar reminder expectations copy hardening
- `#20` Legal text quality review (already implemented pages, now legal quality pass)

Progress update:
- `DONE`: Study Library now shows per-pack audio/transcript storage and deletion guidance in the pack summary panel.
- `DONE`: Calendar reminder copy now explicitly states browser-tab/session constraints and clarifies no email/push reminders yet.
- `DONE`: legal-language quality pass completed for `privacy` and `terms` pages (with counsel-review notice retained).

Acceptance checks:
1. Users can clearly understand what is stored and how to delete.
2. Reminder behavior is explicit in all reminder surfaces.

### Batch 8 (DONE): Maintainability refactor (non-blocking, high leverage)
Goal: reduce template tech debt for future velocity.

Items:
- `#23` Extract shared CSS/JS from huge templates; modularize
- `#24` (if still remaining after Batch 4) fully centralize study-progress logic
- lint/format pipeline hardening

Progress update:
- `DONE`: legal page duplicated styles extracted to shared static stylesheet.
- `DONE`: shared frontend HTML safety utilities extracted to `static/js/html-utils.js` and reused by `index`, `study`, `plan`, and `calendar`.
- `DONE`: shared auth/token fetch helper extracted to `static/js/auth-utils.js` and reused by `index`, `study`, `plan`, `calendar`, and `admin`.
- `DONE`: shared download/export helper extracted to `static/js/download-utils.js` and reused by `index`, `study`, and `admin`.
- `DONE`: shared topbar/auth UI helper extracted to `static/js/topbar-utils.js` and reused by `index`, `study`, `plan`, and `calendar`.

Acceptance checks:
1. Shared utilities/styles no longer duplicated across templates.
2. No behavior regressions in smoke tests.

## 2) Detailed item-by-item status (first feedback list)

### P0
- `#1 XSS risk`: `DONE` (remaining dynamic `innerHTML` hotspots replaced/sanitized; shared safe HTML helpers used)
- `#2 Markdown regex parser`: `DONE` (shared marked + DOMPurify parser path via `static/js/markdown-utils.js` used in dashboard + study)
- `#3 Flashcard correctness logic`: `DONE` (flip no longer auto-masters card; grading flow used)
- `#4 localStorage-only progress`: `DONE` (server-synced study progress with deterministic merge and shared summary path)
- `#5 Google allowlist post-sign-in`: `DONE` (blocking functions before create/sign-in configured)
- `#6 replaceState('/') bug`: `DONE`
- `#7 Admin link visible to all`: `DONE`

### P1 reliability/backend
- `#8 server-side file validation`: `DONE` (size/content-type/signature checks)
- `#9 polling hardening`: `DONE` (backoff, max runtime, retry control)
- `#10 token refresh/auth fetch`: `DONE`
- `#11 authenticated downloads consistency`: `DONE` (major routes standardized)

### P1 UX/a11y
- `#12 dashboard clutter`: `DONE` (default path + advanced settings + focused primary CTA flow implemented)
- `#13 credit cost clarity`: `DONE` (cost summary + availability messaging)
- `#14 too many CTAs`: `DONE` (results actions simplified: primary Start studying, secondary Download, tertiary More actions)
- `#15 mode naming/mental model`: `DONE` (Slide Extract naming and interview-extra cost messaging now explicitly tied to slide-processing pipeline and slides credits)
- `#16 onboarding gap`: `DONE` (first-run quickstart card + Study Library demo pack action)
- `#17 modal accessibility`: `DONE` (focus management/keyboard handling implemented for key modals)
- `#18 contrast/disabled states`: `DONE` (focus visibility improved globally + Lighthouse accessibility score 100 on dashboard)
- `#19 keyboard accessibility`: `DONE` (custom dropdowns + dashboard tab groups support full keyboard traversal)

### P2 trust/polish
- `#20 privacy/terms/data rights`: `DONE` (minimum implementation complete + wording quality pass done; legal counsel review still recommended before public launch)
- `#21 audio/transcript storage expectations`: `DONE`
- `#22 calendar reminders expectation copy`: `DONE`

### P2 maintainability
- `#23 massive inline CSS/JS`: `DONE` (shared utility modules extracted and reused across templates: auth, topbar, downloads, UX focus, HTML safety, markdown parsing)
- `#24 duplicated streak/goal/due logic`: `DONE` (shared server summary consumed by dashboard/planner/study sync path)
- `#25 localStorage key cleanup`: `DONE` (indexed keys + stale key cleanup on hydrate/delete)

### P2 premium UX
- `#26 better empty states`: `DONE` (study library onboarding/demo pack, builder empty-state actions, clear-filters action, purchase-history empty-state CTA)
- `#27 processing estimates/constraints`: `DONE`
- `#28 download/export naming consistency`: `DONE` (dashboard + study library export naming aligned around Lecture Notes / Slide Extract / Lecture Transcript labels)
- `#29 study-tools understandability`: `DONE` (recommended default = Flashcards + test, chip badge, quickstart apply preset)

### P2 correctness/edge
- `#30 timezone edge cases`: `DONE` (timezone-aware summary boundaries + invalid timezone fallback)
- `#31 CSV parser robustness`: `DONE` (Papa Parse path + validation)
- `#32 extras refund authority`: `DONE` (backend now returns billing receipt with charged/refunded credit ledger for interview extras; frontend shows receipt text)

### Operational checklist
- `#33 analytics + funnels`: `DONE`
- `#34 error monitoring`: `DONE` (Sentry FE+BE)
- `#35 rate limiting/abuse`: `DONE` (upload/checkout/analytics + cooldown UX)
- `#36 backups/retention/deletion`: `DONE` (export/delete flows + formal operational retention/backup policy documented in `docs/DATA_RETENTION_BACKUP_POLICY.md`)

## 3) Second AI feedback status summary

- LocalStorage sync conflict: `DONE` (server-authoritative merge + summary sync)
- Unsaved changes paradox/autosave in builder: `DONE` (debounced autosave added in builder edit mode with visible saving state)
- Credit calc edge case for interview extras: `DONE` (disabled/availability logic added)
- Backend file limits/validation: `DONE`
- Flashcard double-flip confusion: `DONE`
- Study tool defaults (No tools default): `DONE` (recommended default + persisted preference)
- Empty state onboarding: `DONE` (dashboard quickstart + library demo pack CTA)
- Planner table-to-cards mobile: `DONE`
- Consolidate headers shared nav: `DONE` (shared protected-page auth shell and shared auth CTA wiring in `topbar-utils.js`)
- Hidden settings in builder: `DONE` (semester/block moved behind advanced metadata toggles in study builder/editor)
- Mobile credits tooltip behavior: `DONE`
- SRM interval rigidity (SM-2-like): `DONE` (difficulty-aware interval growth/drop logic now used instead of rigid fixed steps)
- Polling timeout/error boundary: `DONE`
- Loading skeletons: `DONE` (purchase-history loading skeleton state added)
- Stripe webhook authority: `DONE`
- Accessibility semantics remaining: `DONE` (calendar modal dialog semantics finalized and keyboard paths verified)

## 4) Next batch we will run

**Next batch: Batch 9 (remaining product hardening and UX) — DONE.**

Execution order inside Batch 9:
1. `DONE` `#15` Mode naming / mental model clarity (including interview extras credit-language clarity).
2. `DONE` Second AI “Unsaved Changes paradox” in builder: autosave + clearer dirty-state behavior.
3. `DONE` `#23` extracted shared modal/dropdown keyboard focus helpers to `static/js/ux-utils.js` and wired into `index` + `study`.
4. `DONE` `#23` consolidated shared protected-page header/auth shell behavior (`signout + signed-in/signed-out shell`) via `topbar-utils.js`, wired in `plan` + `calendar`.
5. `DONE` `#23` consolidated shared header/nav auth CTA behavior (`features` and `landing`) via `topbar-utils.bindAuthCta`.
6. `DONE` `#23` continued modular extraction with shared markdown sanitizer utility and remaining safety/UX cleanup.

All items from the two AI feedback lists are now implemented or intentionally folded into implemented equivalents.
