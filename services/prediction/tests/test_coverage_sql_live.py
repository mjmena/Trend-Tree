"""The detection SQL, executed (CRMA-767 AC1).

    "The detection SQL is testable standalone: known published stories match
    a fixture subject above threshold; syndicated duplicates count once."

Everything else in this story is asserted offline, which is right for logic
but cannot say anything about the parts that live *in* the statement -- the
headline fold, the ``GROUP BY``, the similarity predicate. Those are only
真 testable by running them, so this file runs them.

**It is opt-in and skipped by default.** The statement reads a live
warehouse: there is no warehouse in CI, the pool it reads moves, and a test
that silently required Snowflake credentials would fail for the wrong reason
on every other machine. Run it deliberately:

    PREDICTION_COVERAGE_LIVE_SQL=1 .venv/bin/python -m pytest \\
        tests/test_coverage_sql_live.py -v

It shells out to the repo's standing Snowflake CLI recipe (``snow sql -c
claude``, see the project memory) rather than opening its own connection,
because that is the command a human runs against this file by hand -- which
is what "testable standalone" means here.

Recorded result, 2026-08-24: the fixture subject 'protein coffee' returns
exactly one detection, CONTENT_ID 316520398, SIMILARITY 0.8172; 'urolithin A'
returns none; and at a lowered threshold the two-site syndication of one
'functional beer' story returns as ONE row with SYNDICATED_COPIES = 2.
"""

from __future__ import annotations

import csv
import io
import os
import pathlib
import subprocess

import pytest

REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
DETECTION_SQL = REPO_ROOT / "sql" / "prediction_coverage_detection.sql"
CONNECTION = os.environ.get("PREDICTION_COVERAGE_LIVE_SQL_CONNECTION", "claude")

pytestmark = pytest.mark.skipif(
    os.environ.get("PREDICTION_COVERAGE_LIVE_SQL") != "1",
    reason=(
        "reads the live warehouse; set PREDICTION_COVERAGE_LIVE_SQL=1 to run it "
        "(see this module's docstring)"
    ),
)


def run(sql: str) -> list[dict[str, str]]:
    """Execute ``sql`` and return its rows."""
    result = subprocess.run(
        ["snow", "sql", "-c", CONNECTION, "--format", "csv", "-q", sql],
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    assert result.returncode == 0, result.stderr or result.stdout
    body = result.stdout[result.stdout.index("SUBJECT_DESCRIPTOR") :]
    return list(csv.DictReader(io.StringIO(body)))


def statement(*, subjects: tuple[str, ...], min_similarity: float) -> str:
    """The file's own statement with its fixture subjects and threshold
    swapped -- the text is otherwise untouched, so what runs here is what the
    service issues."""
    text = DETECTION_SQL.read_text()
    body = text[text.index("WITH params AS (") :].rstrip().rstrip(";")
    selects = "\n    UNION ALL ".join(
        (f"SELECT '{s}' AS SUBJECT_DESCRIPTOR" if i == 0 else f"SELECT '{s}'")
        for i, s in enumerate(subjects)
    )
    start = body.index("SUBJECTS AS (")
    end = body.index("),", start)
    body = body[:start] + "SUBJECTS AS (\n    " + selects + "\n" + body[end:]
    return body.replace("0.78::FLOAT", f"{min_similarity}::FLOAT", 1)


def test_a_known_published_story_matches_a_fixture_subject_above_the_threshold():
    rows = run(statement(subjects=("protein coffee", "urolithin A"), min_similarity=0.78))

    hits = [row for row in rows if row["SUBJECT_DESCRIPTOR"] == "protein coffee"]
    assert len(hits) == 1, rows
    assert hits[0]["CONTENT_ID"] == "316520398"
    assert hits[0]["HEADLINE"].startswith("Protein coffee:")
    assert float(hits[0]["SIMILARITY"]) >= 0.78

    # ...and the threshold is doing work: a subject we have not covered
    # returns nothing rather than its nearest adjacency.
    assert [row for row in rows if row["SUBJECT_DESCRIPTOR"] == "urolithin A"] == []


def test_syndicated_duplicates_count_once():
    # One story, published on two McClatchy sites four weeks apart, folds to
    # a single detection that reports how many rows collapsed into it.
    rows = run(statement(subjects=("functional beer",), min_similarity=0.70))

    syndicated = [row for row in rows if int(row["SYNDICATED_COPIES"]) > 1]
    assert syndicated, rows
    for row in syndicated:
        assert row["FIRST_PUBLISHED_DATE"] < row["LAST_PUBLISHED_DATE"]

    # The dedupe is what makes this true: no headline appears twice.
    headlines = [row["HEADLINE"] for row in rows]
    assert len(headlines) == len(set(headlines))
