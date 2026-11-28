"""Mixed overnight batches exercised without provider or billing network calls."""
from contextlib import contextmanager
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import batch_orchestrator as batch
from lecture_processor.domains.ai.providers import factory
from lecture_processor.domains.ai.providers.contracts import GenerationResult, PdfPart, TextPart, Usage
from lecture_processor.domains.ai.providers.routing import Route, RoutingSnapshot
from tests.support.batch_worker_heartbeat import BatchHarness

MODEL = 'anthropic/claude-sonnet-5.5'
OPTIONS = {'reasoning_effort': 'medium', 'max_output_tokens': 32768}


def setup(monkeypatch, mode, direct, *, rows=1, fail_first=False, stop=False, truncate_first=False):
    h = BatchHarness(monkeypatch, 'deferred', rows=rows)
    rt = h.runtime
    rt.AI_ROUTING_SNAPSHOT = RoutingSnapshot({stage: Route('openrouter', MODEL, OPTIONS) for stage in direct})
    rt.FEATURE_AUDIO_SECTION_SYNC = False
    rt.PROMPT_SLIDE_EXTRACTION = 'Extract.'
    rt.PROMPT_MERGE_TEMPLATE = 'Merge {slide_text} and {transcript} in {output_language}'
    rt.PROMPT_TEXT_COMBINE_BOTH_TEMPLATE = rt.PROMPT_MERGE_TEMPLATE
    rt.PROMPT_TEXT_COMBINE_SLIDES_ONLY_TEMPLATE = 'Combine {slide_text} in {output_language}'
    rt.MODEL_SLIDES = rt.MODEL_INTEGRATION = 'gemini-synthetic'
    h.calls = []
    h.closed = []
    h.prepared = []
    batch._upsert_batch(h.batch_id, {'mode': mode}, runtime=rt)
    for row in batch._list_rows(h.batch_id, runtime=rt):
        batch._upsert_row(h.batch_id, row['row_id'], {'slide_text': 'Grounded source.',
                          'slides_local_path': '/synthetic/staged.pdf'}, runtime=rt)

    def upload(row, *, runtime, upload_slides=True):
        h.prepared.append(upload_slides)
        row['audio_file_uri'] = 'fake://audio'
        if upload_slides:
            row['slides_file_uri'] = 'fake://slides'

    def generate(stage, parts, **kwargs):
        h.providers.append(stage)
        h.calls.append((stage, parts, kwargs))
        if truncate_first and len(h.calls) == 1:
            cut = GenerationResult('Cut.', None, Usage(10, 8, 18, 0, 0.1), 'openrouter', MODEL)
            kwargs['record_discarded'](stage + '_incomplete_1', cut)
            stored = batch._get_row(h.batch_id, 'row-1', runtime=rt)
            assert stored['token_total'] == 18
            assert stored['token_usage_by_stage'][stage + '_incomplete_1']['cost_usd'] == 0.1
        if stop:
            h.stop_externally()
        if fail_first and len(h.calls) == 1:
            raise ValueError('Synthetic private exception.')
        return GenerationResult('Synthetic complete.', None, Usage(10, 6, 16, 2, 0.125), 'openrouter', MODEL)

    @contextmanager
    def open_session(*args, **kwargs):
        assert kwargs['allow_gemini_fallback'] is False and callable(kwargs['before_request'])
        try:
            yield SimpleNamespace(generate=generate)
        finally:
            h.closed.append(True)

    monkeypatch.setattr(batch, '_upload_row_files', upload)
    monkeypatch.setattr(factory, 'open_provider_session', open_session)
    return h


def test_lecture_audio_runs_in_gemini_before_private_pdf_and_notes(monkeypatch):
    h = setup(monkeypatch, 'lecture-notes', ['slides_extraction', 'notes_merge'])
    h.worker(h.batch_id, runtime=h.runtime)
    assert h.stored_batch()['status'] == 'complete'
    assert h.prepared == [False]
    assert h.providers == ['audio_transcription', 'slides_extraction', 'notes_merge']
    assert h.calls[0][1][0] == PdfPart('/synthetic/staged.pdf')
    assert h.calls[1][2]['source_slide_text'] == 'Synthetic complete.'
    assert len(h.closed) > 0
    row = batch._get_row(h.batch_id, 'row-1', runtime=h.runtime)
    assert row['result'] == 'Synthetic complete.'
    assert row['token_total'] == 32
    assert row['token_usage_by_stage']['audio_transcription']['billing_mode'] == 'batch'
    for stage in ('slide_extraction', 'notes_merge'):
        usage = row['token_usage_by_stage'][stage]
        assert (usage['model'], usage['cost_usd'], usage['billing_mode']) == (MODEL, 0.125, 'standard')


