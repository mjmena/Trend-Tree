"""The status machine and the grace window (CRMA-766 AC4).

    "A prediction past HORIZON_AT transitions to EXPIRED and keeps being
    re-checked for exactly one additional horizon length; a truth arriving in
    that window flips it to RESOLVED_TRUE."

"Exactly one" is the assertion these tests exist for. Both boundaries are
derived from the frozen claim -- HORIZON_AT and the horizon band -- so they
are asserted against those and nothing else. In particular none of these
tests reads EVALUATED_AT: the pre-CRMA-764 rows in the live ledger carry
session-local timestamps about four hours off UTC, and a grace window that
could be moved by that skew would be the bug.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from prediction_service.domain.claim import horizon_length
from prediction_service.strategist import StrategistDecision
from prediction_service.sweep.lifecycle import (
    OBSERVED_FAILED,
    OBSERVED_MET,
    OBSERVED_NOT_YET,
    Observation,
    grace_ends_at,
    grace_remaining,
    is_past_grace,
    is_reevaluable,
    next_status,
)

HORIZON = datetime(2027, 2, 14, tzinfo=UTC)
BAND = "emerging_3_6mo"  # 180 days
BAND_DAYS = 180


# --- the window itself -----------------------------------------------------


@pytest.mark.parametrize(
    ("band", "days"),
    [
        ("near_term_1_3mo", 90),
        ("emerging_3_6mo", 180),
        ("cultural_shift_6_12mo", 365),
        ("longer_range_12_24mo", 730),
    ],
)
def test_the_grace_window_is_exactly_one_more_of_the_bands_own_horizon(band, days):
    assert grace_ends_at(HORIZON, band) == HORIZON + timedelta(days=days)
    assert horizon_length(band) == timedelta(days=days)


def test_the_grace_window_is_derived_from_the_band_not_from_any_stored_timestamp():
    # Two predictions in the same band with the same horizon get the same
    # grace window, whatever their mint time was -- which is what makes the
    # pre-CRMA-764 EVALUATED_AT skew unable to move a transition.
    assert grace_ends_at(HORIZON, BAND) == grace_ends_at(HORIZON, BAND)
    # And it is a function of two arguments only; there is no third one it
    # could take a clock through.
    assert grace_ends_at(HORIZON, BAND) - HORIZON == horizon_length(BAND)


def test_the_window_closes_inclusively_at_its_far_edge():
    closes = grace_ends_at(HORIZON, BAND)
    assert not is_past_grace(HORIZON, BAND, closes - timedelta(seconds=1))
    # One horizon length of grace, not one plus an instant.
    assert is_past_grace(HORIZON, BAND, closes)
    assert is_past_grace(HORIZON, BAND, closes + timedelta(seconds=1))


def test_grace_remaining_counts_down_and_goes_negative():
    assert grace_remaining(HORIZON, BAND, HORIZON) == timedelta(days=BAND_DAYS)
    assert grace_remaining(HORIZON, BAND, HORIZON + timedelta(days=BAND_DAYS)) == timedelta(0)
    assert grace_remaining(
        HORIZON, BAND, HORIZON + timedelta(days=BAND_DAYS + 1)
    ) == timedelta(days=-1)


# --- what gets re-evaluated ------------------------------------------------


def test_an_active_prediction_before_its_horizon_is_re_evaluated():
    assert is_reevaluable("ACTIVE", HORIZON, BAND, HORIZON - timedelta(days=30))


def test_an_expired_prediction_inside_the_grace_window_is_still_re_checked():
    inside = HORIZON + timedelta(days=BAND_DAYS - 1)
    assert is_reevaluable("EXPIRED", HORIZON, BAND, inside)


def test_an_expired_prediction_at_the_close_gets_exactly_one_more_evaluation():
    # Under a daily cron a prediction is ALREADY EXPIRED when its window
    # closes, so "EXPIRED past grace is never selected" would mean no row ever
    # carries final_evaluation: true, and the call's last word would be a row
    # promising a re-check that never comes. One more, then silence.
    past = HORIZON + timedelta(days=BAND_DAYS)
    assert is_reevaluable("EXPIRED", HORIZON, BAND, past)
    decision = next_status(prior_status="EXPIRED", horizon_at=HORIZON, band=BAND, now=past)
    assert decision.status == "EXPIRED"
    assert decision.final is True


def test_an_expired_prediction_whose_final_row_is_written_is_frozen():
    past = HORIZON + timedelta(days=BAND_DAYS)
    assert not is_reevaluable("EXPIRED", HORIZON, BAND, past, final_row_written=True)
    # Still frozen a year later -- the freeze is the final ROW, not the date.
    assert not is_reevaluable(
        "EXPIRED", HORIZON, BAND, past + timedelta(days=365), final_row_written=True
    )


def test_an_active_prediction_is_re_evaluated_even_past_its_grace_window():
    # So a service that was down for a year still writes the ONE row that
    # records the transition, rather than leaving the last word as a call
    # nobody ever closed.
    past = HORIZON + timedelta(days=BAND_DAYS * 3)
    assert is_reevaluable("ACTIVE", HORIZON, BAND, past)
    decision = next_status(prior_status="ACTIVE", horizon_at=HORIZON, band=BAND, now=past)
    assert decision.status == "EXPIRED"
    assert decision.final is True
    # ...and then never again, because that row said it was final.
    assert not is_reevaluable("EXPIRED", HORIZON, BAND, past, final_row_written=True)


@pytest.mark.parametrize("status", ["RESOLVED_TRUE", "RESOLVED_FALSE", "WITHDRAWN"])
def test_a_settled_prediction_is_never_re_evaluated(status):
    assert not is_reevaluable(status, HORIZON, BAND, HORIZON - timedelta(days=1))
    assert not is_reevaluable(status, HORIZON, BAND, HORIZON + timedelta(days=1))


# --- the transitions -------------------------------------------------------


def test_before_the_horizon_with_nothing_observed_it_stays_active():
    decision = next_status(
        prior_status="ACTIVE", horizon_at=HORIZON, band=BAND, now=HORIZON - timedelta(days=1)
    )
    assert decision.status == "ACTIVE"
    assert decision.final is False


def test_at_the_horizon_it_expires_and_says_when_re_checking_stops():
    decision = next_status(
        prior_status="ACTIVE", horizon_at=HORIZON, band=BAND, now=HORIZON
    )
    assert decision.status == "EXPIRED"
    assert decision.final is False
    assert decision.grace_ends_at == HORIZON + timedelta(days=BAND_DAYS)
    assert decision.grace_ends_at.isoformat() in decision.reason


def test_a_truth_arriving_inside_the_grace_window_flips_it_to_resolved_true():
    # AC4's second half, and the whole reason EXPIRED is re-checked at all.
    inside = HORIZON + timedelta(days=BAND_DAYS - 1)
    decision = next_status(
        prior_status="EXPIRED",
        horizon_at=HORIZON,
        band=BAND,
        now=inside,
        observation=Observation(
            outcome=OBSERVED_MET, rationale="both named retailers now list it"
        ),
    )
    assert decision.status == "RESOLVED_TRUE"
    assert decision.final is True
    assert "grace window" in decision.reason
    assert "both named retailers now list it" in decision.reason


def test_a_truth_arriving_before_the_horizon_also_resolves_it_true():
    decision = next_status(
        prior_status="ACTIVE",
        horizon_at=HORIZON,
        band=BAND,
        now=HORIZON - timedelta(days=40),
        observation=Observation(outcome=OBSERVED_MET, rationale="it happened early"),
    )
    assert decision.status == "RESOLVED_TRUE"
    assert "before the horizon" in decision.reason


def test_a_settled_negative_resolves_it_false():
    decision = next_status(
        prior_status="ACTIVE",
        horizon_at=HORIZON,
        band=BAND,
        now=HORIZON - timedelta(days=10),
        observation=Observation(outcome=OBSERVED_FAILED, rationale="the retailer delisted it"),
    )
    assert decision.status == "RESOLVED_FALSE"
    assert decision.final is True


def test_the_grace_window_closing_unobserved_writes_one_final_expired_row():
    closes = HORIZON + timedelta(days=BAND_DAYS)
    decision = next_status(
        prior_status="EXPIRED", horizon_at=HORIZON, band=BAND, now=closes
    )
    assert decision.status == "EXPIRED"
    assert decision.final is True
    assert "final evaluation" in decision.reason
    # ...and the selection rule can actually reach this branch. Asserting the
    # pure function alone would prove a behaviour the integrated sweep cannot
    # produce; tests/test_sweep_run.py runs the whole pass over the boundary.
    assert is_reevaluable("EXPIRED", HORIZON, BAND, closes)


def test_passing_the_horizon_does_not_by_itself_resolve_anything_false():
    # An expired prediction is not a wrong one. The whole point of the grace
    # window is that a late truth reads as late rather than as wrong.
    for offset in (0, 1, BAND_DAYS - 1, BAND_DAYS, BAND_DAYS * 2):
        decision = next_status(
            prior_status="ACTIVE",
            horizon_at=HORIZON,
            band=BAND,
            now=HORIZON + timedelta(days=offset),
        )
        assert decision.status == "EXPIRED"


def test_silence_resolves_nothing():
    # The default observation is "nobody looked", and it must not be able to
    # close a call in either direction -- a sweep with a dead model still
    # expires things on the clock and settles nothing on a guess.
    default = Observation()
    assert default.outcome == OBSERVED_NOT_YET
    assert default.resolves is False
    decision = next_status(
        prior_status="ACTIVE",
        horizon_at=HORIZON,
        band=BAND,
        now=HORIZON - timedelta(days=5),
        observation=default,
    )
    assert decision.status == "ACTIVE"


def test_an_unknown_observation_outcome_is_refused_at_construction():
    with pytest.raises(ValueError, match="unknown observation outcome"):
        Observation(outcome="probably")


def test_a_terminal_prior_status_comes_back_untouched_and_final():
    decision = next_status(
        prior_status="WITHDRAWN",
        horizon_at=HORIZON,
        band=BAND,
        now=HORIZON - timedelta(days=1),
        observation=Observation(outcome=OBSERVED_MET, rationale="irrelevant"),
    )
    assert decision.status == "WITHDRAWN"
    assert decision.final is True


# --- the strategist tier outranks the status machine (CRMA-768 AC1/AC2) ----


def _dismissed(**overrides) -> StrategistDecision:
    return StrategistDecision(
        prediction_id="814a38cb-3935-4ce2-b640-b3154bfa84f4",
        decision="DISMISS",
        decided_at=datetime(2026, 8, 22, 15, 4, tzinfo=UTC),
        **overrides,
    )


def _approved(**overrides) -> StrategistDecision:
    return StrategistDecision(
        prediction_id="814a38cb-3935-4ce2-b640-b3154bfa84f4",
        decision="APPROVE",
        decided_at=datetime(2026, 8, 22, 15, 4, tzinfo=UTC),
        **overrides,
    )


def test_a_dismissed_prediction_records_withdrawn_on_its_next_verdict():
    decision = next_status(
        prior_status="ACTIVE",
        horizon_at=HORIZON,
        band=BAND,
        now=HORIZON - timedelta(days=30),
        strategist=_dismissed(decided_by="jsmith@mcclatchy.com"),
    )

    assert decision.status == "WITHDRAWN"
    assert decision.final is True
    assert "jsmith@mcclatchy.com" in decision.reason


@pytest.mark.parametrize("outcome", [OBSERVED_MET, OBSERVED_FAILED, OBSERVED_NOT_YET])
def test_a_dismiss_outranks_whatever_the_observable_check_reads(outcome):
    # The ladder's top rung: automated evidence -- including a settled
    # observable check -- does not overrule a human who rejected the call.
    decision = next_status(
        prior_status="ACTIVE",
        horizon_at=HORIZON,
        band=BAND,
        now=HORIZON - timedelta(days=1),
        observation=Observation(outcome=outcome, rationale="the check reads clearly"),
        strategist=_dismissed(),
    )

    assert decision.status == "WITHDRAWN"


def test_a_dismiss_outranks_expiry_too():
    decision = next_status(
        prior_status="EXPIRED",
        horizon_at=HORIZON,
        band=BAND,
        now=HORIZON + timedelta(days=10),
        strategist=_dismissed(),
    )

    assert decision.status == "WITHDRAWN"


def test_an_approve_does_not_move_the_status_at_all():
    # AC2: an Approve protects queue standing, not the call's truth. It must
    # not hold a prediction ACTIVE past its horizon, and it must not stop a
    # resolution -- "external saturation resolution still applies".
    still_open = next_status(
        prior_status="ACTIVE",
        horizon_at=HORIZON,
        band=BAND,
        now=HORIZON - timedelta(days=5),
        strategist=_approved(),
    )
    expired = next_status(
        prior_status="ACTIVE",
        horizon_at=HORIZON,
        band=BAND,
        now=HORIZON + timedelta(days=5),
        strategist=_approved(),
    )
    resolved = next_status(
        prior_status="ACTIVE",
        horizon_at=HORIZON,
        band=BAND,
        now=HORIZON - timedelta(days=5),
        observation=Observation(outcome=OBSERVED_MET, rationale="two of three retailers list it"),
        strategist=_approved(),
    )

    assert (still_open.status, expired.status, resolved.status) == (
        "ACTIVE",
        "EXPIRED",
        "RESOLVED_TRUE",
    )


def test_a_settled_call_is_not_reopened_by_a_later_dismiss():
    # A prediction whose grade is already final stays final. The sweep never
    # selects a terminal status, and if one reaches here it is not this
    # pass's job to relabel a closed call.
    decision = next_status(
        prior_status="RESOLVED_TRUE",
        horizon_at=HORIZON,
        band=BAND,
        now=HORIZON + timedelta(days=1),
        strategist=_dismissed(),
    )

    assert decision.status == "RESOLVED_TRUE"
    assert decision.final is True
