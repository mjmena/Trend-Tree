"""Route-level tests for the prediction service (CRMA-762) -- drives the real
FastAPI app over httpx's TestClient with a FakeSnowflake and a fake token
verifier. This is the PRD's primary testing seam: "the service's
authenticated HTTP trigger -> verdict-ledger rows," exercised here with no
warehouse, no network, and no real Google-signed token; the live equivalent
(a real deploy, a real authenticated call, the row queried back from
Snowflake) is the deploy-time verification, not a substitute for this.

The default mode here is `oidc` -- Cloud Run IAM, how the service is actually
deployed -- so the route body is exercised the way it really runs. The IAP
mode gets its own smaller set at the bottom.
"""

from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from tt_services_lib.auth import (
    AUTH_MODE_IAP,
    AUTH_MODE_OIDC,
    IAP_ASSERTION_HEADER,
    IAP_ISSUER,
)

from prediction_service.app import create_app
from prediction_service.config import ConfigError, settings_from_env
from prediction_service.domain.claim import REQUIRED_EVIDENCE_KEYS
from prediction_service.domain.ledger import COMPUTATION_VERSION

from .fakes import FakeSnowflake

SERVICE_URL = "https://trend-tree-prediction-tu6gxkvema-uk.a.run.app"
IAP_AUDIENCE = "/projects/289569404687/locations/us-east4/services/trend-tree-prediction"
GOOGLE_ISSUER = "https://accounts.google.com"

#: Audience shape per mode -- an OIDC token's `aud` is the service URL, an IAP
#: assertion's is the /projects/.../services/... string. See
#: tt_services_lib.auth.
_AUDIENCES = {AUTH_MODE_OIDC: SERVICE_URL, AUTH_MODE_IAP: IAP_AUDIENCE}


def _fake_verify_ok(token: str, audience: str) -> dict:
    return {"email": "caller@x.iam.gserviceaccount.com", "aud": audience, "iss": GOOGLE_ISSUER}


def _fake_verify_ok_iap(token: str, audience: str) -> dict:
    return {"email": "caller@x.iam.gserviceaccount.com", "aud": audience, "iss": IAP_ISSUER}


def _fake_verify_reject(token: str, audience: str) -> dict:
    raise ValueError("invalid token")


def _client(
    snowflake: FakeSnowflake, *, verify=None, mode: str = AUTH_MODE_OIDC
) -> TestClient:
    if verify is None:
        verify = _fake_verify_ok if mode == AUTH_MODE_OIDC else _fake_verify_ok_iap
    settings = settings_from_env(
        {
            "PREDICTION_SERVICE_AUDIENCE": _AUDIENCES[mode],
            "PREDICTION_SERVICE_AUTH_MODE": mode,
        }
    )
    app = create_app(settings=settings, snowflake=snowflake, verify_token=verify)
    return TestClient(app)


def _auth_headers(token: str) -> dict[str, str]:
    """Cloud Run IAM's caller credential: a plain bearer ID token."""
    return {"Authorization": f"Bearer {token}"}


def _iap_headers(assertion: str) -> dict[str, str]:
    return {IAP_ASSERTION_HEADER: assertion}


def test_health_is_unauthenticated_at_the_app_level():
    client = _client(FakeSnowflake())
    resp = client.get("/health")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_healthz_alias_still_answers_for_local_and_in_cluster_callers():
    # /health is what the deploy gate probes (Google's edge swallows the exact
    # path /healthz on *.run.app); the alias stays for everything else.
    client = _client(FakeSnowflake())
    resp = client.get("/healthz")
    assert resp.status_code == 200
    assert resp.json() == {"ok": True}


def test_run_rejects_a_missing_bearer_token():
    client = _client(FakeSnowflake())
    resp = client.post("/run", json={})
    assert resp.status_code == 401


def test_run_rejects_an_invalid_bearer_token():
    client = _client(FakeSnowflake(), verify=_fake_verify_reject)
    resp = client.post("/run", json={}, headers=_auth_headers("bad"))
    assert resp.status_code == 401


def test_run_rejects_an_iap_assertion_while_in_oidc_mode():
    # The modes don't fall back to each other: under Cloud Run IAM the only
    # credential that counts is the bearer token.
    client = _client(FakeSnowflake())
    resp = client.post("/run", json={}, headers=_iap_headers("good"))
    assert resp.status_code == 401


def test_run_with_no_body_writes_the_smoke_test_claim():
    snowflake = FakeSnowflake()
    client = _client(snowflake)

    resp = client.post("/run", json={}, headers=_auth_headers("good"))

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
    assert set(evidence) == set(REQUIRED_EVIDENCE_KEYS)


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
        headers=_auth_headers("good"),
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
        headers=_auth_headers("good"),
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
        headers=_auth_headers("good"),
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
        headers=_auth_headers("good"),
    )

    assert snowflake.calls == []


