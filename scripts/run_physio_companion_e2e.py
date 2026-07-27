#!/usr/bin/env python3
"""Run an isolated, synthetic Physio companion for Playwright tests."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lecture_processor.physio_companion import CompanionConfig, create_companion_app


OWNER_TOKEN_ENV = "PHYSIO_COMPANION_OWNER_TOKEN"


def _write_fixture(vault: Path, support: Path) -> None:
    notes = {
        "Schouder.md": """---
id: region-schouder
type: region
regions: [schouder]
aliases: [Shoulder]
curation_status: reviewed
trust_tier: current_guideline
---
# Schouder

## Screening
Controleer rode vlaggen en de noodzaak tot verwijzen.

## Anamnese
Vraag naar belasting, herstel en het klachtenverloop.

## Onderzoek
Combineer actieve beweging, passieve beweging en weerstandstests. Zie [[Scapula]].

## Differentiaal
Vergelijk hypotheses met het volledige klinische patroon.

## Behandeling
Kies een passend gedoseerde opbouw.

## Herbeoordeling
Meet dezelfde relevante uitkomst opnieuw.
""",
        "Nek.md": """---
id: region-nek
type: region
regions: [nek]
aliases: [Cervicaal]
curation_status: reviewed
trust_tier: current_guideline
---
# Nek

## Screening
Controleer neurologische uitval, trauma en rode vlaggen.

## Anamnese
Breng het klachtenverloop en provocerende factoren in kaart.

## Onderzoek
Onderzoek beweging, neurologie en relevante functietaken.
""",
        "Scapula.md": """---
id: structure-scapula
type: structure
regions: [schouder]
aliases: [Schouderblad]
curation_status: reviewed
trust_tier: current_guideline
---
# Scapula

De scapula vormt de beweeglijke basis van de schoudergordel. Zie [[Schouder]].
""",
    }
    vault.mkdir(parents=True, exist_ok=True)
    support.mkdir(parents=True, exist_ok=True)
    for filename, content in notes.items():
        (vault / filename).write_text(content, encoding="utf-8")

    media_path = support / "atlas-of-anatomy.pdf"
    media_path.write_bytes(b"%PDF-1.4\n" + (b"synthetic-e2e-atlas\n" * 96))
    manifest = {
        "sources": [
            {
                "id": "atlas-of-anatomy",
                "title": "atlas-of-anatomy.pdf",
                "local_path": str(media_path),
                "mime_type": "application/pdf",
                "privacy_class": "public",
                "review_status": "active",
                "regions": ["schouder"],
            }
        ]
    }
    (support / "source-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False),
        encoding="utf-8",
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")

    owner_token = os.getenv(OWNER_TOKEN_ENV, "")
    if len(owner_token) < 32:
        raise SystemExit(f"{OWNER_TOKEN_ENV} must contain at least 32 characters")

    with tempfile.TemporaryDirectory(prefix="lecture-processor-physio-e2e-") as temporary_root:
        root = Path(temporary_root)
        vault = root / "vault"
        support = root / "support"
        _write_fixture(vault, support)
        config = CompanionConfig(
            vault_path=vault,
            app_support_path=support,
            secret_key="playwright-session-secret-for-isolated-e2e-only",
            owner_token=owner_token,
            codex_binary="codex-disabled-in-e2e",
        )
        app = create_companion_app(config)
        app.run(host="127.0.0.1", port=args.port, debug=False, use_reloader=False, threaded=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
