"""The re-evaluation sweep: live predictions in, a fresh verdict row each
(CRMA-766).

Read the signature of ``sweep_predictions`` first. Like the two phases before
it, it takes readers and an optional model and returns built ``Verdict``
objects -- no ``SnowflakeClient``, no ``Settings``, and no way to write. The
route does the writing, after the sweep has returned.

**What one re-evaluation does.**

1. Reads the ledger's live predictions -- ACTIVE, plus EXPIRED ones still
   inside their grace window (matching/predictions.py, ``LIVE_STATUSES``).
2. Drops the ones whose grace window has closed. That is the freeze: their
   last row stands and the grade derived from it is final
   (sweep/lifecycle.py).
3. Re-checks the match through ``matching.run.resolve_match`` -- the same
   code path ``POST /match`` uses, not a copy of it -- refreshing
   ``MATCHED_TREND_ID`` and ``EVIDENCE.trend_context``.
4. Refreshes ``EVIDENCE.saturation`` through the saturation phase's public
   lookup seam. The data-quality floor is deliberately NOT re-applied: it is
   a mint-time gate on whether a subject can be judged at all, and running it
   again would let it quietly stop re-evaluating an already-live call, which
   is a new mechanical rule the strategy does not permit.
5. Asks the model, in one batched turn, to read the observable check,
   restate confidence, rewrite reasoning and say what changed.
6. Applies the status machine and composes ``WHAT_CHANGED``.
7. Appends one row -- **carrying the four claim columns forward
   byte-identically**.

**The claim columns never move.** ``SUBJECT_DESCRIPTOR``,
``DIRECTIONAL_CLAIM``, ``HORIZON_AT`` and ``OBSERVABLE_CHECK`` are read off
the prior row and handed straight back to ``build_verdict``, ``horizon_at``
included -- which is the reason that parameter exists. Nothing in this module
derives a claim value, and the model is not given a field it could return one
in. Falsifiability depends on it: a claim that can be reworded under a
re-evaluation is a claim nobody can be wrong about.

**What this module does not do.** It does not grade. Correct / Early-Late /
Incorrect is derived in SQL from these rows (CRMA-771). It does not detect
coverage (CRMA-767), read strategist decisions (CRMA-768), or project
anything to the dashboard (CRMA-769).
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any

from ..domain.claim import InvalidClaim, Verdict, build_verdict
from ..generation.llm import PredictionLLM
from ..matching.decide import DEFAULT_MIN_SIMILARITY, MatchDecision
from ..matching.predictions import (
    DEFAULT_PREDICTION_LIMIT,
    OpenPrediction,
    OpenPredictionReader,
)
from ..matching.run import build_evidence as build_match_evidence
from ..matching.run import resolve_match
from ..matching.trends import DEFAULT_CANDIDATE_LIMIT, TrendContext, TrendReader
from ..saturation import SaturationPhase, attach_saturation, build_saturation_evidence
from ..saturation.weigh import render_breadth, render_et
from .changes import compose_what_changed
from .direction import confidence_delta, confidence_direction
from .lifecycle import (
    Observation,
    StatusDecision,
    grace_ends_at,
    grace_remaining,
    is_reevaluable,
    next_status,
)
from .parse import Reevaluation, parse_reevaluations
from .prompt import ReevaluationItem, build_system_prompt, build_user_prompt

log = logging.getLogger(__name__)

#: Namespace for deriving a sweep's PREDICTION_EVAL_IDs. Distinct from
#: generation's and matching's, so rows from the three phases can never
#: collide on an id even under one chain.
SWEEP_EVAL_ID_NAMESPACE = uuid.UUID("2f7c9d41-6e8b-5a30-b1d5-83c04f9e2a76")

_KEY_SEP = "\x1f"

_DAY_SECONDS = 86400.0


def new_chain_id() -> str:
    """One value per sweep. The ``pred-sweep-`` infix distinguishes a
    re-evaluation chain from a generation or compare-step chain in the
    ledger."""
    return f"pred-sweep-chain-{uuid.uuid4().hex[:8]}"


def eval_id_for(chain_id: str, prediction_id: str) -> str:
    """This evaluation's ledger identity: one row per prediction per sweep.
    Derived rather than random, so re-firing a sweep with the same
    ``chain_id`` MERGEs into the rows it already wrote instead of appending a
    second set -- which is what makes Cloud Scheduler's own HTTP retry safe.
    """
    return str(uuid.uuid5(SWEEP_EVAL_ID_NAMESPACE, _KEY_SEP.join((chain_id, prediction_id))))


@dataclass(frozen=True)
class SweepScope:
    """A sweep's caps. Caps, not gates -- they bound cost and blast radius,
    they do not decide what qualifies.

    ``prediction_ids`` is the capped-scope / single-prediction test mode the
    PRD asks for: given, the sweep re-evaluates only those and leaves the
    rest of the world alone.
    """

    prediction_limit: int = DEFAULT_PREDICTION_LIMIT
    candidate_limit: int = DEFAULT_CANDIDATE_LIMIT
    min_similarity: float = DEFAULT_MIN_SIMILARITY
    prediction_ids: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for name in ("prediction_limit", "candidate_limit"):
            if getattr(self, name) < 1:
                raise ValueError(f"{name} must be at least 1, got {getattr(self, name)}")
        if not 0.0 <= self.min_similarity <= 1.0:
            raise ValueError(
                f"min_similarity must be a cosine in [0, 1], got {self.min_similarity}"
            )

    def selects(self, prediction_id: str) -> bool:
        return not self.prediction_ids or prediction_id in self.prediction_ids


@dataclass(frozen=True)
class SkippedPrediction:
    """A live row the sweep read and did not re-evaluate, and why. Reported
    rather than dropped silently -- "the grace window closed" is the moment a
    prediction's grade becomes final, and an operator should be able to see
    it happen."""

    prediction_id: str
    subject_descriptor: str
    reason: str


@dataclass(frozen=True)
class SweepOutcome:
    """One prediction's trip through the sweep."""

    prediction_id: str
    subject_descriptor: str
    verdict: Verdict
    prior_confidence: float
    prior_status: str
    prior_matched_trend_id: str | None
    decision: MatchDecision
    context: TrendContext | None
    status: StatusDecision
    observation: Observation
    #: Derived here, stored nowhere -- see sweep/direction.py.
    confidence_direction: str
    confidence_delta: float | None
    #: True when the model answered for this prediction and the answer was
    #: bound to its subject.
    reevaluated: bool = False
    note: str | None = None

    @property
    def final(self) -> bool:
        """Whether this row is the prediction's last."""
        return self.status.final