def test_combine_failure_refunds_only_its_row_and_does_not_use_notes_route(monkeypatch):
    h = setup(monkeypatch, 'text-combine', ['text_combine'], rows=2, fail_first=True)
    h.worker(h.batch_id, runtime=h.runtime)
    assert h.stored_batch()['status'] == 'partial'
    assert h.providers == ['text_combine', 'text_combine']
    assert all(isinstance(call[1][0], TextPart) for call in h.calls)
    first, second = batch._list_rows(h.batch_id, runtime=h.runtime)
    assert first['status'] == 'error' and 'Synthetic private exception' not in first['error']
    assert second['status'] == 'complete' and len(h.refunds) == 1
    h.worker(h.batch_id, runtime=h.runtime)
    assert len(h.calls) == 2 and len(h.refunds) == 1


def test_terminal_batch_during_private_call_cannot_publish_or_start_the_next_row(monkeypatch):
    h = setup(monkeypatch, 'text-combine', ['text_combine'], rows=2, stop=True)
    h.worker(h.batch_id, runtime=h.runtime)
    assert h.stored_batch()['provider_state'] == 'EXTERNAL_STOP'
    assert len(h.calls) == 1 and not h.persisted
    assert all('result' not in row for row in batch._list_rows(h.batch_id, runtime=h.runtime))


def test_native_notes_route_does_not_alias_private_text_combine(monkeypatch):
    h = setup(monkeypatch, 'text-combine', ['notes_merge'])
    h.worker(h.batch_id, runtime=h.runtime)
    assert h.providers == ['notes_merge'] and not h.calls
    assert h.stored_batch()['status'] == 'complete'


