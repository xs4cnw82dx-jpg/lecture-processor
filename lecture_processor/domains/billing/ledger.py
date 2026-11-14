"""Transactional credit journals with immutable debit amounts and capped refunds.

The read/prepare/apply split lets admissions write their job and its debit in
one Firestore transaction, after every caller-owned read has completed.
"""

from collections.abc import Mapping
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json

from lecture_processor.domains.account import lifecycle
from lecture_processor.domains.billing import credits, policy
from lecture_processor.runtime.container import get_runtime


CHARGES_COLLECTION = 'credit_charges'
REFUNDS_COLLECTION = 'credit_refunds'
MAX_CREDIT_VALUE = (1 << 63) - 1


class LedgerUnavailable(RuntimeError):
    status_code = 503


class LedgerConflict(RuntimeError):
    status_code = 409


class InsufficientCredits(RuntimeError):
    status_code = 402

    def __init__(self, needed, available, *, credit_scheme=2, category='', action=''):
        self.needed, self.available = needed, available
        self.credit_scheme, self.category, self.action = credit_scheme, category, action
        super().__init__(f'Not enough credits: need {needed}, have {available}.')


@dataclass(frozen=True)
class ChargeContext:
    uid: str
    ref: str
    scheme: int
    user_data: dict
    user_ref: object
    journal_data: dict
    journal_ref: object
    runtime: object


@dataclass(frozen=True)
class PreparedCharge:
    context: ChargeContext
    receipt: dict
    user_updates: dict
    journal_data: dict


def _runtime(runtime):
    resolved = runtime if runtime is not None else get_runtime()
    if getattr(resolved, 'db', None) is None or not hasattr(resolved.db, 'transaction'):
        raise LedgerUnavailable('Credit storage is unavailable.')
    return resolved


def _integer(value, name, *, stored=False):
    if type(value) is not int or not 0 <= value <= MAX_CREDIT_VALUE:
        error = LedgerUnavailable if stored else LedgerConflict
        raise error(f'Invalid {name}.')
    return value


def _text(value, name):
    if not isinstance(value, str) or not value.strip():
        raise LedgerConflict(f'Invalid {name}.')
    return value


def _legacy_balance(user, field):
    try:
        value = policy._legacy_units(user.get(field, 0))
    except ValueError as error:
        raise LedgerUnavailable('Legacy credit data is unavailable.') from error
    return _integer(value, 'legacy balance', stored=True)


def _snapshot_data(snapshot, *, required=False):
    if not getattr(snapshot, 'exists', False):
        if required:
            raise LedgerUnavailable('Credit record is unavailable.')
        return {}
    data = snapshot.to_dict()
    if not isinstance(data, dict):
        raise LedgerUnavailable('Credit record is unavailable.')
    return data


def charge_document_ref(db, uid, ref):
    identity = json.dumps([uid, ref], separators=(',', ':'), ensure_ascii=True)
    return db.collection(CHARGES_COLLECTION).document(hashlib.sha256(identity.encode()).hexdigest())


def refund_document_ref(db, uid, ref):
    # Existing refunds use this exact identifier and store amounts in old units.
    return db.collection(REFUNDS_COLLECTION).document(hashlib.sha256(f'{uid}:{ref}'.encode()).hexdigest())


def _read_user(transaction, uid, runtime):
    ref = runtime.users_repo.doc_ref(runtime.db, uid)
    data = _snapshot_data(ref.get(transaction=transaction), required=True)
    lifecycle.require_account_access(uid, runtime=runtime, transaction=transaction)
    if str(data.get('account_status', '') or '').strip().lower() in {'deleting', 'deleted'}:
        raise lifecycle.AccountUnavailableError('Account is unavailable.')
    if data.get('uid') not in (None, '', uid):
        raise LedgerUnavailable('Credit account does not match its owner.')
    version = data.get('credits_version')
    if version is not None and (type(version) is not int or version not in {0, 1, 2}):
        raise LedgerUnavailable('Credit account version is unavailable.')
    return ref, data


def read_charge_context(transaction, uid, ref, *, runtime=None):
    runtime = _runtime(runtime)
    uid, ref = _text(uid, 'account'), _text(ref, 'charge reference')
    try:
        user_ref, user = _read_user(transaction, uid, runtime)
        journal_ref = charge_document_ref(runtime.db, uid, ref)
        journal = _snapshot_data(journal_ref.get(transaction=transaction))
    except (LedgerUnavailable, lifecycle.AccountUnavailableError):
        raise
    except Exception as error:
        raise LedgerUnavailable('Credit records could not be read.') from error
    scheme = 2 if policy.uses_unified_credits(user, runtime) else 1
    return ChargeContext(uid, ref, scheme, user, user_ref, journal, journal_ref, runtime)


