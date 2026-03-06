"""Firestore helpers for batch job persistence."""

from .query_utils import apply_where


def batch_jobs_collection(db):
    return db.collection('batch_jobs')


def batch_job_doc_ref(db, batch_id):
    return batch_jobs_collection(db).document(batch_id)


def create_batch_job_doc_ref(db):
    return batch_jobs_collection(db).document()


def set_batch_job(db, batch_id, payload, merge=True):
    return batch_job_doc_ref(db, batch_id).set(payload, merge=merge)


def update_batch_job_fields(db, batch_id, payload):
    return batch_job_doc_ref(db, batch_id).update(payload)


def get_batch_job_doc(db, batch_id):
    return batch_job_doc_ref(db, batch_id).get()


def list_batch_jobs_by_uid(db, uid, limit=100):
    query = apply_where(batch_jobs_collection(db), 'uid', '==', uid).order_by('created_at', direction='DESCENDING')
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def list_batch_jobs_by_uid_and_statuses(db, uid, statuses, limit=100):
    safe_statuses = [str(status or '').strip() for status in (statuses or []) if str(status or '').strip()]
    if not safe_statuses:
        return list_batch_jobs_by_uid(db, uid, limit=limit)
    query = apply_where(batch_jobs_collection(db), 'uid', '==', uid)
    query = apply_where(query, 'status', 'in', safe_statuses[:10]).order_by('created_at', direction='DESCENDING')
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def list_batch_jobs_by_uid_and_submission_id(db, uid, client_submission_id, limit=5):
    safe_uid = str(uid or '').strip()
    safe_submission_id = str(client_submission_id or '').strip()
    if not safe_uid or not safe_submission_id:
        return []
    query = apply_where(batch_jobs_collection(db), 'uid', '==', safe_uid)
    query = apply_where(query, 'client_submission_id', '==', safe_submission_id)
    query = query.order_by('created_at', direction='DESCENDING')
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def list_active_batch_jobs(db, statuses, limit=50):
    active_statuses = [str(status or '').strip() for status in (statuses or []) if str(status or '').strip()]
    if not active_statuses:
        return []
    query = apply_where(batch_jobs_collection(db), 'status', 'in', active_statuses).order_by('updated_at', direction='DESCENDING')
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def list_batch_jobs(db, limit=200):
    query = batch_jobs_collection(db).order_by('created_at', direction='DESCENDING')
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def batch_rows_collection(db, batch_id):
    return batch_job_doc_ref(db, batch_id).collection('rows')


def batch_row_doc_ref(db, batch_id, row_id):
    return batch_rows_collection(db, batch_id).document(row_id)


def set_batch_row(db, batch_id, row_id, payload, merge=True):
    return batch_row_doc_ref(db, batch_id, row_id).set(payload, merge=merge)


def update_batch_row_fields(db, batch_id, row_id, payload):
    return batch_row_doc_ref(db, batch_id, row_id).update(payload)


def get_batch_row_doc(db, batch_id, row_id):
    return batch_row_doc_ref(db, batch_id, row_id).get()


def list_batch_rows(db, batch_id):
    return list(batch_rows_collection(db, batch_id).order_by('ordinal').stream())
