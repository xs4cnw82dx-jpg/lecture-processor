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

    def stream(self):
        self.calls.append(("stream",))
        return ["doc-1", "doc-2"]


class _DB:
    def __init__(self, query):
        self._query = query

    def collection(self, name):
        assert name == "study_packs"
        return self._query


def test_list_study_pack_summaries_by_uid_orders_by_created_at_desc():
    query = _StudyPackQuery()

    result = study_repo.list_study_pack_summaries_by_uid(_DB(query), "u-123", 50)

    assert result == ["doc-1", "doc-2"]
    assert ("order_by", "created_at", "DESCENDING") in query.calls
    assert ("limit", 50) in query.calls
    assert query.calls[-1] == ("stream",)


def test_list_study_pack_summaries_by_uid_applies_start_after_cursor():
    query = _StudyPackQuery()
    after_doc = object()

    result = study_repo.list_study_pack_summaries_by_uid(_DB(query), "u-123", 25, after_doc=after_doc)

    assert result == ["doc-1", "doc-2"]
    assert ("start_after", after_doc) in query.calls
