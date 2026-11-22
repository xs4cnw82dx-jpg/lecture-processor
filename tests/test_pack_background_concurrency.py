"""Background pack writes with deterministic interleavings and synthetic storage."""

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Event, RLock
from types import SimpleNamespace

import pytest

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.ai import pipelines
from lecture_processor.domains.billing import job_charges
from lecture_processor.domains.runtime_jobs import recovery
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.repositories import runtime_jobs_repo, study_repo
from tests import credit_test_support
from tests.credit_test_support import Reference, Transaction
from tests.support.pack_background_concurrency import (
    canonical_job,
    pack,
    question,
    run_regeneration,
    seed_regeneration,
    writes_generated_pack,
)


def source(state):
    return state.store.docs('study_pack_sources')['pack']


def assert_refunded_once(state):
    job = runtime_jobs_store.get_job_snapshot('regenerate', runtime=state.runtime)
    balance_field, expected_balance = ('credits', 100) if state.scheme == 'unified' else ('slides_credits', 1)
    assert {
        'status': job['status'], 'refunded': job['credit_refunded'],
        'balance': state.store.docs('users')['owner'][balance_field],
        'refund_records': len(state.store.docs('credit_refunds')),
    } == {'status': 'error', 'refunded': True, 'balance': expected_balance, 'refund_records': 1}
    if state.scheme == 'unified':
        assert job['billing_receipt']['refunded_credits'] == job['billing_receipt']['charged_credits'] == 2
    else:
        assert job['billing_receipt']['refunded'] == {'slides_credits': 1}
    before = state.store.docs('users'), state.store.docs('credit_refunds')
    assert job_charges.refund_component(
        job, 'extras', 1, 'runtime-job:regenerate:extras',
        legacy_credit_type='slides_credits', legacy_charged_units=1, runtime=state.runtime,
    )
    assert (state.store.docs('users'), state.store.docs('credit_refunds')) == before


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
@pytest.mark.parametrize('changed', ['cards', 'notes', 'pictures'])
def test_regeneration_preserves_a_content_edit_committed_during_generation(background, monkeypatch, scheme, changed):
    state = background(scheme)
    seed_regeneration(state)
    expected = []

    def edit():
        current = pack(state)
        if changed == 'notes':
            fields = {'notes_markdown': '# The owner has revised these notes'}
        else:
            cards = current['flashcards']
            if changed == 'cards':
                cards[0]['back'] = 'The owner has revised this answer'
            else:
                cards[0]['image_ids'] = ['a' * 64]
            fields = {'flashcards': cards}
        study_repo.study_pack_doc_ref(state.runtime.db, 'pack').update(fields)
        expected.append(pack(state))

    run_regeneration(state, monkeypatch, edit)

    assert pack(state) == expected[0]
    assert_refunded_once(state)


def test_regeneration_rejects_a_changed_fallback_source(background, monkeypatch):
    state = background()
    state.store.documents[('study_packs', 'pack')]['notes_markdown'] = ''
    original = pack(state)
    seed_regeneration(state)

    def edit():
        study_repo.study_pack_source_doc_ref(state.runtime.db, 'pack').update({'transcript': 'Revised source transcript'})

    run_regeneration(state, monkeypatch, edit)

    assert pack(state) == original
    assert source(state)['transcript'] == 'Revised source transcript'
    assert_refunded_once(state)


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
@pytest.mark.parametrize('metadata_change', [False, True], ids=['unchanged', 'metadata'])
def test_regeneration_succeeds_with_unchanged_content(background, monkeypatch, scheme, metadata_change):
    state = background(scheme)
    seed_regeneration(state)

    def edit():
        if metadata_change:
            study_repo.study_pack_doc_ref(state.runtime.db, 'pack').update({
                'title': 'Revised title', 'pinned': True, 'updated_at': state.store.now + 1,
            })

    run_regeneration(state, monkeypatch, edit)

    saved = pack(state)
    assert saved['flashcards'][0]['back'] == 'Generated answer'
    assert saved['test_questions'] == [question('generated')]
    assert saved['title'] == ('Revised title' if metadata_change else 'Original title')
    assert runtime_jobs_store.get_job_snapshot('regenerate', runtime=state.runtime)['status'] == 'complete'
    assert not state.store.docs('credit_refunds')
    balance_field, expected_balance = ('credits', 98) if scheme == 'unified' else ('slides_credits', 0)
    assert state.store.docs('users')['owner'][balance_field] == expected_balance


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
def test_provider_failure_preserves_pack_and_refunds_once(background, monkeypatch, scheme):
    state = background(scheme)
    original = pack(state)
    seed_regeneration(state)

    run_regeneration(state, monkeypatch, fail=True)

    assert pack(state) == original
    assert_refunded_once(state)


