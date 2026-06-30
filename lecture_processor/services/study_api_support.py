"""Shared helpers for study API route handlers."""

import secrets

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.domains.study import export as study_export
from lecture_processor.domains.study import audio as study_audio
from lecture_processor.domains.study import progress as study_progress
from lecture_processor.services import access_service


def build_audio_unavailable_message():
    # Developer note: generated audio is intentionally stored on app-local temporary disk
    # so the deployed app can stay on Render's free plan. Keep that infrastructure detail
    # out of user-facing copy; users only need to know the audio is temporary.
    return 'Audio playback is unavailable because this temporary audio file has been deleted.'


def pack_item_count(pack, count_key, items_key):
    if count_key in pack and pack.get(count_key) is not None:
        try:
            stored_count = int(pack.get(count_key, 0) or 0)
        except Exception:
            stored_count = None
        if stored_count is not None and stored_count >= 0:
            return stored_count
    items = pack.get(items_key, [])
    return len(items) if isinstance(items, list) else 0


def account_write_guard(app_ctx, uid):
    allowed, message = account_lifecycle.ensure_account_allows_writes(uid, runtime=app_ctx)
    if allowed:
        return None
    return app_ctx.jsonify({'error': message, 'status': 'account_deletion_in_progress'}), 409


def require_user(app_ctx, request):
    return access_service.require_allowed_user(app_ctx, request)


def parse_daily_card_goal_input(raw_value, runtime=None):
    if raw_value is None:
        return (True, None)
    if isinstance(raw_value, str) and not str(raw_value).strip():
        return (True, None)
    if isinstance(raw_value, bool):
        return (False, None)
    goal = study_progress.sanitize_daily_card_goal_value(raw_value, runtime=runtime)
    if goal is None:
        return (False, None)
    return (True, goal)


def parse_notes_highlights_input(raw_value, runtime=None):
    if raw_value is None:
        return ('clear', None)
    if isinstance(raw_value, str) and not str(raw_value).strip():
        return ('clear', None)
    if isinstance(raw_value, dict) and not raw_value:
        return ('clear', None)
    payload = study_progress.sanitize_notes_highlights_payload(raw_value, runtime=runtime)
    if payload is None:
        return ('invalid', None)
    return ('set', payload)


def parse_study_pack_limit(raw_value):
    if raw_value is None or (isinstance(raw_value, str) and not raw_value.strip()):
        return 50
    try:
        value = int(raw_value)
    except Exception:
        return None
    return max(1, min(value, 100))


def get_owned_study_pack(app_ctx, uid, pack_id):
    doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
    if not doc.exists:
        return None, app_ctx.jsonify({'error': 'Study pack not found'}), 404
    pack = doc.to_dict() or {}
    if pack.get('uid', '') != uid:
        return None, app_ctx.jsonify({'error': 'Forbidden'}), 403
    return (doc, pack), None, None


def get_study_pack_source_payload(app_ctx, pack_id):
    try:
        doc = app_ctx.study_repo.get_study_pack_source_doc(app_ctx.db, pack_id)
    except Exception as error:
        app_ctx.logger.warning('Could not load source outputs for study pack %s: %s', pack_id, error)
        return {}
    if not getattr(doc, 'exists', False):
        return {}
    payload = doc.to_dict() or {}
    return payload if isinstance(payload, dict) else {}


def get_study_pack_source_flags(app_ctx, pack_id):
    try:
        doc = app_ctx.study_repo.get_study_pack_source_flags_doc(app_ctx.db, pack_id)
    except Exception as error:
        app_ctx.logger.warning('Could not load source flags for study pack %s: %s', pack_id, error)
        doc = None
    if getattr(doc, 'exists', False):
        flags = doc.to_dict() or {}
        if 'has_source_slides' in flags or 'has_source_transcript' in flags:
            return {
                'has_source_slides': bool(flags.get('has_source_slides', False)),
                'has_source_transcript': bool(flags.get('has_source_transcript', False)),
            }

    # Older source docs may not have compact flags yet. Fall back once, but do
    # not expose the large source fields to the normal pack-open response.
    payload = get_study_pack_source_payload(app_ctx, pack_id)
    return {
        'has_source_slides': bool(str(payload.get('slide_text', '') or '').strip()),
        'has_source_transcript': bool(str(payload.get('transcript', '') or '').strip()),
    }


def get_owned_study_folder(app_ctx, uid, folder_id):
    doc = app_ctx.study_repo.get_study_folder_doc(app_ctx.db, folder_id)
    if not doc.exists:
        return None, app_ctx.jsonify({'error': 'Folder not found'}), 404
    folder = doc.to_dict() or {}
    if folder.get('uid', '') != uid:
        return None, app_ctx.jsonify({'error': 'Forbidden'}), 403
    return (doc, folder), None, None


