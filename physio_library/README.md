# Physio Library

This folder contains the repo-managed knowledge base for Physio Assistant.

## Structure

- `sources/guidelines/`
- `sources/study-guides/`
- `sources/forms/`
- `index/manifest.json`

## Add Documents

1. Put source files into one of the `sources/` folders.
2. Supported source formats:
   - `.pdf`
   - `.docx`
   - `.pptx`
   - `.txt`
   - `.md`
3. Run:

```bash
./.venv/bin/python scripts/build_physio_library.py
```

The script extracts text, chunks it, creates embeddings, and writes the deployable index to `physio_library/index/manifest.json`.

## Access Control

Physio Assistant access is controlled via:

- `config/physio_allowed_emails.json`
- or the `PHYSIO_ALLOWED_EMAILS` environment variable

For local development, `allow_local_dev` can stay `true`. Before deploying to production, add the owner email to the allowlist or set `PHYSIO_ALLOWED_EMAILS`.
