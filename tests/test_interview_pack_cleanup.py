"""Owned pack removal and concurrent quotation writes, using synthetic storage."""

from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
import hashlib
from threading import Event, RLock
from types import SimpleNamespace

import pytest

from lecture_processor.domains.runtime_jobs.schema import PERSISTED_RUNTIME_JOB_FIELDS
from lecture_processor.domains.runtime_jobs import store as runtime_job_store
from lecture_processor.domains.billing import ledger
from lecture_processor.domains.study import interview_coding_acceptance, interview_coding_runs
from lecture_processor.repositories import runtime_jobs_repo, study_repo
from lecture_processor.services import interview_coding_service as coding
from lecture_processor.services import job_state_service
from lecture_processor.services import study_library_service as library
from tests.credit_test_support import make_credit_runtime


@pytest.fixture
def pack_cleanup(monkeypatch):
    runtime, store = make_credit_runtime(users={'owner': {
        'uid': 'owner', 'account_status': 'active', 'credits_version': 2, 'credits': 20,
    }})
    runtime.jsonify = lambda value: value
    runtime.repositories = SimpleNamespace(study=study_repo, runtime_jobs=runtime_jobs_repo)
    runtime.runtime_jobs_repo = runtime_jobs_repo
    runtime.get_study_progress_doc = lambda uid: runtime.db.collection('study_progress').document(uid)
    runtime.get_study_card_state_doc = lambda uid, pack_id: runtime.db.collection('study_card_states').document(f'{uid}__{pack_id}')
    runtime.jobs, runtime.JOBS_LOCK = {}, RLock()
    runtime.RUNTIME_JOBS_COLLECTION = 'runtime_jobs'
    runtime.RUNTIME_JOB_PERSISTED_FIELDS = PERSISTED_RUNTIME_JOB_FIELDS
    runtime.JOB_TTL_SECONDS = 1800
    runtime.MAX_ACTIVE_JOBS_PER_USER = 2
    runtime.job_state_service = job_state_service
    runtime.client = object()
    runtime.batch_repo = SimpleNamespace(list_batch_jobs_by_uid_and_statuses=lambda *_args, **_kwargs: [])
    store.documents.update({
        ('study_packs', 'pack'): {'uid': 'owner', 'mode': 'interview', 'transcript': 'Hello world'},
        ('study_packs', 'other'): {'uid': 'owner', 'mode': 'interview'},
        ('study_packs', 'foreign'): {'uid': 'someone-else', 'mode': 'interview'},
        ('study_progress', 'owner'): {'uid': 'owner', 'card_state_due_by_date_version': 1, 'card_state_due_by_date': {}},
        ('interview_codes', 'shared-code'): {'uid': 'owner', 'name': 'Shared code'},
        ('interview_quotations', 'owned'): {'uid': 'owner', 'pack_id': 'pack', 'text': 'Hello', 'code_ids': ['shared-code']},
        ('interview_quotations', 'other'): {'uid': 'owner', 'pack_id': 'other', 'text': 'Other pack'},
        ('interview_quotations', 'foreign'): {'uid': 'someone-else', 'pack_id': 'pack', 'text': 'Foreign owner'},
        ('interview_ai_coding_runs', 'owned'): {'uid': 'owner', 'pack_id': 'pack', 'status': 'draft', 'proposed_codes': [{'name': 'Saved draft'}]},
        ('interview_ai_coding_runs', 'other'): {'uid': 'owner', 'pack_id': 'other', 'status': 'draft'},
        ('interview_ai_coding_runs', 'foreign'): {'uid': 'someone-else', 'pack_id': 'pack', 'status': 'draft'},
    })
    monkeypatch.setattr(library.study_api_support, 'require_user', lambda *_args: ({'uid': 'owner'}, None, None))
    monkeypatch.setattr(library.study_picture_service, 'delete_for_pack', lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(library.study_audio, 'remove_pack_audio_file', lambda *_args, **_kwargs: False)
    return SimpleNamespace(runtime=runtime, store=store)


def status(result):
    return result[1] if isinstance(result, tuple) else 200


def remove(state, pack_id='pack'):
    return library.delete_study_pack(state.runtime, None, pack_id)


@pytest.mark.parametrize('run_status', ['draft', 'accepting', 'accepted', 'rejected', 'failed'])
def test_pack_delete_purges_its_children_and_keeps_shared_codes_without_refund(pack_cleanup, run_status):
    state = pack_cleanup
    state.store.documents[('interview_ai_coding_runs', 'owned')]['status'] = run_status
    assert status(remove(state)) == 200
    assert ('study_packs', 'pack') not in state.store.documents
    assert set(state.store.docs('interview_quotations')) == {'other', 'foreign'}
    assert set(state.store.docs('interview_ai_coding_runs')) == {'other', 'foreign'}
    assert set(state.store.docs('interview_codes')) == {'shared-code'}
    assert state.store.docs('users')['owner']['credits'] == 20
    assert state.store.docs('credit_refunds') == {}


def test_pack_delete_drains_more_than_one_page_of_owned_children(pack_cleanup):
    state = pack_cleanup
    for index in range(235):
        for collection in ('interview_quotations', 'interview_ai_coding_runs'):
            state.store.documents[(collection, f'child-{index}')] = {
                'uid': 'owner', 'pack_id': 'pack', 'status': 'draft', 'text': 'Synthetic private text'}
    assert status(remove(state)) == 200
    assert set(state.store.docs('interview_quotations')) == {'other', 'foreign'}
    assert set(state.store.docs('interview_ai_coding_runs')) == {'other', 'foreign'}


def test_pack_delete_denies_foreign_owner_without_any_writes(pack_cleanup):
    before = deepcopy(pack_cleanup.store.documents)
    assert status(remove(pack_cleanup, 'foreign')) == 403
    assert pack_cleanup.store.documents == before


def test_failed_pack_commit_preserves_children_for_retry(pack_cleanup):
    state = pack_cleanup
    state.store.fail_writes.add(('study_packs', 'pack'))
    before = deepcopy(state.store.documents)
    assert status(remove(state)) == 500
    assert state.store.documents == before


def test_failed_child_purge_can_retry_after_pack_is_already_removed(pack_cleanup):
    state = pack_cleanup
    state.store.fail_writes.add(('interview_quotations', 'owned'))
    assert status(remove(state)) == 503
    assert ('study_packs', 'pack') not in state.store.documents
    assert ('interview_quotations', 'owned') in state.store.documents
    state.store.fail_writes.clear()
    assert status(remove(state)) == 200
    assert set(state.store.docs('interview_quotations')) == {'other', 'foreign'}
    assert set(state.store.docs('interview_ai_coding_runs')) == {'other', 'foreign'}


@pytest.mark.parametrize('picture_fails', [False, True])
def test_interview_cleanup_failure_still_attempts_pictures_and_retries_pending_children(pack_cleanup, monkeypatch, picture_fails):
    state = pack_cleanup
    state.store.fail_writes.add(('interview_quotations', 'owned'))
    pictures = {'pending': True, 'fail': picture_fails}
    attempts = []

    def remove_pictures(runtime, uid, pack_id):
        assert runtime is state.runtime
        assert ('study_packs', pack_id) not in state.store.documents
        attempts.append((uid, pack_id))
        if pictures['fail']:
            raise RuntimeError('Synthetic picture cleanup failure')
        removed = int(pictures['pending'])
        pictures['pending'] = False
        return removed

    monkeypatch.setattr(library.study_picture_service, 'delete_for_pack', remove_pictures)
    first = remove(state)
    assert status(first) == 503
    assert first[0] == {
        'error': 'The study pack was deleted, but interview cleanup is still pending. Please try deleting it again.',
        'error_code': 'study_pack_cleanup_pending', 'deleted': True,
    }
    assert attempts == [('owner', 'pack')]
    assert pictures['pending'] is picture_fails
    assert ('interview_quotations', 'owned') in state.store.documents

    state.store.fail_writes.clear()
    second = remove(state)
    assert status(second) == (503 if picture_fails else 200)
    assert attempts == [('owner', 'pack')] * 2
    assert owned_children(state, 'interview_quotations') == {}
    assert owned_children(state, 'interview_ai_coding_runs') == {}
    if picture_fails:
        assert second[0] == {
            'error': 'The study pack was deleted, but picture cleanup is still pending. Please try deleting it again.',
            'error_code': 'study_pack_cleanup_pending', 'deleted': True,
        }
        pictures['fail'] = False
        assert status(remove(state)) == 200
    assert pictures['pending'] is False
    assert status(remove(state)) == 404


@pytest.mark.parametrize('operation', ['create', 'update'])
def test_quotation_write_rechecks_pack_after_validation(pack_cleanup, monkeypatch, operation):
    state = pack_cleanup
    original = coding._load_codes

    def codes_after_removal(*args, **kwargs):
        result = original(*args, **kwargs)
        state.store.documents.pop(('study_packs', 'pack'))
        return result

    monkeypatch.setattr(coding, '_load_codes', codes_after_removal)
    request = SimpleNamespace(get_json=lambda **_kwargs: {
        'start_offset': 0, 'end_offset': 5, 'text': 'Hello', 'code_ids': ['shared-code'], 'comment': 'Edited'})
    before = state.store.docs('interview_quotations')
    result = coding.create_quotation(state.runtime, request, 'pack') if operation == 'create' else coding.update_quotation(
        state.runtime, request, 'pack', 'owned')
    assert status(result) == 404
    assert state.store.docs('interview_quotations') == before


@pytest.mark.parametrize('active_status', ['queued', 'processing', 'refund_pending'])
def test_pack_delete_settles_active_run_before_purging_it(pack_cleanup, active_status):
    state = pack_cleanup
    state.store.documents.pop(('interview_ai_coding_runs', 'owned'))
    run_id, created = interview_coding_runs.claim_run(state.runtime, 'owner', 'pack', 1)
    assert created
    assert state.store.docs('users')['owner']['credits'] == 18
    state.store.documents[('interview_ai_coding_runs', run_id)]['status'] = active_status
    assert status(remove(state)) == 200
    assert run_id not in state.store.docs('interview_ai_coding_runs')
    assert state.store.docs('users')['owner']['credits'] == 20
    assert len(state.store.docs('credit_refunds')) == 1
    assert state.store.docs('runtime_jobs')[run_id]['status'] == 'error'
    assert state.store.docs('runtime_jobs')[run_id]['credit_refunded'] is True


def admit_run(state):
    state.store.documents.pop(('interview_ai_coding_runs', 'owned'))
    run_id, created = interview_coding_runs.claim_run(state.runtime, 'owner', 'pack', 1)
    assert created
    assert state.store.docs('users')['owner']['credits'] == 18
    return run_id


def owned_children(state, collection):
    return {key: value for key, value in state.store.docs(collection).items()
            if value.get('uid') == 'owner' and value.get('pack_id') == 'pack'}


@pytest.mark.parametrize('failure', ['write_failure', 'lost_ack'])
def test_failed_refund_retains_run_and_mirror_until_delete_retry(pack_cleanup, failure):
    state = pack_cleanup
    run_id = admit_run(state)
    if failure == 'write_failure':
        state.store.fail_writes.add(('users', 'owner'))
    else:
        def lose_refund_ack(operations):
            if any(ref.path[0] == 'credit_refunds' for _operation, ref, _payload, _merge in operations):
                state.store.after_commit = None
                raise RuntimeError('Synthetic lost refund acknowledgement')
        state.store.after_commit = lose_refund_ack

    assert status(remove(state)) == 503
    assert ('study_packs', 'pack') not in state.store.documents
    assert state.store.docs('interview_ai_coding_runs')[run_id]['status'] == 'refund_pending'
    assert state.store.docs('runtime_jobs')[run_id]['status'] == 'processing'
    assert state.store.docs('users')['owner']['credits'] == (18 if failure == 'write_failure' else 20)
    assert len(state.store.docs('credit_refunds')) == (0 if failure == 'write_failure' else 1)

    state.store.fail_writes.clear()
    state.store.after_commit = None
    assert status(remove(state)) == 200
    assert run_id not in state.store.docs('interview_ai_coding_runs')
    assert state.store.docs('runtime_jobs')[run_id]['status'] == 'error'
    assert state.store.docs('users')['owner']['credits'] == 20
    assert len(state.store.docs('credit_refunds')) == 1
    settled = deepcopy(state.store.docs('credit_refunds'))
    assert status(remove(state)) == 404
    assert interview_coding_runs.fail_run(state.runtime, run_id) is False
    assert state.store.docs('credit_refunds') == settled
    assert state.store.docs('users')['owner']['credits'] == 20


@pytest.mark.parametrize('converted', [False, True], ids=['legacy-account', 'converted-account'])
def test_old_partial_refund_keeps_legacy_units_and_never_refunds_twice(pack_cleanup, converted):
    state = pack_cleanup
    state.runtime.UNIFIED_CREDITS_ENABLED = False
    state.store.documents[('users', 'owner')] = {
        'uid': 'owner', 'account_status': 'active', 'total_processed': 7,
        **({'credits_version': 2, 'credits': 10} if converted else {'slides_credits': 5}),
    }
    state.store.documents.pop(('interview_ai_coding_runs', 'owned'))
    run_id = 'legacy-running'
    state.store.documents[('interview_ai_coding_runs', run_id)] = {
        'run_id': run_id, 'uid': 'owner', 'pack_id': 'pack', 'status': 'refund_pending',
        'credit_cost': 3, 'credit_charged': 3,
    }
    runtime_job_store.set_job(run_id, {
        'job_scope': 'interview-coding', 'user_id': 'owner', 'study_pack_id': 'pack',
        'status': 'processing', 'study_tools_credit_cost': 3,
    }, runtime=state.runtime)
    stable_ref = f'interview-coding-run:{run_id}:credits'
    refund_ref = ledger.refund_document_ref(state.runtime.db, 'owner', stable_ref)
    state.store.documents[refund_ref.path] = {
        'uid_hash': hashlib.sha256(b'owner').hexdigest(),
        'key_hash': hashlib.sha256(stable_ref.encode()).hexdigest(),
        'credit_type': 'slides_credits', 'amount': 1,
    }

    assert status(remove(state)) == 200
    user = state.store.docs('users')['owner']
    assert user['credits' if converted else 'slides_credits'] == (14 if converted else 7)
    assert user['total_processed'] == 7
    assert run_id not in state.store.docs('interview_ai_coding_runs')
    assert state.store.docs('runtime_jobs')[run_id]['status'] == 'error'
    assert state.store.docs('credit_charges') == {}
    assert set(state.store.docs('credit_refunds')) == {refund_ref.id}
    assert state.store.docs('credit_refunds')[refund_ref.id]['amount'] == 3
    settled = deepcopy(state.store.documents)
    assert status(remove(state)) == 404
    assert interview_coding_runs.fail_run(state.runtime, run_id) is False
    assert state.store.docs('users')['owner'] == settled[('users', 'owner')]
    assert state.store.docs('credit_refunds')[refund_ref.id] == settled[refund_ref.path]


def test_lost_child_cleanup_ack_can_retry_without_a_second_refund(pack_cleanup):
    state = pack_cleanup
    run_id = admit_run(state)
    lost_ack = []

    def lose_cleanup_ack(operations):
        if any(operation == 'delete' and ref.path == ('interview_quotations', 'owned')
               for operation, ref, _payload, _merge in operations):
            state.store.after_commit = None
            lost_ack.append(True)
            raise RuntimeError('Synthetic lost child deletion acknowledgement')

    state.store.after_commit = lose_cleanup_ack
    # Reconciliation may prove the first cleanup committed; otherwise it must
    # give the caller an explicit retryable result.
    assert status(remove(state)) in {200, 503}
    assert lost_ack == [True]
    assert ('study_packs', 'pack') not in state.store.documents
    assert status(remove(state)) in {200, 404}
    assert owned_children(state, 'interview_quotations') == {}
    assert owned_children(state, 'interview_ai_coding_runs') == {}
    assert state.store.docs('users')['owner']['credits'] == 20
    assert len(state.store.docs('credit_refunds')) == 1
    assert state.store.docs('runtime_jobs')[run_id]['status'] == 'error'


def test_late_coding_provider_result_cannot_recreate_deleted_children(pack_cleanup, monkeypatch):
    state = pack_cleanup
    run_id = admit_run(state)
    state.runtime.PROMPT_INTERVIEW_CODING = 'Synthetic coding prompt'
    entered, release = Event(), Event()

    def held_provider(*_args, **_kwargs):
        entered.set()
        assert release.wait(3), 'Synthetic provider was not released'
        return SimpleNamespace(text='{"codes":[{"temp_id":"c1","name":"Late code"}],"quotations":[]}')

    monkeypatch.setattr(coding.ai_provider, 'generate_with_policy', held_provider)
    monkeypatch.setattr(coding.ai_provider, 'extract_token_usage', lambda *_args, **_kwargs: {})
    with ThreadPoolExecutor(max_workers=1) as executor:
        worker = executor.submit(coding._run_ai_coding_job, run_id, 'Hello world', state.runtime)
        try:
            assert entered.wait(2), 'The real coding worker did not reach the provider'
            result = remove(state)
        finally:
            release.set()
        worker.result(timeout=2)
    assert status(result) == 200
    assert owned_children(state, 'interview_ai_coding_runs') == {}
    assert owned_children(state, 'interview_quotations') == {}
    assert set(state.store.docs('interview_codes')) == {'shared-code'}
    assert state.store.docs('users')['owner']['credits'] == 20
    assert len(state.store.docs('credit_refunds')) == 1
    assert state.store.docs('runtime_jobs')[run_id]['status'] == 'error'


def test_delete_between_acceptance_chunks_removes_quotes_but_keeps_committed_codes(pack_cleanup, monkeypatch):
    state = pack_cleanup
    run_id = admit_run(state)
    assert interview_coding_runs.start_processing(state.runtime, run_id)
    proposals = {
        'proposed_codes': [{'temp_id': 'new-code', 'name': 'A shared generated code'}],
        'proposed_quotations': [
            {'start_offset': start, 'end_offset': end, 'text': text, 'code_refs': ['new-code']}
            for start, end, text in [(0, 5, 'Hello'), (6, 11, 'world'), (0, 11, 'Hello world')]
        ],
    }
    assert interview_coding_runs.complete_run(state.runtime, run_id, proposals, transcript='Hello world', existing_codes=[])
    monkeypatch.setattr(interview_coding_acceptance, 'WRITE_CHUNK_SIZE', 2)
    interrupted = {}

    def delete_after_first_chunk(operations):
        if any(operation == 'set' and ref.path[0] == 'interview_quotations'
               for operation, ref, _payload, _merge in operations):
            state.store.after_commit = None
            interrupted['codes'] = state.store.docs('interview_codes')
            interrupted['result'] = remove(state)

    state.store.after_commit = delete_after_first_chunk
    result = coding.accept_ai_coding_run(state.runtime, None, 'pack', run_id)
    assert status(result) == 404
    assert status(interrupted['result']) == 200
    assert len(interrupted['codes']) == 2
    assert state.store.docs('interview_codes') == interrupted['codes']
    assert owned_children(state, 'interview_quotations') == {}
    assert owned_children(state, 'interview_ai_coding_runs') == {}
    assert state.store.docs('users')['owner']['credits'] == 18
    assert state.store.docs('credit_refunds') == {}
    assert state.store.docs('runtime_jobs')[run_id]['status'] == 'complete'


@pytest.mark.parametrize('operation,changed_target', [
    ('create', 'account'), ('update', 'account'), ('create', 'missing_account'), ('update', 'account_status'),
    ('update', 'quotation_owner'), ('update', 'quotation_pack'),
])
def test_manual_quotation_commit_rechecks_current_authority(pack_cleanup, monkeypatch, operation, changed_target):
    state = pack_cleanup
    original = coding._load_codes
    changed = {}

    def change_authority(*args, **kwargs):
        codes = original(*args, **kwargs)
        if changed_target == 'account':
            state.store.documents[('account_deletions', 'owner')] = {'status': 'requested'}
        elif changed_target == 'missing_account':
            state.store.documents.pop(('users', 'owner'))
        elif changed_target == 'account_status':
            state.store.documents[('users', 'owner')]['account_status'] = 'deleting'
        else:
            field, value = ('uid', 'someone-else') if changed_target == 'quotation_owner' else ('pack_id', 'other')
            state.store.documents[('interview_quotations', 'owned')][field] = value
        changed['quotes'] = state.store.docs('interview_quotations')
        return codes

    monkeypatch.setattr(coding, '_load_codes', change_authority)
    request = SimpleNamespace(get_json=lambda **_kwargs: {
        'start_offset': 0, 'end_offset': 5, 'text': 'Hello', 'code_ids': ['shared-code'], 'comment': 'Edited'})
    result = coding.create_quotation(state.runtime, request, 'pack') if operation == 'create' else coding.update_quotation(
        state.runtime, request, 'pack', 'owned')
    if changed_target in {'account', 'missing_account', 'account_status'}:
        assert result == ({'error': 'Account is unavailable.', 'status': 'account_deletion_in_progress'}, 409)
    else:
        assert status(result) == 403
    assert state.store.docs('interview_quotations') == changed['quotes']


def test_account_removal_during_pack_cleanup_never_recreates_a_credit_user(pack_cleanup):
    state = pack_cleanup
    run_id = admit_run(state)

    def remove_account_after_pack_commit(operations):
        if any(operation == 'delete' and ref.path == ('study_packs', 'pack')
               for operation, ref, _payload, _merge in operations):
            state.store.after_commit = None
            state.store.documents.pop(('users', 'owner'))
            state.store.documents[('account_deletions', 'owner')] = {'status': 'requested'}

    state.store.after_commit = remove_account_after_pack_commit
    assert status(remove(state)) in {409, 503}
    assert 'owner' not in state.store.docs('users')
    assert state.store.docs('credit_refunds') == {}
    assert state.store.docs('interview_ai_coding_runs')[run_id]['status'] in {'queued', 'processing', 'refund_pending'}
    assert state.store.docs('runtime_jobs')[run_id]['status'] in {'queued', 'processing'}


@pytest.mark.parametrize('field,value', [('uid', 'someone-else'), ('pack_id', 'other')])
def test_quotation_cleanup_rechecks_identity_after_list_snapshot(pack_cleanup, monkeypatch, field, value):
    state = pack_cleanup
    state.store.documents[('interview_quotations', 'eligible-sibling')] = {
        'uid': 'owner', 'pack_id': 'pack', 'text': 'Remove this owned sibling',
    }
    original = study_repo.list_interview_quotations_by_uid_and_pack
    changed = []
    financial = {name: state.store.docs(name) for name in ('users', 'credit_charges', 'credit_refunds')}
    preserved = {key: state.store.docs('interview_quotations')[key] for key in ('other', 'foreign')}

    def move_after_list(*args, **kwargs):
        snapshots = original(*args, **kwargs)
        if not changed and any(doc.id == 'owned' for doc in snapshots):
            state.store.documents[('interview_quotations', 'owned')][field] = value
            changed.append(deepcopy(state.store.documents[('interview_quotations', 'owned')]))
        return snapshots

    monkeypatch.setattr(study_repo, 'list_interview_quotations_by_uid_and_pack', move_after_list)
    assert status(remove(state)) == 200
    quotes = state.store.docs('interview_quotations')
    assert 'eligible-sibling' not in quotes
    assert len(changed) == 1
    assert quotes['owned'] == changed[0]
    assert {key: quotes[key] for key in preserved} == preserved
    assert {name: state.store.docs(name) for name in financial} == financial
    assert set(state.store.docs('interview_codes')) == {'shared-code'}


@pytest.mark.parametrize('active_status', ['queued', 'processing', 'refund_pending'])
@pytest.mark.parametrize('field,value', [('uid', 'someone-else'), ('pack_id', 'other')])
def test_active_run_cleanup_rechecks_identity_before_failure_claim(pack_cleanup, monkeypatch, active_status, field, value):
    state = pack_cleanup
    run_id = admit_run(state)
    state.store.documents[('users', 'someone-else')] = {
        'uid': 'someone-else', 'account_status': 'active', 'credits_version': 2, 'credits': 31,
    }
    state.store.documents[('interview_ai_coding_runs', run_id)]['status'] = active_status
    state.store.documents[('interview_ai_coding_runs', 'eligible-sibling')] = {
        'uid': 'owner', 'pack_id': 'pack', 'status': 'draft', 'proposed_codes': [{'name': 'Remove this sibling'}],
    }
    original = study_repo.list_interview_ai_coding_runs_by_uid_and_pack
    changed = []
    financial = {name: state.store.docs(name) for name in ('users', 'credit_charges', 'credit_refunds')}
    mirror = deepcopy(state.store.docs('runtime_jobs')[run_id])
    preserved = {key: state.store.docs('interview_ai_coding_runs')[key] for key in ('other', 'foreign')}

    def move_after_list(*args, **kwargs):
        snapshots = original(*args, **kwargs)
        if not changed and any(doc.id == run_id for doc in snapshots):
            state.store.documents[('interview_ai_coding_runs', run_id)][field] = value
            changed.append(deepcopy(state.store.documents[('interview_ai_coding_runs', run_id)]))
        return snapshots

    monkeypatch.setattr(study_repo, 'list_interview_ai_coding_runs_by_uid_and_pack', move_after_list)
    assert status(remove(state)) == 200
    runs = state.store.docs('interview_ai_coding_runs')
    assert 'eligible-sibling' not in runs
    assert len(changed) == 1
    assert runs[run_id] == changed[0]
    assert {key: runs[key] for key in preserved} == preserved
    assert state.store.docs('runtime_jobs')[run_id] == mirror
    assert {name: state.store.docs(name) for name in financial} == financial
    assert set(state.store.docs('interview_codes')) == {'shared-code'}


def test_active_run_cleanup_requires_pack_fence_before_refund_claim(pack_cleanup, monkeypatch):
    state = pack_cleanup
    run_id = admit_run(state)
    original = study_repo.list_interview_ai_coding_runs_by_uid_and_pack
    financial = {name: state.store.docs(name) for name in ('users', 'credit_charges', 'credit_refunds')}
    run = state.store.docs('interview_ai_coding_runs')[run_id]
    mirror = state.store.docs('runtime_jobs')[run_id]

    def restore_pack_after_list(*args, **kwargs):
        snapshots = original(*args, **kwargs)
        state.store.documents[('study_packs', 'pack')] = {
            'uid': 'owner', 'mode': 'interview', 'transcript': 'A replacement pack',
        }
        return snapshots

    monkeypatch.setattr(study_repo, 'list_interview_ai_coding_runs_by_uid_and_pack', restore_pack_after_list)
    assert status(remove(state)) == 503
    assert state.store.docs('interview_ai_coding_runs')[run_id] == run
    assert state.store.docs('runtime_jobs')[run_id] == mirror
    assert {name: state.store.docs(name) for name in financial} == financial


@pytest.mark.parametrize('boundary', ['refund', 'settlement'])
@pytest.mark.parametrize('field,value', [('uid', 'someone-else'), ('pack_id', 'other')])
def test_active_run_cleanup_rechecks_identity_after_refund_and_settlement(pack_cleanup, boundary, field, value):
    state = pack_cleanup
    run_id = admit_run(state)
    changed = {}

    def move_after_commit(operations):
        matched = any(
            (boundary == 'refund' and ref.path[0] == 'credit_refunds')
            or (boundary == 'settlement' and ref.path == ('interview_ai_coding_runs', run_id)
                and (payload or {}).get('status') == 'failed')
            for _operation, ref, payload, _merge in operations
        )
        if matched:
            state.store.after_commit = None
            state.store.documents[('interview_ai_coding_runs', run_id)][field] = value
            changed['run'] = deepcopy(state.store.documents[('interview_ai_coding_runs', run_id)])
            changed['mirror'] = state.store.docs('runtime_jobs')[run_id]

    state.store.after_commit = move_after_commit
    assert status(remove(state)) == 200
    assert state.store.docs('interview_ai_coding_runs')[run_id] == changed['run']
    assert state.store.docs('runtime_jobs')[run_id] == changed['mirror']
    # The refund was already committed for the original owned admission before
    # the identity changed; neither later settlement nor deletion can touch it.
    assert state.store.docs('users')['owner']['credits'] == 20
    assert len(state.store.docs('credit_refunds')) == 1
    assert owned_children(state, 'interview_quotations') == {}


def test_cleanup_page_budget_leaves_explicit_retry_until_all_children_are_removed(pack_cleanup, monkeypatch):
    state = pack_cleanup
    monkeypatch.setattr(interview_coding_runs, 'PACK_CLEANUP_PAGE_SIZE', 2)
    monkeypatch.setattr(interview_coding_runs, 'PACK_CLEANUP_MAX_PAGES', 2)
    for index in range(5):
        state.store.documents[('interview_ai_coding_runs', f'additional-{index}')] = {
            'uid': 'owner', 'pack_id': 'pack', 'status': 'draft',
        }
    result = remove(state)
    assert status(result) == 503
    assert result[0]['deleted'] is True
    assert result[0]['error_code'] == 'study_pack_cleanup_pending'
    assert len(owned_children(state, 'interview_ai_coding_runs')) == 2
    assert status(remove(state)) == 200
    assert owned_children(state, 'interview_ai_coding_runs') == {}
    assert owned_children(state, 'interview_quotations') == {}
    assert state.store.docs('users')['owner']['credits'] == 20
    assert state.store.docs('credit_refunds') == {}


@pytest.mark.parametrize('refund_fails', [False, True])
def test_concurrent_pack_delete_still_drains_children_or_reports_pending_cleanup(pack_cleanup, monkeypatch, refund_fails):
    state = pack_cleanup
    run_id = admit_run(state)
    original = study_repo.list_study_shares_by_owner_and_entity
    deleted = []

    def finish_other_pack_commit(*args, **kwargs):
        shares = original(*args, **kwargs)
        library.study_progress_service.delete_pack_and_progress(state.runtime, 'owner', 'pack', [
            study_repo.study_pack_doc_ref(state.runtime.db, 'pack'),
            study_repo.study_pack_source_doc_ref(state.runtime.db, 'pack'),
            state.runtime.get_study_card_state_doc('owner', 'pack'),
        ])
        deleted.append(True)
        if refund_fails:
            state.store.fail_writes.add(('users', 'owner'))
        return shares

    monkeypatch.setattr(study_repo, 'list_study_shares_by_owner_and_entity', finish_other_pack_commit)
    result = remove(state)
    assert deleted == [True]
    assert status(result) == (503 if refund_fails else 200)
    if refund_fails:
        assert result[0]['error_code'] == 'study_pack_cleanup_pending'
        assert result[0]['deleted'] is True
        assert state.store.docs('interview_ai_coding_runs')[run_id]['status'] == 'refund_pending'
        assert state.store.docs('users')['owner']['credits'] == 18
        state.store.fail_writes.clear()
        assert status(remove(state)) == 200
    assert owned_children(state, 'interview_ai_coding_runs') == {}
    assert owned_children(state, 'interview_quotations') == {}
    assert state.store.docs('users')['owner']['credits'] == 20
    assert len(state.store.docs('credit_refunds')) == 1
