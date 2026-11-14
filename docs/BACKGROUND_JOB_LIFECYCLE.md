Background jobs are registered locally before entering the bounded queue. The registration remains active until execution finishes or the queued future is cancelled. Runtime jobs that are executing persist a heartbeat every 30 seconds; completed jobs and tasks using another state store receive no runtime-job heartbeat writes.

Recovery runs at startup in a daemon thread and during the existing five-minute cleanup cycle. It excludes jobs queued or executing in the current process. A persisted job becomes eligible after 180 seconds without activity by default. Eligibility does not guarantee immediate recovery: the cleanup cadence and recovery lease also affect timing. An authorized status request can recover an eligible orphan sooner through the same transactional claim.

Recovery retains the existing idempotent credit-refund references and records an interrupted result. Startup scans do not delay the first web request. A failure in one startup scan or in periodic recovery does not prevent the other cleanup operations.

| Setting | Default | Purpose |
|---|---|---|
| `RUNTIME_JOB_RECOVERY_STALE_SECONDS` | `0` (uses 180 seconds) | Positive overrides use a minimum of 120 seconds. |
| `RUNTIME_JOB_RECOVERY_LEASE_SECONDS` | `300` | Coordinates periodic and startup scans across instances. |
| `ENABLE_RUNTIME_JOB_RECOVERY` | `1` | Enables runtime-job startup, periodic, and status-request recovery. |
| `ENABLE_BATCH_JOB_RECOVERY` | `1` | Enables the separate batch startup recovery scan. |

The isolated preview and pytest runners disable both recovery flags and the normal cleanup thread. Their test fixtures use synthetic records and external services.
