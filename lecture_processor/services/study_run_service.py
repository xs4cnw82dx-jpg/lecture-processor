"""Finite, resumable planned study runs and explicit completion records."""
from __future__ import annotations

import hashlib
import json
import threading

from lecture_processor.services import study_plan_service as plans
from lecture_processor.domains.account import lifecycle

_memory_lock = threading.RLock()


class RunError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def _integer(value, minimum=0, maximum=86400):
    if isinstance(value, bool):
        raise RunError('Enter a valid whole number.')
    try:
        parsed = int(value)
        if float(value) != parsed or not minimum <= parsed <= maximum:
            raise ValueError()
        return parsed
    except (TypeError, ValueError, OverflowError):
        raise RunError('Enter a valid whole number.') from None


def fingerprint(pack):
    content = {key: pack.get(key, []) if key != 'notes_markdown' else pack.get(key, '')
               for key in ('flashcards', 'test_questions', 'notes_markdown')}
    return hashlib.sha256(json.dumps(content, sort_keys=True).encode()).hexdigest()


def build_queue(pack, state, session, today, all_items=False):
    """Allocate one shared focus budget, with current due/retry work first."""
    study_mode = session.get('study_mode', 'review')
    outcomes = (session.get('planned_outcomes') or {}) if study_mode == 'review' else {}
    duration = int(session.get('duration', 45))
    seconds = duration * 60
    if session.get('timer_mode') == 'pomodoro':
        seconds = (seconds // 1800) * 1500 + min(seconds % 1800, 1500)
    candidates = []
    for prefix, field in [('fc', 'flashcards'), ('q', 'test_questions')]:
        if study_mode == 'notes' or (study_mode == 'flashcards' and prefix != 'fc') or (study_mode == 'test' and prefix != 'q'):
            continue
        occurrences = {}
        for index, item in enumerate(pack.get(field) or []):
            item_id = f'{prefix}_{index}'
            progress = state.get(item_id) or {}
            seen = bool(progress.get('seen') or progress.get('last_review_date'))
            due = seen and str(progress.get('next_review_date') or today) <= today
            retry = progress.get('last_action') == 'retry'
            reason = 'Retry' if retry else 'Due today' if due else 'New' if not seen else 'Revision'
            digest = hashlib.sha256(json.dumps(item, sort_keys=True).encode()).hexdigest()
            occurrence = occurrences.get(digest, 0)
            occurrences[digest] = occurrence + 1
            candidates.append((0 if retry else 1 if due else 2 if not seen else 3, index, prefix,
                               {'id': item_id, 'type': prefix, 'index': index, 'reason': reason,
                                'estimated_seconds': 60 if prefix == 'fc' else 120,
                                'content_key': f'{prefix}:{digest}:{occurrence}'}))
    candidates.sort(key=lambda value: value[:3])
    ordered = [item[3] for item in candidates]
    if all_items:
        return ordered
    queue = []
    used = set()
    explicit = any(int(outcomes.get(key, 0) or 0) for key in ('flashcards', 'questions', 'notes_minutes'))
    remaining_targets = {'fc': int(outcomes.get('flashcards', 0) or 0), 'q': int(outcomes.get('questions', 0) or 0)}
    # Primary work gets first choice, then daily revision fills the same budget.
    for item in ordered:
        if explicit and remaining_targets[item['type']] <= 0:
            continue
        if item['estimated_seconds'] <= seconds:
            queue.append(item)
            used.add(item['id'])
            seconds -= item['estimated_seconds']
            remaining_targets[item['type']] -= 1
    notes = int(outcomes.get('notes_minutes', 0) or 0)
    if pack.get('notes_markdown') and study_mode in {'review', 'notes'} and (notes or not ordered):
        notes_seconds = min(seconds, notes * 60 if notes else seconds)
        if notes_seconds > 0:
            queue.append({'id': 'notes', 'type': 'notes', 'index': 0, 'reason': 'Read and recall', 'seconds': notes_seconds})
            seconds -= notes_seconds
    if explicit and (int(session.get('revision_minutes', 0) or 0) > 0 or session.get('study_intent') in {'mixed', 'review'}):
        for item in ordered:
            if item['id'] not in used and item['estimated_seconds'] <= seconds:
                queue.append(item)
                seconds -= item['estimated_seconds']
    return queue


def rebuild_unfinished(run, pack, state, session, today):
    """Remap unchanged answered content, preserve removed answers as historical work."""
    candidates = build_queue(pack, state, dict(session, study_mode=run.get('study_mode', 'review')), today, all_items=True)
    by_content = {item.get('content_key'): item for item in candidates}
    kept, answers, retries = [], {}, []
    retired = list(run.get('retired_answers') or [])
    previous_answers = run.get('answers') or {}
    for item in run['queue']:
        if item['id'] not in previous_answers:
            continue
        replacement = by_content.get(item.get('content_key'))
        if replacement:
            kept.append(replacement)
            answers[replacement['id']] = previous_answers[item['id']]
            if item['id'] in run.get('retry_done', []):
                retries.append(replacement['id'])
        else:
            retired.append(previous_answers[item['id']])
    used = {item['id'] for item in kept}
    for kind in ('fc', 'q'):
        required = sum(item['type'] == kind for item in run['queue'])
        removed = sum(item['type'] == kind for item in retired) - sum(item['type'] == kind for item in run.get('retired_answers', []))
        available = max(0, required - removed - sum(item['type'] == kind for item in kept))
        kept.extend([item for item in candidates if item['type'] == kind and item['id'] not in used][:available])
    if pack.get('notes_markdown'):
        kept.extend(item for item in run['queue'] if item['type'] == 'notes')
    run.update({'queue': kept, 'answers': answers, 'retry_done': retries, 'retired_answers': retired,
                'content_fingerprint': fingerprint(pack), 'checkpoint_revision': run.get('checkpoint_revision', 0) + 1,
                'content_updated': True, 'run_status': 'paused'})
    return run


def _atomic(app, uid, session_id, run_id, change, pack_digest=None, pack_id=None):
    repo = app.repositories.planner
    def verify_pack(transaction=None):
        if pack_digest is None:
            return
        document = (app.repositories.study.study_pack_doc_ref(app.db, pack_id).get(transaction=transaction)
                    if transaction is not None else app.repositories.study.get_study_pack_doc(app.db, pack_id))
        pack = document.to_dict() if document.exists else {}
        if pack.get('uid') != uid or pack.get('archived') or fingerprint(pack) != pack_digest:
            raise RunError('This pack changed. Reload the session to update unfinished work.', 409)
    if app.db is None:
        with _memory_lock:
            if not lifecycle.ensure_account_allows_writes(uid, runtime=app)[0]:
                raise RunError('Account unavailable.', 409)
            verify_pack()
            session_doc = repo.get_planner_session(None, uid, session_id)
            run_doc = repo.get_study_activity(None, uid, run_id)
            session, run, result = change(session_doc.to_dict() if session_doc.exists else None,
                                          run_doc.to_dict() if run_doc.exists else None)
            if session is not None:
                repo.set_planner_session(None, uid, session_id, session, merge=False)
            if run is not None:
                repo.set_study_activity(None, uid, run_id, run, merge=False)
            if session is not None:
                from lecture_processor.services import calendar_sync_service
                calendar_sync_service.mark_dirty(app, uid)
            return result
    from google.cloud import firestore
    session_ref = repo.planner_session_doc_ref(app.db, uid, session_id)
    run_ref = repo.study_activity_doc_ref(app.db, uid, run_id)

    @firestore.transactional
    def execute(transaction):
        lifecycle.require_account_access(uid, runtime=app, transaction=transaction)
        sd = session_ref.get(transaction=transaction)
        rd = run_ref.get(transaction=transaction)
        verify_pack(transaction)
        session, run, result = change(sd.to_dict() if sd.exists else None, rd.to_dict() if rd.exists else None)
        if session is not None:
            transaction.set(session_ref, session)
        if run is not None:
            transaction.set(run_ref, run)
        if session is not None:
            from lecture_processor.services import calendar_sync_service
            calendar_sync_service.mark_dirty(app, uid, batch=transaction)
        return result
    return execute(app.db.transaction())


def _session(session):
    if not session:
        raise RunError('Study session not found.', 404)
    return session


def _request(app, request, handler):
    decoded, error, _status = plans._require_user(app, request)
    if error is not None:
        return error, _status
    guard = plans._write_guard(app, decoded['uid'])
    if guard:
        return guard
    try:
        body = request.get_json(silent=True) or {}
        if not isinstance(body, dict):
            raise RunError('A JSON object is required.')
        return app.jsonify(handler(decoded['uid'], body))
    except RunError as error:
        return app.jsonify({'error': str(error)}), error.status
    except lifecycle.AccountUnavailableError:
        return app.jsonify({'error': 'Account unavailable.'}), 409


def start_run(app, request, session_id):
    def handle(uid, body):
        repo = app.repositories.planner
        snapshot = repo.get_planner_session(app.db, uid, session_id)
        session = _session(snapshot.to_dict() if snapshot.exists else None)
        pack_id = session.get('pack_id')
        pack_doc = app.repositories.study.get_study_pack_doc(app.db, pack_id) if pack_id else None
        pack = pack_doc.to_dict() if pack_doc and pack_doc.exists else {}
        if pack.get('uid') != uid or pack.get('archived'):
            raise RunError('This study pack is no longer available.', 404)
        pack['study_pack_id'] = pack_id
        state_doc = app.get_study_card_state_doc(uid, pack_id).get()
        state = (state_doc.to_dict() or {}).get('state', {}) if state_doc.exists else {}
        digest = fingerprint(pack)
        generation = int(session.get('completion_generation', 0))
        run_id = session.get('active_run_id') or 'run_' + hashlib.sha256(f'{session_id}:{generation}'.encode()).hexdigest()[:32]
        today = plans._today_for_timezone(plans._preferences(app, uid)['timezone'])
        selected_mode = 'pomodoro' if body.get('timer_mode') == 'pomodoro' else 'countdown'
        study_mode = body.get('study_mode', 'review')
        if study_mode not in {'review', 'flashcards', 'test', 'notes'}:
            raise RunError('Choose Review, Flashcards, Practice test, or Notes for this planned session.')
        queue = build_queue(pack, state, dict(session, timer_mode=selected_mode, study_mode=study_mode), today)
        if not queue:
            raise RunError('No material is available for this study mode. Choose another mode, or add cards, questions, or notes to this pack.')

        def change(current, run):
            current = _session(current)
            if current.get('status') != 'planned' or int(current.get('completion_generation', 0)) != generation:
                raise RunError('This session changed. Return to Study Plan to review it.', 409)
            if current.get('pack_id') != pack_id or current.get('revision') != session.get('revision'):
                raise RunError('This session changed. Reload and try again.', 409)
            effective_timer = selected_mode if 'timer_mode' in body or not run else run.get('timer_mode', 'countdown')
            if run and 'study_mode' in body and study_mode != run.get('study_mode', 'review') and (run.get('slot_seconds') or run.get('answers')):
                raise RunError('This session already has saved progress. Choose Resume saved session to continue it.', 409)
            if run and run.get('content_fingerprint') != digest:
                run = rebuild_unfinished(run, pack, state, current, today)
                run['metrics'] = _metrics(run)
            if run and ('timer_mode' in body or 'study_mode' in body) and not run.get('slot_seconds') and not run.get('answers'):
                effective_mode = study_mode if 'study_mode' in body else run.get('study_mode', 'review')
                updated_queue = build_queue(pack, state, dict(current, timer_mode=effective_timer, study_mode=effective_mode), today)
                run.update({'timer_mode': effective_timer, 'study_mode': effective_mode, 'queue': updated_queue, 'checkpoint_revision': run.get('checkpoint_revision', 0) + 1})
            if not run:
                now = app.time.time()
                run = {'activity_id': run_id, 'uid': uid, 'pack_id': pack_id, 'plan_item_id': session_id,
                       'generation': generation, 'content_fingerprint': digest, 'queue': queue,
                       'answers': {}, 'retry_done': [], 'active_seconds': 0, 'slot_seconds': 0, 'notes_seconds': 0,
                       'duration_seconds': int(current.get('duration', 45)) * 60,
                       'timer_mode': selected_mode, 'study_mode': study_mode, 'run_status': 'paused', 'checkpoint_revision': 0,
                       'started_at': now, 'ended_at': 0, 'updated_at': now, 'source': 'tracked',
                       'metrics': {'minutes': 0, 'cards_reviewed': 0, 'questions_answered': 0, 'correct': 0, 'incorrect': 0}}
            if current.get('active_run_id') != run_id:
                current.update({'active_run_id': run_id, 'revision': int(current.get('revision', 0)) + 1, 'updated_at': app.time.time()})
            return current, run, {'session': current, 'run': run, 'pack': pack}
        return _atomic(app, uid, session_id, run_id, change, pack_digest=digest, pack_id=pack_id)
    return _request(app, request, handle)


def _metrics(run):
    answers = list((run.get('answers') or {}).values()) + list(run.get('retired_answers') or [])
    return {'minutes': int(run.get('active_seconds', 0)) // 60,
            'cards_reviewed': sum(item['type'] == 'fc' for item in answers),
            'questions_answered': sum(item['type'] == 'q' for item in answers),
            'correct': sum(bool(item['correct']) for item in answers),
            'incorrect': sum(not item['correct'] for item in answers)}


def checkpoint_run(app, request, run_id):
    def handle(uid, body):
        original = app.repositories.planner.get_study_activity(app.db, uid, run_id)
        if not original.exists or original.to_dict().get('source') != 'tracked':
            raise RunError('Study run not found.', 404)
        session_id = original.to_dict().get('plan_item_id')

        def change(session, run):
            session = _session(session)
            if session.get('status') != 'planned' or run.get('generation', 0) != session.get('completion_generation', 0):
                raise RunError('This session is no longer active.', 409)
            if body.get('generation') != run.get('generation') or body.get('content_fingerprint') != run.get('content_fingerprint'):
                raise RunError('This study run changed. Reload to resume the current version.', 409)
            retries = body.get('retry_done') or []
            if not isinstance(retries, list) or any(not isinstance(item, str) for item in retries):
                raise RunError('Retry answers must be a list of item ids.')
            revision = _integer(body.get('checkpoint_revision'), 1, 10000000)
            if revision <= run.get('checkpoint_revision', 0):
                incoming = body.get('answers') or {}
                if not isinstance(incoming, dict) or any(item not in run.get('answers', {}) for item in incoming) or any(item not in run.get('retry_done', []) for item in retries):
                    raise RunError('Another tab updated this study run. Reload to resume its saved progress.', 409)
                return None, None, {'run': run, 'replayed': True}
            elapsed = max(0, int(app.time.time() - run['started_at'])) + 2
            active = _integer(body.get('active_seconds', run['active_seconds']))
            slot = _integer(body.get('slot_seconds', run['slot_seconds']))
            notes = _integer(body.get('notes_seconds', run['notes_seconds']))
            if active > slot or slot > elapsed or notes > active:
                raise RunError('Study timer values are inconsistent.')
            timer_mode = 'pomodoro' if body.get('timer_mode') == 'pomodoro' else 'countdown'
            if run.get('slot_seconds') and timer_mode != run.get('timer_mode'):
                raise RunError('The timer mode cannot change after a session starts.')
            bounded = min(slot, run['duration_seconds'])
            focus_limit = slot if timer_mode == 'countdown' else (bounded // 1800) * 1500 + min(bounded % 1800, 1500) + max(0, slot - run['duration_seconds'])
            if active > focus_limit or (notes and not any(item['type'] == 'notes' for item in run['queue'])):
                raise RunError('Break time cannot count as study time.')
            valid = {item['id']: item for item in run['queue']}
            answers = dict(run.get('answers') or {})
            incoming = body.get('answers') or {}
            if not isinstance(incoming, dict) or len(incoming) > len(valid):
                raise RunError('Study answers are invalid.')
            for item_id, answer in incoming.items():
                if item_id not in valid or valid[item_id]['type'] not in {'fc', 'q'} or not isinstance(answer, dict):
                    raise RunError('An answer does not belong to this session.')
                if item_id not in answers:
                    answers[item_id] = {'type': valid[item_id]['type'], 'correct': answer.get('correct') is True}
            if any(item not in answers for item in retries):
                raise RunError('Retry answers do not belong to this session.')
            run.update({'answers': answers, 'active_seconds': max(run['active_seconds'], active),
                        'retry_done': sorted(set(run.get('retry_done', []) + retries)),
                        'slot_seconds': max(run['slot_seconds'], slot), 'notes_seconds': max(run['notes_seconds'], notes),
                        'timer_mode': timer_mode,
                        'run_status': 'paused' if body.get('run_status') != 'active' else 'active',
                        'checkpoint_revision': revision, 'updated_at': app.time.time()})
            run['metrics'] = _metrics(run)
            return None, run, {'run': run}
        return _atomic(app, uid, session_id, run_id, change, pack_digest=original.to_dict().get('content_fingerprint'), pack_id=original.to_dict().get('pack_id'))
    return _request(app, request, handle)


def completion(app, request, session_id):
    def handle(uid, body):
        action = body.get('action', 'complete')
        source = body.get('source', 'tracked')
        if source not in {'tracked', 'offline'}:
            raise RunError('Unknown study log source.')
        snapshot = app.repositories.planner.get_planner_session(app.db, uid, session_id)
        initial = _session(snapshot.to_dict() if snapshot.exists else None)
        run_id = str(initial.get('active_run_id') or '')
        if action == 'reopen':
            run_id = str((initial.get('completion') or {}).get('activity_id') or run_id or 'none')
        elif source == 'offline':
            key = plans.study_plan.sanitize_id(body.get('idempotency_key'))
            if not key:
                raise RunError('A completion request id is required.')
            run_id = 'offline_' + hashlib.sha256(f'{session_id}:{key}'.encode()).hexdigest()[:32]
        if not run_id:
            raise RunError('Start studying or log time spent before completing this session.')

        def change(session, run):
            session = _session(session)
            previous = session.get('completion') or {}
            if action == 'complete' and session.get('status') == 'completed' and previous.get('activity_id') == run_id:
                return None, None, {'session': session, 'replayed': True}
            if _integer(body.get('revision'), 0, 10000000) != int(session.get('revision', 0)):
                raise RunError('This session changed. Refresh the plan and try again.', 409)
            now = app.time.time()
            if action == 'reopen':
                if session.get('status') not in {'completed', 'planned'}:
                    raise RunError('Only completed or paused sessions can be reopened.', 409)
                if run and run.get('source') == 'offline':
                    run['revoked_at'] = now
                generation = int(session.get('completion_generation', 0)) + 1
                keep_run = session.get('status') == 'completed' and run and run.get('source') == 'tracked'
                if keep_run:
                    run.update({'generation': generation, 'run_status': 'paused', 'ended_at': 0})
                session.update({'status': 'planned', 'completion': {}, 'active_run_id': run_id if keep_run else '',
                                'completion_generation': generation})
            elif action == 'complete':
                if session.get('status') != 'planned':
                    raise RunError('Only a planned session can be completed.', 409)
                if source == 'offline':
                    minutes = _integer(body.get('minutes'), 1, 1440)
                    if run and run.get('revoked_at'):
                        raise RunError('This log was undone. Submit a new log.', 409)
                    run = {'activity_id': run_id, 'uid': uid, 'plan_item_id': session_id,
                           'pack_id': session.get('pack_id', ''), 'source': 'offline', 'mode': 'offline',
                           'started_at': now - minutes * 60, 'ended_at': now, 'updated_at': now,
                           'metrics': {'minutes': minutes, 'cards_reviewed': 0, 'questions_answered': 0, 'correct': 0, 'incorrect': 0}}
                    reason = 'offline_log'
                else:
                    if not run or run.get('generation') != session.get('completion_generation', 0):
                        raise RunError('This study run is no longer current.', 409)
                    queue = run.get('queue') or []
                    answers = run.get('answers') or {}
                    notes_target = sum(item.get('seconds', 0) for item in queue if item['type'] == 'notes')
                    targets_met = bool(queue or run.get('retired_answers')) and all(item['id'] in answers for item in queue if item['type'] != 'notes') and run.get('notes_seconds', 0) >= notes_target
                    targets_met = targets_met and all(answer['correct'] or item_id in run.get('retry_done', []) for item_id, answer in answers.items())
                    meaningful = bool(answers or run.get('retired_answers')) or (notes_target > 0 and run.get('notes_seconds', 0) >= 60)
                    duration = run.get('duration_seconds', 0)
                    focus_budget = duration if run.get('timer_mode') != 'pomodoro' else (duration // 1800) * 1500 + min(duration % 1800, 1500)
                    time_met = run.get('slot_seconds', 0) >= duration and run.get('active_seconds', 0) >= focus_budget
                    if not meaningful or not (targets_met or time_met):
                        raise RunError('Your session is still in progress. Save it and resume later.')
                    reason = 'targets_met' if targets_met else 'time_met'
                    run.update({'run_status': 'finished', 'ended_at': now})
                session.update({'status': 'completed', 'completion': {'source': source, 'reason': reason,
                                'completed_at': now, 'activity_id': run_id}})
            else:
                raise RunError('Unknown session action.')
            session.update({'revision': int(session.get('revision', 0)) + 1, 'updated_at': now})
            return session, run, {'session': session}
        expected_run = app.repositories.planner.get_study_activity(app.db, uid, run_id)
        expected = expected_run.to_dict() if expected_run.exists else {}
        return _atomic(app, uid, session_id, run_id, change,
                       pack_digest=expected.get('content_fingerprint') if action == 'complete' and source == 'tracked' else None,
                       pack_id=initial.get('pack_id'))
    return _request(app, request, handle)
