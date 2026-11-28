"""Content-versioned Academy styles, assembled once per release in cascade order."""
from hashlib import sha256
from pathlib import Path

from flask import Response, abort, request, url_for

from lecture_processor.runtime.static_assets import IMMUTABLE_CACHE_CONTROL


_BASE = ('academy-base', 'academy', 'xped-theme')
_FOUNDATION = ('elearning-academy-experience', 'elearning-foundation', 'academy-shell')
_STUDIO = _BASE + _FOUNDATION
_STYLES = {
    'studio': _STUDIO,
    'home': _STUDIO + ('academy-overview',),
    'collaboration': _STUDIO + ('academy-collaboration',),
    'library': _BASE + ('elearning-studio',) + _FOUNDATION + ('academy-library',),
    'builder': _BASE + ('elearning-studio', 'elearning-builder-authoring', 'academy-report') + _FOUNDATION,
    'report': _BASE + ('elearning-studio', 'academy-report') + _FOUNDATION,
    'player': ('academy-base', 'xped-theme', 'elearning-player', 'academy', 'elearning-academy-experience'),
    'learner_error': ('xped-theme', 'elearning-player', 'academy-base'),
}


def register_academy_styles(app):
    css = Path(app.static_folder) / 'css'
    names = {name for layers in _STYLES.values() for name in layers}
    sources = {name: (css / f'{name}.css').read_bytes() for name in names}
    bundles = {}
    for surface, layers in _STYLES.items():
        content = b'\n'.join(sources[name] for name in layers)
        bundles[surface] = content, sha256(content).hexdigest()[:12]

    @app.get('/static/css/academy-<surface>.bundle.css')
    def academy_style(surface):
        if surface not in bundles:
            abort(404)
        content, version = bundles[surface]
        response = Response(content, mimetype='text/css')
        response.set_etag(version)
        response.headers['Cache-Control'] = IMMUTABLE_CACHE_CONTROL if request.args.get('v') == version else 'no-cache'
        return response.make_conditional(request)

    @app.template_global()
    def academy_stylesheet(surface):
        return url_for('academy_style', surface=surface, v=bundles[surface][1])
