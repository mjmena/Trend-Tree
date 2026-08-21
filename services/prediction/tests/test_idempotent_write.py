"""The retried-write case, end to end: route -> the real retrying Snowflake
client -> a MERGE-aware fake warehouse (CRMA-762).

This is the one path unit tests of either half would miss. The shared client
retries any failure whose text looks transport-shaped -- including the case
where the statement *committed* and only the response was lost. Under the
original plain INSERT, whose PREDICTION_EVAL_ID came from the ledger's
``DEFAULT UUID_STRING()``, that retry appended a second row for the same
verdict under a fresh id, and Snowflake's informational PRIMARY KEY enforced
nothing against it. The fake below implements just enough MERGE semantics
(match on PREDICTION_EVAL_ID) to show the write is now a no-op on retry.
"""

from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient
from tt_services_lib.auth import IAP_ASSERTION_HEADER, IAP_ISSUER
from tt_services_lib.snowflake_client import RetryingSnowflakeClient

from prediction_service.app import create_app
from prediction_service.config import settings_from_env

AUDIENCE = "/projects/289569404687/locations/us-east4/services/trend-tree-prediction"


class _FakeLedger:
    """Rows keyed by PREDICTION_EVAL_ID, plus a one-shot "the commit landed
    but the response didn't" failure."""

    def __init__(self, *, lose_first_response: bool) -> None:
        self.rows: dict[str, dict[str, Any]] = {}
        self.statements = 0
        self._lose_first_response = lose_first_response


class _FakeCursor:
    def __init__(self, ledger: _FakeLedger) -> None:
        self._ledger = ledger
        self.description = None
        self.rowcount = 0

    def execute(self, sql: str, params: dict[str, Any] | None = None) -> None:
        assert params is not None
        assert "MERGE INTO" in sql and "WHEN NOT MATCHED" in sql, sql
        self._ledger.statements += 1
        key = params["prediction_eval_id"]
        if key in self._ledger.rows:
            self.rowcount = 0  # matched -- nothing inserted
        else:
            self._ledger.rows[key] = dict(params)
            self.rowcount = 1
        if self._ledger._lose_first_response:
            # The statement above already committed. The client sees only a
            # transport failure and cannot know that.
            self._ledger._lose_first_response = False
            raise Exception("Connection reset by peer while reading the response")

    def __enter__(self) -> _FakeCursor:
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


class _FakeConnection:
    def __init__(self, ledger: _FakeLedger) -> None:
        self._ledger = ledger
        self._closed = False

    def cursor(self, *_args: Any, **_kwargs: Any) -> _FakeCursor:
        return _FakeCursor(self._ledger)

    def is_closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        self._closed = True


def _verify_ok(token: str, audience: str) -> dict:
    return {"email": "caller@x.iam.gserviceaccount.com", "aud": audience, "iss": IAP_ISSUER}


def _client_for(ledger: _FakeLedger) -> TestClient:
    settings = settings_from_env({"PREDICTION_SERVICE_AUDIENCE": AUDIENCE})
    snowflake = RetryingSnowflakeClient(
        settings.snowflake,
        max_attempts=3,
        connect_fn=lambda **_kwargs: _FakeConnection(ledger),
    )
    return TestClient(create_app(settings=settings, snowflake=snowflake, verify_token=_verify_ok))


def test_a_retried_write_lands_exactly_one_row():
    ledger = _FakeLedger(lose_first_response=True)

    resp = _client_for(ledger).post(
        "/run", json={}, headers={IAP_ASSERTION_HEADER: "good"}
    )

    assert resp.status_code == 200
    assert ledger.statements == 2  # the write really was retried...
    assert len(ledger.rows) == 1  # ...and still produced exactly one row
    body = resp.json()
    assert body["rows_written"] == 0  # the retry matched rather than inserting
    assert body["written"] is False
    assert next(iter(ledger.rows)) == body["prediction_eval_id"]


def test_a_clean_write_lands_one_row_and_reports_it():
    ledger = _FakeLedger(lose_first_response=False)

    resp = _client_for(ledger).post(
        "/run", json={}, headers={IAP_ASSERTION_HEADER: "good"}
    )

    assert resp.status_code == 200
    assert ledger.statements == 1
    assert len(ledger.rows) == 1
    assert resp.json()["rows_written"] == 1


def test_two_separate_runs_are_two_rows():
    # The dedupe must key on the *row* identity, not collapse distinct runs.
    ledger = _FakeLedger(lose_first_response=False)
    client = _client_for(ledger)

    client.post("/run", json={}, headers={IAP_ASSERTION_HEADER: "good"})
    client.post("/run", json={}, headers={IAP_ASSERTION_HEADER: "good"})

    assert len(ledger.rows) == 2
