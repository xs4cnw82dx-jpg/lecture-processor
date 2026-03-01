"""Firestore accessors for runtime job state snapshots."""

from .query_utils import apply_where


def doc_ref(db, collection_name, job_id):
    return db.collection(collection_name).document(job_id)


def set_doc(db, collection_name, job_id, payload, merge=False):
    return doc_ref(db, collection_name, job_id).set(payload, merge=merge)


def get_doc(db, collection_name, job_id):
    return doc_ref(db, collection_name, job_id).get()


def delete_doc(db, collection_name, job_id):
    return doc_ref(db, collection_name, job_id).delete()


def query_statuses(db, collection_name, statuses, *, limit=200):
    normalized = [str(status).strip().lower() for status in (statuses or []) if str(status).strip()]
    if not normalized:
        return []
    query = apply_where(db.collection(collection_name), 'status', 'in', normalized)
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())
