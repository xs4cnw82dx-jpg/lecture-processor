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


def _recovery_page(query, field, limit, cursors, *, inequality=False):
    # Equality queries sort by document name. The inequality index sorts by
    # its value first. Include the name to disambiguate ties without offsets.
    query = query.limit(limit)
    # Consume this cursor before querying so a failed continuation starts
    # over next pass and leaves the other scans' positions intact.
    cursor = cursors.pop(field, None)
    page_query = query
    if cursor:
        if inequality:
            page_query = page_query.order_by(field)
        page_query = page_query.order_by('__name__').start_after(cursor)
    page = list(page_query.stream())
    if not page and cursor:
        page = list(query.stream())
    if len(page) == limit:
        last = page[-1]
        following = {'__name__': last.reference}
        if inequality:
            following[field] = last.to_dict()[field]
        cursors[field] = following
    return page


def query_statuses(db, collection_name, statuses, *, limit=200, cursors=None):
    normalized = [str(status).strip().lower() for status in (statuses or []) if str(status).strip()]
    if not normalized:
        return []
    query = apply_where(db.collection(collection_name), 'status', 'in', normalized)
    if isinstance(limit, int) and limit > 0:
        if cursors is not None:
            return _recovery_page(query, 'status', limit, cursors)
        query = query.limit(limit)
    return list(query.stream())


def query_by_user_and_statuses(db, collection_name, user_id, statuses, *, limit=200):
    safe_user_id = str(user_id or '').strip()
    normalized = [str(status).strip().lower() for status in (statuses or []) if str(status).strip()]
    if not safe_user_id or not normalized:
        return []
    query = apply_where(db.collection(collection_name), 'user_id', '==', safe_user_id)
    query = apply_where(query, 'status', 'in', normalized)
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def query_pending_refunds(db, collection_name, *, limit=200, cursors=None):
    """Bounded single-field lookups avoid scanning all terminal job snapshots."""
    maximum = max(1, min(500, int(limit)))
    documents = {}
    if cursors is None:
        cursors = {}
    for field, operator, value in (
        ('credit_refund_pending', '==', True), ('extra_slides_refund_pending', '>', 0),
    ):
        query = apply_where(db.collection(collection_name), field, operator, value)
        page = _recovery_page(query, field, maximum, cursors, inequality=operator == '>')
        for document in page:
            documents[document.id] = document
    return list(documents.values())
