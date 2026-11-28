"""Standalone xPEDitie Pijn Studio application for xped.academy."""
from __future__ import annotations

import json
import os
from pathlib import Path
import re
import secrets
import threading
import time

import firebase_admin
from firebase_admin import auth, credentials, exceptions, firestore
from flask import Flask, abort, g, jsonify, render_template, request
from google.api_core.exceptions import GoogleAPICallError
from werkzeug.exceptions import HTTPException

from lecture_processor.blueprints.academy_collaboration import collaboration
from lecture_processor.blueprints.academy_folders import academy_folders_bp
from lecture_processor.blueprints.academy_language import academy_language_bp
from lecture_processor.blueprints.academy_pages import academy_pages
from lecture_processor.blueprints.academy_overview import overview_bp
from lecture_processor.blueprints.academy_reports import academy_reports
from lecture_processor.blueprints.elearning import elearning_bp
from lecture_processor.domains.elearning.model import ElearningError
from lecture_processor.repositories import users_repo
from lecture_processor.runtime.container import get_runtime
from lecture_processor.runtime.environment import normalize_public_base_url, resolve_js_asset
from lecture_processor.runtime.http_security import apply_security_headers, build_content_security_policy
from lecture_processor.runtime.proxy import apply_proxy_fix
from lecture_processor.runtime.static_assets import register_static_versioning
from lecture_processor.services.academy_accounts import academy_account_bp
from lecture_processor.services import auth_service, elearning_service, rate_limit_service


_ROOT = Path(__file__).resolve().parent.parent
_STATIC_ASSETS = (
    'brand/books/xped/mark-white.png', 'css/academy*.css', 'css/elearning-*.css',
    'css/xped-theme.css', 'fonts/books/xped-*', 'images/xped/*', 'js/academy-*.js',
    'js/elearning-*.js', 'js/vendor/qrcode-generator-2.0.4/*',
)
_REQUIRED_ENV = (
    'FLASK_SECRET_KEY', 'PUBLIC_BASE_URL', 'ACADEMY_FIREBASE_PROJECT_ID',
    'ACADEMY_FIREBASE_API_KEY', 'ACADEMY_FIREBASE_APP_ID',
    'BOOK_STORAGE_URL', 'BOOK_STORAGE_KEY', 'BOOK_STORAGE_BUCKET',
)


def _firebase_clients(project_id, credential_file):
    try:
        secret = os.getenv('ACADEMY_FIREBASE_CREDENTIALS', '').strip()
        if secret:
            data = json.loads(secret)
            if not isinstance(data, dict):
                raise ValueError
            credential = credentials.Certificate(data)
        else:
            credential = credentials.Certificate(credential_file)
    except (ValueError, OSError, KeyError, TypeError):
        raise RuntimeError('The Academy Firebase service account credential is invalid.') from None
    if credential.project_id != project_id:
        raise RuntimeError('The Firebase credential must belong to the configured Academy project.')
    name = 'academy-' + project_id
    try:
        app = firebase_admin.get_app(name)
    except ValueError:
        app = firebase_admin.initialize_app(credential, {'projectId': project_id}, name=name)
    return firestore.client(app=app), app


class AcademyEmailUnverified(Exception):
    """A valid Academy identity still needs to verify its email address."""


class AcademyRuntime:
    """Capabilities used by Studio routes, bound to the Academy Firebase project."""

    jsonify = staticmethod(jsonify)
    users_repo = users_repo
    rate_limit_service = rate_limit_service
    firestore = firestore
    time = time
    # A single multithreaded Gunicorn worker shares this bounded limiter.
    RATE_LIMIT_FIRESTORE_ENABLED = False
    RATE_LIMIT_COUNTER_COLLECTION = 'rate_limit_counters'
    SENTRY_FRONTEND_DSN = ''

    def __init__(self, db, firebase_app):
        self.db = db
        self.firebase_app = firebase_app
        self.XPED_STUDIO_ADMIN_UID = os.getenv('XPED_STUDIO_ADMIN_UID', '').strip()
        self.ADMIN_UIDS = {self.XPED_STUDIO_ADMIN_UID} if self.XPED_STUDIO_ADMIN_UID else set()
        email = os.getenv('XPED_STUDIO_ADMIN_EMAIL', '').strip().lower()
        self.ADMIN_EMAILS = {email} if email and not self.ADMIN_UIDS else set()
        self.RATE_LIMIT_EVENTS = {}
        self.RATE_LIMIT_LOCK = threading.Lock()

    @staticmethod
    def resolve_js_asset(filename):
        return resolve_js_asset(filename, project_root_dir=_ROOT)

    def decode_identity(self, req):
        scheme, _, token = req.headers.get('Authorization', '').partition(' ')
        if scheme.lower() != 'bearer' or not token:
            return None
        try:
            user = auth.verify_id_token(token, app=self.firebase_app, check_revoked=True)
        except (ValueError, exceptions.FirebaseError):
            return None
        return user if user.get('uid') else None

    def verify_firebase_token(self, req):
        user = self.decode_identity(req)
        if user and user.get('email'):
            if user.get('email_verified') is True:
                return user
            if user.get('email_verified') is False:
                raise AcademyEmailUnverified
        return None

    def academy_team_profiles(self, emails):
        profiles = {}
        for start in range(0, len(emails), 100):
            identifiers = [auth.EmailIdentifier(email) for email in emails[start:start + 100]]
            try:
                batch = auth.get_users(identifiers, app=self.firebase_app)
            except exceptions.FirebaseError:
                return None
            for user in batch.users:
                if user.email and user.email_verified and not user.disabled:
                    profiles[user.email.lower()] = {
                        'active': True, 'name': user.display_name or '',
                        'lastSignIn': (user.user_metadata.last_sign_in_timestamp or 0) / 1000,
                    }
        return profiles

    def academy_identity_removed(self, uid):
        try:
            auth.get_user(uid, app=self.firebase_app)
        except auth.UserNotFoundError:
            return True
        except (ValueError, exceptions.FirebaseError):
            return False
        return False

    def is_admin_user(self, user):
        if self.ADMIN_UIDS:
            return user['uid'] in self.ADMIN_UIDS
        email = str(user.get('email') or '').strip().lower()
        return user.get('email_verified') is True and email in self.ADMIN_EMAILS


