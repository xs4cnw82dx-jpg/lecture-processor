"""Permission-checked service layer for xPEDitie Pijn E-Learning Studio."""
from __future__ import annotations

import csv
import hashlib
import io
import re
import secrets
import time
from collections import Counter
from copy import deepcopy

from flask import current_app, jsonify, request, send_file
from itsdangerous import BadSignature, URLSafeTimedSerializer

from lecture_processor.domains.account import lifecycle
from lecture_processor.domains.books.model import BookError
from lecture_processor.domains.elearning import model
from lecture_processor.repositories.elearning_repo import ElearningStore, invalidate
from lecture_processor.services import access_service, book_storage

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
    user = None
    if request.headers.get('Authorization'):
        user, error, status = access_service.require_authenticated_user(runtime, request)
        if error is not None:
            raise model.ElearningError('Please sign in again to continue.', status)
    if required and not user:
        raise model.ElearningError('Sign in to open xPEDitie Pijn Studio.', 401)
    if user:
        allowed, message = lifecycle.ensure_account_allows_writes(user['uid'], runtime=runtime)
        if not allowed:
            raise model.ElearningError(message, 409)
    return user


def _role_rank(role: str) -> int:
    return {'owner': 3, 'edit': 2, 'translate': 1}.get(role, 0)


def access(runtime, expedition_id: str, required: str = 'translate', cached: bool = False):
    db = _store(runtime)
    exp = db.cached(_exp_path(expedition_id)) if cached else db.get(_exp_path(expedition_id))
    if not exp or exp.get('deleted'):
        raise model.ElearningError('This expedition is unavailable.', 404)

    user = identity(runtime, required=False)
    uid = user['uid'] if user else ''
    email = str((user or {}).get('email', '') or '').strip().lower()
    role = ''
    grant_lang = ''
    who = {
        'id': uid,
        'email': email,
        'name': model.safe_text((user or {}).get('name') or (email.split('@')[0] if email else 'Collaborator'), 60),
        'grant_id': '',
    }

    if uid and exp.get('owner_uid') == uid:
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
        view.pop('members', None)
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
    return {
        'id': exp['id'],
        'title': exp.get('title', 'Untitled Expedition'),
        'defaultLanguage': exp.get('defaultLanguage', 'nl'),
        'enabledLanguages': exp.get('enabledLanguages', ['nl']),
        'moduleCount': len(modules),
        'stepCount': step_count,
        'revision': exp.get('revision', 1),
        'role': role,
        'shareEnabled': bool(share.get('enabled')),
        'shareToken': share.get('token', '') if role in ('owner', 'edit') else '',
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
    if body.get('base_revision') is not None and int(body.get('base_revision')) != int(exp.get('revision', 1)):
        raise model.ElearningError('A newer version was saved by a collaborator. Reload before saving.', 409)


def list_expeditions(runtime):
    user = identity(runtime, required=True)
    db = _store(runtime)
    email = str(user.get('email', '') or '').strip().lower()
    owned = db.list('elearning_expeditions', 'owner_uid', user['uid'])
    shared = db.list('elearning_expeditions', 'member_emails', email, 'array_contains') if email else []
    combined = {}
    for exp in owned + shared:
        if exp.get('deleted'):
            continue
        eid = exp.get('id') or exp.get('_id')
        if not eid:
            continue
        role = 'owner' if exp.get('owner_uid') == user['uid'] else str((exp.get('members') or {}).get(email, ''))
        if not role:
            continue
        combined[eid] = _summary_card(exp, role)
    items = sorted(combined.values(), key=lambda x: x.get('updatedAt', 0), reverse=True)
    return jsonify(expeditions=items, storageAvailable=book_storage.configured())


def create_expedition(runtime):
    user = identity(runtime, required=True)
    raw = payload()
    if raw.get('modules') is not None or raw.get('startPage') is not None:
        normalized = model.normalize_expedition_payload(raw)
    else:
        normalized = model.build_default_expedition(
            title=str(raw.get('title') or 'xPEDitie Pijn — Nieuw ontwerp'),
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
            'enabled': True,
            'token': share_token,
            'showPeerResults': True,
            'collectPilotFeedback': True,
            'pausedMessage': 'Deze testmodule is tijdelijk gepauzeerd.',
        },
        'revision': 1,
        'created_at': ts,
        'updated_at': ts,
        'deleted': False,
        'lease': {},
    }
    db = _store(runtime)
    db.put(_exp_path(eid), doc)
    db.put('elearning_share_index/' + share_token, {'expedition_id': eid, 'updated_at': ts})
    return jsonify(expedition=_public_studio_view(doc, 'owner')), 201


