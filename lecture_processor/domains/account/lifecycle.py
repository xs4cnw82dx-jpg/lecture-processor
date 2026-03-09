import os

from lecture_processor.runtime.container import get_runtime
from lecture_processor.domains.study import audio as study_audio
from lecture_processor.repositories.query_utils import apply_where


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


ACTIVE_ACCOUNT_JOB_STATES = {'queued', 'starting', 'processing'}
DELETION_FAILURE_REASON_MAX_LENGTH = 300
STUCK_DELETION_AFTER_SECONDS = 60 * 60


def account_write_block_message(runtime=None):
    _ = _resolve_runtime(runtime)
    return 'Account deletion is in progress. New work and credit changes are blocked until deletion finishes.'


def get_user_account_state(uid, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is None or not uid:
        return {}
    try:
        doc = resolved_runtime.users_repo.get_doc(db, uid)
    except Exception:
        return {}
    if not getattr(doc, 'exists', False):
        return {}
    data = doc.to_dict() or {}
    return data if isinstance(data, dict) else {}


def ensure_account_allows_writes(uid, runtime=None):
    account_state = get_user_account_state(uid, runtime=runtime)
    status = str(account_state.get('account_status', '') or '').strip().lower()
    if status == 'deleting':
        return (False, account_write_block_message(runtime=runtime))
    return (True, '')


def _normalize_failure_reason(reason):
    return str(reason or '').strip()[:DELETION_FAILURE_REASON_MAX_LENGTH]


def mark_account_deletion_requested(uid, email='', runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is None or not uid:
        return False
    now_ts = float(resolved_runtime.time.time())
    resolved_runtime.users_repo.set_doc(
        db,
        uid,
        {
            'uid': uid,
            'email': str(email or '').strip(),
            'account_status': 'deleting',
            'delete_requested_at': now_ts,
            'delete_started_at': now_ts,
            'last_delete_failure_at': 0,
            'last_delete_failure_reason': '',
            'updated_at': now_ts,
        },
        merge=True,
    )
    return True


def restore_account_after_failed_deletion(uid, email='', reason='', runtime=None, existing_state=None):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is None or not uid:
        return False
    now_ts = float(resolved_runtime.time.time())
    payload = dict(existing_state or {})
    payload.update({
        'uid': uid,
        'email': str(email or payload.get('email', '') or '').strip(),
        'account_status': 'active',
        'delete_requested_at': 0,
        'delete_started_at': 0,
        'last_delete_failure_at': now_ts,
        'last_delete_failure_reason': _normalize_failure_reason(reason),
        'updated_at': now_ts,
    })
    resolved_runtime.users_repo.set_doc(
        db,
        uid,
        payload,
        merge=not bool(existing_state),
    )
    return True


def get_account_deletion_started_at(account_state):
    state = account_state if isinstance(account_state, dict) else {}
    started_at = state.get('delete_started_at')
    if isinstance(started_at, (int, float)) and started_at > 0:
        return float(started_at)
    requested_at = state.get('delete_requested_at')
    if isinstance(requested_at, (int, float)) and requested_at > 0:
        return float(requested_at)
    return 0.0


def is_stuck_deletion_candidate(account_state, now_ts=None, stale_after_seconds=STUCK_DELETION_AFTER_SECONDS):
    state = account_state if isinstance(account_state, dict) else {}
    status = str(state.get('account_status', '') or '').strip().lower()
    if status != 'deleting':
        return False
    started_at = get_account_deletion_started_at(state)
    if started_at <= 0:
        return False
    try:
        safe_now = float(now_ts if now_ts is not None else _resolve_runtime().time.time())
    except Exception:
        return False
    try:
        safe_stale_after = max(60.0, float(stale_after_seconds or STUCK_DELETION_AFTER_SECONDS))
    except Exception:
        safe_stale_after = float(STUCK_DELETION_AFTER_SECONDS)
    return safe_now - started_at >= safe_stale_after


def query_docs_by_field(collection_name, field_name, field_value, limit, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is None:
        return []
    query = apply_where(resolved_runtime.db.collection(collection_name), field_name, '==', field_value)
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def has_docs_by_field(collection_name, field_name, field_value, runtime=None):
    return bool(query_docs_by_field(collection_name, field_name, field_value, 1, runtime=runtime))


def count_active_jobs_for_user(uid, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not uid:
        return 0

    active_ids = set()
    with resolved_runtime.JOBS_LOCK:
        for job_id, job in (resolved_runtime.jobs or {}).items():
            if not isinstance(job, dict):
                continue
            if str(job.get('user_id', '') or '').strip() != uid:
                continue
            if str(job.get('status', '') or '').strip().lower() in ACTIVE_ACCOUNT_JOB_STATES:
                active_ids.add(f'in-memory:{job_id}')

    db = getattr(resolved_runtime, 'db', None)
    if db is None:
        return len(active_ids)

    try:
        runtime_docs = resolved_runtime.runtime_jobs_repo.query_by_user_and_statuses(
            db,
            resolved_runtime.RUNTIME_JOBS_COLLECTION,
            uid,
            ACTIVE_ACCOUNT_JOB_STATES,
            limit=500,
        )
        for doc in runtime_docs:
            active_ids.add(f'runtime:{doc.id}')
    except Exception as error:
        resolved_runtime.logger.warning("Warning: could not inspect runtime jobs for user %s: %s", uid, error)

    try:
        batch_docs = resolved_runtime.batch_repo.list_batch_jobs_by_uid_and_statuses(
            db,
            uid,
            list(ACTIVE_ACCOUNT_JOB_STATES),
            limit=500,
        )
        for doc in batch_docs:
            active_ids.add(f'batch:{doc.id}')
    except Exception as error:
        resolved_runtime.logger.warning("Warning: could not inspect batch jobs for user %s: %s", uid, error)

    return len(active_ids)


def list_docs_by_uid(collection_name, uid, max_docs, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    docs = resolved_runtime.admin_repo.query_by_uid(resolved_runtime.db, collection_name, uid, max_docs + 1)
    truncated = len(docs) > max_docs
    limited = docs[:max_docs]
    records = []
    for doc in limited:
        data = doc.to_dict() or {}
        data['_id'] = doc.id
        records.append(data)
    return (records, truncated)


def delete_docs_by_uid(collection_name, uid, max_docs, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    docs = resolved_runtime.admin_repo.query_by_uid(resolved_runtime.db, collection_name, uid, max_docs + 1)
    truncated = len(docs) > max_docs
    limited = docs[:max_docs]
    deleted = 0
    for doc in limited:
        try:
            doc.reference.delete()
            deleted += 1
        except Exception as error:
            resolved_runtime.logger.warning(
                "Warning: could not delete doc in %s/%s: %s",
                collection_name,
                doc.id,
                error,
            )
    return (deleted, truncated)


def remove_upload_artifacts_for_job_ids(job_ids, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not job_ids:
        return 0
    try:
        names = os.listdir(resolved_runtime.UPLOAD_FOLDER)
    except Exception:
        return 0
    prefixes = tuple((f"{str(job_id).strip()}_" for job_id in job_ids if str(job_id or '').strip()))
    if not prefixes:
        return 0
    removed = 0
    for name in names:
        if not name.startswith(prefixes):
            continue
        file_path = os.path.join(resolved_runtime.UPLOAD_FOLDER, name)
        try:
            if os.path.isfile(file_path):
                os.remove(file_path)
                removed += 1
        except Exception as error:
            resolved_runtime.logger.warning("Warning: could not delete upload artifact %s: %s", file_path, error)
    return removed


def anonymize_purchase_docs_by_uid(uid, max_docs, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    docs = resolved_runtime.purchases_repo.query_by_uid(resolved_runtime.db, uid, max_docs + 1)
    truncated = len(docs) > max_docs
    limited = docs[:max_docs]
    anonymized = 0
    for doc in limited:
        try:
            doc.reference.set({'uid': '', 'user_erased': True, 'erased_at': resolved_runtime.time.time()}, merge=True)
            anonymized += 1
        except Exception as error:
            resolved_runtime.logger.warning("Warning: could not anonymize purchase doc %s: %s", doc.id, error)
    return (anonymized, truncated)


def collect_user_export_payload(uid, email, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    user_doc = resolved_runtime.users_repo.get_doc(resolved_runtime.db, uid)
    user_profile = user_doc.to_dict() if user_doc.exists else {}
    study_progress_doc = resolved_runtime.study_repo.study_progress_doc_ref(resolved_runtime.db, uid).get()
    study_progress = study_progress_doc.to_dict() if study_progress_doc.exists else {}

    purchases, purchases_truncated = list_docs_by_uid('purchases', uid, resolved_runtime.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION, runtime=resolved_runtime)
    job_logs, job_logs_truncated = list_docs_by_uid('job_logs', uid, resolved_runtime.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION, runtime=resolved_runtime)
    analytics_events, analytics_truncated = list_docs_by_uid('analytics_events', uid, resolved_runtime.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION, runtime=resolved_runtime)
    study_folders, folders_truncated = list_docs_by_uid('study_folders', uid, resolved_runtime.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION, runtime=resolved_runtime)
    study_packs, packs_truncated = list_docs_by_uid('study_packs', uid, resolved_runtime.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION, runtime=resolved_runtime)
    study_pack_sources, sources_truncated = list_docs_by_uid('study_pack_sources', uid, resolved_runtime.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION, runtime=resolved_runtime)
    card_states, card_states_truncated = list_docs_by_uid('study_card_states', uid, resolved_runtime.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION, runtime=resolved_runtime)
    planner_settings_docs, planner_settings_truncated = list_docs_by_uid('planner_settings', uid, resolved_runtime.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION, runtime=resolved_runtime)
    planner_sessions, planner_sessions_truncated = list_docs_by_uid('planner_sessions', uid, resolved_runtime.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION, runtime=resolved_runtime)
    planner_settings = planner_settings_docs[0] if planner_settings_docs else {}

    for pack in study_packs:
        audio_key = study_audio.get_audio_storage_key_from_pack(pack, runtime=resolved_runtime)
        audio_path = study_audio.resolve_audio_storage_path_from_key(audio_key, runtime=resolved_runtime) if audio_key else ''
        pack['audio_filename'] = os.path.basename(audio_path) if audio_path else ''
        pack.pop('audio_storage_path', None)
        pack.pop('audio_storage_key', None)

    return {
        'meta': {
            'exported_at': resolved_runtime.time.time(),
            'version': 1,
            'uid': uid,
            'email': email,
            'source': 'lecture-processor',
            'limits': {'max_docs_per_collection': resolved_runtime.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION},
            'truncated': {
                'purchases': purchases_truncated,
                'job_logs': job_logs_truncated,
                'analytics_events': analytics_truncated,
                'study_folders': folders_truncated,
                'study_packs': packs_truncated,
                'study_pack_sources': sources_truncated,
                'study_card_states': card_states_truncated,
                'planner_settings': planner_settings_truncated,
                'planner_sessions': planner_sessions_truncated,
            },
        },
        'account': {
            'profile': user_profile,
            'study_progress': study_progress,
            'planner_settings': planner_settings,
        },
        'collections': {
            'purchases': purchases,
            'job_logs': job_logs,
            'analytics_events': analytics_events,
            'study_folders': study_folders,
            'study_packs': study_packs,
            'study_pack_sources': study_pack_sources,
            'study_card_states': card_states,
            'planner_sessions': planner_sessions,
        },
    }


EXPORT_BUNDLE_KEYS = (
    'flashcards_csv',
    'practice_tests_csv',
    'lecture_notes_docx',
    'lecture_notes_pdf_marked',
    'lecture_notes_pdf_unmarked',
    'account_json',
)


def normalize_export_bundle_include(payload_include, runtime=None):
    _ = runtime
    include = payload_include if isinstance(payload_include, dict) else {}
    normalized = {}
    for key in EXPORT_BUNDLE_KEYS:
        normalized[key] = bool(include.get(key))
    return normalized


def has_export_bundle_selection(include_map, runtime=None):
    _ = runtime
    if not isinstance(include_map, dict):
        return False
    return any(bool(include_map.get(key)) for key in EXPORT_BUNDLE_KEYS)
