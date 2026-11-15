"""Coding service responses preserve account state discovered during admission."""

from copy import deepcopy

import pytest

from lecture_processor.services import interview_coding_service as service
from tests.test_interview_coding_background import coding as coding


def _call_after_target_changes(coding, monkeypatch, entrypoint, change):
    if entrypoint == 'legacy_status':
        coding.documents[('interview_ai_coding_runs', 'legacy')] = {
            'uid': 'owner', 'pack_id': 'pack-1', 'status': 'processing',
            'created_at': 1, 'credit_cost': 1,
        }
    committed, changed = [], []
    coding.before_commit = lambda operations: committed.append(operations)
    transaction = coding.runtime.db.transaction

    def change_before_transaction():
        # Authentication and the route's pack read have already succeeded.
        # The real domain transaction must validate the changed target again.
        if change == 'missing_account':
            coding.documents.pop(('users', 'owner'))
        elif change == 'tombstone':
            coding.documents[('account_deletions', 'owner')] = {'status': 'requested'}
        elif change == 'foreign_pack':
            coding.documents[('study_packs', 'pack-1')]['uid'] = 'other'
        elif change == 'missing_pack':
            coding.documents.pop(('study_packs', 'pack-1'))
        elif change == 'wrong_mode':
            coding.documents[('study_packs', 'pack-1')]['mode'] = 'lecture-notes'
        else:
            coding.documents[('users', 'owner')]['account_status'] = change
        changed.append(deepcopy(coding.documents))
        return transaction()

    monkeypatch.setattr(coding.runtime.db, 'transaction', change_before_transaction)
    if entrypoint == 'start':
        response = coding.start()
    else:
        response = service.get_ai_coding_run(coding.runtime, None, 'pack-1', 'legacy')

    assert len(changed) == 1
    assert coding.documents == changed[0]
    assert committed == coding.queued == []
    assert coding.runtime.jobs == {}
    assert coding.provider_calls == 0
    return response


@pytest.mark.parametrize('entrypoint', ['start', 'legacy_status'])
@pytest.mark.parametrize('change', ['deleting', 'deleted', 'missing_account', 'tombstone'])
def test_coding_services_report_account_unavailable_after_a_transaction_race(coding, monkeypatch, entrypoint, change):
    response, status = _call_after_target_changes(coding, monkeypatch, entrypoint, change)

    assert status == 409
    assert response == {'error': 'Account is unavailable.', 'status': 'account_deletion_in_progress'}


@pytest.mark.parametrize('entrypoint', ['start', 'legacy_status'])
@pytest.mark.parametrize('change, expected_status, message', [
    ('foreign_pack', 403, 'Forbidden'),
    ('missing_pack', 404, 'Study pack not found'),
    ('wrong_mode', 400, 'Interview coding is only available for interview packs'),
])
def test_coding_services_keep_other_transaction_errors(coding, monkeypatch, entrypoint, change, expected_status, message):
    response, status = _call_after_target_changes(coding, monkeypatch, entrypoint, change)

    assert status == expected_status
    assert response == {'error': message, 'error_code': 'interview_coding_unavailable'}