def get_expedition(runtime, expedition_id: str):
    _, exp, role, _, grant_lang = access(runtime, expedition_id, required='translate')
    return jsonify(expedition=_public_studio_view(exp, role, grant_lang), storageAvailable=book_storage.configured())


def revision(runtime, expedition_id: str):
    _, exp, _, _, _ = access(runtime, expedition_id, required='translate', cached=True)
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
        current = unit.get(_exp_path(expedition_id))
        if not current or current.get('deleted'):
            raise model.ElearningError('This expedition is unavailable.', 404)
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
    invalidate(expedition_id)
    return jsonify(result)


def save_expedition(runtime, expedition_id: str):
    db, _, role, who, _ = access(runtime, expedition_id, required='edit')
    body = payload()
    normalized = model.normalize_expedition_payload(body)
    edited_lang = model.normalize_lang(body.get('editedLanguage') or normalized['defaultLanguage'])

    def txn(unit):
        current = unit.get(_exp_path(expedition_id))
        _assert_lease(current, who, body)
        next_exp = deepcopy(current)
        next_exp.update(normalized)
        model.mark_translations_for_review(current, next_exp, edited_lang)
        next_exp['revision'] = int(current.get('revision', 1)) + 1
        next_exp['updated_at'] = now()
        unit.put(_exp_path(expedition_id), next_exp)
        return next_exp

    saved = db.atomic(txn)
    invalidate(expedition_id)
    return jsonify(expedition=_public_studio_view(saved, role))


def delete_expedition(runtime, expedition_id: str):
    db, exp, _, _, _ = access(runtime, expedition_id, required='owner')
    exp['deleted'] = True
    exp['updated_at'] = now()
    share_token = (exp.get('share') or {}).get('token', '')
    db.put(_exp_path(expedition_id), exp)
    if share_token:
        db.delete('elearning_share_index/' + share_token)
    invalidate(expedition_id)
    return jsonify(deleted=True)


def duplicate_expedition(runtime, expedition_id: str):
    user = identity(runtime, required=True)
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
            'showPeerResults': True,
            'collectPilotFeedback': True,
            'pausedMessage': 'Deze testmodule is tijdelijk gepauzeerd.',
        },
        'revision': 1,
        'created_at': ts,
        'updated_at': ts,
        'deleted': False,
        'lease': {},
    }
    db.put(_exp_path(new_eid), doc)
    db.put('elearning_share_index/' + share_token, {'expedition_id': new_eid, 'updated_at': ts})
    return jsonify(expedition=_public_studio_view(doc, 'owner')), 201


