from types import SimpleNamespace

import pytest

from lecture_processor.repositories import workout_repo


@pytest.fixture(autouse=True)
def clear_workout_memory():
    workout_repo.clear_memory_state()
    yield
    workout_repo.clear_memory_state()


def test_memory_filters_and_orders_before_limiting_large_history():
    for index in range(405):
        workout_repo.set_record(None, workout_repo.SESSION_COLLECTION, 'owner', f'session-{index}', {
            'status': 'completed', 'updated_at': index,
        })
    workout_repo.set_record(None, workout_repo.SESSION_COLLECTION, 'owner', 'paused', {
        'status': 'paused', 'updated_at': 0,
    })
    workout_repo.set_record(None, workout_repo.SESSION_COLLECTION, 'other', 'newer', {
        'status': 'completed', 'updated_at': 999,
    })

    recent = workout_repo.list_records(
        None, workout_repo.SESSION_COLLECTION, 'owner', 3,
        filters=(('status', '==', 'completed'),), order_by='updated_at', descending=True,
    )
    active = workout_repo.list_records(
        None, workout_repo.SESSION_COLLECTION, 'owner', 1,
        filters=(('status', 'in', ['active', 'paused']),), order_by='updated_at', descending=True,
    )

    assert [item['id'] for item in recent] == ['session-404', 'session-403', 'session-402']
    assert [item['id'] for item in active] == ['paused']


def test_memory_sort_preserves_numeric_timestamp_order():
    for timestamp in (9, 10, 99, 100):
        workout_repo.set_record(None, workout_repo.SESSION_COLLECTION, 'owner', str(timestamp), {
            'updated_at': timestamp,
        })
    records = workout_repo.list_records(
        None, workout_repo.SESSION_COLLECTION, 'owner', 4, order_by='updated_at', descending=True,
    )
    assert [item['updated_at'] for item in records] == [100, 99, 10, 9]


def test_full_memory_history_is_not_capped_at_2000():
    for index in range(2105):
        workout_repo.set_record(None, workout_repo.SESSION_COLLECTION, 'owner', str(index), {
            'status': 'completed', 'updated_at': index,
        })
    records = workout_repo.list_records(
        None, workout_repo.SESSION_COLLECTION, 'owner', None, filters=(('status', '==', 'completed'),),
    )
    assert len(records) == 2105


class RecordingQuery:
    def __init__(self):
        self.calls = []

    def where(self, *, filter):
        self.calls.append(('where', filter.field_path, filter.op_string, filter.value))
        return self

    def order_by(self, field, direction):
        self.calls.append(('order_by', field, direction))
        return self

    def limit(self, value):
        self.calls.append(('limit', value))
        return self

    def stream(self):
        self.calls.append(('stream',))
        return [SimpleNamespace(id='owner__session-1', to_dict=lambda: {'uid': 'owner'})]


def test_firestore_query_applies_filters_and_sort_before_limit():
    query = RecordingQuery()
    db = SimpleNamespace(collection=lambda name: query)

    records = workout_repo.list_records(
        db, workout_repo.SESSION_COLLECTION, 'owner', 1,
        filters=(('status', 'in', ['active', 'paused']),), order_by='updated_at', descending=True,
    )

    assert records == [{'id': 'session-1', 'uid': 'owner'}]
    assert query.calls == [
        ('where', 'uid', '==', 'owner'),
        ('where', 'status', 'in', ['active', 'paused']),
        ('order_by', 'updated_at', 'DESCENDING'),
        ('limit', 1),
        ('stream',),
    ]


def test_firestore_full_history_has_no_display_limit():
    query = RecordingQuery()
    db = SimpleNamespace(collection=lambda name: query)

    workout_repo.list_records(
        db, workout_repo.SESSION_COLLECTION, 'owner', None,
        filters=(('status', '==', 'completed'),), order_by='updated_at', descending=True,
    )

    assert query.calls == [
        ('where', 'uid', '==', 'owner'),
        ('where', 'status', '==', 'completed'),
        ('order_by', 'updated_at', 'DESCENDING'),
        ('stream',),
    ]
