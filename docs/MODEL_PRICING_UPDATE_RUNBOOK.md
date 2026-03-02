# Model Pricing Update Runbook

When Google updates Gemini model pricing, follow these steps to update the cost calculator.

## Steps

1. **Check official pricing** at [Google AI for Developers](https://ai.google.dev/pricing).

2. **Update `config/model_pricing.json`**:
   - Update the `version` field to today's date.
   - Update the rates under each model key (`input_text_per_M`, `input_audio_per_M`, `output_per_M`).
   - If a new model is introduced, add a new entry.

3. **Update `static/js/admin.js`**:
   - Find the `PRICING` object near the bottom of the file.
   - Mirror the same rate changes.
   - If a new model is added and used in processing, also update the `SCENARIOS` object.

4. **Update `legacy_app.py`** (if model names changed):
   - Find `MODEL_SLIDES`, `MODEL_AUDIO`, `MODEL_INTEGRATION`, `MODEL_INTERVIEW`, `MODEL_STUDY`.
   - Update model strings and `MODEL_THINKING_POLICY` if needed.

5. **Deploy and verify**:
   - Open `/admin`, scroll to **Cost Calculator**.
   - Check that the calculated costs match your manual calculation.

## Rate Format

All rates are in **USD per 1 million tokens**. Example:
- `$0.10/M` means $0.10 per 1,000,000 input tokens
- Cost formula: `tokens × rate / 1,000,000`
