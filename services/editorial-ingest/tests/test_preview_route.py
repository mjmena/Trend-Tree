"""Development preview exercises evaluation without production side effects."""

from __future__ import annotations

import json
from dataclasses import dataclass, field

import pytest
from fakes import FakeLLM, FakeTaskQueue, RoutingFakeSnowflake, fake_fetch
from fastapi.testclient import TestClient

from editorial_ingest.app import create_app
from editorial_ingest.config import ConfigError, settings_from_env

API_KEY = "production-key"
PREVIEW_KEY = "preview-only-key"
HEADERS = {"X-Api-Key": API_KEY}


@dataclass
class RecordingSnowflake(RoutingFakeSnowflake):
    writes: list[str] = field(default_factory=list)

    def query(self, sql, params=None):
        if not sql.lstrip().upper().startswith(("SELECT ", "WITH ")):
            self.writes.append(sql)
        return super().query(sql, params)

    def execute(self, sql, params=None):
        self.writes.append(sql)
        return super().execute(sql, params)


@dataclass
class RecordingTaskQueue(FakeTaskQueue):
    enqueues: list[str] = field(default_factory=list)

    def enqueue(self, name, payload):
        self.enqueues.append(name)
        return super().enqueue(name, payload)


def _client(*, snowflake=None, llm=None, judge_llm=None, statuses=None, env=None, fetch_url=None):
    queue = RecordingTaskQueue()
    snowflake = snowflake if snowflake is not None else RecordingSnowflake()
    dispatched = []
    settings = settings_from_env(
        {
            "EDITORIAL_API_KEY": API_KEY,
            "EDITORIAL_PREVIEW_API_KEY": PREVIEW_KEY,
            "EDITORIAL_SERVICE_URL": "https://editorial.example.com",
            **(env or {}),
        }
    )
    app = create_app(
        settings,
        queue=queue,
        snowflake=snowflake,
        llm=llm if llm is not None else FakeLLM(),
        judge_llm=judge_llm if judge_llm is not None else FakeLLM(),
        dispatch=dispatched.append,
        fetch_url=fetch_url if fetch_url is not None else fake_fetch(statuses or {}),
        verify_token=lambda token, audience: {},
    )
    return TestClient(app), snowflake, queue, dispatched


def _body(**overrides):
    return {
        "nomination_id": "preview-123",
        "brief": "Tinned fish boards are replacing charcuterie at house parties.",
        "urls": ["https://example.com/a", "https://example.com/dead"],
        "nominated_by": "jane@example.com",
        **overrides,
    }


def _assert_no_production_effects(snowflake, queue, dispatched):
    assert (snowflake.writes, queue.enqueues, dispatched) == ([], [], [])


def test_new_topic_preview_is_provisional_with_no_new_id_or_production_effects():
    client, snowflake, queue, dispatched = _client(statuses={"https://example.com/dead": 410})

    response = client.post("/nominations/preview", json=_body(), headers=HEADERS)

    assert response.status_code == 200
    assert response.json() == {
        "nomination_id": "preview-123",
        "provisional": True,
        "status": "would_create",
        "trend_id": None,
        "dropped_urls": [{"url": "https://example.com/dead", "reason": "dead_410"}],
    }
    _assert_no_production_effects(snowflake, queue, dispatched)


@pytest.mark.parametrize(
    ("lifecycle_status", "expected_status"),
    [("STABLE", "would_merge"), ("RETIRED", "would_revive")],
)
def test_matching_preview_returns_the_existing_target_without_merging_or_reviving(
    lifecycle_status, expected_status
):
    snowflake = RecordingSnowflake(
        neighbors=[
            {
                "TREND_ID": "other-trend",
                "TREND_TOPIC": "Cheese boards",
                "SIMILARITY": 0.95,
                "LIFECYCLE_STATUS": "RETIRED" if lifecycle_status == "STABLE" else "STABLE",
            },
            {
                "TREND_ID": "existing-trend-42",
                "TREND_TOPIC": "Tinned fish party boards",
                "SIMILARITY": 0.91,
                "LIFECYCLE_STATUS": lifecycle_status,
            }
        ]
    )
    judge = FakeLLM(reply='{"match":"existing-trend-42","rationale":"same behavior"}')
    client, snowflake, queue, dispatched = _client(snowflake=snowflake, judge_llm=judge)

    response = client.post("/nominations/preview", json=_body(), headers=HEADERS)

    assert response.status_code == 200
    assert response.json() == {
        "nomination_id": "preview-123",
        "provisional": True,
        "status": expected_status,
        "trend_id": "existing-trend-42",
        "dropped_urls": [],
    }
    _assert_no_production_effects(snowflake, queue, dispatched)


def test_a_distinct_topic_with_neighbors_has_no_preview_target_or_production_effects():
    snowflake = RecordingSnowflake(
        neighbors=[
            {"TREND_ID": "existing-trend-42", "TREND_TOPIC": "Cheese boards", "SIMILARITY": 0.7}
        ]
    )
    judge = FakeLLM(reply='{"match":null,"rationale":"different behavior"}')
    client, snowflake, queue, dispatched = _client(snowflake=snowflake, judge_llm=judge)

    response = client.post("/nominations/preview", json=_body(), headers=HEADERS)

    assert response.status_code == 200
    assert response.json()["status"] == "would_create"
    assert response.json()["trend_id"] is None
    _assert_no_production_effects(snowflake, queue, dispatched)


