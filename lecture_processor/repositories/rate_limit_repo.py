"""Firestore accessors for rate limit counters."""


def counter_doc_ref(db, collection_name, counter_id):
    return db.collection(collection_name).document(counter_id)