def _request(amount, reason, components, overnight, processed_count):
    _integer(amount, 'charge amount')
    _text(reason, 'charge reason')
    _integer(processed_count, 'processed count')
    if type(overnight) is not bool or not isinstance(components, Mapping) or not components:
        raise LedgerConflict('Invalid charge components.')
    normalized = {}
    for key, component in components.items():
        _text(key, 'component identifier')
        if not isinstance(component, Mapping) or set(component) - {'action', 'units'}:
            raise LedgerConflict('Invalid charge component.')
        action = component.get('action')
        if action not in policy.ACTION_COSTS:
            raise LedgerConflict('Unknown credit action.')
        normalized[key] = {'action': action, 'units': _integer(component.get('units', 1), 'component units')}
    return {
        'amount': amount, 'reason': reason, 'components': normalized,
        'overnight': overnight, 'processed_count': processed_count,
    }


def _admission(value):
    if value is None:
        return {}, 'pending'
    allowed = {'kind', 'job_id', 'batch_id', 'row_id', 'run_id', 'pack_id', 'state'}
    if not isinstance(value, Mapping) or set(value) - allowed:
        raise LedgerConflict('Invalid credit admission.')
    state = value.get('state', 'pending')
    if state not in {'pending', 'admitted'}:
        raise LedgerConflict('Invalid credit admission state.')
    metadata = {key: _text(item, 'admission identifier') for key, item in value.items() if key != 'state'}
    return metadata, state


def _converted_user(user):
    try:
        updates = policy.conversion_updates(user)
    except ValueError as error:
        raise LedgerUnavailable('Credit conversion could not be verified.') from error
    converted = {**user, **updates}
    _integer(converted.get('credits'), 'credit balance', stored=True)
    return converted, updates


def _receipt(journal):
    keys = (
        'credit_scheme', 'charge_ref', 'charged_credits', 'refunded_credits', 'charged', 'refunded',
        'components', 'processed_count', 'processed_refunded', 'admission_state',
    )
    receipt = {key: deepcopy(journal[key]) for key in keys}
    if 'updated_at' in journal:
        receipt['updated_at'] = journal['updated_at']
    return receipt


def _validate_journal(journal, uid, ref):
    if journal.get('uid') != uid or journal.get('charge_ref') != ref or journal.get('credit_scheme') not in {1, 2}:
        raise LedgerConflict('Credit reference belongs to another charge.')
    components = journal.get('components')
    if not isinstance(components, dict) or not components:
        raise LedgerUnavailable('Credit components are unavailable.')
    for component in components.values():
        if not isinstance(component, dict):
            raise LedgerUnavailable('Credit component is unavailable.')
        for field in ('units', 'unit_cost', 'charged_credits', 'refunded_credits'):
            _integer(component.get(field), field, stored=True)
        if component['refunded_credits'] > component['charged_credits']:
            raise LedgerUnavailable('Credit refund exceeds the original charge.')
    for field in ('charged_credits', 'refunded_credits', 'processed_count', 'processed_refunded'):
        _integer(journal.get(field), field, stored=True)
    if (journal['charged_credits'] != sum(item['charged_credits'] for item in components.values())
            or journal['refunded_credits'] != sum(item['refunded_credits'] for item in components.values())
            or journal['processed_refunded'] > journal['processed_count']):
        raise LedgerUnavailable('Credit totals do not match their components.')
    if not isinstance(journal.get('charged'), dict) or not isinstance(journal.get('refunded'), dict):
        raise LedgerUnavailable('Credit amounts are unavailable.')


def _legacy_debit(user, quoted):
    balances = {field: _legacy_balance(user, field) for field in policy.LEGACY_FIELD_RATES}
    original = dict(balances)
    components, charged = {}, {}
    for key, component in quoted.items():
        fields = credits.CATEGORY_CREDIT_FIELDS[component['category']]
        needed = 0 if component['unlimited'] else component['units']
        available = sum(balances[field] for field in fields)
        if available < needed:
            raise InsufficientCredits(
                needed, available, credit_scheme=1,
                category=component['category'], action=component['action'],
            )
        remaining, allocations = needed, {}
        for field in fields:
            take = min(remaining, balances[field])
            if take:
                allocations[field] = take
                balances[field] -= take
                remaining -= take
                charged[field] = charged.get(field, 0) + take
        components[key] = {
            **component, 'unit_cost': 1, 'quoted_credits': component['units'],
            'charged_credits': needed, 'refunded_credits': 0,
            'credit_type': next(iter(allocations), fields[0]), 'charged': allocations, 'refunded': {},
        }
    return components, charged, {field: balance for field, balance in balances.items() if balance != original[field]}


