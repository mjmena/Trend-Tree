"""POST /run -- capped-scope test / manual-fire entrypoint (CRMA-762).

This is the service's skeleton run mode. It does not implement the real
generate/match/verdict pipeline (docs/prd/prediction-pillar-v1.md's
three-phase run is later scope) -- it validates a supplied claim, or falls
back to a built-in smoke-test claim, and appends exactly one verdict row
through the shared retrying Snowflake client. That's the whole point of the
skeleton: prove deploy -> authenticate -> ledger-write end to end before any
generation logic exists.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.exceptions import HTTPException
from pydantic import BaseModel, Field
from tt_services_lib.auth import CallerIdentity
from tt_services_lib.snowflake_client import SnowflakeClient

from ..config import Settings
from ..domain.claim import MAX_LENGTHS, Claim, HorizonBand, InvalidClaim, build_verdict
from ..domain.ledger import MERGE_VERDICT, insert_params

log = logging.getLogger(__name__)

# The built-in smoke-test claim used when a caller POSTs with no `claim` body
# -- a capped-scope run that proves the write path without needing a caller
# to hand-author a claim. Values are illustrative (drawn from the strategy
# doc's own §2 example), not a real generated prediction.
_SMOKE_TEST_CLAIM = Claim(
    subject_descriptor="rucking vests",
    directional_claim="mainstream retail adoption expands beyond specialty fitness",
    horizon_band="emerging_3_6mo",
    observable_check="major-retailer listings + sustained search-interest growth",
)

_EMPTY_EVIDENCE = {
    "source_signals": [],
    "saturation": None,
    "trend_context": None,
    "coverage": None,
}

_DEFAULT_REASONING = (
    "Skeleton run (CRMA-762): no generation/matching pipeline implemented yet. "
    "This verdict exists to prove the deploy -> auth -> ledger-write path end to end."
)


class ClaimIn(BaseModel):
    # max_length mirrors the ledger's column widths (domain.claim.MAX_LENGTHS,
    # itself mirroring the DDL) so an over-long field is a 422 from pydantic
    # here, or a 400 from the domain layer for anything pydantic can't see --
    # never a Snowflake "String is too long" surfacing as a 500.
    subject_descriptor: str = Field(max_length=MAX_LENGTHS["subject_descriptor"])
    directional_claim: str = Field(max_length=MAX_LENGTHS["directional_claim"])
    horizon_band: HorizonBand
    observable_check: str = Field(max_length=MAX_LENGTHS["observable_check"])


class RunRequest(BaseModel):
    claim: ClaimIn | None = Field(
        default=None,
        description="Omit to use the built-in smoke-test claim (a capped, single-row test run).",
    )
    confidence: float = Field(default=40.0, ge=0, le=100)
    reasoning: str = Field(default=_DEFAULT_REASONING, max_length=MAX_LENGTHS["reasoning"])


class RunResponse(BaseModel):
    prediction_id: str
    #: This row's ledger identity -- minted here, not by the warehouse, so the
    #: write is idempotent under retry (see domain/ledger.py).
    prediction_eval_id: str
    chain_id: str
    status: Literal["ACTIVE"]
    #: Rows the MERGE actually affected, straight from the client -- not an
    #: assumption. 1 on a normal write.
    rows_written: int
    #: ``rows_written > 0``. False with ``rows_written == 0`` means the MERGE
    #: matched an existing PREDICTION_EVAL_ID: a retried attempt whose
    #: predecessor had already committed. The ledger holds exactly one row for
    #: this verdict either way -- this attempt just isn't the one that put it
    #: there. A genuine write failure is a 502, never a 200 with written=false.
    written: bool


def run_router(
    settings: Settings,
    snowflake: SnowflakeClient,
    require_caller: Callable[..., CallerIdentity],
) -> APIRouter:
    router = APIRouter()

    @router.post("/run", response_model=RunResponse)
    def run(
        body: RunRequest,
        caller: CallerIdentity = Depends(require_caller),  # noqa: B008 - FastAPI's own DI pattern
    ) -> RunResponse:
        claim_in = body.claim
        # One value per run/generation pass (DDL comment on CHAIN_ID). The
        # skeleton's run is a single verdict, so it is one row per chain
        # today; the real three-phase run will emit several under one.
        chain_id = f"pred-verdict-chain-{uuid.uuid4().hex[:8]}"
        try:
            claim = (
                Claim(
                    subject_descriptor=claim_in.subject_descriptor,
                    directional_claim=claim_in.directional_claim,
                    horizon_band=claim_in.horizon_band,
                    observable_check=claim_in.observable_check,
                )
                if claim_in is not None
                else _SMOKE_TEST_CLAIM
            )
            verdict = build_verdict(
                claim,
                confidence=body.confidence,
                reasoning=body.reasoning,
                evidence=dict(_EMPTY_EVIDENCE),
                chain_id=chain_id,
            )
        except InvalidClaim as err:
            raise HTTPException(status_code=400, detail=str(err)) from err

        log.info(
            "prediction verdict run",
            extra={
                "caller": caller.email,
                "prediction_id": verdict.prediction_id,
                "prediction_eval_id": verdict.prediction_eval_id,
                "chain_id": verdict.chain_id,
            },
        )
        try:
            rows_written = snowflake.execute(
                MERGE_VERDICT.format(table=settings.qualify("FCT_PREDICTION_VERDICT_LEDGER")),
                insert_params(verdict),
            )
        except Exception as err:
            # The shared client has already exhausted its retries by now, so
            # this is a real failure, not a blip. 502: the dependency failed,
            # the request itself was fine -- and never a 200 claiming a write
            # that did not happen.
            log.exception(
                "verdict write failed",
                extra={"prediction_eval_id": verdict.prediction_eval_id},
            )
            raise HTTPException(
                status_code=502, detail=f"verdict write failed: {err}"
            ) from err

        if rows_written == 0:
            # The MERGE matched -- a retried attempt whose predecessor had
            # already committed. The row is there; nothing was duplicated.
            log.warning(
                "verdict write was a no-op (already present) -- retry deduplicated",
                extra={"prediction_eval_id": verdict.prediction_eval_id},
            )
        return RunResponse(
            prediction_id=verdict.prediction_id,
            prediction_eval_id=verdict.prediction_eval_id,
            chain_id=chain_id,
            status="ACTIVE",
            rows_written=rows_written,
            written=rows_written > 0,
        )

    return router
