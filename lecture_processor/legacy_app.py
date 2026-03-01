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
import html
import warnings
import logging
import ipaddress
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse
try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None

# Keep startup clean in local dev environments.
warnings.filterwarnings(
    "ignore",
    message=r"urllib3 v2 only supports OpenSSL 1\.1\.1\+.*"
)

import stripe
from flask import Flask, request, jsonify, render_template, send_file, Response, stream_with_context, g
from google import genai
from google.genai import types
from dotenv import load_dotenv
from werkzeug.utils import secure_filename
from werkzeug.exceptions import RequestEntityTooLarge
from docx import Document
from docx.shared import Pt, Inches
from docx.enum.text import WD_ALIGN_PARAGRAPH
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

REPORTLAB_AVAILABLE = True
try:
    from reportlab.lib import colors
    from reportlab.lib.pagesizes import A4
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.units import mm
    from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, ListFlowable, ListItem, PageBreak
except Exception:
    REPORTLAB_AVAILABLE = False
import firebase_admin
from firebase_admin import credentials, auth, firestore
from lecture_processor.services import (
    analytics_service,
    auth_service,
    file_service,
    job_state_service,
    rate_limit_service,
)

LEGACY_MODULE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT_DIR = os.path.dirname(LEGACY_MODULE_DIR)

load_dotenv()
app = Flask(
    __name__,
    template_folder=os.path.join(PROJECT_ROOT_DIR, 'templates'),
    static_folder=os.path.join(PROJECT_ROOT_DIR, 'static'),
)
app.secret_key = os.getenv('FLASK_SECRET_KEY', os.urandom(32).hex())
LOG_LEVEL = (os.getenv('LOG_LEVEL', 'INFO') or 'INFO').strip().upper()
logging.basicConfig(
    level=getattr(logging, LOG_LEVEL, logging.INFO),
    format='%(asctime)s %(levelname)s %(name)s %(message)s',
)
logger = logging.getLogger('lecture_processor')


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
ALLOWED_AUDIO_EXTENSIONS = {'mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac'}
MAX_PDF_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_AUDIO_UPLOAD_BYTES = 500 * 1024 * 1024
MAX_CONTENT_LENGTH = (MAX_PDF_UPLOAD_BYTES + MAX_AUDIO_UPLOAD_BYTES + (10 * 1024 * 1024))
ALLOWED_SLIDE_MIME_TYPES = {
    'application/pdf',
    'application/x-pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.ms-powerpoint',
}
ALLOWED_PDF_MIME_TYPES = ALLOWED_SLIDE_MIME_TYPES
ALLOWED_AUDIO_MIME_TYPES = {
    'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav',
    'audio/aac', 'audio/ogg', 'audio/flac',
}

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
GEMINI_API_KEY = (os.getenv('GEMINI_API_KEY', '') or '').strip()
if GEMINI_API_KEY:
    try:
        client = genai.Client(api_key=GEMINI_API_KEY)
    except Exception as e:
        client = None
        logger.info(f"⚠️ Gemini client disabled: {e}")
else:
    client = None
    logger.info("⚠️ GEMINI_API_KEY not set; AI processing features are disabled.")
app.config['MAX_CONTENT_LENGTH'] = MAX_CONTENT_LENGTH

# --- Firebase Setup ---
db = None
firebase_init_error = ''
try:
    if os.path.exists('firebase-credentials.json'):
        cred = credentials.Certificate('firebase-credentials.json')
    else:
        firebase_creds_raw = (os.getenv('FIREBASE_CREDENTIALS', '') or '').strip()
        if not firebase_creds_raw:
            raise ValueError("FIREBASE_CREDENTIALS is not set and firebase-credentials.json was not found.")
        cred = credentials.Certificate(json.loads(firebase_creds_raw))
    if not firebase_admin._apps:
        firebase_admin.initialize_app(cred)
    db = firestore.client()
except Exception as e:
    firebase_init_error = str(e)
    logger.info(f"⚠️ Firebase initialization skipped: {firebase_init_error}")

# --- Stripe Setup ---
stripe.api_key = os.getenv('STRIPE_SECRET_KEY')
STRIPE_PUBLISHABLE_KEY = os.getenv('STRIPE_PUBLISHABLE_KEY', '')
STRIPE_WEBHOOK_SECRET = os.getenv('STRIPE_WEBHOOK_SECRET', '')
ADMIN_EMAILS = {email.strip().lower() for email in os.getenv('ADMIN_EMAILS', '').split(',') if email.strip()}
ADMIN_UIDS = {uid.strip() for uid in os.getenv('ADMIN_UIDS', '').split(',') if uid.strip()}

# --- In-Memory Storage (jobs only — credits are in Firestore now) ---
jobs = {}
JOBS_LOCK = threading.RLock()
AUDIO_STREAM_TOKEN_TTL_SECONDS = 3600
AUDIO_STREAM_TOKENS = {}
ALLOW_LEGACY_AUDIO_STREAM_TOKENS = str(os.getenv('ALLOW_LEGACY_AUDIO_STREAM_TOKENS', '0')).strip().lower() in {'1', 'true', 'yes', 'on'}
AUDIO_IMPORT_TOKEN_TTL_SECONDS = 30 * 60
AUDIO_IMPORT_TOKENS = {}
AUDIO_IMPORT_LOCK = threading.Lock()
FEATURE_AUDIO_SECTION_SYNC = os.getenv('FEATURE_AUDIO_SECTION_SYNC', '0').strip().lower() in {'1', 'true', 'yes', 'on'}
MAX_PROGRESS_PACKS_PER_SYNC = 300
MAX_PROGRESS_CARDS_PER_PACK = 2500
PROGRESS_DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
ANALYTICS_NAME_RE = re.compile(r'^[a-z0-9_]{2,64}$')
ANALYTICS_SESSION_ID_RE = re.compile(r'^[A-Za-z0-9_-]{6,80}$')
ANALYTICS_ALLOWED_EVENTS = {
    'auth_modal_opened',
    'auth_success',
    'auth_failed',
    'checkout_started',
    'payment_confirmed',
    'payment_cancelled',
    'process_clicked',
    'processing_started',
    'processing_completed',
    'processing_failed',
    'processing_timeout',
    'processing_retry_requested',
    'study_mode_opened',
    'payment_confirmed_backend',
    'processing_started_backend',
    'processing_completed_backend',
    'processing_failed_backend',
    'processing_finished_backend',
}
ANALYTICS_FUNNEL_STAGES = [
    {'event': 'auth_modal_opened', 'label': 'Opened sign-in'},
    {'event': 'auth_success', 'label': 'Signed in'},
    {'event': 'checkout_started', 'label': 'Started checkout'},
    {'event': 'payment_confirmed', 'label': 'Payment confirmed'},
    {'event': 'process_clicked', 'label': 'Clicked process'},
    {'event': 'processing_started', 'label': 'Upload accepted'},
    {'event': 'processing_completed', 'label': 'Processing complete'},
    {'event': 'study_mode_opened', 'label': 'Opened study mode'},
]
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
ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION = safe_int_env('ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION', 10000, minimum=100, maximum=50000)
ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION = safe_int_env('ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION', 10000, minimum=100, maximum=50000)
RATE_LIMIT_EVENTS = {}
RATE_LIMIT_LOCK = threading.Lock()
RATE_LIMIT_COUNTER_COLLECTION = 'rate_limit_counters'
RATE_LIMIT_FIRESTORE_ENABLED = str(os.getenv('RATE_LIMIT_FIRESTORE_ENABLED', '1')).strip().lower() in {'1', 'true', 'yes', 'on'}

SENTRY_BACKEND_DSN = os.getenv('SENTRY_DSN_BACKEND', '').strip()
SENTRY_FRONTEND_DSN = os.getenv('SENTRY_DSN_FRONTEND', '').strip()
SENTRY_ENVIRONMENT = (os.getenv('SENTRY_ENVIRONMENT', os.getenv('FLASK_ENV', 'production')) or 'production').strip()
SENTRY_RELEASE = (os.getenv('SENTRY_RELEASE', 'lecture-processor') or 'lecture-processor').strip()
LEGAL_CONTACT_EMAIL = (os.getenv('LEGAL_CONTACT_EMAIL', os.getenv('SUPPORT_EMAIL', '')) or '').strip()
DEV_ENV_NAMES = {'development', 'dev', 'local', 'test'}
APP_BOOT_TS = time.time()


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
    }


CORS_ALLOWED_ORIGINS = parse_cors_allowed_origins()

def safe_float_env(name, default=0.0):
    raw = os.getenv(name, str(default)).strip()
    try:
        value = float(raw)
    except Exception:
        return default
    return min(max(value, 0.0), 1.0)

SENTRY_TRACES_SAMPLE_RATE = safe_float_env('SENTRY_TRACES_SAMPLE_RATE', 0.0)

if SENTRY_BACKEND_DSN and sentry_sdk and FlaskIntegration:
    sentry_sdk.init(
        dsn=SENTRY_BACKEND_DSN,
        integrations=[FlaskIntegration()],
        traces_sample_rate=SENTRY_TRACES_SAMPLE_RATE,
        send_default_pii=False,
        environment=SENTRY_ENVIRONMENT,
        release=SENTRY_RELEASE,
    )

def is_dev_environment():
    env_value = str(SENTRY_ENVIRONMENT or '').strip().lower()
    flask_debug = str(os.getenv('FLASK_DEBUG', '0')).strip().lower() in {'1', 'true', 'yes', 'on'}
    return env_value in DEV_ENV_NAMES or flask_debug


def infer_stripe_key_mode(key_value):
    key = str(key_value or '').strip()
    if not key:
        return 'missing'
    if key.startswith('sk_live_') or key.startswith('pk_live_'):
        return 'live'
    if key.startswith('sk_test_') or key.startswith('pk_test_'):
        return 'test'
    return 'unknown'


def build_admin_deployment_info(request_host=''):
    request_host = str(request_host or '').strip()
    request_hostname = request_host.split(':', 1)[0].strip().lower()
    render_hostname = str(os.getenv('RENDER_EXTERNAL_HOSTNAME', '') or '').strip().lower()
    render_external_url = str(os.getenv('RENDER_EXTERNAL_URL', '') or '').strip()
    render_service_id = str(os.getenv('RENDER_SERVICE_ID', '') or '').strip()
    render_deploy_id = str(os.getenv('RENDER_DEPLOY_ID', '') or '').strip()
    render_instance_id = str(os.getenv('RENDER_INSTANCE_ID', '') or '').strip()
    render_service_name = str(os.getenv('RENDER_SERVICE_NAME', '') or '').strip()
    render_git_commit = str(os.getenv('RENDER_GIT_COMMIT', '') or '').strip()
    render_git_branch = str(os.getenv('RENDER_GIT_BRANCH', '') or '').strip()
    render_detected = bool(str(os.getenv('RENDER', '') or '').strip() or render_service_id or render_deploy_id)
    host_matches_render = None
    if render_hostname and request_hostname:
        host_matches_render = request_hostname == render_hostname
    return {
        'runtime': 'render' if render_detected else 'local',
        'request_host': request_host,
        'request_hostname': request_hostname,
        'render_external_hostname': render_hostname,
        'render_external_url': render_external_url,
        'host_matches_render': host_matches_render,
        'service_id': render_service_id,
        'service_name': render_service_name,
        'deploy_id': render_deploy_id,
        'instance_id': render_instance_id,
        'git_branch': render_git_branch,
        'git_commit': render_git_commit,
        'git_commit_short': (render_git_commit[:12] if render_git_commit else ''),
        'app_boot_ts': APP_BOOT_TS,
        'app_uptime_seconds': max(0, round(time.time() - APP_BOOT_TS, 1)),
    }


def build_admin_runtime_checks():
    secret_key_mode = infer_stripe_key_mode(stripe.api_key)
    publishable_key_mode = infer_stripe_key_mode(STRIPE_PUBLISHABLE_KEY)
    stripe_keys_match = (
        secret_key_mode in {'live', 'test'}
        and publishable_key_mode in {'live', 'test'}
        and secret_key_mode == publishable_key_mode
    )
    soffice_available = bool(get_soffice_binary())
    ffmpeg_available = bool(get_ffmpeg_binary())
    ytdlp_available = bool(shutil.which('yt-dlp'))
    return {
        'firebase_ready': bool(db),
        'gemini_ready': bool(client),
        'stripe_secret_mode': secret_key_mode,
        'stripe_publishable_mode': publishable_key_mode,
        'stripe_keys_match': stripe_keys_match,
        'pptx_conversion_available': soffice_available,
        'video_import_available': (ffmpeg_available and ytdlp_available),
        'ffmpeg_available': ffmpeg_available,
        'yt_dlp_available': ytdlp_available,
    }

def apply_cors_headers(response):
    origin = str(request.headers.get('Origin', '') or '').strip()
    if not origin:
        return response
    if not request.path.startswith('/api/'):
        return response
    if origin.lower() not in CORS_ALLOWED_ORIGINS:
        return response
    response.headers['Access-Control-Allow-Origin'] = origin
    response.headers['Vary'] = 'Origin'
    response.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    return response


@app.before_request
def handle_api_options_preflight():
    if request.method == 'OPTIONS' and request.path.startswith('/api/'):
        return apply_cors_headers(app.make_default_options_response())

@app.before_request
def attach_sentry_route_context():
    request_id = str(request.headers.get('X-Request-ID', '') or '').strip()[:120] or uuid.uuid4().hex
    g.request_id = request_id
    if not sentry_sdk:
        return
    try:
        with sentry_sdk.configure_scope() as scope:
            scope.set_tag('request.id', request_id)
            scope.set_tag('route.path', request.path)
            scope.set_tag('route.method', request.method)
            scope.set_tag('route.endpoint', request.endpoint or '')
            scope.set_tag('route.auth_header_present', 'true' if request.headers.get('Authorization') else 'false')
            scope.set_tag('route.environment', SENTRY_ENVIRONMENT or 'production')
            if request.content_type:
                scope.set_tag('route.content_type', str(request.content_type).split(';')[0][:80])
    except Exception:
        pass

@app.after_request
def attach_sentry_response_context(response):
    request_id = str(getattr(g, 'request_id', '') or '').strip()
    if request_id:
        response.headers['X-Request-ID'] = request_id
    if sentry_sdk:
        try:
            with sentry_sdk.configure_scope() as scope:
                scope.set_tag('route.status_code', str(response.status_code))
        except Exception:
            pass
    return apply_cors_headers(response)

@app.errorhandler(RequestEntityTooLarge)
def handle_request_entity_too_large(_error):
    return jsonify({'error': 'Upload too large. Maximum total upload size is 560MB (up to 50MB PDF and 500MB audio).'}), 413

# --- Credit Bundles (what users can buy) ---
CREDIT_BUNDLES = {
    'lecture_5': {
        'name': 'Lecture Notes — 5 Pack',
        'description': '5 standard lecture credits',
        'credits': {'lecture_credits_standard': 5},
        'price_cents': 999,
        'currency': 'eur',
    },
    'lecture_10': {
        'name': 'Lecture Notes — 10 Pack',
        'description': '10 standard lecture credits (best value)',
        'credits': {'lecture_credits_standard': 10},
        'price_cents': 1699,
        'currency': 'eur',
    },
    'slides_10': {
        'name': 'Slides Extraction — 10 Pack',
        'description': '10 slides extraction credits',
        'credits': {'slides_credits': 10},
        'price_cents': 499,
        'currency': 'eur',
    },
    'slides_25': {
        'name': 'Slides Extraction — 25 Pack',
        'description': '25 slides extraction credits (best value)',
        'credits': {'slides_credits': 25},
        'price_cents': 999,
        'currency': 'eur',
    },
    'interview_3': {
        'name': 'Interview Transcription — 3 Pack',
        'description': '3 interview transcription credits',
        'credits': {'interview_credits_short': 3},
        'price_cents': 799,
        'currency': 'eur',
    },
    'interview_8': {
        'name': 'Interview Transcription — 8 Pack',
        'description': '8 interview transcription credits (best value)',
        'credits': {'interview_credits_short': 8},
        'price_cents': 1799,
        'currency': 'eur',
    },
}

# --- Email Allowlist ---
EMAIL_ALLOWLIST_CONFIG_PATH = os.path.join(
    PROJECT_ROOT_DIR,
    'config',
    'allowed_email_domains.json',
)


def load_email_allowlist_config(path):
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
    except Exception as e:
        raise RuntimeError(f"Could not read allowlist config at {path}: {e}")
    if not isinstance(data, dict):
        raise RuntimeError(f"Allowlist config at {path} must be a JSON object.")
    raw_domains = data.get('domains', [])
    raw_suffixes = data.get('suffixes', [])
    if not isinstance(raw_domains, list) or not isinstance(raw_suffixes, list):
        raise RuntimeError(f"Allowlist config at {path} must contain list values for 'domains' and 'suffixes'.")
    domains = {str(item).strip().lower() for item in raw_domains if str(item).strip()}
    suffixes = [str(item).strip().lower() for item in raw_suffixes if str(item).strip()]
    if not domains:
        raise RuntimeError(f"Allowlist config at {path} has an empty domains list.")
    if not suffixes:
        raise RuntimeError(f"Allowlist config at {path} has an empty suffixes list.")
    return domains, suffixes


ALLOWED_EMAIL_DOMAINS, ALLOWED_EMAIL_PATTERNS = load_email_allowlist_config(EMAIL_ALLOWLIST_CONFIG_PATH)

def is_email_allowed(email):
    if not email: return False
    email = email.lower()
    domain = email.split('@')[-1] if '@' in email else ''
    if domain in ALLOWED_EMAIL_DOMAINS: return True
    for pattern in ALLOWED_EMAIL_PATTERNS:
        if domain.endswith(pattern): return True
    return False

# --- AI Model Config ---
MODEL_SLIDES = 'gemini-2.5-flash-lite'
MODEL_AUDIO = 'gemini-3-flash-preview'
MODEL_INTEGRATION = 'gemini-2.5-pro'
MODEL_INTERVIEW = 'gemini-2.5-pro'
MODEL_STUDY = 'gemini-2.5-flash-lite'

FREE_LECTURE_CREDITS = 1
FREE_SLIDES_CREDITS = 2
FREE_INTERVIEW_CREDITS = 0

OUTPUT_LANGUAGE_MAP = {
    'dutch': 'Dutch',
    'english': 'English',
    'spanish': 'Spanish',
    'french': 'French',
    'german': 'German',
    'chinese': 'Chinese',
}
DEFAULT_OUTPUT_LANGUAGE_KEY = 'english'
OUTPUT_LANGUAGE_KEYS = set(OUTPUT_LANGUAGE_MAP.keys()) | {'other'}
MAX_OUTPUT_LANGUAGE_CUSTOM_LENGTH = 40
VIDEO_IMPORT_MAX_URL_LENGTH = 4096
VIDEO_IMPORT_ALLOWED_HOST_SUFFIXES = tuple(
    part.strip().lower()
    for part in (os.getenv('VIDEO_IMPORT_ALLOWED_HOST_SUFFIXES', 'kaltura.com,ovp.kaltura.com,brightspace.com,d2l.com') or '').split(',')
    if part.strip()
)

# --- Prompts ---
PROMPT_SLIDE_EXTRACTION = """Extraheer alle tekst van de slides uit het bijgevoegde PDF-bestand en identificeer de functie van visuele elementen.
Instructies:
1. Geef per slide duidelijk aan welk slide-nummer het betreft (bv. "Slide 1:").
2. Neem de titel van de slide over.
3. Neem alle tekstuele inhoud (bullet points, paragrafen) van de slide over.
4. Identificeer waar afbeeldingen of tabellen staan. Gebruik strikte criteria:
   - Informatief: Gebruik de placeholder ALLEEN als de afbeelding tekst, data, grafieken, diagrammen, flowcharts, of een specifiek wetenschappelijk/technisch diagram bevat dat cruciaal is voor begrip van de slide. Formaat: [Informatieve Afbeelding/Tabel: Geef een neutrale beschrijving van wat zichtbaar is of het onderwerp]
   - Decoratief: Gebruik de placeholder voor ALLE foto's van mensen, landschappen, bedrijfslogo's, universiteitslogo's, achtergrondillustraties, stockfoto's, of sfeerbeelden. Bij twijfel, classificeer het als decoratief! Formaat: [Decoratieve Afbeelding]
5. Laat de zin "Share Your talent move the world" weg, indien aanwezig.
6. Lever de output als platte tekst, zonder specifieke Word-opmaak anders dan de slide-indicatie en de placeholders."""

PROMPT_AUDIO_TRANSCRIPTION = """Maak een nauwkeurig en 'schoon' transcript van het bijgevoegde audiobestand.
Instructies:
1. Transcribeer de gesproken tekst zo letterlijk mogelijk.
2. Verwijder stopwoorden en aarzelingen (zoals "eh," "uhm," "nou ja," "weet je wel") om de leesbaarheid te verhogen, maar behoud de volledige inhoudelijke boodschap. Verander geen zinsconstructies.
3. Gebruik geen tijdcodes.
4. Gebruik alinea's om langere spreekbeurten op te delen.
5. Schrijf de uiteindelijke output volledig in deze taal: {output_language}."""

PROMPT_AUDIO_TRANSCRIPTION_TIMESTAMPED = """Maak een nauwkeurig transcript met tijdsegmenten van het bijgevoegde audiobestand.

Geef ALLEEN geldige JSON terug, zonder markdown of extra tekst, in exact dit formaat:
{{
  "transcript_segments": [
    {{
      "start_ms": 0,
      "end_ms": 10000,
      "text": "..."
    }}
  ],
  "full_transcript": "..."
}}

Regels:
- Gebruik natuurlijke segmenten van ongeveer 5-25 seconden.
- start_ms en end_ms zijn milliseconden vanaf het begin.
- Verwijder stopwoorden en aarzelingen om de leesbaarheid te verbeteren zonder inhoud te verliezen.
- full_transcript bevat de volledige transcriptie als doorlopende tekst.
- Schrijf tekstinhoud volledig in deze taal: {output_language}."""

PROMPT_INTERVIEW_TRANSCRIPTION = """Transcribe this interview in the format: timecode (mm:ss) - speaker - caption.
Rules:
- Use speaker A, speaker B, etc. to identify speakers.
- Keep timestamps in each line.
- Write the output fully in this language: {output_language}."""

PROMPT_INTERVIEW_SUMMARY = """You are an expert interviewer analyst.
Create a concise summary of this interview.
Rules:
- Maximum one page equivalent (about 400-600 words).
- Focus only on the most important points, commitments, and conclusions.
- Use short headings and bullet points where useful.
- Do not invent information outside the transcript.
- Write the output fully in this language: {output_language}.
Transcript:
{transcript}
"""

PROMPT_INTERVIEW_SECTIONED = """You are an expert transcript editor.
Rewrite this interview transcript into a structured version with clear headings.
Rules:
- Keep timestamps and speaker labels from the source where possible.
- Split content into relevant sections (for example: Introduction, Background, Key Discussion, Decisions, Next Steps).
- Use meaningful heading titles based on actual content.
- Do not invent information outside the transcript.
- Write the output fully in this language: {output_language}.
Transcript:
{transcript}
"""

