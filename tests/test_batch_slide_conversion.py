"""Batch slide preparation uses isolated storage and synthetic converters/providers."""

import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import batch_orchestrator as batch
from lecture_processor.domains.ai import instant_batch_orchestrator as instant
from lecture_processor.domains.rate_limit import quotas
from lecture_processor.services import media_admission
from tests.support.batch_slide_conversion import pptx_bytes


def seed_batch(slides, *, strategy='deferred', count=1, extension='.pptx'):
    batch_id = f'synthetic-{strategy}-slides'
    rows = []
    # These worker-only cases resume an already charged legacy batch.
    slides.store.documents[('users', 'slide-owner')].update(slides_credits=100 - count, total_processed=count)
    for index in range(1, count + 1):
        source = slides.root / f'{batch_id}_row-{index}_slides{extension}'
        source.write_bytes(pptx_bytes() if extension.lower() == '.pptx' else b'%PDF-1.7 original PDF')
        rows.append({
            'row_id': f'row-{index}', 'ordinal': index, 'row_job_id': f'{batch_id}-job-{index}',
            'uid': 'slide-owner', 'status': 'queued', 'slides_local_path': str(source),
            'slides_source_path': str(source), 'study_features': 'none', 'credit_deducted': 'slides_credits',
        })
    batch.create_batch_job({
        'batch_id': batch_id, 'uid': 'slide-owner', 'mode': 'slides-only', 'status': 'queued',
        'total_rows': count, 'batch_title': 'Synthetic slides', 'completion_email_status': 'skipped',
    }, rows, runtime=slides.runtime)
    return batch_id, batch._list_rows(batch_id, runtime=slides.runtime)


def worker(strategy):
    return instant.process_instant_batch_job if strategy == 'instant' else batch.process_batch_job


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_post_stages_original_pptx_without_running_conversion(slides, strategy):
    response = slides.post(strategy)
    assert response.status_code == 200
    assert slides.conversions == []
    rows = batch._list_rows(response.get_json()['batch_id'], runtime=slides.runtime)
    assert len(rows) == 2
    assert Path(rows[0]['slides_local_path']).suffix.lower() == '.pptx'
    assert Path(rows[0]['slides_local_path']).read_bytes() == pptx_bytes()
    assert len(slides.submitted) == 1
    assert slides.submitted[0][0] is (instant.process_instant_batch_job if strategy == 'instant' else batch.process_batch_job)
    assert slides.store.docs('users')['slide-owner']['slides_credits'] == 98
    assert len(slides.charges) == 2
    assert all(item['charged'] == {'slides_credits': 1} for item in slides.charges)


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_media_contention_does_not_reject_batch_staging(slides, strategy):
    lease, status = media_admission.try_acquire('another-media-owner')
    assert status == 0
    try:
        response = slides.post(strategy)
        assert response.status_code == 200
        assert slides.conversions == []
        assert len(slides.submitted) == 1
    finally:
        lease.release()