def prepare_charge(context, amount, reason, *, components, overnight=False,
                   processed_count=0, admission=None, runtime=None):
    runtime = runtime if runtime is not None else context.runtime
    request = _request(amount, reason, components, overnight, processed_count)
    metadata, admission_state = _admission(admission)
    existing = context.journal_data
    if existing:
        _validate_journal(existing, context.uid, context.ref)
        if existing.get('request') != request or existing.get('admission', {}) != metadata:
            raise LedgerConflict('Credit reference was already used for a different request.')
        if existing.get('refund_started'):
            raise LedgerConflict('A refunded processing request cannot be admitted again.')
        journal = deepcopy(existing)
        if admission_state == 'admitted' and journal.get('admission_state') != 'admitted':
            journal.update(admission_state='admitted', updated_at=runtime.time.time())
            return PreparedCharge(context, _receipt(journal), {}, journal)
        return PreparedCharge(context, _receipt(existing), {}, {})

    unlimited = credits.effective_unlimited_credits({**context.user_data, 'uid': context.uid}, runtime=runtime)
    quote = policy.quote_components(request['components'], overnight=overnight, unlimited=unlimited)
    if amount != quote['quoted_credits']:
        raise LedgerConflict('Credit amount does not match the requested actions.')
    updates = {}
    if context.scheme == 2:
        user, updates = _converted_user(context.user_data)
        charged_amount = _integer(quote['charged_credits'], 'charge amount')
        if user['credits'] < charged_amount:
            raise InsufficientCredits(charged_amount, user['credits'])
        updates['credits'] = user['credits'] - charged_amount
        component_data = {
            key: {**item, 'refunded_credits': 0}
            for key, item in quote['components'].items()
        }
        charged = {'credits': charged_amount}
    else:
        component_data, charged, updates = _legacy_debit(context.user_data, quote['components'])
        charged_amount = sum(charged.values())
    if processed_count:
        previous = _integer(context.user_data.get('total_processed', 0), 'processed count', stored=True)
        updates['total_processed'] = _integer(previous + processed_count, 'processed count', stored=True)
    if any(item['unlimited'] and item['units'] for item in quote['components'].values()):
        updates['last_unlimited_credit_used_at'] = runtime.time.time()
    journal = {
        'uid': context.uid, 'charge_ref': context.ref, 'reason': reason, 'request': request,
        'credit_scheme': context.scheme, 'charged_credits': charged_amount, 'refunded_credits': 0,
        'charged': charged, 'refunded': {}, 'components': component_data,
        'processed_count': processed_count, 'processed_refunded': 0,
        'admission': metadata, 'admission_state': admission_state,
        'created_at': runtime.time.time(), 'updated_at': runtime.time.time(),
    }
    return PreparedCharge(context, _receipt(journal), updates, journal)


def apply_charge(transaction, prepared):
    if prepared.user_updates:
        transaction.update(prepared.context.user_ref, prepared.user_updates)
    if prepared.journal_data:
        transaction.set(prepared.context.journal_ref, prepared.journal_data)
    return deepcopy(prepared.receipt)


def charge_credits(uid, amount, reason, ref, *, components, overnight=False,
                   processed_count=0, admission=None, runtime=None):
    runtime = _runtime(runtime)

    @runtime.firestore.transactional
    def charge(transaction):
        context = read_charge_context(transaction, uid, ref, runtime=runtime)
        prepared = prepare_charge(context, amount, reason, components=components, overnight=overnight,
                                  processed_count=processed_count, admission=admission, runtime=runtime)
        return apply_charge(transaction, prepared)

    return charge(runtime.db.transaction())


