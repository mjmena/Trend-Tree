"""POST /generate -- the generation phase of the prediction pillar (CRMA-763).

A fired run reads a capped slice of the signal corpus, asks the generation
agent for falsifiable claims, and appends one ACTIVE verdict row per surviving
claim to FCT_PREDICTION_VERDICT_LEDGER.

**Why this is a separate route from /run.** The two capabilities are not the
same shape and must not be reachable through one another: this handler is the
only place generation's readers are built, and the generation call it makes
(``generate_predictions``) receives those readers and the LLM and nothing
else. The write itself happens here, after generation has returned -- the
verdict MERGE is never reachable from inside the generation call graph.

Note what that does *not* say. The readers wrap this same write-capable
``SnowflakeClient``; Python does not stop anyone from calling ``execute`` on
it. What stops a generation-phase statement from reaching a trend table is
``assert_generation_sql`` (generation/blindness.py), which runs on every
statement those adapters issue. /run keeps its CRMA-762 shape: a
hand-authored or smoke claim, one row.

Matching (CRMA-764) is not implemented, so every row written here carries
MATCHED_TREND_ID = NULL -- a white-space prediction in the strategy's §2
vocabulary, ledger-only in v1.

Between generation and the write sits the saturation phase (CRMA-765):
``SaturationPhase.weigh`` applies the data-quality floor -- the pillar's one
mechanical gate, so a subject too young or too sparse to judge never reaches
the ledger -- looks the surviving subjects up in Exploding Topics and GDELT,
and lets the model restate its own confidence with those readings in view.
It runs outside ``generate_predictions`` for the same reason the write does:
the generation call graph stays exactly as narrow as blindness.py describes.
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
from ..generation.signals import (
    SIGNALS_TABLE,
    VERDICT_LEDGER_TABLE,
    SnowflakeLiveSubjectReader,
    SnowflakeSignalReader,
)
from ..saturation import SaturationPhase, floor_from_settings

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
            "Idempotency key for the whole run. Each row's PREDICTION_EVAL_ID is a hash of "
            "this id plus that row's frozen 4-part claim, so re-firing with the same "
            "chain_id MERGEs any claim identical to one already written into the row it "
            "already owns, and lands anything genuinely new as a new row. It does NOT "
            "reproduce the first attempt's output: the model runs at temperature 1.0 and "
            "may word things differently. Omit and one is minted, which makes each POST a "
            "new run -- the right default for a manual fire."
        ),
    )


class PredictionOut(BaseModel):
    #: NULL unless this call wrote the row. A PREDICTION_ID is minted per
    #: verdict object, so reporting one for a row the ledger does not hold
    #: (a dry run, or a MERGE that matched an earlier attempt's row) would
    #: name an id that exists nowhere. The ledger's own id for a matched row
    #: belongs to the run that wrote it; look it up by PREDICTION_EVAL_ID.
    prediction_id: str | None
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
    #: Null when the configured model is not in generation/llm.py's rate
    #: table -- an unpriced run reports unknown rather than another model's
    #: number. The token counts above are still exact.
    llm_cost_estimate: float | None


def _to_out(result: GenerationResult, *, written: set[str]) -> list[PredictionOut]:
    return [
        PredictionOut(
            prediction_id=v.prediction_id if v.prediction_eval_id in written else None,
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
    saturation: SaturationPhase | None = None,
) -> APIRouter:
    router = APIRouter()
    # None means the offline phase -- no outbound call, both oracles an
    # explicit miss -- with the configured data-quality floor still applied.
    # The deployed phase is built in server.py and injected, mirroring how the
    # Gemini client arrives: nothing that reaches the network is constructed
    # by default, so a caller that did not ask for it cannot get one.
    saturation_phase = saturation or SaturationPhase.offline(floor_from_settings(settings))

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
        # Generation's two reads, each pinned to one object. The client
        # handed over is the service's own write-capable SnowflakeClient --
        # the narrowing is in what these adapters will *issue*, enforced by
        # assert_generation_sql, not in what the object can do. See
        # generation/blindness.py, which says so rather than claiming a
        # capability boundary the runtime does not provide.
        reader = SnowflakeSignalReader(snowflake, settings.qualify(SIGNALS_TABLE))
        live = SnowflakeLiveSubjectReader(snowflake, settings.qualify(VERDICT_LEDGER_TABLE))

        try:
            result = generate_predictions(
                reader=reader, llm=llm, live_subjects=live, scope=scope, chain_id=chain_id
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

        # Saturation as evidence, and the data-quality floor (CRMA-765). Never
        # raises: an oracle outage is an explicit miss on the row, not a failed
        # run, and the only verdicts this can remove are the ones the floor
        # skipped. See saturation/run.py.
        result = saturation_phase.weigh(result, llm=llm)

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
                            f"{len(result.verdicts)} row(s) landed; the ledger keeps them. "
                            f"Re-firing with chain_id={chain_id!r} re-runs generation from "
                            "the corpus: any claim identical to one already written MERGEs "
                            "into it, and any claim the model words differently lands as a "
                            "new row. It does not replay this run."
                        ),
                    ) from err
                if rows > 0:
                    written.add(verdict.prediction_eval_id)
                else:
                    # The MERGE matched: an earlier fire of this chain_id
                    # already wrote this exact claim. Idempotent, by design --
                    # the row in the ledger is the one that run minted, so
                    # this verdict's PREDICTION_ID is not reported (see
                    # PredictionOut.prediction_id).
                    log.info(
                        "verdict write was a no-op (this claim is already in the ledger)",
                        extra={
                            "chain_id": chain_id,
                            "prediction_eval_id": verdict.prediction_eval_id,
                        },
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
