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

**Manual and scheduled fires are the same request.** There is no scheduler
mode: Cloud Scheduler POSTs this route with an OIDC token exactly the way a
human does with ``gcloud auth print-identity-token``, and the capped-scope
body (``prediction_ids``, ``skip_generation``) is what makes a test run cheap.
"""

from __future__ import annotations

import logging
from collections.abc import Callable

from fastapi import APIRouter, Depends
from fastapi.exceptions import HTTPException
from pydantic import BaseModel, Field
from tt_services_lib.auth import CallerIdentity
from tt_services_lib.snowflake_client import SnowflakeClient

from ..config import Settings
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
from ..sweep import SweepResult, SweepScope, new_chain_id, sweep_predictions
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
            "second evaluation. Cloud Scheduler retries a failed POST, so the scheduled job "
            "passes a stable id per calendar day (see deploy/scheduler.sh); omit it and each "
            "POST is a new evaluation, which is the right default for a manual fire."
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
    #: Live rows the sweep read and deliberately did not re-evaluate -- past
    #: the grace window, or outside a capped-scope run's prediction_ids.
    skipped: list[SkippedOut]
    generation_ran: bool
    #: Why the generation pass did not run or did not finish. Never fails the
    #: request: the re-evaluation rows have already landed.
    generation_note: str | None
    predictions_minted: int
    generated: list[GeneratedOut]
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
) -> APIRouter:
    router = APIRouter()
    # Same shape /generate uses: None is the offline phase -- no outbound
    # call, both oracles an explicit miss -- so constructing an app never by
    # itself reaches the network.
    saturation_phase = saturation or SaturationPhase.offline(floor_from_settings(settings))
    table = settings.qualify(VERDICT_LEDGER_TABLE)

    @router.post("/sweep", response_model=SweepResponse)
    def sweep(
        body: SweepRequest,
        caller: CallerIdentity = Depends(require_caller),  # noqa: B008 - FastAPI's own DI pattern
    ) -> SweepResponse:
        chain_id = body.chain_id or new_chain_id()
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
                saturation=saturation_phase,
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
                if not body.dry_run:
                    minted_written = set(
                        write_verdicts(
                            snowflake, table, generation.verdicts, chain_id=chain_id
                        ).written
                    )
                minted = len(minted_written)
                generated = [
                    GeneratedOut(
                        prediction_id=(
                            v.prediction_id
                            if v.prediction_eval_id in minted_written
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
            llm_token_usage={
                "input": tokens_in,
                "output": tokens_out,
                "total": tokens_in + tokens_out,
            },
            llm_cost_estimate=cost,
        )

    return router
