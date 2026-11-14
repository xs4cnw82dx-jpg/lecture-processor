"""Resumable application of an interview coding draft."""

import hashlib
import json

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.study import interview_coding
from lecture_processor.domains.study.interview_coding_runs import MAX_RUN_PAYLOAD_BYTES

WRITE_CHUNK_SIZE = 400


class AcceptanceError(Exception):
    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status


def _document_id(run_id, kind, index):
    digest = hashlib.sha256(f'{run_id}:{kind}:{index}'.encode()).hexdigest()
    return f'ai-{digest}'


def _reference_key(value):
    return 'ref-' + hashlib.sha256(str(value).encode('utf-8')).hexdigest()


def _read_owned_run(transaction, run_ref, uid, pack_id):
    snapshot = run_ref.get(transaction=transaction)
    if not snapshot.exists:
        raise AcceptanceError('AI coding run not found', 404)
    run = snapshot.to_dict() or {}
    if run.get('uid') != uid or run.get('pack_id') != pack_id:
        raise AcceptanceError('Forbidden', 403)
    return run


def _validate_target(runtime, transaction, uid, pack_id):
    pack = runtime.db.collection('study_packs').document(pack_id).get(transaction=transaction)
    if not pack.exists:
        raise AcceptanceError('Study pack not found', 404)
    pack_data = pack.to_dict() or {}
    if pack_data.get('uid') != uid:
        raise AcceptanceError('Forbidden', 403)
    if pack_data.get('mode') != 'interview':
        raise AcceptanceError('Interview coding is only available for interview packs', 400)
    user = runtime.db.collection('users').document(uid).get(transaction=transaction)
    if not user.exists or str((user.to_dict() or {}).get('account_status', '')).strip().lower() in {'deleting', 'deleted'}:
        raise AcceptanceError('Account is unavailable. New work is blocked.')
    try:
        account_lifecycle.require_account_access(uid, runtime=runtime, transaction=transaction)
    except account_lifecycle.AccountUnavailableError as error:
        raise AcceptanceError('Account is unavailable. New work is blocked.') from error


def _prepare_plan(run_id, run, pack_id, transcript, existing_codes, now):
    existing_ids = {code['code_id'] for code in existing_codes}
    by_name = {str(code.get('name', '')).strip().lower(): code['code_id'] for code in existing_codes}
    mapping, new_indexes = {}, []
    proposals = run.get('proposed_codes', [])
    for index, proposed in enumerate(proposals if isinstance(proposals, list) else []):
        temp_id = str(proposed.get('temp_id', '') or '').strip()
        existing_id = str(proposed.get('existing_code_id', '') or '').strip()
        name = str(proposed.get('name', '') or '').strip().lower()
        if existing_id in existing_ids:
            mapping[temp_id] = existing_id
        elif name in by_name:
            mapping[temp_id] = by_name[name]
        else:
            code_id = _document_id(run_id, 'code', index)
            mapping[temp_id] = code_id
            by_name[name] = code_id
            new_indexes.append(index)
    allowed_ids = existing_ids | set(mapping.values())
    transcript_key = interview_coding.transcript_base_key(pack_id, transcript)
    quotations = []
    proposals = run.get('proposed_quotations', [])
    for index, proposed in enumerate(proposals if isinstance(proposals, list) else []):
        code_ids = [mapping.get(str(ref).strip(), str(ref).strip()) for ref in proposed.get('code_refs', [])]
        payload = interview_coding.sanitize_quotation_payload(
            {**proposed, 'code_ids': code_ids, 'source': 'ai'}, transcript, allowed_ids,
            pack_id=pack_id, transcript_key=transcript_key,
        )
        if payload is not None:
            quotations.append({**payload, 'code_refs': proposed.get('code_refs', []), 'acceptance_index': index})
    # Normalize the existing proposals in place rather than retaining a second
    # copy of every quotation in the run document.
    return {
        'status': 'accepting', 'updated_at': now,
        'proposed_quotations': quotations,
        'acceptance_plan': {
            'version': 2,
            'code_id_by_ref': {_reference_key(key): value for key, value in mapping.items()},
            'new_code_indexes': new_indexes,
            'created_at': now, 'next_write': 0,
            'code_count': len(new_indexes), 'quotation_count': len(quotations),
        },
    }


