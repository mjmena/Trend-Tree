"""The matching phase: open predictions in, matched verdict rows out
(CRMA-764).

Read the signature of ``match_open_predictions`` before anything else. It
takes an ``OpenPredictionReader``, a ``TrendReader`` and an optional
``PredictionLLM``. It takes no ``SnowflakeClient`` and no ``Settings`` -- the
same shape discipline the generation phase uses, for the same reason: the
phase ends at built ``Verdict`` objects and writing them is the caller's job
(routes/match.py), which keeps the write capability outside this package
entirely. What runs is ``assert_matching_sql`` (matching/isolation.py), on
every statement the readers issue.

**Where this sits relative to generation.** Generation is blind to trend
state and mints white-space predictions. This phase is the compare step, and
it is a separate route rather than a tail on ``POST /generate`` precisely so
that no trend read can ever appear inside a generation run -- the generation
guard, its allowlist and its whole test suite are untouched by this file.

What one matched evaluation changes, and what it does not:

* sets ``MATCHED_TREND_ID`` and ``EVIDENCE.trend_context``;
* rewrites ``REASONING`` so the verdict addresses that context;
* leaves the four claim parts, including ``HORIZON_AT``, exactly as minted;
* leaves ``CONFIDENCE`` exactly as it was. Confidence movement between
  evaluations, and the ``WHAT_CHANGED`` note that explains it, belong to the
  re-evaluation sweep. Writing a number here that no calibration decided
  would put a mechanical adjustment where the strategy asks for a judgement.

Trend context is *evidence*, and failing to fetch evidence is not a reason
to drop a prediction. A context read that raises degrades exactly the way a
failed narrative call does -- a note on the outcome, ``trend_context`` null,
the row still written. The only thing that aborts a pass is a row this
service cannot re-state at all (``InvalidClaim``), which is a bug.

What this phase does NOT do, deliberately:

* **saturation and coverage evidence.** ``EVIDENCE.saturation`` and
  ``EVIDENCE.coverage`` are carried forward from the prior row untouched --
  whatever wrote them keeps them, and if nothing has, they stay null.
* **the data-quality floor.** The strategy's one permitted mechanical gate is
  not this phase's, and nothing here declines to evaluate a prediction.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from ..domain.claim import REQUIRED_EVIDENCE_KEYS, InvalidClaim, Verdict, build_verdict
from ..generation.llm import LLMError, PredictionLLM
from ..generation.parse import UnparseableResponse
from .decide import DEFAULT_MIN_SIMILARITY, MatchDecision, decide_match, match_evidence
from .narrative import build_system_prompt, build_user_prompt, parse_reasoning
from .predictions import DEFAULT_PREDICTION_LIMIT, OpenPrediction, OpenPredictionReader
from .trends import DEFAULT_CANDIDATE_LIMIT, TrendCandidate, TrendContext, TrendReader

log = logging.getLogger(__name__)

#: Namespace for deriving a match run's PREDICTION_EVAL_IDs. Distinct from
#: generation's, so a generation row and a match row can never collide on an
#: id even if both ran under the same chain.
MATCH_EVAL_ID_NAMESPACE = uuid.UUID("0a3d2f18-9b47-5f61-8c02-6d4a7e5b1c93")

_KEY_SEP = "\x1f"


@dataclass(frozen=True)
class MatchScope:
    """A run's caps. Caps, not gates -- they bound cost and blast radius,
    they do not decide what qualifies.

    ``min_similarity`` is the embedding leg's floor for the statement-side
    comparison (the descriptor-side one is a constant in matching/decide.py,
    because it is a property of the two authored vocabularies rather than of
    a run). It decides *whether a prediction is matched or white-space*,
    never whether it survives: both outcomes are written. See
    matching/decide.py for the measurements behind both numbers.
    """

    prediction_limit: int = DEFAULT_PREDICTION_LIMIT
    candidate_limit: int = DEFAULT_CANDIDATE_LIMIT
    min_similarity: float = DEFAULT_MIN_SIMILARITY

    def __post_init__(self) -> None:
        for name in ("prediction_limit", "candidate_limit"):
            if getattr(self, name) < 1:
                raise ValueError(f"{name} must be at least 1, got {getattr(self, name)}")
        if not 0.0 <= self.min_similarity <= 1.0:
            raise ValueError(
                f"min_similarity must be a cosine in [0, 1], got {self.min_similarity}"
            )


@dataclass(frozen=True)
class MatchResolution:
    """One prediction's match, resolved: the decision, whatever context the
    matched trend had, and a note when the context read failed.

    Extracted from the loop below so the re-evaluation sweep (CRMA-766) can
    re-check a prediction's match through exactly this code rather than its
    own copy of it. Nothing about the compare step changed: the sequence is
    still candidates -> decide -> context, and context is still read only
    after the match is settled and only for a matched prediction, which is
    what tests/test_no_mechanical_filter.py asserts by call order.
    """

    decision: MatchDecision
    context: TrendContext | None = None
    #: Why the context is missing, when it is. Never a reason to drop the
    #: prediction -- the match was already decided without it.
    note: str | None = None


def resolve_match(
    subject: str,
    *,
    trends: TrendReader,
    index: list[TrendCandidate],
    candidate_limit: int = DEFAULT_CANDIDATE_LIMIT,
    min_similarity: float = DEFAULT_MIN_SIMILARITY,
    log_extra: dict[str, object] | None = None,
) -> MatchResolution:
    """Decide ``subject``'s match against the trend pipeline, then read the
    matched trend's context.

    Trend context is *evidence*, and failing to fetch evidence is not a
    reason to drop a prediction: a context read that raises comes back as a
    note with ``context=None``, and the caller still writes the row.
    """
    candidates = trends.candidates_for(subject, limit=candidate_limit)
    decision = decide_match(
        subject,
        descriptor_index=index,
        candidates=candidates,
        min_similarity=min_similarity,
    )
    if decision.trend is None:
        return MatchResolution(decision=decision)
    try:
        return MatchResolution(
            decision=decision, context=trends.context_for(decision.trend.trend_id)
        )
    except Exception as err:  # noqa: BLE001 - any read failure degrades the same way
        # The context read is the heaviest statement this phase issues (a
        # window over the lifecycle ledger plus two correlated subqueries and
        # two joins), so it is the one most likely to time out; letting that
        # propagate would abort the whole pass in the route and write
        # *nothing*, including the white-space rows that never needed a
        # context read at all. The match itself was already decided without
        # it, so the row is still correct: it lands with trend_context null,
        # which is the shape build_evidence and the ledger already allow for
        # an unmeasured trend.
        log.warning(
            "trend context read failed",
            extra={**(log_extra or {}), "trend_id": decision.trend.trend_id},
        )
        return MatchResolution(
            decision=decision,
            context=None,
            note=f"trend context unavailable, recorded without it: {err}",
        )


@dataclass(frozen=True)
class MatchOutcome:
    """One prediction's trip through the compare step."""

    prediction_id: str
    subject_descriptor: str
    verdict: Verdict
    decision: MatchDecision
    context: TrendContext | None
    #: True when the narrative model was asked and answered. False on a
    #: white-space prediction (nothing to narrate) or a degraded one.
    narrated: bool = False
    #: Why the narrative was not written, when it was not. Never a reason to
    #: drop the prediction.
    note: str | None = None