def separate_recovery_runtime(state):
    runtime = SimpleNamespace(**state.runtime.__dict__)
    runtime.__dict__.update(
        jobs={}, JOBS_LOCK=RLock(), RUNTIME_JOB_RECOVERY_ENABLED=True,
        RUNTIME_JOB_RECOVERY_STALE_SECONDS=120,
        os=SimpleNamespace(getenv=lambda *_args: 'synthetic-recovery', getpid=lambda: 7),
    )
    return runtime


def assert_charged_without_refund(state):
    assert canonical_job(state)['status'] == 'complete'
    assert canonical_job(state)['study_pack_id'] == 'pack'
    assert not state.store.docs('credit_refunds')
    field, balance = ('credits', 98) if state.scheme == 'unified' else ('slides_credits', 0)
    assert state.store.docs('users')['owner'][field] == balance


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
def test_publication_and_completion_are_one_commit_before_queued_recovery(background, monkeypatch, scheme):
    state = background(scheme)
    seed_regeneration(state)
    recovery_runtime = separate_recovery_runtime(state)
    observations = []

    def after_commit(operations):
        if not writes_generated_pack(operations):
            return
        state.store.after_commit = None
        atomic_receipt = any(
            ref.path == ('runtime_jobs', 'regenerate') and payload
            and payload.get('status') == 'complete'
            for _operation, ref, payload, _merge in operations
        ) and canonical_job(state).get('study_pack_id') == 'pack'
        state.store.now += 181
        recovered = recovery.recover_runtime_job_if_stale('regenerate', runtime=recovery_runtime)
        observations.append((atomic_receipt, recovered))

    state.store.after_commit = after_commit
    run_regeneration(state, monkeypatch)

    assert observations == [(True, False)]
    assert pack(state)['flashcards'][0]['back'] == 'Generated answer'
    assert_charged_without_refund(state)


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
def test_recovery_claim_before_refund_fences_late_publication(background, monkeypatch, scheme):
    state = background(scheme)
    seed_regeneration(state)
    original = pack(state)
    recovery_runtime = separate_recovery_runtime(state)
    recovery_claimed, allow_refund = Event(), Event()
    refund_component = job_charges.refund_component
    futures = []

    def pause_recovery_refund(*args, **kwargs):
        if kwargs.get('runtime') is recovery_runtime:
            recovery_claimed.set()
            assert allow_refund.wait(5), 'The synthetic recovery must be released'
        return refund_component(*args, **kwargs)

    monkeypatch.setattr(job_charges, 'refund_component', pause_recovery_refund)
    with ThreadPoolExecutor(max_workers=1) as executor:
        def during_generation():
            state.store.now += 181
            futures.append(executor.submit(
                recovery.recover_runtime_job_if_stale, 'regenerate', runtime=recovery_runtime,
            ))
            assert recovery_claimed.wait(5), 'Actual recovery must claim before publication resumes'
            assert canonical_job(state)['status'] == 'processing'
            assert canonical_job(state)['recovery_claimed_at'] > 0
            assert not state.store.docs('credit_refunds')

        try:
            run_regeneration(state, monkeypatch, during_generation)
            assert pack(state) == original
        finally:
            allow_refund.set()
            assert futures and futures[0].result(timeout=5)

    # Inspect the separate recovery worker's durable result, not the publisher's cache.
    state.runtime.jobs.clear()
    assert_refunded_once(state)


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
@pytest.mark.parametrize('readback_available', [True, False], ids=['readback', 'readback-unavailable'])
def test_committed_publication_with_lost_ack_is_never_refunded(
    background, monkeypatch, scheme, readback_available,
):
    state = background(scheme)
    seed_regeneration(state)
    acknowledgements_lost = []

    def after_commit(operations):
        if not writes_generated_pack(operations):
            return
        state.store.after_commit = None
        acknowledgements_lost.append(True)
        assert state.runtime.jobs['regenerate']['status'] == 'processing'
        if not readback_available:
            state.store.fail_reads.add(('runtime_jobs', 'regenerate'))
        raise RuntimeError('Synthetic acknowledgement lost after durable commit')

    state.store.after_commit = after_commit
    run_regeneration(state, monkeypatch)

    assert acknowledgements_lost == [True]
    assert pack(state)['flashcards'][0]['back'] == 'Generated answer'
    assert_charged_without_refund(state)


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
def test_failure_before_publication_commit_preserves_pack_and_refunds_once(background, monkeypatch, scheme):
    state = background(scheme)
    seed_regeneration(state)
    original, rejected_commits = pack(state), []

    def before_commit(operations):
        if not writes_generated_pack(operations):
            return
        state.store.before_commit = None
        rejected_commits.append(True)
        raise RuntimeError('Synthetic commit rejected before applying any write')

    state.store.before_commit = before_commit
    run_regeneration(state, monkeypatch)

    assert rejected_commits == [True]
    assert pack(state) == original
    assert_refunded_once(state)


