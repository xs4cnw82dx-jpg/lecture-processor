from lecture_processor.domains.ai import study_generation


def test_normalize_flashcard_front_converts_plain_term_to_question():
    assert study_generation.normalize_flashcard_front("Mitochondria") == "What is Mitochondria?"


def test_normalize_flashcard_front_adds_question_mark_to_existing_prompt():
    assert study_generation.normalize_flashcard_front("List all key components of a neuron.") == "List all key components of a neuron?"


def test_normalize_flashcard_front_preserves_existing_question():
    assert study_generation.normalize_flashcard_front("What is osmosis?") == "What is osmosis?"


def test_sanitize_flashcards_normalizes_fronts():
    cards = study_generation.sanitize_flashcards(
        [
            {"front": "Photosynthesis", "back": "Process plants use to convert light into energy."},
            {"front": "What is osmosis?", "back": "Movement of water across a semipermeable membrane."},
        ],
        10,
    )

    assert cards[0]["front"] == "What is Photosynthesis?"
    assert cards[1]["front"] == "What is osmosis?"
