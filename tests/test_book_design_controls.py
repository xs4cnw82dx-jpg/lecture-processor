"""Bounded line geometry and page furniture survive saving and print exports."""
import base64
from copy import deepcopy
import io
import json
import zipfile

import pytest
from lxml import etree
from PIL import Image, ImageDraw
from pypdf import PdfReader

from lecture_processor.domains.books import model
from lecture_processor.domains.books.export import generate, native_eligible
from lecture_processor.services import book_service as service
from tests.test_books import Store, headers, pages


@pytest.fixture
def book_client(client, monkeypatch, runtime):
    db = Store()
    monkeypatch.setattr(service, 'store', lambda _: db)
    monkeypatch.setattr(service.lifecycle, 'ensure_account_allows_writes', lambda *a, **kw: (True, ''))
    monkeypatch.setattr(runtime.core, 'verify_firebase_token', lambda req: {'uid': req.headers['Authorization'], 'email': req.headers['Authorization'] + '@example.com', 'email_verified': True}, raising=False)
    return client


def path_object(kind='line', **extra):
    return model.item({
        'id': 'path-one', 'type': kind, 'x': 21, 'y': 36, 'w': 100, 'h': 60,
        'pathPoints': [[0, .25], [.4, 1], [1, 0]], 'pathMode': 'smooth',
        'nodeMarkers': True, 'markerColor': '#FFD617', 'markerDiameter': 4,
        'arrowFill': '#007ACC', **extra,
    })


def test_old_arrow_and_page_defaults_remain_compatible():
    arrow = model.item({'id': 'old-arrow', 'type': 'arrow', 'stroke': '#007ACC'})
    assert arrow['pathPoints'] == [[0, .5], [1, .5]]
    assert arrow['pathMode'] == 'angular'
    assert arrow['arrowFill'] is None  # The renderer follows stroke until explicitly customized.
    assert arrow['nodeMarkers'] is False
    assert arrow['markerColor'] == '#FFD617' and arrow['markerDiameter'] == 3
    page = model.page({'id': 'old-page'})
    assert page['showLogo'] is True
    assert page['logoPlacement'] is None and page['numberPlacement'] is None
    assert model.item(arrow) == arrow
    assert model.page(page) == page


@pytest.mark.parametrize('kind', ['line', 'arrow'])
def test_editable_path_values_round_trip_without_arbitrary_markup(kind):
    raw = path_object(kind)
    assert raw['type'] == kind
    assert model.item(deepcopy(raw)) == raw
    assert raw['pathPoints'] == [[0, .25], [.4, 1], [1, 0]]
    assert raw['nodeMarkers'] and raw['markerDiameter'] == 4
    assert raw['arrowFill'] == '#007ACC'
    safe = path_object(kind, pathPoints=[[-10, float('inf')], [2, 'not a coordinate']],
                       pathMode='<svg onload=alert(1)>', markerColor='url(https://bad.test)',
                       markerDiameter=100, arrowFill='url(#custom)', svg='<path d="M0 0"/>')
    assert safe['pathPoints'] == [[0, 0], [1, 0]]
    assert safe['pathMode'] == 'angular'
    assert safe['markerDiameter'] == 12
    assert safe['markerColor'] == '#FFD617'
    assert safe['arrowFill'] is None and 'svg' not in safe
    assert path_object(kind, markerDiameter=-1)['markerDiameter'] == 2


@pytest.mark.parametrize('points', [
    [[0, 0]], [[0, 0]] * 33, [[0], [1, 1]], [[0, 0, 0], [1, 1]],
    [0, 1], {'path': 'M0 0 L1 1'}, 'M0 0 L1 1',
])
def test_malformed_or_unbounded_path_lists_are_rejected(points):
    with pytest.raises(model.BookError):
        path_object(pathPoints=points)
    assert len(path_object(pathPoints=[[i / 31, i / 31] for i in range(32)])['pathPoints']) == 32


