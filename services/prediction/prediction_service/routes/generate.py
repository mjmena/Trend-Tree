"""POST /generate -- the generation phase of the prediction pillar (CRMA-763).

A fired run reads a capped slice of the signal corpus, asks the generation
agent for falsifiable claims, and appends one ACTIVE verdict row per surviving
claim to FCT_PREDICTION_VERDICT_LEDGER.

**Why this is a separate route from /run.** The two capabilities are not the
same shape and must not be reachable through one another: this handler is the
only place a ``SignalReader`` is built, and the generation call it makes
(``generate_predictions``) receives that reader and the LLM and nothing else.
The Snowflake client -- the object that can write, and that could read a trend
table -- stays here, on the *write* side of the boundary, and is used only
after generation has returned its verdicts. /run keeps its CRMA-762 shape: a
hand-authored or smoke claim, one row.

Matching (CRMA-764) is not implemented, so every row written here carries
MATCHED_TREND_ID = NULL -- a white-space prediction in the strategy's §2
vocabulary, ledger-only in v1.
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
from ..domain.ledger import MERGE_VERDICT, insert_params
from ..generation.blindness import BlindnessViolation
from ..generation.llm import LLMError, PredictionLLM
from ..generation.parse import UnparseableResponse
from ..generation.run import (
    GenerationResult,
    GenerationScope,
    generate_predictions,
    new_chain_id,
)
from ..generation.signals import SIGNALS_TABLE, SnowflakeSignalReader

log = logging.getLogger(__name__)


class GenerateRequest(BaseModel):
    lookback_hours: int = Field(
        default=168,
        ge=1,
        le=24 * 90,
        description="How far back the corpus slice reaches. A cap on cost, not a gate.",
    )
    signal_limit: int = Field(
        default=200, ge=1, le=2000, description="Most FCT_SIGNALS rows to read."
    )
    max_predictions: int = Field(
        default=5, ge=1, le=25, description="Most verdict rows this run may write."
    )
    dry_run: bool = Field(
        default=False,
        description=(
            "Generate and return the claims without appending them to the ledger -- "
            "for iterating on generation quality against the real corpus."
        ),
    )
    chain_id: str | None = Field(
        default=None,
        max_length=MAX_LENGTHS["chain_id"],
        description=(
            "Idempotency key for the whole run. Each row's PREDICTION_EVAL_ID is derived "
            "from it (chain_id + ordinal), so re-firing with the same chain_id MERGEs into "
            "the rows the first attempt wrote instead of appending a second copy of the run. "
            "Omit and one is minted, which makes each POST a new run -- the right default "
            "for a manual fire."
        ),
    )


class PredictionOut(BaseModel):
    prediction_id: str
    prediction_eval_id: str
    subject_descriptor: str
    directional_claim: str
    horizon_band: str
    horizon_at: str
    observable_check: str
    confidence: float
    status: str
    #: NULL until the matching phase (CRMA-764) exists -- every prediction
    #: minted here is a white-space prediction.
    matched_trend_id: str | None
    source_signals: list[str]
    written: bool


class RejectionOut(BaseModel):
    reason: str
    subject: str | None


class GenerateResponse(BaseModel):
    chain_id: str
    model: str
    signals_considered: int
    predictions_proposed: int
    predictions_written: int
    dry_run: bool
    predictions: list[PredictionOut]
    #: Why proposals did not become predictions -- a run that emitted nothing
    #: should say why, not just come back empty.
    rejections: list[RejectionOut]
    llm_token_usage: dict[str, int]
    llm_cost_estimate: float


def _to_out(result: GenerationResult, *, written: set[str]) -> list[PredictionOut]:
    return [
        PredictionOut(
            prediction_id=v.prediction_id,
            prediction_eval_id=v.prediction_eval_id,
            subject_descriptor=v.claim.subject_descriptor,
            directional_claim=v.claim.directional_claim,
            horizon_band=v.claim.horizon_band,
            horizon_at=v.horizon_at.isoformat(),
            observable_check=v.claim.observable_check,
            confidence=v.confidence,
            status=v.status,
            matched_trend_id=v.matched_trend_id,
            source_signals=list(v.evidence.get("source_signals") or []),
            written=v.prediction_eval_id in written,
        )
        for v in result.verdicts
    ]


def generate_router(
    settings: Settings,
    snowflake: SnowflakeClient,
    require_caller: Callable[..., CallerIdentity],
    llm: PredictionLLM | None,
) -> APIRouter:
    router = APIRouter()

    @router.post("/generate", response_model=GenerateResponse)
    def generate(
        body: GenerateRequest,
        caller: CallerIdentity = Depends(require_caller),  # noqa: B008 - FastAPI's own DI pattern
    ) -> GenerateResponse:
        if llm is None:
            # Not a boot failure by design (see config.GeminiSettings): the
            # rest of the service, including the deploy gate's /whoami probe,
            # still works. This is the one route that cannot.
            raise HTTPException(
                status_code=503,
                detail=(
                    "generation is unavailable: no Gemini API key is configured. "
                    "Set PREDICTION_GEMINI_API_KEY."
                ),
            )

        chain_id = body.chain_id or new_chain_id()
        scope = GenerationScope(
            lookback_hours=body.lookback_hours,
            signal_limit=body.signal_limit,
            max_predictions=body.max_predictions,
        )
        # The blindness boundary, in one expression: the reader is the only
        # capability generation gets, and it can read exactly one table.
        reader = SnowflakeSignalReader(snowflake, settings.qualify(SIGNALS_TABLE))

        try:
            result = generate_predictions(
                reader=reader, llm=llm, scope=scope, chain_id=chain_id
            )
        except BlindnessViolation:
            # A generation-phase statement reached for trend/heat/lifecycle
            # state. That is a bug in this service, not a dependency failure,
            # and it must never degrade into "we generated something anyway".
            log.exception("generation blindness violation", extra={"chain_id": chain_id})
            raise HTTPException(
                status_code=500,
                detail=(
                    "generation aborted: a generation-phase statement violated the "
                    f"trend/heat/lifecycle blindness invariant. See the log for {chain_id}."
                ),
            ) from None
        except (LLMError, UnparseableResponse) as err:
            log.exception("generation failed", extra={"chain_id": chain_id})
            raise HTTPException(
                status_code=502,
                detail=f"generation failed; no verdicts were written. See the log for {chain_id}.",
            ) from err
        except Exception as err:
            log.exception("signal corpus read failed", extra={"chain_id": chain_id})
            raise HTTPException(
                status_code=502,
                detail=(
                    "generation failed reading the signal corpus; no verdicts were written. "
                    f"See the log for {chain_id}."
                ),
            ) from err

        log.info(
            "generation run",
            extra={
                "caller": caller.email,
                "chain_id": chain_id,
                "signals_considered": result.signals_considered,
                "predictions": len(result.verdicts),
                "dry_run": body.dry_run,
            },
        )

        written: set[str] = set()
        if not body.dry_run:
            table = settings.qualify("FCT_PREDICTION_VERDICT_LEDGER")
            for verdict in result.verdicts:
                try:
                    rows = snowflake.execute(
                        MERGE_VERDICT.format(table=table), insert_params(verdict)
                    )
                except Exception as err:
                    # The shared client has already exhausted its retries.
                    # Rows appended before this point stay -- the ledger is
                    # append-only and a partial run is real history, not
                    # something to pretend away. Say how many landed.
                    log.exception(
                        "verdict write failed",
                        extra={
                            "chain_id": chain_id,
                            "prediction_eval_id": verdict.prediction_eval_id,
                        },
                    )
                    raise HTTPException(
                        status_code=502,
                        detail=(
                            f"verdict write failed after {len(written)} of "
                            f"{len(result.verdicts)} row(s) landed. Re-fire with "
                            f"chain_id={chain_id!r} to complete the run idempotently."
                        ),
                    ) from err
                if rows > 0:
                    written.add(verdict.prediction_eval_id)
                else:
                    # The MERGE matched: this run's chain_id was fired before
                    # and that attempt's row is already in the ledger.
                    log.warning(
                        "verdict write was a no-op (already present)",
                        extra={"prediction_eval_id": verdict.prediction_eval_id},
                    )

        return GenerateResponse(
            chain_id=chain_id,
            model=result.model,
            signals_considered=result.signals_considered,
            predictions_proposed=len(result.verdicts),
            predictions_written=len(written),
            dry_run=body.dry_run,
            predictions=_to_out(result, written=written),
            rejections=[RejectionOut(reason=r.reason, subject=r.subject) for r in result.rejected],
            llm_token_usage={
                "input": result.input_tokens,
                "output": result.output_tokens,
                "total": result.input_tokens + result.output_tokens,
            },
            llm_cost_estimate=result.cost_usd,
        )

    return router