def sharing(runtime, expedition_id: str):
    required = 'owner' if request.method == 'POST' else 'edit'
    db, exp, role, _, _ = access(runtime, expedition_id, required=required)
    if request.method == 'GET':
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
        return jsonify(share=exp.get('share') or {}, members=members if role == 'owner' else [], grants=grants if role == 'owner' else [])

    body = payload()
    action = str(body.get('action') or 'update_public').strip()

    if action == 'update_public':
        share = dict(exp.get('share') or {})
        if 'enabled' in body:
            share['enabled'] = bool(body['enabled'])
        if 'showPeerResults' in body:
            share['showPeerResults'] = bool(body['showPeerResults'])
        if 'collectPilotFeedback' in body:
            share['collectPilotFeedback'] = bool(body['collectPilotFeedback'])
        if 'allowStepComments' in body:
            share['allowStepComments'] = bool(body['allowStepComments'])
        if 'pausedMessage' in body:
            share['pausedMessage'] = model.safe_text(body['pausedMessage'], 400)
        if body.get('rotateToken'):
            old_token = share.get('token', '')
            new_token = 'xped-' + secrets.token_urlsafe(12).replace('-', '').replace('_', '')[:14]
            share['token'] = new_token
            if old_token:
                db.delete('elearning_share_index/' + old_token)
            db.put('elearning_share_index/' + new_token, {'expedition_id': expedition_id, 'updated_at': now()})
        exp['share'] = share
        exp['updated_at'] = now()
        db.put(_exp_path(expedition_id), exp)
        invalidate(expedition_id)
        return jsonify(share=share)

    if action == 'add_member':
        email = model.safe_email(body.get('email'))
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
        db.put(_exp_path(expedition_id), exp)
        invalidate(expedition_id)
        return jsonify(members=[{'email': em, 'role': r} for em, r in sorted(members.items())])

    if action == 'remove_member':
        email = model.safe_email(body.get('email'))
        members = dict(exp.get('members') or {})
        members.pop(email, None)
        exp['members'] = members
        exp['member_emails'] = sorted(members.keys())
        exp['updated_at'] = now()
        db.put(_exp_path(expedition_id), exp)
        invalidate(expedition_id)
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
        db.put('elearning_grants/' + gid, grant_doc)
        db.put('elearning_grant_tokens/' + _digest(raw_token), {'grant_id': gid, 'expedition_id': expedition_id})
        return jsonify(grant={
            'id': gid,
            'role': grant_role,
            'targetLanguage': target_lang,
            'label': label,
            'urlPath': '/elearning/translate/' + raw_token,
        }), 201

    if action == 'revoke_grant':
        gid = model.identifier(body.get('grantId'), 'grant id')
        grant = db.get('elearning_grants/' + gid)
        if not grant or grant.get('expedition_id') != expedition_id:
            raise model.ElearningError('Invite link not found.', 404)
        grant['revoked'] = True
        db.put('elearning_grants/' + gid, grant)
        if grant.get('token_hash'):
            db.delete('elearning_grant_tokens/' + grant['token_hash'])
        return jsonify(revoked=True)

    raise model.ElearningError('Unsupported sharing action.', 400)


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
        current = unit.get(_exp_path(expedition_id))
        if not current or current.get('deleted'):
            raise model.ElearningError('This expedition is unavailable.', 404)
        patched = model.apply_translation_patch(current, target_lang, text_updates, media_updates)
        patched['revision'] = int(current.get('revision', 1)) + 1
        patched['updated_at'] = now()
        unit.put(_exp_path(expedition_id), patched)
        return patched

    saved = db.atomic(txn)
    invalidate(expedition_id)
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
        current = unit.get(_exp_path(expedition_id))
        if not current or current.get('deleted'):
            raise model.ElearningError('This expedition is unavailable.', 404)
        known_keys = {r['key'] for r in model.extract_translation_rows(current, target_lang=target_lang)}
        filtered = {k: v for k, v in updates.items() if k in known_keys}
        if not filtered:
            raise model.ElearningError('No matching translation keys found in this CSV.', 400)
        patched = model.apply_translation_patch(current, target_lang, filtered)
        patched['revision'] = int(current.get('revision', 1)) + 1
        patched['updated_at'] = now()
        unit.put(_exp_path(expedition_id), patched)
        return patched, len(filtered)

    saved, applied_count = db.atomic(txn)
    invalidate(expedition_id)
    return jsonify(expedition=_public_studio_view(saved, role, grant_lang), appliedCount=applied_count)


def upload_asset(runtime, expedition_id: str):
    db, _, _, who, _ = access(runtime, expedition_id, required='translate')
    uploaded = request.files.get('file')
    if not uploaded:
        raise model.ElearningError('Choose an image or audio file to upload.', 400)
    data = uploaded.read(MAX_AUDIO_BYTES + 1)
    content_type = str(uploaded.mimetype or '').lower().split(';')[0].strip()
    aid = model.new_id('ast')
    storage_path = f'elearning/{expedition_id}/{aid}'

    if content_type in ALLOWED_AUDIO_MIMES:
        if len(data) > MAX_AUDIO_BYTES:
            raise model.ElearningError('Audio file must be at most 15 MB.', 413)
        ext = ALLOWED_AUDIO_MIMES[content_type]
        storage_path = f'{storage_path}.{ext}'
        try:
            book_storage.request('POST', storage_path, data=data, content_type=content_type)
        except BookError as err:
            raise model.ElearningError(str(err), err.status) from err
        meta = {
            'id': aid,
            'expedition_id': expedition_id,
            'kind': 'audio',
            'content_type': content_type,
            'size': len(data),
            'path': storage_path,
            'uploaded_by': who['id'],
            'created_at': now(),
        }
    else:
        try:
            size_xy, preview_webp, _ = book_storage.validate_image(data)
            storage_path = f'{storage_path}.webp'
            book_storage.request('POST', storage_path, data=preview_webp, content_type='image/webp')
        except BookError as err:
            raise model.ElearningError(str(err), err.status) from err
        meta = {
            'id': aid,
            'expedition_id': expedition_id,
            'kind': 'image',
            'content_type': 'image/webp',
            'width': size_xy[0],
            'height': size_xy[1],
            'size': len(preview_webp),
            'path': storage_path,
            'uploaded_by': who['id'],
            'created_at': now(),
        }

    db.put('elearning_assets/' + aid, meta)
    return jsonify(asset={
        'id': aid,
        'kind': meta['kind'],
        'contentType': meta['content_type'],
        'url': f'/api/elearning/expeditions/{expedition_id}/assets/{aid}',
    }), 201


