"""Firestore helpers for batch job persistence."""

from .query_utils import apply_where


BATCH_ROW_STATUS_FIELDS = (
    'row_id',
    'ordinal',
    'status',
    'failed_stage',
    'error',
    'study_pack_id',
    'job_log_id',
    'current_stage',
    'current_stage_detail',
    'last_stage_update_at',
    'token_input_total',
    'token_output_total',
    'token_total',
    'credits_charged',
    'interview_features_cost',
    'interview_features_refunded_count',
    'credit_refunded',
    'billing_receipt',
)


def batch_jobs_collection(db):
    return db.collection('batch_jobs')


def batch_job_doc_ref(db, batch_id):
    return batch_jobs_collection(db).document(batch_id)


def create_batch_job_doc_ref(db):
    return batch_jobs_collection(db).document()


def create_batch_job_if_absent(db, batch_id, payload):
    """Atomically create a batch document, failing when the ID already exists."""
    return batch_job_doc_ref(db, batch_id).create(payload)


def set_batch_job(db, batch_id, payload, merge=True):
    return batch_job_doc_ref(db, batch_id).set(payload, merge=merge)


def set_batch_job_with_rows(db, batch_id, batch_payload, rows):
    try:
        write_batch = db.batch()
    except AttributeError:
        set_batch_job(db, batch_id, batch_payload, merge=False)
        for row_id, row_payload in rows:
            set_batch_row(db, batch_id, row_id, row_payload, merge=False)
        return None
    write_batch.set(batch_job_doc_ref(db, batch_id), batch_payload, merge=False)
    for row_id, row_payload in rows:
        write_batch.set(batch_row_doc_ref(db, batch_id, row_id), row_payload, merge=False)
    return write_batch.commit()


def update_batch_job_fields(db, batch_id, payload):
    return batch_job_doc_ref(db, batch_id).update(payload)


def get_batch_job_doc(db, batch_id):
    return batch_job_doc_ref(db, batch_id).get()


def delete_batch_job(db, batch_id):
    return batch_job_doc_ref(db, batch_id).delete()


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


def list_batch_rows(db, batch_id, limit=None):
    query = batch_rows_collection(db, batch_id).order_by('ordinal')
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def list_batch_row_statuses(db, batch_id, limit=None):
    """Read only the small fields required by the polling/status response."""
    query = batch_rows_collection(db, batch_id).order_by('ordinal')
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    select = getattr(query, 'select', None)
    if callable(select):
        query = select(BATCH_ROW_STATUS_FIELDS)
    return list(query.stream())
