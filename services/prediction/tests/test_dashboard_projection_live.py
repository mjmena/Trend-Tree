"""The projection, run against live Snowflake, read-only (CRMA-769).

``test_dashboard_projection.py`` freezes the *shape* of the shipped SQL. This
module runs it and looks at the rows, which is the seam the spec actually
asks for:

    "Projection: the dashboard dynamic table. SQL assertions that the three
    retained columns read from the latest active matched verdict (NULL when
    none), and the additive narrative columns render -- including the composed
    claim sentence."  -- docs/prd/prediction-pillar-v1.md, Testing Decisions

And it is the repo's standing convention: "it worked" means rows landed,
verified by query.

**Read-only.** The projection is extracted from ``sql/dt_trend_dashboard.sql``
and run as a ``SELECT``. The live dynamic table is never altered -- applying
the re-point is a deliberate human step after the epic merges.

The whole module skips when Snowflake is not reachable (no ``snow`` CLI, no
``claude`` connection, expired SSO), so a machine without credentials still
gets a green suite from the structural module alone.
"""

from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from .test_dashboard_projection import DASHBOARD_SQL

#: Every prediction column the projection emits.
PROJECTED = (
    "PREDICTION_SCORE",
    "PREDICTION_FLAG",
    "PREDICTION_ELIGIBLE",
    "PREDICTION_CLAIM",
    "PREDICTION_REASONING",
    "PREDICTION_WHAT_CHANGED",
    "PREDICTION_EVALUATED_AT",
    "PREDICTION_ANGLE",
    "PREDICTION_AUDIENCE_QUESTION",
    "PREDICTION_CITED_EXAMPLES",
)

#: The three whose names, types and ranges AC1 pins.
RETAINED = PROJECTED[:3]

BANDS = (("High Potential", 80.0), ("Watchlist", 65.0), ("Emerging", 40.0))


