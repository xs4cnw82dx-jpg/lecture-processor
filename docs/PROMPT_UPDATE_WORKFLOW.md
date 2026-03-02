# Prompt Update Workflow

This document describes how to review and update the AI prompts used in Lecture Processor.

## Where Prompts Live

All prompts are defined in a single file:

```
lecture_processor/services/prompt_registry.py
```

Each prompt has a unique constant name (e.g. `PROMPT_SLIDE_EXTRACTION`, `PROMPT_AUDIO_TRANSCRIPTION`) and is imported into `legacy_app.py`.

## How to View Current Prompts

1. **Admin Dashboard** — Go to `/admin`, scroll down to **Prompt Inventory**, and click **Load prompts**. This shows the current version, all prompt names, their models, and the first 200 characters of each prompt.
2. **API** — `GET /api/admin/prompts` returns JSON, `GET /api/admin/prompts?format=markdown` returns a readable markdown summary.
3. **Source** — Open `prompt_registry.py` directly.

## How to Update a Prompt

1. Open `lecture_processor/services/prompt_registry.py`.
2. Find the prompt constant you want to change.
3. Edit the prompt text.
4. Bump `PROMPT_REGISTRY_VERSION` (date string like `"2026-03-02"`).
5. Deploy.

## Testing After a Prompt Change

- Run a test job in each affected mode (lecture-notes, slides-only, interview).
- Compare the output quality against a known-good baseline.
- Check the admin dashboard for token usage changes — a significant increase may indicate a prompt regression.

## Which Prompt Does What

| Constant | Used In | Model | Purpose |
|----------|---------|-------|---------|
| `PROMPT_SLIDE_EXTRACTION` | lecture-notes, slides-only | `gemini-2.5-flash-lite` | Extracts text from slide images |
| `PROMPT_AUDIO_TRANSCRIPTION` | lecture-notes | `gemini-3-flash-preview` | Transcribes plain audio |
| `PROMPT_AUDIO_TRANSCRIPTION_TIMESTAMPED` | lecture-notes | `gemini-3-flash-preview` | Transcribes audio with timestamps |
| `PROMPT_INTERVIEW_TRANSCRIPTION` | interview | `gemini-2.5-pro` | Transcribes interview audio |
| `PROMPT_INTERVIEW_SUMMARY` | interview | `gemini-2.5-pro` | Generates interview summary |
| `PROMPT_INTERVIEW_SECTIONED` | interview | `gemini-2.5-pro` | Creates sectioned interview output |
| `PROMPT_MERGE_TEMPLATE` | lecture-notes | `gemini-2.5-pro` | Merges slides + audio into notes |
| `PROMPT_MERGE_WITH_AUDIO_MARKERS` | lecture-notes | `gemini-2.5-pro` | Merges with audio timestamp markers |
| `PROMPT_STUDY_TEMPLATE` | lecture-notes, slides-only | `gemini-2.5-flash-lite` | Generates flashcards + test questions |
