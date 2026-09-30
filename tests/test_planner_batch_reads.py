"""Planner bootstrap/preview reads use bounded projected Firestore batches."""
from copy import deepcopy
from types import SimpleNamespace

from lecture_processor.repositories import study_repo
from lecture_processor.services import study_plan_service


class _Ref:
    def __init__(self, db, collection, doc_id):
        self.db, self.collection, self.id = db, collection, doc_id

    def get(self, field_paths=None):
        self.db.individual_reads.append((self.collection, self.id))
        return self.db.snapshot(self, field_paths)


class _DB:
    def __init__(self, data):
        self.data = data
        self.batches = []
        self.individual_reads = []

    def collection(self, name):
        return SimpleNamespace(document=lambda doc_id: _Ref(self, name, doc_id))

    def snapshot(self, ref, field_paths=None):
        raw = self.data.get((ref.collection, ref.id))
        payload = deepcopy(raw or {})
        if field_paths is not None:
            payload = {key: value for key, value in payload.items() if key in field_paths}
        return SimpleNamespace(id=ref.id, exists=raw is not None, to_dict=lambda: deepcopy(payload))

    def get_all(self, refs, field_paths=None):
        self.batches.append((list(refs), field_paths))
        # Firestore does not promise request order and absent states are valid.
        return [self.snapshot(ref, field_paths) for ref in reversed(refs)]


def test_hundred_planner_states_use_one_batch_and_keep_missing_state_default(runtime, monkeypatch):
    ids = [f'pack_{index:03}' for index in range(100)]
    data = {('study_card_states', 'u1__' + pack_id): {
        'uid': 'u1', 'pack_id': pack_id, 'state': {'fc_0': {'correct': index + 1, 'wrong': 0}},
        'unneeded': 'not part of projection',
    } for index, pack_id in enumerate(ids[:-1])}
    db = _DB(data)
    monkeypatch.setattr(runtime.core, 'db', db)
    result = study_plan_service._pack_states(runtime, 'u1', ids)
    assert result['pack_000']['fc_0']['correct'] == 1
    assert result['pack_098']['fc_0']['correct'] == 99
    assert result['pack_099'] == {}
    assert len(db.batches) == 1
    assert db.batches[0][1] == ['uid', 'pack_id', 'state']
    assert db.individual_reads == []


def test_card_state_reads_are_chunked_and_deduplicated():
    db = _DB({})
    ids = [f'pack_{index:03}' for index in range(250)]
    result = study_repo.get_study_card_state_docs(db, 'u1', ids + ids[:5])
    assert len(result) == 250
    assert [len(refs) for refs, _ in db.batches] == [100, 100, 50]
    assert db.individual_reads == []


def test_owned_pack_summaries_are_projected_batched_and_ownership_checked(runtime, monkeypatch):
    data = {('study_packs', pack_id): {'uid': owner, 'title': pack_id, 'mode': mode, 'archived': archived,
                                      'flashcards_count': 3, 'test_questions_count': 7, 'notes_markdown': 'private content'}
            for pack_id, owner, mode, archived in [('pack_ok', 'u1', 'study-pack', False),
                                                 ('pack_other', 'u2', 'study-pack', False),
                                                 ('pack_voice', 'u1', 'voice-note', False),
                                                 ('pack_archived', 'u1', 'study-pack', True)]}
    db = _DB(data)
    monkeypatch.setattr(runtime.core, 'db', db)
    result = study_plan_service._owned_pack_summaries(runtime, 'u1', ['pack_ok', 'pack_other', 'pack_voice', 'pack_archived', 'pack_missing'])
    assert list(result) == ['pack_ok']
    assert result['pack_ok']['flashcards_count'] == 3
    assert result['pack_ok']['test_questions_count'] == 7
    assert len(db.batches) == 1
    assert db.batches[0][1] == list(study_repo.STUDY_PACK_SUMMARY_FIELDS)
    assert 'notes_markdown' not in db.batches[0][1]
    assert db.individual_reads == []


def test_legacy_pack_count_fallback_is_batched_only_for_missing_counts(runtime, monkeypatch):
    db = _DB({('study_packs', 'pack_legacy'): {'uid': 'u1', 'flashcards': [{}, {}], 'test_questions': [{}]},
              ('study_packs', 'pack_current'): {'uid': 'u1', 'flashcards_count': 4, 'test_questions_count': 5}})
    monkeypatch.setattr(runtime.core, 'db', db)
    result = study_plan_service._owned_pack_summaries(runtime, 'u1', ['pack_legacy', 'pack_current'])
    assert result['pack_legacy']['flashcards_count'] == 2
    assert result['pack_legacy']['test_questions_count'] == 1
    assert len(db.batches) == 2
    assert [ref.id for ref in db.batches[1][0]] == ['pack_legacy']
    assert db.individual_reads == []


def test_small_adapter_without_batch_projection_retains_individual_read_fallback():
    db = _DB({('study_packs', 'pack_test'): {'uid': 'u1', 'flashcards_count': 4}})
    db.get_all = lambda refs: []  # Older adapters reject the field_paths keyword.
    docs = study_repo.get_study_pack_summary_docs(db, ['pack_test'])
    assert docs[0].to_dict()['flashcards_count'] == 4
    assert db.individual_reads == [('study_packs', 'pack_test')]