def _serve_asset(db: ElearningStore, expedition_id: str, asset_id: str):
    aid = model.identifier(asset_id, 'asset id')
    meta = db.get('elearning_assets/' + aid)
    if not meta or meta.get('expedition_id') != expedition_id:
        raise model.ElearningError('Asset not found.', 404)
    try:
        raw = book_storage.request('GET', meta['path'])
    except BookError as err:
        raise model.ElearningError(str(err), err.status) from err
    response = send_file(io.BytesIO(raw), mimetype=meta.get('content_type', 'application/octet-stream'))
    response.headers['Cache-Control'] = 'private, max-age=3600'
    return response


def get_asset(runtime, expedition_id: str, asset_id: str):
    db, _, _, _, _ = access(runtime, expedition_id, required='translate')
    return _serve_asset(db, expedition_id, asset_id)


def delete_asset(runtime, expedition_id: str, asset_id: str):
    db, _, _, _, _ = access(runtime, expedition_id, required='edit')
    aid = model.identifier(asset_id, 'asset id')
    meta = db.get('elearning_assets/' + aid)
    if not meta or meta.get('expedition_id') != expedition_id:
        raise model.ElearningError('Asset not found.', 404)
    try:
        book_storage.request('DELETE', meta['path'])
    except BookError:
        pass
    db.delete('elearning_assets/' + aid)
    return jsonify(deleted=True)


def _resolve_public_expedition(runtime, share_token: str):
    safe_token = str(share_token or '').strip()
    if not _SHARE_TOKEN_RE.fullmatch(safe_token):
        raise model.ElearningError('Invalid share link.', 404)
    db = _store(runtime)
    idx = db.get('elearning_share_index/' + safe_token)
    if not idx or not idx.get('expedition_id'):
        raise model.ElearningError('This expedition link was not found.', 404)
    exp = db.get(_exp_path(idx['expedition_id']))
    if not exp or exp.get('deleted'):
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
    return _serve_asset(db, exp['id'], asset_id)


def public_submit_response(runtime, share_token: str):
    db, exp = _resolve_public_expedition(runtime, share_token)
    body = payload()
    session_id = str(body.get('sessionId') or '').strip()
    if not _SESSION_ID_RE.fullmatch(session_id):
        raise model.ElearningError('Invalid learner session id.', 400)
    cohort = str(body.get('cohort') or 'default').strip()
    if not _COHORT_RE.fullmatch(cohort):
        cohort = 'default'
    lang = model.normalize_lang(body.get('language') or exp.get('defaultLanguage', 'nl'))
    raw_answers = body.get('answers') if isinstance(body.get('answers'), dict) else {}
    answers = {}
    for bid, val in list(raw_answers.items())[:150]:
        if isinstance(bid, str) and re.fullmatch(r'^[a-zA-Z0-9_-]{2,80}$', bid):
            answers[bid] = val

    raw_visited = body.get('visitedStepIds') if isinstance(body.get('visitedStepIds'), list) else []
    visited = [str(s) for s in raw_visited[:200] if isinstance(s, str) and len(s) <= 80]

    pilot = body.get('pilotFeedback') if isinstance(body.get('pilotFeedback'), dict) else None
    clean_pilot = None
    if pilot:
        try:
            clarity = max(1, min(5, int(pilot.get('clarity', 0)))) if pilot.get('clarity') else None
            engagement = max(1, min(5, int(pilot.get('engagement', 0)))) if pilot.get('engagement') else None
        except (TypeError, ValueError):
            clarity, engagement = None, None
        clean_pilot = {
            'clarity': clarity,
            'engagement': engagement,
            'comment': model.safe_text(pilot.get('comment', ''), 2000),
        }

    raw_step_comments = body.get('stepComments') if isinstance(body.get('stepComments'), list) else None
    clean_step_comments = []
    if raw_step_comments is not None:
        for sc in raw_step_comments[:60]:
            if not isinstance(sc, dict):
                continue
            comment_txt = model.safe_text(sc.get('comment', ''), 1200).strip()
            if not comment_txt:
                continue
            clean_step_comments.append({
                'moduleId': model.safe_text(sc.get('moduleId', ''), 80),
                'stepId': model.safe_text(sc.get('stepId', ''), 80),
                'moduleTitle': model.safe_text(sc.get('moduleTitle', ''), 200),
                'stepTitle': model.safe_text(sc.get('stepTitle', ''), 200),
                'reviewer': model.safe_text(sc.get('reviewer', ''), 80),
                'comment': comment_txt,
                'createdAt': int(sc.get('createdAt') or now()),
            })

    doc_id = f"{exp['id']}__{session_id}"
    ts = now()
    existing = db.get('elearning_responses/' + doc_id) or {}
    merged_answers = dict(existing.get('answers') or {})
    merged_answers.update(answers)
    merged_visited = list(dict.fromkeys(list(existing.get('visitedStepIds') or []) + visited))
    merged_comments = clean_step_comments if raw_step_comments is not None else list(existing.get('stepComments') or [])

    record = {
        'id': doc_id,
        'expedition_id': exp['id'],
        'share_token': share_token,
        'session_id': session_id,
        'cohort': cohort,
        'language': lang,
        'answers': merged_answers,
        'visitedStepIds': merged_visited,
        'completed': bool(body.get('completed', existing.get('completed', False))),
        'pilotFeedback': clean_pilot or existing.get('pilotFeedback'),
        'stepComments': merged_comments,
        'started_at': existing.get('started_at', ts),
        'updated_at': ts,
    }
    db.put('elearning_responses/' + doc_id, record)
    return jsonify(saved=True, updatedAt=ts)


