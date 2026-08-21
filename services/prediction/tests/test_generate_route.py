"""POST /generate end to end: authenticated fire -> ACTIVE verdict-ledger rows
(CRMA-763, AC1).

The PRD's primary seam, exercised with no warehouse, no network and no real
signed token: the real FastAPI app, the real generation code, a FakeSnowflake
recording every statement and a fake LLM replaying a recorded reply. The live
equivalent -- a deployed revision, a real OIDC token, the rows queried back
out of FCT_PREDICTION_VERDICT_LEDGER -- is deploy-time verification, not a
substitute for this.
"""

from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from prediction_service.app import create_app
from prediction_service.config import settings_from_env
from prediction_service.domain.claim import REQUIRED_EVIDENCE_KEYS
from prediction_service.domain.ledger import COMPUTATION_VERSION
from prediction_service.generation.llm import LLMError

from .fakes import FakePredictionLLM, FakeSnowflake, ShufflingPredictionLLM

SERVICE_URL = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"
GOOGLE_ISSUER = "https://accounts.google.com"
AUTH_HEADERS = {"Authorization": "Bearer good"}

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
SIGNAL_ROWS = json.loads((FIXTURES / "signals.sample.json").read_text())
MODEL_REPLY = (FIXTURES / "generation_reply.sample.json").read_text()


def _verify_ok(token: str, audience: str) -> dict:
    return {"email": "caller@x.iam.gserviceaccount.com", "aud": audience, "iss": GOOGLE_ISSUER}


def _client(snowflake: FakeSnowflake, llm=None, *, verify=_verify_ok) -> TestClient:
    settings = settings_from_env({"PREDICTION_SERVICE_AUDIENCE": SERVICE_URL})
    app = create_app(settings=settings, snowflake=snowflake, verify_token=verify, llm=llm)
    return TestClient(app)


def _writes(snowflake: FakeSnowflake):
    return [call for call in snowflake.calls if call.kind == "execute"]


# --- auth ------------------------------------------------------------------


def test_generate_requires_a_caller():
    client = _client(FakeSnowflake(), FakePredictionLLM())

    assert client.post("/generate", json={}).status_code == 401


def test_generate_rejects_a_token_the_verifier_refuses():
    def reject(token: str, audience: str) -> dict:
        raise ValueError("invalid token")

    client = _client(FakeSnowflake(), FakePredictionLLM(), verify=reject)

    assert client.post("/generate", json={}, headers=AUTH_HEADERS).status_code == 401


def test_an_unauthenticated_call_reads_no_signals():
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)

    _client(snowflake, FakePredictionLLM()).post("/generate", json={})

    assert snowflake.calls == []


# --- AC1: a capped run writes ACTIVE verdict rows --------------------------