@dataclass(frozen=True)
class SweepResult:
    chain_id: str
    outcomes: list[SweepOutcome] = field(default_factory=list)
    skipped: list[SkippedPrediction] = field(default_factory=list)
    predictions_read: int = 0
    trends_indexed: int = 0
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    #: None when llm.py does not price this model. Unknown, not free.
    cost_usd: float | None = None

    @property
    def verdicts(self) -> list[Verdict]:
        return [outcome.verdict for outcome in self.outcomes]

    @property
    def resolved(self) -> list[SweepOutcome]:
        return [o for o in self.outcomes if o.status.status.startswith("RESOLVED")]

    @property
    def expired(self) -> list[SweepOutcome]:
        return [o for o in self.outcomes if o.status.status == "EXPIRED"]


def _days(seconds: float) -> float:
    return round(seconds / _DAY_SECONDS, 2)


def _render_saturation(lookup: Any, reading: Any) -> str:
    return "\n".join((render_et(lookup), render_breadth(reading)))


def _selected(
    predictions: Sequence[OpenPrediction], *, scope: SweepScope, now: datetime
) -> tuple[list[OpenPrediction], list[SkippedPrediction]]:
    """Split the live rows into "re-evaluate" and "leave alone", with a
    reason for every one left alone."""
    live: list[OpenPrediction] = []
    skipped: list[SkippedPrediction] = []
    for prediction in predictions:
        subject = prediction.claim.subject_descriptor
        if not scope.selects(prediction.prediction_id):
            skipped.append(
                SkippedPrediction(
                    prediction_id=prediction.prediction_id,
                    subject_descriptor=subject,
                    reason="outside this run's requested prediction_ids (capped-scope run)",
                )
            )
            continue
        if not is_reevaluable(
            prediction.status, prediction.horizon_at, prediction.claim.horizon_band, now
        ):
            closes = grace_ends_at(prediction.horizon_at, prediction.claim.horizon_band)
            skipped.append(
                SkippedPrediction(
                    prediction_id=prediction.prediction_id,
                    subject_descriptor=subject,
                    reason=(
                        f"status {prediction.status} with the one-horizon grace window "
                        f"closed at {closes.isoformat()}; this prediction's grade is final "
                        "and no further row will be appended"
                    ),
                )
            )
            continue
        live.append(prediction)
    return live, skipped


