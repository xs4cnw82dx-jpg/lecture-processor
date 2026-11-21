"""Telemetry ingest uses one write and a local limit; batch results are parsed row by row."""
import json
import re
from types import SimpleNamespace

from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.domains.admin import rollups
from lecture_processor.domains.rate_limit import limiter
from lecture_processor.services import analytics_service


def test_batch_results_map_rows_by_key_including_unicode_line_separators():
    rows = [
        {'key': 'b', 'response': {'text': 'second'}},
        {'key': 'a', 'response': {'text': 'first with a JSON-legal line separator'}},
        {'key': 'unknown', 'response': {}},
    ]
    content = ('\r\n'.join(json.dumps(row, ensure_ascii=False) for row in rows) + '\nnot json\n\n').encode('utf-8')
    parsed = batch_orchestrator._parse_batch_result_lines(content, ['a', 'b', 'c'], 3)
    assert parsed[0]['response']['text'].startswith('first ')
    assert parsed[1] == {'response': {'text': 'second'}, 'error': None}
    assert parsed[2] == {'response': None, 'error': 'Missing response line'}
    assert batch_orchestrator._parse_batch_result_lines(content.decode('utf-8'), ['b'], 1)[0]['response'] == {'text': 'second'}


class _Ref:
    def __init__(self, path):
        self.path = path


class _Batch:
    def __init__(self, db):
        self.db, self.writes = db, []

    def set(self, ref, payload, merge=False):
        self.writes.append((ref.path, payload, merge))

    def commit(self):
        self.db.commits.append(self.writes)


class _Db:
    def __init__(self):
        self.commits, self.added = [], []

    def batch(self):
        return _Batch(self)

    def collection(self, name):
        db = self

        class _Collection:
            def document(self, doc_id=None):
                return _Ref(f'{name}/{doc_id or "auto"}')

            def add(self, payload):
                db.added.append((name, payload))
        return _Collection()


def test_analytics_event_and_rollups_are_one_batched_commit(monkeypatch):
    db = _Db()
    runtime = SimpleNamespace(db=db, firestore=SimpleNamespace(Increment=lambda value: ('inc', value)),
                              time=SimpleNamespace(time=lambda: 1_800_000_000.0))
    monkeypatch.setattr(rollups, '_rollup_doc_ref', lambda _db, period, bucket: _Ref(f'rollups/{period}-{bucket}'))
    ok = analytics_service.log_analytics_event(
        'page_view', source='frontend', uid='u1', session_id='s1', properties={}, db=db,
        name_re=re.compile(r'^[a-z0-9_]{1,64}$'), session_id_re=re.compile(r'^[A-Za-z0-9_-]{1,80}$'), allowed_events={'page_view'},
        logger=None, time_module=runtime.time, runtime=runtime)
    assert ok is True and db.added == []
    assert len(db.commits) == 1
    paths = [path for path, _payload, _merge in db.commits[0]]
    assert paths[0] == 'analytics_events/auto'
    assert sorted(path.split('-')[0] for path in paths[1:]) == ['rollups/daily', 'rollups/hourly']
    assert all(merge for _path, _payload, merge in db.commits[0][1:])


def test_telemetry_rate_limit_can_stay_in_memory():
    calls = []
    service = SimpleNamespace(check_rate_limit=lambda *args, **kwargs: calls.append(kwargs) or (True, 0))
    runtime = SimpleNamespace(rate_limit_service=service, RATE_LIMIT_FIRESTORE_ENABLED=True, db=object(), firestore=None,
                              RATE_LIMIT_COUNTER_COLLECTION='c', RATE_LIMIT_EVENTS={}, RATE_LIMIT_LOCK=None, time=None)
    limiter.check_rate_limit('k', 5, 60, runtime=runtime)
    limiter.check_rate_limit('k', 5, 60, runtime=runtime, local_only=True)
    assert [call['firestore_enabled'] for call in calls] == [True, False]
