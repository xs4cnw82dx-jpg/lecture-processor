"""Firestore accessors for study-related collections."""

from .query_utils import apply_where


STUDY_PACK_SUMMARY_FIELDS = (
    'uid',
    'title',
    'mode',
    'flashcards_count',
    'test_questions_count',
    'daily_card_goal',
    'course',
    'subject',
    'semester',
    'block',
    'folder_id',
    'folder_name',
    'parent_folder_id',
    'tags',
    'pinned',
    'archived',
    'created_at',
)

STUDY_PACK_CURSOR_FIELDS = (
    'uid',
    'created_at',
)

STUDY_CARD_STATE_SUMMARY_FIELDS = (
    'uid',
    'pack_id',
    'summary',
    'updated_at',
)

STUDY_PACK_SOURCE_FLAG_FIELDS = (
    'has_source_slides',
    'has_source_transcript',
)


def _apply_select(query, field_paths):
    select = getattr(query, 'select', None)
    if callable(select):
        return select(list(field_paths))
    return query


def _get_doc_with_fields(doc_ref, field_paths):
    try:
        return doc_ref.get(field_paths=list(field_paths))
    except TypeError:
        return doc_ref.get()


def study_pack_doc_ref(db, pack_id):
    return db.collection('study_packs').document(pack_id)


def create_study_pack_doc_ref(db):
    return db.collection('study_packs').document()


def get_study_pack_doc(db, pack_id):
    return study_pack_doc_ref(db, pack_id).get()


def get_study_pack_summary_doc(db, pack_id):
    return _get_doc_with_fields(study_pack_doc_ref(db, pack_id), STUDY_PACK_CURSOR_FIELDS)


def study_pack_source_doc_ref(db, pack_id):
    return db.collection('study_pack_sources').document(pack_id)


def get_study_pack_source_doc(db, pack_id):
    return study_pack_source_doc_ref(db, pack_id).get()


def get_study_pack_source_flags_doc(db, pack_id):
    return _get_doc_with_fields(study_pack_source_doc_ref(db, pack_id), STUDY_PACK_SOURCE_FLAG_FIELDS)


def list_study_pack_summaries_by_uid(db, uid, limit, after_doc=None):
    query = apply_where(db.collection('study_packs'), 'uid', '==', uid).order_by('created_at', direction='DESCENDING').limit(limit)
    if after_doc is not None:
        query = query.start_after(after_doc)
    query = _apply_select(query, STUDY_PACK_SUMMARY_FIELDS)
    return list(query.stream())


def list_study_packs_by_uid(db, uid, limit):
    query = apply_where(db.collection('study_packs'), 'uid', '==', uid).order_by('created_at', direction='DESCENDING').limit(limit)
    return list(query.stream())


def list_study_packs_with_audio_flags(db, limit=250):
    try:
        safe_limit = int(limit or 250)
    except Exception:
        safe_limit = 250
    safe_limit = max(1, min(safe_limit, 500))
    docs = []
    seen = set()
    for field_name in ('has_audio_playback', 'has_audio_sync'):
        query = apply_where(db.collection('study_packs'), field_name, '==', True).limit(safe_limit)
        for doc in query.stream():
            doc_id = str(getattr(doc, 'id', '') or '')
            if doc_id in seen:
                continue
            seen.add(doc_id)
            docs.append(doc)
            if len(docs) >= safe_limit:
                return docs
    return docs


def list_study_packs_by_uid_and_folder(db, uid, folder_id):
    return list(apply_where(apply_where(db.collection('study_packs'), 'uid', '==', uid), 'folder_id', '==', folder_id).stream())


def list_study_pack_summaries_by_uid_and_folder(db, uid, folder_id, limit=100):
    query = apply_where(db.collection('study_packs'), 'uid', '==', uid)
    query = apply_where(query, 'folder_id', '==', folder_id).order_by('created_at', direction='DESCENDING')
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    query = _apply_select(query, STUDY_PACK_SUMMARY_FIELDS)
    return list(query.stream())


