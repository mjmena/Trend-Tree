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
    ERROR_DEADLINE_EXCEEDED,
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


def test_a_subject_the_run_never_got_to_is_not_described_as_a_refusal():
    # The budget-exceeded miss (saturation/run.py) says what actually
    # happened. Telling the model "the provider refused the request" of our
    # own spent budget is the same mislabelling the timeframe fix removes.
    rendered = render_et(
        SaturationLookup(
            query="head spa",
            matched=False,
            miss_reason=MISS_LOOKUP_FAILED,
            error=ERROR_DEADLINE_EXCEEDED,
        )
    )

    assert "spent its lookup budget" in rendered
    assert "refused the request" not in rendered
    assert "no weight in either direction" in rendered


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


def test_the_prompt_demands_the_subject_be_echoed_back():
    # The binding the parser enforces has to be asked for, or every entry is
    # skipped and the whole pass silently degrades to "unweighed".
    system = build_weighing_system_prompt()

    assert '"subject": "<the subject shown for id 1, copied exactly>"' in system
    assert "do NOT renumber, re-sort or reorder" in system
    assert "DISCARDED" in system
    assert "echoing that id's subject" in build_weighing_user_prompt(
        [_item(PEAKED, BROAD)]
    )


def test_a_fallback_classification_is_labelled_with_the_window_it_came_from():
    # ET did not report a 12-month verdict here. Rendering the 3-month one as
    # "12-month" would put a claim about how far along the world is in front
    # of the model that the oracle never made -- and `peaked` is the exact
    # word this prompt says argues against high confidence.
    short = SaturationLookup(
        query="head spa",
        matched=True,
        classification="peaked",
        classification_timeframe="3",
        classifications={"3": "peaked", "6": "peaked"},
        keyword="head spa",
        total=1,
    )

    rendered = render_et(short)

    assert "3-month classification: peaked" in rendered
    assert "12-month classification" not in rendered
    assert "ET reported no 12-month verdict" in rendered


def test_a_twelve_month_classification_is_rendered_as_the_twelve_month_one():
    assert "12-month classification: peaked" in render_et(
        SaturationLookup(
            query="rucking vests",
            matched=True,
            classification="peaked",
            classification_timeframe="12",
            keyword="rucking vest",
            total=1,
        )
    )


def test_the_fuzzy_candidates_reach_the_model_that_is_asked_to_judge_the_match():
    # weigh.py tells the agent ET's search is FUZZY and asks it to judge
    # concept-sameness. agents/lib/exploding_topics.mjs surfaces the candidate
    # list precisely so it can -- one keyword and a bare count is not enough
    # to judge anything against.
    with_candidates = SaturationLookup(
        query="rucking vests",
        matched=True,
        classification="peaked",
        classification_timeframe="12",
        keyword="rucking vest",
        candidates=(
            {"keyword": "rucking vest", "path": "rucking-vest"},
            {"keyword": "weighted vest", "path": "weighted-vest"},
            {"keyword": "ruck plate", "path": "ruck-plate"},
        ),
        total=3,
    )

    rendered = render_et(with_candidates)

    assert "'weighted vest'" in rendered
    assert "'ruck plate'" in rendered


# --- the parser ------------------------------------------------------------

SUBJECTS = ["rucking vests", "cottage cheese", "head spa"]


def _reply(*entries) -> str:
    return json.dumps({"weighings": list(entries)})


def test_a_restatement_is_read_back_by_id_and_bound_to_its_subject():
    reply = _reply(
        {"id": 2, "subject": "cottage cheese", "confidence": 41.5, "reasoning": "ET says peaked"}
    )

    weighings = parse_weighings(reply, subjects=SUBJECTS)

    assert set(weighings) == {2}
    assert weighings[2].confidence == 41.5
    assert weighings[2].reasoning == "ET says peaked"


def test_the_subject_is_matched_case_and_whitespace_insensitively():
    # The binding is on the subject the model was shown, not on its exact
    # keystrokes -- a re-cased echo is still unambiguously the same call.
    reply = _reply(
        {"id": 1, "subject": "Rucking  Vests", "confidence": 40, "reasoning": "same call"}
    )

    assert parse_weighings(reply, subjects=SUBJECTS)[1].reasoning == "same call"


