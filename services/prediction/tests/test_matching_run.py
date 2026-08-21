"""The matching phase's own seams (CRMA-764): what a verdict carries forward,
what identity a re-fire lands on, and what the phase can reach.
"""

from __future__ import annotations

import inspect
import json
from datetime import UTC, datetime

import pytest

from prediction_service.domain.claim import REQUIRED_EVIDENCE_KEYS
from prediction_service.matching import run as matching_run
from prediction_service.matching.decide import decide_match
from prediction_service.matching.predictions import (
    OpenPrediction,
    StaticOpenPredictionReader,
)
from prediction_service.matching.run import (
    MatchScope,
    build_evidence,
    eval_id_for,
    match_open_predictions,
    new_chain_id,
)
from prediction_service.matching.trends import (
    FixtureTrendReader,
    TrendCandidate,
    TrendContext,
)

from .fakes import FakePredictionLLM
from .matching_fakes import TREND_ID, open_prediction_row
from .test_match_route import NARRATIVE


def _trends() -> FixtureTrendReader:
    return FixtureTrendReader(
        [
            {
                "TREND_ID": TREND_ID,
                "TREND_TOPIC": "Rucking as everyday exercise",
                "DESCRIPTOR_QUERY": "rucking vest",
                "SIMILARITIES": {"rucking vests": 0.74},
            }
        ],
        contexts={
            TREND_ID: {
                "TREND_ID": TREND_ID,
                "HEAT_INDEX": 46.0,
                "ACCELERATION": 3.0,
                "AGE_DAYS": 31,
            }
        },
    )


def _run(rows, **kwargs):
    return match_open_predictions(
        predictions=StaticOpenPredictionReader(rows),
        trends=_trends(),
        llm=FakePredictionLLM(reply=NARRATIVE),
        **kwargs,
    )


def test_match_open_predictions_takes_no_warehouse_client():
    # The structural half of the phase's shape, the same discipline
    # generation keeps: readers in, verdicts out. The write capability is
    # never inside this call graph.
    params = inspect.signature(match_open_predictions).parameters
    assert set(params) == {
        "predictions",
        "trends",
        "llm",
        "scope",
        "chain_id",
        "evaluated_at",
    }
    assert "snowflake" not in params
    assert "client" not in params
    assert "settings" not in params


def test_the_only_sql_constants_in_the_matching_package_are_its_three_reads():
    # A second module growing SQL is the review signal that the phase gained
    # a new reach. isolation.py is excluded: it is the guard, so it is the
    # one file allowed to spell out what a read looks like.
    package = __import__("pathlib").Path(matching_run.__file__).parent
    with_sql = sorted(
        path.name
        for path in package.glob("*.py")
        if "SELECT" in path.read_text().upper() and path.name != "isolation.py"
    )
    assert with_sql == ["predictions.py", "trends.py"]


def test_the_evidence_the_phase_does_not_own_is_carried_forward_untouched():
    # The seam with the saturation/coverage work: this phase sets
    # trend_context and nothing else in the payload.
    prior = {
        "source_signals": ["bluesky:1", "gdelt:2"],
        "saturation": {"exploding_topics": "regular", "gdelt_articles": 44},
        "trend_context": None,
        "coverage": {"stories": 3},
        "generation": {"phase": "generate", "model": "gemini-3.7-flash"},
    }
    decision = decide_match(
        "rucking vests",
        descriptor_index=[TrendCandidate(trend_id=TREND_ID, descriptor_query="rucking vest")],
        candidates=[TrendCandidate(trend_id=TREND_ID, similarity=0.74)],
    )

    evidence = build_evidence(
        prior, decision=decision, context=TrendContext(trend_id=TREND_ID, heat_index=46.0)
    )

    assert evidence["source_signals"] == ["bluesky:1", "gdelt:2"]
    assert evidence["saturation"] == {"exploding_topics": "regular", "gdelt_articles": 44}
    assert evidence["coverage"] == {"stories": 3}
    assert evidence["generation"]["model"] == "gemini-3.7-flash"
    assert evidence["trend_context"]["heat_index"] == 46.0
    # ...and the prior dict is not mutated under its owner.
    assert prior["trend_context"] is None


def test_a_prior_row_with_a_broken_evidence_payload_still_gets_the_contract():
    prediction = OpenPrediction.from_row(
        {**open_prediction_row(), "EVIDENCE": "not json at all"}
    )

    assert prediction.evidence == {}

    result = _run([{**open_prediction_row(), "EVIDENCE": "not json at all"}])

    evidence = result.verdicts[0].evidence
    assert all(key in evidence for key in REQUIRED_EVIDENCE_KEYS)
    assert evidence["source_signals"] is None


def test_the_eval_id_is_one_row_per_prediction_per_chain():
    assert eval_id_for("chain-a", "pred-1") == eval_id_for("chain-a", "pred-1")
    assert eval_id_for("chain-a", "pred-1") != eval_id_for("chain-b", "pred-1")
    assert eval_id_for("chain-a", "pred-1") != eval_id_for("chain-a", "pred-2")


def test_a_match_chain_id_is_distinguishable_from_a_generation_one():
    assert new_chain_id().startswith("pred-match-chain-")
    assert len(new_chain_id()) <= 64


def test_the_evaluation_timestamp_is_injectable_and_does_not_move_the_horizon():
    result = _run([open_prediction_row()], evaluated_at=datetime(2026, 9, 1, tzinfo=UTC))

    verdict = result.verdicts[0]
    assert verdict.minted_at == datetime(2026, 9, 1, tzinfo=UTC)
    # emerging_3_6mo is 180 days; deriving from minted_at would have produced
    # 2027-02-28, not the 2027-02-14 the ledger already holds.
    assert verdict.horizon_at.date().isoformat() == "2027-02-14"


def test_a_prior_row_with_no_reasoning_still_mints_a_verdict():
    # REASONING is nullable in the ledger; build_verdict will not mint on an
    # empty one. A data defect must not fail the run.
    result = _run([open_prediction_row(subject="dirty soda", reasoning="")])

    assert result.verdicts[0].reasoning.startswith("No reasoning was recorded")


def test_the_scope_refuses_a_similarity_that_is_not_a_cosine():
    with pytest.raises(ValueError, match="cosine"):
        MatchScope(min_similarity=1.4)
    with pytest.raises(ValueError, match="at least 1"):
        MatchScope(prediction_limit=0)


def test_the_prediction_limit_caps_a_run():
    rows = [
        open_prediction_row(prediction_id="p-1"),
        open_prediction_row(prediction_id="p-2", subject="dirty soda"),
    ]

    result = _run(rows, scope=MatchScope(prediction_limit=1))

    assert len(result.verdicts) == 1


def test_the_verdict_json_round_trips_through_the_ledger_params():
    from prediction_service.domain.ledger import insert_params

    result = _run([open_prediction_row()])
    params = insert_params(result.verdicts[0])

    evidence = json.loads(params["evidence"])
    assert evidence["match"]["method"] == "descriptor_vocabulary"
    assert evidence["trend_context"]["trend_id"] == TREND_ID
    assert params["what_changed"] is None
