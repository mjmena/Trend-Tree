"""POST /nominations -- the accept route's contract statuses (CRMA-1667).

Each test fires the route and asserts on the status and on what reached the
(fake) queue."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Event

from fakes import FakeLLM, FakeTaskQueue, RoutingFakeSnowflake, fake_fetch
from fastapi.testclient import TestClient

from editorial_ingest.app import create_app
from editorial_ingest.config import settings_from_env

API_KEY = "test-key"
SERVICE_URL = "https://trend-tree-editorial-ingest-tu6gxkvema-uk.a.run.app"
HEADERS = {"X-Api-Key": API_KEY}


def _client(
    queue=None,
    statuses=None,
    *,
    snowflake=None,
    wait_seconds=0.1,
    fetch_url=None,
    poll_interval=0.01,
    readback_seconds=5,
):
    settings = settings_from_env(
        {
            "EDITORIAL_API_KEY": API_KEY,
            "EDITORIAL_SERVICE_URL": SERVICE_URL,
            "EDITORIAL_PREVIEW_API_KEY": "preview-key",
        }
    )
    app = create_app(
        settings,
        queue=queue if queue is not None else FakeTaskQueue(),
        snowflake=snowflake if snowflake is not None else RoutingFakeSnowflake(),
        llm=FakeLLM(),
        judge_llm=FakeLLM(),
        dispatch=lambda trend_id: None,
        fetch_url=fetch_url if fetch_url is not None else fake_fetch(statuses or {}),
        verify_token=lambda token, audience: {},
        wait_seconds=wait_seconds,
        poll_interval=poll_interval,
        readback_seconds=readback_seconds,
    )
    return TestClient(app)


def _body(**over):
    body = {
        "nomination_id": "nom-123",
        "brief": "Tinned fish boards are replacing charcuterie at house parties.",
        "urls": ["https://example.com/a", "https://example.com/b"],
        "nominated_by": "jane@example.com",
    }
    body.update(over)
    return body


def test_missing_or_wrong_key_is_401_and_enqueues_nothing():
    queue = FakeTaskQueue()
    client = _client(queue)
    assert client.post("/nominations", json=_body()).status_code == 401
    assert (
        client.post("/nominations", json=_body(), headers={"X-Api-Key": "nope"}).status_code == 401
    )
    # The key is checked before the body: a malformed body with no key is still 401.
    assert client.post("/nominations", content=b"{not json").status_code == 401
    assert queue.tasks == {}


def test_malformed_bodies_are_400_and_enqueue_nothing():
    queue = FakeTaskQueue()
    client = _client(queue)
    bad = [
        b"{not json",
        b"[]",
        json.dumps({k: v for k, v in _body().items() if k != "brief"}).encode(),
        json.dumps(_body(urls=[])).encode(),
        json.dumps(_body(urls=[f"https://example.com/{i}" for i in range(11)])).encode(),
        json.dumps(_body(nomination_id="has spaces")).encode(),
        json.dumps(_body(nomination_id="x" * 65)).encode(),
        json.dumps(_body(brief="   ")).encode(),
        json.dumps(_body(dry_run=True)).encode(),
        json.dumps(_body(brief="x" * 70_000)).encode(),  # over the 64 KB body cap
    ]
    for content in bad:
        resp = client.post("/nominations", content=content, headers=HEADERS)
        assert resp.status_code == 400, content[:80]
    assert queue.tasks == {}


def test_all_urls_dead_is_422_with_reasons_and_enqueues_nothing():
    queue = FakeTaskQueue()
    client = _client(queue, statuses={"https://example.com/a": 404})
    resp = client.post(
        "/nominations",
        json=_body(urls=["https://example.com/a", "not a url", "ftp://example.com/x"]),
        headers=HEADERS,
    )
    assert resp.status_code == 422
    assert resp.json() == {
        "urls": [
            {"url": "https://example.com/a", "reason": "dead_404"},
            {"url": "not a url", "reason": "malformed"},
            {"url": "ftp://example.com/x", "reason": "malformed"},
        ]
    }
    assert queue.tasks == {}


def test_valid_body_is_202_and_enqueues_one_task_named_by_nomination_id():
    queue = FakeTaskQueue()
    client = _client(
        queue,
        statuses={
            "https://example.com/dead": 410,
            "https://example.com/paywall": 403,
            "https://example.com/slow": TimeoutError("timed out"),
        },
    )
    resp = client.post(
        "/nominations",
        json=_body(
            urls=[
                "https://www.example.com/a?utm_source=x",
                "https://example.com/dead",
                "https://example.com/paywall",
                "https://example.com/slow",
            ]
        ),
        headers=HEADERS,
    )
    assert resp.status_code == 202
    assert resp.json() == {
        "nomination_id": "nom-123",
        "status": "pending",
        "trend_id": None,
        "dropped_urls": [{"url": "https://example.com/dead", "reason": "dead_410"}],
        "status_url": "/nominations/nom-123",
        "error": None,
    }
    assert resp.headers["Retry-After"] == "5"
    assert list(queue.tasks) == ["nom-123"]
    task = queue.tasks["nom-123"]
    assert task["brief"] == _body()["brief"]
    assert task["nominated_by"] == "jane@example.com"
    assert [(u["canonical"], u["unverified"]) for u in task["urls"]] == [
        ("https://example.com/a", False),
        ("https://example.com/paywall", True),
        ("https://example.com/slow", True),
    ]


def test_repeat_nomination_id_is_202_and_the_first_content_wins():
    queue = FakeTaskQueue()
    client = _client(queue)
    first = client.post("/nominations", json=_body(), headers=HEADERS)
    again = client.post("/nominations", json=_body(brief="something else"), headers=HEADERS)
    assert first.status_code == 202
    assert again.status_code == 202
    assert again.json()["nomination_id"] == "nom-123"
    assert list(queue.tasks) == ["nom-123"]
    assert queue.tasks["nom-123"]["brief"] == _body()["brief"]


def test_repeat_returns_original_dropped_urls_without_rechecking_replacement_urls():
    queue = FakeTaskQueue()
    client = _client(queue, statuses={"https://example.com/dead": 410})
    first = client.post(
        "/nominations",
        headers=HEADERS,
        json=_body(urls=["https://example.com/a", "https://example.com/dead"]),
    )
    again = client.post(
        "/nominations",
        headers=HEADERS,
        json=_body(brief="Replacement", urls=["https://example.com/dead"]),
    )
    assert again.status_code == 202
    assert again.json() == first.json()
    assert queue.tasks["nom-123"]["brief"] == _body()["brief"]


def test_enqueue_failure_is_503_and_enqueues_nothing():
    queue = FakeTaskQueue(fail=True)
    resp = _client(queue).post("/nominations", json=_body(), headers=HEADERS)
    assert resp.status_code == 503
    assert queue.tasks == {}


def test_submit_returns_the_committed_outcome_while_background_delivery_finishes():
    from test_task_handler import QUEUE_AUTH
    from test_task_handler import _client as worker_client

    enqueued = Event()

    class Queue(FakeTaskQueue):
        def enqueue(self, name, payload):
            result = super().enqueue(name, payload)
            enqueued.set()
            return result

    queue, snowflake = Queue(), RoutingFakeSnowflake()
    client = _client(queue, snowflake=snowflake, wait_seconds=1)
    with ThreadPoolExecutor(max_workers=1) as pool:
        response = pool.submit(client.post, "/nominations", json=_body(), headers=HEADERS)
        assert enqueued.wait(2)
        completed = worker_client(snowflake).post(
            "/tasks/nominations",
            json=queue.tasks["nom-123"],
            headers=QUEUE_AUTH,
        )
        assert completed.status_code == 200
        result = response.result(timeout=2)
    assert result.status_code == 200
    assert result.json()["status"] == "created"
    assert result.json()["trend_id"] == "trend-new-1"
    assert "Retry-After" not in result.headers


def test_wait_deadline_returns_last_receipt_without_waiting_for_a_slow_status_read():
    entered, release = Event(), Event()
    queue = FakeTaskQueue()

    class SlowStatusDatabase(RoutingFakeSnowflake):
        def query(self, sql, params=None):
            if "STG_EDITORIAL_NOMINATIONS" in sql and queue.tasks:
                entered.set()
                assert release.wait(2)
            return super().query(sql, params)

    client = _client(queue, snowflake=SlowStatusDatabase(), wait_seconds=0.1)
    with ThreadPoolExecutor(max_workers=1) as pool:
        response = pool.submit(client.post, "/nominations", json=_body(), headers=HEADERS)
        try:
            assert entered.wait(1)
            result = response.result(timeout=0.5)
            assert result.status_code == 202
            assert result.json()["status"] == "pending"
            assert result.json()["error"] is None
            assert result.json()["status_url"] == "/nominations/nom-123"
        finally:
            release.set()


def test_repeat_submit_reconciles_a_confirmed_missing_task():
    queue = FakeTaskQueue()
    client = _client(queue)
    client.post("/nominations", json=_body(), headers=HEADERS)
    queue.tasks.clear()
    response = client.post("/nominations", json=_body(), headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["status"] == "failed"
    assert response.json()["error"]["code"] == "processing_failed"


def test_one_minute_budget_includes_url_validation_and_queue_handoff(monkeypatch):
    import editorial_ingest.app as app_module

    now = [0.0]
    actual_sleep = app_module.asyncio.sleep

    async def sleep(seconds):
        now[0] += seconds
        await actual_sleep(0)

    def fetch(url):
        now[0] += 20
        return url, 200, None

    class Queue(FakeTaskQueue):
        def enqueue(self, name, payload):
            now[0] += 10
            return super().enqueue(name, payload)

    monkeypatch.setattr(app_module, "monotonic", lambda: now[0])
    monkeypatch.setattr(app_module.asyncio, "sleep", sleep)
    response = _client(
        Queue(),
        fetch_url=fetch,
        wait_seconds=60,
        poll_interval=10,
    ).post("/nominations", json=_body(urls=["https://example.com/a"]), headers=HEADERS)
    assert response.status_code == 202
    assert response.json()["status"] == "pending"
    assert now[0] == 60


def test_deadline_before_acceptance_returns_safe_unavailable_without_enqueueing():
    entered, release = Event(), Event()
    queue = FakeTaskQueue()

    def slow_fetch(url):
        entered.set()
        assert release.wait(2)
        return url, 200, None

    client = _client(queue, fetch_url=slow_fetch)
    with ThreadPoolExecutor(max_workers=1) as pool:
        response = pool.submit(client.post, "/nominations", json=_body(), headers=HEADERS)
        try:
            assert entered.wait(1)
            result = response.result(timeout=0.5)
            assert result.status_code == 503
            assert result.json() == {"detail": "nomination unavailable; retry"}
            assert queue.tasks == {}
        finally:
            release.set()


def test_retry_after_an_uncertain_enqueue_keeps_the_first_task_and_receipt():
    from editorial_ingest.tasks import EnqueueError

    class UncertainQueue(FakeTaskQueue):
        def enqueue(self, name, payload):
            created = super().enqueue(name, payload)
            if created:
                raise EnqueueError("private provider error after task creation")
            return False

    queue = UncertainQueue()
    client = _client(queue, statuses={"https://example.com/dead": 410})
    first = client.post(
        "/nominations",
        headers=HEADERS,
        json=_body(urls=["https://example.com/a", "https://example.com/dead"]),
    )
    assert first.status_code == 503
    assert "private provider" not in first.text
    again = client.post(
        "/nominations",
        headers=HEADERS,
        json=_body(brief="replacement", urls=["https://example.com/dead"]),
    )
    assert again.status_code == 202
    assert again.json()["dropped_urls"] == [
        {"url": "https://example.com/dead", "reason": "dead_410"}
    ]
    assert queue.tasks["nom-123"]["brief"] == _body()["brief"]


def test_health_answers():
    assert _client().get("/health").json() == {"ok": True}