def test_a_capped_run_writes_active_verdict_rows_with_a_complete_claim():
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    resp = client.post(
        "/generate",
        json={"lookback_hours": 168, "signal_limit": 50, "max_predictions": 5},
        headers=AUTH_HEADERS,
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["predictions_written"] >= 1

    writes = _writes(snowflake)
    assert len(writes) == body["predictions_written"]
    for call in writes:
        assert "FCT_PREDICTION_VERDICT_LEDGER" in call.sql
        assert call.sql.strip().startswith("MERGE INTO")
        # The four claim columns the ledger declares NOT NULL.
        assert call.params["subject_descriptor"].strip()
        assert call.params["directional_claim"].strip()
        assert call.params["observable_check"].strip()
        assert call.params["horizon_at"] is not None
        assert call.params["horizon_band"] in {
            "near_term_1_3mo",
            "emerging_3_6mo",
            "cultural_shift_6_12mo",
            "longer_range_12_24mo",
        }
        assert call.params["status"] == "ACTIVE"
        assert call.params["computation_version"] == COMPUTATION_VERSION


def test_the_written_rows_carry_evidence_and_reasoning():
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    client.post("/generate", json={}, headers=AUTH_HEADERS)

    corpus = {row["SIGNAL_ID"] for row in SIGNAL_ROWS}
    for call in _writes(snowflake):
        evidence = json.loads(call.params["evidence"])
        assert set(REQUIRED_EVIDENCE_KEYS) <= set(evidence)
        assert evidence["source_signals"]
        assert set(evidence["source_signals"]) <= corpus
        assert call.params["reasoning"].strip()


def test_a_generated_row_is_a_white_space_prediction_until_matching_lands():
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    client.post("/generate", json={}, headers=AUTH_HEADERS)

    for call in _writes(snowflake):
        assert call.params["matched_trend_id"] is None
        assert call.params["what_changed"] is None


def test_the_response_describes_the_run_it_just_did():
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    body = client.post("/generate", json={}, headers=AUTH_HEADERS).json()

    assert body["signals_considered"] == len(SIGNAL_ROWS)
    assert body["model"] == "fake-model"
    assert body["chain_id"].startswith("pred-verdict-chain-")
    # Both turns of the run: generation, then the saturation weighing pass
    # (CRMA-765), which asks the same model to restate its calls with the
    # Exploding Topics and GDELT readings in view. The fake bills each turn
    # identically, so the reported usage is exactly twice one call -- a run
    # that reported only the first turn would understate what it spent.
    assert body["llm_token_usage"] == {"input": 2400, "output": 600, "total": 3000}
    assert body["llm_cost_estimate"] > 0
    assert all(p["written"] for p in body["predictions"])


def test_the_response_reports_the_claimless_topic_it_dropped():
    # A run that emitted fewer predictions than the model proposed should say
    # why, not merely come back shorter (AC2, at the HTTP surface).
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    body = client.post("/generate", json={}, headers=AUTH_HEADERS).json()

    reasons = {r["subject"]: r["reason"] for r in body["rejections"]}
    assert "targeted supplement stacking" in reasons
    assert "no directional_claim" in reasons["targeted supplement stacking"]
    assert "targeted supplement stacking" not in [
        p["subject_descriptor"] for p in body["predictions"]
    ]


def test_the_cap_bounds_the_rows_a_run_can_write():
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    body = client.post("/generate", json={"max_predictions": 1}, headers=AUTH_HEADERS).json()

    assert body["predictions_written"] == 1
    assert len(_writes(snowflake)) == 1


def test_a_dry_run_returns_the_claims_without_writing_them():
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    body = client.post("/generate", json={"dry_run": True}, headers=AUTH_HEADERS).json()

    assert body["dry_run"] is True
    assert body["predictions"]
    assert body["predictions_written"] == 0
    assert all(p["written"] is False for p in body["predictions"])
    assert _writes(snowflake) == []


# --- idempotency -----------------------------------------------------------


def test_re_firing_the_same_chain_id_targets_the_same_ledger_rows():
    # Cloud Scheduler retries (CRMA-766) must not append a second copy of a
    # run. Eval ids hash the claim within the chain, so an identical claim
    # MERGEs into the row it already owns.
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    first = client.post(
        "/generate", json={"chain_id": "sched-exec-99"}, headers=AUTH_HEADERS
    ).json()
    snowflake.rowcount = 0  # the MERGE now matches the rows the first fire wrote
    second = client.post(
        "/generate", json={"chain_id": "sched-exec-99"}, headers=AUTH_HEADERS
    ).json()

    assert [p["prediction_eval_id"] for p in first["predictions"]] == [
        p["prediction_eval_id"] for p in second["predictions"]
    ]
    assert second["predictions_written"] == 0


def _shuffling_client(snowflake: FakeSnowflake) -> tuple[TestClient, ShufflingPredictionLLM]:
    repeated = [
        {
            "subject_descriptor": "rucking vests",
            "directional_claim": "mainstream retail adoption expands",
            "horizon_band": "emerging_3_6mo",
            "observable_check": "Target lists a house-label weighted vest under 20 lb",
            "confidence": 68,
            "reasoning": "convergent evidence across commerce, search and social",
            "source_signals": ["bluesky:3lqz7a2xk4d2m"],
        },
        {
            "subject_descriptor": "cottage cheese",
            "directional_claim": "displaces ricotta in home-cooked savory dishes",
            "horizon_band": "cultural_shift_6_12mo",
            "observable_check": "Good & Gather lists a 4% milkfat tub in its online catalog",
            "confidence": 54,
            "reasoning": "a supply-side change plus an inverted diet framing",
            "source_signals": ["bluesky:3lqx91mm2c22t"],
        },
    ]
    fresh = {
        "subject_descriptor": "head spa",
        "directional_claim": "appointment availability moves from waitlist to same-day",
        "horizon_band": "near_term_1_3mo",
        "observable_check": "three named US metro salons list same-day head-spa slots online",
        "confidence": 61,
        "reasoning": "a single strong signal with a named, checkable outcome",
        "source_signals": ["gdelt:20260807:supplement-stack-coverage"],
    }
    llm = ShufflingPredictionLLM(replies=repeated, novel=[{}, fresh])
    return _client(snowflake, llm), llm


def test_a_re_fire_against_a_nondeterministic_model_writes_only_the_new_claims():
    # The failure the positional scheme hid. This fake answers differently
    # every call, the way temperature 1.0 does. The second fire must MERGE
    # the two repeated claims into the rows they already own (rows=0) and
    # append the one genuinely new claim.
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client, _ = _shuffling_client(snowflake)

    first = client.post(
        "/generate", json={"chain_id": "sched-exec-77"}, headers=AUTH_HEADERS
    ).json()

    written_first = {
        call.params["subject_descriptor"]: call.params["prediction_eval_id"]
        for call in _writes(snowflake)
    }
    assert set(written_first) == {"rucking vests", "cottage cheese"}

    # The ledger now holds those two eval ids; anything else is an insert.
    class Deduping(FakeSnowflake):
        def execute(self, sql, params=None):
            super().execute(sql, params)
            return 0 if params["prediction_eval_id"] in written_first.values() else 1

    second_sf = Deduping(rows=SIGNAL_ROWS)
    client2, _ = _shuffling_client(second_sf)
    client2.post("/generate", json={"chain_id": "sched-exec-77"}, headers=AUTH_HEADERS)
    second = client2.post(
        "/generate", json={"chain_id": "sched-exec-77"}, headers=AUTH_HEADERS
    ).json()

    by_subject = {p["subject_descriptor"]: p for p in second["predictions"]}
    assert set(by_subject) == {"rucking vests", "cottage cheese", "head spa"}
    # The repeated claims kept their ids and re-wrote nothing.
    for subject in ("rucking vests", "cottage cheese"):
        assert by_subject[subject]["prediction_eval_id"] == written_first[subject]
        assert by_subject[subject]["written"] is False
    # The new claim is a new row, not an overwrite of an unrelated one.
    assert by_subject["head spa"]["prediction_eval_id"] not in written_first.values()
    assert by_subject["head spa"]["written"] is True
    assert second["predictions_written"] == 1
    assert first["chain_id"] == second["chain_id"] == "sched-exec-77"


def test_a_prediction_id_is_only_reported_for_a_row_this_call_wrote():
    # The response must describe the ledger, not the objects this process
    # happened to build. A PREDICTION_ID is minted per verdict, so reporting
    # one for a MERGE that matched names a row that exists nowhere.
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    first = client.post(
        "/generate", json={"chain_id": "sched-exec-55"}, headers=AUTH_HEADERS
    ).json()
    assert all(p["prediction_id"] for p in first["predictions"])

    snowflake.rowcount = 0
    second = client.post(
        "/generate", json={"chain_id": "sched-exec-55"}, headers=AUTH_HEADERS
    ).json()

    assert [p["prediction_id"] for p in second["predictions"]] == [None, None]
    assert all(p["written"] is False for p in second["predictions"])


def test_a_dry_run_reports_no_prediction_id_because_nothing_was_written():
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    body = client.post("/generate", json={"dry_run": True}, headers=AUTH_HEADERS).json()

    assert body["predictions"]
    assert all(p["prediction_id"] is None for p in body["predictions"])


def test_a_subject_already_live_in_the_ledger_is_not_re_minted():
    # The route's half of the daily-flood fix: the live-subject read comes
    # back with a subject the model proposed again, and it does not become a
    # row.
    class LiveLedger(FakeSnowflake):
        def query(self, sql, params=None):
            super().query(sql, params)
            if "SUBJECT_DESCRIPTOR" in sql.upper():
                return [{"SUBJECT_DESCRIPTOR": "rucking vests"}]
            return list(SIGNAL_ROWS)

    snowflake = LiveLedger()
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    body = client.post("/generate", json={}, headers=AUTH_HEADERS).json()

    subjects = [p["subject_descriptor"] for p in body["predictions"]]
    assert "rucking vests" not in subjects
    assert "cottage cheese" in subjects
    reasons = {r["subject"]: r["reason"] for r in body["rejections"]}
    assert "already carries a live ACTIVE prediction" in reasons["rucking vests"]


def test_two_runs_without_a_chain_id_do_not_collide():
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    first = client.post("/generate", json={}, headers=AUTH_HEADERS).json()
    second = client.post("/generate", json={}, headers=AUTH_HEADERS).json()

    assert first["chain_id"] != second["chain_id"]
    assert not set(p["prediction_eval_id"] for p in first["predictions"]) & set(
        p["prediction_eval_id"] for p in second["predictions"]
    )


# --- failure paths ---------------------------------------------------------


def test_a_service_with_no_gemini_key_answers_503_and_names_the_variable():
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, None)

    resp = client.post("/generate", json={}, headers=AUTH_HEADERS)

    assert resp.status_code == 503
    assert "PREDICTION_GEMINI_API_KEY" in resp.json()["detail"]
    assert snowflake.calls == []


