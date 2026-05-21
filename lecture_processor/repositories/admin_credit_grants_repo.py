"""Firestore accessors for admin credit grant ledger entries."""

from .query_utils import apply_where

COLLECTION = 'admin_credit_grants'


def collection_ref(db):
    return db.collection(COLLECTION)


def doc_ref(db, grant_id):
    return collection_ref(db).document(grant_id)


def set_doc(db, grant_id, data, merge=False):
    return doc_ref(db, grant_id).set(data, merge=merge)


def list_recent(db, limit=20, firestore_module=None):
    query = collection_ref(db)
    if firestore_module is not None:
        query = query.order_by('created_at', direction=firestore_module.Query.DESCENDING)
    query = query.limit(limit)
    return list(query.stream())


def list_by_email_recent(db, email_normalized, limit=20, firestore_module=None):
    query = apply_where(collection_ref(db), 'email_normalized', '==', str(email_normalized or '').strip().lower())
    if firestore_module is not None:
        query = query.order_by('created_at', direction=firestore_module.Query.DESCENDING)
    query = query.limit(limit)
    return list(query.stream())


def list_by_uid_recent(db, uid, limit=20, firestore_module=None):
    query = apply_where(collection_ref(db), 'uid', '==', str(uid or '').strip())
    if firestore_module is not None:
        query = query.order_by('created_at', direction=firestore_module.Query.DESCENDING)
    query = query.limit(limit)
    return list(query.stream())