def _aggregate_block(block: dict, responses: list[dict]) -> dict:
    bid = block['id']
    btype = block['type']
    values = [r.get('answers', {}).get(bid) for r in responses if bid in (r.get('answers') or {})]
    count = len(values)
    if btype in ('mcq', 'myth_fact'):
        counts = Counter()
        for val in values:
            if isinstance(val, list):
                for item in val:
                    counts[str(item)] += 1
            elif val is not None and val != '':
                counts[str(val)] += 1
        return {'type': btype, 'count': count, 'counts': dict(counts)}
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
    if not (exp.get('share') or {}).get('showPeerResults', True):
        raise model.ElearningError('Peer results are disabled for this expedition.', 403)
    bid = model.identifier(block_id, 'block id')
    target_block = None
    for mod in exp.get('modules', []):
        for step in mod.get('steps', []):
            for blk in step.get('blocks', []):
                if blk['id'] == bid:
                    target_block = blk
                    break
    if not target_block or not (target_block.get('settings') or {}).get('showPeerResults'):
        raise model.ElearningError('Peer results are not enabled for this question.', 403)
    rows = db.list('elearning_responses', 'expedition_id', exp['id'], limit=500)
    return jsonify(aggregate=_aggregate_block(target_block, rows))


def get_responses(runtime, expedition_id: str):
    db, exp, _, _, _ = access(runtime, expedition_id, required='edit')
    cohort_filter = str(request.args.get('cohort') or '').strip()
    lang_filter = str(request.args.get('language') or '').strip().lower()
    all_rows = db.list('elearning_responses', 'expedition_id', expedition_id, limit=500)
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
    durations.sort()
    median_sec = round(durations[len(durations) // 2]) if durations else 0

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
                    agg = _aggregate_block(blk, rows)
                    if blk['type'] == 'reflection':
                        agg['samples'] = [
                            model.safe_text(r.get('answers', {}).get(blk['id'], ''), 600)
                            for r in rows
                            if str(r.get('answers', {}).get(blk['id'], '') or '').strip()
                        ][:50]
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
    rows = db.list('elearning_responses', 'expedition_id', expedition_id, limit=500)
    block_ids = []
    for mod in exp.get('modules', []):
        for step in mod.get('steps', []):
            for blk in step.get('blocks', []):
                if blk['type'] in ('mcq', 'myth_fact', 'scale', 'reflection', 'wordcloud', 'ranking', 'balance_scale', 'mini_plan', 'hotspot'):
                    block_ids.append(blk['id'])

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(['session_id', 'cohort', 'language', 'completed', 'clarity', 'engagement', 'pilot_comment'] + block_ids)
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
        for bid in block_ids:
            val = ans.get(bid, '')
            if isinstance(val, (list, dict)):
                import json
                val = json.dumps(val, ensure_ascii=False)
            row_out.append(str(val))
        writer.writerow(row_out)

    return send_file(
        io.BytesIO(buf.getvalue().encode('utf-8-sig')),
        mimetype='text/csv; charset=utf-8',
        as_attachment=True,
        download_name=f'xped-responses-{expedition_id}.csv',
    )
