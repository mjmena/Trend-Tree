"""The precedence ladder: strategist action > coverage demotion > automated
evidence (CRMA-768 AC3).

``resolve_posture`` is pure and takes the coverage tier as an explicit
argument rather than reading ``EVIDENCE.coverage`` itself. Coverage detection
is CRMA-767's and lands on its own branch; the ladder is complete and
testable without it, and the only wiring left after that story merges is
passing ``coverage_demoted=`` at the one call site in sweep/run.py.

What the tests below pin is the *ordering*, one rung at a time, including
every case where a lower rung disagrees with a higher one.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from prediction_service.strategist import (
    POSTURE_ACT,
    POSTURE_WATCH_COVERED,
    POSTURE_WITHDRAWN,
    PRECEDENCE_LADDER,
    TIER_AUTOMATED_EVIDENCE,
    TIER_COVERAGE_DEMOTION,
    TIER_STRATEGIST_ACTION,
    StrategistDecision,
    resolve_posture,
    strategist_evidence,
)

DECIDED_AT = datetime(2026, 8, 22, 15, 4, tzinfo=UTC)
PREDICTION_ID = "814a38cb-3935-4ce2-b640-b3154bfa84f4"


def approve(**overrides) -> StrategistDecision:
    return StrategistDecision(
        prediction_id=PREDICTION_ID, decision="APPROVE", decided_at=DECIDED_AT, **overrides
    )


def dismiss(**overrides) -> StrategistDecision:
    return StrategistDecision(
        prediction_id=PREDICTION_ID, decision="DISMISS", decided_at=DECIDED_AT, **overrides
    )


# --- rung 3: automated evidence, when nothing above it speaks --------------


def test_with_no_human_action_and_no_coverage_the_automated_posture_stands():
    posture = resolve_posture(None, automated_posture=POSTURE_ACT)

    assert posture.posture == POSTURE_ACT
    assert posture.tier == TIER_AUTOMATED_EVIDENCE
    assert not posture.withdrawn
    assert not posture.protected


# --- rung 2: coverage demotion outranks automated evidence ----------------


def test_coverage_demotes_an_otherwise_actionable_call():
    posture = resolve_posture(None, coverage_demoted=True, automated_posture=POSTURE_ACT)

    assert posture.posture == POSTURE_WATCH_COVERED
    assert posture.tier == TIER_COVERAGE_DEMOTION


def test_coverage_only_ever_demotes_it_never_raises():
    # The one-way valve (strategy doc 7.3). A coverage detection on a call
    # the automated tier already reads as watch/covered leaves it there --
    # there is no direction in which coverage can move a posture up.
    posture = resolve_posture(
        None, coverage_demoted=True, automated_posture=POSTURE_WATCH_COVERED
    )

    assert posture.posture == POSTURE_WATCH_COVERED


# --- rung 1: strategist action outranks both ------------------------------


def test_an_approve_holds_act_standing_against_a_coverage_demotion():
    posture = resolve_posture(approve(), coverage_demoted=True, automated_posture=POSTURE_ACT)

    assert posture.posture == POSTURE_ACT
    assert posture.tier == TIER_STRATEGIST_ACTION
    assert posture.protected
    assert "coverage" in posture.reason


def test_an_approve_holds_act_standing_against_an_automated_demotion():
    posture = resolve_posture(approve(), automated_posture=POSTURE_WATCH_COVERED)

    assert posture.posture == POSTURE_ACT
    assert posture.tier == TIER_STRATEGIST_ACTION
    assert posture.protected


def test_a_dismiss_withdraws_the_call_whatever_the_lower_tiers_say():
    posture = resolve_posture(dismiss(), coverage_demoted=True, automated_posture=POSTURE_ACT)

    assert posture.posture == POSTURE_WITHDRAWN
    assert posture.tier == TIER_STRATEGIST_ACTION
    assert posture.withdrawn
    assert not posture.protected


def test_the_reason_names_the_human_and_when_they_acted():
    # AC3's "precedence is observable": the reason reaches WHAT_CHANGED and
    # EVIDENCE.strategist, so it has to say which decision won and when.
    posture = resolve_posture(approve(decided_by="jsmith@mcclatchy.com"))

    assert "jsmith@mcclatchy.com" in posture.reason
    assert DECIDED_AT.isoformat() in posture.reason


def test_protection_is_not_permanent_a_later_dismiss_replaces_the_approve():
    # "Until the next human touch" is enforced by only ever resolving the
    # LATEST decision -- there is no stored protection flag to expire.
    later = StrategistDecision(
        prediction_id=PREDICTION_ID,
        decision="DISMISS",
        decided_at=datetime(2026, 8, 23, 9, 0, tzinfo=UTC),
    )

    assert resolve_posture(later).withdrawn


# --- the vocabulary is closed ---------------------------------------------


def test_an_unknown_automated_posture_is_refused():
    with pytest.raises(ValueError, match="unknown posture"):
        resolve_posture(None, automated_posture="act_now")


def test_an_unknown_decision_is_refused_at_construction():
    with pytest.raises(ValueError, match="unknown strategist decision"):
        StrategistDecision(prediction_id="p1", decision="MAYBE", decided_at=DECIDED_AT)


# --- the evidence payload agrees with the ladder --------------------------


def test_the_evidence_records_a_coverage_demotion_a_human_overruled():
    # The failure this test exists for: deriving `coverage_demoted` back out
    # of the settled tier reads FALSE in exactly this case -- an Approve wins,
    # so the tier is strategist_action -- and the row would then claim a human
    # overruled a demotion that it also says never happened.
    posture = resolve_posture(approve(), coverage_demoted=True)

    payload = strategist_evidence(approve(), posture, coverage_demoted=True)

    assert payload["coverage_demoted"] is True
    assert payload["protected_from_demotion"] is True
    assert payload["precedence_tier"] == TIER_STRATEGIST_ACTION
    assert payload["posture"] == POSTURE_ACT


def test_the_evidence_records_a_coverage_demotion_nobody_overruled():
    posture = resolve_posture(None, coverage_demoted=True)

    payload = strategist_evidence(None, posture, coverage_demoted=True)

    assert payload["coverage_demoted"] is True
    assert payload["protected_from_demotion"] is False
    assert payload["posture"] == POSTURE_WATCH_COVERED
    assert payload["precedence_tier"] == TIER_COVERAGE_DEMOTION


def test_the_ladder_is_named_on_every_row():
    payload = strategist_evidence(None, resolve_posture(None))

    assert payload["precedence"] == PRECEDENCE_LADDER
    assert payload["calibration_label"] is None
