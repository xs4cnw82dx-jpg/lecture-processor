"""Small, dependency-free parser for Obsidian Markdown notes."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable


FRONTMATTER_BOUNDARY = re.compile(r"^---\s*$")
HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*#*\s*$")
WIKI_LINK_RE = re.compile(r"(?<!!)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]")
WIKI_EMBED_RE = re.compile(r"!\[\[([^\]|#]+)(?:#page=(\d+))?(?:\|[^\]]+)?\]\]")
INLINE_LIST_RE = re.compile(r"^\[(.*)\]$")


def _unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _parse_scalar(value: str) -> Any:
    value = value.strip()
    inline = INLINE_LIST_RE.match(value)
    if inline:
        if not inline.group(1).strip():
            return []
        return [_unquote(part) for part in inline.group(1).split(",") if part.strip()]
    lowered = value.lower()
    if lowered in {"true", "yes"}:
        return True
    if lowered in {"false", "no"}:
        return False
    if lowered in {"null", "~"}:
        return None
    return _unquote(value)


def parse_frontmatter(text: str) -> tuple[dict[str, Any], str]:
    """Parse the atomic YAML subset emitted by the Physio templates.

    Obsidian properties in this project use scalars, inline lists, or indented
    dash lists. Avoiding a general YAML loader also prevents object construction
    from untrusted notes.
    """

    lines = text.lstrip("\ufeff").splitlines()
    if not lines or not FRONTMATTER_BOUNDARY.match(lines[0]):
        return {}, text
    end = next(
        (i for i, line in enumerate(lines[1:], 1) if FRONTMATTER_BOUNDARY.match(line)),
        None,
    )
    if end is None:
        return {}, text
    properties: dict[str, Any] = {}
    current_list: str | None = None
    for raw in lines[1:end]:
        if raw.startswith(("  - ", "- ")) and current_list:
            item = raw.split("-", 1)[1].strip()
            properties[current_list].append(_unquote(item))
            continue
        if ":" not in raw or raw.startswith((" ", "\t")):
            continue
        key, value = raw.split(":", 1)
        key = key.strip()
        if not key:
            continue
        if not value.strip():
            properties[key] = []
            current_list = key
        else:
            properties[key] = _parse_scalar(value)
            current_list = None
    body = "\n".join(lines[end + 1 :]).lstrip("\n")
    return properties, body


def as_string_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    value = str(value).strip()
    return [value] if value else []


def slugify(value: str) -> str:
    value = re.sub(r"[*_`~]", "", value).strip().casefold()
    value = re.sub(r"[^\w\s-]", "", value, flags=re.UNICODE)
    value = re.sub(r"[-\s]+", "-", value).strip("-")
    return value or "sectie"


@dataclass(slots=True)
class Heading:
    anchor: str
    title: str
    level: int
    body: str
    position: int


@dataclass(slots=True)
class ParsedNote:
    note_id: str
    relative_path: str
    title: str
    body: str
    properties: dict[str, Any]
    headings: list[Heading]
    links: list[str]
    embeds: list[dict[str, Any]]
    content_hash: str
    reviewed: bool
    source_rank: int
    aliases: list[str] = field(default_factory=list)
    regions: list[str] = field(default_factory=list)


REVIEWED_STATUSES = {"reviewed", "gereviewd", "goedgekeurd", "approved"}
SOURCE_RANKS = {
    "current_guideline": 5,
    "richtlijn": 5,
    "guideline": 5,
    "textbook": 4,
    "evidence_publication": 4,
    "publication": 4,
    "semester_summary": 3,
    "semester-samenvatting": 3,
    "personal_note": 2,
    "craft_note": 2,
    "ai_combined_lecture": 1,
    "lecture": 1,
}


def _source_rank(properties: dict[str, Any]) -> int:
    raw = properties.get("trust_tier", properties.get("source_type", ""))
    if isinstance(raw, (int, float)):
        return max(0, min(5, int(raw)))
    key = str(raw).strip().casefold().replace(" ", "_")
    return SOURCE_RANKS.get(key, 0)


def _headings(body: str, fallback_title: str) -> list[Heading]:
    lines = body.splitlines()
    markers: list[tuple[int, int, str]] = []
    for index, line in enumerate(lines):
        match = HEADING_RE.match(line)
        if match:
            markers.append((index, len(match.group(1)), match.group(2).strip()))
    if not markers:
        return [Heading(anchor="", title=fallback_title, level=1, body=body.strip(), position=0)]
    headings: list[Heading] = []
    used: dict[str, int] = {}
    prefix = "\n".join(lines[: markers[0][0]]).strip()
    if prefix:
        headings.append(Heading(anchor="", title=fallback_title, level=1, body=prefix, position=0))
    for marker_index, (line_index, level, title) in enumerate(markers):
        next_index = markers[marker_index + 1][0] if marker_index + 1 < len(markers) else len(lines)
        anchor_base = slugify(title)
        duplicate = used.get(anchor_base, 0)
        used[anchor_base] = duplicate + 1
        anchor = anchor_base if duplicate == 0 else f"{anchor_base}-{duplicate}"
        headings.append(
            Heading(
                anchor=anchor,
                title=title,
                level=level,
                body="\n".join(lines[line_index + 1 : next_index]).strip(),
                position=len(headings),
            )
        )
    return headings


def parse_note(path: Path, vault_path: Path) -> ParsedNote:
    raw = path.read_text(encoding="utf-8")
    properties, body = parse_frontmatter(raw)
    relative_path = path.resolve().relative_to(vault_path.resolve()).as_posix()
    title = str(properties.get("title") or path.stem).strip()
    note_id = str(properties.get("id") or relative_path.removesuffix(".md")).strip()
    status = str(properties.get("curation_status", "draft")).strip().casefold()
    links = list(dict.fromkeys(match.strip() for match in WIKI_LINK_RE.findall(body)))
    embeds = [
        {"target": target.strip(), "page": int(page) if page else None}
        for target, page in WIKI_EMBED_RE.findall(body)
    ]
    return ParsedNote(
        note_id=note_id,
        relative_path=relative_path,
        title=title,
        body=body,
        properties=properties,
        headings=_headings(body, title),
        links=links,
        embeds=embeds,
        content_hash=hashlib.sha256(raw.encode("utf-8")).hexdigest(),
        reviewed=status in REVIEWED_STATUSES,
        source_rank=_source_rank(properties),
        aliases=as_string_list(properties.get("aliases")),
        regions=as_string_list(properties.get("regions")),
    )


def iter_markdown_files(vault_path: Path) -> Iterable[Path]:
    for path in sorted(vault_path.rglob("*.md")):
        relative_parts = path.relative_to(vault_path).parts
        if any(part.startswith(".") for part in relative_parts):
            continue
        if path.is_file() and not path.is_symlink():
            yield path
