"""The ``EVIDENCE.saturation`` payload (CRMA-765 AC1).

The contract the strategy writes down is that ``EVIDENCE`` carries four keys
and that ``saturation`` is "Exploding Topics classification via
``descriptor.query`` + GDELT article breadth". Two properties matter here:
the payload says what both oracles found *including when they found nothing*,
and filling it in disturbs nothing else in the evidence dict -- which is what
makes a matched verdict and a white-space verdict carry it identically.
"""

from __future__ import annotations

import json

from prediction_service.domain.claim import REQUIRED_EVIDENCE_KEYS, Claim, build_verdict
from prediction_service.domain.ledger import insert_params
from prediction_service.saturation import (
    SATURATION_KEY,
    ArticleBreadth,
    SaturationLookup,
    attach_saturation,
    build_saturation_evidence,
)
from prediction_service.saturation.lookup import MISS_LOOKUP_FAILED, MISS_NOT_IN_CATALOG

PEAKED = SaturationLookup(
    query="rucking vests",
    matched=True,
    classification="peaked",
    classifications={"3": "peaked", "12": "peaked"},
    growth={"12": "+318%"},
    keyword="rucking vest",
    path="rucking-vest",
    absolute_volume=40500,
    total=3,
)
BROAD = ArticleBreadth(
    query="rucking vests",
    available=True,
    article_count=44,
    distinct_domains=19,
    top_domains=("nytimes.com", "today.com"),
)


def test_the_payload_carries_the_classification_and_the_breadth():
    payload = build_saturation_evidence(lookup=PEAKED, reading=BROAD)

    assert payload["query"] == "rucking vests"
    assert payload["exploding_topics"]["classification"] == "peaked"
    assert payload["exploding_topics"]["classifications"] == {"3": "peaked", "12": "peaked"}
    assert payload["exploding_topics"]["matched_keyword"] == "rucking vest"
    assert payload["gdelt"]["article_count"] == 44
    assert payload["gdelt"]["distinct_domains"] == 19


def test_the_payload_names_the_window_the_classification_came_from():
    # A 3-month `peaked` recorded as the 12-month verdict is a materially
    # different claim about how far along the world is -- and this row is what
    # the track record will be judged from.
    payload = build_saturation_evidence(
        lookup=SaturationLookup(
            query="head spa",
            matched=True,
            classification="peaked",
            classification_timeframe="3",
            classifications={"3": "peaked", "6": "peaked"},
            keyword="head spa",
            total=1,
        ),
        reading=BROAD,
    )

    assert payload["exploding_topics"]["classification"] == "peaked"
    assert payload["exploding_topics"]["classification_timeframe"] == "3"


def test_the_payload_carries_the_fuzzy_candidates_the_agent_judged_from():
    # Parity with agents/lib/exploding_topics.mjs: the row records what ET
    # offered, not just what it matched, because concept-sameness was the
    # agent's judgment and this is what it judged from.
    payload = build_saturation_evidence(
        lookup=SaturationLookup(
            query="rucking vests",
            matched=True,
            keyword="rucking vest",
            candidates=(
                {"keyword": "rucking vest", "absolute_volume": 40500},
                {"keyword": "weighted vest", "absolute_volume": 90500},
            ),
            total=2,
        ),
        reading=BROAD,
    )

    assert [c["keyword"] for c in payload["exploding_topics"]["candidates"]] == [
        "rucking vest",
        "weighted vest",
    ]


def test_a_miss_is_spelled_out_rather_than_left_absent():
    # "ET does not know this subject" is a fact about the world worth
    # reading, and the payload says in its own body that it costs nothing --
    # so a ledger row reads correctly without the strategy doc to hand.
    payload = build_saturation_evidence(
        lookup=SaturationLookup(query="head spa", matched=False, miss_reason=MISS_NOT_IN_CATALOG),
        reading=BROAD,
    )

    assert payload["exploding_topics"]["matched"] is False
    assert payload["exploding_topics"]["miss_reason"] == MISS_NOT_IN_CATALOG
    assert payload["exploding_topics"]["classification"] is None
    assert payload["exploding_topics"]["miss_carries_no_penalty"] is True


