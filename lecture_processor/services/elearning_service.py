"""Permission-checked service layer for xPEDitie Pijn E-Learning Studio."""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import re
import secrets
import time
from collections import Counter, OrderedDict
from itertools import chain
from statistics import median
from threading import Lock
from copy import deepcopy

from flask import current_app, g, jsonify, request, send_file
from google.cloud.firestore_v1.field_path import FieldPath
from itsdangerous import BadSignature, URLSafeTimedSerializer

from lecture_processor.domains.account import lifecycle
from lecture_processor.domains.books.model import BookError
from lecture_processor.domains.elearning import model
from lecture_processor.domains.shared import sanitize_csv_cell, sanitize_csv_row
from lecture_processor.repositories.elearning_repo import ElearningStore
from lecture_processor.services import access_service, book_storage, elearning_storage

# Cache only already-public totals. Access, share settings and visibility are
# checked before looking up a value, including on a cache hit.
_peer_cache = OrderedDict()
_peer_lock = Lock()
_peer_read_locks = [Lock() for _ in range(8)]
PEER_RESULT_SECONDS = 20
LEASE_SECONDS = 60
MAX_AUDIO_BYTES = 15 * 1024 * 1024
ALLOWED_AUDIO_MIMES = {
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/ogg': 'ogg',
    'audio/wav': 'wav',
    'audio/webm': 'webm',
}
_SHARE_TOKEN_RE = re.compile(r'^[a-zA-Z0-9_-]{8,96}$')
_SESSION_ID_RE = re.compile(r'^[a-zA-Z0-9_-]{8,80}$')
_COHORT_RE = re.compile(r'^[a-zA-Z0-9_.-]{0,48}$')


def now() -> float:
    return time.time()


def _digest(value: object) -> str:
    return hashlib.sha256(str(value).encode('utf-8')).hexdigest()


def _store(runtime) -> ElearningStore:
    return ElearningStore(runtime.db)


def _exp_path(expedition_id: str) -> str:
    return 'elearning_expeditions/' + model.identifier(expedition_id, 'expedition id')


def _grant_serializer() -> URLSafeTimedSerializer:
    return URLSafeTimedSerializer(current_app.secret_key, salt='elearning-grant-v1')


def payload() -> dict:
    raw = request.get_json(silent=True)
    if not isinstance(raw, dict):
        raise model.ElearningError('Expected a JSON object body.', 400)
    return raw


def identity(runtime, required: bool = False):
    if hasattr(g, 'elearning_user'):
        user = g.elearning_user
    else:
        user = _request_identity(runtime)
        g.elearning_user = user
    if required and not user:
        raise model.ElearningError('Sign in to open xPEDitie Pijn Studio.', 401)
    return user


def _request_identity(runtime):
    user = None
    if request.headers.get('Authorization'):
        user, error, status = access_service.require_authenticated_user(runtime, request)
        if error is not None:
            raise model.ElearningError('Please sign in again to continue.', status)
    if user:
        allowed, message = lifecycle.ensure_account_allows_writes(user['uid'], runtime=runtime)
        if not allowed:
            raise model.ElearningError(message, 409)
    return user


def _verified_member_email(user):
    if not user or user.get('email_verified') is not True:
        return ''
    return str(user.get('email') or '').strip().lower()


def _author_key(email):
    return 'academy_authors/' + _digest(email)


def academy_removal_key(email):
    return 'academy_account_removals/' + _digest(email)


def _allow_invitation(runtime, unit, email):
    if not current_app.config.get('XPED_ACADEMY'):
        return
    lock = unit.get(academy_removal_key(email))
    if not lock:
        return
    # If Firebase removed the account but the response was lost before the
    # database acknowledgment, a later explicit invitation can recover safely.
    marker = unit.get(lifecycle.ACCOUNT_DELETIONS_COLLECTION + '/' + lock['uid']) or {}
    if marker.get('status') == 'auth_delete_pending' and runtime.academy_identity_removed(lock['uid']):
        unit.delete(academy_removal_key(email))
        unit.put(lifecycle.ACCOUNT_DELETIONS_COLLECTION + '/' + lock['uid'], {'status': 'deleted'})
        return
    raise model.ElearningError('This account is being removed.', 409)


def _can_author(runtime, user, unit=None):
    if not current_app.config.get('XPED_ACADEMY'):
        return True
    email = _verified_member_email(user)
    if not email:
        return False
    if _is_studio_admin(runtime, user):
        return True
    db = unit if unit is not None else _store(runtime)
    invite = db.get(_author_key(email))
    return bool(invite and invite.get('email') == email)


def _require_author(runtime, user, unit=None):
    if not _can_author(runtime, user, unit):
        raise model.ElearningError('An author invitation is required for this action.', 403)


def _role_rank(role: str) -> int:
    return {'owner': 3, 'edit': 2, 'translate': 1}.get(role, 0)


def access(runtime, expedition_id: str, required: str = 'translate', unit=None):
    db = unit if unit is not None else _store(runtime)
    exp = db.get(_exp_path(expedition_id))
    if not exp or exp.get('deleted') or exp.get('copying'):
        raise model.ElearningError('This expedition is unavailable.', 404)

    user = identity(runtime, required=False)
    uid = user['uid'] if user else ''
    email = _verified_member_email(user)
    if unit and uid and current_app.config.get('XPED_ACADEMY'):
        marker = unit.get(lifecycle.ACCOUNT_DELETIONS_COLLECTION + '/' + uid)
        if marker and marker.get('status') != 'cancelled':
            raise model.ElearningError('This account is being removed.', 409)
    role = ''
    grant_lang = ''
    who = {
        'id': uid,
        'email': email,
        'name': model.safe_text((user or {}).get('name') or (email.split('@')[0] if email else 'Collaborator'), 60),
        'grant_id': '',
    }

    if uid and exp.get('owner_uid') == uid:
        _require_author(runtime, user, db)
        role = 'owner'
    elif email and email in (exp.get('members') or {}):
        member_role = str(exp['members'][email])
        if member_role in ('edit', 'translate'):
            role = member_role

    grant_header = str(request.headers.get('X-Elearning-Access', '') or '').strip()
    if grant_header:
        try:
            claims = _grant_serializer().loads(grant_header, max_age=86400 * 14)
            grant = db.get('elearning_grants/' + model.identifier(claims['grant'], 'grant'))
        except (BadSignature, KeyError, ValueError, model.ElearningError):
            grant = None
        if (
            grant
            and grant.get('expedition_id') == expedition_id
            and not grant.get('revoked')
            and (not grant.get('expires_at') or grant['expires_at'] > now())
        ):
            grant_role = str(grant.get('role') or 'translate')
            if _role_rank(grant_role) > _role_rank(role):
                role = grant_role
                grant_lang = str(grant.get('target_language') or '')
                who['grant_id'] = grant['id']
            if not uid:
                who['id'] = str(claims.get('guest') or grant['id'])
                who['name'] = model.safe_text(claims.get('name') or grant.get('label') or 'Translator', 60)

    if not role:
        raise model.ElearningError('You do not have access to this expedition.', 403)
    if required == 'owner' and role != 'owner':
        raise model.ElearningError('Only the expedition owner can change this setting.', 403)
    if required == 'edit' and role not in ('owner', 'edit'):
        raise model.ElearningError('Translator access only allows editing translations.', 403)
    if required == 'translate' and role not in ('owner', 'edit', 'translate'):
        raise model.ElearningError('You do not have permission to view this expedition.', 403)
    return db, exp, role, who, grant_lang


