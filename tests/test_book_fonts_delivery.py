"""Book Studio serves compressed web fonts and builds its Word font bundle once."""
import io
import re
import zipfile
from pathlib import Path

from lecture_processor.blueprints import books

ROOT = Path(__file__).resolve().parents[1]


def test_book_studio_stylesheet_uses_existing_woff2_fonts():
    css = (ROOT / 'static/css/book-studio.css').read_text(encoding='utf-8')
    urls = re.findall(r'url\("(/static/fonts/books/[^"]+)"\)', css)
    assert urls and all(url.endswith('.woff2') for url in urls)
    assert all((ROOT / url.lstrip('/')).is_file() for url in urls)
    assert len(re.findall(r'@font-face', css)) == len(urls)
    assert all(f'url("{url}") format("woff2")' in css for url in urls)


def test_font_bundle_keeps_ttf_files_and_is_built_once(client, monkeypatch):
    monkeypatch.setitem(books._fonts_bundle, 'signature', None)
    first = client.get('/api/books/fonts')
    assert first.status_code == 200 and first.mimetype == 'application/zip'
    names = zipfile.ZipFile(io.BytesIO(first.data)).namelist()
    ttfs = sorted(path.name for path in (ROOT / 'static/fonts/books').glob('*.ttf'))
    assert sorted(name for name in names if name.endswith('.ttf')) == ttfs
    assert 'INSTALL.txt' in names and not any(name.endswith('.woff2') for name in names)

    def rebuilt(*_args, **_kwargs):
        raise AssertionError('The font bundle must be reused while the font files are unchanged')

    monkeypatch.setattr(zipfile, 'ZipFile', rebuilt)
    second = client.get('/api/books/fonts')
    assert second.status_code == 200 and second.data == first.data