def test_run_writes_a_merge_keyed_on_a_service_minted_eval_id():
    # The idempotency contract: the row's own id comes from the service (so a
    # retry can match on it), and the write is a MERGE, not an INSERT.
    snowflake = FakeSnowflake()
    client = _client(snowflake)

    resp = client.post("/run", json={}, headers=_auth_headers("good"))

    body = resp.json()
    call = snowflake.last
    assert call.sql.strip().startswith("MERGE INTO")
    assert "WHEN NOT MATCHED" in call.sql
    assert call.params["prediction_eval_id"] == body["prediction_eval_id"]
    assert body["prediction_eval_id"] != body["prediction_id"]


def test_run_writes_chain_id_and_computation_version():
    snowflake = FakeSnowflake()
    client = _client(snowflake)

    resp = client.post("/run", json={}, headers=_auth_headers("good"))

    body = resp.json()
    call = snowflake.last
    assert call.params["chain_id"] == body["chain_id"]
    assert body["chain_id"].startswith("pred-verdict-chain-")
    assert call.params["computation_version"] == COMPUTATION_VERSION


def test_run_reports_the_row_count_the_client_returned():
    snowflake = FakeSnowflake()
    client = _client(snowflake)

    body = client.post("/run", json={}, headers=_auth_headers("good")).json()

    assert body["rows_written"] == 1
    assert body["written"] is True


def test_run_reports_a_deduplicated_retry_as_zero_rows_written():
    # A MERGE that matched: an earlier attempt of this same write had already
    # committed. The ledger holds one row -- this attempt just isn't the one
    # that put it there, and the response says so instead of claiming a write.
    snowflake = FakeSnowflake(rowcount=0)
    client = _client(snowflake)

    body = client.post("/run", json={}, headers=_auth_headers("good")).json()

    assert body["rows_written"] == 0
    assert body["written"] is False


def test_run_returns_502_when_the_ledger_write_fails():
    snowflake = FakeSnowflake(fail_with=RuntimeError("Snowflake connect failed: no route to host"))
    client = _client(snowflake)

    resp = client.post("/run", json={}, headers=_auth_headers("good"))

    assert resp.status_code == 502
    assert "verdict write failed" in resp.json()["detail"]


def test_the_502_body_does_not_echo_the_driver_error():
    # A Snowflake ProgrammingError's text can carry the rendered statement,
    # and pyformat binding puts the parameter VALUES in that statement. The
    # detail belongs in the log, not in an HTTP response body.
    leaky = RuntimeError(
        "002003 (42S02): SQL compilation error: MERGE INTO ... VALUES "
        "('caller-supplied-secret', 'rucking vests')"
    )
    client = _client(FakeSnowflake(fail_with=leaky))

    resp = client.post("/run", json={}, headers=_auth_headers("good"))

    detail = resp.json()["detail"]
    assert resp.status_code == 502
    assert "caller-supplied-secret" not in detail
    assert "SQL compilation error" not in detail
    assert "MERGE INTO" not in detail


# --- /whoami: the authenticated no-op the deploy gate probes ---------------
#
# /health is unauthenticated at the app level on purpose, so it never runs the
# container's own token verification. Without this route the deploy gate could
# only prove "the edge passed my token and the process is up" -- a revision
# whose audience does not match its auth mode clears that and 401s every real
# call. /whoami is behind require_caller and writes nothing, so the gate can
# exercise the auth path on every deploy without appending a ledger row.


def test_whoami_requires_a_caller():
    client = _client(FakeSnowflake())

    assert client.get("/whoami").status_code == 401


def test_whoami_rejects_a_token_the_verifier_refuses():
    client = _client(FakeSnowflake(), verify=_fake_verify_reject)

    assert client.get("/whoami", headers=_auth_headers("bad")).status_code == 401


def test_whoami_returns_the_verified_caller_identity():
    client = _client(FakeSnowflake())

    resp = client.get("/whoami", headers=_auth_headers("good"))

    assert resp.status_code == 200
    assert resp.json() == {
        "caller": "caller@x.iam.gserviceaccount.com",
        "audience": SERVICE_URL,
        "auth_mode": AUTH_MODE_OIDC,
    }


def test_whoami_writes_nothing():
    # The whole reason the gate probes this route and not /run.
    snowflake = FakeSnowflake()
    client = _client(snowflake)

    client.get("/whoami", headers=_auth_headers("good"))

    assert snowflake.calls == []


def test_whoami_works_in_iap_mode_too():
    client = _client(FakeSnowflake(), mode=AUTH_MODE_IAP)

    resp = client.get("/whoami", headers=_iap_headers("good"))

    assert resp.status_code == 200
    assert resp.json()["auth_mode"] == AUTH_MODE_IAP
    assert resp.json()["audience"] == IAP_AUDIENCE


# --- caller-supplied idempotency key ---------------------------------------


