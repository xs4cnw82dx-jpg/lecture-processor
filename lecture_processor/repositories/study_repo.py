"""Firestore accessors for study-related collections."""


def study_pack_doc_ref(db, pack_id):
    return db.collection('study_packs').document(pack_id)


def create_study_pack_doc_ref(db):
    return db.collection('study_packs').document()


def get_study_pack_doc(db, pack_id):
    return study_pack_doc_ref(db, pack_id).get()


def list_study_packs_by_uid(db, uid, limit):
    return list(db.collection('study_packs').where('uid', '==', uid).limit(limit).stream())


def list_study_packs_by_uid_and_folder(db, uid, folder_id):
    return list(db.collection('study_packs').where('uid', '==', uid).where('folder_id', '==', folder_id).stream())


def study_folder_doc_ref(db, folder_id):
    return db.collection('study_folders').document(folder_id)


def create_study_folder_doc_ref(db):
    return db.collection('study_folders').document()


def get_study_folder_doc(db, folder_id):
    return study_folder_doc_ref(db, folder_id).get()


def list_study_folders_by_uid(db, uid):
    return list(db.collection('study_folders').where('uid', '==', uid).stream())


def study_progress_doc_ref(db, uid):
    return db.collection('study_progress').document(uid)


def study_card_state_doc_ref(db, uid, pack_id):
    return db.collection('study_card_states').document(f"{uid}__{pack_id}")


def list_study_card_states_by_uid(db, uid, limit):
    return db.collection('study_card_states').where('uid', '==', uid).limit(limit).stream()