def test_page_furniture_stores_only_safe_bounded_placement_and_visibility():
    page = model.page({
        'id': 'custom-footer', 'items': [path_object()], 'showLogo': False,
        'logoPlacement': {'x': 18, 'y': 187, 'w': 15, 'h': 100, 'svg': '<svg/>'},
        'numberPlacement': {'x': 40, 'y': 188, 'font': '<script>'},
    })
    assert page['logoPlacement'] == {'x': 18, 'y': 187, 'w': 15}
    assert page['numberPlacement'] == {'x': 40, 'y': 188}
    assert page['showLogo'] is False
    assert model.page(deepcopy(page)) == page
    bounded = model.page({'id': 'bounds', 'logoPlacement': {'x': -10, 'y': 9999, 'w': 9999}, 'numberPlacement': {'x': float('nan'), 'y': -20}})
    assert bounded['logoPlacement'] == {'x': 0, 'y': 210, 'w': 60}
    assert bounded['numberPlacement'] == {'x': 0, 'y': 0}
    assert model.page({'id': 'small-logo', 'logoPlacement': {'w': 0}})['logoPlacement']['w'] == 8
    for invalid in ('<svg/>', ['x', 'y'], True):
        value = model.page({'id': 'invalid', 'logoPlacement': invalid, 'numberPlacement': invalid})
        assert value['logoPlacement'] is None and value['numberPlacement'] is None


def test_cloud_versions_deleted_pages_and_backup_keep_design_controls(book_client):
    client = book_client
    logical = pages(5)
    logical[1] = model.page({
        **logical[1], 'items': [path_object()],
        'logoPlacement': {'x': 19, 'y': 189, 'w': 17},
        'numberPlacement': {'x': 40, 'y': 190},
    })
    logical[2] = model.page({**logical[2], 'items': [path_object('arrow', arrowFill='#1FE4A9')], 'showLogo': False})
    created = client.post('/api/books', headers=headers(), json={'pages': logical, 'pageNumbers': {'enabled': True}})
    assert created.status_code == 201, created.json
    bid = created.json['book']['id']
    token = client.post('/api/books/' + bid + '/lease', headers=headers(), json={}).json['lease_token']
    saved = client.put('/api/books/' + bid, headers=headers(), json={
        'lease_token': token, 'base_revision': 1,
        'page_ids': ['p0', 'p1', 'p3', 'p4'], 'deleted_page_ids': ['p2'],
        'pages': [logical[2]], 'metadata': {'title': 'A route to explore', 'pageNumbers': {'enabled': True}},
    })
    assert saved.status_code == 200, saved.json
    current = client.get('/api/books/' + bid, headers=headers()).json
    inside = next(page for page in current['pages'] if page['id'] == 'p1')
    deleted = next(page for page in current['pages'] if page['id'] == 'p2')
    assert inside['logoPlacement'] == logical[1]['logoPlacement']
    assert inside['numberPlacement'] == logical[1]['numberPlacement']
    assert inside['items'][0] == logical[1]['items'][0]
    assert deleted['showLogo'] is False and deleted['items'][0]['arrowFill'] == '#1FE4A9'
    snapshot = client.post('/api/books/' + bid + '/history', headers=headers(), json={
        'lease_token': token, 'base_revision': saved.json['revision'], 'name': 'Before the next route',
    })
    assert snapshot.status_code == 200, snapshot.json
    versions = client.get('/api/books/' + bid + '/history?include_pages=1', headers=headers()).json['versions']
    assert versions[0]['pages'][1]['items'][0] == logical[1]['items'][0]
    assert versions[0]['deletedPages'][0]['showLogo'] is False
    response = client.get('/api/books/' + bid + '/backup', headers=headers())
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.data)) as archive:
        backup = json.loads(archive.read('book.json'))
    assert backup['pages'][1]['logoPlacement'] == logical[1]['logoPlacement']
    assert backup['pages'][1]['numberPlacement'] == logical[1]['numberPlacement']
    assert backup['deletedPages'][0]['items'][0]['pathMode'] == 'smooth'
    assert backup['versions'][0]['deletedPages'][0]['items'][0]['arrowFill'] == '#1FE4A9'
    assert backup['pageNumbers']['enabled'] is True


