from __future__ import annotations

from flask import Blueprint, abort, redirect, render_template, request

from lecture_processor.runtime.container import get_runtime


pages_bp = Blueprint('pages', __name__)


@pages_bp.route('/')
def index():
    return render_template('landing.html')


@pages_bp.route('/dashboard')
def dashboard():
    runtime = get_runtime()
    return render_template(
        'index.html',
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
    runtime = get_runtime()
    return render_template('tools.html', tools_js_asset=runtime.resolve_js_asset('js/tools.js'))


@pages_bp.route('/admin')
def admin_dashboard():
    runtime = get_runtime()
    decoded_token = runtime.verify_admin_session_cookie(request)
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
