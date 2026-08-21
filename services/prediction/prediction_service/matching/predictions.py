"""The open predictions the compare step evaluates (CRMA-764).

"Open" is a property of the *latest* row for each PREDICTION_ID, not of any
row: the ledger is append-only with one row per evaluation, so an older
ACTIVE row under a since-WITHDRAWN prediction must not resurrect it.

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

from ..domain.claim import Claim
from .isolation import assert_matching_sql, positive_int

#: The pillar's own verdict ledger -- the compare step's input and, via the
#: route, its output. Unqualified; routes/match.py qualifies it.
VERDICT_LEDGER_TABLE = "FCT_PREDICTION_VERDICT_LEDGER"

#: How many open predictions one run evaluates. A cap on cost and blast
#: radius, not a gate on what qualifies.
DEFAULT_PREDICTION_LIMIT = 50

# EVAL_RANK ties break on PREDICTION_EVAL_ID so two rows written inside the
# same clock tick still resolve to one deterministic "latest".
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
  AND PREDICTION_STATUS = 'ACTIVE'
ORDER BY EVALUATED_AT DESC, PREDICTION_EVAL_ID DESC
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
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=UTC)
    return datetime.fromisoformat(str(raw)).replace(tzinfo=UTC)


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
    """Reads the verdict ledger's open predictions and nothing else."""

    def __init__(self, client: LedgerQueryRunner, table: str = VERDICT_LEDGER_TABLE) -> None:
        self._client = client
        self._table = table

    def open_predictions(self, *, limit: int = DEFAULT_PREDICTION_LIMIT) -> list[OpenPrediction]:
        sql = OPEN_PREDICTIONS_QUERY.format(table=self._table)
        assert_matching_sql(sql, allowed_tables=(VERDICT_LEDGER_TABLE,))
        params = {"prediction_limit": positive_int("prediction_limit", limit)}
        return [OpenPrediction.from_row(row) for row in self._client.query(sql, params)]


class StaticOpenPredictionReader:
    """The local loop's open-prediction list: whatever the caller supplies."""

    def __init__(self, rows: Iterable[Mapping[str, Any]] = ()) -> None:
        self._rows: Sequence[OpenPrediction] = [OpenPrediction.from_row(row) for row in rows]

    def open_predictions(
        self, *, limit: int = DEFAULT_PREDICTION_LIMIT
    ) -> list[OpenPrediction]:
        return list(self._rows[: max(0, int(limit))])