def _public_studio_view(exp: dict, role: str, grant_lang: str = '') -> dict:
    view = {
        k: v
        for k, v in exp.items()
        if k not in ('lease', 'member_emails', '_id') and not k.startswith('_')
    }
    if role != 'owner':
        for key in ('members', 'owner_uid', 'owner_email', 'folder_id'):
            view.pop(key, None)
    if role == 'translate':
        view.pop('share', None)
    elif 'share' in view:
        share = view['share'] or {}
        view['share'] = {**share, 'collectResponses': model.collects_responses(share)}
    lease = exp.get('lease') or {}
    view['editor'] = (
        {'name': lease.get('name', ''), 'expires_at': lease.get('expires_at', 0), 'user_id': lease.get('user_id', '')}
        if lease.get('expires_at', 0) > now()
        else None
    )
    view['role'] = role
    if grant_lang:
        view['grantTargetLanguage'] = grant_lang
    return view


def _summary_card(exp: dict, role: str) -> dict:
    modules = exp.get('modules') or []
    step_count = sum(len(m.get('steps') or []) for m in modules)
    share = exp.get('share') or {}
    start_page = exp.get('startPage') or {}
    cover_media = model.safe_media_ref((start_page.get('heroMediaOverrides') or {}).get(exp.get('defaultLanguage')))
    if cover_media['kind'] == 'none':
        cover_media = model.safe_media_ref(start_page.get('heroMedia'))
    return {
        'id': exp['id'],
        'title': exp.get('title', 'Untitled Expedition'),
        'defaultLanguage': exp.get('defaultLanguage', 'nl'),
        'enabledLanguages': exp.get('enabledLanguages', ['nl']),
        'moduleCount': len(modules),
        'stepCount': step_count,
        'revision': exp.get('revision', 1),
        'role': role,
        'deletionPending': bool(exp.get('deleted')),
        'collectResponses': model.collects_responses(share),
        'shareEnabled': bool(share.get('enabled') and not exp.get('deleted')),
        'shareToken': share.get('token', '') if role in ('owner', 'edit') else '',
        'coverMedia': cover_media,
        'languageCoverage': model.compute_language_coverage(exp),
        'updatedAt': exp.get('updated_at', 0),
        'createdAt': exp.get('created_at', 0),
    }


def _assert_lease(exp: dict, who: dict, body: dict) -> None:
    if not exp or exp.get('deleted'):
        raise model.ElearningError('This expedition is no longer available.', 409)
    lease = exp.get('lease') or {}
    session_hdr = str(request.headers.get('X-Elearning-Session', '') or '')
    lease_token = str(body.get('lease_token', '') or '')
    if (
        lease.get('expires_at', 0) <= now()
        or lease.get('user_id') != who['id']
        or not secrets.compare_digest(str(lease.get('token_hash', '')), _digest(lease_token))
        or lease.get('session') != session_hdr
    ):
        raise model.ElearningError('Your editing turn has expired. Click Resume Editing to continue.', 409)
    revision = body.get('base_revision')
    if type(revision) is not int or revision != exp.get('revision', 1):
        raise model.ElearningError('A newer version was saved by a collaborator. Reload before saving.', 409)


def list_expeditions(runtime):
    user = identity(runtime, required=True)
    db = _store(runtime)
    email = _verified_member_email(user)
    academy = current_app.config.get('XPED_ACADEMY')
    can_create = _can_author(runtime, user, db)
    # The Academy folder selector includes the owner's whole library, including transfers.
    limit = None if academy else 200
    owned = db.stream('elearning_expeditions', 'owner_uid', user['uid'], limit=limit) if can_create else ()
    shared = db.stream('elearning_expeditions', 'member_emails', email, 'array_contains', limit=limit) if email else ()
    combined = {}
    for exp in chain(owned, shared):
        if exp.get('copying') or (exp.get('deleted') and exp.get('owner_uid') != user['uid']):
            continue
        eid = exp.get('id') or exp.get('_id')
        if not eid:
            continue
        role = 'owner' if exp.get('owner_uid') == user['uid'] else str((exp.get('members') or {}).get(email, ''))
        if not role or (role == 'owner' and not can_create):
            continue
        combined[eid] = _summary_card(exp, role)
        if role == 'owner' and academy:
            combined[eid]['folderId'] = exp.get('folder_id', '')
    items = sorted(combined.values(), key=lambda x: x.get('updatedAt', 0), reverse=True)
    capabilities = {'canCreate': can_create} if academy else {}
    if academy and can_create:
        folders = db.list(f"academy_users/{user['uid']}/folders", limit=None)
        capabilities['folders'] = sorted((
            {'id': folder['_id'], 'name': folder['name'], 'deleting': bool(folder.get('deleting'))}
            for folder in folders
        ), key=lambda folder: (folder['name'].casefold(), folder['id']))
    return jsonify(expeditions=items, storageAvailable=book_storage.configured(),
                   studioAdmin=_is_studio_admin(runtime, user), **capabilities)


def _insert_expedition(runtime, user, db, doc, *, source_id=None):
    if not doc.get('copying') and model.media_ids(doc):
        raise model.ElearningError('Create the expedition before attaching uploaded media.', 400)

    def insert(tx):
        _require_author(runtime, user, tx)
        if source_id and current_app.config.get('XPED_ACADEMY'):
            access(runtime, source_id, 'edit', unit=tx)
        owner = doc['owner_uid']
        profile = tx.get('users/' + owner) or {}
        deleting = tx.get(lifecycle.ACCOUNT_DELETIONS_COLLECTION + '/' + owner) or {}
        if profile.get('account_status') in ('deleting', 'deleted') or (deleting and deleting.get('status') != 'cancelled'):
            raise model.ElearningError('This account is being removed.', 409)
        tx.put(_exp_path(doc['id']), doc)
        tx.put('elearning_share_index/' + doc['share']['token'], {
            'expedition_id': doc['id'], 'updated_at': doc['updated_at'],
        })
    db.atomic(insert)


def preview_import(runtime):
    _require_author(runtime, identity(runtime, required=True))
    raw = payload()
    if not isinstance(raw.get('modules'), list):
        raise model.ElearningError('Choose an expedition JSON file containing a list of stations.', 400)
    for module in raw['modules']:
        if not isinstance(module, dict) or not isinstance(module.get('steps'), list):
            raise model.ElearningError('Each imported station must contain a list of steps.', 400)
        for step in module['steps']:
            if not isinstance(step, dict) or not isinstance(step.get('blocks'), list):
                raise model.ElearningError('Each imported step must contain a list of blocks.', 400)
    course = model.validate_authored_expedition(raw)
    if model.media_ids(course):
        raise model.ElearningError('This JSON references uploaded files. Duplicate the original expedition to include its media, or remove these references before importing.', 400)
    ids = set()
    for module in course['modules']:
        items = [module, *module['steps']]
        for step in module['steps']:
            items.extend(step['blocks'])
        for item in items:
            if item['id'] in ids:
                raise model.ElearningError('Two items have the same ID. Give each station, step and block its own ID before importing.', 400)
            ids.add(item['id'])
    return jsonify(title=course['title'], enabledLanguages=course['enabledLanguages'],
                   stationCount=len(course['modules']), stepCount=sum(len(module['steps']) for module in course['modules']))


def create_expedition(runtime):
    user = identity(runtime, required=True)
    _require_author(runtime, user)
    raw = payload()
    if raw.get('modules') is not None or raw.get('startPage') is not None:
        normalized = model.validate_authored_expedition(raw)
    else:
        title = str(raw.get('title') or 'xPEDitie Pijn — Nieuw ontwerp')
        if len(title.strip()) > 200:
            raise model.ElearningError('Use at most 200 characters for the expedition title.', 400)
        normalized = model.build_default_expedition(
            title=title,
            default_lang=str(raw.get('defaultLanguage') or 'nl'),
        )
    eid = model.new_id('exp')
    share_token = 'xped-' + secrets.token_urlsafe(12).replace('-', '').replace('_', '')[:14]
    ts = now()
    doc = {
        **normalized,
        'id': eid,
        'owner_uid': user['uid'],
        'owner_email': str(user.get('email', '') or '').strip().lower(),
        'members': {},
        'member_emails': [],
        'share': {
            'enabled': False,
            'token': share_token,
            'collectResponses': False,
            'showPeerResults': False,
            'collectPilotFeedback': False,
            'pausedMessage': 'Deze testmodule is tijdelijk gepauzeerd.',
        },
        'revision': 1,
        'created_at': ts,
        'updated_at': ts,
        'deleted': False,
        'lease': {},
    }
    db = _store(runtime)
    _insert_expedition(runtime, user, db, doc)
    return jsonify(expedition=_public_studio_view(doc, 'owner')), 201


