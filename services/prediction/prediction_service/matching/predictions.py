"""The live predictions the compare step and the re-evaluation sweep read
(CRMA-764, generalized by CRMA-766).

"Live" is a property of the *latest* row for each PREDICTION_ID, not of any
row: the ledger is append-only with one row per evaluation, so an older
ACTIVE row under a since-WITHDRAWN prediction must not resurrect it.

Which statuses count as live is the caller's, not this module's: matching
wants ACTIVE, the sweep wants ACTIVE plus EXPIRED (the grace window). See
``validated_statuses``.

The claim comes back off the ledger and is carried forward verbatim -- all
four parts including ``HORIZON_AT``, which is derived at mint and must not
move when a later evaluation re-states it. So does ``EVIDENCE``: the compare
step sets ``trend_context`` and touches nothing else in the payload, which
keeps ``source_signals`` intact and leaves ``saturation`` and ``coverage``
to the phases that own them.
"""

from __future__ import annotations

import json
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Protocol

from ..domain.claim import VALID_STATUSES, Claim
from .isolation import assert_matching_sql, positive_int

#: The pillar's own verdict ledger -- the compare step's input and, via the
#: route, its output. Unqualified; routes/match.py qualifies it.
VERDICT_LEDGER_TABLE = "FCT_PREDICTION_VERDICT_LEDGER"

#: How many open predictions one run evaluates. A cap on cost and blast
#: radius, not a gate on what qualifies -- and the ORDER BY below is what
#: makes that true rather than merely stated. See OPEN_PREDICTIONS_QUERY.
DEFAULT_PREDICTION_LIMIT = 50

#: The statuses the compare step reads. "Open" for matching means ACTIVE and
#: only ACTIVE -- a resolved, expired or withdrawn prediction has nothing left
#: to match.
DEFAULT_STATUSES: tuple[str, ...] = ("ACTIVE",)

#: The statuses the re-evaluation sweep reads (CRMA-766). EXPIRED is in the
#: set because the strategy's grace window keeps re-checking a prediction for
#: one further horizon length past HORIZON_AT -- a truth arriving in that
#: window has to be able to flip it to RESOLVED_TRUE. Rows past the grace
#: window come back too and are dropped by sweep/lifecycle.py, which is where
#: the arithmetic that decides "past" lives; the SQL does no date math, so
#: nothing here compares a horizon against a clock.
LIVE_STATUSES: tuple[str, ...] = ("ACTIVE", "EXPIRED")


def validated_statuses(statuses: Iterable[str]) -> tuple[str, ...]:
    """The status set, checked against the ledger's enum and de-duplicated.

    The set is bound into the statement as a JSON array (see
    OPEN_PREDICTIONS_QUERY), so it is the one caller-supplied value in this
    module that is neither an int nor quoted by the connector's own binding
    of a scalar. Checking it against ``VALID_STATUSES`` -- the same
    vocabulary ``build_verdict`` enforces on the way out -- is what makes the
    bind incapable of carrying anything but a status name, and it catches the
    likelier mistake too: a typo like ``"RESOLVED"`` would otherwise select
    nothing and read as "no predictions are live".
    """
    ordered = tuple(dict.fromkeys(str(status).strip().upper() for status in statuses))
    if not ordered:
        raise ValueError("at least one prediction status must be requested")
    unknown = sorted(set(ordered) - VALID_STATUSES)
    if unknown:
        raise ValueError(
            f"unknown prediction status: {unknown} (expected a subset of "
            f"{sorted(VALID_STATUSES)})"
        )
    return ordered

