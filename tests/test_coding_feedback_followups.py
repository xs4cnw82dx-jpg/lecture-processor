"""Public coding feedback against synthetic providers and the real credit policy."""

from copy import deepcopy
import logging
from types import SimpleNamespace

from flask import Flask, jsonify, request
import pytest

from lecture_processor.domains.ai import study_generation
from lecture_processor.domains.billing import ledger, policy
from lecture_processor.repositories import study_repo, users_repo
from lecture_processor.services import interview_coding_service as coding
from tests.credit_test_support import make_credit_runtime


@pytest.mark.parametrize('scheme', [1, 2])
@pytest.mark.parametrize('category', ['lecture', 'slides', 'interview'])
@pytest.mark.parametrize('exemption', ['lecture', 'slides'])
def test_coding_estimate_exemption_matches_the_configured_charge(monkeypatch, scheme, category, exemption):
    monkeypatch.setitem(policy.ACTION_COSTS, 'interview_coding', {
        **policy.ACTION_COSTS['interview_coding'], 'category': category,
    })
    user = {field: 10 for field in policy.LEGACY_FIELD_RATES}
    user.update(uid='owner', unlimited_credits={exemption: True})
    if scheme == 2:
        user.update(credits_version=2, credits=100)
    runtime, state = make_credit_runtime(users={'owner': user}, unified_enabled=False)
    runtime.repositories = SimpleNamespace(study=study_repo, users=users_repo)
    runtime.jsonify = jsonify
    monkeypatch.setattr(coding.study_api_support, 'require_user', lambda *_args: ({'uid': 'owner'}, None, None))
    monkeypatch.setattr(coding, '_require_interview_pack', lambda *_args: (
        {'uid': 'owner', 'mode': 'interview'}, 'Synthetic transcript', None, None,
    ))
    app = Flask(__name__)

    @app.get('/coding/estimate')
    def estimate():
        return coding.get_coding_state(runtime, request, 'pack')

    before = deepcopy(state.documents)
    response = app.test_client().get('/coding/estimate')
    assert response.status_code == 200
    quote = response.get_json()['ai_estimate']
    assert state.documents == before and state.commit_count == 0
    receipt = ledger.charge_credits(
        'owner', policy.action_cost('interview_coding'), 'interview_coding', 'synthetic-coding',
        components={'primary': {'action': 'interview_coding', 'units': 1}}, runtime=runtime,
    )
    assert quote['credit_scheme'] == scheme
    assert quote['charged_credits'] == receipt['charged_credits']
    assert receipt['charged_credits'] == (0 if exemption == category else 2 if scheme == 2 else 1)
    assert quote['credit_cost'] == (2 if scheme == 2 else 1)


@pytest.mark.parametrize('failure', ['exception', 'empty', 'mixed'])
def test_two_failed_interview_features_return_one_message_and_keep_accounting(monkeypatch, caplog, failure):
    runtime = SimpleNamespace(
        PROMPT_INTERVIEW_SUMMARY='{transcript} {output_language}',
        PROMPT_INTERVIEW_SECTIONED='{transcript} {output_language}',
        MODEL_STUDY='synthetic-model', logger=logging.getLogger('coding-feedback-test'),
    )
    calls = []

    def generate(*_args, **kwargs):
        operation = kwargs['operation_name']
        calls.append(operation)
        if failure == 'exception' or (failure == 'mixed' and operation == 'interview_summary_generation'):
            raise RuntimeError('Synthetic private provider diagnostic')
        return SimpleNamespace(text='  ')

    monkeypatch.setattr(study_generation.ai_provider, 'generate_with_optional_thinking', generate)
    monkeypatch.setattr(study_generation.ai_provider, 'extract_token_usage', lambda *_args, **_kwargs: {
        'input_tokens': 7, 'output_tokens': 4, 'total_tokens': 11,
    })
    result = study_generation.generate_interview_enhancements(
        'Synthetic transcript', ['summary', 'sections'], runtime=runtime,
    )
    assert result['error'] == 'Could not generate the interview summary or structured transcript. Please try again.'
    assert result['error_code'] == 'interview_enhancement_failed'
    assert result['failed_count'] == 2 and result['successful_features'] == []
    assert not result['summary'] and not result['sections'] and result['combined'] is None
    assert calls == ['interview_summary_generation', 'interview_sections_generation']
    assert result['token_total'] == {'exception': 0, 'empty': 22, 'mixed': 11}[failure]
    assert 'Synthetic private provider diagnostic' not in str(result)
    if failure != 'empty':
        assert 'Synthetic private provider diagnostic' in caplog.text