def test_unused_transcript_change_does_not_reject_notes_based_generation(background, monkeypatch):
    state = background()
    seed_regeneration(state)

    def edit_unused_source():
        study_repo.study_pack_source_doc_ref(state.runtime.db, 'pack').update({'transcript': 'New unused transcript'})

    run_regeneration(state, monkeypatch, edit_unused_source)

    assert source(state)['transcript'] == 'New unused transcript'
    assert pack(state)['flashcards'][0]['back'] == 'Generated answer'
    assert_charged_without_refund(state)


def test_account_deletion_request_during_generation_blocks_publication(background, monkeypatch):
    state = background()
    seed_regeneration(state)
    original = pack(state)

    def request_deletion():
        assert account_lifecycle.mark_account_deletion_requested('owner', runtime=state.runtime)

    run_regeneration(state, monkeypatch, request_deletion)

    assert pack(state) == original
    assert state.store.docs('account_deletions')['owner']['status'] == 'requested'


@pytest.mark.parametrize('change', ['deleted', 'other-owner', 'other-pack', 'terminal'])
def test_changed_canonical_job_cannot_authorize_publication(background, monkeypatch, change):
    state = background()
    seed_regeneration(state)
    original = pack(state)

    def change_canonical_job():
        ref = runtime_jobs_repo.doc_ref(state.runtime.db, 'runtime_jobs', 'regenerate')
        if change == 'deleted':
            ref.delete()
        elif change == 'other-owner':
            ref.update({'user_id': 'other-owner'})
        elif change == 'other-pack':
            ref.update({'study_pack_id': 'other-pack'})
        else:
            ref.update({'status': 'error'})

    run_regeneration(state, monkeypatch, change_canonical_job)

    assert pack(state) == original
    if change == 'deleted':
        assert canonical_job(state) is None
    elif change == 'other-owner':
        assert canonical_job(state)['user_id'] == 'other-owner'
    elif change == 'other-pack':
        assert canonical_job(state)['study_pack_id'] == 'other-pack'
    else:
        assert canonical_job(state)['status'] == 'error'


@pytest.mark.parametrize('change', ['deleted', 'other-owner'])
def test_pack_replaced_or_deleted_during_generation_is_not_published(background, monkeypatch, change):
    state = background()
    seed_regeneration(state)
    expected = []

    def change_pack():
        ref = study_repo.study_pack_doc_ref(state.runtime.db, 'pack')
        if change == 'deleted':
            ref.delete()
        else:
            ref.update({'uid': 'other-owner'})
        expected.append(state.store.docs('study_packs').get('pack'))

    run_regeneration(state, monkeypatch, change_pack)

    assert state.store.docs('study_packs').get('pack') == expected[0]
    assert_refunded_once(state)


