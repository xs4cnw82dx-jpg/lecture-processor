import json
from types import SimpleNamespace

from lecture_processor.services import upload_api_service
from lecture_processor.services import url_security


def test_extract_text_from_html_document_removes_script_and_style_content():
    html = """
        <html>
          <body>
            <script>alert('ignore me')</script>
            <p>Hello<br>world</p>
            <style>body { display:none; }</style>
          </body>
        </html>
    """

    extracted = upload_api_service._extract_text_from_html_document(html)

    assert extracted == "Hello\nworld"


def test_extract_content_charset_uses_declared_charset():
    assert upload_api_service._extract_content_charset("text/plain; charset=iso-8859-1") == "iso-8859-1"
    assert upload_api_service._extract_content_charset("text/plain") == "utf-8"
    assert upload_api_service._extract_content_charset("") == "utf-8"


def test_fetch_tools_url_text_decodes_using_declared_charset(monkeypatch):
    class _FakeResponse:
        status = 200
        headers = {"Content-Type": "text/plain; charset=iso-8859-1"}

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self, _max_bytes):
            return b"Caf\xe9"

    class _FakeOpener:
        def open(self, _request, timeout=20):
            assert timeout == 20
            return _FakeResponse()

    import urllib.request

    monkeypatch.setattr(
        url_security,
        "validate_external_url_for_fetch",
        lambda url, **_kwargs: (url, ""),
    )
    monkeypatch.setattr(
        urllib.request,
        "build_opener",
        lambda *_args, **_kwargs: _FakeOpener(),
    )

    text, error, content_type = upload_api_service._fetch_tools_url_text("https://example.com/article.txt")

    assert error is None
    assert content_type == "text/plain; charset=iso-8859-1"
    assert text == "Café"