def test_concurrent_workers_claim_once_and_restart_cannot_replay(monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from lecture_processor.domains.ai import overnight_provider as overnight
    from tests.support.processing_credit_admission import runtime_fixture, stage_batch

    rt, _store = runtime_fixture()
    stage_batch(rt, 'private', 1)
    assert not overnight.claim_worker('private', 'too-early', rt)
    rt.batch_repo.batch_job_doc_ref(rt.db, 'private').update({'status': 'queued', 'credit_admission_state': 'admitted'})
    with ThreadPoolExecutor(max_workers=4) as pool:
        claimed = list(pool.map(lambda n: overnight.claim_worker('private', str(n), rt), range(8)))
    assert sum(claimed) == 1
    owner = batch._get_batch('private', runtime=rt)['overnight_worker_id']
    assert owner == str(claimed.index(True))
    assert not overnight._write('private', 'foreign', {'result': 'foreign'}, rt, row_id='0')

    def forbidden(*args, **kwargs):
        pytest.fail('Restarted worker must leave the existing claim to stale recovery.')

    monkeypatch.setattr(batch, '_upload_batch_files', forbidden)
    batch.process_batch_job('private', runtime=rt)
    assert 'result' not in batch._get_row('private', '0', runtime=rt)


def test_recovery_rechecks_heartbeat_then_fences_late_results_and_refunds_once(monkeypatch):
    from lecture_processor.domains.ai import overnight_provider as overnight
    from tests.test_batch_credit_settlement import charged_row

    rt, store, parent, row = charged_row(monkeypatch, overnight=True)
    batch._upsert_row('batch', '0', row, runtime=rt)
    assert overnight.claim_worker('batch', 'claimed', rt)
    charged_balance = store.docs('users')['owner']['credits']
    assert 0 < 100 - charged_balance < 8
    rt.BATCH_JOB_RECOVERY_STALE_SECONDS = 120
    parent = batch._get_batch('batch', runtime=rt)
    store.now += 121
    batch._upsert_batch('batch', {'last_heartbeat_at': store.now}, runtime=rt)
    batch._repair_inactive_batch_state('batch', batch=parent, runtime=rt)
    assert batch._get_batch('batch', runtime=rt)['status'] == 'queued'
    assert store.docs('users')['owner']['credits'] == charged_balance
    store.now += 121
    assert overnight._write('batch', 'claimed', {'current_stage': 'notes_merge'}, rt, row_id='0')
    parent = batch._get_batch('batch', runtime=rt)
    batch._repair_inactive_batch_state('batch', batch=parent, runtime=rt)
    assert not overnight._write('batch', 'claimed', {'result': 'late'}, rt, row_id='0')
    assert not overnight.claim_worker('batch', 'next', rt)
    assert batch._get_batch('batch', runtime=rt)['status'] == 'error'
    assert batch._get_row('batch', '0', runtime=rt)['status'] == 'error'
    assert 'result' not in batch._get_row('batch', '0', runtime=rt)
    assert store.docs('users')['owner']['credits'] == 100
    batch._repair_inactive_batch_state('batch', runtime=rt)
    assert store.docs('users')['owner']['credits'] == 100


def test_interrupted_recovery_can_resume_after_its_lease_but_worker_cannot_publish(monkeypatch):
    from lecture_processor.domains.ai import overnight_provider as overnight
    from tests.test_batch_credit_settlement import charged_row

    rt, store, _parent, row = charged_row(monkeypatch, overnight=True)
    batch._upsert_row('batch', '0', row, runtime=rt)
    rt.BATCH_JOB_RECOVERY_STALE_SECONDS = 120
    assert overnight.claim_worker('batch', 'claimed', rt)
    store.now += 121
    assert overnight.fence_stale_worker('batch', rt)
    assert not overnight.fence_stale_worker('batch', rt)
    assert not overnight._write('batch', 'claimed', {'result': 'after-fence'}, rt, row_id='0')
    assert not batch._heartbeat_batch('batch', runtime=rt)
    store.now += 121
    batch._repair_inactive_batch_state('batch', runtime=rt)
    assert store.docs('users')['owner']['credits'] == 100
    assert batch._get_batch('batch', runtime=rt)['status'] == 'error'


def test_discarded_attempt_usage_is_persisted_even_if_row_generation_fails(monkeypatch):
    h = setup(monkeypatch, 'text-combine', ['text_combine'], fail_first=True, truncate_first=True)
    h.worker(h.batch_id, runtime=h.runtime)
    stored = batch._get_row(h.batch_id, 'row-1', runtime=h.runtime)
    assert stored['status'] == 'error'
    assert stored['token_total'] == 18 and len(h.refunds) == 1
    assert 'result' not in stored


def test_private_interview_features_share_only_the_existing_gemini_transcript(monkeypatch):
    h = setup(monkeypatch, 'interview', ['interview_summary', 'interview_sections'])
    h.runtime.MODEL_INTERVIEW = 'gemini-synthetic'
    h.runtime.PROMPT_INTERVIEW_TRANSCRIPTION = 'Transcribe in {output_language}.'
    h.runtime.PROMPT_INTERVIEW_SUMMARY = 'Summarize {transcript} in {output_language}.'
    h.runtime.PROMPT_INTERVIEW_SECTIONED = 'Structure {transcript} in {output_language}.'
    batch._upsert_row(h.batch_id, 'row-1', {'interview_features': ['summary', 'sections']}, runtime=h.runtime)
    h.worker(h.batch_id, runtime=h.runtime)
    assert h.providers == ['interview_transcription', 'interview_summary', 'interview_sections']
    assert all(isinstance(part, TextPart) for _stage, parts, _kwargs in h.calls for part in parts)
    row = batch._get_row(h.batch_id, 'row-1', runtime=h.runtime)
    assert row['status'] == 'complete'
    assert row['interview_summary'] == row['interview_sections'] == 'Synthetic complete.'


def test_private_study_tools_consume_native_slide_text(monkeypatch):
    h = setup(monkeypatch, 'slides-only', ['study_tools'])
    h.runtime.PROMPT_STUDY_TEMPLATE = 'Generate {flashcard_amount} cards from {source_text} in {output_language}.'
    batch._upsert_row(h.batch_id, 'row-1', {'study_features': 'flashcards', 'flashcard_selection': 'auto',
                                             'question_selection': 'auto'}, runtime=h.runtime)
    h.worker(h.batch_id, runtime=h.runtime)
    assert h.providers == ['slide_extraction', 'study_tools']
    assert 'Synthetic transcript.' in h.calls[0][1][0].text
    row = batch._get_row(h.batch_id, 'row-1', runtime=h.runtime)
    assert row['status'] == 'complete' and row['study_generation_error']
    assert row['token_usage_by_stage']['study_materials_generation']['model'] == MODEL


def test_firestore_private_writes_persist_only_supported_job_and_row_fields():
    from lecture_processor.domains.ai import overnight_provider as overnight
    from tests.support.processing_credit_admission import runtime_fixture, stage_batch

    rt, _ = runtime_fixture()
    stage_batch(rt, 'private', 1)
    rt.batch_repo.batch_job_doc_ref(rt.db, 'private').update({'status': 'queued', 'credit_admission_state': 'admitted'})
    assert overnight.claim_worker('private', 'owner-worker', rt)
    patch = {'notes_audio_map': ({'section_title': 'Introduction', '_local': 'transient'}, object()),
             '_handle': object(), 'invalid': object(), 'updated_at': rt.time.time()}
    assert overnight._write('private', 'owner-worker', patch, rt)
    assert overnight._write('private', 'owner-worker', patch, rt, row_id='0')
    for document in (batch._get_batch('private', runtime=rt), batch._get_row('private', '0', runtime=rt)):
        assert document['notes_audio_map'] == [{'section_title': 'Introduction'}]
        assert not {'_handle', 'invalid'} & document.keys()
