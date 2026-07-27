from pathlib import Path
import csv
import importlib.util
import sys


SCRIPT = Path(__file__).parents[1] / "scripts/evaluate_physio_search.py"
SPEC = importlib.util.spec_from_file_location("evaluate_physio_search", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
assert SPEC.loader
SPEC.loader.exec_module(MODULE)


class Index:
    def search(self, query, include_unreviewed=False, limit=5):
        if query == "hit":
            return [{"note_id": "expected"}]
        return []


def test_benchmark_reports_top_five_and_rank_one(tmp_path):
    benchmark = tmp_path / "gold.csv"
    with benchmark.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=["question_id", "query", "expected_note_id", "expected_max_rank", "expected_visibility"])
        writer.writeheader()
        writer.writerow({"question_id": "1", "query": "hit", "expected_note_id": "expected", "expected_max_rank": "1", "expected_visibility": "default"})

    result = MODULE.evaluate(Index(), benchmark)

    assert result["top_five_recall"] == 1.0
    assert result["rank_one_accuracy"] == 1.0
