"""The sweep's local loop (CRMA-766): fixture-driven re-evaluation, no deploy.

``local_sweep.py`` is where the status machine and the re-evaluation prompt
iterate without a commit-to-deploy round trip. The shipped fixture is built
so one default run shows every state a live call can be in -- before the
horizon, inside the grace window, at the close (the one final row), and
already frozen -- which is exactly what a reader needs to see to believe AC4.
"""

from __future__ import annotations

import io
import json
from pathlib import Path

import pytest

import local_sweep

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def _run(*args) -> str:
    out = io.StringIO()
    assert local_sweep.run(list(args), out=out) == 0
    return out.getvalue()


def test_the_default_invocation_needs_no_key_no_network_and_no_warehouse():
    output = _run()
    assert "chain_id              pred-sweep-chain-" in output
    assert "(nothing was written" in output


def test_one_default_run_shows_every_state_a_live_call_can_be_in():
    output = _run()
    # Before the horizon: still ACTIVE.
    assert "STATUS             ACTIVE -> ACTIVE" in output
    # Past the horizon, inside the grace window, and the truth arrived.
    assert "STATUS             EXPIRED -> RESOLVED_TRUE" in output
    # At the close: one last row, and it says so rather than promising a
    # re-check nobody will run.
    assert "STATUS             EXPIRED -> EXPIRED" in output
    assert "This is the final evaluation of this call" in output
    # Already frozen -- its final row is in the ledger, so no row is appended.
    assert "SKIPPED" in output
    assert "grace window closed" in output
    assert "already in the ledger" in output


def test_the_grace_window_is_reported_for_every_re_evaluated_row():
    output = _run()
    assert output.count("GRACE ENDS AT") == 3


def test_the_frozen_horizon_is_labelled_as_such():
    output = _run()
    assert "HORIZON_AT         2027-02-14T00:00:00+00:00 (frozen)" in output


def test_the_confidence_direction_is_shown_and_is_derived():
    output = _run()
    assert "68.0 -> 74.0 (strengthened, delta 6.0)" in output


def test_what_changed_is_printed_for_every_row():
    output = _run()
    assert output.count("WHAT_CHANGED") == 3


def test_capped_scope_runs_a_single_prediction():
    output = _run("--prediction-id", "814a38cb-3935-4ce2-b640-b3154bfa84f4")
    assert "re-evaluated          1" in output
    # The scope goes into the read, so the other three are never looked at --
    # a capped-scope run says nothing about predictions it was not asked for.
    assert "predictions read      1" in output
    assert "skipped               0" in output


def test_a_capped_scope_id_that_matches_nothing_is_reported_not_silent():
    output = _run("--prediction-id", "no-such-prediction")
    assert "re-evaluated          0" in output
    assert "SKIPPED            no-such-prediction" in output
    assert "no live row was found" in output


def test_moving_the_clock_moves_a_prediction_across_its_horizon():
    # The whole reason --now exists: the status machine is a function of the
    # moment, and this is how that is inspected offline.
    before = _run("--now", "2027-02-13T00:00:00+00:00")
    assert "STATUS             ACTIVE -> ACTIVE" in before

    after = _run("--now", "2027-02-15T00:00:00+00:00")
    assert "STATUS             ACTIVE -> EXPIRED" in after
    assert "FINAL EVALUATION   False" in after


def test_moving_the_clock_past_the_grace_window_freezes_the_prediction():
    # 2027-02-14 + 180 days = 2027-08-13.
    output = _run("--now", "2027-08-14T00:00:00+00:00")
    assert "STATUS             ACTIVE -> EXPIRED" in output
    assert "FINAL EVALUATION   True" in output


def test_the_shipped_reply_fixture_is_the_shape_the_parser_reads():
    from prediction_service.sweep.parse import parse_reevaluations

    payload = (FIXTURES / "sweep_reply.sample.json").read_text()
    rows = json.loads((FIXTURES / "sweep_predictions.sample.json").read_text())
    answers = parse_reevaluations(
        payload,
        prediction_ids=[row["PREDICTION_ID"] for row in rows[:2]],
        subjects=["rucking vests", "probiotic nasal spray"],
    )
    assert set(answers) == {1, 2}
    assert answers[2].observation.outcome == "met"


def test_the_shipped_prediction_fixture_carries_the_ledgers_column_names():
    rows = json.loads((FIXTURES / "sweep_predictions.sample.json").read_text())
    for row in rows:
        for column in (
            "PREDICTION_ID",
            "SUBJECT_DESCRIPTOR",
            "DIRECTIONAL_CLAIM",
            "HORIZON_BAND",
            "HORIZON_AT",
            "OBSERVABLE_CHECK",
            "CONFIDENCE",
            "PREDICTION_STATUS",
            "EVIDENCE",
        ):
            assert column in row, f"{column} missing from {row.get('PREDICTION_ID')}"


def test_print_prompt_dumps_the_re_evaluation_instructions():
    output = _run("--print-prompt")
    assert "THE CLAIM IS FROZEN" in output


@pytest.mark.parametrize("moment", ["not-a-date", "2027-13-01"])
def test_a_nonsense_now_is_refused(moment):
    with pytest.raises(ValueError):
        local_sweep.parse_now(moment)
