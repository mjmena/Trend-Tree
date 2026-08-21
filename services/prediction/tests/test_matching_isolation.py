"""The matching phase's isolation invariant (CRMA-764).

Matching is *allowed* to read trend, heat and lifecycle state -- that is the
compare step. What it must never do is write, and what it must never reach is
an object nobody granted it. Three things get assertions:

1. **The statements a real match run issues.** Every one of them, from a run
   through the real route, checked against the grant.
2. **The guard is not vacuous.** It rejects a write, an ungranted object and
   a second statement riding behind a semicolon.
3. **The generation guard is untouched.** Matching reads FCT_TRENDS; if that
   had been bought by loosening ``assert_generation_sql``, generation would
   have quietly gained the same reach.
"""

from __future__ import annotations

import pytest

from prediction_service.generation.blindness import (
    DEFAULT_ALLOWED_TABLES,
    FORBIDDEN_TABLE_TOKENS,
    BlindnessViolation,
    assert_generation_sql,
)
from prediction_service.matching.isolation import (
    MatchingIsolationViolation,
    assert_matching_sql,
    positive_int,
)
from prediction_service.matching.predictions import (
    OPEN_PREDICTIONS_QUERY,
    VERDICT_LEDGER_TABLE,
    SnowflakeOpenPredictionReader,
)
from prediction_service.matching.trends import (
    DESCRIPTOR_INDEX_QUERY,
    ENRICHMENT_LEDGER_TABLE,
    LIFECYCLE_LEDGER_TABLE,
    SIGNALS_TABLE,
    TREND_CANDIDATE_QUERY,
    TREND_CONTEXT_QUERY,
    TREND_SIGNALS_TABLE,
    TRENDS_TABLE,
    SnowflakeTrendReader,
)

from .fakes import FakeSnowflake

QUALIFIED = "MCC_PRESENTATION.TREND_AGENT."

TREND_GRANT = (TRENDS_TABLE, ENRICHMENT_LEDGER_TABLE)
CONTEXT_GRANT = (TRENDS_TABLE, LIFECYCLE_LEDGER_TABLE, TREND_SIGNALS_TABLE, SIGNALS_TABLE)


# --- 1. the phase's own statements ----------------------------------------


def test_every_matching_statement_clears_its_own_grant():
    assert_matching_sql(
        DESCRIPTOR_INDEX_QUERY.format(
            trends=QUALIFIED + TRENDS_TABLE, enrichment=QUALIFIED + ENRICHMENT_LEDGER_TABLE
        ),
        allowed_tables=TREND_GRANT,
    )
    assert_matching_sql(
        TREND_CANDIDATE_QUERY.format(
            trends=QUALIFIED + TRENDS_TABLE, enrichment=QUALIFIED + ENRICHMENT_LEDGER_TABLE
        ),
        allowed_tables=TREND_GRANT,
    )
    assert_matching_sql(
        TREND_CONTEXT_QUERY.format(
            trends=QUALIFIED + TRENDS_TABLE,
            lifecycle=QUALIFIED + LIFECYCLE_LEDGER_TABLE,
            trend_signals=QUALIFIED + TREND_SIGNALS_TABLE,
            signals=QUALIFIED + SIGNALS_TABLE,
        ),
        allowed_tables=CONTEXT_GRANT,
    )
    assert_matching_sql(
        OPEN_PREDICTIONS_QUERY.format(table=QUALIFIED + VERDICT_LEDGER_TABLE),
        allowed_tables=(VERDICT_LEDGER_TABLE,),
    )


def test_each_grant_is_narrow_enough_to_reject_the_others_statements():
    # A grant that admitted every matching statement would prove nothing.
    with pytest.raises(MatchingIsolationViolation):
        assert_matching_sql(
            TREND_CONTEXT_QUERY.format(
                trends=QUALIFIED + TRENDS_TABLE,
                lifecycle=QUALIFIED + LIFECYCLE_LEDGER_TABLE,
                trend_signals=QUALIFIED + TREND_SIGNALS_TABLE,
                signals=QUALIFIED + SIGNALS_TABLE,
            ),
            allowed_tables=TREND_GRANT,
        )
    with pytest.raises(MatchingIsolationViolation):
        assert_matching_sql(
            OPEN_PREDICTIONS_QUERY.format(table=QUALIFIED + VERDICT_LEDGER_TABLE),
            allowed_tables=TREND_GRANT,
        )


def test_a_trend_reader_pointed_at_an_ungranted_object_raises_before_the_client():
    snowflake = FakeSnowflake()
    reader = SnowflakeTrendReader(snowflake, trends=QUALIFIED + "STG_EXTERNAL_SIGNALS")

    with pytest.raises(MatchingIsolationViolation):
        reader.descriptor_index()

    assert snowflake.calls == []


