"""Batch slide preparation uses isolated storage and synthetic converters/providers."""

from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
import threading
from types import SimpleNamespace
import zipfile

import pytest

from lecture_processor.domains.account import lifecycle
from lecture_processor.domains.ai import batch_orchestrator as batch
from lecture_processor.domains.ai import instant_batch_orchestrator as instant
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.billing import credits
from lecture_processor.domains.rate_limit import limiter, quotas
from lecture_processor.domains.upload import import_audio
from lecture_processor.services import media_admission


def pptx_bytes():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, content in [('[Content_Types].xml', '<Types/>'), ('ppt/presentation.xml', '<presentation/>')]:
            archive.writestr(zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0)), content)
    return buffer.getvalue()


@pytest.fixture
def slides(core, runtime, client, monkeypatch, tmp_path):
    state = SimpleNamespace(
        runtime=core, root=tmp_path, conversions=[], uploads=[], submitted=[],
        charges=[], refunds=[], reserved=[], released=[], cleaned=[], checkpoints=[],
        conversion_hook=None, upload_hook=None, checkpoint_hook=None,
        saved_packs=[], job_logs=[], disk_checks=[],
    )
    monkeypatch.setattr(core, 'UPLOAD_FOLDER', str(tmp_path))
    monkeypatch.setattr(core, 'db', None)
    for name in ('_BATCH_JOBS_MEMORY', '_BATCH_ROWS_MEMORY'):
        store = {}
        monkeypatch.setattr(core, name, store, raising=False)
        monkeypatch.setitem(runtime.__dict__, name, store)
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': 'slide-owner', 'email': 'slides@example.test'})
    monkeypatch.setattr(auth_policy, 'is_email_allowed', lambda *_args, **_kwargs: True)
    monkeypatch.setattr(lifecycle, 'ensure_account_allows_writes', lambda *_args, **_kwargs: (True, ''))
    monkeypatch.setattr(lifecycle, 'count_active_jobs_for_user', lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(limiter, 'check_rate_limit', lambda **_kwargs: (True, 0))
    monkeypatch.setattr(quotas, 'has_sufficient_upload_disk_space', lambda amount=0, **_kwargs: state.disk_checks.append(amount) or (True, 10**12, 0))
    monkeypatch.setattr(quotas, 'reserve_daily_upload_bytes', lambda uid, amount, **_kwargs: state.reserved.append((uid, amount)) or (True, 0))
    monkeypatch.setattr(quotas, 'release_daily_upload_bytes', lambda uid, amount, **_kwargs: state.released.append((uid, amount)) or True)
    monkeypatch.setattr(core, 'get_or_create_user', lambda uid, email: {'uid': uid, 'email': email, 'slides_credits': 100})
    monkeypatch.setattr(core, 'get_batch_background_queue_stats', lambda: {'active': 0, 'capacity': 4})
    monkeypatch.setattr(credits, 'has_category_credit', lambda *_args, **_kwargs: True)
    monkeypatch.setattr(credits, 'deduct_credit', lambda uid, credit, **_kwargs: state.charges.append((uid, credit)) or credit)
    monkeypatch.setattr(credits, 'refund_credit', lambda *_args, **kwargs: state.refunds.append(kwargs.get('idempotency_key')) or True)
    monkeypatch.setattr(import_audio, 'cleanup_expired_audio_import_tokens', lambda **_kwargs: None)
    monkeypatch.setattr(core, 'submit_batch_background_job', lambda target, *args, **kwargs: state.submitted.append((target, args, kwargs)))
    monkeypatch.setattr(core, 'wait_for_file_processing', lambda _file: None)
    monkeypatch.setattr(core, 'INSTANT_BATCH_API_STAGGER_SECONDS', 0)
    monkeypatch.setattr(core, 'INSTANT_BATCH_MAX_PARALLEL_ROWS', 2)
    monkeypatch.setattr(core, 'save_job_log', lambda *args: state.job_logs.append(deepcopy(args)))
    monkeypatch.setattr(batch, 'send_batch_completion_email', lambda *_args, **_kwargs: ('skipped', 'isolated test'))
    monkeypatch.setattr(batch, '_run_batch_stage', lambda _batch_id, _stage_name, requests, **_kwargs: [{'response': {'text': 'Synthetic slide notes.'}} for _ in requests])
    monkeypatch.setattr(batch.ai_provider, 'generate_with_policy', lambda *_args, **_kwargs: SimpleNamespace(text='Synthetic slide notes.', usage_metadata=None))

    def save_pack(job_id, payload, **_kwargs):
        payload['study_pack_id'] = f'synthetic-pack-{job_id}'
        state.saved_packs.append(deepcopy(payload))
        return True

    monkeypatch.setattr(batch.ai_pipelines, 'save_study_pack', save_pack)

    def cleanup(paths, _provider_files):
        for path in paths:
            if path:
                state.cleaned.append(str(path))
                Path(path).unlink(missing_ok=True)

    def convert(source, target):
        state.conversions.append((str(source), str(target)))
        if state.conversion_hook:
            return state.conversion_hook(source, target)
        Path(target).write_bytes(b'%PDF-1.7 synthetic converted slides')
        return str(target), ''

    def upload(file, config=None):
        state.uploads.append((str(file), Path(file).read_bytes(), dict(config or {})))
        if state.upload_hook:
            state.upload_hook(file)
        return SimpleNamespace(uri=f'fake://slides/{len(state.uploads)}', name='synthetic-provider-file')

    monkeypatch.setattr(core, 'cleanup_files', cleanup)
    monkeypatch.setattr(core, 'convert_pptx_to_pdf', convert)
    monkeypatch.setattr(core, 'client', SimpleNamespace(files=SimpleNamespace(upload=upload)))
    original_upsert = batch._upsert_row

    def checkpoint(batch_id, row_id, payload, runtime=None, merge=True):
        state.checkpoints.append((batch_id, row_id, deepcopy(payload)))
        if state.checkpoint_hook:
            state.checkpoint_hook(batch_id, row_id, payload)
        return original_upsert(batch_id, row_id, payload, runtime=runtime, merge=merge)

    monkeypatch.setattr(batch, '_upsert_row', checkpoint)

    def post(strategy='deferred', first=None, filename='first.PPTX'):
        return client.post('/api/instant-batch/jobs' if strategy == 'instant' else '/api/batch/jobs', data={
            'mode': 'slides-only', 'batch_title': 'Synthetic slide conversion',
            'rows': json.dumps([{'row_id': 'row-1'}, {'row_id': 'row-2'}]),
            'row_1_slides': (io.BytesIO(pptx_bytes() if first is None else first), filename),
            'row_2_slides': (io.BytesIO(b'%PDF-1.7 synthetic PDF'), 'second.pdf'),
        })

    state.post = post
    return state


def seed_batch(slides, *, strategy='deferred', count=1, extension='.pptx'):
    batch_id = f'synthetic-{strategy}-slides'
    rows = []
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
    assert list(slides.root.iterdir()) == []
    worker(strategy)(batch_id, runtime=slides.runtime)
    batch.get_batch_status(batch_id, runtime=slides.runtime)
    assert len(slides.refunds) == 1
    lease, status = media_admission.try_acquire('slide-owner')
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
    lease, status = media_admission.try_acquire('slide-owner')
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
    lease, status = media_admission.try_acquire('another-media-owner')
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
    lease, status = media_admission.try_acquire('slide-owner')
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
def test_worker_waits_for_media_admission_without_early_refund(slides, monkeypatch, strategy, owner):
    batch_id, _rows = seed_batch(slides, strategy=strategy)
    lease, status = media_admission.try_acquire(owner)
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
    lease, status = media_admission.try_acquire('another-media-owner')
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
        lease, status = media_admission.try_acquire('another-media-owner')
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
    released, status = media_admission.try_acquire('slide-owner')
    assert status == 0
    released.release()


def test_parallel_instant_rows_serialize_conversion_instead_of_failing_contention(slides, monkeypatch):
    batch_id, _rows = seed_batch(slides, strategy='instant', count=2)
    entered, waiting, release = threading.Event(), threading.Event(), threading.Event()
    lock = threading.Lock()
    activity = {'active': 0, 'peak': 0, 'calls': 0}
    original_acquire = batch.media_admission.try_acquire

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

    monkeypatch.setattr(batch.media_admission, 'try_acquire', observe_admission)
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
