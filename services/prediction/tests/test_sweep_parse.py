"""The re-evaluation reply, parsed (CRMA-766).

The parser's job is not to extract as much as possible -- it is to refuse to
bind an answer to a call it might not be about. A re-evaluation carries a
*resolution*, so a mis-bound entry does not merely mislabel a number: it
closes the wrong prediction, permanently, and nothing downstream would
notice.

The binding key is PREDICTION_ID. Two live calls CAN share a subject
descriptor -- generation dedupes on the whole four-part claim, so two
candidates that differ only in their directional claim both mint -- and a
parser bound to the subject alone would hand one of them the other's ``met``.
That is the test at the bottom of this file.
"""

from __future__ import annotations

import json

import pytest

from prediction_service.domain.claim import MAX_LENGTHS
from prediction_service.sweep.parse import (
    UnparseableReevaluation,
    parse_reevaluations,
)

SUBJECTS = ["rucking vests", "probiotic nasal spray"]
IDS = ["pred-rucking-vests", "pred-probiotic-nasal-spray"]


def reply(*entries):
    return json.dumps({"reevaluations": list(entries)})


def parse(text, *, prediction_ids=None, subjects=None):
    return parse_reevaluations(
        text,
        prediction_ids=IDS if prediction_ids is None else prediction_ids,
        subjects=SUBJECTS if subjects is None else subjects,
    )


def entry(**overrides):
    base = {
        "id": 1,
        "prediction_id": IDS[0],
        "subject": "rucking vests",
        "observable_check": "not_yet",
        "observation": "nothing at the named retailers yet",
        "confidence": 74.0,
        "reasoning": "restated",
        "what_changed": "two more sources",
    }
    base.update(overrides)
    return base


def test_a_well_formed_entry_parses():
    answers = parse(reply(entry()))
    assert answers[1].confidence == 74.0
    assert answers[1].reasoning == "restated"
    assert answers[1].what_changed == "two more sources"
    assert answers[1].observation.outcome == "not_yet"
    assert answers[1].observation.rationale == "nothing at the named retailers yet"


def test_an_entry_echoing_the_wrong_subject_is_dropped():
    answers = parse(reply(entry(subject="probiotic nasal spray", observable_check="met")))
    assert answers == {}


def test_an_entry_echoing_the_wrong_prediction_id_is_dropped():
    answers = parse(reply(entry(prediction_id=IDS[1], observable_check="met")))
    assert answers == {}


def test_an_entry_with_no_prediction_id_is_dropped():
    answers = parse(reply({k: v for k, v in entry().items() if k != "prediction_id"}))
    assert answers == {}


def test_an_entry_that_omits_the_subject_still_binds_on_the_id():
    # The id is the key; the subject is a second opinion when it is offered.
    answers = parse(reply({k: v for k, v in entry().items() if k != "subject"}))
    assert answers[1].confidence == 74.0


def test_subjects_are_matched_on_the_folded_form():
    answers = parse(reply(entry(subject="  Rucking   Vests ")))
    assert 1 in answers


def test_a_renumbered_and_resorted_reply_binds_by_identity_not_position():
    # The realistic failure: the model re-sorts by its new confidence.
    answers = parse(
        reply(
            entry(id=1, prediction_id=IDS[1], subject="probiotic nasal spray", confidence=90.0),
            entry(id=2, prediction_id=IDS[0], subject="rucking vests", confidence=20.0),
        ),
    )
    # Neither entry is where its prediction_id says it belongs, so neither binds.
    assert answers == {}


SAME_SUBJECT = ["rucking vests", "rucking vests"]
SAME_SUBJECT_IDS = ["pred-one", "pred-two"]


def _same_subject_entry(index, prediction_id, *, outcome, confidence):
    return {
        "id": index,
        "prediction_id": prediction_id,
        "subject": "rucking vests",
        "observable_check": outcome,
        "observation": "as read",
        "confidence": confidence,
        "reasoning": f"the case for {prediction_id}",
        "what_changed": f"what moved for {prediction_id}",
    }


def test_two_live_calls_on_the_same_subject_cannot_be_swapped():
    # SUBJECT_DESCRIPTOR is not unique. Generation dedupes on the whole
    # four-part claim, so two candidates that share a subject and differ in
    # their directional claim both mint -- and the live-subject index is read
    # before the model turn, so it cannot suppress a same-subject sibling
    # minted in the same reply. Bound by subject, a reply whose entry 1
    # carried entry 2's content would bind BOTH, and hand call one call two's
    # `met` -- which is terminal.
    swapped = reply(
        _same_subject_entry(1, "pred-two", outcome="met", confidence=95.0),
        _same_subject_entry(2, "pred-one", outcome="not_yet", confidence=40.0),
    )
    assert (
        parse(swapped, prediction_ids=SAME_SUBJECT_IDS, subjects=SAME_SUBJECT) == {}
    )


