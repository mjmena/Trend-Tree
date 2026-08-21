"""The re-evaluation pass (CRMA-766).

What one sweep does to a live prediction, and -- as much as anything -- what
it refuses to do when a dependency is missing. The recurring assertion is
that a missing model degrades the *narrative*, never the lifecycle: EXPIRED
needs a clock, not a model, and nothing must be able to resolve a call by
accident.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from prediction_service.matching.predictions import (
    LIVE_STATUSES,
    StaticOpenPredictionReader,
)
from prediction_service.matching.trends import TrendCandidate, TrendContext
from prediction_service.sweep import (
    OBSERVED_MET,
    SweepScope,
    eval_id_for,
    sweep_predictions,
)

from .matching_fakes import (
    CANDIDATE_ROWS,
    CONTEXT_ROW,
    DESCRIPTOR_ROWS,
    TREND_ID,
    RecordingTrendReader,
    open_prediction_row,
)
from .sweep_fakes import SweepLLM, reevaluation_reply

HORIZON = datetime(2027, 2, 14, tzinfo=UTC)
NOW = HORIZON - timedelta(days=60)


def trends() -> RecordingTrendReader:
    return RecordingTrendReader(
        descriptors=[TrendCandidate.from_row(row) for row in DESCRIPTOR_ROWS],
        candidates={
            subject: [TrendCandidate.from_row(row) for row in rows]
            for subject, rows in CANDIDATE_ROWS.items()
        },
        contexts={TREND_ID: TrendContext.from_row(CONTEXT_ROW)},
    )


def sweep(rows, *, llm=None, now=NOW, scope=None, saturation=None):
    return sweep_predictions(
        predictions=StaticOpenPredictionReader(rows, statuses=LIVE_STATUSES),
        trends=trends(),
        llm=llm,
        saturation=saturation,
        scope=scope or SweepScope(),
        now=now,
    )


ANSWER = {
    "id": 1,
    "subject": "rucking vests",
    "observable_check": "not_yet",
    "observation": "no house-label listing yet",
    "confidence": 74.0,
    "reasoning": "restated for this evaluation",
    "what_changed": "two more independent sources landed",
}


# --- the row it appends ----------------------------------------------------


def test_a_re_evaluation_appends_a_row_carrying_the_prediction_id_forward():
    row = open_prediction_row()
    result = sweep([row], llm=SweepLLM(reevaluation_reply=reevaluation_reply(ANSWER)))

    (outcome,) = result.outcomes
    assert outcome.verdict.prediction_id == row["PREDICTION_ID"]
    # A NEW row identity, derived from the chain so a re-fire MERGEs.
    assert outcome.verdict.prediction_eval_id == eval_id_for(
        result.chain_id, row["PREDICTION_ID"]
    )
    assert outcome.verdict.prediction_eval_id != row["PREDICTION_EVAL_ID"]


def test_the_row_carries_the_models_confidence_verbatim():
    result = sweep(
        [open_prediction_row(confidence=68.0)],
        llm=SweepLLM(reevaluation_reply=reevaluation_reply(ANSWER)),
    )
    (outcome,) = result.outcomes
    assert outcome.verdict.confidence == 74.0
    assert outcome.confidence_direction == "strengthened"
    assert outcome.confidence_delta == 6.0


def test_what_changed_names_the_movement():
    result = sweep(
        [open_prediction_row(confidence=68.0)],
        llm=SweepLLM(reevaluation_reply=reevaluation_reply(ANSWER)),
    )
    note = result.outcomes[0].verdict.what_changed
    assert "68.0" in note and "74.0" in note
    assert "two more independent sources landed" in note


def test_the_match_is_re_checked_and_lands_in_the_row():
    result = sweep(
        [open_prediction_row()], llm=SweepLLM(reevaluation_reply=reevaluation_reply(ANSWER))
    )
    (outcome,) = result.outcomes
    assert outcome.verdict.matched_trend_id == TREND_ID
    assert outcome.verdict.evidence["trend_context"]["trend_id"] == TREND_ID
    assert outcome.verdict.evidence["match"]["matched_trend_id"] == TREND_ID
    assert outcome.verdict.evidence["match"]["phase"] == "match"


def test_the_prior_evidence_is_carried_forward_not_replaced():
    row = open_prediction_row(
        evidence={
            "source_signals": ["bluesky:abc"],
            "saturation": {"query": "rucking vests", "exploding_topics": {"matched": True}},
            "trend_context": None,
            "coverage": {"detections": []},
        }
    )
    result = sweep([row], llm=SweepLLM(reevaluation_reply=reevaluation_reply(ANSWER)))
    evidence = result.outcomes[0].verdict.evidence
    # The audit trail generation wrote...
    assert evidence["source_signals"] == ["bluesky:abc"]
    # ...and the keys other phases own, untouched with no saturation phase
    # wired.
    assert evidence["saturation"]["exploding_topics"]["matched"] is True
    assert evidence["coverage"] == {"detections": []}


def test_the_evidence_records_how_this_evaluation_was_reached():
    result = sweep(
        [open_prediction_row()], llm=SweepLLM(reevaluation_reply=reevaluation_reply(ANSWER))
    )
    block = result.outcomes[0].verdict.evidence["reevaluation"]
    assert block["reevaluated"] is True
    assert block["prior_confidence"] == 68.0
    assert block["prior_status"] == "ACTIVE"
    assert block["observable_check"] == "not_yet"
    assert block["final_evaluation"] is False
    assert block["grace_ends_at"] == (HORIZON + timedelta(days=180)).isoformat()
    assert block["confidence_direction_is_derived_not_stored"] is True


# --- degradation -----------------------------------------------------------


def test_no_model_keeps_the_prior_numbers_and_still_writes_a_row():
    result = sweep([open_prediction_row(confidence=68.0)], llm=None)
    (outcome,) = result.outcomes
    assert outcome.verdict.confidence == 68.0
    assert outcome.verdict.status == "ACTIVE"
    assert outcome.reevaluated is False
    assert outcome.verdict.evidence["reevaluation"]["reevaluated"] is False


def test_no_model_still_expires_a_prediction_past_its_horizon():
    # The lifecycle is a clock, not a model. This is the property that keeps
    # a Gemini outage from freezing the pillar's status machine.
    result = sweep(
        [open_prediction_row()], llm=None, now=HORIZON + timedelta(days=1)
    )
    assert result.outcomes[0].verdict.status == "EXPIRED"


def test_a_failed_model_call_resolves_nothing():
    result = sweep(
        [open_prediction_row()],
        llm=SweepLLM(fail_reevaluation_with=RuntimeError("gemini is down")),
    )
    (outcome,) = result.outcomes
    assert outcome.verdict.status == "ACTIVE"
    assert outcome.observation.outcome == "not_yet"
    assert "failed" in outcome.verdict.evidence["reevaluation"]["note"]


def test_an_answer_bound_to_the_wrong_subject_is_discarded():
    # The dangerous shape: a re-sorted, renumbered reply would otherwise
    # close the wrong prediction permanently.
    wrong = {**ANSWER, "subject": "probiotic nasal spray", "observable_check": "met"}
    result = sweep(
        [open_prediction_row()], llm=SweepLLM(reevaluation_reply=reevaluation_reply(wrong))
    )
    (outcome,) = result.outcomes
    assert outcome.verdict.status == "ACTIVE"
    assert outcome.verdict.confidence == 68.0
    assert outcome.reevaluated is False


def test_a_context_read_failure_still_writes_the_row():
    class Exploding(RecordingTrendReader):
        def context_for(self, trend_id: str):
            raise RuntimeError("warehouse timeout")

    result = sweep_predictions(
        predictions=StaticOpenPredictionReader(
            [open_prediction_row()], statuses=LIVE_STATUSES
        ),
        trends=Exploding(
            descriptors=[TrendCandidate.from_row(row) for row in DESCRIPTOR_ROWS],
            candidates={
                subject: [TrendCandidate.from_row(row) for row in rows]
                for subject, rows in CANDIDATE_ROWS.items()
            },
        ),
        llm=SweepLLM(reevaluation_reply=reevaluation_reply(ANSWER)),
        now=NOW,
    )
    (outcome,) = result.outcomes
    assert outcome.verdict.matched_trend_id == TREND_ID
    assert outcome.verdict.evidence["trend_context"] is None
    assert "trend context unavailable" in (outcome.note or "")


# --- selection -------------------------------------------------------------


def test_a_prediction_past_its_grace_window_is_skipped_with_a_reason():
    row = open_prediction_row(status="EXPIRED")
    result = sweep([row], llm=None, now=HORIZON + timedelta(days=180))
    assert result.outcomes == []
    (skipped,) = result.skipped
    assert skipped.prediction_id == row["PREDICTION_ID"]
    assert "grace window closed" in skipped.reason
    assert "final" in skipped.reason


def test_an_expired_prediction_inside_its_grace_window_is_still_swept():
    row = open_prediction_row(status="EXPIRED")
    answer = {**ANSWER, "observable_check": "met", "observation": "both retailers list it"}
    result = sweep(
        [row],
        llm=SweepLLM(reevaluation_reply=reevaluation_reply(answer)),
        now=HORIZON + timedelta(days=90),
    )
    (outcome,) = result.outcomes
    assert outcome.observation.outcome == OBSERVED_MET
    assert outcome.verdict.status == "RESOLVED_TRUE"
    assert outcome.final is True


def test_capped_scope_re_evaluates_only_the_requested_predictions():
    keep = open_prediction_row(prediction_id="keep-me")
    other = open_prediction_row(
        prediction_id="leave-me", subject="probiotic nasal spray"
    )
    result = sweep(
        [keep, other], llm=None, scope=SweepScope(prediction_ids=("keep-me",))
    )
    assert [o.prediction_id for o in result.outcomes] == ["keep-me"]
    assert [s.prediction_id for s in result.skipped] == ["leave-me"]
    assert "capped-scope" in result.skipped[0].reason


def test_a_sweep_with_nothing_live_is_not_an_error():
    result = sweep([], llm=None)
    assert result.outcomes == []
    assert result.verdicts == []
    assert result.predictions_read == 0


def test_re_firing_the_same_chain_id_produces_the_same_row_identities():
    # What makes Cloud Scheduler's HTTP retry safe: the MERGE matches.
    row = open_prediction_row()
    first = sweep_predictions(
        predictions=StaticOpenPredictionReader([row], statuses=LIVE_STATUSES),
        trends=trends(),
        llm=None,
        chain_id="pred-sweep-chain-fixed",
        now=NOW,
    )
    second = sweep_predictions(
        predictions=StaticOpenPredictionReader([row], statuses=LIVE_STATUSES),
        trends=trends(),
        llm=None,
        chain_id="pred-sweep-chain-fixed",
        now=NOW,
    )
    assert (
        first.outcomes[0].verdict.prediction_eval_id
        == second.outcomes[0].verdict.prediction_eval_id
    )


def test_a_sweep_eval_id_can_never_collide_with_a_match_or_generation_one():
    from prediction_service.matching.run import eval_id_for as match_eval_id

    assert eval_id_for("chain", "pred") != match_eval_id("chain", "pred")


# --- the data-quality floor is a mint-time gate, not a sweep one -----------


def test_the_sweep_does_not_re_apply_the_data_quality_floor():
    # The floor decides whether a subject can be JUDGED AT ALL, at mint. Run
    # again over an already-live prediction it would become a rule that
    # silently stops re-evaluating a call the pillar already made -- a new
    # mechanical gate, which the strategy says needs a decision, not a commit.
    from prediction_service.saturation import DataQualityFloor, SaturationPhase

    phase = SaturationPhase.offline(
        # Thresholds nothing could clear.
        DataQualityFloor(min_observation_age_hours=10**6, min_evidence_chars=10**6)
    )
    result = sweep([open_prediction_row()], llm=None, saturation=phase)
    assert len(result.outcomes) == 1


def test_a_wired_saturation_phase_refreshes_the_evidence_key():
    from prediction_service.saturation import SaturationPhase

    phase = SaturationPhase.offline()
    result = sweep([open_prediction_row()], llm=None, saturation=phase)
    saturation = result.outcomes[0].verdict.evidence["saturation"]
    assert saturation["exploding_topics"]["matched"] is False
    assert saturation["exploding_topics"]["miss_carries_no_penalty"] is True
    # No floor block: the floor did not run, and evidence must not imply it did.
    assert "data_quality_floor" not in saturation


@pytest.mark.parametrize("status", ["RESOLVED_TRUE", "RESOLVED_FALSE", "WITHDRAWN"])
def test_a_settled_prediction_never_reaches_the_sweep(status):
    # Belt and braces: the reader filters by status, and if one slipped
    # through anyway the selection step would still leave it alone.
    result = sweep([open_prediction_row(status=status)], llm=None)
    assert result.outcomes == []
