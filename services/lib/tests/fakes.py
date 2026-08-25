"""In-memory / scripted stand-ins for the Snowflake connector, so
tt_services_lib's own tests run with no warehouse and no network. auth.py's
tests use plain functions as fake verifiers instead (see test_auth.py) --
there is no persistent state to fake there.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


class FakeCursor:
    def __init__(self, conn: FakeConnection) -> None:
        self._conn = conn
        self.description: Any = True
        self.rowcount = 0
        self._rows: list[dict[str, Any]] = []

    def execute(self, sql: str, params: Any = None) -> None:
        self._conn.calls.append((sql, params))
        outcome = self._conn._next_outcome()
        if isinstance(outcome, Exception):
            raise outcome
        self._rows, self.rowcount = outcome

    def fetchall(self) -> list[dict[str, Any]]:
        return self._rows

    def __enter__(self) -> FakeCursor:
        return self

    def __exit__(self, *exc: Any) -> None:
        return None


@dataclass
class FakeConnection:
    """``outcomes`` is consumed one per ``cursor().execute()`` call: an
    Exception is raised, anything else is treated as ``(rows, rowcount)``.
    An exhausted queue defaults to an empty successful result, so a test that
    doesn't care about the return value doesn't have to pad the list.
    """

    outcomes: list[Any] = field(default_factory=list)
    calls: list[tuple[str, Any]] = field(default_factory=list)
    closed: bool = False
    close_calls: int = 0

    def cursor(self, *_args: Any, **_kwargs: Any) -> FakeCursor:
        return FakeCursor(self)

    def is_closed(self) -> bool:
        return self.closed

    def close(self) -> None:
        self.close_calls += 1
        self.closed = True

    def _next_outcome(self) -> Any:
        if not self.outcomes:
            return ([], 0)
        return self.outcomes.pop(0)


def fake_connect_fn(connection: FakeConnection) -> Callable[..., FakeConnection]:
    """A ``connect_fn`` that always hands back the same FakeConnection --
    matches the real ``connector.connect(**options)`` call shape (kwargs
    accepted and ignored), and lets a test simulate reconnect-after-drop by
    just observing repeated ``.calls`` on one shared connection object.
    """

    def _connect(**_kwargs: Any) -> FakeConnection:
        return connection

    return _connect
