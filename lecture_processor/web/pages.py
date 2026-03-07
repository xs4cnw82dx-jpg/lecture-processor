from __future__ import annotations

from flask import Blueprint, abort, redirect, render_template, request

from lecture_processor.domains.auth import session as auth_session
from lecture_processor.runtime.container import get_runtime


pages_bp = Blueprint('pages', __name__)


def _public_context(*, runtime) -> dict:
    return {
        'legal_contact_email': runtime.LEGAL_CONTACT_EMAIL,
    }


def _shell_context(*, runtime, page_key: str, show_credits_pill: bool = False) -> dict:
    return {
        'shell_page_key': page_key,
        'shell_show_credits_pill': bool(show_credits_pill),
        'legal_contact_email': runtime.LEGAL_CONTACT_EMAIL,
    }


@pages_bp.route('/')
def index():
    runtime = get_runtime()
    auth_view = str(request.args.get('auth', '') or '').strip().lower()
    if auth_view in {'signin', 'signup', 'reset'}:
        return redirect(f'/lecture-notes?auth={auth_view}')
    return render_template('landing.html', **_public_context(runtime=runtime))


@pages_bp.route('/dashboard')
def dashboard():
    runtime = get_runtime()
    return render_template(
        'dashboard.html',
        dashboard_js_asset=runtime.resolve_js_asset('js/dashboard.js'),
        sentry_frontend_dsn=runtime.SENTRY_FRONTEND_DSN,
        sentry_environment=runtime.SENTRY_ENVIRONMENT,
        sentry_release=runtime.SENTRY_RELEASE,
        **_shell_context(runtime=runtime, page_key='dashboard', show_credits_pill=True),
    )


def _render_processing_page(forced_mode: str):
    runtime = get_runtime()
    page_key = {
        'lecture-notes': 'lecture-notes',
        'slides-only': 'slides-extraction',
        'interview': 'interview-transcription',
    }.get(forced_mode, 'extraction')
    return render_template(
        'index.html',
        forced_mode=forced_mode,
        sentry_frontend_dsn=runtime.SENTRY_FRONTEND_DSN,
        sentry_environment=runtime.SENTRY_ENVIRONMENT,
        sentry_release=runtime.SENTRY_RELEASE,
        sentry_capture_local=runtime.SENTRY_CAPTURE_LOCAL,
        index_js_asset=runtime.resolve_js_asset('js/index-app.js'),
        **_shell_context(runtime=runtime, page_key=page_key),
    )


def _render_batch_page(forced_mode: str):
    runtime = get_runtime()
    page_key = {
        'lecture-notes': 'batch-mode',
        'slides-only': 'batch-mode-slides',
        'interview': 'batch-mode-interview',
    }.get(forced_mode, 'batch-mode')
    return render_template(
        'batch_mode.html',
        forced_mode=forced_mode,
        batch_mode_js_asset=runtime.resolve_js_asset('js/batch-mode.js'),
        **_shell_context(runtime=runtime, page_key=page_key),
    )


@pages_bp.route('/plan')
@pages_bp.route('/stats')
def plan_dashboard():
    runtime = get_runtime()
    return render_template(
        'plan.html',
        **_shell_context(runtime=runtime, page_key='plan'),
    )


@pages_bp.route('/calendar')
def calendar_dashboard():
    runtime = get_runtime()
    return render_template(
        'calendar.html',
        **_shell_context(runtime=runtime, page_key='calendar'),
    )


@pages_bp.route('/features')
def features_page():
    runtime = get_runtime()
    return render_template('features.html', **_public_context(runtime=runtime))


@pages_bp.route('/helpcenter')
def help_center_page():
    runtime = get_runtime()
    return render_template('helpcenter.html', **_public_context(runtime=runtime))


@pages_bp.route('/FAQ')
def faq_page():
    runtime = get_runtime()
    return render_template('faq.html', **_public_context(runtime=runtime))


@pages_bp.route('/faq')
def faq_page_lowercase():
    return redirect('/FAQ', code=302)


