"""POST /tasks/nominations -- accepts only the queue's OIDC token (CRMA-1667).

In this ticket the handler does no work; CRMA-1668 adds it."""

from __future__ import annotations

from fakes import FakeTaskQueue, fake_fetch
from fastapi.testclient import TestClient

from editorial_ingest.app import create_app
from editorial_ingest.config import settings_from_env

SERVICE_URL = "https://trend-tree-editorial-ingest-tu6gxkvema-uk.a.run.app"
QUEUE_SA = "crm-runtime@mcc-crm-automations.iam.gserviceaccount.com"
TASK = {"nomination_id": "nom-123", "brief": "b", "nominated_by": "n", "urls": []}


def _verify(token: str, audience: str) -> dict:
    if audience != SERVICE_URL:
        raise ValueError("wrong audience")
    emails = {"queue-token": QUEUE_SA, "other-token": "someone@example.com"}
    if token not in emails:
        raise ValueError("bad signature")
    return {"iss": "https://accounts.google.com", "aud": audience, "email": emails[token]}


def _client():
    settings = settings_from_env({"EDITORIAL_API_KEY": "k", "EDITORIAL_SERVICE_URL": SERVICE_URL})
    app = create_app(
        settings, queue=FakeTaskQueue(), fetch_url=fake_fetch({}), verify_token=_verify
    )
    return TestClient(app)


def test_handler_rejects_a_request_without_the_queues_oidc_token():
    client = _client()
    assert client.post("/tasks/nominations", json=TASK).status_code == 401
    bad = {"Authorization": "Bearer forged"}
    assert client.post("/tasks/nominations", json=TASK, headers=bad).status_code == 401
    # A valid Google token from any other identity is not the queue.
    other = {"Authorization": "Bearer other-token"}
    assert client.post("/tasks/nominations", json=TASK, headers=other).status_code == 403
    # The accept route's API key does not open the handler.
    assert (
        client.post("/tasks/nominations", json=TASK, headers={"X-Api-Key": "k"}).status_code == 401
    )


def test_handler_accepts_the_queues_token():
    resp = _client().post(
        "/tasks/nominations", json=TASK, headers={"Authorization": "Bearer queue-token"}
    )
    assert 200 <= resp.status_code < 300
