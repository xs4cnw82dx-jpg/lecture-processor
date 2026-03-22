"""Core runtime logic shared across blueprints and service modules."""

import os

import uuid

import threading

import time

import io

import json

import csv

import re

import shutil

import subprocess

import sys

import logging

import statistics

import random

from datetime import datetime, timedelta, timezone

from urllib.parse import urlparse

try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None

import stripe

from flask import Flask, request, jsonify, render_template, send_file, Response, stream_with_context, g, redirect, abort

from google import genai

from google.genai import types

from werkzeug.utils import secure_filename

from werkzeug.exceptions import RequestEntityTooLarge

try:
    from flask_compress import Compress
except Exception:
    Compress = None

try:
    import sentry_sdk
    from sentry_sdk.integrations.flask import FlaskIntegration
except Exception:
    sentry_sdk = None
    FlaskIntegration = None

try:
    import imageio_ffmpeg
except Exception:
    imageio_ffmpeg = None

import firebase_admin

from firebase_admin import credentials, auth, firestore

from lecture_processor.config import resolve_sentry_environment
from lecture_processor.domains.admin import metrics as admin_metrics
from lecture_processor.domains.ai import pipelines as ai_pipelines
from lecture_processor.domains.ai import study_generation
from lecture_processor.domains.account import users as account_users
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import purchases as billing_purchases
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.shared import parsing as shared_parsing
from lecture_processor.domains.study import audio as study_audio
from lecture_processor.domains.study import export as study_export
from lecture_processor.domains.study import progress as study_progress
from lecture_processor.domains.upload import import_audio as upload_import_audio
from lecture_processor.services import analytics_service, auth_service, file_service, job_state_service, prompt_registry, rate_limit_service, url_security

from lecture_processor.repositories import admin_repo, batch_repo, job_logs_repo, planner_repo, purchases_repo, runtime_jobs_repo, study_repo, users_repo
from lecture_processor.runtime import bootstrap as runtime_bootstrap
from lecture_processor.runtime import media_runtime
from lecture_processor.runtime import environment as runtime_environment
from lecture_processor.runtime.http_security import apply_security_headers as runtime_apply_security_headers
from lecture_processor.runtime.job_dispatcher import BoundedJobDispatcher, JobQueueFullError
from lecture_processor.runtime.proxy import client_ip_from_request

LEGACY_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT_DIR = os.path.dirname(os.path.dirname(LEGACY_MODULE_DIR))

runtime_bootstrap.load_local_environment()

app = None


def create_flask_app(*, flask_secret_key=''):
    app_obj = Flask(
        __name__,
        template_folder=os.path.join(PROJECT_ROOT_DIR, 'templates'),
        static_folder=os.path.join(PROJECT_ROOT_DIR, 'static'),
    )
    safe_secret_key = str(flask_secret_key or os.getenv('FLASK_SECRET_KEY', '') or '').strip()
    if safe_secret_key:
        app_obj.secret_key = safe_secret_key
    elif os.getenv('RENDER'):
        raise RuntimeError('FLASK_SECRET_KEY must be set in deployed environments.')
    else:
        app_obj.secret_key = 'dev-only-secret-key-change-me'
    if Compress is not None:
        Compress(app_obj)
    app_obj.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH
    return app_obj

LOG_LEVEL = (os.getenv('LOG_LEVEL', 'INFO') or 'INFO').strip().upper()

logger = runtime_bootstrap.configure_logging(LOG_LEVEL)

JOB_WORKERS = int(os.getenv('JOB_WORKERS', '2') or 2)

JOB_QUEUE_MAX_PENDING = int(os.getenv('JOB_QUEUE_MAX_PENDING', '8') or 8)

TRUSTED_PROXY_HOPS = int(os.getenv('TRUSTED_PROXY_HOPS', '1') or 1)

job_dispatcher = BoundedJobDispatcher(JOB_WORKERS, JOB_QUEUE_MAX_PENDING, logger=logger)

def log_event(level, event, **fields):
    payload = {'event': event}
    for key, value in fields.items():
        payload[str(key)] = value
    logger.log(level, json.dumps(payload, ensure_ascii=True))

UPLOAD_FOLDER = 'uploads'

STUDY_AUDIO_RELATIVE_DIR = 'study_audio'

STUDY_AUDIO_ROOT = os.path.abspath(os.path.join(UPLOAD_FOLDER, STUDY_AUDIO_RELATIVE_DIR))

ALLOWED_SLIDE_EXTENSIONS = {'pdf', 'pptx'}

ALLOWED_PDF_EXTENSIONS = ALLOWED_SLIDE_EXTENSIONS

ALLOWED_AUDIO_EXTENSIONS = {'mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac', 'webm'}

MAX_PDF_UPLOAD_BYTES = 50 * 1024 * 1024

MAX_AUDIO_UPLOAD_BYTES = 500 * 1024 * 1024

MAX_CONTENT_LENGTH = MAX_PDF_UPLOAD_BYTES + MAX_AUDIO_UPLOAD_BYTES + 10 * 1024 * 1024

