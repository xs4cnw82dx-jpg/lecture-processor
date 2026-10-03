"""Synthetic planner data for opt-in, isolated browser integration tests only."""
from types import SimpleNamespace

from flask import jsonify, request
from google.api_core.exceptions import FailedPrecondition, DeadlineExceeded


def install(app):
    from lecture_processor.runtime.container import get_runtime
    from lecture_processor.domains.account import lifecycle
    from lecture_processor.repositories import planner_repo
    runtime = get_runtime(app)
    if not app.config.get('TESTING') or runtime.db is not None:
        raise RuntimeError('Planner fixture requires the isolated in-memory test runtime')
    uid = 'planner-fixture-user'
    packs = {
        key: {'uid': uid, 'study_pack_id': key, 'title': title, 'mode': 'study-pack', 'folder_id': '',
              'flashcards_count': 40, 'test_questions_count': 12, 'created_at': 1,
              'flashcards': [{'front': f'Question {i}', 'back': f'Answer {i}'} for i in range(40)],
              'test_questions': [{'question': f'Question {i}', 'options': ['Yes', 'No'], 'answer': 'Yes'} for i in range(12)]}
        for key, title in [('fixture_anatomy', 'Anatomy foundations'), ('fixture_biology', 'Cell biology')]
    }
    def snapshot(payload=None, doc_id=''):
        return SimpleNamespace(exists=payload is not None, id=doc_id, to_dict=lambda: dict(payload or {}))
    runtime.verify_firebase_token = lambda req: {'uid': uid, 'email': 'planner@example.test', 'email_verified': True} if req.headers.get('Authorization') == 'Bearer planner-fixture-token' else None
    runtime.is_email_allowed = lambda email: email == 'planner@example.test'
    lifecycle.ensure_account_allows_writes = lambda *args, **kwargs: (True, '')
    repo = runtime.repositories.study
    repo.list_study_pack_summaries_by_uid = lambda _db, _uid, _limit, after_doc=None: [snapshot(value, key) for key, value in packs.items()] if after_doc is None else []
    repo.get_study_pack_summary_doc = lambda _db, key: snapshot(packs.get(key), key)
    repo.get_study_pack_doc = lambda _db, key: snapshot(packs.get(key), key)
    repo.list_study_folders_by_uid = lambda *_args: []
    repo.list_study_card_states_by_uid = lambda *_args: []
    runtime.get_study_card_state_doc = lambda *_args: SimpleNamespace(get=lambda: snapshot({'state': {}}))
    runtime.get_study_progress_doc = lambda *_args: SimpleNamespace(get=lambda: snapshot({'card_state_due_by_date_version': 1, 'card_state_due_by_date': {}}))
    fault = {'next_apply': ''}
    commit = planner_repo.commit_study_plan
    def commit_fixture(*args, **kwargs):
        mode = fault['next_apply']; fault['next_apply'] = ''
        if mode == 'missing_index':
            raise FailedPrecondition('Synthetic missing index')
        result = commit(*args, **kwargs)
        if mode == 'lost_response':
            raise DeadlineExceeded('Synthetic response lost after successful commit')
        return result
    planner_repo.commit_study_plan = commit_fixture

    @app.post('/__planner-fixture/reset')
    def reset():
        planner_repo.clear_memory_state(); fault['next_apply'] = ''
        return jsonify({'ok': True})

    @app.post('/__planner-fixture/fault')
    def set_fault():
        value = (request.get_json() or {}).get('next_apply', '')
        if value not in ('missing_index', 'lost_response', ''):
            return jsonify({'error': 'Unknown fixture fault'}), 400
        fault['next_apply'] = value
        return jsonify({'ok': True})