def test_a_model_failure_is_a_502_and_writes_nothing():
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(fail_with=LLMError("Gemini HTTP 429: quota")))

    resp = client.post("/generate", json={}, headers=AUTH_HEADERS)

    assert resp.status_code == 502
    assert _writes(snowflake) == []


def test_an_unparseable_reply_is_a_502_and_writes_nothing():
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(snowflake, FakePredictionLLM(reply="I have no predictions today."))

    resp = client.post("/generate", json={}, headers=AUTH_HEADERS)

    assert resp.status_code == 502
    assert _writes(snowflake) == []


def test_the_502_body_does_not_echo_the_dependency_error():
    # Same rule as /run: a driver or provider message can carry prompt text
    # and rendered parameter values. It belongs in the log.
    snowflake = FakeSnowflake(rows=SIGNAL_ROWS)
    client = _client(
        snowflake,
        FakePredictionLLM(fail_with=LLMError("Gemini HTTP 400: bad key sk-secret-123")),
    )

    detail = client.post("/generate", json={}, headers=AUTH_HEADERS).json()["detail"]

    assert "sk-secret-123" not in detail


def test_a_corpus_read_failure_is_a_502_and_writes_nothing():
    class FailingReads(FakeSnowflake):
        def query(self, sql, params=None):
            raise RuntimeError("Snowflake connect failed: no route to host")

    snowflake = FailingReads()
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    resp = client.post("/generate", json={}, headers=AUTH_HEADERS)

    assert resp.status_code == 502
    assert _writes(snowflake) == []