def get_expedition(runtime, expedition_id: str):
    _, exp, role, _, grant_lang = access(runtime, expedition_id, required='translate')
    return jsonify(expedition=_public_studio_view(exp, role, grant_lang), storageAvailable=book_storage.configured())


def revision(runtime, expedition_id: str):
    _, exp, _, _, _ = access(runtime, expedition_id, required='translate')
    lease = exp.get('lease') or {}
    editor = {
        'name': lease.get('name', ''),
        'expires_at': lease.get('expires_at', 0),
        'updated_at': lease.get('updated_at', 0),
    } if lease.get('expires_at', 0) > now() else None
    return jsonify(revision=exp.get('revision', 1), updatedAt=exp.get('updated_at', 0), editor=editor)


def lease(runtime, expedition_id: str):
    db, _, _, who, _ = access(runtime, expedition_id, required='edit')
    body = payload()
    action = str(body.get('action') or 'acquire').strip()
    session_hdr = str(request.headers.get('X-Elearning-Session', '') or '').strip()
    if not session_hdr or len(session_hdr) > 120:
        raise model.ElearningError('Missing editing session header.', 400)
    token = secrets.token_urlsafe(24)

    def txn(unit):
        _, current, _, _, _ = access(runtime, expedition_id, 'edit', unit=unit)
        cur_lease = current.get('lease') or {}
        active = cur_lease.get('expires_at', 0) > now()
        is_mine = active and cur_lease.get('user_id') == who['id'] and cur_lease.get('session') == session_hdr
        if action == 'release':
            if is_mine:
                current['lease'] = {}
                unit.put(_exp_path(expedition_id), current)
            return {'released': True, 'revision': current.get('revision', 1)}
        if active and not is_mine and not body.get('takeover'):
            return {
                'granted': False,
                'same_account': cur_lease.get('user_id') == who['id'],
                'editor': {
                    'name': cur_lease.get('name', 'Collaborator'),
                    'expires_at': cur_lease.get('expires_at', 0),
                    'updated_at': cur_lease.get('updated_at', 0),
                },
                'revision': current.get('revision', 1),
            }
        ts_now = now()
        expires_at = ts_now + LEASE_SECONDS
        current['lease'] = {
            'user_id': who['id'],
            'name': who['name'],
            'session': session_hdr,
            'token_hash': _digest(token),
            'updated_at': ts_now,
            'expires_at': expires_at,
        }
        unit.put(_exp_path(expedition_id), current)
        return {
            'granted': True,
            'lease_token': token,
            'expires_at': expires_at,
            'revision': current.get('revision', 1),
        }

    result = db.atomic(txn)
    return jsonify(result)


def save_expedition(runtime, expedition_id: str):
    db, _, role, who, _ = access(runtime, expedition_id, required='edit')
    body = payload()
    normalized = model.validate_authored_expedition(body)
    edited_lang = model.normalize_lang(body.get('editedLanguage') or normalized['defaultLanguage'])

    def txn(unit):
        _, current, _, _, _ = access(runtime, expedition_id, 'edit', unit=unit)
        _assert_lease(current, who, body)
        next_exp = deepcopy(current)
        next_exp.update(normalized)
        elearning_storage.attach_new_media(unit, current, next_exp)
        model.mark_translations_for_review(current, next_exp, edited_lang)
        next_exp['revision'] = int(current.get('revision', 1)) + 1
        next_exp['updated_at'] = now()
        unit.put(_exp_path(expedition_id), next_exp)
        return next_exp

    saved = db.atomic(txn)
    return jsonify(expedition=_public_studio_view(saved, role))


def delete_expedition(runtime, expedition_id: str):
    user = identity(runtime, required=True)
    elearning_storage.delete_expedition(
        _store(runtime), model.identifier(expedition_id), user['uid'],
        authorize=lambda unit: _require_author(runtime, user, unit),
    )
    return jsonify(deleted=True)


def duplicate_expedition(runtime, expedition_id: str):
    user = identity(runtime, required=True)
    _require_author(runtime, user)
    db, exp, _, _, _ = access(runtime, expedition_id, required='edit')
    copy_payload = model.normalize_expedition_payload(exp)
    copy_payload['title'] = (copy_payload['title'] + ' (Copy)')[:200]
    new_eid = model.new_id('exp')
    share_token = 'xped-' + secrets.token_urlsafe(12).replace('-', '').replace('_', '')[:14]
    ts = now()
    doc = {
        **copy_payload,
        'id': new_eid,
        'owner_uid': user['uid'],
        'owner_email': str(user.get('email', '') or '').strip().lower(),
        'members': {},
        'member_emails': [],
        'share': {
            'enabled': False,
            'token': share_token,
            'collectResponses': False,
            'showPeerResults': False,
            'collectPilotFeedback': False,
            'pausedMessage': 'Deze testmodule is tijdelijk gepauzeerd.',
        },
        'revision': 1,
        'created_at': ts,
        'updated_at': ts,
        'deleted': False,
        'lease': {},
    }
    asset_ids = model.media_ids(doc)
    if asset_ids:
        doc['copying'] = True
    _insert_expedition(runtime, user, db, doc, source_id=expedition_id)
    if asset_ids:
        try:
            def authorize_copy(unit):
                access(runtime, expedition_id, 'edit', unit=unit)
                _require_author(runtime, user, unit)

            cloned = {}
            for source_id in asset_ids:
                original = db.get('elearning_assets/' + source_id)
                if not original or original['expedition_id'] != expedition_id:
                    raise model.ElearningError('A referenced media file is unavailable.', 409)
                aid = model.new_id('ast')
                ext = original['path'].rsplit('.', 1)[-1]
                meta = {**original, 'id': aid, 'expedition_id': new_eid, 'uploaded_by': user['uid'],
                        'created_at': ts, 'path': f'elearning/{new_eid}/{aid}.{ext}'}
                elearning_storage.store_asset(db, meta, elearning_storage.read_asset(db, original),
                                             authorize=authorize_copy if current_app.config.get('XPED_ACADEMY') else None)
                cloned[source_id] = aid
            def publish_copy(unit):
                _require_author(runtime, user, unit)
                access(runtime, expedition_id, 'edit', unit=unit)
                copy = unit.get(_exp_path(new_eid))
                if not copy or copy.get('deleted'):
                    raise model.ElearningError('This copy is no longer available.', 409)
                for ref in model.media_refs(copy):
                    if isinstance(ref, dict) and ref.get('kind') == 'asset':
                        ref['assetId'] = cloned[ref['assetId']]
                copy.pop('copying', None)
                unit.put(_exp_path(new_eid), copy)
                return copy
            doc = db.atomic(publish_copy)
        except Exception:
            elearning_storage.delete_expedition(db, new_eid, user['uid'])
            raise
    return jsonify(expedition=_public_studio_view(doc, 'owner')), 201


def _is_studio_admin(runtime, user):
    if not runtime.is_admin_user(user):
        return False
    if runtime.XPED_STUDIO_ADMIN_UID:
        return user['uid'] == runtime.XPED_STUDIO_ADMIN_UID
    if runtime.ADMIN_UIDS:
        return runtime.ADMIN_UIDS == {user['uid']}
    email = _verified_member_email(user)
    return bool(email and runtime.ADMIN_EMAILS == {email})


