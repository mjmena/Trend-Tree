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

from .fakes import FakePredictionLLM, FakeSnowflake

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
    assert body["llm_token_usage"] == {"input": 1200, "output": 300, "total": 1500}
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
    # run. Eval ids are derived from the chain id, so the MERGE matches.
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


# --- the skeleton route is unchanged ---------------------------------------


def test_run_still_works_without_an_llm_configured():
    # /run is CRMA-762's smoke path and must not have acquired a dependency
    # on the generation phase.
    snowflake = FakeSnowflake()
    client = _client(snowflake, None)

    assert client.post("/run", json={}, headers=AUTH_HEADERS).status_code == 200
