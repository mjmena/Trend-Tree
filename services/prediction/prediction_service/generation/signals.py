"""The generation phase's warehouse reaches (CRMA-763).

Two reads, both narrow, both named here so the phase's whole surface against
the warehouse is one file:

* ``SignalReader`` -- the signal corpus, ``FCT_SIGNALS``. The phase's
  evidence.
* ``LiveSubjectReader`` -- the subjects already carrying a live ACTIVE
  prediction, from the verdict ledger this service itself writes. Not trend
  state: it is the pillar's own output, read so a daily run does not re-mint
  the same subject every day (see run.py's dedupe).

**What these Protocols do and do not buy.** They are structural typing with
no runtime enforcement -- this repo configures no mypy or pyright, so nothing
checks that the object handed to ``SnowflakeSignalReader`` is query-only. In
production it is literally ``SnowflakeClient``, which also exposes
``execute``. Narrowing the annotation is a *review* signal (a reader that
starts wanting ``execute`` has to change its declared dependency, visibly)
and a test seam. It is not a capability boundary, and describing it as one
would be a comment that the runtime does not honour.

The enforcement that does run is ``assert_generation_sql``: every statement
issued from this module is checked, before it is issued, against an allowlist
of FROM/JOIN targets plus a denylist of trend-shaped tokens. See
blindness.py.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Protocol

from .blindness import assert_generation_sql

#: The signal corpus, unqualified. routes/generate.py passes
#: ``settings.qualify("FCT_SIGNALS")``.
SIGNALS_TABLE = "FCT_SIGNALS"

#: The pillar's own verdict ledger, unqualified. Read-only from here, and
#: only for the live-subject list.
VERDICT_LEDGER_TABLE = "FCT_PREDICTION_VERDICT_LEDGER"

#: How many live subjects the prompt is willing to carry. A cap on prompt
#: size, not a correctness knob -- the dedupe in run.py works off whatever
#: this returns.
DEFAULT_LIVE_SUBJECT_LIMIT = 300

# The corpus read. Columns are the corpus's own (sql/fct_signals.sql);
# nothing here joins, and nothing here can -- see assert_generation_sql,
# which every call runs through first.
#
# SIGNAL_VECTOR is deliberately not selected: 1024 floats per row, useless to
# a text prompt, and expensive to ship. Embedding-space work belongs to the
# matching phase (CRMA-764), which is allowed to see trends.
#
# **Why this is a stratified sample and not `ORDER BY SIGNAL_TIMESTAMP DESC`.**
# It used to be the latter. Measured on 2026-08-21, the live corpus carries
# 6,644 rows across 11 sources in a 168-hour window, and the newest 200 of
# them span 5.5 hours from 8 sources -- so the default run never saw six and
# a half of its seven days, `lookback_hours` was decorative, and whichever
# source ingests most often crowded out the rest. That directly caps what the
# agent can find: four of the five emergence paths need breadth across time
# or across sources to be visible at all.
#
# ROW_NUMBER over (source x calendar day) makes the LIMIT a round-robin
# across every cell in the window: the first pass takes one row from each
# source-day, the second another, and so on until the cap. Every source and
# every day that has rows is represented before any cell gets a second row.
# The within-cell order is HASH(SIGNAL_ID), not RANDOM(): a re-fire over an
# unchanged window then shows the model the same corpus, which is what makes
# chain_id idempotency (run.py) worth anything against a temperature-1.0
# model.
SIGNAL_QUERY = """
WITH WINDOWED AS (
    SELECT
        SIGNAL_ID,
        SOURCE_NAME,
        SIGNAL_TIMESTAMP,
        SIGNAL_TITLE,
        SIGNAL_TEXT
    FROM {table}
    WHERE SIGNAL_TITLE IS NOT NULL
      AND SIGNAL_TIMESTAMP >= DATEADD('hour', -%(lookback_hours)s, CURRENT_TIMESTAMP())
),
STRATIFIED AS (
    SELECT
        SIGNAL_ID,
        SOURCE_NAME,
        SIGNAL_TIMESTAMP,
        SIGNAL_TITLE,
        SIGNAL_TEXT,
        ROW_NUMBER() OVER (
            PARTITION BY SOURCE_NAME, DATE_TRUNC('day', SIGNAL_TIMESTAMP)
            ORDER BY HASH(SIGNAL_ID)
        ) AS CELL_RANK
    FROM WINDOWED
)
SELECT
    SIGNAL_ID,
    SOURCE_NAME,
    SIGNAL_TIMESTAMP,
    SIGNAL_TITLE,
    SIGNAL_TEXT
