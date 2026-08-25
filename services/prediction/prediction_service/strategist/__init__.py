"""The strategist tier: human action outranks automation (CRMA-768).

The Predictions Queue gives a content strategist two actions, and the
strategy doc (7.4) makes both of them outrank everything the pillar computes:

* **Dismiss** -> the next verdict records ``WITHDRAWN``. The call leaves the
  queue and is excluded from the track record (CRMA-771's derivation already
  excludes it).
* **Approve** -> the call is protected from coverage and automated demotion
  until the next human touch, and holds its queue standing.

Three pieces, deliberately separate:

* ``decisions`` -- the read seam. The decisions live in Insights Postgres
  (``prediction_decisions``), owned by the Insights Agent side and not yet
  reachable from this service; what ships is the Protocol, an offline reader
  and an explicitly-unavailable one. Binding is by ``PREDICTION_ID`` only.
* ``precedence`` -- the ladder, pure: strategist action > coverage demotion
  > automated evidence. Coverage arrives as an argument (CRMA-767 owns
  detection), so the ladder is complete and testable on its own.
* ``labels`` -- the calibration label tier. Every decision is retained with
  its prediction id and timestamp for later regression tuning, and no runtime
  path reads one back. That isolation is asserted structurally in
  tests/test_strategist_isolation.py, following matching/isolation.py's
  precedent.

**No new mechanical gate.** Nothing in this package filters, suppresses or
refuses a prediction. ``WITHDRAWN`` is a human's decision recorded as a
status; a dropped decision row keeps the prior standing rather than rejecting
anything; and an unreadable decision source leaves automation running exactly
as it would have.
"""

from __future__ import annotations

from .decisions import (
    DECISION_APPROVE,
    DECISION_DISMISS,
    DECISIONS,
    SOURCE_INSIGHTS_POSTGRES,
    UNAVAILABLE_NOT_PROVISIONED,
    UNAVAILABLE_READ_FAILED,
    DecisionLookup,
    DecisionRead,
    StaticStrategistDecisionReader,
    StrategistDecision,
    StrategistDecisionReader,
    UnavailableDecisionReader,
    read_decisions,
)
from .evidence import PRECEDENCE_LADDER, STRATEGIST_KEY, strategist_evidence
from .labels import (
    LABEL_ID_NAMESPACE,
    LABEL_TABLE,
    LABEL_VERSION,
    MERGE_LABEL,
    CalibrationLabel,
    CalibrationLabelIsolationViolation,
    LabelWriteFailed,
    assert_label_sql,
    calibration_labels,
    label_id_for,
    label_params,
    write_calibration_labels,
)
from .precedence import (
    DEMOTED_BY_AUTOMATED_EVIDENCE,
    DEMOTED_BY_COVERAGE,
    POSTURE_ACT,
    POSTURE_WATCH_COVERED,
    POSTURE_WITHDRAWN,
    POSTURES,
    TIER_AUTOMATED_EVIDENCE,
    TIER_COVERAGE_DEMOTION,
    TIER_STRATEGIST_ACTION,
    PostureDecision,
    attributed_to,
    resolve_posture,
    withdrawal_reason,
)

__all__ = [
    "CalibrationLabel",
    "CalibrationLabelIsolationViolation",
    "DECISIONS",
    "DEMOTED_BY_AUTOMATED_EVIDENCE",
    "DEMOTED_BY_COVERAGE",
    "DECISION_APPROVE",
    "DECISION_DISMISS",
    "DecisionLookup",
    "DecisionRead",
    "LABEL_ID_NAMESPACE",
    "LABEL_TABLE",
    "LABEL_VERSION",
    "LabelWriteFailed",
    "MERGE_LABEL",
    "POSTURES",
    "POSTURE_ACT",
    "POSTURE_WATCH_COVERED",
    "POSTURE_WITHDRAWN",
    "PRECEDENCE_LADDER",
    "PostureDecision",
    "SOURCE_INSIGHTS_POSTGRES",
    "STRATEGIST_KEY",
    "StaticStrategistDecisionReader",
    "StrategistDecision",
    "StrategistDecisionReader",
    "TIER_AUTOMATED_EVIDENCE",
    "TIER_COVERAGE_DEMOTION",
    "TIER_STRATEGIST_ACTION",
    "UNAVAILABLE_NOT_PROVISIONED",
    "UNAVAILABLE_READ_FAILED",
    "UnavailableDecisionReader",
    "assert_label_sql",
    "attributed_to",
    "calibration_labels",
    "label_id_for",
    "label_params",
    "read_decisions",
    "resolve_posture",
    "strategist_evidence",
    "withdrawal_reason",
    "write_calibration_labels",
]
