"""The task queue seam. The accept route enqueues one Cloud Tasks task per
nomination, named by ``nomination_id``; tests substitute a fake.

The real client is Cloud Tasks' REST API through google-auth (no
google-cloud-tasks dependency). It runs as the service's own identity,
crm-runtime@, which holds roles/cloudtasks.enqueuer and actAs on itself (needed
to sign the task's OIDC token).
"""

from __future__ import annotations

import base64
import json
from typing import Any, Protocol

TASKS_API = "https://cloudtasks.googleapis.com/v2"


class EnqueueError(Exception):
    """The task could not be created. The accept route answers 503."""


class TaskQueue(Protocol):
    def enqueue(self, name: str, payload: dict[str, Any]) -> bool:
        """Create the task. True if created, False if a task with this name
        already exists (the first content wins). Raises EnqueueError otherwise."""
        ...


class CloudTasksQueue:
    def __init__(
        self,
        *,
        project: str,
        location: str,
        queue: str,
        target_url: str,
        audience: str,
        service_account: str,
        dispatch_deadline_s: int = 900,
        session: Any = None,
    ) -> None:
        self._parent = f"projects/{project}/locations/{location}/queues/{queue}"
        self._target_url = target_url
        self._audience = audience
        self._service_account = service_account
        self._deadline = f"{dispatch_deadline_s}s"
        self._session = session

    def _authed(self) -> Any:
        if self._session is None:
            import google.auth
            from google.auth.transport.requests import AuthorizedSession

            creds, _ = google.auth.default(
                scopes=["https://www.googleapis.com/auth/cloud-platform"]
            )
            self._session = AuthorizedSession(creds)
        return self._session

    def enqueue(self, name: str, payload: dict[str, Any]) -> bool:
        task = {
            "name": f"{self._parent}/tasks/{name}",
            "dispatchDeadline": self._deadline,
            "httpRequest": {
                "httpMethod": "POST",
                "url": self._target_url,
                "headers": {"Content-Type": "application/json"},
                "body": base64.b64encode(json.dumps(payload).encode()).decode(),
                # Explicit: the default audience is the full task URL, which a
                # verifier checking the base service URL would reject.
                "oidcToken": {
                    "serviceAccountEmail": self._service_account,
                    "audience": self._audience,
                },
            },
        }
        try:
            resp = self._authed().post(
                f"{TASKS_API}/{self._parent}/tasks", json={"task": task}, timeout=30
            )
        except Exception as err:  # noqa: BLE001 - any transport failure is a 503
            raise EnqueueError(f"Cloud Tasks unreachable: {err}") from err
        if resp.status_code == 409:  # ALREADY_EXISTS: a repeat of this nomination_id
            return False
        if resp.status_code >= 300:
            raise EnqueueError(f"Cloud Tasks answered {resp.status_code}: {resp.text[:300]}")
        return True