def create_app():
    missing = [key for key in _REQUIRED_ENV if not os.environ.get(key, '').strip()]
    credential_file = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS', '').strip()
    if not credential_file and not os.environ.get('ACADEMY_FIREBASE_CREDENTIALS', '').strip():
        missing.append('GOOGLE_APPLICATION_CREDENTIALS or ACADEMY_FIREBASE_CREDENTIALS')
    if missing:
        raise RuntimeError('Missing Academy configuration: ' + ', '.join(missing))
    normalize_public_base_url(os.environ['PUBLIC_BASE_URL'], is_dev_like=False)
    project_id = os.environ['ACADEMY_FIREBASE_PROJECT_ID'].strip()
    if not re.fullmatch(r'[a-z][a-z0-9-]{4,28}[a-z0-9]', project_id) or project_id == 'lecture-processor-cdff6':
        raise RuntimeError('Configure a dedicated Academy Firebase project.')
    auth_domain = project_id + '.firebaseapp.com'
    public_config = {
        'apiKey': os.environ['ACADEMY_FIREBASE_API_KEY'],
        'appId': os.environ['ACADEMY_FIREBASE_APP_ID'],
        'projectId': project_id,
        'authDomain': auth_domain,
    }
    db, firebase_app = _firebase_clients(project_id, credential_file)
    app = Flask(__name__, root_path=str(_ROOT), template_folder='templates', static_folder='static')
    app.config.update(XPED_ACADEMY=True, SECRET_KEY=os.environ['FLASK_SECRET_KEY'])
    app.extensions['lecture_processor'] = {'runtime': AcademyRuntime(db, firebase_app)}
    apply_proxy_fix(app, 1)
    register_static_versioning(app)
    app.register_blueprint(elearning_bp)
    app.register_blueprint(overview_bp)
    app.register_blueprint(academy_folders_bp)
    app.register_blueprint(collaboration)
    app.register_blueprint(academy_account_bp)
    app.register_blueprint(academy_language_bp)
    app.register_blueprint(academy_pages)
    app.register_blueprint(academy_reports)
    static_root = Path(app.static_folder)
    public_assets = {
        file.relative_to(static_root).as_posix()
        for pattern in _STATIC_ASSETS for file in static_root.glob(pattern) if file.is_file()
    }

    @app.errorhandler(AcademyEmailUnverified)
    def verify_email_required(_error):
        return jsonify(error='Please verify your email address before continuing.',
                       error_code=auth_service.EMAIL_NOT_VERIFIED_AUTH_ERROR), 403

    @app.errorhandler(HTTPException)
    def http_error(error):
        # Preserve e.g. Allow and Retry-After headers supplied by Werkzeug.
        response = error.get_response()
        if request.path.startswith('/api/'):
            response.set_data(app.json.dumps({'error': error.name}))
            response.content_type = 'application/json'
        elif not request.path.startswith('/static/'):
            response.set_data(render_template('academy/error.html', status_code=error.code))
            response.content_type = 'text/html; charset=utf-8'
        return response

    @app.get('/healthz')
    def healthz():
        return jsonify(status='ok')

    @app.route('/api/academy/authors', methods=['GET', 'POST'])
    def authors():
        try:
            return elearning_service.academy_authors(get_runtime())
        except ElearningError as error:
            return jsonify(error=str(error)), error.status
        except GoogleAPICallError:
            return jsonify(error='Cloud saving is temporarily unavailable. Please try again in a moment.'), 503

    @app.get('/privacy')
    def privacy():
        return render_template('academy_privacy.html')

    @app.before_request
    def prepare_request():
        if request.endpoint == 'static':
            if request.view_args['filename'] not in public_assets:
                abort(404)
        else:
            g.csp_nonce = secrets.token_urlsafe(18)

    @app.context_processor
    def academy_context():
        return {
            'academy_mode': True,
            'academy_firebase_config': public_config,
            'legal_contact_email': os.environ.get('LEGAL_CONTACT_EMAIL', '').strip(),
            'csp_nonce': getattr(g, 'csp_nonce', ''),
        }

    @app.after_request
    def security_headers(response):
        response.headers['Content-Security-Policy'] = build_content_security_policy(
            script_nonce=getattr(g, 'csp_nonce', ''),
            firebase_auth_origin='https://' + auth_domain,
            extra_frame_sources=('https://www.youtube-nocookie.com', 'https://player.vimeo.com'),
        )
        if request.endpoint != 'static':
            response.headers['Referrer-Policy'] = 'strict-origin'
            response.headers.setdefault('Cache-Control', 'private, no-store')
        return apply_security_headers(response, request_is_secure=request.is_secure)

    return app