def _require_studio_admin(runtime):
    user = identity(runtime, required=True)
    if not _is_studio_admin(runtime, user):
        raise model.ElearningError('Studio admin access is required.', 403)
    return user


def academy_authors(runtime):
    admin = _require_studio_admin(runtime)
    db = _store(runtime)
    if request.method == 'GET':
        invites = db.list('academy_authors', limit=None, fields=['email'])
        admin_email = _verified_member_email(admin)
        return jsonify(authors=sorted(row['email'] for row in invites if row['email'] != admin_email))
    request.max_content_length = 4096
    body = payload()
    email = model.safe_email(body.get('email'))
    if email == _verified_member_email(admin):
        raise model.ElearningError('The Studio administrator already has author access.', 400)
    if body.get('action') == 'grant':
        def grant(tx):
            _allow_invitation(runtime, tx, email)
            tx.put(_author_key(email), {'email': email})
        db.atomic(grant)
    elif body.get('action') == 'revoke':
        db.delete(_author_key(email))
    else:
        raise model.ElearningError('Choose grant or revoke.', 400)
    return jsonify(ok=True)


def studio_statistics(runtime):
    user = _require_studio_admin(runtime)
    db = _store(runtime)
    courses = db.list('elearning_expeditions', 'owner_uid', user['uid'], limit=None,
                      fields=['title', 'deleted', 'copying'])
    rows = []
    for course in courses:
        if course.get('deleted') or course.get('copying'):
            continue
        eid = course['_id']
        course_filter = [('expedition_id', '==', eid)]
        completed = db.count('elearning_responses', [*course_filter, ('completed', '==', True)])
        sessions = db.count('elearning_responses', course_filter)
        rows.append({'id': eid, 'title': course.get('title') or 'Untitled Expedition',
                     'sessions': sessions, 'completed': completed})
    return jsonify(courses=sorted(rows, key=lambda row: row['title'].casefold()),
                   sessions=sum(row['sessions'] for row in rows), completed=sum(row['completed'] for row in rows))


def export_course_content(runtime, expedition_id: str):
    _, course, _, _, _ = access(runtime, expedition_id, required='edit')
    # The authoring schema is the allowlist, including hidden draft stations and translations.
    titles = dict(course.get('localizedTitle') or {})
    lang = course.get('defaultLanguage', 'nl')
    titles[lang] = course.get('title') or titles.get(lang) or 'Untitled Expedition'
    raw = {**course, 'title': titles}
    try:
        content = model.validate_authored_expedition(raw)
        exceeds_limits = False
    except model.CourseSizeLimit:
        content = model.normalize_stored_for_export(raw)
        exceeds_limits = True
    excluded_uploads = len(model.media_ids(content))
    for ref in model.media_refs(content):
        if isinstance(ref, dict) and ref.get('kind') == 'asset':
            ref.update(model.safe_media_ref(None))
    for module in content['modules']:
        for step in module['steps']:
            step.pop('authorNotes', None)
            for block in step['blocks']:
                if block['type'] == 'custom_visual':
                    block['data'].pop('agentBrief', None)
                    block['data'].pop('slotId', None)
    # A localized title is accepted by the import API. Avoid dropping translated course titles.
    content['title'] = content.pop('localizedTitle')
    if exceeds_limits:
        # An oversized author note or design brief was removed from this download.
        # Only flag the material if its portable fields still exceed an import limit.
        try:
            model.validate_authored_expedition(content)
            exceeds_limits = False
        except model.CourseSizeLimit:
            pass
    return jsonify(course=content, excludedUploads=excluded_uploads, exceedsImportLimits=exceeds_limits)


def sharing(runtime, expedition_id: str, *, admin=False):
    if admin:
        _require_studio_admin(runtime)
    required = 'owner' if admin or request.method == 'POST' else 'edit'
    db, exp, role, _, _ = access(runtime, expedition_id, required=required)
    if request.method != 'POST':
        grants = [
            {
                'id': g['id'],
                'role': g.get('role', 'translate'),
                'targetLanguage': g.get('target_language', 'de'),
                'label': g.get('label', ''),
                'revoked': bool(g.get('revoked')),
                'createdAt': g.get('created_at', 0),
                'urlPath': '/elearning/translate/' + g['token'] if not g.get('revoked') else '',
            }
            for g in db.list('elearning_grants', 'expedition_id', expedition_id)
            if not g.get('revoked')
        ]
        members = [{'email': em, 'role': r} for em, r in sorted((exp.get('members') or {}).items())]
        share = dict(exp.get('share') or {})
        share['collectResponses'] = model.collects_responses(share)
        return jsonify(share=share, members=members if role == 'owner' else [], grants=grants if role == 'owner' else [])

    body = payload()
    action = str(body.get('action') or 'update_public').strip()

    def change(unit):
        _, exp, _, _, _ = access(runtime, expedition_id, 'owner', unit=unit)
        if action == 'update_public':
            share = dict(exp.get('share') or {})
            previous = model.response_collection_options(share)
            share['collectResponses'] = previous['collectResponses']
            if 'collectResponses' in body:
                if type(body['collectResponses']) is not bool:
                    raise model.ElearningError('Choose a response collection setting.', 400)
                share['collectResponses'] = body['collectResponses']
            if 'enabled' in body:
                share['enabled'] = bool(body['enabled'])
            if 'showPeerResults' in body:
                share['showPeerResults'] = bool(body['showPeerResults'])
            if 'collectPilotFeedback' in body:
                share['collectPilotFeedback'] = bool(body['collectPilotFeedback'])
            if 'allowStepComments' in body:
                share['allowStepComments'] = bool(body['allowStepComments'])
            if model.response_collection_options(share) != previous:
                share['collectionVersion'] = secrets.token_urlsafe(12)
            if 'pausedMessage' in body:
                share['pausedMessage'] = model.safe_text(body['pausedMessage'], 400)
            if body.get('rotateToken'):
                old_token = share.get('token', '')
                new_token = 'xped-' + secrets.token_urlsafe(12).replace('-', '').replace('_', '')[:14]
                share['token'] = new_token
                if old_token:
                    unit.delete('elearning_share_index/' + old_token)
                unit.put('elearning_share_index/' + new_token, {'expedition_id': expedition_id, 'updated_at': now()})
            exp['share'] = share
            exp['updated_at'] = now()
            unit.put(_exp_path(expedition_id), exp)
            return jsonify(share=share)

        if action == 'add_member':
            email = model.safe_email(body.get('email'))
            _allow_invitation(runtime, unit, email)
            member_role = str(body.get('role') or 'edit').strip()
            if member_role not in ('edit', 'translate'):
                raise model.ElearningError('Role must be edit or translate.', 400)
            members = dict(exp.get('members') or {})
            if len(members) >= 20 and email not in members:
                raise model.ElearningError('Maximum 20 collaborators per expedition.', 400)
            members[email] = member_role
            exp['members'] = members
            exp['member_emails'] = sorted(members.keys())
            exp['updated_at'] = now()
            unit.put(_exp_path(expedition_id), exp)
            return jsonify(members=[{'email': em, 'role': r} for em, r in sorted(members.items())])

        if action == 'remove_member':
            email = model.safe_email(body.get('email'))
            members = dict(exp.get('members') or {})
            members.pop(email, None)
            exp['members'] = members
            exp['member_emails'] = sorted(members.keys())
            exp['updated_at'] = now()
            unit.put(_exp_path(expedition_id), exp)
            return jsonify(members=[{'email': em, 'role': r} for em, r in sorted(members.items())])

        if action == 'create_grant':
            grant_role = str(body.get('role') or 'translate').strip()
            if grant_role not in ('translate', 'edit'):
                raise model.ElearningError('Grant role must be translate or edit.', 400)
            target_lang = model.normalize_lang(body.get('targetLanguage') or 'de')
            label = model.safe_text(body.get('label') or f'{target_lang.upper()} Editor', 80).strip()
            gid = model.new_id('grt')
            raw_token = secrets.token_urlsafe(24)
            grant_doc = {
                'id': gid,
                'expedition_id': expedition_id,
                'role': grant_role,
                'target_language': target_lang,
                'label': label,
                'token': raw_token,
                'token_hash': _digest(raw_token),
                'revoked': False,
                'created_at': now(),
                'expires_at': 0,
            }
            unit.put('elearning_grants/' + gid, grant_doc)
            unit.put('elearning_grant_tokens/' + _digest(raw_token), {'grant_id': gid, 'expedition_id': expedition_id})
            return jsonify(grant={
                'id': gid,
                'role': grant_role,
                'targetLanguage': target_lang,
                'label': label,
                'urlPath': '/elearning/translate/' + raw_token,
            }), 201

        if action == 'revoke_grant':
            gid = model.identifier(body.get('grantId'), 'grant id')
            grant = unit.get('elearning_grants/' + gid)
            if not grant or grant.get('expedition_id') != expedition_id:
                raise model.ElearningError('Invite link not found.', 404)
            grant['revoked'] = True
            unit.put('elearning_grants/' + gid, grant)
            if grant.get('token_hash'):
                unit.delete('elearning_grant_tokens/' + grant['token_hash'])
            return jsonify(revoked=True)

        raise model.ElearningError('Unsupported sharing action.', 400)

    return db.atomic(change)


