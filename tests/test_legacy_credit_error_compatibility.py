"""Public credit rejection contracts with real admission and atomic storage."""

import pytest

from tests.test_unified_processing_routes import (
    HEADERS, UID, post_action, post_batch, processing as processing,
)


@pytest.fixture
def legacy(processing, monkeypatch):
    monkeypatch.setattr(processing.core, 'UNIFIED_CREDITS_ENABLED', False)
    user = processing.store.documents[('users', UID)]
    user.pop('credits_version')
    user.pop('credits')
    user.update(lecture_credits_standard=5, slides_credits=0, interview_credits_short=5)
    return processing


def assert_no_debit(processing):
    assert processing.store.docs('credit_charges') == {}
    assert processing.store.docs('credit_refunds') == {}
    assert processing.store.docs(processing.core.RUNTIME_JOBS_COLLECTION) == {}
    assert processing.store.docs('users')[UID]['total_processed'] == 0
    assert processing.queued == []


def post_coding(processing):
    processing.store.documents[('study_packs', 'owned-pack')].update(
        mode='interview', source_transcript='Synthetic interview transcript.',
    )
    return processing.client.post('/api/interview-coding/packs/owned-pack/ai-runs', json={}, headers=HEADERS)


def test_legacy_coding_rejection_names_text_extraction_credits_without_debit(legacy):
    response = post_coding(legacy)

    assert response.status_code == 402
    assert response.get_json() == {
        'error': 'Not enough text extraction credits for AI coding. This transcript needs 1 credit(s).',
        'error_code': 'insufficient_credits',
    }
    assert_no_debit(legacy)
    assert legacy.store.docs('users')[UID]['lecture_credits_standard'] == 5
    assert legacy.store.docs('interview_ai_coding_runs') == {}


def test_legacy_interview_extras_rejection_names_needed_category_without_rollback_charge(legacy):
    response = post_action(legacy, 'interview-extras')

    assert response.status_code == 402
    assert response.get_json() == {
        'error': 'Not enough text extraction credits for interview extras. You selected 2 option(s) and need 2 text extraction credits.',
    }
    assert_no_debit(legacy)
    assert legacy.store.docs('users')[UID]['interview_credits_short'] == 5
    assert legacy.store.docs('users')[UID]['slides_credits'] == 0


def exhaust_after_file_validation(processing, monkeypatch, field):
    """Another request spends the balance after this request's preflight read."""
    original = processing.core.get_saved_file_size
    observed = []

    def size(path):
        result = original(path)
        if not observed:
            observed.append(path)
            processing.store.documents[('users', UID)][field] = 0
        return result

    monkeypatch.setattr(processing.core, 'get_saved_file_size', size)
    return observed


@pytest.mark.parametrize('action,field,message', [
    ('lecture', 'lecture_credits_standard', 'No lecture credits remaining.'),
    ('slides', 'slides_credits', 'No text extraction credits remaining.'),
    ('interview', 'interview_credits_short', 'No interview credits remaining.'),
    ('interview-extras', 'slides_credits', 'Could not reserve text extraction credits for interview extras. Please try again.'),
])
def test_legacy_upload_admission_race_preserves_category_message(legacy, monkeypatch, action, field, message):
    legacy.store.documents[('users', UID)][field] = 5
    observed = exhaust_after_file_validation(legacy, monkeypatch, field)

    response = post_action(legacy, action)

    assert observed, 'The request must pass preflight and validate its staged file.'
    assert response.status_code == 402
    assert response.get_json() == {'error': message}
    assert_no_debit(legacy)
    assert legacy.store.docs('users')[UID][field] == 0


@pytest.mark.parametrize('instant', [False, True], ids=['overnight', 'instant'])
@pytest.mark.parametrize('mode,field,extras,message', [
    ('lecture-notes', 'lecture_credits_standard', 0, 'Not enough lecture credits to start this batch.'),
    ('slides-only', 'slides_credits', 0, 'Not enough text extraction credits to start this batch.'),
    ('interview', 'interview_credits_short', 0, 'Not enough interview credits to start this batch.'),
    ('interview', 'slides_credits', 2, 'Not enough text extraction credits for interview extras in this batch row.'),
])
def test_legacy_batch_admission_race_preserves_old_400(legacy, monkeypatch, instant, mode, field, extras, message):
    legacy.store.documents[('users', UID)].update(slides_credits=10)
    observed = exhaust_after_file_validation(legacy, monkeypatch, field)

    response = post_batch(legacy, mode, instant=instant, extras=extras)

    assert observed
    assert response.status_code == 400
    assert response.get_json() == {'error': message}
    assert_no_debit(legacy)
    assert legacy.store.docs('users')[UID][field] == 0


@pytest.mark.parametrize('action,needed,available', [('coding', 2, 1), ('interview-extras', 14, 13)])
def test_stored_unified_user_flag_off_keeps_scalar_error_contract(processing, monkeypatch, action, needed, available):
    monkeypatch.setattr(processing.core, 'UNIFIED_CREDITS_ENABLED', False)
    processing.store.documents[('users', UID)]['credits'] = available

    response = post_coding(processing) if action == 'coding' else post_action(processing, action)

    assert response.status_code == 402
    assert response.get_json() == {
        'error': f'Not enough credits. This needs {needed} credits; {available} are available.',
        'error_code': 'insufficient_credits', 'needed': needed, 'available': available,
    }
    assert_no_debit(processing)
    assert processing.store.docs('users')[UID]['credits'] == available


def test_unified_one_credit_admission_race_uses_singular_credit(processing, monkeypatch):
    processing.store.documents[('users', UID)]['credits'] = 3
    observed = exhaust_after_file_validation(processing, monkeypatch, 'credits')

    response = post_batch(processing, 'slides-only', instant=False)

    assert observed
    assert response.status_code == 402
    assert response.get_json() == {
        'error': 'Not enough credits. This needs 1 credit; 0 are available.',
        'error_code': 'insufficient_credits', 'needed': 1, 'available': 0,
    }
    assert_no_debit(processing)
    assert processing.store.docs('users')[UID]['credits'] == 0
