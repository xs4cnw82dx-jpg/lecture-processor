from lecture_processor.repositories import planner_repo


class _FakeDoc:
    id = "user-1__session-1"

    def to_dict(self):
        return {
            "id": "session-1",
            "uid": "user-1",
            "date": "2099-01-01",
            "time": "09:00",
        }


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
        return [_FakeDoc()]


class _FakeDb:
    def __init__(self):
        self.query = _FakeQuery()

    def collection(self, name):
        assert name == "planner_sessions"
        return self.query


def test_future_planner_query_filters_orders_and_limits_in_firestore():
    db = _FakeDb()

    records = planner_repo.list_planner_sessions_by_uid(
        db,
        "user-1",
        4,
        start_date="2026-07-19",
    )

    assert [item["id"] for item in records] == ["session-1"]
    assert len(db.query.where_calls) == 2
    assert db.query.order_calls == [("date", "ASCENDING"), ("time", "ASCENDING")]
    assert db.query.limit_value == 4


def test_future_memory_query_filters_and_sorts_before_limit():
    planner_repo.clear_memory_state()
    try:
        planner_repo.set_planner_session(
            None,
            "user-1",
            "past",
            {"id": "past", "uid": "user-1", "date": "2000-01-01", "time": "09:00"},
            merge=False,
        )
        planner_repo.set_planner_session(
            None,
            "user-1",
            "later",
            {"id": "later", "uid": "user-1", "date": "2099-01-02", "time": "09:00"},
            merge=False,
        )
        planner_repo.set_planner_session(
            None,
            "user-1",
            "earlier",
            {"id": "earlier", "uid": "user-1", "date": "2099-01-01", "time": "09:00"},
            merge=False,
        )

        records = planner_repo.list_planner_sessions_by_uid(
            None,
            "user-1",
            1,
            start_date="2026-07-19",
        )

        assert [item["id"] for item in records] == ["earlier"]
    finally:
        planner_repo.clear_memory_state()