def _reevaluations(
    items: Sequence[ReevaluationItem], llm: PredictionLLM | None
) -> tuple[dict[int, Reevaluation], dict[str, Any]]:
    """Ask the model to re-evaluate the batch. Returns the answers plus the
    provenance block that goes into the evidence.

    Every failure degrades to "nothing was re-read": each prediction keeps
    its prior confidence and reasoning and its observable check reads
    ``not_yet``, so a model outage can neither resolve a call nor move a
    number. The time-based transitions still happen -- EXPIRED needs no
    model, only a clock -- which is exactly the property that keeps the
    lifecycle honest when the LLM is down.
    """
    if llm is None:
        return {}, {
            "reevaluated": False,
            "note": (
                "no model available for the re-evaluation turn; every call keeps its prior "
                "confidence and reasoning, and no observable check was read"
            ),
        }
    try:
        response = llm.complete(
            system=build_system_prompt(), user=build_user_prompt(items)
        )
        answers = parse_reevaluations(
            response.text, subjects=[item.subject_descriptor for item in items]
        )
    except Exception as err:  # noqa: BLE001 - an outage is a miss, not a failed sweep
        log.warning("re-evaluation turn failed; live calls keep their prior numbers: %s", err)
        return {}, {
            "reevaluated": False,
            "note": (
                f"the re-evaluation turn failed ({type(err).__name__}); confidence and "
                "reasoning are the prior evaluation's, unadjusted, and no observable "
                "check was read"
            ),
        }
    return answers, {
        "reevaluated": True,
        "model": response.model,
        # ONE batched call re-evaluates the whole sweep, and this block is
        # copied onto every row it covered -- so the token and cost fields are
        # named for the batch. Summing `batch_cost_usd` across ledger rows
        # over-counts by `batch_size`; the run-level total is
        # SweepResult.cost_usd, which adds it once.
        "batch_size": len(items),
        "batch_input_tokens": response.input_tokens,
        "batch_output_tokens": response.output_tokens,
        "batch_cost_usd": response.cost_usd,
    }


