from lecture_processor.repositories.query_utils import apply_where


class _FilterCapableQuery:
    def __init__(self):
        self.kwargs = None

    def where(self, *args, **kwargs):
        self.kwargs = kwargs
        return self


class _PositionalOnlyQuery:
    def __init__(self):
        self.args = None

    def where(self, *args, **kwargs):
        if "filter" in kwargs:
            raise TypeError("filter keyword unsupported")
        self.args = args
        return self


def test_apply_where_prefers_field_filter_keyword():
    query = _FilterCapableQuery()

    result = apply_where(query, "uid", "==", "u123")

    assert result is query
    assert query.kwargs is not None
    assert "filter" in query.kwargs


def test_apply_where_falls_back_to_positional_for_simple_test_doubles():
    query = _PositionalOnlyQuery()

    result = apply_where(query, "uid", "==", "u123")

    assert result is query
    assert query.args == ("uid", "==", "u123")