def test_changed_fallback_source_owner_blocks_publication(background, monkeypatch):
    state = background()
    state.store.documents[('study_packs', 'pack')]['notes_markdown'] = ''
    original = pack(state)
    seed_regeneration(state)

    def change_source_owner():
        study_repo.study_pack_source_doc_ref(state.runtime.db, 'pack').update({'uid': 'other-owner'})

    run_regeneration(state, monkeypatch, change_source_owner)

    assert pack(state) == original
    assert source(state)['uid'] == 'other-owner'
    assert_refunded_once(state)


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
def test_completed_regeneration_callback_does_not_generate_again(background, monkeypatch, scheme):
    state = background(scheme)
    seed_regeneration(state)
    generated = []
    run_regeneration(state, monkeypatch, lambda: generated.append(True))
    saved = pack(state)

    pipelines.regenerate_study_tools_for_pack('regenerate', 'pack', runtime=state.runtime)

    assert generated == [True]
    assert pack(state) == saved
    assert_charged_without_refund(state)


def writes_refund(operations):
    return any(ref.path[0] == 'credit_refunds' for _operation, ref, _payload, _merge in operations)


def writes_job_fields(operations, **fields):
    return any(
        ref.path == ('runtime_jobs', 'regenerate') and payload
        and all(payload.get(key) == value for key, value in fields.items())
        for _operation, ref, payload, _merge in operations
    )


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
@pytest.mark.parametrize('failure', ['refund-before', 'refund-ack', 'bookkeeping-before', 'bookkeeping-ack'])
def test_settlement_retry_uses_one_cumulative_unit_after_uncertain_ack(background, monkeypatch, scheme, failure):
    state = background(scheme)
    seed_regeneration(state)
    injected = []

    def intercept(operations):
        relevant = writes_refund(operations) if failure.startswith('refund') else writes_job_fields(
            operations, credit_refunded=True, extra_slides_refunded=1, extra_slides_refund_pending=0,
        )
        if not relevant:
            return
        state.store.before_commit = state.store.after_commit = None
        injected.append(True)
        raise RuntimeError('Synthetic settlement acknowledgement failure')

    if failure.endswith('before'):
        state.store.before_commit = intercept
    else:
        state.store.after_commit = intercept
    run_regeneration(state, monkeypatch, fail=True)

    assert injected == [True]
    assert canonical_job(state)['status'] == 'error'
    assert canonical_job(state).get('extra_slides_refund_pending', 0) == (0 if failure == 'bookkeeping-ack' else 1)
    if failure != 'bookkeeping-ack':
        assert canonical_job(state)['expires_at_ts'] is None
    credited_before = state.store.docs('users')
    state.runtime.jobs.clear()
    pipelines.regenerate_study_tools_for_pack('regenerate', 'pack', runtime=state.runtime)

    assert_refunded_once(state)
    assert canonical_job(state)['extra_slides_refunded'] == 1
    assert canonical_job(state)['extra_slides_refund_pending'] == 0
    assert canonical_job(state)['expires_at_ts'] is not None
    if failure != 'refund-before':
        assert state.store.docs('users') == credited_before


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
@pytest.mark.parametrize('readback_available', [True, False], ids=['readback', 'unavailable'])
def test_lost_failure_claim_ack_refunds_only_after_durable_fence(background, monkeypatch, scheme, readback_available):
    state = background(scheme)
    seed_regeneration(state)
    injected = []

    def after_commit(operations):
        if not writes_job_fields(operations, status='error', extra_slides_refund_pending=1):
            return
        state.store.after_commit = None
        injected.append(True)
        if not readback_available:
            state.store.fail_reads.add(('runtime_jobs', 'regenerate'))
        raise RuntimeError('Synthetic failure-claim acknowledgement lost')

    state.store.after_commit = after_commit
    run_regeneration(state, monkeypatch, fail=True)

    assert injected == [True]
    assert canonical_job(state)['status'] == 'error'
    if readback_available:
        assert_refunded_once(state)
    else:
        assert not state.store.docs('credit_refunds')
        assert canonical_job(state)['extra_slides_refund_pending'] == 1
        assert canonical_job(state)['expires_at_ts'] is None
        state.store.fail_reads.clear()
        pipelines.regenerate_study_tools_for_pack('regenerate', 'pack', runtime=state.runtime)
        assert_refunded_once(state)


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
@pytest.mark.parametrize('change', ['deleted', 'other-owner', 'recovery-claimed'])
def test_refund_bookkeeping_does_not_recreate_or_overwrite_changed_job(background, monkeypatch, scheme, change):
    state = background(scheme)
    seed_regeneration(state)
    expected = []

    def after_refund(operations):
        if not writes_refund(operations):
            return
        state.store.after_commit = None
        ref = runtime_jobs_repo.doc_ref(state.runtime.db, 'runtime_jobs', 'regenerate')
        if change == 'deleted':
            ref.delete()
        else:
            ref.update({'user_id': 'other-owner'} if change == 'other-owner' else {'recovery_claimed_at': state.store.now})
        expected.append(canonical_job(state))

    state.store.after_commit = after_refund
    run_regeneration(state, monkeypatch, fail=True)

    assert expected and canonical_job(state) == expected[0]
    field, balance = ('credits', 100) if scheme == 'unified' else ('slides_credits', 1)
    assert state.store.docs('users')['owner'][field] == balance
    assert len(state.store.docs('credit_refunds')) == 1


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
def test_lost_start_ack_defers_without_generating_or_refunding(background, monkeypatch, scheme):
    state = background(scheme)
    seed_regeneration(state)
    original = pack(state)
    generated, lost = [], []
    monkeypatch.setattr(pipelines.study_generation.factory, 'open_provider_session', lambda *_args, **_kwargs: generated.append(True))

    def after_commit(operations):
        if not writes_job_fields(operations, status='processing'):
            return
        state.store.after_commit = None
        lost.append(True)
        raise RuntimeError('Synthetic start acknowledgement lost')

    state.store.after_commit = after_commit
    pipelines.regenerate_study_tools_for_pack('regenerate', 'pack', runtime=state.runtime)

    assert lost == [True] and not generated
    assert pack(state) == original
    assert canonical_job(state)['status'] == 'processing'
    assert not state.store.docs('credit_refunds')
    state.store.now += 181
    assert recovery.recover_runtime_job_if_stale('regenerate', runtime=separate_recovery_runtime(state))
    state.runtime.jobs.clear()
    assert_refunded_once(state)


