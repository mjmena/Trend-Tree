"""The strategist Approve/Dismiss decisions the sweep reads (CRMA-768).

The decisions themselves are made in the Insights Agent's Predictions Queue
and stored in **Insights Postgres** (`prediction_decisions`), which the PRD
lists as an external dependency with an owner on the Insights Agent side.
Access to that database is not provisioned to this service today (see
``docs/access-requests/insights-postgres-prediction-decisions.md``), so what
ships here is the seam and not the adapter:

* ``StrategistDecisionReader`` -- the Protocol the sweep depends on, shaped
  like ``OpenPredictionReader`` and the saturation oracles;
* ``StaticStrategistDecisionReader`` -- the offline flavor tests and the
  local loop run against;
* ``UnavailableDecisionReader`` -- the deployed default until the grant
  lands. It answers "nobody could be asked", which is not the same fact as
  "nobody has acted", and the evidence says which.

**Binding is by PREDICTION_ID and by nothing else.** Three stories on this
epic shipped a batched read that bound its results to domain objects by
position or by the subject descriptor, and one of them closed the wrong
prediction permanently. A subject descriptor is not unique -- two live calls
can share one -- and a decision bound to the wrong prediction is a strategist
withdrawing a call they never saw. So ``read_decisions`` indexes by the id
the row itself carries, drops a row whose id was not asked about, and never
reads a row's position. A drop keeps the prior value ("no human has acted
here"), never a rejection.

**Nothing here raises.** A Postgres outage must not stop the pillar writing
verdicts -- the same stance saturation/lookup.py takes on Exploding Topics,
and for a stronger reason: an unreadable decision source means automation
carries on unchecked, and failing the sweep over it would stop the calls a
strategist has already approved from being re-evaluated at all.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Protocol

log = logging.getLogger(__name__)

#: The two actions the Predictions Queue offers (strategy doc 7.4).
DECISION_APPROVE = "APPROVE"
DECISION_DISMISS = "DISMISS"

DECISIONS: frozenset[str] = frozenset({DECISION_APPROVE, DECISION_DISMISS})

#: Where a decision came from, recorded on every calibration label so a later
#: regression pass can tell a real strategist action from a backfill.
SOURCE_INSIGHTS_POSTGRES = "insights_postgres.prediction_decisions"

#: Why the decision source could not be read. Each is "we could not ask",
#: never "nobody acted" -- the distinction is worth saying out loud in the
#: evidence, and it is the honest reading while the grant is outstanding.
UNAVAILABLE_NOT_PROVISIONED = (
    "the Insights Postgres prediction_decisions table is not reachable from this service: "
    "read access has not been provisioned (see "
    "docs/access-requests/insights-postgres-prediction-decisions.md). No strategist "
    "decision was read, so no call was withdrawn and none is protected"
)
UNAVAILABLE_READ_FAILED = "the strategist decision read failed"


@dataclass(frozen=True)
class StrategistDecision:
    """One strategist action on one prediction, as the Predictions Queue
    recorded it.

    ``prediction_id`` is the binding key and the only one. ``decided_at`` is
    what makes "until the next human touch" enforceable without storing a
    protection flag anywhere: the reader resolves the latest decision per
    prediction, so a Dismiss after an Approve simply replaces it.

    ``observed_confidence`` / ``observed_flag`` are what the strategist was
    looking at when they acted -- the Insights side stores both at decision
    time. They are carried for the calibration label tier and are read by no
    runtime path (see strategist/labels.py and tests/test_strategist_isolation.py).
    """

    prediction_id: str
    decision: str
    decided_at: datetime
    decided_by: str | None = None
    observed_confidence: float | None = None
    observed_flag: str | None = None
    source: str = SOURCE_INSIGHTS_POSTGRES

    def __post_init__(self) -> None:
        if not str(self.prediction_id).strip():
            raise ValueError("a strategist decision must name the prediction it acted on")
        if self.decision not in DECISIONS:
            raise ValueError(
                f"unknown strategist decision: {self.decision!r} "
                f"(expected one of {sorted(DECISIONS)})"
            )

    @property
    def is_approve(self) -> bool:
        return self.decision == DECISION_APPROVE

    @property
    def is_dismiss(self) -> bool:
        return self.decision == DECISION_DISMISS

    def as_evidence(self) -> dict[str, Any]:
        """The decision as it lands in ``EVIDENCE.strategist``. Read by a
        human and by CRMA-769's projection; read by no scoring path."""
        return {
            "decision": self.decision,
            "prediction_id": self.prediction_id,
            "decided_at": self.decided_at.isoformat(),
            "decided_by": self.decided_by,
            "source": self.source,
        }


@dataclass(frozen=True)
class DecisionLookup:
    """What the decision source said about one sweep's predictions.

    ``available`` separates "we asked and nobody has acted" from "we could
    not ask". Both leave every call unwithdrawn and unprotected -- there is
    no mechanical consequence either way -- but only one of them is a fact
    about the strategists.
    """

    decisions: Mapping[str, StrategistDecision] = field(default_factory=dict)
    available: bool = True
    unavailable_reason: str | None = None

    def for_prediction(self, prediction_id: str) -> StrategistDecision | None:
        return self.decisions.get(prediction_id)

    def as_evidence(self) -> dict[str, Any]:
        return {
            "source": SOURCE_INSIGHTS_POSTGRES,
            "available": self.available,
            "unavailable_reason": self.unavailable_reason,
        }


