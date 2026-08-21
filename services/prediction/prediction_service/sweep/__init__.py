"""The daily re-evaluation sweep (CRMA-766).

The pillar runs itself: Cloud Scheduler fires ``POST /sweep`` once a day over
OIDC (deploy/scheduler.sh), the sweep re-evaluates every live prediction and
appends a row for each, and a generation pass runs in the same request so one
scheduled call keeps the whole pillar moving.

Public surface:

* ``sweep_predictions`` / ``SweepScope`` / ``SweepResult`` -- the pass.
* ``next_status`` / ``Observation`` / ``grace_ends_at`` / ``is_reevaluable``
  -- the status machine and the grace window, pure.
* ``confidence_direction`` / ``confidence_delta`` -- derived, never stored.
* ``compose_what_changed`` -- the note.
* ``build_system_prompt`` / ``build_user_prompt`` / ``parse_reevaluations``
  -- the re-evaluation turn, as pure functions.
"""

from __future__ import annotations

from .changes import NOTHING_MOVED, compose_what_changed
from .direction import (
    FIRST_EVALUATION,
    LEDGER_PRECISION_TOLERANCE,
    STRENGTHENED,
    UNCHANGED,
    WEAKENED,
    confidence_delta,
    confidence_direction,
)
from .lifecycle import (
    OBSERVATIONS,
    OBSERVED_FAILED,
    OBSERVED_MET,
    OBSERVED_NOT_YET,
    TERMINAL_STATUSES,
    Observation,
    StatusDecision,
    grace_ends_at,
    grace_remaining,
    is_past_grace,
    is_reevaluable,
    next_status,
)
from .parse import Reevaluation, UnparseableReevaluation, parse_reevaluations
from .prompt import (
    REEVALUATION_MARKER,
    ReevaluationItem,
    build_system_prompt,
    build_user_prompt,
)
from .run import (
    SWEEP_EVAL_ID_NAMESPACE,
    SkippedPrediction,
    SweepOutcome,
    SweepResult,
    SweepScope,
    daily_chain_id,
    eval_id_for,
    new_chain_id,
    sweep_predictions,
)

__all__ = [
    "FIRST_EVALUATION",
    "LEDGER_PRECISION_TOLERANCE",
    "NOTHING_MOVED",
    "OBSERVATIONS",
    "OBSERVED_FAILED",
    "OBSERVED_MET",
    "OBSERVED_NOT_YET",
    "REEVALUATION_MARKER",
    "STRENGTHENED",
    "SWEEP_EVAL_ID_NAMESPACE",
    "TERMINAL_STATUSES",
    "UNCHANGED",
    "WEAKENED",
    "Observation",
    "Reevaluation",
    "ReevaluationItem",
    "SkippedPrediction",
    "StatusDecision",
    "SweepOutcome",
    "SweepResult",
    "SweepScope",
    "UnparseableReevaluation",
    "build_system_prompt",
    "build_user_prompt",
    "compose_what_changed",
    "confidence_delta",
    "confidence_direction",
    "daily_chain_id",
    "eval_id_for",
    "grace_ends_at",
    "grace_remaining",
    "is_past_grace",
    "is_reevaluable",
    "new_chain_id",
    "next_status",
    "parse_reevaluations",
    "sweep_predictions",
]
