from datetime import datetime, timezone

from tests.support.study_plan_api import _headers, _preview_body


def preferences(start='17:00', duration=45):
    return {'timezone': 'Europe/Amsterdam', 'cadence': 'daily', 'daily_start': start,
            'availability_preset': 'daily', 'default_session_minutes': duration,
            'availability': [{'weekday': day, 'start': start, 'end': '20:00'} for day in range(7)]}


def make_october_clock(core, monkeypatch):
    monkeypatch.setattr(core.time, 'time', lambda: datetime(2026, 10, 3, 10, tzinfo=timezone.utc).timestamp())
    from lecture_processor.services import study_plan_service
    today = study_plan_service._today_for_timezone
    monkeypatch.setattr(study_plan_service, '_today_for_timezone',
                        lambda zone, now=None: today(zone, now or datetime.fromtimestamp(core.time.time(), timezone.utc)))


def preview(client, pack_id, **overrides):
    body = _preview_body(pack_id, '2026-10-31')
    body['preferences'] = preferences()
    body.update(overrides)
    response = client.post('/api/study-plan/preview', json=body, headers=_headers())
    assert response.status_code == 200, response.get_json()
    return response.get_json()['proposal']


def apply(client, proposal, key='idempotency_daily'):
    return client.post('/api/study-plan/apply', json={'proposal_id': proposal['proposal_id'], 'idempotency_key': key}, headers=_headers())
