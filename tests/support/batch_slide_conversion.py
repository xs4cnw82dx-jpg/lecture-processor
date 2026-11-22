import io
import json
import zipfile
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

from lecture_processor.domains.account import lifecycle
from lecture_processor.domains.ai import batch_orchestrator as batch
from lecture_processor.domains.ai.providers.fake import FakeGeminiClient
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.billing import job_charges
from lecture_processor.domains.rate_limit import limiter, quotas
from lecture_processor.domains.upload import import_audio
from tests.credit_test_support import make_credit_runtime


class _SlidesState(SimpleNamespace):
    @property
    def charges(self):
        return list(self.store.docs('credit_charges').values())


def pptx_bytes():
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w', compression=zipfile.ZIP_STORED) as archive:
        for name, content in [('[Content_Types].xml', '<Types/>'), ('ppt/presentation.xml', '<presentation/>')]:
            archive.writestr(zipfile.ZipInfo(name, date_time=(2020, 1, 1, 0, 0, 0)), content)
    return buffer.getvalue()


def make_slides(core, runtime, client, monkeypatch, tmp_path):
    state = _SlidesState(
        runtime=core, root=tmp_path, conversions=[], uploads=[], submitted=[],
        refunds=[], reserved=[], released=[], cleaned=[], checkpoints=[],
        conversion_hook=None, upload_hook=None, checkpoint_hook=None,
        saved_packs=[], job_logs=[], disk_checks=[],
    )
    credit_runtime, state.store = make_credit_runtime(users={'slide-owner': {
        'uid': 'slide-owner', 'account_status': 'active', 'slides_credits': 100, 'total_processed': 0,
    }}, unified_enabled=False)
    monkeypatch.setattr(core, 'UPLOAD_FOLDER', str(tmp_path))
    monkeypatch.setattr(core, 'db', credit_runtime.db)
    monkeypatch.setattr(core, 'UNIFIED_CREDITS_ENABLED', False)
    monkeypatch.setattr(core.firestore, 'transactional', credit_runtime.firestore.transactional)
    monkeypatch.setattr(core.firestore, 'Increment', credit_runtime.firestore.Increment)
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
    monkeypatch.setattr(core, 'get_or_create_user', lambda uid, _email: state.store.docs('users')[uid])
    monkeypatch.setattr(core, 'get_batch_background_queue_stats', lambda: {'active': 0, 'capacity': 4})
    original_refund = job_charges.refund_component

    def observe_refund(row, component, target, refund_ref, **kwargs):
        state.refunds.append(refund_ref)
        return original_refund(row, component, target, refund_ref, **kwargs)

    monkeypatch.setattr(job_charges, 'refund_component', observe_refund)
    monkeypatch.setattr(import_audio, 'cleanup_expired_audio_import_tokens', lambda **_kwargs: None)
    monkeypatch.setattr(core, 'submit_batch_background_job', lambda target, *args, **kwargs: state.submitted.append((target, args, kwargs)))
    monkeypatch.setattr(core, 'wait_for_file_processing', lambda _file: None)
    monkeypatch.setattr(core, 'INSTANT_BATCH_API_STAGGER_SECONDS', 0)
    monkeypatch.setattr(core, 'INSTANT_BATCH_MAX_PARALLEL_ROWS', 2)
    monkeypatch.setattr(core, 'save_job_log', lambda *args: state.job_logs.append(deepcopy(args)))
    monkeypatch.setattr(batch, 'send_batch_completion_email', lambda *_args, **_kwargs: ('skipped', 'isolated test'))
    monkeypatch.setattr(batch, '_run_batch_stage', lambda _batch_id, _stage_name, requests, **_kwargs: [{'response': {'text': 'Synthetic slide notes.'}} for _ in requests])

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
    # A local fake client: rows upload through this seam and instant rows generate through a session.
    fake_client = FakeGeminiClient()
    fake_client.files.upload = upload
    fake_client.models.generate_content = lambda **_kwargs: SimpleNamespace(text='Synthetic slide notes.', usage_metadata=None)
    monkeypatch.setattr(core, 'client', fake_client)
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
