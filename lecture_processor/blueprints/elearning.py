"""Routes for xPEDitie Pijn E-Learning Studio, Translation Mode, and Public Learner Player."""
from __future__ import annotations

import logging
import os

from flask import Blueprint, current_app, g, jsonify, render_template, request
from google.api_core.exceptions import GoogleAPICallError
from werkzeug.exceptions import RequestEntityTooLarge

from lecture_processor.domains.books.model import BookError
from lecture_processor.domains.elearning.model import ElearningError
from lecture_processor.domains.rate_limit import limiter
from lecture_processor.runtime.container import get_runtime
from lecture_processor.runtime.http_security import build_content_security_policy
from lecture_processor.services import elearning_service as service

elearning_bp = Blueprint('elearning', __name__)
logger = logging.getLogger(__name__)

_VIDEO_FRAME_SOURCES = (
    'https://www.youtube-nocookie.com',
    'https://player.vimeo.com',
)


@elearning_bp.before_request
def _guard_rate_limits():
    if request.path.startswith('/api/elearning') and request.method in ('POST', 'PUT', 'DELETE'):
        runtime = get_runtime()
        # Bound public submissions independently of the app-wide lecture upload limit.
        if request.endpoint == 'elearning.api_expedition_upload_asset':
            request.max_content_length = service.MAX_AUDIO_BYTES + 1024 * 1024
        elif request.endpoint == 'elearning.api_public_submit':
            request.max_content_length = 512 * 1024
        else:
            request.max_content_length = 2 * 1024 * 1024
        is_public = request.path.startswith('/api/elearning/public/')
        allowed, retry = limiter.check_rate_limit(
            key='elearning:' + ('public:' if is_public else 'write:') + (request.remote_addr or 'unknown'),
            limit=60 if is_public else 180,
            window_seconds=60,
            runtime=runtime,
        )
        if not allowed:
            return jsonify(error='Please wait a moment before trying again.'), 429, {'Retry-After': str(retry)}


@elearning_bp.after_request
def _apply_video_frame_csp(response):
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['Referrer-Policy'] = 'strict-origin'
    if not request.path.startswith('/api/') and not current_app.config.get('XPED_ACADEMY'):
        runtime = get_runtime()
        response.headers['Content-Security-Policy'] = build_content_security_policy(
            sentry_frontend_dsn=runtime.SENTRY_FRONTEND_DSN,
            script_nonce=getattr(g, 'csp_nonce', ''),
            extra_frame_sources=_VIDEO_FRAME_SOURCES,
        )
    return response


@elearning_bp.errorhandler(RequestEntityTooLarge)
def _request_too_large(_error):
    messages = {
        'elearning.api_public_submit': 'This learning response is too large to save.',
        'elearning.api_expedition_upload_asset': 'Choose an image of at most 10 MB or audio of at most 15 MB.',
    }
    return jsonify(error=messages.get(request.endpoint, 'This expedition update is too large to save.')), 413


@elearning_bp.errorhandler(BookError)
@elearning_bp.errorhandler(ElearningError)
def _handle_elearning_error(error: ElearningError):
    if error.status >= 409:
        logger.info('E-learning request declined: status=%s endpoint=%s', error.status, request.endpoint)
    details = {'error': str(error)}
    if current_app.config.get('XPED_ACADEMY') and getattr(error, 'code', ''):
        details['error_code'] = error.code
    return jsonify(details), error.status


@elearning_bp.errorhandler(GoogleAPICallError)
@elearning_bp.errorhandler(RuntimeError)
def _handle_unavailable(error):
    logger.warning('E-learning storage unavailable: %s', type(error).__name__)
    return jsonify(error='Cloud saving is temporarily unavailable. Please try again in a moment.'), 503


# --- Page Routes ---


def _studio_context(runtime):
    if current_app.config.get('XPED_ACADEMY'):
        return {}
    from lecture_processor.web.pages import _shell_context

    return _shell_context(runtime=runtime, page_key='physio-elearning')


@elearning_bp.route('/physio/elearning')
def studio_dashboard_page(template='elearning_dashboard.html', **page_context):
    runtime = get_runtime()
    return render_template(
        template,
        **page_context,
        elearning_model_js=runtime.resolve_js_asset('js/elearning-model.js'),
        elearning_icons_js=runtime.resolve_js_asset('js/elearning-icons.js'),
        elearning_admin_js=runtime.resolve_js_asset('js/elearning-admin.js'),
        elearning_dashboard_js=runtime.resolve_js_asset('js/elearning-dashboard.js'),
        **_studio_context(runtime),
    )


