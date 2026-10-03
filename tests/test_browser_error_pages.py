from flask import abort
from lecture_processor import create_app


def test_unknown_browser_page_is_branded_and_keeps_404(client):
    response = client.get('/no-such-workspace-page')
    assert response.status_code == 404
    assert b'We could not find this page' in response.data
    assert b'Go to your workspace' in response.data
    assert b'Content-Security-Policy' not in response.data
    assert 'Content-Security-Policy' in response.headers


def test_unknown_api_route_keeps_http_error_semantics(client):
    response = client.get('/api/no-such-endpoint')
    assert response.status_code == 404
    assert b'error-page' not in response.data


def test_browser_error_does_not_expose_internal_description():
    app = create_app()
    @app.get('/error-preview')
    def error_preview():
        abort(500, description='Private server detail')
    response = app.test_client().get('/error-preview')
    assert response.status_code == 500
    assert b'Something went wrong' in response.data
    assert b'Private server detail' not in response.data
