"""Routes only -- every dependency arrives as an argument so tests can call
create_app(...) with a fake Snowflake client and a fake IAP verifier, and
drive the service over httpx with no server, no network, and no warehouse."""

from __future__ import annotations

from fastapi import FastAPI
from tt_services_lib.auth import TokenVerifier, google_iap_verifier, require_caller_dependency
from tt_services_lib.snowflake_client import SnowflakeClient

from .config import Settings
from .routes.run import run_router


def create_app(
    settings: Settings,
    snowflake: SnowflakeClient,
    *,
    verify_token: TokenVerifier = google_iap_verifier,
) -> FastAPI:
    app = FastAPI(title="trend-tree-prediction", docs_url=None, redoc_url=None)

    # Unauthenticated at the *app* level on purpose: a liveness/readiness
    # probe target. This does not widen access -- Cloud Run's native IAP
    # integration (--iap --no-allow-unauthenticated, see deploy/deploy.sh)
    # protects the whole service at the edge, healthz included, so an
    # unauthenticated request never reaches the container regardless of what
    # this route itself requires.
    @app.get("/healthz")
    def healthz() -> dict[str, bool]:
        return {"ok": True}

    require_caller = require_caller_dependency(settings.audience, verify=verify_token)
    app.include_router(run_router(settings, snowflake, require_caller))
    return app
