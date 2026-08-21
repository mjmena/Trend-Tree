"""Service configuration from env (PREDICTION_ prefix).

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
    # This service's IAP audience string -- the value IAP's JWT assertion's
    # `aud` claim must match: `/projects/{PROJECT_NUMBER}/locations/{REGION}
    # /services/{SERVICE_NAME}` for Cloud Run's native IAP integration (see
    # tt_services_lib.auth). Static and known before any deploy -- unlike a
    # service URL, it needs no bootstrap dance. Set at deploy time (see
    # deploy/deploy.sh); empty locally, where tests inject a fake verifier
    # instead of checking a real audience.
    audience: str

    def qualify(self, table: str) -> str:
        """``<database>.<schema>.<table>`` -- see the note on
        SnowflakeSettings.database."""
        return f"{self.snowflake.database}.{self.snowflake.schema}.{table}"

    def validate_for_server(self) -> None:
        """Refuse to boot a server on settings that only *look* like they
        work. Both checks below otherwise fail late and misleadingly:

        * an empty ``audience`` fails closed -- every request 401s -- so a
          service that never received PREDICTION_SERVICE_AUDIENCE looks
          identical from the edge to one that is correctly locked down.
        * with no key material the Snowflake client falls through to
          ``externalbrowser``, which in a container blocks for ~120s waiting
          for a browser that will never open, and then errors -- per request.

        Called from server.py, not from ``settings_from_env``: tests and any
        non-server caller still build Settings freely.
        """
        problems: list[str] = []
        if not self.audience.strip():
            problems.append(
                "PREDICTION_SERVICE_AUDIENCE is empty -- every IAP assertion would fail its "
                "audience check and every request would 401. Set it to "
                "/projects/{PROJECT_NUMBER}/locations/{REGION}/services/{SERVICE} "
                "(deploy/deploy.sh does this)."
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
        audience=e.get("PREDICTION_SERVICE_AUDIENCE", ""),
    )