@dataclass(frozen=True)
class MatchResult:
    chain_id: str
    outcomes: list[MatchOutcome] = field(default_factory=list)
    predictions_considered: int = 0
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
    def matched(self) -> list[MatchOutcome]:
        return [outcome for outcome in self.outcomes if outcome.decision.matched]

    @property
    def white_space(self) -> list[MatchOutcome]:
        return [outcome for outcome in self.outcomes if not outcome.decision.matched]


def new_chain_id() -> str:
    """One value per match run. The ``pred-match-`` infix distinguishes a
    compare-step chain from a generation chain in the ledger."""
    return f"pred-match-chain-{uuid.uuid4().hex[:8]}"


def eval_id_for(chain_id: str, prediction_id: str) -> str:
    """This evaluation's ledger identity: one row per prediction per match
    run. Derived rather than random so re-firing a run with the same
    ``chain_id`` MERGEs into the rows it already wrote instead of appending a
    second set."""
    return str(uuid.uuid5(MATCH_EVAL_ID_NAMESPACE, _KEY_SEP.join((chain_id, prediction_id))))


def build_evidence(
    prior: dict[str, object], *, decision: MatchDecision, context: TrendContext | None
) -> dict[str, object]:
    """The EVIDENCE VARIANT for a match evaluation.

    Built by *carrying the prior row forward* and setting one key. That is
    the seam: ``source_signals`` keeps the audit trail generation wrote, and
    ``saturation`` and ``coverage`` keep whatever their owning phases put
    there. This phase owns ``trend_context`` and nothing else in the payload.

    ``trend_context`` is null for a white-space prediction -- there is no
    trend whose context it could be -- which is the ledger contract from the
    DDL, and it is null-but-present, per REQUIRED_EVIDENCE_KEYS.
    """
    evidence = dict(prior)
    for key in REQUIRED_EVIDENCE_KEYS:
        evidence.setdefault(key, None)
    evidence["trend_context"] = context.as_evidence() if (decision.matched and context) else None
    evidence["match"] = match_evidence(decision)
    return evidence


