"""The re-evaluation reply, parsed (CRMA-766).

The parser's job is not to extract as much as possible -- it is to refuse to
bind an answer to a call it might not be about. A re-evaluation carries a
*resolution*, so a mis-bound entry does not merely mislabel a number: it
closes the wrong prediction, permanently, and nothing downstream would
notice.
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


def reply(*entries):
    return json.dumps({"reevaluations": list(entries)})


def entry(**overrides):
    base = {
        "id": 1,
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
    answers = parse_reevaluations(reply(entry()), subjects=SUBJECTS)
    assert answers[1].confidence == 74.0
    assert answers[1].reasoning == "restated"
    assert answers[1].what_changed == "two more sources"
    assert answers[1].observation.outcome == "not_yet"
    assert answers[1].observation.rationale == "nothing at the named retailers yet"


def test_an_entry_echoing_the_wrong_subject_is_dropped():
    answers = parse_reevaluations(
        reply(entry(subject="probiotic nasal spray", observable_check="met")),
        subjects=SUBJECTS,
    )
    assert answers == {}


def test_subjects_are_matched_on_the_folded_form():
    answers = parse_reevaluations(reply(entry(subject="  Rucking   Vests ")), subjects=SUBJECTS)
    assert 1 in answers


def test_a_renumbered_and_resorted_reply_binds_by_subject_not_position():
    # The realistic failure: the model re-sorts by its new confidence.
    answers = parse_reevaluations(
        reply(
            entry(id=1, subject="probiotic nasal spray", confidence=90.0),
            entry(id=2, subject="rucking vests", confidence=20.0),
        ),
        subjects=SUBJECTS,
    )
    # Neither entry is where its subject says it belongs, so neither binds.
    assert answers == {}


@pytest.mark.parametrize("value", ["definitely", "", None, 3, "MET?", "resolved_true"])
def test_an_unrecognized_observable_check_reads_not_yet(value):
    # Both settled outcomes are permanent, so a typo must never be able to
    # close a call.
    answers = parse_reevaluations(reply(entry(observable_check=value)), subjects=SUBJECTS)
    assert answers[1].observation.outcome == "not_yet"


@pytest.mark.parametrize("outcome", ["met", "failed", "not_yet"])
def test_the_three_readings_survive(outcome):
    answers = parse_reevaluations(reply(entry(observable_check=outcome)), subjects=SUBJECTS)
    assert answers[1].observation.outcome == outcome


def test_an_out_of_range_confidence_is_absent_rather_than_clamped():
    # Absent means "keep the prior row's number", which is the only safe
    # degradation; clamping would be code choosing a confidence.
    answers = parse_reevaluations(reply(entry(confidence=140)), subjects=SUBJECTS)
    assert answers[1].confidence is None


def test_over_long_text_is_truncated_to_its_column():
    answers = parse_reevaluations(
        reply(entry(reasoning="x" * 9000, what_changed="y" * 9000)), subjects=SUBJECTS
    )
    assert len(answers[1].reasoning) <= MAX_LENGTHS["reasoning"]
    assert len(answers[1].what_changed) <= MAX_LENGTHS["what_changed"]


def test_a_duplicate_id_keeps_the_first():
    answers = parse_reevaluations(
        reply(entry(confidence=74.0), entry(confidence=10.0)), subjects=SUBJECTS
    )
    assert answers[1].confidence == 74.0


def test_an_id_outside_the_batch_is_dropped():
    assert parse_reevaluations(reply(entry(id=9)), subjects=SUBJECTS) == {}


def test_a_reply_with_no_reevaluations_key_raises():
    with pytest.raises(UnparseableReevaluation):
        parse_reevaluations('{"weighings": []}', subjects=SUBJECTS)


def test_a_reevaluations_value_that_is_not_a_list_raises():
    with pytest.raises(UnparseableReevaluation):
        parse_reevaluations('{"reevaluations": {"id": 1}}', subjects=SUBJECTS)


def test_an_empty_batch_is_a_valid_answer_meaning_nothing_to_say():
    assert parse_reevaluations('{"reevaluations": []}', subjects=SUBJECTS) == {}


def test_a_fenced_reply_still_parses():
    fenced = "```json\n" + reply(entry()) + "\n```"
    assert 1 in parse_reevaluations(fenced, subjects=SUBJECTS)


def test_the_prompt_names_exactly_the_readings_the_parser_accepts():
    # A prompt offering a word the parser silently rejects would produce
    # calls that can never resolve.
    from prediction_service.sweep.lifecycle import OBSERVATIONS
    from prediction_service.sweep.prompt import build_system_prompt

    prompt = build_system_prompt()
    for outcome in OBSERVATIONS:
        assert f'"{outcome}"' in prompt