def test_a_resorted_renumbered_reply_swaps_nothing():
    # The failure this binding exists for. Asked to restate a list, a model
    # may return its entries sorted by its new confidence and renumbered
    # 1..n -- ordinary behaviour, and read back by position it would write
    # 'rucking vests' with cottage cheese's number and a reasoning paragraph
    # about cottage cheese's classification. Every row still written, nothing
    # detectably wrong downstream. Mislabelled, silently.
    reply = _reply(
        {"id": 1, "subject": "cottage cheese", "confidence": 91, "reasoning": "cc first now"},
        {"id": 2, "subject": "rucking vests", "confidence": 12, "reasoning": "rv second now"},
    )

    # Nothing is bound, so both calls keep generation's own confidence and
    # reasoning. A skip is not a gate: it means "keep your own number".
    assert parse_weighings(reply, subjects=SUBJECTS) == {}


def test_a_restatement_naming_another_subject_is_skipped():
    reply = _reply(
        {"id": 1, "subject": "cottage cheese", "confidence": 40, "reasoning": "wrong call"},
        {"id": 2, "subject": "cottage cheese", "confidence": 44, "reasoning": "right call"},
    )

    weighings = parse_weighings(reply, subjects=SUBJECTS)

    assert set(weighings) == {2}
    assert weighings[2].confidence == 44


def test_a_restatement_with_no_subject_key_is_skipped():
    # An entry that does not say what it is about cannot be bound to a call,
    # and position is not evidence that it belongs to one.
    reply = _reply({"id": 1, "confidence": 40, "reasoning": "which call is this about?"})

    assert parse_weighings(reply, subjects=SUBJECTS) == {}


@pytest.mark.parametrize(
    "entry",
    [
        {"id": 9, "subject": "rucking vests", "confidence": 40, "reasoning": "out of range id"},
        {"id": 0, "subject": "rucking vests", "confidence": 40, "reasoning": "ids are 1-based"},
        {"id": 1, "subject": "rucking vests", "confidence": 140, "reasoning": "outside 0-100"},
        {"id": 1, "subject": "rucking vests", "confidence": None, "reasoning": "no confidence"},
        {"id": 1, "subject": "rucking vests", "confidence": 40, "reasoning": "   "},
        {"id": 1, "subject": "rucking vests", "confidence": 40},
        {"id": 1, "subject": 7, "confidence": 40, "reasoning": "a number is not a subject"},
        {"subject": "rucking vests", "confidence": 40, "reasoning": "no id"},
        {"id": True, "subject": "rucking vests", "confidence": 40, "reasoning": "not an id"},
        "not an object",
    ],
)
def test_a_malformed_restatement_is_absent_rather_than_invented(entry):
    # Absent means the caller keeps generation's own number. A parser that
    # filled in a default would be the mechanical discount this whole design
    # exists to avoid.
    assert parse_weighings(json.dumps({"weighings": [entry]}), subjects=SUBJECTS[:2]) == {}


def test_the_first_restatement_for_an_id_wins():
    reply = _reply(
        {"id": 1, "subject": "rucking vests", "confidence": 40, "reasoning": "first"},
        {"id": 1, "subject": "rucking vests", "confidence": 90, "reasoning": "second"},
    )

    assert parse_weighings(reply, subjects=SUBJECTS[:1])[1].reasoning == "first"


def test_an_over_long_reasoning_is_trimmed_to_its_ledger_column():
    reply = _reply(
        {"id": 1, "subject": "rucking vests", "confidence": 50, "reasoning": "x" * 6000}
    )

    assert len(parse_weighings(reply, subjects=SUBJECTS[:1])[1].reasoning) == 4000


def test_a_reply_without_the_key_is_refused_rather_than_read_as_empty():
    with pytest.raises(UnparseableWeighing, match="no 'weighings' key"):
        parse_weighings(json.dumps({"predictions": []}), subjects=SUBJECTS[:1])

    with pytest.raises(UnparseableWeighing, match="must be a list"):
        parse_weighings(json.dumps({"weighings": {"1": {}}}), subjects=SUBJECTS[:1])


def test_a_fenced_reply_is_still_read():
    reply = (
        '```json\n{"weighings": [{"id": 1, "subject": "rucking vests", '
        '"confidence": 50, "reasoning": "ok"}]}\n```'
    )

    assert parse_weighings(reply, subjects=SUBJECTS[:1])[1].confidence == 50
