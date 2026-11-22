# Gemini audio migration — 7 October 2026

## Delivered implementation

- All audio transcription now uses `gemini-3.8-flash` with `thinking_level: high`: lecture audio (plain, timestamped and fallback), Interview Transcription, Voice Notes, General Transcriber, instant batch and deferred batch.
- Other task models stay unchanged: slides/study/tools use Gemini 3.5 Flash-Lite; notes integration uses Gemini 3.1 Pro Preview; interview coding already uses Gemini 3.8 Flash/high.
- Removed obsolete unused `thinking_budget` arguments from the generation wrapper and interview enhancement callers. Deferred batch no longer has a budget-based generation branch and now applies the model's thinking-level policy to every stage, including audio. Batch request normalization strips obsolete budget and sampling parameters while preserving independent response settings.
- Standard requests already omitted custom temperature/top-p/top-k. Tests check the serialized SDK configuration, not only model constants.
- Existing `generateContent` and Batch API transport is retained. This migration addresses model/configuration compatibility without changing upload, response parsing or batch lifecycle contracts.

## Provider cost accounting

Official references checked on 7 October 2026:

- [Gemini 3.8 Flash model reference](https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash): audio input, Batch API and high thinking supported. Minimal thinking is not supported on this model.
- [Provider pricing](https://ai.google.dev/gemini-api/docs/pricing): standard input/output rates USD 0.75/3.75 per million tokens through 31 December 2026; batch 0.375/1.875. From 1 January 2027 UTC, standard becomes 1.50/7.50 and batch 0.75/3.75. Output billing includes thinking tokens.
- [Gemini migration guide](https://ai.google.dev/gemini-api/docs/gemini-3): thinking-level migration and removal of custom sampling settings.

The September catalog already contained these correct 3.8 rates and automatic scheduled rollover. Updated the catalog version and admin calculator scenarios to route every audio stage to 3.8; corrected interview summary/section estimates to the actual study model; added a standalone audio/voice estimate. Historical model prices and historical-job dates are preserved. Customer credit prices and balances are unchanged.

Fixed one related accounting omission: a successful timestamped provider response that fails JSON parsing is still paid usage. When plain transcription is retried, the admin usage totals now include both responses, including their thinking tokens.

## Verification

201 isolated backend tests passed across provider, pricing, transcription policies, batch orchestration, pipelines, admin cost analyzer and launch guardrails. Python correctness lint and whitespace checks passed.

The new executable tests use the real SDK configuration objects and fake provider responses to exercise plain/timestamped/fallback transcription, single interview/voice/general jobs, instant audio/interview batch stages, and deferred batch payload normalization. Tests also verify usage metadata and admin catalog mappings. Existing pricing tests verify standard/batch rates, the January rollover and unchanged historical costs.

No external AI calls, credentials, real uploads, customer credits or production data were used. Actual provider transcription quality cannot be measured by synthetic provider tests; the source/SDK payload and documented model capability are verified. Parent owns integrated browser/CI/release verification.