def exchange_grant(runtime):
    body = payload()
    raw_token = str(body.get('token') or '').strip()
    if len(raw_token) < 16 or len(raw_token) > 128:
        raise model.ElearningError('This translator link is invalid.', 404)
    db = _store(runtime)
    idx = db.get('elearning_grant_tokens/' + _digest(raw_token))
    if not idx:
        raise model.ElearningError('This translator link is invalid or has been revoked.', 404)
    grant = db.get('elearning_grants/' + model.identifier(idx['grant_id'], 'grant'))
    if not grant or grant.get('revoked'):
        raise model.ElearningError('This translator link has been revoked.', 410)
    guest_name = model.safe_text(body.get('name') or grant.get('label') or 'Translator', 60)
    signed = _grant_serializer().dumps({
        'grant': grant['id'],
        'guest': 'guest_' + secrets.token_hex(6),
        'name': guest_name,
    })
    return jsonify(
        accessToken=signed,
        expeditionId=grant['expedition_id'],
        role=grant.get('role', 'translate'),
        targetLanguage=grant.get('target_language', 'de'),
    )


def save_translations(runtime, expedition_id: str):
    db, _, role, _, grant_lang = access(runtime, expedition_id, required='translate')
    body = payload()
    target_lang = model.normalize_lang(body.get('targetLanguage') or grant_lang or 'de', '')
    if not target_lang:
        raise model.ElearningError('Choose a valid target language (nl, en, or de).', 400)
    if grant_lang and target_lang != grant_lang:
        raise model.ElearningError(f'This translator link is scoped to {grant_lang.upper()}.', 403)
    if body.get('modules') is not None or body.get('startPage') is not None:
        raise model.ElearningError('Translation saves only accept textUpdates and mediaUpdates.', 403)
    text_updates = body.get('textUpdates') if isinstance(body.get('textUpdates'), dict) else {}
    media_updates = body.get('mediaUpdates') if isinstance(body.get('mediaUpdates'), dict) else {}

    def txn(unit):
        _, current, _, _, _ = access(runtime, expedition_id, 'translate', unit=unit)
        patched = model.apply_translation_patch(current, target_lang, text_updates, media_updates)
        elearning_storage.attach_new_media(unit, current, patched)
        patched['revision'] = int(current.get('revision', 1)) + 1
        patched['updated_at'] = now()
        unit.put(_exp_path(expedition_id), patched)
        return patched

    saved = db.atomic(txn)
    return jsonify(expedition=_public_studio_view(saved, role, grant_lang))


def export_translations_csv(runtime, expedition_id: str):
    _, exp, _, _, grant_lang = access(runtime, expedition_id, required='translate')
    source_lang = model.normalize_lang(request.args.get('source', exp.get('defaultLanguage', 'nl')))
    target_lang = model.normalize_lang(request.args.get('target', grant_lang or 'de'))
    rows = model.extract_translation_rows(exp, source_lang=source_lang, target_lang=target_lang)
    csv_data = model.translation_rows_to_csv(rows, target_lang=target_lang)
    filename = f"xped-translations-{expedition_id}-{target_lang}.csv"
    return send_file(
        io.BytesIO(csv_data.encode('utf-8-sig')),
        mimetype='text/csv; charset=utf-8',
        as_attachment=True,
        download_name=filename,
    )


def import_translations_csv(runtime, expedition_id: str):
    db, _, role, _, grant_lang = access(runtime, expedition_id, required='translate')
    target_lang = model.normalize_lang(request.args.get('target') or (request.form.get('targetLanguage') if request.form else '') or grant_lang or 'de', '')
    if grant_lang and target_lang != grant_lang:
        raise model.ElearningError(f'This translator link is scoped to {grant_lang.upper()}.', 403)
    if 'file' in request.files:
        raw_bytes = request.files['file'].read(2 * 1024 * 1024)
        csv_text = raw_bytes.decode('utf-8-sig', errors='replace')
    else:
        body = payload()
        csv_text = str(body.get('csv') or '')
    updates = model.csv_to_translation_updates(csv_text, target_lang)
    if not updates:
        raise model.ElearningError('No translation rows found for the target language.', 400)

    def txn(unit):
        _, current, _, _, _ = access(runtime, expedition_id, 'translate', unit=unit)
        original = {r['key']: r['target'] for r in model.extract_translation_rows(current, target_lang=target_lang)}
        # An unedited exported cell must keep its original author text on import.
        filtered = {k: original[k] if v == sanitize_csv_cell(original[k]) else v
                    for k, v in updates.items() if k in original}
        if not filtered:
            raise model.ElearningError('No matching translation keys found in this CSV.', 400)
        patched = model.apply_translation_patch(current, target_lang, filtered)
        patched['revision'] = int(current.get('revision', 1)) + 1
        patched['updated_at'] = now()
        unit.put(_exp_path(expedition_id), patched)
        return patched, len(filtered)

    saved, applied_count = db.atomic(txn)
    return jsonify(expedition=_public_studio_view(saved, role, grant_lang), appliedCount=applied_count)


def upload_asset(runtime, expedition_id: str):
    db, _, _, who, _ = access(runtime, expedition_id, required='translate')
    uploaded = request.files.get('file')
    if not uploaded:
        raise model.ElearningError('Choose an image or audio file to upload.', 400)
    data = uploaded.read(MAX_AUDIO_BYTES + 1)
    content_type = str(uploaded.mimetype or '').lower().split(';')[0].strip()
    aid = model.new_id('ast')
    filename = (uploaded.filename or '').replace('\\', '/').rsplit('/', 1)[-1]
    meta = {'id': aid, 'expedition_id': expedition_id, 'uploaded_by': who['id'], 'created_at': now(),
            'filename': model.safe_text(filename, 120), 'pending_session': _media_session(who)}
    if content_type in ALLOWED_AUDIO_MIMES:
        if not data or len(data) > MAX_AUDIO_BYTES:
            raise model.ElearningError('Choose a non-empty audio file of at most 15 MB.', 413)
        ext = ALLOWED_AUDIO_MIMES[content_type]
        meta.update(kind='audio', content_type=content_type)
    else:
        size_xy, data, _ = book_storage.validate_image(data)
        ext = 'webp'
        meta.update(kind='image', content_type='image/webp', width=size_xy[0], height=size_xy[1])
    meta['path'] = f'elearning/{expedition_id}/{aid}.{ext}'
    # Check course membership and the author's invitation in the same transactions
    # that reserve and publish media, including when access changes mid-upload.
    def authorize_upload(unit):
        if current_app.config.get('XPED_ACADEMY'):
            access(runtime, expedition_id, required='translate', unit=unit)
    elearning_storage.store_asset(db, meta, data, authorize=authorize_upload)
    return jsonify(asset={
        'id': aid,
        'kind': meta['kind'],
        'contentType': meta['content_type'],
        'url': f'/api/elearning/expeditions/{expedition_id}/assets/{aid}',
    }), 201


