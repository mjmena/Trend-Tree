"""The saturation weighing turn -- prompt and parser (CRMA-765 AC2/AC3).

The weighing turn is the *only* way saturation is allowed to move a verdict,
so what the prompt says is load-bearing in a way prompt text usually is not:
"``peaked`` argues against high confidence; nothing is mechanically excluded;
an ET miss carries no penalty" has to actually reach the model, and the parser
has to be incapable of inventing a number when the model does not supply one.
"""

from __future__ import annotations

import json

import pytest

from prediction_service.saturation.lookup import (
    MISS_LOOKUP_FAILED,
    MISS_NOT_CONFIGURED,
    MISS_NOT_IN_CATALOG,
    ArticleBreadth,
    SaturationLookup,
)
from prediction_service.saturation.weigh import (
    WEIGHING_MARKER,
    UnparseableWeighing,
    WeighingItem,
    build_weighing_system_prompt,
    build_weighing_user_prompt,
    parse_weighings,
    render_breadth,
    render_et,
)


def _item(lookup: SaturationLookup, reading: ArticleBreadth) -> WeighingItem:
    return WeighingItem(
        subject_descriptor="rucking vests",
        directional_claim="mass-market retail adoption expands",
        horizon_band="emerging_3_6mo",
        observable_check="Target lists a house-label weighted vest under 20 lb",
        confidence=68,
        reasoning="four independent signals converge",
        lookup=lookup,
        reading=reading,
    )


PEAKED = SaturationLookup(
    query="rucking vests",
    matched=True,
    classification="peaked",
    classifications={"3": "peaked", "12": "peaked"},
    growth={"12": "+318%"},
    keyword="rucking vest",
    absolute_volume=40500,
    total=3,
)
BROAD = ArticleBreadth(
    query="rucking vests",
    available=True,
    article_count=44,
    distinct_domains=19,
    top_domains=("nytimes.com",),
)


# --- what the prompt has to say --------------------------------------------


def test_the_system_prompt_says_peaked_argues_against_and_excludes_nothing():
    prompt = build_weighing_system_prompt()

    assert "peaked" in prompt
    assert "ARGUES AGAINST high confidence" in prompt
    assert "Nothing is excluded." in prompt
    assert "nothing downstream will drop one for you" in prompt


def test_the_system_prompt_says_a_miss_is_not_evidence_against_a_claim():
    prompt = build_weighing_system_prompt()

    assert "An Exploding Topics MISS is NOT evidence against a claim." in prompt
    assert "Do not lower a number for a miss" in prompt


def test_the_system_prompt_says_no_code_adjusts_the_number():
    prompt = build_weighing_system_prompt()

    assert "No code adjusts the number you return" in prompt


def test_the_system_prompt_requires_the_reasoning_to_address_saturation():
    # AC3: a peaked classification has to be ADDRESSED in REASONING, which
    # only happens if the prompt demands it in as many words.
    prompt = build_weighing_system_prompt()

    assert "ADDRESSES the saturation evidence" in prompt
    assert "name what ET said (including a miss)" in prompt


def test_the_system_prompt_is_recognisable_as_the_weighing_turn():
    assert WEIGHING_MARKER in build_weighing_system_prompt()
    assert WEIGHING_MARKER not in build_weighing_user_prompt([_item(PEAKED, BROAD)])


def test_a_peaked_classification_and_the_breadth_reach_the_user_turn():
    prompt = build_weighing_user_prompt([_item(PEAKED, BROAD)])

    assert "12mo=peaked" in prompt
    assert "44 article(s) across 19 distinct publisher(s)" in prompt
    assert "searches last month: 40500" in prompt
    assert "your confidence: 68" in prompt


@pytest.mark.parametrize(
    "reason", [MISS_NOT_IN_CATALOG, MISS_NOT_CONFIGURED, MISS_LOOKUP_FAILED]
)
def test_every_kind_of_miss_is_rendered_as_carrying_no_weight(reason):
    rendered = render_et(SaturationLookup(query="head spa", matched=False, miss_reason=reason))

    assert "MISS" in rendered
    assert "not" in rendered.lower()
    assert "no weight in either direction" in rendered or "NOT evidence against" in rendered


def test_an_unavailable_breadth_reading_is_rendered_as_not_a_zero():
    rendered = render_breadth(
        ArticleBreadth(query="x", available=False, error="rate_limited")
    )

    assert "UNAVAILABLE" in rendered
    assert "NOT a reading of zero coverage" in rendered


def test_the_agent_is_told_et_search_is_fuzzy_before_it_weighs_a_match():
    # ADR-0004's rejected option, restated: /database-search returns
    # near-matches, so concept-sameness is the agent's judgment, never a
    # deterministic total > 0.
    assert "ET's search is FUZZY" in render_et(PEAKED)


def test_the_user_turn_refuses_an_empty_batch():
    with pytest.raises(ValueError, match="at least one item"):
        build_weighing_user_prompt([])


# --- the parser ------------------------------------------------------------


def test_a_restatement_is_read_back_by_id():
    reply = json.dumps(
        {"weighings": [{"id": 2, "confidence": 41.5, "reasoning": "ET says peaked"}]}
    )

    weighings = parse_weighings(reply, count=3)

    assert set(weighings) == {2}
    assert weighings[2].confidence == 41.5
    assert weighings[2].reasoning == "ET says peaked"


@pytest.mark.parametrize(
    "entry",
    [
        {"id": 9, "confidence": 40, "reasoning": "out of range id"},
        {"id": 0, "confidence": 40, "reasoning": "ids are 1-based"},
        {"id": 1, "confidence": 140, "reasoning": "confidence outside 0-100"},
        {"id": 1, "confidence": None, "reasoning": "no confidence"},
        {"id": 1, "confidence": 40, "reasoning": "   "},
        {"id": 1, "confidence": 40},
        {"confidence": 40, "reasoning": "no id"},
        {"id": True, "confidence": 40, "reasoning": "a bool is not an id"},
        "not an object",
    ],
)
def test_a_malformed_restatement_is_absent_rather_than_invented(entry):
    # Absent means the caller keeps generation's own number. A parser that
    # filled in a default would be the mechanical discount this whole design
    # exists to avoid.
    assert parse_weighings(json.dumps({"weighings": [entry]}), count=2) == {}


def test_the_first_restatement_for_an_id_wins():
    reply = json.dumps(
        {
            "weighings": [
                {"id": 1, "confidence": 40, "reasoning": "first"},
                {"id": 1, "confidence": 90, "reasoning": "second"},
            ]
        }
    )

    assert parse_weighings(reply, count=1)[1].reasoning == "first"


def test_an_over_long_reasoning_is_trimmed_to_its_ledger_column():
    reply = json.dumps({"weighings": [{"id": 1, "confidence": 50, "reasoning": "x" * 6000}]})

    assert len(parse_weighings(reply, count=1)[1].reasoning) == 4000


def test_a_reply_without_the_key_is_refused_rather_than_read_as_empty():
    with pytest.raises(UnparseableWeighing, match="no 'weighings' key"):
        parse_weighings(json.dumps({"predictions": []}), count=1)

    with pytest.raises(UnparseableWeighing, match="must be a list"):
        parse_weighings(json.dumps({"weighings": {"1": {}}}), count=1)


def test_a_fenced_reply_is_still_read():
    reply = '```json\n{"weighings": [{"id": 1, "confidence": 50, "reasoning": "ok"}]}\n```'

    assert parse_weighings(reply, count=1)[1].confidence == 50
