"""Firestore query helpers used by admin/account exports."""


def query_docs_in_window(db, collection_name, timestamp_field, window_start, window_end=None, order_desc=False, limit=None, firestore_module=None):
    collection = db.collection(collection_name)
    query = collection.where(timestamp_field, '>=', window_start)
    if window_end is not None:
        query = query.where(timestamp_field, '<=', window_end)
    if order_desc and firestore_module is not None:
        query = query.order_by(timestamp_field, direction=firestore_module.Query.DESCENDING)
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def stream_collection(db, collection_name):
    return db.collection(collection_name).stream()


def count_collection(db, collection_name):
    agg = db.collection(collection_name).count().get()
    if agg:
        return int(agg[0][0].value)
    return 0


def count_window(db, collection_name, timestamp_field, window_start):
    query = db.collection(collection_name).where(timestamp_field, '>=', window_start)
    agg = query.count().get()
    if agg:
        return int(agg[0][0].value)
    return 0


def query_by_uid(db, collection_name, uid, limit):
    return list(db.collection(collection_name).where('uid', '==', uid).limit(limit).stream())
