# AI Launch Handoff (Read This First)

Last updated: 2026-03-01
Project: `lecture-processor`
Primary repo: `https://github.com/xs4cnw82dx-jpg/lecture-processor`
Production URL: `https://lecture-processor-1.onrender.com`

---

## 1) Non-Negotiable Collaboration Rules (About the Owner)

The owner is a student with little/no traditional coding experience.

The assistant must:

1. Give explicit, step-by-step instructions.
2. Specify exactly what to click/type.
3. Never skip implied steps.
4. Explain expected output at each step.
5. Include common errors + exact fixes.
6. Avoid vague instructions like “set up X” without exact commands and file edits.

The owner can:

- Run terminal commands exactly as instructed.
- Edit files exactly as instructed.
- Follow precise directions.

The owner cannot reliably:

- Debug independently.
- Infer missing technical steps.
- Resolve architecture decisions alone.

When in doubt: choose explicitness over brevity.

---

## 2) Current Reality (Critical Status)

### Launch status

- Engineering readiness: strong.
- Public paid launch readiness: **NOT READY** (blocked).

### Current blockers for public paid launch

1. Stripe is intentionally in **test mode** (no live payments yet).
2. Privacy/Terms text still needs proper legal review before commercial/public launch.

### What is already production-stable

- CI with required checks on `main`:
  - `Guardrail Tests (pytest)`
  - `Smoke Tests`
- Branch protection enabled on `main` (PR + checks required, strict).
- Release tags:
  - `v0.1.0`
  - `v0.1.1`
- Production smoke tests pass on Render.
- Authenticated production smoke tests pass.
- Rollback runbook exists.

---

## 3) Tech Stack and Architecture Snapshot

- Backend: Flask package with app factory (`lecture_processor/__init__.py`) and compatibility bootstrap (`app.py`)
- Frontend: server-rendered templates + inline JS/CSS in `templates/*.html`
- Auth: Firebase Auth (Google + email/password)
- Database: Firestore
- Payments: Stripe Checkout + webhook
- AI: Gemini API
- Hosting: Render
- CI: GitHub Actions (`.github/workflows/ci.yml`)
- Monitoring: Sentry frontend + backend
- Ops analytics: `/admin` dashboard + funnel + CSV exports

Important files:

- App bootstrap: `app.py`
- App factory: `lecture_processor/__init__.py`
- Legacy route module (still active): `lecture_processor/legacy_app.py`
- API blueprints: `lecture_processor/blueprints/*.py`
- Firestore repositories: `lecture_processor/repositories/*.py`
- CI workflow: `.github/workflows/ci.yml`
- Optional E2E workflow: `.github/workflows/e2e-playwright.yml`
- Smoke script: `scripts/smoke_test.py`
- Stripe go-live verification script: `scripts/stripe_go_live_check.py`
- Guardrail tests: `tests/test_launch_guardrails.py`
- Launch checklist: `docs/LAUNCH_READINESS.md`
- Stripe switch checklist: `docs/STRIPE_GO_LIVE_CHECKLIST.md`
- Final prelaunch notes: `docs/FINAL_PRELAUNCH_PASS.md`
- Rollback process: `docs/ROLLBACK_RUNBOOK.md`
- Legal pages:
  - `templates/privacy.html`
  - `templates/terms.html`

---

## 4) Environment and Local Workflow

Owner machine assumptions:

- macOS
- Python 3.9.x
- local venv in project folder

Default startup commands:

```bash
cd /Users/jaccovandermeulen/Desktop/lecture-processor
source venv/bin/activate
python app.py
```

If assistant asks owner to run any Python command, always include venv activation step unless already active.

---

## 5) Current Deployment and Release Discipline

### Required branch flow

- Never push risky changes directly to `main`.
- Create feature branch with prefix `codex/`.
- Open PR.
- Wait for required checks to pass.
- Merge PR.

### Required checks on `main`

- `Guardrail Tests (pytest)`
- `Smoke Tests`

### Release tagging convention

- Annotated semantic tags (`v0.1.0`, `v0.1.1`, next `v0.1.2`, etc.)
- After merge + green CI, create tag and publish GitHub release notes.

---

## 6) What Has Been Implemented (High-Impact Work Completed)

### Security/reliability

- XSS hardening and safe rendering patterns were addressed in key areas.
- Markdown rendering moved toward safer handling.
- Auth flow allowlist blocking improved (including `st.hanze.nl`).
- Unified auth fetch + retry and polling hardening added.
- Server-side checks for upload/limits and rate-limit responses (`429` + `Retry-After`) implemented.

### Product correctness

- Flashcard/study logic corrections and UX fixes in study mode.
- Admin visibility control and role-sensitive UI behavior improved.

### Observability + ops

- Sentry integrated frontend and backend.
- Route context tags on backend Sentry events.
- Analytics funnel events and admin funnel views/export implemented.
- Rate-limit observability in admin (totals + breakdown + recent hits).

