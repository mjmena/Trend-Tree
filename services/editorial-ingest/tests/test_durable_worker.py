from __future__ import annotations

from fakes import RoutingFakeSnowflake
from test_task_handler import QUEUE_AUTH, TASK, _client

from editorial_ingest.outcomes import SnowflakeNominationStore


def test_completed_task_replay_needs_only_a_receipt_read():
    snowflake = RoutingFakeSnowflake()
    first = _client(snowflake).post("/tasks/nominations", json=TASK, headers=QUEUE_AUTH)
    assert first.status_code == 200

    class ReadOnlyDatabase:
        def query(self, sql, params=None):
            if not sql.lstrip().upper().startswith("SELECT"):
                raise RuntimeError("write unavailable")
            return snowflake.query(sql, params)

        def execute(self, sql, params=None):
            raise RuntimeError("write unavailable")

    repeated = _client(ReadOnlyDatabase()).post(
        "/tasks/nominations",
        json=TASK,
        headers=QUEUE_AUTH,
    )
    assert repeated.status_code == 200
    assert repeated.json() == first.json()


def test_created_outcome_is_durable_before_dispatch_and_dispatch_failure_cannot_erase_it():
    snowflake = RoutingFakeSnowflake()
    seen = []

    class Dispatch:
        def append(self, trend_id):
            seen.append(SnowflakeNominationStore(snowflake).get(TASK["nomination_id"]).status)
            raise TimeoutError("dispatcher timed out")

    response = _client(snowflake, Dispatch()).post(
        "/tasks/nominations",
        json=TASK,
        headers=QUEUE_AUTH,
    )
    assert response.status_code == 200
    assert response.json()["status"] == "created"
    assert response.json()["trend_id"] == "trend-new-1"
    assert seen == ["created"]


def test_worker_failure_is_safe_and_retryable_before_a_candidate_exists():
    from fakes import FakeLLM
    from test_task_handler import NEIGHBOR

    snowflake = RoutingFakeSnowflake(neighbors=[NEIGHBOR])
    response = _client(
        snowflake, judge_llm=FakeLLM(fail_with=RuntimeError("private provider key"))
    ).post(
        "/tasks/nominations",
        json=TASK,
        headers=QUEUE_AUTH,
    )
    assert response.status_code == 500
    assert "private provider key" not in response.text
    receipt = SnowflakeNominationStore(snowflake).get(TASK["nomination_id"])
    assert receipt.status == "pending"
    assert receipt.error["code"] == "processing_retry"


def test_overlapping_task_delivery_cannot_start_a_second_promotion():
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event

    from fakes import FakeLLM
    from test_task_handler import NEIGHBOR

    entered, release = Event(), Event()

    class WaitingJudge(FakeLLM):
        def complete(self, **kwargs):
            entered.set()
            assert release.wait(5)
            return super().complete(**kwargs)

    snowflake = RoutingFakeSnowflake(neighbors=[NEIGHBOR])
    judge = WaitingJudge(reply='{"match": null, "rationale": "different"}')
    client = _client(snowflake, judge_llm=judge)
    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(client.post, "/tasks/nominations", json=TASK, headers=QUEUE_AUTH)
        assert entered.wait(5)
        try:
            second = client.post("/tasks/nominations", json=TASK, headers=QUEUE_AUTH)
            assert second.status_code == 409
        finally:
            release.set()
        assert first.result().json()["status"] == "created"
    assert len(snowflake.statements("PROC_PROMOTION_APPLY")) == 1
