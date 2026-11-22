from datetime import date, timedelta

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.auth import policy as auth_policy


class _Snapshot:
    def __init__(self, payload=None, doc_id=''):
        self._payload = dict(payload or {})
        self.id = doc_id
        self.exists = payload is not None

    def to_dict(self):
        return dict(self._payload)


def make_study_plan_runtime(core, monkeypatch, runtime):
    uid = 'study-plan-user'
    pack_id = 'pack_questions'
    pack = {
        'uid': uid,
        'study_pack_id': pack_id,
        'title': 'Question-only pack',
        'mode': 'study-pack',
        'flashcards_count': 0,
        'test_questions_count': 12,
        'folder_id': '',
        'created_at': 1,
    }
    monkeypatch.setattr(core, 'db', None)
    monkeypatch.setattr(core, 'PUBLIC_BASE_URL', 'https://lectureprocessor.test')
    monkeypatch.setattr(auth_policy, 'is_email_allowed', lambda _email, runtime=None: True)
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': uid, 'email': 'student@example.com'})
    monkeypatch.setattr(account_lifecycle, 'ensure_account_allows_writes', lambda _uid, runtime=None: (True, ''))
    monkeypatch.setattr(core.study_repo, 'list_study_pack_summaries_by_uid', lambda _db, _uid, _limit, after_doc=None: [_Snapshot(pack, pack_id)] if after_doc is None else [])
    monkeypatch.setattr(core.study_repo, 'get_study_pack_summary_doc', lambda _db, requested: _Snapshot(pack, requested) if requested == pack_id else _Snapshot())
    monkeypatch.setattr(core.study_repo, 'get_study_pack_doc', lambda _db, requested: _Snapshot(pack, requested) if requested == pack_id else _Snapshot())
    monkeypatch.setattr(core.study_repo, 'list_study_folders_by_uid', lambda _db, _uid: [])
    progress_docs = {}
    class ProgressRef:
        def __init__(self, key, default):
            self.key, self.default = key, default
        def get(self, **_kwargs):
            from copy import deepcopy
            return _Snapshot(deepcopy(progress_docs.get(self.key, self.default)))
        def set(self, payload, merge=False):
            from copy import deepcopy
            progress_docs[self.key] = {**progress_docs.get(self.key, self.default), **deepcopy(payload)} if merge else deepcopy(payload)
    state_ref = lambda owner, pack: ProgressRef(('state', owner, pack), {'state': {}})
    progress_ref = lambda owner: ProgressRef(('progress', owner), {'card_state_due_by_date_version': 1, 'card_state_due_by_date': {}})
    monkeypatch.setattr(core, 'get_study_card_state_doc', state_ref)
    monkeypatch.setitem(runtime.__dict__, 'get_study_card_state_doc', state_ref)
    monkeypatch.setitem(runtime.__dict__, 'get_study_progress_doc', progress_ref)
    monkeypatch.setattr(core.study_repo, 'list_study_card_states_by_uid', lambda _db, _uid, _limit: [])
    core.planner_repo.clear_memory_state()
    yield {'uid': uid, 'pack_id': pack_id, 'pack': pack}
    core.planner_repo.clear_memory_state()


def _headers():
    return {'Authorization': 'Bearer test'}


def _preview_body(pack_id, exam_date=None):
    deadline = exam_date or (date.today() + timedelta(days=10)).isoformat()
    return {
        'goal': {'title': 'Question final', 'exam_date': deadline, 'pack_ids': [pack_id]},
        'preferences': {
            'timezone': 'UTC',
            'availability': [{'weekday': weekday, 'start': '18:00', 'end': '20:00'} for weekday in range(7)],
            'default_session_minutes': 45,
        },
    }
