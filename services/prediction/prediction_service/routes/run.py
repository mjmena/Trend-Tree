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
from collections.abc import Callable
from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.exceptions import HTTPException
from pydantic import BaseModel, Field
from tt_services_lib.auth import CallerIdentity
from tt_services_lib.snowflake_client import SnowflakeClient

from ..config import Settings
from ..domain.claim import Claim, HorizonBand, InvalidClaim, build_verdict
from ..domain.ledger import INSERT_VERDICT, insert_params

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
    subject_descriptor: str
    directional_claim: str
    horizon_band: HorizonBand
    observable_check: str


class RunRequest(BaseModel):
    claim: ClaimIn | None = Field(
        default=None,
        description="Omit to use the built-in smoke-test claim (a capped, single-row test run).",
    )
    confidence: float = Field(default=40.0, ge=0, le=100)
    reasoning: str = Field(default=_DEFAULT_REASONING)


class RunResponse(BaseModel):
    prediction_id: str
    status: Literal["ACTIVE"]
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
            )
        except InvalidClaim as err:
            raise HTTPException(status_code=400, detail=str(err)) from err

        log.info(
            "prediction verdict run",
            extra={"caller": caller.email, "prediction_id": verdict.prediction_id},
        )
        snowflake.execute(
            INSERT_VERDICT.format(table=settings.qualify("FCT_PREDICTION_VERDICT_LEDGER")),
            insert_params(verdict),
        )
        return RunResponse(prediction_id=verdict.prediction_id, status="ACTIVE", written=True)

    return router
