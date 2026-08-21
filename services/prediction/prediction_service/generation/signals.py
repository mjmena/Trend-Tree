"""The generation phase's only warehouse reach: recent rows of the signal
corpus, ``FCT_SIGNALS`` (CRMA-763).

``SignalReader`` is the capability boundary described in
generation/blindness.py. Its whole surface is ``recent_signals`` -- a caller
holding one can read the signal corpus and do nothing else, which is what
makes the generation phase blind by construction rather than by convention.

``SnowflakeSignalReader`` is the production adapter. It depends on
``SignalQueryRunner`` (query-only), *not* on
``tt_services_lib.snowflake_client.SnowflakeClient``: the real client also
exposes ``execute``, and generation has no business holding a handle that can
write. The concrete client satisfies the narrower Protocol structurally, so
routes/generate.py passes the same object the rest of the service uses --
the narrowing costs nothing at the call site and is load-bearing here.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from .blindness import assert_generation_sql

#: The signal corpus, unqualified. routes/generate.py passes
#: ``settings.qualify("FCT_SIGNALS")``.
SIGNALS_TABLE = "FCT_SIGNALS"

# The one statement generation issues. Columns are the corpus's own
# (sql/fct_signals.sql); nothing here joins, and nothing here can -- see
# assert_generation_sql, which every call runs through first.
#
# SIGNAL_VECTOR is deliberately not selected: 1024 floats per row, useless to
# a text prompt, and expensive to ship. Embedding-space work belongs to the
# matching phase (CRMA-764), which is allowed to see trends.
SIGNAL_QUERY = """
SELECT
    SIGNAL_ID,
    SOURCE_NAME,
    SIGNAL_TIMESTAMP,
    SIGNAL_TITLE,
    SIGNAL_TEXT
FROM {table}
WHERE SIGNAL_TITLE IS NOT NULL
  AND SIGNAL_TIMESTAMP >= DATEADD('hour', -%(lookback_hours)s, CURRENT_TIMESTAMP())
ORDER BY SIGNAL_TIMESTAMP DESC
LIMIT %(signal_limit)s
"""


@dataclass(frozen=True)
class SignalRecord:
    """One ``FCT_SIGNALS`` row as generation sees it. Text only -- no vector,
    no trend linkage."""

    signal_id: str
    source_name: str
    signal_timestamp: str | None
    signal_title: str
    signal_text: str | None

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> SignalRecord:
        """Build from a warehouse row (upper-case keys) or a fixture dict
        (lower-case keys) -- the local loop and the deployed run feed the
        same prompt builders."""

        def get(name: str) -> Any:
            if name in row:
                return row[name]
            return row.get(name.lower())

        timestamp = get("SIGNAL_TIMESTAMP")
        return cls(
            signal_id=str(get("SIGNAL_ID") or ""),
            source_name=str(get("SOURCE_NAME") or ""),
            signal_timestamp=None if timestamp is None else str(timestamp),
            signal_title=str(get("SIGNAL_TITLE") or ""),
            signal_text=None if get("SIGNAL_TEXT") is None else str(get("SIGNAL_TEXT")),
        )


class SignalReader(Protocol):
    """The generation phase's entire data capability."""

    def recent_signals(self, *, lookback_hours: int, limit: int) -> list[SignalRecord]: ...


class SignalQueryRunner(Protocol):
    """The read half of ``SnowflakeClient``. Narrowed on purpose: an object
    with ``execute`` on it does not belong in the generation call graph."""

    def query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]: ...


class SnowflakeSignalReader:
    """Reads ``FCT_SIGNALS`` and nothing else.

    ``table`` is injected so the service's own database/schema qualification
    (``Settings.qualify``) stays in one place, but a caller cannot use it to
    smuggle in a different table: ``assert_generation_sql`` sees the rendered
    statement and rejects a trend/heat/lifecycle object before the client is
    ever called.
    """

    def __init__(self, client: SignalQueryRunner, table: str = SIGNALS_TABLE) -> None:
        self._client = client
        self._table = table

    def recent_signals(self, *, lookback_hours: int, limit: int) -> list[SignalRecord]:
        sql = SIGNAL_QUERY.format(table=self._table)
        assert_generation_sql(sql)
        rows = self._client.query(
            sql, {"lookback_hours": int(lookback_hours), "signal_limit": int(limit)}
        )
        return [SignalRecord.from_row(row) for row in rows]


class FixtureSignalReader:
    """The local loop's reader: a list of rows from a JSON fixture, no
    warehouse and no network. Same ``SignalReader`` surface the deployed run
    uses, so the fixture path exercises the real generation code (PRD's
    "fixture-driven local runs exercise the agent loop without deploys")."""

    def __init__(self, rows: Iterable[Mapping[str, Any]]) -> None:
        self._records: Sequence[SignalRecord] = [SignalRecord.from_row(row) for row in rows]

    def recent_signals(self, *, lookback_hours: int, limit: int) -> list[SignalRecord]:
        # lookback_hours is not applied: a fixture is already the slice its
        # author chose. The limit is, so a capped local run caps the same way
        # a capped deployed run does.
        return list(self._records[: max(0, int(limit))])