@dataclass(frozen=True)
class DecisionRead:
    """What one reader came back with.

    Same shape ``SaturationLookup`` and ``ArticleBreadth`` have: a flat
    result that carries its own miss, so a reader never raises to say "I
    could not look" and the caller never has to ask a reader what kind of
    reader it is.
    """

    decisions: Sequence[StrategistDecision] = ()
    available: bool = True
    unavailable_reason: str | None = None


class StrategistDecisionReader(Protocol):
    """Something that can answer "what did a strategist do about these
    predictions". Returns the rows it has, in any order; never raises."""

    def decisions_for(
        self, prediction_ids: Sequence[str]
    ) -> DecisionRead:  # pragma: no cover - Protocol
        ...


@dataclass
class StaticStrategistDecisionReader:
    """Whatever the caller says. The offline flavor -- what tests and
    local_sweep.py run against, and what a fixture-driven rehearsal of the
    tier uses before the Postgres grant lands."""

    decisions: Sequence[StrategistDecision] = ()
    asked: list[tuple[str, ...]] = field(default_factory=list)

    def decisions_for(self, prediction_ids: Sequence[str]) -> DecisionRead:
        self.asked.append(tuple(prediction_ids))
        wanted = set(prediction_ids)
        return DecisionRead(
            decisions=[d for d in self.decisions if d.prediction_id in wanted]
        )


@dataclass
class UnavailableDecisionReader:
    """The deployed reader until Insights Postgres access is granted: it
    reads nothing and says why.

    Deliberately not a no-op that returns an empty read silently. "No
    strategist has touched this call" and "we cannot see whether one has"
    produce the same postures, and the only thing that keeps them
    distinguishable in the ledger is that this reader names itself.
    """

    reason: str = UNAVAILABLE_NOT_PROVISIONED

    def decisions_for(self, prediction_ids: Sequence[str]) -> DecisionRead:
        return DecisionRead(available=False, unavailable_reason=self.reason)


def _latest(a: StrategistDecision, b: StrategistDecision) -> StrategistDecision:
    """The later of two decisions on one prediction.

    An exact-timestamp tie is not evidence of order, so it must not be
    resolved by whichever row the source happened to return first -- that is
    position-binding by the back door. It resolves to the **Approve**, and
    the asymmetry is deliberate: a WITHDRAWN verdict is final, the
    prediction is never read as live again, and no later sweep can undo it,
    while an Approve that should have been a Dismiss is corrected by the
    next sweep the moment the Dismiss carries a later timestamp. On a tie,
    take the recoverable branch.
    """
    if a.decided_at != b.decided_at:
        return a if a.decided_at > b.decided_at else b
    return a if a.is_approve else b


def read_decisions(
    reader: StrategistDecisionReader | None, prediction_ids: Sequence[str]
) -> DecisionLookup:
    """The latest strategist decision per prediction, bound by PREDICTION_ID.

    Every rejection path here is a *drop*, and a drop means "this prediction
    keeps its prior standing" -- never "this prediction is refused". Three of
    them:

    * a row whose ``prediction_id`` is not one we asked about (a source-side
      filter bug, or a stale row): dropped, because the only thing worse than
      missing a decision is applying it to a neighbouring call;
    * a row that is not a ``StrategistDecision`` at all: dropped and logged;
    * every row, when the reader raised, or when it came back saying it
      could not look: the whole lookup degrades to unavailable and the sweep
      carries on unchecked, which is the same posture an unconfigured reader
      produces.

    Position is never used. The reader is free to return rows in any order,
    to return none, or to return several for one prediction -- the latest by
    ``decided_at`` wins, which is what makes an Approve's protection end at
    the next human touch.
    """
    ids = tuple(dict.fromkeys(str(pid) for pid in prediction_ids))
    if reader is None:
        return DecisionLookup(
            decisions={}, available=False, unavailable_reason=UNAVAILABLE_NOT_PROVISIONED
        )
    try:
        read = reader.decisions_for(ids)
    except Exception as err:  # noqa: BLE001 - an outage is a miss, not a failed sweep
        log.warning("strategist decision read failed; no call is withdrawn: %s", err)
        return DecisionLookup(
            decisions={},
            available=False,
            unavailable_reason=f"{UNAVAILABLE_READ_FAILED} ({type(err).__name__})",
        )

    wanted = set(ids)
    latest: dict[str, StrategistDecision] = {}
    for row in read.decisions:
        if not isinstance(row, StrategistDecision):
            log.warning("dropping an unreadable strategist decision row: %r", type(row))
            continue
        if row.prediction_id not in wanted:
            # Bound by identity, never by position: a row for a prediction
            # this sweep did not ask about belongs to no prediction here.
            log.warning(
                "dropping a strategist decision for a prediction this sweep did not read",
                extra={"prediction_id": row.prediction_id},
            )
            continue
        current = latest.get(row.prediction_id)
        latest[row.prediction_id] = row if current is None else _latest(current, row)

    return DecisionLookup(
        decisions=latest,
        available=read.available,
        unavailable_reason=read.unavailable_reason,
    )
