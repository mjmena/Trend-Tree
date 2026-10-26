"""Service configuration from env (EDITORIAL_ prefix).

``settings_from_env`` takes ``env`` as an argument so tests build settings
without touching os.environ (the prediction service's pattern).
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass

DEFAULT_PROJECT = "mcc-crm-automations"
DEFAULT_LOCATION = "us-east4"
DEFAULT_QUEUE = "trend-tree-editorial-ingest"
# The identity Cloud Tasks signs the handler's OIDC token as. The handler
# accepts no other email: with allUsers ingress there is no edge check.
DEFAULT_TASK_SERVICE_ACCOUNT = "crm-runtime@mcc-crm-automations.iam.gserviceaccount.com"
# The dispatcher workflow (dispatcher-p_8rCBgnl): sources -> enrichment -> write.
DEFAULT_DISPATCHER_URL = "https://eoqf5zok2vcvael.m.pipedream.net"


class ConfigError(RuntimeError):
    """Settings that cannot serve traffic. Raised at startup, never per request."""


@dataclass(frozen=True)
class SnowflakeSettings:
    """tt_services_lib.snowflake_client.SnowflakeSettings. Every statement is
    fully qualified, so database/schema are only the connection's defaults."""

    account: str
    user: str
    role: str
    warehouse: str
    database: str
    schema: str
    authenticator: str  # externalbrowser locally; keypair on Cloud Run
    private_key_path: str
    private_key: str  # PEM, from Secret Manager on Cloud Run


@dataclass(frozen=True)
class Settings:
    # The one shared key ATLAS prod sends as X-Api-Key (Secret Manager).
    api_key: str
    # The BASE service URL: the task handler's OIDC audience and the task's
    # target host. Cloud Run URLs in this project are deterministic.
    service_url: str
    project: str
    location: str
    queue: str
    task_service_account: str
    port: int
    snowflake: SnowflakeSettings
    gemini_api_key: str
    dispatcher_url: str

    def validate_for_server(self) -> None:
        if not self.api_key.strip():
            raise ConfigError("EDITORIAL_API_KEY is empty: every caller would be refused")
        if not self.service_url.startswith("https://"):
            raise ConfigError("EDITORIAL_SERVICE_URL must be the https:// base service URL")
        if not self.gemini_api_key.strip():
            raise ConfigError("EDITORIAL_GEMINI_API_KEY is empty: every task would fail")
        if not (self.snowflake.private_key or self.snowflake.private_key_path):
            raise ConfigError("no Snowflake key: set EDITORIAL_SNOWFLAKE_PRIVATE_KEY")


def settings_from_env(env: Mapping[str, str] | None = None) -> Settings:
    env = os.environ if env is None else env
    return Settings(
        api_key=env.get("EDITORIAL_API_KEY", ""),
        service_url=env.get("EDITORIAL_SERVICE_URL", "").rstrip("/"),
        project=env.get("EDITORIAL_TASKS_PROJECT", DEFAULT_PROJECT),
        location=env.get("EDITORIAL_TASKS_LOCATION", DEFAULT_LOCATION),
        queue=env.get("EDITORIAL_TASKS_QUEUE", DEFAULT_QUEUE),
        task_service_account=env.get(
            "EDITORIAL_TASKS_SERVICE_ACCOUNT", DEFAULT_TASK_SERVICE_ACCOUNT
        ),
        port=int(env.get("PORT", "8080")),
        snowflake=SnowflakeSettings(
            account=env.get("EDITORIAL_SNOWFLAKE_ACCOUNT", "WVB49304-MCCLATCHY_EVAL"),
            user=env.get("EDITORIAL_SNOWFLAKE_USER", "CRMBOT_SERVICE_USER"),
            role=env.get("EDITORIAL_SNOWFLAKE_ROLE", "MARKETING_ENGINEER"),
            warehouse=env.get("EDITORIAL_SNOWFLAKE_WAREHOUSE", "MARKETING_WH"),
            database=env.get("EDITORIAL_SNOWFLAKE_DATABASE", "MCC_RAW"),
            schema=env.get("EDITORIAL_SNOWFLAKE_SCHEMA", "MARKETING_DEV"),
            authenticator=env.get("EDITORIAL_SNOWFLAKE_AUTHENTICATOR", "externalbrowser"),
            private_key_path=env.get("EDITORIAL_SNOWFLAKE_PRIVATE_KEY_PATH", ""),
            private_key=env.get("EDITORIAL_SNOWFLAKE_PRIVATE_KEY", ""),
        ),
        gemini_api_key=env.get("EDITORIAL_GEMINI_API_KEY", ""),
        dispatcher_url=env.get("EDITORIAL_DISPATCHER_URL", DEFAULT_DISPATCHER_URL),
    )
