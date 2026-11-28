"""Self-service management of the caller's dedicated Academy identity."""
from __future__ import annotations

import os
import time

import requests
from firebase_admin import auth, exceptions
from flask import Blueprint, jsonify, render_template, request
from google.api_core.exceptions import GoogleAPICallError

from lecture_processor.domains.elearning.model import ElearningError
from lecture_processor.domains.rate_limit import limiter
from lecture_processor.repositories.elearning_repo import ElearningStore
from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import elearning_service as studio
from lecture_processor.services import elearning_storage


academy_account_bp = Blueprint('academy_account', __name__)
_PAGE = 12


@academy_account_bp.before_request
def _limit_requests():
    if request.endpoint == 'academy_account.account_page':
        return None
    exporting = request.endpoint == 'academy_account.export'
    key = ('academy:export:' if exporting else 'academy:delete:') + (request.remote_addr or 'unknown')
    allowed, retry = limiter.check_rate_limit(key, 12 if exporting else 180, 60, runtime=get_runtime())
    if not allowed:
        return limiter.build_rate_limited_response('Please wait a moment before trying again.', retry, runtime=get_runtime())
    return None


@academy_account_bp.errorhandler(ElearningError)
def _account_error(error):
    return jsonify(error=str(error)), error.status


@academy_account_bp.errorhandler(GoogleAPICallError)
def _unavailable(_error):
    return jsonify(error='Account data is temporarily unavailable. Please try again.'), 503


def _identity(runtime):
    user = runtime.decode_identity(request)
    if not user:
        raise ElearningError('Sign in to manage your Studio account.', 401)
    return user


@academy_account_bp.get('/account')
def account_page():
    return render_template('academy/settings.html')


@academy_account_bp.get('/api/academy/account/export')
def export():
    runtime = get_runtime()
    user = _identity(runtime)
    uid, email = user['uid'], studio._verified_member_email(user)
    db = ElearningStore(runtime.db)
    try:
        profile = auth.get_user(uid, app=runtime.firebase_app)
    except (ValueError, exceptions.FirebaseError):
        raise ElearningError('Account data is temporarily unavailable. Please try again.', 503) from None
    # Each projection omits course contents, access tokens, other collaborators and learner responses.
    own = db.list('elearning_expeditions', 'owner_uid', uid, fields=['title'], limit=None)
    shared = (db.list('elearning_expeditions', 'member_emails', email, 'array_contains',
                      fields=['title', 'members'], limit=None) if email else [])
    folders = db.list(f'academy_users/{uid}/folders', fields=['name'], limit=None)
    uploads = db.list('elearning_assets', 'uploaded_by', uid, fields=['expedition_id', 'filename', 'size'], limit=None)
    response = jsonify(
        account={key: user[key] for key in ('uid', 'email', 'email_verified', 'name', 'picture', 'phone_number') if key in user},
        createdAtMillis=profile.user_metadata.creation_timestamp,
        lastSignInAtMillis=profile.user_metadata.last_sign_in_timestamp,
        preferences={key: value for key, value in (db.get('academy_users/' + uid) or {}).items() if key == 'language'},
        signInProviders=sorted(provider.provider_id for provider in profile.provider_data),
        invitedAuthor=bool(email and db.get(studio._author_key(email))),
        studioAdmin=runtime.is_admin_user(user),
        ownedCourses=[{'id': row['_id'], 'title': row.get('title', '')} for row in own],
        collaborations=[{'id': row['_id'], 'title': row.get('title', ''), 'role': row.get('members', {}).get(email)} for row in shared],
        folders=[{'id': row['_id'], 'name': row.get('name', '')} for row in folders],
        uploads=[{'id': row['_id'], 'courseId': row.get('expedition_id'), 'filename': row.get('filename'), 'bytes': row.get('size')} for row in uploads],
    )
    response.headers['Content-Disposition'] = 'attachment; filename="xped-academy-account.json"'
    return response


