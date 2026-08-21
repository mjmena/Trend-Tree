"""Shared Snowflake client for the services/ namespace (CRMA-762).

The Protocol is the test seam -- routes and domain code depend on
``SnowflakeClient``, never on the concrete connector, so tests substitute an
in-memory fake with no warehouse and no network (see each service's
``tests/fakes.py``).

Unlike prism's ``clients/snowflake.py`` (lazy-connect, reconnect-on-transport-
error, but the *failing call itself* is never retried -- only the *next* call
benefits from a fresh connection), this client retries the call in place:
transient/network-shaped errors get a bounded exponential backoff with jitter
before giving up, and only then does it drop the cached connection so the
retried attempt reconnects cleanly. A scheduled or single-shot agent run has
no "next caller" to benefit from prism's approach, so retrying in place is the
right default for this namespace.
"""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Mapping
from typing import Any, Protocol

import snowflake.connector
from cryptography.hazmat.primitives import serialization
from tenacity import Retrying, retry_if_exception, stop_after_attempt, wait_exponential_jitter

log = logging.getLogger(__name__)

Row = dict[str, Any]

# Substring hints that a failure is transport/session-shaped rather than a bad
# query or a real bug. Matches on the lower-cased exception text -- the
# connector does not expose a stable typed hierarchy for every one of these
# across versions. Deliberately narrow: an unmatched error is treated as real
# and is never retried (see test_non_transient_error_is_not_retried).
_TRANSIENT_HINTS = (
    "network",
    "disconnect",
    "connection",
    "expired",
    "jwt",
    "timeout",
    "timed out",
    "503",
    "504",
)


def _is_transient(err: BaseException) -> bool:
    return isinstance(err, Exception) and any(
        hint in str(err).lower() for hint in _TRANSIENT_HINTS
    )


class SnowflakeSettings(Protocol):
    """The subset of connection settings this client needs. Each service
    defines its own concrete ``SnowflakeSettings`` dataclass; this Protocol is
    just the shape, so the client doesn't import any one service's config."""

    account: str
    user: str
    role: str
    warehouse: str
    database: str
    schema: str
    authenticator: str
    private_key_path: str
    private_key: str


class SnowflakeClient(Protocol):
    def query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[Row]:
        """Run a SELECT; rows keyed by upper-case column name."""
        ...

    def execute(self, sql: str, params: Mapping[str, Any] | None = None) -> int:
        """Run DML; returns affected row count."""
        ...


def _der_private_key(pem: str) -> bytes:
    """The connector wants PKCS#8 DER bytes; Secret Manager hands us PEM text."""
    key = serialization.load_pem_private_key(pem.encode(), password=None)
    return key.private_bytes(
        encoding=serialization.Encoding.DER,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )


class RetryingSnowflakeClient:
    """Lazy connection; the call itself is retried (bounded exponential
    backoff with jitter) before the cached connection is dropped for a fresh
    reconnect on the next attempt.

    Thread-safe for the same reason prism's is: handlers may run concurrently
    in a threadpool, the lock guards connection *creation* only, and each call
    takes its own cursor rather than sharing one across concurrent requests.
    """

    def __init__(
        self,
        settings: SnowflakeSettings,
        *,
        max_attempts: int = 4,
        connect_fn: Callable[..., Any] = snowflake.connector.connect,
    ) -> None:
        self._settings = settings
        self._conn: Any | None = None
        self._lock = threading.Lock()
        self._max_attempts = max_attempts
        self._connect_fn = connect_fn

    def _connect_options(self) -> dict[str, Any]:
        s = self._settings
        options: dict[str, Any] = {
            "account": s.account,
            "user": s.user,
            "role": s.role,
            "warehouse": s.warehouse,
            "database": s.database,
            "schema": s.schema,
            "client_session_keep_alive": True,
        }
        if s.private_key:
            options["private_key"] = _der_private_key(s.private_key)
        elif s.private_key_path:
            with open(s.private_key_path) as handle:
                options["private_key"] = _der_private_key(handle.read())
        else:
            options["authenticator"] = s.authenticator
        return options

    def _connection(self) -> Any:
        with self._lock:
            if self._conn is None or self._conn.is_closed():
                try:
                    self._conn = self._connect_fn(**self._connect_options())
                except Exception as err:  # noqa: BLE001 - re-raised with context
                    raise RuntimeError(f"Snowflake connect failed: {err}") from err
            return self._conn

    def _drop_connection(self) -> None:
        with self._lock:
            self._conn = None

    def _run_once(self, sql: str, params: Mapping[str, Any] | None) -> tuple[list[Row], int]:
        conn = self._connection()
        with conn.cursor(snowflake.connector.DictCursor) as cursor:
            cursor.execute(sql, dict(params) if params else None)
            rows = cursor.fetchall() if cursor.description else []
            return list(rows), cursor.rowcount or 0

    def _before_sleep(self, retry_state: Any) -> None:
        exc = retry_state.outcome.exception() if retry_state.outcome else None
        log.warning(
            "snowflake call failed (attempt %s/%s), retrying: %s",
            retry_state.attempt_number,
            self._max_attempts,
            exc,
        )
        # Force a fresh connect on the retried attempt rather than reusing a
        # socket the far side has already closed, or a session whose JWT has
        # expired.
        self._drop_connection()

    def _run(self, sql: str, params: Mapping[str, Any] | None) -> tuple[list[Row], int]:
        retrying = Retrying(
            retry=retry_if_exception(_is_transient),
            stop=stop_after_attempt(self._max_attempts),
            wait=wait_exponential_jitter(initial=0.5, max=8),
            reraise=True,
            before_sleep=self._before_sleep,
        )
        return retrying(self._run_once, sql, params)

    def query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[Row]:
        return self._run(sql, params)[0]

    def execute(self, sql: str, params: Mapping[str, Any] | None = None) -> int:
        return self._run(sql, params)[1]