def test_a_caller_supplied_eval_id_is_used_as_the_merge_key():
    # CRMA-766 puts a Cloud Scheduler cron with automatic retries in front of
    # /run. Without a caller-supplied key, an HTTP-level retry mints a fresh
    # eval id and lands a SECOND verdict row -- the in-process MERGE dedupe
    # only covers retries inside one snowflake.execute call.
    snowflake = FakeSnowflake()
    client = _client(snowflake)

    resp = client.post(
        "/run",
        json={"prediction_eval_id": "scheduler-exec-1234"},
        headers=_auth_headers("good"),
    )

    assert resp.status_code == 200
    assert resp.json()["prediction_eval_id"] == "scheduler-exec-1234"
    assert snowflake.last.params["prediction_eval_id"] == "scheduler-exec-1234"


def test_two_posts_with_the_same_eval_id_target_the_same_ledger_row():
    snowflake = FakeSnowflake()
    client = _client(snowflake)

    for _ in range(2):
        client.post(
            "/run",
            json={"prediction_eval_id": "scheduler-exec-1234"},
            headers=_auth_headers("good"),
        )

    keys = [call.params["prediction_eval_id"] for call in snowflake.calls]
    assert keys == ["scheduler-exec-1234", "scheduler-exec-1234"]


def test_an_omitted_eval_id_still_mints_a_fresh_one_per_post():
    # The default stays "each POST is a new verdict" -- a manual fire must not
    # collapse into a previous run's row.
    snowflake = FakeSnowflake()
    client = _client(snowflake)

    first = client.post("/run", json={}, headers=_auth_headers("good")).json()
    second = client.post("/run", json={}, headers=_auth_headers("good")).json()

    assert first["prediction_eval_id"] != second["prediction_eval_id"]


def test_an_over_long_eval_id_is_rejected_before_the_warehouse():
    snowflake = FakeSnowflake()
    client = _client(snowflake)

    resp = client.post(
        "/run",
        json={"prediction_eval_id": "x" * 65},
        headers=_auth_headers("good"),
    )

    assert resp.status_code == 422
    assert snowflake.calls == []


def test_run_rejects_an_over_long_reasoning_before_the_warehouse():
    # 4001 chars against REASONING VARCHAR(4000): a client-side rejection, not
    # a Snowflake "String is too long" surfacing as a 500.
    snowflake = FakeSnowflake()
    client = _client(snowflake)

    resp = client.post(
        "/run",
        json={"reasoning": "x" * 4001},
        headers=_auth_headers("good"),
    )

    assert resp.status_code == 422
    assert snowflake.calls == []


def test_run_rejects_an_over_long_subject_descriptor():
    snowflake = FakeSnowflake()
    client = _client(snowflake)

    resp = client.post(
        "/run",
        json={
            "claim": {
                "subject_descriptor": "x" * 257,
                "directional_claim": "y",
                "horizon_band": "emerging_3_6mo",
                "observable_check": "z",
            }
        },
        headers=_auth_headers("good"),
    )

    assert resp.status_code == 422
    assert snowflake.calls == []


def test_create_app_refuses_an_empty_audience_with_the_real_verifier():
    # Empty audience fails closed -- every request 401s -- which from outside
    # is indistinguishable from a correctly locked-down service. Refuse to
    # build the app at all rather than ship that.
    settings = settings_from_env({})

    with pytest.raises(ConfigError, match="PREDICTION_SERVICE_AUDIENCE is empty"):
        create_app(settings=settings, snowflake=FakeSnowflake())


# --- IAP mode -------------------------------------------------------------
#
# Retained, not the deployed posture: if IAP is reinstated, PREDICTION_SERVICE
# _AUTH_MODE=iap plus the IAP-shaped audience is the whole switch, and these
# pin down that the switch still works.


def test_iap_mode_accepts_an_assertion_and_writes():
    snowflake = FakeSnowflake()
    client = _client(snowflake, mode=AUTH_MODE_IAP)

    resp = client.post("/run", json={}, headers=_iap_headers("good"))

    assert resp.status_code == 200
    assert resp.json()["written"] is True
    assert len(snowflake.calls) == 1


def test_iap_mode_rejects_a_missing_assertion():
    client = _client(FakeSnowflake(), mode=AUTH_MODE_IAP)
    resp = client.post("/run", json={})
    assert resp.status_code == 401


def test_iap_mode_rejects_a_bearer_token():
    client = _client(FakeSnowflake(), mode=AUTH_MODE_IAP)
    resp = client.post("/run", json={}, headers=_auth_headers("good"))
    assert resp.status_code == 401


def test_iap_mode_rejects_an_assertion_the_verifier_refuses():
    client = _client(FakeSnowflake(), mode=AUTH_MODE_IAP, verify=_fake_verify_reject)
    resp = client.post("/run", json={}, headers=_iap_headers("bad"))
    assert resp.status_code == 401


def test_create_app_refuses_an_unknown_auth_mode():
    # A typo'd mode is a config problem, so it must break app construction --
    # not select some default and quietly serve on the wrong credential.
    settings = settings_from_env(
        {"PREDICTION_SERVICE_AUDIENCE": SERVICE_URL, "PREDICTION_SERVICE_AUTH_MODE": "iap-ish"}
    )

    with pytest.raises(ConfigError, match="unknown auth mode"):
        create_app(settings=settings, snowflake=FakeSnowflake(), verify_token=_fake_verify_ok)
