# Environment reference

The web app, deployment command and local companion read 142 named settings. The table lists application defaults. Deployment overrides are in [render.yaml](../render.yaml).

Regenerate with `python scripts/generate_environment_reference.py`. The generator reads checked-in source without loading application configuration.

Boolean flags accept `1`, `true`, `yes` and `on`, ignoring case and surrounding whitespace, unless the entry specifies a different rule. Names ending in `_SECONDS`, `_MS` and `_BYTES` include their units.

| Variable | Default or behavior | Used by |
| --- | --- | --- |
| `ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION` | `10000 (minimum 100, maximum 50000)` | [core.py](../lecture_processor/runtime/core.py) |
| `ACCOUNT_DELETE_RATE_LIMIT_MAX_REQUESTS` | `3 (minimum 1, maximum 20)` | [core.py](../lecture_processor/runtime/core.py) |
| `ACCOUNT_DELETE_RATE_LIMIT_WINDOW_SECONDS` | `3600 (minimum 60, maximum 86400)` | [core.py](../lecture_processor/runtime/core.py) |
| `ACCOUNT_EXPORT_MAX_CSV_PACKS` | `250 (minimum 1, maximum 5000)` | [core.py](../lecture_processor/runtime/core.py) |
| `ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION` | `10000 (minimum 100, maximum 50000)` | [core.py](../lecture_processor/runtime/core.py) |
| `ACCOUNT_EXPORT_MAX_DOCX_PACKS` | `40 (minimum 1, maximum 1000)` | [core.py](../lecture_processor/runtime/core.py) |
| `ACCOUNT_EXPORT_MAX_PDF_PACKS` | `20 (minimum 1, maximum 1000)` | [core.py](../lecture_processor/runtime/core.py) |
| `ACCOUNT_EXPORT_RATE_LIMIT_MAX_REQUESTS` | `6 (minimum 1, maximum 100)` | [core.py](../lecture_processor/runtime/core.py) |
| `ACCOUNT_EXPORT_RATE_LIMIT_WINDOW_SECONDS` | `3600 (minimum 60, maximum 86400)` | [core.py](../lecture_processor/runtime/core.py) |
| `ACCOUNT_EXPORT_ZIP_SPOOL_BYTES` | `5 * 1024 * 1024 (minimum 1024 * 1024, maximum 250 * 1024 * 1024)` | [core.py](../lecture_processor/runtime/core.py) |
| `ACCOUNT_RECENT_AUTH_MAX_AGE_SECONDS` | `600 (minimum 60, maximum 3600)` | [core.py](../lecture_processor/runtime/core.py) |
| `ADMIN_EMAILS` | Unset | [core.py](../lecture_processor/runtime/core.py) |
| `ADMIN_FALLBACK_MAX_DOCS` | `5000 (minimum 100, maximum 50000)` | [core.py](../lecture_processor/runtime/core.py) |
| `ADMIN_PAGE_UNAUTHORIZED_MODE` | `redirect` | [core.py](../lecture_processor/runtime/core.py) |
| `ADMIN_SESSION_DURATION_SECONDS` | `8 * 60 * 60 (minimum 5 * 60, maximum 30 * 24 * 60 * 60)` | [core.py](../lecture_processor/runtime/core.py) |
| `ADMIN_UIDS` | Unset | [core.py](../lecture_processor/runtime/core.py) |
| `ALLOW_LEGACY_AUDIO_STREAM_TOKENS` | `0` | [core.py](../lecture_processor/runtime/core.py) |
| `ANALYTICS_RATE_LIMIT_MAX_REQUESTS` | `240 (minimum 10, maximum 5000)` | [core.py](../lecture_processor/runtime/core.py) |
| `ANALYTICS_RATE_LIMIT_WINDOW_SECONDS` | `60 (minimum 10, maximum 3600)` | [core.py](../lecture_processor/runtime/core.py) |
| `APP_ENV` | Runtime environment override. | [environment.py](../lecture_processor/runtime/environment.py) |
| `AUDIO_IMPORT_JOB_TTL_SECONDS` | `2 * 60 * 60 (minimum 15 * 60, maximum 24 * 60 * 60)` | [core.py](../lecture_processor/runtime/core.py) |
| `BATCH_EMAIL_NOTIFICATIONS_ENABLED` | `1` | [core.py](../lecture_processor/runtime/core.py) |
| `BATCH_JOB_QUEUE_MAX_PENDING` | `24 (minimum 0, maximum 2000)` | [core.py](../lecture_processor/runtime/core.py) |
| `BATCH_JOB_RECOVERY_BATCH_LIMIT` | `100 (minimum 1, maximum 5000)` | [core.py](../lecture_processor/runtime/core.py) |
| `BATCH_JOB_RECOVERY_LEASE_COLLECTION` | `batch_job_recovery_leases` | [core.py](../lecture_processor/runtime/core.py) |
| `BATCH_JOB_RECOVERY_LEASE_ID` | `startup` | [core.py](../lecture_processor/runtime/core.py) |
| `BATCH_JOB_RECOVERY_LEASE_SECONDS` | `300 (minimum 30, maximum 3600)` | [core.py](../lecture_processor/runtime/core.py) |
| `BATCH_JOB_RECOVERY_STALE_SECONDS` | `0 (minimum 0, maximum 7 * 24 * 60 * 60)` | [core.py](../lecture_processor/runtime/core.py) |
| `BATCH_JOB_WORKERS` | `1 (minimum 1, maximum 16)` | [core.py](../lecture_processor/runtime/core.py) |
| `BATCH_MAX_ROWS` | `100 (minimum 2, maximum 499)` | [core.py](../lecture_processor/runtime/core.py) |
| `BATCH_STATUS_ROWS_LIMIT` | `100 (minimum 1, maximum 500)` | [core.py](../lecture_processor/runtime/core.py) |
| `BOOK_ASSETS_MAX_MB` | `25` | [book_storage.py](../lecture_processor/services/book_storage.py) |
| `BOOK_CHATGPT_URL` | Defaults to `https://chatgpt.com/`. | [books.py](../lecture_processor/blueprints/books.py) |
| `BOOK_IMAGE_MAX_MB` | 10 MiB, capped at 10. | [book_storage.py](../lecture_processor/services/book_storage.py) |
| `BOOK_STORAGE_BUCKET` | `book-images` | [book_storage.py](../lecture_processor/services/book_storage.py) |
| `BOOK_STORAGE_KEY` | Unset | [book_storage.py](../lecture_processor/services/book_storage.py) |
| `BOOK_STORAGE_MAX_MB` | `750` | [book_storage.py](../lecture_processor/services/book_storage.py) |
| `BOOK_STORAGE_URL` | Unset | [book_storage.py](../lecture_processor/services/book_storage.py) |
| `BOOK_STUDIO_ENABLED` | Enabled unless set to 0. | [books.py](../lecture_processor/blueprints/books.py) |
| `BOOK_TRANSFER_MAX_MB` | `4096` | [book_storage.py](../lecture_processor/services/book_storage.py) |
| `CALENDAR_TOKEN_ENCRYPTION_KEYS` | Comma-separated Fernet keys, newest first. | [calendar_sync_service.py](../lecture_processor/services/calendar_sync_service.py) |
| `CALENDAR_WORKER_AUDIENCE` | Unset | [calendar_sync_service.py](../lecture_processor/services/calendar_sync_service.py) |
| `CALENDAR_WORKER_SERVICE_ACCOUNT` | Firebase Functions service account for calendar wakeups. | [calendar-sync.js](../functions/calendar-sync.js) |
| `CALENDAR_WORKER_SERVICE_ACCOUNT_EMAIL` | Unset | [calendar_sync_service.py](../lecture_processor/services/calendar_sync_service.py) |
| `CALENDAR_WORKER_URL` | HTTPS URL of the calendar worker. | [calendar-sync.js](../functions/calendar-sync.js) |
| `CHECKOUT_RATE_LIMIT_MAX_REQUESTS` | `6 (minimum 1, maximum 100)` | [core.py](../lecture_processor/runtime/core.py) |
| `CHECKOUT_RATE_LIMIT_WINDOW_SECONDS` | `600 (minimum 10, maximum 86400)` | [core.py](../lecture_processor/runtime/core.py) |
| `CORS_ALLOWED_ORIGINS` | Comma-separated origins. Defaults to the local and deployed origins in the linked parser. | [environment.py](../lecture_processor/runtime/environment.py) |
| `ENABLE_BATCH_JOB_RECOVERY` | `1` | [core.py](../lecture_processor/runtime/core.py) |
| `ENABLE_RUNTIME_JOB_RECOVERY` | `1` | [core.py](../lecture_processor/runtime/core.py) |
| `ENV` | Legacy environment name. | [environment.py](../lecture_processor/runtime/environment.py) |
| `FEATURE_AUDIO_SECTION_SYNC` | `0` | [core.py](../lecture_processor/runtime/core.py) |
| `FIREBASE_CREDENTIALS` | Service-account JSON. The local startup path can also read a credentials file. | [bootstrap.py](../lecture_processor/runtime/bootstrap.py) |
| `FLASK_DEBUG` | `0` | [dev_server.py](../lecture_processor/runtime/dev_server.py), [environment.py](../lecture_processor/runtime/environment.py) |
| `FLASK_ENV` | Legacy Flask runtime environment. | [environment.py](../lecture_processor/runtime/environment.py) |
| `FLASK_SECRET_KEY` | Required outside development. | [config.py](../lecture_processor/config.py), [core.py](../lecture_processor/runtime/core.py), [settings.py](../lecture_processor/runtime/settings.py) |
| `FLASK_TESTING` | `0` | [bootstrap.py](../lecture_processor/runtime/bootstrap.py) |
| `GEMINI_API_KEY` | Backend Gemini credential. | [bootstrap.py](../lecture_processor/runtime/bootstrap.py) |
| `GEMINI_HTTP_TIMEOUT_MS` | `600000` | [environment.py](../lecture_processor/runtime/environment.py) |
| `GEMINI_REQUEST_HTTP_TIMEOUT_MS` | `60000` | [environment.py](../lecture_processor/runtime/environment.py) |
| `GOOGLE_CALENDAR_CLIENT_ID` | Unset | [calendar_sync_service.py](../lecture_processor/services/calendar_sync_service.py) |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | Unset | [calendar_sync_service.py](../lecture_processor/services/calendar_sync_service.py) |
| `GOOGLE_CALENDAR_ENABLED` | Disabled by default. Accepts 1 or true and requires the calendar credentials. | [calendar_sync_service.py](../lecture_processor/services/calendar_sync_service.py) |
| `GOOGLE_CALENDAR_REDIRECT_URI` | Unset | [calendar_sync_service.py](../lecture_processor/services/calendar_sync_service.py) |
| `HOSTNAME` | Unset | [batch_orchestrator.py](../lecture_processor/domains/ai/batch_orchestrator.py), [recovery.py](../lecture_processor/domains/runtime_jobs/recovery.py) |
| `INSTANT_BATCH_API_STAGGER_SECONDS` | `5.0 (minimum 0.0, maximum 60.0)` | [core.py](../lecture_processor/runtime/core.py) |
| `INSTANT_BATCH_MAX_PARALLEL_ROWS` | `2 (minimum 1, maximum 8)` | [core.py](../lecture_processor/runtime/core.py) |
| `INSTANT_BATCH_MAX_ROWS` | `20 (minimum 2, maximum 100)` | [core.py](../lecture_processor/runtime/core.py) |
| `JOB_QUEUE_MAX_PENDING` | `8 (minimum 0, maximum 1000)` | [core.py](../lecture_processor/runtime/core.py) |
| `JOB_TTL_SECONDS` | `30 * 60 (minimum 5 * 60, maximum 24 * 60 * 60)` | [core.py](../lecture_processor/runtime/core.py) |
| `JOB_WORKERS` | `2 (minimum 1, maximum 32)` | [core.py](../lecture_processor/runtime/core.py) |
| `LECTURE_PROCESSOR_YTDLP_GUARD` | Internal subprocess configuration set by the downloader. | [ytdlp_network_guard.py](../lecture_processor/services/ytdlp_network_guard.py) |
| `LIBREOFFICE_BIN` | Optional binary path. The Docker image sets soffice. | [file_service.py](../lecture_processor/services/file_service.py) |
| `LOG_LEVEL` | `INFO` | [environment.py](../lecture_processor/runtime/environment.py) |
| `LP_FORCE_FAKE_PROVIDER` | Defaults off. The isolated test and preview runners set this flag. | [environment.py](../lecture_processor/runtime/environment.py) |
| `MAX_ACTIVE_JOBS_PER_USER` | `2 (minimum 1, maximum 20)` | [core.py](../lecture_processor/runtime/core.py) |
| `MAX_TOOLS_DOCUMENT_BYTES` | `50 * 1024 * 1024 (minimum 1 * 1024 * 1024, maximum 100 * 1024 * 1024)` | [core.py](../lecture_processor/runtime/core.py) |
| `MAX_TOOLS_IMAGE_BYTES` | `20 * 1024 * 1024 (minimum 1 * 1024 * 1024, maximum 50 * 1024 * 1024)` | [core.py](../lecture_processor/runtime/core.py) |
| `MODEL_PRICING_CACHE_TTL_SECONDS` | `300 (minimum 30, maximum 3600)` | [core.py](../lecture_processor/runtime/core.py) |
| `OPENAI_CUSTOM_HEADERS` | Must be unset for the OpenRouter adapter. | [openrouter.py](../lecture_processor/domains/ai/providers/openrouter.py) |
| `OPENROUTER_API_KEY` | Backend OpenRouter credential. | [openrouter.py](../lecture_processor/domains/ai/providers/openrouter.py) |
| `OPENROUTER_HTTP_TIMEOUT_MS` | `600000 (maximum 3600000)` | [environment.py](../lecture_processor/runtime/environment.py) |
| `OPENROUTER_REQUEST_HTTP_TIMEOUT_MS` | `60000 (maximum 3600000)` | [environment.py](../lecture_processor/runtime/environment.py) |
| `PHYSIO_CODEX_BINARY` | Optional companion executable path. The launcher otherwise discovers Codex. | [run_physio_companion.py](../scripts/run_physio_companion.py) |
| `PHYSIO_COMPANION_URL` | Defaults to `http://127.0.0.1:8765/physio`. | [pages.py](../lecture_processor/web/pages.py) |
| `PORT` | 5000 for local app.py, 10000 for Gunicorn in Docker. | [Dockerfile](../Dockerfile), [app.py](../app.py) |
| `PROVIDER_RETRY_BASE_SECONDS` | `1.2 (minimum 0.2, maximum 10.0)` | [core.py](../lecture_processor/runtime/core.py) |
| `PROVIDER_RETRY_MAX_ATTEMPTS` | `3 (minimum 1, maximum 6)` | [core.py](../lecture_processor/runtime/core.py) |
| `PROVIDER_RETRY_MAX_SECONDS` | `10.0 (minimum 1.0, maximum 30.0)` | [core.py](../lecture_processor/runtime/core.py) |
| `PUBLIC_BASE_URL` | HTTPS origin required outside development. | [elearning.py](../lecture_processor/blueprints/elearning.py), [config.py](../lecture_processor/config.py), [environment.py](../lecture_processor/runtime/environment.py), [settings.py](../lecture_processor/runtime/settings.py) |
| `PYTEST_CURRENT_TEST` | Unset | [bootstrap.py](../lecture_processor/runtime/bootstrap.py) |
| `RATE_LIMIT_FIRESTORE_ENABLED` | `1` | [core.py](../lecture_processor/runtime/core.py) |
| `RENDER` | Platform-provided Render deployment marker. | [bootstrap.py](../lecture_processor/runtime/bootstrap.py), [core.py](../lecture_processor/runtime/core.py), [environment.py](../lecture_processor/runtime/environment.py), [auth_api_service.py](../lecture_processor/services/auth_api_service.py) |
| `RENDER_DEPLOY_ID` | Unset | [environment.py](../lecture_processor/runtime/environment.py) |
| `RENDER_EXTERNAL_HOSTNAME` | Unset | [environment.py](../lecture_processor/runtime/environment.py), [hooks.py](../lecture_processor/runtime/hooks.py) |
| `RENDER_EXTERNAL_URL` | Unset | [environment.py](../lecture_processor/runtime/environment.py) |
| `RENDER_GIT_BRANCH` | Unset | [environment.py](../lecture_processor/runtime/environment.py) |
| `RENDER_GIT_COMMIT` | Unset | [environment.py](../lecture_processor/runtime/environment.py) |
| `RENDER_INSTANCE_ID` | Unset | [batch_orchestrator.py](../lecture_processor/domains/ai/batch_orchestrator.py), [recovery.py](../lecture_processor/domains/runtime_jobs/recovery.py), [environment.py](../lecture_processor/runtime/environment.py) |
| `RENDER_SERVICE_ID` | Unset | [environment.py](../lecture_processor/runtime/environment.py) |
| `RENDER_SERVICE_NAME` | Unset | [environment.py](../lecture_processor/runtime/environment.py) |
| `RUNTIME_JOB_RECOVERY_BATCH_LIMIT` | `200 (minimum 1, maximum 5000)` | [core.py](../lecture_processor/runtime/core.py) |
| `RUNTIME_JOB_RECOVERY_LEASE_COLLECTION` | `runtime_job_recovery_leases` | [core.py](../lecture_processor/runtime/core.py) |
| `RUNTIME_JOB_RECOVERY_LEASE_ID` | `startup` | [core.py](../lecture_processor/runtime/core.py) |
| `RUNTIME_JOB_RECOVERY_LEASE_SECONDS` | `300 (minimum 30, maximum 3600)` | [core.py](../lecture_processor/runtime/core.py) |
| `RUNTIME_JOB_RECOVERY_STALE_SECONDS` | `0 (minimum 0, maximum 7 * 24 * 60 * 60)` | [core.py](../lecture_processor/runtime/core.py) |
| `SENTRY_CAPTURE_LOCAL` | `0` | [core.py](../lecture_processor/runtime/core.py) |
| `SENTRY_DSN_BACKEND` | Unset | [core.py](../lecture_processor/runtime/core.py) |
| `SENTRY_DSN_FRONTEND` | Unset | [core.py](../lecture_processor/runtime/core.py) |
| `SENTRY_ENVIRONMENT` | Defaults to production on Render. Locally checks APP_ENV, ENV, then FLASK_ENV. | [environment.py](../lecture_processor/runtime/environment.py) |
| `SENTRY_RELEASE` | `lecture-processor` | [environment.py](../lecture_processor/runtime/environment.py) |
| `SENTRY_TRACES_SAMPLE_RATE` | `0.0` | [core.py](../lecture_processor/runtime/core.py) |
| `SMTP_FROM_EMAIL` | Unset | [core.py](../lecture_processor/runtime/core.py) |
| `SMTP_FROM_NAME` | `Lecture Processor` | [core.py](../lecture_processor/runtime/core.py) |
| `SMTP_HOST` | Unset | [core.py](../lecture_processor/runtime/core.py) |
| `SMTP_PASSWORD` | Unset | [core.py](../lecture_processor/runtime/core.py) |
| `SMTP_PORT` | `587 (minimum 1, maximum 65535)` | [core.py](../lecture_processor/runtime/core.py) |
| `SMTP_REPLY_TO` | Unset | [core.py](../lecture_processor/runtime/core.py) |
| `SMTP_TIMEOUT_SECONDS` | `12 (minimum 1, maximum 120)` | [core.py](../lecture_processor/runtime/core.py) |
| `SMTP_USERNAME` | Unset | [core.py](../lecture_processor/runtime/core.py) |
| `SMTP_USE_SSL` | `0` | [core.py](../lecture_processor/runtime/core.py) |
| `SMTP_USE_TLS` | `1` | [core.py](../lecture_processor/runtime/core.py) |
| `STRIPE_PUBLISHABLE_KEY` | Unset | [core.py](../lecture_processor/runtime/core.py) |
| `STRIPE_SECRET_KEY` | Unset | [core.py](../lecture_processor/runtime/core.py) |
| `STRIPE_WEBHOOK_SECRET` | Unset | [core.py](../lecture_processor/runtime/core.py) |
| `TELEMETRY_RETENTION_SECONDS` | `90 * 24 * 60 * 60 (minimum 24 * 60 * 60, maximum 2 * 365 * 24 * 60 * 60)` | [core.py](../lecture_processor/runtime/core.py) |
| `TESTING` | Falls back to FLASK_TESTING when unset. | [bootstrap.py](../lecture_processor/runtime/bootstrap.py) |
| `TOOLS_RATE_LIMIT_MAX_REQUESTS` | `10 (minimum 1, maximum 300)` | [core.py](../lecture_processor/runtime/core.py) |
| `TOOLS_RATE_LIMIT_WINDOW_SECONDS` | `600 (minimum 30, maximum 86400)` | [core.py](../lecture_processor/runtime/core.py) |
| `TRUSTED_PROXY_HOPS` | `1 (minimum 0, maximum 10)` | [core.py](../lecture_processor/runtime/core.py) |
| `UNIFIED_CREDITS_ENABLED` | Defaults to the checked-in billing policy. | [core.py](../lecture_processor/runtime/core.py) |
| `UPLOAD_ARTIFACT_TTL_SECONDS` | `24 * 60 * 60 (minimum 60 * 60, maximum 30 * 24 * 60 * 60)` | [core.py](../lecture_processor/runtime/core.py) |
| `UPLOAD_DAILY_BYTE_CAP` | `2 * 1024 * 1024 * 1024 (minimum 100 * 1024 * 1024, maximum 5 * 1024 * 1024 * 1024 * 1024)` | [core.py](../lecture_processor/runtime/core.py) |
| `UPLOAD_MIN_FREE_DISK_BYTES` | `1024 * 1024 * 1024 (minimum 50 * 1024 * 1024, maximum 500 * 1024 * 1024 * 1024)` | [core.py](../lecture_processor/runtime/core.py) |
| `UPLOAD_RATE_LIMIT_MAX_REQUESTS` | `10 (minimum 1, maximum 1000)` | [core.py](../lecture_processor/runtime/core.py) |
| `UPLOAD_RATE_LIMIT_WINDOW_SECONDS` | `600 (minimum 10, maximum 86400)` | [core.py](../lecture_processor/runtime/core.py) |
| `USE_MINIFIED_JS_ASSETS` | Defaults on outside development. | [environment.py](../lecture_processor/runtime/environment.py) |
| `VIDEO_IMPORT_ALLOWED_HOST_SUFFIXES` | `kaltura.com,ovp.kaltura.com,brightspace.com,d2l.com` | [core.py](../lecture_processor/runtime/core.py) |
| `VIDEO_IMPORT_RATE_LIMIT_MAX_REQUESTS` | `8 (minimum 1, maximum 200)` | [core.py](../lecture_processor/runtime/core.py) |
| `VIDEO_IMPORT_RATE_LIMIT_WINDOW_SECONDS` | `600 (minimum 30, maximum 86400)` | [core.py](../lecture_processor/runtime/core.py) |
| `WEB_CONCURRENCY` | `1` | [Dockerfile](../Dockerfile) |
| `WEB_THREADS` | `4` | [Dockerfile](../Dockerfile) |