def test_an_unavailable_breadth_reading_is_not_recorded_as_zero_coverage():
    payload = build_saturation_evidence(
        lookup=PEAKED,
        reading=ArticleBreadth(query="x", available=False, error="rate_limited"),
    )

    assert payload["gdelt"]["available"] is False
    assert payload["gdelt"]["article_count"] is None
    assert payload["gdelt"]["distinct_domains"] is None
    assert payload["gdelt"]["error"] == "rate_limited"


def test_attaching_saturation_disturbs_no_other_evidence_key():
    # The seam with the matching phase (CRMA-764) and the coverage detector:
    # this merge must never reorganise or drop a key it does not own.
    before = {
        "source_signals": ["s1", "s2"],
        "saturation": None,
        "trend_context": {"heat_index": 61.2, "age_days": 44},
        "coverage": {"stories": 3},
        "generation": {"phase": "generate", "model": "gemini-3.7-flash"},
    }

    after = attach_saturation(before, build_saturation_evidence(lookup=PEAKED, reading=BROAD))

    assert set(after) == set(before)
    for key in ("source_signals", "trend_context", "coverage", "generation"):
        assert after[key] == before[key]
    assert after[SATURATION_KEY]["exploding_topics"]["classification"] == "peaked"
    # The input is not mutated -- callers hold the pre-attachment dict.
    assert before["saturation"] is None


def test_a_matched_verdict_carries_saturation_exactly_as_a_white_space_one_does():
    # AC1 in one assertion. Nothing in this package reads MATCHED_TREND_ID, so
    # a prediction that CRMA-764 matches to a trend gets the identical
    # payload -- and the matched id and trend_context survive untouched.
    claim = Claim(
        subject_descriptor="rucking vests",
        directional_claim="mass-market retail adoption expands",
        horizon_band="emerging_3_6mo",
        observable_check="Target lists a house-label weighted vest under 20 lb",
    )
    saturation = build_saturation_evidence(lookup=PEAKED, reading=BROAD)
    white_space = build_verdict(
        claim,
        confidence=61,
        reasoning="r",
        evidence=attach_saturation(
            {k: None for k in REQUIRED_EVIDENCE_KEYS}, saturation
        ),
    )
    matched = build_verdict(
        claim,
        confidence=61,
        reasoning="r",
        matched_trend_id="trend-abc",
        evidence=attach_saturation(
            {**{k: None for k in REQUIRED_EVIDENCE_KEYS}, "trend_context": {"heat_index": 61.2}},
            saturation,
        ),
    )

    assert matched.evidence["saturation"] == white_space.evidence["saturation"]
    assert matched.matched_trend_id == "trend-abc"
    assert matched.evidence["trend_context"] == {"heat_index": 61.2}


def test_the_payload_survives_the_ledger_write_as_json():
    # EVIDENCE is written with PARSE_JSON(%(evidence)s), so a payload that
    # json.dumps cannot serialize is a 500 at write time, not a review note.
    claim = Claim(
        subject_descriptor="rucking vests",
        directional_claim="mass-market retail adoption expands",
        horizon_band="emerging_3_6mo",
        observable_check="Target lists a house-label weighted vest under 20 lb",
    )
    evidence = attach_saturation(
        {k: None for k in REQUIRED_EVIDENCE_KEYS},
        build_saturation_evidence(
            lookup=SaturationLookup(
                query="x",
                matched=False,
                miss_reason=MISS_LOOKUP_FAILED,
                error="http_403",
            ),
            reading=BROAD,
        ),
    )

    params = insert_params(
        build_verdict(claim, confidence=61, reasoning="r", evidence=evidence)
    )

    assert json.loads(params["evidence"])["saturation"]["exploding_topics"]["error"] == "http_403"
