"""The strategist decision read seam, and the identity binding (CRMA-768 AC5).

Insights Postgres ``prediction_decisions`` is not reachable from this service
today (docs/access-requests/insights-postgres-prediction-decisions.md), so
what is under test is the seam: a Protocol the sweep depends on, an offline
reader, and an explicitly-unavailable one -- the same shape the saturation
oracles and ``OpenPredictionReader`` already have.

**The binding is the part worth the most tests.** Three stories on this epic
shipped a batched read bound to its domain objects by position or by the
subject descriptor, and one of them permanently closed the wrong prediction.
A strategist Dismiss bound to the wrong call is that failure with a human's
name on it, so every case below asks the same question: can a decision reach
a prediction it was not about?
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from prediction_service.strategist import (
    SOURCE_INSIGHTS_POSTGRES,
    DecisionRead,
    StaticStrategistDecisionReader,
    StrategistDecision,
    UnavailableDecisionReader,
    read_decisions,
)

FIRST = "814a38cb-3935-4ce2-b640-b3154bfa84f4"
SECOND = "b6a1f0d2-4c3e-4b7a-9f11-2d8c5e6a7b40"
THIRD = "c0d3e4f5-1a2b-4c3d-8e9f-0a1b2c3d4e5f"

WHEN = datetime(2026, 8, 22, 15, 4, tzinfo=UTC)


def decision(prediction_id: str, action: str = "DISMISS", **overrides) -> StrategistDecision:
    overrides.setdefault("decided_at", WHEN)
    return StrategistDecision(prediction_id=prediction_id, decision=action, **overrides)


# --- binding by identity, never by position -------------------------------


def test_each_decision_lands_on_the_prediction_it_names():
    reader = StaticStrategistDecisionReader(
        decisions=[decision(SECOND, "DISMISS"), decision(FIRST, "APPROVE")]
    )

    lookup = read_decisions(reader, [FIRST, SECOND])

    # Returned in the opposite order to the request. Bound by id, so the
    # order the source happened to answer in changes nothing.
    assert lookup.for_prediction(FIRST).decision == "APPROVE"
    assert lookup.for_prediction(SECOND).decision == "DISMISS"


def test_two_live_calls_that_share_a_subject_get_their_own_decisions():
    # The subject descriptor is not unique. Nothing in the read uses it.
    reader = StaticStrategistDecisionReader(decisions=[decision(FIRST, "DISMISS")])

    lookup = read_decisions(reader, [FIRST, SECOND])

    assert lookup.for_prediction(FIRST).decision == "DISMISS"
    assert lookup.for_prediction(SECOND) is None


def test_a_decision_for_a_prediction_this_sweep_did_not_read_is_dropped():
    # Dropped, not reconciled onto a neighbour and not raised: a drop means
    # "these calls keep their prior standing", which is exactly right.
    reader = StaticStrategistDecisionReader(decisions=[decision(THIRD, "DISMISS")])
    # ignores the filter it was given
    reader.decisions_for = lambda ids: DecisionRead(decisions=[decision(THIRD, "DISMISS")])

    lookup = read_decisions(reader, [FIRST, SECOND])

    assert lookup.decisions == {}


def test_a_row_that_is_not_a_decision_is_dropped_rather_than_crashing_the_sweep():
    reader = StaticStrategistDecisionReader()
    reader.decisions_for = lambda ids: DecisionRead(
        decisions=[{"prediction_id": FIRST, "decision": "DISMISS"}]
    )

    lookup = read_decisions(reader, [FIRST])

    assert lookup.decisions == {}
    assert lookup.available is True


def test_the_reader_is_asked_only_about_the_predictions_in_scope():
    reader = StaticStrategistDecisionReader()

    read_decisions(reader, [FIRST, FIRST, SECOND])

    # De-duplicated, and nothing else added.
    assert reader.asked == [(FIRST, SECOND)]


# --- "until the next human touch" -----------------------------------------


def test_the_latest_decision_wins_so_an_approve_is_replaced_by_a_later_dismiss():
    reader = StaticStrategistDecisionReader(
        decisions=[
            decision(FIRST, "APPROVE", decided_at=WHEN),
            decision(FIRST, "DISMISS", decided_at=datetime(2026, 8, 23, 9, 0, tzinfo=UTC)),
        ]
    )

    assert read_decisions(reader, [FIRST]).for_prediction(FIRST).decision == "DISMISS"


def test_a_later_approve_lifts_an_earlier_dismiss_too():
    reader = StaticStrategistDecisionReader(
        decisions=[
            decision(FIRST, "DISMISS", decided_at=WHEN),
            decision(FIRST, "APPROVE", decided_at=datetime(2026, 8, 23, 9, 0, tzinfo=UTC)),
        ]
    )

    assert read_decisions(reader, [FIRST]).for_prediction(FIRST).decision == "APPROVE"


def test_two_decisions_at_the_same_instant_resolve_to_the_recoverable_one():
    # A tie must not depend on the order rows came back in -- that is
    # position-binding by the back door. It resolves to the APPROVE, because
    # a WITHDRAWN verdict is final and no later sweep can undo it, while a
    # wrong Approve is corrected by the next Dismiss that carries a later
    # timestamp.
    forward = StaticStrategistDecisionReader(
        decisions=[decision(FIRST, "APPROVE"), decision(FIRST, "DISMISS")]
    )
    backward = StaticStrategistDecisionReader(
        decisions=[decision(FIRST, "DISMISS"), decision(FIRST, "APPROVE")]
    )

    assert read_decisions(forward, [FIRST]).for_prediction(FIRST).decision == "APPROVE"
    assert read_decisions(backward, [FIRST]).for_prediction(FIRST).decision == "APPROVE"


# --- the source being unreachable is a fact, not a failure ----------------


def test_an_unprovisioned_source_reads_as_unavailable_not_as_no_decisions():
    lookup = read_decisions(UnavailableDecisionReader(), [FIRST])

    assert lookup.decisions == {}
    assert lookup.available is False
    assert "has not been provisioned" in lookup.unavailable_reason
    assert lookup.as_evidence()["source"] == SOURCE_INSIGHTS_POSTGRES


def test_no_reader_at_all_reads_as_unavailable():
    lookup = read_decisions(None, [FIRST])

    assert lookup.available is False
    assert lookup.decisions == {}


def test_a_read_that_raises_degrades_to_unavailable_and_withdraws_nothing():
    reader = StaticStrategistDecisionReader()

    def boom(ids):
        raise RuntimeError("connection refused")

    reader.decisions_for = boom

    lookup = read_decisions(reader, [FIRST])

    assert lookup.available is False
    assert "RuntimeError" in lookup.unavailable_reason
    assert lookup.for_prediction(FIRST) is None


def test_an_empty_read_from_a_reachable_source_is_available_and_empty():
    lookup = read_decisions(StaticStrategistDecisionReader(), [FIRST])

    assert lookup.available is True
    assert lookup.unavailable_reason is None


# --- the decision's own shape ---------------------------------------------


def test_a_decision_must_name_a_prediction():
    with pytest.raises(ValueError, match="must name the prediction"):
        StrategistDecision(prediction_id="  ", decision="APPROVE", decided_at=WHEN)


def test_the_evidence_form_carries_the_prediction_id_and_the_timestamp():
    # AC4: retained "with the prediction id and timestamp".
    payload = decision(FIRST, "APPROVE", decided_by="jsmith@mcclatchy.com").as_evidence()

    assert payload["prediction_id"] == FIRST
    assert payload["decided_at"] == WHEN.isoformat()
    assert payload["decided_by"] == "jsmith@mcclatchy.com"
    assert payload["source"] == SOURCE_INSIGHTS_POSTGRES
