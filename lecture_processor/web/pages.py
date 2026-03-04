from __future__ import annotations

from flask import Blueprint, abort, redirect, render_template, request

from lecture_processor.domains.auth import session as auth_session
from lecture_processor.runtime.container import get_runtime


pages_bp = Blueprint('pages', __name__)


@pages_bp.route('/')
def index():
    return render_template('landing.html')


@pages_bp.route('/dashboard')
def dashboard():
    runtime = get_runtime()
    return render_template(
        'dashboard.html',
        dashboard_js_asset=runtime.resolve_js_asset('js/dashboard.js'),
        sentry_frontend_dsn=runtime.SENTRY_FRONTEND_DSN,
        sentry_environment=runtime.SENTRY_ENVIRONMENT,
        sentry_release=runtime.SENTRY_RELEASE,
    )


def _render_processing_page(forced_mode: str):
    runtime = get_runtime()
    return render_template(
        'index.html',
        forced_mode=forced_mode,
        sentry_frontend_dsn=runtime.SENTRY_FRONTEND_DSN,
        sentry_environment=runtime.SENTRY_ENVIRONMENT,
        sentry_release=runtime.SENTRY_RELEASE,
        index_js_asset=runtime.resolve_js_asset('js/index-app.js'),
    )


@pages_bp.route('/plan')
@pages_bp.route('/stats')
def plan_dashboard():
    return render_template('plan.html')


@pages_bp.route('/calendar')
def calendar_dashboard():
    return render_template('calendar.html')


@pages_bp.route('/features')
def features_page():
    return render_template('features.html')


@pages_bp.route('/tools')
def tools_page():
    return render_template('tools.html')


@pages_bp.route('/lecture-notes')
def lecture_notes_page():
    return _render_processing_page('lecture-notes')


@pages_bp.route('/slides-extraction')
def slides_extraction_page():
    return _render_processing_page('slides-only')


@pages_bp.route('/interview-transcription')
def interview_transcription_page():
    return _render_processing_page('interview')


@pages_bp.route('/document-reader')
def document_reader_page():
    runtime = get_runtime()
    return render_template(
        'reader.html',
        reader_title='Document Reader',
        reader_subtitle='Extract notes and answers from documents with optional question prompts.',
        reader_source='document',
        reader_js_asset=runtime.resolve_js_asset('js/reader.js'),
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
    )


@pages_bp.route('/buy_credits')
def buy_credits_page():
    runtime = get_runtime()
    return render_template(
        'buy_credits.html',
        buy_credits_js_asset=runtime.resolve_js_asset('js/buy-credits.js'),
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
    return render_template('study.html', study_js_asset=runtime.resolve_js_asset('js/study.js'))


@pages_bp.route('/privacy')
def privacy_policy():
    runtime = get_runtime()
    return render_template(
        'privacy.html',
        legal_contact_email=runtime.LEGAL_CONTACT_EMAIL,
        last_updated='February 26, 2026',
    )


@pages_bp.route('/terms')
def terms_of_service():
    runtime = get_runtime()
    return render_template(
        'terms.html',
        legal_contact_email=runtime.LEGAL_CONTACT_EMAIL,
        last_updated='February 26, 2026',
    )
