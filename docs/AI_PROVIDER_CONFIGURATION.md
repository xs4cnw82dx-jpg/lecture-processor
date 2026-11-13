# AI provider request configuration

The Gemini client uses `GEMINI_HTTP_TIMEOUT_MS` as its HTTP timeout in
milliseconds. The default is `600000` (10 minutes), covering background
generation, provider file operations, and batch API requests.

Generation performed while handling a web request uses
`GEMINI_REQUEST_HTTP_TIMEOUT_MS`, defaulting to `60000` (1 minute). This value
cannot exceed the configured client timeout. It is applied to the individual
generation call; background workers retain the client timeout.

Both settings accept positive integers. Missing, empty, non-integer, zero, or
negative values use their defaults. These are per-request transport limits;
existing retry policies and overall job deadlines still apply separately.
