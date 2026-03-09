"""Firestore query helpers used by admin/account exports."""

from .query_utils import apply_where


def _apply_filters(query, filters):
    safe_filters = filters if isinstance(filters, (list, tuple)) else []
    for entry in safe_filters:
        if not isinstance(entry, (list, tuple)) or len(entry) != 3:
            continue
        field_path, op_string, value = entry
        query = apply_where(query, field_path, op_string, value)
    return query


def query_docs_in_window(
    db,
    collection_name,
    timestamp_field,
    window_start,
    window_end=None,
    order_desc=False,
    limit=None,
    firestore_module=None,
    filters=None,
):
    collection = db.collection(collection_name)
    query = _apply_filters(collection, filters)
    query = apply_where(query, timestamp_field, '>=', window_start)
    if window_end is not None:
        query = apply_where(query, timestamp_field, '<=', window_end)
    if order_desc and firestore_module is not None:
        query = query.order_by(timestamp_field, direction=firestore_module.Query.DESCENDING)
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def stream_collection(db, collection_name):
    return db.collection(collection_name).stream()


def count_collection(db, collection_name, filters=None):
    query = _apply_filters(db.collection(collection_name), filters)
    agg = query.count().get()
    if agg:
        return int(agg[0][0].value)
    return 0


def count_window(db, collection_name, timestamp_field, window_start, filters=None):
    query = _apply_filters(db.collection(collection_name), filters)
    query = apply_where(query, timestamp_field, '>=', window_start)
    agg = query.count().get()
    if agg:
        return int(agg[0][0].value)
    return 0


def query_by_uid(db, collection_name, uid, limit):
    return list(apply_where(db.collection(collection_name), 'uid', '==', uid).limit(limit).stream())
