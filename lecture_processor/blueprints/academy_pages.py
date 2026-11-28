"""Public page URLs for the standalone Academy. The shared APIs keep their contracts."""
from flask import Blueprint, redirect, render_template, request, url_for

from lecture_processor.blueprints import elearning

academy_pages = Blueprint('academy', __name__)

# Bookmarks, printed QR codes and previously created translator links.
_LEGACY_ENDPOINTS = {
    'elearning.studio_dashboard_page': 'academy.library',
    'elearning.studio_builder_page': 'academy.builder',
    'elearning.studio_responses_page': 'academy.report',
    'elearning.public_player_page': 'academy.player',
    'elearning.translator_page': 'academy.translator',
    'academy_account.account_page': 'academy.settings',
}


@academy_pages.before_app_request
def legacy_page():
    destination = _LEGACY_ENDPOINTS.get(request.endpoint)
    if destination:
        return _redirect_page(destination, **(request.view_args or {}))


def _redirect_page(destination, **route_args):
    path = url_for(destination, **route_args)
    if request.query_string:
        path += '?' + request.query_string.decode('latin-1')
    return redirect(path, code=301)


@academy_pages.get('/')
def home():
    return elearning.studio_dashboard_page(['academy/home.html', 'academy/library.html'], academy_view='home')


@academy_pages.get('/expedities')
def library():
    return elearning.studio_dashboard_page('academy/library.html', academy_view='library')


@academy_pages.get('/expedities/<expedition_id>')
def course(expedition_id):
    return elearning.studio_dashboard_page(
        ['academy/course.html', 'academy/library.html'], academy_view='course', expedition_id=expedition_id,
    )


@academy_pages.get('/expedities/<expedition_id>/bewerken')
def builder(expedition_id):
    return elearning.studio_builder_page(
        expedition_id, 'academy/builder.html',
        initial_mode='translate' if request.args.get('modus') == 'vertalen' else 'edit',
    )


@academy_pages.get('/expedities/<expedition_id>/resultaten')
def report(expedition_id):
    return elearning.studio_responses_page(expedition_id, 'academy/report.html')


@academy_pages.get('/resultaten')
def results():
    return render_template('academy/results_index.html', academy_view='results')


@academy_pages.get('/vertalingen')
def translations():
    return render_template('academy/translations_index.html', academy_view='translations')


@academy_pages.get('/team')
def team():
    return elearning.studio_dashboard_page(['academy/team.html', 'academy/library.html'], academy_view='team')


@academy_pages.get('/instellingen')
def settings():
    return render_template('academy_account.html', academy_view='settings')


@academy_pages.get('/start/<share_token>')
def player(share_token):
    return elearning.public_player_page(share_token)


@academy_pages.get('/vertalen/<grant_token>')
def translator(grant_token):
    return elearning.translator_page(grant_token, 'academy/builder.html')


@academy_pages.get('/inloggen')
def signin():
    return render_template('academy_signin.html', academy_view='signin')


@academy_pages.get('/signin')
def legacy_signin():
    return _redirect_page('academy.signin')
