from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest
from fakes import FakeTaskQueue, RoutingFakeSnowflake
from test_accept_route import HEADERS, _body, _client

from editorial_ingest.outcomes import SnowflakeNominationStore


def test_readback_returns_the_same_public_snapshot_without_evaluation_wait():
    client = _client()
    accepted = client.post("/nominations", json=_body(), headers=HEADERS)
    response = client.get(accepted.json()["status_url"], headers=HEADERS)
    assert response.status_code == 200
    assert response.json() == accepted.json()
    assert response.headers["Retry-After"] == "5"


def test_confirmed_missing_task_ends_in_a_safe_failure_after_processing_stops():
    queue = FakeTaskQueue()
    client = _client(queue)
    accepted = client.post("/nominations", json=_body(), headers=HEADERS)
    queue.tasks.clear()
    response = client.get(accepted.json()["status_url"], headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["status"] == "failed"
    assert response.json()["trend_id"] is None
    assert response.json()["error"] == {
        "code": "processing_failed",
        "message": "Nomination processing did not finish. Contact support with the nomination ID.",
    }


def test_polling_repairs_an_unconfirmed_handoff_using_the_original_accepted_request():
    queue = FakeTaskQueue(fail=True)
    client = _client(queue, statuses={"https://example.com/dead": 410})
    failed_response = client.post(
        "/nominations",
        headers=HEADERS,
        json=_body(urls=["https://example.com/a", "https://example.com/dead"]),
    )
    assert failed_response.status_code == 503
    queue.fail = False
    readback = client.get("/nominations/nom-123", headers=HEADERS)
    assert readback.status_code == 200
    assert readback.json()["status"] == "pending"
    assert readback.json()["dropped_urls"] == [
        {"url": "https://example.com/dead", "reason": "dead_410"}
    ]
    assert queue.tasks["nom-123"]["brief"] == _body()["brief"]
    assert [url["canonical"] for url in queue.tasks["nom-123"]["urls"]] == ["https://example.com/a"]


def test_missing_task_does_not_fail_a_live_worker_but_reconciles_after_its_lease_expires():
    queue, snowflake = FakeTaskQueue(), RoutingFakeSnowflake()
    client = _client(queue, snowflake=snowflake)
    client.post("/nominations", json=_body(), headers=HEADERS)
    store = SnowflakeNominationStore(snowflake)
    store.claim("nom-123", "live-worker")
    queue.tasks.clear()
    live = client.get("/nominations/nom-123", headers=HEADERS)
    assert live.json()["status"] == "pending"
    assert store.get("nom-123").owner == "live-worker"

    snowflake.database.advance(961)
    stopped = client.get("/nominations/nom-123", headers=HEADERS)
    assert stopped.json()["status"] == "failed"
    assert store.get("nom-123").owner is None


def test_queue_lookup_outage_keeps_the_last_pending_snapshot():
    queue = FakeTaskQueue()
    client = _client(queue)
    accepted = client.post("/nominations", json=_body(), headers=HEADERS)
    queue.tasks.clear()
    queue.fail = True
    response = client.get("/nominations/nom-123", headers=HEADERS)
    assert response.status_code == 200
    assert response.json() == accepted.json()
    repeated = client.post("/nominations", json=_body(), headers=HEADERS)
    assert repeated.status_code == 202
    assert repeated.json() == accepted.json()


@pytest.mark.parametrize("key", [None, "wrong-key", "preview-key"])
def test_private_history_requires_the_production_key_for_known_and_unknown_ids(key):
    client = _client()
    client.post("/nominations", json=_body(), headers=HEADERS)
    headers = {"X-Api-Key": key} if key else {}
    for nomination_id in ["nom-123", "unknown"]:
        assert client.get(f"/nominations/{nomination_id}", headers=headers).status_code == 401
    assert client.get("/nominations/unknown", headers=HEADERS).status_code == 404
    assert client.post("/nominations", json=_body(), headers=headers).status_code == 401


def test_readback_returns_known_pending_receipt_when_the_queue_lookup_takes_too_long():
    entered, release = Event(), Event()

    class Queue(FakeTaskQueue):
        slow = False

        def lookup(self, name):
            if self.slow:
                entered.set()
                assert release.wait(2)
            return super().lookup(name)

    queue = Queue()
    client = _client(queue, readback_seconds=0.1)
    accepted = client.post("/nominations", json=_body(), headers=HEADERS)
    queue.slow = True
    with ThreadPoolExecutor(max_workers=1) as pool:
        response = pool.submit(client.get, "/nominations/nom-123", headers=HEADERS)
        try:
            assert entered.wait(1)
            result = response.result(timeout=0.5)
            assert result.status_code == 200
            assert result.json() == accepted.json()
        finally:
            release.set()


def test_unavailable_receipt_storage_does_not_leak_private_provider_errors():
    class UnavailableDatabase(RoutingFakeSnowflake):
        def query(self, sql, params=None):
            raise RuntimeError("private warehouse connection details")

    client = _client(snowflake=UnavailableDatabase())
    readback = client.get("/nominations/nom-123", headers=HEADERS)
    submit = client.post("/nominations", json=_body(), headers=HEADERS)
    assert readback.status_code == submit.status_code == 503
    assert readback.json() == submit.json() == {"detail": "nomination unavailable; retry"}