# EVAL_RANK ties break on PREDICTION_EVAL_ID so two rows written inside the
# same clock tick still resolve to one deterministic "latest".
#
# The status filter is ARRAY_CONTAINS over a bound JSON array rather than an
# interpolated IN list: the set is caller-supplied, and this keeps the
# statement TEXT a constant that assert_matching_sql and the isolation tests
# can check once, for every caller, instead of once per status set.
#
# There is no date arithmetic in this statement, deliberately. The sweep's
# grace window is decided in sweep/lifecycle.py from HORIZON_AT and the
# frozen horizon band -- values that are UTC by construction -- so nothing
# here compares a horizon against a warehouse session clock.
#
# The *outer* ORDER BY is oldest-evaluated first, and that direction is
# load-bearing. Every evaluation appends a row, so evaluating a prediction
# makes it the most recently evaluated one. Selecting newest-first would hand
# the cap back to the same head of the queue on every run: once the open pool
# grew past `prediction_limit`, the predictions past that point would never be
# selected again, would keep MATCHED_TREND_ID NULL forever, and would be
# indistinguishable in the ledger from genuine white space. Oldest-first makes
# repeated runs round-robin the whole pool, which is what a cap is supposed to
# do. Invisible at today's handful of open rows; certain at ~50.
OPEN_PREDICTIONS_QUERY = """
WITH LATEST AS (
    SELECT
        PREDICTION_ID,
        PREDICTION_EVAL_ID,
        SUBJECT_DESCRIPTOR,
        DIRECTIONAL_CLAIM,
        HORIZON_BAND,
        HORIZON_AT,
        OBSERVABLE_CHECK,
        CONFIDENCE,
        PREDICTION_STATUS,
        MATCHED_TREND_ID,
        EVIDENCE,
        REASONING,
        EVALUATED_AT,
        ROW_NUMBER() OVER (
            PARTITION BY PREDICTION_ID
            ORDER BY EVALUATED_AT DESC, PREDICTION_EVAL_ID DESC
        ) AS EVAL_RANK
    FROM {table}
)
SELECT
    PREDICTION_ID,
    PREDICTION_EVAL_ID,
    SUBJECT_DESCRIPTOR,
    DIRECTIONAL_CLAIM,
    HORIZON_BAND,
    HORIZON_AT,
    OBSERVABLE_CHECK,
    CONFIDENCE,
    PREDICTION_STATUS,
    MATCHED_TREND_ID,
    EVIDENCE,
    REASONING,
    EVALUATED_AT
FROM LATEST
WHERE EVAL_RANK = 1
  AND ARRAY_CONTAINS(PREDICTION_STATUS::VARIANT, PARSE_JSON(%(statuses)s))
ORDER BY EVALUATED_AT ASC, PREDICTION_EVAL_ID ASC
LIMIT %(prediction_limit)s
"""


def _get(row: Mapping[str, Any], name: str) -> Any:
    if name in row:
        return row[name]
    return row.get(name.lower())


def _evidence(raw: Any) -> dict[str, Any]:
    """The prior row's EVIDENCE as a dict.

    The connector hands a VARIANT back as its JSON text; a fixture hands back
    the dict directly. Anything else -- including a VARIANT holding a scalar
    or an array -- becomes an empty dict rather than an exception: a prior
    row with an unreadable evidence payload is a reason to rebuild the
    contracted keys, not a reason to drop the prediction.
    """
    if isinstance(raw, Mapping):
        return dict(raw)
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            return {}
        if isinstance(parsed, dict):
            return parsed
    return {}


def _as_datetime(raw: Any) -> datetime:
    """A ledger timestamp as an aware UTC datetime.

    The connector hands back real datetimes and the ledger's columns are
    TIMESTAMP_NTZ written in UTC, so a naive value is *stamped* UTC. A string
    that already carries an offset is a different case -- a fixture or a JSON
    payload -- and it is *converted*, not re-stamped: ``.replace(tzinfo=UTC)``
    on "2027-02-14T00:00:00+02:00" would silently move the instant two hours.
    """
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=UTC)
    parsed = datetime.fromisoformat(str(raw))
    return parsed.replace(tzinfo=UTC) if parsed.tzinfo is None else parsed.astimezone(UTC)


