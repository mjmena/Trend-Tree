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


class ConfigError(RuntimeError):
    """Settings that cannot serve traffic. Raised at startup, never per request."""


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

    def validate_for_server(self) -> None:
        if not self.api_key.strip():
            raise ConfigError("EDITORIAL_API_KEY is empty: every caller would be refused")
        if not self.service_url.startswith("https://"):
            raise ConfigError("EDITORIAL_SERVICE_URL must be the https:// base service URL")


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
    )