@pages_bp.route('/tools')
def tools_page():
    runtime = get_runtime()
    return render_template(
        'tools.html',
        **_shell_context(runtime=runtime, page_key='tools'),
    )


@pages_bp.route('/lecture-notes')
def lecture_notes_page():
    return _render_processing_page('lecture-notes')


@pages_bp.route('/slides-extraction')
def slides_extraction_page():
    return _render_processing_page('slides-only')


@pages_bp.route('/interview-transcription')
def interview_transcription_page():
    return _render_processing_page('interview')


@pages_bp.route('/batch_mode')
def batch_mode_page():
    return _render_batch_page('lecture-notes')


@pages_bp.route('/batch_mode_interview_transcription')
def batch_mode_interview_page():
    return _render_batch_page('interview')


@pages_bp.route('/batch_mode_slides_extraction')
def batch_mode_slides_page():
    return _render_batch_page('slides-only')


@pages_bp.route('/batch_dashboard')
def batch_dashboard_page():
    runtime = get_runtime()
    return render_template(
        'batch_dashboard.html',
        batch_dashboard_js_asset=runtime.resolve_js_asset('js/batch-dashboard.js'),
        **_shell_context(runtime=runtime, page_key='batch-dashboard', show_credits_pill=True),
    )


@pages_bp.route('/document-reader')
def document_reader_page():
    runtime = get_runtime()
    return render_template(
        'reader.html',
        reader_title='Document Reader',
        reader_subtitle='Extract notes and answers from documents with optional question prompts.',
        reader_source='document',
        reader_js_asset=runtime.resolve_js_asset('js/reader.js'),
        **_shell_context(runtime=runtime, page_key='document-reader'),
    )


@pages_bp.route('/image-reader')
def image_reader_page():
    runtime = get_runtime()
    return render_template(
        'reader.html',
        reader_title='Image Reader',
        reader_subtitle='Extract text and structured notes from up to five images per run.',
        reader_source='image',
        reader_js_asset=runtime.resolve_js_asset('js/reader.js'),
        **_shell_context(runtime=runtime, page_key='image-reader'),
    )


@pages_bp.route('/url-reader')
def url_reader_page():
    runtime = get_runtime()
    return render_template(
        'reader.html',
        reader_title='URL Reader',
        reader_subtitle='Analyze public webpage content with a focused question prompt.',
        reader_source='url',
        reader_js_asset=runtime.resolve_js_asset('js/reader.js'),
        **_shell_context(runtime=runtime, page_key='url-reader'),
    )


@pages_bp.route('/buy_credits')
def buy_credits_page():
    runtime = get_runtime()
    return render_template(
        'buy_credits.html',
        buy_credits_js_asset=runtime.resolve_js_asset('js/buy-credits.js'),
        **_shell_context(runtime=runtime, page_key='buy-credits', show_credits_pill=True),
    )


@pages_bp.route('/admin')
def admin_dashboard():
    runtime = get_runtime()
    decoded_token = auth_session.verify_admin_session_cookie(request, runtime=runtime)
    if not decoded_token:
        if runtime.ADMIN_PAGE_UNAUTHORIZED_MODE == '404':
            abort(404)
        return redirect('/dashboard')
    return render_template('admin.html', admin_js_asset=runtime.resolve_js_asset('js/admin.js'))


@pages_bp.route('/study')
def study_dashboard():
    runtime = get_runtime()
    return render_template(
        'study.html',
        study_js_asset=runtime.resolve_js_asset('js/study.js'),
        **_shell_context(runtime=runtime, page_key='study'),
    )


@pages_bp.route('/privacy')
def privacy_policy():
    runtime = get_runtime()
    return render_template(
        'privacy.html',
        **_public_context(runtime=runtime),
        last_updated='February 26, 2026',
    )


@pages_bp.route('/terms')
def terms_of_service():
    runtime = get_runtime()
    return render_template(
        'terms.html',
        **_public_context(runtime=runtime),
        last_updated='February 26, 2026',
    )
