"""Production wiring: the real retrying Snowflake client, real Google OIDC
verification (both defaults on create_app / RetryingSnowflakeClient).

Run with `python -m prediction_service.server`, or point uvicorn at
`prediction_service.server:app`.
"""

from __future__ import annotations

import logging

import uvicorn
from tt_services_lib.snowflake_client import RetryingSnowflakeClient

from .app import create_app
from .config import settings_from_env

logging.basicConfig(level=logging.INFO)

settings = settings_from_env()
app = create_app(settings=settings, snowflake=RetryingSnowflakeClient(settings.snowflake))


def main() -> None:
    # timeout_graceful_shutdown lets an in-flight verdict write finish when
    # Cloud Run sends SIGTERM ahead of reclaiming a scaled-to-zero instance.
    uvicorn.run(
        app,
        host="0.0.0.0",  # noqa: S104 - Cloud Run routes to the container's port
        port=settings.port,
        timeout_graceful_shutdown=30,
    )


if __name__ == "__main__":
    main()
