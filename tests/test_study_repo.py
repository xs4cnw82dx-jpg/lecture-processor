from lecture_processor.repositories import study_repo


class _StudyPackQuery:
    def __init__(self):
        self.calls = []

    def where(self, *args, **kwargs):
        self.calls.append(("where", args, kwargs))
        return self

    def order_by(self, field, direction=None):
        self.calls.append(("order_by", field, direction))
        return self

    def limit(self, value):
        self.calls.append(("limit", value))
        return self

    def start_after(self, value):
        self.calls.append(("start_after", value))
        return self

    def select(self, field_paths):
        self.calls.append(("select", tuple(field_paths)))
        return self

    def stream(self):
        self.calls.append(("stream",))
        return ["doc-1", "doc-2"]


class _DocRef:
    def __init__(self, doc_id):
        self.doc_id = doc_id
        self.calls = []

    def get(self, **kwargs):
        self.calls.append(("get", kwargs))
        return {"id": self.doc_id, "kwargs": kwargs}


class _StudyPackCollection:
    def __init__(self, query):
        self.query = query
        self.doc_refs = {}

    def where(self, *args, **kwargs):
        return self.query.where(*args, **kwargs)

    def order_by(self, *args, **kwargs):
        return self.query.order_by(*args, **kwargs)

    def limit(self, *args, **kwargs):
        return self.query.limit(*args, **kwargs)

    def document(self, doc_id=None):
        ref = _DocRef(doc_id)
        self.doc_refs[doc_id] = ref
        return ref


class _DB:
    def __init__(self, query):
        self._query = query
        self.collection_ref = _StudyPackCollection(query)

    def collection(self, name):
        assert name == "study_packs"
        return self.collection_ref


def test_list_study_pack_summaries_by_uid_orders_by_created_at_desc():
    query = _StudyPackQuery()

    result = study_repo.list_study_pack_summaries_by_uid(_DB(query), "u-123", 50)

    assert result == ["doc-1", "doc-2"]
    assert ("order_by", "created_at", "DESCENDING") in query.calls
    assert ("limit", 50) in query.calls
    assert ("select", tuple(study_repo.STUDY_PACK_SUMMARY_FIELDS)) in query.calls
    assert query.calls[-1] == ("stream",)


def test_list_study_pack_summaries_by_uid_applies_start_after_cursor():
    query = _StudyPackQuery()
    after_doc = object()

    result = study_repo.list_study_pack_summaries_by_uid(_DB(query), "u-123", 25, after_doc=after_doc)

    assert result == ["doc-1", "doc-2"]
    assert ("start_after", after_doc) in query.calls


def test_list_study_pack_summaries_by_uid_and_folder_filters_folder():
    query = _StudyPackQuery()

    result = study_repo.list_study_pack_summaries_by_uid_and_folder(_DB(query), "u-123", "folder-1", 20)

    assert result == ["doc-1", "doc-2"]
    filters = [
        (
            getattr(call[2].get("filter"), "field_path", ""),
            getattr(call[2].get("filter"), "op_string", ""),
            getattr(call[2].get("filter"), "value", ""),
        )
        for call in query.calls
        if call[0] == "where"
    ]
    assert ("uid", "==", "u-123") in filters
    assert ("folder_id", "==", "folder-1") in filters
    assert ("order_by", "created_at", "DESCENDING") in query.calls
    assert ("limit", 20) in query.calls
    assert ("select", tuple(study_repo.STUDY_PACK_SUMMARY_FIELDS)) in query.calls


def test_get_study_pack_summary_doc_projects_cursor_fields():
    query = _StudyPackQuery()
    db = _DB(query)

    result = study_repo.get_study_pack_summary_doc(db, "pack-1")

    assert result["id"] == "pack-1"
    assert result["kwargs"] == {"field_paths": list(study_repo.STUDY_PACK_CURSOR_FIELDS)}


def test_list_study_card_state_summaries_by_uid_selects_compact_fields():
    class _CardStateQuery(_StudyPackQuery):
        def stream(self):
            self.calls.append(("stream",))
            return iter(["state-doc"])

    class _CardStateDB:
        def __init__(self, query):
            self.query = query

        def collection(self, name):
            assert name == "study_card_states"
            return self.query

    query = _CardStateQuery()

    result = list(study_repo.list_study_card_state_summaries_by_uid(_CardStateDB(query), "u-123", 10))

    assert result == ["state-doc"]
    assert ("limit", 10) in query.calls
    assert ("select", tuple(study_repo.STUDY_CARD_STATE_SUMMARY_FIELDS)) in query.calls


def test_rollup_rebuild_reads_all_states_in_the_same_transaction_without_sync_limit():
    transaction = object()

    class _Query(_StudyPackQuery):
        def stream(self, transaction=None):
            self.calls.append(('stream', transaction))
            return ['a', 'b', 'c']

    class _Db:
        def collection(self, name):
            assert name == 'study_card_states'
            return query

    query = _Query()
    assert study_repo.list_all_study_card_states_by_uid(_Db(), 'owner', transaction) == ['a', 'b', 'c']
    assert not any(call[0] == 'limit' for call in query.calls)
    assert query.calls[-1] == ('stream', transaction)


def test_rollup_owner_reads_are_projected_batched_and_transactional():
    calls = []
    transaction = object()

    class _BatchDb(_DB):
        def get_all(self, refs, **kwargs):
            calls.append((len(refs), kwargs))
            return [ref.doc_id for ref in refs]

    result = study_repo.get_study_pack_owner_docs(_BatchDb(_StudyPackQuery()), [f'pack-{index}' for index in range(205)] + ['pack-1'], transaction)
    assert len(result) == 205
    assert [size for size, _ in calls] == [100, 100, 5]
    assert all(options == {'field_paths': ['uid'], 'transaction': transaction} for _, options in calls)