def _serve_asset(db: ElearningStore, expedition_id: str, asset_id: str):
    aid = model.identifier(asset_id, 'asset id')
    meta = db.get('elearning_assets/' + aid)
    if not meta or meta.get('expedition_id') != expedition_id or not meta.get('ready', True):
        raise model.ElearningError('Asset not found.', 404)
    if request.method == 'HEAD':
        response = current_app.response_class(mimetype=meta.get('content_type', 'application/octet-stream'))
        if 'size' in meta:
            response.content_length = meta['size']
        return response
    try:
        raw = elearning_storage.read_asset(db, meta)
    except BookError as err:
        raise model.ElearningError(str(err), err.status) from err
    response = send_file(io.BytesIO(raw), mimetype=meta.get('content_type', 'application/octet-stream'))
    response.headers['Cache-Control'] = 'private, no-store'
    return response


def get_asset(runtime, expedition_id: str, asset_id: str):
    db, _, _, _, _ = access(runtime, expedition_id, required='translate')
    return _serve_asset(db, expedition_id, asset_id)


def _media_session(who):
    return _digest(who['id'] + '|' + request.headers.get('X-Elearning-Session', ''))


def unused_assets(runtime, expedition_id):
    db, course, _, who, _ = access(runtime, expedition_id, required='edit')
    used = model.media_ids(course)
    session = _media_session(who)
    candidates = []
    for asset in db.list('elearning_assets', 'expedition_id', expedition_id, limit=None):
        if asset['id'] not in used and elearning_storage.can_reclaim(asset, session):
            candidates.append({key: asset[key] for key in ('id', 'kind', 'size', 'filename') if key in asset})
    return jsonify(unused=candidates, revision=course['revision'])


def delete_asset(runtime, expedition_id: str, asset_id: str):
    db = _store(runtime)
    aid = model.identifier(asset_id, 'asset id')
    key = 'elearning_assets/' + aid
    body = payload()

    def claim(unit):
        _, course, _, who, _ = access(runtime, expedition_id, 'edit', unit=unit)
        _assert_lease(course, who, body)
        meta = unit.get(key)
        if not meta or meta.get('expedition_id') != expedition_id:
            raise model.ElearningError('Asset not found.', 404)
        if aid in model.media_ids(course):
            raise model.ElearningError('This file is still used by the expedition.', 409)
        if not elearning_storage.can_reclaim(meta, _media_session(who)):
            raise model.ElearningError('Another upload is still finishing. Try again in a moment.', 409)
        # Prevent a concurrent save from reattaching bytes while the external
        # deletion is in flight. Keep the path and reservation through retries.
        meta.update(ready=False, removing=True, upload_until=0)
        unit.put(key, meta)
        return meta

    meta = db.atomic(claim)
    try:
        elearning_storage.erase_asset(db, meta)
    except BookError as err:
        return jsonify(error='File removal is pending. Retry to free the space.', removalPending=True), err.status
    return jsonify(deleted=True)


def _resolve_public_expedition(runtime, share_token: str, unit=None):
    safe_token = str(share_token or '').strip()
    if not _SHARE_TOKEN_RE.fullmatch(safe_token):
        raise model.ElearningError('Invalid share link.', 404)
    db = unit if unit is not None else _store(runtime)
    idx = db.get('elearning_share_index/' + safe_token)
    if not idx or not idx.get('expedition_id'):
        raise model.ElearningError('This expedition link was not found.', 404)
    exp = db.get(_exp_path(idx['expedition_id']))
    if not exp or exp.get('deleted') or exp.get('copying'):
        raise model.ElearningError('This expedition is no longer available.', 404)
    share = exp.get('share') or {}
    if share.get('token') != safe_token:
        raise model.ElearningError('This expedition link has expired.', 410)
    if not share.get('enabled'):
        raise model.ElearningError(
            str(share.get('pausedMessage') or 'This learning module is temporarily paused.'),
            410,
        )
    return db, exp


def public_get_expedition(runtime, share_token: str):
    _, exp = _resolve_public_expedition(runtime, share_token)
    return jsonify(expedition=model.sanitize_public_expedition(exp))


def public_get_asset(runtime, share_token: str, asset_id: str):
    db, exp = _resolve_public_expedition(runtime, share_token)
    public = model.sanitize_public_expedition(exp)
    if asset_id not in model.media_ids(public):
        raise model.ElearningError('Asset not found.', 404)
    return _serve_asset(db, exp['id'], asset_id)


def _learner_answer(block, value):
    kind = block['type']
    data = block.get('data') or {}
    if kind == 'reflection' and isinstance(value, str):
        return value[:4000]
    if kind == 'myth_fact' and value in ('myth', 'fact'):
        return value
    if kind == 'scale' and type(value) is int and data['min'] <= value <= data['max']:
        return value
    if kind == 'balance_scale' and isinstance(value, dict):
        return {item['id']: value[item['id']] for item in data.get('factors', [])
                if type(value.get(item['id'])) is int and 0 <= value[item['id']] <= 3}
    if kind in ('mcq', 'hotspot', 'ranking'):
        field = {'mcq': 'options', 'hotspot': 'pins', 'ranking': 'items'}[kind]
        ids = {item['id'] for item in data.get(field, [])}
        if isinstance(value, str) and value in ids:
            return value
        if isinstance(value, list) and kind != 'hotspot':
            return list(dict.fromkeys(v for v in value if isinstance(v, str) and v in ids))
    if kind == 'wordcloud' and isinstance(value, list):
        count = data.get('maxWords', 3)
        return [v[:40] for v in value[:count] if isinstance(v, str)]
    if kind == 'mini_plan':
        max_select = data.get('maxSelect', 3)
        valid_ids = {item['id'] for item in data.get('suggestions', []) if isinstance(item, dict) and item.get('id')}
        if isinstance(value, dict):
            raw_ids = value.get('ids') if isinstance(value.get('ids'), list) else []
            clean_ids = list(dict.fromkeys(v for v in raw_ids if isinstance(v, str) and v in valid_ids))[:max_select]
            remaining = max(0, max_select - len(clean_ids))
            raw_custom = value.get('custom') if isinstance(value.get('custom'), list) else []
            clean_custom = ([v[:300] for v in raw_custom if isinstance(v, str) and v.strip()][:remaining]
                            if data.get('allowCustom', True) else [])
            return {'ids': clean_ids, 'custom': clean_custom}
        if isinstance(value, list):
            if not data.get('allowCustom', True):
                # Older clients sent the chosen labels as strings.
                labels = {label for item in data.get('suggestions', [])
                          for lang, label in item.get('label', {}).items() if lang in ('nl', 'de', 'en') and label}
                value = [v for v in value if isinstance(v, str) and (v in valid_ids or v in labels)]
            return [v[:300] for v in value[:max_select] if isinstance(v, str)]
    return None


def _rating(value):
    try:
        return max(1, min(5, int(value))) if value else None
    except (TypeError, ValueError, OverflowError):
        return None


# A learner's active time on one step, in whole seconds. The player sends cumulative
# totals for its session, so the stored value only ever grows to the largest report.
MAX_STEP_SECONDS = 4 * 60 * 60


def _merge_step_seconds(stored, reported, steps) -> dict:
    merged = {sid: int(value) for sid, value in (stored or {}).items()
              if isinstance(sid, str) and type(value) is int and value > 0}
    if not isinstance(reported, dict):
        return merged
    for sid, value in list(reported.items())[:500]:
        if sid not in steps or isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        if not math.isfinite(value) or value < 1:
            continue
        merged[sid] = max(merged.get(sid, 0), min(int(value), MAX_STEP_SECONDS))
    return merged