def test_stale_cached_owner_cannot_act_on_another_canonical_job(background, monkeypatch):
    state = background()
    seed_regeneration(state)
    state.runtime.jobs['regenerate']['user_id'] = 'stale-other-owner'
    before, generated = deepcopy(state.store.documents), []
    monkeypatch.setattr(pipelines.study_generation.factory, 'open_provider_session', lambda *_args, **_kwargs: generated.append(True))

    pipelines.regenerate_study_tools_for_pack('regenerate', 'pack', runtime=state.runtime)

    assert not generated
    assert state.store.documents == before
    assert 'regenerate' not in state.runtime.jobs


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
def test_unexpected_refund_helper_exception_preserves_pending_settlement(background, monkeypatch, scheme):
    state = background(scheme)
    seed_regeneration(state)
    refund = job_charges.refund_component

    def fail_refund(*_args, **_kwargs):
        raise RuntimeError('Synthetic refund helper interruption')

    monkeypatch.setattr(job_charges, 'refund_component', fail_refund)
    try:
        run_regeneration(state, monkeypatch, fail=True)
    except RuntimeError as error:
        pytest.fail(f'Refund helper interruption escaped the background handler: {error}')

    assert canonical_job(state)['status'] == 'error'
    assert canonical_job(state)['extra_slides_refund_pending'] == 1
    assert canonical_job(state)['expires_at_ts'] is None
    assert not state.store.docs('credit_refunds')
    monkeypatch.setattr(job_charges, 'refund_component', refund)
    pipelines.regenerate_study_tools_for_pack('regenerate', 'pack', runtime=state.runtime)
    assert_refunded_once(state)