def test_a_write_failure_is_a_502_that_says_how_to_finish_the_run():
    # The ledger is append-only: rows that landed before the failure are real
    # history. The response says how many, and how to complete the run
    # without duplicating them.
    snowflake = FakeSnowflake(
        rows=SIGNAL_ROWS, fail_with=RuntimeError("Snowflake connect failed: no route to host")
    )
    client = _client(snowflake, FakePredictionLLM(reply=MODEL_REPLY))

    resp = client.post("/generate", json={"chain_id": "sched-exec-7"}, headers=AUTH_HEADERS)

    assert resp.status_code == 502
    detail = resp.json()["detail"]
    assert "0 of 2 row(s) landed" in detail
    assert "sched-exec-7" in detail
    # The remediation must not promise a replay it cannot deliver: at
    # temperature 1.0 a re-fire regenerates, it does not repeat.
    assert "It does not replay this run." in detail
    assert "idempotently" not in detail


# --- the skeleton route is unchanged ---------------------------------------


def test_run_still_works_without_an_llm_configured():
    # /run is CRMA-762's smoke path and must not have acquired a dependency
    # on the generation phase.
    snowflake = FakeSnowflake()
    client = _client(snowflake, None)

    assert client.post("/run", json={}, headers=AUTH_HEADERS).status_code == 200
