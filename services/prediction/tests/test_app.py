"""Route-level tests for the prediction service (CRMA-762) -- drives the real
FastAPI app over httpx's TestClient with a FakeSnowflake and a fake IAP
verifier. This is the PRD's primary testing seam: "the service's
authenticated HTTP trigger -> verdict-ledger rows," exercised here with no
warehouse, no network, and no real IAP-signed assertion; the live equivalent
(a real deploy behind Cloud Run's native IAP integration, a real
IAP-authenticated call, the row queried back from Snowflake) is the
deploy-time verification, not a substitute for this.
"""

from __future__ import annotations

import json

from fastapi.testclient import TestClient
from tt_services_lib.auth import IAP_ASSERTION_HEADER

from prediction_service.app import create_app
from prediction_service.config import settings_from_env

from .fakes import FakeSnowflake

AUDIENCE = "/projects/289569404687/locations/us-east4/services/trend-tree-prediction"


def _fake_verify_ok(token: str, audience: str) -> dict:
    return {"email": "caller@x.iam.gserviceaccount.com", "aud": audience}


def _fake_verify_reject(token: str, audience: str) -> dict:
    raise ValueError("invalid assertion")


def _client(snowflake: FakeSnowflake, *, verify=_fake_verify_ok) -> TestClient:
    settings = settings_from_env({"PREDICTION_SERVICE_AUDIENCE": AUDIENCE})
    app = create_app(settings=settings, snowflake=snowflake, verify_token=verify)
    return TestClient(app)


def _iap_headers(assertion: str) -> dict[str, str]:
    return {IAP_ASSERTION_HEADER: assertion}


def test_healthz_is_unauthenticated_at_the_app_level():
    client = _client(FakeSnowflake())
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_run_rejects_missing_iap_assertion():
    client = _client(FakeSnowflake())
    resp = client.post("/run", json={})
    assert resp.status_code == 401


def test_run_rejects_invalid_iap_assertion():
    client = _client(FakeSnowflake(), verify=_fake_verify_reject)
    resp = client.post("/run", json={}, headers=_iap_headers("bad"))
    assert resp.status_code == 401


def test_run_with_no_body_writes_the_smoke_test_claim():
    snowflake = FakeSnowflake()
    client = _client(snowflake)

    resp = client.post("/run", json={}, headers=_iap_headers("good"))

    assert resp.status_code == 200
    body = resp.json()
    assert body["written"] is True
    assert body["status"] == "ACTIVE"
    assert body["prediction_id"]

    assert len(snowflake.calls) == 1
    call = snowflake.last
    assert "FCT_PREDICTION_VERDICT_LEDGER" in call.sql
    assert call.params["prediction_id"] == body["prediction_id"]
    assert call.params["subject_descriptor"] == "rucking vests"
    assert call.params["status"] == "ACTIVE"
    assert call.params["matched_trend_id"] is None
    evidence = json.loads(call.params["evidence"])
    assert set(evidence) == {"source_signals", "saturation", "trend_context", "coverage"}


def test_run_with_custom_claim_writes_it():
    snowflake = FakeSnowflake()
    client = _client(snowflake)

    resp = client.post(
        "/run",
        json={
            "claim": {
                "subject_descriptor": "snail mucin",
                "directional_claim": "mainstream K-beauty crossover accelerates",
                "horizon_band": "near_term_1_3mo",
                "observable_check": "retail SKU count + search interest",
            },
            "confidence": 62.5,
        },
        headers=_iap_headers("good"),
    )

    assert resp.status_code == 200
    call = snowflake.last
    assert call.params["subject_descriptor"] == "snail mucin"
    assert call.params["horizon_band"] == "near_term_1_3mo"
    assert call.params["confidence"] == 62.5


def test_run_rejects_blank_claim_field_with_400():
    client = _client(FakeSnowflake())
    resp = client.post(
        "/run",
        json={
            "claim": {
                "subject_descriptor": "   ",
                "directional_claim": "x",
                "horizon_band": "emerging_3_6mo",
                "observable_check": "y",
            }
        },
        headers=_iap_headers("good"),
    )
    assert resp.status_code == 400


def test_run_rejects_unknown_horizon_band_with_422():
    # Caught by pydantic's Literal validation before it ever reaches the
    # domain layer -- a structurally different rejection point than the
    # blank-field case above, both worth pinning down.
    client = _client(FakeSnowflake())
    resp = client.post(
        "/run",
        json={
            "claim": {
                "subject_descriptor": "x",
                "directional_claim": "y",
                "horizon_band": "next_tuesday",
                "observable_check": "z",
            }
        },
        headers=_iap_headers("good"),
    )
    assert resp.status_code == 422


def test_run_does_not_write_when_claim_is_invalid():
    snowflake = FakeSnowflake()
    client = _client(snowflake)

    client.post(
        "/run",
        json={
            "claim": {
                "subject_descriptor": "",
                "directional_claim": "x",
                "horizon_band": "emerging_3_6mo",
                "observable_check": "y",
            }
        },
        headers=_iap_headers("good"),
    )

    assert snowflake.calls == []