@pytest.mark.parametrize('change', ['refunded', 'missing', 'closed'])
def test_changed_charge_journal_blocks_publication_without_trusting_cached_receipt(background, monkeypatch, change):
    state = background()
    seed_regeneration(state)
    original = pack(state)

    def change_journal():
        current = canonical_job(state)
        ref = job_charges.ledger.charge_document_ref(state.runtime.db, 'owner', current['charge_ref'])
        if change == 'refunded':
            assert job_charges.refund_component(
                current, 'extras', 1, 'runtime-job:regenerate:extras', runtime=state.runtime,
            )
        elif change == 'missing':
            ref.delete()
        else:
            ref.update({'admission_state': 'closed'})
        assert not canonical_job(state).get('credit_refunded')

    run_regeneration(state, monkeypatch, change_journal)

    assert pack(state) == original
    assert canonical_job(state)['status'] == 'error'
    if change == 'missing':
        assert canonical_job(state)['extra_slides_refund_pending'] == 1
        assert not state.store.docs('credit_refunds')
    else:
        assert_refunded_once(state)


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
@pytest.mark.parametrize('winner', ['publication', 'failure'])
def test_delayed_publication_and_failure_claim_conflict_on_canonical_read_version(background, monkeypatch, scheme, winner):
    state = background(scheme)
    seed_regeneration(state)
    original = pack(state)
    versions, events, delayed = {}, [], []
    original_get = Reference.get

    class VersionConflict(RuntimeError):
        pass

    class VersionedTransaction(Transaction):
        def __init__(self, store):
            super().__init__(store)
            self.read_versions = {}

        def apply(self):
            if any(versions.get(path, 0) != version for path, version in self.read_versions.items()):
                raise VersionConflict('Synthetic read-version precondition failed')
            super().commit()
            for _operation, ref, _payload, _merge in self.operations:
                versions[ref.path] = versions.get(ref.path, 0) + 1

        def commit(self):
            if writes_generated_pack(self.operations) and not delayed:
                delayed.append(self)
                events.append('publication queued without acknowledgement')
                raise TimeoutError('Synthetic publication still in flight')
            is_claim = writes_job_fields(self.operations, status='error', extra_slides_refund_pending=1)
            if is_claim and winner == 'publication':
                delayed[0].apply()
                events.append('publication committed')
                with pytest.raises(VersionConflict):
                    self.apply()
                events.append('failure claim aborted')
                raise VersionConflict('Synthetic claim transaction lost its read version')
            self.apply()
            if is_claim and winner == 'failure':
                events.append('failure claim committed')
                with pytest.raises(VersionConflict):
                    delayed[0].apply()
                events.append('publication aborted')

    def get_with_version(ref, transaction=None, field_paths=None):
        snapshot = original_get(ref, transaction=transaction, field_paths=field_paths)
        if isinstance(transaction, VersionedTransaction):
            transaction.read_versions.setdefault(ref.path, versions.get(ref.path, 0))
        return snapshot

    monkeypatch.setattr(Reference, 'get', get_with_version)
    # Cover both the old bare Reference.update and the conditional transaction.
    # A bare write records no read precondition and therefore cannot be fenced.
    monkeypatch.setattr(credit_test_support, 'Transaction', VersionedTransaction)
    monkeypatch.setattr(state.store.db, 'transaction', lambda: VersionedTransaction(state.store))
    run_regeneration(state, monkeypatch)

    if len(events) == 1 and delayed:
        delayed[0].apply()
        events.append('unfenced late publication committed')
    assert events and events[0] == 'publication queued without acknowledgement'
    assert len(events) == 3
    if winner == 'publication':
        assert events[1:] == ['publication committed', 'failure claim aborted']
        assert pack(state)['flashcards'][0]['back'] == 'Generated answer'
        assert_charged_without_refund(state)
    else:
        assert events[1:] == ['failure claim committed', 'publication aborted']
        assert pack(state) == original
        assert_refunded_once(state)
