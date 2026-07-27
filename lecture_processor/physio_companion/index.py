"""Incremental SQLite FTS5 index for an Obsidian Physio vault."""

from __future__ import annotations

import json
import re
import sqlite3
import threading
from dataclasses import asdict
from pathlib import Path
from typing import Any

from .markdown import ParsedNote, WIKI_EMBED_RE, as_string_list, iter_markdown_files, parse_note


SEARCH_TOKEN_RE = re.compile(r"[^\W_]+(?:[-'][^\W_]+)*", re.UNICODE)


class KnowledgeIndex:
    """Owns the derived index; Markdown remains the canonical source."""

    def __init__(self, vault_path: Path, database_path: Path):
        self.vault_path = Path(vault_path).resolve()
        self.database_path = Path(database_path).resolve()
        self.database_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._initialize()

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA journal_mode=WAL")
        return connection

    def _initialize(self) -> None:
        with self._connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS notes (
                    note_id TEXT PRIMARY KEY,
                    relative_path TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    body TEXT NOT NULL,
                    properties_json TEXT NOT NULL,
                    aliases_json TEXT NOT NULL,
                    regions_json TEXT NOT NULL,
                    note_type TEXT NOT NULL,
                    clinical_use_json TEXT NOT NULL,
                    reviewed INTEGER NOT NULL CHECK(reviewed IN (0, 1)),
                    source_rank INTEGER NOT NULL,
                    content_hash TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS headings (
                    heading_id TEXT PRIMARY KEY,
                    note_id TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
                    anchor TEXT NOT NULL,
                    title TEXT NOT NULL,
                    level INTEGER NOT NULL,
                    body TEXT NOT NULL,
                    position INTEGER NOT NULL
                );
                CREATE TABLE IF NOT EXISTS links (
                    source_id TEXT NOT NULL REFERENCES notes(note_id) ON DELETE CASCADE,
                    target_text TEXT NOT NULL,
                    UNIQUE(source_id, target_text)
                );
                CREATE INDEX IF NOT EXISTS idx_notes_reviewed ON notes(reviewed);
                CREATE INDEX IF NOT EXISTS idx_headings_note ON headings(note_id, position);
                CREATE INDEX IF NOT EXISTS idx_links_target ON links(target_text);
                CREATE VIRTUAL TABLE IF NOT EXISTS headings_fts USING fts5(
                    heading_id UNINDEXED,
                    note_id UNINDEXED,
                    note_title,
                    heading_title,
                    body,
                    aliases,
                    regions,
                    clinical_use,
                    tokenize='unicode61 remove_diacritics 2'
                );
                """
            )

    @staticmethod
    def _heading_id(note: ParsedNote, anchor: str, position: int) -> str:
        return f"{note.note_id}#{anchor or f'_root-{position}'}"

    def _delete_note(self, connection: sqlite3.Connection, note_id: str) -> None:
        connection.execute("DELETE FROM headings_fts WHERE note_id = ?", (note_id,))
        connection.execute("DELETE FROM notes WHERE note_id = ?", (note_id,))

    def _store_note(self, connection: sqlite3.Connection, note: ParsedNote) -> None:
        existing = connection.execute(
            "SELECT note_id FROM notes WHERE relative_path = ? OR note_id = ?",
            (note.relative_path, note.note_id),
        ).fetchall()
        for row in existing:
            self._delete_note(connection, row["note_id"])
        note_type = str(note.properties.get("type", "note")).strip() or "note"
        clinical_use = as_string_list(note.properties.get("clinical_use"))
        connection.execute(
            """INSERT INTO notes(
                note_id, relative_path, title, body, properties_json, aliases_json,
                regions_json, note_type, clinical_use_json, reviewed, source_rank,
                content_hash
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                note.note_id,
                note.relative_path,
                note.title,
                note.body,
                json.dumps(note.properties, ensure_ascii=False),
                json.dumps(note.aliases, ensure_ascii=False),
                json.dumps(note.regions, ensure_ascii=False),
                note_type,
                json.dumps(clinical_use, ensure_ascii=False),
                int(note.reviewed),
                note.source_rank,
                note.content_hash,
            ),
        )
        for heading in note.headings:
            heading_id = self._heading_id(note, heading.anchor, heading.position)
            connection.execute(
                "INSERT INTO headings VALUES (?, ?, ?, ?, ?, ?, ?)",
                (
                    heading_id,
                    note.note_id,
                    heading.anchor,
                    heading.title,
                    heading.level,
                    heading.body,
                    heading.position,
                ),
            )
            connection.execute(
                "INSERT INTO headings_fts VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (
                    heading_id,
                    note.note_id,
                    note.title,
                    heading.title,
                    heading.body,
                    " ".join(note.aliases),
                    " ".join(note.regions),
                    " ".join(clinical_use),
                ),
            )
        connection.executemany(
            "INSERT OR IGNORE INTO links(source_id, target_text) VALUES (?, ?)",
            [(note.note_id, target) for target in note.links],
        )

    def refresh(self) -> dict[str, int]:
        """Hash and update changed notes, then remove notes absent from disk."""

        parsed: list[ParsedNote] = []
        errors = 0
        for path in iter_markdown_files(self.vault_path):
            try:
                parsed.append(parse_note(path, self.vault_path))
            except (OSError, UnicodeError, ValueError):
                errors += 1
        seen_paths = {note.relative_path for note in parsed}
        added = updated = unchanged = deleted = 0
        with self._lock, self._connect() as connection:
            known = {
                row["relative_path"]: row
                for row in connection.execute(
                    "SELECT note_id, relative_path, content_hash FROM notes"
                )
            }
            for note in parsed:
                old = known.get(note.relative_path)
                if old and old["content_hash"] == note.content_hash and old["note_id"] == note.note_id:
                    unchanged += 1
                    continue
                self._store_note(connection, note)
                if old:
                    updated += 1
                else:
                    added += 1
            for relative_path, row in known.items():
                if relative_path not in seen_paths:
                    self._delete_note(connection, row["note_id"])
                    deleted += 1
        return {
            "added": added,
            "updated": updated,
            "unchanged": unchanged,
            "deleted": deleted,
            "errors": errors,
            "total": len(parsed),
        }

    @staticmethod
    def _match_expression(query: str) -> str:
        tokens = SEARCH_TOKEN_RE.findall(query.casefold())[:12]
        if not tokens:
            return ""
        return " AND ".join(f'"{token.replace(chr(34), "")}"*' for token in tokens)

    @staticmethod
    def _decode_note(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "note_id": row["note_id"],
            "title": row["title"],
            "path": row["relative_path"],
            "body": row["body"],
            "properties": json.loads(row["properties_json"]),
            "aliases": json.loads(row["aliases_json"]),
            "regions": json.loads(row["regions_json"]),
            "type": row["note_type"],
            "clinical_use": json.loads(row["clinical_use_json"]),
            "reviewed": bool(row["reviewed"]),
            "source_rank": row["source_rank"],
        }

    def search(
        self,
        query: str,
        *,
        region: str | None = None,
        note_type: str | None = None,
        include_unreviewed: bool = False,
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        expression = self._match_expression(query)
        if not expression:
            return []
        limit = max(1, min(int(limit), 100))
        clauses = ["headings_fts MATCH ?"]
        parameters: list[Any] = [expression]
        if not include_unreviewed:
            clauses.append("n.reviewed = 1")
        if note_type:
            clauses.append("n.note_type = ?")
            parameters.append(note_type)
        if region:
            clauses.append("EXISTS (SELECT 1 FROM json_each(n.regions_json) WHERE lower(value) = lower(?))")
            parameters.append(region)
        parameters.append(limit * 4)
        sql = f"""
            SELECT n.*, h.heading_id, h.anchor, h.title AS heading_title,
                   h.body AS heading_body,
                   bm25(headings_fts, 0, 0, 8.0, 5.0, 1.0, 7.0, 4.0, 2.0) AS fts_rank
              FROM headings_fts
              JOIN headings h ON h.heading_id = headings_fts.heading_id
              JOIN notes n ON n.note_id = headings_fts.note_id
             WHERE {' AND '.join(clauses)}
             ORDER BY fts_rank ASC, n.source_rank DESC
             LIMIT ?
        """
        with self._lock, self._connect() as connection:
            rows = connection.execute(sql, parameters).fetchall()
        normalized = query.strip().casefold()
        results: list[dict[str, Any]] = []
        seen: set[str] = set()
        for row in rows:
            key = row["heading_id"]
            if key in seen:
                continue
            seen.add(key)
            aliases = json.loads(row["aliases_json"])
            exact = normalized == row["title"].casefold()
            alias_exact = any(normalized == alias.casefold() for alias in aliases)
            score = -float(row["fts_rank"]) + row["source_rank"] * 0.15
            score += 10.0 if exact else 8.0 if alias_exact else 0.0
            body = row["heading_body"].strip()
            results.append(
                {
                    "note_id": row["note_id"],
                    "title": row["title"],
                    "path": row["relative_path"],
                    "anchor": row["anchor"],
                    "heading": row["heading_title"],
                    "snippet": body[:360] + ("…" if len(body) > 360 else ""),
                    "type": row["note_type"],
                    "regions": json.loads(row["regions_json"]),
                    "aliases": aliases,
                    "reviewed": bool(row["reviewed"]),
                    "source_rank": row["source_rank"],
                    "score": round(score, 5),
                }
            )
        results.sort(key=lambda item: (-item["score"], item["title"].casefold()))
        return results[:limit]

    def _resolve_target(self, connection: sqlite3.Connection, target: str) -> str | None:
        target_folded = target.strip().casefold()
        rows = connection.execute(
            "SELECT note_id, title, relative_path, aliases_json FROM notes"
        ).fetchall()
        for row in rows:
            candidates = {
                row["note_id"].casefold(),
                row["title"].casefold(),
                Path(row["relative_path"]).stem.casefold(),
                *(alias.casefold() for alias in json.loads(row["aliases_json"])),
            }
            if target_folded in candidates:
                return row["note_id"]
        return None

    def get_note(self, note_id: str, *, include_unreviewed: bool = False) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT * FROM notes WHERE note_id = ?", (note_id,)).fetchone()
            if not row or (not include_unreviewed and not row["reviewed"]):
                return None
            note = self._decode_note(row)
            note["headings"] = [
                dict(item)
                for item in connection.execute(
                    "SELECT anchor, title, level, body, position FROM headings WHERE note_id = ? ORDER BY position",
                    (note_id,),
                )
            ]
            raw_links = [
                item["target_text"]
                for item in connection.execute(
                    "SELECT target_text FROM links WHERE source_id = ? ORDER BY target_text",
                    (note_id,),
                )
            ]
            note["links"] = [
                {"text": target, "note_id": self._resolve_target(connection, target)}
                for target in raw_links
            ]
            backlinks: list[dict[str, str]] = []
            for link in connection.execute(
                "SELECT source_id, target_text FROM links WHERE source_id != ?", (note_id,)
            ):
                if self._resolve_target(connection, link["target_text"]) == note_id:
                    source = connection.execute(
                        "SELECT title, reviewed FROM notes WHERE note_id = ?", (link["source_id"],)
                    ).fetchone()
                    if source and (include_unreviewed or source["reviewed"]):
                        backlinks.append({"note_id": link["source_id"], "title": source["title"]})
            note["backlinks"] = backlinks
            note["embeds"] = [
                {"target": target.strip(), "page": int(page) if page else None}
                for target, page in WIKI_EMBED_RE.findall(note["body"])
            ]
            return note

    def list_regions(self, *, include_unreviewed: bool = False) -> list[dict[str, Any]]:
        where = "" if include_unreviewed else "WHERE reviewed = 1"
        counts: dict[str, int] = {}
        display_names: dict[str, str] = {}
        with self._lock, self._connect() as connection:
            for row in connection.execute(f"SELECT regions_json FROM notes {where}"):
                for region in json.loads(row["regions_json"]):
                    folded = str(region).casefold()
                    counts[folded] = counts.get(folded, 0) + 1
                    display_names.setdefault(folded, str(region))
            portal_where = "note_type = 'region'" + ("" if include_unreviewed else " AND reviewed = 1")
            portals = connection.execute(
                f"SELECT title, regions_json FROM notes WHERE {portal_where} ORDER BY title COLLATE NOCASE"
            ).fetchall()
        if portals:
            result = []
            seen: set[str] = set()
            for portal in portals:
                regions = json.loads(portal["regions_json"])
                if not regions:
                    continue
                region = str(regions[0])
                folded = region.casefold()
                if folded in seen:
                    continue
                seen.add(folded)
                result.append(
                    {
                        "name": str(portal["title"]),
                        "slug": re.sub(r"[^a-z0-9]+", "-", folded).strip("-"),
                        "count": counts.get(folded, 0),
                    }
                )
            return result
        return [
            {"name": display_names[folded], "slug": re.sub(r"[^a-z0-9]+", "-", folded).strip("-"), "count": count}
            for folded, count in sorted(counts.items())
        ]

    def graph(
        self,
        *,
        note_id: str | None = None,
        global_graph: bool = False,
        include_unreviewed: bool = False,
    ) -> dict[str, list[dict[str, Any]]]:
        with self._lock, self._connect() as connection:
            notes = connection.execute(
                "SELECT note_id, title, note_type, reviewed, regions_json FROM notes"
                + ("" if include_unreviewed else " WHERE reviewed = 1")
            ).fetchall()
            allowed = {row["note_id"] for row in notes}
            all_edges: list[dict[str, str]] = []
            for link in connection.execute("SELECT source_id, target_text FROM links"):
                if link["source_id"] not in allowed:
                    continue
                target_id = self._resolve_target(connection, link["target_text"])
                if target_id in allowed:
                    all_edges.append({"source": link["source_id"], "target": target_id})
            if not global_graph:
                if not note_id or note_id not in allowed:
                    return {"nodes": [], "edges": []}
                neighbor_ids = {note_id}
                selected_edges = []
                for edge in all_edges:
                    if note_id in (edge["source"], edge["target"]):
                        selected_edges.append(edge)
                        neighbor_ids.update((edge["source"], edge["target"]))
            else:
                neighbor_ids = allowed
                selected_edges = all_edges
            nodes = [
                {
                    "id": row["note_id"],
                    "title": row["title"],
                    "type": row["note_type"],
                    "regions": json.loads(row["regions_json"]),
                    "reviewed": bool(row["reviewed"]),
                }
                for row in notes
                if row["note_id"] in neighbor_ids
            ]
            return {"nodes": nodes, "edges": selected_edges}

    def reviewed_context(self, note_ids: list[str], *, max_chars: int) -> list[dict[str, Any]]:
        context: list[dict[str, Any]] = []
        remaining = max_chars
        with self._lock, self._connect() as connection:
            for note_id in list(dict.fromkeys(note_ids))[:30]:
                row = connection.execute(
                    "SELECT note_id, title, relative_path, body FROM notes WHERE note_id = ? AND reviewed = 1",
                    (note_id,),
                ).fetchone()
                if not row or remaining <= 0:
                    continue
                body = row["body"][:remaining]
                remaining -= len(body)
                anchors = [
                    heading["anchor"]
                    for heading in connection.execute(
                        "SELECT anchor FROM headings WHERE note_id = ? ORDER BY position", (note_id,)
                    )
                ]
                context.append(
                    {
                        "note_id": row["note_id"],
                        "title": row["title"],
                        "path": row["relative_path"],
                        "allowed_anchors": anchors,
                        "body": body,
                    }
                )
        return context

    def stats(self) -> dict[str, int]:
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS notes, COALESCE(SUM(reviewed), 0) AS reviewed FROM notes"
            ).fetchone()
            headings = connection.execute("SELECT COUNT(*) FROM headings").fetchone()[0]
        return {"notes": row["notes"], "reviewed_notes": row["reviewed"], "headings": headings}
