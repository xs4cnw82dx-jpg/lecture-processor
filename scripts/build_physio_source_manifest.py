#!/usr/bin/env python3
"""Build a reviewed, explicit inventory for local Physio source files.

The command deliberately scans only configured roots. It never treats Downloads
as an implicit root and it never modifies source material.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import os
import re
import tempfile
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


SUPPORTED_SUFFIXES = {
    ".csv", ".doc", ".docx", ".heic", ".jpeg", ".jpg", ".md", ".m4a",
    ".mov", ".mp3", ".mp4", ".pdf", ".png", ".ppt", ".pptx", ".rtf",
    ".txt", ".wav", ".xls", ".xlsx",
}
IDENTIFIER_PATH_TERMS = {
    "stage", "stagelog", "stageverslag", "feedback", "assessment", "beoordeling",
    "cv", "sollicitatie", "patient", "patiënt", "client", "cliënt", "email",
}
EMAIL_RE = re.compile(rb"[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}", re.I)


@dataclass(frozen=True)
class RootSpec:
    source_type: str
    trust_tier: int
    path: Path


@dataclass
class ManifestRecord:
    source_id: str
    sha256: str
    path: str
    root: str
    source_type: str
    trust_tier: int
    size_bytes: int
    modified_at: str
    suffix: str
    mime_type: str
    privacy_class: str
    copyright_class: str
    extraction_status: str
    duplicate_of: str | None


def default_roots(home: Path | None = None) -> list[RootSpec]:
    base = home or Path.home()
    return [
        RootSpec("guideline", 500, base / "Documents/KNGF Richtlijnen"),
        RootSpec("semester-summary", 300, base / "Documents/Semester Summaries"),
        RootSpec("anatomy", 300, base / "Documents/Anatomie"),
        RootSpec("craft-note", 200, base / "Downloads/Hanze hogeschool Craft notes"),
        RootSpec("ai-combined-lecture", 100, base / "Downloads/Colleges uitgewerkt uitgebreid"),
        RootSpec("textbook", 400, base / "Desktop/Fysiotherapie Boeken"),
    ]


def parse_root(value: str) -> RootSpec:
    try:
        source_type, tier, raw_path = value.split(":", 2)
        return RootSpec(source_type.strip(), int(tier), Path(raw_path).expanduser().resolve())
    except (TypeError, ValueError) as exc:
        raise argparse.ArgumentTypeError("root must be TYPE:TIER:/absolute/path") from exc


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _contains_likely_identifier(path: Path) -> bool:
    lowered_parts = {part.casefold() for part in path.parts}
    if any(any(term in part for term in IDENTIFIER_PATH_TERMS) for part in lowered_parts):
        return True
    if path.suffix.casefold() not in {".md", ".txt", ".csv", ".rtf"}:
        return False
    try:
        with path.open("rb") as handle:
            return EMAIL_RE.search(handle.read(512 * 1024)) is not None
    except OSError:
        return True


def _classes(spec: RootSpec, path: Path) -> tuple[str, str, str]:
    sensitive = _contains_likely_identifier(path)
    privacy = "review-required" if sensitive else "private-local"
    copyright = "publisher-restricted" if spec.source_type in {"textbook", "guideline"} else "private-study"
    status = "review-required" if sensitive else "pending"
    return privacy, copyright, status


def iter_records(roots: Iterable[RootSpec]) -> Iterable[ManifestRecord]:
    seen_hashes: dict[str, str] = {}
    for spec in roots:
        if not spec.path.is_dir():
            continue
        for path in sorted(spec.path.rglob("*")):
            if not path.is_file() or path.suffix.casefold() not in SUPPORTED_SUFFIXES:
                continue
            try:
                stat = path.stat()
                digest = _sha256(path)
            except OSError:
                continue
            source_id = "src-" + digest[:20]
            duplicate_of = seen_hashes.get(digest)
            seen_hashes.setdefault(digest, source_id)
            privacy, copyright, extraction_status = _classes(spec, path)
            yield ManifestRecord(
                source_id=source_id,
                sha256=digest,
                path=str(path.resolve()),
                root=str(spec.path.resolve()),
                source_type=spec.source_type,
                trust_tier=spec.trust_tier,
                size_bytes=stat.st_size,
                modified_at=datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
                suffix=path.suffix.casefold(),
                mime_type=mimetypes.guess_type(path.name)[0] or "application/octet-stream",
                privacy_class=privacy,
                copyright_class=copyright,
                extraction_status=extraction_status,
                duplicate_of=duplicate_of,
            )


def write_manifest(records: Iterable[ManifestRecord], output: Path) -> dict[str, int]:
    output = output.expanduser().resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    rows = list(records)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=output.parent, delete=False) as handle:
        temp_path = Path(handle.name)
        serialized = []
        for record in rows:
            item = asdict(record)
            item["id"] = record.source_id
            item["local_path"] = record.path
            serialized.append(item)
        if output.suffix.casefold() == ".jsonl":
            for item in serialized:
                handle.write(json.dumps(item, ensure_ascii=False, sort_keys=True) + "\n")
        else:
            json.dump({"schema_version": 1, "sources": serialized}, handle, ensure_ascii=False, sort_keys=True)
    os.replace(temp_path, output)
    try:
        output.chmod(0o600)
    except OSError:
        pass
    return {
        "records": len(rows),
        "duplicates": sum(row.duplicate_of is not None for row in rows),
        "review_required": sum(row.extraction_status == "review-required" for row in rows),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        type=Path,
        default=Path.home() / "Library/Application Support/Lecture Processor/Physio/source-manifest.json",
    )
    parser.add_argument(
        "--root",
        dest="roots",
        action="append",
        type=parse_root,
        help="Explicit source root as TYPE:TIER:/absolute/path. Supplying one disables defaults.",
    )
    args = parser.parse_args()
    roots = args.roots or default_roots()
    summary = write_manifest(iter_records(roots), args.output)
    print(json.dumps({"output": str(args.output.expanduser().resolve()), **summary}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