def test_the_right_answers_for_two_same_subject_calls_still_bind():
    # ...and the guard is not merely "a shared subject means nothing binds".
    straight = reply(
        _same_subject_entry(1, "pred-one", outcome="not_yet", confidence=40.0),
        _same_subject_entry(2, "pred-two", outcome="met", confidence=95.0),
    )
    answers = parse(straight, prediction_ids=SAME_SUBJECT_IDS, subjects=SAME_SUBJECT)
    assert (answers[1].confidence, answers[1].observation.outcome) == (40.0, "not_yet")
    assert (answers[2].confidence, answers[2].observation.outcome) == (95.0, "met")


def test_a_batch_whose_ids_and_subjects_disagree_in_length_is_refused():
    with pytest.raises(ValueError, match="same batch"):
        parse_reevaluations(reply(entry()), prediction_ids=IDS, subjects=SUBJECTS[:1])


@pytest.mark.parametrize("value", ["definitely", "", None, 3, "MET?", "resolved_true"])
def test_an_unrecognized_observable_check_reads_not_yet(value):
    # Both settled outcomes are permanent, so a typo must never be able to
    # close a call.
    answers = parse(reply(entry(observable_check=value)))
    assert answers[1].observation.outcome == "not_yet"


@pytest.mark.parametrize("outcome", ["met", "failed", "not_yet"])
def test_the_three_readings_survive(outcome):
    answers = parse(reply(entry(observable_check=outcome)))
    assert answers[1].observation.outcome == outcome


def test_an_out_of_range_confidence_is_absent_rather_than_clamped():
    # Absent means "keep the prior row's number", which is the only safe
    # degradation; clamping would be code choosing a confidence.
    answers = parse(reply(entry(confidence=140)))
    assert answers[1].confidence is None


def test_over_long_text_is_truncated_to_its_column():
    answers = parse(
        reply(entry(reasoning="x" * 9000, what_changed="y" * 9000)), subjects=SUBJECTS
    )
    assert len(answers[1].reasoning) <= MAX_LENGTHS["reasoning"]
    assert len(answers[1].what_changed) <= MAX_LENGTHS["what_changed"]


def test_a_duplicate_id_keeps_the_first():
    answers = parse(
        reply(entry(confidence=74.0), entry(confidence=10.0)), subjects=SUBJECTS
    )
    assert answers[1].confidence == 74.0


def test_an_id_outside_the_batch_is_dropped():
    assert parse(reply(entry(id=9))) == {}


def test_a_reply_with_no_reevaluations_key_raises():
    with pytest.raises(UnparseableReevaluation):
        parse('{"weighings": []}')


def test_a_reevaluations_value_that_is_not_a_list_raises():
    with pytest.raises(UnparseableReevaluation):
        parse('{"reevaluations": {"id": 1}}')


def test_an_empty_batch_is_a_valid_answer_meaning_nothing_to_say():
    assert parse('{"reevaluations": []}') == {}


def test_a_fenced_reply_still_parses():
    fenced = "```json\n" + reply(entry()) + "\n```"
    assert 1 in parse(fenced)


def test_the_prompt_asks_for_the_field_the_parser_binds_on():
    # A prompt that never showed the prediction_id would produce replies that
    # can never bind, and every call would silently keep its prior numbers.
    from prediction_service.sweep.prompt import (
        ReevaluationItem,
        build_system_prompt,
        build_user_prompt,
    )

    assert '"prediction_id"' in build_system_prompt()
    item = ReevaluationItem(
        prediction_id="pred-abc",
        subject_descriptor="rucking vests",
        directional_claim="claim",
        horizon_band="emerging_3_6mo",
        observable_check="check",
        horizon_at="2027-02-14T00:00:00+00:00",
        status="ACTIVE",
        confidence=68.0,
        reasoning="because",
        days_to_horizon=60.0,
        days_of_grace_left=240.0,
    )
    assert "pred-abc" in build_user_prompt([item])


def test_the_prompt_names_exactly_the_readings_the_parser_accepts():
    # A prompt offering a word the parser silently rejects would produce
    # calls that can never resolve.
    from prediction_service.sweep.lifecycle import OBSERVATIONS
    from prediction_service.sweep.prompt import build_system_prompt

    prompt = build_system_prompt()
    for outcome in OBSERVATIONS:
        assert f'"{outcome}"' in prompt
