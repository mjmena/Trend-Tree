"""Service configuration from env (PREDICTION_ prefix).

PREDICTION_SERVICE_AUTH_MODE picks the ingress-auth layer: ``oidc`` (Cloud Run
IAM -- the default, and how the service is actually deployed) or ``iap``.
PREDICTION_SERVICE_AUDIENCE has to match the mode; see Settings.audience.

``settings_from_env`` takes ``env`` as an argument rather than reading
os.environ directly, so tests can build settings without touching the
environment (matches prism's config.py).

On Cloud Run the private key arrives as PEM *content* in
PREDICTION_SNOWFLAKE_PRIVATE_KEY (bound from Secret Manager
``snowflake-private-key``, the same secret prism/helm/audience-builder use --
CRMBOT_SERVICE_USER's MARKETING_ENGINEER role already reaches both
MCC_RAW.MARKETING_DEV and MCC_PRESENTATION.TREND_AGENT per the existing
Pipedream connected-account queries in this repo's own workflows); locally you
either point PREDICTION_SNOWFLAKE_PRIVATE_KEY_PATH at a PEM file, or fall
through to externalbrowser SSO.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

from tt_services_lib.auth import (
    AUTH_MODE_IAP,
    AUTH_MODE_OIDC,
    AUTH_MODES,
    DEFAULT_AUTH_MODE,
)

from .generation.llm import DEFAULT_MODEL as DEFAULT_GEMINI_MODEL

# The prefix an audience must carry in each mode. The two shapes are not
# interchangeable: an OIDC token's `aud` is this service's URL, an IAP
# assertion's is the `/projects/{NUM}/locations/{REGION}/services/{SVC}`
# string. Pairing one mode with the other's audience produces a container
# that boots, answers the unauthenticated /health probe exactly like a
# healthy one, and 401s every real call -- see validate_for_server.
_AUDIENCE_PREFIXES: dict[str, str] = {
    AUTH_MODE_OIDC: "https://",
    AUTH_MODE_IAP: "/projects/",
}


class ConfigError(RuntimeError):
    """Settings that cannot serve traffic. Raised at startup, never per
    request -- a misconfigured deploy should refuse to come up, not serve
    401s or 500s that read as "locked down and healthy"."""


@dataclass(frozen=True)
class SnowflakeSettings:
    account: str
    user: str
    role: str
    warehouse: str
    # Qualifies every table reference -- see Settings.qualify(). Never rely on
    # the connection's default database/schema for a query.
    database: str
    schema: str
    # externalbrowser locally; keypair on Cloud Run
    authenticator: str
    private_key_path: str
    # PEM content -- how Cloud Run passes it (Secret Manager env), vs a path locally
    private_key: str


@dataclass(frozen=True)
class GeminiSettings:
    """The generation phase's LLM (CRMA-763). The fleet runs on Google
    Gemini; ``model`` defaults to what agents/lib/gemini_loop.mjs uses for
    the Pipedream agents, so a model bump is one env var, not a redeploy of
    code.

    ``api_key`` is deliberately NOT part of validate_for_server's refuse-to-
    boot set: without it the service still serves /health, /whoami (the
    deploy gate's probe) and /run, and only POST /generate fails -- as a 503
    that names the missing variable. A dead generation phase then surfaces
    the way the PRD asks for, as verdict-ledger staleness in the audit
    agent's view, rather than as a container that will not start.
    """

    api_key: str
    model: str
    timeout_s: float


@dataclass(frozen=True)
class Settings:
    snowflake: SnowflakeSettings
    gemini: GeminiSettings
    port: int
    # Which ingress-auth layer fronts this service -- `oidc` (Cloud Run IAM,
    # the deployed posture) or `iap`. See tt_services_lib.auth for what each
    # one changes; it also decides what `audience` below has to be.
    auth_mode: str
    # The value an incoming token's `aud` claim must match. Under `oidc` that
    # is this service's URL (https://{SERVICE}-{HASH}-{REGION}.a.run.app);
    # under `iap` it is the IAP audience string
    # `/projects/{PROJECT_NUMBER}/locations/{REGION}/services/{SERVICE_NAME}`.
    # Set at deploy time (see deploy/deploy.sh); empty locally, where tests
    # inject a fake verifier instead of checking a real audience.
    audience: str

    def expected_audience_shape(self) -> str:
        """What `audience` should look like in this mode -- for error
        messages, so a misconfigured deploy says what to set, not just that
        something is unset."""
        if self.auth_mode == AUTH_MODE_IAP:
            return "/projects/{PROJECT_NUMBER}/locations/{REGION}/services/{SERVICE}"
        return "this service's URL, e.g. https://{SERVICE}-{HASH}-{REGION}.a.run.app"

    def qualify(self, table: str) -> str:
        """``<database>.<schema>.<table>`` -- see the note on
        SnowflakeSettings.database."""
        return f"{self.snowflake.database}.{self.snowflake.schema}.{table}"

    def validate_for_server(self) -> None:
        """Refuse to boot a server on settings that only *look* like they
        work. Both checks below otherwise fail late and misleadingly:

        * an empty ``audience`` fails closed -- every request 401s -- so a
          service that never received PREDICTION_SERVICE_AUDIENCE looks
          identical from the edge to one that is correctly locked down. An
          unrecognized ``auth_mode`` is the same class of problem, and is
          refused here rather than at the first request.
        * an ``audience`` of the wrong *shape* for the mode fails exactly the
          same way, and is the more likely accident: a half-applied deploy or
          a hand-run ``gcloud run services update --update-env-vars`` can pair
          ``auth_mode=oidc`` with an IAP-shaped audience. Nothing downstream
          notices -- the container boots, the unauthenticated health probe is
          rejected at the edge as usual, the authenticated one returns 200 --
          and every real call 401s while the service looks correctly locked
          down from outside.
        * with no key material the Snowflake client falls through to
          ``externalbrowser``, which in a container blocks for ~120s waiting
          for a browser that will never open, and then errors -- per request.

        Called from server.py, not from ``settings_from_env``: tests and any
        non-server caller still build Settings freely.
        """
        problems: list[str] = []
        mode_known = self.auth_mode in AUTH_MODES
        if not mode_known:
            problems.append(
                f"PREDICTION_SERVICE_AUTH_MODE is {self.auth_mode!r}, not one of "
                f"{list(AUTH_MODES)}. Leave it unset for {DEFAULT_AUTH_MODE!r} (Cloud Run IAM)."
            )
        audience = self.audience.strip()
        if not audience:
            problems.append(
                "PREDICTION_SERVICE_AUDIENCE is empty -- every token would fail its audience "
                "check and every request would 401. Set it to "
                f"{self.expected_audience_shape()} (deploy/deploy.sh does this)."
            )
        elif mode_known and not audience.startswith(_AUDIENCE_PREFIXES[self.auth_mode]):
            # Shape only, not identity: whether the URL is *this* service's is
            # not knowable from inside the container. This catches the
            # mode/audience mismatch, which is the failure that hides.
            problems.append(
                f"PREDICTION_SERVICE_AUDIENCE is {self.audience!r}, which is not the shape "
                f"PREDICTION_SERVICE_AUTH_MODE={self.auth_mode!r} needs (expected it to start "
                f"with {_AUDIENCE_PREFIXES[self.auth_mode]!r} -- "
                f"{self.expected_audience_shape()}). Every request would 401 while the "
                "service looked locked down from outside."
            )
        if not (self.snowflake.private_key or self.snowflake.private_key_path):
            problems.append(
                "no Snowflake key material: neither PREDICTION_SNOWFLAKE_PRIVATE_KEY nor "
                f"PREDICTION_SNOWFLAKE_PRIVATE_KEY_PATH is set, so the client would fall back "
                f"to authenticator={self.snowflake.authenticator!r} -- interactive auth, which "
                "cannot succeed in a server process."
            )
        if problems:
            raise ConfigError("refusing to start: " + "; ".join(problems))


def _timeout(raw: str) -> float:
    try:
        return float(raw)
    except ValueError as err:
        raise ConfigError(
            f"PREDICTION_GEMINI_TIMEOUT_S is {raw!r}, which is not a number"
        ) from err


def _port(raw: str) -> int:
    """A non-numeric PORT is a config problem like any other, so it surfaces
    as ConfigError rather than a bare ValueError from int()."""
    try:
        return int(raw)
    except ValueError as err:
        raise ConfigError(f"PORT is {raw!r}, which is not an integer") from err


def settings_from_env(env: Mapping[str, str] | None = None) -> Settings:
    e = os.environ if env is None else env
    return Settings(
        snowflake=SnowflakeSettings(
            account=e.get("PREDICTION_SNOWFLAKE_ACCOUNT", "WVB49304-MCCLATCHY_EVAL"),
            user=e.get("PREDICTION_SNOWFLAKE_USER", "CRMBOT_SERVICE_USER"),
            role=e.get("PREDICTION_SNOWFLAKE_ROLE", "MARKETING_ENGINEER"),
            warehouse=e.get("PREDICTION_SNOWFLAKE_WAREHOUSE", "MARKETING_WH"),
            database=e.get("PREDICTION_SNOWFLAKE_DATABASE", "MCC_PRESENTATION"),
            schema=e.get("PREDICTION_SNOWFLAKE_SCHEMA", "TREND_AGENT"),
            authenticator=e.get("PREDICTION_SNOWFLAKE_AUTHENTICATOR", "externalbrowser"),
            private_key_path=e.get("PREDICTION_SNOWFLAKE_PRIVATE_KEY_PATH", ""),
            private_key=e.get("PREDICTION_SNOWFLAKE_PRIVATE_KEY", ""),
        ),
        gemini=GeminiSettings(
            api_key=e.get("PREDICTION_GEMINI_API_KEY", ""),
            model=e.get("PREDICTION_GEMINI_MODEL", DEFAULT_GEMINI_MODEL),
            timeout_s=_timeout(e.get("PREDICTION_GEMINI_TIMEOUT_S", "180")),
        ),
        port=_port(e.get("PORT", "8080")),
        # Unset or blank means the deployed posture (Cloud Run IAM). A value
        # that is set but unrecognized is kept verbatim so validate_for_server
        # can refuse it -- a typo must not silently fall back to a default.
        auth_mode=(e.get("PREDICTION_SERVICE_AUTH_MODE") or "").strip().lower()
        or DEFAULT_AUTH_MODE,
        audience=e.get("PREDICTION_SERVICE_AUDIENCE", ""),
    )
