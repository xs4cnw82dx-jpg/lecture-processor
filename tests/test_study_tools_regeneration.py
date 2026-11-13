from copy import deepcopy
import json
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import pipelines


@pytest.fixture
def regeneration(monkeypatch):
    pack = {
        'uid': 'synthetic-owner',
        'title': 'Movement notes',
        'notes_markdown': 'Muscles contract and move joints.',
        'flashcards': [
            {'front': 'What is a muscle?', 'back': 'Original explanation', 'image_ids': ['muscle-image']},
            {'front': 'What is a joint?', 'back': 'Original joint explanation', 'image_ids': ['joint-image']},
        ],
        'test_questions': [
            {'question': 'Original question?', 'options': ['A', 'B', 'C', 'D'], 'answer': 'A', 'explanation': 'Original reason'},
        ],
        'flashcards_count': 2,
        'test_questions_count': 1,
        'study_features': 'both',
        'flashcard_selection': '30',
        'question_selection': '15',
        'updated_at': 10.0,
    }
    state = {
        'pack': pack,
        'updates': [],
        'refunds': [],
        'logs': [],
        'job': {
            'user_id': 'synthetic-owner',
            'status': 'queued',
            'study_features': 'both',
            'flashcard_selection': '20',
            'question_selection': '10',
            'study_tools_credit_cost': 1,
            'extra_slides_refunded': 0,
            'credit_refunded': False,
            'billing_receipt': {'charged': {'slides_credits': 1}, 'refunded': {}},
        },
    }

    def update_pack(fields):
        state['updates'].append(deepcopy(fields))
        pack.update(deepcopy(fields))

    pack_doc = SimpleNamespace(
        exists=True,
        to_dict=lambda: deepcopy(pack),
        reference=SimpleNamespace(update=update_pack),
    )
    runtime = SimpleNamespace(
        db=object(),
        study_repo=SimpleNamespace(get_study_pack_doc=lambda *_: pack_doc),
        time=SimpleNamespace(time=lambda: 100.0),
        logger=SimpleNamespace(exception=lambda *_, **__: None, warning=lambda *_, **__: None),
        MODEL_STUDY='synthetic-study-model',
        PROMPT_STUDY_TEMPLATE='{source_text} {flashcard_amount} {question_amount} {output_language}',
        PROCESSING_PUBLIC_ERROR_MESSAGE='Processing could not finish. Please try again.',
        save_job_log=lambda *args: state['logs'].append(deepcopy(args)),
    )

    def update_job(_job_id, runtime=None, **fields):
        state['job'].update(deepcopy(fields))

    def set_job(_job_id, payload, runtime=None):
        state['job'] = deepcopy(payload)

    def refund(uid, amount, **kwargs):
        state['refunds'].append((uid, amount, kwargs['idempotency_key'], kwargs['idempotency_total']))
        return True

    monkeypatch.setattr(pipelines.runtime_jobs_store, 'get_job_snapshot', lambda *_args, **_kwargs: deepcopy(state['job']))
    monkeypatch.setattr(pipelines.runtime_jobs_store, 'update_job_fields', update_job)
    monkeypatch.setattr(pipelines.runtime_jobs_store, 'set_job', set_job)
    monkeypatch.setattr(pipelines.billing_credits, 'refund_slides_credits', refund)

    def run(response, *, features='both'):
        state['job']['study_features'] = features

        def generate(*_args, **_kwargs):
            if isinstance(response, Exception):
                raise response
            return SimpleNamespace(
                text=response,
                usage_metadata=SimpleNamespace(prompt_token_count=12, candidates_token_count=8, total_token_count=20),
            )

        monkeypatch.setattr(pipelines.ai_provider, 'generate_with_policy', generate)
        pipelines.regenerate_study_tools_for_pack('synthetic-job', 'synthetic-pack', runtime=runtime)

    return state, run


@pytest.mark.parametrize('response', [RuntimeError('Synthetic provider failure'), '{}', '{"flashcards": [], "test_questions": []}', '{"flashcards": [}'])
def test_failed_regeneration_keeps_pack_and_refunds_reserved_credit(regeneration, response):
    state, run = regeneration
    original = deepcopy(state['pack'])

    run(response)

    assert state['pack'] == original
    assert state['updates'] == []
    assert state['job']['status'] == 'error'
    assert state['job']['failed_stage'] == 'study_tools_generation'
    assert state['job']['error'] == 'Processing could not finish. Please try again.'
    assert state['refunds'] == [('synthetic-owner', 1, 'runtime-job:synthetic-job:extras', 1)]
    assert state['job']['extra_slides_refunded'] == 1
    assert state['job']['credit_refunded'] is True
    assert state['job']['billing_receipt']['refunded'] == {'slides_credits': 1}
    assert state['logs'][-1][1]['status'] == 'error'


def generated_materials():
    return {
        'flashcards': [
            {'front': 'What is a muscle?', 'back': 'Updated muscle explanation'},
            {'front': 'What is a tendon?', 'back': 'Connective tissue'},
        ],
        'test_questions': [
            {'question': 'Which tissue?', 'options': ['Muscle', 'Bone', 'Skin', 'Nerve'], 'answer': 'Muscle', 'explanation': 'It contracts.'},
        ],
    }


