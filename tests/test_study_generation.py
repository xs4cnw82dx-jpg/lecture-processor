import pytest

from lecture_processor.domains.ai import study_generation


@pytest.fixture(params=['domain', 'runtime'])
def validation(request, app, core):
    with app.app_context():
        yield study_generation if request.param == 'domain' else core


def test_normalize_flashcard_front_converts_plain_term_to_question(validation):
    assert validation.normalize_flashcard_front("Mitochondria") == "What is Mitochondria?"


def test_normalize_flashcard_front_adds_question_mark_to_existing_prompt(validation):
    assert validation.normalize_flashcard_front("List all key components of a neuron.") == "List all key components of a neuron?"


def test_normalize_flashcard_front_preserves_existing_question(validation):
    assert validation.normalize_flashcard_front("What is osmosis?") == "What is osmosis?"


def test_sanitize_flashcards_normalizes_fronts(validation):
    cards = validation.sanitize_flashcards(
        [
            {"front": "Photosynthesis", "back": "Process plants use to convert light into energy."},
            {"front": "What is osmosis?", "back": "Movement of water across a semipermeable membrane."},
        ],
        10,
    )

    assert cards[0]["front"] == "What is Photosynthesis?"
    assert cards[1]["front"] == "What is osmosis?"


def test_flashcards_reject_invalid_entries_and_duplicates_before_limiting(validation):
    cards = validation.sanitize_flashcards([
        None,
        {'front': '', 'back': 'Missing prompt'},
        {'front': 'Osmosis', 'back': ' Water movement '},
        {'front': 'What is osmosis?', 'back': 'Water movement'},
        {'front': 'Neuron', 'back': 'Nerve cell'},
        {'front': 'Extra', 'back': 'Outside the requested amount'},
    ], 2)
    assert cards == [
        {'front': 'What is Osmosis?', 'back': 'Water movement'},
        {'front': 'What is Neuron?', 'back': 'Nerve cell'},
    ]


def test_questions_require_four_distinct_options_and_an_existing_answer(validation):
    valid = {'question': ' Which one? ', 'options': [' A ', 'B', 'C', 'D'], 'answer': ' A ', 'explanation': ' Because. '}
    questions = validation.sanitize_questions([
        {'question': 'Missing answer', 'options': ['A', 'B', 'C', 'D'], 'answer': 'E'},
        {'question': 'Duplicate options', 'options': ['A', 'A', 'C', 'D'], 'answer': 'A'},
        {'question': 'Too few', 'options': ['A', 'B'], 'answer': 'A'},
        valid,
        {**valid, 'question': 'which one?'},
    ], 10)
    assert questions == [{'question': 'Which one?', 'options': ['A', 'B', 'C', 'D'], 'answer': 'A', 'explanation': 'Because.'}]


def test_json_extraction_accepts_fenced_or_surrounded_results_and_rejects_malformed(validation):
    expected = {'flashcards': []}
    assert validation.extract_json_payload('```json\n{"flashcards": []}\n```') == expected
    assert validation.extract_json_payload('Result: {"flashcards": []} trailing text') == expected
    assert validation.extract_json_payload('Result: {"flashcards": [}') is None


def test_auto_and_explicit_amounts_keep_existing_generation_contract(validation):
    assert validation.resolve_auto_amount('flashcards', 'word ' * 1200) == 20
    assert validation.resolve_auto_amount('questions', 'word ' * 2600) == 15
    assert validation.resolve_study_amounts('auto', '7', 'short text') == (10, 7)
