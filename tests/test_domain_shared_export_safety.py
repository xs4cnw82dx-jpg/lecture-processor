from lecture_processor.domains.shared import sanitize_csv_cell, sanitize_csv_row
from lecture_processor.domains.study import export as study_export
from tests.runtime_test_support import get_test_core

core = get_test_core()


def test_sanitize_csv_cell_prefixes_formula_like_values():
    assert sanitize_csv_cell('=2+2') == "'=2+2"
    assert sanitize_csv_cell('+SUM(A1:A2)') == "'+SUM(A1:A2)"
    assert sanitize_csv_cell('-cmd') == "'-cmd"
    assert sanitize_csv_cell('@risk') == "'@risk"
    assert sanitize_csv_cell('\tvalue') == "'\tvalue"
    assert sanitize_csv_cell('safe text') == 'safe text'
    assert sanitize_csv_cell(42) == 42


def test_sanitize_csv_row_applies_cell_rules():
    row = sanitize_csv_row(['=x', 'safe', None, 3])
    assert row == ["'=x", 'safe', '', 3]


def test_build_flashcards_csv_bytes_sanitizes_formula_cells():
    csv_bytes = study_export.build_flashcards_csv_bytes(
        {
            'flashcards': [
                {'front': '=front', 'back': '+back'},
            ]
        },
        runtime=core,
    )

    csv_text = csv_bytes.decode('utf-8')
    assert "'=front" in csv_text
    assert "'+back" in csv_text


def test_build_practice_test_csv_bytes_sanitizes_formula_cells():
    csv_bytes = study_export.build_practice_test_csv_bytes(
        {
            'test_questions': [
                {
                    'question': '@question',
                    'options': ['=a', 'safe', '-c', '+d'],
                    'answer': '=answer',
                    'explanation': '\twhy',
                }
            ]
        },
        runtime=core,
    )

    csv_text = csv_bytes.decode('utf-8')
    assert "'@question" in csv_text
    assert "'=a" in csv_text
    assert "'-c" in csv_text
    assert "'+d" in csv_text
    assert "'=answer" in csv_text
    assert "'\twhy" in csv_text