ALLOWED_SLIDE_MIME_TYPES = {'application/pdf', 'application/x-pdf', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.ms-powerpoint'}

ALLOWED_PDF_MIME_TYPES = ALLOWED_SLIDE_MIME_TYPES

ALLOWED_AUDIO_MIME_TYPES = {'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/aac', 'audio/ogg', 'audio/flac', 'audio/webm', 'video/webm'}

runtime_bootstrap.ensure_directory(UPLOAD_FOLDER)

GEMINI_API_KEY = (os.getenv('GEMINI_API_KEY', '') or '').strip()

client = runtime_bootstrap.initialize_gemini_client(
    GEMINI_API_KEY,
    genai_module=genai,
    logger=logger,
)

firebase_runtime = runtime_bootstrap.initialize_firebase(
    logger=logger,
    credentials_module=credentials,
    firestore_module=firestore,
    firebase_admin_module=firebase_admin,
)
db = firebase_runtime.db
firebase_init_error = firebase_runtime.init_error

runtime_bootstrap.configure_stripe(stripe, os.getenv('STRIPE_SECRET_KEY'))

STRIPE_PUBLISHABLE_KEY = os.getenv('STRIPE_PUBLISHABLE_KEY', '')

STRIPE_WEBHOOK_SECRET = os.getenv('STRIPE_WEBHOOK_SECRET', '')

ADMIN_EMAILS = {email.strip().lower() for email in os.getenv('ADMIN_EMAILS', '').split(',') if email.strip()}

ADMIN_UIDS = {uid.strip() for uid in os.getenv('ADMIN_UIDS', '').split(',') if uid.strip()}

ADMIN_SESSION_COOKIE_NAME = 'lp_admin_session'

ADMIN_SESSION_DURATION_SECONDS = int(os.getenv('ADMIN_SESSION_DURATION_SECONDS', str(8 * 60 * 60)) or 8 * 60 * 60)

ADMIN_PAGE_UNAUTHORIZED_MODE = str(os.getenv('ADMIN_PAGE_UNAUTHORIZED_MODE', 'redirect')).strip().lower()

jobs = {}

JOBS_LOCK = threading.RLock()

RUNTIME_JOBS_COLLECTION = 'runtime_jobs'

RUNTIME_JOB_RECOVERY_BATCH_LIMIT = int(os.getenv('RUNTIME_JOB_RECOVERY_BATCH_LIMIT', '200') or 200)

RUNTIME_JOB_RECOVERY_ENABLED = str(os.getenv('ENABLE_RUNTIME_JOB_RECOVERY', '1')).strip().lower() in {'1', 'true', 'yes', 'on'}

RUNTIME_JOB_RECOVERY_LEASE_COLLECTION = str(os.getenv('RUNTIME_JOB_RECOVERY_LEASE_COLLECTION', 'runtime_job_recovery_leases') or 'runtime_job_recovery_leases').strip()

RUNTIME_JOB_RECOVERY_LEASE_ID = str(os.getenv('RUNTIME_JOB_RECOVERY_LEASE_ID', 'startup') or 'startup').strip()

RUNTIME_JOB_RECOVERY_LEASE_SECONDS = int(os.getenv('RUNTIME_JOB_RECOVERY_LEASE_SECONDS', '300') or 300)

RUNTIME_JOB_RECOVERY_LOCK = threading.Lock()

RUNTIME_JOB_RECOVERY_DONE = False

BATCH_JOB_RECOVERY_BATCH_LIMIT = int(os.getenv('BATCH_JOB_RECOVERY_BATCH_LIMIT', '100') or 100)

BATCH_JOB_RECOVERY_ENABLED = str(os.getenv('ENABLE_BATCH_JOB_RECOVERY', '1')).strip().lower() in {'1', 'true', 'yes', 'on'}

BATCH_JOB_RECOVERY_LEASE_COLLECTION = str(os.getenv('BATCH_JOB_RECOVERY_LEASE_COLLECTION', 'batch_job_recovery_leases') or 'batch_job_recovery_leases').strip()

BATCH_JOB_RECOVERY_LEASE_ID = str(os.getenv('BATCH_JOB_RECOVERY_LEASE_ID', 'startup') or 'startup').strip()

BATCH_JOB_RECOVERY_LEASE_SECONDS = int(os.getenv('BATCH_JOB_RECOVERY_LEASE_SECONDS', '300') or 300)

BATCH_JOB_RECOVERY_STALE_SECONDS = int(os.getenv('BATCH_JOB_RECOVERY_STALE_SECONDS', '0') or 0)

BATCH_JOB_RECOVERY_LOCK = threading.Lock()

BATCH_JOB_RECOVERY_DONE = False

RUNTIME_JOB_PERSISTED_FIELDS = {'status', 'step', 'step_description', 'total_steps', 'mode', 'job_scope', 'tool_source_type', 'tool_input_name', 'user_id', 'user_email', 'credit_deducted', 'credit_refunded', 'started_at', 'finished_at', 'result', 'slide_text', 'transcript', 'flashcards', 'test_questions', 'flashcard_selection', 'question_selection', 'study_features', 'output_language', 'study_generation_error', 'study_pack_id', 'study_pack_title', 'error', 'billing_receipt', 'interview_features', 'interview_features_successful', 'interview_summary', 'interview_sections', 'interview_combined', 'interview_features_cost', 'extra_slides_refunded', 'audio_storage_key', 'notes_audio_map', 'transcript_segments', 'token_usage_by_stage', 'token_input_total', 'token_output_total', 'token_total', 'export_manifest', 'is_batch', 'batch_parent_id', 'batch_row_id', 'billing_mode', 'billing_multiplier', 'stage_costs'}

RUNTIME_JOB_MAX_STRING_LENGTH = 200000

AUDIO_STREAM_TOKEN_TTL_SECONDS = 3600

AUDIO_STREAM_TOKENS = {}

ALLOW_LEGACY_AUDIO_STREAM_TOKENS = str(os.getenv('ALLOW_LEGACY_AUDIO_STREAM_TOKENS', '0')).strip().lower() in {'1', 'true', 'yes', 'on'}

AUDIO_IMPORT_TOKEN_TTL_SECONDS = 30 * 60

AUDIO_IMPORT_TOKENS = {}

AUDIO_IMPORT_LOCK = threading.Lock()

FEATURE_AUDIO_SECTION_SYNC = os.getenv('FEATURE_AUDIO_SECTION_SYNC', '0').strip().lower() in {'1', 'true', 'yes', 'on'}

MAX_PROGRESS_PACKS_PER_SYNC = 300

MAX_PROGRESS_CARDS_PER_PACK = 2500

PROGRESS_DATE_RE = re.compile('^\\d{4}-\\d{2}-\\d{2}$')

ANALYTICS_NAME_RE = re.compile('^[a-z0-9_]{2,64}$')

ANALYTICS_SESSION_ID_RE = re.compile('^[A-Za-z0-9_-]{6,80}$')

ANALYTICS_ALLOWED_EVENTS = {'auth_modal_opened', 'auth_success', 'auth_failed', 'checkout_started', 'payment_confirmed', 'payment_cancelled', 'process_clicked', 'processing_started', 'processing_completed', 'processing_failed', 'processing_timeout', 'processing_retry_requested', 'study_mode_opened', 'payment_confirmed_backend', 'processing_started_backend', 'processing_completed_backend', 'processing_failed_backend', 'processing_finished_backend'}

ANALYTICS_FUNNEL_STAGES = [{'event': 'auth_modal_opened', 'label': 'Opened sign-in'}, {'event': 'auth_success', 'label': 'Signed in'}, {'event': 'checkout_started', 'label': 'Started checkout'}, {'event': 'payment_confirmed', 'label': 'Payment confirmed'}, {'event': 'process_clicked', 'label': 'Clicked process'}, {'event': 'processing_started', 'label': 'Upload accepted'}, {'event': 'processing_completed', 'label': 'Processing complete'}, {'event': 'study_mode_opened', 'label': 'Opened study mode'}]

ANALYTICS_FUNNEL_EVENT_NAMES = {stage['event'] for stage in ANALYTICS_FUNNEL_STAGES}

def safe_int_env(name, default=0, minimum=1, maximum=100000):
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except Exception:
        value = int(default)
    return min(max(value, minimum), maximum)

UPLOAD_RATE_LIMIT_WINDOW_SECONDS = safe_int_env('UPLOAD_RATE_LIMIT_WINDOW_SECONDS', 600, minimum=10, maximum=86400)

UPLOAD_RATE_LIMIT_MAX_REQUESTS = safe_int_env('UPLOAD_RATE_LIMIT_MAX_REQUESTS', 10, minimum=1, maximum=1000)

MAX_ACTIVE_JOBS_PER_USER = safe_int_env('MAX_ACTIVE_JOBS_PER_USER', 2, minimum=1, maximum=20)

CHECKOUT_RATE_LIMIT_WINDOW_SECONDS = safe_int_env('CHECKOUT_RATE_LIMIT_WINDOW_SECONDS', 600, minimum=10, maximum=86400)

CHECKOUT_RATE_LIMIT_MAX_REQUESTS = safe_int_env('CHECKOUT_RATE_LIMIT_MAX_REQUESTS', 6, minimum=1, maximum=100)

ANALYTICS_RATE_LIMIT_WINDOW_SECONDS = safe_int_env('ANALYTICS_RATE_LIMIT_WINDOW_SECONDS', 60, minimum=10, maximum=3600)

ANALYTICS_RATE_LIMIT_MAX_REQUESTS = safe_int_env('ANALYTICS_RATE_LIMIT_MAX_REQUESTS', 240, minimum=10, maximum=5000)

VIDEO_IMPORT_RATE_LIMIT_WINDOW_SECONDS = safe_int_env('VIDEO_IMPORT_RATE_LIMIT_WINDOW_SECONDS', 600, minimum=30, maximum=86400)

VIDEO_IMPORT_RATE_LIMIT_MAX_REQUESTS = safe_int_env('VIDEO_IMPORT_RATE_LIMIT_MAX_REQUESTS', 8, minimum=1, maximum=200)

TOOLS_RATE_LIMIT_WINDOW_SECONDS = safe_int_env('TOOLS_RATE_LIMIT_WINDOW_SECONDS', 600, minimum=30, maximum=86400)

TOOLS_RATE_LIMIT_MAX_REQUESTS = safe_int_env('TOOLS_RATE_LIMIT_MAX_REQUESTS', 10, minimum=1, maximum=300)

UPLOAD_MIN_FREE_DISK_BYTES = safe_int_env('UPLOAD_MIN_FREE_DISK_BYTES', 1024 * 1024 * 1024, minimum=50 * 1024 * 1024, maximum=500 * 1024 * 1024 * 1024)

UPLOAD_DAILY_BYTE_CAP = safe_int_env('UPLOAD_DAILY_BYTE_CAP', 2 * 1024 * 1024 * 1024, minimum=100 * 1024 * 1024, maximum=5 * 1024 * 1024 * 1024 * 1024)

UPLOAD_DAILY_COUNTER_COLLECTION = 'upload_usage_daily'

ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION = safe_int_env('ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION', 10000, minimum=100, maximum=50000)

ACCOUNT_EXPORT_MAX_CSV_PACKS = safe_int_env('ACCOUNT_EXPORT_MAX_CSV_PACKS', 250, minimum=1, maximum=5000)

ACCOUNT_EXPORT_MAX_DOCX_PACKS = safe_int_env('ACCOUNT_EXPORT_MAX_DOCX_PACKS', 40, minimum=1, maximum=1000)

ACCOUNT_EXPORT_MAX_PDF_PACKS = safe_int_env('ACCOUNT_EXPORT_MAX_PDF_PACKS', 20, minimum=1, maximum=1000)

ACCOUNT_EXPORT_ZIP_SPOOL_BYTES = safe_int_env('ACCOUNT_EXPORT_ZIP_SPOOL_BYTES', 5 * 1024 * 1024, minimum=1024 * 1024, maximum=250 * 1024 * 1024)

ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION = safe_int_env('ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION', 10000, minimum=100, maximum=50000)

RATE_LIMIT_EVENTS = {}

RATE_LIMIT_LOCK = threading.Lock()

RATE_LIMIT_COUNTER_COLLECTION = 'rate_limit_counters'

RATE_LIMIT_FIRESTORE_ENABLED = str(os.getenv('RATE_LIMIT_FIRESTORE_ENABLED', '1')).strip().lower() in {'1', 'true', 'yes', 'on'}

SENTRY_BACKEND_DSN = os.getenv('SENTRY_DSN_BACKEND', '').strip()

SENTRY_FRONTEND_DSN = os.getenv('SENTRY_DSN_FRONTEND', '').strip()

SENTRY_ENVIRONMENT = resolve_sentry_environment()

SENTRY_RELEASE = (os.getenv('SENTRY_RELEASE', 'lecture-processor') or 'lecture-processor').strip()

SENTRY_CAPTURE_LOCAL = str(os.getenv('SENTRY_CAPTURE_LOCAL', '0')).strip().lower() in {'1', 'true', 'yes', 'on'}

LEGAL_CONTACT_EMAIL = 'email@lectureprocessor.com'

DEV_ENV_NAMES = {'development', 'dev', 'local', 'test'}

APP_BOOT_TS = time.time()


def _self_runtime():
    return sys.modules[__name__]

def parse_cors_allowed_origins():
    raw = (os.getenv('CORS_ALLOWED_ORIGINS', '') or '').strip()
    if raw:
        origins = [part.strip().lower() for part in raw.split(',') if part.strip()]
        return set(origins)
    return {
        'http://127.0.0.1:5000',
        'http://localhost:5000',
        'http://127.0.0.1:10000',
        'http://localhost:10000',
        'https://lecture-processor.onrender.com',
        'https://lecture-processor-1.onrender.com',
        'https://lectureprocessor.com',
        'https://www.lectureprocessor.com',
    }

CORS_ALLOWED_ORIGINS = parse_cors_allowed_origins()

def safe_float_env(name, default=0.0):
    return runtime_bootstrap.safe_float_env(name, default, environ=os.environ)

SENTRY_TRACES_SAMPLE_RATE = safe_float_env('SENTRY_TRACES_SAMPLE_RATE', 0.0)

def should_init_backend_sentry():
    return runtime_bootstrap.should_init_backend_sentry(
        backend_dsn=SENTRY_BACKEND_DSN,
        sentry_sdk_module=sentry_sdk,
        flask_integration=FlaskIntegration,
        capture_local=SENTRY_CAPTURE_LOCAL,
        environ=os.environ,
        argv=sys.argv,
    )


if should_init_backend_sentry():
    runtime_bootstrap.initialize_backend_sentry(
        backend_dsn=SENTRY_BACKEND_DSN,
        sentry_sdk_module=sentry_sdk,
        flask_integration=FlaskIntegration,
        traces_sample_rate=SENTRY_TRACES_SAMPLE_RATE,
        environment=SENTRY_ENVIRONMENT,
        release=SENTRY_RELEASE,
    )

def is_dev_environment():
    return runtime_environment.is_dev_environment(
        environ=os.environ,
        sentry_environment=SENTRY_ENVIRONMENT,
    )

def get_public_base_url():
    return runtime_environment.get_public_base_url(environ=os.environ, logger=logger)

PUBLIC_BASE_URL = get_public_base_url()


def _env_truthy(name, default='0'):
    return runtime_bootstrap.env_truthy(name, default, environ=os.environ)


BATCH_EMAIL_NOTIFICATIONS_ENABLED = _env_truthy('BATCH_EMAIL_NOTIFICATIONS_ENABLED', '1')
SMTP_HOST = (os.getenv('SMTP_HOST', '') or '').strip()
SMTP_PORT = safe_int_env('SMTP_PORT', 587, minimum=1, maximum=65535)
SMTP_USERNAME = (os.getenv('SMTP_USERNAME', '') or '').strip()
SMTP_PASSWORD = (os.getenv('SMTP_PASSWORD', '') or '').strip()
SMTP_USE_TLS = _env_truthy('SMTP_USE_TLS', '1')
SMTP_USE_SSL = _env_truthy('SMTP_USE_SSL', '0')
SMTP_FROM_EMAIL = (os.getenv('SMTP_FROM_EMAIL', '') or '').strip()
SMTP_FROM_NAME = (os.getenv('SMTP_FROM_NAME', 'Lecture Processor') or 'Lecture Processor').strip()
SMTP_REPLY_TO = (os.getenv('SMTP_REPLY_TO', '') or '').strip()
SMTP_TIMEOUT_SECONDS = safe_int_env('SMTP_TIMEOUT_SECONDS', 12, minimum=1, maximum=120)

def should_use_minified_js_assets():
    raw = str(os.getenv('USE_MINIFIED_JS_ASSETS', '') or '').strip().lower()
    if raw:
        return raw in {'1', 'true', 'yes', 'on'}
    return not is_dev_environment()

def resolve_js_asset(filename):
    """Use minified JS outside development when a built bundle exists."""
    safe_name = str(filename or '').strip()
    if not safe_name.endswith('.js'):
        return safe_name
    if not should_use_minified_js_assets():
        return safe_name
    min_name = safe_name[:-3] + '.min.js'
    min_path = os.path.join(PROJECT_ROOT_DIR, 'static', min_name)
    if os.path.exists(min_path):
        return min_name
    return safe_name

def infer_stripe_key_mode(key_value):
    key = str(key_value or '').strip()
    if not key:
        return 'missing'
    if key.startswith('sk_live_') or key.startswith('pk_live_'):
        return 'live'
    if key.startswith('sk_test_') or key.startswith('pk_test_'):
        return 'test'
    return 'unknown'


def _extract_hostname(value):
    return runtime_environment.extract_hostname(value)


def _resolve_host_status(request_hostname, *, render_hostname='', public_hostname=''):
    return runtime_environment.resolve_host_status(
        request_hostname,
        render_hostname=render_hostname,
        public_hostname=public_hostname,
    )


def build_admin_deployment_info(request_host=''):
    return runtime_environment.build_admin_deployment_info(
        request_host,
        environ=os.environ,
        public_base_url=PUBLIC_BASE_URL,
        app_boot_ts=APP_BOOT_TS,
        now_ts=time.time(),
    )

def build_admin_runtime_checks():
    return admin_metrics.build_admin_runtime_checks(runtime=_self_runtime())

def apply_cors_headers(response):
    origin = str(request.headers.get('Origin', '') or '').strip()
    if not origin:
        return response
    if not request.path.startswith('/api/'):
        return response
    if origin.lower() not in CORS_ALLOWED_ORIGINS:
        return response
    response.headers['Access-Control-Allow-Origin'] = origin
    existing_vary = str(response.headers.get('Vary', '') or '').strip()
    response.headers['Vary'] = 'Origin' if not existing_vary else f'{existing_vary}, Origin'
    response.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    return response


def apply_security_headers(response):
    return runtime_apply_security_headers(
        response,
        request_is_secure=bool(request.is_secure or os.getenv('RENDER')),
        sentry_frontend_dsn=SENTRY_FRONTEND_DSN,
        script_nonce=getattr(g, 'csp_nonce', ''),
    )

CREDIT_BUNDLES = {'lecture_5': {'name': 'Lecture Notes — 5 Pack', 'description': '5 standard lecture credits', 'credits': {'lecture_credits_standard': 5}, 'price_cents': 999, 'currency': 'eur'}, 'lecture_10': {'name': 'Lecture Notes — 10 Pack', 'description': '10 standard lecture credits (best value)', 'credits': {'lecture_credits_standard': 10}, 'price_cents': 1699, 'currency': 'eur'}, 'slides_10': {'name': 'Slides Extraction — 10 Pack', 'description': '10 slides extraction credits', 'credits': {'slides_credits': 10}, 'price_cents': 499, 'currency': 'eur'}, 'slides_25': {'name': 'Slides Extraction — 25 Pack', 'description': '25 slides extraction credits (best value)', 'credits': {'slides_credits': 25}, 'price_cents': 999, 'currency': 'eur'}, 'interview_3': {'name': 'Interview Transcription — 3 Pack', 'description': '3 interview transcription credits', 'credits': {'interview_credits_short': 3}, 'price_cents': 799, 'currency': 'eur'}, 'interview_8': {'name': 'Interview Transcription — 8 Pack', 'description': '8 interview transcription credits (best value)', 'credits': {'interview_credits_short': 8}, 'price_cents': 1799, 'currency': 'eur'}}

EMAIL_ALLOWLIST_CONFIG_PATH = os.path.join(PROJECT_ROOT_DIR, 'config', 'allowed_email_domains.json')

def load_email_allowlist_config(path):
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
    except Exception as e:
        raise RuntimeError(f'Could not read allowlist config at {path}: {e}')
    if not isinstance(data, dict):
        raise RuntimeError(f'Allowlist config at {path} must be a JSON object.')
    raw_domains = data.get('domains', [])
    raw_suffixes = data.get('suffixes', [])
    if not isinstance(raw_domains, list) or not isinstance(raw_suffixes, list):
        raise RuntimeError(f"Allowlist config at {path} must contain list values for 'domains' and 'suffixes'.")
    domains = {str(item).strip().lower() for item in raw_domains if str(item).strip()}
    suffixes = [str(item).strip().lower() for item in raw_suffixes if str(item).strip()]
    if not domains:
        raise RuntimeError(f'Allowlist config at {path} has an empty domains list.')
    if not suffixes:
        raise RuntimeError(f'Allowlist config at {path} has an empty suffixes list.')
    return (domains, suffixes)

ALLOWED_EMAIL_DOMAINS, ALLOWED_EMAIL_PATTERNS = load_email_allowlist_config(EMAIL_ALLOWLIST_CONFIG_PATH)

def is_email_allowed(email):
    if not email:
        return False
    email = email.lower()
    domain = email.split('@')[-1] if '@' in email else ''
    if domain in ALLOWED_EMAIL_DOMAINS:
        return True
    for pattern in ALLOWED_EMAIL_PATTERNS:
        if domain.endswith(pattern):
            return True
    return False

MODEL_SLIDES = 'gemini-3.1-flash-lite-preview'

MODEL_AUDIO = 'gemini-3-flash-preview'

MODEL_INTEGRATION = 'gemini-2.5-pro'

MODEL_INTERVIEW = 'gemini-2.5-pro'

MODEL_STUDY = 'gemini-3.1-flash-lite-preview'

MODEL_TOOLS = 'gemini-3.1-flash-lite-preview'

ALLOWED_TOOLS_DOC_EXTENSIONS = {'pdf', 'pptx', 'docx'}

ALLOWED_TOOLS_IMAGE_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp', 'heic', 'heif'}

ALLOWED_TOOLS_DOC_MIME_TYPES = set(ALLOWED_SLIDE_MIME_TYPES) | {'application/vnd.openxmlformats-officedocument.wordprocessingml.document'}

ALLOWED_TOOLS_IMAGE_MIME_TYPES = {'image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif'}

MAX_TOOLS_DOCUMENT_BYTES = safe_int_env('MAX_TOOLS_DOCUMENT_BYTES', 50 * 1024 * 1024, minimum=1 * 1024 * 1024, maximum=100 * 1024 * 1024)

MAX_TOOLS_IMAGE_BYTES = safe_int_env('MAX_TOOLS_IMAGE_BYTES', 20 * 1024 * 1024, minimum=1 * 1024 * 1024, maximum=50 * 1024 * 1024)

MODEL_PRICING_CONFIG_PATH = os.path.join(PROJECT_ROOT_DIR, 'config', 'model_pricing.json')

MODEL_PRICING_CACHE_TTL_SECONDS = safe_int_env('MODEL_PRICING_CACHE_TTL_SECONDS', 300, minimum=30, maximum=3600)

MODEL_PRICING_CACHE = {'loaded_at': 0.0, 'payload': None}

FREE_LECTURE_CREDITS = 1

FREE_SLIDES_CREDITS = 2

FREE_INTERVIEW_CREDITS = 0

OUTPUT_LANGUAGE_MAP = {'dutch': 'Dutch', 'english': 'English', 'spanish': 'Spanish', 'french': 'French', 'german': 'German', 'chinese': 'Chinese'}

DEFAULT_OUTPUT_LANGUAGE_KEY = 'english'

OUTPUT_LANGUAGE_KEYS = set(OUTPUT_LANGUAGE_MAP.keys()) | {'other'}

MAX_OUTPUT_LANGUAGE_CUSTOM_LENGTH = 40

VIDEO_IMPORT_MAX_URL_LENGTH = 4096

VIDEO_IMPORT_ALLOWED_HOST_SUFFIXES = tuple((part.strip().lower() for part in (os.getenv('VIDEO_IMPORT_ALLOWED_HOST_SUFFIXES', 'kaltura.com,ovp.kaltura.com,brightspace.com,d2l.com') or '').split(',') if part.strip()))

PROMPT_REGISTRY_VERSION = prompt_registry.PROMPT_REGISTRY_VERSION

PROMPT_SLIDE_EXTRACTION = prompt_registry.PROMPT_SLIDE_EXTRACTION

PROMPT_AUDIO_TRANSCRIPTION = prompt_registry.PROMPT_AUDIO_TRANSCRIPTION

PROMPT_AUDIO_TRANSCRIPTION_TIMESTAMPED = prompt_registry.PROMPT_AUDIO_TRANSCRIPTION_TIMESTAMPED

PROMPT_INTERVIEW_TRANSCRIPTION = prompt_registry.PROMPT_INTERVIEW_TRANSCRIPTION

PROMPT_INTERVIEW_SUMMARY = prompt_registry.PROMPT_INTERVIEW_SUMMARY

PROMPT_INTERVIEW_SECTIONED = prompt_registry.PROMPT_INTERVIEW_SECTIONED

PROMPT_MERGE_TEMPLATE = prompt_registry.PROMPT_MERGE_TEMPLATE

PROMPT_MERGE_WITH_AUDIO_MARKERS = prompt_registry.PROMPT_MERGE_WITH_AUDIO_MARKERS

PROMPT_STUDY_TEMPLATE = prompt_registry.PROMPT_STUDY_TEMPLATE

def get_prompt_inventory():
    return prompt_registry.get_prompt_inventory()

def get_prompt_inventory_markdown():
    return prompt_registry.get_prompt_inventory_markdown()

JOB_TTL_SECONDS = safe_int_env('JOB_TTL_SECONDS', 30 * 60, minimum=5 * 60, maximum=24 * 60 * 60)

JOB_CLEANUP_INTERVAL_SECONDS = 5 * 60

PROCESSING_PUBLIC_ERROR_MESSAGE = 'Processing failed. Your credit has been refunded.'

def cleanup_old_jobs():
    """Evict completed/errored jobs older than JOB_TTL_SECONDS to prevent OOM."""
    now_ts = time.time()
    expired_ids = []
    with JOBS_LOCK:
        for job_id, job in list(jobs.items()):
            status = job.get('status', '')
            if status not in ('complete', 'error'):
                continue
            finished_at = job.get('finished_at', job.get('started_at', now_ts))
            if now_ts - finished_at > JOB_TTL_SECONDS:
                expired_ids.append(job_id)
        for job_id in expired_ids:
            jobs.pop(job_id, None)
    for job_id in expired_ids:
        delete_runtime_job_snapshot(job_id)

def cleanup_expired_audio_stream_tokens():
    """Evict expired audio stream tokens to prevent unbounded memory growth."""
    now_ts = time.time()
    expired = [t for t, d in list(AUDIO_STREAM_TOKENS.items()) if now_ts > d.get('expires_at', 0)]
    for token in expired:
        AUDIO_STREAM_TOKENS.pop(token, None)

def _run_periodic_cleanup():
    """Background thread: periodically evict stale jobs and audio stream tokens."""
    while True:
        time.sleep(JOB_CLEANUP_INTERVAL_SECONDS)
        try:
            cleanup_old_jobs()
            cleanup_expired_audio_stream_tokens()
        except Exception:
            logger.warning('Periodic cleanup failed', exc_info=True)

_cleanup_thread = threading.Thread(target=_run_periodic_cleanup, daemon=True)

def build_default_user_data(uid, email):
    """Return the canonical default user document structure."""
    return account_users.build_default_user_data(uid, email, runtime=_self_runtime())

def get_or_create_user(uid, email):
    """Get a user from Firestore, or create them with free credits if they don't exist."""
    return account_users.get_or_create_user(uid, email, runtime=_self_runtime())

def grant_credits_to_user(uid, bundle_id):
    """Grant credits from a purchased bundle to a user in Firestore."""
    return billing_credits.grant_credits_to_user(uid, bundle_id, runtime=_self_runtime())

def deduct_credit(uid, credit_type_primary, credit_type_fallback=None):
    """Deduct one credit atomically using a Firestore transaction. Returns the credit type deducted, or None."""
    return billing_credits.deduct_credit(
        uid,
        credit_type_primary,
        credit_type_fallback,
        runtime=_self_runtime(),
    )

def deduct_interview_credit(uid):
    """Deduct one interview credit atomically, checking short -> medium -> long. Returns the credit type deducted, or None."""
    return billing_credits.deduct_interview_credit(uid, runtime=_self_runtime())

def refund_credit(uid, credit_type):
    """Refund one credit back to the user after a failed processing job."""
    return billing_credits.refund_credit(uid, credit_type, runtime=_self_runtime())

def save_purchase_record(uid, bundle_id, stripe_session_id):
    """Save a purchase record to Firestore for purchase history."""
    billing_purchases.save_purchase_record(uid, bundle_id, stripe_session_id, runtime=_self_runtime())

def purchase_record_exists_for_session(stripe_session_id):
    return billing_purchases.purchase_record_exists_for_session(
        stripe_session_id,
        runtime=_self_runtime(),
    )

def process_checkout_session_credits(stripe_session):
    return billing_purchases.process_checkout_session_credits(
        stripe_session,
        runtime=_self_runtime(),
    )

def sanitize_analytics_event_name(raw_name):
    return analytics_service.sanitize_event_name(raw_name, name_re=ANALYTICS_NAME_RE, allowed_events=ANALYTICS_ALLOWED_EVENTS)

def sanitize_analytics_session_id(raw_session_id):
    return analytics_service.sanitize_session_id(raw_session_id, session_id_re=ANALYTICS_SESSION_ID_RE)

def sanitize_analytics_properties(raw_props):
    return analytics_service.sanitize_properties(raw_props, name_re=ANALYTICS_NAME_RE)

def log_analytics_event(event_name, source='frontend', uid='', email='', session_id='', properties=None, created_at=None):
    runtime = app.extensions.get('lecture_processor', {}).get('runtime')
    return analytics_service.log_analytics_event(event_name, source=source, uid=uid, email=email, session_id=session_id, properties=properties, created_at=created_at, db=db, name_re=ANALYTICS_NAME_RE, session_id_re=ANALYTICS_SESSION_ID_RE, allowed_events=ANALYTICS_ALLOWED_EVENTS, logger=logger, time_module=time, runtime=runtime)

def log_rate_limit_hit(limit_name, retry_after=0):
    runtime = app.extensions.get('lecture_processor', {}).get('runtime')
    return analytics_service.log_rate_limit_hit(limit_name, retry_after=retry_after, db=db, logger=logger, time_module=time, runtime=runtime)

def save_job_log(job_id, job_data, finished_at):
    """Save a processing job log to Firestore for analytics."""
    try:
        from lecture_processor.domains.admin import metrics as admin_metrics
        from lecture_processor.domains.admin import rollups as admin_rollups

        started_at = job_data.get('started_at', 0)
        duration = round(finished_at - started_at, 1) if started_at else 0
        payload = {
            'job_id': job_id,
            'uid': job_data.get('user_id', ''),
            'email': job_data.get('user_email', ''),
            'mode': job_data.get('mode', ''),
            'source_type': job_data.get('source_type', ''),
            'source_url': job_data.get('source_url', ''),
            'source_name': job_data.get('source_name', ''),
            'status': job_data.get('status', ''),
            'study_features': job_data.get('study_features', 'none'),
            'interview_features_count': len(job_data.get('interview_features', [])) if isinstance(job_data.get('interview_features'), list) else 0,
            'credit_deducted': job_data.get('credit_deducted', ''),
            'credit_refunded': job_data.get('credit_refunded', False),
            'error_message': job_data.get('error', ''),
            'failed_stage': job_data.get('failed_stage', ''),
            'provider_error_code': job_data.get('provider_error_code', ''),
            'retry_attempts': int(job_data.get('retry_attempts', 0) or 0),
            'token_usage_by_stage': job_data.get('token_usage_by_stage', {}),
            'token_input_total': int(job_data.get('token_input_total', 0) or 0),
            'token_output_total': int(job_data.get('token_output_total', 0) or 0),
            'token_total': int(job_data.get('token_total', 0) or 0),
            'file_size_mb': round(float(job_data.get('file_size_mb', 0) or 0), 2),
            'custom_prompt': job_data.get('custom_prompt', ''),
            'prompt_template_key': job_data.get('prompt_template_key', ''),
            'prompt_source': job_data.get('prompt_source', ''),
            'custom_prompt_length': int(job_data.get('custom_prompt_length', 0) or 0),
            'effective_prompt_preview': str(job_data.get('effective_prompt_preview', '') or '')[:1800],
            'credit_refund_method': job_data.get('credit_refund_method', ''),
            'is_batch': bool(job_data.get('is_batch', False)),
            'batch_parent_id': str(job_data.get('batch_parent_id', '') or ''),
            'batch_row_id': str(job_data.get('batch_row_id', '') or ''),
            'billing_mode': str(job_data.get('billing_mode', 'standard') or 'standard'),
            'billing_multiplier': float(job_data.get('billing_multiplier', 1.0) or 1.0),
            'stage_costs': job_data.get('stage_costs', []),
            'started_at': started_at,
            'finished_at': finished_at,
            'duration_seconds': duration,
        }
        payload = admin_metrics.add_admin_visibility_flag(payload)
        job_logs_repo.set_job_log(db, job_id, payload)
        admin_rollups.increment_job_rollups(payload, runtime=app.extensions.get('lecture_processor', {}).get('runtime'))
        status = str(job_data.get('status', '') or '').lower()
        backend_event = 'processing_finished_backend'
        if status == 'complete':
            backend_event = 'processing_completed_backend'
        elif status == 'error':
            backend_event = 'processing_failed_backend'
        log_analytics_event(backend_event, source='backend', uid=job_data.get('user_id', ''), email=job_data.get('user_email', ''), session_id=job_id, properties={'job_id': job_id, 'mode': job_data.get('mode', ''), 'duration_seconds': duration, 'credit_refunded': bool(job_data.get('credit_refunded', False))}, created_at=finished_at)
        logger.info(f"📊 Logged job {job_id}: mode={job_data.get('mode')}, status={job_data.get('status')}, duration={duration}s")
    except Exception as e:
        logger.error(f'❌ Failed to log job {job_id}: {e}')

def recover_stale_runtime_jobs():
    """Recover jobs left in starting/processing state after a restart."""
    if db is None:
        return 0
    now_ts = time.time()
    recovered = 0
    try:
        stale_docs = runtime_jobs_repo.query_statuses(db, RUNTIME_JOBS_COLLECTION, {'starting', 'processing'}, limit=RUNTIME_JOB_RECOVERY_BATCH_LIMIT)
    except Exception:
        logger.warning('Runtime-job recovery query failed', exc_info=True)
        return 0
    for doc in stale_docs:
        job_id = doc.id
        job_data = doc.to_dict() or {}
        if not isinstance(job_data, dict):
            continue
        status = str(job_data.get('status', '') or '').lower()
        if status not in {'starting', 'processing'}:
            continue
        uid = str(job_data.get('user_id', '') or '').strip()
        credit_type = str(job_data.get('credit_deducted', '') or '').strip()
        already_refunded = bool(job_data.get('credit_refunded', False))
        if uid and credit_type and (not already_refunded):
            refund_credit(uid, credit_type)
            add_job_credit_refund(job_data, credit_type, 1)
            job_data['credit_refunded'] = True
        extra_spent = int(job_data.get('interview_features_cost', 0) or 0)
        extra_refunded = int(job_data.get('extra_slides_refunded', 0) or 0)
        extra_to_refund = max(0, extra_spent - extra_refunded)
        if uid and extra_to_refund > 0:
            refund_slides_credits(uid, extra_to_refund)
            job_data['extra_slides_refunded'] = extra_refunded + extra_to_refund
            add_job_credit_refund(job_data, 'slides_credits', extra_to_refund)
        ensure_job_billing_receipt(job_data, {credit_type: 1} if credit_type else None)
        job_data['status'] = 'error'
        job_data['step_description'] = 'Interrupted by server restart'
        job_data['error'] = 'Processing was interrupted by a server restart. Your credit has been refunded.'
        job_data['finished_at'] = now_ts
        job_data['job_id'] = job_id
        set_job(job_id, job_data)
        save_job_log(job_id, job_data, now_ts)
        recovered += 1
    if recovered:
        logger.warning('Recovered %s stale runtime jobs after startup.', recovered)
    return recovered

def acquire_runtime_job_recovery_lease(now_ts=None):
    if db is None:
        return True
    lease_collection = str(RUNTIME_JOB_RECOVERY_LEASE_COLLECTION or '').strip()
    lease_id = str(RUNTIME_JOB_RECOVERY_LEASE_ID or '').strip()
    if not lease_collection or not lease_id:
        return True
    now_ts = float(now_ts if isinstance(now_ts, (int, float)) else time.time())
    lease_seconds = max(30, min(int(RUNTIME_JOB_RECOVERY_LEASE_SECONDS or 300), 3600))
    holder_id = str(os.getenv('RENDER_INSTANCE_ID', '') or '').strip() or str(os.getenv('HOSTNAME', '') or '').strip() or f'pid-{os.getpid()}'
    lease_ref = db.collection(lease_collection).document(lease_id)
    transaction = db.transaction()

    @firestore.transactional
    def _txn(txn):
        snapshot = lease_ref.get(transaction=txn)
        existing = snapshot.to_dict() or {}
        existing_expires_at = get_timestamp(existing.get('expires_at'))
        if snapshot.exists and existing_expires_at > now_ts:
            return False
        txn.set(lease_ref, {'lease_id': lease_id, 'holder_id': holder_id, 'acquired_at': now_ts, 'expires_at': now_ts + lease_seconds}, merge=True)
        return True
    try:
        return bool(_txn(transaction))
    except Exception:
        logger.warning('Could not acquire runtime-job recovery lease; continuing without distributed lock.', exc_info=True)
        return True

def run_startup_recovery_once():
    global RUNTIME_JOB_RECOVERY_DONE
    with RUNTIME_JOB_RECOVERY_LOCK:
        if RUNTIME_JOB_RECOVERY_DONE:
            return
        RUNTIME_JOB_RECOVERY_DONE = True
    if not RUNTIME_JOB_RECOVERY_ENABLED:
        logger.info('Runtime-job recovery disabled via ENABLE_RUNTIME_JOB_RECOVERY.')
        return
    if not acquire_runtime_job_recovery_lease():
        logger.info('Skipping startup runtime-job recovery; lease already held by another instance.')
        return
    recover_stale_runtime_jobs()

def verify_firebase_token(request):
    return auth_service.verify_firebase_token(request, auth_module=auth, logger=logger)

def is_admin_user(decoded_token):
    if not decoded_token:
        return False
    uid = decoded_token.get('uid', '')
    email = decoded_token.get('email', '').lower()
    return uid in ADMIN_UIDS or email in ADMIN_EMAILS

def _extract_bearer_token(req):
    from lecture_processor.domains.auth import session as auth_session

    return auth_session._extract_bearer_token(req)

def verify_admin_session_cookie(req):
    from lecture_processor.domains.auth import session as auth_session

    return auth_session.verify_admin_session_cookie(req)

def get_admin_window(window_key):
    return admin_metrics.get_admin_window(window_key, runtime=_self_runtime())

def get_timestamp(value):
    return admin_metrics.get_timestamp(value, runtime=_self_runtime())

def build_time_buckets(window_key, now_ts):
    return admin_metrics.build_time_buckets(window_key, now_ts, runtime=_self_runtime())

def get_bucket_key(timestamp, window_key):
    return admin_metrics.get_bucket_key(timestamp, window_key, runtime=_self_runtime())

def query_docs_in_window(collection_name, timestamp_field, window_start, window_end=None, order_desc=False, limit=None):
    return admin_repo.query_docs_in_window(db, collection_name=collection_name, timestamp_field=timestamp_field, window_start=window_start, window_end=window_end, order_desc=order_desc, limit=limit, firestore_module=firestore)

def mark_admin_data_warning(collection_name, reason):
    return admin_metrics.mark_admin_data_warning(collection_name, reason, runtime=_self_runtime())

def get_admin_data_warnings():
    return admin_metrics.get_admin_data_warnings(runtime=_self_runtime())

def safe_query_docs_in_window(collection_name, timestamp_field, window_start, window_end=None, order_desc=False, limit=None):
    return admin_metrics.safe_query_docs_in_window(
        collection_name,
        timestamp_field,
        window_start,
        window_end=window_end,
        order_desc=order_desc,
        limit=limit,
        runtime=_self_runtime(),
    )

def safe_count_collection(collection_name):
    return admin_metrics.safe_count_collection(collection_name, runtime=_self_runtime())

def safe_count_window(collection_name, timestamp_field, window_start):
    return admin_metrics.safe_count_window(
        collection_name,
        timestamp_field,
        window_start,
        runtime=_self_runtime(),
    )

def build_admin_funnel_steps(analytics_docs, window_start):
    return admin_metrics.build_admin_funnel_steps(
        analytics_docs,
        window_start,
        runtime=_self_runtime(),
    )

def build_admin_funnel_daily_rows(analytics_docs, window_start, window_key, now_ts):
    return admin_metrics.build_admin_funnel_daily_rows(
        analytics_docs,
        window_start,
        window_key,
        now_ts,
        runtime=_self_runtime(),
    )

def _runtime_job_storage_enabled():
    return db is not None

def _runtime_job_sanitize_value(value):
    if isinstance(value, str):
        if len(value) > RUNTIME_JOB_MAX_STRING_LENGTH:
            return value[:RUNTIME_JOB_MAX_STRING_LENGTH]
        return value
    if isinstance(value, list):
        return [_runtime_job_sanitize_value(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _runtime_job_sanitize_value(v) for k, v in value.items()}
    return value

def _build_runtime_job_payload(job_id, job_data):
    payload = {'job_id': job_id, 'updated_at': time.time()}
    if not isinstance(job_data, dict):
        payload['status'] = 'unknown'
        return payload
    for field in RUNTIME_JOB_PERSISTED_FIELDS:
        if field in job_data:
            payload[field] = _runtime_job_sanitize_value(job_data.get(field))
    return payload

def persist_runtime_job_snapshot(job_id, job_data):
    if not _runtime_job_storage_enabled() or not job_id:
        return
    try:
        runtime_jobs_repo.set_doc(db, RUNTIME_JOBS_COLLECTION, job_id, _build_runtime_job_payload(job_id, job_data), merge=True)
    except Exception:
        logger.warning('Failed to persist runtime job snapshot for %s', job_id, exc_info=True)

def load_runtime_job_snapshot(job_id):
    if not _runtime_job_storage_enabled() or not job_id:
        return None
    try:
        doc = runtime_jobs_repo.get_doc(db, RUNTIME_JOBS_COLLECTION, job_id)
        if not doc.exists:
            return None
        data = doc.to_dict() or {}
        if not isinstance(data, dict):
            return None
        data.setdefault('job_id', job_id)
        return data
    except Exception:
        logger.warning('Failed to load runtime job snapshot for %s', job_id, exc_info=True)
        return None

def delete_runtime_job_snapshot(job_id):
    if not _runtime_job_storage_enabled() or not job_id:
        return
    try:
        runtime_jobs_repo.delete_doc(db, RUNTIME_JOBS_COLLECTION, job_id)
    except Exception:
        logger.warning('Failed to delete runtime job snapshot for %s', job_id, exc_info=True)

def update_job_fields(job_id, **fields):
    if not fields:
        return get_job_snapshot(job_id)

    def _mutator(job):
        job.update(fields)
    snapshot = mutate_job(job_id, _mutator)
    return snapshot

def get_job_snapshot(job_id):
    snapshot = job_state_service.get_job_snapshot(job_id, jobs_store=jobs, lock=JOBS_LOCK)
    if snapshot is not None:
        return snapshot
    runtime_snapshot = load_runtime_job_snapshot(job_id)
    if runtime_snapshot is not None:
        job_state_service.set_job(job_id, dict(runtime_snapshot), jobs_store=jobs, lock=JOBS_LOCK)
        return runtime_snapshot
    return None

def mutate_job(job_id, mutator_fn):
    snapshot = job_state_service.mutate_job(job_id, mutator_fn, jobs_store=jobs, lock=JOBS_LOCK)
    if snapshot is not None:
        persist_runtime_job_snapshot(job_id, snapshot)
    return snapshot

def set_job(job_id, value):
    snapshot = job_state_service.set_job(job_id, value, jobs_store=jobs, lock=JOBS_LOCK)
    if isinstance(snapshot, dict):
        persist_runtime_job_snapshot(job_id, snapshot)
    return snapshot

def delete_job(job_id):
    deleted = job_state_service.delete_job(job_id, jobs_store=jobs, lock=JOBS_LOCK)
    delete_runtime_job_snapshot(job_id)
    return deleted

def _window_counter_id(key, window_seconds, window_start):
    return rate_limit_service.window_counter_id(key, window_seconds, window_start)

def _check_rate_limit_firestore(key, limit, window_seconds, now_ts):
    return rate_limit_service.check_rate_limit_firestore(key, limit, window_seconds, now_ts, firestore_enabled=RATE_LIMIT_FIRESTORE_ENABLED, db=db, firestore_module=firestore, counter_collection=RATE_LIMIT_COUNTER_COLLECTION)

def check_rate_limit(key, limit, window_seconds):
    return rate_limit_service.check_rate_limit(key, limit, window_seconds, firestore_enabled=RATE_LIMIT_FIRESTORE_ENABLED, db=db, firestore_module=firestore, counter_collection=RATE_LIMIT_COUNTER_COLLECTION, in_memory_events=RATE_LIMIT_EVENTS, in_memory_lock=RATE_LIMIT_LOCK, time_module=time)

def build_rate_limited_response(message, retry_after):
    response = jsonify({'error': message, 'retry_after_seconds': int(max(1, retry_after))})
    response.status_code = 429
    response.headers['Retry-After'] = str(int(max(1, retry_after)))
    return response

def normalize_rate_limit_key_part(value, fallback='anon', max_len=120):
    raw = str(value or '').strip().lower()
    if not raw:
        return fallback
    safe = re.sub('[^a-z0-9_.:@-]+', '_', raw)
    return safe[:max_len] if safe else fallback


def get_client_ip(req=None):
    return client_ip_from_request(req or request)


def submit_background_job(target, *args, **kwargs):
    return job_dispatcher.submit(target, *args, **kwargs)


def get_background_queue_stats():
    return job_dispatcher.stats()

def has_sufficient_upload_disk_space(required_bytes=0):
    """Return (ok, free_bytes, threshold_bytes) for upload safety checks."""
    try:
        usage = shutil.disk_usage(UPLOAD_FOLDER if os.path.exists(UPLOAD_FOLDER) else '/')
        free_bytes = int(usage.free)
    except Exception:
        return (True, 0, UPLOAD_MIN_FREE_DISK_BYTES)
    try:
        required = int(required_bytes or 0)
    except Exception:
        required = 0
    needed = max(UPLOAD_MIN_FREE_DISK_BYTES, required + UPLOAD_MIN_FREE_DISK_BYTES)
    return (free_bytes >= needed, free_bytes, needed)

def reserve_daily_upload_bytes(uid, requested_bytes):
    """Atomically reserve upload bytes for a user in the current UTC day."""
    if db is None:
        return (True, 0)
    if not uid:
        return (False, 0)
    try:
        requested = int(requested_bytes or 0)
    except Exception:
        requested = 0
    requested = max(0, requested)
    if requested <= 0:
        return (True, 0)
    now_ts = time.time()
    day_key = datetime.fromtimestamp(now_ts, tz=timezone.utc).strftime('%Y-%m-%d')
    doc_id = f'{uid}:{day_key}'
    retry_after = max(1, int(datetime.fromtimestamp(now_ts, tz=timezone.utc).replace(hour=23, minute=59, second=59, microsecond=0).timestamp() - now_ts))
    counter_ref = db.collection(UPLOAD_DAILY_COUNTER_COLLECTION).document(doc_id)
    transaction = db.transaction()

    @firestore.transactional
    def _txn(txn):
        snapshot = counter_ref.get(transaction=txn)
        used = 0
        if snapshot.exists:
            used = int((snapshot.to_dict() or {}).get('bytes_used', 0) or 0)
        if used + requested > UPLOAD_DAILY_BYTE_CAP:
            return (False, retry_after)
        txn.set(counter_ref, {'uid': uid, 'day': day_key, 'bytes_used': used + requested, 'updated_at': now_ts, 'expires_at': now_ts + 3 * 24 * 60 * 60}, merge=True)
        return (True, 0)
    try:
        return _txn(transaction)
    except Exception:
        logger.warning('Upload daily byte reservation failed for uid=%s', uid, exc_info=True)
        return (True, 0)

def count_active_jobs_for_user(uid):
    return job_state_service.count_active_jobs_for_user(uid, jobs_store=jobs, lock=JOBS_LOCK)

def list_docs_by_uid(collection_name, uid, max_docs):
    docs = admin_repo.query_by_uid(db, collection_name, uid, max_docs + 1)
    truncated = len(docs) > max_docs
    limited = docs[:max_docs]
    records = []
    for doc in limited:
        data = doc.to_dict() or {}
        data['_id'] = doc.id
        records.append(data)
    return (records, truncated)

def delete_docs_by_uid(collection_name, uid, max_docs):
    docs = admin_repo.query_by_uid(db, collection_name, uid, max_docs + 1)
    truncated = len(docs) > max_docs
    limited = docs[:max_docs]
    deleted = 0
    for doc in limited:
        try:
            doc.reference.delete()
            deleted += 1
        except Exception as e:
            logger.warning(f'Warning: could not delete doc in {collection_name}/{doc.id}: {e}')
    return (deleted, truncated)

def remove_upload_artifacts_for_job_ids(job_ids):
    if not job_ids:
        return 0
    try:
        names = os.listdir(UPLOAD_FOLDER)
    except Exception:
        return 0
    prefixes = tuple((f'{str(job_id).strip()}_' for job_id in job_ids if str(job_id or '').strip()))
    if not prefixes:
        return 0
    removed = 0
    for name in names:
        if not name.startswith(prefixes):
            continue
        file_path = os.path.join(UPLOAD_FOLDER, name)
        try:
            if os.path.isfile(file_path):
                os.remove(file_path)
                removed += 1
        except Exception as e:
            logger.warning(f'Warning: could not delete upload artifact {file_path}: {e}')
    return removed

def anonymize_purchase_docs_by_uid(uid, max_docs):
    docs = purchases_repo.query_by_uid(db, uid, max_docs + 1)
    truncated = len(docs) > max_docs
    limited = docs[:max_docs]
    anonymized = 0
    for doc in limited:
        try:
            doc.reference.set({'uid': '', 'user_erased': True, 'erased_at': time.time()}, merge=True)
            anonymized += 1
        except Exception as e:
            logger.warning(f'Warning: could not anonymize purchase doc {doc.id}: {e}')
    return (anonymized, truncated)

def collect_user_export_payload(uid, email):
    user_doc = users_repo.get_doc(db, uid)
    user_profile = user_doc.to_dict() if user_doc.exists else {}
    study_progress_doc = get_study_progress_doc(uid).get()
    study_progress = study_progress_doc.to_dict() if study_progress_doc.exists else {}
    purchases, purchases_truncated = list_docs_by_uid('purchases', uid, ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION)
    job_logs, job_logs_truncated = list_docs_by_uid('job_logs', uid, ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION)
    analytics_events, analytics_truncated = list_docs_by_uid('analytics_events', uid, ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION)
    study_folders, folders_truncated = list_docs_by_uid('study_folders', uid, ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION)
    study_packs, packs_truncated = list_docs_by_uid('study_packs', uid, ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION)
    card_states, card_states_truncated = list_docs_by_uid('study_card_states', uid, ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION)
    for pack in study_packs:
        audio_key = get_audio_storage_key_from_pack(pack)
        audio_path = resolve_audio_storage_path_from_key(audio_key) if audio_key else ''
        pack['audio_filename'] = os.path.basename(audio_path) if audio_path else ''
        pack.pop('audio_storage_path', None)
        pack.pop('audio_storage_key', None)
    return {'meta': {'exported_at': time.time(), 'version': 1, 'uid': uid, 'email': email, 'source': 'lecture-processor', 'limits': {'max_docs_per_collection': ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION}, 'truncated': {'purchases': purchases_truncated, 'job_logs': job_logs_truncated, 'analytics_events': analytics_truncated, 'study_folders': folders_truncated, 'study_packs': packs_truncated, 'study_card_states': card_states_truncated}}, 'account': {'profile': user_profile, 'study_progress': study_progress}, 'collections': {'purchases': purchases, 'job_logs': job_logs, 'analytics_events': analytics_events, 'study_folders': study_folders, 'study_packs': study_packs, 'study_card_states': card_states}}

def parse_requested_amount(raw_value, allowed, default):
    return shared_parsing.parse_requested_amount(raw_value, allowed, default, runtime=_self_runtime())

def parse_study_features(raw_value):
    return shared_parsing.parse_study_features(raw_value, runtime=_self_runtime())

def normalize_output_language_choice(raw_value, custom_value=''):
    return shared_parsing.normalize_output_language_choice(
        raw_value,
        custom_value,
        runtime=_self_runtime(),
    )

def parse_output_language(raw_value, custom_value=''):
    return shared_parsing.parse_output_language(raw_value, custom_value, runtime=_self_runtime())

def sanitize_output_language_pref_key(raw_value):
    return shared_parsing.sanitize_output_language_pref_key(raw_value, runtime=_self_runtime())

def sanitize_output_language_pref_custom(raw_value):
    return shared_parsing.sanitize_output_language_pref_custom(raw_value, runtime=_self_runtime())

def build_user_preferences_payload(user_data):
    return shared_parsing.build_user_preferences_payload(user_data, runtime=_self_runtime())

def parse_interview_features(raw_value):
    return shared_parsing.parse_interview_features(raw_value, runtime=_self_runtime())

def host_matches_allowed_suffix(hostname):
    if not hostname:
        return False
    host = hostname.strip().lower()
    return any((host == suffix or host.endswith('.' + suffix) for suffix in VIDEO_IMPORT_ALLOWED_HOST_SUFFIXES))

def validate_video_import_url(raw_url):
    return upload_import_audio.validate_video_import_url(raw_url, runtime=_self_runtime())

def cleanup_expired_audio_import_tokens():
    return upload_import_audio.cleanup_expired_audio_import_tokens(runtime=_self_runtime())

def register_audio_import_token(uid, file_path, source_url='', original_name=''):
    return upload_import_audio.register_audio_import_token(
        uid,
        file_path,
        source_url=source_url,
        original_name=original_name,
        runtime=_self_runtime(),
    )

def get_audio_import_token_path(uid, token, consume=False):
    return upload_import_audio.get_audio_import_token_path(
        uid,
        token,
        consume=consume,
        runtime=_self_runtime(),
    )

def release_audio_import_token(uid, token):
    return upload_import_audio.release_audio_import_token(uid, token, runtime=_self_runtime())

def get_ffmpeg_binary():
    return media_runtime.get_ffmpeg_binary(which_func=shutil.which, imageio_ffmpeg_module=imageio_ffmpeg)

def get_ffprobe_binary():
    return media_runtime.get_ffprobe_binary(ffmpeg_binary_getter=get_ffmpeg_binary)

def download_audio_from_video_url(source_url, file_prefix):
    return media_runtime.download_audio_from_video_url(
        source_url,
        file_prefix,
        upload_folder=UPLOAD_FOLDER,
        max_audio_upload_bytes=MAX_AUDIO_UPLOAD_BYTES,
        ffmpeg_binary_getter=get_ffmpeg_binary,
        file_looks_like_audio_fn=file_looks_like_audio,
        get_saved_file_size_fn=get_saved_file_size,
        which_func=shutil.which,
        subprocess_module=subprocess,
    )

def download_video_from_video_url(source_url, file_prefix):
    return file_service.download_video_from_video_url(
        source_url,
        file_prefix,
        upload_folder=UPLOAD_FOLDER,
        max_download_bytes=MAX_AUDIO_UPLOAD_BYTES,
        ffmpeg_binary_getter=get_ffmpeg_binary,
        get_saved_file_size_fn=get_saved_file_size,
        which_func=shutil.which,
        subprocess_module=subprocess,
    )

def deduct_slides_credits(uid, amount):
    return billing_credits.deduct_slides_credits(uid, amount, runtime=_self_runtime())

def refund_slides_credits(uid, amount):
    return billing_credits.refund_slides_credits(uid, amount, runtime=_self_runtime())

def normalize_credit_ledger(credit_map):
    return billing_receipts.normalize_credit_ledger(credit_map, runtime=_self_runtime())

def initialize_billing_receipt(charged_map=None):
    return billing_receipts.initialize_billing_receipt(charged_map, runtime=_self_runtime())

def ensure_job_billing_receipt(job_data, charged_map=None):
    return billing_receipts.ensure_job_billing_receipt(
        job_data,
        charged_map=charged_map,
        runtime=_self_runtime(),
    )

def add_job_credit_refund(job_data, credit_type, amount=1):
    return billing_receipts.add_job_credit_refund(
        job_data,
        credit_type,
        amount=amount,
        runtime=_self_runtime(),
    )

def get_billing_receipt_snapshot(job_data):
    return billing_receipts.get_billing_receipt_snapshot(job_data, runtime=_self_runtime())

MODEL_THINKING_POLICY = {'gemini-3.1-flash-lite-preview': {'thinking_level': 'high'}, 'gemini-2.5-pro': {'thinking_budget': 32768}, 'gemini-3-flash-preview': {'thinking_level': 'high'}}

PROVIDER_RETRY_MAX_ATTEMPTS = safe_int_env('PROVIDER_RETRY_MAX_ATTEMPTS', 3, minimum=1, maximum=6)

PROVIDER_RETRY_BASE_SECONDS = max(0.2, min(10.0, float(os.getenv('PROVIDER_RETRY_BASE_SECONDS', '1.2') or 1.2)))

PROVIDER_RETRY_MAX_SECONDS = max(1.0, min(30.0, float(os.getenv('PROVIDER_RETRY_MAX_SECONDS', '10.0') or 10.0)))

PROVIDER_TRANSIENT_STATUS_CODES = {408, 409, 425, 429, 500, 502, 503, 504}

PROVIDER_TRANSIENT_MESSAGE_HINTS = ('timeout', 'timed out', 'temporarily unavailable', 'try again', 'resource exhausted', 'unavailable', 'internal error', 'connection reset', 'deadline exceeded')

def _build_thinking_config(model_name):
    """Build a ThinkingConfig for the given model based on MODEL_THINKING_POLICY."""
    policy = MODEL_THINKING_POLICY.get(model_name)
    if not policy or not hasattr(types, 'ThinkingConfig'):
        return None
    try:
        return types.ThinkingConfig(**policy)
    except Exception:
        return None

def get_provider_status_code(error):
    if error is None:
        return None
    for attr in ('status_code', 'code'):
        value = getattr(error, attr, None)
        if isinstance(value, int) and value > 0:
            return value
        if isinstance(value, str) and value.isdigit():
            return int(value)
    response = getattr(error, 'response', None)
    if response is not None:
        value = getattr(response, 'status_code', None)
        if isinstance(value, int) and value > 0:
            return value
    return None

def classify_provider_error_code(error):
    status_code = get_provider_status_code(error)
    if status_code:
        return f'HTTP_{status_code}'
    text = str(error or '').lower()
    if 'timeout' in text or 'timed out' in text or 'deadline exceeded' in text:
        return 'TIMEOUT'
    if 'resource exhausted' in text or 'rate limit' in text or 'too many requests' in text:
        return 'RATE_LIMIT'
    if 'unavailable' in text or 'temporarily unavailable' in text:
        return 'UNAVAILABLE'
    if 'connection reset' in text:
        return 'CONNECTION_RESET'
    return 'GENERIC'

def is_transient_provider_error(error):
    status_code = get_provider_status_code(error)
    if status_code in PROVIDER_TRANSIENT_STATUS_CODES:
        return True
    if isinstance(error, (TimeoutError, ConnectionError)):
        return True
    text = str(error or '').lower()
    return any((fragment in text for fragment in PROVIDER_TRANSIENT_MESSAGE_HINTS))

def run_with_provider_retry(operation_name, func, retry_tracker=None):
    attempts = max(1, PROVIDER_RETRY_MAX_ATTEMPTS)
    last_error = None
    for attempt in range(1, attempts + 1):
        try:
            result = func()
            if retry_tracker is not None:
                retry_tracker[operation_name] = max(retry_tracker.get(operation_name, 0), attempt - 1)
            return result
        except Exception as error:
            last_error = error
            transient = is_transient_provider_error(error)
            if retry_tracker is not None:
                retry_tracker[operation_name] = max(retry_tracker.get(operation_name, 0), attempt)
            if not transient or attempt >= attempts:
                raise
            delay = min(PROVIDER_RETRY_MAX_SECONDS, PROVIDER_RETRY_BASE_SECONDS * 2 ** (attempt - 1))
            delay += random.uniform(0.0, 0.4)
            logger.warning('Transient provider error during %s (attempt %s/%s, code=%s): %s. Retrying in %.1fs', operation_name, attempt, attempts, classify_provider_error_code(error), error, delay)
            time.sleep(delay)
    if last_error is not None:
        raise last_error

def extract_token_usage(response):
    """Extract token counts from a Gemini response's usage_metadata."""
    meta = getattr(response, 'usage_metadata', None)
    if not meta:
        return {'input_tokens': 0, 'output_tokens': 0, 'total_tokens': 0}
    return {'input_tokens': getattr(meta, 'prompt_token_count', 0) or 0, 'output_tokens': getattr(meta, 'candidates_token_count', 0) or 0, 'total_tokens': getattr(meta, 'total_token_count', 0) or 0}

class TokenAccumulator:
    """Accumulates token usage across multiple AI calls in a processing job."""

    def __init__(self):
        self.stages = {}
        self.input_total = 0
        self.output_total = 0
        self.total = 0

    def record(self, stage_name, response):
        usage = extract_token_usage(response)
        self.stages[stage_name] = usage
        self.input_total += usage['input_tokens']
        self.output_total += usage['output_tokens']
        self.total += usage['total_tokens']

    def as_dict(self):
        return {'token_usage_by_stage': self.stages, 'token_input_total': self.input_total, 'token_output_total': self.output_total, 'token_total': self.total}

def generate_with_policy(model, contents, max_output_tokens=65536, retry_tracker=None, operation_name=None):
    """Unified generation wrapper that applies model-specific thinking config."""
    if client is None:
        raise RuntimeError('Gemini client is not configured.')
    base_config = {'max_output_tokens': max_output_tokens}
    thinking = _build_thinking_config(model)
    if thinking:
        base_config['thinking_config'] = thinking
    try:
        config = types.GenerateContentConfig(**base_config)
    except Exception:
        config = types.GenerateContentConfig(max_output_tokens=max_output_tokens)
    return run_with_provider_retry(operation_name or f'generate_content:{model}', lambda: client.models.generate_content(model=model, contents=contents, config=config), retry_tracker=retry_tracker)

def generate_with_optional_thinking(model, prompt_text, max_output_tokens=65536, thinking_budget=None, retry_tracker=None, operation_name=None):
    """Convenience wrapper for text-only prompts. Uses model policy for thinking config."""
    contents = [types.Content(role='user', parts=[types.Part.from_text(text=prompt_text)])]
    return generate_with_policy(model, contents, max_output_tokens=max_output_tokens, retry_tracker=retry_tracker, operation_name=operation_name)

def convert_audio_to_mp3_with_ytdlp(local_audio_path):
    return file_service.convert_audio_to_mp3_with_ytdlp(local_audio_path, ffmpeg_binary_getter=get_ffmpeg_binary, logger=logger, which_func=shutil.which, subprocess_module=subprocess)

def resolve_auto_amount(kind, source_text):
    word_count = len((source_text or '').split())
    if kind == 'flashcards':
        if word_count < 1200:
            return 10
        if word_count < 2600:
            return 20
        return 30
    if word_count < 1200:
        return 5
    if word_count < 2600:
        return 10
    return 15

def resolve_study_amounts(flashcard_selection, question_selection, source_text):
    flashcard_amount = resolve_auto_amount('flashcards', source_text) if flashcard_selection == 'auto' else int(flashcard_selection)
    question_amount = resolve_auto_amount('questions', source_text) if question_selection == 'auto' else int(question_selection)
    return (flashcard_amount, question_amount)

def extract_json_payload(raw_text):
    if not raw_text:
        return None
    text = raw_text.strip()
    if text.startswith('```'):
        lines = text.splitlines()
        if len(lines) >= 3 and lines[0].startswith('```') and (lines[-1].strip() == '```'):
            text = '\n'.join(lines[1:-1]).strip()
    start = text.find('{')
    if start == -1:
        return None
    decoder = json.JSONDecoder()
    try:
        parsed, _ = decoder.raw_decode(text[start:])
        return parsed
    except json.JSONDecodeError:
        end = text.rfind('}')
        if end == -1 or end <= start:
            return None
        try:
            return json.loads(text[start:end + 1])
        except json.JSONDecodeError:
            return None

def sanitize_flashcards(items, max_items):
    MAX_TEXT_LEN = 2000
    if not isinstance(items, list):
        return []
    cleaned = []
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        front = normalize_flashcard_front(item.get('front', ''))[:MAX_TEXT_LEN]
        back = str(item.get('back', '')).strip()[:MAX_TEXT_LEN]
        if not front or not back:
            continue
        key = (front.lower(), back.lower())
        if key in seen:
            continue
        seen.add(key)
        cleaned.append({'front': front, 'back': back})
        if len(cleaned) >= max_items:
            break
    return cleaned

def normalize_flashcard_front(raw_front):
    front = str(raw_front or '').strip()
    if not front:
        return ''
    if front.endswith('?'):
        return front

    compact = re.sub(r'\s+', ' ', front).strip()
    if not compact:
        return ''

    lower = compact.lower()
    question_starts = (
        'what ',
        'which ',
        'who ',
        'when ',
        'where ',
        'why ',
        'how ',
        'list ',
        'name ',
        'identify ',
        'describe ',
        'define ',
        'explain ',
        'give ',
    )
    if any(lower.startswith(prefix) for prefix in question_starts):
        return compact.rstrip('.!') + '?'

    article_match = re.match(r'^(?:the|a|an)\s+(.+)$', compact, flags=re.IGNORECASE)
    if article_match:
        compact = article_match.group(1).strip()

    if not compact:
        return ''

    if re.search(r'\b(?:components|parts|steps|stages|types|examples|causes|effects|symptoms|features)\b', lower):
        return f'List all {compact.rstrip(".!")}?'
    return f'What is {compact.rstrip(".!")}?' 

def sanitize_questions(items, max_items):
    MAX_TEXT_LEN = 2000
    if not isinstance(items, list):
        return []
    cleaned = []
    seen = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        question = str(item.get('question', '')).strip()[:MAX_TEXT_LEN]
        options = item.get('options', [])
        answer = str(item.get('answer', '')).strip()[:MAX_TEXT_LEN]
        explanation = str(item.get('explanation', '')).strip()[:MAX_TEXT_LEN]
        if not question or not isinstance(options, list) or len(options) != 4 or (not answer):
            continue
        option_strings = [str(option).strip()[:MAX_TEXT_LEN] for option in options]
        if any((not option for option in option_strings)):
            continue
        if len(set(option_strings)) != 4:
            continue
        if answer not in option_strings:
            continue
        dedupe_key = question.lower()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        cleaned.append({'question': question, 'options': option_strings, 'answer': answer, 'explanation': explanation})
        if len(cleaned) >= max_items:
            break
    return cleaned

def default_streak_data():
    return study_progress.default_streak_data(runtime=_self_runtime())

def sanitize_progress_date(value):
    return study_progress.sanitize_progress_date(value, runtime=_self_runtime())

def sanitize_int(value, default=0, min_value=0, max_value=10000000):
    return study_progress.sanitize_int(
        value,
        default=default,
        min_value=min_value,
        max_value=max_value,
        runtime=_self_runtime(),
    )

def sanitize_float(value, default=0.0, min_value=0.0, max_value=10000000.0):
    return study_progress.sanitize_float(
        value,
        default=default,
        min_value=min_value,
        max_value=max_value,
        runtime=_self_runtime(),
    )

def sanitize_streak_data(payload):
    return study_progress.sanitize_streak_data(payload, runtime=_self_runtime())

def sanitize_daily_goal_value(value):
    return study_progress.sanitize_daily_goal_value(value, runtime=_self_runtime())

def sanitize_pack_id(value):
    return study_progress.sanitize_pack_id(value, runtime=_self_runtime())

def sanitize_card_state_entry(payload):
    return study_progress.sanitize_card_state_entry(payload, runtime=_self_runtime())

def sanitize_card_state_map(payload):
    return study_progress.sanitize_card_state_map(payload, runtime=_self_runtime())

def derive_card_level_from_stats(seen, interval_days, flip_count=0, write_count=0):
    return study_progress.derive_card_level_from_stats(
        seen,
        interval_days,
        flip_count,
        write_count,
        runtime=_self_runtime(),
    )

def merge_streak_data(server_payload, incoming_payload):
    return study_progress.merge_streak_data(server_payload, incoming_payload, runtime=_self_runtime())

def merge_timezone_value(server_timezone, incoming_timezone):
    return study_progress.merge_timezone_value(server_timezone, incoming_timezone, runtime=_self_runtime())

def sanitize_timezone_name(value):
    return study_progress.sanitize_timezone_name(value, runtime=_self_runtime())

def resolve_progress_timezone(progress_data):
    return study_progress.resolve_progress_timezone(progress_data, runtime=_self_runtime())

def resolve_user_timezone(uid):
    return study_progress.resolve_user_timezone(uid, runtime=_self_runtime())

def to_timezone_now(base_now, tzinfo):
    return study_progress.to_timezone_now(base_now, tzinfo, runtime=_self_runtime())

def card_state_entry_rank(entry):
    return study_progress.card_state_entry_rank(entry, runtime=_self_runtime())

def merge_card_state_entries(server_entry, incoming_entry):
    return study_progress.merge_card_state_entries(server_entry, incoming_entry, runtime=_self_runtime())

def merge_card_state_maps(server_state, incoming_state):
    return study_progress.merge_card_state_maps(server_state, incoming_state, runtime=_self_runtime())

def count_due_cards_in_state(state, today_local):
    return study_progress.count_due_cards_in_state(state, today_local, runtime=_self_runtime())

def compute_study_progress_summary(progress_data, card_state_maps, base_now=None):
    return study_progress.compute_study_progress_summary(
        progress_data,
        card_state_maps,
        base_now=base_now,
        runtime=_self_runtime(),
    )

def get_study_progress_doc(uid):
    return study_repo.study_progress_doc_ref(db, uid)

def get_study_card_state_doc(uid, pack_id):
    safe_pack_id = str(pack_id or '').replace('/', '_')
    return study_repo.study_card_state_doc_ref(db, uid, safe_pack_id)


def get_planner_settings(uid):
    return planner_repo.get_planner_settings(db, uid)


def set_planner_settings(uid, payload, merge=True):
    return planner_repo.set_planner_settings(db, uid, payload, merge=merge)


def get_planner_session(uid, session_id):
    return planner_repo.get_planner_session(db, uid, session_id)


def set_planner_session(uid, session_id, payload, merge=True):
    return planner_repo.set_planner_session(db, uid, session_id, payload, merge=merge)


def delete_planner_session(uid, session_id):
    return planner_repo.delete_planner_session(db, uid, session_id)


def list_planner_sessions(uid, limit=200):
    return planner_repo.list_planner_sessions_by_uid(db, uid, limit)

def generate_study_materials(source_text, flashcard_selection, question_selection, study_features='both', output_language='English', retry_tracker=None):
    return study_generation.generate_study_materials(
        source_text,
        flashcard_selection,
        question_selection,
        study_features=study_features,
        output_language=output_language,
        retry_tracker=retry_tracker,
        runtime=_self_runtime(),
    )[:3]

def generate_interview_enhancements(transcript_text, selected_features, output_language='English', retry_tracker=None):
    return study_generation.generate_interview_enhancements(
        transcript_text,
        selected_features,
        output_language=output_language,
        retry_tracker=retry_tracker,
        runtime=_self_runtime(),
    )

def allowed_file(filename, allowed_extensions):
    return file_service.allowed_file(filename, allowed_extensions)

def file_has_pdf_signature(path):
    return file_service.file_has_pdf_signature(path)

def file_has_pptx_signature(path):
    return file_service.file_has_pptx_signature(path)

def get_soffice_binary():
    return media_runtime.get_soffice_binary(env_getter=os.getenv, which_func=shutil.which)

def convert_pptx_to_pdf(source_path, target_pdf_path):
    return media_runtime.convert_pptx_to_pdf(
        source_path,
        target_pdf_path,
        soffice_binary_getter=get_soffice_binary,
        subprocess_module=subprocess,
    )

def resolve_uploaded_slides_to_pdf(uploaded_file, job_id):
    return media_runtime.resolve_uploaded_slides_to_pdf(
        uploaded_file,
        job_id,
        upload_folder=UPLOAD_FOLDER,
        allowed_slide_extensions=ALLOWED_SLIDE_EXTENSIONS,
        allowed_slide_mime_types=ALLOWED_SLIDE_MIME_TYPES,
        max_pdf_upload_bytes=MAX_PDF_UPLOAD_BYTES,
        cleanup_files_fn=cleanup_files,
        secure_filename_fn=secure_filename,
        allowed_file_fn=allowed_file,
        file_has_pdf_signature_fn=file_has_pdf_signature,
        file_has_pptx_signature_fn=file_has_pptx_signature,
        convert_pptx_to_pdf_fn=convert_pptx_to_pdf,
        get_saved_file_size_fn=get_saved_file_size,
    )

def file_has_audio_signature(path):
    return file_service.file_has_audio_signature(path)

def file_looks_like_audio(path):
    return media_runtime.file_looks_like_audio(
        path,
        ffprobe_binary_getter=get_ffprobe_binary,
        subprocess_module=subprocess,
    )

def get_saved_file_size(path):
    return file_service.get_saved_file_size(path)

def get_mime_type(filename):
    return file_service.get_mime_type(filename)

def wait_for_file_processing(uploaded_file):
    return media_runtime.wait_for_file_processing(
        uploaded_file,
        client=client,
        logger=logger,
        time_module=time,
        is_transient_provider_error_fn=is_transient_provider_error,
        classify_provider_error_code_fn=classify_provider_error_code,
    )

def cleanup_files(local_paths, gemini_files):
    return media_runtime.cleanup_files(local_paths, gemini_files, client=client, logger=logger)

def parse_audio_markers_from_notes(notes_markdown):
    if not notes_markdown:
        return []
    pattern = re.compile('#{1,3}\\s+(.+?)\\s*\\n\\s*<!--\\s*audio:(\\d+)-(\\d+)\\s*-->', re.MULTILINE)
    notes_audio_map = []
    section_index = 0
    for match in pattern.finditer(notes_markdown):
        try:
            start_ms = int(match.group(2))
            end_ms = int(match.group(3))
        except Exception:
            continue
        notes_audio_map.append({'section_index': section_index, 'section_title': match.group(1).strip(), 'start_ms': max(0, start_ms), 'end_ms': max(start_ms, end_ms)})
        section_index += 1
    return notes_audio_map

def format_transcript_with_timestamps(segments):
    if not isinstance(segments, list):
        return ''
    lines = []
    for seg in segments:
        if not isinstance(seg, dict):
            continue
        text = str(seg.get('text', '') or '').strip()
        if not text:
            continue
        start_ms = int(seg.get('start_ms', 0) or 0)
        end_ms = int(seg.get('end_ms', start_ms) or start_ms)
        lines.append(f'[{start_ms}-{end_ms}] {text}')
    return '\n'.join(lines)

def transcribe_audio_plain(audio_file, audio_mime_type, output_language='English', retry_tracker=None, include_usage=False):
    output_language = OUTPUT_LANGUAGE_MAP.get(str(output_language).lower(), str(output_language))
    prompt = PROMPT_AUDIO_TRANSCRIPTION.format(output_language=output_language)
    response = generate_with_policy(MODEL_AUDIO, [types.Content(role='user', parts=[types.Part.from_uri(file_uri=audio_file.uri, mime_type=audio_mime_type), types.Part.from_text(text=prompt)])], retry_tracker=retry_tracker, operation_name='audio_transcription')
    transcript = (getattr(response, 'text', '') or '').strip()
    if include_usage:
        return (transcript, extract_token_usage(response))
    return transcript

def transcribe_audio_with_timestamps(audio_file, audio_mime_type, output_language='English', retry_tracker=None, include_usage=False):
    output_language = OUTPUT_LANGUAGE_MAP.get(str(output_language).lower(), str(output_language))
    prompt = PROMPT_AUDIO_TRANSCRIPTION_TIMESTAMPED.format(output_language=output_language)
    try:
        response = generate_with_policy(MODEL_AUDIO, [types.Content(role='user', parts=[types.Part.from_uri(file_uri=audio_file.uri, mime_type=audio_mime_type), types.Part.from_text(text=prompt)])], retry_tracker=retry_tracker, operation_name='audio_transcription_timestamped')
        usage = extract_token_usage(response)
        parsed = extract_json_payload(getattr(response, 'text', '') or '')
        if not isinstance(parsed, dict):
            raise ValueError('Timestamped transcription JSON not found')
        raw_segments = parsed.get('transcript_segments', [])
        full_transcript = str(parsed.get('full_transcript', '') or '').strip()
        clean_segments = []
        if isinstance(raw_segments, list):
            for seg in raw_segments:
                if not isinstance(seg, dict):
                    continue
                text = str(seg.get('text', '') or '').strip()
                if not text:
                    continue
                try:
                    start_ms = int(seg.get('start_ms', 0) or 0)
                    end_ms = int(seg.get('end_ms', start_ms) or start_ms)
                except Exception:
                    continue
                clean_segments.append({'start_ms': max(0, start_ms), 'end_ms': max(start_ms, end_ms), 'text': text})
        if not full_transcript and clean_segments:
            full_transcript = '\n'.join([s['text'] for s in clean_segments]).strip()
        if not full_transcript:
            raise ValueError('Empty transcript')
        if include_usage:
            return (full_transcript, clean_segments, usage)
        return (full_transcript, clean_segments)
    except Exception as e:
        logger.warning(f'⚠️ Timestamp transcription failed, falling back to plain transcript: {e}')
        fallback_prompt = PROMPT_AUDIO_TRANSCRIPTION.format(output_language=output_language)
        fallback_response = generate_with_policy(MODEL_AUDIO, [types.Content(role='user', parts=[types.Part.from_uri(file_uri=audio_file.uri, mime_type=audio_mime_type), types.Part.from_text(text=fallback_prompt)])], retry_tracker=retry_tracker, operation_name='audio_transcription_fallback')
        fallback_usage = extract_token_usage(fallback_response)
        fallback_text = (getattr(fallback_response, 'text', '') or '').strip()
        if include_usage:
            return (fallback_text, [], fallback_usage)
        return (fallback_text, [])

def ensure_study_audio_root():
    os.makedirs(STUDY_AUDIO_ROOT, exist_ok=True)

def normalize_audio_storage_key(raw_key):
    key = str(raw_key or '').strip().replace('\\', '/')
    if not key:
        return ''
    key = os.path.normpath(key).replace('\\', '/')
    while key.startswith('./'):
        key = key[2:]
    if key.startswith('/'):
        return ''
    if key == '.' or key.startswith('../') or '/..' in key:
        return ''
    if not key.startswith(f'{STUDY_AUDIO_RELATIVE_DIR}/'):
        return ''
    return key

def resolve_audio_storage_path_from_key(raw_key):
    key = normalize_audio_storage_key(raw_key)
    if not key:
        return ''
    ensure_study_audio_root()
    relative_path = key[len(f'{STUDY_AUDIO_RELATIVE_DIR}/'):]
    absolute_path = os.path.abspath(os.path.join(STUDY_AUDIO_ROOT, relative_path))
    if not absolute_path.startswith(STUDY_AUDIO_ROOT + os.sep):
        return ''
    return absolute_path

def infer_audio_storage_key_from_path(raw_path):
    path = str(raw_path or '').strip()
    if not path:
        return ''
    absolute_path = os.path.abspath(path)
    ensure_study_audio_root()
    if not absolute_path.startswith(STUDY_AUDIO_ROOT + os.sep):
        return ''
    relative = os.path.relpath(absolute_path, STUDY_AUDIO_ROOT).replace('\\', '/')
    if relative == '.' or relative.startswith('../'):
        return ''
    return normalize_audio_storage_key(f'{STUDY_AUDIO_RELATIVE_DIR}/{relative}')

def get_audio_storage_key_from_pack(pack):
    if not isinstance(pack, dict):
        return ''
    key = normalize_audio_storage_key(pack.get('audio_storage_key', ''))
    if key:
        return key
    return infer_audio_storage_key_from_path(pack.get('audio_storage_path', ''))

def get_audio_storage_path_from_pack(pack):
    key = get_audio_storage_key_from_pack(pack)
    if key:
        return resolve_audio_storage_path_from_key(key)
    return ''

def ensure_pack_audio_storage_key(pack_ref, pack):
    key = get_audio_storage_key_from_pack(pack)
    if key and (not normalize_audio_storage_key(pack.get('audio_storage_key', ''))):
        try:
            pack_ref.set({'audio_storage_key': key, 'has_audio_playback': True, 'updated_at': time.time()}, merge=True)
        except Exception:
            pass
    return key

def remove_pack_audio_file(pack):
    target_path = get_audio_storage_path_from_pack(pack)
    if not target_path:
        return False
    try:
        if os.path.exists(target_path):
            os.remove(target_path)
            return True
    except Exception:
        return False
    return False

def persist_audio_for_study_pack(job_id, audio_source_path):
    if not audio_source_path or not os.path.exists(audio_source_path):
        return ''
    ext = os.path.splitext(audio_source_path)[1].lower() or '.mp3'
    ensure_study_audio_root()
    target_key = normalize_audio_storage_key(f'{STUDY_AUDIO_RELATIVE_DIR}/{job_id}{ext}')
    target_path = resolve_audio_storage_path_from_key(target_key)
    if not target_path:
        return ''
    try:
        shutil.copy2(audio_source_path, target_path)
        return target_key
    except Exception as e:
        logger.warning(f'⚠️ Could not persist audio for study pack {job_id}: {e}')
        return ''

def markdown_to_docx(markdown_text, title='Document'):
    from lecture_processor.domains.study import export as study_export

    return study_export.markdown_to_docx(markdown_text, title=title)

def normalize_exam_date(raw_value):
    return study_export.normalize_exam_date(raw_value, runtime=_self_runtime())

def build_study_pack_pdf(pack, include_answers=True):
    return study_export.build_study_pack_pdf(pack, include_answers=include_answers, runtime=_self_runtime())

def save_study_pack(job_id, job_data):
    return ai_pipelines.save_study_pack(job_id, job_data, runtime=_self_runtime())

def process_lecture_notes(job_id, pdf_path, audio_path):
    return ai_pipelines.process_lecture_notes(job_id, pdf_path, audio_path, runtime=_self_runtime())

def process_slides_only(job_id, pdf_path):
    return ai_pipelines.process_slides_only(job_id, pdf_path, runtime=_self_runtime())

def process_interview_transcription(job_id, audio_path):
    return ai_pipelines.process_interview_transcription(job_id, audio_path, runtime=_self_runtime())

def get_model_pricing_config(force_reload=False):
    now_ts = time.time()
    cached = MODEL_PRICING_CACHE.get('payload')
    loaded_at = float(MODEL_PRICING_CACHE.get('loaded_at', 0.0) or 0.0)
    if not force_reload and isinstance(cached, dict) and cached and (now_ts - loaded_at < MODEL_PRICING_CACHE_TTL_SECONDS):
        return json.loads(json.dumps(cached))
    with open(MODEL_PRICING_CONFIG_PATH, 'r', encoding='utf-8') as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f'Model pricing config must be a JSON object: {MODEL_PRICING_CONFIG_PATH}')
    MODEL_PRICING_CACHE['payload'] = payload
    MODEL_PRICING_CACHE['loaded_at'] = now_ts
    return json.loads(json.dumps(payload))
