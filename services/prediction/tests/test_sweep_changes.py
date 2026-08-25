"""WHAT_CHANGED states what moved (CRMA-766 AC3).

The note is composed from the two rows, not generated, so these assert the
facts in the sentence against the facts in the columns. The model's own
explanation is a tail on it -- present when there is one, and never the only
thing in the note.
"""

from __future__ import annotations

from prediction_service.domain.claim import MAX_LENGTHS
from prediction_service.sweep.changes import NOTHING_MOVED, compose_what_changed

BASE = {
    "prior_confidence": 68.0,
    "confidence": 68.0,
    "prior_status": "ACTIVE",
    "status": "ACTIVE",
    "status_reason": "still open; the horizon is 2027-02-14T00:00:00+00:00",
}


def test_a_confidence_movement_is_named_with_both_numbers_and_the_delta():
    note = compose_what_changed(**{**BASE, "confidence": 74.0})
    assert "strengthened" in note
    assert "68.0" in note and "74.0" in note and "+6.0" in note


def test_a_drop_reads_weakened():
    note = compose_what_changed(**{**BASE, "confidence": 55.5})
    assert "weakened" in note
    assert "-12.5" in note


def test_a_status_transition_is_named_with_its_reason():
    note = compose_what_changed(
        **{
            **BASE,
            "status": "EXPIRED",
            "status_reason": "the horizon passed at 2027-02-14T00:00:00+00:00",
        }
    )
    assert "ACTIVE -> EXPIRED" in note
    assert "the horizon passed" in note


def test_becoming_matched_is_named():
    note = compose_what_changed(
        **BASE,
        prior_trend_id=None,
        trend_id="3956205c-8896-4184-9e2c-f4b70f8e9b9c",
        trend_topic="Rucking as everyday exercise",
    )
    assert "No longer white space" in note
    assert "3956205c-8896-4184-9e2c-f4b70f8e9b9c" in note
    assert "Rucking as everyday exercise" in note


def test_losing_a_match_is_named_too():
    note = compose_what_changed(
        **BASE, prior_trend_id="3956205c", trend_id=None
    )
    assert "Back to white space" in note
    assert "3956205c" in note


def test_a_run_that_moved_nothing_says_so_rather_than_going_empty():
    # An empty WHAT_CHANGED reads as "the sweep did not run", which is a
    # materially different thing from "the sweep ran and nothing had moved".
    note = compose_what_changed(
        **BASE, observation_rationale="no house-label listing has appeared"
    )
    assert note.startswith(NOTHING_MOVED)
    assert "no house-label listing has appeared" in note


def test_the_models_note_is_appended_not_substituted():
    note = compose_what_changed(
        **{**BASE, "confidence": 74.0},
        model_note="Two new independent sources landed in the last week.",
    )
    # The arithmetic is still there...
    assert "+6.0" in note
    # ...and the explanation follows it.
    assert note.endswith("Two new independent sources landed in the last week.")


def test_the_note_is_truthful_without_a_model():
    # A sweep whose model call failed still writes a WHAT_CHANGED that
    # describes the row, because the spine is composed from the columns.
    note = compose_what_changed(**{**BASE, "confidence": 74.0}, model_note=None)
    assert "strengthened" in note
    assert note.endswith(".")


def test_the_note_never_overflows_its_column():
    note = compose_what_changed(**{**BASE, "confidence": 74.0}, model_note="x" * 8000)
    assert len(note) <= MAX_LENGTHS["what_changed"]


def test_clause_order_puts_the_number_first_then_the_status_then_the_match():
    note = compose_what_changed(
        prior_confidence=66.0,
        confidence=92.0,
        prior_status="EXPIRED",
        status="RESOLVED_TRUE",
        status_reason="the observable check now reads TRUE inside the grace window",
        prior_trend_id=None,
        trend_id="abc",
    )
    assert note.index("Confidence") < note.index("Status moved") < note.index("white space")


def test_a_held_confidence_rides_alongside_a_real_movement_rather_than_leading_it():
    note = compose_what_changed(
        **{
            **BASE,
            "status": "EXPIRED",
            "status_reason": "the horizon passed",
        }
    )
    # The change leads...
    assert note.startswith("Status moved ACTIVE -> EXPIRED")
    # ...and the number that did not move is still reported.
    assert "Confidence held at 68.0" in note
