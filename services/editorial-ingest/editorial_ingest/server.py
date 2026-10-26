"""Production wiring. Run with `python -m editorial_ingest.server`."""

from __future__ import annotations

import logging

import uvicorn

from .app import TASK_HANDLER_PATH, create_app
from .config import settings_from_env
from .tasks import CloudTasksQueue

logging.basicConfig(level=logging.INFO)

settings = settings_from_env()
settings.validate_for_server()
app = create_app(
    settings,
    queue=CloudTasksQueue(
        project=settings.project,
        location=settings.location,
        queue=settings.queue,
        target_url=settings.service_url + TASK_HANDLER_PATH,
        audience=settings.service_url,
        service_account=settings.task_service_account,
    ),
)


def main() -> None:
    uvicorn.run(app, host="0.0.0.0", port=settings.port, timeout_graceful_shutdown=30)  # noqa: S104


if __name__ == "__main__":
    main()
