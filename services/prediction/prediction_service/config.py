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

from tt_services_lib.auth import AUTH_MODE_IAP, AUTH_MODES, DEFAULT_AUTH_MODE


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
class Settings:
    snowflake: SnowflakeSettings
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
        * with no key material the Snowflake client falls through to
          ``externalbrowser``, which in a container blocks for ~120s waiting
          for a browser that will never open, and then errors -- per request.

        Called from server.py, not from ``settings_from_env``: tests and any
        non-server caller still build Settings freely.
        """
        problems: list[str] = []
        if self.auth_mode not in AUTH_MODES:
            problems.append(
                f"PREDICTION_SERVICE_AUTH_MODE is {self.auth_mode!r}, not one of "
                f"{list(AUTH_MODES)}. Leave it unset for {DEFAULT_AUTH_MODE!r} (Cloud Run IAM)."
            )
        if not self.audience.strip():
            problems.append(
                "PREDICTION_SERVICE_AUDIENCE is empty -- every token would fail its audience "
                "check and every request would 401. Set it to "
                f"{self.expected_audience_shape()} (deploy/deploy.sh does this)."
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
        port=int(e.get("PORT", "8080")),
        # Unset or blank means the deployed posture (Cloud Run IAM). A value
        # that is set but unrecognized is kept verbatim so validate_for_server
        # can refuse it -- a typo must not silently fall back to a default.
        auth_mode=(e.get("PREDICTION_SERVICE_AUTH_MODE") or "").strip().lower()
        or DEFAULT_AUTH_MODE,
        audience=e.get("PREDICTION_SERVICE_AUDIENCE", ""),
    )
