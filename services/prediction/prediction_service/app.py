"""Routes only -- every dependency arrives as an argument so tests can call
create_app(...) with a fake Snowflake client and a fake token verifier, and
drive the service over httpx with no server, no network, and no warehouse."""

from __future__ import annotations

from fastapi import Depends, FastAPI
from tt_services_lib.auth import CallerIdentity, TokenVerifier, require_caller_dependency
from tt_services_lib.snowflake_client import SnowflakeClient

from .config import ConfigError, Settings
from .routes.run import run_router


def create_app(
    settings: Settings,
    snowflake: SnowflakeClient,
    *,
    verify_token: TokenVerifier | None = None,
) -> FastAPI:
    # None means "the real verifier for settings.auth_mode" -- so only an
    # injected (test) verifier is exempt from the audience check below.
    if verify_token is None and not settings.audience.strip():
        # Fail at construction, not per request. An empty audience fails
        # closed (every call 401s), which is indistinguishable from a
        # correctly locked-down service when probed from outside -- exactly
        # the shape of breakage a deploy gate could otherwise wave through.
        raise ConfigError(
            "PREDICTION_SERVICE_AUDIENCE is empty but a real token verifier is in use; "
            "every request would 401. Set the audience, or inject a verifier (tests do)."
        )

    app = FastAPI(title="trend-tree-prediction", docs_url=None, redoc_url=None)

    # Unauthenticated at the *app* level on purpose: a liveness/readiness
    # probe target. This does not widen access -- the service is deployed
    # --no-allow-unauthenticated (see deploy/deploy.sh), so Cloud Run IAM
    # rejects a caller without roles/run.invoker at the edge, health included,
    # and an unauthenticated request never reaches the container regardless of
    # what this route itself requires. Same holds under the IAP mode.
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

    # The mode switch. Cloud Run IAM (`oidc`) is how this service is deployed
    # today; `iap` is retained as the alternative in case IAP is reinstated.
    # An unknown mode is a config problem, so it surfaces as ConfigError at
    # construction -- the same class of failure as an empty audience.
    try:
        require_caller = require_caller_dependency(
            settings.audience, mode=settings.auth_mode, verify=verify_token
        )
    except ValueError as err:
        raise ConfigError(str(err)) from err
    # The authenticated no-op. /health is unauthenticated by design, so it
    # proves only that the edge passed a token and the process is up -- it
    # never runs verify_oidc_token / verify_iap_assertion. A revision whose
    # audience has the wrong SHAPE for its auth mode (a partly-applied
    # deploy, or a manual `gcloud run services update --update-env-vars`)
    # therefore answers /health with 200 while 401-ing every real call.
    #
    # This route exists so the deploy gate can exercise the container's own
    # auth code without side effects: /run appends a real verdict-ledger row,
    # and a promote gate must not write rows on every deploy. It returns only
    # what the caller already proved about itself -- no secrets, and nothing
    # a caller who cleared require_caller does not already know.
    def whoami(
        caller: CallerIdentity = Depends(require_caller),  # noqa: B008 - FastAPI's own DI pattern
    ) -> dict[str, str]:
        return {
            "caller": caller.email,
            "audience": caller.audience,
            "auth_mode": settings.auth_mode,
        }

    app.get("/whoami")(whoami)

    app.include_router(run_router(settings, snowflake, require_caller))
    return app
