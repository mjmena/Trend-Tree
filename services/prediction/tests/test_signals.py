"""The generation phase's two warehouse reads (CRMA-763).

Pinned here rather than in test_blindness.py because these are questions
about *what the corpus is*, not about what generation may see. The sampling
one is a quality question with a measured answer: on 2026-08-21 the live
FCT_SIGNALS carried 6,644 rows across 11 sources in a 168-hour window, and
the newest 200 of them spanned 5.5 hours from 8 sources -- so `ORDER BY
SIGNAL_TIMESTAMP DESC LIMIT 200` showed the agent a thirtieth of one day and
called it a week.
"""

from __future__ import annotations

import pytest

from prediction_service.generation.blindness import BlindnessViolation
from prediction_service.generation.signals import (
    LIVE_SUBJECTS_QUERY,
    SIGNAL_QUERY,
    SIGNALS_TABLE,
    VERDICT_LEDGER_TABLE,
    SnowflakeLiveSubjectReader,
    SnowflakeSignalReader,
)

from .fakes import FakeSnowflake

QUALIFIED_SIGNALS = "MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS"
QUALIFIED_LEDGER = "MCC_PRESENTATION.TREND_AGENT.FCT_PREDICTION_VERDICT_LEDGER"


# --- the corpus is a sample of the window, not its most recent tail --------


def test_the_corpus_read_samples_across_sources_and_days():
    sql = SIGNAL_QUERY.upper()

    assert "PARTITION BY SOURCE_NAME, DATE_TRUNC('DAY', SIGNAL_TIMESTAMP)" in sql
    assert "ROW_NUMBER() OVER" in sql
    # The LIMIT is applied to the round-robin rank, so it takes one row per
    # source-day before any cell gets a second.
    assert "ORDER BY CELL_RANK ASC" in sql


def test_the_corpus_read_is_not_a_plain_newest_first_tail():
    # The regression this replaced: `ORDER BY SIGNAL_TIMESTAMP DESC LIMIT n`
    # over a 168h window never reaches past the busiest few hours, which
    # makes lookback_hours decorative and biases the slice toward whichever
    # source ingests most often.
    body = SIGNAL_QUERY.upper()
    tail = body[body.rindex("FROM STRATIFIED") :]

    assert "ORDER BY SIGNAL_TIMESTAMP DESC\nLIMIT" not in tail


def test_the_within_cell_pick_is_stable_rather_than_random():
    # HASH(SIGNAL_ID), not RANDOM(): a re-fire over an unchanged window shows
    # the model the same corpus, which is what makes chain_id idempotency
    # worth anything against a temperature-1.0 model.
    assert "ORDER BY HASH(SIGNAL_ID)" in SIGNAL_QUERY.upper()
    assert "RANDOM()" not in SIGNAL_QUERY.upper()


def test_the_lookback_window_and_the_limit_both_reach_the_warehouse():
    snowflake = FakeSnowflake(rows=[])
    reader = SnowflakeSignalReader(snowflake, QUALIFIED_SIGNALS)

    reader.recent_signals(lookback_hours=48, limit=25)

    assert snowflake.last.params == {"lookback_hours": 48, "signal_limit": 25}
    assert QUALIFIED_SIGNALS in snowflake.last.sql


def test_the_corpus_read_still_selects_no_vector():
    # 1024 floats per row, useless to a text prompt. Embedding-space work is
    # the matching phase's (CRMA-764).
    assert "SIGNAL_VECTOR" not in SIGNAL_QUERY.upper()


# --- parameter safety (review finding 16) ----------------------------------


def test_scope_bounds_are_coerced_to_ints_before_the_statement_is_built():
    # Load-bearing, not defensive. The connector's default pyformat binding
    # is CLIENT-side, so the statement that reaches Snowflake is the
    # post-substitution text -- which the guard would never see if it were
    # only handed the template. Ints are what make substitution incapable of
    # changing the statement's shape.
    snowflake = FakeSnowflake(rows=[])
    reader = SnowflakeSignalReader(snowflake, QUALIFIED_SIGNALS)

    reader.recent_signals(lookback_hours="48", limit="25")

    assert snowflake.last.params == {"lookback_hours": 48, "signal_limit": 25}


