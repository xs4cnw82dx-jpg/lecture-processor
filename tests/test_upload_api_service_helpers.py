import json
import zipfile
from types import SimpleNamespace

from lecture_processor.services import upload_api_service
from lecture_processor.services import upload_batch_support
from lecture_processor.services import tools_extraction_support
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


def test_docx_zip_validation_rejects_large_internal_member(tmp_path, monkeypatch):
    monkeypatch.setattr(tools_extraction_support, "OOXML_MAX_MEMBER_UNCOMPRESSED_BYTES", 10)
    docx_path = tmp_path / "oversized.docx"
    with zipfile.ZipFile(docx_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", "x" * 11)

    error = tools_extraction_support.validate_ooxml_zip(
        docx_path,
        required_members=("[Content_Types].xml", "word/document.xml"),
    )

    assert error == "DOCX file contains an internal part that is too large."


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


def test_fetch_tools_url_text_uses_ip_bound_fetch_target(monkeypatch):
    import urllib.request

    target = url_security.ValidatedFetchTarget(
        url="https://example.com/article?token=secret",
        scheme="https",
        host="example.com",
        port=443,
        resolved_ips=("93.184.216.34",),
    )
    validate_calls = []

    def _fake_validate(url, **kwargs):
        validate_calls.append((url, kwargs))
        return target, None

    class _FakeResponse:
        status = 200
        headers = {"Content-Type": "text/plain; charset=utf-8"}

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self, _max_bytes):
            return b"Hello"

    captured = {}

    class _FakeOpener:
        def open(self, request, timeout=20):
            captured["request_url"] = request.full_url
            return _FakeResponse()

    def _fake_build_opener(*handlers):
        captured["handlers"] = handlers
        return _FakeOpener()

    monkeypatch.setattr(url_security, "validate_external_url_for_fetch", _fake_validate)
    monkeypatch.setattr(urllib.request, "build_opener", _fake_build_opener)

    text, error, content_type = upload_api_service._fetch_tools_url_text(
        "https://example.com/article?token=secret"
    )

    assert error is None
    assert text == "Hello"
    assert content_type == "text/plain; charset=utf-8"
    assert captured["request_url"] == "https://example.com/article?token=secret"
    assert validate_calls[0][1]["return_fetch_target"] is True
    https_handler = next(
        handler for handler in captured["handlers"]
        if isinstance(handler, url_security.IPBoundHTTPSHandler)
    )
    assert https_handler.registry.resolve("example.com", 443) == ("93.184.216.34",)


def test_runtime_job_refund_receipt_accumulates_primary_and_extra_refunds():
    runtime = SimpleNamespace(
        time=SimpleNamespace(time=lambda: 100.0),
        logger=SimpleNamespace(warning=lambda *_args, **_kwargs: None),
    )
    job_snapshot = {
        "billing_receipt": {
            "charged": {
                "lecture_credits_standard": 1,
                "slides_credits": 2,
            },
            "refunded": {},
        },
        "extra_slides_refunded": 0,
    }

    primary_updates = upload_batch_support._record_runtime_job_refund(
        runtime,
        "job-1",
        "lecture_credits_standard",
        1,
        job_snapshot=job_snapshot,
    )
    extra_updates = upload_batch_support._record_runtime_job_refund(
        runtime,
        "job-1",
        "slides_credits",
        2,
        extra_slides_increment=2,
        job_snapshot=job_snapshot,
    )

    assert primary_updates["billing_receipt"]["refunded"]["lecture_credits_standard"] == 1
    assert extra_updates["billing_receipt"]["refunded"] == {
        "lecture_credits_standard": 1,
        "slides_credits": 2,
    }
    assert extra_updates["extra_slides_refunded"] == 2
