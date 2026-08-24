"""The re-evaluation sweep: live predictions in, a fresh verdict row each
(CRMA-766).

Read the signature of ``sweep_predictions`` first. Like the two phases before
it, it takes readers and an optional model and returns built ``Verdict``
objects -- no ``SnowflakeClient``, no ``Settings``, and no way to write. The
route does the writing, after the sweep has returned.

**What one re-evaluation does.**

1. Reads the ledger's live predictions -- ACTIVE, plus EXPIRED ones still
   inside their grace window (matching/predictions.py, ``LIVE_STATUSES``).
2. Writes ONE last row for a prediction whose grace window has closed, then
   drops it on every later run. That final row is the freeze made visible:
   after it the row stands and the grade derived from it is final
   (sweep/lifecycle.py). A row the read could not parse, and a requested
   PREDICTION_ID with no live row, are reported as skips rather than
   dropped or raised.
3. Re-checks the match through ``matching.run.resolve_match`` -- the same
   code path ``POST /match`` uses, not a copy of it -- refreshing
   ``MATCHED_TREND_ID`` and ``EVIDENCE.trend_context``.
4. Refreshes ``EVIDENCE.saturation`` through the saturation phase's public
   lookup seam -- unless neither oracle answered and the prior row already
   carries a real reading, in which case the prior reading stands. The
   latest row is what the dashboard projection reads, and a provider outage
   is not a reason to say we know less about a subject than we do. The
   data-quality floor is deliberately NOT re-applied: it is a mint-time gate
   on whether a subject can be judged at all, and running it again would let
   it quietly stop re-evaluating an already-live call, which is a new
   mechanical rule the strategy does not permit.
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
from collections.abc import Mapping, Sequence
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


def daily_chain_id(now: datetime | None = None) -> str:
    """The scheduled run's chain id: one value per UTC calendar day.

    Cloud Scheduler retries a POST that returned non-2xx or that blew the
    attempt deadline -- and it abandons an attempt that is *still running*,
    which is the dangerous case: the first attempt goes on to commit its rows
    while the retry starts from scratch. With a fresh random chain per fire
    the retry derives fresh ``eval_id_for()`` values and appends a SECOND full
    set of evaluations for the same day; the ledger is append-only, so nothing
    downstream can tell them apart.

    Derived from the date rather than passed in the cron body because Cloud
    Scheduler message bodies are static -- it has no template variables. The
    job asks for this by sending ``daily_chain_id: true`` (deploy/scheduler.sh)
    and the route derives the value here, so the id is one line of code rather
    than a thing an operator has to remember to rotate.

    A retry that crossed UTC midnight would derive the next day's id and lose
    the dedup. The job fires at 14:00 UTC with a 590s attempt deadline and two
    retries, so that boundary is ten hours away.
    """
    moment = now or datetime.now(UTC)
    return f"pred-sweep-daily-{moment.astimezone(UTC).strftime('%Y-%m-%d')}"


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
    #: bound to it by PREDICTION_ID.
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
    #: None when a re-evaluation turn HAPPENED and llm.py does not price that
    #: model -- unknown, not free. A sweep that made no model call at all (an
    #: empty live pool, no model configured, a failed turn) is 0.0, because
    #: "this pass cost nothing" is a fact, and reporting it as unknown makes
    #: the route's total null for a run that went on to mint at real cost.
    cost_usd: float | None = 0.0

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


def narrative_for(
    prediction: OpenPrediction, answer: Reevaluation | None
) -> tuple[str | None, str | None]:
    """This sweep's ANGLE and AUDIENCE_QUESTION: written when absent,
    refreshed on news, carried forward otherwise (CRMA-782).

    **The rule is NOT "refresh when WHAT_CHANGED is non-null."** That was the
    story's wording and it does not survive contact with this module:
    ``compose_what_changed`` is total, falling back to ``NOTHING_MOVED``, so
    WHAT_CHANGED is non-null on every sweep row ever written. Keyed on that,
    "refresh only when something moved" would refresh unconditionally --
    exactly the daily churn the story set out to prevent, and measurably so:
    on 2026-08-23, 14 of 15 live rows read "Nothing moved since the previous
    evaluation".

    The real signal is the model's OWN note. ``answer.what_changed`` is the
    sentence it wrote about this prediction, empty when it had nothing to
    report, and ``answer`` itself is None unless the batched turn bound an
    entry to this prediction by an echoed ``prediction_id`` agreeing with
    its position (sweep/parse.py). So a refresh requires, in order: an entry
    that proved which call it belonged to, a claim of news, and a usable
    replacement sentence. Anything short of all three keeps what is stored.

    Carrying forward is the safe default in both directions -- it cannot lose
    an angle we already have, and it cannot invent one we do not.
    """
    if answer is None:
        return prediction.angle, prediction.audience_question

    # News, as the model itself reported it for THIS call. Empty when it had
    # nothing to say.
    reported_news = bool(answer.what_changed.strip())

    def resolve(fresh: str | None, stored: str | None) -> str | None:
        # `.strip()` rather than a bare truthiness test: sweep/parse.py
        # already maps a blank rewrite to None, but this function must not
        # depend on that to avoid erasing a stored sentence. A caller that
        # hands it "  " means "I have nothing", whatever the type says.
        if not (fresh and fresh.strip()):
            return stored
        # A FIRST write needs no news. Every prediction minted before
        # CRMA-782 carries NULL here, and generation is the only other
        # writer -- so without this branch those calls could never acquire an
        # angle at all, however many times they were swept.
        if stored is None:
            return fresh.strip()
        # Replacing one that already reads well is the churn case, and it
        # costs us a sentence a human may have come to rely on. Require the
        # model to have said what moved.
        return fresh.strip() if reported_news else stored

    return (
        resolve(answer.angle, prediction.angle),
        resolve(answer.audience_question, prediction.audience_question),
    )


def _looked_at_nothing(lookup: Any, reading: Any) -> bool:
    """True when this evaluation consulted neither oracle successfully -- an
    ET miss AND an unavailable GDELT reading. Not the same as "we looked and
    found nothing": an available reading of zero articles is a reading."""
    return not lookup.matched and not reading.available