@dataclass(frozen=True)
class OpenPrediction:
    """One live prediction, as read off the ledger's latest row for it."""

    prediction_id: str
    claim: Claim
    #: Frozen at mint. Re-stated, never re-derived -- see the module docstring.
    horizon_at: datetime
    confidence: float
    status: str = "ACTIVE"
    matched_trend_id: str | None = None
    evidence: dict[str, Any] = field(default_factory=dict)
    reasoning: str = ""
    prior_eval_id: str | None = None

    @classmethod
    def from_row(cls, row: Mapping[str, Any]) -> OpenPrediction:
        return cls(
            prediction_id=str(_get(row, "PREDICTION_ID") or ""),
            claim=Claim(
                subject_descriptor=str(_get(row, "SUBJECT_DESCRIPTOR") or ""),
                directional_claim=str(_get(row, "DIRECTIONAL_CLAIM") or ""),
                horizon_band=str(_get(row, "HORIZON_BAND") or ""),  # type: ignore[arg-type]
                observable_check=str(_get(row, "OBSERVABLE_CHECK") or ""),
            ),
            horizon_at=_as_datetime(_get(row, "HORIZON_AT")),
            confidence=float(_get(row, "CONFIDENCE") or 0),
            status=str(_get(row, "PREDICTION_STATUS") or "ACTIVE"),
            matched_trend_id=(
                str(_get(row, "MATCHED_TREND_ID"))
                if _get(row, "MATCHED_TREND_ID") is not None
                else None
            ),
            evidence=_evidence(_get(row, "EVIDENCE")),
            reasoning=str(_get(row, "REASONING") or ""),
            prior_eval_id=(
                str(_get(row, "PREDICTION_EVAL_ID"))
                if _get(row, "PREDICTION_EVAL_ID") is not None
                else None
            ),
        )


class OpenPredictionReader(Protocol):
    def open_predictions(self, *, limit: int) -> list[OpenPrediction]: ...


class LedgerQueryRunner(Protocol):
    def query(self, sql: str, params: Mapping[str, Any] | None = None) -> list[dict[str, Any]]: ...


class SnowflakeOpenPredictionReader:
    """Reads the verdict ledger's live predictions and nothing else.

    ``statuses`` is what makes one reader serve two callers: the compare step
    wants ACTIVE (``DEFAULT_STATUSES``), the re-evaluation sweep wants ACTIVE
    plus EXPIRED (``LIVE_STATUSES``, for the grace window). Everything else
    -- the latest-row-per-prediction window, the oldest-first ordering that
    keeps the cap from starving the tail of the pool, the verbatim claim --
    is identical for both, which is why there is no second reader.
    """

    def __init__(
        self,
        client: LedgerQueryRunner,
        table: str = VERDICT_LEDGER_TABLE,
        *,
        statuses: Iterable[str] = DEFAULT_STATUSES,
    ) -> None:
        self._client = client
        self._table = table
        self._statuses = validated_statuses(statuses)

    @property
    def statuses(self) -> tuple[str, ...]:
        return self._statuses

    def open_predictions(self, *, limit: int = DEFAULT_PREDICTION_LIMIT) -> list[OpenPrediction]:
        sql = OPEN_PREDICTIONS_QUERY.format(table=self._table)
        assert_matching_sql(sql, allowed_tables=(VERDICT_LEDGER_TABLE,))
        params = {
            "prediction_limit": positive_int("prediction_limit", limit),
            "statuses": json.dumps(list(self._statuses)),
        }
        return [OpenPrediction.from_row(row) for row in self._client.query(sql, params)]


class StaticOpenPredictionReader:
    """The local loop's open-prediction list: whatever the caller supplies,
    filtered to ``statuses`` the way the warehouse reader's WHERE clause
    filters -- so an offline run cannot see a prediction the deployed one
    would not."""

    def __init__(
        self,
        rows: Iterable[Mapping[str, Any]] = (),
        *,
        statuses: Iterable[str] = DEFAULT_STATUSES,
    ) -> None:
        self._statuses = validated_statuses(statuses)
        self._rows: Sequence[OpenPrediction] = [
            prediction
            for prediction in (OpenPrediction.from_row(row) for row in rows)
            if prediction.status.upper() in self._statuses
        ]

    @property
    def statuses(self) -> tuple[str, ...]:
        return self._statuses

    def open_predictions(
        self, *, limit: int = DEFAULT_PREDICTION_LIMIT
    ) -> list[OpenPrediction]:
        return list(self._rows[: max(0, int(limit))])
