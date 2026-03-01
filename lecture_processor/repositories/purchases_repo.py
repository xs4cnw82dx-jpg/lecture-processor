"""Firestore accessors for purchases collection."""

from .query_utils import apply_where


def doc_ref(db, purchase_id):
    return db.collection('purchases').document(purchase_id)


def get_doc(db, purchase_id):
    return doc_ref(db, purchase_id).get()


def set_doc(db, purchase_id, data, merge=True):
    return doc_ref(db, purchase_id).set(data, merge=merge)


def add_doc(db, data):
    return db.collection('purchases').add(data)


def list_by_uid_recent(db, uid, limit, firestore_module):
    query = apply_where(db.collection('purchases'), 'uid', '==', uid).order_by('created_at', direction=firestore_module.Query.DESCENDING).limit(limit)
    return list(query.stream())


def query_by_uid(db, uid, limit):
    query = apply_where(db.collection('purchases'), 'uid', '==', uid).limit(limit)
    return list(query.stream())


def query_by_session_id(db, stripe_session_id, limit=1):
    query = apply_where(db.collection('purchases'), 'stripe_session_id', '==', stripe_session_id).limit(limit)
    return list(query.stream())
