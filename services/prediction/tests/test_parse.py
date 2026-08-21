"""Turning a model reply into candidate claims (CRMA-763, AC2 + AC4).

Every assertion here is about *structure*, because every rejection in
parse.py is structural. The strategy doc rules out mechanical gates
(§10.4); the one rule this layer enforces is §2's -- "a topic without a claim
is never emitted, however confident the agent feels."
"""

from __future__ import annotations

import json

import pytest

from prediction_service.generation.parse import UnparseableResponse, parse_candidates

CORPUS = ["bluesky:abc", "amazon_trends:vest", "gdelt:20260810"]


def _reply(*predictions) -> str:
    return json.dumps({"predictions": list(predictions)})


def _good(**overrides) -> dict:
    base = {
        "subject_descriptor": "rucking vests",
        "directional_claim": "mainstream retail adoption expands beyond specialty fitness",
        "horizon_band": "emerging_3_6mo",
        "observable_check": "major-retailer listings + sustained search-interest growth",
        "confidence": 68,
        "reasoning": "four independent sources converge on the same shift",
        "emergence_path": "signal convergence",
        "source_signals": ["bluesky:abc", "amazon_trends:vest"],
    }
    base.update(overrides)
    return base


def _parse(text: str, *, max_predictions: int = 5):
    return parse_candidates(text, known_signal_ids=CORPUS, max_predictions=max_predictions)


def test_a_complete_proposal_becomes_a_candidate():
    accepted, rejected = _parse(_reply(_good()))

    assert rejected == []
    assert len(accepted) == 1
    candidate = accepted[0]
    assert candidate.claim.subject_descriptor == "rucking vests"
    assert candidate.claim.horizon_band == "emerging_3_6mo"
    assert candidate.confidence == 68.0
    assert candidate.source_signals == ("bluesky:abc", "amazon_trends:vest")
    assert candidate.emergence_path == "signal convergence"


# --- AC2: a topic without a directional claim is never emitted -------------


def test_a_topic_with_no_directional_claim_is_dropped_at_any_confidence():
    accepted, rejected = _parse(_reply(_good(directional_claim="", confidence=99)))

    assert accepted == []
    assert len(rejected) == 1
    assert "no directional_claim" in rejected[0].reason
    assert rejected[0].subject == "rucking vests"


def test_a_whitespace_only_directional_claim_is_the_same_as_none():
    accepted, rejected = _parse(_reply(_good(directional_claim="   \n  ")))

    assert accepted == []
    assert "no directional_claim" in rejected[0].reason


def test_a_missing_directional_claim_key_is_dropped():
    proposal = _good()
    del proposal["directional_claim"]

    accepted, rejected = _parse(_reply(proposal))

    assert accepted == []
    assert "no directional_claim" in rejected[0].reason


def test_a_claim_with_no_observable_check_is_dropped_as_ungradable():
    accepted, rejected = _parse(_reply(_good(observable_check="")))

    assert accepted == []
    assert "not gradable" in rejected[0].reason


def test_high_confidence_never_rescues_an_incomplete_claim():
    # The explicit form of AC2: the same topic at 5 and at 100 is dropped
    # both times, for the same structural reason.
    for confidence in (5, 50, 100):
        accepted, rejected = _parse(_reply(_good(directional_claim="", confidence=confidence)))
        assert accepted == []
        assert "no directional_claim" in rejected[0].reason


def test_a_dropped_proposal_does_not_take_its_siblings_with_it():
    accepted, rejected = _parse(_reply(_good(directional_claim=""), _good()))

    assert len(accepted) == 1
    assert len(rejected) == 1


# --- AC3: the horizon band is controlled vocabulary ------------------------


@pytest.mark.parametrize(
    "band",
    ["near_term_1_3mo", "emerging_3_6mo", "cultural_shift_6_12mo", "longer_range_12_24mo"],
)
def test_each_controlled_band_is_accepted(band):
    accepted, _ = _parse(_reply(_good(horizon_band=band)))
    assert accepted[0].claim.horizon_band == band


@pytest.mark.parametrize("band", ["", "3-6 months", "soon", "emerging", "NEAR_TERM_1_3MO"])
def test_a_band_outside_the_controlled_vocabulary_is_dropped(band):
    accepted, rejected = _parse(_reply(_good(horizon_band=band)))

    assert accepted == []
    assert "horizon_band" in rejected[0].reason


