"""POST /nominations -- the accept route's contract statuses (CRMA-1667).

Each test fires the route and asserts on the status and on what reached the
(fake) queue."""

from __future__ import annotations

import json

from fakes import FakeLLM, FakeTaskQueue, RoutingFakeSnowflake, fake_fetch
from fastapi.testclient import TestClient

from editorial_ingest.app import create_app
from editorial_ingest.config import settings_from_env

API_KEY = "test-key"
SERVICE_URL = "https://trend-tree-editorial-ingest-tu6gxkvema-uk.a.run.app"
HEADERS = {"X-Api-Key": API_KEY}


def _client(queue=None, statuses=None):
    settings = settings_from_env(
        {"EDITORIAL_API_KEY": API_KEY, "EDITORIAL_SERVICE_URL": SERVICE_URL}
    )
    app = create_app(
        settings,
        queue=queue if queue is not None else FakeTaskQueue(),
        snowflake=RoutingFakeSnowflake(),
        llm=FakeLLM(),
        judge_llm=FakeLLM(),
        dispatch=lambda trend_id: None,
        fetch_url=fake_fetch(statuses or {}),
        verify_token=lambda token, audience: {},
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
        "dropped_urls": [{"url": "https://example.com/dead", "reason": "dead_410"}],
    }
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


def test_enqueue_failure_is_503_and_enqueues_nothing():
    queue = FakeTaskQueue(fail=True)
    resp = _client(queue).post("/nominations", json=_body(), headers=HEADERS)
    assert resp.status_code == 503
    assert queue.tasks == {}


def test_health_answers():
    assert _client().get("/health").json() == {"ok": True}
