"""Processing routes exercise real credit admission against synthetic storage."""

from copy import deepcopy

import pytest

from tests.support.unified_processing_routes import UID, post_action, post_batch

CASES = [
    ('lecture', 8, {'primary': ('lecture_notes', 1, 8)}),
    ('slides', 2, {'primary': ('slides_extraction', 1, 2)}),
    ('interview', 10, {'primary': ('interview_transcription', 1, 10)}),
    ('interview-extras', 14, {'primary': ('interview_transcription', 1, 10), 'extras': ('interview_extra', 2, 4)}),
    ('extract', 2, {'primary': ('tools_extraction', 1, 2)}),
    ('transcribe', 10, {'primary': ('tools_transcription', 1, 10)}),
    ('voice', 10, {'primary': ('voice_note', 1, 10)}),
    ('regenerate', 2, {'extras': ('regenerate_study_tools', 1, 2)}),
]
BATCH_CASES = [
    ('lecture-notes', 'lecture_notes', 8, 0),
    ('slides-only', 'slides_extraction', 2, 0),
    ('interview', 'interview_transcription', 10, 2),
    ('audio-transcription', 'audio_transcription', 10, 0),
    ('text-combine', 'text_combine', 8, 0),
]


@pytest.mark.parametrize('enabled', [True, False], ids=['activated', 'stored-v2-flag-off'])
@pytest.mark.parametrize('action,cost,components', CASES, ids=[case[0] for case in CASES])
def test_processing_post_debits_exact_unified_cost_and_persists_receipt(processing, monkeypatch, enabled, action, cost, components):
    monkeypatch.setattr(processing.core, 'UNIFIED_CREDITS_ENABLED', enabled)

    response = post_action(processing, action)

    assert response.status_code in {200, 202}, response.get_json()
    job_id = response.get_json()['job_id']
    job = processing.store.docs(processing.core.RUNTIME_JOBS_COLLECTION)[job_id]
    assert processing.store.docs('users')[UID]['credits'] == 100 - cost
    assert processing.store.docs('users')[UID]['total_processed'] == (0 if action == 'regenerate' else 1)
    assert job['credit_scheme'] == 2 and job['charged_credits'] == cost
    receipt = job['billing_receipt']
    assert receipt['charge_ref'] == job['charge_ref']
    assert receipt['charged_credits'] == cost and receipt['refunded_credits'] == 0
    nonzero_components = {key: item for key, item in receipt['components'].items() if item['units']}
    assert {key: (item['action'], item['units'], item['charged_credits']) for key, item in nonzero_components.items()} == components
    journal = list(processing.store.docs('credit_charges').values())
    assert len(journal) == 1 and journal[0]['charged_credits'] == cost
    assert len(processing.queued) == 1


@pytest.mark.parametrize('action,cost,_components', CASES, ids=[case[0] for case in CASES])
def test_processing_post_reports_scalar_insufficiency_without_admission(processing, action, cost, _components):
    processing.store.documents[('users', UID)]['credits'] = cost - 1
    original = deepcopy(processing.store.documents[('users', UID)])

    response = post_action(processing, action)

    assert response.status_code == 402, response.get_json()
    body = response.get_json()
    assert body['error_code'] == 'insufficient_credits'
    assert body['needed'] == cost and body['available'] == cost - 1
    assert processing.store.docs('users')[UID]['credits'] == original['credits']
    assert processing.store.docs('credit_charges') == {}
    assert processing.store.docs(processing.core.RUNTIME_JOBS_COLLECTION) == {}
    assert processing.queued == []


@pytest.mark.parametrize('enabled', [True, False], ids=['activated', 'stored-v2-flag-off'])
@pytest.mark.parametrize('instant', [True, False], ids=['instant', 'overnight'])
@pytest.mark.parametrize('mode,action,primary_cost,extras', BATCH_CASES, ids=[case[0] for case in BATCH_CASES])
def test_batch_posts_debit_each_row_at_its_frozen_strategy_cost(processing, monkeypatch, enabled, instant, mode, action, primary_cost, extras):
    monkeypatch.setattr(processing.core, 'UNIFIED_CREDITS_ENABLED', enabled)
    divisor = 1 if instant else 2
    row_cost = (primary_cost + 2 * extras) // divisor

    response = post_batch(processing, mode, instant=instant, extras=extras)

    assert response.status_code == 200, response.get_json()
    batch_id = response.get_json()['batch_id']
    batch = processing.store.docs('batch_jobs')[batch_id]
    rows = processing.store.docs(f'batch_jobs/{batch_id}/rows')
    assert batch['status'] == 'queued' and batch['credit_admission_state'] == 'admitted'
    assert batch['processing_strategy'] == ('instant' if instant else 'batch')
    assert len(rows) == 3
    assert processing.store.docs('users')[UID]['credits'] == 100 - 3 * row_cost
    assert processing.store.docs('users')[UID]['total_processed'] == 3
    charges = processing.store.docs('credit_charges')
    assert len(charges) == 3
    assert sum(charge['charged_credits'] for charge in charges.values()) == 3 * row_cost
    for row in rows.values():
        assert row['credit_scheme'] == 2 and row['charged_credits'] == row_cost
        receipt = row['billing_receipt']
        assert receipt['charged_credits'] == row_cost and receipt['refunded_credits'] == 0
        assert receipt['components']['primary']['action'] == action
        assert receipt['components']['primary']['charged_credits'] == primary_cost // divisor
        if extras:
            assert receipt['components']['extras']['units'] == extras
            assert receipt['components']['extras']['charged_credits'] == 2 * extras // divisor
    assert len(processing.queued) == 1


@pytest.mark.parametrize('instant,needed', [(True, 42), (False, 21)], ids=['instant', 'overnight'])
def test_batch_preflight_includes_all_rows_and_extras_without_partial_debit(processing, instant, needed):
    processing.store.documents[('users', UID)]['credits'] = needed - 1

    response = post_batch(processing, 'interview', instant=instant, extras=2)

    assert response.status_code == 402, response.get_json()
    body = response.get_json()
    assert body['needed'] == needed and body['available'] == needed - 1
    assert body['error_code'] == 'insufficient_credits'
    assert processing.store.docs('users')[UID]['credits'] == needed - 1
    assert processing.store.docs('credit_charges') == {}
    assert processing.store.docs('batch_jobs') == {}
    assert processing.queued == []