def _operations(run_id, run, uid):
    plan = run['acceptance_plan']
    mapping, now = plan['code_id_by_ref'], plan['created_at']
    operations = []
    for index in plan['new_code_indexes']:
        proposed = run['proposed_codes'][index]
        code_id = _document_id(run_id, 'code', index)
        parent_key = str(proposed.get('parent_temp_id', '') or '').strip()
        parent_id = mapping.get(_reference_key(parent_key) if plan.get('version') == 2 else parent_key, '')
        operations.append(('interview_codes', code_id, {
            'code_id': code_id, 'uid': uid,
            'name': str(proposed.get('name', '') or 'Untitled code').strip()[:80],
            'description': str(proposed.get('description', '') or '').strip()[:500],
            'color': interview_coding.sanitize_code_color(proposed.get('color', 'teal')),
            'parent_code_id': parent_id if parent_id != code_id else '',
            'created_at': now, 'updated_at': now,
        }))
    for proposed in run['proposed_quotations']:
        quote_id = _document_id(run_id, 'quotation', proposed['acceptance_index'])
        payload = {key: value for key, value in proposed.items() if key not in {'code_refs', 'acceptance_index'}}
        operations.append(('interview_quotations', quote_id, {
            **payload, 'quotation_id': quote_id, 'uid': uid, 'created_at': now, 'updated_at': now,
        }))
    return operations


def accept_run(runtime, run_ref, uid, pack_id, transcript, existing_codes):
    @runtime.firestore.transactional
    def claim(transaction):
        run = _read_owned_run(transaction, run_ref, uid, pack_id)
        _validate_target(runtime, transaction, uid, pack_id)
        if run.get('status') == 'accepted':
            return True
        if run.get('status') == 'draft':
            updates = _prepare_plan(
                run_ref.id, run, pack_id, transcript, existing_codes, runtime.time.time(),
            )
            if len(json.dumps({**run, **updates}, ensure_ascii=False).encode('utf-8')) > MAX_RUN_PAYLOAD_BYTES:
                raise AcceptanceError('This coding draft is too large to apply. Please use a shorter interview.')
            transaction.update(run_ref, updates)
        elif run.get('status') != 'accepting' or run.get('acceptance_plan', {}).get('version') not in {1, 2}:
            raise AcceptanceError('Only draft AI coding runs can be accepted', 400)
        return False

    if claim(runtime.db.transaction()):
        return

    @runtime.firestore.transactional
    def write_chunk(transaction):
        run = _read_owned_run(transaction, run_ref, uid, pack_id)
        _validate_target(runtime, transaction, uid, pack_id)
        if run.get('status') == 'accepted':
            return True
        if run.get('status') != 'accepting':
            raise AcceptanceError('The AI coding run is no longer being accepted')
        plan = run['acceptance_plan']
        operations = _operations(run_ref.id, run, uid)
        cursor = plan.get('next_write')
        if type(cursor) is not int or not 0 <= cursor <= len(operations):
            raise AcceptanceError('This coding draft cannot be resumed. Please contact support.')
        chunk = operations[cursor:cursor + WRITE_CHUNK_SIZE]
        for collection, document_id, payload in chunk:
            transaction.set(runtime.db.collection(collection).document(document_id), payload)
        next_cursor = cursor + len(chunk)
        done = next_cursor == len(operations)
        updates = {
            'acceptance_plan': {**plan, 'next_write': next_cursor},
            'updated_at': runtime.time.time(),
        }
        if done:
            updates.update({
                'status': 'accepted', 'accepted_at': runtime.time.time(),
                'accepted_code_count': plan['code_count'],
                'accepted_quotation_count': plan['quotation_count'],
            })
        # The cursor commits with its documents. Concurrent callers and retries
        # therefore resume from the next chunk without recreating earlier data.
        transaction.update(run_ref, updates)
        return done

    while not write_chunk(runtime.db.transaction()):
        pass


def reject_run(runtime, run_ref, uid, pack_id):
    @runtime.firestore.transactional
    def reject(transaction):
        run = _read_owned_run(transaction, run_ref, uid, pack_id)
        _validate_target(runtime, transaction, uid, pack_id)
        if run.get('status') == 'rejected':
            return
        if run.get('status') != 'draft':
            raise AcceptanceError('Only draft AI coding runs can be rejected')
        transaction.update(run_ref, {'status': 'rejected', 'updated_at': runtime.time.time()})

    reject(runtime.db.transaction())