def public_share_origin(app_ctx, request):
    configured = str(getattr(app_ctx, 'PUBLIC_BASE_URL', '') or '').strip().rstrip('/')
    if configured:
        return configured
    if request is not None:
        return str(getattr(request, 'host_url', '') or '').strip().rstrip('/')
    return ''


def build_share_url(app_ctx, request, share_token):
    origin = public_share_origin(app_ctx, request)
    safe_token = str(share_token or '').strip()
    if not origin or not safe_token:
        return ''
    return f'{origin}/shared/{safe_token}'


def serialize_share_state(app_ctx, request, entity_type, entity_id, share_doc=None):
    share_payload = {}
    if share_doc is not None and getattr(share_doc, 'exists', False):
        share_payload = share_doc.to_dict() or {}
    share_token = str(share_payload.get('share_token', '') or '')
    return {
        'entity_type': entity_type,
        'entity_id': entity_id,
        'access_scope': str(share_payload.get('access_scope', 'private') or 'private'),
        'share_url': build_share_url(app_ctx, request, share_token) if share_token else '',
        'updated_at': float(share_payload.get('updated_at', 0) or 0),
    }


def serialize_public_pack(app_ctx, pack_id, pack, *, include_folder=True):
    audio_storage_key = study_audio.get_audio_storage_key_from_pack(pack, runtime=app_ctx)
    has_audio_playback = study_audio.audio_storage_key_has_file(audio_storage_key, runtime=app_ctx)
    audio_unavailable_message = ''
    if audio_storage_key and not has_audio_playback:
        audio_unavailable_message = build_audio_unavailable_message()
    has_audio_sync = (
        app_ctx.FEATURE_AUDIO_SECTION_SYNC
        and has_audio_playback
        and bool(pack.get('has_audio_sync', False))
    )
    return {
        'study_pack_id': pack_id,
        'title': pack.get('title', ''),
        'mode': pack.get('mode', ''),
        'output_language': pack.get('output_language', 'English'),
        'notes_markdown': pack.get('notes_markdown', ''),
        'transcript_segments': pack.get('transcript_segments', []),
        'notes_audio_map': pack.get('notes_audio_map', []) if has_audio_sync else [],
        'has_audio_sync': has_audio_sync,
        'has_audio_playback': has_audio_playback,
        'audio_unavailable_reason': 'missing_audio_file' if audio_unavailable_message else '',
        'audio_unavailable_message': audio_unavailable_message,
        'flashcards': pack.get('flashcards', []),
        'test_questions': pack.get('test_questions', []),
        'interview_summary': pack.get('interview_summary'),
        'interview_sections': pack.get('interview_sections'),
        'interview_combined': pack.get('interview_combined'),
        'study_features': pack.get('study_features', 'none'),
        'interview_features': pack.get('interview_features', []),
        'course': pack.get('course', ''),
        'subject': pack.get('subject', ''),
        'semester': pack.get('semester', ''),
        'block': pack.get('block', ''),
        'folder_id': pack.get('folder_id', '') if include_folder else '',
        'folder_name': pack.get('folder_name', '') if include_folder else '',
        'created_at': pack.get('created_at', 0),
    }


def serialize_public_folder(folder_id, folder):
    return {
        'folder_id': folder_id,
        'name': folder.get('name', ''),
        'parent_folder_id': folder.get('parent_folder_id', ''),
        'sort_order': float(folder.get('sort_order', 0) or 0),
        'course': folder.get('course', ''),
        'subject': folder.get('subject', ''),
        'semester': folder.get('semester', ''),
        'block': folder.get('block', ''),
        'exam_date': folder.get('exam_date', ''),
        'created_at': folder.get('created_at', 0),
        'updated_at': folder.get('updated_at', 0),
    }


def serialize_public_pack_summary(pack_id, pack):
    return {
        'study_pack_id': pack_id,
        'title': pack.get('title', ''),
        'mode': pack.get('mode', ''),
        'flashcards_count': pack_item_count(pack, 'flashcards_count', 'flashcards'),
        'test_questions_count': pack_item_count(pack, 'test_questions_count', 'test_questions'),
        'course': pack.get('course', ''),
        'subject': pack.get('subject', ''),
        'semester': pack.get('semester', ''),
        'block': pack.get('block', ''),
        'folder_id': pack.get('folder_id', ''),
        'folder_name': pack.get('folder_name', ''),
        'created_at': pack.get('created_at', 0),
    }


def get_public_share(app_ctx, share_token):
    if app_ctx.db is None:
        return None, app_ctx.jsonify({'error': 'Sharing is unavailable'}), 503
    doc = app_ctx.study_repo.get_study_share_doc(app_ctx.db, share_token)
    if not doc.exists:
        return None, app_ctx.jsonify({'error': 'Shared content not found'}), 404
    share = doc.to_dict() or {}
    if str(share.get('access_scope', 'private') or 'private') != 'public':
        return None, app_ctx.jsonify({'error': 'Shared content not found'}), 404
    return (doc, share), None, None


def _new_share_token():
    return secrets.token_urlsafe(24)


