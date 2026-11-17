"""Provisional evaluation has no production submission dependencies."""

from __future__ import annotations

import hmac
import json
import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ValidationError
from tt_services_lib.gemini import PredictionLLM
from tt_services_lib.snowflake_client import SnowflakeClient

from .config import Settings
from .handler import judge_sameness, write_topic
from .urls import Fetcher, check_urls

log = logging.getLogger(__name__)


def create_preview_router(
    settings: Settings,
    *,
    nomination_model: type[BaseModel],
    max_body_bytes: int,
    snowflake: SnowflakeClient,
    llm: PredictionLLM,
    judge_llm: PredictionLLM,
    fetch_url: Fetcher,
) -> APIRouter:
    router = APIRouter()

    @router.post("/nominations/preview")
    async def preview(request: Request) -> JSONResponse:
        given = request.headers.get("x-api-key", "").encode()
        authorized = hmac.compare_digest(given, settings.api_key.encode())
        if settings.preview_api_key is not None:
            authorized |= hmac.compare_digest(given, settings.preview_api_key.encode())
        if not authorized:
            raise HTTPException(status_code=401, detail="missing or wrong X-Api-Key")

        raw = await request.body()
        if len(raw) > max_body_bytes:
            raise HTTPException(status_code=400, detail="body over 64 KB")
        try:
            nomination = nomination_model.model_validate(json.loads(raw))
        except (ValueError, ValidationError) as err:
            raise HTTPException(status_code=400, detail="malformed body") from err

        try:
            kept, dropped = await run_in_threadpool(check_urls, nomination.urls, fetch_url)
            if not kept:
                return JSONResponse(status_code=422, content={"urls": dropped})

            task = {**nomination.model_dump(), "urls": kept}
            topic, _ = await run_in_threadpool(write_topic, snowflake, llm, task)
            judgment, _ = await run_in_threadpool(
                judge_sameness, snowflake, judge_llm, topic, task
            )
            status = "would_create"
            if judgment.target_trend_id is not None:
                target = next(
                    neighbor for neighbor in judgment.considered_neighbors
                    if neighbor["trend_id"] == judgment.target_trend_id
                )
                status = (
                    "would_revive" if target["lifecycle_status"] == "RETIRED" else "would_merge"
                )
        except Exception as err:
            log.exception("preview %s failed", nomination.nomination_id)
            raise HTTPException(status_code=503, detail="preview unavailable; retry") from err
        return JSONResponse(
            status_code=200,
            content={
                "nomination_id": nomination.nomination_id,
                "provisional": True,
                "status": status,
                "trend_id": judgment.target_trend_id,
                "dropped_urls": dropped,
            },
        )

    return router
