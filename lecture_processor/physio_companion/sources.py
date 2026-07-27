"""Safe, manifest-backed source imports for the local Physio workspace."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import re
import subprocess
import tempfile
import threading
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO
from urllib.parse import quote, unquote, urlsplit
from xml.etree import ElementTree

from pypdf import PdfReader
from werkzeug.utils import secure_filename

from .markdown import as_string_list, iter_markdown_files, parse_note, slugify


CATEGORY_DEFAULTS: dict[str, dict[str, Any]] = {
    "guidelines": {"source_type": "guideline", "trust_tier": 500, "copyright_class": "publisher-restricted"},
    "semester-summaries": {"source_type": "semester-summary", "trust_tier": 300, "copyright_class": "private-study"},
    "anatomy": {"source_type": "anatomy", "trust_tier": 300, "copyright_class": "private-study"},
    "craft": {"source_type": "craft-note", "trust_tier": 200, "copyright_class": "private-study"},
    "lectures": {"source_type": "lecture", "trust_tier": 150, "copyright_class": "private-study"},
    "books": {"source_type": "textbook", "trust_tier": 400, "copyright_class": "publisher-restricted"},
    "other": {"source_type": "other", "trust_tier": 100, "copyright_class": "private-study"},
}

SUPPORTED_SUFFIXES = {
    ".csv", ".doc", ".docx", ".heic", ".jpeg", ".jpg", ".md", ".m4a",
    ".mov", ".mp3", ".mp4", ".pdf", ".png", ".ppt", ".pptx", ".rtf",
    ".txt", ".wav", ".xls", ".xlsx",
}
REVIEW_ACTIONS = {
    "pending": "pending",
    "review": "reviewed",
    "reviewed": "reviewed",
    "activate": "active",
    "active": "active",
    "reject": "rejected",
    "rejected": "rejected",
}
TRUST_TIER_VALUES = {
    "guideline": 500,
    "evidence-publication": 400,
    "evidence_publication": 400,
    "textbook": 400,
    "semester-summary": 300,
    "semester_summary": 300,
    "personal-note": 200,
    "personal_note": 200,
    "ai-combined-lecture": 100,
    "ai_combined_lecture": 100,
    "unverified": 100,
}
VAULT_TRUST_BY_CATEGORY = {
    "guidelines": "guideline",
    "books": "evidence_publication",
    "semester-summaries": "semester_summary",
    "anatomy": "semester_summary",
    "craft": "personal_note",
    "lectures": "personal_note",
    "other": "unverified",
}
EDITABLE_FIELDS = {
    "title", "category", "source_type", "source_date", "date", "privacy_class",
    "copyright_class", "trust_tier", "extraction_status", "review_status", "notes", "regions",
}

AUTO_EXTRACT_SUFFIXES = {".csv", ".docx", ".md", ".pdf", ".rtf", ".txt"}
MAX_AUTO_EXTRACT_BYTES = 40 * 1024 * 1024
MAX_EXTRACTED_CHARS = 2_000_000
MAX_PDF_PAGES = 500
MAX_DOCX_ARCHIVE_ENTRIES = 2_000
MAX_DOCX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024
MAX_DOCX_XML_BYTES = 20 * 1024 * 1024
MAX_ARCHIVE_COMPRESSION_RATIO = 200
SECTION_CHARS = 7_500
QUERY_STOPWORDS = {
    "aan", "als", "bij", "dat", "de", "den", "der", "die", "dit", "een", "en", "er",
    "gaat", "gebeurt", "het", "hoe", "in", "is", "komt", "met", "na", "of", "om", "op",
    "te", "tot", "uit", "van", "voor", "wat", "welke", "wordt", "zijn",
}

AUTO_REVIEW_IGNORE = re.compile(
    r"(?i)(feedback|feedforward|studentmentor|stageverslag|beoordelingsformulier|"
    r"project lecture processor|payment|betal|factuur|sollicitatie|cv\b|"
    r"_(?:heic|png)_preview\.png$)"
)
AUTO_REGION_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("centraal-neurologisch", re.compile(
        r"(?i)(/blok 2[ ._-]*1/|\bblok 2[ ._-]*1\b|parkinson|cerebro.?vascul|\bcva\b|"
        r"multiple scler|\bms\b|centraal neurolog|hersenletsel|dwarslaes|alzheimer|"
        r"basale ganglia|cerebell|neurorevalid)"
    )),
    ("perifeer-neurologisch", re.compile(
        r"(?i)(/blok 1[ ._-]*4/|\bblok 1[ ._-]*4\b|perifeer neurolog|polyneuropath|"
        r"guillain.?barr|plexus(?:letsel)?|perifere zenuw|zenuwletsel|neuropathie)"
    )),
    ("knie", re.compile(
        r"(?i)(menisc|menisect|\bknie|knee|patell|gonartro|voorste kruisband|\bvkb\b|\bacl\b)"
    )),
    ("schouder", re.compile(r"(?i)(schouder|shoulder|rotator.?cuff|glenohumer|scapul|\bkans\b)")),
    ("bekken-heup", re.compile(r"(?i)(bekken|pelvi|\bheup|hip|coxartro)")),
    ("enkel-voet", re.compile(r"(?i)(enkel|ankle|\bvoet|foot|achilles|plantair)")),
    ("pols-hand", re.compile(r"(?i)(\bpols\b|\bwrist\b|\bhand\b|handfunctie|handletsel|carpaal|carpal)")),
    ("elleboog", re.compile(r"(?i)(elleboog|elbow|epicondyl)")),
    ("nek", re.compile(r"(?i)(nekpijn|cervicaal|cervical|whiplash)")),
    ("lumbaal", re.compile(r"(?i)(lage rug|low back|lumbaal|lumbar|lumbosacraal|\blrs\b)")),
    ("thoracaal", re.compile(r"(?i)(thoracaal|thoracic|rib|costae)")),
    ("kaak-hoofd", re.compile(r"(?i)(kaak|temporomandib|\btmj\b|hoofdpijn|migraine)")),
    ("cardiorespiratoir", re.compile(r"(?i)(cardio|respir|\bcopd\b|hartrevalid|longrevalid|claudicatio)")),
    ("oncologie", re.compile(r"(?i)(oncolog|kanker|cancer|tumou?r|lymfoedeem)")),
    ("geriatrie", re.compile(r"(?i)(geriatr|kwetsbare oudere|valprevent|osteoporo)")),
    ("pijn", re.compile(r"(?i)(alle pijncolleges|pijnfysiolog|nocicept|sensitisatie|pain science)")),
)


class SourceManagerError(ValueError):
    """Base class for user-facing source manager errors."""


class SourceNotFound(SourceManagerError):
    pass


class SourceConflict(SourceManagerError):
    pass


class SourceTooLarge(SourceManagerError):
    pass


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _safe_filename(filename: str) -> str:
    # Path.name also neutralizes Windows-style paths after slash normalization.
    basename = Path(str(filename).replace("\\", "/")).name
    sanitized = secure_filename(basename)
    if not sanitized or sanitized in {".", ".."}:
        raise SourceManagerError("Het bestand heeft geen geldige bestandsnaam")
    suffix = Path(sanitized).suffix.casefold()
    if suffix not in SUPPORTED_SUFFIXES:
        raise SourceManagerError(f"Bestandstype {suffix or '(zonder extensie)'} wordt niet ondersteund")
    return sanitized


def classify_source(filename: str) -> str:
    """Classify conservatively from the filename; callers may override it."""

    folded = re.sub(r"[_-]+", " ", Path(filename).stem.casefold())
    if re.search(r"\b(kngf|richtlijn|guideline|protocol)\b", folded):
        return "guidelines"
    if re.search(r"\b(semester|samenvatting|summary|tentamenstof)\b", folded):
        return "semester-summaries"
    if re.search(r"\b(anatomie|anatomy|atlas|spier|muscle|botten|bones|zenuw|nerve)\b", folded):
        return "anatomy"
    if "craft" in folded:
        return "craft"
    if re.search(r"\b(college|lecture|hoorcollege|werkcollege|lesnotit)\w*\b", folded):
        return "lectures"
    if re.search(r"\b(boek|book|textbook|kenhub)\b", folded):
        return "books"
    return "other"


def _trust_tier(value: Any) -> tuple[int, str | None]:
    if isinstance(value, str) and not value.strip().isdigit():
        label = value.strip().casefold()
        if label not in TRUST_TIER_VALUES:
            raise SourceManagerError("Onbekend trust-tier")
        return TRUST_TIER_VALUES[label], label.replace("-", "_")
    try:
        numeric = int(value)
    except (TypeError, ValueError) as exc:
        raise SourceManagerError("trust_tier moet een bekend label of geheel getal zijn") from exc
    if not 0 <= numeric <= 1000:
        raise SourceManagerError("trust_tier moet tussen 0 en 1000 liggen")
    label = (
        "guideline" if numeric >= 500 else
        "evidence_publication" if numeric >= 400 else
        "semester_summary" if numeric >= 300 else
        "personal_note" if numeric >= 200 else
        "unverified"
    )
    return numeric, label


class SourceManager:
    """Import source copies and keep their single JSON manifest consistent."""

    def __init__(self, manifest_path: Path, sources_root: Path, vault_path: Path, *, max_source_bytes: int):
        self.manifest_path = Path(manifest_path).expanduser().resolve()
        self.sources_root = Path(sources_root).expanduser().resolve()
        self.vault_path = Path(vault_path).expanduser().resolve()
        self.max_source_bytes = max_source_bytes
        self._lock = threading.RLock()
        self.sources_root.mkdir(parents=True, exist_ok=True)
        self.manifest_path.parent.mkdir(parents=True, exist_ok=True)
        if not self.manifest_path.exists():
            self._write_records([])

    @property
    def categories(self) -> list[dict[str, Any]]:
        return [{"id": key, **value} for key, value in CATEGORY_DEFAULTS.items()]

    def _read_document(self) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        try:
            raw = json.loads(self.manifest_path.read_text(encoding="utf-8"))
        except FileNotFoundError:
            return {"schema_version": 1}, []
        except json.JSONDecodeError as exc:
            raise SourceManagerError("De bronmanifestatie bevat ongeldige JSON") from exc
        if isinstance(raw, list):
            return {"schema_version": 1}, [item for item in raw if isinstance(item, dict)]
        if not isinstance(raw, dict) or not isinstance(raw.get("sources", []), list):
            raise SourceManagerError("De bronmanifestatie moet een sources-lijst bevatten")
        metadata = {key: value for key, value in raw.items() if key != "sources"}
        return metadata, [item for item in raw.get("sources", []) if isinstance(item, dict)]

    def _write_records(self, records: list[dict[str, Any]], metadata: dict[str, Any] | None = None) -> None:
        document = {**(metadata or {"schema_version": 1}), "sources": records}
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=self.manifest_path.parent, prefix=".source-manifest-", delete=False
        ) as handle:
            temp_path = Path(handle.name)
            json.dump(document, handle, ensure_ascii=False, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temp_path, 0o600)
            os.replace(temp_path, self.manifest_path)
        finally:
            temp_path.unlink(missing_ok=True)

    def _reviewed_source_ids(self) -> set[str]:
        """Return manifest IDs actually cited by reviewed vault notes."""

        return set(self._reviewed_source_regions())

    def _reviewed_source_regions(self) -> dict[str, set[str]]:
        """Map cited manifest IDs to the regions of their reviewed vault notes."""

        source_regions: dict[str, set[str]] = {}
        for path in iter_markdown_files(self.vault_path):
            try:
                note = parse_note(path, self.vault_path)
            except (OSError, UnicodeError, ValueError):
                continue
            if not note.reviewed:
                continue
            for reference in as_string_list(note.properties.get("source_refs")):
                source_id = str(reference).split("#", 1)[0].strip()
                if source_id:
                    source_regions.setdefault(source_id, set()).update(region.casefold() for region in note.regions)
        return source_regions

    def _public(
        self,
        record: dict[str, Any],
        *,
        detail: bool = False,
        reviewed_source_ids: set[str] | None = None,
        reviewed_source_regions: dict[str, set[str]] | None = None,
    ) -> dict[str, Any]:
        result = dict(record)
        if not detail:
            result.pop("extracted_text", None)
            result.pop("extracted_sections", None)
        path = result.get("local_path", result.get("path"))
        result.setdefault("filename", Path(str(path)).name if path else "")
        if "category" not in result:
            type_categories = {values["source_type"]: key for key, values in CATEGORY_DEFAULTS.items()}
            result["category"] = type_categories.get(result.get("source_type"), "other")
        if not result.get("review_status"):
            source_id = str(result.get("id") or result.get("source_id") or "")
            result["review_status"] = (
                "active"
                if source_id in (reviewed_source_ids or set())
                and result.get("privacy_class") != "review-required"
                else "pending"
            )
        source_id = str(result.get("id") or result.get("source_id") or "")
        explicit_regions = [region.casefold() for region in as_string_list(result.get("regions"))]
        derived_regions = sorted((reviewed_source_regions or {}).get(source_id, set()))
        result["regions"] = list(dict.fromkeys(explicit_regions if "regions" in record else derived_regions))
        result["managed_import"] = bool(result.get("managed_import"))
        result["managed"] = result["managed_import"]
        if result.get("knowledge_note_path"):
            relative = str(result["knowledge_note_path"]).removesuffix(".md")
            result["obsidian_uri"] = (
                f"obsidian://open?vault={quote(self.vault_path.name, safe='')}"
                f"&file={quote(relative, safe='/')}"
            )
        return result

    def _sync_source_note(self, record: dict[str, Any]) -> None:
        """Create an indexable provenance note without modifying the imported original."""

        if not record.get("managed_import"):
            return
        note_id = str(record.get("knowledge_note_id") or f"source-{str(record['sha256'])[:20]}")
        relative = Path("60 Bronnen") / f"{note_id}.md"
        target = (self.vault_path / relative).resolve()
        if self.vault_path not in target.parents:
            raise SourceManagerError("Ongeldig kennispad voor bron")
        target.parent.mkdir(parents=True, exist_ok=True)
        record["knowledge_note_id"] = note_id
        record["knowledge_note_path"] = relative.as_posix()

        status = str(record.get("review_status", "pending"))
        curation = {"active": "reviewed", "reviewed": "source_checked", "rejected": "archived"}.get(status, "draft")
        vault_trust = str(record.get("trust_label") or VAULT_TRUST_BY_CATEGORY.get(str(record.get("category")), "unverified"))
        title = str(record.get("title") or record.get("filename") or note_id)
        regions = [str(region).casefold() for region in as_string_list(record.get("regions"))]
        lines = [
            "---",
            f"id: {note_id}",
            "type: source",
            f"regions: {json.dumps(regions, ensure_ascii=False)}",
            "systems: []",
            "clinical_use: [bronbeheer]",
            "aliases: []",
            f"curation_status: {curation}",
            f"source_refs: [{json.dumps(str(record['id']), ensure_ascii=False)}]",
            f"trust_tier: {vault_trust}",
            f"last_reviewed: {_now()[:10] if status in {'active', 'reviewed'} else 'null'}",
            "---",
            "",
            f"# {title}",
            "",
            f"[Open het lokale bronbestand](http://127.0.0.1:8765/api/local/physio/media/{record['id']})",
            "",
            "## Bronmetadata",
            "",
            f"- Categorie: {record.get('category', 'other')}",
            f"- Brontype: {record.get('source_type', 'other')}",
            f"- Status: {status}",
            f"- Extractie: {record.get('extraction_status', 'pending')}",
            f"- Bron-ID: `{record['id']}`",
        ]
        contents = "\n".join(lines).rstrip() + "\n"
        with tempfile.NamedTemporaryFile(
            "w", encoding="utf-8", dir=target.parent, prefix=f".{note_id}-", delete=False
        ) as handle:
            temp_path = Path(handle.name)
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.replace(temp_path, target)
        finally:
            temp_path.unlink(missing_ok=True)

    def list_sources(
        self,
        *,
        category: str | None = None,
        review_status: str | None = None,
        query: str = "",
        managed: bool | None = None,
        offset: int = 0,
        limit: int = 100,
    ) -> dict[str, Any]:
        if offset < 0 or not 1 <= limit <= 1000:
            raise SourceManagerError("offset of limit is ongeldig")
        folded_query = query.strip().casefold()
        with self._lock:
            _metadata, records = self._read_document()
            reviewed_source_regions = self._reviewed_source_regions()
            reviewed_source_ids = set(reviewed_source_regions)
            rows = [
                self._public(
                    record,
                    reviewed_source_ids=reviewed_source_ids,
                    reviewed_source_regions=reviewed_source_regions,
                )
                for record in records
            ]
            unique_rows: dict[str, dict[str, Any]] = {}
            for row in rows:
                source_id = str(row.get("id") or row.get("source_id") or row.get("sha256") or row.get("path"))
                unique_rows.setdefault(source_id, row)
            rows = list(unique_rows.values())
        if category:
            rows = [row for row in rows if row.get("category", "other") == category]
        if review_status:
            rows = [row for row in rows if row.get("review_status", "pending") == review_status]
        if managed is not None:
            rows = [row for row in rows if row["managed_import"] is managed]
        if folded_query:
            rows = [
                row for row in rows
                if folded_query in " ".join(str(row.get(key, "")) for key in ("title", "filename", "source_type", "category")).casefold()
            ]
        rows.sort(key=lambda row: str(row.get("imported_at") or row.get("modified_at") or ""), reverse=True)
        return {"sources": rows[offset:offset + limit], "total": len(rows), "offset": offset, "limit": limit}

    def get(self, source_id: str) -> dict[str, Any] | None:
        with self._lock:
            _metadata, records = self._read_document()
            reviewed_source_regions = self._reviewed_source_regions()
            reviewed_source_ids = set(reviewed_source_regions)
            for record in records:
                if str(record.get("id") or record.get("source_id")) == source_id:
                    return self._public(
                        record,
                        detail=True,
                        reviewed_source_ids=reviewed_source_ids,
                        reviewed_source_regions=reviewed_source_regions,
                    )
        return None

    def preview_file(self, source_id: str) -> dict[str, Any] | None:
        """Resolve a review preview exclusively through a manifest ID.

        The normal media route deliberately hides rejected and review-required
        material. The source manager needs to show those files *while* the user
        is deciding their status, so it has a separate loopback-only route.
        HEIC files are converted once to a browser-compatible PNG cache.
        """

        with self._lock:
            _metadata, records = self._read_document()
            record = next(
                (item for item in records if str(item.get("id") or item.get("source_id")) == source_id),
                None,
            )
            if record is None:
                return None
            raw_path = record.get("local_path", record.get("path"))
            path = Path(str(raw_path)).expanduser().resolve() if raw_path else None
            if not path or not path.is_file():
                return None
            title = str(record.get("title") or path.name)
            suffix = path.suffix.casefold()
            if suffix == ".heic":
                preview_root = self.manifest_path.parent / "Previews"
                preview_root.mkdir(parents=True, exist_ok=True)
                cache_key = str(record.get("sha256") or hashlib.sha256(str(path).encode()).hexdigest())
                preview = preview_root / f"{cache_key}.png"
                if not preview.exists() or preview.stat().st_mtime_ns < path.stat().st_mtime_ns:
                    temporary = preview.with_name(f".{preview.name}.{os.getpid()}.tmp.png")
                    try:
                        subprocess.run(
                            ["/usr/bin/sips", "-s", "format", "png", str(path), "--out", str(temporary)],
                            check=True,
                            stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE,
                            timeout=30,
                        )
                        os.replace(temporary, preview)
                        os.chmod(preview, 0o600)
                    except (OSError, subprocess.SubprocessError):
                        temporary.unlink(missing_ok=True)
                        return {"path": path, "mime_type": "image/heic", "title": title}
                return {"path": preview, "mime_type": "image/png", "title": title}
            mime_type = str(record.get("mime_type") or mimetypes.guess_type(path.name)[0] or "application/octet-stream")
            return {"path": path, "mime_type": mime_type, "title": title}

    @staticmethod
    def _auto_regions(record: dict[str, Any]) -> list[str]:
        path = str(record.get("local_path", record.get("path", ""))).replace("\\", "/")
        title = str(record.get("title") or record.get("filename") or Path(path).name)
        haystack = f"{path}\n{title}"
        if AUTO_REVIEW_IGNORE.search(haystack):
            return []
        return [region for region, pattern in AUTO_REGION_RULES if pattern.search(haystack)]

    def auto_triage(self) -> dict[str, Any]:
        """Apply only high-confidence, inspectable source classifications.

        Explicit user edits, rejected records and ambiguous files are left
        untouched. For duplicated DOCX/TXT lecture pairs, the DOCX is preferred.
        """

        with self._lock:
            metadata, records = self._read_document()
            docx_stems = {
                str(Path(str(item.get("local_path", item.get("path", "")))).with_suffix("")).casefold()
                for item in records
                if Path(str(item.get("local_path", item.get("path", "")))).suffix.casefold() == ".docx"
            }
            changed = 0
            region_counts: dict[str, int] = {}
            category_by_type = {values["source_type"]: key for key, values in CATEGORY_DEFAULTS.items()}
            for record in records:
                current_status = str(record.get("review_status") or "pending")
                if current_status in {"active", "reviewed", "rejected"} or record.get("regions"):
                    continue
                path = Path(str(record.get("local_path", record.get("path", ""))))
                regions = self._auto_regions(record)
                if not regions:
                    continue
                if path.suffix.casefold() == ".txt" and str(path.with_suffix("")).casefold() in docx_stems:
                    continue
                record["regions"] = list(dict.fromkeys(regions))
                record["review_status"] = "active"
                record.setdefault("category", category_by_type.get(str(record.get("source_type")), classify_source(path.name)))
                if path.suffix.casefold() in AUTO_EXTRACT_SUFFIXES:
                    record["extraction_status"] = "ready"
                elif path.suffix.casefold() in {".heic", ".jpeg", ".jpg", ".png", ".m4a", ".mov", ".mp3", ".mp4", ".wav"}:
                    record["extraction_status"] = "media-ready"
                note = str(record.get("notes") or "").strip()
                marker = "Automatisch met hoge zekerheid ingedeeld op bestandsnaam en bronmap."
                record["notes"] = f"{note}\n{marker}".strip() if marker not in note else note
                record["modified_at"] = _now()
                changed += 1
                for region in record["regions"]:
                    region_counts[region] = region_counts.get(region, 0) + 1
            if changed:
                self._write_records(records, metadata)
            remaining = sum(
                1 for record in records
                if str(record.get("review_status") or "pending") == "pending"
            )
            return {"changed": changed, "remaining_pending": remaining, "regions": region_counts}

    def import_stream(self, stream: BinaryIO, filename: str, *, category: str | None = None) -> dict[str, Any]:
        safe_name = _safe_filename(filename)
        selected_category = category or classify_source(safe_name)
        if selected_category not in CATEGORY_DEFAULTS:
            raise SourceManagerError("Onbekende broncategorie")
        category_dir = (self.sources_root / selected_category).resolve()
        category_dir.mkdir(parents=True, exist_ok=True)
        if self.sources_root not in category_dir.parents:
            raise SourceManagerError("Ongeldige broncategorie")

        digest = hashlib.sha256()
        size = 0
        with tempfile.NamedTemporaryFile("wb", dir=category_dir, prefix=".upload-", delete=False) as handle:
            temp_path = Path(handle.name)
            try:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > self.max_source_bytes:
                        raise SourceTooLarge("Het bronbestand is groter dan de lokale uploadlimiet")
                    digest.update(chunk)
                    handle.write(chunk)
                handle.flush()
                os.fsync(handle.fileno())
            except Exception:
                handle.close()
                temp_path.unlink(missing_ok=True)
                raise

        sha256 = digest.hexdigest()
        with self._lock:
            metadata, records = self._read_document()
            for existing in records:
                if existing.get("sha256") == sha256:
                    temp_path.unlink(missing_ok=True)
                    return {
                        "source": self._public(existing, reviewed_source_ids=self._reviewed_source_ids()),
                        "deduplicated": True,
                    }

            destination = category_dir / safe_name
            if destination.exists():
                destination = category_dir / f"{destination.stem}-{sha256[:8]}{destination.suffix}"
            os.replace(temp_path, destination)
            try:
                os.chmod(destination, 0o600)
            except OSError:
                pass
            now = _now()
            defaults = CATEGORY_DEFAULTS[selected_category]
            source_id = f"src-{sha256[:20]}"
            record = {
                "id": source_id,
                "source_id": source_id,
                "sha256": sha256,
                "filename": destination.name,
                "title": Path(safe_name).stem,
                "category": selected_category,
                "source_type": defaults["source_type"],
                "date": now[:10],
                "source_date": now[:10],
                "imported_at": now,
                "modified_at": now,
                "size_bytes": size,
                "suffix": destination.suffix.casefold(),
                "mime_type": mimetypes.guess_type(destination.name)[0] or "application/octet-stream",
                "privacy_class": "private-local",
                "copyright_class": defaults["copyright_class"],
                "trust_tier": defaults["trust_tier"],
                "extraction_status": "pending",
                "review_status": "pending",
                "regions": [],
                "duplicate_of": None,
                "managed_import": True,
                "local_path": str(destination),
                "path": str(destination),
                "root": str(self.sources_root),
            }
            if destination.suffix.casefold() in {".md", ".txt", ".csv"}:
                record["extraction_status"] = "text-ready"
            try:
                self._sync_source_note(record)
                records.append(record)
                self._write_records(records, metadata)
            except Exception:
                destination.unlink(missing_ok=True)
                note_relative = record.get("knowledge_note_path")
                if note_relative:
                    note_path = (self.vault_path / str(note_relative)).resolve()
                    if self.vault_path in note_path.parents:
                        note_path.unlink(missing_ok=True)
                raise
            return {
                "source": self._public(record, reviewed_source_ids=self._reviewed_source_ids()),
                "deduplicated": False,
            }

    def update(self, source_id: str, changes: dict[str, Any]) -> dict[str, Any]:
        unknown = set(changes) - EDITABLE_FIELDS
        if unknown:
            raise SourceManagerError(f"Niet-wijzigbare velden: {', '.join(sorted(unknown))}")
        with self._lock:
            metadata, records = self._read_document()
            record = next((item for item in records if str(item.get("id") or item.get("source_id")) == source_id), None)
            if record is None:
                raise SourceNotFound("Bron niet gevonden")
            new_category = str(changes.get("category", record.get("category", "other")))
            if new_category not in CATEGORY_DEFAULTS:
                raise SourceManagerError("Onbekende broncategorie")
            if "review_status" in changes and str(changes["review_status"]) not in set(REVIEW_ACTIONS.values()):
                raise SourceManagerError("Ongeldige reviewstatus")
            if "trust_tier" in changes:
                changes["trust_tier"], label = _trust_tier(changes["trust_tier"])
                if label:
                    record["trust_label"] = label
            if "regions" in changes:
                if not isinstance(changes["regions"], list):
                    raise SourceManagerError("regions moet een lijst zijn")
                changes["regions"] = list(dict.fromkeys(
                    re.sub(r"[^a-z0-9-]+", "-", str(region).casefold()).strip("-")
                    for region in changes["regions"]
                    if str(region).strip()
                ))

            original_record = dict(record)
            old_category = str(record.get("category", "other"))
            move: tuple[Path, Path] | None = None
            if new_category != old_category and record.get("managed_import"):
                current = self._managed_path(record)
                target_dir = (self.sources_root / new_category).resolve()
                target_dir.mkdir(parents=True, exist_ok=True)
                target = target_dir / current.name
                if target.exists() and target != current:
                    target = target_dir / f"{target.stem}-{str(record.get('sha256', 'source'))[:8]}{target.suffix}"
                os.replace(current, target)
                move = (current, target)
                record["local_path"] = record["path"] = str(target)
                record["filename"] = target.name
                defaults = CATEGORY_DEFAULTS[new_category]
                for key in ("source_type", "trust_tier", "copyright_class"):
                    if key not in changes:
                        record[key] = defaults[key]

            for key, value in changes.items():
                if key in {"title", "source_type", "source_date", "date", "privacy_class", "copyright_class", "extraction_status", "review_status", "notes"}:
                    value = str(value).strip()
                record[key] = value
            record["category"] = new_category
            record["modified_at"] = _now()
            self._sync_source_note(record)
            try:
                self._write_records(records, metadata)
            except Exception:
                if move and move[1].exists():
                    os.replace(move[1], move[0])
                try:
                    self._sync_source_note(original_record)
                except OSError:
                    pass
                raise
            return self._public(record, reviewed_source_ids=self._reviewed_source_ids())

    def set_review_status(self, source_id: str, action: str) -> dict[str, Any]:
        status = REVIEW_ACTIONS.get(str(action).casefold())
        if not status:
            raise SourceManagerError("Actie moet pending, review, activate of reject zijn")
        changes = {"review_status": status}
        if status in {"active", "rejected", "pending"}:
            changes["extraction_status"] = {"active": "ready", "rejected": "rejected", "pending": "pending"}[status]
        result = self.update(source_id, changes)
        result["review_action"] = str(action).casefold()
        return result

    @staticmethod
    def _unique_section(title: str, seen: dict[str, int]) -> tuple[str, str]:
        base = re.sub(r"\s+", " ", title).strip() or "Bronpassage"
        count = seen.get(base.casefold(), 0) + 1
        seen[base.casefold()] = count
        display = base if count == 1 else f"{base} — deel {count}"
        return display, slugify(display)

    @classmethod
    def _paragraph_sections(cls, paragraphs: list[tuple[str | None, str]]) -> list[dict[str, Any]]:
        sections: list[dict[str, Any]] = []
        seen: dict[str, int] = {}
        heading = "Bronpassage"
        buffer: list[str] = []
        size = 0

        def flush() -> None:
            nonlocal buffer, size
            body = "\n\n".join(buffer).strip()
            if not body:
                return
            title, anchor = cls._unique_section(heading, seen)
            sections.append({"title": title, "anchor": anchor, "body": body})
            buffer = []
            size = 0

        for kind, text in paragraphs:
            clean = re.sub(r"[ \t]+", " ", str(text)).strip()
            if not clean:
                continue
            if kind == "heading":
                flush()
                heading = clean
                continue
            if buffer and size + len(clean) > SECTION_CHARS:
                flush()
            buffer.append(clean)
            size += len(clean)
        flush()
        return sections

    @classmethod
    def _extract_docx(cls, path: Path) -> list[dict[str, Any]]:
        paragraphs: list[tuple[str | None, str]] = []
        with zipfile.ZipFile(path) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_DOCX_ARCHIVE_ENTRIES:
                raise SourceManagerError("DOCX bevat te veel archiefonderdelen")
            total_uncompressed = sum(max(0, int(entry.file_size or 0)) for entry in entries)
            if total_uncompressed > MAX_DOCX_UNCOMPRESSED_BYTES:
                raise SourceManagerError("DOCX is te groot na uitpakken")
            for entry in entries:
                if entry.flag_bits & 0x1:
                    raise SourceManagerError("Versleutelde DOCX-bestanden worden niet ondersteund")
                if int(entry.file_size or 0) > 0:
                    ratio = int(entry.file_size or 0) / max(1, int(entry.compress_size or 0))
                    if ratio > MAX_ARCHIVE_COMPRESSION_RATIO:
                        raise SourceManagerError("DOCX heeft een onveilige compressieverhouding")
            try:
                document_info = archive.getinfo("word/document.xml")
            except KeyError as exc:
                raise SourceManagerError("DOCX bevat geen documenttekst") from exc
            if int(document_info.file_size or 0) > MAX_DOCX_XML_BYTES:
                raise SourceManagerError("DOCX-documenttekst is te groot")
            root = ElementTree.fromstring(archive.read(document_info))
        namespace = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        for paragraph in root.findall(".//w:body/w:p", namespace):
            text = "".join(node.text or "" for node in paragraph.findall(".//w:t", namespace)).strip()
            if not text:
                continue
            style_node = paragraph.find("./w:pPr/w:pStyle", namespace)
            style = style_node.get(f"{{{namespace['w']}}}val", "") if style_node is not None else ""
            kind = "heading" if style.casefold().startswith(("heading", "kop", "title", "titel")) else None
            paragraphs.append((kind, text))
        return cls._paragraph_sections(paragraphs)

    @classmethod
    def _extract_text_file(cls, path: Path) -> list[dict[str, Any]]:
        text = path.read_text(encoding="utf-8", errors="replace")[:MAX_EXTRACTED_CHARS]
        paragraphs: list[tuple[str | None, str]] = []
        for block in re.split(r"\n\s*\n", text):
            clean = block.strip()
            if not clean:
                continue
            heading_match = re.match(r"^#{1,6}\s+(.+)$", clean)
            paragraphs.append(("heading", heading_match.group(1)) if heading_match else (None, clean))
        return cls._paragraph_sections(paragraphs)

    @classmethod
    def _extract_pdf(cls, path: Path) -> list[dict[str, Any]]:
        sections: list[dict[str, Any]] = []
        reader = PdfReader(str(path))
        if len(reader.pages) > MAX_PDF_PAGES:
            raise SourceManagerError(
                f"PDF bevat meer dan {MAX_PDF_PAGES} pagina's en wordt niet automatisch uitgelezen"
            )
        total = 0
        for number, page in enumerate(reader.pages, 1):
            body = (page.extract_text() or "").strip()
            if not body:
                continue
            remaining = MAX_EXTRACTED_CHARS - total
            if remaining <= 0:
                break
            body = body[:remaining]
            total += len(body)
            sections.append({"title": f"PDF-pagina {number}", "anchor": f"pdf-pagina-{number}", "body": body, "page": number})
        return sections

    @classmethod
    def _extract_sections(cls, record: dict[str, Any]) -> list[dict[str, Any]]:
        raw_path = record.get("local_path", record.get("path"))
        path = Path(str(raw_path)).expanduser().resolve() if raw_path else None
        if not path or not path.is_file():
            raise SourceManagerError("Het lokale bronbestand bestaat niet meer")
        suffix = path.suffix.casefold()
        if suffix not in AUTO_EXTRACT_SUFFIXES:
            raise SourceManagerError(f"Tekstextractie voor {suffix or 'dit bestandstype'} wordt nog niet ondersteund")
        if path.stat().st_size > MAX_AUTO_EXTRACT_BYTES:
            raise SourceManagerError("Bron is te groot voor automatische tekstextractie")
        if suffix == ".docx":
            return cls._extract_docx(path)
        if suffix == ".pdf":
            return cls._extract_pdf(path)
        return cls._extract_text_file(path)

    def _ensure_extracted(self, record: dict[str, Any]) -> bool:
        if record.get("extracted_sections"):
            return False
        try:
            sections = self._extract_sections(record)
            if not sections:
                raise SourceManagerError("Er werd geen doorzoekbare tekst gevonden")
            record["extracted_sections"] = sections
            record["extraction_status"] = "indexed"
            record["extracted_at"] = _now()
            record.pop("extraction_error", None)
        except (OSError, ValueError, zipfile.BadZipFile, SourceManagerError) as exc:
            record["extraction_status"] = "unavailable"
            record["extraction_error"] = str(exc)[:300]
        return True

    @staticmethod
    def _query_tokens(query: str) -> list[str]:
        words = re.findall(r"[^\W_]+", query.casefold(), flags=re.UNICODE)
        meaningful = [word for word in words if len(word) > 2 and word not in QUERY_STOPWORDS]
        return list(dict.fromkeys(meaningful or words))[:16]

    def deep_context(self, query: str, *, region: str = "", max_chars: int = 30_000) -> list[dict[str, Any]]:
        """Return ranked passages from active, locally extracted source files."""

        tokens = self._query_tokens(query)
        if not tokens or max_chars <= 0:
            return []
        with self._lock:
            metadata, records = self._read_document()
            source_regions = self._reviewed_source_regions()
            active_ids = set(source_regions)
            unique_active: dict[str, dict[str, Any]] = {}
            for record in records:
                source_id = str(record.get("id") or record.get("source_id") or "")
                if source_id and (
                    str(record.get("review_status", "")) in {"active", "reviewed"}
                    or source_id in active_ids
                ):
                    unique_active.setdefault(source_id, record)
            active_records = list(unique_active.values())
            changed = False
            seen_ids: set[str] = set()
            for record in active_records:
                source_id = str(record.get("id") or record.get("source_id") or "")
                if not source_id or source_id in seen_ids:
                    continue
                seen_ids.add(source_id)
                suffix = Path(str(record.get("local_path", record.get("path", "")))).suffix.casefold()
                if suffix in AUTO_EXTRACT_SUFFIXES:
                    changed = self._ensure_extracted(record) or changed
            if changed:
                self._write_records(records, metadata)

            ranked: list[tuple[float, dict[str, Any], dict[str, Any], list[str]]] = []
            normalized_region = region.casefold().strip()
            for record in active_records:
                source_id = str(record.get("id") or record.get("source_id") or "")
                regions = (
                    set(region.casefold() for region in as_string_list(record.get("regions")))
                    if "regions" in record
                    else source_regions.get(source_id, set())
                )
                for section in record.get("extracted_sections", []):
                    haystack = f"{section.get('title', '')}\n{section.get('body', '')}".casefold()
                    matched = [token for token in tokens if token in haystack]
                    if not matched:
                        continue
                    score = sum(min(haystack.count(token), 8) for token in matched) * 4.0
                    score += len(matched) / max(1, len(tokens)) * 8.0
                    if normalized_region and normalized_region in regions:
                        score += 6.0
                    ranked.append((score, record, section, sorted(regions)))
            ranked.sort(key=lambda item: (-item[0], str(item[1].get("title") or item[1].get("path") or "").casefold()))

            grouped: dict[str, dict[str, Any]] = {}
            remaining = max_chars
            for _score, record, section, regions in ranked[:18]:
                if remaining <= 0:
                    break
                source_id = str(record.get("id") or record.get("source_id"))
                virtual_id = f"source--{source_id}"
                item = grouped.setdefault(virtual_id, {
                    "note_id": virtual_id,
                    "title": str(record.get("title") or Path(str(record.get("path", source_id))).name),
                    "path": str(record.get("local_path", record.get("path", ""))),
                    "regions": regions,
                    "allowed_anchors": [],
                    "body_parts": [],
                })
                sections = record.get("extracted_sections", [])
                section_index = next((index for index, candidate in enumerate(sections) if candidate is section), 0)
                for nearby in sections[max(0, section_index - 1):section_index + 2]:
                    anchor = str(nearby.get("anchor") or slugify(str(nearby.get("title", "Bronpassage"))))
                    if anchor in item["allowed_anchors"] or remaining <= 0:
                        continue
                    passage = f"## {nearby.get('title', 'Bronpassage')}\n{nearby.get('body', '')}"[:remaining]
                    remaining -= len(passage)
                    item["allowed_anchors"].append(anchor)
                    item["body_parts"].append(passage)
            return [
                {**{key: value for key, value in item.items() if key != "body_parts"}, "body": "\n\n".join(item["body_parts"])}
                for item in grouped.values()
            ]

    def virtual_note(self, note_id: str) -> dict[str, Any] | None:
        prefix = "source--"
        if not note_id.startswith(prefix):
            return None
        source_id = note_id[len(prefix):]
        with self._lock:
            metadata, records = self._read_document()
            record = next((item for item in records if str(item.get("id") or item.get("source_id")) == source_id), None)
            if record is None:
                return None
            if self._ensure_extracted(record):
                self._write_records(records, metadata)
            if not record.get("extracted_sections"):
                return None
            source_regions = self._reviewed_source_regions()
            regions = list(dict.fromkeys(
                [region.casefold() for region in as_string_list(record.get("regions"))]
                if "regions" in record
                else sorted(source_regions.get(source_id, set()))
            ))
            body = "\n\n".join(
                f"## {section.get('title', 'Bronpassage')}\n\n{section.get('body', '')}"
                for section in record["extracted_sections"]
            )
            inline_assets: dict[str, str] = {}
            raw_path = record.get("local_path", record.get("path"))
            source_path = Path(str(raw_path)).expanduser().resolve() if raw_path else None
            if source_path and source_path.suffix.casefold() == ".md":
                records_by_path = {
                    Path(str(item.get("local_path", item.get("path", "")))).expanduser().resolve():
                    str(item.get("id") or item.get("source_id") or "")
                    for item in records
                    if item.get("local_path", item.get("path"))
                }
                for target in re.findall(r"!\[[^\]]*\]\(((?:[^()]|\([^)]*\))+)\)", body):
                    clean_target = target.strip().strip("<>").split(' "', 1)[0]
                    parsed = urlsplit(clean_target)
                    if parsed.scheme or parsed.netloc:
                        continue
                    resolved = (source_path.parent / unquote(parsed.path)).resolve()
                    asset_id = records_by_path.get(resolved)
                    if asset_id:
                        inline_assets[target] = asset_id
            return {
                "note_id": note_id,
                "title": str(record.get("title") or Path(str(record.get("path", source_id))).name),
                "path": str(record.get("local_path", record.get("path", ""))),
                "body": body,
                "properties": {"type": "source", "curation_status": "reviewed", "regions": regions},
                "type": "source",
                "regions": regions,
                "reviewed": True,
                "links": [],
                "backlinks": [],
                "embeds": [{"manifest_id": source_id, "label": "Open oorspronkelijk bronbestand"}],
                "source_uri": f"/api/local/physio/media/{quote(source_id, safe='')}",
                "inline_assets": inline_assets,
            }

    def _managed_path(self, record: dict[str, Any]) -> Path:
        if not record.get("managed_import"):
            raise SourceConflict("Alleen via de bronnenmanager geïmporteerde kopieën kunnen worden verwijderd")
        raw_path = record.get("local_path", record.get("path"))
        if not raw_path:
            raise SourceConflict("De beheerde bron heeft geen lokaal pad")
        path = Path(str(raw_path)).expanduser().resolve()
        if self.sources_root not in path.parents or path == self.sources_root:
            raise SourceConflict("De bron valt buiten de beheerde lokale bronbibliotheek")
        return path

    def delete(self, source_id: str) -> bool:
        with self._lock:
            metadata, records = self._read_document()
            index = next(
                (position for position, item in enumerate(records) if str(item.get("id") or item.get("source_id")) == source_id),
                None,
            )
            if index is None:
                return False
            path = self._managed_path(records[index])
            note_relative = records[index].get("knowledge_note_path")
            records.pop(index)
            self._write_records(records, metadata)
            path.unlink(missing_ok=True)
            if note_relative:
                note_path = (self.vault_path / str(note_relative)).resolve()
                if self.vault_path in note_path.parents:
                    note_path.unlink(missing_ok=True)
            return True