### Trust/compliance baseline

- Privacy Policy route/page exists: `/privacy`.
- Terms route/page exists: `/terms`.
- Account export endpoint exists.
- Account delete + data deletion flow exists.

### Launch hardening

- CI startup made robust when env secrets are absent.
- Smoke workflow hardened in CI.
- Rollback runbook added.
- Issue #4 modular rewrite batches R1-R6 completed:
  - app factory + bootstrap compatibility
  - blueprints split for API grouping
  - service extraction
  - repository layer for Firestore access
  - `app.py` retained as thin entrypoint for Gunicorn/local runs

---

## 7) Known Operational Constraints

1. Stripe is test-only by intent right now.
2. Domain purchase is deferred (cost not worth it yet for private beta phase).
3. Owner wants to continue iterating in private beta mode.
4. Gemini/API costs may still be real depending on Google billing configuration.

---

## 8) If Returning After Months: Exact Re-Entry Procedure for AI

When an AI agent resumes this project, it should do this in order:

1. Read these files first:
   - `docs/AI_LAUNCH_HANDOFF.md` (this file)
   - `docs/LAUNCH_READINESS.md`
   - `docs/DATA_RETENTION_BACKUP_POLICY.md`
   - `docs/ROLLBACK_RUNBOOK.md`
   - `.github/workflows/ci.yml`
2. Check repo health:
   - current branch
   - local uncommitted changes
   - latest tags
3. Confirm `origin/main` CI status.
4. Run local checks:
   - guardrail tests
   - smoke script (local)
5. Run production smoke script against Render URL.
6. Report gaps as:
   - blockers
   - high-priority fixes
   - nice-to-haves
7. Provide owner with explicit click-by-click steps for anything requiring dashboard/UI actions.

---

## 9) Public Paid Launch Checklist (Do Not Skip)

### Phase A: Legal and policy readiness

1. Legal review of Privacy Policy and Terms text.
2. Confirm data retention/deletion/export wording matches behavior.
3. Confirm legal contact email and policy links in app footer/menu.

### Phase B: Stripe go-live

1. Replace `sk_test`/`pk_test` with live keys in Render.
2. Create live Stripe webhook endpoint to production:
   - event: `checkout.session.completed`
3. Replace webhook signing secret in Render.
4. Run end-to-end real payment validation with small amount.
5. Confirm credit grant and purchase logging in Firestore.

### Phase C: Final technical gate

1. CI green on main.
2. Tag release (`vX.Y.Z`) and publish release notes.
3. Run production smoke tests (public + authenticated).
4. Monitor for 24h with runbook thresholds.

### Phase D: Announcement gate

Only announce publicly when all are true:

- legal review done,
- Stripe live verified,
- smoke checks pass,
- no critical Sentry issues,
- rollback path confirmed.

---

## 10) Step-by-Step Commands the AI Should Prefer

### Local tests

```bash
cd /Users/jaccovandermeulen/Desktop/lecture-processor
source venv/bin/activate
python -m pytest -q tests/test_launch_guardrails.py
./scripts/run_smoke.sh
```

### Optional local E2E smoke (Playwright)

```bash
cd /Users/jaccovandermeulen/Desktop/lecture-processor
npm install
npx playwright install --with-deps chromium
npm run e2e
```

### Production smoke

```bash
cd /Users/jaccovandermeulen/Desktop/lecture-processor
source venv/bin/activate
python scripts/smoke_test.py --base-url https://lecture-processor-1.onrender.com
```

### Stripe go-live verification (before/after key switch)

```bash
cd /Users/jaccovandermeulen/Desktop/lecture-processor
source venv/bin/activate
python scripts/stripe_go_live_check.py \
  --base-url https://lecture-processor-1.onrender.com \
  --expect-mode live \
  --bearer-token "$FIREBASE_TEST_BEARER"
```

### Git release flow

```bash
cd /Users/jaccovandermeulen/Desktop/lecture-processor
git checkout -b codex/<short-topic>
# edit files
git add <files>
git commit -m "<clear message>"
git push -u origin codex/<short-topic>
# open PR, wait for checks, merge
git checkout main
git pull --ff-only origin main
git tag -a vX.Y.Z -m "vX.Y.Z: <summary>"
git push origin vX.Y.Z
```

---

## 11) Assistant Behavior Rules for Future Sessions

1. Always prioritize launch blockers over cosmetic work.
2. When user says “go do it”, execute changes directly when possible.
3. Keep unrelated local changes untouched.
4. Never use destructive git commands.
5. For any dashboard operation the assistant cannot perform directly, provide exact click-by-click guidance.
6. After each significant change:
   - run tests/checks,
   - report result clearly,
   - state next action.

---

## 12) Suggested Prompt the Owner Can Reuse

Use this exact sentence in future chats:

> Read `docs/AI_LAUNCH_HANDOFF.md` first, then continue helping me from current state with explicit step-by-step instructions only.