PROMPT_MERGE_TEMPLATE = """Maak één complete, consistente en studieklare uitwerking van het college op basis van slide-tekst en audio-transcript.

DOEL:
- Lever een volledig naslagdocument op (geen samenvatting).
- Maak de tekst direct bruikbaar voor studenten bij voorbereiding op toets/tentamen.
- Integreer alle relevante inhoud uit beide bronnen in één samenhangende tekst.

OUTPUTVORM (VERPLICHT):
1. Start direct met inhoud in Markdown (geen inleidende assistent-zin).
2. Eerste regel is een titel met `#`.
3. Gebruik daarna `##` en `###` met duidelijke, logische opbouw.
4. Gebruik geen transcriptvorm met sprekers, dialooglabels of vraag-antwoord stijl.
5. Lever alleen de uiteindelijke tekst; geen toelichting op je werkwijze.

VERBODEN OPENINGEN:
- "Hier is de uitwerking"
- "Absoluut"
- "Onderstaand"
- "In dit document"
- "Hieronder volgt"

INHOUDELIJKE REGELS:
1. Integratie:
   - Gebruik de slide-volgorde als ruggengraat.
   - Verwerk audio-uitleg op de logisch juiste plaats.
   - Behoud inhoudelijke details die didactische waarde hebben.
2. Redactie:
   - Verwijder conversatie-ruis (opstartzinnen, klasinteractie, herhalingen zonder inhoud).
   - Zet spreektaal en klasdialoog om naar vloeiende, doorlopende leertekst.
3. Structuur:
   - Per onderwerp: korte definitie/afbakening -> uitleg/mechanisme -> klinische of praktische relevantie.
   - Gebruik bullets alleen waar dat de scanbaarheid verbetert.
   - Behoud casussen/opdrachten als aparte secties als ze in de input staan.
4. Visual placeholders:
   - Behoud alleen `[Informatieve Afbeelding/Tabel: ...]` op de juiste plek.
   - Laat decoratieve placeholders weg.
5. Taal:
   - Schrijf volledig in: {output_language}.
   - Houd toon professioneel, neutraal en didactisch.

SOFT FIDELITY (BALANS TUSSEN BETROUWBAARHEID EN LEESBAARHEID):
- Baseren op slide-tekst + transcript als primaire waarheid.
- Toegestaan:
  - Korte verbindingszinnen voor leesbaarheid.
  - Voorzichtige herformulering/duiding van impliciete verbanden die direct uit de input volgen.
- Niet toegestaan:
  - Nieuwe cijfers, richtlijnen, bronnen, diagnoses of behandelclaims die niet uit de input komen.
  - Nieuwe medische feiten die niet in slide of transcript te herleiden zijn.
- Bij twijfel: laat weg of formuleer neutraal zonder extra claim.

AFSLUITING (VERPLICHT):
- Voeg een laatste sectie toe: `## Kernpunten voor tentamen`.
- Geef 8-15 concrete bullets met de belangrijkste leerpunten.

EINDCONTROLE VOOR UITVOER:
- Staat er nog een meta-inleiding? Verwijderen.
- Staat er nog letterlijke klasdialoog? Herschrijven.
- Zijn de hoofdonderwerpen uit zowel slides als transcript afgedekt? Zo niet: aanvullen.

INPUT SLIDE-TEKST:
{slide_text}

INPUT AUDIO-TRANSCRIPT:
{transcript}"""

PROMPT_MERGE_WITH_AUDIO_MARKERS = """Creëer een volledige, integrale en goed leesbare uitwerking van een college door slide-tekst en audio-transcript te combineren.

BELANGRIJK - AUDIO MARKERS:
Voor elke hoofdsectie gebruik je direct onder de kop exact dit marker-formaat:
<!-- audio:START_MS-END_MS -->
waar START_MS en END_MS de relevante tijdrange uit het transcript met tijdsegmenten aangeven.

Regels:
1. Niet samenvatten, maar compleet uitschrijven.
2. Gebruik koppen en subkoppen voor structuur.
3. Verwijder alleen irrelevante spreektaal; behoud alle inhoudelijke uitleg.
4. Gebruik geen labels zoals "Audio:" of "Slide:".
5. Schrijf volledig in deze taal: {output_language}.

Input slide-tekst:
{slide_text}

Input audio-transcript met tijdsegmenten:
{transcript}"""

PROMPT_STUDY_TEMPLATE = """You are an expert university professor creating study materials. I will provide you with the complete text of a lecture or slide deck.

Your task is to generate {flashcard_amount} flashcards and {question_amount} multiple-choice test questions based strictly on the provided text. Do not invent outside information.
Write all generated output fully in this language: {output_language}.

RULES FOR FLASHCARDS:
- The 'front' should be a clear term or concept.
- The 'back' should be a concise, accurate definition/explanation.

RULES FOR TEST QUESTIONS:
- Create challenging, university-level multiple-choice questions.
- Provide exactly 4 options (A, B, C, D) as an array of strings.
- Provide the correct answer (must match one option exactly).
- Provide a brief 'explanation' of WHY the answer is correct.

REQUIRED OUTPUT FORMAT:
You must respond with strictly valid JSON matching this structure:
{{
  "flashcards": [{{"front": "string", "back": "string"}}],
  "test_questions": [{{"question": "string", "options": ["string", "string", "string", "string"], "answer": "string", "explanation": "string"}}]
}}

LECTURE TEXT:
{source_text}
"""

# =============================================
# FIRESTORE USER FUNCTIONS
# =============================================

JOB_TTL_SECONDS = 2 * 60 * 60  # 2 hours
JOB_CLEANUP_INTERVAL_SECONDS = 5 * 60  # run cleanup every 5 minutes

def cleanup_old_jobs():
    """Evict completed/errored jobs older than JOB_TTL_SECONDS to prevent OOM."""
    now_ts = time.time()
    with JOBS_LOCK:
        expired_ids = []
        for job_id, job in list(jobs.items()):
            status = job.get('status', '')
            if status not in ('complete', 'error'):
                continue
            finished_at = job.get('finished_at', job.get('started_at', now_ts))
            if now_ts - finished_at > JOB_TTL_SECONDS:
                expired_ids.append(job_id)
        for job_id in expired_ids:
            jobs.pop(job_id, None)

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
            pass

_cleanup_thread = threading.Thread(target=_run_periodic_cleanup, daemon=True)
_cleanup_thread.start()

def build_default_user_data(uid, email):
    """Return the canonical default user document structure."""
    return {
        'uid': uid,
        'email': email,
        'lecture_credits_standard': FREE_LECTURE_CREDITS,
        'lecture_credits_extended': 0,
        'slides_credits': FREE_SLIDES_CREDITS,
        'interview_credits_short': FREE_INTERVIEW_CREDITS,
        'interview_credits_medium': 0,
        'interview_credits_long': 0,
        'total_processed': 0,
        'created_at': time.time(),
        'preferred_output_language': DEFAULT_OUTPUT_LANGUAGE_KEY,
        'preferred_output_language_custom': '',
        'onboarding_completed': False,
    }

def get_or_create_user(uid, email):
    """Get a user from Firestore, or create them with free credits if they don't exist."""
    user_ref = db.collection('users').document(uid)
    user_doc = user_ref.get()

    if user_doc.exists:
        user_data = user_doc.to_dict()
        updates = {}
        # Update email if it changed
        if user_data.get('email') != email and email:
            updates['email'] = email
        pref_key = sanitize_output_language_pref_key(user_data.get('preferred_output_language', DEFAULT_OUTPUT_LANGUAGE_KEY))
        pref_custom = sanitize_output_language_pref_custom(user_data.get('preferred_output_language_custom', ''))
        if pref_key != str(user_data.get('preferred_output_language', '') or '').strip().lower():
            updates['preferred_output_language'] = pref_key
        if pref_key != 'other':
            pref_custom = ''
        if pref_custom != str(user_data.get('preferred_output_language_custom', '') or '').strip():
            updates['preferred_output_language_custom'] = pref_custom
        if not isinstance(user_data.get('onboarding_completed'), bool):
            updates['onboarding_completed'] = False
        if updates:
            user_ref.update(updates)
            user_data.update(updates)
        return user_data
    else:
        # New user — create with free credits
        user_data = build_default_user_data(uid, email)
        user_ref.set(user_data)
        logger.info(f"New user created: {uid} ({email})")
        return user_data

def grant_credits_to_user(uid, bundle_id):
    """Grant credits from a purchased bundle to a user in Firestore."""
    bundle = CREDIT_BUNDLES.get(bundle_id)
    if not bundle:
        logger.info(f"Warning: Unknown bundle_id '{bundle_id}' in grant_credits_to_user")
        return False

    user_ref = db.collection('users').document(uid)
    user_doc = user_ref.get()

    if not user_doc.exists:
        # User not in Firestore yet — create with defaults first
        user_data = build_default_user_data(uid, '')
        user_ref.set(user_data)

    # Add the purchased credits
    for credit_key, credit_amount in bundle['credits'].items():
        user_ref.update({credit_key: firestore.Increment(credit_amount)})
        logger.info(f"Granted {credit_amount} '{credit_key}' credits to user {uid}.")

    return True

def deduct_credit(uid, credit_type_primary, credit_type_fallback=None):
    """Deduct one credit atomically using a Firestore transaction. Returns the credit type deducted, or None."""
    @firestore.transactional
    def _deduct_in_transaction(transaction, user_ref):
        snapshot = user_ref.get(transaction=transaction)
        if not snapshot.exists:
            return None
        data = snapshot.to_dict()
        if data.get(credit_type_primary, 0) > 0:
            transaction.update(user_ref, {
                credit_type_primary: firestore.Increment(-1),
                'total_processed': firestore.Increment(1),
            })
            return credit_type_primary
        elif credit_type_fallback and data.get(credit_type_fallback, 0) > 0:
            transaction.update(user_ref, {
                credit_type_fallback: firestore.Increment(-1),
                'total_processed': firestore.Increment(1),
            })
            return credit_type_fallback
        return None

    user_ref = db.collection('users').document(uid)
    transaction = db.transaction()
    return _deduct_in_transaction(transaction, user_ref)

def deduct_interview_credit(uid):
    """Deduct one interview credit atomically, checking short -> medium -> long. Returns the credit type deducted, or None."""
    @firestore.transactional
    def _deduct_in_transaction(transaction, user_ref):
        snapshot = user_ref.get(transaction=transaction)
        if not snapshot.exists:
            return None
        data = snapshot.to_dict()
        for credit_type in ('interview_credits_short', 'interview_credits_medium', 'interview_credits_long'):
            if data.get(credit_type, 0) > 0:
                transaction.update(user_ref, {
                    credit_type: firestore.Increment(-1),
                    'total_processed': firestore.Increment(1),
                })
                return credit_type
        return None

    user_ref = db.collection('users').document(uid)
    transaction = db.transaction()
    return _deduct_in_transaction(transaction, user_ref)

def refund_credit(uid, credit_type):
    """Refund one credit back to the user after a failed processing job."""
    if not uid or not credit_type:
        return
    try:
        user_ref = db.collection('users').document(uid)
        user_ref.update({
            credit_type: firestore.Increment(1),
            'total_processed': firestore.Increment(-1),
        })
        logger.info(f"✅ Refunded 1 '{credit_type}' credit to user {uid} due to processing failure.")
    except Exception as e:
        logger.info(f"❌ Failed to refund credit '{credit_type}' to user {uid}: {e}")

def save_purchase_record(uid, bundle_id, stripe_session_id):
    """Save a purchase record to Firestore for purchase history."""
    bundle = CREDIT_BUNDLES.get(bundle_id)
    if not bundle:
        return
    try:
        record = {
            'uid': uid,
            'bundle_id': bundle_id,
            'bundle_name': bundle['name'],
            'price_cents': bundle['price_cents'],
            'currency': bundle['currency'],
            'credits': bundle['credits'],
            'stripe_session_id': stripe_session_id,
            'created_at': time.time(),
        }
        if stripe_session_id:
            db.collection('purchases').document(stripe_session_id).set(record, merge=True)
        else:
            db.collection('purchases').add(record)
        logger.info(f"📝 Saved purchase record for user {uid}: {bundle['name']}")
    except Exception as e:
        logger.info(f"❌ Failed to save purchase record for user {uid}: {e}")

def purchase_record_exists_for_session(stripe_session_id):
    if not stripe_session_id:
        return False
    try:
        doc = db.collection('purchases').document(stripe_session_id).get()
        if doc.exists:
            return True
        query = db.collection('purchases').where('stripe_session_id', '==', stripe_session_id).limit(1)
        for _ in query.stream():
            return True
        return False
    except Exception as e:
        logger.info(f"⚠️ Could not check purchase record for session {stripe_session_id}: {e}")
        return False

def process_checkout_session_credits(stripe_session):
    metadata = stripe_session.get('metadata', {}) or {}
    uid = metadata.get('uid', '')
    bundle_id = metadata.get('bundle_id', '')
    stripe_session_id = stripe_session.get('id', '')
    payment_status = (stripe_session.get('payment_status') or '').lower()
    session_status = (stripe_session.get('status') or '').lower()

    if not uid or not bundle_id:
        return False, 'Missing checkout metadata.'
    if bundle_id not in CREDIT_BUNDLES:
        return False, 'Unknown credit bundle.'
    if payment_status != 'paid' and session_status != 'complete':
        return False, 'Checkout session is not paid yet.'
    if purchase_record_exists_for_session(stripe_session_id):
        return True, 'already_processed'

    success = grant_credits_to_user(uid, bundle_id)
    if not success:
        return False, 'Could not grant credits.'
    save_purchase_record(uid, bundle_id, stripe_session_id)
    bundle = CREDIT_BUNDLES.get(bundle_id, {})
    log_analytics_event(
        'payment_confirmed_backend',
        source='backend',
        uid=uid,
        session_id=stripe_session_id,
        properties={
            'bundle_id': bundle_id,
            'price_cents': int(bundle.get('price_cents', 0) or 0),
        }
    )
    return True, 'granted'

def sanitize_analytics_event_name(raw_name):
    return analytics_service.sanitize_event_name(
        raw_name,
        name_re=ANALYTICS_NAME_RE,
        allowed_events=ANALYTICS_ALLOWED_EVENTS,
    )

def sanitize_analytics_session_id(raw_session_id):
    return analytics_service.sanitize_session_id(
        raw_session_id,
        session_id_re=ANALYTICS_SESSION_ID_RE,
    )

def sanitize_analytics_properties(raw_props):
    return analytics_service.sanitize_properties(raw_props, name_re=ANALYTICS_NAME_RE)

def log_analytics_event(event_name, source='frontend', uid='', email='', session_id='', properties=None, created_at=None):
    return analytics_service.log_analytics_event(
        event_name,
        source=source,
        uid=uid,
        email=email,
        session_id=session_id,
        properties=properties,
        created_at=created_at,
        db=db,
        name_re=ANALYTICS_NAME_RE,
        session_id_re=ANALYTICS_SESSION_ID_RE,
        allowed_events=ANALYTICS_ALLOWED_EVENTS,
        logger=logger,
        time_module=time,
    )

def log_rate_limit_hit(limit_name, retry_after=0):
    return analytics_service.log_rate_limit_hit(
        limit_name,
        retry_after=retry_after,
        db=db,
        logger=logger,
        time_module=time,
    )

def save_job_log(job_id, job_data, finished_at):
    """Save a processing job log to Firestore for analytics."""
    try:
        started_at = job_data.get('started_at', 0)
        duration = round(finished_at - started_at, 1) if started_at else 0
        db.collection('job_logs').document(job_id).set({
            'job_id': job_id,
            'uid': job_data.get('user_id', ''),
            'email': job_data.get('user_email', ''),
            'mode': job_data.get('mode', ''),
            'status': job_data.get('status', ''),
            'credit_deducted': job_data.get('credit_deducted', ''),
            'credit_refunded': job_data.get('credit_refunded', False),
            'error_message': job_data.get('error', ''),
            'started_at': started_at,
            'finished_at': finished_at,
            'duration_seconds': duration,
        })
        status = str(job_data.get('status', '') or '').lower()
        backend_event = 'processing_finished_backend'
        if status == 'complete':
            backend_event = 'processing_completed_backend'
        elif status == 'error':
            backend_event = 'processing_failed_backend'
        log_analytics_event(
            backend_event,
            source='backend',
            uid=job_data.get('user_id', ''),
            email=job_data.get('user_email', ''),
            session_id=job_id,
            properties={
                'job_id': job_id,
                'mode': job_data.get('mode', ''),
                'duration_seconds': duration,
                'credit_refunded': bool(job_data.get('credit_refunded', False)),
            },
            created_at=finished_at,
        )
        logger.info(f"📊 Logged job {job_id}: mode={job_data.get('mode')}, status={job_data.get('status')}, duration={duration}s")
    except Exception as e:
        logger.info(f"❌ Failed to log job {job_id}: {e}")

# =============================================
# HELPER FUNCTIONS
# =============================================

def verify_firebase_token(request):
    return auth_service.verify_firebase_token(request, auth_module=auth, logger=logger)

def is_admin_user(decoded_token):
    if not decoded_token:
        return False
    uid = decoded_token.get('uid', '')
    email = decoded_token.get('email', '').lower()
    return uid in ADMIN_UIDS or email in ADMIN_EMAILS

def get_admin_window(window_key):
    windows = {
        '24h': 24 * 60 * 60,
        '7d': 7 * 24 * 60 * 60,
        '30d': 30 * 24 * 60 * 60,
    }
    safe_key = window_key if window_key in windows else '7d'
    return safe_key, windows[safe_key]

def get_timestamp(value):
    return value if isinstance(value, (int, float)) else 0

