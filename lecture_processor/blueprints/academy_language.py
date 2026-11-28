"""Interface language and isolated Studio catalogs for xPED Academy."""
from __future__ import annotations

from functools import lru_cache
import json
from pathlib import Path

from flask import Blueprint, Response, abort, g, jsonify, request
from google.api_core.exceptions import GoogleAPICallError

from lecture_processor.repositories.elearning_repo import ElearningStore
from lecture_processor.runtime.container import get_runtime

academy_language_bp = Blueprint('academy_language', __name__)
LANGUAGES = ('nl', 'de')
_CATALOGS = Path(__file__).resolve().parents[1] / 'locales' / 'academy'


@lru_cache(maxsize=2)
def catalog(language):
    return json.loads((_CATALOGS / (language + '.json')).read_text(encoding='utf-8'))


@lru_cache(maxsize=2)
def _all_messages(language):
    return {key: value for messages in catalog(language).values() for key, value in messages.items()}


def language():
    chosen = getattr(g, 'academy_player_language', None) or request.cookies.get('xped-language')
    return chosen if chosen in LANGUAGES else 'nl'


def translate(key, **values):
    text = _all_messages(language())[key]
    for name, val in values.items():
        text = text.replace('{' + name + '}', str(val))
    return text


@academy_language_bp.app_context_processor
def locale_context():
    locale = language()
    return dict(academy_locale=locale, xped_t=translate,
                xped_copy=lambda nl, de: de if locale == 'de' else nl)


@academy_language_bp.get('/academy/messages/<language_code>/<section>.js')
def messages(language_code, section):
    if language_code not in LANGUAGES or section not in ('account', 'signin', 'library', 'builder', 'report', 'player', 'shared'):
        abort(404)
    groups = catalog(language_code)
    selected = {**groups.get('shared', {}), **groups.get(section, {})}
    body = 'window.XpedMessages=' + json.dumps(selected, ensure_ascii=False, separators=(',', ':')) + ';'
    result = Response(body, mimetype='text/javascript')
    result.cache_control.public = True
    result.cache_control.max_age = 0
    result.add_etag()
    return result.make_conditional(request)


@academy_language_bp.route('/api/academy/preferences', methods=('GET', 'PUT'))
def account_preferences():
    runtime = get_runtime()
    user = runtime.verify_firebase_token(request)
    if not user:
        return jsonify(error='Sign in required'), 401
    uid = user['uid']
    store = ElearningStore(runtime.db)
    profile_path = 'academy_users/' + uid
    try:
        if request.method == 'GET':
            profile = store.get(profile_path) or {}
            locale = profile.get('language')
            return jsonify(language=locale if locale in LANGUAGES else None)
        data = request.get_json(silent=True)
        locale = data.get('language') if isinstance(data, dict) else None
        if locale not in LANGUAGES:
            return jsonify(error='Unsupported language'), 400

        def save(tx):
            removal = tx.get('account_deletions/' + uid)
            if removal and removal.get('status') != 'cancelled':
                return False
            profile = tx.get(profile_path) or {}
            tx.put(profile_path, {**profile, 'language': locale})
            return True

        if not store.atomic(save):
            return jsonify(error='This account is being removed.'), 409
        return jsonify(language=locale)
    except GoogleAPICallError:
        return jsonify(error='Preferences are temporarily unavailable.'), 503


def learner_language(available):
    """The first browser language sets the default. Course links may request an offered language."""
    browser = request.headers.get('Accept-Language', '').split(',', 1)[0].split(';', 1)[0].strip().lower()
    first = 'de' if browser.split('-')[0] == 'de' else 'nl'
    requested = request.args.get('lang')
    for option in (requested, request.cookies.get('xped-course-language'), first, 'nl', 'de'):
        if option in available:
            return option
    return first