def find_share_record(app_ctx, owner_uid, entity_type, entity_id):
    try:
        docs = app_ctx.study_repo.list_study_shares_by_owner_and_entity(
            app_ctx.db,
            owner_uid,
            entity_type,
            entity_id,
            limit=20,
        )
        docs = [doc for doc in docs if getattr(doc, 'exists', False)]
        if docs:
            docs.sort(
                key=lambda doc: float((doc.to_dict() or {}).get('updated_at', 0) or 0),
                reverse=True,
            )
            return docs[0]
    except Exception:
        pass
    return app_ctx.study_repo.find_study_share_by_owner_and_entity(
        app_ctx.db,
        owner_uid,
        entity_type,
        entity_id,
    )


def ensure_share_record(app_ctx, owner_uid, entity_type, entity_id, *, requested_scope='private'):
    share_doc = find_share_record(app_ctx, owner_uid, entity_type, entity_id)
    now_ts = app_ctx.time.time()
    if share_doc is not None and getattr(share_doc, 'exists', False):
        share_ref = share_doc.reference
        share_payload = share_doc.to_dict() or {}
        share_token = str(share_payload.get('share_token', '') or share_ref.id)
        created_at = float(share_payload.get('created_at', now_ts) or now_ts)
        if (
            str(requested_scope or '').strip().lower() == 'public'
            and str(share_payload.get('access_scope', 'private') or 'private').strip().lower() != 'public'
        ):
            share_token = _new_share_token()
            share_ref = app_ctx.study_repo.create_study_share_doc_ref(app_ctx.db, share_token)
            created_at = now_ts
        return share_ref, share_token, now_ts, created_at
    share_token = _new_share_token()
    share_ref = app_ctx.study_repo.create_study_share_doc_ref(app_ctx.db, share_token)
    return share_ref, share_token, now_ts, now_ts


def delete_share_for_entity(app_ctx, owner_uid, entity_type, entity_id):
    if app_ctx.db is None:
        return
    try:
        list_matches = getattr(app_ctx.study_repo, 'list_study_shares_by_owner_and_entity', None)
        if callable(list_matches):
            share_docs = list_matches(app_ctx.db, owner_uid, entity_type, entity_id, limit=100)
        else:
            share_doc = app_ctx.study_repo.find_study_share_by_owner_and_entity(
                app_ctx.db,
                owner_uid,
                entity_type,
                entity_id,
            )
            share_docs = [share_doc] if share_doc is not None else []
        for share_doc in share_docs:
            if share_doc is not None and getattr(share_doc, 'exists', False):
                share_doc.reference.delete()
    except Exception as error:
        app_ctx.logger.warning(
            'Could not delete share for %s %s owned by %s: %s',
            entity_type,
            entity_id,
            owner_uid,
            error,
        )


def list_pending_batches_by_folder(app_ctx, uid):
    pending_batches = batch_orchestrator.list_batches_for_uid(
        uid,
        statuses=['queued', 'processing'],
        limit=300,
        runtime=app_ctx,
    )
    pending_by_folder = {}
    for batch in pending_batches:
        folder_id = str(batch.get('folder_id', '') or '').strip()
        if not folder_id:
            continue
        pending_by_folder[folder_id] = int(pending_by_folder.get(folder_id, 0) or 0) + 1
    return pending_by_folder


def normalize_virtual_or_real_folder_parent(raw_parent_id):
    parent_id = str(raw_parent_id or '').strip()
    if parent_id in {'__interviews__', '__voice_notes__'}:
        return parent_id
    return parent_id


def build_folder_descendant_ids(folders, root_folder_id):
    root_id = str(root_folder_id or '').strip()
    children_by_parent = {}
    for folder in folders or []:
        folder_id = str(folder.get('folder_id', '') or '').strip()
        if not folder_id:
            continue
        parent_id = str(folder.get('parent_folder_id', '') or '').strip()
        children_by_parent.setdefault(parent_id, []).append(folder_id)
    descendants = set()
    stack = list(children_by_parent.get(root_id, []))
    while stack:
        folder_id = stack.pop()
        if folder_id in descendants:
            continue
        descendants.add(folder_id)
        stack.extend(children_by_parent.get(folder_id, []))
    return descendants


def build_folder_payloads_from_docs(folder_docs):
    folders = []
    for doc in folder_docs or []:
        folder = doc.to_dict() or {}
        folders.append({
            'folder_id': doc.id,
            'name': folder.get('name', ''),
            'parent_folder_id': str(folder.get('parent_folder_id', '') or '').strip(),
            'sort_order': float(folder.get('sort_order', 0) or 0),
            'course': folder.get('course', ''),
            'subject': folder.get('subject', ''),
            'semester': folder.get('semester', ''),
            'block': folder.get('block', ''),
            'exam_date': folder.get('exam_date', ''),
            'created_at': folder.get('created_at', 0),
            'updated_at': folder.get('updated_at', 0),
        })
    return folders
