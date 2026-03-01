"""Firestore accessors for users collection."""


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
