from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib

import pytest

from lecture_processor.domains.account import lifecycle
from lecture_processor.domains.billing import credits, ledger, policy
from tests.credit_test_support import make_credit_runtime


def account(balance=40, **overrides):
    return {'uid': 'owner', 'credits_version': 2, 'credits': balance, 'total_processed': 0,
            'account_status': 'active', **overrides}


def charge(runtime, ref='job-1', *, action='lecture_notes', units=1, overnight=False,
           processed_count=1, admission=None):
    components = {'primary': {'action': action, 'units': units}}
    return ledger.charge_credits('owner', policy.action_cost(action, units=units, overnight=overnight),
                                 'processing', ref, components=components, overnight=overnight,
                                 processed_count=processed_count, admission=admission, runtime=runtime)


def refund(runtime, amount=8, *, charge_ref='job-1', ref='refund-1', processed_count=1):
    return ledger.refund_credits('owner', amount, 'processing_failed', ref, charge_ref=charge_ref,
                                component_targets={'primary': amount}, processed_count=processed_count,
                                runtime=runtime)


def test_charge_journal_is_durable_and_counts_processing_separately_from_credit_units():
    runtime, store = make_credit_runtime(users={'owner': account()})
    receipt = charge(runtime)
    assert receipt['charged_credits'] == 8
    assert receipt['charged'] == {'credits': 8}
    assert receipt['processed_count'] == 1
    assert receipt['admission_state'] == 'pending'
    assert receipt['updated_at'] == store.now
    assert store.docs('users')['owner']['credits'] == 32
    assert store.docs('users')['owner']['total_processed'] == 1
    journal = next(iter(store.docs('credit_charges').values()))
    assert journal['uid'] == 'owner' and journal['charge_ref'] == 'job-1'
    assert journal['components']['primary']['unit_cost'] == 8
    assert journal['admission'] == {}
    store.now += 10
    restored = refund(runtime)
    assert restored['updated_at'] == store.now
    assert restored['refunded_credits'] == 8
    assert restored['processed_refunded'] == 1
    assert store.docs('users')['owner']['credits'] == 40
    assert store.docs('users')['owner']['total_processed'] == 0


def test_simultaneous_replays_deduct_exactly_once():
    runtime, store = make_credit_runtime(users={'owner': account()})
    with ThreadPoolExecutor(max_workers=8) as executor:
        receipts = list(executor.map(lambda _: charge(runtime), range(16)))
    assert all(receipt == receipts[0] for receipt in receipts)
    assert len(store.docs('credit_charges')) == 1
    assert store.docs('users')['owner']['credits'] == 32
    assert store.docs('users')['owner']['total_processed'] == 1


def test_concurrent_distinct_charges_cannot_overspend():
    runtime, store = make_credit_runtime(users={'owner': account(8)})
    def attempt(ref):
        try:
            return charge(runtime, ref)
        except ledger.InsufficientCredits as error:
            return error
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(attempt, ['one', 'two']))
    assert sum(isinstance(item, ledger.InsufficientCredits) for item in results) == 1
    assert store.docs('users')['owner']['credits'] == 0
    assert len(store.docs('credit_charges')) == 1


@pytest.mark.parametrize('change', ['reason', 'amount', 'components', 'mode', 'processed', 'admission'])
def test_same_reference_rejects_different_input_without_another_debit(change):
    runtime, store = make_credit_runtime(users={'owner': account()})
    charge(runtime, admission={'kind': 'runtime_job', 'job_id': 'one'})
    before = deepcopy(store.documents)
    kwargs = dict(amount=8, reason='processing', components={'primary': {'action': 'lecture_notes', 'units': 1}},
                  overnight=False, processed_count=1, admission={'kind': 'runtime_job', 'job_id': 'one'})
    if change == 'reason':
        kwargs['reason'] = 'different'
    elif change == 'amount':
        kwargs['amount'] = 7
    elif change == 'components':
        kwargs['components'] = {'primary': {'action': 'slides_extraction', 'units': 4}}
    elif change == 'mode':
        kwargs['overnight'] = True
    elif change == 'processed':
        kwargs['processed_count'] = 0
    else:
        kwargs['admission']['job_id'] = 'two'
    with pytest.raises(ledger.LedgerConflict):
        ledger.charge_credits('owner', ref='job-1', runtime=runtime, **kwargs)
    assert store.documents == before


