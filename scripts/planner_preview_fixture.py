"""Synthetic planner data for opt-in, isolated browser integration tests only."""
from types import SimpleNamespace
from copy import deepcopy
from threading import RLock

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
    packs['fixture_mixed'] = {
        'uid': uid, 'study_pack_id': 'fixture_mixed', 'title': 'Mixed study material',
        'mode': 'study-pack', 'folder_id': '', 'created_at': 1,
        'flashcards_count': 4, 'test_questions_count': 2,
        'flashcards': [{'front': f'Movement {i}', 'back': f'Answer {i}'} for i in range(4)],
        'test_questions': [{'question': f'Practice {i}', 'options': ['Yes', 'No'], 'answer': 'Yes'} for i in range(2)],
        'notes_markdown': '# Movement notes\nRead, recall, and explain the movement.',
    }
    def snapshot(payload=None, doc_id=''):
        saved = deepcopy(payload)
        return SimpleNamespace(exists=saved is not None, id=doc_id, reference=None, to_dict=lambda: deepcopy(saved or {}))
    progress_docs, card_docs = {}, {}
    storage_lock = RLock()
    class MemoryRef:
        def __init__(self, store, key):
            self.store, self.key = store, key

        def get(self, transaction=None):
            with storage_lock:
                return snapshot(self.store.get(self.key), self.key)

        def set(self, payload, merge=False):
            with storage_lock:
                self.store[self.key] = dict(self.store.get(self.key, {}) if merge else {}, **deepcopy(payload))

        def delete(self):
            with storage_lock:
                self.store.pop(self.key, None)
    runtime.verify_firebase_token = lambda req: {'uid': uid, 'email': 'planner@example.test', 'email_verified': True} if req.headers.get('Authorization') == 'Bearer planner-fixture-token' else None
    runtime.is_email_allowed = lambda email: email == 'planner@example.test'
    lifecycle.ensure_account_allows_writes = lambda *args, **kwargs: (True, '')
    lifecycle.account_deletion_ref = lambda *args, **kwargs: SimpleNamespace(get=lambda **_kwargs: snapshot())
    repo = runtime.repositories.study
    repo.list_study_pack_summaries_by_uid = lambda _db, _uid, _limit, after_doc=None: [snapshot(value, key) for key, value in packs.items()] if after_doc is None else []
    repo.get_study_pack_summary_doc = lambda _db, key: snapshot(packs.get(key), key)
    repo.get_study_pack_doc = lambda _db, key: snapshot(packs.get(key), key)
    repo.get_study_pack_source_doc = lambda _db, key: snapshot()
    repo.get_study_pack_source_flags_doc = lambda _db, key: snapshot()
    repo.get_study_pack_docs = lambda _db, keys: [snapshot(packs.get(key), key) for key in keys]
    repo.get_study_pack_owner_docs = lambda _db, keys, transaction=None: [snapshot(packs.get(key), key) for key in keys]
    repo.list_study_folders_by_uid = lambda *_args: []
    repo.list_study_card_states_by_uid = lambda _db, owner, _limit: [snapshot(value, key) for key, value in list(card_docs.items()) if value.get('uid') == owner][:_limit]
    repo.list_all_study_card_states_by_uid = lambda _db, owner, transaction=None: [snapshot(value, key) for key, value in list(card_docs.items()) if value.get('uid') == owner]
    runtime.get_study_card_state_doc = lambda owner, pack_id: MemoryRef(card_docs, owner + '__' + pack_id)
    runtime.get_study_progress_doc = lambda owner: MemoryRef(progress_docs, owner)
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
        with storage_lock:
            progress_docs.clear(); card_docs.clear()
        return jsonify({'ok': True})

    @app.post('/__planner-fixture/fault')
    def set_fault():
        value = (request.get_json() or {}).get('next_apply', '')
        if value not in ('missing_index', 'lost_response', ''):
            return jsonify({'error': 'Unknown fixture fault'}), 400
        fault['next_apply'] = value
        return jsonify({'ok': True})
