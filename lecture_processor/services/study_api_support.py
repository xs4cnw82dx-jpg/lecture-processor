"""Shared helpers for study API route handlers."""

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.domains.study import export as study_export
from lecture_processor.domains.study import progress as study_progress
from lecture_processor.services import access_service


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
    has_audio_playback = bool(pack.get('has_audio_playback', False))
    has_audio_sync = app_ctx.FEATURE_AUDIO_SECTION_SYNC and bool(pack.get('has_audio_sync', False))
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


def ensure_share_record(app_ctx, owner_uid, entity_type, entity_id):
    share_doc = app_ctx.study_repo.find_study_share_by_owner_and_entity(
        app_ctx.db,
        owner_uid,
        entity_type,
        entity_id,
    )
    now_ts = app_ctx.time.time()
    if share_doc is not None and getattr(share_doc, 'exists', False):
        share_ref = share_doc.reference
        share_payload = share_doc.to_dict() or {}
        share_token = str(share_payload.get('share_token', '') or share_ref.id)
        created_at = float(share_payload.get('created_at', now_ts) or now_ts)
        return share_ref, share_token, now_ts, created_at
    share_token = str(app_ctx.uuid.uuid4()).replace('-', '')
    share_ref = app_ctx.study_repo.create_study_share_doc_ref(app_ctx.db, share_token)
    return share_ref, share_token, now_ts, now_ts


def delete_share_for_entity(app_ctx, owner_uid, entity_type, entity_id):
    if app_ctx.db is None:
        return
    try:
        share_doc = app_ctx.study_repo.find_study_share_by_owner_and_entity(
            app_ctx.db,
            owner_uid,
            entity_type,
            entity_id,
        )
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