def test_repricing_and_new_exemption_do_not_change_committed_charge_or_refund(monkeypatch):
    runtime, store = make_credit_runtime(users={'owner': account()})
    original = charge(runtime)
    monkeypatch.setitem(policy.ACTION_COSTS, 'lecture_notes', {'category': 'lecture', 'instant': 20, 'overnight': 10})
    store.documents[('users', 'owner')]['unlimited_credits'] = {'lecture': True}
    replay = ledger.charge_credits('owner', 8, 'processing', 'job-1', components={'primary': {'action': 'lecture_notes'}},
                                   processed_count=1, runtime=runtime)
    assert replay == original
    assert refund(runtime)['refunded_credits'] == 8
    assert store.docs('users')['owner']['credits'] == 40


def test_charge_and_job_are_one_atomic_transaction_and_admission_state_is_committed():
    runtime, store = make_credit_runtime(users={'owner': account()})
    job = runtime.db.collection('runtime_jobs').document('one')
    @runtime.firestore.transactional
    def admit(transaction):
        context = ledger.read_charge_context(transaction, 'owner', 'job-1', runtime=runtime)
        assert not job.get(transaction=transaction).exists
        prepared = ledger.prepare_charge(context, 8, 'processing', components={'primary': {'action': 'lecture_notes'}},
                                         processed_count=1, admission={'kind': 'runtime_job', 'job_id': 'one', 'state': 'admitted'})
        receipt = ledger.apply_charge(transaction, prepared)
        transaction.set(job, {'uid': 'owner', 'billing_receipt': receipt})
        return receipt
    store.fail_writes.add(('runtime_jobs', 'one'))
    with pytest.raises(RuntimeError, match='Synthetic write failure'):
        admit(runtime.db.transaction())
    assert store.docs('users')['owner']['credits'] == 40
    assert store.docs('credit_charges') == {}
    store.fail_writes.clear()
    receipt = admit(runtime.db.transaction())
    assert receipt['admission_state'] == 'admitted'
    assert store.docs('runtime_jobs')['one']['billing_receipt'] == receipt
    assert next(iter(store.docs('credit_charges').values()))['admission_state'] == 'admitted'


def test_pending_charge_can_be_admitted_without_a_second_debit():
    runtime, store = make_credit_runtime(users={'owner': account()})
    charge(runtime, admission={'kind': 'runtime_job', 'job_id': 'one'})
    receipt = charge(runtime, admission={'kind': 'runtime_job', 'job_id': 'one', 'state': 'admitted'})
    assert receipt['admission_state'] == 'admitted'
    assert store.docs('users')['owner']['credits'] == 32


def test_commit_acknowledgement_failure_can_be_retried_without_recharging():
    runtime, store = make_credit_runtime(users={'owner': account()})
    def lose_ack(_operations):
        store.after_commit = None
        raise RuntimeError('Acknowledgement lost')
    store.after_commit = lose_ack
    with pytest.raises(RuntimeError, match='Acknowledgement lost'):
        charge(runtime)
    receipt = charge(runtime)
    assert receipt['charged_credits'] == 8
    assert store.docs('users')['owner']['credits'] == 32
    assert len(store.docs('credit_charges')) == 1


def test_conversion_activation_then_deactivation_keeps_v2_charges_and_refunds():
    original = {'uid': 'owner', 'lecture_credits_standard': 3, 'slides_credits': 4, 'total_processed': 0}
    runtime, store = make_credit_runtime(users={'owner': original}, unified_enabled=True)
    first = charge(runtime)
    user = store.docs('users')['owner']
    assert first['credit_scheme'] == 2 and user['credits'] == 24
    assert user['legacy_credits_snapshot']['lecture_credits_standard'] == 3
    runtime.UNIFIED_CREDITS_ENABLED = False
    second = charge(runtime, 'job-2')
    assert second['credit_scheme'] == 2 and store.docs('users')['owner']['credits'] == 16
    refund(runtime, charge_ref='job-2')
    assert store.docs('users')['owner']['credits'] == 24
    assert store.docs('users')['owner']['lecture_credits_standard'] == 0