FROM STRATIFIED
ORDER BY CELL_RANK ASC, SIGNAL_TIMESTAMP DESC
LIMIT %(signal_limit)s
"""

# The live-subject read. The ledger is append-only with one row per
# evaluation, so "is this subject still live" is a property of the LATEST row
# for each PREDICTION_ID -- an older ACTIVE row under a since-WITHDRAWN
# prediction must not suppress a fresh proposal.
#
# HORIZON_AT >= now keeps a prediction whose horizon has passed out of the
# list: it is due to be graded, not to block re-proposal.
LIVE_SUBJECTS_QUERY = """
WITH LATEST AS (
    SELECT
        SUBJECT_DESCRIPTOR,
        PREDICTION_STATUS,
        HORIZON_AT,
        ROW_NUMBER() OVER (
            PARTITION BY PREDICTION_ID ORDER BY EVALUATED_AT DESC
        ) AS EVAL_RANK
    FROM {table}
)
SELECT DISTINCT SUBJECT_DESCRIPTOR
FROM LATEST
WHERE EVAL_RANK = 1
  AND PREDICTION_STATUS = 'ACTIVE'
  AND HORIZON_AT >= CURRENT_TIMESTAMP()
ORDER BY SUBJECT_DESCRIPTOR ASC
LIMIT %(subject_limit)s
"""


def _positive_int(name: str, value: Any) -> int:
    """Coerce a scope bound to a positive int, or refuse.

    Load-bearing, not defensive: the Snowflake connector's default ``pyformat``
    paramstyle binds client-side, so the statement that actually reaches the
    warehouse is the post-substitution text -- which ``assert_generation_sql``
    never saw when it was handed the template. These two params being ints is
    what makes substitution incapable of changing the statement's shape, so
    the coercion is written out here rather than left implicit in an ``int()``
    at the call site. The rendered statement is guarded as well (see
    ``recent_signals``); this is the half that makes the guard's job possible.
    """
    coerced = int(value)
    if coerced < 1:
        raise ValueError(f"{name} must be at least 1, got {coerced}")
    return coerced


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
    """The generation phase's evidence source."""

    def recent_signals(self, *, lookback_hours: int, limit: int) -> list[SignalRecord]: ...


class LiveSubjectReader(Protocol):
    """Subjects that already carry a live ACTIVE prediction."""

    def live_subjects(self) -> list[str]: ...


class SignalQueryRunner(Protocol):
    """The read half of a warehouse client. Narrowed as a declaration of what
    this module uses -- see the module docstring on what that does and does
    not enforce."""

    def query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]: ...


class SnowflakeSignalReader:
    """Reads ``FCT_SIGNALS`` and nothing else.

    ``table`` is injected so the service's own database/schema qualification
    (``Settings.qualify``) stays in one place, but a caller cannot use it to
    smuggle in a different table: ``assert_generation_sql`` sees the rendered
    statement and rejects any FROM target that is not the signal corpus
    before the client is ever called.
    """

    def __init__(self, client: SignalQueryRunner, table: str = SIGNALS_TABLE) -> None:
        self._client = client
        self._table = table

    def recent_signals(self, *, lookback_hours: int, limit: int) -> list[SignalRecord]:
        params = {
            "lookback_hours": _positive_int("lookback_hours", lookback_hours),
            "signal_limit": _positive_int("signal_limit", limit),
        }
        sql = SIGNAL_QUERY.format(table=self._table)
        # Guard the statement as the connector will render it, not just the
        # template -- see _positive_int. (Adding a literal `%` to the SQL, a
        # LIKE pattern say, makes this substitution raise: escape it as `%%`,
        # which is what the connector needs anyway.)
        assert_generation_sql(sql % params, allowed_tables=(SIGNALS_TABLE,))
        rows = self._client.query(sql, params)
        return [SignalRecord.from_row(row) for row in rows]


class SnowflakeLiveSubjectReader:
    """Reads the live ACTIVE subjects out of the pillar's own verdict ledger.

    This is not a hole in the generation phase's blindness (AC5): the verdict
    ledger is the prediction pillar's output, not trend/heat/lifecycle state,
    and the CONTEXT.md isolation invariant runs the other way -- no trend
    scoring path may read it. Nothing about the trend pipeline's attention
    reaches the agent through this list; it carries subject strings the agent
    itself wrote. The blindness guard is extended by an explicit second
    allowed table rather than relaxed.
    """

    def __init__(
        self,
        client: SignalQueryRunner,
        table: str = VERDICT_LEDGER_TABLE,
        *,
        limit: int = DEFAULT_LIVE_SUBJECT_LIMIT,
    ) -> None:
        self._client = client
        self._table = table
        self._limit = limit

    def live_subjects(self) -> list[str]:
        params = {"subject_limit": _positive_int("subject_limit", self._limit)}
        sql = LIVE_SUBJECTS_QUERY.format(table=self._table)
        assert_generation_sql(sql % params, allowed_tables=(VERDICT_LEDGER_TABLE,))
        rows = self._client.query(sql, params)
        subjects = []
        for row in rows:
            value = row.get("SUBJECT_DESCRIPTOR", row.get("subject_descriptor"))
            if value:
                subjects.append(str(value))
        return subjects


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


class StaticLiveSubjectReader:
    """The local loop's live-subject list: whatever the caller says, default
    nothing. Keeps the offline run exercising the same dedupe path."""

    def __init__(self, subjects: Iterable[str] = ()) -> None:
        self._subjects = [str(s) for s in subjects]

    def live_subjects(self) -> list[str]:
        return list(self._subjects)
