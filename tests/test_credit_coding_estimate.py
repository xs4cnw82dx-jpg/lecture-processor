from copy import deepcopy
from types import SimpleNamespace

from flask import Flask, jsonify, request
import pytest

from lecture_processor.domains.billing import policy
from lecture_processor.repositories import study_repo, users_repo
from lecture_processor.services import interview_coding_service as service
from tests.credit_test_support import make_credit_runtime


@pytest.mark.parametrize('enabled,version,exempt,scheme', [
    (True, 2, False, 2), (False, 2, False, 2), (False, 2, True, 2),
    (True, None, False, 2), (False, None, False, 1), (False, None, True, 1),
])
@pytest.mark.parametrize('transcript,units', [('', 0), ('  ', 0), ('Hello', 1), ('😀' * 120000, 1), ('😀' * 120001, 2)], ids=['empty', 'blank', 'short', 'unit-boundary', 'next-unit'])
def test_owned_coding_estimate_names_its_units_and_actual_charge(monkeypatch, enabled, version, exempt, scheme, transcript, units):
    user = {'uid': 'one', 'slides_credits': 10, 'unlimited_credits': {'slides': exempt}}
    if version:
        user.update(credits_version=version, credits=20)
    runtime, store = make_credit_runtime(users={'one': user}, unified_enabled=enabled)
    runtime.repositories = SimpleNamespace(study=study_repo, users=users_repo)
    runtime.jsonify = jsonify
    monkeypatch.setattr(service.study_api_support, 'require_user', lambda *_args: ({'uid': 'one'}, None, None))
    monkeypatch.setattr(service, '_require_interview_pack', lambda *_args: ({'mode': 'interview', 'uid': 'one'}, transcript, None, None))
    before = deepcopy(store.documents)
    app = Flask(__name__)
    @app.get('/coding/estimate')
    def estimate():
        return service.get_coding_state(runtime, request, 'pack-one')
    response = app.test_client().get('/coding/estimate')
    assert response.status_code == 200
    estimate = response.get_json()['ai_estimate']
    price = policy.action_cost('interview_coding', units=units) if scheme == 2 else units
    assert estimate['credit_scheme'] == scheme
    assert estimate['credit_cost'] == price
    assert estimate['charged_credits'] == (0 if exempt else price)
    assert store.documents == before
    assert store.commit_count == 0