def test_flag_off_unconverted_user_is_charged_in_old_units_without_conversion():
    runtime, store = make_credit_runtime(users={'owner': {'uid': 'owner', 'lecture_credits_extended': 3}}, unified_enabled=False)
    receipt = charge(runtime)
    assert receipt['credit_scheme'] == 1
    assert receipt['components']['primary']['unit_cost'] == 1
    assert receipt['components']['primary']['credit_type'] == 'lecture_credits_extended'
    assert receipt['charged_credits'] == 1
    assert store.docs('users')['owner']['lecture_credits_extended'] == 2
    assert 'credits_version' not in store.docs('users')['owner']
    ledger.refund_credits('owner', 1, 'failed', 'refund-old', charge_ref='job-1', component_targets={'primary': 1},
                          processed_count=1, runtime=runtime)
    assert store.docs('users')['owner']['lecture_credits_extended'] == 3


def test_a_legacy_journal_refund_after_conversion_keeps_original_old_units():
    runtime, store = make_credit_runtime(users={'owner': {'uid': 'owner', 'slides_credits': 5}}, unified_enabled=False)
    charge(runtime, action='interview_coding', units=3, processed_count=0)
    runtime.UNIFIED_CREDITS_ENABLED = True
    first = ledger.refund_credits('owner', 1, 'partial', 'refund-old', charge_ref='job-1',
                                  component_targets={'primary': 1}, runtime=runtime)
    assert first['credit_scheme'] == 1 and first['refunded_credits'] == 1
    assert store.docs('users')['owner']['credits'] == 6
    runtime.UNIFIED_CREDITS_ENABLED = False
    result = ledger.refund_credits('owner', 3, 'partial', 'refund-old', charge_ref='job-1',
                                   component_targets={'primary': 3}, runtime=runtime)
    assert result['refunded_credits'] == 3
    assert store.docs('users')['owner']['credits'] == 10


def test_simultaneous_conversion_charges_convert_the_balance_only_once():
    runtime, store = make_credit_runtime(users={'owner': {'uid': 'owner', 'lecture_credits_standard': 3}})
    with ThreadPoolExecutor(max_workers=2) as executor:
        list(executor.map(lambda ref: charge(runtime, ref), ['first', 'second']))
    assert store.docs('users')['owner']['credits'] == 8
    assert store.docs('users')['owner']['legacy_credits_snapshot']['lecture_credits_standard'] == 3


@pytest.mark.parametrize('overnight', [False, True])
def test_partial_component_refunds_and_exemptions_preserve_actual_charge(overnight):
    runtime, store = make_credit_runtime(users={'owner': account(unlimited_credits={'interview': True})})
    components = {'primary': {'action': 'interview_transcription'}, 'extras': {'action': 'interview_extra', 'units': 3}}
    amount = policy.quote_components(components, overnight=overnight)['quoted_credits']
    receipt = ledger.charge_credits('owner', amount, 'interview', 'job-1', components=components,
                                    overnight=overnight, processed_count=1, runtime=runtime)
    rate = 1 if overnight else 2
    assert receipt['components']['primary']['charged_credits'] == 0
    assert receipt['charged_credits'] == 3 * rate
    refunded = ledger.refund_credits('owner', 2 * rate, 'partial', 'extras', charge_ref='job-1',
                                     component_targets={'extras': 2 * rate}, runtime=runtime)
    assert refunded['refunded_credits'] == 2 * rate
    assert store.docs('users')['owner']['credits'] == 40 - rate
    assert store.docs('users')['owner']['total_processed'] == 1
    with pytest.raises(ledger.LedgerConflict):
        refund(runtime, amount=10)
    ledger.refund_credits('owner', 0, 'failed', 'primary', charge_ref='job-1',
                          component_targets={'primary': 0}, processed_count=1, runtime=runtime)
    assert store.docs('users')['owner']['credits'] == 40 - rate
    assert store.docs('users')['owner']['total_processed'] == 0


def test_zero_exempt_charge_stays_zero_when_exemption_is_later_removed():
    runtime, store = make_credit_runtime(users={'owner': account(0, unlimited_credits={'lecture': True})})
    receipt = charge(runtime)
    assert receipt['charged_credits'] == 0
    store.documents[('users', 'owner')]['unlimited_credits'] = {}
    assert refund(runtime, amount=0)['refunded_credits'] == 0
    assert store.docs('users')['owner']['credits'] == 0
    assert store.docs('users')['owner']['total_processed'] == 0
    with pytest.raises(ledger.LedgerConflict):
        charge(runtime)