def _narrate(
    llm: PredictionLLM,
    prediction: OpenPrediction,
    decision: MatchDecision,
    context: TrendContext | None,
) -> tuple[str, int, int, float | None, str]:
    trend = decision.trend
    user = build_user_prompt(
        subject_descriptor=prediction.claim.subject_descriptor,
        directional_claim=prediction.claim.directional_claim,
        horizon_band=prediction.claim.horizon_band,
        observable_check=prediction.claim.observable_check,
        confidence=prediction.confidence,
        prior_reasoning=prediction.reasoning,
        trend_topic=trend.trend_topic if trend else None,
        descriptor_query=trend.descriptor_query if trend else None,
        descriptor_statement=trend.descriptor_statement if trend else None,
        match_method=decision.method,
        similarity=trend.similarity if trend else None,
        context=context.as_evidence() if context else None,
    )
    response = llm.complete(system=build_system_prompt(), user=user)
    return (
        parse_reasoning(response.text),
        response.input_tokens,
        response.output_tokens,
        response.cost_usd,
        response.model,
    )


def match_open_predictions(
    *,
    predictions: OpenPredictionReader,
    trends: TrendReader,
    llm: PredictionLLM | None = None,
    scope: MatchScope | None = None,
    chain_id: str | None = None,
    evaluated_at: datetime | None = None,
) -> MatchResult:
    """One compare-step pass over the open predictions."""
    scope = scope or MatchScope()
    chain = chain_id or new_chain_id()
    evaluated = evaluated_at or datetime.now(UTC)

    open_predictions = predictions.open_predictions(limit=scope.prediction_limit)
    # Read once for the whole run: the descriptor leg compares every
    # prediction against the same index, and re-reading it per prediction
    # would buy nothing but round-trips.
    index = trends.descriptor_index()

    outcomes: list[MatchOutcome] = []
    input_tokens = 0
    output_tokens = 0
    cost_usd: float | None = None
    model = ""

    for prediction in open_predictions:
        subject = prediction.claim.subject_descriptor
        resolution = resolve_match(
            subject,
            trends=trends,
            index=index,
            candidate_limit=scope.candidate_limit,
            min_similarity=scope.min_similarity,
            log_extra={"chain_id": chain, "prediction_id": prediction.prediction_id},
        )
        decision = resolution.decision
        context = resolution.context

        reasoning = prediction.reasoning
        narrated = False
        # Degraded evidence, never a dropped prediction -- the same contract
        # _narrate keeps below.
        note: str | None = resolution.note

        if decision.matched and llm is not None:
            try:
                reasoning, used_in, used_out, call_cost, model = _narrate(
                    llm, prediction, decision, context
                )
                narrated = True
                input_tokens += used_in
                output_tokens += used_out
                if call_cost is not None:
                    cost_usd = (cost_usd or 0.0) + call_cost
            except (LLMError, UnparseableResponse) as err:
                # A degraded narrative, never a dropped prediction. The match
                # itself was decided without the model (matching/decide.py),
                # so the row is still correct -- it just carries the reasoning
                # the previous evaluation recorded.
                note = "; ".join(
                    part
                    for part in (
                        note,
                        f"narrative unavailable, prior reasoning carried forward: {err}",
                    )
                    if part
                )
                log.warning(
                    "match narrative failed",
                    extra={"chain_id": chain, "prediction_id": prediction.prediction_id},
                )
        elif decision.matched and llm is None:
            note = "; ".join(
                part
                for part in (
                    note,
                    "no narrative model configured; prior reasoning carried forward",
                )
                if part
            )

        if not reasoning.strip():
            # The ledger's REASONING is nullable but build_verdict is not
            # willing to mint a verdict with none, and an empty prior is a
            # data defect rather than a decision. Say what happened instead
            # of failing the run.
            reasoning = (
                "No reasoning was recorded at the previous evaluation and none could be "
                "written at this one; the match itself is recorded in EVIDENCE.match."
            )

        try:
            verdict = build_verdict(
                prediction.claim,
                confidence=prediction.confidence,
                reasoning=reasoning,
                evidence=build_evidence(
                    prediction.evidence, decision=decision, context=context
                ),
                status=prediction.status,
                matched_trend_id=decision.trend_id,
                # Owned by the re-evaluation sweep -- see the module docstring.
                what_changed=None,
                prediction_id=prediction.prediction_id,
                prediction_eval_id=eval_id_for(chain, prediction.prediction_id),
                chain_id=chain,
                minted_at=evaluated,
                # Frozen at mint. Re-deriving it here would silently move the
                # date the claim is due to be judged.
                horizon_at=prediction.horizon_at,
                # Carried forward verbatim (CRMA-782). This phase decides
                # whether a prediction corroborates a trend; it has no
                # opinion about the narrative and calls no model that could
                # form one. Omitting these would write NULL over a good
                # angle on every match run.
                angle=prediction.angle,
                audience_question=prediction.audience_question,
            )
        except InvalidClaim:
            # A ledger row this service cannot re-state is a bug worth
            # surfacing, not something to write half of.
            log.exception(
                "open prediction could not be re-minted",
                extra={"chain_id": chain, "prediction_id": prediction.prediction_id},
            )
            raise

        outcomes.append(
            MatchOutcome(
                prediction_id=prediction.prediction_id,
                subject_descriptor=subject,
                verdict=verdict,
                decision=decision,
                context=context,
                narrated=narrated,
                note=note,
            )
        )

    log.info(
        "match pass complete",
        extra={
            "chain_id": chain,
            "predictions": len(outcomes),
            "matched": sum(1 for o in outcomes if o.decision.matched),
            "white_space": sum(1 for o in outcomes if not o.decision.matched),
            "trends_indexed": len(index),
            "cost_usd": cost_usd,
        },
    )

    return MatchResult(
        chain_id=chain,
        outcomes=outcomes,
        predictions_considered=len(open_predictions),
        trends_indexed=len(index),
        model=model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        cost_usd=cost_usd,
    )
