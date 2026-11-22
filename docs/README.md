# Documentation

## Development and product

- [Local setup and tests](../README.md)
- [AI provider configuration](AI_PROVIDER_CONFIGURATION.md) and [prompt updates](PROMPT_UPDATE_WORKFLOW.md)
- [Background job lifecycle](BACKGROUND_JOB_LIFECYCLE.md)
- [Study Plan operations](STUDY_PLAN_V2.md) and [calendar setup](google-calendar-setup.md)
- [Book Studio](BOOK_STUDIO.md)
- [Visual redesign plan](VISUAL_REDESIGN_MASTER_PLAN.md), [progress](VISUAL_REDESIGN_PROGRESS.md) and [reference captures](redesign-evidence/README.md)

The Python coverage report appears in the coverage job summary on pull requests. Run `.venv/bin/python scripts/run_pytest_isolated.py -q --cov=lecture_processor` for a local report. To run just the launch guardrails, pass `tests/launch/` to the isolated runner.

## Operations and release

- [Production readiness and deferred integrations](../PRODUCTION_READINESS.md)
- [Launch readiness checklist](LAUNCH_READINESS.md)
- [Data retention and backups](DATA_RETENTION_BACKUP_POLICY.md)
- [Firestore index deployment](FIRESTORE_INDEXES.md)
- [Model pricing updates](MODEL_PRICING_UPDATE_RUNBOOK.md)
- [Stripe go-live checklist](STRIPE_GO_LIVE_CHECKLIST.md)
- [Rollback and incident response](ROLLBACK_RUNBOOK.md)

[Browse completed plans, release handoffs and QA records](archive/README.md).