def test_cumulative_refunds_under_concurrency_and_distinct_refs_never_exceed_charge():
    runtime, store = make_credit_runtime(users={'owner': account()})
    charge(runtime)
    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(lambda index: refund(runtime, ref=f'refund-{index}'), range(16)))
    assert all(item['refunded_credits'] == 8 for item in results)
    assert store.docs('users')['owner']['credits'] == 40
    assert store.docs('users')['owner']['total_processed'] == 0
    assert refund(runtime, amount=2)['refunded_credits'] == 8
    assert store.docs('users')['owner']['credits'] == 40


def test_cumulative_partial_refund_can_grow_but_not_exceed_the_component():
    runtime, store = make_credit_runtime(users={'owner': account()})
    charge(runtime)
    refund(runtime, amount=2, processed_count=0)
    assert store.docs('users')['owner']['credits'] == 34
    refund(runtime, amount=6, processed_count=0)
    assert store.docs('users')['owner']['credits'] == 38
    before = deepcopy(store.documents)
    with pytest.raises(ledger.LedgerConflict):
        refund(runtime, amount=9)
    assert store.documents == before


def test_refund_key_cannot_be_rebound_to_another_charge_or_reason():
    runtime, store = make_credit_runtime(users={'owner': account()})
    charge(runtime)
    charge(runtime, 'job-2')
    refund(runtime)
    before = deepcopy(store.documents)
    with pytest.raises(ledger.LedgerConflict):
        refund(runtime, charge_ref='job-2')
    with pytest.raises(ledger.LedgerConflict):
        ledger.refund_credits('owner', 8, 'different-reason', 'refund-1', charge_ref='job-1',
                              component_targets={'primary': 8}, runtime=runtime)
    assert store.documents == before


def test_refund_write_failure_rolls_back_balance_counter_and_all_journals():
    runtime, store = make_credit_runtime(users={'owner': account()})
    charge(runtime)
    before = deepcopy(store.documents)
    target = ledger.refund_document_ref(runtime.db, 'owner', 'refund-1')
    store.fail_writes.add(target.path)
    with pytest.raises(RuntimeError, match='Synthetic write failure'):
        refund(runtime)
    assert store.documents == before


@pytest.mark.parametrize('state', ['missing', 'deleting', 'deleted', 'tombstone', 'unreadable_tombstone'])
def test_debit_is_blocked_for_missing_or_unavailable_account(state):
    runtime, store = make_credit_runtime(users={'owner': account()})
    if state == 'missing':
        store.documents.pop(('users', 'owner'))
    elif state in {'deleting', 'deleted'}:
        store.documents[('users', 'owner')]['account_status'] = state
    elif state == 'tombstone':
        store.documents[('account_deletions', 'owner')] = {'status': 'requested'}
    else:
        store.fail_reads.add(('account_deletions', 'owner'))
    before = deepcopy(store.documents)
    with pytest.raises((ledger.LedgerUnavailable, lifecycle.AccountUnavailableError)):
        charge(runtime)
    assert store.documents == before


def test_refund_does_not_recreate_deleted_account():
    runtime, store = make_credit_runtime(users={'owner': account()})
    charge(runtime)
    store.documents.pop(('users', 'owner'))
    before = deepcopy(store.documents)
    with pytest.raises(ledger.LedgerUnavailable):
        refund(runtime)
    assert store.documents == before


@pytest.mark.parametrize('balance', [-1, True, 1.5, '40', None])
def test_invalid_unified_balance_fails_closed_without_any_writes(balance):
    runtime, store = make_credit_runtime(users={'owner': account(balance)})
    before = deepcopy(store.documents)
    with pytest.raises(ledger.LedgerUnavailable):
        charge(runtime)
    assert store.documents == before


