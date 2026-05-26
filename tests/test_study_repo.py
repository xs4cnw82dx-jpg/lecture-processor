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