def _carries_a_reading(saturation: Any) -> bool:
    """Whether the prior row's ``EVIDENCE.saturation`` holds something an
    oracle actually answered, as opposed to null or two recorded misses."""
    if not isinstance(saturation, Mapping):
        return False
    et = saturation.get("exploding_topics")
    gdelt = saturation.get("gdelt")
    matched = isinstance(et, Mapping) and bool(et.get("matched"))
    available = isinstance(gdelt, Mapping) and bool(gdelt.get("available"))
    return matched or available


def _final_row_written(evidence: Mapping[str, Any] | None) -> bool:
    """Whether the prior row was already this prediction's final evaluation.

    Read off the row the sweep itself wrote: every sweep row records
    ``EVIDENCE.reevaluation.final_evaluation``. A mint row has no
    ``reevaluation`` block at all, which reads as False -- correctly, since a
    prediction that was minted and never swept has not had its final row.
    """
    if not isinstance(evidence, Mapping):
        return False
    block = evidence.get("reevaluation")
    return isinstance(block, Mapping) and block.get("final_evaluation") is True


def _selected(
    predictions: Sequence[OpenPrediction], *, scope: SweepScope, now: datetime
) -> tuple[list[OpenPrediction], list[SkippedPrediction]]:
    """Split the live rows into "re-evaluate" and "leave alone", with a
    reason for every one left alone."""
    live: list[OpenPrediction] = []
    skipped: list[SkippedPrediction] = []
    for prediction in predictions:
        subject = prediction.claim.subject_descriptor
        # A backstop only: the capped scope is applied in the read
        # (OPEN_PREDICTIONS_QUERY), so a reader that honours it never gets
        # here. A reader that ignores the argument still cannot widen a
        # capped-scope run's blast radius.
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
            prediction.status,
            prediction.horizon_at,
            prediction.claim.horizon_band,
            now,
            final_row_written=_final_row_written(prediction.evidence),
        ):
            closes = grace_ends_at(prediction.horizon_at, prediction.claim.horizon_band)
            skipped.append(
                SkippedPrediction(
                    prediction_id=prediction.prediction_id,
                    subject_descriptor=subject,
                    reason=(
                        f"status {prediction.status} with the one-horizon grace window "
                        f"closed at {closes.isoformat()}; its final evaluation is already "
                        "in the ledger, its grade is final, and no further row will be "
                        "appended"
                    ),
                )
            )
            continue
        live.append(prediction)
    return live, skipped