def build_time_buckets(window_key, now_ts):
    labels = []
    keys = []
    if window_key == '24h':
        now_dt = datetime.fromtimestamp(now_ts, tz=timezone.utc).replace(minute=0, second=0, microsecond=0)
        start_dt = now_dt - timedelta(hours=23)
        for i in range(24):
            current = start_dt + timedelta(hours=i)
            labels.append(current.strftime('%H:%M'))
            keys.append(current.strftime('%Y-%m-%d %H:00'))
        granularity = 'hour'
    else:
        days = 7 if window_key == '7d' else 30
        now_dt = datetime.fromtimestamp(now_ts, tz=timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        start_dt = now_dt - timedelta(days=days - 1)
        for i in range(days):
            current = start_dt + timedelta(days=i)
            labels.append(current.strftime('%d %b'))
            keys.append(current.strftime('%Y-%m-%d'))
        granularity = 'day'
    return labels, keys, granularity

def get_bucket_key(timestamp, window_key):
    dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
    if window_key == '24h':
        return dt.replace(minute=0, second=0, microsecond=0).strftime('%Y-%m-%d %H:00')
    return dt.replace(hour=0, minute=0, second=0, microsecond=0).strftime('%Y-%m-%d')


def query_docs_in_window(collection_name, timestamp_field, window_start, window_end=None, order_desc=False, limit=None):
    collection = db.collection(collection_name)
    query = collection.where(timestamp_field, '>=', window_start)
    if window_end is not None:
        query = query.where(timestamp_field, '<=', window_end)
    if order_desc:
        query = query.order_by(timestamp_field, direction=firestore.Query.DESCENDING)
    if isinstance(limit, int) and limit > 0:
        query = query.limit(limit)
    return list(query.stream())


def safe_query_docs_in_window(collection_name, timestamp_field, window_start, window_end=None, order_desc=False, limit=None):
    if db is None:
        return []
    try:
        return query_docs_in_window(
            collection_name=collection_name,
            timestamp_field=timestamp_field,
            window_start=window_start,
            window_end=window_end,
            order_desc=order_desc,
            limit=limit,
        )
    except Exception:
        # Fallback for missing indexes in early environments.
        docs = []
        for doc in db.collection(collection_name).stream():
            data = doc.to_dict() or {}
            ts = get_timestamp(data.get(timestamp_field))
            if ts < window_start:
                continue
            if window_end is not None and ts > window_end:
                continue
            docs.append(doc)
        docs.sort(
            key=lambda d: get_timestamp((d.to_dict() or {}).get(timestamp_field)),
            reverse=order_desc,
        )
        if isinstance(limit, int) and limit > 0:
            docs = docs[:limit]
        return docs


def safe_count_collection(collection_name):
    if db is None:
        return 0
    try:
        agg = db.collection(collection_name).count().get()
        if agg:
            return int(agg[0][0].value)
    except Exception:
        pass
    return len(list(db.collection(collection_name).stream()))


def safe_count_window(collection_name, timestamp_field, window_start):
    if db is None:
        return 0
    try:
        query = db.collection(collection_name).where(timestamp_field, '>=', window_start)
        agg = query.count().get()
        if agg:
            return int(agg[0][0].value)
    except Exception:
        pass
    docs = safe_query_docs_in_window(collection_name, timestamp_field, window_start)
    return len(docs)

def build_admin_funnel_steps(analytics_docs, window_start):
    funnel_actor_sets = {stage['event']: set() for stage in ANALYTICS_FUNNEL_STAGES}
    analytics_event_count = 0

    for doc in analytics_docs:
        event = doc.to_dict() or {}
        created_at = get_timestamp(event.get('created_at'))
        if created_at < window_start:
            continue
        event_name = sanitize_analytics_event_name(event.get('event', ''))
        if not event_name:
            continue
        analytics_event_count += 1
        if event_name not in funnel_actor_sets:
            continue
        uid = str(event.get('uid', '') or '').strip()
        session_id = sanitize_analytics_session_id(event.get('session_id', ''))
        actor_id = uid or session_id or f"doc:{doc.id}"
        funnel_actor_sets[event_name].add(actor_id)

    funnel_steps = []
    previous_count = 0
    for idx, stage in enumerate(ANALYTICS_FUNNEL_STAGES):
        count = len(funnel_actor_sets.get(stage['event'], set()))
        if idx == 0:
            conversion = 100.0 if count > 0 else 0.0
        elif previous_count > 0:
            conversion = round(min((count / previous_count) * 100.0, 100.0), 1)
        else:
            conversion = 0.0
        funnel_steps.append({
            'event': stage['event'],
            'label': stage['label'],
            'count': count,
            'conversion_from_prev': conversion,
        })
        previous_count = count

    return funnel_steps, analytics_event_count

def build_admin_funnel_daily_rows(analytics_docs, window_start, window_key, now_ts):
    _labels, bucket_keys, granularity = build_time_buckets(window_key, now_ts)
    counts_by_bucket = {}

    for doc in analytics_docs:
        event = doc.to_dict() or {}
        created_at = get_timestamp(event.get('created_at'))
        if created_at < window_start or created_at > now_ts:
            continue
        event_name = sanitize_analytics_event_name(event.get('event', ''))
        if event_name not in ANALYTICS_FUNNEL_EVENT_NAMES:
            continue

        bucket_key = get_bucket_key(created_at, window_key)
        if bucket_key not in counts_by_bucket:
            counts_by_bucket[bucket_key] = {}
        if event_name not in counts_by_bucket[bucket_key]:
            counts_by_bucket[bucket_key][event_name] = {'event_count': 0, 'actors': set()}

        uid = str(event.get('uid', '') or '').strip()
        session_id = sanitize_analytics_session_id(event.get('session_id', ''))
        actor_id = uid or session_id or f"doc:{doc.id}"

        counts_by_bucket[bucket_key][event_name]['event_count'] += 1
        counts_by_bucket[bucket_key][event_name]['actors'].add(actor_id)

    rows = []
    for bucket_key in bucket_keys:
        stage_counts = counts_by_bucket.get(bucket_key, {})
        prev_unique = 0
        for idx, stage in enumerate(ANALYTICS_FUNNEL_STAGES):
            stage_data = stage_counts.get(stage['event'], {'event_count': 0, 'actors': set()})
            unique_actor_count = len(stage_data.get('actors', set()))
            event_count = int(stage_data.get('event_count', 0) or 0)
            if idx == 0:
                conversion = 100.0 if unique_actor_count > 0 else 0.0
            elif prev_unique > 0:
                conversion = round(min((unique_actor_count / prev_unique) * 100.0, 100.0), 1)
            else:
                conversion = 0.0

            rows.append({
                'bucket_key': bucket_key,
                'granularity': granularity,
                'event': stage['event'],
                'label': stage['label'],
                'unique_actor_count': unique_actor_count,
                'event_count': event_count,
                'conversion_from_prev': conversion,
            })
            prev_unique = unique_actor_count

    return rows, granularity

def get_job_snapshot(job_id):
    return job_state_service.get_job_snapshot(job_id, jobs_store=jobs, lock=JOBS_LOCK)


def mutate_job(job_id, mutator_fn):
    return job_state_service.mutate_job(job_id, mutator_fn, jobs_store=jobs, lock=JOBS_LOCK)


def set_job(job_id, value):
    return job_state_service.set_job(job_id, value, jobs_store=jobs, lock=JOBS_LOCK)


def delete_job(job_id):
    return job_state_service.delete_job(job_id, jobs_store=jobs, lock=JOBS_LOCK)


def _window_counter_id(key, window_seconds, window_start):
    return rate_limit_service.window_counter_id(key, window_seconds, window_start)


def _check_rate_limit_firestore(key, limit, window_seconds, now_ts):
    return rate_limit_service.check_rate_limit_firestore(
        key,
        limit,
        window_seconds,
        now_ts,
        firestore_enabled=RATE_LIMIT_FIRESTORE_ENABLED,
        db=db,
        firestore_module=firestore,
        counter_collection=RATE_LIMIT_COUNTER_COLLECTION,
    )


def check_rate_limit(key, limit, window_seconds):
    return rate_limit_service.check_rate_limit(
        key,
        limit,
        window_seconds,
        firestore_enabled=RATE_LIMIT_FIRESTORE_ENABLED,
        db=db,
        firestore_module=firestore,
        counter_collection=RATE_LIMIT_COUNTER_COLLECTION,
        in_memory_events=RATE_LIMIT_EVENTS,
        in_memory_lock=RATE_LIMIT_LOCK,
        time_module=time,
    )

def build_rate_limited_response(message, retry_after):
    response = jsonify({
        'error': message,
        'retry_after_seconds': int(max(1, retry_after)),
    })
    response.status_code = 429
    response.headers['Retry-After'] = str(int(max(1, retry_after)))
    return response

def normalize_rate_limit_key_part(value, fallback='anon', max_len=120):
    raw = str(value or '').strip().lower()
    if not raw:
        return fallback
    safe = re.sub(r'[^a-z0-9_.:@-]+', '_', raw)
    return safe[:max_len] if safe else fallback

def count_active_jobs_for_user(uid):
    return job_state_service.count_active_jobs_for_user(uid, jobs_store=jobs, lock=JOBS_LOCK)

def list_docs_by_uid(collection_name, uid, max_docs):
    docs = list(
        db.collection(collection_name)
        .where('uid', '==', uid)
        .limit(max_docs + 1)
        .stream()
    )
    truncated = len(docs) > max_docs
    limited = docs[:max_docs]
    records = []
    for doc in limited:
        data = doc.to_dict() or {}
        data['_id'] = doc.id
        records.append(data)
    return records, truncated

def delete_docs_by_uid(collection_name, uid, max_docs):
    docs = list(
        db.collection(collection_name)
        .where('uid', '==', uid)
        .limit(max_docs + 1)
        .stream()
    )
    truncated = len(docs) > max_docs
    limited = docs[:max_docs]
    deleted = 0
    for doc in limited:
        try:
            doc.reference.delete()
            deleted += 1
        except Exception as e:
            logger.info(f"Warning: could not delete doc in {collection_name}/{doc.id}: {e}")
    return deleted, truncated

def remove_upload_artifacts_for_job_ids(job_ids):
    if not job_ids:
        return 0
    try:
        names = os.listdir(UPLOAD_FOLDER)
    except Exception:
        return 0
    prefixes = tuple(f"{str(job_id).strip()}_" for job_id in job_ids if str(job_id or '').strip())
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
            logger.info(f"Warning: could not delete upload artifact {file_path}: {e}")
    return removed

def anonymize_purchase_docs_by_uid(uid, max_docs):
    docs = list(
        db.collection('purchases')
        .where('uid', '==', uid)
        .limit(max_docs + 1)
        .stream()
    )
    truncated = len(docs) > max_docs
    limited = docs[:max_docs]
    anonymized = 0
    for doc in limited:
        try:
            doc.reference.set({
                'uid': '',
                'user_erased': True,
                'erased_at': time.time(),
            }, merge=True)
            anonymized += 1
        except Exception as e:
            logger.info(f"Warning: could not anonymize purchase doc {doc.id}: {e}")
    return anonymized, truncated

def collect_user_export_payload(uid, email):
    user_doc = db.collection('users').document(uid).get()
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

    return {
        'meta': {
            'exported_at': time.time(),
            'version': 1,
            'uid': uid,
            'email': email,
            'source': 'lecture-processor',
            'limits': {
                'max_docs_per_collection': ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION,
            },
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

def parse_requested_amount(raw_value, allowed, default):
    value = str(raw_value or default).strip().lower()
    return value if value in allowed else default

def parse_study_features(raw_value):
    value = str(raw_value or 'none').strip().lower()
    return value if value in {'none', 'flashcards', 'test', 'both'} else 'none'

def normalize_output_language_choice(raw_value, custom_value=''):
    key = str(raw_value or DEFAULT_OUTPUT_LANGUAGE_KEY).strip().lower()
    custom = str(custom_value or '').strip()[:MAX_OUTPUT_LANGUAGE_CUSTOM_LENGTH]
    if key in OUTPUT_LANGUAGE_MAP:
        return key, '', OUTPUT_LANGUAGE_MAP[key]
    if key == 'other':
        if custom:
            return 'other', custom, custom
        return DEFAULT_OUTPUT_LANGUAGE_KEY, '', OUTPUT_LANGUAGE_MAP[DEFAULT_OUTPUT_LANGUAGE_KEY]
    return DEFAULT_OUTPUT_LANGUAGE_KEY, '', OUTPUT_LANGUAGE_MAP[DEFAULT_OUTPUT_LANGUAGE_KEY]

def parse_output_language(raw_value, custom_value=''):
    _key, _custom, resolved = normalize_output_language_choice(raw_value, custom_value)
    return resolved

def sanitize_output_language_pref_key(raw_value):
    key = str(raw_value or DEFAULT_OUTPUT_LANGUAGE_KEY).strip().lower()
    return key if key in OUTPUT_LANGUAGE_KEYS else DEFAULT_OUTPUT_LANGUAGE_KEY

def sanitize_output_language_pref_custom(raw_value):
    return str(raw_value or '').strip()[:MAX_OUTPUT_LANGUAGE_CUSTOM_LENGTH]

def build_user_preferences_payload(user_data):
    key, custom, resolved = normalize_output_language_choice(
        user_data.get('preferred_output_language', DEFAULT_OUTPUT_LANGUAGE_KEY),
        user_data.get('preferred_output_language_custom', ''),
    )
    return {
        'output_language': key,
        'output_language_custom': custom,
        'output_language_label': resolved,
        'onboarding_completed': bool(user_data.get('onboarding_completed', False)),
    }

def parse_interview_features(raw_value):
    value = str(raw_value or 'none').strip().lower()
    if value in {'none', ''}:
        return []
    if value == 'both':
        return ['summary', 'sections']
    parts = [part.strip() for part in value.split(',') if part.strip()]
    features = []
    for part in parts:
        if part in {'summary', 'sections'} and part not in features:
            features.append(part)
    return features

def host_matches_allowed_suffix(hostname):
    if not hostname:
        return False
    host = hostname.strip().lower()
    return any(host == suffix or host.endswith('.' + suffix) for suffix in VIDEO_IMPORT_ALLOWED_HOST_SUFFIXES)

def is_blocked_hostname(hostname):
    host = str(hostname or '').strip().lower()
    if not host:
        return True
    if host in {'localhost', 'localhost.localdomain'}:
        return True
    if host.endswith('.local') or host.endswith('.internal'):
        return True
    try:
        ip = ipaddress.ip_address(host)
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_reserved:
            return True
    except ValueError:
        pass
    return False

def validate_video_import_url(raw_url):
    url = str(raw_url or '').strip()
    if not url:
        return '', 'Please paste a video URL.'
    if len(url) > VIDEO_IMPORT_MAX_URL_LENGTH:
        return '', 'Video URL is too long.'
    try:
        parsed = urlparse(url)
    except Exception:
        return '', 'Video URL is invalid.'
    if parsed.scheme.lower() != 'https':
        return '', 'Only HTTPS video URLs are supported.'
    if parsed.username or parsed.password:
        return '', 'Video URL credentials are not allowed.'
    host = (parsed.hostname or '').strip().lower()
    if not host:
        return '', 'Video URL host is missing.'
    if is_blocked_hostname(host):
        return '', 'This video host is not allowed.'
    if VIDEO_IMPORT_ALLOWED_HOST_SUFFIXES and not host_matches_allowed_suffix(host):
        return '', 'Only Brightspace/Kaltura video hosts are supported for automatic import.'
    # SSRF guard: pre-resolve DNS and check the resolved IP isn't private/internal (Issue 5)
    try:
        import socket
        resolved_ips = socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP)
        for family, kind, proto, canonname, sockaddr in resolved_ips:
            ip_str = sockaddr[0]
            ip_obj = ipaddress.ip_address(ip_str)
            if ip_obj.is_private or ip_obj.is_loopback or ip_obj.is_link_local or ip_obj.is_multicast or ip_obj.is_reserved:
                return '', 'This video host resolves to a restricted network address.'
    except socket.gaierror:
        return '', 'Could not resolve the video URL host.'
    except Exception:
        pass
    return url, ''

def cleanup_expired_audio_import_tokens():
    now_ts = time.time()
    expired = []
    with AUDIO_IMPORT_LOCK:
        for token, data in list(AUDIO_IMPORT_TOKENS.items()):
            if now_ts > float(data.get('expires_at', 0) or 0):
                expired.append(data.get('path', ''))
                AUDIO_IMPORT_TOKENS.pop(token, None)
    for path in expired:
        try:
            if path and os.path.exists(path):
                os.remove(path)
        except Exception:
            pass

def register_audio_import_token(uid, file_path, source_url='', original_name=''):
    token = str(uuid.uuid4())
    with AUDIO_IMPORT_LOCK:
        AUDIO_IMPORT_TOKENS[token] = {
            'uid': str(uid or ''),
            'path': str(file_path or ''),
            'source_url': str(source_url or '')[:VIDEO_IMPORT_MAX_URL_LENGTH],
            'original_name': str(original_name or '')[:240],
            'created_at': time.time(),
            'expires_at': time.time() + AUDIO_IMPORT_TOKEN_TTL_SECONDS,
        }
    return token

def get_audio_import_token_path(uid, token, consume=False):
    cleanup_expired_audio_import_tokens()
    safe_uid = str(uid or '')
    safe_token = str(token or '').strip()
    if not safe_token:
        return '', 'Missing imported audio token.'
    with AUDIO_IMPORT_LOCK:
        entry = AUDIO_IMPORT_TOKENS.get(safe_token)
        if not entry:
            return '', 'Imported audio token expired or invalid. Please import again.'
        if entry.get('uid', '') != safe_uid:
            return '', 'Imported audio token does not belong to this account.'
        file_path = str(entry.get('path', '') or '').strip()
        if consume:
            AUDIO_IMPORT_TOKENS.pop(safe_token, None)
    if not file_path or not os.path.exists(file_path):
        return '', 'Imported audio file is no longer available. Please import again.'
    return file_path, ''

def release_audio_import_token(uid, token):
    safe_uid = str(uid or '')
    safe_token = str(token or '').strip()
    if not safe_token:
        return False
    file_path = ''
    with AUDIO_IMPORT_LOCK:
        entry = AUDIO_IMPORT_TOKENS.get(safe_token)
        if not entry or entry.get('uid', '') != safe_uid:
            return False
        file_path = str(entry.get('path', '') or '').strip()
        AUDIO_IMPORT_TOKENS.pop(safe_token, None)
    try:
        if file_path and os.path.exists(file_path):
            os.remove(file_path)
    except Exception:
        pass
    return True

def get_ffmpeg_binary():
    return file_service.get_ffmpeg_binary(which_func=shutil.which, imageio_ffmpeg_module=imageio_ffmpeg)

def get_ffprobe_binary():
    return file_service.get_ffprobe_binary(ffmpeg_binary_getter=get_ffmpeg_binary)

def download_audio_from_video_url(source_url, file_prefix):
    return file_service.download_audio_from_video_url(
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

def deduct_slides_credits(uid, amount):
    """Deduct slides credits atomically using a Firestore transaction."""
    if amount <= 0:
        return True

    @firestore.transactional
    def _deduct_in_transaction(transaction, user_ref):
        snapshot = user_ref.get(transaction=transaction)
        if not snapshot.exists:
            return False
        data = snapshot.to_dict()
        current = data.get('slides_credits', 0)
        if current < amount:
            return False
        transaction.update(user_ref, {'slides_credits': firestore.Increment(-amount)})
        return True

    user_ref = db.collection('users').document(uid)
    transaction = db.transaction()
    return _deduct_in_transaction(transaction, user_ref)

def refund_slides_credits(uid, amount):
    if not uid or amount <= 0:
        return
    try:
        db.collection('users').document(uid).update({'slides_credits': firestore.Increment(amount)})
        logger.info(f"✅ Refunded {amount} slides credits to user {uid}.")
    except Exception as e:
        logger.info(f"❌ Failed to refund {amount} slides credits to user {uid}: {e}")

def normalize_credit_ledger(credit_map):
    normalized = {}
    if not isinstance(credit_map, dict):
        return normalized
    for credit_type, raw_amount in credit_map.items():
        key = str(credit_type or '').strip()
        if not key:
            continue
        try:
            amount = int(raw_amount)
        except Exception:
            continue
        if amount > 0:
            normalized[key] = amount
    return normalized

def initialize_billing_receipt(charged_map=None):
    return {
        'charged': normalize_credit_ledger(charged_map or {}),
        'refunded': {},
        'updated_at': time.time(),
    }

def ensure_job_billing_receipt(job_data, charged_map=None):
    receipt = job_data.get('billing_receipt')
    if not isinstance(receipt, dict):
        receipt = initialize_billing_receipt(charged_map or {})
        job_data['billing_receipt'] = receipt
        return receipt
    charged = receipt.get('charged', {})
    if not isinstance(charged, dict):
        charged = {}
    for credit_type, amount in normalize_credit_ledger(charged_map or {}).items():
        charged[credit_type] = max(int(charged.get(credit_type, 0) or 0), amount)
    receipt['charged'] = charged
    if not isinstance(receipt.get('refunded'), dict):
        receipt['refunded'] = {}
    receipt['updated_at'] = time.time()
    return receipt

def add_job_credit_refund(job_data, credit_type, amount=1):
    if not credit_type:
        return
    try:
        amount_int = int(amount)
    except Exception:
        return
    if amount_int <= 0:
        return
    receipt = ensure_job_billing_receipt(job_data)
    refunded = receipt.setdefault('refunded', {})
    refunded[credit_type] = int(refunded.get(credit_type, 0) or 0) + amount_int
    receipt['updated_at'] = time.time()

def get_billing_receipt_snapshot(job_data):
    receipt = job_data.get('billing_receipt')
    if not isinstance(receipt, dict):
        return {'charged': {}, 'refunded': {}}
    snapshot = {
        'charged': normalize_credit_ledger(receipt.get('charged', {})),
        'refunded': normalize_credit_ledger(receipt.get('refunded', {})),
    }
    updated_at = receipt.get('updated_at')
    if updated_at:
        snapshot['updated_at'] = updated_at
    return snapshot

def normalize_credit_ledger(credit_map):
    normalized = {}
    if not isinstance(credit_map, dict):
        return normalized
    for credit_type, raw_amount in credit_map.items():
        key = str(credit_type or '').strip()
        if not key:
            continue
        try:
            amount = int(raw_amount)
        except Exception:
            continue
        if amount > 0:
            normalized[key] = amount
    return normalized

def initialize_billing_receipt(charged_map=None):
    return {
        'charged': normalize_credit_ledger(charged_map or {}),
        'refunded': {},
        'updated_at': time.time(),
    }

def ensure_job_billing_receipt(job_data, charged_map=None):
    receipt = job_data.get('billing_receipt')
    if not isinstance(receipt, dict):
        receipt = initialize_billing_receipt(charged_map or {})
        job_data['billing_receipt'] = receipt
        return receipt
    charged = receipt.get('charged', {})
    if not isinstance(charged, dict):
        charged = {}
    for credit_type, amount in normalize_credit_ledger(charged_map or {}).items():
        charged[credit_type] = max(int(charged.get(credit_type, 0) or 0), amount)
    receipt['charged'] = charged
    if not isinstance(receipt.get('refunded'), dict):
        receipt['refunded'] = {}
    receipt['updated_at'] = time.time()
    return receipt

def add_job_credit_refund(job_data, credit_type, amount=1):
    if not credit_type:
        return
    try:
        amount_int = int(amount)
    except Exception:
        return
    if amount_int <= 0:
        return
    receipt = ensure_job_billing_receipt(job_data)
    refunded = receipt.setdefault('refunded', {})
    refunded[credit_type] = int(refunded.get(credit_type, 0) or 0) + amount_int
    receipt['updated_at'] = time.time()

def get_billing_receipt_snapshot(job_data):
    receipt = job_data.get('billing_receipt')
    if not isinstance(receipt, dict):
        return {'charged': {}, 'refunded': {}}
    snapshot = {
        'charged': normalize_credit_ledger(receipt.get('charged', {})),
        'refunded': normalize_credit_ledger(receipt.get('refunded', {})),
    }
    updated_at = receipt.get('updated_at')
    if updated_at:
        snapshot['updated_at'] = updated_at
    return snapshot

def generate_with_optional_thinking(model, prompt_text, max_output_tokens=65536, thinking_budget=256):
    base_config = {'max_output_tokens': max_output_tokens}
    try:
        if hasattr(types, 'ThinkingConfig'):
            base_config['thinking_config'] = types.ThinkingConfig(thinking_budget=thinking_budget)
    except Exception:
        pass
    try:
        config = types.GenerateContentConfig(**base_config)
    except Exception:
        config = types.GenerateContentConfig(max_output_tokens=max_output_tokens)
    return client.models.generate_content(
        model=model,
        contents=[types.Content(role='user', parts=[types.Part.from_text(text=prompt_text)])],
        config=config
    )

def convert_audio_to_mp3_with_ytdlp(local_audio_path):
    return file_service.convert_audio_to_mp3_with_ytdlp(
        local_audio_path,
        ffmpeg_binary_getter=get_ffmpeg_binary,
        logger=logger,
        which_func=shutil.which,
        subprocess_module=subprocess,
    )

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
    return flashcard_amount, question_amount

def extract_json_payload(raw_text):
    if not raw_text:
        return None
    text = raw_text.strip()
    if text.startswith('```'):
        lines = text.splitlines()
        if len(lines) >= 3 and lines[0].startswith('```') and lines[-1].strip() == '```':
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
        front = str(item.get('front', '')).strip()[:MAX_TEXT_LEN]
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
        if not question or not isinstance(options, list) or len(options) != 4 or not answer:
            continue
        option_strings = [str(option).strip()[:MAX_TEXT_LEN] for option in options]
        if any(not option for option in option_strings):
            continue
        if len(set(option_strings)) != 4:
            continue
        if answer not in option_strings:
            continue
        dedupe_key = question.lower()
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        cleaned.append({
            'question': question,
            'options': option_strings,
            'answer': answer,
            'explanation': explanation,
        })
        if len(cleaned) >= max_items:
            break
    return cleaned

def default_streak_data():
    return {
        'last_study_date': '',
        'current_streak': 0,
        'daily_progress_date': '',
        'daily_progress_count': 0,
    }

def sanitize_progress_date(value):
    text = str(value or '').strip()
    return text if PROGRESS_DATE_RE.match(text) else ''

def sanitize_int(value, default=0, min_value=0, max_value=10_000_000):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    if parsed < min_value:
        return min_value
    if parsed > max_value:
        return max_value
    return parsed

def sanitize_streak_data(payload):
    base = default_streak_data()
    if not isinstance(payload, dict):
        return base
    base['last_study_date'] = sanitize_progress_date(payload.get('last_study_date', ''))
    base['current_streak'] = sanitize_int(payload.get('current_streak', 0), default=0, min_value=0, max_value=36500)
    base['daily_progress_date'] = sanitize_progress_date(payload.get('daily_progress_date', ''))
    base['daily_progress_count'] = sanitize_int(payload.get('daily_progress_count', 0), default=0, min_value=0, max_value=100000)
    return base

def sanitize_daily_goal_value(value):
    parsed = sanitize_int(value, default=-1, min_value=-1, max_value=500)
    if parsed < 1:
        return None
    return parsed

def sanitize_pack_id(value):
    pack_id = str(value or '').strip()
    if not pack_id or len(pack_id) > 160:
        return ''
    return pack_id

def sanitize_card_state_entry(payload):
    if not isinstance(payload, dict):
        return None
    seen = sanitize_int(payload.get('seen', 0), default=0, min_value=0, max_value=100000)
    correct = sanitize_int(payload.get('correct', 0), default=0, min_value=0, max_value=100000)
    wrong = sanitize_int(payload.get('wrong', 0), default=0, min_value=0, max_value=100000)
    interval_days = sanitize_int(payload.get('interval_days', 0), default=0, min_value=0, max_value=3650)
    level = str(payload.get('level', '')).strip().lower()
    if level not in {'new', 'familiar', 'mastered'}:
        if interval_days >= 14:
            level = 'mastered'
        elif seen > 0:
            level = 'familiar'
        else:
            level = 'new'
    difficulty = str(payload.get('difficulty', 'medium')).strip().lower()
    if difficulty not in {'easy', 'medium', 'hard'}:
        difficulty = 'medium'
    return {
        'seen': seen,
        'correct': correct,
        'wrong': wrong,
        'level': level,
        'interval_days': interval_days,
        'next_review_date': sanitize_progress_date(payload.get('next_review_date', '')),
        'last_review_date': sanitize_progress_date(payload.get('last_review_date', '')),
        'difficulty': difficulty,
    }

def sanitize_card_state_map(payload):
    if not isinstance(payload, dict):
        return {}
    cleaned = {}
    for raw_card_id, raw_entry in payload.items():
        card_id = str(raw_card_id or '').strip()
        if not card_id or len(card_id) > 64:
            continue
        if not re.match(r'^(fc|q)_\d{1,6}$', card_id):
            continue
        entry = sanitize_card_state_entry(raw_entry)
        if entry is None:
            continue
        cleaned[card_id] = entry
        if len(cleaned) >= MAX_PROGRESS_CARDS_PER_PACK:
            break
    return cleaned

def derive_card_level_from_stats(seen, interval_days):
    if interval_days >= 14:
        return 'mastered'
    if seen > 0:
        return 'familiar'
    return 'new'

def merge_streak_data(server_payload, incoming_payload):
    server = sanitize_streak_data(server_payload)
    incoming = sanitize_streak_data(incoming_payload)

    merged_last_study_date = max(server.get('last_study_date', ''), incoming.get('last_study_date', ''))
    if merged_last_study_date == server.get('last_study_date', '') and merged_last_study_date != incoming.get('last_study_date', ''):
        merged_current_streak = sanitize_int(server.get('current_streak', 0), default=0, min_value=0, max_value=36500)
    elif merged_last_study_date == incoming.get('last_study_date', '') and merged_last_study_date != server.get('last_study_date', ''):
        merged_current_streak = sanitize_int(incoming.get('current_streak', 0), default=0, min_value=0, max_value=36500)
    else:
        merged_current_streak = max(
            sanitize_int(server.get('current_streak', 0), default=0, min_value=0, max_value=36500),
            sanitize_int(incoming.get('current_streak', 0), default=0, min_value=0, max_value=36500),
        )

    merged_daily_progress_date = max(server.get('daily_progress_date', ''), incoming.get('daily_progress_date', ''))
    if merged_daily_progress_date == server.get('daily_progress_date', '') and merged_daily_progress_date != incoming.get('daily_progress_date', ''):
        merged_daily_progress_count = sanitize_int(server.get('daily_progress_count', 0), default=0, min_value=0, max_value=100000)
    elif merged_daily_progress_date == incoming.get('daily_progress_date', '') and merged_daily_progress_date != server.get('daily_progress_date', ''):
        merged_daily_progress_count = sanitize_int(incoming.get('daily_progress_count', 0), default=0, min_value=0, max_value=100000)
    else:
        merged_daily_progress_count = max(
            sanitize_int(server.get('daily_progress_count', 0), default=0, min_value=0, max_value=100000),
            sanitize_int(incoming.get('daily_progress_count', 0), default=0, min_value=0, max_value=100000),
        )
    if not merged_daily_progress_date:
        merged_daily_progress_count = 0

    return sanitize_streak_data({
        'last_study_date': merged_last_study_date,
        'current_streak': merged_current_streak,
        'daily_progress_date': merged_daily_progress_date,
        'daily_progress_count': merged_daily_progress_count,
    })

def merge_timezone_value(server_timezone, incoming_timezone):
    server_value = sanitize_timezone_name(server_timezone)
    incoming_value = sanitize_timezone_name(incoming_timezone)
    return incoming_value or server_value

def sanitize_timezone_name(value):
    timezone_name = str(value or '').strip()[:80]
    if not timezone_name:
        return ''
    if ZoneInfo:
        try:
            ZoneInfo(timezone_name)
            return timezone_name
        except Exception:
            return ''
    return timezone_name

def resolve_progress_timezone(progress_data):
    timezone_name = sanitize_timezone_name((progress_data or {}).get('timezone', ''))
    if timezone_name and ZoneInfo:
        try:
            return ZoneInfo(timezone_name), timezone_name
        except Exception:
            pass
    return timezone.utc, 'UTC'

def resolve_user_timezone(uid):
    safe_uid = str(uid or '').strip()
    if not safe_uid or not db:
        return timezone.utc, 'UTC'
    try:
        progress_doc = get_study_progress_doc(safe_uid).get()
        progress_data = progress_doc.to_dict() if progress_doc.exists else {}
        return resolve_progress_timezone(progress_data)
    except Exception:
        return timezone.utc, 'UTC'

def to_timezone_now(base_now, tzinfo):
    base = base_now
    if base is None:
        return datetime.now(tzinfo)
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    return base.astimezone(tzinfo)

def card_state_entry_rank(entry):
    if not isinstance(entry, dict):
        return ('', 0, 0, 0, 0, '')
    return (
        sanitize_progress_date(entry.get('last_review_date', '')),
        sanitize_int(entry.get('seen', 0), default=0, min_value=0, max_value=100000),
        sanitize_int(entry.get('correct', 0), default=0, min_value=0, max_value=100000),
        sanitize_int(entry.get('wrong', 0), default=0, min_value=0, max_value=100000),
        sanitize_int(entry.get('interval_days', 0), default=0, min_value=0, max_value=3650),
        sanitize_progress_date(entry.get('next_review_date', '')),
    )

def merge_card_state_entries(server_entry, incoming_entry):
    cleaned_server = sanitize_card_state_entry(server_entry)
    cleaned_incoming = sanitize_card_state_entry(incoming_entry)

    if cleaned_server is None:
        return cleaned_incoming
    if cleaned_incoming is None:
        return cleaned_server

    server_last = sanitize_progress_date(cleaned_server.get('last_review_date', ''))
    incoming_last = sanitize_progress_date(cleaned_incoming.get('last_review_date', ''))
    merged_last = max(server_last, incoming_last)

    if merged_last == server_last and merged_last != incoming_last:
        source_for_schedule = cleaned_server
    elif merged_last == incoming_last and merged_last != server_last:
        source_for_schedule = cleaned_incoming
    else:
        source_for_schedule = cleaned_server if card_state_entry_rank(cleaned_server) >= card_state_entry_rank(cleaned_incoming) else cleaned_incoming

    merged_seen = max(cleaned_server.get('seen', 0), cleaned_incoming.get('seen', 0))
    merged_correct = max(cleaned_server.get('correct', 0), cleaned_incoming.get('correct', 0))
    merged_wrong = max(cleaned_server.get('wrong', 0), cleaned_incoming.get('wrong', 0))
    minimum_seen = merged_correct + merged_wrong
    if merged_seen < minimum_seen:
        merged_seen = minimum_seen

    merged_interval_days = sanitize_int(source_for_schedule.get('interval_days', 0), default=0, min_value=0, max_value=3650)
    merged_next_review_date = sanitize_progress_date(source_for_schedule.get('next_review_date', ''))
    if not merged_next_review_date:
        merged_next_review_date = max(
            sanitize_progress_date(cleaned_server.get('next_review_date', '')),
            sanitize_progress_date(cleaned_incoming.get('next_review_date', '')),
        )

    merged_difficulty = str(source_for_schedule.get('difficulty', 'medium')).strip().lower()
    if merged_difficulty not in {'easy', 'medium', 'hard'}:
        merged_difficulty = 'medium'

    merged_entry = {
        'seen': merged_seen,
        'correct': merged_correct,
        'wrong': merged_wrong,
        'interval_days': merged_interval_days,
        'last_review_date': merged_last,
        'next_review_date': merged_next_review_date,
        'difficulty': merged_difficulty,
        'level': derive_card_level_from_stats(merged_seen, merged_interval_days),
    }
    return sanitize_card_state_entry(merged_entry)

def merge_card_state_maps(server_state, incoming_state):
    cleaned_server = sanitize_card_state_map(server_state)
    cleaned_incoming = sanitize_card_state_map(incoming_state)
    merged = {}
    for card_id in sorted(set(cleaned_server.keys()) | set(cleaned_incoming.keys())):
        merged_entry = merge_card_state_entries(cleaned_server.get(card_id), cleaned_incoming.get(card_id))
        if merged_entry is None:
            continue
        merged[card_id] = merged_entry
        if len(merged) >= MAX_PROGRESS_CARDS_PER_PACK:
            break
    return merged

def count_due_cards_in_state(state, today_local):
    due = 0
    for card_id, entry in (state or {}).items():
        if not str(card_id).startswith('fc_'):
            continue
        seen = sanitize_int((entry or {}).get('seen', 0), default=0, min_value=0, max_value=100000)
        if seen <= 0:
            continue
        next_date = str((entry or {}).get('next_review_date', '') or '').strip()
        if not next_date or next_date <= today_local:
            due += 1
    return due

def compute_study_progress_summary(progress_data, card_state_maps, base_now=None):
    progress = progress_data or {}
    streak_data = sanitize_streak_data(progress.get('streak_data', {}))
    daily_goal = sanitize_daily_goal_value(progress.get('daily_goal'))
    if daily_goal is None:
        daily_goal = 20

    tzinfo, _timezone_name = resolve_progress_timezone(progress)
    now_local = to_timezone_now(base_now, tzinfo)
    today_local = now_local.strftime('%Y-%m-%d')
    yesterday_local = (now_local - timedelta(days=1)).strftime('%Y-%m-%d')

    current_streak = 0
    if streak_data.get('last_study_date') in {today_local, yesterday_local}:
        current_streak = sanitize_int(streak_data.get('current_streak', 0), default=0, min_value=0, max_value=36500)

    today_progress = 0
    if streak_data.get('daily_progress_date') == today_local:
        today_progress = sanitize_int(streak_data.get('daily_progress_count', 0), default=0, min_value=0, max_value=100000)

    due_today = 0
    for raw_state in (card_state_maps or []):
        due_today += count_due_cards_in_state(sanitize_card_state_map(raw_state), today_local)

    return {
        'daily_goal': daily_goal,
        'current_streak': current_streak,
        'today_progress': today_progress,
        'due_today': due_today,
    }

def get_study_progress_doc(uid):
    return db.collection('study_progress').document(uid)

def get_study_card_state_doc(uid, pack_id):
    safe_pack_id = str(pack_id or '').replace('/', '_')
    return db.collection('study_card_states').document(f"{uid}__{safe_pack_id}")

def generate_study_materials(source_text, flashcard_selection, question_selection, study_features='both', output_language='English'):
    if study_features == 'none':
        return [], [], None
    flashcard_amount, question_amount = resolve_study_amounts(flashcard_selection, question_selection, source_text)
    if study_features == 'flashcards':
        question_amount = 0
    elif study_features == 'test':
        flashcard_amount = 0
    MAX_SOURCE_TEXT_LEN = 120000
    was_truncated = len(source_text) > MAX_SOURCE_TEXT_LEN
    prompt = PROMPT_STUDY_TEMPLATE.format(
        flashcard_amount=flashcard_amount,
        question_amount=question_amount,
        output_language=output_language,
        source_text=source_text[:MAX_SOURCE_TEXT_LEN],
    )
    try:
        response = client.models.generate_content(
            model=MODEL_STUDY,
            contents=[types.Content(role='user', parts=[types.Part.from_text(text=prompt)])],
            config=types.GenerateContentConfig(max_output_tokens=32768)
        )
        parsed = extract_json_payload(response.text)
        if not isinstance(parsed, dict):
            return [], [], 'Study materials JSON parsing failed.'
        flashcards = sanitize_flashcards(parsed.get('flashcards', []), flashcard_amount)
        test_questions = sanitize_questions(parsed.get('test_questions', []), question_amount)
        if not flashcards and not test_questions and study_features != 'none':
            return [], [], 'Study materials were empty after validation.'
        error_msg = None
        if was_truncated:
            error_msg = 'Note: source text was very long and was truncated before study material generation.'
        return flashcards, test_questions, error_msg
    except Exception as e:
        return [], [], f'Study materials generation failed: {e}'

def generate_interview_enhancements(transcript_text, selected_features, output_language='English'):
    summary_text = None
    sectioned_text = None
    errors = []
    for feature in selected_features:
        try:
            if feature == 'summary':
                prompt = PROMPT_INTERVIEW_SUMMARY.format(transcript=transcript_text[:120000], output_language=output_language)
                response = generate_with_optional_thinking(MODEL_STUDY, prompt, max_output_tokens=8192, thinking_budget=384)
                summary_text = (response.text or '').strip()
                if not summary_text:
                    errors.append('Summary generation returned empty output.')
            elif feature == 'sections':
                prompt = PROMPT_INTERVIEW_SECTIONED.format(transcript=transcript_text[:120000], output_language=output_language)
                response = generate_with_optional_thinking(MODEL_STUDY, prompt, max_output_tokens=32768, thinking_budget=384)
                sectioned_text = (response.text or '').strip()
                if not sectioned_text:
                    errors.append('Sectioned transcript generation returned empty output.')
        except Exception as e:
            errors.append(f"{feature} generation failed: {e}")

    successful = []
    if summary_text:
        successful.append('summary')
    if sectioned_text:
        successful.append('sections')

    combined_text = None
    if summary_text and sectioned_text:
        combined_text = f"# Interview Summary\n\n{summary_text}\n\n# Structured Interview Transcript\n\n{sectioned_text}"

    failed_count = max(0, len(selected_features) - len(successful))
    return {
        'summary': summary_text,
        'sections': sectioned_text,
        'combined': combined_text,
        'successful_features': successful,
        'failed_count': failed_count,
        'error': '; '.join(errors) if errors else None,
    }

def allowed_file(filename, allowed_extensions):
    return file_service.allowed_file(filename, allowed_extensions)

def file_has_pdf_signature(path):
    return file_service.file_has_pdf_signature(path)

def file_has_pptx_signature(path):
    return file_service.file_has_pptx_signature(path)

def get_soffice_binary():
    return file_service.get_soffice_binary(env_getter=os.getenv, which_func=shutil.which)

def convert_pptx_to_pdf(source_path, target_pdf_path):
    return file_service.convert_pptx_to_pdf(
        source_path,
        target_pdf_path,
        soffice_binary_getter=get_soffice_binary,
        subprocess_module=subprocess,
    )

def resolve_uploaded_slides_to_pdf(uploaded_file, job_id):
    return file_service.resolve_uploaded_slides_to_pdf(
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
    return file_service.file_looks_like_audio(
        path,
        ffprobe_binary_getter=get_ffprobe_binary,
        subprocess_module=subprocess,
    )

def get_saved_file_size(path):
    return file_service.get_saved_file_size(path)

def get_mime_type(filename):
    return file_service.get_mime_type(filename)

def wait_for_file_processing(uploaded_file):
    max_wait_time = 300
    wait_interval = 5
    total_waited = 0
    while total_waited < max_wait_time:
        file_info = client.files.get(name=uploaded_file.name)
        if file_info.state.name == 'ACTIVE': return True
        elif file_info.state.name == 'FAILED': raise Exception(f"File processing failed: {uploaded_file.name}")
        time.sleep(wait_interval)
        total_waited += wait_interval
    raise Exception(f"File processing timed out after {max_wait_time} seconds")

def cleanup_files(local_paths, gemini_files):
    for path in local_paths:
        try:
            if os.path.exists(path): os.remove(path)
        except Exception as e: print(f"Warning: Could not delete local file {path}: {e}")
    for gemini_file in gemini_files:
        try:
            client.files.delete(name=gemini_file.name)
        except Exception as e: print(f"Warning: Could not delete Gemini file {gemini_file.name}: {e}")

def parse_audio_markers_from_notes(notes_markdown):
    if not notes_markdown:
        return []
    pattern = re.compile(r'#{1,3}\s+(.+?)\s*\n\s*<!--\s*audio:(\d+)-(\d+)\s*-->', re.MULTILINE)
    notes_audio_map = []
    section_index = 0
    for match in pattern.finditer(notes_markdown):
        try:
            start_ms = int(match.group(2))
            end_ms = int(match.group(3))
        except Exception:
            continue
        notes_audio_map.append({
            'section_index': section_index,
            'section_title': match.group(1).strip(),
            'start_ms': max(0, start_ms),
            'end_ms': max(start_ms, end_ms),
        })
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
        lines.append(f"[{start_ms}-{end_ms}] {text}")
    return '\n'.join(lines)

def transcribe_audio_plain(audio_file, audio_mime_type, output_language='English'):
    output_language = OUTPUT_LANGUAGE_MAP.get(str(output_language).lower(), str(output_language))
    prompt = PROMPT_AUDIO_TRANSCRIPTION.format(output_language=output_language)
    response = client.models.generate_content(
        model=MODEL_AUDIO,
        contents=[types.Content(role='user', parts=[
            types.Part.from_uri(file_uri=audio_file.uri, mime_type=audio_mime_type),
            types.Part.from_text(text=prompt)
        ])],
        config=types.GenerateContentConfig(max_output_tokens=65536)
    )
    return (getattr(response, 'text', '') or '').strip()

def transcribe_audio_with_timestamps(audio_file, audio_mime_type, output_language='English'):
    output_language = OUTPUT_LANGUAGE_MAP.get(str(output_language).lower(), str(output_language))
    prompt = PROMPT_AUDIO_TRANSCRIPTION_TIMESTAMPED.format(output_language=output_language)
    try:
        response = client.models.generate_content(
            model=MODEL_AUDIO,
            contents=[types.Content(role='user', parts=[
                types.Part.from_uri(file_uri=audio_file.uri, mime_type=audio_mime_type),
                types.Part.from_text(text=prompt)
            ])],
            config=types.GenerateContentConfig(max_output_tokens=65536)
        )
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
                clean_segments.append({
                    'start_ms': max(0, start_ms),
                    'end_ms': max(start_ms, end_ms),
                    'text': text,
                })
        if not full_transcript and clean_segments:
            full_transcript = '\n'.join([s['text'] for s in clean_segments]).strip()
        if not full_transcript:
            raise ValueError('Empty transcript')
        return full_transcript, clean_segments
    except Exception as e:
        logger.info(f"⚠️ Timestamp transcription failed, falling back to plain transcript: {e}")
        fallback_prompt = PROMPT_AUDIO_TRANSCRIPTION.format(output_language=output_language)
        fallback_response = client.models.generate_content(
            model=MODEL_AUDIO,
            contents=[types.Content(role='user', parts=[
                types.Part.from_uri(file_uri=audio_file.uri, mime_type=audio_mime_type),
                types.Part.from_text(text=fallback_prompt)
            ])],
            config=types.GenerateContentConfig(max_output_tokens=65536)
        )
        return (getattr(fallback_response, 'text', '') or '').strip(), []

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


def infer_audio_storage_key_from_legacy_path(raw_path):
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
    return infer_audio_storage_key_from_legacy_path(pack.get('audio_storage_path', ''))


def get_audio_storage_path_from_pack(pack):
    key = get_audio_storage_key_from_pack(pack)
    if key:
        return resolve_audio_storage_path_from_key(key)
    return ''


def ensure_pack_audio_storage_key(pack_ref, pack):
    key = get_audio_storage_key_from_pack(pack)
    if key and not normalize_audio_storage_key(pack.get('audio_storage_key', '')):
        try:
            pack_ref.set({
                'audio_storage_key': key,
                'has_audio_playback': True,
                'updated_at': time.time(),
            }, merge=True)
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
    target_key = normalize_audio_storage_key(f"{STUDY_AUDIO_RELATIVE_DIR}/{job_id}{ext}")
    target_path = resolve_audio_storage_path_from_key(target_key)
    if not target_path:
        return ''
    try:
        shutil.copy2(audio_source_path, target_path)
        return target_key
    except Exception as e:
        logger.info(f"⚠️ Could not persist audio for study pack {job_id}: {e}")
        return ''

def markdown_to_docx(markdown_text, title="Document"):
    doc = Document()
    style = doc.styles['Normal']
    style.font.name = 'Calibri'
    style.font.size = Pt(11)
    lines = markdown_text.split('\n')
    i = 0
    is_transcript = any(len(line.strip()) > 3 and line.strip()[0].isdigit() and ':' in line.strip()[:6] and ' - ' in line for line in lines[:20])

    def add_inline_markdown_runs(paragraph, text):
        raw = str(text or '')
        # Supports inline emphasis markers used in generated output.
        parts = re.split(r'(\*\*.+?\*\*|__.+?__|\*.+?\*|_.+?_)', raw)
        for part in parts:
            if not part:
                continue
            if (part.startswith('**') and part.endswith('**') and len(part) >= 4) or (part.startswith('__') and part.endswith('__') and len(part) >= 4):
                run = paragraph.add_run(part[2:-2])
                run.bold = True
                continue
            if (part.startswith('*') and part.endswith('*') and len(part) >= 3) or (part.startswith('_') and part.endswith('_') and len(part) >= 3):
                run = paragraph.add_run(part[1:-1])
                run.italic = True
                continue
            paragraph.add_run(part.replace('**', '').replace('__', ''))
    
    while i < len(lines):
        line = lines[i].strip()
        numbered_match = re.match(r'^\d+\.\s+(.*)$', line)
        if not line:
            i += 1
            continue
        if line.startswith('### '): doc.add_heading(line[4:], level=3)
        elif line.startswith('## '): doc.add_heading(line[3:], level=2)
        elif line.startswith('# '): doc.add_heading(line[2:], level=1)
        elif line.startswith('- ') or line.startswith('* '):
            p = doc.add_paragraph(style='List Bullet')
            add_inline_markdown_runs(p, line[2:])
        elif numbered_match:
            p = doc.add_paragraph(style='List Number')
            add_inline_markdown_runs(p, numbered_match.group(1))
        elif is_transcript and len(line) > 3 and line[0].isdigit() and ':' in line[:6]:
            p = doc.add_paragraph()
            add_inline_markdown_runs(p, line)
        else:
            paragraph_lines = [line]
            while i + 1 < len(lines):
                next_line = lines[i + 1].strip()
                if (
                    next_line
                    and not next_line.startswith('#')
                    and not next_line.startswith('- ')
                    and not next_line.startswith('* ')
                    and not re.match(r'^\d+\.\s+', next_line)
                ):
                    paragraph_lines.append(next_line)
                    i += 1
                else:
                    break
            paragraph_text = ' '.join(paragraph_lines)
            p = doc.add_paragraph()
            add_inline_markdown_runs(p, paragraph_text)
        i += 1
    return doc

def normalize_exam_date(raw_value):
    exam_date = str(raw_value or '').strip()
    if not exam_date:
        return ''
    try:
        return datetime.strptime(exam_date, '%Y-%m-%d').strftime('%Y-%m-%d')
    except ValueError:
        raise ValueError('Exam date must use YYYY-MM-DD format')

def markdown_inline_to_pdf_html(text):
    safe_text = html.escape(str(text or ''))
    safe_text = re.sub(r'\*\*(.+?)\*\*', r'<b>\1</b>', safe_text)
    safe_text = re.sub(r'\*(.+?)\*', r'<i>\1</i>', safe_text)
    return safe_text

def append_notes_markdown_to_story(story, notes_markdown, styles):
    lines = str(notes_markdown or '').splitlines()
    bullet_items = []

    def flush_bullets():
        nonlocal bullet_items
        if not bullet_items:
            return
        list_flow = ListFlowable(
            [ListItem(Paragraph(item, styles['pdfBody']), leftIndent=6) for item in bullet_items],
            bulletType='bullet',
            leftIndent=14,
            bulletFontSize=8,
            bulletOffsetY=1
        )
        story.append(list_flow)
        story.append(Spacer(1, 4))
        bullet_items = []

    for raw_line in lines:
        line = raw_line.strip()
        if not line:
            flush_bullets()
            story.append(Spacer(1, 4))
            continue

        heading_level = 0
        if line.startswith('### '):
            heading_level = 3
        elif line.startswith('## '):
            heading_level = 2
        elif line.startswith('# '):
            heading_level = 1

        if heading_level:
            flush_bullets()
            heading_text = markdown_inline_to_pdf_html(line[heading_level + 1:])
            heading_style = styles['pdfH1'] if heading_level == 1 else styles['pdfH2'] if heading_level == 2 else styles['pdfH3']
            story.append(Paragraph(heading_text, heading_style))
            story.append(Spacer(1, 3))
            continue

        if line.startswith('- ') or line.startswith('* '):
            bullet_items.append(markdown_inline_to_pdf_html(line[2:].strip()))
            continue

        numbered_match = re.match(r'^(\d+)\.\s+(.*)$', line)
        if numbered_match:
            flush_bullets()
            text_html = markdown_inline_to_pdf_html(numbered_match.group(2))
            story.append(Paragraph(f"{numbered_match.group(1)}. {text_html}", styles['pdfBody']))
            story.append(Spacer(1, 2))
            continue

        flush_bullets()
        story.append(Paragraph(markdown_inline_to_pdf_html(line), styles['pdfBody']))
        story.append(Spacer(1, 2))

    flush_bullets()

def build_study_pack_pdf(pack, include_answers=True):
    if not REPORTLAB_AVAILABLE:
        raise RuntimeError(
            "PDF export requires the optional 'reportlab' dependency. "
            "Install it with: pip install reportlab==4.2.5"
        )

    pdf_buffer = io.BytesIO()
    doc = SimpleDocTemplate(
        pdf_buffer,
        pagesize=A4,
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
        title=str(pack.get('title', 'Study Pack')).strip() or 'Study Pack'
    )

    base_styles = getSampleStyleSheet()
    styles = {
        'pdfTitle': ParagraphStyle(
            'PdfTitle',
            parent=base_styles['Heading1'],
            fontName='Helvetica-Bold',
            fontSize=17,
            leading=21,
            spaceAfter=6,
            textColor=colors.HexColor('#111827')
        ),
        'pdfMeta': ParagraphStyle(
            'PdfMeta',
            parent=base_styles['BodyText'],
            fontName='Helvetica',
            fontSize=9.5,
            leading=12.5,
            textColor=colors.HexColor('#4B5563')
        ),
        'pdfSection': ParagraphStyle(
            'PdfSection',
            parent=base_styles['Heading2'],
            fontName='Helvetica-Bold',
            fontSize=12.5,
            leading=16,
            spaceBefore=6,
            spaceAfter=6,
            textColor=colors.HexColor('#111827')
        ),
        'pdfH1': ParagraphStyle(
            'PdfH1',
            parent=base_styles['Heading2'],
            fontName='Helvetica-Bold',
            fontSize=12,
            leading=15,
            textColor=colors.HexColor('#1F2937')
        ),
        'pdfH2': ParagraphStyle(
            'PdfH2',
            parent=base_styles['Heading3'],
            fontName='Helvetica-Bold',
            fontSize=11,
            leading=14,
            textColor=colors.HexColor('#1F2937')
        ),
        'pdfH3': ParagraphStyle(
            'PdfH3',
            parent=base_styles['Heading4'],
            fontName='Helvetica-Bold',
            fontSize=10,
            leading=13,
            textColor=colors.HexColor('#374151')
        ),
        'pdfBody': ParagraphStyle(
            'PdfBody',
            parent=base_styles['BodyText'],
            fontName='Helvetica',
            fontSize=9.5,
            leading=13,
            textColor=colors.HexColor('#111827')
        ),
        'pdfQuestion': ParagraphStyle(
            'PdfQuestion',
            parent=base_styles['BodyText'],
            fontName='Helvetica-Bold',
            fontSize=10,
            leading=13.5,
            textColor=colors.HexColor('#111827')
        ),
        'pdfOption': ParagraphStyle(
            'PdfOption',
            parent=base_styles['BodyText'],
            fontName='Helvetica',
            fontSize=9.5,
            leading=12.5,
            leftIndent=10,
            textColor=colors.HexColor('#1F2937')
        ),
        'pdfOptionCorrect': ParagraphStyle(
            'PdfOptionCorrect',
            parent=base_styles['BodyText'],
            fontName='Helvetica-Bold',
            fontSize=9.5,
            leading=12.5,
            leftIndent=10,
            textColor=colors.HexColor('#065F46')
        ),
    }

    pack_title = str(pack.get('title', 'Study Pack')).strip() or 'Study Pack'
    story = [Paragraph(markdown_inline_to_pdf_html(pack_title), styles['pdfTitle'])]

    mode = str(pack.get('mode', '') or '').strip() or 'Unknown'
    output_language = str(pack.get('output_language', '') or '').strip() or 'Unknown'
    course = str(pack.get('course', '') or '').strip() or '-'
    subject = str(pack.get('subject', '') or '').strip() or '-'
    semester = str(pack.get('semester', '') or '').strip() or '-'
    block = str(pack.get('block', '') or '').strip() or '-'
    created_at = pack.get('created_at', 0)
    created_text = '-'
    try:
        if created_at:
            created_text = datetime.fromtimestamp(float(created_at)).strftime('%Y-%m-%d %H:%M')
    except Exception:
        created_text = '-'

    metadata_rows = [
        [Paragraph('<b>Mode</b>', styles['pdfMeta']), Paragraph(markdown_inline_to_pdf_html(mode), styles['pdfMeta'])],
        [Paragraph('<b>Language</b>', styles['pdfMeta']), Paragraph(markdown_inline_to_pdf_html(output_language), styles['pdfMeta'])],
        [Paragraph('<b>Course</b>', styles['pdfMeta']), Paragraph(markdown_inline_to_pdf_html(course), styles['pdfMeta'])],
        [Paragraph('<b>Subject</b>', styles['pdfMeta']), Paragraph(markdown_inline_to_pdf_html(subject), styles['pdfMeta'])],
        [Paragraph('<b>Semester / Block</b>', styles['pdfMeta']), Paragraph(markdown_inline_to_pdf_html(f"{semester} / {block}"), styles['pdfMeta'])],
        [Paragraph('<b>Created</b>', styles['pdfMeta']), Paragraph(markdown_inline_to_pdf_html(created_text), styles['pdfMeta'])],
    ]
    metadata_table = Table(metadata_rows, colWidths=[36 * mm, 145 * mm], hAlign='LEFT')
    metadata_table.setStyle(TableStyle([
        ('VALIGN', (0, 0), (-1, -1), 'TOP'),
        ('LEFTPADDING', (0, 0), (-1, -1), 4),
        ('RIGHTPADDING', (0, 0), (-1, -1), 4),
        ('TOPPADDING', (0, 0), (-1, -1), 2),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2),
        ('GRID', (0, 0), (-1, -1), 0.35, colors.HexColor('#E5E7EB')),
        ('BACKGROUND', (0, 0), (0, -1), colors.HexColor('#F9FAFB')),
    ]))
    story.append(metadata_table)
    story.append(Spacer(1, 10))

    story.append(Paragraph('Integrated Notes', styles['pdfSection']))
    notes_markdown = str(pack.get('notes_markdown', '') or '').strip()
    if notes_markdown:
        append_notes_markdown_to_story(story, notes_markdown, styles)
    else:
        story.append(Paragraph('No integrated notes available.', styles['pdfBody']))
    story.append(Spacer(1, 10))

    story.append(Paragraph('Flashcards', styles['pdfSection']))
    flashcards = pack.get('flashcards', []) if isinstance(pack.get('flashcards', []), list) else []
    if flashcards:
        card_rows = [[Paragraph('<b>Front</b>', styles['pdfMeta']), Paragraph('<b>Back</b>', styles['pdfMeta'])]]
        for card in flashcards:
            card_rows.append([
                Paragraph(markdown_inline_to_pdf_html(str(card.get('front', '') or '')), styles['pdfBody']),
                Paragraph(markdown_inline_to_pdf_html(str(card.get('back', '') or '')), styles['pdfBody']),
            ])
        flashcard_table = Table(card_rows, colWidths=[84 * mm, 97 * mm], repeatRows=1, hAlign='LEFT')
        flashcard_table.setStyle(TableStyle([
            ('GRID', (0, 0), (-1, -1), 0.35, colors.HexColor('#D1D5DB')),
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#F3F4F6')),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
        ]))
        story.append(flashcard_table)
    else:
        story.append(Paragraph('No flashcards available.', styles['pdfBody']))

    story.append(PageBreak())
    practice_title = 'Practice Questions'
    if not include_answers:
        practice_title += ' (Without Answers)'
    story.append(Paragraph(practice_title, styles['pdfSection']))
    questions = pack.get('test_questions', []) if isinstance(pack.get('test_questions', []), list) else []
    if questions:
        for idx, question in enumerate(questions, 1):
            question_text = str(question.get('question', '') or '').strip() or f'Question {idx}'
            story.append(Paragraph(f"{idx}. {markdown_inline_to_pdf_html(question_text)}", styles['pdfQuestion']))

            options = question.get('options', [])
            if not isinstance(options, list):
                options = []
            answer = str(question.get('answer', '') or '').strip()
            letters = ['A', 'B', 'C', 'D']
            for option_idx, option in enumerate(options[:4]):
                option_text = str(option or '').strip()
                is_correct = include_answers and option_text == answer and option_text != ''
                marker = '✓' if is_correct else '•'
                letter = letters[option_idx] if option_idx < len(letters) else str(option_idx + 1)
                option_style = styles['pdfOptionCorrect'] if is_correct else styles['pdfOption']
                story.append(Paragraph(f"{marker} {letter}. {markdown_inline_to_pdf_html(option_text)}", option_style))

            explanation = str(question.get('explanation', '') or '').strip()
            if include_answers and explanation:
                story.append(Paragraph(f"<b>Explanation:</b> {markdown_inline_to_pdf_html(explanation)}", styles['pdfBody']))
            story.append(Spacer(1, 7))
    else:
        story.append(Paragraph('No practice questions available.', styles['pdfBody']))

    doc.build(story)
    pdf_buffer.seek(0)
    return pdf_buffer

def save_study_pack(job_id, job_data):
    try:
        notes_markdown = str(job_data.get('result', '') or '')
        max_notes_chars = 180000
        notes_truncated = len(notes_markdown) > max_notes_chars
        if notes_truncated:
            notes_markdown = notes_markdown[:max_notes_chars]

        doc_ref = db.collection('study_packs').document()
        now_ts = time.time()
        tzinfo, timezone_name = resolve_user_timezone(job_data.get('user_id', ''))
        local_title_time = datetime.fromtimestamp(now_ts, tz=timezone.utc).astimezone(tzinfo)
        doc_ref.set({
            'study_pack_id': doc_ref.id,
            'source_job_id': job_id,
            'uid': job_data.get('user_id', ''),
            'mode': job_data.get('mode', ''),
            'title': f"{job_data.get('mode', 'study-pack')} {local_title_time.strftime('%Y-%m-%d %H:%M')}",
            'title_timezone': timezone_name,
            'output_language': job_data.get('output_language', 'English'),
            'notes_markdown': notes_markdown,
            'notes_truncated': notes_truncated,
            'transcript_segments': job_data.get('transcript_segments', []),
            'notes_audio_map': job_data.get('notes_audio_map', []),
            'audio_storage_key': normalize_audio_storage_key(job_data.get('audio_storage_key', '')),
            'has_audio_sync': FEATURE_AUDIO_SECTION_SYNC and bool(job_data.get('audio_storage_key')) and bool(job_data.get('notes_audio_map', [])),
            'has_audio_playback': bool(job_data.get('audio_storage_key')),
            'flashcards': job_data.get('flashcards', []),
            'test_questions': job_data.get('test_questions', []),
            'flashcard_selection': job_data.get('flashcard_selection', '20'),
            'question_selection': job_data.get('question_selection', '10'),
            'study_features': job_data.get('study_features', 'none'),
            'interview_features': job_data.get('interview_features', []),
            'interview_summary': job_data.get('interview_summary'),
            'interview_sections': job_data.get('interview_sections'),
            'interview_combined': job_data.get('interview_combined'),
            'study_generation_error': job_data.get('study_generation_error'),
            'course': '',
            'subject': '',
            'semester': '',
            'block': '',
            'folder_id': '',
            'folder_name': '',
            'created_at': now_ts,
            'updated_at': now_ts,
        })
        job_data['study_pack_id'] = doc_ref.id
    except Exception as e:
        logger.info(f"❌ Failed to save study pack for job {job_id}: {e}")

# =============================================
# AI PROCESSING FUNCTIONS
# =============================================

def process_lecture_notes(job_id, pdf_path, audio_path):
    gemini_files = []
    local_paths = [pdf_path, audio_path]
    try:
        jobs[job_id]['status'] = 'processing'
        jobs[job_id]['step'] = 1
        jobs[job_id]['step_description'] = 'Extracting text from slides...'
        pdf_file = client.files.upload(file=pdf_path, config={'mime_type': 'application/pdf'})
        gemini_files.append(pdf_file)
        wait_for_file_processing(pdf_file)
        response = client.models.generate_content(model=MODEL_SLIDES, contents=[types.Content(role='user', parts=[types.Part.from_uri(file_uri=pdf_file.uri, mime_type='application/pdf'), types.Part.from_text(text=PROMPT_SLIDE_EXTRACTION)])], config=types.GenerateContentConfig(max_output_tokens=65536))
        slide_text = response.text
        jobs[job_id]['slide_text'] = slide_text
        
        jobs[job_id]['step'] = 2
        jobs[job_id]['step_description'] = 'Transcribing audio...'
        output_language = jobs[job_id].get('output_language', 'English')
        converted_audio_path, converted = convert_audio_to_mp3_with_ytdlp(audio_path)
        if converted and converted_audio_path not in local_paths:
            local_paths.append(converted_audio_path)
        jobs[job_id]['step_description'] = 'Optimizing audio for faster processing...'
        audio_mime_type = get_mime_type(converted_audio_path)
        audio_file = client.files.upload(file=converted_audio_path, config={'mime_type': audio_mime_type})
        gemini_files.append(audio_file)
        jobs[job_id]['step_description'] = 'Processing audio file (this may take a few minutes)...'
        wait_for_file_processing(audio_file)
        jobs[job_id]['step_description'] = 'Generating transcript...'
        if FEATURE_AUDIO_SECTION_SYNC:
            transcript, transcript_segments = transcribe_audio_with_timestamps(audio_file, audio_mime_type, output_language)
        else:
            transcript = transcribe_audio_plain(audio_file, audio_mime_type, output_language)
            transcript_segments = []
        jobs[job_id]['transcript'] = transcript
        jobs[job_id]['transcript_segments'] = transcript_segments
        jobs[job_id]['audio_storage_key'] = persist_audio_for_study_pack(job_id, converted_audio_path)
        
        jobs[job_id]['step'] = 3
        jobs[job_id]['step_description'] = 'Creating complete lecture notes...'
        merge_transcript = format_transcript_with_timestamps(transcript_segments) if transcript_segments else transcript
        if FEATURE_AUDIO_SECTION_SYNC and transcript_segments:
            merge_prompt = PROMPT_MERGE_WITH_AUDIO_MARKERS.format(slide_text=slide_text, transcript=merge_transcript, output_language=output_language)
        else:
            merge_prompt = PROMPT_MERGE_TEMPLATE.format(slide_text=slide_text, transcript=transcript, output_language=output_language)
        response = client.models.generate_content(model=MODEL_INTEGRATION, contents=[types.Content(role='user', parts=[types.Part.from_text(text=merge_prompt)])], config=types.GenerateContentConfig(max_output_tokens=65536))
        merged_notes = response.text
        jobs[job_id]['result'] = merged_notes
        jobs[job_id]['notes_audio_map'] = parse_audio_markers_from_notes(merged_notes) if FEATURE_AUDIO_SECTION_SYNC else []

        if jobs[job_id].get('study_features', 'none') != 'none':
            jobs[job_id]['step'] = 4
            jobs[job_id]['step_description'] = 'Generating flashcards and practice test...'
            flashcards, test_questions, study_error = generate_study_materials(
                merged_notes,
                jobs[job_id].get('flashcard_selection', '20'),
                jobs[job_id].get('question_selection', '10'),
                jobs[job_id].get('study_features', 'none'),
                output_language
            )
            jobs[job_id]['flashcards'] = flashcards
            jobs[job_id]['test_questions'] = test_questions
            jobs[job_id]['study_generation_error'] = study_error
        else:
            jobs[job_id]['flashcards'] = []
            jobs[job_id]['test_questions'] = []
            jobs[job_id]['study_generation_error'] = None
        save_study_pack(job_id, jobs[job_id])

        jobs[job_id]['status'] = 'complete'
        jobs[job_id]['step'] = jobs[job_id].get('total_steps', 3)
        jobs[job_id]['step_description'] = 'Complete!'
    except Exception as e:
        jobs[job_id]['status'] = 'error'
        jobs[job_id]['error'] = str(e)
        # Refund the credit since processing failed
        uid = jobs[job_id].get('user_id')
        credit_type = jobs[job_id].get('credit_deducted')
        refund_credit(uid, credit_type)
        add_job_credit_refund(jobs[job_id], credit_type, 1)
        jobs[job_id]['credit_refunded'] = True
    finally:
        cleanup_files(local_paths, gemini_files)
        # Log the job to Firestore and record finished_at for cleanup thread
        jobs[job_id]['finished_at'] = time.time()
        save_job_log(job_id, jobs[job_id], jobs[job_id]['finished_at'])

def process_slides_only(job_id, pdf_path):
    gemini_files = []
    local_paths = [pdf_path]
    try:
        jobs[job_id]['status'] = 'processing'
        jobs[job_id]['step'] = 1
        jobs[job_id]['step_description'] = 'Extracting text from slides...'
        pdf_file = client.files.upload(file=pdf_path, config={'mime_type': 'application/pdf'})
        gemini_files.append(pdf_file)
        wait_for_file_processing(pdf_file)
        response = client.models.generate_content(model=MODEL_SLIDES, contents=[types.Content(role='user', parts=[types.Part.from_uri(file_uri=pdf_file.uri, mime_type='application/pdf'), types.Part.from_text(text=PROMPT_SLIDE_EXTRACTION)])], config=types.GenerateContentConfig(max_output_tokens=65536))
        extracted_text = response.text
        jobs[job_id]['result'] = extracted_text
        if jobs[job_id].get('study_features', 'none') != 'none':
            jobs[job_id]['step'] = 2
            jobs[job_id]['step_description'] = 'Generating flashcards and practice test...'
            flashcards, test_questions, study_error = generate_study_materials(
                extracted_text,
                jobs[job_id].get('flashcard_selection', '20'),
                jobs[job_id].get('question_selection', '10'),
                jobs[job_id].get('study_features', 'none'),
                jobs[job_id].get('output_language', 'English')
            )
            jobs[job_id]['flashcards'] = flashcards
            jobs[job_id]['test_questions'] = test_questions
            jobs[job_id]['study_generation_error'] = study_error
        else:
            jobs[job_id]['flashcards'] = []
            jobs[job_id]['test_questions'] = []
            jobs[job_id]['study_generation_error'] = None
        save_study_pack(job_id, jobs[job_id])
        jobs[job_id]['status'] = 'complete'
        jobs[job_id]['step'] = jobs[job_id].get('total_steps', 1)
        jobs[job_id]['step_description'] = 'Complete!'
    except Exception as e:
        jobs[job_id]['status'] = 'error'
        jobs[job_id]['error'] = str(e)
        # Refund the credit since processing failed
        uid = jobs[job_id].get('user_id')
        credit_type = jobs[job_id].get('credit_deducted')
        refund_credit(uid, credit_type)
        add_job_credit_refund(jobs[job_id], credit_type, 1)
        jobs[job_id]['credit_refunded'] = True
    finally:
        cleanup_files(local_paths, gemini_files)
        # Log the job to Firestore and record finished_at for cleanup thread
        jobs[job_id]['finished_at'] = time.time()
        save_job_log(job_id, jobs[job_id], jobs[job_id]['finished_at'])

def process_interview_transcription(job_id, audio_path):
    gemini_files = []
    local_paths = [audio_path]
    try:
        jobs[job_id]['status'] = 'processing'
        jobs[job_id]['step'] = 1
        jobs[job_id]['step_description'] = 'Optimizing audio for faster processing...'
        output_language = jobs[job_id].get('output_language', 'English')
        converted_audio_path, converted = convert_audio_to_mp3_with_ytdlp(audio_path)
        if converted and converted_audio_path not in local_paths:
            local_paths.append(converted_audio_path)
        jobs[job_id]['audio_storage_key'] = persist_audio_for_study_pack(job_id, converted_audio_path)
        audio_mime_type = get_mime_type(converted_audio_path)
        audio_file = client.files.upload(file=converted_audio_path, config={'mime_type': audio_mime_type})
        gemini_files.append(audio_file)
        jobs[job_id]['step_description'] = 'Processing audio file (this may take a few minutes)...'
        wait_for_file_processing(audio_file)
        jobs[job_id]['step_description'] = 'Generating transcript with timestamps...'
        interview_prompt = PROMPT_INTERVIEW_TRANSCRIPTION.format(output_language=output_language)
        response = client.models.generate_content(model=MODEL_INTERVIEW, contents=[types.Content(role='user', parts=[types.Part.from_uri(file_uri=audio_file.uri, mime_type=audio_mime_type), types.Part.from_text(text=interview_prompt)])], config=types.GenerateContentConfig(max_output_tokens=65536))
        transcript_text = response.text or ''
        jobs[job_id]['transcript'] = transcript_text
        jobs[job_id]['result'] = transcript_text

        selected_features = jobs[job_id].get('interview_features', [])
        if selected_features:
            jobs[job_id]['step'] = 2
            jobs[job_id]['step_description'] = 'Creating interview summary and sections...'
            enhancement = generate_interview_enhancements(transcript_text, selected_features, output_language)
            jobs[job_id]['interview_summary'] = enhancement.get('summary')
            jobs[job_id]['interview_sections'] = enhancement.get('sections')
            jobs[job_id]['interview_combined'] = enhancement.get('combined')
            jobs[job_id]['interview_features_successful'] = enhancement.get('successful_features', [])
            jobs[job_id]['study_generation_error'] = enhancement.get('error')

            failed_count = enhancement.get('failed_count', 0)
            if failed_count > 0:
                uid = jobs[job_id].get('user_id')
                refund_slides_credits(uid, failed_count)
                jobs[job_id]['extra_slides_refunded'] = jobs[job_id].get('extra_slides_refunded', 0) + failed_count
                add_job_credit_refund(jobs[job_id], 'slides_credits', failed_count)

            if enhancement.get('summary') and enhancement.get('sections'):
                jobs[job_id]['result'] = enhancement.get('combined', transcript_text)
            elif enhancement.get('summary'):
                jobs[job_id]['result'] = enhancement.get('summary')
            elif enhancement.get('sections'):
                jobs[job_id]['result'] = enhancement.get('sections')

        save_study_pack(job_id, jobs[job_id])
        jobs[job_id]['status'] = 'complete'
        jobs[job_id]['step'] = jobs[job_id].get('total_steps', 1)
        jobs[job_id]['step_description'] = 'Complete!'
    except Exception as e:
        jobs[job_id]['status'] = 'error'
        jobs[job_id]['error'] = str(e)
        # Refund the credit since processing failed
        uid = jobs[job_id].get('user_id')
        credit_type = jobs[job_id].get('credit_deducted')
        refund_credit(uid, credit_type)
        add_job_credit_refund(jobs[job_id], credit_type, 1)
        extra_spent = jobs[job_id].get('interview_features_cost', 0)
        already_refunded = jobs[job_id].get('extra_slides_refunded', 0)
        to_refund = max(0, extra_spent - already_refunded)
        if to_refund > 0:
            refund_slides_credits(uid, to_refund)
            jobs[job_id]['extra_slides_refunded'] = already_refunded + to_refund
            add_job_credit_refund(jobs[job_id], 'slides_credits', to_refund)
        jobs[job_id]['credit_refunded'] = True
    finally:
        cleanup_files(local_paths, gemini_files)
        # Log the job to Firestore and record finished_at for cleanup thread
        jobs[job_id]['finished_at'] = time.time()
        save_job_log(job_id, jobs[job_id], jobs[job_id]['finished_at'])

# =============================================
# ROUTES
# =============================================

@app.route('/')
def index():
    return render_template('landing.html')

@app.route('/dashboard')
def dashboard():
    return render_template(
        'index.html',
        sentry_frontend_dsn=SENTRY_FRONTEND_DSN,
        sentry_environment=SENTRY_ENVIRONMENT,
        sentry_release=SENTRY_RELEASE,
    )

@app.route('/plan')
@app.route('/stats')
def plan_dashboard():
    return render_template('plan.html')

@app.route('/calendar')
def calendar_dashboard():
    return render_template('calendar.html')

@app.route('/features')
def features_page():
    return render_template('features.html')

@app.route('/admin')
def admin_dashboard():
    return render_template('admin.html')

@app.route('/study')
def study_dashboard():
    return render_template('study.html')

@app.route('/privacy')
def privacy_policy():
    return render_template(
        'privacy.html',
        legal_contact_email=LEGAL_CONTACT_EMAIL,
        last_updated='February 26, 2026',
    )

@app.route('/terms')
def terms_of_service():
    return render_template(
        'terms.html',
        legal_contact_email=LEGAL_CONTACT_EMAIL,
        last_updated='February 26, 2026',
    )

@app.route('/api/verify-email', methods=['POST'])
def verify_email():
    # Rate limit by IP to prevent enumeration
    client_ip = request.remote_addr or 'unknown'
    allowed_rl, retry_after_rl = check_rate_limit(
        key=f"verify_email:{client_ip}",
        limit=20,
        window_seconds=60,
    )
    if not allowed_rl:
        return build_rate_limited_response('Too many verification requests. Please wait.', retry_after_rl)
    email = request.get_json().get('email', '')
    if is_email_allowed(email):
        return jsonify({'allowed': True})
    return jsonify({'allowed': False, 'message': 'Please use your university email or a major email provider (Gmail, Outlook, iCloud, Yahoo).'})

@app.route('/api/dev/sentry-test', methods=['POST'])
def dev_sentry_test():
    if not is_dev_environment():
        return jsonify({'error': 'Not found'}), 404
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    if not is_admin_user(decoded_token):
        return jsonify({'error': 'Forbidden'}), 403
    if not sentry_sdk or not SENTRY_BACKEND_DSN:
        return jsonify({'error': 'Sentry backend DSN is not configured'}), 400

    payload = request.get_json(silent=True) or {}
    note = str(payload.get('message', 'Manual backend Sentry test')).strip()[:120]
    try:
        raise RuntimeError(f"Sentry dev test trigger: {note}")
    except Exception as exc:
        event_id = sentry_sdk.capture_exception(exc)
        return jsonify({
            'ok': True,
            'event_id': event_id,
            'message': 'Sentry test event captured from backend',
        })

@app.route('/api/analytics/event', methods=['POST'])
@app.route('/api/lp-event', methods=['POST'])
def ingest_analytics_event():
    data = request.get_json(silent=True) or {}
    decoded_token = verify_firebase_token(request)
    uid = decoded_token.get('uid', '') if decoded_token else ''
    email = decoded_token.get('email', '') if decoded_token else ''
    session_id = sanitize_analytics_session_id(data.get('session_id', ''))
    if not session_id and uid:
        session_id = uid[:80]

    actor_token = uid or session_id or request.headers.get('X-Forwarded-For', request.remote_addr or '')
    actor_key = normalize_rate_limit_key_part(actor_token, fallback='anon')
    allowed_analytics, retry_after = check_rate_limit(
        key=f"analytics:{actor_key}",
        limit=ANALYTICS_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=ANALYTICS_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allowed_analytics:
        log_rate_limit_hit('analytics', retry_after)
        return build_rate_limited_response(
            'Too many analytics events from this client. Please retry shortly.',
            retry_after,
        )

    event_name = sanitize_analytics_event_name(data.get('event', ''))
    if not event_name:
        return jsonify({'error': 'Invalid event name'}), 400

    properties = sanitize_analytics_properties(data.get('properties', {}))
    properties['path'] = str(data.get('path', '') or '').strip()[:80]
    properties['page'] = str(data.get('page', '') or '').strip()[:40]

    ok = log_analytics_event(
        event_name,
        source='frontend',
        uid=uid,
        email=email,
        session_id=session_id,
        properties=properties,
    )
    if not ok:
        return jsonify({'error': 'Could not store event'}), 500
    return jsonify({'ok': True})

@app.route('/api/auth/user', methods=['GET'])
def get_user():
    decoded_token = verify_firebase_token(request)
    if not decoded_token: return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not is_email_allowed(email): return jsonify({'error': 'Email not allowed', 'message': 'Please use your university email.'}), 403
    user = get_or_create_user(uid, email)
    preferences = build_user_preferences_payload(user)
    return jsonify({
        'uid': user['uid'], 'email': user['email'],
        'credits': {
            'lecture_standard': user.get('lecture_credits_standard', 0),
            'lecture_extended': user.get('lecture_credits_extended', 0),
            'slides': user.get('slides_credits', 0),
            'interview_short': user.get('interview_credits_short', 0),
            'interview_medium': user.get('interview_credits_medium', 0),
            'interview_long': user.get('interview_credits_long', 0),
        },
        'total_processed': user.get('total_processed', 0),
        'is_admin': is_admin_user(decoded_token),
        'preferences': preferences,
    })

@app.route('/api/user-preferences', methods=['GET'])
def get_user_preferences():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not is_email_allowed(email):
        return jsonify({'error': 'Email not allowed'}), 403
    user = get_or_create_user(uid, email)
    return jsonify({'preferences': build_user_preferences_payload(user)})

@app.route('/api/user-preferences', methods=['PUT'])
def update_user_preferences():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not is_email_allowed(email):
        return jsonify({'error': 'Email not allowed'}), 403

    payload = request.get_json(silent=True) or {}
    user = get_or_create_user(uid, email)

    raw_key = payload.get('output_language', user.get('preferred_output_language', DEFAULT_OUTPUT_LANGUAGE_KEY))
    raw_custom = payload.get('output_language_custom', user.get('preferred_output_language_custom', ''))
    pref_key = sanitize_output_language_pref_key(raw_key)
    pref_custom = sanitize_output_language_pref_custom(raw_custom)

    if pref_key == 'other' and not pref_custom:
        return jsonify({'error': 'Custom language is required when output language is Other.'}), 400
    if pref_key != 'other':
        pref_custom = ''

    updates = {
        'preferred_output_language': pref_key,
        'preferred_output_language_custom': pref_custom,
        'updated_at': time.time(),
    }
    if 'onboarding_completed' in payload:
        updates['onboarding_completed'] = bool(payload.get('onboarding_completed'))

    try:
        db.collection('users').document(uid).set(updates, merge=True)
        user.update(updates)
        return jsonify({'ok': True, 'preferences': build_user_preferences_payload(user)})
    except Exception as e:
        logger.info(f"Error updating preferences for user {uid}: {e}")
        return jsonify({'error': 'Could not save preferences'}), 500

@app.route('/api/account/export', methods=['GET'])
def export_account_data():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    try:
        payload = collect_user_export_payload(uid, email)
        date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        filename = f"lecture-processor-account-export-{date_str}.json"
        data_bytes = json.dumps(payload, ensure_ascii=False, indent=2, default=str).encode('utf-8')
        file_obj = io.BytesIO(data_bytes)
        file_obj.seek(0)
        return send_file(
            file_obj,
            mimetype='application/json',
            as_attachment=True,
            download_name=filename,
        )
    except Exception as e:
        logger.info(f"Error exporting account data for {uid}: {e}")
        return jsonify({'error': 'Could not export account data'}), 500

@app.route('/api/account/delete', methods=['POST'])
def delete_account_data():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    email = str(decoded_token.get('email', '') or '').strip().lower()
    payload = request.get_json(silent=True) or {}

    confirm_text = str(payload.get('confirm_text', '') or '').strip().upper()
    if confirm_text != 'DELETE MY ACCOUNT':
        return jsonify({'error': 'Invalid confirmation text. Type DELETE MY ACCOUNT exactly.'}), 400

    confirm_email = str(payload.get('confirm_email', '') or '').strip().lower()
    if email and confirm_email != email:
        return jsonify({'error': 'Confirmation email does not match your account email.'}), 400

    active_jobs = count_active_jobs_for_user(uid)
    if active_jobs > 0:
        return jsonify({'error': f'Cannot delete account while {active_jobs} processing job(s) are still active. Please wait until processing finishes.'}), 409

    try:
        deleted = {}
        truncated = {}
        warnings_list = []
        job_ids = set()

        job_log_docs, job_logs_truncated = list_docs_by_uid('job_logs', uid, ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION)
        truncated['job_logs'] = job_logs_truncated
        for item in job_log_docs:
            jid = str(item.get('job_id', '') or item.get('_id', '')).strip()
            if jid:
                job_ids.add(jid)

        deleted_job_logs, _ = delete_docs_by_uid('job_logs', uid, ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION)
        deleted['job_logs'] = deleted_job_logs

        anonymized_purchases, purchases_truncated = anonymize_purchase_docs_by_uid(uid, ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION)
        deleted_analytics, analytics_truncated = delete_docs_by_uid('analytics_events', uid, ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION)
        deleted_folders, folders_truncated = delete_docs_by_uid('study_folders', uid, ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION)
        deleted_card_states, card_states_truncated = delete_docs_by_uid('study_card_states', uid, ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION)
        truncated['purchases'] = purchases_truncated
        truncated['analytics_events'] = analytics_truncated
        truncated['study_folders'] = folders_truncated
        truncated['study_card_states'] = card_states_truncated
        deleted['purchases_anonymized'] = anonymized_purchases
        deleted['analytics_events'] = deleted_analytics
        deleted['study_folders'] = deleted_folders
        deleted['study_card_states'] = deleted_card_states

        study_pack_docs = list(
            db.collection('study_packs')
            .where('uid', '==', uid)
            .limit(ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION + 1)
            .stream()
        )
        truncated['study_packs'] = len(study_pack_docs) > ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION
        study_pack_docs = study_pack_docs[:ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION]

        deleted_study_packs = 0
        deleted_pack_audio_files = 0
        deleted_pack_progress_states = 0
        for doc in study_pack_docs:
            pack = doc.to_dict() or {}
            pack_id = doc.id
            job_id = str(pack.get('source_job_id', '') or '').strip()
            if job_id:
                job_ids.add(job_id)

            if remove_pack_audio_file(pack):
                deleted_pack_audio_files += 1

            try:
                get_study_card_state_doc(uid, pack_id).delete()
                deleted_pack_progress_states += 1
            except Exception:
                pass

            try:
                doc.reference.delete()
                deleted_study_packs += 1
            except Exception as e:
                warnings_list.append(f"Could not delete study pack {pack_id}: {e}")

        deleted['study_packs'] = deleted_study_packs
        deleted['study_pack_audio_files'] = deleted_pack_audio_files
        deleted['study_pack_progress_states'] = deleted_pack_progress_states

        try:
            get_study_progress_doc(uid).delete()
            deleted['study_progress_doc'] = 1
        except Exception:
            deleted['study_progress_doc'] = 0

        try:
            db.collection('users').document(uid).delete()
            deleted['user_profile_doc'] = 1
        except Exception:
            deleted['user_profile_doc'] = 0

        removed_in_memory_jobs = 0
        with JOBS_LOCK:
            for jid, job_data in list(jobs.items()):
                if str(job_data.get('user_id', '') or '') != uid:
                    continue
                job_ids.add(jid)
                try:
                    del jobs[jid]
                    removed_in_memory_jobs += 1
                except Exception:
                    pass
        deleted['in_memory_jobs'] = removed_in_memory_jobs

        deleted['upload_artifacts'] = remove_upload_artifacts_for_job_ids(job_ids)

        auth_user_deleted = False
        try:
            auth.delete_user(uid)
            auth_user_deleted = True
        except Exception as e:
            warnings_list.append(f"Could not delete Firebase Auth user: {e}")

        return jsonify({
            'ok': True,
            'auth_user_deleted': auth_user_deleted,
            'deleted': deleted,
            'truncated': truncated,
            'warnings': warnings_list,
        })
    except Exception as e:
        logger.info(f"Error deleting account data for {uid}: {e}")
        return jsonify({'error': 'Could not delete account data'}), 500

@app.route('/api/study-progress', methods=['GET'])
def get_study_progress():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        progress_doc = get_study_progress_doc(uid).get()
        progress_data = progress_doc.to_dict() if progress_doc.exists else {}
        daily_goal = sanitize_daily_goal_value(progress_data.get('daily_goal'))
        if daily_goal is None:
            daily_goal = 20
        streak_data = sanitize_streak_data(progress_data.get('streak_data', {}))
        timezone = str(progress_data.get('timezone', '') or '').strip()[:80]

        card_states = {}
        card_state_maps = []
        docs = db.collection('study_card_states').where('uid', '==', uid).limit(MAX_PROGRESS_PACKS_PER_SYNC).stream()
        for doc in docs:
            data = doc.to_dict() or {}
            pack_id = sanitize_pack_id(data.get('pack_id', ''))
            if not pack_id:
                continue
            state_map = sanitize_card_state_map(data.get('state', {}))
            card_states[pack_id] = state_map
            card_state_maps.append(state_map)

        return jsonify({
            'daily_goal': daily_goal,
            'streak_data': streak_data,
            'timezone': sanitize_timezone_name(timezone),
            'card_states': card_states,
            'summary': compute_study_progress_summary(progress_data, card_state_maps),
        })
    except Exception as e:
        logger.info(f"Error fetching study progress for user {uid}: {e}")
        return jsonify({'error': 'Could not load study progress'}), 500

@app.route('/api/study-progress', methods=['PUT'])
def update_study_progress():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return jsonify({'error': 'Invalid payload'}), 400

    try:
        existing_progress_doc = get_study_progress_doc(uid).get()
        existing_progress_data = existing_progress_doc.to_dict() if existing_progress_doc.exists else {}
        updates = {
            'uid': uid,
            'updated_at': time.time(),
        }

        if 'daily_goal' in payload:
            daily_goal = sanitize_daily_goal_value(payload.get('daily_goal'))
            if daily_goal is None:
                return jsonify({'error': 'daily_goal must be between 1 and 500'}), 400
            updates['daily_goal'] = daily_goal

        if 'streak_data' in payload:
            updates['streak_data'] = merge_streak_data(existing_progress_data.get('streak_data', {}), payload.get('streak_data'))

        if 'timezone' in payload:
            updates['timezone'] = merge_timezone_value(existing_progress_data.get('timezone', ''), payload.get('timezone', ''))

        get_study_progress_doc(uid).set(updates, merge=True)

        card_states = payload.get('card_states')
        if card_states is not None:
            if not isinstance(card_states, dict):
                return jsonify({'error': 'card_states must be an object'}), 400
            processed = 0
            for raw_pack_id, raw_state in card_states.items():
                if processed >= MAX_PROGRESS_PACKS_PER_SYNC:
                    break
                pack_id = sanitize_pack_id(raw_pack_id)
                if not pack_id:
                    continue
                cleaned_state = sanitize_card_state_map(raw_state)
                doc_ref = get_study_card_state_doc(uid, pack_id)
                if cleaned_state:
                    existing_pack_doc = doc_ref.get()
                    existing_pack_state = {}
                    if existing_pack_doc.exists:
                        existing_pack_data = existing_pack_doc.to_dict() or {}
                        existing_pack_state = sanitize_card_state_map(existing_pack_data.get('state', {}))
                    merged_state = merge_card_state_maps(existing_pack_state, cleaned_state)
                    doc_ref.set({
                        'uid': uid,
                        'pack_id': pack_id,
                        'state': merged_state,
                        'updated_at': time.time(),
                    }, merge=True)
                processed += 1

        remove_pack_ids = payload.get('remove_pack_ids')
        if remove_pack_ids is not None:
            if not isinstance(remove_pack_ids, list):
                return jsonify({'error': 'remove_pack_ids must be a list'}), 400
            for raw_pack_id in remove_pack_ids[:MAX_PROGRESS_PACKS_PER_SYNC]:
                pack_id = sanitize_pack_id(raw_pack_id)
                if not pack_id:
                    continue
                try:
                    get_study_card_state_doc(uid, pack_id).delete()
                except Exception as delete_error:
                    logger.info(f"Warning: failed deleting study progress state for {uid}/{pack_id}: {delete_error}")

        return jsonify({'ok': True})
    except Exception as e:
        logger.info(f"Error updating study progress for user {uid}: {e}")
        return jsonify({'error': 'Could not save study progress'}), 500

@app.route('/api/study-progress/summary', methods=['GET'])
def get_study_progress_summary():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        progress_doc = get_study_progress_doc(uid).get()
        progress_data = progress_doc.to_dict() if progress_doc.exists else {}
        card_state_maps = []
        docs = db.collection('study_card_states').where('uid', '==', uid).limit(MAX_PROGRESS_PACKS_PER_SYNC).stream()
        for doc in docs:
            data = doc.to_dict() or {}
            card_state_maps.append(sanitize_card_state_map(data.get('state', {})))

        return jsonify(compute_study_progress_summary(progress_data, card_state_maps))
    except Exception as e:
        logger.info(f"Error fetching study progress summary for user {uid}: {e}")
        return jsonify({'error': 'Could not load study progress summary'}), 500

# --- Stripe Routes ---

@app.route('/api/config', methods=['GET'])
def get_config():
    return jsonify({
        'stripe_publishable_key': STRIPE_PUBLISHABLE_KEY,
        'bundles': {
            bundle_id: {
                'name': bundle['name'],
                'description': bundle['description'],
                'price_cents': bundle['price_cents'],
                'currency': bundle['currency'],
                'credits': bundle['credits'],
            }
            for bundle_id, bundle in CREDIT_BUNDLES.items()
        }
    })

@app.route('/api/create-checkout-session', methods=['POST'])
def create_checkout_session():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Please sign in to continue'}), 401

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    allowed_checkout, retry_after = check_rate_limit(
        key=f"checkout:{normalize_rate_limit_key_part(uid, fallback='anon_uid')}",
        limit=CHECKOUT_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=CHECKOUT_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allowed_checkout:
        log_rate_limit_hit('checkout', retry_after)
        return build_rate_limited_response(
            'Too many checkout attempts. Please wait before starting another checkout.',
            retry_after,
        )

    data = request.get_json(silent=True) or {}
    bundle_id = data.get('bundle_id', '')

    if bundle_id not in CREDIT_BUNDLES:
        return jsonify({'error': 'Invalid bundle selected'}), 400

    bundle = CREDIT_BUNDLES[bundle_id]

    try:
        checkout_session = stripe.checkout.Session.create(
            payment_method_types=['card', 'ideal'],
            line_items=[{
                'price_data': {
                    'currency': bundle['currency'],
                    'product_data': {
                        'name': bundle['name'],
                        'description': bundle['description'],
                    },
                    'unit_amount': bundle['price_cents'],
                },
                'quantity': 1,
            }],
            mode='payment',
            success_url=request.host_url.rstrip('/') + '/dashboard?payment=success&session_id={CHECKOUT_SESSION_ID}',
            cancel_url=request.host_url.rstrip('/') + '/dashboard?payment=cancelled',
            customer_email=email,
            metadata={
                'uid': uid,
                'bundle_id': bundle_id,
            },
        )
        return jsonify({'checkout_url': checkout_session.url})
    except Exception as e:
        logger.info(f"Stripe checkout error: {e}")
        return jsonify({'error': 'Could not create checkout session. Please try again.'}), 500

@app.route('/api/confirm-checkout-session', methods=['GET'])
def confirm_checkout_session():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token.get('uid', '')
    session_id = str(request.args.get('session_id', '') or '').strip()
    if not session_id:
        return jsonify({'error': 'Missing session_id'}), 400

    try:
        session = stripe.checkout.Session.retrieve(session_id)
        metadata = session.get('metadata', {}) or {}
        if metadata.get('uid', '') != uid:
            return jsonify({'error': 'Forbidden'}), 403

        ok, status = process_checkout_session_credits(session)
        if not ok:
            return jsonify({'error': status}), 400
        return jsonify({'ok': True, 'status': status})
    except stripe.error.StripeError as e:
        logger.info(f"Stripe confirm session error: {e}")
        return jsonify({'error': 'Could not verify checkout session.'}), 400
    except Exception as e:
        logger.info(f"Confirm checkout session error: {e}")
        return jsonify({'error': 'Could not confirm checkout session.'}), 500

@app.route('/api/stripe-webhook', methods=['POST'])
def stripe_webhook():
    payload = request.data
    sig_header = request.headers.get('Stripe-Signature', '')

    if STRIPE_WEBHOOK_SECRET:
        try:
            event = stripe.Webhook.construct_event(
                payload, sig_header, STRIPE_WEBHOOK_SECRET
            )
        except ValueError:
            logger.info("Stripe webhook: Invalid payload")
            return 'Invalid payload', 400
        except stripe.error.SignatureVerificationError as e:
            logger.info(f"Stripe webhook signature verification failed: {e}")
            return 'Invalid signature', 400
        except Exception as e:
            logger.info(f"Stripe webhook unexpected error: {e}")
            return 'Webhook processing error', 500
    else:
        # SECURITY: Reject all webhook requests if STRIPE_WEBHOOK_SECRET is not configured.
        # Without signature verification, anyone could forge payment events.
        logger.info("⚠️ Stripe webhook rejected: STRIPE_WEBHOOK_SECRET is not configured")
        return jsonify({'error': 'Webhook not configured'}), 500

    if event.get('type') == 'checkout.session.completed':
        session = event['data']['object']
        ok, status = process_checkout_session_credits(session)
        if ok and status == 'granted':
            metadata = session.get('metadata', {}) or {}
            logger.info(f"✅ Payment successful! Granted bundle '{metadata.get('bundle_id', '')}' to user '{metadata.get('uid', '')}'")
        elif ok and status == 'already_processed':
            logger.info(f"ℹ️ Checkout session {session.get('id', '')} already processed.")
        else:
            logger.info(f"⚠️ Webhook checkout session {session.get('id', '')} not processed: {status}")

    return '', 200

# --- Purchase History Route ---

@app.route('/api/purchase-history', methods=['GET'])
def get_purchase_history():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']

    try:
        purchases_ref = db.collection('purchases').where('uid', '==', uid).order_by('created_at', direction=firestore.Query.DESCENDING).limit(50)
        purchases = []
        for doc in purchases_ref.stream():
            p = doc.to_dict()
            purchases.append({
                'id': doc.id,
                'bundle_name': p.get('bundle_name', 'Unknown'),
                'price_cents': p.get('price_cents', 0),
                'currency': p.get('currency', 'eur'),
                'credits': p.get('credits', {}),
                'created_at': p.get('created_at', 0),
            })
        return jsonify({'purchases': purchases})
    except Exception as e:
        logger.info(f"Error fetching purchase history: {e}")
        return jsonify({'purchases': []})

@app.route('/api/study-packs', methods=['GET'])
def get_study_packs():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    try:
        study_docs = list(db.collection('study_packs').where('uid', '==', uid).limit(200).stream())
        packs = []
        for doc in study_docs:
            pack = doc.to_dict()
            packs.append({
                'study_pack_id': doc.id,
                'title': pack.get('title', ''),
                'mode': pack.get('mode', ''),
                'flashcards_count': len(pack.get('flashcards', [])),
                'test_questions_count': len(pack.get('test_questions', [])),
                'course': pack.get('course', ''),
                'subject': pack.get('subject', ''),
                'semester': pack.get('semester', ''),
                'block': pack.get('block', ''),
                'folder_id': pack.get('folder_id', ''),
                'folder_name': pack.get('folder_name', ''),
                'created_at': pack.get('created_at', 0),
            })
        packs.sort(key=lambda p: p.get('created_at', 0), reverse=True)
        return jsonify({'study_packs': packs[:50]})
    except Exception as e:
        logger.info(f"Error fetching study packs: {e}")
        return jsonify({'error': 'Could not load study packs'}), 500

@app.route('/api/study-packs', methods=['POST'])
def create_study_pack():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    payload = request.get_json() or {}

    title = str(payload.get('title', '')).strip()[:120]
    if not title:
        title = f"Untitled pack {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M')}"

    try:
        now_ts = time.time()
        folder_id = str(payload.get('folder_id', '')).strip()
        folder_name = ''
        if folder_id:
            folder_doc = db.collection('study_folders').document(folder_id).get()
            if not folder_doc.exists:
                return jsonify({'error': 'Folder not found'}), 404
            folder_data = folder_doc.to_dict()
            if folder_data.get('uid', '') != uid:
                return jsonify({'error': 'Forbidden'}), 403
            folder_name = folder_data.get('name', '')
        else:
            folder_id = ''

        flashcards = sanitize_flashcards(payload.get('flashcards', []), 500)
        test_questions = sanitize_questions(payload.get('test_questions', []), 500)
        notes_markdown = str(payload.get('notes_markdown', '')).strip()[:180000]
        notes_audio_map = parse_audio_markers_from_notes(notes_markdown) if FEATURE_AUDIO_SECTION_SYNC else []

        doc_ref = db.collection('study_packs').document()
        doc_ref.set({
            'study_pack_id': doc_ref.id,
            'source_job_id': '',
            'uid': uid,
            'mode': 'manual',
            'title': title,
            'output_language': str(payload.get('output_language', 'English')).strip()[:64] or 'English',
            'notes_markdown': notes_markdown,
            'notes_truncated': False,
            'transcript_segments': [],
            'notes_audio_map': notes_audio_map,
            'audio_storage_key': '',
            'has_audio_sync': False,
            'has_audio_playback': False,
            'flashcards': flashcards,
            'test_questions': test_questions,
            'flashcard_selection': 'manual',
            'question_selection': 'manual',
            'study_features': 'both',
            'interview_features': [],
            'interview_summary': None,
            'interview_sections': None,
            'interview_combined': None,
            'study_generation_error': None,
            'course': str(payload.get('course', '')).strip()[:120],
            'subject': str(payload.get('subject', '')).strip()[:120],
            'semester': str(payload.get('semester', '')).strip()[:120],
            'block': str(payload.get('block', '')).strip()[:120],
            'folder_id': folder_id,
            'folder_name': folder_name,
            'created_at': now_ts,
            'updated_at': now_ts,
        })

        return jsonify({'ok': True, 'study_pack_id': doc_ref.id})
    except Exception as e:
        logger.info(f"Error creating study pack: {e}")
        return jsonify({'error': 'Could not create study pack'}), 500

@app.route('/api/study-packs/<pack_id>', methods=['GET'])
def get_study_pack(pack_id):
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    try:
        doc = db.collection('study_packs').document(pack_id).get()
        if not doc.exists:
            return jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict() or {}
        if pack.get('uid', '') != uid:
            return jsonify({'error': 'Forbidden'}), 403
        ensure_pack_audio_storage_key(doc.reference, pack)
        has_audio_playback = bool(pack.get('has_audio_playback', False) or get_audio_storage_key_from_pack(pack))
        has_audio_sync = FEATURE_AUDIO_SECTION_SYNC and bool(pack.get('has_audio_sync', False))
        notes_audio_map = pack.get('notes_audio_map', []) if has_audio_sync else []
        return jsonify({
            'study_pack_id': pack_id,
            'title': pack.get('title', ''),
            'mode': pack.get('mode', ''),
            'output_language': pack.get('output_language', 'English'),
            'notes_markdown': pack.get('notes_markdown', ''),
            'transcript_segments': pack.get('transcript_segments', []),
            'notes_audio_map': notes_audio_map,
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
            'folder_id': pack.get('folder_id', ''),
            'folder_name': pack.get('folder_name', ''),
            'created_at': pack.get('created_at', 0),
        })
    except Exception as e:
        logger.info(f"Error fetching study pack {pack_id}: {e}")
        return jsonify({'error': 'Could not fetch study pack'}), 500

@app.route('/api/study-packs/<pack_id>', methods=['PATCH'])
def update_study_pack(pack_id):
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    payload = request.get_json() or {}

    try:
        pack_ref = db.collection('study_packs').document(pack_id)
        doc = pack_ref.get()
        if not doc.exists:
            return jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return jsonify({'error': 'Forbidden'}), 403
        ensure_pack_audio_storage_key(pack_ref, pack)

        updates = {'updated_at': time.time()}
        if 'title' in payload:
            updates['title'] = str(payload.get('title', '')).strip()[:120]
        if 'course' in payload:
            updates['course'] = str(payload.get('course', '')).strip()[:120]
        if 'subject' in payload:
            updates['subject'] = str(payload.get('subject', '')).strip()[:120]
        if 'semester' in payload:
            updates['semester'] = str(payload.get('semester', '')).strip()[:120]
        if 'block' in payload:
            updates['block'] = str(payload.get('block', '')).strip()[:120]
        if 'folder_id' in payload:
            folder_id = str(payload.get('folder_id', '')).strip()
            updates['folder_id'] = ''
            updates['folder_name'] = ''
            if folder_id:
                folder_doc = db.collection('study_folders').document(folder_id).get()
                if not folder_doc.exists:
                    return jsonify({'error': 'Folder not found'}), 404
                folder_data = folder_doc.to_dict()
                if folder_data.get('uid', '') != uid:
                    return jsonify({'error': 'Forbidden'}), 403
                updates['folder_id'] = folder_id
                updates['folder_name'] = folder_data.get('name', '')

        if 'flashcards' in payload:
            updates['flashcards'] = sanitize_flashcards(payload.get('flashcards', []), 500)
        if 'test_questions' in payload:
            updates['test_questions'] = sanitize_questions(payload.get('test_questions', []), 500)
        if 'notes_markdown' in payload:
            updates['notes_markdown'] = str(payload.get('notes_markdown', ''))[:180000]
            notes_audio_map = parse_audio_markers_from_notes(updates['notes_markdown']) if FEATURE_AUDIO_SECTION_SYNC else []
            updates['notes_audio_map'] = notes_audio_map
            updates['has_audio_sync'] = FEATURE_AUDIO_SECTION_SYNC and bool(get_audio_storage_key_from_pack(pack)) and bool(notes_audio_map)
        updates['has_audio_playback'] = bool(get_audio_storage_key_from_pack(pack))

        pack_ref.update(updates)
        return jsonify({'ok': True})
    except Exception as e:
        logger.info(f"Error updating study pack {pack_id}: {e}")
        return jsonify({'error': 'Could not update study pack'}), 500

@app.route('/api/study-packs/<pack_id>', methods=['DELETE'])
def delete_study_pack(pack_id):
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        pack_ref = db.collection('study_packs').document(pack_id)
        doc = pack_ref.get()
        if not doc.exists:
            return jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return jsonify({'error': 'Forbidden'}), 403
        remove_pack_audio_file(pack)
        pack_ref.delete()
        try:
            get_study_card_state_doc(uid, pack_id).delete()
        except Exception as e:
            logger.info(f"Warning: could not delete study progress state for pack {pack_id}: {e}")
        return jsonify({'ok': True})
    except Exception as e:
        logger.info(f"Error deleting study pack {pack_id}: {e}")
        return jsonify({'error': 'Could not delete study pack'}), 500

@app.route('/api/study-folders', methods=['GET'])
def get_study_folders():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        docs = list(db.collection('study_folders').where('uid', '==', uid).stream())
        folders = []
        for doc in docs:
            folder = doc.to_dict()
            folders.append({
                'folder_id': doc.id,
                'name': folder.get('name', ''),
                'course': folder.get('course', ''),
                'subject': folder.get('subject', ''),
                'semester': folder.get('semester', ''),
                'block': folder.get('block', ''),
                'exam_date': folder.get('exam_date', ''),
                'created_at': folder.get('created_at', 0),
            })
        folders.sort(key=lambda f: f.get('created_at', 0), reverse=True)
        return jsonify({'folders': folders})
    except Exception as e:
        logger.info(f"Error fetching study folders: {e}")
        return jsonify({'error': 'Could not load study folders'}), 500

@app.route('/api/study-packs/<pack_id>/audio-url', methods=['GET'])
def get_study_pack_audio_url(pack_id):
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        doc = db.collection('study_packs').document(pack_id).get()
        if not doc.exists:
            return jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict() or {}
        if pack.get('uid', '') != uid:
            return jsonify({'error': 'Forbidden'}), 403
        audio_storage_key = ensure_pack_audio_storage_key(doc.reference, pack)
        audio_storage_path = resolve_audio_storage_path_from_key(audio_storage_key)
        if not audio_storage_path:
            return jsonify({'error': 'No audio file for this study pack'}), 404
        if not os.path.exists(audio_storage_path):
            return jsonify({'error': 'Audio file not found'}), 404
        if not ALLOW_LEGACY_AUDIO_STREAM_TOKENS:
            return jsonify({'error': 'Legacy token audio endpoint is disabled on this server'}), 410
        stream_token = str(uuid.uuid4())
        AUDIO_STREAM_TOKENS[stream_token] = {
            'path': audio_storage_path,
            'expires_at': time.time() + AUDIO_STREAM_TOKEN_TTL_SECONDS
        }
        return jsonify({'audio_url': f"/api/audio-stream/{stream_token}"})
    except Exception as e:
        logger.info(f"Error generating study-pack audio URL {pack_id}: {e}")
        return jsonify({'error': 'Could not generate audio URL'}), 500

@app.route('/api/study-packs/<pack_id>/audio', methods=['GET'])
def stream_study_pack_audio(pack_id):
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        doc = db.collection('study_packs').document(pack_id).get()
        if not doc.exists:
            return jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict() or {}
        if pack.get('uid', '') != uid and not is_admin_user(decoded_token):
            return jsonify({'error': 'Forbidden'}), 403
        audio_storage_key = ensure_pack_audio_storage_key(doc.reference, pack)
        audio_storage_path = resolve_audio_storage_path_from_key(audio_storage_key)
        if not audio_storage_path:
            return jsonify({'error': 'No audio file for this study pack'}), 404
        if not os.path.exists(audio_storage_path):
            return jsonify({'error': 'Audio file not found'}), 404
        return send_file(audio_storage_path, mimetype=get_mime_type(audio_storage_path), conditional=True)
    except Exception as e:
        logger.info(f"Error streaming study-pack audio {pack_id}: {e}")
        return jsonify({'error': 'Could not stream audio'}), 500

@app.route('/api/audio-stream/<token>', methods=['GET'])
def stream_audio_token(token):
    if not ALLOW_LEGACY_AUDIO_STREAM_TOKENS:
        return jsonify({'error': 'Not found'}), 404
    token_data = AUDIO_STREAM_TOKENS.get(token)
    if not token_data:
        return jsonify({'error': 'Invalid token'}), 404
    if time.time() > token_data.get('expires_at', 0):
        AUDIO_STREAM_TOKENS.pop(token, None)
        return jsonify({'error': 'Token expired'}), 410
    file_path = token_data.get('path', '')
    if not file_path or not os.path.exists(file_path):
        return jsonify({'error': 'Audio file not found'}), 404
    mime_type = get_mime_type(file_path)
    return send_file(file_path, mimetype=mime_type, conditional=True)

@app.route('/api/study-folders', methods=['POST'])
def create_study_folder():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    payload = request.get_json() or {}
    name = str(payload.get('name', '')).strip()[:120]
    if not name:
        return jsonify({'error': 'Folder name is required'}), 400
    try:
        now_ts = time.time()
        try:
            exam_date = normalize_exam_date(payload.get('exam_date', ''))
        except ValueError as ve:
            return jsonify({'error': str(ve)}), 400
        doc_ref = db.collection('study_folders').document()
        doc_ref.set({
            'folder_id': doc_ref.id,
            'uid': uid,
            'name': name,
            'course': str(payload.get('course', '')).strip()[:120],
            'subject': str(payload.get('subject', '')).strip()[:120],
            'semester': str(payload.get('semester', '')).strip()[:120],
            'block': str(payload.get('block', '')).strip()[:120],
            'exam_date': exam_date,
            'created_at': now_ts,
            'updated_at': now_ts,
        })
        return jsonify({'ok': True, 'folder_id': doc_ref.id})
    except Exception as e:
        logger.info(f"Error creating study folder: {e}")
        return jsonify({'error': 'Could not create folder'}), 500

@app.route('/api/study-folders/<folder_id>', methods=['PATCH'])
def update_study_folder(folder_id):
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    payload = request.get_json() or {}
    try:
        folder_ref = db.collection('study_folders').document(folder_id)
        doc = folder_ref.get()
        if not doc.exists:
            return jsonify({'error': 'Folder not found'}), 404
        folder = doc.to_dict()
        if folder.get('uid', '') != uid:
            return jsonify({'error': 'Forbidden'}), 403
        updates = {'updated_at': time.time()}
        if 'name' in payload:
            name = str(payload.get('name', '')).strip()[:120]
            if not name:
                return jsonify({'error': 'Folder name is required'}), 400
            updates['name'] = name
        for field in ['course', 'subject', 'semester', 'block']:
            if field in payload:
                updates[field] = str(payload.get(field, '')).strip()[:120]
        if 'exam_date' in payload:
            try:
                updates['exam_date'] = normalize_exam_date(payload.get('exam_date', ''))
            except ValueError as ve:
                return jsonify({'error': str(ve)}), 400
        folder_ref.update(updates)
        if 'name' in updates:
            packs = list(db.collection('study_packs').where('uid', '==', uid).where('folder_id', '==', folder_id).stream())
            for pack_doc in packs:
                pack_doc.reference.update({'folder_name': updates['name'], 'updated_at': time.time()})
        return jsonify({'ok': True})
    except Exception as e:
        logger.info(f"Error updating folder {folder_id}: {e}")
        return jsonify({'error': 'Could not update folder'}), 500

@app.route('/api/study-folders/<folder_id>', methods=['DELETE'])
def delete_study_folder(folder_id):
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        folder_ref = db.collection('study_folders').document(folder_id)
        doc = folder_ref.get()
        if not doc.exists:
            return jsonify({'error': 'Folder not found'}), 404
        folder = doc.to_dict()
        if folder.get('uid', '') != uid:
            return jsonify({'error': 'Forbidden'}), 403
        folder_ref.delete()
        packs = list(db.collection('study_packs').where('uid', '==', uid).where('folder_id', '==', folder_id).stream())
        for pack_doc in packs:
            pack_doc.reference.update({'folder_id': '', 'folder_name': '', 'updated_at': time.time()})
        return jsonify({'ok': True})
    except Exception as e:
        logger.info(f"Error deleting folder {folder_id}: {e}")
        return jsonify({'error': 'Could not delete folder'}), 500

@app.route('/api/admin/overview', methods=['GET'])
def get_admin_overview():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    if not is_admin_user(decoded_token):
        return jsonify({'error': 'Forbidden'}), 403

    try:
        window_key, window_seconds = get_admin_window(request.args.get('window', '7d'))
        now_ts = time.time()
        window_start = now_ts - window_seconds

        total_users = safe_count_collection('users')
        new_users = safe_count_window('users', 'created_at', window_start)
        total_processed = safe_count_collection('job_logs')

        filtered_purchases_docs = safe_query_docs_in_window(
            collection_name='purchases',
            timestamp_field='created_at',
            window_start=window_start,
            window_end=now_ts,
        )
        filtered_jobs_docs = safe_query_docs_in_window(
            collection_name='job_logs',
            timestamp_field='finished_at',
            window_start=window_start,
            window_end=now_ts,
        )
        filtered_analytics_docs = safe_query_docs_in_window(
            collection_name='analytics_events',
            timestamp_field='created_at',
            window_start=window_start,
            window_end=now_ts,
        )
        filtered_rate_limit_docs = safe_query_docs_in_window(
            collection_name='rate_limit_logs',
            timestamp_field='created_at',
            window_start=window_start,
            window_end=now_ts,
        )

        total_revenue_cents = 0
        purchase_count = 0
        filtered_purchases = []
        for doc in filtered_purchases_docs:
            purchase = doc.to_dict() or {}
            filtered_purchases.append(purchase)
            purchase_count += 1
            total_revenue_cents += purchase.get('price_cents', 0) or 0

        job_count = 0
        success_jobs = 0
        failed_jobs = 0
        refunded_jobs = 0
        durations = []
        filtered_jobs = []
        for doc in filtered_jobs_docs:
            job = doc.to_dict() or {}
            filtered_jobs.append(job)
            job_count += 1
            status = job.get('status', '')
            if status == 'complete':
                success_jobs += 1
            elif status == 'error':
                failed_jobs += 1
            if job.get('credit_refunded'):
                refunded_jobs += 1
            duration = job.get('duration_seconds')
            if isinstance(duration, (int, float)):
                durations.append(duration)

        avg_duration_seconds = round(sum(durations) / len(durations), 1) if durations else 0

        funnel_steps, analytics_event_count = build_admin_funnel_steps(filtered_analytics_docs, window_start)
        rate_limit_counts = {'upload': 0, 'checkout': 0, 'analytics': 0}
        for doc in filtered_rate_limit_docs:
            entry = doc.to_dict() or {}
            limit_name = str(entry.get('limit_name', '') or '').strip().lower()
            if limit_name in rate_limit_counts:
                rate_limit_counts[limit_name] += 1

        rate_limit_entries = []
        for doc in filtered_rate_limit_docs:
            entry = doc.to_dict() or {}
            rate_limit_entries.append(entry)
        recent_rate_limits_sorted = sorted(
            rate_limit_entries,
            key=lambda entry: get_timestamp(entry.get('created_at')),
            reverse=True,
        )[:20]
        recent_rate_limits = []
        for entry in recent_rate_limits_sorted:
            limit_name = str(entry.get('limit_name', '') or '').strip().lower()
            if limit_name not in {'upload', 'checkout', 'analytics'}:
                continue
            recent_rate_limits.append({
                'created_at': entry.get('created_at', 0),
                'limit_name': limit_name,
                'retry_after_seconds': int(entry.get('retry_after_seconds', 0) or 0),
            })

        mode_breakdown = {
            'lecture-notes': {'label': 'Lecture Notes', 'total': 0, 'complete': 0, 'error': 0},
            'slides-only': {'label': 'Slide Extract', 'total': 0, 'complete': 0, 'error': 0},
            'interview': {'label': 'Interview Transcript', 'total': 0, 'complete': 0, 'error': 0},
            'other': {'label': 'Other', 'total': 0, 'complete': 0, 'error': 0},
        }
        for job in filtered_jobs:
            mode = job.get('mode', '')
            key = mode if mode in mode_breakdown else 'other'
            status = job.get('status', '')
            mode_breakdown[key]['total'] += 1
            if status == 'complete':
                mode_breakdown[key]['complete'] += 1
            elif status == 'error':
                mode_breakdown[key]['error'] += 1

        recent_jobs_sorted = sorted(
            filtered_jobs,
            key=lambda j: get_timestamp(j.get('finished_at')),
            reverse=True
        )[:20]
        recent_jobs = []
        for job in recent_jobs_sorted:
            recent_jobs.append({
                'job_id': job.get('job_id', ''),
                'email': job.get('email', ''),
                'mode': job.get('mode', ''),
                'status': job.get('status', ''),
                'duration_seconds': job.get('duration_seconds', 0),
                'credit_refunded': job.get('credit_refunded', False),
                'finished_at': job.get('finished_at', 0),
            })

        recent_purchases_sorted = sorted(
            filtered_purchases,
            key=lambda p: get_timestamp(p.get('created_at')),
            reverse=True
        )[:20]
        recent_purchases = []
        for purchase in recent_purchases_sorted:
            recent_purchases.append({
                'uid': purchase.get('uid', ''),
                'bundle_name': purchase.get('bundle_name', 'Unknown'),
                'price_cents': purchase.get('price_cents', 0),
                'currency': purchase.get('currency', 'eur'),
                'created_at': purchase.get('created_at', 0),
            })

        trend_labels, trend_keys, trend_granularity = build_time_buckets(window_key, now_ts)
        success_by_bucket = {key: {'complete': 0, 'error': 0} for key in trend_keys}
        revenue_by_bucket = {key: 0 for key in trend_keys}

        for job in filtered_jobs:
            timestamp = get_timestamp(job.get('finished_at'))
            bucket_key = get_bucket_key(timestamp, window_key)
            if bucket_key not in success_by_bucket:
                continue
            status = job.get('status', '')
            if status == 'complete':
                success_by_bucket[bucket_key]['complete'] += 1
            elif status == 'error':
                success_by_bucket[bucket_key]['error'] += 1

        for purchase in filtered_purchases:
            timestamp = get_timestamp(purchase.get('created_at'))
            bucket_key = get_bucket_key(timestamp, window_key)
            if bucket_key not in revenue_by_bucket:
                continue
            revenue_by_bucket[bucket_key] += purchase.get('price_cents', 0) or 0

        success_trend = []
        revenue_trend = []
        for key in trend_keys:
            complete_count = success_by_bucket[key]['complete']
            error_count = success_by_bucket[key]['error']
            total_count = complete_count + error_count
            success_rate = round((complete_count / total_count) * 100, 1) if total_count > 0 else 0
            success_trend.append(success_rate)
            revenue_trend.append(revenue_by_bucket[key])

        return jsonify({
            'window': {
                'key': window_key,
                'start': window_start,
                'end': now_ts,
            },
            'metrics': {
                'total_users': total_users,
                'new_users': new_users,
                'total_processed': total_processed,
                'total_revenue_cents': total_revenue_cents,
                'purchase_count': purchase_count,
                'job_count': job_count,
                'success_jobs': success_jobs,
                'failed_jobs': failed_jobs,
                'refunded_jobs': refunded_jobs,
                'avg_duration_seconds': avg_duration_seconds,
                'analytics_event_count': analytics_event_count,
                'rate_limit_upload_429': rate_limit_counts['upload'],
                'rate_limit_checkout_429': rate_limit_counts['checkout'],
                'rate_limit_analytics_429': rate_limit_counts['analytics'],
                'rate_limit_429_total': rate_limit_counts['upload'] + rate_limit_counts['checkout'] + rate_limit_counts['analytics'],
            },
            'trends': {
                'labels': trend_labels,
                'success_rate': success_trend,
                'revenue_cents': revenue_trend,
                'granularity': trend_granularity,
            },
            'mode_breakdown': mode_breakdown,
            'funnel': {
                'steps': funnel_steps,
            },
            'recent_jobs': recent_jobs,
            'recent_purchases': recent_purchases,
            'recent_rate_limits': recent_rate_limits,
            'deployment': build_admin_deployment_info(request.host),
            'runtime_checks': build_admin_runtime_checks(),
        })
    except Exception as e:
        logger.info(f"Error fetching admin overview: {e}")
        return jsonify({'error': 'Could not fetch admin dashboard data'}), 500

@app.route('/api/admin/export', methods=['GET'])
def export_admin_csv():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    if not is_admin_user(decoded_token):
        return jsonify({'error': 'Forbidden'}), 403

    export_type = request.args.get('type', 'jobs')
    if export_type not in {'jobs', 'purchases', 'funnel', 'funnel-daily'}:
        return jsonify({'error': 'Invalid export type'}), 400

    window_key, window_seconds = get_admin_window(request.args.get('window', '7d'))
    now_ts = time.time()
    window_start = now_ts - window_seconds

    class _CsvBuffer:
        def write(self, value):
            return value

    def iter_rows():
        if export_type == 'jobs':
            yield [
                'job_id', 'uid', 'email', 'mode', 'status', 'credit_deducted',
                'credit_refunded', 'error_message', 'started_at', 'finished_at', 'duration_seconds'
            ]
            docs = safe_query_docs_in_window(
                collection_name='job_logs',
                timestamp_field='finished_at',
                window_start=window_start,
                window_end=now_ts,
                order_desc=True,
            )
            for doc in docs:
                job = doc.to_dict() or {}
                yield [
                    job.get('job_id', doc.id),
                    job.get('uid', ''),
                    job.get('email', ''),
                    job.get('mode', ''),
                    job.get('status', ''),
                    job.get('credit_deducted', ''),
                    job.get('credit_refunded', False),
                    job.get('error_message', ''),
                    job.get('started_at', 0),
                    job.get('finished_at', 0),
                    job.get('duration_seconds', 0),
                ]
            return

        if export_type == 'purchases':
            yield [
                'uid', 'bundle_id', 'bundle_name', 'price_cents', 'currency',
                'credits', 'stripe_session_id', 'created_at'
            ]
            docs = safe_query_docs_in_window(
                collection_name='purchases',
                timestamp_field='created_at',
                window_start=window_start,
                window_end=now_ts,
                order_desc=True,
            )
            for doc in docs:
                purchase = doc.to_dict() or {}
                yield [
                    purchase.get('uid', ''),
                    purchase.get('bundle_id', ''),
                    purchase.get('bundle_name', ''),
                    purchase.get('price_cents', 0),
                    purchase.get('currency', 'eur'),
                    json.dumps(purchase.get('credits', {}), ensure_ascii=True),
                    purchase.get('stripe_session_id', ''),
                    purchase.get('created_at', 0),
                ]
            return

        analytics_docs = safe_query_docs_in_window(
            collection_name='analytics_events',
            timestamp_field='created_at',
            window_start=window_start,
            window_end=now_ts,
            order_desc=False,
        )

        if export_type == 'funnel':
            yield [
                'event',
                'label',
                'count',
                'conversion_from_prev_percent',
                'window_key',
                'window_start',
                'window_end',
                'generated_at',
            ]
            funnel_steps, _ = build_admin_funnel_steps(analytics_docs, window_start)
            generated_at = now_ts
            for step in funnel_steps:
                yield [
                    step.get('event', ''),
                    step.get('label', ''),
                    int(step.get('count', 0) or 0),
                    float(step.get('conversion_from_prev', 0.0) or 0.0),
                    window_key,
                    window_start,
                    now_ts,
                    generated_at,
                ]
            return

        yield [
            'bucket_key',
            'granularity',
            'event',
            'label',
            'unique_actor_count',
            'event_count',
            'conversion_from_prev_percent',
            'window_key',
            'window_start',
            'window_end',
            'generated_at',
        ]
        daily_rows, granularity = build_admin_funnel_daily_rows(
            analytics_docs=analytics_docs,
            window_start=window_start,
            window_key=window_key,
            now_ts=now_ts,
        )
        generated_at = now_ts
        for row in daily_rows:
            yield [
                row.get('bucket_key', ''),
                granularity,
                row.get('event', ''),
                row.get('label', ''),
                int(row.get('unique_actor_count', 0) or 0),
                int(row.get('event_count', 0) or 0),
                float(row.get('conversion_from_prev', 0.0) or 0.0),
                window_key,
                window_start,
                now_ts,
                generated_at,
            ]

    def generate_csv():
        buffer = _CsvBuffer()
        writer = csv.writer(buffer)
        for row in iter_rows():
            yield writer.writerow(row)

    try:
        filename = f"admin-{export_type}-{window_key}.csv"
        response = Response(stream_with_context(generate_csv()), mimetype='text/csv')
        response.headers['Content-Disposition'] = f'attachment; filename={filename}'
        return response
    except Exception as e:
        logger.info(f"Error exporting admin CSV ({export_type}): {e}")
        return jsonify({'error': 'Could not export CSV'}), 500

# --- Upload & Processing Routes ---

@app.route('/api/import-audio-url', methods=['POST'])
def import_audio_from_url():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Please sign in to continue'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not is_email_allowed(email):
        return jsonify({'error': 'Email not allowed'}), 403

    allowed_import, retry_after = check_rate_limit(
        key=f"audio_import:{normalize_rate_limit_key_part(uid, fallback='anon_uid')}",
        limit=VIDEO_IMPORT_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=VIDEO_IMPORT_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allowed_import:
        return build_rate_limited_response(
            'Too many video import attempts right now. Please wait and try again.',
            retry_after,
        )

    data = request.get_json(silent=True) or {}
    safe_url, error_message = validate_video_import_url(data.get('url', ''))
    if not safe_url:
        return jsonify({'error': error_message}), 400

    cleanup_expired_audio_import_tokens()
    prefix = f"urlimport_{uuid.uuid4().hex}"
    try:
        audio_path, output_name, size_bytes = download_audio_from_video_url(safe_url, prefix)
        token = register_audio_import_token(uid, audio_path, safe_url, output_name)
        return jsonify({
            'ok': True,
            'audio_import_token': token,
            'file_name': output_name,
            'size_bytes': int(size_bytes),
            'expires_in_seconds': AUDIO_IMPORT_TOKEN_TTL_SECONDS,
        })
    except Exception as e:
        logger.info(f"Error importing audio from URL for user {uid}: {e}")
        return jsonify({'error': 'Could not import audio from URL. Please check that the URL is accessible and try again.'}), 400

@app.route('/api/import-audio-url/release', methods=['POST'])
def release_imported_audio():
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    payload = request.get_json(silent=True) or {}
    token = str(payload.get('audio_import_token', '') or '').strip()
    if token:
        release_audio_import_token(uid, token)
    return jsonify({'ok': True})

@app.route('/upload', methods=['POST'])
def upload_files():
    decoded_token = verify_firebase_token(request)
    if not decoded_token: return jsonify({'error': 'Please sign in to continue'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not is_email_allowed(email): return jsonify({'error': 'Email not allowed'}), 403
    active_jobs = count_active_jobs_for_user(uid)
    if active_jobs >= MAX_ACTIVE_JOBS_PER_USER:
        log_rate_limit_hit('upload', 10)
        return jsonify({
            'error': f'You already have {active_jobs} active processing job(s). Please wait for one to finish before starting another.'
        }), 429
    allowed_upload, retry_after = check_rate_limit(
        key=f"upload:{uid}",
        limit=UPLOAD_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=UPLOAD_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allowed_upload:
        log_rate_limit_hit('upload', retry_after)
        return build_rate_limited_response(
            'Too many upload attempts right now. Please wait and try again.',
            retry_after,
        )
    user = get_or_create_user(uid, email)
    mode = request.form.get('mode', 'lecture-notes')
    flashcard_selection = parse_requested_amount(request.form.get('flashcard_amount', '20'), {'10', '20', '30', 'auto'}, '20')
    question_selection = parse_requested_amount(request.form.get('question_amount', '10'), {'5', '10', '15', 'auto'}, '10')
    preferred_language_key = sanitize_output_language_pref_key(user.get('preferred_output_language', DEFAULT_OUTPUT_LANGUAGE_KEY))
    preferred_language_custom = sanitize_output_language_pref_custom(user.get('preferred_output_language_custom', ''))
    output_language = parse_output_language(
        request.form.get('output_language', preferred_language_key),
        request.form.get('output_language_custom', preferred_language_custom),
    )
    study_features = parse_study_features(request.form.get('study_features', 'none'))
    interview_features = parse_interview_features(request.form.get('interview_features', 'none'))
    audio_import_token = str(request.form.get('audio_import_token', '') or '').strip()
    cleanup_expired_audio_import_tokens()
    if request.content_length and request.content_length > MAX_CONTENT_LENGTH:
        return jsonify({'error': 'Upload too large. Maximum total upload size is 560MB (up to 50MB slides file (PDF/PPTX) and 500MB audio).'}), 413
    
    if mode == 'lecture-notes':
        total_lecture = user.get('lecture_credits_standard', 0) + user.get('lecture_credits_extended', 0)
        if total_lecture <= 0:
            return jsonify({'error': 'No lecture credits remaining. Please purchase more credits.'}), 402
        if 'pdf' not in request.files:
            return jsonify({'error': 'Both slides (PDF/PPTX) and audio files are required'}), 400
        slides_file = request.files['pdf']
        uploaded_audio_file = request.files.get('audio')
        has_uploaded_audio = bool(uploaded_audio_file and uploaded_audio_file.filename)
        has_imported_audio = bool(audio_import_token)
        if not has_uploaded_audio and not has_imported_audio:
            return jsonify({'error': 'Both slides (PDF/PPTX) and audio files are required'}), 400
        if slides_file.filename == '':
            return jsonify({'error': 'Both files must be selected'}), 400
        job_id = str(uuid.uuid4())
        pdf_path, slides_error = resolve_uploaded_slides_to_pdf(slides_file, job_id)
        if slides_error:
            return jsonify({'error': slides_error}), 400

        imported_audio_used = False
        audio_path = ''
        if has_uploaded_audio:
            if not allowed_file(uploaded_audio_file.filename, ALLOWED_AUDIO_EXTENSIONS):
                cleanup_files([pdf_path], [])
                return jsonify({'error': 'Invalid audio file'}), 400
            if (uploaded_audio_file.mimetype or '').lower() not in ALLOWED_AUDIO_MIME_TYPES:
                cleanup_files([pdf_path], [])
                return jsonify({'error': 'Invalid audio content type'}), 400
            audio_path = os.path.join(UPLOAD_FOLDER, f"{job_id}_{secure_filename(uploaded_audio_file.filename)}")
            uploaded_audio_file.save(audio_path)
            if has_imported_audio:
                release_audio_import_token(uid, audio_import_token)
        else:
            audio_path, token_error = get_audio_import_token_path(uid, audio_import_token, consume=False)
            if token_error:
                cleanup_files([pdf_path], [])
                return jsonify({'error': token_error}), 400
            imported_audio_used = True

        audio_size = get_saved_file_size(audio_path)
        if audio_size <= 0 or audio_size > MAX_AUDIO_UPLOAD_BYTES:
            cleanup_files([pdf_path, audio_path], [])
            return jsonify({'error': 'Audio exceeds server limit (max 500MB) or is empty.'}), 400
        if not file_looks_like_audio(audio_path):
            cleanup_files([pdf_path, audio_path], [])
            return jsonify({'error': 'Uploaded audio file is invalid or unsupported.'}), 400
        deducted = deduct_credit(uid, 'lecture_credits_standard', 'lecture_credits_extended')
        if not deducted:
            cleanup_files([pdf_path, audio_path], [])
            return jsonify({'error': 'No lecture credits remaining.'}), 402
        if imported_audio_used:
            _consumed_path, token_error = get_audio_import_token_path(uid, audio_import_token, consume=True)
            if token_error:
                cleanup_files([pdf_path, audio_path], [])
                refund_credit(uid, deducted)
                return jsonify({'error': token_error}), 400
        total_steps = 4 if study_features != 'none' else 3
        set_job(job_id, {'status': 'starting', 'step': 0, 'step_description': 'Starting...', 'total_steps': total_steps, 'mode': 'lecture-notes', 'user_id': uid, 'user_email': email, 'credit_deducted': deducted, 'credit_refunded': False, 'started_at': time.time(), 'result': None, 'slide_text': None, 'transcript': None, 'flashcard_selection': flashcard_selection, 'question_selection': question_selection, 'study_features': study_features, 'output_language': output_language, 'flashcards': [], 'test_questions': [], 'study_generation_error': None, 'study_pack_id': None, 'error': None, 'billing_receipt': initialize_billing_receipt({deducted: 1})})
        thread = threading.Thread(target=process_lecture_notes, args=(job_id, pdf_path, audio_path))
        thread.start()
        
    elif mode == 'slides-only':
        if user.get('slides_credits', 0) <= 0:
            return jsonify({'error': 'No slides credits remaining. Please purchase more credits.'}), 402
        if 'pdf' not in request.files: return jsonify({'error': 'Slide file (PDF or PPTX) is required'}), 400
        slides_file = request.files['pdf']
        if slides_file.filename == '': return jsonify({'error': 'Slide file must be selected'}), 400
        job_id = str(uuid.uuid4())
        pdf_path, slides_error = resolve_uploaded_slides_to_pdf(slides_file, job_id)
        if slides_error:
            return jsonify({'error': slides_error}), 400
        deducted = deduct_credit(uid, 'slides_credits')
        if not deducted:
            cleanup_files([pdf_path], [])
            return jsonify({'error': 'No slides credits remaining.'}), 402
        total_steps = 2 if study_features != 'none' else 1
        set_job(job_id, {'status': 'starting', 'step': 0, 'step_description': 'Starting...', 'total_steps': total_steps, 'mode': 'slides-only', 'user_id': uid, 'user_email': email, 'credit_deducted': deducted, 'credit_refunded': False, 'started_at': time.time(), 'result': None, 'flashcard_selection': flashcard_selection, 'question_selection': question_selection, 'study_features': study_features, 'output_language': output_language, 'flashcards': [], 'test_questions': [], 'study_generation_error': None, 'study_pack_id': None, 'error': None, 'billing_receipt': initialize_billing_receipt({deducted: 1})})
        thread = threading.Thread(target=process_slides_only, args=(job_id, pdf_path))
        thread.start()
        
    elif mode == 'interview':
        total_interview = user.get('interview_credits_short', 0) + user.get('interview_credits_medium', 0) + user.get('interview_credits_long', 0)
        if total_interview <= 0:
            return jsonify({'error': 'No interview credits remaining. Please purchase more credits.'}), 402
        uploaded_audio_file = request.files.get('audio')
        has_uploaded_audio = bool(uploaded_audio_file and uploaded_audio_file.filename)
        has_imported_audio = bool(audio_import_token)
        if not has_uploaded_audio and not has_imported_audio:
            return jsonify({'error': 'Audio file is required'}), 400
        job_id = str(uuid.uuid4())
        imported_audio_used = False
        if has_uploaded_audio:
            if not allowed_file(uploaded_audio_file.filename, ALLOWED_AUDIO_EXTENSIONS):
                return jsonify({'error': 'Invalid audio file'}), 400
            if (uploaded_audio_file.mimetype or '').lower() not in ALLOWED_AUDIO_MIME_TYPES:
                return jsonify({'error': 'Invalid audio content type'}), 400
            audio_path = os.path.join(UPLOAD_FOLDER, f"{job_id}_{secure_filename(uploaded_audio_file.filename)}")
            uploaded_audio_file.save(audio_path)
            if has_imported_audio:
                release_audio_import_token(uid, audio_import_token)
        else:
            audio_path, token_error = get_audio_import_token_path(uid, audio_import_token, consume=False)
            if token_error:
                return jsonify({'error': token_error}), 400
            imported_audio_used = True

        audio_size = get_saved_file_size(audio_path)
        if audio_size <= 0 or audio_size > MAX_AUDIO_UPLOAD_BYTES:
            cleanup_files([audio_path], [])
            return jsonify({'error': 'Audio exceeds server limit (max 500MB) or is empty.'}), 400
        if not file_looks_like_audio(audio_path):
            cleanup_files([audio_path], [])
            return jsonify({'error': 'Uploaded audio file is invalid or unsupported.'}), 400
        deducted = deduct_interview_credit(uid)
        if not deducted:
            cleanup_files([audio_path], [])
            return jsonify({'error': 'No interview credits remaining.'}), 402
        interview_features_cost = len(interview_features)
        if interview_features_cost > 0:
            if user.get('slides_credits', 0) < interview_features_cost:
                refund_credit(uid, deducted)
                cleanup_files([audio_path], [])
                return jsonify({'error': f'Not enough slides credits for interview extras. You selected {interview_features_cost} option(s) and need {interview_features_cost} slides credits.'}), 402
            if not deduct_slides_credits(uid, interview_features_cost):
                refund_credit(uid, deducted)
                cleanup_files([audio_path], [])
                return jsonify({'error': 'Could not reserve slides credits for interview extras. Please try again.'}), 402
        if imported_audio_used:
            _consumed_path, token_error = get_audio_import_token_path(uid, audio_import_token, consume=True)
            if token_error:
                cleanup_files([audio_path], [])
                refund_credit(uid, deducted)
                if interview_features_cost > 0:
                    refund_slides_credits(uid, interview_features_cost)
                return jsonify({'error': token_error}), 400
        total_steps = 2 if interview_features_cost > 0 else 1
        set_job(job_id, {
            'status': 'starting',
            'step': 0,
            'step_description': 'Starting...',
            'total_steps': total_steps,
            'mode': 'interview',
            'user_id': uid,
            'user_email': email,
            'credit_deducted': deducted,
            'credit_refunded': False,
            'started_at': time.time(),
            'result': None,
            'transcript': None,
            'flashcards': [],
            'test_questions': [],
            'study_features': 'none',
            'output_language': output_language,
            'interview_features': interview_features,
            'interview_features_cost': interview_features_cost,
            'interview_features_successful': [],
            'interview_summary': None,
            'interview_sections': None,
            'interview_combined': None,
            'extra_slides_refunded': 0,
            'study_generation_error': None,
            'error': None,
            'billing_receipt': initialize_billing_receipt({deducted: 1, 'slides_credits': interview_features_cost}),
        })
        thread = threading.Thread(target=process_interview_transcription, args=(job_id, audio_path))
        thread.start()
    else:
        return jsonify({'error': 'Invalid mode selected'}), 400

    created_job = get_job_snapshot(job_id) or {}
    log_analytics_event(
        'processing_started_backend',
        source='backend',
        uid=uid,
        email=email,
        session_id=job_id,
        properties={
            'job_id': job_id,
            'mode': created_job.get('mode', mode),
            'study_features': created_job.get('study_features', 'none'),
            'interview_features_count': len(created_job.get('interview_features', [])) if isinstance(created_job.get('interview_features'), list) else 0,
        },
        created_at=created_job.get('started_at', time.time()),
    )

    return jsonify({'job_id': job_id})

@app.route('/status/<job_id>')
def get_status(job_id):
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    job = get_job_snapshot(job_id)
    if not job:
        cleanup_old_jobs()  # Attempt cleanup before returning not-found
        job = get_job_snapshot(job_id)
        if not job:
            return jsonify({
                'error': 'Job not found. It may have expired after a server update. Please re-upload your file to try again.',
                'job_lost': True,
            }), 404
    if job.get('user_id', '') != uid and not is_admin_user(decoded_token):
        return jsonify({'error': 'Forbidden'}), 403
    response = {'status': job['status'], 'step': job['step'], 'step_description': job['step_description'], 'total_steps': job.get('total_steps', 3), 'mode': job.get('mode', 'lecture-notes')}
    billing_receipt = get_billing_receipt_snapshot(job)
    if billing_receipt.get('charged') or billing_receipt.get('refunded'):
        response['billing_receipt'] = billing_receipt
    if job['status'] == 'complete':
        response['result'] = job['result']
        response['flashcards'] = job.get('flashcards', [])
        response['test_questions'] = job.get('test_questions', [])
        response['study_generation_error'] = job.get('study_generation_error')
        response['study_pack_id'] = job.get('study_pack_id')
        response['study_features'] = job.get('study_features', 'none')
        response['output_language'] = job.get('output_language', 'English')
        response['interview_features'] = job.get('interview_features', [])
        response['interview_features_successful'] = job.get('interview_features_successful', [])
        response['interview_summary'] = job.get('interview_summary')
        response['interview_sections'] = job.get('interview_sections')
        response['interview_combined'] = job.get('interview_combined')
        if job.get('mode') == 'lecture-notes':
            response['slide_text'] = job.get('slide_text')
            response['transcript'] = job.get('transcript')
        if job.get('mode') == 'interview':
            response['transcript'] = job.get('transcript')
    elif job['status'] == 'error':
        response['error'] = job['error']
        response['credit_refunded'] = job.get('credit_refunded', False)
    return jsonify(response)

@app.route('/download-docx/<job_id>')
def download_docx(job_id):
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    job = get_job_snapshot(job_id)
    if not job:
        return jsonify({'error': 'Job not found'}), 404
    if job.get('user_id', '') != uid and not is_admin_user(decoded_token):
        return jsonify({'error': 'Forbidden'}), 403
    if job['status'] != 'complete': return jsonify({'error': 'Job not complete'}), 400
    content_type = request.args.get('type', 'result')
    ALLOWED_CONTENT_TYPES = {'result', 'slides', 'transcript', 'summary', 'sections', 'combined'}
    if content_type not in ALLOWED_CONTENT_TYPES:
        content_type = 'result'
    
    if content_type == 'slides' and job.get('slide_text'):
        content, filename, title = job['slide_text'], 'slide-extract.docx', 'Slide Extract'
    elif content_type == 'transcript' and job.get('transcript'):
        content, filename, title = job['transcript'], 'lecture-transcript.docx', 'Lecture Transcript'
    elif content_type == 'summary' and job.get('interview_summary'):
        content, filename, title = job['interview_summary'], 'interview-summary.docx', 'Interview Summary'
    elif content_type == 'sections' and job.get('interview_sections'):
        content, filename, title = job['interview_sections'], 'interview-structured.docx', 'Structured Interview Transcript'
    elif content_type == 'combined' and job.get('interview_combined'):
        content, filename, title = job['interview_combined'], 'interview-summary-structured.docx', 'Interview Summary + Structured Transcript'
    else:
        content = job['result']
        mode = job.get('mode', 'lecture-notes')
        if mode == 'lecture-notes': filename, title = 'lecture-notes.docx', 'Lecture Notes'
        elif mode == 'slides-only': filename, title = 'slide-extract.docx', 'Slide Extract'
        else: filename, title = 'interview-transcript.docx', 'Interview Transcript'
        
    doc = markdown_to_docx(content, title)
    docx_io = io.BytesIO()
    doc.save(docx_io)
    docx_io.seek(0)
    return send_file(docx_io, mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document', as_attachment=True, download_name=filename)

@app.route('/download-flashcards-csv/<job_id>')
def download_flashcards_csv(job_id):
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    job = get_job_snapshot(job_id)
    if not job:
        return jsonify({'error': 'Job not found'}), 404
    if job.get('user_id', '') != uid and not is_admin_user(decoded_token):
        return jsonify({'error': 'Forbidden'}), 403
    if job.get('status') != 'complete':
        return jsonify({'error': 'Job not complete'}), 400
    export_type = request.args.get('type', 'flashcards').strip().lower()

    output = io.StringIO()
    writer = csv.writer(output)
    if export_type == 'test':
        test_questions = job.get('test_questions', [])
        if not test_questions:
            return jsonify({'error': 'No practice questions available for this job'}), 400
        writer.writerow(['question', 'option_a', 'option_b', 'option_c', 'option_d', 'answer', 'explanation'])
        for q in test_questions:
            options = q.get('options', [])
            padded = (options + ['', '', '', ''])[:4]
            writer.writerow([
                q.get('question', ''),
                padded[0],
                padded[1],
                padded[2],
                padded[3],
                q.get('answer', ''),
                q.get('explanation', ''),
            ])
        filename = f'practice-test-{job_id}.csv'
    else:
        flashcards = job.get('flashcards', [])
        if not flashcards:
            return jsonify({'error': 'No flashcards available for this job'}), 400
        writer.writerow(['question', 'answer'])
        for card in flashcards:
            writer.writerow([card.get('front', ''), card.get('back', '')])
        filename = f'flashcards-{job_id}.csv'

    csv_bytes = io.BytesIO(output.getvalue().encode('utf-8'))
    csv_bytes.seek(0)
    return send_file(csv_bytes, mimetype='text/csv', as_attachment=True, download_name=filename)

@app.route('/api/study-packs/<pack_id>/export-flashcards-csv', methods=['GET'])
def export_study_pack_flashcards_csv(pack_id):
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    try:
        doc = db.collection('study_packs').document(pack_id).get()
        if not doc.exists:
            return jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return jsonify({'error': 'Forbidden'}), 403
        export_type = request.args.get('type', 'flashcards').strip().lower()
        output = io.StringIO()
        writer = csv.writer(output)
        if export_type == 'test':
            test_questions = pack.get('test_questions', [])
            if not test_questions:
                return jsonify({'error': 'No practice questions available'}), 400
            writer.writerow(['question', 'option_a', 'option_b', 'option_c', 'option_d', 'answer', 'explanation'])
            for q in test_questions:
                options = q.get('options', [])
                padded = (options + ['', '', '', ''])[:4]
                writer.writerow([
                    q.get('question', ''),
                    padded[0],
                    padded[1],
                    padded[2],
                    padded[3],
                    q.get('answer', ''),
                    q.get('explanation', ''),
                ])
            filename = f'study-pack-{pack_id}-practice-test.csv'
        else:
            flashcards = pack.get('flashcards', [])
            if not flashcards:
                return jsonify({'error': 'No flashcards available'}), 400
            writer.writerow(['question', 'answer'])
            for card in flashcards:
                writer.writerow([card.get('front', ''), card.get('back', '')])
            filename = f'study-pack-{pack_id}-flashcards.csv'
        csv_bytes = io.BytesIO(output.getvalue().encode('utf-8'))
        csv_bytes.seek(0)
        return send_file(csv_bytes, mimetype='text/csv', as_attachment=True, download_name=filename)
    except Exception as e:
        logger.info(f"Error exporting study pack flashcards CSV {pack_id}: {e}")
        return jsonify({'error': 'Could not export CSV'}), 500

@app.route('/api/study-packs/<pack_id>/export-notes', methods=['GET'])
def export_study_pack_notes(pack_id):
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    try:
        doc = db.collection('study_packs').document(pack_id).get()
        if not doc.exists:
            return jsonify({'error': 'Study pack not found'}), 404
        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return jsonify({'error': 'Forbidden'}), 403

        notes_markdown = str(pack.get('notes_markdown', '') or '').strip()
        if not notes_markdown:
            return jsonify({'error': 'No integrated notes available'}), 400

        export_format = request.args.get('format', 'docx').strip().lower()
        base_name = f"study-pack-{pack_id}-notes"
        pack_title = str(pack.get('title', 'Lecture Notes') or 'Lecture Notes').strip()

        if export_format == 'md':
            md_bytes = io.BytesIO(notes_markdown.encode('utf-8'))
            md_bytes.seek(0)
            return send_file(
                md_bytes,
                mimetype='text/markdown',
                as_attachment=True,
                download_name=f"{base_name}.md"
            )

        if export_format == 'docx':
            docx = markdown_to_docx(notes_markdown, pack_title)
            docx_bytes = io.BytesIO()
            docx.save(docx_bytes)
            docx_bytes.seek(0)
            return send_file(
                docx_bytes,
                mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                as_attachment=True,
                download_name=f"{base_name}.docx"
            )

        return jsonify({'error': 'Invalid format'}), 400
    except Exception as e:
        logger.info(f"Error exporting study pack notes {pack_id}: {e}")
        return jsonify({'error': 'Could not export notes'}), 500

@app.route('/api/study-packs/<pack_id>/export-pdf', methods=['GET'])
def export_study_pack_pdf(pack_id):
    decoded_token = verify_firebase_token(request)
    if not decoded_token:
        return jsonify({'error': 'Unauthorized'}), 401

    if not REPORTLAB_AVAILABLE:
        return jsonify({
            'error': "PDF export is currently unavailable on this server. Install dependency: pip install reportlab==4.2.5"
        }), 503

    uid = decoded_token['uid']
    try:
        doc = db.collection('study_packs').document(pack_id).get()
        if not doc.exists:
            return jsonify({'error': 'Study pack not found'}), 404

        pack = doc.to_dict()
        if pack.get('uid', '') != uid:
            return jsonify({'error': 'Forbidden'}), 403

        include_answers_raw = str(request.args.get('include_answers', '1')).strip().lower()
        include_answers = include_answers_raw in {'1', 'true', 'yes', 'on'}
        pdf_io = build_study_pack_pdf(pack, include_answers=include_answers)
        filename_suffix = '' if include_answers else '-no-answers'
        return send_file(
            pdf_io,
            mimetype='application/pdf',
            as_attachment=True,
            download_name=f"study-pack-{pack_id}{filename_suffix}.pdf"
        )
    except Exception as e:
        logger.info(f"Error exporting study pack PDF {pack_id}: {e}")
        return jsonify({'error': 'Could not export PDF'}), 500

# =============================================
# HEALTH CHECK (Issue 38)
# =============================================
@app.route('/healthz')
def healthz():
    return jsonify({'status': 'ok'}), 200

if __name__ == '__main__':
    app.run(debug=True, port=5000)