def _admin(runtime):
    email = os.getenv('XPED_STUDIO_ADMIN_EMAIL', '').strip().lower()
    uid = runtime.XPED_STUDIO_ADMIN_UID
    try:
        if uid:
            record = auth.get_user(uid, app=runtime.firebase_app)
        elif email:
            record = auth.get_user_by_email(email, app=runtime.firebase_app)
        else:
            record = None
    except (ValueError, exceptions.FirebaseError):
        record = None
    if (not record or record.disabled or not record.email_verified or not record.email
            or (uid and record.uid != uid) or (email and record.email.lower() != email)):
        raise ElearningError('The Studio administrator could not be verified. Please try again.', 503)
    return {'uid': record.uid, 'email': record.email.lower()}


def _delete_signin(token):
    # Firebase accepts a recent ID token for deleting only its own identity. The
    # dedicated runtime's Auth viewer role never gains account deletion powers.
    try:
        result = requests.post('https://identitytoolkit.googleapis.com/v1/accounts:delete',
                               params={'key': os.environ['ACADEMY_FIREBASE_API_KEY']}, json={'idToken': token},
                               timeout=(3, 8), allow_redirects=False)
    except requests.RequestException:
        raise ElearningError('Sign-in removal could not be confirmed. Please try again.', 503) from None
    if result.status_code == 200:
        return
    try:
        code = result.json()['error']['message']
    except (KeyError, TypeError, ValueError):
        code = ''
    if code == 'USER_NOT_FOUND':
        return
    if code in ('CREDENTIAL_TOO_OLD_LOGIN_AGAIN', 'INVALID_ID_TOKEN', 'TOKEN_EXPIRED'):
        raise ElearningError('Sign in again to finish deleting your account.', 403)
    raise ElearningError('Sign-in removal could not be confirmed. Please try again.', 503)


def _check_recipient(tx, uid):
    marker = tx.get('account_deletions/' + uid) or {}
    if marker and marker.get('status') != 'cancelled':
        raise ElearningError('The Studio administrator is unavailable. Please try again.', 409)


def _start(db, uid, email, destination):
    marker = 'account_deletions/' + uid
    admin_uid = destination['uid'] if destination else ''

    def begin(tx):
        state = tx.get(marker) or {}
        if state.get('status') in ('auth_delete_pending', 'deleted'):
            return state
        if admin_uid:
            _check_recipient(tx, admin_uid)
        if state.get('status') == 'transferring':
            if admin_uid and state.get('admin_uid') != admin_uid:
                if state.get('admin_uid'):
                    raise ElearningError('The transfer destination changed. Contact Studio support before continuing.', 409)
                state['admin_uid'] = admin_uid
                tx.put(marker, state)
            return state
        if state and state.get('status') != 'cancelled':
            raise ElearningError('An account change is already in progress.', 409)
        state = {'status': 'transferring', 'admin_uid': admin_uid, 'email': email}
        tx.put(marker, state)
        if email:
            tx.delete(studio._author_key(email))
            tx.put(studio.academy_removal_key(email), {'uid': uid})
        return state

    return db.atomic(begin)


def _move(db, course_id, uid, email, destination):
    key = 'elearning_expeditions/' + course_id

    def transfer(tx):
        course = tx.get(key)
        if not course:
            return
        owned = course.get('owner_uid') == uid
        if owned and (course.get('deleted') or course.get('copying')):
            return 'unfinished'
        own_membership = email and email in (course.get('member_emails') or [])
        has_lease = (course.get('lease') or {}).get('user_id') == uid
        if not owned and not own_membership and not has_lease:
            return
        if owned:
            _check_recipient(tx, destination['uid'])
            folder = 'academy_users/' + destination['uid'] + '/folders/account-review'
            folder_exists = tx.get(folder)
            course.update(owner_uid=destination['uid'], owner_email=destination['email'], folder_id='account-review')
            if not folder_exists:
                tx.put(folder, {'name': 'Account review'})
        if own_membership:
            members = dict(course.get('members') or {})
            members.pop(email, None)
            course.update(members=members, member_emails=sorted(members))
        if has_lease:
            course['lease'] = {}
        tx.put(key, course)
    if db.atomic(transfer) == 'unfinished':
        # Finish only an already-deleted course or a copy that never became usable.
        # The deletion tombstone prevents the copy from publishing during this step.
        elearning_storage.delete_expedition(db, course_id, uid)