@pytest.mark.parametrize('field,rate', [('lecture_credits_extended', 8), ('slides_credits', 2), ('interview_credits_long', 10)])
def test_historical_refund_ledger_amount_is_never_reinterpreted_as_unified_units(field, rate):
    key = 'historical-refund'
    identifier = hashlib.sha256(f'owner:{key}'.encode()).hexdigest()
    runtime, store = make_credit_runtime(users={'owner': {'uid': 'owner', field: 1, 'total_processed': 0}}, documents={
        ('credit_refunds', identifier): {'credit_type': field, 'amount': 1,
            'uid_hash': hashlib.sha256(b'owner').hexdigest(), 'key_hash': hashlib.sha256(key.encode()).hexdigest()},
    })
    assert ledger.refund_legacy_credits('owner', field, 3, key, charged_units=3, runtime=runtime)
    assert store.docs('users')['owner']['credits'] == 3 * rate
    stored = store.docs('credit_refunds')[identifier]
    assert stored['amount'] == 3 and stored['credit_type'] == field
    assert store.docs('users')['owner']['legacy_credits_snapshot'][field] == 1
    assert ledger.refund_legacy_credits('owner', field, 3, key, charged_units=3, runtime=runtime)
    assert store.docs('users')['owner']['credits'] == 3 * rate


def test_completed_historical_refund_replay_does_not_convert_or_mint_again():
    runtime, store = make_credit_runtime(users={'owner': account(30)}, documents={
        ('credit_refunds', hashlib.sha256(b'owner:old-refund').hexdigest()): {'credit_type': 'interview_credits_short', 'amount': 1},
    }, unified_enabled=False)
    before = deepcopy(store.documents)
    assert ledger.refund_legacy_credits('owner', 'interview_credits_short', 1, 'old-refund', charged_units=1,
                                       processed_count=1, runtime=runtime)
    assert store.documents == before


def test_completed_historical_slides_primary_refund_does_not_decrement_processed_twice():
    key = 'runtime-job:old-slides:primary'
    runtime, store = make_credit_runtime(users={'owner': account(30, total_processed=5)}, documents={
        ('credit_refunds', hashlib.sha256(f'owner:{key}'.encode()).hexdigest()): {
            'credit_type': 'slides_credits', 'amount': 1,
        },
    }, unified_enabled=False)
    before = deepcopy(store.documents)
    assert ledger.refund_legacy_credits('owner', 'slides_credits', 1, key, charged_units=1,
                                       processed_count=1, runtime=runtime)
    assert store.documents == before


def test_malformed_historical_processed_count_cannot_be_replayed():
    runtime, store = make_credit_runtime(users={'owner': account()}, documents={
        ('credit_refunds', hashlib.sha256(b'owner:bad-count').hexdigest()): {
            'credit_type': 'slides_credits', 'amount': 1, 'processed_count': 2,
        },
    })
    before = deepcopy(store.documents)
    with pytest.raises(ledger.LedgerUnavailable):
        ledger.refund_legacy_credits('owner', 'slides_credits', 1, 'bad-count', charged_units=1,
                                       processed_count=1, runtime=runtime)
    assert store.documents == before


def test_legacy_refund_after_rollout_rollback_still_uses_converted_balance():
    runtime, store = make_credit_runtime(users={'owner': account(4, total_processed=1)}, unified_enabled=False)
    assert ledger.refund_legacy_credits('owner', 'lecture_credits_standard', 1, 'old-primary',
                                       charged_units=1, processed_count=1, runtime=runtime)
    assert store.docs('users')['owner']['credits'] == 12
    assert store.docs('users')['owner']['total_processed'] == 0
    assert 'lecture_credits_standard' not in store.docs('users')['owner']


def test_historical_zero_actual_charge_cannot_be_refunded_as_one_unit():
    runtime, store = make_credit_runtime(users={'owner': account(0)})
    with pytest.raises(ledger.LedgerConflict):
        ledger.refund_legacy_credits('owner', 'slides_credits', 1, 'zero', charged_units=0, runtime=runtime)
    assert store.docs('users')['owner']['credits'] == 0


def test_legacy_refund_cannot_raise_the_original_debit_cap_on_replay():
    runtime, store = make_credit_runtime(users={'owner': account(0)})
    assert ledger.refund_legacy_credits('owner', 'slides_credits', 1, 'old-extra', charged_units=2, runtime=runtime)
    before = deepcopy(store.documents)
    with pytest.raises(ledger.LedgerConflict):
        ledger.refund_legacy_credits('owner', 'slides_credits', 3, 'old-extra', charged_units=3, runtime=runtime)
    assert store.documents == before


