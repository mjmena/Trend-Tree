"""The strategist tier through POST /sweep -- the primary seam (CRMA-768).

The PRD's testing decision is "fire the authenticated HTTP trigger, then
assert on what reached the ledger", so every acceptance criterion that is
about the pillar's *behaviour* is asserted here on the row the sweep wrote,
not on an intermediate object:

* **AC1** -- a Dismissed prediction's next verdict is ``WITHDRAWN``, it stops
  being re-evaluated after that, and CRMA-771's track-record derivation
  already excludes the status.
* **AC2** -- an Approved prediction is not demoted by coverage or by
  automated evidence, and still resolves on its observable check.
* **AC3** -- ``EVIDENCE.strategist`` records which rung of the ladder settled
  the posture, so precedence is observable in the ledger.
* **AC4** -- the decision is retained as a calibration label, with its
  prediction id and timestamp, in its own table.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from prediction_service.app import create_app
from prediction_service.config import settings_from_env
from prediction_service.strategist import (
    LABEL_TABLE,
    POSTURE_ACT,
    POSTURE_WITHDRAWN,
    TIER_AUTOMATED_EVIDENCE,
    TIER_STRATEGIST_ACTION,
    StaticStrategistDecisionReader,
    StrategistDecision,
    UnavailableDecisionReader,
)

from .matching_fakes import open_prediction_row
from .sweep_fakes import SweepLedgerSimulator, SweepLLM, reevaluation_reply

SERVICE_URL = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"
AUTH_HEADERS = {"Authorization": "Bearer good"}

FIRST = "814a38cb-3935-4ce2-b640-b3154bfa84f4"
SECOND = "b6a1f0d2-4c3e-4b7a-9f11-2d8c5e6a7b40"
DECIDED_AT = datetime(2026, 8, 22, 15, 4, tzinfo=UTC)


def _verify_ok(token: str, audience: str) -> dict:
    return {
        "email": "caller@x.iam.gserviceaccount.com",
        "aud": audience,
        "iss": "https://accounts.google.com",
    }


def _client(snowflake, llm=None, decisions=None) -> TestClient:
    settings = settings_from_env({"PREDICTION_SERVICE_AUDIENCE": SERVICE_URL})
    return TestClient(
        create_app(
            settings=settings,
            snowflake=snowflake,
            verify_token=_verify_ok,
            llm=llm,
            decisions=decisions,
        )
    )


def _horizon(days_from_now: float) -> str:
    moment = datetime.now(UTC) + timedelta(days=days_from_now)
    return moment.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def _ledger(*rows: dict) -> SweepLedgerSimulator:
    return SweepLedgerSimulator(rows=[dict(row) for row in rows])


def _row(prediction_id: str = FIRST, **overrides) -> dict:
    row = open_prediction_row(prediction_id=prediction_id, **overrides)
    row["HORIZON_AT"] = _horizon(60)
    return row


def _decision(prediction_id: str, action: str, **overrides) -> StrategistDecision:
    overrides.setdefault("decided_at", DECIDED_AT)
    return StrategistDecision(prediction_id=prediction_id, decision=action, **overrides)


def _reader(*decisions: StrategistDecision) -> StaticStrategistDecisionReader:
    return StaticStrategistDecisionReader(decisions=list(decisions))


def _written(ledger: SweepLedgerSimulator, prediction_id: str) -> dict:
    """The row this sweep appended for one prediction."""
    rows = [
        call.params
        for call in ledger.writes
        if call.params.get("prediction_id") == prediction_id
        and "subject_descriptor" in call.params
    ]
    assert rows, f"no verdict row was written for {prediction_id}"
    return rows[-1]


def _strategist_evidence(params: dict) -> dict:
    return json.loads(params["evidence"])["strategist"]


def _labels(ledger: SweepLedgerSimulator) -> list[dict]:
    return [call.params for call in ledger.writes if LABEL_TABLE in call.sql.upper()]


def _sweep(client, **body):
    body.setdefault("skip_generation", True)
    resp = client.post("/sweep", json=body, headers=AUTH_HEADERS)
    assert resp.status_code == 200, resp.text
    return resp.json()


# --- AC1: Dismiss withdraws the call --------------------------------------


def test_a_dismissed_prediction_writes_a_withdrawn_verdict():
    ledger = _ledger(_row())
    client = _client(ledger, decisions=_reader(_decision(FIRST, "DISMISS")))

    body = _sweep(client)

    assert [r["status"] for r in body["results"]] == ["WITHDRAWN"]
    assert _written(ledger, FIRST)["status"] == "WITHDRAWN"


def test_a_withdrawn_call_is_not_re_evaluated_on_the_next_run():
    # AC1's "it exits the queue": WITHDRAWN is terminal, so the next sweep
    # does not even read it as live.
    ledger = _ledger(_row())
    client = _client(ledger, decisions=_reader(_decision(FIRST, "DISMISS")))

    _sweep(client)
    second = _sweep(client)

    assert second["reevaluated"] == 0
    assert second["predictions_read"] == 0


def test_a_dismiss_beats_an_observable_check_that_just_came_true():
    # The precedence ladder's top rung, at the seam: a model that says the
    # claim is met does not overrule a human who rejected the call.
    ledger = _ledger(_row())
    llm = SweepLLM(
        reevaluation_reply=reevaluation_reply(
            {
                "id": 1,
                "prediction_id": FIRST,
                "subject": "rucking vests",
                "observable_check": "met",
                "observation": "both retailers now list a house label",
                "confidence": 91.0,
                "reasoning": "The claim has arrived.",
                "what_changed": "Two listings appeared.",
            }
        )
    )
    client = _client(ledger, llm=llm, decisions=_reader(_decision(FIRST, "DISMISS")))

    _sweep(client)

    assert _written(ledger, FIRST)["status"] == "WITHDRAWN"


def test_the_withdrawal_names_the_human_in_what_changed():
    ledger = _ledger(_row())
    client = _client(
        ledger,
        decisions=_reader(_decision(FIRST, "DISMISS", decided_by="jsmith@mcclatchy.com")),
    )

    _sweep(client)

    assert "jsmith@mcclatchy.com" in _written(ledger, FIRST)["what_changed"]


# --- AC2: Approve protects standing, not truth ----------------------------


def test_an_approved_prediction_holds_act_standing():
    ledger = _ledger(_row())
    client = _client(ledger, decisions=_reader(_decision(FIRST, "APPROVE")))

    body = _sweep(client)

    assert body["results"][0]["posture"] == POSTURE_ACT
    assert body["results"][0]["posture_tier"] == TIER_STRATEGIST_ACTION
    assert _strategist_evidence(_written(ledger, FIRST))["posture"] == POSTURE_ACT


def test_an_approve_does_not_stop_the_call_resolving_on_its_own_check():
    # "External saturation resolution still applies (verdict-driven)."
    ledger = _ledger(_row())
    llm = SweepLLM(
        reevaluation_reply=reevaluation_reply(
            {
                "id": 1,
                "prediction_id": FIRST,
                "subject": "rucking vests",
                "observable_check": "met",
                "observation": "both retailers now list a house label",
                "confidence": 91.0,
                "reasoning": "The claim has arrived.",
                "what_changed": "Two listings appeared.",
            }
        )
    )
    client = _client(ledger, llm=llm, decisions=_reader(_decision(FIRST, "APPROVE")))

    _sweep(client)

    assert _written(ledger, FIRST)["status"] == "RESOLVED_TRUE"


def test_an_approve_does_not_hold_a_call_past_its_horizon():
    row = _row()
    row["HORIZON_AT"] = _horizon(-3)
    ledger = _ledger(row)
    client = _client(ledger, decisions=_reader(_decision(FIRST, "APPROVE")))

    _sweep(client)

    assert _written(ledger, FIRST)["status"] == "EXPIRED"


# --- AC3: the ladder is observable in the ledger --------------------------


def test_an_untouched_call_records_the_automated_tier():
    ledger = _ledger(_row())
    client = _client(ledger, decisions=_reader())

    _sweep(client)

    evidence = _strategist_evidence(_written(ledger, FIRST))
    assert evidence["decision"] is None
    assert evidence["posture"] == POSTURE_ACT
    assert evidence["precedence_tier"] == TIER_AUTOMATED_EVIDENCE
    assert evidence["precedence"] == (
        "strategist action > coverage demotion > automated evidence"
    )
    assert evidence["source"]["available"] is True


def test_a_withdrawn_row_records_the_strategist_tier_and_the_decision():
    ledger = _ledger(_row())
    client = _client(
        ledger,
        decisions=_reader(_decision(FIRST, "DISMISS", decided_by="jsmith@mcclatchy.com")),
    )

    _sweep(client)

    evidence = _strategist_evidence(_written(ledger, FIRST))
    assert evidence["posture"] == POSTURE_WITHDRAWN
    assert evidence["precedence_tier"] == TIER_STRATEGIST_ACTION
    assert evidence["decision"]["prediction_id"] == FIRST
    assert evidence["decision"]["decided_at"] == DECIDED_AT.isoformat()


def test_an_unreachable_decision_source_says_so_rather_than_reading_as_no_action():
    ledger = _ledger(_row())
    client = _client(ledger, decisions=UnavailableDecisionReader())

    _sweep(client)

    source = _strategist_evidence(_written(ledger, FIRST))["source"]
    assert source["available"] is False
    assert "has not been provisioned" in source["unavailable_reason"]


# --- the binding: a decision reaches only the call it names ---------------


def test_two_live_calls_get_their_own_decisions():
    ledger = _ledger(_row(FIRST), _row(SECOND, subject="probiotic nasal spray"))
    client = _client(ledger, decisions=_reader(_decision(SECOND, "DISMISS")))

    _sweep(client)

    assert _written(ledger, FIRST)["status"] == "ACTIVE"
    assert _written(ledger, SECOND)["status"] == "WITHDRAWN"


def test_two_live_calls_sharing_a_subject_are_still_told_apart():
    # The subject descriptor is not a key. Binding is by PREDICTION_ID only.
    ledger = _ledger(_row(FIRST), _row(SECOND))
    client = _client(ledger, decisions=_reader(_decision(SECOND, "DISMISS")))

    _sweep(client)

    assert _written(ledger, FIRST)["status"] == "ACTIVE"
    assert _written(ledger, SECOND)["status"] == "WITHDRAWN"


# --- AC4: the decision is retained as a calibration label -----------------


def test_every_decision_read_is_retained_as_a_calibration_label():
    ledger = _ledger(_row())
    client = _client(
        ledger,
        decisions=_reader(
            _decision(FIRST, "APPROVE", decided_by="jsmith@mcclatchy.com", observed_confidence=68.0)
        ),
    )

    body = _sweep(client)

    labels = _labels(ledger)
    assert len(labels) == 1
    assert labels[0]["prediction_id"] == FIRST
    assert labels[0]["decision"] == "APPROVE"
    assert labels[0]["decided_at"] == DECIDED_AT
    assert labels[0]["decided_by"] == "jsmith@mcclatchy.com"
    assert labels[0]["observed_confidence"] == 68.0
    assert body["calibration_labels_written"] == 1


def test_a_standing_decision_re_read_daily_does_not_append_a_label_per_day():
    ledger = _ledger(_row())
    client = _client(ledger, decisions=_reader(_decision(FIRST, "APPROVE")))

    _sweep(client)
    _sweep(client)

    assert len({label["label_id"] for label in _labels(ledger)}) == 1


def test_a_changed_mind_is_retained_as_a_second_label():
    # The tier keeps the whole sequence of human judgements -- that is what a
    # later calibration pass is fit against.
    ledger = _ledger(_row())
    client = _client(ledger, decisions=_reader(_decision(FIRST, "APPROVE")))
    _sweep(client)

    later = _client(
        ledger,
        decisions=_reader(
            _decision(FIRST, "DISMISS", decided_at=datetime(2026, 8, 23, 9, 0, tzinfo=UTC))
        ),
    )
    _sweep(later)

    ids = {label["label_id"] for label in _labels(ledger)}
    assert len(ids) == 2


def test_no_decision_means_no_label_row():
    ledger = _ledger(_row())
    client = _client(ledger, decisions=_reader())

    _sweep(client)

    assert _labels(ledger) == []


def test_a_failed_label_write_does_not_cost_the_sweep_its_verdict_rows():
    # The verdicts are the pillar's output; the labels are for a tuning pass
    # that has not happened yet. Losing the second must never lose the first.
    ledger = _ledger(_row())
    ledger.fail_labels_with = RuntimeError("permission denied on the label table")
    client = _client(ledger, decisions=_reader(_decision(FIRST, "APPROVE")))

    body = _sweep(client)

    assert body["verdicts_written"] == 1
    assert "calibration label" in body["calibration_label_note"]


@pytest.mark.parametrize("action", ["APPROVE", "DISMISS"])
def test_the_label_carries_the_pillars_own_reading_at_the_time(action):
    ledger = _ledger(_row(confidence=68.0))
    client = _client(ledger, decisions=_reader(_decision(FIRST, action)))

    _sweep(client)

    label = _labels(ledger)[0]
    assert label["verdict_confidence"] == 68.0
    assert label["verdict_status"] == ("WITHDRAWN" if action == "DISMISS" else "ACTIVE")
