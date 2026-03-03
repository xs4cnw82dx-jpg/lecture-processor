from lecture_processor.domains.admin import metrics
from lecture_processor.runtime.container import get_runtime


class _Doc:
    def __init__(self, doc_id, payload):
        self.id = doc_id
        self._payload = payload

    def to_dict(self):
        return dict(self._payload)


def test_window_and_bucket_helpers_are_stable():
    assert metrics.get_admin_window('bogus') == ('7d', 7 * 24 * 60 * 60)

    labels, keys, granularity = metrics.build_time_buckets('24h', 1_710_000_000)
    assert granularity == 'hour'
    assert len(labels) == 24
    assert len(keys) == 24


def test_safe_count_collection_returns_partial_zero_and_records_warning(app, monkeypatch):
    runtime = get_runtime(app)

    def _boom(_db, _collection_name):
        raise RuntimeError('count failure')

    monkeypatch.setattr(runtime.core.admin_repo, 'count_collection', _boom)

    with app.test_request_context('/api/admin/data'):
        assert metrics.safe_count_collection('users', runtime=runtime) == 0
        assert 'users:count_failed' in metrics.get_admin_data_warnings(runtime=runtime)


def test_build_admin_funnel_steps_counts_unique_actors(app):
    runtime = get_runtime(app)
    now_ts = runtime.time.time()

    docs = [
        _Doc('1', {'event': 'auth_modal_opened', 'uid': 'u1', 'session_id': 'sess_a', 'created_at': now_ts}),
        _Doc('2', {'event': 'auth_modal_opened', 'uid': 'u1', 'session_id': 'sess_b', 'created_at': now_ts}),
        _Doc('3', {'event': 'auth_success', 'uid': 'u1', 'session_id': 'sess_a', 'created_at': now_ts}),
        _Doc('4', {'event': 'checkout_started', 'uid': '', 'session_id': 'sess_c', 'created_at': now_ts}),
        _Doc('5', {'event': 'unknown_event', 'uid': 'u2', 'session_id': 'sess_d', 'created_at': now_ts}),
    ]

    steps, analytics_event_count = metrics.build_admin_funnel_steps(docs, now_ts - 60, runtime=runtime)
    by_event = {entry['event']: entry for entry in steps}

    assert analytics_event_count == 4
    assert by_event['auth_modal_opened']['count'] == 1
    assert by_event['auth_success']['count'] == 1
    assert by_event['checkout_started']['count'] == 1
    assert by_event['auth_modal_opened']['conversion_from_prev'] == 100.0
