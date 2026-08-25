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
from snowflake.connector import errorcode
from snowflake.connector import errors as sf_errors
from tenacity import Retrying, retry_if_exception, stop_after_attempt, wait_exponential_jitter

log = logging.getLogger(__name__)

Row = dict[str, Any]

# Classification is typed-first. Substring matching on exception text is the
# last resort only (see _is_transient): it can't tell a dropped socket from a
# permanent error whose message merely happens to contain the word
# "connection", and retrying the latter burns the full backoff for nothing.

# Connector error classes that are transport/session-shaped by definition.
_TRANSIENT_ERROR_TYPES: tuple[type[BaseException], ...] = (
    sf_errors.OperationalError,
    sf_errors.InterfaceError,
    sf_errors.InternalServerError,
    sf_errors.ServiceUnavailableError,
    sf_errors.GatewayTimeoutError,
    sf_errors.BadGatewayError,
    sf_errors.RequestTimeoutError,
    sf_errors.TooManyRequests,
    sf_errors.OtherHTTPRetryableError,
    sf_errors.TokenExpiredError,
    sf_errors.RequestExceedMaxRetryError,
    # Raised by the stdlib/urllib3 layer under the connector, not by it.
    ConnectionError,
    TimeoutError,
)

# Connector error classes that are *never* transient, whatever their text
# says: these are bad SQL, bad data, or an unsupported operation. Checked
# before anything else so a ProgrammingError reading "invalid identifier
# CONNECTION_ID" can't be mistaken for a dropped connection.
_PERMANENT_ERROR_TYPES: tuple[type[BaseException], ...] = (
    sf_errors.ProgrammingError,
    sf_errors.IntegrityError,
    sf_errors.DataError,
    sf_errors.NotSupportedError,
)

# Connector errnos that mean "the transport or session went away", regardless
# of which class carries them.
_TRANSIENT_ERRNOS: frozenset[int] = frozenset(
    {
        errorcode.ER_CONNECTION_IS_CLOSED,
        errorcode.ER_FAILED_TO_REQUEST,
        errorcode.ER_FAILED_TO_SERVER,
        errorcode.ER_CONNECTION_TIMEOUT,
        errorcode.ER_RETRYABLE_CODE,
        errorcode.ER_JWT_RETRY_EXPIRED,
        errorcode.ER_FAILED_TO_RENEW_SESSION,
        errorcode.ER_CHUNK_DOWNLOAD_FAILED,
    }
)

# Last-resort substring hints, consulted *only* for exceptions the connector
# didn't raise (a bare socket error, a wrapped urllib3 failure, a test
# double). Deliberately narrow: an unmatched error is treated as real and is
# never retried (see test_non_transient_error_is_not_retried).
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
    if not isinstance(err, Exception):
        return False
    if isinstance(err, _PERMANENT_ERROR_TYPES):
        return False
    errno = getattr(err, "errno", None)
    if isinstance(errno, int) and errno in _TRANSIENT_ERRNOS:
        return True
    if isinstance(err, _TRANSIENT_ERROR_TYPES):
        return True
    if isinstance(err, sf_errors.Error):
        # A typed connector error we did not classify above is a real error,
        # not a blip -- don't fall through to substring guessing for it.
        return False
    return any(hint in str(err).lower() for hint in _TRANSIENT_HINTS)


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
        """Close best-effort before forgetting the handle -- dropping the
        reference alone leaks the server-side Snowflake session until it
        times out on its own."""
        with self._lock:
            conn, self._conn = self._conn, None
        if conn is None:
            return
        try:
            conn.close()
        except Exception as err:  # noqa: BLE001 - the connection is being discarded anyway
            log.debug("ignoring error while closing a dropped Snowflake connection: %s", err)

    def _run_once(self, sql: str, params: Mapping[str, Any] | None) -> tuple[list[Row], int]:
        conn = self._connection()
        with conn.cursor(snowflake.connector.DictCursor) as cursor:
            cursor.execute(sql, dict(params) if params else None)
            rows = cursor.fetchall() if cursor.description else []
            # DB-API leaves rowcount at -1 (and the connector at None) when the
            # statement has no meaningful affected-row count. Callers read this
            # as "rows written", where a negative number is worse than useless
            # -- routes/run.py's `written = rows_written > 0` would report a
            # -1 as "not written" while the SQL may well have written a row.
            # Clamp anything that is not a non-negative int to 0.
            rowcount = cursor.rowcount
            affected = rowcount if isinstance(rowcount, int) and rowcount > 0 else 0
            return list(rows), affected

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