def test_shared_row_upload_converts_pptx_before_sending_pdf_bytes(slides):
    source = slides.root / 'worker-batch_row-1_slides.pptx'
    source.write_bytes(pptx_bytes())
    batch.create_batch_job({'batch_id': 'worker-batch', 'uid': 'slide-owner', 'mode': 'slides-only', 'status': 'queued'}, [{
        'row_id': 'row-1', 'uid': 'slide-owner', 'slides_local_path': str(source), 'status': 'queued',
    }], runtime=slides.runtime)
    row = batch._get_row('worker-batch', 'row-1', runtime=slides.runtime)
    batch._upload_row_files(row, runtime=slides.runtime)
    assert len(slides.conversions) == 1
    assert len(slides.uploads) == 1
    assert slides.uploads[0][1].startswith(b'%PDF-')
    assert slides.uploads[0][2] == {'mime_type': 'application/pdf'}


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_workers_persist_conversion_before_upload_and_clean_both_paths(slides, strategy):
    batch_id, rows = seed_batch(slides, strategy=strategy)
    source = Path(rows[0]['slides_source_path'])
    observed = []

    def inspect_upload(path):
        stored = batch._get_row(batch_id, 'row-1', runtime=slides.runtime)
        observed.append(stored)
        assert stored['slides_conversion_complete'] is True
        assert stored['slides_local_path'] == path
        assert Path(stored['slides_source_path']).read_bytes() == pptx_bytes()
        assert Path(path).read_bytes().startswith(b'%PDF-')
        assert '_local_paths' not in stored

    slides.upload_hook = inspect_upload
    worker(strategy)(batch_id, runtime=slides.runtime)
    assert len(observed) == 1
    assert len(slides.saved_packs) == 1
    assert batch._get_batch(batch_id, runtime=slides.runtime)['status'] == 'complete'
    assert slides.refunds == []
    assert not source.exists()
    assert not Path(observed[0]['slides_local_path']).exists()
    assert list(slides.root.iterdir()) == []
    assert slides.runtime.MAX_PDF_UPLOAD_BYTES in slides.disk_checks


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
@pytest.mark.parametrize('failure', ['reported', 'timeout', 'oversize', 'invalid-pdf'])
def test_conversion_failure_refunds_once_and_releases_files_and_admission(slides, monkeypatch, strategy, failure):
    batch_id, _rows = seed_batch(slides, strategy=strategy)
    monkeypatch.setattr(slides.runtime, 'MAX_PDF_UPLOAD_BYTES', 1000)

    def fail_conversion(_source, target):
        if failure == 'timeout':
            Path(target).write_bytes(b'partial conversion')
            raise TimeoutError('Synthetic converter timeout')
        if failure == 'reported':
            Path(target).write_bytes(b'partial conversion')
            return '', 'Synthetic converter failed'
        Path(target).write_bytes(b'%PDF-' + b'x' * 1000 if failure == 'oversize' else b'not a PDF')
        return str(target), ''

    slides.conversion_hook = fail_conversion
    worker(strategy)(batch_id, runtime=slides.runtime)
    assert batch._get_batch(batch_id, runtime=slides.runtime)['status'] == 'error'
    assert slides.uploads == []
    assert slides.saved_packs == []
    assert slides.refunds == [f'batch-row:{batch_id}:row-1:primary']
    assert slides.store.docs('users')['slide-owner']['slides_credits'] == 100
    assert slides.store.docs('users')['slide-owner']['total_processed'] == 0
    assert len(slides.store.docs('credit_refunds')) == 1
    assert list(slides.root.iterdir()) == []
    worker(strategy)(batch_id, runtime=slides.runtime)
    batch.get_batch_status(batch_id, runtime=slides.runtime)
    assert len(slides.refunds) == 1
    lease, status = media_admission.try_acquire_conversion('slide-owner')
    assert status == 0
    lease.release()


@pytest.mark.parametrize('phase', ['before-conversion', 'after-conversion'])
def test_failed_conversion_checkpoint_keeps_original_and_never_uploads(slides, phase):
    batch_id, rows = seed_batch(slides)
    source = Path(rows[0]['slides_source_path'])

    def fail_checkpoint(_batch_id, _row_id, payload):
        if payload.get('slides_conversion_complete') is (phase == 'after-conversion'):
            assert source.read_bytes() == pptx_bytes()
            raise RuntimeError('Synthetic checkpoint unavailable')

    slides.checkpoint_hook = fail_checkpoint
    with pytest.raises(RuntimeError, match='checkpoint unavailable'):
        batch._upload_row_files(rows[0], runtime=slides.runtime)
    assert source.read_bytes() == pptx_bytes()
    assert slides.uploads == []
    assert len(slides.conversions) == (1 if phase == 'after-conversion' else 0)
    stored = batch._get_row(batch_id, 'row-1', runtime=slides.runtime)
    assert stored['slides_local_path'] == str(source)
    assert not stored.get('slides_conversion_complete')
    lease, status = media_admission.try_acquire_conversion('slide-owner')
    assert status == 0
    lease.release()


