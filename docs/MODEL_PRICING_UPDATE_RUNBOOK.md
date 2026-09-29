# Model Pricing Update Runbook

When Google updates Gemini model pricing, follow these steps to update the cost calculator.

## Steps

1. **Check official [models](https://ai.google.dev/gemini-api/docs/models), [pricing](https://ai.google.dev/gemini-api/docs/pricing), and [thinking settings](https://ai.google.dev/gemini-api/docs/thinking)**.

2. **Update `config/model_pricing.json`**. This file is the source of truth for admin cost analysis and the admin Cost Calculator:
   - Update the `version` field to today's date.
   - Update both `models` (calculator) and `pricing_table` (job reports), including standard, batch, audio, and long-context rates.
   - For an announced future rate change, add a `rate_schedule` with its ISO `effective_from` date to both entries. Rates switch automatically by UTC date, including when the config is cached.
   - Retain old model entries so historical jobs still have matching rates. Reports use the job's finish date (creation/start date when unavailable).
   - Update scenario model IDs. Flat short-context entries use `max_input_tokens` and `long_context_model` to select the higher tier in the calculator.

3. **Verify the admin pricing API**:
   - Start the app locally.
   - Open `/api/admin/model-pricing` as an admin user.
   - Confirm `version`, `pricing_as_of`, and the effective model rates. The API resolves today's flat calculator rates and preserves the dated `pricing_table` for historical reports.

4. **Update runtime model constants** (if model names changed):
   - Find `MODEL_SLIDES`, `MODEL_AUDIO`, `MODEL_INTEGRATION`, `MODEL_INTERVIEW`, `MODEL_INTERVIEW_CODING`, `MODEL_STUDY`, and `MODEL_TOOLS` in `lecture_processor/runtime/core.py`.
   - Update model strings and `MODEL_THINKING_POLICY` if needed.

5. **Deploy and verify**:
   - Open `/admin`, scroll to **Cost Calculator**.
   - Check that the calculated costs match your manual calculation.
   - Run `python -m pytest -q tests/test_model_pricing.py tests/test_admin_cost_analyzer.py tests/test_domain_ai_provider.py` and `npm run e2e -- e2e/admin-calculator.spec.js`.

## Current catalog (verified September 29, 2026)

- Gemini 3.5 Flash-Lite replaces 3.1 Flash-Lite for slides, audio, study tools, and extraction.
- Gemini 3.1 Pro Preview replaces 2.5 Pro for notes integration and interviews. This is Google's latest Pro endpoint and remains a preview.
- Gemini 3.8 Flash replaces 3 Flash Preview for interview coding.
- Flash-Lite uses minimal thinking; Pro and interview coding use high thinking. Gemini 3.8 Flash does not support minimal thinking.
- Gemini 3.8 Flash standard rates are $0.75 input / $3.75 output per million through December 31, 2026, then $1.50 / $7.50 from January 1, 2027. Batch rates are half these amounts. Output token accounting includes thinking tokens.

## Rate Format

All rates are in **USD per 1 million tokens**. Example:
- `$0.10/M` means $0.10 per 1,000,000 input tokens
- Cost formula: `tokens × rate / 1,000,000`