def _refund_user_updates(user, scheme, delta, field_deltas, processed_delta, runtime):
    updates = {}
    if scheme == 2 or policy.uses_unified_credits(user, runtime):
        converted, updates = _converted_user(user)
        if scheme == 1:
            delta = sum(policy.legacy_amount_credits(field, value) for field, value in field_deltas.items())
        updates['credits'] = _integer(converted['credits'] + delta, 'credit balance', stored=True)
    else:
        for field, value in field_deltas.items():
            updates[field] = _integer(_legacy_balance(user, field) + value, 'credit balance', stored=True)
    if processed_delta:
        previous = _integer(user.get('total_processed', 0), 'processed count', stored=True)
        updates['total_processed'] = max(0, previous - processed_delta)
    return updates


def _legacy_component_refund(component, target):
    allocations = component.get('charged')
    previous = component.get('refunded', {})
    if not isinstance(allocations, dict) or not isinstance(previous, dict):
        raise LedgerUnavailable('Original legacy debit is unavailable.')
    remaining, refunded, deltas = target, {}, {}
    for field, amount in allocations.items():
        if field not in policy.LEGACY_FIELD_RATES:
            raise LedgerUnavailable('Original credit type is unavailable.')
        amount = _integer(amount, 'component debit', stored=True)
        take = min(remaining, amount)
        old = _integer(previous.get(field, 0), 'component refund', stored=True)
        if old > take:
            raise LedgerUnavailable('Legacy refund totals do not match.')
        if take:
            refunded[field] = take
        if take > old:
            deltas[field] = take - old
        remaining -= take
    if remaining or sum(allocations.values()) != component['charged_credits']:
        raise LedgerUnavailable('Original legacy debit does not match its amount.')
    return refunded, deltas


def refund_credits(uid, amount, reason, ref, *, charge_ref, component_targets,
                   processed_count=0, runtime=None):
    runtime = _runtime(runtime)
    uid, ref, charge_ref = _text(uid, 'account'), _text(ref, 'refund reference'), _text(charge_ref, 'charge reference')
    _text(reason, 'refund reason')
    _integer(amount, 'refund amount')
    _integer(processed_count, 'processed refund count')
    if not isinstance(component_targets, Mapping) or not component_targets:
        raise LedgerConflict('Invalid refund components.')
    targets = {key: _integer(value, 'component refund target') for key, value in component_targets.items()}
    if amount != sum(targets.values()):
        raise LedgerConflict('Refund amount does not match its component targets.')
    charge_ref_doc = charge_document_ref(runtime.db, uid, charge_ref)
    refund_ref_doc = refund_document_ref(runtime.db, uid, ref)

    @runtime.firestore.transactional
    def refund(transaction):
        user_ref, user = _read_user(transaction, uid, runtime)
        journal = _snapshot_data(charge_ref_doc.get(transaction=transaction), required=True)
        previous_refund = _snapshot_data(refund_ref_doc.get(transaction=transaction))
        _validate_journal(journal, uid, charge_ref)
        if previous_refund and (
            previous_refund.get('uid') != uid or previous_refund.get('charge_ref') != charge_ref
            or previous_refund.get('reason') != reason or previous_refund.get('refund_ref') != ref
        ):
            raise LedgerConflict('Refund reference was already used for another request.')
        if processed_count > journal['processed_count']:
            raise LedgerConflict('Processed refund count exceeds the original admission.')
        if set(targets) - set(journal['components']):
            raise LedgerConflict('Refund component was not charged.')
        components, field_deltas, delta = deepcopy(journal['components']), {}, 0
        for key, target in targets.items():
            component = components[key]
            if target > component['charged_credits']:
                raise LedgerConflict('Refund exceeds the committed component debit.')
            target = max(target, component['refunded_credits'])
            delta += target - component['refunded_credits']
            if journal['credit_scheme'] == 1:
                refunded, changes = _legacy_component_refund(component, target)
                component['refunded'] = refunded
                for field, value in changes.items():
                    field_deltas[field] = field_deltas.get(field, 0) + value
            component['refunded_credits'] = target
        processed_target = max(processed_count, journal['processed_refunded'])
        updates = _refund_user_updates(user, journal['credit_scheme'], delta, field_deltas,
                                       processed_target - journal['processed_refunded'], runtime)
        refunded = deepcopy(journal['refunded'])
        if journal['credit_scheme'] == 2:
            refunded['credits'] = journal['refunded_credits'] + delta
        else:
            for field, value in field_deltas.items():
                refunded[field] = refunded.get(field, 0) + value
        journal.update(
            components=components, refunded_credits=journal['refunded_credits'] + delta,
            refunded=refunded, processed_refunded=processed_target,
            refund_started=True, updated_at=runtime.time.time(),
        )
        prior_targets = previous_refund.get('component_targets', {})
        merged_targets = {**prior_targets}
        for key, target in targets.items():
            merged_targets[key] = max(target, _integer(prior_targets.get(key, 0), 'refund target', stored=True))
        refund_data = {
            'uid': uid, 'refund_ref': ref, 'charge_ref': charge_ref, 'reason': reason,
            'credit_scheme': journal['credit_scheme'], 'component_targets': merged_targets,
            'amount': sum(merged_targets.values()),
            'processed_count': max(processed_count, _integer(previous_refund.get('processed_count', 0), 'processed count', stored=True)),
            'updated_at': runtime.time.time(),
        }
        if updates:
            transaction.update(user_ref, updates)
        transaction.set(charge_ref_doc, journal)
        transaction.set(refund_ref_doc, refund_data)
        return _receipt(journal)

    return refund(runtime.db.transaction())