@pytest.mark.parametrize('features', ['flashcards', 'test'])
def test_unrequested_material_cannot_make_an_empty_regeneration_succeed(regeneration, features):
    state, run = regeneration
    original = deepcopy(state['pack'])
    response = generated_materials()
    response['flashcards' if features == 'flashcards' else 'test_questions'] = []

    run(json.dumps(response), features=features)

    assert state['pack'] == original
    assert state['updates'] == []
    assert state['job']['status'] == 'error'
    assert state['refunds'] == [('synthetic-owner', 1, 'runtime-job:synthetic-job:extras', 1)]


@pytest.mark.parametrize('missing_section', ['flashcards', 'test_questions'])
@pytest.mark.parametrize('missing_kind', ['empty', 'omitted', 'invalid'])
def test_partial_regeneration_preserves_the_section_without_valid_output(regeneration, missing_section, missing_kind):
    state, run = regeneration
    original = deepcopy(state['pack'])
    generated = generated_materials()
    if missing_kind == 'omitted':
        generated.pop(missing_section)
    else:
        generated[missing_section] = [] if missing_kind == 'empty' else [{'unrelated': 'Invalid item'}]

    run(json.dumps(generated), features='both')

    selection_field = 'flashcard_selection' if missing_section == 'flashcards' else 'question_selection'
    for field in (missing_section, f'{missing_section}_count', selection_field):
        assert state['pack'][field] == original[field]
        assert field not in state['updates'][0]
    updated_section = 'test_questions' if missing_section == 'flashcards' else 'flashcards'
    assert state['pack'][updated_section] != original[updated_section]
    assert state['job']['status'] == 'complete'
    assert state['job']['flashcards'] == state['pack']['flashcards']
    assert state['job']['test_questions'] == state['pack']['test_questions']
    assert state['pack']['study_features'] == 'both'
    assert state['refunds'] == []


@pytest.mark.parametrize('features', ['flashcards', 'test', 'both'])
def test_regeneration_only_replaces_selected_materials(regeneration, features):
    state, run = regeneration
    original = deepcopy(state['pack'])
    generated = generated_materials()

    # The provider may include an unrequested section; selection still controls writes.
    run(json.dumps(generated), features=features)

    assert state['job']['status'] == 'complete'
    assert state['refunds'] == []
    assert state['job']['token_total'] == 20
    expected_cards = [{**generated['flashcards'][0], 'image_ids': ['muscle-image']}, generated['flashcards'][1]]
    if features in ('flashcards', 'both'):
        assert state['pack']['flashcards'] == expected_cards
        assert state['pack']['flashcards_count'] == 2
        assert state['pack']['flashcard_selection'] == '20'
    else:
        for field in ('flashcards', 'flashcards_count', 'flashcard_selection'):
            assert state['pack'][field] == original[field]
            assert field not in state['updates'][0]
    if features in ('test', 'both'):
        assert state['pack']['test_questions'] == generated['test_questions']
        assert state['pack']['test_questions_count'] == 1
        assert state['pack']['question_selection'] == '10'
    else:
        for field in ('test_questions', 'test_questions_count', 'question_selection'):
            assert state['pack'][field] == original[field]
            assert field not in state['updates'][0]
    assert state['job']['flashcards'] == state['pack']['flashcards']
    assert state['job']['test_questions'] == state['pack']['test_questions']
    assert state['pack']['study_features'] == 'both'


@pytest.mark.parametrize('features', ['flashcards', 'test'])
def test_regeneration_metadata_describes_the_saved_sections(regeneration, features):
    state, run = regeneration
    empty_section = 'test_questions' if features == 'flashcards' else 'flashcards'
    state['pack'][empty_section] = []
    state['pack'][f'{empty_section}_count'] = 0

    run(json.dumps(generated_materials()), features=features)

    assert state['pack']['study_features'] == features
    assert state['pack'][empty_section] == []
    assert state['job']['status'] == 'complete'
    assert state['refunds'] == []


def test_regeneration_retains_images_by_front_when_cards_move(regeneration):
    state, run = regeneration
    generated = generated_materials()
    generated['flashcards'] = [
        {'front': 'What is a joint?', 'back': 'Updated joint explanation'},
        {'front': 'What is a muscle?', 'back': 'Updated muscle explanation'},
    ]

    run(json.dumps(generated), features='flashcards')

    assert [card.get('image_ids') for card in state['pack']['flashcards']] == [['joint-image'], ['muscle-image']]


def test_regeneration_retains_distinct_images_from_cards_with_the_same_front(regeneration):
    state, run = regeneration
    state['pack']['flashcards'].append({
        'front': 'What is a muscle?',
        'back': 'Another explanation',
        'image_ids': ['alternate-image', 'alternate-image'],
    })
    state['pack']['flashcards_count'] = 3

    run(json.dumps(generated_materials()), features='flashcards')

    assert state['job']['status'] == 'complete'
    assert state['pack']['flashcards'][0]['image_ids'] == ['muscle-image', 'alternate-image']
    assert state['job']['flashcards'] == state['pack']['flashcards']
    assert state['refunds'] == []


def test_regeneration_retains_nonfatal_generation_warning(regeneration):
    state, run = regeneration
    state['pack']['notes_markdown'] = 'Synthetic long notes. ' * 6000

    run(json.dumps(generated_materials()))

    assert state['job']['status'] == 'complete'
    assert 'truncated' in state['pack']['study_generation_error']
    assert state['pack']['flashcards'][0]['back'] == 'Updated muscle explanation'
    assert state['refunds'] == []
