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
    "prediction_id": "814a38cb-3935-4ce2-b640-b3154bfa84f4",
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


def test_the_grace_window_closing_writes_one_final_row_then_freezes():
    # The integrated path, not the pure function: a daily cron leaves a
    # prediction already EXPIRED when its window closes, so this is the ONLY
    # way a row ever carries final_evaluation: true.
    row = open_prediction_row(status="EXPIRED")
    closes = HORIZON + timedelta(days=180)
    result = sweep([row], llm=None, now=closes)

    (outcome,) = result.outcomes
    assert result.skipped == []
    assert outcome.verdict.status == "EXPIRED"
    assert outcome.final is True
    assert outcome.verdict.evidence["reevaluation"]["final_evaluation"] is True
    # The row's last word does not promise a re-check nobody will run.
    assert "final evaluation" in outcome.verdict.what_changed

    # Feed that row back in the way the next day's sweep would read it.
    import json

    closed = open_prediction_row(status="EXPIRED", evidence=outcome.verdict.evidence)
    closed["EVIDENCE"] = json.dumps(outcome.verdict.evidence)
    after = sweep([closed], llm=None, now=closes + timedelta(days=1))
    assert after.outcomes == []
    (skipped,) = after.skipped
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
    # The filter is in the read now, so the rest of the world is not merely
    # left alone -- it is never looked at, and a capped-scope run says
    # nothing about predictions it was not asked about.
    assert result.skipped == []
    assert result.predictions_read == 1


def test_a_requested_prediction_that_was_never_found_is_reported_not_silent():
    # "reevaluated: 0" with the target absent from `skipped` too is
    # indistinguishable from "we looked and it was fine".
    result = sweep(
        [open_prediction_row(prediction_id="keep-me")],
        llm=None,
        scope=SweepScope(prediction_ids=("keep-me", "ghost")),
    )
    assert [o.prediction_id for o in result.outcomes] == ["keep-me"]
    (skipped,) = result.skipped
    assert skipped.prediction_id == "ghost"
    assert "no live row was found" in skipped.reason


def test_one_unreadable_ledger_row_does_not_lose_the_whole_sweep():
    # A row this service did not write -- PREDICTION_EVAL_ID keeps its DDL
    # DEFAULT UUID_STRING() for ad-hoc inserts, and NOT NULL excludes neither
    # a control character nor whitespace. Built in an unguarded comprehension
    # this raised InvalidClaim and the daily sweep wrote nothing for ANY
    # prediction.
    bad = open_prediction_row(
        prediction_id="broken", subject="rucking\x01vests"
    )
    good = open_prediction_row(prediction_id="fine")
    result = sweep([bad, good], llm=None)

    assert [o.prediction_id for o in result.outcomes] == ["fine"]
    (skipped,) = result.skipped
    assert skipped.prediction_id == "broken"
    assert "could not be read" in skipped.reason
    # ...and the thing that made it unreadable is not echoed back verbatim.
    assert "\x01" not in skipped.subject_descriptor
    assert "\x01" not in skipped.reason


def test_a_sweep_with_nothing_live_is_not_an_error():
    result = sweep([], llm=None)
    assert result.outcomes == []
    assert result.verdicts == []
    assert result.predictions_read == 0
    # A pass that made no model call cost nothing. Reporting that as unknown
    # makes the route's total null for a run that goes on to mint at real cost.
    assert result.cost_usd == 0.0


def test_a_sweep_that_made_no_model_call_costs_zero_not_unknown():
    assert sweep([open_prediction_row()], llm=None).cost_usd == 0.0
    failed = sweep(
        [open_prediction_row()],
        llm=SweepLLM(fail_reevaluation_with=RuntimeError("gemini is down")),
    )
    assert failed.cost_usd == 0.0


def test_a_mis_bound_answer_is_reported_at_the_outcome_not_only_in_the_evidence():
    # "reevaluated: false, note: null" tells an operator nothing about which
    # of the two it was.
    wrong = {**ANSWER, "prediction_id": "some-other-prediction"}
    result = sweep(
        [open_prediction_row()], llm=SweepLLM(reevaluation_reply=reevaluation_reply(wrong))
    )
    (outcome,) = result.outcomes
    assert outcome.reevaluated is False
    assert outcome.note and "no usable answer" in outcome.note


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


def test_a_saturation_miss_never_overwrites_a_real_prior_reading():
    # An ET outage, or a lookup budget spent before this subject's turn, comes
    # back as a miss. The LATEST row is what CRMA-769 projects, so writing the
    # miss over a real reading would make the pillar say it knows less about a
    # subject than it does. A miss is not evidence; it carries no penalty
    # precisely because nobody looked.
    from prediction_service.saturation import SaturationPhase

    prior = {
        "source_signals": ["bluesky:abc"],
        "saturation": {
            "query": "rucking vests",
            "exploding_topics": {"matched": True, "classification": "regular"},
            "gdelt": {"available": True, "article_count": 31},
        },
        "trend_context": None,
        "coverage": None,
    }
    result = sweep(
        [open_prediction_row(evidence=prior)], llm=None, saturation=SaturationPhase.offline()
    )
    (outcome,) = result.outcomes
    saturation = outcome.verdict.evidence["saturation"]
    assert saturation["exploding_topics"]["matched"] is True
    assert saturation["gdelt"]["article_count"] == 31
    # ...and the row says the reading was not refreshed, rather than implying
    # it was.
    assert "not re-read" in outcome.verdict.evidence["reevaluation"]["saturation_note"]
    assert "not re-read" in (outcome.note or "")


def test_a_wired_saturation_phase_refreshes_the_evidence_key():
    from prediction_service.saturation import SaturationPhase

    # The prior row carries no reading at all, so an explicit miss is the
    # most this evaluation knows -- and recording it is better than a null.
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