def test_a_prediction_reader_pointed_elsewhere_raises_before_the_client():
    snowflake = FakeSnowflake()
    reader = SnowflakeOpenPredictionReader(snowflake, QUALIFIED + "FCT_TRENDS")

    with pytest.raises(MatchingIsolationViolation):
        reader.open_predictions(limit=5)

    assert snowflake.calls == []


# --- 2. the guard is not vacuous ------------------------------------------


@pytest.mark.parametrize(
    "sql",
    [
        # Evidence purity (CONTEXT.md): nothing prediction-derived may reach
        # the signal corpus, and the way to guarantee that from this package
        # is that this package cannot write at all.
        "INSERT INTO MCC_PRESENTATION.TREND_AGENT.FCT_SIGNALS (SIGNAL_ID) VALUES ('x')",
        "UPDATE MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS SET TREND_TOPIC = 'x'",
        "MERGE INTO MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS AS t USING (SELECT 1) AS i ON 1=1",
        "DELETE FROM MCC_PRESENTATION.TREND_AGENT.FCT_TREND_SIGNALS",
        "CREATE TABLE X AS SELECT 1",
    ],
)
def test_the_matching_guard_rejects_any_write(sql):
    with pytest.raises(MatchingIsolationViolation, match="reads only"):
        assert_matching_sql(sql, allowed_tables=CONTEXT_GRANT)


def test_the_matching_guard_rejects_an_object_outside_the_grant():
    with pytest.raises(MatchingIsolationViolation, match="granted at the call site"):
        assert_matching_sql(
            "SELECT * FROM MCC_PRESENTATION.TREND_AGENT.STG_TREND_CANDIDATES",
            allowed_tables=TREND_GRANT,
        )


def test_a_second_statement_cannot_ride_along_behind_a_semicolon():
    with pytest.raises(MatchingIsolationViolation, match="one statement at a time"):
        assert_matching_sql(
            "SELECT TREND_ID FROM FCT_TRENDS; DELETE FROM FCT_TRENDS",
            allowed_tables=(TRENDS_TABLE,),
        )


def test_a_trailing_semicolon_is_not_a_second_statement():
    assert_matching_sql("SELECT TREND_ID FROM FCT_TRENDS;", allowed_tables=(TRENDS_TABLE,))


def test_a_comment_naming_another_object_is_not_a_read_of_it():
    assert_matching_sql(
        "-- deliberately does not touch STG_TREND_CANDIDATES\n"
        "SELECT TREND_ID FROM MCC_PRESENTATION.TREND_AGENT.FCT_TRENDS",
        allowed_tables=(TRENDS_TABLE,),
    )


def test_scope_bounds_are_coerced_before_they_reach_a_statement():
    assert positive_int("limit", "25") == 25
    with pytest.raises(ValueError, match="at least 1"):
        positive_int("limit", 0)
    with pytest.raises(ValueError):
        positive_int("limit", "; DROP TABLE X")


# --- 3. the generation guard is untouched ---------------------------------


def test_matchings_reach_was_not_bought_by_loosening_the_generation_grant():
    # The regression that would matter most: someone makes matching work by
    # widening assert_generation_sql, and generation silently gains the same
    # reach. The generation grant is still the signal corpus alone, and the
    # denylist still names every trend-shaped object matching reads.
    assert DEFAULT_ALLOWED_TABLES == ("FCT_SIGNALS",)
    for token in ("FCT_TRENDS", "FCT_TREND_", "HEAT_INDEX", "LIFECYCLE_STATUS"):
        assert token in FORBIDDEN_TABLE_TOKENS

    for sql in (
        DESCRIPTOR_INDEX_QUERY.format(
            trends=QUALIFIED + TRENDS_TABLE, enrichment=QUALIFIED + ENRICHMENT_LEDGER_TABLE
        ),
        TREND_CANDIDATE_QUERY.format(
            trends=QUALIFIED + TRENDS_TABLE, enrichment=QUALIFIED + ENRICHMENT_LEDGER_TABLE
        ),
        TREND_CONTEXT_QUERY.format(
            trends=QUALIFIED + TRENDS_TABLE,
            lifecycle=QUALIFIED + LIFECYCLE_LEDGER_TABLE,
            trend_signals=QUALIFIED + TREND_SIGNALS_TABLE,
            signals=QUALIFIED + SIGNALS_TABLE,
        ),
    ):
        with pytest.raises(BlindnessViolation):
            assert_generation_sql(sql, allowed_tables=(TRENDS_TABLE, ENRICHMENT_LEDGER_TABLE))