def public_submit_response(runtime, share_token: str):
    body = payload()
    session_id = str(body.get('sessionId') or '').strip()
    if not _SESSION_ID_RE.fullmatch(session_id):
        raise model.ElearningError('Invalid learner session id.', 400)
    cohort = str(body.get('cohort') or '').strip() or 'default'
    if not _COHORT_RE.fullmatch(cohort):
        cohort = 'default'
    ts = now()

    def save(tx):
        _, exp = _resolve_public_expedition(runtime, share_token, unit=tx)
        options = model.response_collection_options(exp.get('share') or {})
        if not options['collectResponses'] or body.get('consent') is not True:
            raise model.ElearningError('Sharing requires the learner’s permission on an active pilot.', 403)
        if body.get('collectionVersion') != options['collectionVersion']:
            raise model.ElearningError('The response collection settings have changed.', 409)
        course = model.sanitize_public_expedition(exp)
        lang = model.normalize_lang(body.get('language'), course['defaultLanguage'])
        steps = {step['id']: (module, step) for module in course['modules'] for step in module['steps']}
        blocks = {blk['id']: blk for _, step in steps.values() for blk in step['blocks']}
        doc_id = f"{exp['id']}__{session_id}"
        path = 'elearning_responses/' + doc_id
        old = tx.get(path) or {}
        if old and (old.get('cohort') or 'default') != cohort:
            raise model.ElearningError('Start a new response session for this pilot group.', 409)
        if old and old.get('consentVersion') != options['collectionVersion']:
            raise model.ElearningError('Start a new response session for these collection settings.', 409)
        answers = dict(old.get('answers') or {})
        peer_answers = dict(old.get('peerAnswers') or {})
        disclosed = body.get('peerDisclosureTypes')
        if not isinstance(disclosed, dict):
            disclosed = {}
        if isinstance(body.get('answers'), dict):
            for bid, value in body['answers'].items():
                if bid not in blocks:
                    continue
                block = blocks[bid]
                kind = block['type']
                answer = _learner_answer(block, value)
                if answer is None or (bid in answers and answers[bid] == answer):
                    continue
                # A full progress snapshot can include older answers. Only a new answer,
                # or a revision of an already disclosed answer of this type, can be shared.
                eligible = bid not in answers or kind in peer_answers.get(bid, {})
                if (eligible and disclosed.get(bid) == kind and course['shareOptions']['showPeerResults']
                        and (block.get('settings') or {}).get('showPeerResults')):
                    # These types only publish counts. Their free text stays in the author's data.
                    public_value = True if kind in ('reflection', 'mini_plan', 'hotspot') else answer
                    peer_answers[bid] = {kind: public_value}
                else:
                    peer_answers.pop(bid, None)
                answers[bid] = answer
        step_seconds = _merge_step_seconds(old.get('stepSeconds'), body.get('stepSeconds'), steps)
        visited = list(old.get('visitedStepIds') or [])
        if isinstance(body.get('visitedStepIds'), list):
            visited.extend(s for s in body['visitedStepIds'] if isinstance(s, str) and s in steps)
        feedback = old.get('pilotFeedback')
        pilot = body.get('pilotFeedback')
        if options['collectPilotFeedback'] and isinstance(pilot, dict):
            feedback = {'clarity': _rating(pilot.get('clarity')), 'engagement': _rating(pilot.get('engagement')),
                        'comment': model.safe_text(pilot.get('comment'), 2000)}
        comments = list(old.get('stepComments') or [])
        if options['allowStepComments'] and isinstance(body.get('stepComments'), list):
            comments = []
            for item in body['stepComments'][:60]:
                if not isinstance(item, dict):
                    continue
                sid = model.safe_text(item.get('stepId'), 80)
                comment = model.safe_text(item.get('comment'), 1200).strip()
                if not comment or sid not in steps:
                    continue
                module, step = steps[sid]
                comments.append({'moduleId': module['id'], 'stepId': sid, 'comment': comment,
                                 'reviewer': model.safe_text(item.get('reviewer'), 80),
                                 'moduleTitle': module['title'].get(lang, ''), 'stepTitle': step['title'].get(lang, ''),
                                 'createdAt': item['createdAt'] if type(item.get('createdAt')) is int else int(ts)})
        tx.put(path, {'id': doc_id, 'expedition_id': exp['id'], 'session_id': session_id,
                      'cohort': cohort, 'language': lang, 'answers': answers, 'peerAnswers': peer_answers,
                      'consentVersion': options['collectionVersion'], 'consented_at': old.get('consented_at', ts),
                      'visitedStepIds': list(dict.fromkeys(visited)), 'stepSeconds': step_seconds,
                      'completed': bool(body.get('completed') or old.get('completed')),
                      'pilotFeedback': feedback, 'stepComments': comments, 'started_at': old.get('started_at', ts), 'updated_at': ts})

    _store(runtime).atomic(save)
    return jsonify(saved=True, updatedAt=ts)


def _aggregate_block(block: dict, values: list) -> dict:
    btype = block['type']
    count = len(values)
    if btype in ('mcq', 'myth_fact'):
        counts = Counter()
        for val in values:
            if isinstance(val, list):
                counts.update({item for item in val if isinstance(item, str) and item})
            elif isinstance(val, str) and val:
                counts[val] += 1
        respondents = sum(bool(value) for value in values)
        return {'type': btype, 'count': respondents, 'counts': dict(counts)}
    if btype == 'scale':
        nums = []
        buckets = Counter()
        for val in values:
            try:
                num = float(val)
                nums.append(num)
                buckets[str(int(round(num)))] += 1
            except (TypeError, ValueError):
                continue
        avg = round(sum(nums) / len(nums), 2) if nums else None
        return {'type': btype, 'count': len(nums), 'average': avg, 'buckets': dict(buckets)}
    if btype == 'wordcloud':
        words = Counter()
        for val in values:
            entries = val if isinstance(val, list) else str(val or '').split(',')
            for w in entries:
                cleaned = model.safe_text(w, 40).strip().lower()
                if cleaned:
                    words[cleaned] += 1
        return {'type': btype, 'count': count, 'words': [{'word': w, 'count': c} for w, c in words.most_common(40)]}
    if btype == 'ranking':
        rank_totals: Counter = Counter()
        for val in values:
            if isinstance(val, list):
                n = len(val)
                for idx, item_id in enumerate(val):
                    rank_totals[str(item_id)] += max(1, n - idx)
        return {'type': btype, 'count': count, 'scores': dict(rank_totals)}
    if btype == 'balance_scale':
        factors = (block.get('data') or {}).get('factors') or []
        load_ids = {f['id'] for f in factors if f.get('category') == 'load'}
        res_ids = {f['id'] for f in factors if f.get('category') != 'load'}
        load_sums, res_sums = [], []
        for val in values:
            if not isinstance(val, dict):
                continue
            ls = sum(float(v) for k, v in val.items() if k in load_ids and isinstance(v, (int, float)))
            rs = sum(float(v) for k, v in val.items() if k in res_ids and isinstance(v, (int, float)))
            load_sums.append(ls)
            res_sums.append(rs)
        return {
            'type': btype,
            'count': len(load_sums),
            'avgLoad': round(sum(load_sums) / len(load_sums), 1) if load_sums else None,
            'avgResource': round(sum(res_sums) / len(res_sums), 1) if res_sums else None,
        }
    return {'type': btype, 'count': count}