@elearning_bp.route('/physio/elearning/<expedition_id>/edit')
def studio_builder_page(expedition_id: str, template='elearning_builder.html', initial_mode='edit'):
    runtime = get_runtime()
    return render_template(
        template,
        expedition_id=expedition_id,
        grant_token='',
        initial_mode=initial_mode,
        elearning_model_js=runtime.resolve_js_asset('js/elearning-model.js'),
        elearning_icons_js=runtime.resolve_js_asset('js/elearning-icons.js'),
        elearning_qr_js=runtime.resolve_js_asset('js/elearning-qr.js'),
        elearning_route_map_js=runtime.resolve_js_asset('js/elearning-route-map.js'),
        elearning_blocks_js=runtime.resolve_js_asset('js/elearning-blocks.js'),
        elearning_builder_js=runtime.resolve_js_asset('js/elearning-builder.js'),
        **_studio_context(runtime),
    )


@elearning_bp.route('/elearning/translate/<grant_token>')
def translator_page(grant_token: str, template='elearning_builder.html'):
    runtime = get_runtime()
    return render_template(
        template,
        expedition_id='',
        grant_token=grant_token,
        initial_mode='translate',
        elearning_model_js=runtime.resolve_js_asset('js/elearning-model.js'),
        elearning_icons_js=runtime.resolve_js_asset('js/elearning-icons.js'),
        elearning_qr_js=runtime.resolve_js_asset('js/elearning-qr.js'),
        elearning_route_map_js=runtime.resolve_js_asset('js/elearning-route-map.js'),
        elearning_blocks_js=runtime.resolve_js_asset('js/elearning-blocks.js'),
        elearning_builder_js=runtime.resolve_js_asset('js/elearning-builder.js'),
        **_studio_context(runtime),
    )


@elearning_bp.route('/physio/elearning/<expedition_id>/responses')
def studio_responses_page(expedition_id: str, template='elearning_responses.html'):
    runtime = get_runtime()
    return render_template(
        template,
        expedition_id=expedition_id,
        elearning_model_js=runtime.resolve_js_asset('js/elearning-model.js'),
        elearning_icons_js=runtime.resolve_js_asset('js/elearning-icons.js'),
        elearning_responses_js=runtime.resolve_js_asset('js/elearning-responses.js'),
        **_studio_context(runtime),
    )


@elearning_bp.route('/elearning/p/<share_token>')
def public_player_page(share_token: str):
    runtime = get_runtime()
    initial_course = None
    player_error = None
    if current_app.config.get('XPED_ACADEMY'):
        from lecture_processor.blueprints.academy_language import learner_language
        try:
            initial_course = service.public_payload(runtime, share_token)
        except ElearningError as exc:
            player_error = {'status': exc.status, 'message': str(exc), 'code': getattr(exc, 'code', '')}
        except (GoogleAPICallError, RuntimeError):
            player_error = {'status': 503, 'message': '', 'code': 'temporarily_unavailable'}
        available = initial_course['enabledLanguages'] if initial_course else ('nl', 'de')
        g.academy_player_language = learner_language(available)
        if player_error:
            return render_template('academy/learner_error.html', academy_player_error=player_error), player_error['status']
    return render_template(
        'elearning_player.html',
        share_token=share_token,
        academy_initial_course=initial_course,
        elearning_model_js=runtime.resolve_js_asset('js/elearning-model.js'),
        elearning_icons_js=runtime.resolve_js_asset('js/elearning-icons.js'),
        elearning_route_map_js=runtime.resolve_js_asset('js/elearning-route-map.js'),
        elearning_blocks_js=runtime.resolve_js_asset('js/elearning-blocks.js'),
        elearning_player_js=runtime.resolve_js_asset('js/elearning-player.js'),
        public_base_url=os.getenv('PUBLIC_BASE_URL', ''),
    )


# --- Studio REST API ---

@elearning_bp.route('/api/elearning/expeditions', methods=['GET', 'POST'])
def api_expeditions():
    runtime = get_runtime()
    if request.method == 'POST':
        return service.create_expedition(runtime)
    return service.list_expeditions(runtime)


@elearning_bp.get('/api/elearning/admin/statistics')
def api_studio_statistics():
    return service.studio_statistics(get_runtime())


@elearning_bp.route('/api/elearning/admin/expeditions/<expedition_id>/sharing', methods=['GET', 'POST'])
def api_studio_admin_sharing(expedition_id: str):
    return service.sharing(get_runtime(), expedition_id, admin=True)


