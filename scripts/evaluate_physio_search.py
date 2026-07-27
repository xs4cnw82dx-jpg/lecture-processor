#!/usr/bin/env python3
"""Evaluate the local lexical Physio index against the shoulder gold set."""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lecture_processor.physio_companion.index import KnowledgeIndex


DEFAULT_VAULT = Path.home() / "Documents/Physio Knowledge Vault"
DEFAULT_SUPPORT = Path.home() / "Library/Application Support/Lecture Processor/Physio"


def evaluate(index: KnowledgeIndex, benchmark: Path) -> dict:
    rows = list(csv.DictReader(benchmark.open(encoding="utf-8")))
    evaluated = []
    timings = []
    for row in rows:
        include_unreviewed = row.get("expected_visibility") == "review_only"
        started = time.perf_counter()
        results = index.search(row["query"], include_unreviewed=include_unreviewed, limit=5)
        timings.append(time.perf_counter() - started)
        rank = next((position for position, item in enumerate(results, 1) if item["note_id"] == row["expected_note_id"]), None)
        evaluated.append({
            "question_id": row["question_id"],
            "query": row["query"],
            "expected_note_id": row["expected_note_id"],
            "rank": rank,
            "pass_top_five": rank is not None and rank <= 5,
            "pass_expected_rank": not row.get("expected_max_rank") or (rank is not None and rank <= int(row["expected_max_rank"])),
            "visibility": row.get("expected_visibility", "default"),
        })
    default_rows = [item for item in evaluated if item["visibility"] == "default"]
    rank_one_rows = [
        item for item, source in zip(evaluated, rows)
        if source.get("expected_max_rank") == "1" and item["visibility"] == "default"
    ]
    return {
        "questions": len(evaluated),
        "default_questions": len(default_rows),
        "top_five_recall": round(sum(item["pass_top_five"] for item in default_rows) / max(1, len(default_rows)), 4),
        "expected_rank_pass_rate": round(sum(item["pass_expected_rank"] for item in default_rows) / max(1, len(default_rows)), 4),
        "rank_one_accuracy": round(sum(item["rank"] == 1 for item in rank_one_rows) / max(1, len(rank_one_rows)), 4),
        "warm_search_p95_ms": round(statistics.quantiles(timings, n=20)[18] * 1000, 2) if len(timings) >= 2 else round(timings[0] * 1000, 2),
        "failures": [item for item in evaluated if not item["pass_expected_rank"]],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", type=Path, default=DEFAULT_VAULT)
    parser.add_argument("--index", type=Path, default=DEFAULT_SUPPORT / "knowledge-index.sqlite3")
    parser.add_argument("--benchmark", type=Path, default=DEFAULT_VAULT / "00 Start/benchmark-schouder-50.csv")
    parser.add_argument("--refresh", action="store_true")
    args = parser.parse_args()
    index = KnowledgeIndex(args.vault, args.index)
    if args.refresh:
        index.refresh()
    result = evaluate(index, args.benchmark)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["top_five_recall"] >= 0.9 else 1


if __name__ == "__main__":
    raise SystemExit(main())
