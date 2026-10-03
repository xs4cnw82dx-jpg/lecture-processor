# Batch Status — fresh design pass

Inspected commit `26c06c4`, its templates/renderers, the live Chrome list/detail flow and the user's failed-batch screenshot. The new archive behavior is useful, but the presentation still reads as a large white slab: small type, thin hierarchy, a repeated provider failure at batch and item level, and equally weighted recovery/utility actions.

## Composition

1. Constrain the workspace to a purposeful 1200px reading width. Use a compact eyebrow, generous title and short lead. The list gets a quiet segmented view bar, integrated filter disclosure and scannable progress rows.
2. Remove the detail page's enclosing shell-panel. Put the title above two deliberately separate surfaces: a status/progress summary and a compact credit receipt. Place recovery/download actions with the outcome; archive/refresh remain quiet utilities.
3. Explain a common batch failure once. Result cards have a numbered identity, status, concise outcome and optional failure disclosure. Raw diagnostics remain nested/collapsed and escaped. Do not repeat the same provider explanation on every unopened card.
4. Display actual completion progress with a labeled meter, ready/failed totals and state-specific guidance. All-refunded, partially refunded, pending refund and charged credit states remain distinct and truthful.
5. Completed rows offer well-grouped exports; pending rows show stage; failed rows explain recovery without implying a one-click retry exists. Preserve ZIP readiness, authentication, polling, archive/restore/undo, dismissal and account-switch protections.

## Interaction and responsiveness

- Study Plan foundation: cobalt #2558d9, navy #17233c, blue-gray #65718a, canvas #f6f8fc, 18px surfaces, 11px controls.
- Shared enhanced filters where available, clear selected/focus states, animated disclosure content/chevrons and reduced-motion support.
- Stable loading skeletons, intentional empty/no-match/auth/failure states, retained results after refresh failure.
- Desktop summary split, mobile stacked summary/receipt, actions that wrap without clipping, card-like list rows on small screens. Long titles/diagnostics wrap without expanding the viewport.

## Verification

Run focused renderer unit tests and Batch Status browser tests. Add coverage for repeated-error suppression, state-specific progress/credit treatment, responsive actions, keyboard disclosure persistence and contrast. Review generated screenshots at desktop/mobile, including failed, active, complete, partial, empty and long-title cases. Source asset interception in tests must include batch-status.js until the parent's shared build regenerates minified assets.

## Implementation and QA — resumed on `8449def`

Implemented the composition above in the template, consolidated Batch Status stylesheet, shared batch renderer and dashboard controller. The enhanced filters retain native values and URL/back behavior. Disclosures animate open/closed, support keyboard operation and preserve expansion/focus through polling. Progress uses SVG attributes because runtime CSP correctly rejects inline style attributes.

- Focused unit checks: **7/7 passed** (`node --test tests_js/batch-status.test.js`).
- Isolated browser checks: **12/12 passed**, 12.9s final run (`PLAYWRIGHT_PORT=5132 PHYSIO_E2E_PORT=8772 npx playwright test e2e/batch-status.spec.js --workers=2`).
- Focused ESLint and whitespace checks passed.
- Reviewed actual screenshots of failed desktop/mobile, completed desktop, partial mobile, processing tablet, and empty mobile. Captured normal and long-title list/detail views at 1440/390 and processing/partial/completed at 1440/1024/768/390 in `/tmp/redesign-secondary-evidence/batch/`. Captures finish finite animations so selected tabs/progress are visually settled. Evidence was regenerated after parallel Playwright cleanup removed the original output directory.
- Verified archive/restore/Undo, dismissal after refresh, direct links, retained downloaded results after refresh failure, authenticated ZIP route, submission focus without clearing selected uploads, account switching, terminal refund/email polling, disclosure focus persistence, filters/back, and failed archive recovery.
- Added explicit rendered progress geometry/fill assertions after screenshot review exposed a CSP issue. Raw diagnostic markup remains escaped.

No production batches changed. Local server/testing used only the isolated runner with fixture accounts and temporary storage. Minified assets are intentionally left to the parent build. Remaining integration checks: full shared-shell build and deployed smoke verification; actual browser 200% zoom and assistive technology were not independently exercised in this section. Loading/auth/unknown-state source paths and unit coverage supplement the rendered state fixtures.

Follow-up: native disclosure treatment removed in favor of shared automatic SVG chevrons/accordion animation and `data-app-menu` overflow actions. Deleted Batch's delegated summary animation and Escape handler to prevent conflicting toggles. Menu wrapper preserves action IDs/delegation. The combined scoped suite passed **25/25**, including desktop/mobile menu bounds, keyboard focus/close and unchanged archive/restore/undo behavior. Open/closed screenshots are in the batch evidence subdirectory.
