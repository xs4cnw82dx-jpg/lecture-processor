"""Local-only case and session storage."""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class CaseStore:
    CASE_FIELDS = {"title", "mode", "region", "presenting_complaint", "notes", "pinned_note_ids"}
    SESSION_FIELDS = {"kind", "content"}

    def __init__(self, database_path: Path):
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
                CREATE TABLE IF NOT EXISTS cases (
                    case_id TEXT PRIMARY KEY,
                    data_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    session_id TEXT PRIMARY KEY,
                    case_id TEXT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
                    data_json TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_sessions_case ON sessions(case_id, created_at);
                """
            )

    @staticmethod
    def _case_from_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "case_id": row["case_id"],
            **json.loads(row["data_json"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _session_from_row(row: sqlite3.Row) -> dict[str, Any]:
        return {
            "session_id": row["session_id"],
            "case_id": row["case_id"],
            **json.loads(row["data_json"]),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _normalize_case(payload: dict[str, Any], *, partial: bool = False) -> dict[str, Any]:
        unknown = set(payload) - CaseStore.CASE_FIELDS
        if unknown:
            raise ValueError(f"Unknown case fields: {', '.join(sorted(unknown))}")
        normalized = dict(payload)
        if not partial:
            normalized.setdefault("title", "Naamloze casus")
            normalized.setdefault("mode", "clinical")
            normalized.setdefault("region", "")
            normalized.setdefault("presenting_complaint", "")
            normalized.setdefault("notes", "")
            normalized.setdefault("pinned_note_ids", [])
        if "mode" in normalized and normalized["mode"] != "clinical":
            raise ValueError("mode must be 'clinical'")
        if "pinned_note_ids" in normalized:
            if not isinstance(normalized["pinned_note_ids"], list):
                raise ValueError("pinned_note_ids must be a list")
            normalized["pinned_note_ids"] = [str(item) for item in normalized["pinned_note_ids"][:100]]
        for field in ("title", "region", "presenting_complaint", "notes"):
            if field in normalized:
                if not isinstance(normalized[field], str):
                    raise ValueError(f"{field} must be a string")
                normalized[field] = normalized[field][:20_000]
        return normalized

    def list_cases(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as connection:
            rows = connection.execute("SELECT * FROM cases ORDER BY updated_at DESC").fetchall()
        return [self._case_from_row(row) for row in rows]

    def create_case(self, payload: dict[str, Any]) -> dict[str, Any]:
        data = self._normalize_case(payload)
        now = _utc_now()
        case_id = uuid.uuid4().hex
        with self._lock, self._connect() as connection:
            connection.execute(
                "INSERT INTO cases VALUES (?, ?, ?, ?)",
                (case_id, json.dumps(data, ensure_ascii=False), now, now),
            )
        return {"case_id": case_id, **data, "created_at": now, "updated_at": now}

    def get_case(self, case_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT * FROM cases WHERE case_id = ?", (case_id,)).fetchone()
        return self._case_from_row(row) if row else None

    def update_case(self, case_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        patch = self._normalize_case(payload, partial=True)
        with self._lock, self._connect() as connection:
            row = connection.execute("SELECT * FROM cases WHERE case_id = ?", (case_id,)).fetchone()
            if not row:
                return None
            data = json.loads(row["data_json"])
            data.update(patch)
            now = _utc_now()
            connection.execute(
                "UPDATE cases SET data_json = ?, updated_at = ? WHERE case_id = ?",
                (json.dumps(data, ensure_ascii=False), now, case_id),
            )
        return {"case_id": case_id, **data, "created_at": row["created_at"], "updated_at": now}

    def delete_case(self, case_id: str) -> bool:
        with self._lock, self._connect() as connection:
            cursor = connection.execute("DELETE FROM cases WHERE case_id = ?", (case_id,))
            return cursor.rowcount > 0

    @staticmethod
    def _normalize_session(payload: dict[str, Any], *, partial: bool = False) -> dict[str, Any]:
        unknown = set(payload) - CaseStore.SESSION_FIELDS
        if unknown:
            raise ValueError(f"Unknown session fields: {', '.join(sorted(unknown))}")
        normalized = dict(payload)
        if not partial:
            normalized.setdefault("kind", "clinical_reasoning")
            normalized.setdefault("content", {})
        if "kind" in normalized and normalized["kind"] not in {"soap", "rps", "clinical_reasoning", "consult"}:
            raise ValueError("Unsupported session kind")
        if "content" in normalized and not isinstance(normalized["content"], (dict, str)):
            raise ValueError("content must be an object or string")
        encoded = json.dumps(normalized, ensure_ascii=False)
        if len(encoded) > 100_000:
            raise ValueError("Session content is too large")
        return normalized

    def list_sessions(self, case_id: str) -> list[dict[str, Any]] | None:
        if self.get_case(case_id) is None:
            return None
        with self._lock, self._connect() as connection:
            rows = connection.execute(
                "SELECT * FROM sessions WHERE case_id = ? ORDER BY created_at", (case_id,)
            ).fetchall()
        return [self._session_from_row(row) for row in rows]

    def create_session(self, case_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        if self.get_case(case_id) is None:
            return None
        data = self._normalize_session(payload)
        now = _utc_now()
        session_id = uuid.uuid4().hex
        with self._lock, self._connect() as connection:
            connection.execute(
                "INSERT INTO sessions VALUES (?, ?, ?, ?, ?)",
                (session_id, case_id, json.dumps(data, ensure_ascii=False), now, now),
            )
            connection.execute("UPDATE cases SET updated_at = ? WHERE case_id = ?", (now, case_id))
        return {
            "session_id": session_id,
            "case_id": case_id,
            **data,
            "created_at": now,
            "updated_at": now,
        }

    def update_session(self, case_id: str, session_id: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        patch = self._normalize_session(payload, partial=True)
        with self._lock, self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM sessions WHERE session_id = ? AND case_id = ?", (session_id, case_id)
            ).fetchone()
            if not row:
                return None
            data = json.loads(row["data_json"])
            data.update(patch)
            now = _utc_now()
            connection.execute(
                "UPDATE sessions SET data_json = ?, updated_at = ? WHERE session_id = ?",
                (json.dumps(data, ensure_ascii=False), now, session_id),
            )
            connection.execute("UPDATE cases SET updated_at = ? WHERE case_id = ?", (now, case_id))
        return {
            "session_id": session_id,
            "case_id": case_id,
            **data,
            "created_at": row["created_at"],
            "updated_at": now,
        }

    def delete_session(self, case_id: str, session_id: str) -> bool:
        with self._lock, self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM sessions WHERE session_id = ? AND case_id = ?", (session_id, case_id)
            )
            return cursor.rowcount > 0

    def export_case(self, case_id: str) -> dict[str, Any] | None:
        case = self.get_case(case_id)
        if case is None:
            return None
        return {"schema_version": 1, "exported_at": _utc_now(), "case": case, "sessions": self.list_sessions(case_id)}
