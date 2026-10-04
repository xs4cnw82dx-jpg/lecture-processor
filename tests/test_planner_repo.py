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


def test_upcoming_query_continues_past_full_excluded_pages_and_includes_legacy():
    from types import SimpleNamespace

    rows = [dict(id=f'session-{index:03}', uid='user-1', date='2099-01-01', time='09:00',
                 status='planned', pack_id='outside') for index in range(100)]
    rows += [dict(id='legacy', uid='user-1', date='2099-01-02', time='09:00', pack_id='inside'),
             dict(id='planned', uid='user-1', date='2099-01-03', time='09:00', status='planned', pack_id='inside')]
    docs = [SimpleNamespace(id='user-1__' + row['id'], to_dict=lambda row=row: dict(row)) for row in rows]
    pages = []
    query_calls = []

    class Query:
        def __init__(self, after=None, limit=0):
            self.after, self.page_limit = after, limit

        def where(self, *args, **kwargs):
            query_calls.append(('where', args, kwargs))
            return self

        def order_by(self, field, direction=None):
            query_calls.append(('order', field, direction))
            return self

        def start_after(self, cursor):
            return Query(cursor)

        def limit(self, value):
            return Query(self.after, value)

        def stream(self):
            start = docs.index(self.after) + 1 if self.after is not None else 0
            pages.append((start, self.page_limit))
            return docs[start:start + self.page_limit]

    db = SimpleNamespace(collection=lambda name: Query())
    result = planner_repo.list_planner_sessions_by_uid(db, 'user-1', 2, start_date='2026-09-30', planned_only=True, pack_ids={'inside'})
    assert [row['id'] for row in result] == ['legacy', 'planned']
    assert pages == [(0, 50), (50, 50), (100, 50)]
    assert [item for item in query_calls if item[0] == 'order'] == [
        ('order', 'date', 'ASCENDING'), ('order', 'time', 'ASCENDING')]
    assert len([item for item in query_calls if item[0] == 'where']) == 2


def test_upcoming_memory_query_filters_finished_and_elapsed_before_limit():
    planner_repo.clear_memory_state()
    try:
        for session_id, clock, status in [('cancelled', '20:00', 'cancelled'), ('completed', '20:00', 'completed'),
                                          ('skipped', '20:00', 'skipped'), ('elapsed', '09:00', 'planned'),
                                          ('upcoming', '19:00', 'planned'), ('legacy', '20:00', None)]:
            row = dict(id=session_id, date='2026-09-30', time=clock)
            if status is not None:
                row['status'] = status
            planner_repo.set_planner_session(None, 'user-1', session_id, row)
        result = planner_repo.list_planner_sessions_by_uid(
            None, 'user-1', 2, start_date='2026-09-30', start_time='18:30:00', planned_only=True,
        )
        assert [row['id'] for row in result] == ['upcoming', 'legacy']
    finally:
        planner_repo.clear_memory_state()


def test_active_membership_survives_more_than_two_hundred_archived_goals():
    planner_repo.clear_memory_state()
    try:
        for index in range(250):
            planner_repo.set_study_goal(None, 'owner', f'old{index}', {'goal_id': f'old{index}', 'status': 'archived'})
        planner_repo.set_study_goal(None, 'owner', 'current', {'goal_id': 'current', 'status': 'active', 'pack_ids': ['inside']})
        planner_repo.set_study_goal(None, 'other', 'foreign', {'goal_id': 'foreign', 'status': 'active'})
        assert [goal['goal_id'] for goal in planner_repo.list_active_study_goals_by_uid(None, 'owner')] == ['current']
    finally:
        planner_repo.clear_memory_state()


def test_active_pack_session_filter_precedes_limit():
    planner_repo.clear_memory_state()
    try:
        for index in range(8):
            planner_repo.set_planner_session(None, 'owner', f's{index}', {
                'uid': 'owner', 'id': f's{index}', 'date': f'2099-01-{index + 1:02}', 'time': '10:00',
                'pack_id': 'outside' if index < 7 else 'inside', 'status': 'planned'})
        result = planner_repo.list_planner_sessions_by_uid(None, 'owner', 4, start_date='2000-01-01', planned_only=True, pack_ids={'inside'})
        assert [item['id'] for item in result] == ['s7']
    finally:
        planner_repo.clear_memory_state()
