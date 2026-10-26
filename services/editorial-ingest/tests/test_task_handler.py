"""POST /tasks/nominations -- the task handler (CRMA-1667 auth, CRMA-1668 work,
CRMA-1671 sameness).

The spec's fake-based tests: the resume path, and a failed sameness judgment.
The no-match and match paths themselves are proven live."""

from __future__ import annotations

import pytest
from fakes import FakeLLM, FakeTaskQueue, RoutingFakeSnowflake, fake_fetch
from fastapi.testclient import TestClient
from tt_services_lib.gemini import TransientLLMError

from editorial_ingest.app import create_app
from editorial_ingest.config import settings_from_env

SERVICE_URL = "https://trend-tree-editorial-ingest-tu6gxkvema-uk.a.run.app"
QUEUE_SA = "crm-runtime@mcc-crm-automations.iam.gserviceaccount.com"
QUEUE_AUTH = {"Authorization": "Bearer queue-token"}
TASK = {
    "nomination_id": "nom-123",
    "brief": "Tinned fish boards are replacing charcuterie at house parties.",
    "nominated_by": "jane@example.com",
    "urls": [
        {
            "url": "https://example.com/a",
            "canonical": "https://example.com/a",
            "http_status": 200,
            "status_class": "ok",
            "unverified": False,
            "title": "The tinned fish board is the new charcuterie",
        }
    ],
}


def _verify(token: str, audience: str) -> dict:
    if audience != SERVICE_URL:
        raise ValueError("wrong audience")
    emails = {"queue-token": QUEUE_SA, "other-token": "someone@example.com"}
    if token not in emails:
        raise ValueError("bad signature")
    return {"iss": "https://accounts.google.com", "aud": audience, "email": emails[token]}


def _client(snowflake=None, dispatched=None, judge_llm=None):
    settings = settings_from_env({"EDITORIAL_API_KEY": "k", "EDITORIAL_SERVICE_URL": SERVICE_URL})
    app = create_app(
        settings,
        queue=FakeTaskQueue(),
        snowflake=snowflake or RoutingFakeSnowflake(),
        llm=FakeLLM(),
        judge_llm=judge_llm or FakeLLM(),
        dispatch=(dispatched if dispatched is not None else []).append,
        fetch_url=fake_fetch({}),
        verify_token=_verify,
    )
    return TestClient(app)


def test_handler_rejects_a_request_without_the_queues_oidc_token():
    snowflake = RoutingFakeSnowflake()
    client = _client(snowflake)
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
    assert snowflake.calls == []


def test_a_task_whose_candidate_is_already_promoted_does_nothing_and_answers_2xx():
    snowflake = RoutingFakeSnowflake(
        candidate={"TOPIC": "t", "PROMOTED_AT": "2026-10-26 10:00:00", "PROMOTED_TO": "trend-1"}
    )
    resp = _client(snowflake).post("/tasks/nominations", json=TASK, headers=QUEUE_AUTH)
    assert 200 <= resp.status_code < 300
    assert snowflake.statements("PROC_PROMOTION_APPLY") == []
    assert snowflake.statements("MERGE_EXTERNAL_SIGNALS") == []


def test_a_task_that_finds_its_candidate_unpromoted_resumes_at_promotion():
    # The crash case: signals merged and the candidate written, then the task
    # died before (or inside) PROC_PROMOTION_APPLY. The retry must not merge
    # the signals again or write a second candidate.
    snowflake = RoutingFakeSnowflake(
        candidate={"TOPIC": "Tinned fish boards", "PROMOTED_AT": None, "PROMOTED_TO": None}
    )
    dispatched: list[str] = []
    resp = _client(snowflake, dispatched).post("/tasks/nominations", json=TASK, headers=QUEUE_AUTH)
    assert 200 <= resp.status_code < 300
    assert len(snowflake.statements("PROC_PROMOTION_APPLY")) == 1
    assert snowflake.statements("MERGE_EXTERNAL_SIGNALS") == []
    assert snowflake.statements("INSERT INTO MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES") == []
    assert dispatched == ["trend-new-1"]


NEIGHBOR = {
    "TREND_ID": "trend-old-1",
    "TREND_TOPIC": "Tinned fish served as a party board",
    "SUMMARY_SHORT": "Conservas boards at house parties.",
    "LIFECYCLE_STATUS": "STABLE",
    "SIMILARITY": 0.81,
}


@pytest.mark.parametrize(
    "judge",
    [
        FakeLLM(fail_with=TransientLLMError("gemini 503")),
        FakeLLM(reply='{"match": "trend-not-in-pool", "rationale": "same trend"}'),
    ],
    ids=["judge-error", "out-of-pool-trend-id"],
)
def test_a_failed_sameness_judgment_answers_non_2xx_and_writes_nothing(judge):
    # Never a fallback to PROMOTE_NEW: a fault must not mint a duplicate trend.
    snowflake = RoutingFakeSnowflake(neighbors=[NEIGHBOR])
    resp = _client(snowflake, judge_llm=judge).post(
        "/tasks/nominations", json=TASK, headers=QUEUE_AUTH
    )
    assert resp.status_code >= 400
    assert judge.calls, "the pool was not empty, so the judge must have been asked"
    assert snowflake.statements("MERGE_EXTERNAL_SIGNALS") == []
    assert snowflake.statements("INSERT INTO MCC_RAW.MARKETING_DEV.STG_TREND_CANDIDATES") == []
    assert snowflake.statements("PROC_PROMOTION_APPLY") == []
