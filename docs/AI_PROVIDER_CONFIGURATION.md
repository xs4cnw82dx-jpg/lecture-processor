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
no data collection. Plugins are explicitly disabled except the native PDF
parser when a PDF part is present. These request settings do not establish
account-level privacy settings or prove provider-side enforcement. Account
settings, endpoint eligibility and request acceptance must be verified before
any route is activated. There is no OpenRouter Batch API integration.

Forced isolated runners intercept routing before constructing any real
provider client. Adapter contract tests use an injected HTTP mock transport
with a literal test key and blocked network access.

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