@elearning_bp.get('/api/elearning/expeditions/<expedition_id>/content-export')
def api_course_content_export(expedition_id: str):
    return service.export_course_content(get_runtime(), expedition_id)


@elearning_bp.route('/api/elearning/import-preview', methods=['POST'])
def api_import_preview():
    return service.preview_import(get_runtime())


@elearning_bp.route('/api/elearning/grant-session', methods=['POST'])
def api_grant_session():
    return service.exchange_grant(get_runtime())


@elearning_bp.route('/api/elearning/expeditions/<expedition_id>', methods=['GET', 'PUT', 'DELETE'])
def api_expedition_detail(expedition_id: str):
    runtime = get_runtime()
    if request.method == 'PUT':
        return service.save_expedition(runtime, expedition_id)
    if request.method == 'DELETE':
        return service.delete_expedition(runtime, expedition_id)
    return service.get_expedition(runtime, expedition_id)


@elearning_bp.route('/api/elearning/expeditions/<expedition_id>/duplicate', methods=['POST'])
def api_expedition_duplicate(expedition_id: str):
    return service.duplicate_expedition(get_runtime(), expedition_id)


@elearning_bp.route('/api/elearning/expeditions/<expedition_id>/revision', methods=['GET'])
def api_expedition_revision(expedition_id: str):
    return service.revision(get_runtime(), expedition_id)


@elearning_bp.route('/api/elearning/expeditions/<expedition_id>/lease', methods=['POST'])
def api_expedition_lease(expedition_id: str):
    return service.lease(get_runtime(), expedition_id)


@elearning_bp.route('/api/elearning/expeditions/<expedition_id>/sharing', methods=['GET', 'POST'])
def api_expedition_sharing(expedition_id: str):
    return service.sharing(get_runtime(), expedition_id)


@elearning_bp.route('/api/elearning/expeditions/<expedition_id>/translations', methods=['POST'])
def api_expedition_translations(expedition_id: str):
    return service.save_translations(get_runtime(), expedition_id)


@elearning_bp.route('/api/elearning/expeditions/<expedition_id>/translations/export.csv', methods=['GET'])
def api_expedition_translations_export(expedition_id: str):
    return service.export_translations_csv(get_runtime(), expedition_id)


@elearning_bp.route('/api/elearning/expeditions/<expedition_id>/translations/import', methods=['POST'])
def api_expedition_translations_import(expedition_id: str):
    return service.import_translations_csv(get_runtime(), expedition_id)


@elearning_bp.route('/api/elearning/expeditions/<expedition_id>/assets', methods=['GET', 'POST'])
def api_expedition_upload_asset(expedition_id: str):
    if request.method == 'POST':
        return service.upload_asset(get_runtime(), expedition_id)
    return service.unused_assets(get_runtime(), expedition_id)


@elearning_bp.route('/api/elearning/expeditions/<expedition_id>/assets/<asset_id>', methods=['GET', 'DELETE'])
def api_expedition_asset(expedition_id: str, asset_id: str):
    runtime = get_runtime()
    if request.method == 'DELETE':
        return service.delete_asset(runtime, expedition_id, asset_id)
    return service.get_asset(runtime, expedition_id, asset_id)


@elearning_bp.route('/api/elearning/expeditions/<expedition_id>/responses', methods=['GET'])
def api_expedition_responses(expedition_id: str):
    return service.get_responses(get_runtime(), expedition_id)


@elearning_bp.route('/api/elearning/expeditions/<expedition_id>/responses/export.csv', methods=['GET'])
def api_expedition_responses_csv(expedition_id: str):
    return service.export_responses_csv(get_runtime(), expedition_id)


# --- Public Zero-Login Learner API ---

@elearning_bp.route('/api/elearning/public/<share_token>', methods=['GET'])
def api_public_expedition(share_token: str):
    return service.public_get_expedition(get_runtime(), share_token)


@elearning_bp.route('/api/elearning/public/<share_token>/assets/<asset_id>', methods=['GET'])
def api_public_asset(share_token: str, asset_id: str):
    return service.public_get_asset(get_runtime(), share_token, asset_id)


@elearning_bp.route('/api/elearning/public/<share_token>/responses', methods=['POST'])
def api_public_submit(share_token: str):
    return service.public_submit_response(get_runtime(), share_token)


@elearning_bp.route('/api/elearning/public/<share_token>/aggregates/<block_id>', methods=['GET'])
def api_public_aggregates(share_token: str, block_id: str):
    return service.public_get_aggregates(get_runtime(), share_token, block_id)