def test_concurrent_primary_and_extra_refunds_preserve_both_component_totals():
    runtime, store = make_credit_runtime(users={'owner': account()})
    components = {'primary': {'action': 'interview_transcription'}, 'extras': {'action': 'interview_extra', 'units': 3}}
    ledger.charge_credits('owner', 16, 'interview', 'job-1', components=components, processed_count=1, runtime=runtime)
    def settle(component):
        return ledger.refund_credits('owner', 10 if component == 'primary' else 4, 'failed', component,
                                     charge_ref='job-1', component_targets={component: 10 if component == 'primary' else 4},
                                     processed_count=1 if component == 'primary' else 0, runtime=runtime)
    with ThreadPoolExecutor(max_workers=2) as executor:
        list(executor.map(settle, ['primary', 'extras']))
    assert store.docs('users')['owner']['credits'] == 38
    assert store.docs('users')['owner']['total_processed'] == 0
    journal = next(iter(store.docs('credit_charges').values()))
    assert journal['refunded_credits'] == 14
    assert journal['components']['primary']['refunded_credits'] == 10
    assert journal['components']['extras']['refunded_credits'] == 4


def test_new_default_grant_and_payload_follow_stored_scheme_and_activation():
    runtime, _store = make_credit_runtime()
    user = credits.build_default_user_data('owner', 'Owner@Example.Test', runtime=runtime)
    assert user['credits'] == 12 and user['credits_version'] == 2
    assert all(user[field] == 0 for field in policy.LEGACY_FIELD_RATES)
    assert credits.build_credit_payload(user, runtime=runtime) == 12
    assert credits.build_category_summary(user, runtime=runtime) == {
        'total': 12, 'unlimited': {'lecture': False, 'slides': False, 'interview': False},
    }
    runtime.UNIFIED_CREDITS_ENABLED = False
    assert credits.build_credit_payload(user, runtime=runtime) == 12
    legacy = credits.build_default_user_data('second', 'second@example.test', runtime=runtime)
    assert 'credits_version' not in legacy
    assert credits.build_credit_payload(legacy, runtime=runtime) == {
        'lecture_standard': 1, 'lecture_extended': 0, 'slides': 2,
        'interview_short': 0, 'interview_medium': 0, 'interview_long': 0,
        'unlimited': {'lecture': False, 'slides': False, 'interview': False},
    }


@pytest.mark.parametrize('converted', [False, True])
@pytest.mark.parametrize('operation', ['grant', 'lecture', 'interview', 'slides', 'refund_primary', 'refund_extras',
                                       'refund_primary_idempotent', 'refund_extras_idempotent'])
def test_legacy_compatibility_helpers_cannot_write_old_fields_during_unified_billing(converted, operation):
    user = {'uid': 'owner', 'total_processed': 3, **dict.fromkeys(policy.LEGACY_FIELD_RATES, 3)}
    if converted:
        user.update(credits_version=2, credits=40)
    runtime, store = make_credit_runtime(users={'owner': user}, unified_enabled=not converted)
    runtime.CREDIT_BUNDLES = deepcopy(policy.LEGACY_CHECKOUT_BUNDLES)
    before = deepcopy(store.documents)
    calls = {
        'grant': lambda: credits.grant_credits_to_user('owner', 'lecture_5', runtime=runtime),
        'lecture': lambda: credits.deduct_credit('owner', 'lecture_credits_standard', runtime=runtime),
        'interview': lambda: credits.deduct_interview_credit('owner', runtime=runtime),
        'slides': lambda: credits.deduct_slides_credits('owner', 1, runtime=runtime),
        'refund_primary': lambda: credits.refund_credit('owner', 'lecture_credits_standard', runtime=runtime),
        'refund_extras': lambda: credits.refund_slides_credits('owner', 1, runtime=runtime),
        'refund_primary_idempotent': lambda: credits.refund_credit('owner', 'lecture_credits_standard', runtime=runtime,
                                                                 idempotency_key='old-primary'),
        'refund_extras_idempotent': lambda: credits.refund_slides_credits('owner', 1, runtime=runtime,
                                                                        idempotency_key='old-extras'),
    }
    assert not calls[operation]()
    assert store.documents == before
