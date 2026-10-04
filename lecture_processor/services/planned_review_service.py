"""Atomic SRS mutations for acknowledged planned-run review attempts.

Receipts belong to the run (content identity + attempt), while grow-only counters
use one stable bucket across all runs. Returning to a run or replaying a lost
response never advances an interval or a daily counter twice.
"""
from datetime import date, timedelta
import hashlib
import math

from lecture_processor.domains.study import progress
from lecture_processor.services import study_progress_service as summaries

DEVICE = '0_planned'


def _next_interval(current, action):
    if action == 'retry':
        interval = 1
    elif action == 'hard':
        interval = max(current + 1, current * 1.25) if current else 1
    elif action == 'easy':
        interval = max(current + 3, current * 2.4) if current else 4
    else:
        interval = max(current + 2, current * 1.8) if current else 2
    return min(120, max(1, math.floor(interval + .5)))


def _increment_bucket(mapping, changes):
    # Never evict another device's counters to make room for server work.
    if DEVICE not in mapping and len(mapping) >= progress.MAX_PROGRESS_DEVICES:
        raise ValueError('Progress has reached its device limit. Contact support before continuing this planned session; no review was saved.')
    bucket = dict(mapping.get(DEVICE, {}))
    for key, amount in changes.items():
        bucket[key] = min(100000, int(bucket.get(key, 0)) + amount)
    return {DEVICE: bucket, **{key: value for key, value in mapping.items() if key != DEVICE}}


def prepare(app, uid, run, body, transaction=None):
    """Read and prepare all writes; caller commits these with the run receipt."""
    raw_actions = body.get('pending_reviews', [])
    if not isinstance(raw_actions, list) or len(raw_actions) > 2 * len(run['queue']):
        raise ValueError('Planned review actions are invalid.')
    valid = {item['id']: item for item in run['queue']}
    receipts = dict(run.get('review_receipts') or {})
    actions = []
    for raw in raw_actions:
        if not isinstance(raw, dict):
            raise ValueError('Planned review actions are invalid.')
        item_id, action, key = raw.get('id'), raw.get('action'), raw.get('key')
        if not all(isinstance(value, str) for value in (item_id, action, key)):
            raise ValueError('Planned review actions are invalid.')
        item = valid.get(item_id)
        if not item or item['type'] not in {'fc', 'q'} or action not in {'retry', 'hard', 'good', 'easy'}:
            raise ValueError('A review does not belong to this study run.')
        if key not in {item_id + ':first', item_id + ':retry'}:
            raise ValueError('A review attempt is invalid.')
        answer = (run.get('answers') or {}).get(item_id)
        retry = key.endswith(':retry')
        if not answer or (retry and (answer.get('correct') or item_id not in run.get('retry_done', []))):
            raise ValueError('A review has no saved answer in this study run.')
        if not retry and bool(answer.get('correct')) != (action != 'retry'):
            raise ValueError('The review action does not match its first answer.')
        receipt = hashlib.sha256((item['content_key'] + (':retry' if retry else ':first')).encode()).hexdigest()
        if receipt not in receipts:
            receipts[receipt] = action
            actions.append((item_id, action))
    notes = run.get('notes_seconds', 0) >= 60 and not run.get('notes_activity_recorded')
    if not actions and not notes and not raw_actions:
        return [], {}

    state_ref = app.get_study_card_state_doc(uid, run['pack_id'])
    progress_ref = app.get_study_progress_doc(uid)
    state_doc = summaries._read_doc(state_ref, transaction)
    progress_doc = summaries._read_doc(progress_ref, transaction)
    state = progress.sanitize_card_state_map((state_doc.to_dict() or {}).get('state', {}) if state_doc.exists else {}, runtime=app)
    data = (progress_doc.to_dict() or {}) if progress_doc.exists else {}
    today = summaries._local_today(data, app)
    rollup = summaries._due_rollup_for_progress(app, uid, data, transaction)
    before = summaries._card_state_summary(state, app)['due_by_date']
    now = app.time.time()
    for item_id, action in actions:
        entry = progress.sanitize_card_state_entry(state.get(item_id, {}), runtime=app)
        counters = progress.sanitize_device_counter_map(entry.get('device_counters'), fallback_entry=entry, runtime=app)
        entry['device_counters'] = _increment_bucket(counters, {'seen': 1, 'wrong' if action == 'retry' else 'correct': 1})
        entry.update(progress.sum_device_counter_map(entry['device_counters'], runtime=app))
        interval = _next_interval(entry['interval_days'], action)
        entry.update({'interval_days': interval, 'max_interval_days': max(entry['max_interval_days'], interval),
                      'last_review_date': today, 'next_review_date': today if action == 'retry' else (date.fromisoformat(today) + timedelta(days=interval)).isoformat(),
                      'difficulty': 'hard' if action == 'hard' else 'easy' if action == 'easy' else 'medium',
                      'last_action': action, 'updated_at': max(now * 1000, entry.get('updated_at', 0) + 1)})
        entry['level'] = progress.derive_card_level_from_stats(entry['seen'], interval, entry['flip_count'], entry['write_count'], runtime=app)
        state[item_id] = entry
    writes = []
    if actions or notes:
        streak = progress.sanitize_streak_data(data.get('streak_data', {}), runtime=app)
        if streak['last_study_date'] < today:
            yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
            streak['current_streak'] = streak['current_streak'] + 1 if streak['last_study_date'] == yesterday else 1
            streak['last_study_date'] = today
        daily = progress.sanitize_daily_progress_by_device(streak.get('daily_progress_by_device'), fallback_date=streak['daily_progress_date'], fallback_count=streak['daily_progress_count'], runtime=app)
        if actions:
            counters = daily.get(today, {})
            if DEVICE not in counters and len(counters) >= progress.MAX_PROGRESS_DEVICES:
                raise ValueError('Progress has reached its device limit. Contact support; no review was saved.')
            daily[today] = {DEVICE: min(100000, counters.get(DEVICE, 0) + len(actions)), **{key: value for key, value in counters.items() if key != DEVICE}}
        streak['daily_progress_by_device'] = daily
        streak = progress.sanitize_streak_data(streak, runtime=app)
        after = summaries._card_state_summary(state, app)
        rollup = summaries._apply_due_by_date_delta(rollup, subtract=before, add=after['due_by_date'])
        updates = {**summaries._rollup_updates(uid, rollup, app), 'streak_data': streak, 'updated_at': now}
        data = {**data, **updates}
        if actions:
            writes.append((state_ref, {'uid': uid, 'pack_id': run['pack_id'], 'state': state, 'summary': after, 'updated_at': now}))
        writes.append((progress_ref, updates))
        run['review_receipts'] = receipts
        if notes:
            run['notes_activity_recorded'] = True
    return writes, {'card_states': {run['pack_id']: state}, 'summary': summaries._summary_with_due_count(data, summaries._due_count_from_due_by_date(rollup, today, app), app), 'streak_data': data.get('streak_data', {})}