def test_rehydrated_pdf_checkpoint_reuses_conversion_without_another_quota_charge(slides):
    response = slides.post()
    batch_id = response.get_json()['batch_id']
    row = batch._get_row(batch_id, 'row-1', runtime=slides.runtime)
    quota_after_staging = (list(slides.reserved), list(slides.released))
    charged_bytes = sum(amount for _uid, amount in slides.reserved) - sum(amount for _uid, amount in slides.released)
    assert charged_bytes == len(pptx_bytes()) + len(b'%PDF-1.7 synthetic PDF')

    def fallback_conversion(source, _target):
        path = Path(source).with_suffix('.pdf')
        path.write_bytes(b'%PDF-1.7 LibreOffice fallback output')
        return str(path), ''

    slides.conversion_hook = fallback_conversion
    batch._upload_row_files(row, runtime=slides.runtime)
    reloaded = batch._get_row(batch_id, 'row-1', runtime=slides.runtime)
    assert reloaded['slides_conversion_complete'] is True
    assert Path(reloaded['slides_local_path']).read_bytes().startswith(b'%PDF-')
    assert Path(reloaded['slides_source_path']).exists()
    assert reloaded['slides_local_path'] in reloaded['slides_conversion_candidates']
    batch._upload_row_files(reloaded, runtime=slides.runtime)
    assert len(slides.conversions) == 1
    assert len(slides.uploads) == 2
    assert (slides.reserved, slides.released) == quota_after_staging


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_invalid_pptx_is_rejected_without_a_worker_or_leftover_file(slides, strategy):
    response = slides.post(strategy, first=b'not a presentation')
    assert response.status_code == 400
    assert 'PPTX' in response.get_json()['error']
    assert slides.conversions == []
    assert slides.submitted == []
    assert len(slides.refunds) == len(slides.charges)
    assert list(slides.root.iterdir()) == []
    assert sum(amount for _uid, amount in slides.reserved) == sum(amount for _uid, amount in slides.released)


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_pdf_worker_does_not_need_conversion_admission(slides, strategy):
    batch_id, _rows = seed_batch(slides, strategy=strategy, extension='.pdf')
    lease, status = media_admission.try_acquire_conversion('another-media-owner')
    assert status == 0
    try:
        worker(strategy)(batch_id, runtime=slides.runtime)
        assert slides.conversions == []
        assert len(slides.uploads) == 1
        assert len(slides.saved_packs) == 1
        assert batch._get_batch(batch_id, runtime=slides.runtime)['status'] == 'complete'
    finally:
        lease.release()


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_low_disk_space_prevents_conversion_and_refunds_the_worker(slides, monkeypatch, strategy):
    batch_id, _rows = seed_batch(slides, strategy=strategy)
    monkeypatch.setattr(quotas, 'has_sufficient_upload_disk_space', lambda *_args, **_kwargs: (False, 0, 1000))
    worker(strategy)(batch_id, runtime=slides.runtime)
    assert slides.conversions == []
    assert slides.uploads == []
    assert len(slides.refunds) == 1
    assert batch._get_batch(batch_id, runtime=slides.runtime)['status'] == 'error'
    assert list(slides.root.iterdir()) == []
    lease, status = media_admission.try_acquire_conversion('slide-owner')
    assert status == 0
    lease.release()


