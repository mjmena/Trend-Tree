"""Unit tests for the shared retrying Snowflake client (CRMA-762) -- the core
differentiator from prism's client, which drops the connection on a
transport-shaped error but never retries the *failing call itself*. These
tests assert this one does, with no warehouse and no network involved.
"""

from __future__ import annotations

from dataclasses import dataclass

import pytest

from tt_services_lib.snowflake_client import RetryingSnowflakeClient

from .fakes import FakeConnection, fake_connect_fn


@dataclass(frozen=True)
class _Settings:
    account: str = "acct"
    user: str = "user"
    role: str = "role"
    warehouse: str = "wh"
    database: str = "db"
    schema: str = "schema"
    authenticator: str = "externalbrowser"
    private_key_path: str = ""
    private_key: str = ""


def _client(conn: FakeConnection, **kwargs: object) -> RetryingSnowflakeClient:
    return RetryingSnowflakeClient(_Settings(), connect_fn=fake_connect_fn(conn), **kwargs)


def test_retries_transient_error_then_succeeds():
    conn = FakeConnection(
        outcomes=[
            Exception("Connection reset by peer"),
            Exception("JWT token is expired"),
            ([{"X": 1}], 1),
        ]
    )
    client = _client(conn, max_attempts=5)

    rows = client.query("SELECT 1")

    assert rows == [{"X": 1}]
    assert len(conn.calls) == 3  # two failed attempts + the succeeding one


def test_gives_up_after_max_attempts():
    conn = FakeConnection(outcomes=[Exception("network timeout")] * 10)
    client = _client(conn, max_attempts=3)

    with pytest.raises(Exception, match="network timeout"):
        client.query("SELECT 1")

    assert len(conn.calls) == 3


def test_non_transient_error_is_not_retried():
    conn = FakeConnection(outcomes=[Exception("SQL compilation error: invalid identifier 'FOO'")])
    client = _client(conn, max_attempts=5)

    with pytest.raises(Exception, match="invalid identifier"):
        client.query("SELECT foo")

    assert len(conn.calls) == 1  # no retry -- this is a real bug, not a blip


def test_execute_returns_affected_row_count():
    conn = FakeConnection(outcomes=[([], 1)])
    client = _client(conn)

    assert client.execute("INSERT INTO t VALUES (1)") == 1


def test_query_passes_params_through_to_the_cursor():
    conn = FakeConnection(outcomes=[([{"X": 1}], 1)])
    client = _client(conn)

    client.query("SELECT %(x)s", {"x": 1})

    sql, params = conn.calls[0]
    assert sql == "SELECT %(x)s"
    assert params == {"x": 1}
