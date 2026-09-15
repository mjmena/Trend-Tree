"""The calibration label tier: retained, never live-trained (CRMA-768 AC4).

    "Strategist Approve/Dismiss decisions are retained as a calibration label
    tier -- recorded now, regression-tuned against later, never
    live-trained." (strategy doc 7.4; PRD's user story 29)

So this module has exactly one direction: **out**. It turns a strategist
decision into a row in ``FCT_PREDICTION_STRATEGIST_LABELS`` and offers no way
to read one back. There is no SELECT here, no lookup, no aggregate, and
``assert_label_sql`` refuses to hand a warehouse client anything but a single
MERGE into that one table. That is the structural half of AC4's "no code path
adjusts confidence from them at runtime": a number cannot be adjusted from a
tier nothing can read.

The behavioural half is in tests/test_strategist_isolation.py, which sweeps
the whole decision space and asserts the confidence written is the confidence
the model gave, unchanged -- following matching/isolation.py and
tests/test_no_mechanical_filter.py, the existing precedent for this shape.

**Idempotency.** ``LABEL_ID`` is derived from the decision's own identity
(prediction id + action + the moment it was taken), so the daily sweep
re-reading the same standing decision every day MERGEs into the one row it
already wrote instead of appending a label per day. A strategist who changes
their mind produces a new ``DECIDED_AT`` and therefore a new label -- the
tier keeps the whole sequence of human judgements, which is the point of
retaining it.
"""

from __future__ import annotations

import logging
import re
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Any

from .decisions import DecisionLookup, StrategistDecision

log = logging.getLogger(__name__)

#: The label tier's table (sql/fct_prediction_strategist_labels.sql).
#: Unqualified; routes/sweep.py qualifies it, like every other table name in
#: this service.
LABEL_TABLE = "FCT_PREDICTION_STRATEGIST_LABELS"

#: Bump when the label contract changes -- same lineage column the verdict
#: ledger carries, written explicitly rather than defaulted server-side.
LABEL_VERSION = "v1"

#: Namespace for deriving LABEL_IDs. Distinct from the three eval-id
#: namespaces so a label id can never collide with a verdict row's id.
LABEL_ID_NAMESPACE = uuid.UUID("6b1c8f52-9a47-5d18-8c62-1e35a0d47b9f")

_KEY_SEP = "\x1f"

MERGE_LABEL = """
MERGE INTO {table} AS labels
USING (SELECT %(label_id)s AS LABEL_ID) AS incoming
  ON labels.LABEL_ID = incoming.LABEL_ID
WHEN NOT MATCHED THEN INSERT (
  LABEL_ID, PREDICTION_ID, DECISION, DECIDED_AT, DECIDED_BY,
  OBSERVED_CONFIDENCE, OBSERVED_FLAG, VERDICT_CONFIDENCE, VERDICT_STATUS,
  DECISION_SOURCE, RECORDED_AT, CHAIN_ID, LABEL_VERSION
) VALUES (
  %(label_id)s, %(prediction_id)s, %(decision)s, %(decided_at)s, %(decided_by)s,
  %(observed_confidence)s, %(observed_flag)s, %(verdict_confidence)s, %(verdict_status)s,
  %(decision_source)s, %(recorded_at)s, %(chain_id)s, %(label_version)s
)
"""


class CalibrationLabelIsolationViolation(RuntimeError):
    """A statement issued against the calibration label tier that was not a
    single write into the label table. Raised *before* the statement is
    issued, so the tier stays write-only by construction rather than by
    review."""


class LabelWriteFailed(RuntimeError):
    """A label MERGE failed after the shared client exhausted its retries.

    Never fatal to a sweep: the verdict rows are the pillar's output, and the
    labels are collected for a tuning pass that has not happened yet. The
    route reports this and carries on -- see routes/sweep.py.
    """

    def __init__(self, *, written: int, total: int, label_id: str) -> None:
        super().__init__(
            f"calibration label write failed after {written} of {total} row(s) landed; "
            f"the ledger keeps them (failed on {label_id})"
        )
        self.written = written
        self.total = total
        self.label_id = label_id


_SINGLE_MERGE = re.compile(r"^\s*MERGE\s+INTO\s+(\S+)", re.IGNORECASE)


def assert_label_sql(sql: str, *, table: str) -> None:
    """Raise unless ``sql`` is one MERGE into ``table``.

    The calibration tier writes and does nothing else. A SELECT against it --
    however innocent it looked at the time -- is the first step of feeding
    human labels back into a live number, which the strategy forbids, so it
    is refused here rather than reviewed for later.
    """
    body = str(sql)
    if ";" in body.strip().rstrip(";"):
        raise CalibrationLabelIsolationViolation(
            "the calibration label tier issues one statement at a time; this text contains "
            f"more than one: {body.strip()[:80]!r}"
        )
    match = _SINGLE_MERGE.match(body)
    if not match:
        raise CalibrationLabelIsolationViolation(
            "the calibration label tier is write-only: strategist decisions are retained "
            "for a later regression pass and no runtime path may read one back. Expected a "
            f"MERGE INTO {table}, got {body.strip()[:80]!r}"
        )
    if match.group(1).strip('"').upper() != table.upper():
        raise CalibrationLabelIsolationViolation(
            f"the calibration label tier writes only to {table}; this statement targets "
            f"{match.group(1)!r}"
        )