def _remove_upload_identity(db, asset_id, uid):
    key = 'elearning_assets/' + asset_id

    def scrub(tx):
        asset = tx.get(key)
        if asset and asset.get('uploaded_by') == uid:
            for field in ('uploaded_by', 'pending_session', 'attach_until'):
                asset.pop(field, None)
            tx.put(key, asset)
    db.atomic(scrub)


def _transfer_page(db, uid, email, destination):
    # Each successful operation removes its own query match. A retry or another
    # tab can resume without a cursor, collection-wide batch, or duplicate copy.
    remaining = _PAGE
    for field, value, op in [('owner_uid', uid, '=='), ('member_emails', email, 'array_contains'), ('lease.user_id', uid, '==')]:
        if not value:
            continue
        courses = db.list('elearning_expeditions', field, value, op, limit=remaining, fields=[field])
        if field == 'owner_uid' and courses and not destination:
            # A create transaction may have committed between the initial
            # ownership query and our tombstone. Resolve a recipient on retry.
            return False
        for row in courses:
            _move(db, row['_id'], uid, email, destination)
        remaining -= len(courses)
        if not remaining:
            return False
    assets = db.list('elearning_assets', 'uploaded_by', uid, limit=remaining, fields=['uploaded_by'])
    for asset in assets:
        _remove_upload_identity(db, asset['_id'], uid)
    remaining -= len(assets)
    if not remaining:
        return False
    collection = f'academy_users/{uid}/folders'
    folders = db.list(collection, limit=remaining, fields=['name'])
    for folder in folders:
        db.delete(collection + '/' + folder['_id'])
    return len(folders) < remaining


def _ready(db, uid, email):
    def finish(tx):
        key = 'account_deletions/' + uid
        marker = tx.get(key)
        if not marker or marker.get('status') != 'transferring':
            return
        # The terminal marker contains no email or destination identity, even
        # if Firebase succeeds and the process stops before acknowledging it.
        tx.delete('users/' + uid)
        tx.delete('academy_users/' + uid)
        pending = {'status': 'auth_delete_pending'}
        if email:
            pending['removal_key'] = studio.academy_removal_key(email)
        tx.put(key, pending)
    db.atomic(finish)


@academy_account_bp.post('/api/academy/account/delete')
def delete():
    request.max_content_length = 4096
    runtime = get_runtime()
    user = _identity(runtime)
    uid = user['uid']
    if studio.payload().get('confirmUid') != uid:
        raise ElearningError('Confirm deletion for the account you are signed in to.', 400)
    if not 0 <= time.time() - float(user.get('auth_time') or 0) <= 300:
        raise ElearningError('Sign in again to finish deleting your account.', 403)
    if runtime.is_admin_user(user):
        raise ElearningError('Assign a successor as Studio administrator before deleting this account.', 409)
    db = ElearningStore(runtime.db)
    marker = 'account_deletions/' + uid
    state = db.get(marker) or {}
    if state.get('status') != 'auth_delete_pending' and state.get('status') != 'deleted':
        has_courses = db.list('elearning_expeditions', 'owner_uid', uid, fields=['owner_uid'], limit=1)
        destination = _admin(runtime) if has_courses else None
        if destination and destination['uid'] == uid:
            raise ElearningError('Assign a successor as Studio administrator before deleting this account.', 409)
        state = _start(db, uid, studio._verified_member_email(user), destination)
        if state['status'] == 'transferring':
            if not _transfer_page(db, uid, state['email'], destination):
                return jsonify(complete=False), 202, {'Retry-After': '1'}
            _ready(db, uid, state['email'])
    if state.get('status') != 'deleted':
        try:
            _delete_signin(request.headers['Authorization'].partition(' ')[2])
        except ElearningError:
            # Another request may have completed deletion or the provider may
            # have removed the caller just before its response connection broke.
            if not runtime.academy_identity_removed(uid):
                raise

        def acknowledge(tx):
            receipt = tx.get(marker) or {}
            removal_key = receipt.get('removal_key')
            if removal_key and (tx.get(removal_key) or {}).get('uid') == uid:
                tx.delete(removal_key)
            tx.put(marker, {'status': 'deleted'})
        db.atomic(acknowledge)
    return jsonify(complete=True)