def _unreadable(predictions: OpenPredictionReader) -> list[SkippedPrediction]:
    """Rows the read could not turn into predictions, as skips.

    A malformed ledger row used to abort the whole sweep from inside a list
    comprehension -- 502, nothing written for any prediction. It degrades per
    row now (matching/predictions.py), and this is where the sweep says so
    out loud instead of quietly evaluating a smaller pool.
    """
    return [
        SkippedPrediction(
            prediction_id=row.prediction_id,
            subject_descriptor=row.subject_descriptor,
            reason=row.reason,
        )
        for row in getattr(predictions, "unreadable", ())
    ]


def _unrequested(
    read: Sequence[OpenPrediction], *, scope: SweepScope
) -> list[SkippedPrediction]:
    """Requested PREDICTION_IDs the read never returned.

    "reevaluated: 0" with the target absent from `skipped` too is the one
    answer a capped-scope fire must never give: it looks identical to "we
    looked and it was fine".
    """
    if not scope.prediction_ids:
        return []
    seen = {prediction.prediction_id for prediction in read}
    return [
        SkippedPrediction(
            prediction_id=prediction_id,
            subject_descriptor="",
            reason=(
                "requested in this run's prediction_ids but no live row was found for it: "
                "it is not in the ledger, its latest row is not ACTIVE or EXPIRED, or the "
                "prediction_limit cut it off. Nothing was evaluated for it"
            ),
        )
        for prediction_id in scope.prediction_ids
        if prediction_id not in seen
    ]


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
            response.text,
            # PREDICTION_ID is the binding key: two live calls can share a
            # subject descriptor, and a `met` bound to the wrong one closes
            # the wrong call permanently. See sweep/parse.py.
            prediction_ids=[item.prediction_id for item in items],
            subjects=[item.subject_descriptor for item in items],
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

    # The capped scope goes INTO the read, not after it: filtering the page
    # the LIMIT returned would silently miss a requested prediction that sits
    # past the cap. See OPEN_PREDICTIONS_QUERY.
    read = predictions.open_predictions(
        limit=scope.prediction_limit, prediction_ids=scope.prediction_ids
    )
    live, skipped = _selected(read, scope=scope, now=moment)
    skipped = _unreadable(predictions) + _unrequested(read, scope=scope) + skipped
    if not live:
        log.info(
            "sweep found nothing to re-evaluate",
            extra={"chain_id": chain, "read": len(read), "skipped": len(skipped)},
        )
        return SweepResult(
            chain_id=chain,
            skipped=skipped,
            predictions_read=len(read),
            trends_indexed=0,
            cost_usd=0.0,
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
            # Shown, not just stored: the prompt asks whether the story has
            # changed, and that question is unanswerable about a sentence the
            # model cannot read. A None here is also load-bearing -- it is how
            # a pre-CRMA-782 call gets told it has no angle yet.
            angle=prediction.angle,
            audience_question=prediction.audience_question,
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
        angle, audience_question = narrative_for(prediction, answer)
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
        saturation_note: str | None = None
        if lookup is not None and reading is not None:
            if _looked_at_nothing(lookup, reading) and _carries_a_reading(
                evidence.get("saturation")
            ):
                # Neither oracle answered -- a provider outage, or the lookup
                # budget spent before this subject's turn. The prior row's
                # real reading stands. Downgrading it to a miss would make the
                # LATEST row -- the one CRMA-769 projects -- say we know less
                # about this subject than we do, and a miss carries no penalty
                # precisely because it is not evidence.
                saturation_note = (
                    "saturation was not re-read at this evaluation (neither Exploding "
                    "Topics nor GDELT answered); the prior reading stands unchanged"
                )
            else:
                evidence = attach_saturation(
                    evidence, build_saturation_evidence(lookup=lookup, reading=reading)
                )
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
        notes: list[str] = [n for n in (resolution.note,) if n]
        if answer is None and provenance.get("reevaluated"):
            block["note"] = (
                "the model returned no usable answer for this call -- absent, malformed, "
                "or not bound to this prediction; confidence and reasoning are the prior "
                "evaluation's, unadjusted, and no observable check was read"
            )
            # Also reported at the API surface: "reevaluated: false, note: null"
            # tells an operator nothing about which of the two it was.
            notes.append(block["note"])
        if saturation_note:
            block["saturation_note"] = saturation_note
            notes.append(saturation_note)
        note = "; ".join(notes) or None
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
            final=status.final,
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
                # Refreshed only when this sweep found news; otherwise the
                # stored sentence is handed back untouched (CRMA-782).
                angle=angle,
                audience_question=audience_question,
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
        # Only a turn that actually ran can have an unknown price.
        cost_usd=provenance.get("batch_cost_usd") if provenance.get("reevaluated") else 0.0,
    )