def study_folder_doc_ref(db, folder_id):
    return db.collection('study_folders').document(folder_id)


def create_study_folder_doc_ref(db):
    return db.collection('study_folders').document()


def get_study_folder_doc(db, folder_id):
    return study_folder_doc_ref(db, folder_id).get()


def list_study_folders_by_uid(db, uid):
    return list(apply_where(db.collection('study_folders'), 'uid', '==', uid).stream())


def interview_code_doc_ref(db, code_id):
    return db.collection('interview_codes').document(code_id)


def create_interview_code_doc_ref(db):
    return db.collection('interview_codes').document()


def get_interview_code_doc(db, code_id):
    return interview_code_doc_ref(db, code_id).get()


def list_interview_codes_by_uid(db, uid, limit=1000):
    query = apply_where(db.collection('interview_codes'), 'uid', '==', uid)
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def interview_quotation_doc_ref(db, quotation_id):
    return db.collection('interview_quotations').document(quotation_id)


def create_interview_quotation_doc_ref(db):
    return db.collection('interview_quotations').document()


def get_interview_quotation_doc(db, quotation_id):
    return interview_quotation_doc_ref(db, quotation_id).get()


def list_interview_quotations_by_uid_and_pack(db, uid, pack_id, limit=2000):
    query = apply_where(db.collection('interview_quotations'), 'uid', '==', uid)
    query = apply_where(query, 'pack_id', '==', pack_id)
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def interview_ai_coding_run_doc_ref(db, run_id):
    return db.collection('interview_ai_coding_runs').document(run_id)


def create_interview_ai_coding_run_doc_ref(db):
    return db.collection('interview_ai_coding_runs').document()


def get_interview_ai_coding_run_doc(db, run_id):
    return interview_ai_coding_run_doc_ref(db, run_id).get()


def list_interview_ai_coding_runs_by_uid_and_pack(db, uid, pack_id, limit=20):
    query = apply_where(db.collection('interview_ai_coding_runs'), 'uid', '==', uid)
    query = apply_where(query, 'pack_id', '==', pack_id)
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def study_share_doc_ref(db, share_token):
    return db.collection('study_shares').document(share_token)


def create_study_share_doc_ref(db, share_token):
    return study_share_doc_ref(db, share_token)


def get_study_share_doc(db, share_token):
    return study_share_doc_ref(db, share_token).get()


def list_study_shares_by_uid(db, uid, limit=200):
    query = apply_where(db.collection('study_shares'), 'owner_uid', '==', uid).order_by('updated_at', direction='DESCENDING')
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def find_study_share_by_owner_and_entity(db, owner_uid, entity_type, entity_id):
    docs = list_study_shares_by_owner_and_entity(db, owner_uid, entity_type, entity_id, limit=1)
    return docs[0] if docs else None


def list_study_shares_by_owner_and_entity(db, owner_uid, entity_type, entity_id, limit=20):
    safe_owner_uid = str(owner_uid or '').strip()
    safe_entity_type = str(entity_type or '').strip()
    safe_entity_id = str(entity_id or '').strip()
    if not safe_owner_uid or not safe_entity_type or not safe_entity_id:
        return []
    query = apply_where(db.collection('study_shares'), 'owner_uid', '==', safe_owner_uid)
    query = apply_where(query, 'entity_type', '==', safe_entity_type)
    query = apply_where(query, 'entity_id', '==', safe_entity_id)
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def study_progress_doc_ref(db, uid):
    return db.collection('study_progress').document(uid)


def study_card_state_doc_ref(db, uid, pack_id):
    return db.collection('study_card_states').document(f"{uid}__{pack_id}")


def list_study_card_states_by_uid(db, uid, limit):
    return apply_where(db.collection('study_card_states'), 'uid', '==', uid).limit(limit).stream()


def list_study_card_state_summaries_by_uid(db, uid, limit):
    query = apply_where(db.collection('study_card_states'), 'uid', '==', uid).limit(limit)
    query = _apply_select(query, STUDY_CARD_STATE_SUMMARY_FIELDS)
    return query.stream()
