"""Batch archive contents and response-owned temporary-file lifetimes."""

import io
import json
import random
import tempfile
from types import SimpleNamespace
import zipfile

from flask import Flask, jsonify, request, send_file
import pytest

from lecture_processor.services import upload_batch_service


@pytest.fixture
def archive_endpoint(monkeypatch):
    app = Flask(__name__)
    app.config['TESTING'] = True
    state = SimpleNamespace(
        streams=[],
        sent_streams=[],
        sent_sizes=[],
        payload=b'Example document content',
        combined_error=None,
        send_error=None,
        batch={
            'batch_id': 'archive-test',
            'batch_title': 'Example batch',
            'mode': 'lecture-notes',
            'status': 'complete',
            'total_rows': 1,
            'completed_rows': 1,
            'export_options': {'include_combined_docx': False},
        },
    )
    real_spooled_file = tempfile.SpooledTemporaryFile

    def track_spooled_file(*args, **kwargs):
        stream = real_spooled_file(*args, **kwargs)
        state.streams.append(stream)
        return stream

    def track_bytes_io(*args, **kwargs):
        stream = io.BytesIO(*args, **kwargs)
        state.streams.append(stream)
        return stream

    def tracked_send_file(stream, **kwargs):
        state.sent_streams.append(stream)
        position = stream.tell()
        stream.seek(0, io.SEEK_END)
        state.sent_sizes.append(stream.tell())
        stream.seek(position)
        if state.send_error:
            raise state.send_error
        return send_file(stream, **kwargs)

    def combined_document(*_args):
        if state.combined_error:
            raise state.combined_error
        return b'Combined document content'

    runtime = SimpleNamespace(
        io=SimpleNamespace(BytesIO=track_bytes_io),
        jsonify=jsonify,
        send_file=tracked_send_file,
    )
    monkeypatch.setattr(tempfile, 'SpooledTemporaryFile', track_spooled_file)
    monkeypatch.setattr(
        upload_batch_service.upload_batch_support,
        'get_batch_with_permission',
        lambda *_args, **_kwargs: (state.batch, {'uid': 'archive-owner'}, None, 200),
    )
    monkeypatch.setattr(
        upload_batch_service.batch_orchestrator,
        'get_batch_status',
        lambda *_args, **_kwargs: {'can_download_zip': True},
    )
    monkeypatch.setattr(
        upload_batch_service.batch_orchestrator,
        'list_batch_rows',
        lambda *_args, **_kwargs: [{'row_id': 'row-1', 'status': 'complete'}],
    )
    monkeypatch.setattr(
        upload_batch_service.batch_orchestrator,
        'build_batch_row_export_metadata',
        lambda row, *_args, **_kwargs: {'row_id': row['row_id'], 'status': row['status']},
    )
    monkeypatch.setattr(
        upload_batch_service,
        'batch_row_docx_bytes',
        lambda *_args, **_kwargs: state.payload,
    )
    monkeypatch.setattr(upload_batch_service, 'batch_combined_docx_bytes', combined_document)

    @app.get('/archive')
    def download_archive():
        return upload_batch_service.download_batch_zip(runtime, request, 'archive-test')

    with app.test_client() as client:
        state.client = client
        yield state
    for stream in state.streams:
        stream.close()


@pytest.mark.parametrize('include_combined', [False, True])
def test_small_archive_preserves_contents_and_length(archive_endpoint, include_combined):
    state = archive_endpoint
    state.batch['export_options']['include_combined_docx'] = include_combined
    response = state.client.get('/archive', buffered=False)
    try:
        assert response.status_code == 200
        assert response.mimetype == 'application/zip'
        assert response.headers['Content-Disposition'] == 'attachment; filename=batch-archive-test.zip'
        assert not getattr(state.sent_streams[0], '_rolled', False)
        archive_bytes = response.get_data()
        assert response.content_length == len(archive_bytes)
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            expected_names = {'summary.json', 'rows/row-1/meta.json', 'rows/row-1/result.docx'}
            if include_combined:
                expected_names.add('example-batch_Combined.docx')
                assert archive.read('example-batch_Combined.docx') == b'Combined document content'
            assert set(archive.namelist()) == expected_names
            assert archive.read('rows/row-1/result.docx') == state.payload
            assert json.loads(archive.read('summary.json'))['completed_rows'] == 1
            assert json.loads(archive.read('rows/row-1/meta.json')) == {
                'row_id': 'row-1', 'status': 'complete',
            }
    finally:
        response.close()


def test_large_incompressible_archive_rolls_to_disk_before_streaming(archive_endpoint):
    state = archive_endpoint
    state.payload = random.Random(2718).randbytes(6 * 1024 * 1024)
    response = state.client.get('/archive', buffered=False)
    try:
        assert response.status_code == 200
        assert response.content_length > 5 * 1024 * 1024
        stream = state.sent_streams[0]
        assert getattr(stream, '_rolled', False), 'Large archives must leave the in-memory spool.'
        assert not stream.closed
        archive_bytes = response.get_data()
        assert response.content_length == len(archive_bytes)
        with zipfile.ZipFile(io.BytesIO(archive_bytes)) as archive:
            assert archive.read('rows/row-1/result.docx') == state.payload
    finally:
        response.close()
    assert state.sent_streams[0].closed


@pytest.mark.parametrize('consume_body', [False, True], ids=['abandoned', 'completed'])
def test_response_close_releases_archive_stream(archive_endpoint, consume_body):
    state = archive_endpoint
    response = state.client.get('/archive', buffered=False)
    stream = state.sent_streams[0]
    assert not stream.closed
    if consume_body:
        assert response.get_data().startswith(b'PK\x03\x04')
    response.close()
    assert stream.closed


def test_archive_range_response_preserves_exact_bytes_and_headers(archive_endpoint):
    state = archive_endpoint
    response = state.client.get('/archive', headers={'Range': 'bytes=0-3'}, buffered=False)
    try:
        assert response.status_code == 206
        assert response.get_data() == b'PK\x03\x04'
        assert response.content_length == 4
        assert response.headers['Accept-Ranges'] == 'bytes'
        assert response.headers['Content-Range'] == f'bytes 0-3/{state.sent_sizes[0]}'
    finally:
        response.close()
    assert state.sent_streams[0].closed


def test_invalid_archive_range_releases_stream(archive_endpoint):
    state = archive_endpoint
    response = state.client.get('/archive', headers={'Range': 'bytes=999999999-'})
    try:
        assert response.status_code == 416
        assert state.sent_streams[0].closed
    finally:
        response.close()


@pytest.mark.parametrize('failure_stage', ['combined_document', 'send_file'])
def test_archive_errors_release_allocated_stream(archive_endpoint, failure_stage):
    state = archive_endpoint
    if failure_stage == 'combined_document':
        state.batch['export_options']['include_combined_docx'] = True
        state.combined_error = RuntimeError('Combined export failed')
    else:
        state.send_error = RuntimeError('Response creation failed')
    with pytest.raises(RuntimeError, match='failed'):
        state.client.get('/archive')
    assert len(state.streams) == 1
    assert state.streams[0].closed
