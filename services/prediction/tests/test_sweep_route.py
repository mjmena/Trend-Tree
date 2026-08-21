"""POST /sweep end to end -- the daily run (CRMA-766 AC1, AC2, AC3, AC4).

The PRD's primary seam: fire the authenticated HTTP trigger, then assert on
what reached the ledger. This is also where the "a scheduled run needs no
human action" criterion is testable in-process -- a scheduled fire and a
manual fire are the same request with the same body, so what is asserted here
is exactly what Cloud Scheduler will get.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from prediction_service.app import create_app
from prediction_service.config import settings_from_env
from prediction_service.domain.claim import REQUIRED_EVIDENCE_KEYS

from .matching_fakes import open_prediction_row
from .sweep_fakes import SweepLedgerSimulator, SweepLLM, reevaluation_reply

SERVICE_URL = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"
AUTH_HEADERS = {"Authorization": "Bearer good"}
GOOGLE_ISSUER = "https://accounts.google.com"

HORIZON = datetime(2027, 2, 14, tzinfo=UTC)

ANSWER = {
    "id": 1,
    "subject": "rucking vests",
    "observable_check": "not_yet",
    "observation": "no house-label listing has appeared at any of the three retailers",
    "confidence": 74.0,
    "reasoning": "The behaviour keeps widening past the fitness-specialist audience.",
    "what_changed": "Two more independent sources landed this week.",
}


def _verify_ok(token: str, audience: str) -> dict:
    return {"email": "caller@x.iam.gserviceaccount.com", "aud": audience, "iss": GOOGLE_ISSUER}


def _client(snowflake, llm=None) -> TestClient:
    settings = settings_from_env({"PREDICTION_SERVICE_AUDIENCE": SERVICE_URL})
    return TestClient(
        create_app(settings=settings, snowflake=snowflake, verify_token=_verify_ok, llm=llm)
    )


def _ledger(*rows: dict) -> SweepLedgerSimulator:
    return SweepLedgerSimulator(rows=[dict(row) for row in rows])


#: The route evaluates at the real ``datetime.now(UTC)`` -- it has no clock to
#: inject, deliberately, because a production route that took "now" from the
#: request would be a production route that could be asked to re-evaluate the
#: past. So the lifecycle tests below place HORIZON_AT relative to the real
#: clock instead. A fixed date would work for a while and then quietly stop
#: testing what it says it tests.
def _horizon(days_from_now: float) -> str:
    moment = datetime.now(UTC) + timedelta(days=days_from_now)
    return moment.strftime("%Y-%m-%d %H:%M:%S.%f")[:-3]


def _as_utc(raw) -> datetime:
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=UTC)
    return datetime.fromisoformat(str(raw)).replace(tzinfo=UTC)


# --- the request itself ----------------------------------------------------


def test_an_unauthenticated_sweep_is_refused():
    resp = TestClient(
        create_app(
            settings=settings_from_env({"PREDICTION_SERVICE_AUDIENCE": SERVICE_URL}),
            snowflake=_ledger(),
            verify_token=_verify_ok,
        )
    ).post("/sweep", json={})
    assert resp.status_code == 401


def test_a_manual_fire_with_an_empty_body_runs_the_whole_sweep():
    # AC1's manual half: no arguments needed. The scheduled job sends a body
    # with the same defaults spelled out.
    ledger = _ledger(open_prediction_row())
    resp = _client(ledger, SweepLLM(reevaluation_reply=reevaluation_reply(ANSWER))).post(
        "/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["reevaluated"] == 1
    assert body["verdicts_written"] == 1


def test_capped_scope_leaves_the_rest_of_the_world_alone():
    # PRD user story 24: "a single-trend / capped-scope run mode, so that a
    # test run is cheap and doesn't re-evaluate the world."
    keep = open_prediction_row(prediction_id="keep-me")
    other = open_prediction_row(prediction_id="leave-me", subject="probiotic nasal spray")
    ledger = _ledger(keep, other)

    resp = _client(ledger, SweepLLM()).post(
        "/sweep",
        json={"prediction_ids": ["keep-me"], "skip_generation": True},
        headers=AUTH_HEADERS,
    )

    body = resp.json()
    assert [r["prediction_id"] for r in body["results"]] == ["keep-me"]
    assert [s["prediction_id"] for s in body["skipped"]] == ["leave-me"]
    assert body["verdicts_written"] == 1


def test_a_dry_run_writes_nothing():
    ledger = _ledger(open_prediction_row())
    before = len(ledger.rows)
    resp = _client(ledger, SweepLLM()).post(
        "/sweep", json={"dry_run": True, "skip_generation": True}, headers=AUTH_HEADERS
    )
    assert resp.json()["verdicts_written"] == 0
    assert len(ledger.rows) == before
    assert ledger.writes == []


# --- what lands in the ledger ---------------------------------------------


def test_the_appended_row_keeps_the_claim_and_carries_the_contracted_evidence():
    ledger = _ledger(open_prediction_row())
    _client(ledger, SweepLLM(reevaluation_reply=reevaluation_reply(ANSWER))).post(
        "/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS
    )

    (write,) = ledger.writes
    bound = write.params
    original = open_prediction_row()
    assert bound["subject_descriptor"] == original["SUBJECT_DESCRIPTOR"]
    assert bound["directional_claim"] == original["DIRECTIONAL_CLAIM"]
    assert bound["observable_check"] == original["OBSERVABLE_CHECK"]
    assert bound["horizon_at"] == HORIZON
    evidence = json.loads(bound["evidence"])
    for key in REQUIRED_EVIDENCE_KEYS:
        assert key in evidence


def test_three_successive_sweeps_append_three_rows_with_one_claim_between_them():
    # AC2 at the HTTP seam: the ledger simulator actually appends, so this is
    # three real rows read back.
    ledger = _ledger(open_prediction_row())
    client = _client(ledger, SweepLLM(reevaluation_reply=reevaluation_reply(ANSWER)))
    for _ in range(3):
        assert (
            client.post(
                "/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS
            ).status_code
            == 200
        )

    rows = [dict(row) for row in ledger.rows]
    assert len(rows) == 4  # the seed row plus three evaluations
    assert len({row["PREDICTION_ID"] for row in rows}) == 1
    assert len({row["PREDICTION_EVAL_ID"] for row in rows}) == 4
    for column in ("SUBJECT_DESCRIPTOR", "DIRECTIONAL_CLAIM", "OBSERVABLE_CHECK"):
        assert len({row[column] for row in rows}) == 1, column
    # HORIZON_AT survives the round trip through the write and back through
    # the read as the same instant.
    # Normalized the way the reader normalizes them: the seed row holds the
    # warehouse's string form, the appended rows hold the datetime the service
    # bound. Same instant is the assertion, not same repr.
    assert len({_as_utc(row["HORIZON_AT"]) for row in rows}) == 1


def test_what_changed_is_written_on_every_re_evaluation():
    # AC3 at the seam.
    ledger = _ledger(open_prediction_row(confidence=68.0))
    _client(ledger, SweepLLM(reevaluation_reply=reevaluation_reply(ANSWER))).post(
        "/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS
    )
    (write,) = ledger.writes
    note = write.params["what_changed"]
    assert note
    assert "68.0" in note and "74.0" in note
    assert "Two more independent sources landed this week." in note


def test_the_response_reports_a_derived_direction_that_is_in_no_column():
    ledger = _ledger(open_prediction_row(confidence=68.0))
    resp = _client(ledger, SweepLLM(reevaluation_reply=reevaluation_reply(ANSWER))).post(
        "/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS
    )
    (result,) = resp.json()["results"]
    assert result["confidence_direction"] == "strengthened"
    assert result["confidence_delta"] == 6.0
    # ...and nothing of the sort was bound.
    (write,) = ledger.writes
    assert not [k for k in write.params if k.startswith("confidence_d")]


# --- the lifecycle, at the seam -------------------------------------------


def test_a_prediction_past_its_horizon_expires_and_keeps_being_re_checked():
    # AC4. The band is emerging_3_6mo (180 days), so a horizon 30 days behind
    # us leaves 150 days of grace: expired, and still being re-checked.
    row = open_prediction_row()
    row["HORIZON_AT"] = _horizon(-30)
    ledger = _ledger(row)
    client = _client(ledger, SweepLLM())

    resp = client.post("/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS)
    (result,) = resp.json()["results"]
    assert result["status"] == "EXPIRED"
    assert result["final"] is False
    expected = _as_utc(row["HORIZON_AT"]) + timedelta(days=180)
    assert _as_utc(result["grace_ends_at"]) == expected

    # ...and the next sweep picks it up again, because EXPIRED-in-grace is
    # still live.
    again = client.post("/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS)
    assert again.json()["reevaluated"] == 1


def test_a_truth_arriving_in_the_grace_window_flips_it_to_resolved_true():
    row = open_prediction_row(status="EXPIRED")
    row["HORIZON_AT"] = _horizon(-30)
    ledger = _ledger(row)
    answer = {
        **ANSWER,
        "observable_check": "met",
        "observation": "house-label listings are live at Target and Walmart",
    }
    resp = _client(ledger, SweepLLM(reevaluation_reply=reevaluation_reply(answer))).post(
        "/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS
    )
    (result,) = resp.json()["results"]
    assert result["prior_status"] == "EXPIRED"
    assert result["status"] == "RESOLVED_TRUE"
    assert result["final"] is True
    assert "grace window" in result["what_changed"]


def test_a_prediction_past_its_grace_window_is_never_written_again():
    row = open_prediction_row(status="EXPIRED")
    # 400 days past a 180-day band: the grace window closed 220 days ago.
    row["HORIZON_AT"] = _horizon(-400)
    ledger = _ledger(row)
    resp = _client(ledger, SweepLLM()).post(
        "/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS
    )
    body = resp.json()
    assert body["reevaluated"] == 0
    assert body["verdicts_written"] == 0
    assert len(body["skipped"]) == 1
    assert ledger.writes == []


def test_a_resolved_prediction_is_not_read_back_by_the_next_sweep():
    row = open_prediction_row(status="EXPIRED")
    row["HORIZON_AT"] = _horizon(-30)
    ledger = _ledger(row)
    answer = {**ANSWER, "observable_check": "met", "observation": "it happened"}
    client = _client(ledger, SweepLLM(reevaluation_reply=reevaluation_reply(answer)))

    assert client.post(
        "/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS
    ).json()["resolved"] == 1
    # The next sweep sees a RESOLVED_TRUE latest row and leaves it alone.
    assert client.post(
        "/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS
    ).json()["reevaluated"] == 0


# --- the generation pass ---------------------------------------------------


GENERATION_REPLY = json.dumps(
    {
        "predictions": [
            {
                "subject_descriptor": "cottage cheese ice cream",
                "directional_claim": "supermarket freezer aisles stock a branded version",
                "horizon_band": "emerging_3_6mo",
                "observable_check": "a national brand lists it in two grocery chains",
                "confidence": 55,
                "reasoning": "Three independent sources describe the same home preparation.",
                "source_signals": ["bluesky:1"],
            }
        ]
    }
)

SIGNAL_ROWS = [
    {
        "SIGNAL_ID": "bluesky:1",
        "SIGNAL_TITLE": "cottage cheese ice cream everywhere",
        "SIGNAL_TEXT": "People keep posting the same blender recipe and the same brand tags, "
        "and the comments are full of people saying they made it this week too.",
        "SOURCE_NAME": "bluesky",
        "SIGNAL_TIMESTAMP": "2026-08-01 00:00:00.000",
        "CATEGORY": "food",
    }
]


def test_the_daily_run_re_evaluates_and_generates_in_one_request():
    ledger = SweepLedgerSimulator(rows=[open_prediction_row()], signals=list(SIGNAL_ROWS))
    resp = _client(
        ledger,
        SweepLLM(
            reevaluation_reply=reevaluation_reply(ANSWER),
            generation_reply=GENERATION_REPLY,
        ),
    ).post("/sweep", json={}, headers=AUTH_HEADERS)

    body = resp.json()
    assert body["reevaluated"] == 1
    assert body["generation_ran"] is True
    assert body["predictions_minted"] == 1
    assert body["generated"][0]["subject_descriptor"] == "cottage cheese ice cream"
    # Both passes wrote through the same ledger, under one chain.
    assert len(ledger.writes) == 2


def test_a_failing_generation_pass_does_not_lose_the_sweeps_rows():
    class Exploding(SweepLedgerSimulator):
        def query(self, sql, params=None):
            if "FCT_SIGNALS" in sql.upper() and "FCT_PREDICTION_VERDICT_LEDGER" not in sql.upper():
                raise RuntimeError("corpus read timed out")
            return super().query(sql, params)

    ledger = Exploding(rows=[open_prediction_row()])
    resp = _client(
        ledger, SweepLLM(reevaluation_reply=reevaluation_reply(ANSWER))
    ).post("/sweep", json={}, headers=AUTH_HEADERS)

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["verdicts_written"] == 1
    assert body["generation_ran"] is False
    assert "generation pass failed" in body["generation_note"]


def test_no_gemini_key_still_sweeps_and_says_why_it_did_not_generate():
    ledger = _ledger(open_prediction_row())
    resp = _client(ledger, llm=None).post("/sweep", json={}, headers=AUTH_HEADERS)

    body = resp.json()
    assert body["reevaluated"] == 1
    assert body["verdicts_written"] == 1
    assert body["generation_ran"] is False
    assert "PREDICTION_GEMINI_API_KEY" in body["generation_note"]


def test_skip_generation_says_so_rather_than_going_quiet():
    ledger = _ledger(open_prediction_row())
    body = _client(ledger, SweepLLM()).post(
        "/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS
    ).json()
    assert body["generation_ran"] is False
    assert "skip_generation" in body["generation_note"]


# --- failure -------------------------------------------------------------


def test_a_ledger_write_failure_is_a_502_that_says_how_far_it_got():
    ledger = _ledger(open_prediction_row())
    ledger.fail_with = RuntimeError("connection reset")
    resp = _client(ledger, SweepLLM()).post(
        "/sweep", json={"skip_generation": True}, headers=AUTH_HEADERS
    )
    assert resp.status_code == 502
    assert "0 of 1" in resp.json()["detail"]
    assert "chain_id" in resp.json()["detail"]


def test_re_firing_the_same_chain_id_deduplicates_rather_than_appending_twice():
    ledger = _ledger(open_prediction_row())
    client = _client(ledger, SweepLLM())
    body = {"skip_generation": True, "chain_id": "pred-sweep-chain-fixed"}

    first = client.post("/sweep", json=body, headers=AUTH_HEADERS).json()
    assert first["verdicts_written"] == 1
    ids = {row["PREDICTION_EVAL_ID"] for row in ledger.rows}

    ledger.rowcount = 0  # the MERGE matches: this evaluation is already there
    second = client.post("/sweep", json=body, headers=AUTH_HEADERS).json()
    assert second["verdicts_written"] == 0
    assert second["results"][0]["prediction_eval_id"] in ids


@pytest.mark.parametrize("field", ["prediction_limit", "candidate_limit"])
def test_a_nonsense_cap_is_a_422_not_a_500(field):
    ledger = _ledger(open_prediction_row())
    resp = _client(ledger, SweepLLM()).post(
        "/sweep", json={field: 0}, headers=AUTH_HEADERS
    )
    assert resp.status_code == 422
