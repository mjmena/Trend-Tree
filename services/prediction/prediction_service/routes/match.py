"""POST /match -- the compare step of the prediction pillar (CRMA-764).

A fired run reads the ledger's open predictions, compares each against
current trends via the descriptor vocabulary (ADR-0003) and embeddings, and
appends one verdict row per prediction: ``MATCHED_TREND_ID`` and
``EVIDENCE.trend_context`` set on a hit, both NULL on a miss -- a white-space
prediction, ledger-only in v1.

**Why this is a separate route from /generate.** Generation is structurally
blind to trend, heat and lifecycle state, and CRMA-763 made that a property
of the statements a generation run issues, asserted over the whole run
(tests/test_blindness.py). Matching reads exactly those tables. Hanging it
off the end of /generate would have put a trend read inside a generation
run's statement set -- so the compare step is its own request, its own call
graph and its own guard (matching/isolation.py). The generation grant is
untouched.

The write happens here, after matching has returned, with the service's own
client -- the same shape /generate uses, and for the same reason: no verdict
MERGE is reachable from inside the matching call graph.
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
from ..generation.llm import PredictionLLM
from ..matching.decide import DEFAULT_MIN_SIMILARITY
from ..matching.isolation import MatchingIsolationViolation
from ..matching.predictions import (
    DEFAULT_PREDICTION_LIMIT,
    VERDICT_LEDGER_TABLE,
    SnowflakeOpenPredictionReader,
)
from ..matching.run import (
    MatchResult,
    MatchScope,
    match_open_predictions,
    new_chain_id,
)
from ..matching.trends import (
    DEFAULT_CANDIDATE_LIMIT,
    ENRICHMENT_LEDGER_TABLE,
    LIFECYCLE_LEDGER_TABLE,
    SIGNALS_TABLE,
    TREND_SIGNALS_TABLE,
    TRENDS_TABLE,
    SnowflakeTrendReader,
)

log = logging.getLogger(__name__)


class MatchRequest(BaseModel):
    prediction_limit: int = Field(
        default=DEFAULT_PREDICTION_LIMIT,
        ge=1,
        le=500,
        description="Most open predictions this run evaluates. A cap on cost, not a gate.",
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
        description=(
            "Cosine floor for the embedding leg's *statement* comparison -- the fallback "
            "used for a trend that has no descriptor of its own. A candidate scored "
            "against a trend's descriptor.query is on a different scale and carries its "
            "own measured floor (matching/decide.py). Decides matched vs white-space, "
            "never whether a prediction survives -- both outcomes are written."
        ),
    )
    dry_run: bool = Field(
        default=False,
        description="Resolve the matches and return them without appending verdict rows.",
    )
    chain_id: str | None = Field(
        default=None,
        max_length=MAX_LENGTHS["chain_id"],
        description=(
            "Idempotency key for the whole run. Each row's PREDICTION_EVAL_ID is a hash of "
            "this id plus the PREDICTION_ID it evaluates, so re-firing with the same "
            "chain_id MERGEs into the rows it already wrote rather than appending a second "
            "set. Omit and one is minted, which makes each POST a new evaluation."
        ),
    )


class MatchOut(BaseModel):
    prediction_id: str
    prediction_eval_id: str
    subject_descriptor: str
    #: NULL is the white-space outcome, not a failure.
    matched_trend_id: str | None
    match_method: str | None
    similarity: float | None
    trend_topic: str | None
    #: The matched trend's heat / acceleration / growth / age. Null when
    #: unmeasured -- which covers a white-space prediction (no trend to have
    #: context for), a matched trend the warehouse has nothing recorded for,
    #: and a matched trend whose context read failed (``note`` says so, and
    #: the row is written either way).
    trend_context: dict | None
    confidence: float
    #: Whether the narrative model wrote this row's reasoning.
    narrated: bool
    note: str | None
    written: bool


class MatchResponse(BaseModel):
    chain_id: str
    model: str
    predictions_considered: int
    trends_indexed: int
    matched: int
    white_space: int
    verdicts_written: int
    dry_run: bool
    min_similarity: float
    results: list[MatchOut]
    llm_token_usage: dict[str, int]
    #: Null when the configured model is not priced, or when no narrative
    #: call was made at all (a run that matched nothing costs nothing).
    llm_cost_estimate: float | None


def _to_out(result: MatchResult, *, written: set[str]) -> list[MatchOut]:
    return [
        MatchOut(
            prediction_id=outcome.prediction_id,
            prediction_eval_id=outcome.verdict.prediction_eval_id,
            subject_descriptor=outcome.subject_descriptor,
            matched_trend_id=outcome.verdict.matched_trend_id,
            match_method=outcome.decision.method,
            similarity=(
                outcome.decision.trend.similarity if outcome.decision.trend else None
            ),
            trend_topic=(outcome.decision.trend.trend_topic if outcome.decision.trend else None),
            trend_context=outcome.verdict.evidence.get("trend_context"),
            confidence=outcome.verdict.confidence,
            narrated=outcome.narrated,
            note=outcome.note,
            written=outcome.verdict.prediction_eval_id in written,
        )
        for outcome in result.outcomes
    ]


def match_router(
    settings: Settings,
    snowflake: SnowflakeClient,
    require_caller: Callable[..., CallerIdentity],
    llm: PredictionLLM | None,
) -> APIRouter:
    router = APIRouter()

    @router.post("/match", response_model=MatchResponse)
    def match(
        body: MatchRequest,
        caller: CallerIdentity = Depends(require_caller),  # noqa: B008 - FastAPI's own DI pattern
    ) -> MatchResponse:
        chain_id = body.chain_id or new_chain_id()
        scope = MatchScope(
            prediction_limit=body.prediction_limit,
            candidate_limit=body.candidate_limit,
            min_similarity=body.min_similarity,
        )
        # The compare step's reads, each pinned to its objects. The client
        # handed over is the service's own write-capable SnowflakeClient --
        # the narrowing is in what these adapters will *issue*, enforced by
        # assert_matching_sql, not in what the object can do.
        predictions = SnowflakeOpenPredictionReader(
            snowflake, settings.qualify(VERDICT_LEDGER_TABLE)
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
            result = match_open_predictions(
                predictions=predictions,
                trends=trends,
                # None is a degraded narrative, never a dead route: the match
                # itself is decided without a model, so a service with no
                # Gemini key still writes correct MATCHED_TREND_IDs and
                # trend_context, carrying each prediction's prior reasoning.
                llm=llm,
                scope=scope,
                chain_id=chain_id,
            )
        except MatchingIsolationViolation:
            # A matching-phase statement tried to write, or reached an object
            # this phase was not granted. A bug in this service, not a
            # dependency failure.
            log.exception("matching isolation violation", extra={"chain_id": chain_id})
            raise HTTPException(
                status_code=500,
                detail=(
                    "matching aborted: a matching-phase statement violated the read-only "
                    f"isolation invariant. See the log for {chain_id}."
                ),
            ) from None
        except Exception as err:
            log.exception("matching failed", extra={"chain_id": chain_id})
            raise HTTPException(
                status_code=502,
                detail=(
                    "matching failed reading the ledger or the trend tables; no verdicts "
                    f"were written. See the log for {chain_id}."
                ),
            ) from err

        log.info(
            "match run",
            extra={
                "caller": caller.email,
                "chain_id": chain_id,
                "predictions": len(result.outcomes),
                "matched": len(result.matched),
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
                    # append-only and a partial run is real history.
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
                            f"Re-firing with chain_id={chain_id!r} re-runs the compare step "
                            "and MERGEs into the rows this run already wrote."
                        ),
                    ) from err
                if rows > 0:
                    written.add(verdict.prediction_eval_id)
                else:
                    log.info(
                        "verdict write was a no-op (this evaluation is already in the ledger)",
                        extra={
                            "chain_id": chain_id,
                            "prediction_eval_id": verdict.prediction_eval_id,
                        },
                    )

        return MatchResponse(
            chain_id=chain_id,
            model=result.model,
            predictions_considered=result.predictions_considered,
            trends_indexed=result.trends_indexed,
            matched=len(result.matched),
            white_space=len(result.white_space),
            verdicts_written=len(written),
            dry_run=body.dry_run,
            min_similarity=scope.min_similarity,
            results=_to_out(result, written=written),
            llm_token_usage={
                "input": result.input_tokens,
                "output": result.output_tokens,
                "total": result.input_tokens + result.output_tokens,
            },
            llm_cost_estimate=result.cost_usd,
        )

    return router
