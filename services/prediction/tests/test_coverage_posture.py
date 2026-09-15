"""The demote-only one-way valve (CRMA-767 AC3, AC4).

``coverage_demotes`` is the seam CRMA-768's precedence ladder imports, so
this file is as much its contract as its test: what it takes, what it can
return, and the two directions it must never move in.
"""

from __future__ import annotations

import inspect

import pytest

from prediction_service.coverage import (
    POSTURE_ACT,
    POSTURE_WATCH_COVERED,
    CoverageDetection,
    CoverageReading,
    ExternalDemand,
    coverage_demotes,
    posture_for,
)
from prediction_service.coverage.posture import DIRECTION_STRENGTHENED
from prediction_service.sweep.direction import STRENGTHENED, UNCHANGED, WEAKENED

SUBJECT = "protein coffee"

STORY = CoverageDetection(
    headline="Protein coffee: How the trending drink is changing the way Americans fuel "
    "their mornings",
    similarity=0.8172,
    content_id="316520398",
    first_published_date="2026-07-15",
    last_published_date="2026-07-15",
)


def covered(**overrides) -> CoverageReading:
    return CoverageReading(
        subject=SUBJECT, available=True, detections=(STORY,), **overrides
    )


def looked_and_found_nothing() -> CoverageReading:
    return CoverageReading(subject=SUBJECT, available=True, detections=())


def could_not_look() -> CoverageReading:
    return CoverageReading(subject=SUBJECT, available=False, miss_reason="outage")


# --- the demotion itself ---------------------------------------------------


def test_detected_coverage_demotes_a_prediction_with_no_external_demand():
    assert coverage_demotes(covered()) is True
    assert posture_for(covered()) == POSTURE_WATCH_COVERED


def test_a_subject_we_have_not_covered_changes_nothing():
    assert coverage_demotes(looked_and_found_nothing()) is False
    assert posture_for(looked_and_found_nothing()) == POSTURE_ACT


@pytest.mark.parametrize(
    "reading",
    [None, could_not_look()],
    ids=["no reading at all", "we could not look"],
)
def test_not_knowing_is_not_a_reason_to_demote(reading):
    # A detector that was never wired, or a warehouse that did not answer,
    # must not read as "we have covered this".
    assert coverage_demotes(reading) is False
    assert posture_for(reading) == POSTURE_ACT


# --- AC4: external demand re-raises ---------------------------------------


def test_rising_external_demand_re_raises_a_covered_prediction():
    demand = ExternalDemand(confidence_direction=STRENGTHENED, confidence_delta=6.0)
    assert coverage_demotes(covered(), demand=demand) is False
    assert posture_for(covered(), demand=demand) == POSTURE_ACT


@pytest.mark.parametrize("direction", [UNCHANGED, WEAKENED, "", "first_evaluation"])
def test_only_a_strengthening_call_re_raises(direction):
    # The world holding steady, or cooling, is exactly the case coverage is
    # meant to demote.
    demand = ExternalDemand(confidence_direction=direction)
    assert coverage_demotes(covered(), demand=demand) is True


def test_external_demand_cannot_raise_a_prediction_we_never_covered():
    # The valve is one-way in both senses: rising demand on an uncovered
    # subject is not this module's business, and it still answers "I change
    # nothing".
    demand = ExternalDemand(confidence_direction=STRENGTHENED, confidence_delta=9.0)
    assert coverage_demotes(looked_and_found_nothing(), demand=demand) is False
    assert posture_for(looked_and_found_nothing(), demand=demand) == POSTURE_ACT


def test_the_direction_vocabulary_matches_the_sweeps_own():
    # posture.py spells the string rather than importing it (sweep imports
    # coverage, and the reverse would close the cycle). If sweep/direction.py
    # ever renames it, the re-raise leg would silently stop working -- this
    # is the drift guard.
    assert DIRECTION_STRENGTHENED == STRENGTHENED


# --- AC3: the valve is structurally incapable of raising confidence -------


def test_the_valve_returns_a_boolean_and_nothing_a_confidence_could_be_made_of():
    for demand in (None, ExternalDemand(confidence_direction=STRENGTHENED)):
        for reading in (None, could_not_look(), looked_and_found_nothing(), covered()):
            assert isinstance(coverage_demotes(reading, demand=demand), bool)
            assert posture_for(reading, demand=demand) in (
                POSTURE_ACT,
                POSTURE_WATCH_COVERED,
            )


def test_the_valve_is_pure_no_client_no_model_no_clock():
    # The property CRMA-768 is entitled to rely on: it can call this from
    # inside a precedence ladder without acquiring an I/O dependency.
    parameters = inspect.signature(coverage_demotes).parameters
    assert list(parameters) == ["reading", "demand"]
    source = inspect.getsource(coverage_demotes)
    for forbidden in ("client", "query", "llm", "complete(", "datetime", "now("):
        assert forbidden not in source
