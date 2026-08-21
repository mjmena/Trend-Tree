"""Routes only -- every dependency arrives as an argument so tests can call
create_app(...) with a fake Snowflake client and a fake IAP verifier, and
drive the service over httpx with no server, no network, and no warehouse."""

from __future__ import annotations

from fastapi import FastAPI
from tt_services_lib.auth import TokenVerifier, google_iap_verifier, require_caller_dependency
from tt_services_lib.snowflake_client import SnowflakeClient

from .config import ConfigError, Settings
from .routes.run import run_router


def create_app(
    settings: Settings,
    snowflake: SnowflakeClient,
    *,
    verify_token: TokenVerifier = google_iap_verifier,
) -> FastAPI:
    if verify_token is google_iap_verifier and not settings.audience.strip():
        # Fail at construction, not per request. An empty audience fails
        # closed (every call 401s), which is indistinguishable from a
        # correctly locked-down service when probed from outside -- exactly
        # the shape of breakage a deploy gate could otherwise wave through.
        raise ConfigError(
            "PREDICTION_SERVICE_AUDIENCE is empty but the real IAP verifier is in use; "
            "every request would 401. Set the audience, or inject a verifier (tests do)."
        )

    app = FastAPI(title="trend-tree-prediction", docs_url=None, redoc_url=None)

    # Unauthenticated at the *app* level on purpose: a liveness/readiness
    # probe target. This does not widen access -- Cloud Run's native IAP
    # integration (--iap --no-allow-unauthenticated, see deploy/deploy.sh)
    # protects the whole service at the edge, health included, so an
    # unauthenticated request never reaches the container regardless of what
    # this route itself requires.
    #
    # /health, not /healthz, is the canonical externally-probed path: Google's
    # edge intercepts the exact path `/healthz` on *.run.app hostnames and
    # answers its own generic 404 before the request reaches Cloud Run at all
    # (measured 2026-08-21; every other path tried routed through normally).
    # /healthz stays registered for in-cluster and local callers -- but do not
    # point the deploy gate back at it, that silently re-breaks the promote.
    def health() -> dict[str, bool]:
        return {"ok": True}

    app.get("/health")(health)
    app.get("/healthz")(health)

    require_caller = require_caller_dependency(settings.audience, verify=verify_token)
    app.include_router(run_router(settings, snowflake, require_caller))
    return app
