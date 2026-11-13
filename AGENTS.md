# Working instructions

## Current priority

Audit remediation takes priority. Consult the untracked local workplan at
`codex-team/CODEX_WORKPLAN.md`
(`/Users/jaccovandermeulen/Desktop/lecture-processor/codex-team/CODEX_WORKPLAN.md`),
maintain `codex-team/STATUS.md`, and use the workplan's review and live-check gates.

## Active website redesign

The four documents below are background for Phase D UI work. Read them when
starting that work and when resuming it after a context reset; other work packages
do not require rereading them.

1. `docs/VISUAL_REDESIGN_MASTER_PLAN.md` — the complete approved 45-part visual and interaction audit.
2. `docs/VISUAL_REDESIGN_PROGRESS.md` — current ownership, completed work, verification, and outstanding work.
3. `docs/PRODUCT_FEEDBACK_REPAIR_PLAN.md` — previous screenshot-driven repairs, delivered in PR #185.
4. `docs/STUDY_FLOW_POLISH_PLAN.md` — 4 October screenshot feedback and delivery checklist, delivered in PR #186.

Use Study Plan as the visual foundation. The user explicitly requires a genuinely polished redesign: improve composition, typography, spacing, hierarchy, controls, interaction states, and responsive behavior. A palette change or additional CSS overrides alone does not satisfy the task. Inspect rendered results and iterate.

Keep the progress file current at phase boundaries and before handing off or compacting. Never mark a page complete solely because its code changed; record verification and any remaining gaps. Preserve existing application behavior and user data.

The user authorized parallel subagents and the full development workflow. Coordinate disjoint file ownership; do not overwrite another agent's work. Use a `codex/` branch, run appropriate checks, push and create a PR, attach the PR to this chat, monitor checks, merge when allowed, sync local main safely, and verify the deployed result. Never bypass branch protections or overwrite unrelated local changes.

## Preview isolation

Never run the normal application against workspace uploads for visual QA. Use the isolated preview/test runner prepared for this redesign, with temporary storage, disabled background cleanup/recovery, and fake external services. Preserve the recent study-run, favorite, and calendar features; do not activate deferred external services.
