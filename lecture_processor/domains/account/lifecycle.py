import os

from lecture_processor.runtime.container import get_runtime
from lecture_processor.domains.study import audio as study_audio


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def count_active_jobs_for_user(uid, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    return resolved_runtime.job_state_service.count_active_jobs_for_user(
        uid,
        jobs_store=resolved_runtime.jobs,
        lock=resolved_runtime.JOBS_LOCK,
    )


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
    card_states, card_states_truncated = list_docs_by_uid('study_card_states', uid, resolved_runtime.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION, runtime=resolved_runtime)

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
                'study_card_states': card_states_truncated,
            },
        },
        'account': {
            'profile': user_profile,
            'study_progress': study_progress,
        },
        'collections': {
            'purchases': purchases,
            'job_logs': job_logs,
            'analytics_events': analytics_events,
            'study_folders': study_folders,
            'study_packs': study_packs,
            'study_card_states': card_states,
        },
    }
