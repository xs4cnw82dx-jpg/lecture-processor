from types import SimpleNamespace

from flask import jsonify, request

from lecture_processor.repositories import study_repo
from lecture_processor.services import access_service, voice_note_service


class _Doc:
    def __init__(self, doc_id, payload):
        self.id = doc_id
        self._payload = dict(payload)

    def to_dict(self):
        return dict(self._payload)


class _VoiceNoteRepo:
    def __init__(self, docs):
        self.docs = docs
        self.calls = []

    def list_voice_note_packs_by_uid(self, db, uid, limit, after_doc=None):
        self.calls.append((db, uid, limit, after_doc))
        return list(self.docs)


class _FakeQuery:
    def __init__(self):
        self.where_calls = []
        self.order_calls = []
        self.limit_value = None

    def where(self, *args, **kwargs):
        self.where_calls.append((args, kwargs))
        return self

    def order_by(self, field, direction=None):
        self.order_calls.append((field, direction))
        return self

    def limit(self, value):
        self.limit_value = value
        return self

    def stream(self):
        return [_Doc("voice-1", {"uid": "user-1", "mode": "voice-note", "created_at": 1})]


class _FakeDb:
    def __init__(self):
        self.query = _FakeQuery()

    def collection(self, name):
        assert name == "study_packs"
        return self.query


def test_voice_note_listing_returns_hydration_page(app, monkeypatch):
    docs = [
        _Doc(
            "voice-1",
            {
                "uid": "user-1",
                "mode": "voice-note",
                "title": "Morning note",
                "notes_markdown": "Remember the brachial plexus.",
                "tags": ["anatomy"],
                "pinned": True,
                "created_at": 20,
                "updated_at": 21,
            },
        ),
        _Doc("voice-2", {"uid": "user-1", "mode": "voice-note", "title": "Second", "created_at": 10}),
        _Doc("voice-3", {"uid": "user-1", "mode": "voice-note", "title": "Third", "created_at": 5}),
    ]
    repo = _VoiceNoteRepo(docs)
    runtime = SimpleNamespace(db=object(), study_repo=repo, jsonify=jsonify)
    monkeypatch.setattr(
        access_service,
        "require_allowed_user",
        lambda *_args, **_kwargs: ({"uid": "user-1"}, None, None),
    )

    with app.test_request_context("/api/voice-notes?limit=2"):
        response = voice_note_service.list_voice_notes(runtime, request)

    payload = response.get_json()
    assert [item["study_pack_id"] for item in payload["voice_notes"]] == ["voice-1", "voice-2"]
    assert payload["voice_notes"][0]["transcript"] == "Remember the brachial plexus."
    assert payload["has_more"] is True
    assert payload["next_cursor"] == "voice-2"
    assert repo.calls == [(runtime.db, "user-1", 3, None)]


def test_voice_note_repository_filters_by_mode_before_limit():
    db = _FakeDb()

    records = study_repo.list_voice_note_packs_by_uid(db, "user-1", 101)

    assert [doc.id for doc in records] == ["voice-1"]
    assert len(db.query.where_calls) == 2
    assert db.query.order_calls == [("created_at", "DESCENDING")]
    assert db.query.limit_value == 101
