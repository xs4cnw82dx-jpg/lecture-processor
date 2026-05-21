"""Firestore accessors for users collection."""

from .query_utils import apply_where


def doc_ref(db, uid):
    return db.collection('users').document(uid)


def get_doc(db, uid):
    return doc_ref(db, uid).get()


def set_doc(db, uid, data, merge=False):
    return doc_ref(db, uid).set(data, merge=merge)


def update_doc(db, uid, updates):
    return doc_ref(db, uid).update(updates)


def delete_doc(db, uid):
    return doc_ref(db, uid).delete()


def query_by_email_normalized(db, email_normalized, limit=5):
    query = apply_where(db.collection('users'), 'email_normalized', '==', str(email_normalized or '').strip().lower())
    return list(query.limit(limit).stream())


def query_by_email(db, email, limit=5):
    query = apply_where(db.collection('users'), 'email', '==', str(email or '').strip())
    return list(query.limit(limit).stream())