@dataclass(frozen=True)
class CalibrationLabel:
    """One retained human judgement.

    Carries the decision (the label), the prediction it was about, when it
    was taken, and what both the strategist and the pillar were reading at
    the time -- everything a later regression needs, and nothing this service
    reads back.
    """

    label_id: str
    prediction_id: str
    decision: str
    decided_at: datetime
    recorded_at: datetime
    decided_by: str | None = None
    #: What the strategist was looking at when they acted (the Insights side
    #: stores both at decision time).
    observed_confidence: float | None = None
    observed_flag: str | None = None
    #: What the pillar's own verdict read at the evaluation that recorded
    #: this label -- the feature side of a later calibration fit.
    verdict_confidence: float | None = None
    verdict_status: str | None = None
    decision_source: str | None = None
    chain_id: str | None = None


def label_id_for(decision: StrategistDecision) -> str:
    """The label's identity, derived from the decision itself.

    Two properties: a standing decision re-read on every daily sweep produces
    the same id and therefore one row, and a strategist changing their mind
    produces a different ``DECIDED_AT`` and therefore a second row rather
    than overwriting the first. The tier keeps the whole sequence.
    """
    return str(
        uuid.uuid5(
            LABEL_ID_NAMESPACE,
            _KEY_SEP.join(
                (decision.prediction_id, decision.decision, decision.decided_at.isoformat())
            ),
        )
    )


def calibration_labels(
    lookup: DecisionLookup,
    *,
    verdicts: dict[str, tuple[float, str]] | None = None,
    recorded_at: datetime,
    chain_id: str | None = None,
) -> list[CalibrationLabel]:
    """Every decision this sweep read, as labels.

    ``verdicts`` maps PREDICTION_ID to the (confidence, status) this
    evaluation wrote -- keyed, not positional, for the same reason the
    decisions themselves are: two live calls can share a subject, and a label
    carrying the wrong call's confidence is a silently poisoned training row.
    A prediction missing from the map simply records no pillar-side reading.
    """
    readings = verdicts or {}
    labels: list[CalibrationLabel] = []
    for prediction_id, decision in sorted(lookup.decisions.items()):
        confidence, status = readings.get(prediction_id, (None, None))
        labels.append(
            CalibrationLabel(
                label_id=label_id_for(decision),
                prediction_id=prediction_id,
                decision=decision.decision,
                decided_at=decision.decided_at,
                recorded_at=recorded_at,
                decided_by=decision.decided_by,
                observed_confidence=decision.observed_confidence,
                observed_flag=decision.observed_flag,
                verdict_confidence=confidence,
                verdict_status=status,
                decision_source=decision.source,
                chain_id=chain_id,
            )
        )
    return labels


def label_params(label: CalibrationLabel) -> dict[str, Any]:
    return {
        "label_id": label.label_id,
        "prediction_id": label.prediction_id,
        "decision": label.decision,
        "decided_at": label.decided_at,
        "decided_by": label.decided_by,
        "observed_confidence": label.observed_confidence,
        "observed_flag": label.observed_flag,
        "verdict_confidence": label.verdict_confidence,
        "verdict_status": label.verdict_status,
        "decision_source": label.decision_source,
        "recorded_at": label.recorded_at,
        "chain_id": label.chain_id,
        "label_version": LABEL_VERSION,
    }


def write_calibration_labels(
    client, table: str, labels: Sequence[CalibrationLabel], *, chain_id: str | None = None
) -> set[str]:
    """MERGE each label, in order. Returns the LABEL_IDs this call inserted;
    a MERGE that matched is a re-read of a standing decision, not a failure.

    A plain set rather than ``writes.WriteReport``: that type separates
    "inserted" from "deduplicated" because a deduplicated *verdict* means a
    retry landed twice and the caller has to say which attempt wrote the row.
    A deduplicated label is the ordinary daily path -- a standing decision
    read again -- and is not an event anyone needs reported.

    Raises ``LabelWriteFailed`` on the first failure, having kept whatever
    landed before it. The caller decides what that means -- for the sweep it
    is a note, not an error, because the verdict rows have already landed and
    the labels are for a tuning pass that has not happened yet.
    """
    statement = MERGE_LABEL.format(table=table)
    assert_label_sql(statement, table=table)
    written: set[str] = set()
    for label in labels:
        try:
            rows = client.execute(statement, label_params(label))
        except Exception as err:
            log.exception(
                "calibration label write failed",
                extra={"chain_id": chain_id, "label_id": label.label_id},
            )
            raise LabelWriteFailed(
                written=len(written), total=len(labels), label_id=label.label_id
            ) from err
        if rows > 0:
            written.add(label.label_id)
    return written