# --- AC4: source_signals is the audit trail, so it has to be real ----------


def test_ids_outside_this_runs_corpus_are_dropped():
    accepted, _ = _parse(
        _reply(_good(source_signals=["bluesky:abc", "bluesky:this-was-never-shown"]))
    )

    assert accepted[0].source_signals == ("bluesky:abc",)


def test_a_proposal_citing_only_invented_ids_is_rejected_outright():
    # An uncitable claim is not evidence, it is a guess -- and EVIDENCE
    # .source_signals is supposed to be the auditable answer to "how are
    # these decisions getting made".
    accepted, rejected = _parse(_reply(_good(source_signals=["bluesky:invented"])))

    assert accepted == []
    assert "no source_signals that exist" in rejected[0].reason


def test_an_empty_source_signals_list_is_rejected():
    accepted, rejected = _parse(_reply(_good(source_signals=[])))

    assert accepted == []
    assert "no source_signals that exist" in rejected[0].reason


def test_duplicate_ids_are_collapsed_in_order():
    accepted, _ = _parse(
        _reply(_good(source_signals=["amazon_trends:vest", "bluesky:abc", "amazon_trends:vest"]))
    )

    assert accepted[0].source_signals == ("amazon_trends:vest", "bluesky:abc")


def test_a_string_instead_of_a_list_of_ids_is_rejected_not_iterated_by_character():
    accepted, rejected = _parse(_reply(_good(source_signals="bluesky:abc")))

    assert accepted == []
    assert "no source_signals that exist" in rejected[0].reason


# --- the rest of the envelope ---------------------------------------------


def test_a_proposal_with_no_reasoning_is_dropped():
    # REASONING is a first-class column and the strategist-facing answer to
    # "why should I believe you"; a verdict without it is not shippable.
    accepted, rejected = _parse(_reply(_good(reasoning="  ")))

    assert accepted == []
    assert rejected[0].reason == "no reasoning"


@pytest.mark.parametrize("confidence", [None, -1, 101, "very high", True])
def test_confidence_outside_zero_to_one_hundred_is_dropped(confidence):
    accepted, rejected = _parse(_reply(_good(confidence=confidence)))

    assert accepted == []
    assert "confidence" in rejected[0].reason


def test_a_subject_longer_than_its_ledger_column_is_dropped_not_truncated():
    accepted, rejected = _parse(_reply(_good(subject_descriptor="x" * 300)))

    assert accepted == []
    assert "column width" in rejected[0].reason


def test_a_non_object_proposal_is_dropped():
    accepted, rejected = _parse(_reply("just a string"))

    assert accepted == []
    assert rejected[0].reason == "proposal is not an object"


# --- the run cap ----------------------------------------------------------


def test_proposals_beyond_the_cap_are_trimmed_and_accounted_for():
    accepted, rejected = _parse(
        _reply(_good(subject_descriptor="a"), _good(subject_descriptor="b")),
        max_predictions=1,
    )

    assert [c.claim.subject_descriptor for c in accepted] == ["a"]
    assert len(rejected) == 1
    assert "beyond this run's cap" in rejected[0].reason
    assert rejected[0].subject == "b"


# --- reply shapes ---------------------------------------------------------


def test_an_empty_predictions_list_is_a_valid_answer():
    accepted, rejected = _parse('{"predictions": []}')

    assert accepted == []
    assert rejected == []


def test_a_fenced_reply_is_still_parsed():
    fenced = "```json\n" + _reply(_good()) + "\n```"

    accepted, _ = _parse(fenced)

    assert len(accepted) == 1


def test_prose_around_the_object_is_tolerated():
    noisy = "Here is my answer:\n" + _reply(_good()) + "\nHope that helps."

    accepted, _ = _parse(noisy)

    assert len(accepted) == 1


def test_a_reply_that_is_not_json_is_an_unparseable_response():
    with pytest.raises(UnparseableResponse, match="no JSON object"):
        _parse("I could not find anything worth predicting today.")


def test_a_reply_without_a_predictions_key_is_unparseable():
    with pytest.raises(UnparseableResponse, match="no 'predictions' key"):
        _parse('{"claims": []}')


def test_a_non_list_predictions_value_is_unparseable():
    with pytest.raises(UnparseableResponse, match="must be a list"):
        _parse('{"predictions": {"subject_descriptor": "x"}}')
