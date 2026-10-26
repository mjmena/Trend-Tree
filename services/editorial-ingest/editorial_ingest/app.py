"""The editorial-ingest FastAPI app factory (CRMA-1667).

Three routes:

- ``POST /nominations`` -- the accept route ATLAS calls with ``X-Api-Key``.
- ``POST /tasks/nominations`` -- the task handler; only Cloud Tasks' OIDC
  token from the queue's service account gets in. Its work is handler.py.
- ``GET /health`` -- the deploy smoke probe (not /healthz: Google's edge
  swallows that path on *.run.app).

The service is public (allUsers invoker), so each route authenticates itself.
"""

from __future__ import annotations

import hmac
import json
import logging
from typing import Annotated, Any

from fastapi import Body, Depends, FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError
from tt_services_lib.auth import CallerIdentity, TokenVerifier, require_caller_dependency
from tt_services_lib.gemini import PredictionLLM
from tt_services_lib.snowflake_client import SnowflakeClient

from .config import ConfigError, Settings
from .handler import Dispatch, handle_nomination
from .tasks import EnqueueError, TaskQueue
from .urls import Fetcher, check_urls, http_fetch

log = logging.getLogger(__name__)

MAX_BODY_BYTES = 64 * 1024
TASK_HANDLER_PATH = "/tasks/nominations"

NonBlank = Annotated[str, StringConstraints(pattern=r"\S")]


class Nomination(BaseModel):
    # The contract has exactly four fields; anything else (rationale,
    # category, dry_run) is a malformed body.
    model_config = ConfigDict(extra="forbid", strict=True)

    # The idempotency key, the Cloud Tasks task name and the CANDIDATE_ID
    # (VARCHAR(64)); task names allow only [A-Za-z0-9_-].
    nomination_id: Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
    brief: NonBlank
    urls: Annotated[list[str], Field(min_length=1, max_length=10)]
    nominated_by: NonBlank


def create_app(
    settings: Settings,
    *,
    queue: TaskQueue,
    snowflake: SnowflakeClient,
    llm: PredictionLLM,
    dispatch: Dispatch,
    verify_token: TokenVerifier | None = None,
    fetch_url: Fetcher = http_fetch,
) -> FastAPI:
    if not settings.api_key:
        # hmac.compare_digest("", "") is True: an empty key would admit anyone.
        raise ConfigError("EDITORIAL_API_KEY is empty")
    app = FastAPI(
        title="trend-tree-editorial-ingest", docs_url=None, redoc_url=None, openapi_url=None
    )
    expected_key = settings.api_key.encode()

    @app.get("/health")
    def health() -> dict[str, bool]:
        return {"ok": True}

    @app.post("/nominations")
    async def accept(request: Request) -> JSONResponse:
        # The key first, before reading or parsing anything.
        given = request.headers.get("x-api-key", "").encode()
        if not hmac.compare_digest(given, expected_key):
            raise HTTPException(status_code=401, detail="missing or wrong X-Api-Key")

        raw = await request.body()
        if len(raw) > MAX_BODY_BYTES:
            raise HTTPException(status_code=400, detail="body over 64 KB")
        try:
            nomination = Nomination.model_validate(json.loads(raw))
        except (ValueError, ValidationError) as err:
            raise HTTPException(status_code=400, detail=f"malformed body: {err}") from err

        kept, dropped = await run_in_threadpool(check_urls, nomination.urls, fetch_url)
        if not kept:
            return JSONResponse(status_code=422, content={"urls": dropped})

        payload = {
            "nomination_id": nomination.nomination_id,
            "brief": nomination.brief,
            "nominated_by": nomination.nominated_by,
            "urls": kept,
        }
        try:
            # False (the name already exists) is a repeat: still 202, first content wins.
            await run_in_threadpool(queue.enqueue, nomination.nomination_id, payload)
        except EnqueueError as err:
            raise HTTPException(status_code=503, detail="enqueue failed; retry") from err
        return JSONResponse(
            status_code=202,
            content={"nomination_id": nomination.nomination_id, "dropped_urls": dropped},
        )

    require_caller = require_caller_dependency(settings.service_url, verify=verify_token)

    def require_queue(caller: CallerIdentity = Depends(require_caller)) -> CallerIdentity:  # noqa: B008
        # google_oidc_verifier checks signature/aud/iss only; with public
        # ingress, the identity check is ours.
        if caller.email != settings.task_service_account:
            raise HTTPException(status_code=403, detail="not the queue's service account")
        return caller

    @app.post(TASK_HANDLER_PATH)
    def handle_task(
        task: dict[str, Any] = Body(...),  # noqa: B008 - our own accept route wrote it
        caller: CallerIdentity = Depends(require_queue),  # noqa: B008
    ) -> dict[str, Any]:
        try:
            return handle_nomination(task, snowflake=snowflake, llm=llm, dispatch=dispatch)
        except Exception as err:
            # Non-2xx is the whole retry contract with Cloud Tasks.
            log.exception("nomination %s failed", task.get("nomination_id"))
            raise HTTPException(status_code=500, detail=f"task failed: {err}") from err

    return app
