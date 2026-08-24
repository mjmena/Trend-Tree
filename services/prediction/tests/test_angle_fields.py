"""The strategist-facing narrative fields: ANGLE and AUDIENCE_QUESTION
(CRMA-782).

The 4-part claim is machine-facing by design -- ADR-0003 fixes the subject's
register and the observable check is a named source plus a hard threshold, so
two readers grade it identically. Neither property leaves room for "why does
this matter". These two fields carry that, and the whole point of them is
that they are ADDITIVE: a verdict without them is still a verdict, and no
value in either may ever change what gets minted or at what confidence.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime

import pytest

from prediction_service.domain.claim import (
    MAX_LENGTHS,
    Claim,
    InvalidClaim,
    build_verdict,
)
from prediction_service.domain.ledger import MERGE_VERDICT, insert_params
from prediction_service.generation.parse import parse_candidates
from prediction_service.generation.prompt import build_system_prompt
from prediction_service.matching.predictions import OpenPrediction
from prediction_service.sweep.lifecycle import Observation
from prediction_service.sweep.parse import Reevaluation, parse_reevaluations
from prediction_service.sweep.prompt import build_system_prompt as build_sweep_system_prompt
from prediction_service.sweep.run import narrative_for

_VALID_EVIDENCE = {
    "source_signals": [],
    "saturation": None,
    "trend_context": None,
    "coverage": None,
}

ANGLE = "Sunscreen compliance is becoming something you can see."
QUESTION = "Would you trust a sticker to tell you when to reapply?"


def _claim() -> Claim:
    return Claim(
        subject_descriptor="UV sensor stickers",
        directional_claim="mainstream beauty retailers expand shelf placement",
        horizon_band="emerging_3_6mo",
        observable_check="Target or Ulta lists at least three distinct brands",
    )


def _verdict(**overrides):
    fields: dict[str, object] = {
        "confidence": 72.0,
        "reasoning": "convergent retail and press evidence",
        "evidence": dict(_VALID_EVIDENCE),
    }
    fields.update(overrides)
    return build_verdict(_claim(), **fields)  # type: ignore[arg-type]


def test_both_fields_have_a_column_width():
    assert MAX_LENGTHS["angle"] > 0
    assert MAX_LENGTHS["audience_question"] > 0


def test_a_verdict_carries_the_fields_when_given():
    verdict = _verdict(angle=ANGLE, audience_question=QUESTION)
    assert verdict.angle == ANGLE
    assert verdict.audience_question == QUESTION


def test_a_verdict_without_them_is_still_a_verdict():
    """The additive property, stated as a test. Every row written before
    CRMA-782 has NULL in both columns and must still read back valid."""
    verdict = _verdict()
    assert verdict.angle is None
    assert verdict.audience_question is None
    assert verdict.confidence == 72.0
    assert verdict.status == "ACTIVE"


@pytest.mark.parametrize("field", ["angle", "audience_question"])
def test_an_over_long_field_is_refused_by_the_domain_layer(field):
    """Same fail-fast contract the other narrative columns get: an actionable
    error here rather than a Snowflake "String is too long" after a round
    trip. parse.py is what keeps this from ever gating a real run -- it drops
    an over-long value to None rather than letting it reject the claim."""
    with pytest.raises(InvalidClaim, match="exceeds its column width"):
        _verdict(**{field: "x" * (MAX_LENGTHS[field] + 1)})


@pytest.mark.parametrize("field", ["angle", "audience_question"])
def test_control_and_bidi_characters_are_refused(field):
    """Both fields reach the dashboard card verbatim, which is exactly where
    a right-to-left override does its damage."""
    with pytest.raises(InvalidClaim, match="control or bidirectional-override"):
        _verdict(**{field: "before‮after"})


def test_the_write_carries_both_fields():
    params = insert_params(_verdict(angle=ANGLE, audience_question=QUESTION))
    assert params["angle"] == ANGLE
    assert params["audience_question"] == QUESTION


def test_the_write_sends_null_when_they_are_absent():
    params = insert_params(_verdict())
    assert params["angle"] is None
    assert params["audience_question"] is None


def test_the_merge_names_both_columns():
    """The INSERT column list and its VALUES list must stay the same length;
    a column added to one and not the other is a runtime SQL error, not a
    type error."""
    for column in ("ANGLE", "AUDIENCE_QUESTION"):
        assert column in MERGE_VERDICT
    for placeholder in ("%(angle)s", "%(audience_question)s"):
        assert placeholder in MERGE_VERDICT


def _reply(**extra) -> str:
    proposal = {
        "subject_descriptor": "UV sensor stickers",
        "directional_claim": "mainstream beauty retailers expand shelf placement",
        "horizon_band": "emerging_3_6mo",
        "observable_check": "Target or Ulta lists at least three distinct brands",
        "confidence": 72,
        "reasoning": "convergent retail and press evidence",
        "source_signals": ["sig-1"],
    }
    proposal.update(extra)
    return json.dumps({"predictions": [proposal]})


def _parse_one(**extra):
    accepted, rejected = parse_candidates(
        _reply(**extra), known_signal_ids=["sig-1"], max_predictions=5
    )
    return accepted, rejected


def test_generation_parses_both_fields():
    accepted, rejected = _parse_one(angle=ANGLE, audience_question=QUESTION)
    assert not rejected
    assert accepted[0].angle == ANGLE
    assert accepted[0].audience_question == QUESTION


def test_a_proposal_without_them_is_accepted():
    """The additive rule at the parse boundary. Every rejection in this
    module is structural -- not a falsifiable claim, or evidence that does
    not exist. A missing angle is neither."""
    accepted, rejected = _parse_one()
    assert not rejected
    assert accepted[0].angle is None
    assert accepted[0].audience_question is None


@pytest.mark.parametrize(
    "bad",
    [
        pytest.param("x" * (MAX_LENGTHS["angle"] + 1), id="over-long"),
        pytest.param("before‮after", id="bidi-override"),
        pytest.param("   ", id="blank"),
        pytest.param(42, id="not-a-string"),
        pytest.param({"nested": "object"}, id="wrong-type"),
    ],
)
def test_an_unusable_angle_is_dropped_and_never_rejects_the_claim(bad):
    """This is the non-gating rule where it would actually break.

    ``build_verdict`` raises ``InvalidClaim`` on an over-long or
    bidi-carrying narrative, and generation/run.py turns any ``InvalidClaim``
    into a dropped candidate. So if an unusable angle reached the domain
    layer, a model that wrote a bad angle would silently cost us a real
    prediction -- the field would be a gate. parse.py is the boundary that
    prevents it: the angle goes to None, the claim stands.
    """
    accepted, rejected = _parse_one(angle=bad)
    assert not rejected
    assert len(accepted) == 1
    assert accepted[0].angle is None
    assert accepted[0].claim.subject_descriptor == "UV sensor stickers"
    assert accepted[0].confidence == 72


def test_a_dropped_angle_leaves_the_audience_question_alone():
    accepted, _ = _parse_one(angle="x" * 9999, audience_question=QUESTION)
    assert accepted[0].angle is None
    assert accepted[0].audience_question == QUESTION


def _prior(**overrides) -> OpenPrediction:
    fields: dict[str, object] = {
        "prediction_id": "pred-1",
        "claim": _claim(),
        "horizon_at": datetime(2027, 2, 17, tzinfo=UTC),
        "confidence": 72.0,
        "angle": ANGLE,
        "audience_question": QUESTION,
    }
    fields.update(overrides)
    return OpenPrediction(**fields)  # type: ignore[arg-type]


def _answer(**overrides) -> Reevaluation:
    fields: dict[str, object] = {
        "confidence": 72.0,
        "reasoning": "restated",
        "what_changed": "",
        "observation": Observation(),
    }
    fields.update(overrides)
    return Reevaluation(**fields)  # type: ignore[arg-type]


def test_an_unbound_answer_keeps_the_stored_narrative():
    """``answer is None`` means the batched turn never proved which call an
    entry belonged to. That must never cost us the stored angle."""
    assert narrative_for(_prior(), None) == (ANGLE, QUESTION)


def test_nothing_moved_keeps_the_stored_narrative():
    """The rule the story got wrong, pinned as a test.

    WHAT_CHANGED on the written row is non-null here -- compose_what_changed
    falls back to "Nothing moved since the previous evaluation" -- so a rule
    keyed on that column would refresh. The model's own note is empty, which
    is the real signal, so the stored sentence stands.
    """
    assert narrative_for(_prior(), _answer(what_changed="   ")) == (ANGLE, QUESTION)


def test_news_without_a_replacement_still_keeps_the_stored_narrative():
    answer = _answer(what_changed="Ulta now lists a third brand.")
    assert narrative_for(_prior(), answer) == (ANGLE, QUESTION)


def test_news_with_a_replacement_refreshes():
    fresh = "The patch has become the default way parents check a kid's burn risk."
    answer = _answer(what_changed="Ulta now lists a third brand.", angle=fresh)
    assert narrative_for(_prior(), answer) == (fresh, QUESTION)


def test_a_refresh_cannot_erase_an_angle_we_already_have():
    """The model cannot blank a field by sending an empty one -- parse maps
    that to None, and None means "keep", never "erase"."""
    answer = _answer(what_changed="something moved", angle="", audience_question="  ")
    assert narrative_for(_prior(), answer) == (ANGLE, QUESTION)


def test_a_prediction_with_no_stored_angle_stays_without_one():
    bare = _prior(angle=None, audience_question=None)
    assert narrative_for(bare, None) == (None, None)


def test_the_sweep_parser_drops_an_unusable_rewrite():
    """An over-long rewrite is discarded in favour of the stored sentence,
    not truncated into a half-sentence on the card."""
    reply = json.dumps(
        {
            "reevaluations": [
                {
                    "id": 1,
                    "prediction_id": "pred-1",
                    "confidence": 72,
                    "reasoning": "r",
                    "what_changed": "news",
                    "angle": "x" * (MAX_LENGTHS["angle"] + 1),
                    "audience_question": "before‮after",
                }
            ]
        }
    )
    bound = parse_reevaluations(reply, prediction_ids=["pred-1"], subjects=["UV sensor stickers"])
    assert bound[1].angle is None
    assert bound[1].audience_question is None
    assert narrative_for(_prior(), bound[1]) == (ANGLE, QUESTION)


def test_an_entry_that_fails_identity_binding_cannot_touch_the_narrative():
    """The recurring bug class of this epic, at the new field.

    A batched turn that binds by position alone would let one prediction's
    angle land on another. The id echo has to agree, and when it does not
    the entry is dropped -- which leaves the stored angle standing.
    """
    reply = json.dumps(
        {
            "reevaluations": [
                {
                    "id": 1,
                    "prediction_id": "some-other-prediction",
                    "confidence": 99,
                    "reasoning": "r",
                    "what_changed": "news",
                    "angle": "an angle belonging to a different call",
                }
            ]
        }
    )
    bound = parse_reevaluations(reply, prediction_ids=["pred-1"], subjects=["UV sensor stickers"])
    assert bound == {}
    assert narrative_for(_prior(), bound.get(1)) == (ANGLE, QUESTION)


def test_the_generation_prompt_builder_is_pure():
    """Same string every call: no clock, no I/O, no warehouse. That is what
    lets prompt quality iterate under pytest rather than through a deploy."""
    assert build_system_prompt() == build_system_prompt()


def test_the_generation_prompt_asks_for_both_fields_and_marks_them_optional():
    prompt = build_system_prompt()
    assert "angle" in prompt
    assert "audience_question" in prompt
    # The non-gating rule has to be in the prompt as well as in the code --
    # a model that believes an angle is mandatory will invent one, and an
    # invented angle is worse than none.
    assert "OPTIONAL" in prompt
    assert "NEVER costs the prediction" in prompt


def test_the_generation_prompt_keeps_the_two_registers_apart():
    """The angle is prose; the subject is not. If the angle's register bled
    into the claim, the claim would stop being gradable -- which is the
    reason these are separate fields at all."""
    prompt = build_system_prompt()
    # Substring, not the whole sentence: the prompt hard-wraps, so a literal
    # spanning the wrap would assert the line width rather than the rule.
    assert "Machine-facing register" in prompt
    assert "Do NOT let them leak back into the" in prompt


def test_the_sweep_prompt_tells_the_model_to_leave_them_alone():
    """Default to silence. The sweep runs daily; a model invited to rewrite
    the angle each cycle produces churn, not news."""
    prompt = build_sweep_system_prompt()
    assert "OMIT both fields" in prompt
    assert "keeps what is stored" in prompt


def test_neither_field_moves_the_confidence():
    """The non-gating rule, at the domain layer: same claim, same evidence,
    same number -- whatever the narrative says."""
    plain = _verdict(minted_at=datetime(2026, 8, 24, tzinfo=UTC))
    narrated = _verdict(
        angle="This changes everything.",
        audience_question="Do you care?",
        minted_at=datetime(2026, 8, 24, tzinfo=UTC),
    )
    assert plain.confidence == narrated.confidence
    assert plain.status == narrated.status
    assert plain.horizon_at == narrated.horizon_at
    assert plain.claim == narrated.claim
