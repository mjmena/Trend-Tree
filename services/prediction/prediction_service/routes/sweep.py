"""POST /sweep -- the daily run of the prediction pillar (CRMA-766).

This is the endpoint Cloud Scheduler fires (deploy/scheduler.sh), and it is
the whole of the pillar's day:

1. **Re-evaluate.** Every live prediction -- ACTIVE, plus EXPIRED ones still
   inside their one-horizon grace window -- gets its match re-checked, its
   saturation evidence refreshed, its observable check read, and a new ledger
   row appended with the four claim columns carried forward byte-identically.
2. **Generate.** A generation pass runs in the same request, so one scheduled
   call both keeps the existing calls current and mints new ones. Generation
   is second on purpose: it reads the live-subject list off the ledger to
   avoid re-proposing a subject already under an open call, and the sweep has
   just written the rows that say which those are.

**A failing generation pass does not fail the sweep.** The re-evaluation rows
have already landed by then, and a 502 that hides a successful sweep would
make the scheduler's retry re-run work that is already done. Generation's
failure comes back in the response body and in the log, and it surfaces where
the PRD asks for it -- as verdict-ledger staleness in the audit agent's view.

**The strategist tier runs inside the same request** (CRMA-768). The sweep
reads the Approve/Dismiss decisions, applies the precedence ladder, and this
route retains every decision it read as a calibration label in
``FCT_PREDICTION_STRATEGIST_LABELS``. A failed label write is a note, never a
502: the verdict rows are the pillar's output, the labels are for a tuning
pass that has not happened yet, and losing the second must not lose the first.

**Manual and scheduled fires are the same request.** There is no scheduler
mode: Cloud Scheduler POSTs this route with an OIDC token exactly the way a
human does with ``gcloud auth print-identity-token``, and the capped-scope
body (``prediction_ids``, ``skip_generation``) is what makes a test run cheap.
The one thing the scheduled body says that a manual one does not is
``daily_chain_id: true`` -- Cloud Scheduler retries, and without a stable
per-day idempotency key a retry appends a second full set of evaluations for
the same day. See ``sweep.run.daily_chain_id``.
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from fastapi.exceptions import HTTPException
from pydantic import BaseModel, Field
from tt_services_lib.auth import CallerIdentity
from tt_services_lib.snowflake_client import SnowflakeClient

from ..config import Settings
from ..coverage import build_coverage_phase
from ..domain.claim import MAX_LENGTHS
from ..generation.blindness import BlindnessViolation
from ..generation.llm import PredictionLLM
from ..generation.run import GenerationScope, generate_predictions
from ..generation.signals import (
    SIGNALS_TABLE,
    SnowflakeLiveSubjectReader,
    SnowflakeSignalReader,
)
from ..matching.decide import DEFAULT_MIN_SIMILARITY
from ..matching.isolation import MatchingIsolationViolation
from ..matching.predictions import (
    DEFAULT_PREDICTION_LIMIT,
    LIVE_STATUSES,
    VERDICT_LEDGER_TABLE,
    SnowflakeOpenPredictionReader,
)
from ..matching.trends import (
    DEFAULT_CANDIDATE_LIMIT,
    ENRICHMENT_LEDGER_TABLE,
    LIFECYCLE_LEDGER_TABLE,
    TREND_SIGNALS_TABLE,
    TRENDS_TABLE,
    SnowflakeTrendReader,
)
from ..saturation import SaturationPhase, floor_from_settings
from ..strategist import (
    LABEL_TABLE,
    LabelWriteFailed,
    StrategistDecisionReader,
    calibration_labels,
    write_calibration_labels,
)
from ..sweep import (
    SweepResult,
    SweepScope,
    daily_chain_id,
    new_chain_id,
    sweep_predictions,
)
from ..writes import VerdictWriteFailed, write_verdicts

log = logging.getLogger(__name__)


class SweepRequest(BaseModel):
    prediction_limit: int = Field(
        default=DEFAULT_PREDICTION_LIMIT,
        ge=1,
        le=500,
        description="Most live predictions this sweep re-evaluates. A cap on cost, not a gate.",
    )
    prediction_ids: list[str] = Field(
        default_factory=list,
        max_length=50,
        description=(
            "Capped-scope / single-prediction mode: re-evaluate only these PREDICTION_IDs "
            "and leave the rest of the world alone. Empty means every live prediction."
        ),
    )
    candidate_limit: int = Field(
        default=DEFAULT_CANDIDATE_LIMIT,
        ge=1,
        le=100,
        description="How many cosine-ranked trends each subject's embedding leg considers.",
    )
    min_similarity: float = Field(
        default=DEFAULT_MIN_SIMILARITY,
        ge=0.0,
        le=1.0,
        description="Cosine floor for the embedding leg's statement comparison; see POST /match.",
    )
    skip_generation: bool = Field(
        default=False,
        description=(
            "Re-evaluate only -- do not mint new predictions. The cheap shape for a test "
            "fire; the scheduled run leaves it false."
        ),
    )
    lookback_hours: int = Field(
        default=168,
        ge=1,
        le=24 * 90,
        description="The generation pass's corpus window.",
    )
    signal_limit: int = Field(
        default=200, ge=1, le=2000, description="Most FCT_SIGNALS rows the generation pass reads."
    )
    max_predictions: int = Field(
        default=5, ge=1, le=25, description="Most new predictions the generation pass may mint."
    )
    dry_run: bool = Field(
        default=False,
        description="Run both passes and return them without appending any ledger rows.",
    )
    chain_id: str | None = Field(
        default=None,
        max_length=MAX_LENGTHS["chain_id"],
        description=(
            "Idempotency key for the whole run. Each re-evaluation row's PREDICTION_EVAL_ID "
            "is a hash of this id plus the PREDICTION_ID it evaluates, so re-firing with the "
            "same chain_id MERGEs into the rows it already wrote rather than appending a "
            "second evaluation. Omit it and each POST is a new evaluation, which is the "
            "right default for a manual fire. Wins over daily_chain_id when both are given."
        ),
    )
    daily_chain_id: bool = Field(
        default=False,
        description=(
            "Derive chain_id from the UTC calendar date instead of minting a fresh one. "
            "This is what the scheduled job sends (deploy/scheduler.sh): Cloud Scheduler "
            "retries a POST it abandoned at the attempt deadline while the original may "
            "still be running and committing, and a fresh chain_id would append a second "
            "full set of evaluations for the same day. A manual fire leaves this false so "
            "it cannot MERGE into -- and therefore be silently swallowed by -- the day's "
            "scheduled rows."
        ),
    )


class SweepOut(BaseModel):
    prediction_id: str
    prediction_eval_id: str
    subject_descriptor: str
    prior_status: str
    status: str
    #: True when the one-horizon grace window has closed: this is the last row
    #: this prediction will ever get, and its grade is now final.
    final: bool
    #: When re-checking stops. HORIZON_AT plus exactly one horizon length.
    grace_ends_at: str
    prior_confidence: float
    confidence: float
    #: Derived from the two confidences above, stored in no column anywhere.
    confidence_direction: str
    confidence_delta: float | None
    observable_check: str
    matched_trend_id: str | None
    what_changed: str
    #: Queue standing after the precedence ladder -- act / watch_covered /
    #: withdrawn -- and which rung settled it. AC3's "precedence is
    #: observable", at the API surface as well as in EVIDENCE.strategist.
    posture: str
    posture_tier: str
    #: The latest strategist action on this call (APPROVE / DISMISS), or None
    #: when there has been none or the decision source was unreachable.
    strategist_decision: str | None
    #: Whether the model answered for this prediction.
    reevaluated: bool
    note: str | None
    written: bool


class SkippedOut(BaseModel):
    prediction_id: str
    subject_descriptor: str
    reason: str


class GeneratedOut(BaseModel):
    prediction_id: str | None
    prediction_eval_id: str
    subject_descriptor: str
    horizon_band: str
    horizon_at: str
    confidence: float
    written: bool


class SweepResponse(BaseModel):
    chain_id: str
    model: str
    dry_run: bool
    predictions_read: int
    trends_indexed: int
    reevaluated: int
    resolved: int
    expired: int
    verdicts_written: int
    results: list[SweepOut]
    #: Rows the sweep did not re-evaluate, and why: its final row is already
    #: in the ledger; the ledger row could not be read; or a requested
    #: PREDICTION_ID matched no live row at all. Never silent -- "reevaluated:
    #: 0" with nothing in here would look identical to a clean run.
    skipped: list[SkippedOut]
    generation_ran: bool
    #: Why the generation pass did not run or did not finish. Never fails the
    #: request: the re-evaluation rows have already landed.
    generation_note: str | None
    predictions_minted: int
    generated: list[GeneratedOut]
    #: Strategist decisions retained for later regression tuning (AC4). Never
    #: read back at runtime -- see strategist/labels.py.
    calibration_labels_written: int
    #: Why the labels did not land, when they did not. Never fails the
    #: request: the verdict rows are already in the ledger.
    calibration_label_note: str | None
    #: Why no strategist decision was read at all, when the source could not
    #: be reached. Distinct from "nobody has acted", which is silence here.
    strategist_source_note: str | None
    llm_token_usage: dict[str, int]
    llm_cost_estimate: float | None


def _to_out(result: SweepResult, *, written: set[str]) -> list[SweepOut]:
    return [
        SweepOut(
            prediction_id=outcome.prediction_id,
            prediction_eval_id=outcome.verdict.prediction_eval_id,
            subject_descriptor=outcome.subject_descriptor,
            prior_status=outcome.prior_status,
            status=outcome.verdict.status,
            final=outcome.final,
            grace_ends_at=outcome.status.grace_ends_at.isoformat(),
            prior_confidence=outcome.prior_confidence,
            confidence=outcome.verdict.confidence,
            confidence_direction=outcome.confidence_direction,
            confidence_delta=outcome.confidence_delta,
            observable_check=outcome.observation.outcome,
            matched_trend_id=outcome.verdict.matched_trend_id,
            what_changed=outcome.verdict.what_changed or "",
            posture=outcome.posture.posture,
            posture_tier=outcome.posture.tier,
            strategist_decision=(
                outcome.strategist_decision.decision if outcome.strategist_decision else None
            ),
            reevaluated=outcome.reevaluated,
            note=outcome.note,
            written=outcome.verdict.prediction_eval_id in written,
        )
        for outcome in result.outcomes
    ]


def sweep_router(
    settings: Settings,
    snowflake: SnowflakeClient,
    require_caller: Callable[..., CallerIdentity],
    llm: PredictionLLM | None,
    saturation: SaturationPhase | None = None,
    decisions: StrategistDecisionReader | None = None,
) -> APIRouter:
    router = APIRouter()
    # Same shape /generate uses: None is the offline phase -- no outbound
    # call, both oracles an explicit miss -- so constructing an app never by
    # itself reaches the network.
    saturation_phase = saturation or SaturationPhase.offline(floor_from_settings(settings))
    # ...but the SWEEP gets the phase as it was given, None included. An
    # unwired service must leave EVIDENCE.saturation as the prior row left it
    # rather than overwriting a real reading with a "we did not look" miss --
    # the choice local_sweep.py already makes. sweep/run.py holds the same
    # line for a wired phase whose lookups came back empty.
    sweep_saturation = saturation
    # Coverage detection is one read through the client this route already
    # holds -- no key, no outbound HTTP at construction time -- so it is
    # built here rather than in server.py. Off in config (or a warehouse
    # outage) degrades to "we could not look", which demotes nothing.
    coverage_phase = build_coverage_phase(settings, snowflake)
    table = settings.qualify(VERDICT_LEDGER_TABLE)
    label_table = settings.qualify(LABEL_TABLE)

    @router.post("/sweep", response_model=SweepResponse)
    def sweep(
        body: SweepRequest,
        caller: CallerIdentity = Depends(require_caller),  # noqa: B008 - FastAPI's own DI pattern
    ) -> SweepResponse:
        chain_id = body.chain_id or (
            daily_chain_id() if body.daily_chain_id else new_chain_id()
        )
        scope = SweepScope(
            prediction_limit=body.prediction_limit,
            candidate_limit=body.candidate_limit,
            min_similarity=body.min_similarity,
            prediction_ids=tuple(body.prediction_ids),
        )
        # LIVE_STATUSES, not the compare step's ACTIVE-only set: an EXPIRED
        # prediction inside its grace window is still being re-checked, and a
        # truth arriving there still resolves it TRUE.
        predictions = SnowflakeOpenPredictionReader(
            snowflake, table, statuses=LIVE_STATUSES
        )
        trends = SnowflakeTrendReader(
            snowflake,
            trends=settings.qualify(TRENDS_TABLE),
            enrichment=settings.qualify(ENRICHMENT_LEDGER_TABLE),
            lifecycle=settings.qualify(LIFECYCLE_LEDGER_TABLE),
            trend_signals=settings.qualify(TREND_SIGNALS_TABLE),
            signals=settings.qualify(SIGNALS_TABLE),
        )

        try:
            result = sweep_predictions(
                predictions=predictions,
                trends=trends,
                llm=llm,
                saturation=sweep_saturation,
                coverage=coverage_phase,
                decisions=decisions,
                scope=scope,
                chain_id=chain_id,
            )
        except MatchingIsolationViolation:
            log.exception("sweep isolation violation", extra={"chain_id": chain_id})
            raise HTTPException(
                status_code=500,
                detail=(
                    "sweep aborted: a re-evaluation statement violated the read-only "
                    f"isolation invariant. See the log for {chain_id}."
                ),
            ) from None
        except Exception as err:
            log.exception("sweep failed", extra={"chain_id": chain_id})
            raise HTTPException(
                status_code=502,
                detail=(
                    "the re-evaluation sweep failed reading the ledger or the trend tables; "
                    f"no verdicts were written. See the log for {chain_id}."
                ),
            ) from err

        written: set[str] = set()
        if not body.dry_run:
            try:
                written = set(
                    write_verdicts(
                        snowflake, table, result.verdicts, chain_id=chain_id
                    ).written
                )
            except VerdictWriteFailed as err:
                raise HTTPException(
                    status_code=502,
                    detail=(
                        f"{err} Re-firing with chain_id={chain_id!r} re-runs the sweep and "
                        "MERGEs into the rows this run already wrote."
                    ),
                ) from err

        # AC4: every decision this sweep read is retained, with its
        # prediction id and its timestamp, in its own table. Written after
        # the verdicts and never in their way -- a label is evidence for a
        # tuning pass that has not happened yet, a verdict is the product.
        labels_written = 0
        calibration_label_note: str | None = None
        labels = calibration_labels(
            result.strategist,
            verdicts={
                outcome.prediction_id: (outcome.verdict.confidence, outcome.verdict.status)
                for outcome in result.outcomes
            },
            recorded_at=datetime.now(UTC),
            chain_id=chain_id,
        )
        if labels and not body.dry_run:
            try:
                labels_written = len(
                    write_calibration_labels(
                        snowflake, label_table, labels, chain_id=chain_id
                    )
                )
            except LabelWriteFailed as err:
                log.exception("calibration label write failed", extra={"chain_id": chain_id})
                calibration_label_note = (
                    f"{err} The verdict rows above are unaffected; re-firing with "
                    f"chain_id={chain_id!r} re-reads the same decisions and MERGEs into "
                    "the label rows that landed."
                )

        log.info(
            "sweep run",
            extra={
                "caller": caller.email,
                "chain_id": chain_id,
                "reevaluated": len(result.outcomes),
                "written": len(written),
                "dry_run": body.dry_run,
            },
        )

        generated: list[GeneratedOut] = []
        generation_ran = False
        generation_note: str | None = None
        minted = 0
        tokens_in = result.input_tokens
        tokens_out = result.output_tokens
        cost = result.cost_usd
        model = result.model

        if body.skip_generation:
            generation_note = "generation skipped at the caller's request (skip_generation)"
        elif llm is None:
            # The same 503 condition POST /generate reports, reported as a
            # note instead: the sweep's own rows landed, and failing the whole
            # request over a missing key would hide that.
            generation_note = (
                "generation is unavailable: no Gemini API key is configured "
                "(PREDICTION_GEMINI_API_KEY). The re-evaluation rows above still landed."
            )
        else:
            try:
                generation = generate_predictions(
                    reader=SnowflakeSignalReader(snowflake, settings.qualify(SIGNALS_TABLE)),
                    llm=llm,
                    live_subjects=SnowflakeLiveSubjectReader(snowflake, table),
                    scope=GenerationScope(
                        lookback_hours=body.lookback_hours,
                        signal_limit=body.signal_limit,
                        max_predictions=body.max_predictions,
                    ),
                    chain_id=chain_id,
                )
                try:
                    generation = saturation_phase.weigh(generation, llm=llm)
                except Exception:
                    log.exception(
                        "saturation phase failed; verdicts keep generation's own numbers",
                        extra={"chain_id": chain_id},
                    )
                generation_ran = True
                model = model or generation.model
                tokens_in += generation.input_tokens
                tokens_out += generation.output_tokens
                cost = (
                    None
                    if cost is None or generation.cost_usd is None
                    else round(cost + generation.cost_usd, 6)
                )
                minted_written: set[str] = set()
                # A same-chain retry MERGEs onto rows a previous attempt
                # committed. Those rows exist -- reporting prediction_id: null
                # for them would say the opposite -- so "the row is in the
                # ledger" is written | deduplicated, while `written` keeps its
                # narrower meaning of "this attempt inserted it".
                minted_present: set[str] = set()
                if not body.dry_run:
                    report = write_verdicts(
                        snowflake, table, generation.verdicts, chain_id=chain_id
                    )
                    minted_written = set(report.written)
                    minted_present = minted_written | set(report.deduplicated)
                minted = len(minted_written)
                generated = [
                    GeneratedOut(
                        prediction_id=(
                            v.prediction_id
                            if v.prediction_eval_id in minted_present
                            else None
                        ),
                        prediction_eval_id=v.prediction_eval_id,
                        subject_descriptor=v.claim.subject_descriptor,
                        horizon_band=v.claim.horizon_band,
                        horizon_at=v.horizon_at.isoformat(),
                        confidence=v.confidence,
                        written=v.prediction_eval_id in minted_written,
                    )
                    for v in generation.verdicts
                ]
            except BlindnessViolation:
                # A generation-phase statement reached for trend/heat state.
                # A bug in this service -- but the sweep's rows are already in
                # the ledger, so it is reported, not raised.
                log.exception("generation blindness violation", extra={"chain_id": chain_id})
                generation_note = (
                    "generation aborted: a generation-phase statement violated the "
                    f"trend/heat/lifecycle blindness invariant. See the log for {chain_id}."
                )
            except VerdictWriteFailed as err:
                log.exception("generation write failed", extra={"chain_id": chain_id})
                generation_note = f"{err}"
            except Exception as err:  # noqa: BLE001 - reported, never fatal to the sweep
                log.exception("generation pass failed", extra={"chain_id": chain_id})
                generation_note = (
                    f"the generation pass failed ({type(err).__name__}); the re-evaluation "
                    f"rows above still landed. See the log for {chain_id}."
                )

        return SweepResponse(
            chain_id=chain_id,
            model=model,
            dry_run=body.dry_run,
            predictions_read=result.predictions_read,
            trends_indexed=result.trends_indexed,
            reevaluated=len(result.outcomes),
            resolved=len(result.resolved),
            expired=len(result.expired),
            verdicts_written=len(written),
            results=_to_out(result, written=written),
            skipped=[
                SkippedOut(
                    prediction_id=s.prediction_id,
                    subject_descriptor=s.subject_descriptor,
                    reason=s.reason,
                )
                for s in result.skipped
            ],
            generation_ran=generation_ran,
            generation_note=generation_note,
            predictions_minted=minted,
            generated=generated,
            calibration_labels_written=labels_written,
            calibration_label_note=calibration_label_note,
            strategist_source_note=result.strategist.unavailable_reason,
            llm_token_usage={
                "input": tokens_in,
                "output": tokens_out,
                "total": tokens_in + tokens_out,
            },
            llm_cost_estimate=cost,
        )

    return router