def fake_sleep(slides, monkeypatch, callback):
    original_time = slides.runtime.time
    clock = SimpleNamespace(now=original_time.time(), sleeps=[])

    def sleep(seconds):
        clock.sleeps.append(seconds)
        clock.now += seconds
        callback(clock)

    monkeypatch.setattr(slides.runtime, 'time', SimpleNamespace(
        time=lambda: clock.now, sleep=sleep, monotonic=original_time.monotonic,
    ))
    return clock


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
@pytest.mark.parametrize('owner', ['slide-owner', 'another-media-owner'])
def test_long_download_does_not_delay_or_refund_slide_conversion(slides, monkeypatch, strategy, owner):
    batch_id, _rows = seed_batch(slides, strategy=strategy, count=2)
    # Keep this artificial-clock case about a held download. Real parallel
    # conversion contention is exercised separately with thread events.
    monkeypatch.setattr(slides.runtime, 'INSTANT_BATCH_MAX_PARALLEL_ROWS', 1)
    clock = fake_sleep(slides, monkeypatch, lambda _clock: None)
    lease, status = media_admission.try_acquire(owner)
    assert status == 0
    try:
        clock.now += batch.BATCH_SLIDE_MEDIA_WAIT_SECONDS + 1
        worker(strategy)(batch_id, runtime=slides.runtime)
        assert batch._get_batch(batch_id, runtime=slides.runtime)['status'] == 'complete'
        assert len(slides.conversions) == len(slides.uploads) == len(slides.saved_packs) == 2
        assert slides.refunds == []
        assert clock.sleeps == []
        remaining, code = media_admission.try_acquire(owner)
        if remaining:
            remaining.release()
        assert code == 429, 'Conversion must not release the held download lease.'
    finally:
        lease.release()


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
@pytest.mark.parametrize('owner', ['slide-owner', 'another-media-owner'])
def test_worker_waits_for_media_admission_without_early_refund(slides, monkeypatch, strategy, owner):
    batch_id, _rows = seed_batch(slides, strategy=strategy)
    lease, status = media_admission.try_acquire_conversion(owner)
    assert status == 0

    def release_on_wait(clock):
        assert slides.conversions == []
        assert slides.uploads == []
        clock.now += 1000
        snapshot = batch.get_batch_status(batch_id, runtime=slides.runtime)
        assert snapshot['status'] == 'processing'
        assert slides.refunds == []
        lease.release()

    clock = fake_sleep(slides, monkeypatch, release_on_wait)
    try:
        worker(strategy)(batch_id, runtime=slides.runtime)
    finally:
        lease.release()
    assert len(clock.sleeps) == 1
    assert len(slides.conversions) == 1
    assert len(slides.uploads) == 1
    assert batch._get_batch(batch_id, runtime=slides.runtime)['status'] == 'complete'
    assert slides.refunds == []


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_admission_wait_has_a_bound_and_refunds_once(slides, monkeypatch, strategy):
    batch_id, _rows = seed_batch(slides, strategy=strategy)
    monkeypatch.setattr(batch, 'BATCH_SLIDE_MEDIA_WAIT_SECONDS', 10, raising=False)
    monkeypatch.setattr(batch, 'BATCH_SLIDE_MEDIA_RETRY_SECONDS', 2, raising=False)
    clock = fake_sleep(slides, monkeypatch, lambda _clock: None)
    lease, status = media_admission.try_acquire_conversion('another-media-owner')
    assert status == 0
    try:
        worker(strategy)(batch_id, runtime=slides.runtime)
    finally:
        lease.release()
    assert sum(clock.sleeps) == 10
    assert len(clock.sleeps) == 5
    assert slides.conversions == []
    assert slides.uploads == []
    assert len(slides.refunds) == 1
    assert batch._get_batch(batch_id, runtime=slides.runtime)['status'] == 'error'
    assert list(slides.root.iterdir()) == []
    batch.get_batch_status(batch_id, runtime=slides.runtime)
    worker(strategy)(batch_id, runtime=slides.runtime)
    assert len(slides.refunds) == 1


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
@pytest.mark.parametrize('phase', ['waiting', 'conversion'])
def test_terminal_transition_stops_conversion_or_upload_without_overwriting_decision(slides, monkeypatch, strategy, phase):
    batch_id, _rows = seed_batch(slides, strategy=strategy)
    stopped = []

    def stop_batch():
        batch._upsert_batch(batch_id, {
            'status': 'error', 'error_summary': 'Externally stopped.',
            'provider_state': 'EXTERNAL_STOP', 'finished_at': slides.runtime.time.time(),
        }, runtime=slides.runtime)
        stopped.append(batch._get_batch(batch_id, runtime=slides.runtime))

    lease = None
    if phase == 'waiting':
        lease, status = media_admission.try_acquire_conversion('another-media-owner')
        assert status == 0
        fake_sleep(slides, monkeypatch, lambda _clock: stop_batch())
    else:
        def convert_then_stop(_source, target):
            Path(target).write_bytes(b'%PDF-1.7 late converted output')
            stop_batch()
            return str(target), ''
        slides.conversion_hook = convert_then_stop
    try:
        worker(strategy)(batch_id, runtime=slides.runtime)
    finally:
        if lease:
            lease.release()
    assert stopped
    assert batch._get_batch(batch_id, runtime=slides.runtime) == stopped[-1]
    assert len(slides.conversions) == (1 if phase == 'conversion' else 0)
    assert slides.uploads == []
    assert slides.refunds == []
    assert slides.saved_packs == []
    assert list(slides.root.iterdir()) == []
    released, status = media_admission.try_acquire_conversion('slide-owner')
    assert status == 0
    released.release()


