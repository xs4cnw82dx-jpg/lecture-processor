# AI provider request configuration

The Gemini client uses `GEMINI_HTTP_TIMEOUT_MS` as its HTTP timeout in
milliseconds. The default is `600000` (10 minutes), covering background
generation, provider file operations (including uploads), and batch API requests.

Generation performed while handling a web request uses
`GEMINI_REQUEST_HTTP_TIMEOUT_MS`, defaulting to `60000` (1 minute). This value
cannot exceed the configured client timeout. It is applied to the individual
generation call; background workers retain the client timeout.

Both settings accept positive integers. Missing, empty, non-integer, zero, or
negative values use their defaults. These are per-request transport limits;
existing retry policies and overall job deadlines still apply separately.

## Optional OpenRouter adapter

The checked-in routing configuration still selects Gemini for every stage.
Existing native callers retain their current models; stage-based callers use
the immutable routing snapshot through a workflow-local provider session.
Audio stages reject any provider other than Gemini.

The dormant OpenRouter adapter uses the pinned OpenAI Python 2.54.0 SDK with
an explicit `https://openrouter.ai/api/v1` base URL. This version retains the
existing HTTPX dependency and preserves OpenRouter's additional request fields
through the documented `extra_body` argument. The SDK's response context closes
each response; JSON is checked for provider errors before SDK model parsing.
The model request itself is nonstreaming. SDK retries are disabled so the
application's existing retry policy remains the only retry loop.

`OPENROUTER_API_KEY` is read only when a real OpenRouter client is first needed.
The adapter owns its HTTP client, ignores proxy environment settings, rejects
redirects, and closes the client when its provider session ends. It suppresses
SDK request logging and exposes only fixed failure categories and numeric
statuses. A nonempty `OPENAI_CUSTOM_HEADERS` fails client setup because the SDK
would otherwise import arbitrary headers. Other OpenAI credentials, base URLs,
organizations and projects are not inherited.

`OPENROUTER_HTTP_TIMEOUT_MS` controls read timeouts for background calls, with
a default of `600000`. `OPENROUTER_REQUEST_HTTP_TIMEOUT_MS` defaults to `60000`
and cannot exceed the background limit. Both accept positive integers and are
capped at `3600000`; invalid values use defaults. Connect, write and pool
timeouts are 10, 30 and 5 seconds. Transport timeouts apply per attempt, separate
from application retry and job deadlines.

The adapter requires explicit reasoning effort and an output limit in each
OpenRouter route. It fixes the provider to `google-vertex/global`, disables
fallback routing, requires supported parameters and ZDR routing, and requests
no data collection. The adapter sends `enabled: false` for plugins that support that
field, except the file parser, which uses the native PDF engine when a PDF is
present. It omits plugins without an enable switch, including alignment,
which requires at least one rule. Keep those plugins off in workspace defaults
for this deployment. [OpenRouter plugin settings](https://openrouter.ai/docs/guides/features/plugins/overview)
and the [API schema](https://openrouter.ai/openapi.json) describe these controls. These request settings do not establish
account-level privacy settings or prove provider-side enforcement. Account
settings, endpoint eligibility and request acceptance must be verified before
any route is activated. There is no OpenRouter Batch API integration.

Forced isolated runners intercept routing before constructing any real
provider client. Adapter contract tests use an injected HTTP mock transport
with a literal test key and blocked network access.

## Document completion and fallback

An OpenRouter slide extraction, notes merge or text combine requires a nonempty
response with a `stop` finish reason. For notes, the route may specify a
`retry_max_output_tokens` above its initial `max_output_tokens`. For example,
an initial 32,768 and retry limit of 65,536 permit one larger generation after
a `length` finish. The caller's ceiling bounds both attempts.

When the available caps are exhausted, or a transient OpenRouter error outlasts
application retries, these stages can use the existing Gemini stage model once.
A complete Gemini result is required on this path as well. Input, policy,
endpoint eligibility and credential errors terminate the operation. The job
retains usage for discarded completions and records provider fallback in the
application log. A request above 100,000 reported input tokens logs its stage
and token count. Merged documents keep only informative placeholders grounded
in the provided slide text. Notes merge uses the literal English marker prefix.
Text combine uses the literal Dutch prefix required by its slide-input templates.
The requested output language applies to the surrounding prose.

## Workflow file preparation

A provider session can separate file upload, processing and generation with
`upload_file(stage, part, operation_name=...)` and
`wait_for_file(stage, part, operation_name=...)`. Pass the same neutral file part
to each phase and to `generate`. Each preparation method returns `None`; native
file handles stay private to the adapter. Explicit operation names and optional
retry trackers preserve the caller's existing progress and retry accounting.

For Gemini, an upload becomes session-owned immediately. A failed processing
wait can be retried without uploading the file again. Ready files are reused
within that session, keyed by resolved local path and MIME type; staged files
must remain unchanged until the session closes. Preparation does not build a
generation configuration. Callers that omit these phases retain lazy upload and
processing during generation.

OpenRouter preparation validates the route and file-part shape only. It does
not read files, create a client or establish that a file exists or is ready.
Generation performs its bounded file reads and request construction. Audio
remains Gemini-only in both preparation and generation.

Keep one session per workflow. The caller owns local files and cleans them up
at its existing boundary, then closes the session for best-effort remote cleanup.
Closing is idempotent and never deletes local files. An uploaded resource cannot
be reused with a different Gemini client.

Instant rows keep the staged or converted PDF until row cleanup. For an
OpenRouter slide route, the row supplies that local PDF directly. For a
Gemini slide route, it uses its existing Gemini Files reference.

OpenRouter requests containing a PDF accept up to 10 MiB of combined raw
attachments. A larger PDF request on an OpenRouter route uses that stage's
Gemini model instead, which uploads the file rather than inlining it, so decks
up to the 50 MB upload limit keep working on either provider. Base64 encoding
and SDK JSON serialization both consume memory.
In a local single-request measurement with synthetic files and a mock HTTP
transport, 10, 20 and 50 MiB inputs added about 50, 101 and 251 MiB respectively
to the adapter process's peak RSS. Worker baseline memory and concurrent
requests also contribute to total memory usage.

## Recorded costs

New OpenRouter usage records retain thinking tokens separately, but do not add
them to completion tokens a second time. A finite nonnegative provider-reported
cost, including zero, takes precedence over a tariff estimate. Admin reports
label reported, estimated and mixed totals; input/output cost components remain
tariff estimates. Legacy Gemini records and exports retain their existing shape.

OpenRouter normal-request tariffs remain standard rates for overnight jobs.
Calculator entries named `anthropic-batch-reference/...` are separate vendor
Batch references, not OpenRouter execution routes or verified Vertex Batch
prices. The Haiku estimate uses the published through-100,000 / over-100,000
prompt-token tiers; endpoint metadata's threshold wording is ambiguous at the
boundary, so a reported charge takes precedence.

SDK references: [pinned usage documentation](https://github.com/openai/openai-python/tree/v2.54.0)
and [OpenRouter SDK guidance](https://openrouter.ai/docs/guides/community/openai-sdk).
