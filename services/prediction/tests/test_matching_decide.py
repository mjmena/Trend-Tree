"""The match decision (CRMA-764 AC4).

"Match mechanics are deterministic enough to test: a fixture prediction
matching a known trend resolves to that trend." Everything here runs on
plain objects -- no warehouse, no model, no clock -- because the decision
itself uses none of those.
"""

from __future__ import annotations

import inspect

from prediction_service.matching import decide as decide_module
from prediction_service.matching.decide import (
    MATCH_DESCRIPTOR,
    MATCH_EMBEDDING,
    decide_match,
    match_evidence,
)
from prediction_service.matching.trends import TrendCandidate

RUCKING = TrendCandidate(
    trend_id="trend-rucking",
    trend_topic="Rucking as everyday exercise",
    descriptor_query="rucking vest",
    descriptor_statement="Adults wear weighted vests on ordinary walks.",
)
PROBIOTIC = TrendCandidate(
    trend_id="trend-probiotic",
    trend_topic="Probiotic body sprays",
    descriptor_query="probiotic body spray",
)


def _with(candidate: TrendCandidate, similarity: float) -> TrendCandidate:
    return TrendCandidate(
        trend_id=candidate.trend_id,
        trend_topic=candidate.trend_topic,
        descriptor_query=candidate.descriptor_query,
        descriptor_statement=candidate.descriptor_statement,
        similarity=similarity,
    )


def test_a_fixture_prediction_resolves_to_its_known_trend():
    decision = decide_match(
        "rucking vests",
        descriptor_index=[RUCKING, PROBIOTIC],
        candidates=[_with(RUCKING, 0.7421), _with(PROBIOTIC, 0.0912)],
    )

    assert decision.matched
    assert decision.trend_id == "trend-rucking"
    assert decision.method == MATCH_DESCRIPTOR
    # The number it scored is reported even though it is not what decided.
    assert decision.trend.similarity == 0.7421


def test_the_descriptor_leg_reaches_a_trend_the_cosine_window_missed():
    # The failure this leg exists to prevent: the trend whose descriptor
    # literally reads as the subject ranks outside the candidate window.
    decision = decide_match(
        "rucking vests",
        descriptor_index=[PROBIOTIC, RUCKING],
        candidates=[_with(PROBIOTIC, 0.44)],
    )

    assert decision.trend_id == "trend-rucking"
    assert decision.method == MATCH_DESCRIPTOR
    assert decision.trend.similarity is None


def test_the_embedding_leg_matches_when_no_descriptor_agrees():
    decision = decide_match(
        "everyday weighted vest walking",
        descriptor_index=[RUCKING, PROBIOTIC],
        candidates=[_with(RUCKING, 0.71), _with(PROBIOTIC, 0.10)],
    )

    assert decision.trend_id == "trend-rucking"
    assert decision.method == MATCH_EMBEDDING


def test_a_near_miss_below_the_floor_is_white_space_not_a_match():
    # The live false positive the floor exists for: "probiotic nasal spray"
    # scored 0.5699 against a probiotic *body* spray trend. Recorded as a
    # white-space prediction, not dropped.
    decision = decide_match(
        "probiotic nasal spray",
        descriptor_index=[RUCKING, PROBIOTIC],
        candidates=[_with(PROBIOTIC, 0.5699), _with(RUCKING, 0.1204)],
        min_similarity=0.60,
    )

    assert not decision.matched
    assert decision.trend_id is None
    assert decision.method is None
    # ...and the runners-up are still recorded, so the call can be re-argued.
    assert [c.trend_id for c in decision.considered] == ["trend-probiotic", "trend-rucking"]


def test_no_candidates_at_all_is_white_space():
    decision = decide_match("dirty soda", descriptor_index=[], candidates=[])

    assert not decision.matched
    assert decision.considered == ()


def test_the_decision_is_stable_under_candidate_order():
    forward = decide_match(
        "everyday weighted vest walking",
        descriptor_index=[],
        candidates=[_with(RUCKING, 0.71), _with(PROBIOTIC, 0.71)],
    )
    reversed_ = decide_match(
        "everyday weighted vest walking",
        descriptor_index=[],
        candidates=[_with(PROBIOTIC, 0.71), _with(RUCKING, 0.71)],
    )

    # A tie resolves the same way whichever order the warehouse returned.
    assert forward.trend_id == reversed_.trend_id


def test_a_candidate_with_no_similarity_never_wins_the_embedding_leg():
    decision = decide_match(
        "something else",
        descriptor_index=[],
        candidates=[TrendCandidate(trend_id="trend-null", similarity=None)],
    )

    assert not decision.matched


def test_match_evidence_records_how_the_call_was_reached():
    decision = decide_match(
        "rucking vests",
        descriptor_index=[RUCKING],
        candidates=[_with(RUCKING, 0.7421), _with(PROBIOTIC, 0.0912)],
        min_similarity=0.6,
    )

    evidence = match_evidence(decision)

    assert evidence["phase"] == "match"
    assert evidence["method"] == MATCH_DESCRIPTOR
    assert evidence["matched_trend_id"] == "trend-rucking"
    assert evidence["min_similarity"] == 0.6
    assert [c["trend_id"] for c in evidence["considered"]] == [
        "trend-rucking",
        "trend-probiotic",
    ]


def test_decide_match_has_no_parameter_a_trend_context_could_enter_through():
    # The structural half of AC2: heat, acceleration, growth and age cannot
    # influence the decision because there is nowhere to pass them.
    params = set(inspect.signature(decide_match).parameters)
    assert params == {
        "subject",
        "descriptor_index",
        "candidates",
        "min_similarity",
        "considered_limit",
    }
    assert "context" not in params
    assert "heat" not in params


def test_the_decision_module_names_no_context_measure():
    source = inspect.getsource(decide_module)
    # Comments and docstrings do discuss the measures -- that is the point of
    # saying they are excluded. Only executable text is checked.
    code = "\n".join(
        line for line in source.splitlines() if not line.strip().startswith("#")
    )
    body = code.split('"""')
    executable = "".join(body[::2]).lower()
    for measure in ("heat", "acceleration", "age_days", "lifecycle", "growth"):
        assert measure not in executable, measure
