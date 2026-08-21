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
