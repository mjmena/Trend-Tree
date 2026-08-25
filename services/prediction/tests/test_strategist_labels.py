"""The calibration label tier's own shape (CRMA-768 AC4).

The tier's *isolation* is asserted in tests/test_strategist_isolation.py.
What is asserted here is that the labels themselves are worth keeping: the
prediction id and the timestamp are on every one, a standing decision does
not accumulate a row per day, a changed mind keeps both judgements, and the
pillar-side reading a later regression would be fit against is bound to the
right call.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from prediction_service.strategist import (
    SOURCE_INSIGHTS_POSTGRES,
    LabelWriteFailed,
    StaticStrategistDecisionReader,
    StrategistDecision,
    calibration_labels,
    label_id_for,
    label_params,
    read_decisions,
    write_calibration_labels,
)

FIRST = "814a38cb-3935-4ce2-b640-b3154bfa84f4"
SECOND = "b6a1f0d2-4c3e-4b7a-9f11-2d8c5e6a7b40"
WHEN = datetime(2026, 8, 22, 15, 4, tzinfo=UTC)
LATER = datetime(2026, 8, 23, 9, 0, tzinfo=UTC)
RECORDED = datetime(2026, 8, 24, 14, 0, tzinfo=UTC)
TABLE = "MCC_PRESENTATION.TREND_AGENT.FCT_PREDICTION_STRATEGIST_LABELS"


def _decision(prediction_id: str, action: str = "APPROVE", **overrides) -> StrategistDecision:
    overrides.setdefault("decided_at", WHEN)
    return StrategistDecision(prediction_id=prediction_id, decision=action, **overrides)


def _lookup(*decisions: StrategistDecision):
    return read_decisions(
        StaticStrategistDecisionReader(decisions=list(decisions)),
        [d.prediction_id for d in decisions],
    )


class _Recorder:
    def __init__(self, rowcount: int = 1, fail_with: Exception | None = None) -> None:
        self.rowcount = rowcount
        self.fail_with = fail_with
        self.calls: list[tuple[str, dict]] = []

    def execute(self, sql: str, params: dict) -> int:
        self.calls.append((sql, params))
        if self.fail_with:
            raise self.fail_with
        return self.rowcount


# --- the label's identity -------------------------------------------------


def test_the_same_decision_always_derives_the_same_label_id():
    # What makes the daily sweep's re-read a MERGE no-op rather than a row
    # per day.
    assert label_id_for(_decision(FIRST)) == label_id_for(_decision(FIRST))


def test_a_changed_mind_derives_a_different_label():
    approve = _decision(FIRST, "APPROVE")
    dismiss = _decision(FIRST, "DISMISS", decided_at=LATER)

    assert label_id_for(approve) != label_id_for(dismiss)


def test_the_same_action_on_two_predictions_derives_two_labels():
    assert label_id_for(_decision(FIRST)) != label_id_for(_decision(SECOND))


# --- what a label carries -------------------------------------------------


def test_every_label_carries_the_prediction_id_and_the_timestamp():
    labels = calibration_labels(
        _lookup(_decision(FIRST, "DISMISS", decided_by="jsmith@mcclatchy.com")),
        recorded_at=RECORDED,
    )

    assert len(labels) == 1
    assert labels[0].prediction_id == FIRST
    assert labels[0].decided_at == WHEN
    assert labels[0].recorded_at == RECORDED
    assert labels[0].decision == "DISMISS"
    assert labels[0].decision_source == SOURCE_INSIGHTS_POSTGRES


def test_the_pillars_own_reading_is_bound_to_the_call_it_belongs_to():
    # Keyed, not positional: a label carrying a neighbouring call's
    # confidence is a silently poisoned training row.
    labels = calibration_labels(
        _lookup(_decision(FIRST), _decision(SECOND, "DISMISS")),
        verdicts={FIRST: (74.0, "ACTIVE"), SECOND: (66.0, "WITHDRAWN")},
        recorded_at=RECORDED,
    )
    by_id = {label.prediction_id: label for label in labels}

    assert (by_id[FIRST].verdict_confidence, by_id[FIRST].verdict_status) == (74.0, "ACTIVE")
    assert (by_id[SECOND].verdict_confidence, by_id[SECOND].verdict_status) == (
        66.0,
        "WITHDRAWN",
    )


def test_a_prediction_with_no_verdict_this_run_records_no_pillar_reading():
    labels = calibration_labels(_lookup(_decision(FIRST)), verdicts={}, recorded_at=RECORDED)

    assert labels[0].verdict_confidence is None
    assert labels[0].verdict_status is None


def test_no_decisions_means_no_labels():
    assert calibration_labels(_lookup(), recorded_at=RECORDED) == []


def test_the_bound_parameters_cover_every_column_the_merge_names():
    params = label_params(calibration_labels(_lookup(_decision(FIRST)), recorded_at=RECORDED)[0])

    assert set(params) == {
        "label_id",
        "prediction_id",
        "decision",
        "decided_at",
        "decided_by",
        "observed_confidence",
        "observed_flag",
        "verdict_confidence",
        "verdict_status",
        "decision_source",
        "recorded_at",
        "chain_id",
        "label_version",
    }


# --- the write ------------------------------------------------------------


def test_a_merge_that_matched_is_a_re_read_not_a_failure():
    client = _Recorder(rowcount=0)
    labels = calibration_labels(_lookup(_decision(FIRST)), recorded_at=RECORDED)

    assert write_calibration_labels(client, TABLE, labels) == set()
    assert len(client.calls) == 1


def test_a_failed_write_says_how_far_the_batch_got():
    client = _Recorder(fail_with=RuntimeError("permission denied"))
    labels = calibration_labels(
        _lookup(_decision(FIRST), _decision(SECOND)), recorded_at=RECORDED
    )

    with pytest.raises(LabelWriteFailed) as err:
        write_calibration_labels(client, TABLE, labels)

    assert err.value.written == 0
    assert err.value.total == 2