def sweep_predictions(
    *,
    predictions: OpenPredictionReader,
    trends: TrendReader,
    llm: PredictionLLM | None = None,
    saturation: SaturationPhase | None = None,
    scope: SweepScope | None = None,
    chain_id: str | None = None,
    now: datetime | None = None,
) -> SweepResult:
    """One re-evaluation pass over the live predictions."""
    scope = scope or SweepScope()
    chain = chain_id or new_chain_id()
    moment = now or datetime.now(UTC)

    read = predictions.open_predictions(limit=scope.prediction_limit)
    live, skipped = _selected(read, scope=scope, now=moment)
    if not live:
        log.info(
            "sweep found nothing to re-evaluate",
            extra={"chain_id": chain, "read": len(read), "skipped": len(skipped)},
        )
        return SweepResult(
            chain_id=chain, skipped=skipped, predictions_read=len(read), trends_indexed=0
        )

    # Read once for the whole sweep, like the compare step: every subject is
    # compared against the same descriptor index.
    index = trends.descriptor_index()

    resolutions = [
        resolve_match(
            prediction.claim.subject_descriptor,
            trends=trends,
            index=index,
            candidate_limit=scope.candidate_limit,
            min_similarity=scope.min_similarity,
            log_extra={"chain_id": chain, "prediction_id": prediction.prediction_id},
        )
        for prediction in live
    ]

    subjects = [prediction.claim.subject_descriptor for prediction in live]
    readings = (
        saturation.readings(subjects)
        if saturation is not None
        else [(None, None)] * len(subjects)
    )

    items = [
        ReevaluationItem(
            prediction_id=prediction.prediction_id,
            subject_descriptor=prediction.claim.subject_descriptor,
            directional_claim=prediction.claim.directional_claim,
            horizon_band=prediction.claim.horizon_band,
            observable_check=prediction.claim.observable_check,
            horizon_at=prediction.horizon_at.isoformat(),
            status=prediction.status,
            confidence=prediction.confidence,
            reasoning=prediction.reasoning,
            days_to_horizon=_days((prediction.horizon_at - moment).total_seconds()),
            days_of_grace_left=_days(
                grace_remaining(
                    prediction.horizon_at, prediction.claim.horizon_band, moment
                ).total_seconds()
            ),
            matched_trend_topic=(
                resolution.decision.trend.trend_topic if resolution.decision.trend else None
            ),
            trend_context=resolution.context.as_evidence() if resolution.context else None,
            saturation=(
                _render_saturation(lookup, reading) if lookup is not None else None
            ),
        )
        for prediction, resolution, (lookup, reading) in zip(
            live, resolutions, readings, strict=True
        )
    ]

    answers, provenance = _reevaluations(items, llm)

    outcomes: list[SweepOutcome] = []
    for position, (prediction, resolution, (lookup, reading)) in enumerate(
        zip(live, resolutions, readings, strict=True), 1
    ):
        answer = answers.get(position)
        observation = answer.observation if answer else Observation()
        confidence = (
            answer.confidence
            if answer is not None and answer.confidence is not None
            else prediction.confidence
        )
        reasoning = (answer.reasoning if answer else "") or prediction.reasoning
        status = next_status(
            prior_status=prediction.status,
            horizon_at=prediction.horizon_at,
            band=prediction.claim.horizon_band,
            now=moment,
            observation=observation,
        )

        evidence = build_match_evidence(
            prediction.evidence, decision=resolution.decision, context=resolution.context
        )
        evidence_notes: list[str] = []
        if lookup is not None and reading is not None:
            evidence["saturation"] = build_saturation_evidence(
                lookup=lookup, reading=reading
            )
            evidence = attach_saturation(evidence, evidence["saturation"])
            if lookup.matched and lookup.classification:
                evidence_notes.append(
                    f"Exploding Topics now reads {lookup.classification!r} for this subject"
                )
        block = dict(provenance)
        block["chain_id"] = chain
        block["evaluated_at"] = moment.isoformat()
        block["prior_prediction_eval_id"] = prediction.prior_eval_id
        block["prior_confidence"] = prediction.confidence
        block["prior_status"] = prediction.status
        block["observable_check"] = observation.outcome
        block["observation"] = observation.rationale
        block["grace_ends_at"] = status.grace_ends_at.isoformat()
        block["final_evaluation"] = status.final
        # Said in the payload rather than stored as a column, deliberately --
        # see sweep/direction.py.
        block["confidence_direction_is_derived_not_stored"] = True
        note: str | None = resolution.note
        if answer is None and provenance.get("reevaluated"):
            block["note"] = (
                "the model returned no usable answer for this call -- absent, malformed, "
                "or not bound to this subject; confidence and reasoning are the prior "
                "evaluation's, unadjusted, and no observable check was read"
            )
        evidence["reevaluation"] = block

        what_changed = compose_what_changed(
            prior_confidence=prediction.confidence,
            confidence=confidence,
            prior_status=prediction.status,
            status=status.status,
            status_reason=status.reason,
            prior_trend_id=prediction.matched_trend_id,
            trend_id=resolution.decision.trend_id,
            trend_topic=(
                resolution.decision.trend.trend_topic if resolution.decision.trend else None
            ),
            evidence_notes=evidence_notes,
            model_note=answer.what_changed if answer else None,
            observation_rationale=observation.rationale,
        )

        try:
            verdict = build_verdict(
                # Byte-identical: the claim object came off the prior ledger
                # row and is handed back untouched. Nothing here re-derives a
                # claim part.
                prediction.claim,
                confidence=confidence,
                reasoning=reasoning,
                evidence=evidence,
                status=status.status,
                matched_trend_id=resolution.decision.trend_id,
                what_changed=what_changed,
                prediction_id=prediction.prediction_id,
                prediction_eval_id=eval_id_for(chain, prediction.prediction_id),
                chain_id=chain,
                minted_at=moment,
                # Frozen at mint. Re-deriving it here would silently move the
                # date the claim is due to be judged -- and would move the
                # grace window with it.
                horizon_at=prediction.horizon_at,
            )
        except InvalidClaim:
            log.exception(
                "live prediction could not be re-minted",
                extra={"chain_id": chain, "prediction_id": prediction.prediction_id},
            )
            raise

        outcomes.append(
            SweepOutcome(
                prediction_id=prediction.prediction_id,
                subject_descriptor=prediction.claim.subject_descriptor,
                verdict=verdict,
                prior_confidence=prediction.confidence,
                prior_status=prediction.status,
                prior_matched_trend_id=prediction.matched_trend_id,
                decision=resolution.decision,
                context=resolution.context,
                status=status,
                observation=observation,
                confidence_direction=confidence_direction(prediction.confidence, confidence),
                confidence_delta=confidence_delta(prediction.confidence, confidence),
                reevaluated=answer is not None,
                note=note,
            )
        )

    log.info(
        "sweep complete",
        extra={
            "chain_id": chain,
            "re_evaluated": len(outcomes),
            "skipped": len(skipped),
            "resolved": sum(1 for o in outcomes if o.status.status.startswith("RESOLVED")),
            "expired": sum(1 for o in outcomes if o.status.status == "EXPIRED"),
        },
    )

    return SweepResult(
        chain_id=chain,
        outcomes=outcomes,
        skipped=skipped,
        predictions_read=len(read),
        trends_indexed=len(index),
        model=str(provenance.get("model") or ""),
        input_tokens=int(provenance.get("batch_input_tokens") or 0),
        output_tokens=int(provenance.get("batch_output_tokens") or 0),
        cost_usd=provenance.get("batch_cost_usd"),
    )