def test_preview_key_can_preview_but_cannot_submit_production_work():
    client, snowflake, queue, dispatched = _client()
    headers = {"X-Api-Key": PREVIEW_KEY}

    response = client.post("/nominations/preview", json=_body(), headers=headers)

    assert response.status_code == 200
    assert response.json()["status"] == "would_create"
    assert client.post("/nominations", json=_body(), headers=headers).status_code == 401
    assert client.post("/tasks/nominations", json=_body(), headers=headers).status_code == 401
    _assert_no_production_effects(snowflake, queue, dispatched)


@pytest.mark.parametrize("preview_key", ["", "   ", API_KEY])
def test_service_refuses_empty_or_shared_preview_credentials(preview_key):
    with pytest.raises(ConfigError):
        _client(env={"EDITORIAL_PREVIEW_API_KEY": preview_key})


@pytest.mark.parametrize("production_key", ["", "   "])
def test_service_refuses_empty_production_credentials_even_with_a_preview_key(production_key):
    with pytest.raises(ConfigError):
        _client(env={"EDITORIAL_API_KEY": production_key})


@pytest.mark.parametrize(
    "llm",
    [FakeLLM(fail_with=RuntimeError("provider secret detail")), FakeLLM(reply="private bad reply")],
)
def test_topic_failures_are_safe_and_never_create_production_work(llm):
    client, snowflake, queue, dispatched = _client(llm=llm)

    response = client.post("/nominations/preview", json=_body(), headers=HEADERS)

    assert response.status_code == 503
    assert response.json() == {"detail": "preview unavailable; retry"}
    _assert_no_production_effects(snowflake, queue, dispatched)


@pytest.mark.parametrize(
    "judge",
    [
        FakeLLM(fail_with=RuntimeError("provider secret detail")),
        FakeLLM(reply="private bad reply"),
        FakeLLM(reply='{"match":"invented-target","rationale":"private rationale"}'),
    ],
)
def test_sameness_failures_never_fall_back_to_creation_or_leak_private_details(judge):
    snowflake = RecordingSnowflake(
        neighbors=[
            {"TREND_ID": "existing-trend-42", "TREND_TOPIC": "Party boards", "SIMILARITY": 0.91}
        ]
    )
    client, snowflake, queue, dispatched = _client(snowflake=snowflake, judge_llm=judge)

    response = client.post("/nominations/preview", json=_body(), headers=HEADERS)

    assert response.status_code == 503
    assert response.json() == {"detail": "preview unavailable; retry"}
    _assert_no_production_effects(snowflake, queue, dispatched)


@pytest.mark.parametrize("headers", [{}, {"X-Api-Key": ""}, {"X-Api-Key": "wrong-key"}])
def test_preview_authenticates_before_parsing_input_or_calling_providers(headers):
    llm = FakeLLM()
    client, snowflake, queue, dispatched = _client(llm=llm)

    response = client.post("/nominations/preview", content=b"not json", headers=headers)

    assert response.status_code == 401
    assert (snowflake.calls, llm.calls) == ([], [])
    _assert_no_production_effects(snowflake, queue, dispatched)


def test_preview_body_validation_preserves_the_four_field_contract():
    llm = FakeLLM()
    client, snowflake, queue, dispatched = _client(llm=llm)
    malformed = [
        b"{private invalid body",
        b"[]",
        json.dumps({k: v for k, v in _body().items() if k != "brief"}).encode(),
        json.dumps(_body(brief=" ")).encode(),
        json.dumps(_body(nomination_id="has spaces")).encode(),
        json.dumps(_body(urls=[])).encode(),
        json.dumps(_body(urls=["https://example.com/a"] * 11)).encode(),
        json.dumps(_body(dry_run=True)).encode(),
        json.dumps(_body(brief="x" * 70_000)).encode(),
    ]

    for content in malformed:
        response = client.post("/nominations/preview", content=content, headers=HEADERS)
        assert response.status_code == 400
        assert response.json()["detail"] in {"malformed body", "body over 64 KB"}
    assert (snowflake.calls, llm.calls) == ([], [])
    _assert_no_production_effects(snowflake, queue, dispatched)


def test_preview_rejects_all_dead_urls_without_evaluating_or_writing():
    llm = FakeLLM()
    client, snowflake, queue, dispatched = _client(
        llm=llm, statuses={"https://example.com/dead": 404}
    )

    response = client.post(
        "/nominations/preview",
        json=_body(urls=["https://example.com/dead", "not a url"]),
        headers=HEADERS,
    )

    assert response.status_code == 422
    assert response.json() == {
        "urls": [
            {"url": "https://example.com/dead", "reason": "dead_404"},
            {"url": "not a url", "reason": "malformed"},
        ]
    }
    assert (snowflake.calls, llm.calls) == ([], [])
    _assert_no_production_effects(snowflake, queue, dispatched)


def test_preview_keeps_urls_with_network_failures_without_exposing_error_details():
    client, snowflake, queue, dispatched = _client(
        statuses={"https://example.com/a": TimeoutError("private proxy secret")}
    )

    response = client.post(
        "/nominations/preview", json=_body(urls=["https://example.com/a"]), headers=HEADERS
    )

    assert response.status_code == 200
    assert response.json()["dropped_urls"] == []
    assert "private" not in response.text
    _assert_no_production_effects(snowflake, queue, dispatched)


def test_preview_handles_an_invalid_url_provider_response_with_a_safe_error():
    client, snowflake, queue, dispatched = _client(
        fetch_url=lambda url: (url, "private invalid provider response", None)
    )

    response = client.post("/nominations/preview", json=_body(), headers=HEADERS)

    assert response.status_code == 503
    assert response.json() == {"detail": "preview unavailable; retry"}
    _assert_no_production_effects(snowflake, queue, dispatched)