def refund_legacy_credits(uid, credit_type, target_units, ref, *, charged_units,
                          processed_count=0, runtime=None):
    """Apply only unrefunded old units without reinterpreting historical ledgers."""
    runtime = _runtime(runtime)
    uid, ref = _text(uid, 'account'), _text(ref, 'refund reference')
    _integer(target_units, 'legacy refund target')
    _integer(charged_units, 'legacy charged units')
    _integer(processed_count, 'processed refund count')
    if credit_type not in policy.LEGACY_FIELD_RATES or target_units > charged_units:
        raise LedgerConflict('Legacy refund exceeds its original debit.')
    if processed_count > 1:
        raise LedgerConflict('Legacy processing refunds cover one admission.')
    ledger_ref = refund_document_ref(runtime.db, uid, ref)

    @runtime.firestore.transactional
    def refund(transaction):
        user_ref, user = _read_user(transaction, uid, runtime)
        previous = _snapshot_data(ledger_ref.get(transaction=transaction))
        if previous and (
            previous.get('credit_type') != credit_type or previous.get('charge_ref')
            or previous.get('uid') not in (None, uid)
            or previous.get('uid_hash') not in (None, hashlib.sha256(uid.encode()).hexdigest())
            or previous.get('key_hash') not in (None, hashlib.sha256(ref.encode()).hexdigest())
        ):
            raise LedgerConflict('Legacy refund reference belongs to another debit.')
        if 'charged_units' in previous and _integer(previous['charged_units'], 'legacy charged units', stored=True) != charged_units:
            raise LedgerConflict('The original legacy debit cap cannot change.')
        previous_amount = _integer(previous.get('amount', 0), 'legacy refund amount', stored=True)
        if previous_amount > charged_units:
            raise LedgerConflict('Historical refund exceeds the recorded charge.')
        target = max(target_units, previous_amount)
        delta = target - previous_amount
        # Old primary refunds, including slides-only jobs, already decremented
        # total_processed. Their caller supplies one; extras/coding supply zero.
        implied_processed = 1 if previous_amount and (processed_count or credit_type != 'slides_credits') else 0
        prior_processed = previous.get('processed_count', implied_processed)
        prior_processed = _integer(prior_processed, 'processed refund count', stored=True)
        if prior_processed > 1:
            raise LedgerUnavailable('Legacy processed refund count is unavailable.')
        processed_target = max(prior_processed, processed_count)
        if previous and not delta and processed_target == prior_processed:
            return True
        # Pre-journal legacy jobs cannot prove a debit for unlimited categories;
        # preserve their historical no-op rather than manufacture a refund.
        actual_delta = 0 if credits.is_unlimited_for_credit_type(user, credit_type, runtime=runtime) else delta
        updates = _refund_user_updates(user, 1, actual_delta, {credit_type: actual_delta},
                                       processed_target - prior_processed, runtime)
        data = {
            'uid': uid, 'uid_hash': hashlib.sha256(uid.encode()).hexdigest(),
            'key_hash': hashlib.sha256(ref.encode()).hexdigest(), 'credit_type': credit_type,
            'amount': target, 'charged_units': charged_units, 'processed_count': processed_target,
            'updated_at': runtime.time.time(),
        }
        if updates:
            transaction.update(user_ref, updates)
        transaction.set(ledger_ref, data, merge=True)
        return True

    try:
        return bool(refund(runtime.db.transaction()))
    except (LedgerConflict, LedgerUnavailable, lifecycle.AccountUnavailableError):
        raise
    except Exception:
        runtime.logger.error('Could not commit a legacy credit refund.', exc_info=True)
        return False