def test_parallel_instant_rows_serialize_conversion_instead_of_failing_contention(slides, monkeypatch):
    batch_id, _rows = seed_batch(slides, strategy='instant', count=2)
    entered, waiting, release = threading.Event(), threading.Event(), threading.Event()
    lock = threading.Lock()
    activity = {'active': 0, 'peak': 0, 'calls': 0}
    original_acquire = batch.media_admission.try_acquire_conversion

    def observe_admission(uid):
        result = original_acquire(uid)
        if result[0] is None:
            waiting.set()
        return result

    def conversion(_source, target):
        with lock:
            activity['active'] += 1
            activity['calls'] += 1
            activity['peak'] = max(activity['peak'], activity['active'])
            first = activity['calls'] == 1
        try:
            if first:
                entered.set()
                assert release.wait(5), 'Held synthetic conversion was not released.'
            Path(target).write_bytes(b'%PDF-1.7 serialized output')
            return str(target), ''
        finally:
            with lock:
                activity['active'] -= 1

    monkeypatch.setattr(batch.media_admission, 'try_acquire_conversion', observe_admission)
    monkeypatch.setattr(batch, 'BATCH_SLIDE_MEDIA_RETRY_SECONDS', 0.01, raising=False)
    monkeypatch.setattr(batch, 'BATCH_SLIDE_MEDIA_WAIT_SECONDS', 2, raising=False)
    slides.conversion_hook = conversion
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(instant.process_instant_batch_job, batch_id, runtime=slides.runtime)
        try:
            assert entered.wait(3)
            assert waiting.wait(3)
            assert slides.refunds == []
            assert len(slides.conversions) == 1
        finally:
            release.set()
        future.result(timeout=5)
    assert activity == {'active': 0, 'peak': 1, 'calls': 2}
    assert len(slides.saved_packs) == 2
    assert len(slides.uploads) == 2
    assert batch._get_batch(batch_id, runtime=slides.runtime)['status'] == 'complete'
    assert slides.refunds == []
    assert list(slides.root.iterdir()) == []


@pytest.mark.parametrize('converted', [False, True])
def test_stale_recovery_cleans_persisted_conversion_paths_and_refunds_once(slides, converted):
    batch_id, rows = seed_batch(slides)
    source = Path(rows[0]['slides_source_path'])
    if not converted:
        def interrupted_conversion(_source, target):
            Path(target).write_bytes(b'partial conversion output')
            return '', 'Synthetic interruption'
        slides.conversion_hook = interrupted_conversion
        with pytest.raises(ValueError):
            batch._upload_row_files(rows[0], runtime=slides.runtime)
    else:
        batch._upload_row_files(rows[0], runtime=slides.runtime)
    persisted = batch._get_row(batch_id, 'row-1', runtime=slides.runtime)
    assert '_local_paths' not in persisted
    assert source.exists()
    assert any(Path(path).exists() for path in persisted['slides_conversion_candidates'])
    batch._upsert_batch(batch_id, {
        'status': 'processing', 'last_heartbeat_at': slides.runtime.time.time() - 1000,
    }, runtime=slides.runtime)
    recovered = batch.get_batch_status(batch_id, runtime=slides.runtime)
    assert recovered['status'] == 'error'
    assert list(slides.root.iterdir()) == []
    assert slides.refunds == [f'batch-row:{batch_id}:row-1:primary']
    batch.get_batch_status(batch_id, runtime=slides.runtime)
    assert len(slides.refunds) == 1
