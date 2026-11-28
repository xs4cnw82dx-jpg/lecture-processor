"""Firestore accessors for purchases collection."""

from .query_utils import apply_where

REFUND_REVIEWS = 'checkout_refund_reviews'


def _collection(db):
    if db is None:
        raise RuntimeError('Purchase storage is unavailable.')
    return db.collection('purchases')


def doc_ref(db, purchase_id):
    return _collection(db).document(purchase_id)


def get_doc(db, purchase_id):
    return doc_ref(db, purchase_id).get()


def set_doc(db, purchase_id, data, merge=True):
    return doc_ref(db, purchase_id).set(data, merge=merge)


def add_doc(db, data):
    return _collection(db).add(data)


def list_by_uid_recent(db, uid, limit, firestore_module):
    query = apply_where(_collection(db), 'uid', '==', uid).order_by('created_at', direction=firestore_module.Query.DESCENDING).limit(limit)
    return list(query.stream())


def query_by_uid(db, uid, limit):
    query = apply_where(_collection(db), 'uid', '==', uid).limit(limit)
    return list(query.stream())


def query_by_session_id(db, stripe_session_id, limit=1):
    query = apply_where(_collection(db), 'stripe_session_id', '==', stripe_session_id).limit(limit)
    return list(query.stream())


def mark_refund_for_review(db, firestore_module, session_id, refund_id, status):
    # A stale webhook may observe failure just before another handler records
    # success. Both transactions synchronize on the existing purchase receipt.
    purchase = doc_ref(db, session_id)
    review = db.collection(REFUND_REVIEWS).document(session_id)
    payload = {'stripe_refund_id': refund_id, 'refund_status': status}

    @firestore_module.transactional
    def mark(txn):
        if purchase.get(transaction=txn).exists:
            return
        if review.get(transaction=txn).to_dict() != payload:
            txn.set(review, payload)

    mark(db.transaction())


def record_deleted_checkout_refund(db, session_id, receipt):
    batch = db.batch()
    batch.set(doc_ref(db, session_id), receipt, merge=True)
    batch.delete(db.collection(REFUND_REVIEWS).document(session_id))
    batch.commit()


def list_refunds_for_review(db, limit=20):
    return list(db.collection(REFUND_REVIEWS).limit(limit).stream())