@pytest.mark.parametrize(
    ("hours", "limit"),
    [
        ("168; DROP TABLE FCT_SIGNALS", 200),
        (168, "200 UNION SELECT * FROM FCT_TRENDS"),
        (0, 200),
        (168, -1),
    ],
)
def test_a_bound_that_is_not_a_positive_int_never_reaches_the_client(hours, limit):
    snowflake = FakeSnowflake(rows=[])
    reader = SnowflakeSignalReader(snowflake, QUALIFIED_SIGNALS)

    with pytest.raises(ValueError):
        reader.recent_signals(lookback_hours=hours, limit=limit)

    assert snowflake.calls == []


def test_the_guard_sees_the_statement_as_the_connector_will_render_it():
    # Not just the template: the rendered text is what actually executes.
    rendered = SIGNAL_QUERY.format(table=QUALIFIED_SIGNALS) % {
        "lookback_hours": 168,
        "signal_limit": 200,
    }

    assert "%(lookback_hours)s" not in rendered
    assert "-168," in rendered.replace(" ", "")


def test_a_reader_pointed_at_the_ledger_is_refused_by_the_corpus_grant():
    snowflake = FakeSnowflake(rows=[])
    reader = SnowflakeSignalReader(snowflake, QUALIFIED_LEDGER)

    with pytest.raises(BlindnessViolation):
        reader.recent_signals(lookback_hours=24, limit=10)

    assert snowflake.calls == []


# --- the live-subject read -------------------------------------------------


def test_live_subjects_reads_the_latest_row_per_prediction():
    # The ledger is append-only with one row per evaluation, so an older
    # ACTIVE row under a since-WITHDRAWN prediction must not suppress a fresh
    # proposal.
    sql = LIVE_SUBJECTS_QUERY.upper()

    assert "PARTITION BY PREDICTION_ID ORDER BY EVALUATED_AT DESC" in sql
    assert "EVAL_RANK = 1" in sql
    assert "PREDICTION_STATUS = 'ACTIVE'" in sql
    # A prediction past its horizon is due to be graded, not to block a
    # re-proposal.
    assert "HORIZON_AT >= CURRENT_TIMESTAMP()" in sql


def test_live_subjects_returns_the_subject_strings():
    snowflake = FakeSnowflake(
        rows=[{"SUBJECT_DESCRIPTOR": "rucking vests"}, {"SUBJECT_DESCRIPTOR": "cottage cheese"}]
    )
    reader = SnowflakeLiveSubjectReader(snowflake, QUALIFIED_LEDGER)

    assert reader.live_subjects() == ["rucking vests", "cottage cheese"]
    assert snowflake.last.kind == "query"
    assert snowflake.last.params == {"subject_limit": 300}


def test_live_subjects_skips_null_rows_rather_than_stringifying_them():
    snowflake = FakeSnowflake(rows=[{"SUBJECT_DESCRIPTOR": None}, {"SUBJECT_DESCRIPTOR": "x"}])
    reader = SnowflakeLiveSubjectReader(snowflake, QUALIFIED_LEDGER)

    assert reader.live_subjects() == ["x"]


def test_the_live_subject_reader_cannot_be_pointed_at_the_corpus():
    snowflake = FakeSnowflake(rows=[])
    reader = SnowflakeLiveSubjectReader(snowflake, QUALIFIED_SIGNALS)

    with pytest.raises(BlindnessViolation):
        reader.live_subjects()

    assert snowflake.calls == []


def test_the_two_reads_name_different_tables():
    assert SIGNALS_TABLE != VERDICT_LEDGER_TABLE
    assert SIGNALS_TABLE in SIGNAL_QUERY.format(table=SIGNALS_TABLE)
    assert VERDICT_LEDGER_TABLE in LIVE_SUBJECTS_QUERY.format(table=VERDICT_LEDGER_TABLE)
