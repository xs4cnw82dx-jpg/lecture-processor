Background jobs are registered locally before entering the bounded queue. The registration remains active until execution finishes or the queued future is cancelled. Runtime jobs that are executing persist a heartbeat every 30 seconds; completed jobs and tasks using another state store receive no runtime-job heartbeat writes.

Recovery runs at startup in a daemon thread and during the existing five-minute cleanup cycle. It excludes jobs queued or executing in the current process. A persisted job becomes eligible after 180 seconds without activity by default. Eligibility does not guarantee immediate recovery: the cleanup cadence and recovery lease also affect timing. An authorized status request can recover an eligible orphan sooner through the same transactional claim.

Recovery retains the existing idempotent credit-refund references and records an interrupted result. Startup scans do not delay the first web request. A failure in one startup scan or in periodic recovery does not prevent the other cleanup operations.

Credit-bearing runtime jobs commit their debit journal and initial job record in one transaction before dispatch. Initialization and worker entry recheck the durable admission so a recovered job cannot restart. Batch submissions persist a preparing parent and staged rows, admit each row in a bounded transaction, and dispatch only after every row is admitted. Recovery closes a pending parent before collecting its rows for compensation.

Receipts retain the amount charged to each component. Refunds use those amounts, including zero for category exemptions, and cumulative targets prevent repeated requests from returning more than was charged. A failed refund retains a pending marker; marked runtime snapshots do not expire until settlement. Recovery retries only the marked components, including failed extras on otherwise successful work. Terminal batches retain a parent retry flag and per-row component targets, queried in bounded groups. Transactional claims prevent overlapping retries; settlement updates receipt history and aggregate credit totals without rerunning successful work or counting another completed job.

`UNIFIED_CREDITS_ENABLED` is a server setting with a default of `1`. It controls new conversion and the checkout catalog. Stored `credits_version: 2` accounts and `credit_scheme: 2` receipts remain authoritative when it is disabled. Prices, conversion rates, bundle terms and the signup grant are defined in `lecture_processor/domains/billing/policy.py`. Conversion occurs within the same transaction as the account read or money change; deployment does not run a migration script. Existing category balances and public receipts keep their prior format while the setting is disabled and the account is unconverted.

| Setting | Default | Purpose |
|---|---|---|
| `RUNTIME_JOB_RECOVERY_STALE_SECONDS` | `0` (uses 180 seconds) | Positive overrides use a minimum of 120 seconds. |
| `RUNTIME_JOB_RECOVERY_LEASE_SECONDS` | `300` | Coordinates periodic and startup scans across instances. |
| `ENABLE_RUNTIME_JOB_RECOVERY` | `1` | Enables runtime-job startup, periodic, and status-request recovery. |
| `ENABLE_BATCH_JOB_RECOVERY` | `1` | Enables the separate batch startup recovery scan. |
| `UNIFIED_CREDITS_ENABLED` | `1` | Enables lazy balance conversion and the unified checkout catalog. Set `0` to keep unconverted accounts on legacy terms; stored version-two balances remain authoritative. |

The isolated preview and pytest runners disable both recovery flags and the normal cleanup thread. Their test fixtures use synthetic records and external services.
