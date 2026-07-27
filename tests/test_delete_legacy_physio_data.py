from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


SCRIPT = Path(__file__).parents[1] / "scripts/delete_legacy_physio_data.py"
SPEC = importlib.util.spec_from_file_location("delete_legacy_physio_data", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class Doc:
    def __init__(self, collection, key, payload):
        self.reference = (collection, key)
        self._payload = payload

    def to_dict(self):
        return dict(self._payload)


class Query:
    def __init__(self, docs):
        self.docs = docs

    def where(self, _field, _operator, uid):
        return Query([doc for doc in self.docs if doc.to_dict().get("uid") == uid])

    def stream(self):
        return iter(self.docs)


class Batch:
    def __init__(self, db):
        self.db = db
        self.refs = []

    def delete(self, ref):
        self.refs.append(ref)

    def commit(self):
        for collection, key in self.refs:
            self.db.rows[collection].pop(key)


class DB:
    def __init__(self):
        self.rows = {
            "physio_cases": {"mine": {"uid": "me"}, "other": {"uid": "other"}},
            "physio_case_sessions": {"mine-session": {"uid": "me"}},
        }

    def collection(self, name):
        return Query([Doc(name, key, value) for key, value in self.rows[name].items()])

    def batch(self):
        return Batch(self)


def test_dry_run_is_scoped_and_does_not_write():
    db = DB()
    result = MODULE.delete_for_uid(db, "me", execute=False)
    assert result["documents"] == {"physio_cases": 1, "physio_case_sessions": 1}
    assert "mine" in db.rows["physio_cases"]
    assert "other" in db.rows["physio_cases"]


def test_execute_deletes_only_exact_uid_and_verifies():
    db = DB()
    result = MODULE.delete_for_uid(db, "me", execute=True)
    assert result["mode"] == "execute"
    assert db.rows["physio_cases"] == {"other": {"uid": "other"}}
    assert db.rows["physio_case_sessions"] == {}