def public_get_aggregates(runtime, share_token: str, block_id: str):
    db, exp = _resolve_public_expedition(runtime, share_token)
    if not model.response_collection_options(exp.get('share') or {})['showPeerResults']:
        raise model.ElearningError('Peer results are disabled for this expedition.', 403)
    bid = model.identifier(block_id, 'block id')
    target_block = None
    for mod in model.sanitize_public_expedition(exp)['modules']:
        for step in mod['steps']:
            for blk in step['blocks']:
                if blk['id'] == bid:
                    target_block = blk
                    break
    if not target_block or not (target_block.get('settings') or {}).get('showPeerResults'):
        raise model.ElearningError('Peer results are not enabled for this question.', 403)
    kind = target_block['type']
    key = (share_token, exp.get('revision'), bid, kind)
    with _peer_read_locks[hash(key) % len(_peer_read_locks)]:
        with _peer_lock:
            entry = _peer_cache.get(key)
            if entry and entry[0] > time.monotonic():
                _peer_cache.move_to_end(key)
                return jsonify(aggregate=entry[1])
        rows = db.list('elearning_responses', 'expedition_id', exp['id'], limit=None,
                       fields=[FieldPath('peerAnswers', bid, kind).to_api_repr()])
        values = [r['peerAnswers'][bid][kind] for r in rows if kind in r.get('peerAnswers', {}).get(bid, {})]
        aggregate = _aggregate_block(target_block, values)
        with _peer_lock:
            _peer_cache[key] = (time.monotonic() + PEER_RESULT_SECONDS, aggregate)
            _peer_cache.move_to_end(key)
            if len(_peer_cache) > 128:
                _peer_cache.popitem(last=False)
    return jsonify(aggregate=aggregate)


def get_responses(runtime, expedition_id: str):
    db, exp, _, _, _ = access(runtime, expedition_id, required='edit')
    cohort_filter = str(request.args.get('cohort') or '').strip()
    lang_filter = str(request.args.get('language') or '').strip().lower()
    all_rows = db.list('elearning_responses', 'expedition_id', expedition_id, limit=None)
    cohorts = sorted({str(r.get('cohort') or 'default') for r in all_rows})
    rows = [
        r for r in all_rows
        if (not cohort_filter or r.get('cohort') == cohort_filter)
        and (not lang_filter or r.get('language') == lang_filter)
    ]

    completed_count = sum(1 for r in rows if r.get('completed'))
    durations = [
        max(0, float(r.get('updated_at', 0)) - float(r.get('started_at', 0)))
        for r in rows
        if r.get('started_at') and r.get('updated_at')
    ]
    median_sec = round(median(durations)) if durations else 0

    funnel = []
    block_stats = {}
    for mod in exp.get('modules', []):
        for step in mod.get('steps', []):
            reached = sum(1 for r in rows if step['id'] in (r.get('visitedStepIds') or []))
            funnel.append({
                'moduleId': mod['id'],
                'moduleTitle': mod.get('title', {}),
                'stepId': step['id'],
                'stepTitle': step.get('title', {}),
                'reached': reached,
            })
            for blk in step.get('blocks', []):
                if blk['type'] in ('mcq', 'myth_fact', 'scale', 'wordcloud', 'ranking', 'reflection', 'balance_scale', 'mini_plan'):
                    bid = blk['id']
                    values = [r['answers'][bid] for r in rows if bid in (r.get('answers') or {})]
                    agg = _aggregate_block(blk, values)
                    if blk['type'] == 'reflection':
                        reflections = [value for value in values if isinstance(value, str) and value.strip()]
                        agg['sampleTotal'] = len(reflections)
                        agg['samples'] = [model.safe_text(value, 600) for value in reflections[:50]]
                    block_stats[blk['id']] = agg

    feedback = []
    clarity_scores = []
    engagement_scores = []
    for r in rows:
        pf = r.get('pilotFeedback')
        if isinstance(pf, dict):
            if pf.get('clarity'):
                clarity_scores.append(pf['clarity'])
            if pf.get('engagement'):
                engagement_scores.append(pf['engagement'])
            feedback.append({
                'cohort': r.get('cohort', 'default'),
                'language': r.get('language', 'nl'),
                'clarity': pf.get('clarity'),
                'engagement': pf.get('engagement'),
                'comment': pf.get('comment', ''),
                'updatedAt': r.get('updated_at', 0),
            })

    step_comments = []
    for r in rows:
        for sc in (r.get('stepComments') or []):
            if isinstance(sc, dict) and sc.get('comment'):
                step_comments.append({
                    **sc,
                    'cohort': r.get('cohort', 'default'),
                    'language': r.get('language', 'nl'),
                })

    return jsonify(
        expedition={'id': exp['id'], 'title': exp.get('title', ''), 'defaultLanguage': exp.get('defaultLanguage', 'nl'), 'modules': exp.get('modules', [])},
        summary={
            'totalSessions': len(rows),
            'completedSessions': completed_count,
            'completionRate': round((completed_count / len(rows)) * 100, 1) if rows else 0,
            'medianSeconds': median_sec,
            'avgClarity': round(sum(clarity_scores) / len(clarity_scores), 2) if clarity_scores else None,
            'avgEngagement': round(sum(engagement_scores) / len(engagement_scores), 2) if engagement_scores else None,
        },
        cohorts=cohorts,
        funnel=funnel,
        blockStats=block_stats,
        pilotFeedback=feedback,
        stepComments=step_comments,
    )


def export_responses_csv(runtime, expedition_id: str):
    db, exp, _, _, _ = access(runtime, expedition_id, required='edit')
    cohort_filter = str(request.args.get('cohort') or '').strip()
    lang_filter = str(request.args.get('language') or '').strip().lower()
    all_rows = db.list('elearning_responses', 'expedition_id', expedition_id, limit=None)
    rows = [
        r for r in all_rows
        if (not cohort_filter or r.get('cohort') == cohort_filter)
        and (not lang_filter or r.get('language') == lang_filter)
    ]
    block_ids = []
    step_ids = []
    for mod in exp.get('modules', []):
        for step in mod.get('steps', []):
            step_ids.append(step['id'])
            for blk in step.get('blocks', []):
                if blk['type'] in ('mcq', 'myth_fact', 'scale', 'reflection', 'wordcloud', 'ranking', 'balance_scale', 'mini_plan', 'hotspot'):
                    block_ids.append(blk['id'])

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(['session_id', 'cohort', 'language', 'completed', 'clarity', 'engagement', 'pilot_comment',
                     'active_seconds'] + ['seconds_' + sid for sid in step_ids] + block_ids)
    for r in rows:
        pf = r.get('pilotFeedback') or {}
        ans = r.get('answers') or {}
        row_out = [
            r.get('session_id', ''),
            r.get('cohort', 'default'),
            r.get('language', 'nl'),
            'yes' if r.get('completed') else 'no',
            pf.get('clarity', ''),
            pf.get('engagement', ''),
            pf.get('comment', ''),
        ]
        seconds = {sid: value for sid, value in (r.get('stepSeconds') or {}).items() if type(value) is int}
        # Sessions without measured time (private or older consent) leave the time cells empty.
        row_out.append(sum(seconds.get(sid, 0) for sid in step_ids) if seconds else '')
        row_out.extend(seconds.get(sid, '') if seconds else '' for sid in step_ids)
        for bid in block_ids:
            val = ans.get(bid, '')
            if isinstance(val, (list, dict)):
                val = json.dumps(val, ensure_ascii=False)
            row_out.append(str(val))
        writer.writerow(sanitize_csv_row(row_out))

    scope_parts = []
    if cohort_filter and _COHORT_RE.fullmatch(cohort_filter):
        scope_parts.append(cohort_filter)
    if lang_filter in model.SUPPORTED_LANGUAGES:
        scope_parts.append(lang_filter)
    scope_suffix = '-' + '-'.join(scope_parts) if scope_parts else ''

    return send_file(
        io.BytesIO(buf.getvalue().encode('utf-8-sig')),
        mimetype='text/csv; charset=utf-8',
        as_attachment=True,
        download_name=f'xped-responses-{expedition_id}{scope_suffix}.csv',
    )