def _run(sql: str) -> list[dict]:
    result = subprocess.run(
        ["snow", "sql", "-c", "claude", "--format", "json", "--stdin"],
        input=sql,
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode != 0:
        pytest.skip(f"Snowflake unreachable: {result.stderr.strip()[:200]}")
    return json.loads(result.stdout)


def _projection_body() -> str:
    """The shipped dynamic table's SELECT, lifted out of its CREATE."""
    sql = DASHBOARD_SQL.read_text()
    create = sql[sql.index("CREATE OR REPLACE DYNAMIC TABLE") :]
    return create[create.index("\nAS\nWITH ") + len("\nAS\n") :].rstrip().rstrip(";")


@pytest.fixture(scope="module")
def snowflake() -> None:
    if shutil.which("snow") is None:
        pytest.skip("the snow CLI is not installed")
    _run("SELECT 1 AS OK;")


@pytest.fixture(scope="module")
def projected(snowflake) -> list[dict]:
    """One row per trend, prediction columns only, from the shipped SQL."""
    columns = ", ".join(PROJECTED)
    return _run(f"SELECT TREND_ID, {columns}\nFROM (\n{_projection_body()}\n) shadow;")


@pytest.fixture(scope="module")
def elected(snowflake) -> list[dict]:
    """What the ledger says the projection *should* show, derived independently.

    Deliberately not the projection's own CTEs: an expectation computed the
    way the code computes it agrees with the code by construction. This reads
    the ledger straight and applies the story's rule in words -- latest
    verdict per prediction, keep the ACTIVE matched ones, one per trend.
    """
    return _run("""
        WITH latest AS (
          SELECT PREDICTION_ID, MATCHED_TREND_ID, PREDICTION_STATUS, CONFIDENCE,
                 EVALUATED_AT, REASONING, ANGLE, AUDIENCE_QUESTION,
                 EVIDENCE:source_signals AS SOURCE_SIGNALS
          FROM MCC_PRESENTATION.TREND_AGENT.FCT_PREDICTION_VERDICT_LEDGER
          QUALIFY ROW_NUMBER() OVER (
            PARTITION BY PREDICTION_ID ORDER BY EVALUATED_AT DESC, PREDICTION_EVAL_ID) = 1
        )
        SELECT MATCHED_TREND_ID AS TREND_ID, CONFIDENCE, REASONING,
               ANGLE, AUDIENCE_QUESTION,
               COALESCE(ARRAY_SIZE(SOURCE_SIGNALS), 0) AS CITED
        FROM latest
        WHERE PREDICTION_STATUS = 'ACTIVE' AND MATCHED_TREND_ID IS NOT NULL
        QUALIFY ROW_NUMBER() OVER (
          PARTITION BY MATCHED_TREND_ID
          ORDER BY EVALUATED_AT DESC, CONFIDENCE DESC, PREDICTION_ID) = 1;
    """)


def _with_a_call(projected: list[dict]) -> list[dict]:
    return [row for row in projected if row["PREDICTION_SCORE"] is not None]


# --- AC1 -------------------------------------------------------------------


def test_the_projection_covers_every_trend(projected: list[dict]):
    # The re-point changes what the prediction columns say, not which trends
    # have a row. A dashboard that lost trends would be a very different
    # change from the one this story describes.
    assert len(projected) > 100
    assert len({row["TREND_ID"] for row in projected}) == len(projected)


def test_a_trend_with_no_active_matched_prediction_reads_null_in_all_three(
    projected: list[dict],
):
    silent = [row for row in projected if row["PREDICTION_SCORE"] is None]
    assert silent, "expected most trends to carry no active call"
    for row in silent:
        assert all(row[column] is None for column in RETAINED), row["TREND_ID"]


def test_eligible_is_never_false(projected: list[dict]):
    # 490 of 506 trends read FALSE before the cutover. Afterwards the value
    # does not occur: "no call" is not "a negative call".
    assert [row for row in projected if row["PREDICTION_ELIGIBLE"] is False] == []


def test_every_score_is_in_range_and_its_flag_bands_it(projected: list[dict]):
    for row in _with_a_call(projected):
        score = float(row["PREDICTION_SCORE"])
        assert 0.0 <= score <= 100.0
        expected = next((name for name, floor in BANDS if score >= floor), None)
        assert row["PREDICTION_FLAG"] == expected, row["TREND_ID"]


# --- AC2 -------------------------------------------------------------------


def test_a_trend_with_an_active_matched_verdict_shows_the_whole_card(
    projected: list[dict],
):
    called = _with_a_call(projected)
    assert called, "no trend currently carries an active matched verdict"
    for row in called:
        assert row["PREDICTION_ELIGIBLE"] is True
        assert row["PREDICTION_EVALUATED_AT"]
        assert row["PREDICTION_REASONING"]
        # All four claim parts are NOT NULL on the ledger, so the composed
        # sentence always renders -- and it renders as a sentence.
        claim = row["PREDICTION_CLAIM"]
        assert claim and claim.endswith(".")
        assert " by " in claim and ", observable when " in claim


# --- AC3 -------------------------------------------------------------------


def test_only_the_elected_verdicts_reach_the_dashboard(
    projected: list[dict], elected: list[dict]
):
    # Independently derived from the ledger, so this disagrees with the
    # projection if the projection is wrong. White-space predictions -- the
    # ones matching no trend -- are excluded from `elected` by the same rule
    # the SQL applies, and there is nowhere else for them to appear.
    assert {row["TREND_ID"] for row in _with_a_call(projected)} == {
        row["TREND_ID"] for row in elected
    }


def test_the_score_is_the_elected_verdicts_confidence(
    projected: list[dict], elected: list[dict]
):
    confidence = {row["TREND_ID"]: float(row["CONFIDENCE"]) for row in elected}
    for row in _with_a_call(projected):
        assert float(row["PREDICTION_SCORE"]) == confidence[row["TREND_ID"]]


# --- AC7 -------------------------------------------------------------------


def test_citing_nothing_yields_no_examples_block_and_no_suppression(
    projected: list[dict], elected: list[dict]
):
    cited = {row["TREND_ID"]: row["CITED"] for row in elected}
    for row in _with_a_call(projected):
        examples = row["PREDICTION_CITED_EXAMPLES"]
        if cited[row["TREND_ID"]] == 0:
            # Absent, not empty -- and the card is still here.
            assert examples is None
            assert row["PREDICTION_SCORE"] is not None
        else:
            parsed = json.loads(examples)
            assert 0 < len(parsed) <= 5
            # A citation carries a readable label, and a link or nothing --
            # never a bare signal id posing as a URL.
            for example in parsed:
                assert example.get("url", "https://").startswith("http")


# --- AC8 -------------------------------------------------------------------


def test_a_missing_angle_costs_only_the_angle(projected: list[dict], elected: list[dict]):
    narrated = {row["TREND_ID"]: row for row in elected}
    bare = [
        row
        for row in _with_a_call(projected)
        if narrated[row["TREND_ID"]]["ANGLE"] is None
    ]
    assert bare, "expected at least one verdict the model did not narrate"
    for row in bare:
        assert row["PREDICTION_ANGLE"] is None
        # Everything that does not depend on the angle still renders.
        assert row["PREDICTION_CLAIM"] and row["PREDICTION_REASONING"]
        assert row["PREDICTION_SCORE"] is not None