@pytest.mark.parametrize('kind,extra', [
    ('line', {'pathPoints': [[0, .5], [1, .5]], 'nodeMarkers': False, 'pathMode': 'angular'}),
    ('line', {'pathMode': 'smooth'}),
    ('arrow', {'pathMode': 'angular', 'arrowHead': 'both'}),
    ('arrow', {'pathMode': 'smooth', 'arrowFill': '#FFD617'}),
])
def test_line_paths_are_intentionally_flattened_in_editable_word(kind, extra):
    value = path_object(kind, **extra)
    assert native_eligible(value) is False
    assert native_eligible(model.item({'id': 'editable-heading', 'type': 'text', 'text': 'Editable words'})) is True


def captured_page():
    """A distinctive capture verifies the exporter keeps the supplied renderer output."""
    image = Image.new('RGB', (149, 210), '#fffdf7')
    draw = ImageDraw.Draw(image)
    draw.line([(20, 60), (75, 100), (128, 45)], fill='#007ACC', width=3)
    draw.ellipse((71, 96, 79, 104), fill='#FFD617')
    draw.rectangle((22, 190, 39, 195), fill='#062940')
    data = io.BytesIO()
    image.save(data, 'PNG')
    return image, 'data:image/png;base64,' + base64.b64encode(data.getvalue()).decode()


def test_editable_export_keeps_mixed_run_spacing_in_capture_without_duplicate_native_text():
    _, preview = captured_page()
    logical = pages()
    mixed = model.item({
        'id': 'mixed-spacing', 'type': 'text', 'text': 'Airy words\nClose words', 'style': {'lineHeight': 1.4},
        'runs': [{'text': 'Airy words\n', 'style': {'lineHeight': 2}}, {'text': 'Close words', 'style': {'lineHeight': 1.4}}],
    })
    assert native_eligible(mixed) is False
    uniform = deepcopy(mixed)
    for run in uniform['runs']:
        run['style']['lineHeight'] = uniform['style']['lineHeight']
    assert native_eligible(uniform) is True
    logical[0]['items'] = [mixed]
    data, _, _ = generate({'pages': logical, 'previews': [preview] * 4, 'format': 'editable'})
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        document = etree.fromstring(archive.read('word/document.xml'))
    ns = {'v': 'urn:schemas-microsoft-com:vml', 'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'}
    assert len(document.findall('.//wp:anchor', ns)) == 4
    assert not document.findall('.//v:textbox', ns)


@pytest.mark.parametrize('format', ['faithful', 'editable', 'pdf'])
def test_exports_retain_captured_lines_markers_and_placed_furniture(format):
    image, preview = captured_page()
    logical = pages()
    logical[0] = model.page({
        **logical[0], 'items': [path_object(), path_object('arrow', id='arrow-two')],
        'logoPlacement': {'x': 22, 'y': 190, 'w': 17}, 'numberPlacement': {'x': 43, 'y': 190},
    })
    data, _, extension = generate({'pages': logical, 'previews': [preview] * 4, 'format': format})
    if extension == 'pdf':
        document = PdfReader(io.BytesIO(data))
        assert len(document.pages) == 3
        capture = document.pages[0].images[0].image.convert('RGB')
    else:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            capture = Image.open(io.BytesIO(archive.read(next(name for name in archive.namelist() if name.startswith('word/media/'))))).convert('RGB')
            document = etree.fromstring(archive.read('word/document.xml'))
        ns = {'v': 'urn:schemas-microsoft-com:vml', 'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'}
        assert len(document.findall('.//wp:anchor', ns)) == 4
        assert not document.findall('.//v:shape', ns)
        assert not document.findall('.//v:line', ns)
        assert not document.findall('.//v:rect', ns)
    assert capture.size == image.size
    for sample in [(75, 100), (25, 192), (0, 0)]:
        assert capture.getpixel(sample) == image.getpixel(sample)
