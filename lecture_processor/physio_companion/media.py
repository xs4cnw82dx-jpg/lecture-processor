"""Explicit manifest-backed media serving with HTTP byte ranges."""

from __future__ import annotations

import json
import mimetypes
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Iterator


MANIFEST_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")


@dataclass(frozen=True, slots=True)
class MediaEntry:
    media_id: str
    path: Path
    mime_type: str
    title: str
    metadata: dict[str, Any]


class InvalidRange(ValueError):
    pass


class MediaManifest:
    def __init__(self, manifest_path: Path):
        self.manifest_path = Path(manifest_path).resolve()
        self._entries: dict[str, MediaEntry] = {}
        self._mtime_ns: int | None = None
        self._lock = threading.RLock()
        self.reload()

    def reload(self) -> int:
        with self._lock:
            if not self.manifest_path.exists():
                self._entries = {}
                self._mtime_ns = None
                return 0
            manifest_text = self.manifest_path.read_text(encoding="utf-8")
            if self.manifest_path.suffix.casefold() == ".jsonl":
                records = [json.loads(line) for line in manifest_text.splitlines() if line.strip()]
            else:
                raw = json.loads(manifest_text)
                records = raw.get("sources", raw.get("media", [])) if isinstance(raw, dict) else raw
            if not isinstance(records, list):
                raise ValueError("Manifest must contain a sources or media list")
            entries: dict[str, MediaEntry] = {}
            for record in records:
                if not isinstance(record, dict):
                    continue
                media_id = str(record.get("id") or record.get("media_id") or "")
                local_path = record.get("local_path", record.get("path"))
                if not MANIFEST_ID_RE.fullmatch(media_id) or not local_path:
                    continue
                path = Path(str(local_path)).expanduser().resolve()
                mime_type = str(record.get("mime_type") or mimetypes.guess_type(path.name)[0] or "application/octet-stream")
                metadata = {
                    key: record[key]
                    for key in ("source_type", "privacy_class", "copyright_class", "trust_tier", "page", "extraction_status", "review_status")
                    if key in record
                }
                entries[media_id] = MediaEntry(
                    media_id=media_id,
                    path=path,
                    mime_type=mime_type,
                    title=str(record.get("title") or path.name),
                    metadata=metadata,
                )
            self._entries = entries
            self._mtime_ns = self.manifest_path.stat().st_mtime_ns
            return len(entries)

    def _reload_if_changed(self) -> None:
        try:
            mtime = self.manifest_path.stat().st_mtime_ns
        except OSError:
            mtime = None
        if mtime != self._mtime_ns:
            self.reload()

    def get(self, media_id: str) -> MediaEntry | None:
        if not MANIFEST_ID_RE.fullmatch(media_id):
            return None
        with self._lock:
            self._reload_if_changed()
            entry = self._entries.get(media_id)
            if (
                not entry
                or not entry.path.is_file()
                or entry.metadata.get("privacy_class") == "review-required"
                or entry.metadata.get("extraction_status") in {"review-required", "rejected"}
                or entry.metadata.get("review_status") == "rejected"
            ):
                return None
            return entry

    def list_entries(self) -> list[dict[str, Any]]:
        with self._lock:
            self._reload_if_changed()
            return [
                {
                    "id": entry.media_id,
                    "title": entry.title,
                    "mime_type": entry.mime_type,
                    **entry.metadata,
                }
                for entry in self._entries.values()
                if entry.path.is_file()
                and entry.metadata.get("privacy_class") != "review-required"
                and entry.metadata.get("extraction_status") not in {"review-required", "rejected"}
                and entry.metadata.get("review_status") != "rejected"
            ]

    def resolve_target(self, target: str) -> str | None:
        """Resolve an Obsidian embed target to a manifest ID, never a path."""

        folded = target.strip().casefold()
        with self._lock:
            self._reload_if_changed()
            for entry in self._entries.values():
                candidates = {
                    entry.media_id.casefold(),
                    entry.title.casefold(),
                    entry.path.name.casefold(),
                    entry.path.stem.casefold(),
                }
                if folded in candidates:
                    return entry.media_id
        return None


def parse_byte_range(header: str | None, size: int) -> tuple[int, int, bool]:
    if not header:
        return 0, max(0, size - 1), False
    if "," in header:
        raise InvalidRange("Multiple ranges are not supported")
    match = RANGE_RE.fullmatch(header.strip())
    if not match or size <= 0:
        raise InvalidRange("Invalid byte range")
    start_raw, end_raw = match.groups()
    if not start_raw and not end_raw:
        raise InvalidRange("Invalid byte range")
    if not start_raw:
        suffix = int(end_raw)
        if suffix <= 0:
            raise InvalidRange("Invalid suffix range")
        start = max(0, size - suffix)
        end = size - 1
    else:
        start = int(start_raw)
        end = int(end_raw) if end_raw else size - 1
    if start >= size or start < 0 or end < start:
        raise InvalidRange("Range is outside the file")
    return start, min(end, size - 1), True


def iter_file_range(path: Path, start: int, length: int, *, chunk_size: int = 64 * 1024) -> Iterator[bytes]:
    with path.open("rb") as handle:
        handle.seek(start)
        remaining = length
        while remaining > 0:
            chunk = handle.read(min(chunk_size, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk
